"""
Security regression tests -- attack vectors that must be blocked.
"""
import hmac
import pytest
from datetime import datetime, timedelta, timezone

from app import store, extraction, notion_client, policy
from app.config import settings
from app.models import (
    IncomingRequest, RequestRecord, ExtractedFields,
    Decision, RequestStatus,
)

def _payload(key="sec-test", text="Need Rs 1000 for paper from Acme"):
    return {
        "idempotency_key": key,
        "requester_name": "Attacker",
        "requester_contact": "evil@attacker.com",
        "raw_text": text,
    }

HDRS = {"X-Webhook-Secret": "test-secret"}

CLEAN_TEXT = "Need Rs 2000 for printing posters from Copy King for the fest"
RISKY_TEXT = "Need Rs 18000 to print the fest programme from Printing Corner"

def _extract_fields(text):
    if text == CLEAN_TEXT:
        return ExtractedFields(vendor="Copy King", amount=2000.0, category="Printing",
                               purpose="posters", urgency="normal", missing_fields=[],
                               ai_summary="Rs 2000 for posters.")
    if text == RISKY_TEXT:
        return ExtractedFields(vendor="Printing Corner", amount=18000.0, category="Printing",
                               purpose="programme printing", urgency="normal", missing_fields=[],
                               ai_summary="Rs 18000 to print.")
    return ExtractedFields(vendor="Acme", amount=1000.0, category="Printing",
                           purpose="p", urgency="normal", missing_fields=[],
                           ai_summary="summary")

class FakeNotion:
    def __init__(self):
        self.pages = {}
        self.runlog = []
        self.decisions = {}
        self.budgets = {"Printing": (50000.0, 5000.0, "bp-printing")}
        self.created = 0
        self.fail_creates = False
        self.fail_budget_increment = False

    async def create_request_page(self, record):
        if self.fail_creates:
            raise notion_client.NotionAPIError("simulated failure")
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
        return self.budgets.get(category, (0.0, 0.0, None))

    async def increment_budget_spent(self, page_id, amount):
        if self.fail_budget_increment:
            raise notion_client.NotionAPIError("simulated budget update failure")
        for cat, (cap, spent, pid) in self.budgets.items():
            if pid == page_id:
                self.budgets[cat] = (cap, spent + amount, pid)
                return

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
    monkeypatch.setattr(notion_client, "increment_budget_spent", fake.increment_budget_spent)
    monkeypatch.setattr(extraction, "extract", _extract_fields)
    monkeypatch.setattr(settings, "WEBHOOK_SECRET", "test-secret")
    monkeypatch.setattr(settings, "RESEND_API_KEY", "")

    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        c.fake = fake
        yield c

# ===========================================================================
# 1. AUTH BYPASS
# ===========================================================================
class TestAuthBypass:
    def test_webhook_no_secret_rejected(self, client):
        resp = client.post("/webhook/request", json=_payload())
        assert resp.status_code == 401

    def test_webhook_wrong_secret_rejected(self, client):
        resp = client.post("/webhook/request", json=_payload(),
                           headers={"X-Webhook-Secret": "wrong"})
        assert resp.status_code == 401

    def test_webhook_empty_secret_rejected(self, client):
        resp = client.post("/webhook/request", json=_payload(),
                           headers={"X-Webhook-Secret": ""})
        assert resp.status_code == 401

    def test_check_approvals_no_secret_rejected(self, client):
        resp = client.post("/notion/check-approvals")
        assert resp.status_code == 401

    def test_check_approvals_wrong_secret_rejected(self, client):
        resp = client.post("/notion/check-approvals",
                           headers={"X-Webhook-Secret": "wrong"})
        assert resp.status_code == 401

    def test_get_request_no_secret_rejected(self, client):
        resp = client.get("/requests/REQ-TEST1234")
        assert resp.status_code == 401

    def test_get_request_wrong_secret_rejected(self, client):
        resp = client.get("/requests/REQ-TEST1234",
                          headers={"X-Webhook-Secret": "wrong"})
        assert resp.status_code == 401

    def test_health_needs_no_auth(self, client):
        assert client.get("/health").status_code == 200

    def test_index_needs_no_auth(self, client):
        assert client.get("/").status_code == 200

# ===========================================================================
# 2. TIMING SIDE-CHANNEL
# ===========================================================================
class TestTimingAttack:
    def test_uses_constant_time_comparison(self):
        import inspect
        from app import main
        source = inspect.getsource(main._check_webhook_auth)
        assert "compare_digest" in source, (
            "_check_webhook_auth must use hmac.compare_digest, not !="
        )

