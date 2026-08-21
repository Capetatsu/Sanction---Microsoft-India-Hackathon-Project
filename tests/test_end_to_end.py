"""
End-to-end tests via FastAPI TestClient with a fake Notion client. No network
and no credentials needed: the Notion/Anthropic/Resend calls are all replaced
with in-memory fakes, so the full state machine in app/main.py is exercised.

Covers the six real scenarios the demo must prove:
  1. safe  -> auto-processed -> action sent -> Run Log
  2. risky -> Pending in Notion -> human approves -> resumes -> action -> Run Log
  3. risky -> Pending in Notion -> human rejects -> no action -> Run Log
  4. garbage input -> Needs Clarification, never guessed, no action
  5. duplicate webhook delivery -> ignored, no double processing
  6. duplicate expense -> escalated with duplicate_of, never auto-approved

Plus the failure-path guarantees: AI API failure degrades to Needs
Clarification; Notion create failure returns 502 without losing the record;
email failure logs an Error row instead of claiming success.
"""
import pytest

from app import store, extraction, notion_client
from app.config import settings
from app.models import RequestStatus, ExtractedFields

_REAL_EXTRACT = extraction.extract  # captured pre-fixture (fixture swaps it out)

CLEAN_TEXT = "Need Rs 2000 for printing posters from Copy King for the fest"
RISKY_TEXT = "Need Rs 18000 to print the fest programme from Printing Corner"
REJECT_TEXT = "Need Rs 15000 for stage banners from Banner Studio"
DUP2_TEXT = "Need Rs 2050 for more posters from Copy King"
GARBAGE_TEXT = "I need money urgently"


def _payload(key, text):
    return {
        "idempotency_key": key,
        "requester_name": "Aisha Mehta",
        "requester_contact": "aisha@campus.edu",
        "raw_text": text,
    }


def _extract_fields(text: str) -> ExtractedFields:
    base = {}
    if text == CLEAN_TEXT:
        base = dict(vendor="Copy King", amount=2000.0, category="Printing",
                    purpose="posters", urgency="normal", missing_fields=[],
                    ai_summary="Rs 2000 for posters from Copy King for the fest.")
    elif text == RISKY_TEXT:
        base = dict(vendor="Printing Corner", amount=18000.0, category="Printing",
                    purpose="programme printing", urgency="normal", missing_fields=[],
                    ai_summary="Rs 18000 to print the fest programme.")
    elif text == REJECT_TEXT:
        base = dict(vendor="Banner Studio", amount=15000.0, category="Printing",
                    purpose="stage banners", urgency="normal", missing_fields=[],
                    ai_summary="Rs 15000 for stage banners.")
    elif text == DUP2_TEXT:
        base = dict(vendor="Copy King", amount=2050.0, category="Printing",
                    purpose="extra posters", urgency="normal", missing_fields=[],
                    ai_summary="Rs 2050 for more posters from Copy King.")
    elif text == GARBAGE_TEXT:
        base = dict(vendor=None, amount=None, category=None, purpose=None,
                    urgency="urgent", missing_fields=["vendor", "amount", "category"],
                    ai_summary="No vendor or amount given.")
    else:
        raise RuntimeError(f"unexpected request text: {text}")
    return ExtractedFields(**base)


class FakeNotion:
    """Minimal in-memory stand-in for the Notion API surface the app uses."""

    def __init__(self):
        self.pages = {}        # page_id -> {"request_id": str, "status": str}
        self.runlog = []       # list of (request_id, action, actor, detail)
        self.decisions = {}    # request_id -> (decision, decided_by)
        self.budgets = {"Printing": (50000.0, 5000.0), "Decorations": (20000.0, 15000.0)}
        self.created = 0
        self.fail_creates = False

    async def create_request_page(self, record):
        if self.fail_creates:
            raise notion_client.NotionAPIError("simulated create failure")
        self.created += 1
        pid = f"page-{record.request_id}"
        self.pages[pid] = {"request_id": record.request_id, "status": record.decision.status.value}
        return pid

    async def update_request_status(self, page_id, status, decided_by=None):
        self.pages[page_id]["status"] = status.value

    async def get_request_decision(self, page_id):
        rid = self.pages[page_id]["request_id"]
        return self.decisions.get(rid, (None, None))

    async def append_run_log(self, request_id, action, actor, detail=""):
        self.runlog.append((request_id, action, actor, detail))

    async def get_budget(self, category):
        return self.budgets.get(category, (0.0, 0.0))

    def runlog_for(self, request_id):
        return [a for (rid, a, _, _) in self.runlog if rid == request_id]

    def page_status(self, request_id):
        for pid, page in self.pages.items():
            if page["request_id"] == request_id:
                return page["status"]
        return None


