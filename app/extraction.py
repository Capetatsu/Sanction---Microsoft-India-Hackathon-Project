"""
AI's job here is strictly: turn messy free text into structured facts, and
produce a plain-language summary a human can read in Notion. It does NOT
decide whether to approve anything — that authority lives entirely in
policy.py. This split is what makes the AI's role defensible: it does the
one thing rules can't (parse open-ended language), and nothing it isn't
trusted to do (spend money).
"""
import json
import logging
from google import genai
from app.config import settings
from app.models import ExtractedFields

logger = logging.getLogger(__name__)
_client = genai.Client(api_key=settings.GEMINI_API_KEY) if settings.GEMINI_API_KEY else None
if _client:
    logger.info("GEMINI client initialized: True")
else:
    logger.warning("GEMINI client initialized: False (no API key)")

EXTRACTION_PROMPT = """You extract structured fields from a college club expense request.
Return ONLY a JSON object, no prose, matching this schema:
{{
  "vendor": string or null,
  "amount": number or null,
  "category": one of ["Decorations","Stationery","Food & Refreshments","Printing","Transport","Equipment Rental","Other"] or null,
  "purpose": short string or null,
  "urgency": "normal" or "urgent",
  "missing_fields": array of field names that are required but absent (from: vendor, amount, category, purpose),
  "ai_summary": one-sentence plain-language summary of the request for a human approver
}}

Request text:
\"\"\"{text}\"\"\"
"""


def extract(raw_text: str) -> ExtractedFields:
    if _client is None:
        return _heuristic_fallback(raw_text)

    try:
        response = _client.models.generate_content(
            model="gemini-flash-latest",
            contents=EXTRACTION_PROMPT.format(text=raw_text),
            config=genai.types.GenerateContentConfig(
                response_mime_type="application/json",
                max_output_tokens=500,
            ),
        )
        logger.info("GEMINI API call: success")
    except Exception as e:
        status = getattr(e, "status_code", None) or getattr(e, "code", None) or getattr(e, "status", None)
        logger.warning("GEMINI API call: failed", extra={"error_type": type(e).__name__, "status": status, "error_message": str(e)[:200]})
        return _api_failure_fallback(raw_text)
    text_out = (response.text or "").strip()
    text_out = text_out.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        data = json.loads(text_out)
        logger.info("GEMINI response JSON: valid")
    except json.JSONDecodeError:
        logger.warning("GEMINI response JSON: invalid")
        return _heuristic_fallback(raw_text)

    return ExtractedFields(
        vendor=data.get("vendor"),
        amount=data.get("amount"),
        category=data.get("category"),
        purpose=data.get("purpose"),
        urgency=data.get("urgency", "normal"),
        missing_fields=data.get("missing_fields", []),
        ai_summary=data.get("ai_summary", ""),
    )


def _heuristic_fallback(raw_text: str) -> ExtractedFields:
    """Used only if no API key is configured (e.g. offline dev). Never used
    in the actual demo — flagged loudly so it's never mistaken for the real
    extraction path."""
    return ExtractedFields(
        vendor=None,
        amount=None,
        category=None,
        purpose=None,
        urgency="normal",
        missing_fields=["vendor", "amount", "category"],
        ai_summary="[FALLBACK — no GEMINI_API_KEY set] Could not parse request: " + raw_text[:120],
    )


def _api_failure_fallback(raw_text: str) -> ExtractedFields:
    """Used when the Gemini API call itself fails (rate limit/outage/etc.)
    with a key configured. Labeled distinctly from the no-key fallback so the
    two causes are never confused when reading the Run Log / AI Summary."""
    return ExtractedFields(
        vendor=None,
        amount=None,
        category=None,
        purpose=None,
        urgency="normal",
        missing_fields=["vendor", "amount", "category"],
        ai_summary="[FALLBACK — AI extraction API call failed] Could not parse request: " + raw_text[:120],
    )
