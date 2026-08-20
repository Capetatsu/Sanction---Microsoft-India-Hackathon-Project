"""Idempotency / store tests using the in-memory fallback (no Postgres needed
for this suite; DATABASE_URL unset). Covers double-delivery protection."""
import pytest
from app import store
from app.models import RequestRecord, IncomingRequest, ExtractedFields, Decision, RequestStatus


@pytest.mark.asyncio
async def test_idempotency_double_delivery():
    key = "idem-key-1"
    assert await store.already_processed(key) is None
    await store.mark_processed(key, "REQ-AAA")
    assert await store.already_processed(key) == "REQ-AAA"
    # second mark is a no-op, first request_id wins
    await store.mark_processed(key, "REQ-BBB")
    assert await store.already_processed(key) == "REQ-AAA"


@pytest.mark.asyncio
async def test_save_and_get_record_roundtrip():
    incoming = IncomingRequest(idempotency_key="k2", requester_name="A", requester_contact="a@b.com", raw_text="text")
    extracted = ExtractedFields(vendor="V", amount=10, category="Other", purpose="p", urgency="normal")
    record = RequestRecord(request_id="REQ-ZZZ", incoming=incoming, extracted=extracted, decision=Decision(status=RequestStatus.AUTO_APPROVED))
    await store.save_record(record)
    fetched = await store.get_record("REQ-ZZZ")
    assert fetched.request_id == "REQ-ZZZ"
    assert fetched.extracted.vendor == "V"