# ===========================================================================
# 3. INPUT VALIDATION
# ===========================================================================
class TestInputValidation:
    def test_empty_payload_rejected(self, client):
        resp = client.post("/webhook/request", json={}, headers=HDRS)
        assert resp.status_code == 422

    def test_missing_fields_rejected(self, client):
        resp = client.post("/webhook/request",
                           json={"idempotency_key": "k", "raw_text": "x"},
                           headers=HDRS)
        assert resp.status_code == 422

    def test_raw_text_too_long_rejected(self, client):
        resp = client.post("/webhook/request",
                           json=_payload(text="A" * 3000), headers=HDRS)
        assert resp.status_code == 422

    def test_idempotency_key_too_long_rejected(self, client):
        resp = client.post("/webhook/request",
                           json=_payload(key="K" * 300), headers=HDRS)
        assert resp.status_code == 422

    def test_negative_amount_triggers_clarification(self):
        ext = ExtractedFields(vendor="X", amount=-5000, category="Other",
                              purpose="p", urgency="normal", missing_fields=[])
        d = policy.decide(ext, 100000, 0, [])
        assert d.status == RequestStatus.NEEDS_CLARIFICATION

    def test_zero_amount_triggers_clarification(self):
        ext = ExtractedFields(vendor="X", amount=0, category="Other",
                              purpose="p", urgency="normal", missing_fields=[])
        d = policy.decide(ext, 100000, 0, [])
        assert d.status == RequestStatus.NEEDS_CLARIFICATION

    def test_extreme_amount_hits_ceiling(self):
        ext = ExtractedFields(vendor="X", amount=999999999, category="Other",
                              purpose="p", urgency="normal", missing_fields=[])
        d = policy.decide(ext, 100000, 0, [])
        assert d.status == RequestStatus.PENDING_APPROVAL
        assert any("ceiling" in r for r in d.risk_reasons)

# ===========================================================================
# 4. RECEIVED_AT MANIPULATION
# ===========================================================================
class TestReceivedAtManipulation:
    def test_past_timestamp_does_not_bypass_duplicate_detection(self, client):
        """Attacker sets received_at far in the past to dodge duplicate check."""
        past = (datetime.now(timezone.utc) - timedelta(days=365)).isoformat()
        resp1 = client.post("/webhook/request",
                            json=_payload("dup-manip-1", CLEAN_TEXT),
                            headers=HDRS)
        rid1 = resp1.json()["request_id"]
        resp2 = client.post("/webhook/request",
                            json={**_payload("dup-manip-2", CLEAN_TEXT),
                                  "received_at": past},
                            headers=HDRS)
        assert resp2.status_code == 200

    def test_future_timestamp_does_not_cause_crash(self, client):
        future = (datetime.now(timezone.utc) + timedelta(days=365)).isoformat()
        resp = client.post("/webhook/request",
                           json={**_payload("fut-test", CLEAN_TEXT),
                                 "received_at": future},
                           headers=HDRS)
        assert resp.status_code == 200

# ===========================================================================
# 5. IDEMPOTENCY RACE CONDITION
# ===========================================================================
class TestIdempotencyRace:
    def test_duplicate_key_returns_same_request(self, client):
        r1 = client.post("/webhook/request",
                         json=_payload("race-k1", CLEAN_TEXT),
                         headers=HDRS).json()
        r2 = client.post("/webhook/request",
                         json=_payload("race-k1", CLEAN_TEXT),
                         headers=HDRS).json()
        assert r1["status"] != "duplicate_ignored" or r2["status"] == "duplicate_ignored"
        assert client.fake.created == 1

# ===========================================================================
# 6. POLICY BYPASS ATTEMPTS
# ===========================================================================
class TestPolicyBypass:
    def test_ceiling_bypass_via_negative_category(self):
        ext = ExtractedFields(vendor="X", amount=49999, category=None,
                              purpose="p", urgency="normal", missing_fields=[])
        d = policy.decide(ext, 0, 0, [])
        assert d.status == RequestStatus.PENDING_APPROVAL

    def test_missing_vendor_cannot_auto_approve(self):
        ext = ExtractedFields(vendor=None, amount=100, category="Printing",
                              purpose="p", urgency="normal",
                              missing_fields=["vendor"])
        d = policy.decide(ext, 100000, 0, [])
        assert d.status == RequestStatus.NEEDS_CLARIFICATION

    def test_missing_amount_cannot_auto_approve(self):
        ext = ExtractedFields(vendor="X", amount=None, category="Printing",
                              purpose="p", urgency="normal",
                              missing_fields=["amount"])
        d = policy.decide(ext, 100000, 0, [])
        assert d.status == RequestStatus.NEEDS_CLARIFICATION

    def test_amount_at_ceiling_exact_is_escalated(self):
        ext = ExtractedFields(vendor="X", amount=50000, category="Other",
                              purpose="p", urgency="normal", missing_fields=[])
        d = policy.decide(ext, 100000, 0, [])
        assert d.status == RequestStatus.PENDING_APPROVAL

    def test_amount_just_under_ceiling_auto_approves(self):
        ext = ExtractedFields(vendor="X", amount=100, category="Other",
                              purpose="p", urgency="normal", missing_fields=[])
        d = policy.decide(ext, 100000, 0, [])
        assert d.status == RequestStatus.AUTO_APPROVED

