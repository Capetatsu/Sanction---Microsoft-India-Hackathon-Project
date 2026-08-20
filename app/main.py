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
import os
import uuid
from datetime import datetime
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
    """Demo trigger form — the only 'frontend', and deliberately one page."""
    return FileResponse(os.path.join(WEBSITE_DIR, "demo_form.html"))


@app.get("/health")
async def health():
    return {"status": "ok"}


def _check_webhook_auth(x_webhook_secret: str | None):
    if not settings.WEBHOOK_SECRET:
        # No secret configured — fail closed rather than silently open.
        raise HTTPException(500, "WEBHOOK_SECRET not configured on server")
    if x_webhook_secret != settings.WEBHOOK_SECRET:
        raise HTTPException(401, "invalid or missing webhook secret")


@app.post("/webhook/request")
async def receive_request(incoming: IncomingRequest, x_webhook_secret: str | None = Header(default=None)):
    _check_webhook_auth(x_webhook_secret)

    return await _process_request(incoming)


@app.post("/demo/request")
async def demo_request(incoming: IncomingRequest):
    """Server-side proxy for the built-in demo form. The form is served by this
    same backend, so the webhook secret is injected here from server config —
    never embedded in browser-visible HTML/JavaScript. /webhook/request remains
    the protected external trigger; this endpoint only forwards the form's
    payload through the exact same pipeline after the same auth check."""
    return await _process_request(incoming, injected_secret=settings.WEBHOOK_SECRET)


async def _process_request(incoming: IncomingRequest, injected_secret: str | None = None):
    if injected_secret is not None:
        _check_webhook_auth(injected_secret)

    existing = await store.already_processed(incoming.idempotency_key)
    if existing:
        return {"status": "duplicate_ignored", "request_id": existing}

    request_id = f"REQ-{uuid.uuid4().hex[:8].upper()}"

    extracted = extraction.extract(incoming.raw_text)

    budget_cap, budget_spent = (0.0, 0.0)
    if extracted.category:
        budget_cap, budget_spent = await notion_client.get_budget(extracted.category)

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
    )

    # Durable record + idempotency markers go in BEFORE the Notion write, so a
    # crash or Notion failure mid-pipeline does not lose the received request
    # or forget that this delivery was already attempted (BUILD_PLAN PART 6/12).
    await store.save_record(record)
    await store.mark_processed(incoming.idempotency_key, request_id)

    try:
        page_id = await notion_client.create_request_page(record)
        record.notion_page_id = page_id
        await store.save_record(record)
    except notion_client.NotionAPIError as e:
        await runlog.log(request_id, "Error", "system", f"Notion page create failed: {e}")
        raise HTTPException(502, f"Notion write failed: {e}")

    await runlog.log(request_id, "Received", "system", incoming.raw_text[:200])

    if decision.status == RequestStatus.AUTO_APPROVED:
        record.decided_by = "policy-engine (auto)"
        record.decided_at = datetime.utcnow()
        await store.save_record(record)
        await runlog.log(request_id, "Auto-Approved", "system", "; ".join(decision.risk_reasons) or "Within policy.")
        await _execute_action(record)
    elif decision.status == RequestStatus.PENDING_APPROVAL:
        await runlog.log(request_id, "Escalated", "system", "; ".join(decision.risk_reasons))
    elif decision.status == RequestStatus.NEEDS_CLARIFICATION:
        await runlog.log(request_id, "Needs Clarification", "system", "; ".join(decision.risk_reasons))

    return {"status": decision.status.value, "request_id": request_id, "risk_reasons": decision.risk_reasons}


@app.post("/notion/check-approvals")
async def check_approvals():
    """Poll every Pending Approval request for a human decision made in
    Notion, and resume the ones that were actioned. Call this on a schedule
    (external pinger) — this is the 'human decides in Notion, backend
    resumes automatically' half of the loop.

    Each record is handled independently: one Notion/action failure is
    logged and skipped, it never aborts the rest of the batch."""
    resumed = []
    failed = []
    for record in await store.pending_records():
        try:
            decision_value, decided_by = await notion_client.get_request_decision(record.notion_page_id)
        except notion_client.NotionAPIError as e:
            failed.append(record.request_id)
            await runlog.log(record.request_id, "Error", "system", f"Notion decision lookup failed: {e}")
            continue

        try:
            if decision_value == "Approved":
                record.decision.status = RequestStatus.APPROVED
                record.decided_by = decided_by or "unknown approver"
                record.decided_at = datetime.utcnow()
                await notion_client.update_request_status(record.notion_page_id, RequestStatus.APPROVED, record.decided_by)
                await store.save_record(record)
                await runlog.log(record.request_id, "Approved", record.decided_by)
                await _execute_action(record)
                resumed.append(record.request_id)
            elif decision_value == "Rejected":
                record.decision.status = RequestStatus.REJECTED
                record.decided_by = decided_by or "unknown approver"
                record.decided_at = datetime.utcnow()
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
        pdf_path = actions.generate_authorization_pdf(record)
    except Exception as e:
        await runlog.log(record.request_id, "Error", "system", f"PDF generation failed: {e}")
        return

    try:
        delivered = actions.send_authorization_email(record, pdf_path)
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
async def get_request(request_id: str):
    record = await store.get_record(request_id)
    if not record:
        raise HTTPException(404, "not found")
    return record