@pytest.fixture
def client(monkeypatch):
    store._MEM_STORE.clear()
    store._MEM_IDEMPOTENCY.clear()
    fake = FakeNotion()
    monkeypatch.setattr(notion_client, "create_request_page", fake.create_request_page)
    monkeypatch.setattr(notion_client, "update_request_status", fake.update_request_status)
    monkeypatch.setattr(notion_client, "get_request_decision", fake.get_request_decision)
    monkeypatch.setattr(notion_client, "append_run_log", fake.append_run_log)
    monkeypatch.setattr(notion_client, "get_budget", fake.get_budget)
    monkeypatch.setattr(extraction, "extract", _extract_fields)
    monkeypatch.setattr(settings, "WEBHOOK_SECRET", "test-secret")
    monkeypatch.setattr(settings, "RESEND_API_KEY", "")

    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        c.fake = fake
        yield c


HDRS = {"X-Webhook-Secret": "test-secret"}


def test_webhook_requires_secret(client):
    resp = client.post("/webhook/request", json=_payload("k-main", CLEAN_TEXT))
    assert resp.status_code == 401


# Scenario 1: safe request -> auto-processed -> action -> Run Log
def test_safe_request_auto_approved_and_actioned(client):
    resp = client.post("/webhook/request", json=_payload("k-safe", CLEAN_TEXT), headers=HDRS)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == RequestStatus.AUTO_APPROVED.value
    rid = body["request_id"]
    assert rid.startswith("REQ-")

    assert client.fake.page_status(rid) == RequestStatus.AUTO_APPROVED.value
    assert client.fake.created == 1
    log = client.fake.runlog_for(rid)
    assert log == ["Received", "Auto-Approved", "Action-Sent"]

    record = store._MEM_STORE[rid]
    assert record.decided_by == "policy-engine (auto)"
    assert record.notion_page_id


# Scenario 5: duplicate webhook delivery -> ignored, nothing re-processed
def test_duplicate_webhook_delivery_ignored(client):
    first = client.post("/webhook/request", json=_payload("k-dup", CLEAN_TEXT), headers=HDRS).json()
    second = client.post("/webhook/request", json=_payload("k-dup", CLEAN_TEXT), headers=HDRS)
    assert second.status_code == 200
    assert second.json() == {"status": "duplicate_ignored", "request_id": first["request_id"]}
    assert client.fake.created == 1  # no second Notion page


# Scenario 6: duplicate expense -> escalated with duplicate_of, never auto-approved
def test_duplicate_expense_escalates_with_duplicate_of(client):
    first = client.post("/webhook/request", json=_payload("k-e1", CLEAN_TEXT), headers=HDRS).json()
    assert first["status"] == RequestStatus.AUTO_APPROVED.value

    second = client.post("/webhook/request", json=_payload("k-e2", DUP2_TEXT), headers=HDRS)
    assert second.status_code == 200
    body = second.json()
    assert body["status"] == RequestStatus.PENDING_APPROVAL.value
    record = store._MEM_STORE[body["request_id"]]
    assert record.decision.duplicate_of == first["request_id"]
    assert client.fake.page_status(body["request_id"]) == RequestStatus.PENDING_APPROVAL.value


# Scenario 2: risky -> Pending in Notion -> human approves -> resumes -> action
def test_risky_request_approved_in_notion_resumes(client):
    resp = client.post("/webhook/request", json=_payload("k-risky", RISKY_TEXT), headers=HDRS)
    body = resp.json()
    assert body["status"] == RequestStatus.PENDING_APPROVAL.value
    assert body["risk_reasons"]
    rid = body["request_id"]
    assert client.fake.runlog_for(rid) == ["Received", "Escalated"]

    client.fake.decisions[rid] = ("Approved", "Prof. R. Desai")
    poll = client.post("/notion/check-approvals", headers=HDRS)
    assert rid in poll.json()["resumed"]
    assert poll.json()["failed"] == []

    record = store._MEM_STORE[rid]
    assert record.decision.status == RequestStatus.APPROVED
    assert record.decided_by == "Prof. R. Desai"
    assert client.fake.page_status(rid) == RequestStatus.APPROVED.value
    assert client.fake.runlog_for(rid) == ["Received", "Escalated", "Approved", "Action-Sent"]

    # A second poll does nothing: record has left Pending Approval.
    poll2 = client.post("/notion/check-approvals", headers=HDRS).json()
    assert rid not in poll2["resumed"]


