"""
Sanction — the whole workflow lives here, glued together:
trigger -> extract -> decide -> log to Notion -> (pause for approval) ->
generate + send authorization -> Run Log.

Two entry points:
  POST /webhook/request        the real trigger — a form/email/script hits this
  POST /notion/check-approvals a cron-style endpoint that polls Notion for
                                 human decisions and resumes paused requests

Persistence: request records + idempotency keys live in Postgres (app/store.py),
not in-process memory — Render's free web services wipe local state on every
redeploy/restart/spin-down.

/notion/check-approvals must be hit on a schedule by an external pinger
(cron-job.org / GitHub Actions schedule / UptimeRobot) — Render's free tier
cannot run a reliable persistent in-process background loop.
"""
import asyncio
import hmac
import os
import uuid
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException, Header
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from contextlib import asynccontextmanager

from app.models import IncomingRequest, RequestRecord, RequestStatus
from app import extraction, policy, notion_client, runlog, actions, store
from app.config import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    await store.init()
    yield
    await store.close()


app = FastAPI(title="Sanction", lifespan=lifespan)

WEBSITE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")
app.mount("/static", StaticFiles(directory=WEBSITE_DIR), name="static")


@app.get("/")
async def index():
    return FileResponse(os.path.join(WEBSITE_DIR, "index.html"))


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/api/requests")
async def api_requests():
    records = await store.recent_records()
    return [r.model_dump(mode="json") for r in records]


@app.get("/api/budgets")
async def api_budgets():
    categories = ["Decorations", "Printing", "Equipment", "Food", "Travel", "Other"]
    out = []
    for cat in categories:
        cap, spent = await notion_client.get_budget(cat)
        out.append({"category": cat, "cap": cap, "spent": spent})
    return out


@app.get("/api/runlog")
async def api_runlog():
    records = await store.recent_records()
    return [
        {
            "request_id": r.request_id,
            "status": r.decision.status.value,
            "vendor": r.extracted.vendor,
            "amount": r.extracted.amount,
            "category": r.extracted.category,
            "requester": r.incoming.requester_name,
            "received_at": r.incoming.received_at.isoformat(),
            "decided_by": r.decided_by,
            "decided_at": r.decided_at.isoformat() if r.decided_at else None,
            "risk_reasons": r.decision.risk_reasons,
        }
        for r in records
    ]


def _check_webhook_auth(x_webhook_secret: str | None):
    if not settings.WEBHOOK_SECRET:
        # No secret configured — fail closed rather than silently open.
        raise HTTPException(500, "WEBHOOK_SECRET not configured on server")
    if not x_webhook_secret or not hmac.compare_digest(x_webhook_secret, settings.WEBHOOK_SECRET):
        raise HTTPException(401, "invalid or missing webhook secret")


@app.post("/webhook/request")
async def receive_request(incoming: IncomingRequest, x_webhook_secret: str | None = Header(default=None)):
    _check_webhook_auth(x_webhook_secret)

    # Atomic idempotency: mark_processed returns None if key was already set,
    # preventing duplicate processing under concurrent delivery.
    existing = await store.already_processed(incoming.idempotency_key)
    if existing:
        return {"status": "duplicate_ignored", "request_id": existing}

    request_id = f"REQ-{uuid.uuid4().hex[:8].upper()}"

    # Mark as processed FIRST (atomic claim), then proceed. If processing
    # fails after this point, the idempotency key is consumed — a retry
    # with the same key will be ignored. This prevents duplicate Notion
    # pages and duplicate emails under concurrent delivery.
    await store.mark_processed(incoming.idempotency_key, request_id)

    extracted = await asyncio.to_thread(extraction.extract, incoming.raw_text)

    budget_cap, budget_spent, budget_page_id = (0.0, 0.0, None)
    if extracted.category:
        try:
            budget_cap, budget_spent, budget_page_id = await notion_client.get_budget(extracted.category)
        except notion_client.NotionAPIError:
            pass

    decision = policy.decide(
        extracted=extracted,
        budget_cap=budget_cap,
        budget_spent=budget_spent,
        recent_requests=await store.recent_records(),
    )

    record = RequestRecord(
        request_id=request_id,
        incoming=incoming,
        extracted=extracted,
        decision=decision,
        budget_page_id=budget_page_id,
    )

    # Durable record goes in after the idempotency claim. A crash or Notion
    # failure mid-pipeline loses the request record, but the idempotency key
    # is already consumed, preventing duplicate processing on retry.
    await store.save_record(record)

    try:
        page_id = await notion_client.create_request_page(record)
        record.notion_page_id = page_id
        await store.save_record(record)
    except notion_client.NotionAPIError as e:
        await runlog.log(request_id, "Error", "system", f"Notion page create failed: {e}")
        raise HTTPException(502, "Notion write failed — request saved, will retry")

    await runlog.log(request_id, "Received", "system", incoming.raw_text[:200])

    if decision.status == RequestStatus.AUTO_APPROVED:
        record.decided_by = "policy-engine (auto)"
        record.decided_at = datetime.now(timezone.utc)
        await store.save_record(record)
        await runlog.log(request_id, "Auto-Approved", "system", "; ".join(decision.risk_reasons) or "Within policy.")
        await store.claim_action(request_id)  # defense-in-depth: prevent double-action
        await _execute_action(record)
        if record.budget_page_id:
            try:
                await notion_client.increment_budget_spent(record.budget_page_id, extracted.amount)
            except notion_client.NotionAPIError as e:
                await runlog.log(request_id, "Error", "system", f"Budget Spent update failed after auto-approval: {e}")
    elif decision.status == RequestStatus.PENDING_APPROVAL:
        await runlog.log(request_id, "Escalated", "system", "; ".join(decision.risk_reasons))
    elif decision.status == RequestStatus.NEEDS_CLARIFICATION:
        await runlog.log(request_id, "Needs Clarification", "system", "; ".join(decision.risk_reasons))

    return {"status": decision.status.value, "request_id": request_id, "risk_reasons": decision.risk_reasons}