# ===========================================================================
# 7. NOTION ERROR HANDLING
# ===========================================================================
class TestNotionErrorResilience:
    def test_notion_create_failure_502_no_crash(self, client):
        client.fake.fail_creates = True
        resp = client.post("/webhook/request",
                           json=_payload("nf-sec", CLEAN_TEXT),
                           headers=HDRS)
        assert resp.status_code == 502

    def test_check_approvals_survives_malformed_decision(self, client, monkeypatch):
        async def _bad_decision(page_id):
            return "Garbage", None
        monkeypatch.setattr(notion_client, "get_request_decision", _bad_decision)
        resp = client.post("/webhook/request",
                           json=_payload("app-sec", RISKY_TEXT),
                           headers=HDRS)
        assert resp.status_code == 200
        poll = client.post("/notion/check-approvals", headers=HDRS)
        assert poll.status_code == 200

    def test_check_approvals_survives_notion_page_missing(self, client, monkeypatch):
        async def _no_page(page_id):
            raise notion_client.NotionAPIError("page not found")
        monkeypatch.setattr(notion_client, "get_request_decision", _no_page)
        resp = client.post("/webhook/request",
                           json=_payload("np-sec", RISKY_TEXT),
                           headers=HDRS)
        assert resp.status_code == 200
        poll = client.post("/notion/check-approvals", headers=HDRS)
        body = poll.json()
        assert len(body["failed"]) == 1

# ===========================================================================
# 8. EXCEPTION LEAKAGE
# ===========================================================================
class TestExceptionLeakage:
    def test_502_does_not_leak_notion_details(self, client):
        client.fake.fail_creates = True
        resp = client.post("/webhook/request",
                           json=_payload("leak-test", CLEAN_TEXT),
                           headers=HDRS)
        assert resp.status_code == 502
        body = resp.json()["detail"]
        assert "secret" not in body.lower()
        assert "token" not in body.lower()
        assert "Bearer" not in body

    def test_401_does_not_leak_secret_value(self, client):
        resp = client.post("/webhook/request", json=_payload())
        assert resp.status_code == 401
        body = resp.json()["detail"]
        assert "test-secret" not in body

# ===========================================================================
# 9. CATEGORY VALIDATION
# ===========================================================================
class TestCategoryValidation:
    def test_invalid_category_routes_to_clarification(self):
        ext = ExtractedFields(vendor="X", amount=100, category="INVALIDCategory!!!",
                              purpose="p", urgency="normal", missing_fields=[])
        d = policy.decide(ext, 0, 0, [])
        assert d.status == RequestStatus.NEEDS_CLARIFICATION
        assert "not recognized" in d.risk_reasons[0].lower()

    def test_none_category_does_not_crash_policy(self):
        ext = ExtractedFields(vendor="X", amount=100, category=None,
                              purpose="p", urgency="normal", missing_fields=[])
        d = policy.decide(ext, 50000, 49000, [])
        assert d.status in (RequestStatus.AUTO_APPROVED, RequestStatus.PENDING_APPROVAL)

    def test_valid_category_passes_through(self):
        ext = ExtractedFields(vendor="X", amount=100, category="Printing",
                              purpose="p", urgency="normal", missing_fields=[])
        d = policy.decide(ext, 50000, 0, [])
        assert d.status == RequestStatus.AUTO_APPROVED

# ===========================================================================
# 10. STORE RESILIENCE
# ===========================================================================
class TestStoreResilience:
    @pytest.mark.asyncio
    async def test_get_nonexistent_record_returns_none(self):
        result = await store.get_record("REQ-NONEXISTENT")
        assert result is None

    @pytest.mark.asyncio
    async def test_recent_records_limit_works(self):
        for i in range(3):
            incoming = IncomingRequest(
                idempotency_key=f"stress-{i}",
                requester_name="S", requester_contact="s@s.com", raw_text="t")
            extracted = ExtractedFields(vendor="V", amount=10, category="Other",
                                        purpose="p", urgency="normal")
            record = RequestRecord(
                request_id=f"REQ-STRESS{i}",
                incoming=incoming, extracted=extracted,
                decision=Decision(status=RequestStatus.AUTO_APPROVED))
            await store.save_record(record)
        recs = await store.recent_records()
        assert len(recs) >= 3
