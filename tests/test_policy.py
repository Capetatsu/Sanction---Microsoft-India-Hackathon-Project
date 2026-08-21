"""Unit tests for the deterministic policy engine (no network/DB needed)."""
import pytest
from datetime import datetime, timedelta, timezone
from app.models import ExtractedFields, RequestRecord, IncomingRequest, Decision, RequestStatus
from app import policy


def _fields(**kw):
    base = dict(vendor="Acme Printers", amount=1000, category="Printing", purpose="banners", urgency="normal", missing_fields=[])
    base.update(kw)
    return ExtractedFields(**base)


def _record(vendor, amount, request_id="REQ-OLD1", days_ago=1, status=RequestStatus.AUTO_APPROVED):
    incoming = IncomingRequest(
        idempotency_key=f"k-{request_id}",
        requester_name="Test",
        requester_contact="t@example.edu",
        raw_text="x",
        received_at=datetime.now(timezone.utc) - timedelta(days=days_ago),
    )
    extracted = ExtractedFields(vendor=vendor, amount=amount, category="Printing", purpose="p", urgency="normal", missing_fields=[])
    return RequestRecord(request_id=request_id, incoming=incoming, extracted=extracted, decision=Decision(status=status))


def test_clean_request_auto_approved():
    d = policy.decide(_fields(), budget_cap=100000, budget_spent=0, recent_requests=[])
    assert d.status == RequestStatus.AUTO_APPROVED


def test_missing_fields_needs_clarification():
    d = policy.decide(_fields(vendor=None, missing_fields=["vendor"]), budget_cap=100000, budget_spent=0, recent_requests=[])
    assert d.status == RequestStatus.NEEDS_CLARIFICATION


def test_zero_amount_needs_clarification():
    d = policy.decide(_fields(amount=0), budget_cap=100000, budget_spent=0, recent_requests=[])
    assert d.status == RequestStatus.NEEDS_CLARIFICATION


def test_over_budget_escalates():
    d = policy.decide(_fields(amount=5000), budget_cap=1000, budget_spent=900, recent_requests=[])
    assert d.status == RequestStatus.PENDING_APPROVAL


def test_over_hard_ceiling_escalates_even_within_budget():
    d = policy.decide(_fields(amount=999999), budget_cap=10_000_000, budget_spent=0, recent_requests=[])
    assert d.status == RequestStatus.PENDING_APPROVAL
    assert any("sanity ceiling" in r for r in d.risk_reasons)


def test_duplicate_vendor_and_amount_escalates():
    prior = _record("Acme Printers", 1000)
    d = policy.decide(_fields(vendor="Acme Printer's", amount=1020), budget_cap=100000, budget_spent=0, recent_requests=[prior])
    assert d.status == RequestStatus.PENDING_APPROVAL
    assert d.duplicate_of == "REQ-OLD1"


def test_duplicate_outside_window_ignored():
    prior = _record("Acme Printers", 1000, days_ago=30)
    d = policy.decide(_fields(vendor="Acme Printers", amount=1000), budget_cap=100000, budget_spent=0, recent_requests=[prior])
    assert d.status == RequestStatus.AUTO_APPROVED