@app.post("/notion/check-approvals")
async def check_approvals(x_webhook_secret: str | None = Header(default=None)):
    """Poll every Pending Approval request for a human decision made in
    Notion, and resume the ones that were actioned. Call this on a schedule
    (external pinger) — this is the 'human decides in Notion, backend
    resumes automatically' half of the loop.

    Each record is handled independently: one Notion/action failure is
    logged and skipped, it never aborts the rest of the batch."""
    _check_webhook_auth(x_webhook_secret)
    resumed = []
    failed = []
    for record in await store.pending_records():
        try:
            decision_value, decided_by = await notion_client.get_request_decision(record.notion_page_id)
        except (notion_client.NotionAPIError, KeyError, TypeError) as e:
            failed.append(record.request_id)
            await runlog.log(record.request_id, "Error", "system", f"Notion decision lookup failed: {e}")
            continue

        try:
            if decision_value == "Approved":
                # Atomic claim: prevents double-action if two polls overlap.
                if not await store.claim_action(record.request_id):
                    continue  # another poll already claimed this record
                record.decision.status = RequestStatus.APPROVED
                record.decided_by = decided_by or "unknown approver"
                record.decided_at = datetime.now(timezone.utc)
                await notion_client.update_request_status(record.notion_page_id, RequestStatus.APPROVED, record.decided_by)
                await store.save_record(record)
                await runlog.log(record.request_id, "Approved", record.decided_by)
                await _execute_action(record)
                if record.budget_page_id:
                    try:
                        await notion_client.increment_budget_spent(record.budget_page_id, record.extracted.amount)
                    except notion_client.NotionAPIError as e:
                        await runlog.log(record.request_id, "Error", "system", f"Budget Spent update failed after approval: {e}")
                resumed.append(record.request_id)
            elif decision_value == "Rejected":
                record.decision.status = RequestStatus.REJECTED
                record.decided_by = decided_by or "unknown approver"
                record.decided_at = datetime.now(timezone.utc)
                await notion_client.update_request_status(record.notion_page_id, RequestStatus.REJECTED, record.decided_by)
                await store.save_record(record)
                await runlog.log(record.request_id, "Rejected", record.decided_by)
                resumed.append(record.request_id)
        except notion_client.NotionAPIError as e:
            failed.append(record.request_id)
            await runlog.log(record.request_id, "Error", "system", f"Notion status update failed: {e}")
            continue
    return {"resumed": resumed, "failed": failed}


async def _execute_action(record: RequestRecord):
    """Generate the authorization PDF, then email it. Each half fails
    independently: one failure logs an honest 'Error' row and stops — it never
    silently claims success for the half that didn't happen (PART 12)."""
    try:
        pdf_path = await asyncio.to_thread(actions.generate_authorization_pdf, record)
    except Exception as e:
        await runlog.log(record.request_id, "Error", "system", f"PDF generation failed: {e}")
        return

    try:
        delivered = await asyncio.to_thread(actions.send_authorization_email, record, pdf_path)
    except actions.EmailSendError as e:
        await runlog.log(record.request_id, "Error", "system", f"Email send failed: {e}")
        return

    if delivered:
        detail = f"Authorization PDF generated and emailed: {pdf_path}"
    else:
        detail = (f"Authorization PDF generated but email not delivered "
                  f"(RESEND_API_KEY unset — local fallback): {pdf_path}")
    await runlog.log(record.request_id, "Action-Sent", "system", detail)


@app.get("/requests/{request_id}")
async def get_request(request_id: str, x_webhook_secret: str | None = Header(default=None)):
    _check_webhook_auth(x_webhook_secret)
    record = await store.get_record(request_id)
    if not record:
        raise HTTPException(404, "not found")
    return record
