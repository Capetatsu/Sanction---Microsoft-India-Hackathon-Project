"""
Thin wrapper over the Notion API. Every write here is what makes Notion the
real audit trail — rows are created/updated by this integration token, never
typed by hand, which is exactly what the track's Run Log requirement checks.

Every call is wrapped: a transient Notion error raises NotionAPIError instead
of an uncaught HTTPStatusError, so callers (esp. check_approvals' per-record
loop) can log-and-continue instead of aborting an entire batch on one flaky
call.
"""
import asyncio
import httpx
from datetime import datetime
from app.config import settings
from app.models import RequestRecord, RequestStatus

NOTION_VERSION = "2022-06-28"
BASE_URL = "https://api.notion.com/v1"


class NotionAPIError(Exception):
    pass


def _headers():
    return {
        "Authorization": f"Bearer {settings.NOTION_TOKEN}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }


async def _request(method: str, path: str, payload: dict | None = None, retries: int = 0) -> dict:
    """HTTP call with optional retry-and-backoff for transient errors. Mutating
    creates (pages, run log rows) MUST keep retries=0 — a retry after a lost
    response would create a duplicate row/run-log entry."""
    last_err: Exception | None = None
    for attempt in range(retries + 1):
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                url = f"{BASE_URL}{path}"
                if method == "POST":
                    resp = await client.post(url, headers=_headers(), json=payload or {})
                elif method == "PATCH":
                    resp = await client.patch(url, headers=_headers(), json=payload or {})
                else:
                    resp = await client.get(url, headers=_headers())
                resp.raise_for_status()
                return resp.json()
        except httpx.HTTPError as e:
            last_err = e
            if attempt < retries:
                await asyncio.sleep(0.5 * (attempt + 1))
    raise NotionAPIError(f"{method} {path} failed: {last_err}") from last_err


async def _get(path: str) -> dict:
    return await _request("GET", path, retries=1)


async def _patch(path: str, payload: dict) -> dict:
    return await _request("PATCH", path, payload, retries=1)


async def _post(path: str, payload: dict) -> dict:
    return await _request("POST", path, payload, retries=0)


async def create_request_page(record: RequestRecord) -> str:
    payload = {
        "parent": {"database_id": settings.NOTION_REQUESTS_DB_ID},
        "properties": {
            "Name": {"title": [{"text": {"content": record.request_id}}]},
            "Requester": {"rich_text": [{"text": {"content": record.incoming.requester_name}}]},
            "Vendor": {"rich_text": [{"text": {"content": record.extracted.vendor or ""}}]},
            "Amount": {"number": record.extracted.amount},
            "Category": {"select": {"name": record.extracted.category or "Other"}},
            "Status": {"select": {"name": record.decision.status.value}},
            "AI Summary": {"rich_text": [{"text": {"content": record.extracted.ai_summary}}]},
            "Risk Reasons": {"rich_text": [{"text": {"content": "; ".join(record.decision.risk_reasons)}}]},
            "Raw Request": {"rich_text": [{"text": {"content": record.incoming.raw_text[:2000]}}]},
            "Received At": {"date": {"start": record.incoming.received_at.isoformat()}},
        },
    }
    data = await _post("/pages", payload)
    return data["id"]


async def update_request_status(page_id: str, status: RequestStatus, decided_by: str | None = None):
    props = {"Status": {"select": {"name": status.value}}}
    if decided_by:
        props["Decided By"] = {"rich_text": [{"text": {"content": decided_by}}]}
        props["Decided At"] = {"date": {"start": datetime.utcnow().isoformat()}}
    await _patch(f"/pages/{page_id}", {"properties": props})


async def get_request_decision(page_id: str) -> tuple[str | None, str | None]:
    """Poll a request page for a human decision made directly in Notion.
    Returns (decision, decided_by) where decision is 'Approved'/'Rejected'/None."""
    data = await _get(f"/pages/{page_id}")
    props = data["properties"]
    decision_prop = props.get("Decision", {}).get("select")
    decided_by_prop = props.get("Decided By", {}).get("rich_text", [])
    decision = decision_prop["name"] if decision_prop else None
    decided_by = decided_by_prop[0]["text"]["content"] if decided_by_prop else None
    return decision, decided_by


async def append_run_log(request_id: str, action: str, actor: str, detail: str = ""):
    payload = {
        "parent": {"database_id": settings.NOTION_RUNLOG_DB_ID},
        "properties": {
            "Name": {"title": [{"text": {"content": f"{request_id} — {action}"}}]},
            "Request ID": {"rich_text": [{"text": {"content": request_id}}]},
            "Action": {"select": {"name": action}},
            "Actor": {"rich_text": [{"text": {"content": actor}}]},
            "Detail": {"rich_text": [{"text": {"content": detail[:2000]}}]},
            "Timestamp": {"date": {"start": datetime.utcnow().isoformat()}},
        },
    }
    await _post("/pages", payload)


async def get_budget(category: str) -> tuple[float, float]:
    """Returns (cap, spent) for a category by querying the Budgets DB.
    Returns (0.0, 0.0) both when the category truly has no budget row and
    when the lookup itself fails — caller distinguishes via the exception
    only if it needs to; policy.py treats missing budget conservatively
    either way (0 remaining -> escalates rather than auto-approves)."""
    payload = {"filter": {"property": "Category", "select": {"equals": category}}}
    try:
        data = await _request("POST", f"/databases/{settings.NOTION_BUDGETS_DB_ID}/query", payload, retries=1)
    except NotionAPIError:
        return (0.0, 0.0)
    results = data.get("results", [])
    if not results:
        return (0.0, 0.0)
    props = results[0]["properties"]
    cap = props.get("Cap", {}).get("number") or 0.0
    spent = props.get("Spent", {}).get("number") or 0.0
    return (cap, spent)
