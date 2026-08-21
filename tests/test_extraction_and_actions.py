"""No-network-required tests: fallback paths that must never crash."""
import json
from app import extraction, actions
from app.models import RequestRecord, IncomingRequest, ExtractedFields, Decision, RequestStatus


def test_extraction_no_api_key_uses_heuristic_fallback(monkeypatch):
    monkeypatch.setattr(extraction, "_client_api_key", "")
    result = extraction.extract("some raw text")
    assert result.missing_fields == ["vendor", "amount", "category"]
    assert "no GROQ_API_KEY" in result.ai_summary


def test_extraction_api_failure_uses_fallback(monkeypatch):
    import httpx
    def mock_post(*args, **kwargs):
        raise httpx.HTTPStatusError("Rate limited", request=None, response=httpx.Response(429))
    monkeypatch.setattr(httpx.Client, "post", mock_post)
    monkeypatch.setattr(extraction, "_client_api_key", "test-key")
    result = extraction.extract("some raw text")
    assert result.missing_fields == ["vendor", "amount", "category"]
    assert "AI extraction API call failed" in result.ai_summary


def test_extraction_malformed_response_uses_fallback(monkeypatch):
    import httpx
    class MockResponse:
        status_code = 200
        def json(self):
            return {"choices": [{"message": {"content": "not valid json"}}]}
        def raise_for_status(self):
            pass
    def mock_post(*args, **kwargs):
        return MockResponse()
    monkeypatch.setattr(httpx.Client, "post", mock_post)
    monkeypatch.setattr(extraction, "_client_api_key", "test-key")
    result = extraction.extract("some raw text")
    assert result.missing_fields == ["vendor", "amount", "category"]
    assert "no GROQ_API_KEY" in result.ai_summary or "AI extraction API call failed" in result.ai_summary


def test_valid_groq_extraction(monkeypatch):
    import httpx
    valid_response = {
        "vendor": "Copy King",
        "amount": 2000,
        "category": "Printing",
        "purpose": "printing posters for the college cultural fest tomorrow",
        "urgency": "normal",
        "missing_fields": [],
        "ai_summary": "Request of Rs 2000 for printing posters from Copy King for the college fest."
    }
    class MockResponse:
        status_code = 200
        def json(self):
            return {"choices": [{"message": {"content": json.dumps(valid_response)}}]}
        def raise_for_status(self):
            pass
    def mock_post(*args, **kwargs):
        return MockResponse()
    monkeypatch.setattr(httpx.Client, "post", mock_post)
    monkeypatch.setattr(extraction, "_client_api_key", "test-key")
    result = extraction.extract("I need Rs 2000 for printing posters from Copy King for the fest")
    assert result.vendor == "Copy King"
    assert result.amount == 2000
    assert result.category == "Printing"
    assert result.purpose == "printing posters for the college cultural fest tomorrow"
    assert result.urgency == "normal"
    assert result.missing_fields == []
    assert "Copy King" in result.ai_summary


def test_category_enum_validation(monkeypatch):
    import httpx
    # Test that invalid category rejected by Groq API (400) triggers fallback
    def mock_post(*args, **kwargs):
        response = httpx.Response(400, json={"error": "Invalid enum value"})
        raise httpx.HTTPStatusError("Invalid enum", request=None, response=response)
    monkeypatch.setattr(httpx.Client, "post", mock_post)
    monkeypatch.setattr(extraction, "_client_api_key", "test-key")
    result = extraction.extract("test")
    # Should fall back because API rejected invalid enum
    assert result.missing_fields == ["vendor", "amount", "category"]


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