# Scenario 3: risky -> Pending -> human rejects -> no external action
def test_risky_request_rejected_no_action(client):
    resp = client.post("/webhook/request", json=_payload("k-rej", REJECT_TEXT), headers=HDRS)
    body = resp.json()
    assert body["status"] == RequestStatus.PENDING_APPROVAL.value
    rid = body["request_id"]

    client.fake.decisions[rid] = ("Rejected", "Prof. R. Desai")
    poll = client.post("/notion/check-approvals", headers=HDRS)
    assert rid in poll.json()["resumed"]

    record = store._MEM_STORE[rid]
    assert record.decision.status == RequestStatus.REJECTED
    assert client.fake.page_status(rid) == RequestStatus.REJECTED.value
    assert client.fake.runlog_for(rid) == ["Received", "Escalated", "Rejected"]  # no Action-Sent


# Scenario 4: garbage input -> Needs Clarification, no action, never guessed
def test_garbage_input_needs_clarification(client):
    resp = client.post("/webhook/request", json=_payload("k-gar", GARBAGE_TEXT), headers=HDRS)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == RequestStatus.NEEDS_CLARIFICATION.value
    rid = body["request_id"]
    assert client.fake.runlog_for(rid) == ["Received", "Needs Clarification"]
    assert "Action-Sent" not in client.fake.runlog_for(rid)


# AI API failure -> falls back to Needs Clarification via the real except path
def test_ai_api_failure_degrades_safely(client, monkeypatch):
    class _BoomingMessages:
        def create(self, **kw):
            raise Exception("anthropic outage")

    class _BoomingClient:
        messages = _BoomingMessages()

    monkeypatch.setattr(extraction, "_client", _BoomingClient())
    monkeypatch.setattr(extraction, "extract", _REAL_EXTRACT)  # undo the fixture's canned extractor
    resp = client.post("/webhook/request", json=_payload("k-ai", GARBAGE_TEXT), headers=HDRS)
    assert resp.status_code == 200
    assert resp.json()["status"] == RequestStatus.NEEDS_CLARIFICATION.value
    assert "[FALLBACK — AI extraction API call failed]" in store._MEM_STORE[resp.json()["request_id"]].extracted.ai_summary


# Notion create failure -> honest 502, record preserved, no false success
def test_notion_create_failure_returns_502_and_preserves_record(client):
    client.fake.fail_creates = True
    resp = client.post("/webhook/request", json=_payload("k-nf", CLEAN_TEXT), headers=HDRS)
    assert resp.status_code == 502
    assert client.fake.created == 0

    after_fail = client.post("/webhook/request", json=_payload("k-nf", CLEAN_TEXT), headers=HDRS)
    assert after_fail.json()["status"] == "duplicate_ignored"


# Email failure -> Error run log row, never claims success
def test_email_failure_logs_error_not_success(client, monkeypatch):
    from app import actions

    def _boom(*args, **kwargs):
        raise actions.EmailSendError("Resend 503")

    monkeypatch.setattr(actions, "send_authorization_email", _boom)
    resp = client.post("/webhook/request", json=_payload("k-ef", CLEAN_TEXT), headers=HDRS)
    assert resp.status_code == 200
    assert resp.json()["status"] == RequestStatus.AUTO_APPROVED.value
    rid = resp.json()["request_id"]
    assert client.fake.runlog_for(rid) == ["Received", "Auto-Approved", "Error"]


# Malformed payload -> 422 before any processing
def test_malformed_payload_422(client):
    resp = client.post("/webhook/request",
                       json={"idempotency_key": 1, "raw_text": "x" * 5000}, headers=HDRS)
    assert resp.status_code == 422
    assert client.fake.created == 0


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}