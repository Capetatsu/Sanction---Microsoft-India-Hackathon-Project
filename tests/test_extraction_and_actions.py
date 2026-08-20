"""No-network-required tests: fallback paths that must never crash."""
from app import extraction, actions
from app.models import RequestRecord, IncomingRequest, ExtractedFields, Decision, RequestStatus


def test_extraction_no_api_key_uses_heuristic_fallback(monkeypatch):
    monkeypatch.setattr(extraction, "_client", None)
    result = extraction.extract("some raw text")
    assert result.missing_fields == ["vendor", "amount", "category"]
    assert "no ANTHROPIC_API_KEY" in result.ai_summary


def _make_record():
    incoming = IncomingRequest(idempotency_key="k", requester_name="A", requester_contact="a@b.com", raw_text="t")
    extracted = ExtractedFields(vendor="V", amount=10, category="Other", purpose="p", urgency="normal")
    return RequestRecord(request_id="REQ-T1", incoming=incoming, extracted=extracted, decision=Decision(status=RequestStatus.AUTO_APPROVED))


def test_email_without_resend_key_logs_instead_of_sending(monkeypatch, capsys):
    from app.config import settings
    monkeypatch.setattr(settings, "RESEND_API_KEY", "")
    record = _make_record()
    pdf_path = actions.generate_authorization_pdf(record)
    actions.send_authorization_email(record, pdf_path)  # must not raise
    out = capsys.readouterr().out
    assert "RESEND_API_KEY not set" in out
