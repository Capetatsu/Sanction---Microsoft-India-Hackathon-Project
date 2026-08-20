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
import httpx
from app.config import settings
from app.models import ExtractedFields

logger = logging.getLogger(__name__)

GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = getattr(settings, "GROQ_MODEL", "openai/gpt-oss-20b")

_client_api_key = getattr(settings, "GROQ_API_KEY", "")
if _client_api_key:
    logger.info("GROQ client initialized: True")
else:
    logger.warning("GROQ client initialized: False (no API key)")


EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "vendor": {"type": ["string", "null"]},
        "amount": {"type": ["number", "null"]},
        "category": {
            "type": ["string", "null"],
            "enum": ["Decorations", "Printing", "Equipment", "Food", "Travel", "Other"]
        },
        "purpose": {"type": ["string", "null"]},
        "urgency": {"type": ["string", "null"], "enum": ["normal", "urgent"]},
        "missing_fields": {
            "type": "array",
            "items": {"type": "string"}
        },
        "ai_summary": {"type": "string"}
    },
    "required": ["vendor", "amount", "category", "purpose", "urgency", "missing_fields", "ai_summary"],
    "additionalProperties": False
}

EXTRACTION_PROMPT = """You extract structured fields from a college club expense request.
Return ONLY a JSON object matching the schema.

Categories: Decorations, Printing, Equipment, Food, Travel, Other

Request text:
\"\"\"{text}\"\"\"
"""


def extract(raw_text: str) -> ExtractedFields:
    if not _client_api_key:
        return _heuristic_fallback(raw_text)

    payload = {
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": "You extract structured fields from expense requests. Return valid JSON only."},
            {"role": "user", "content": EXTRACTION_PROMPT.format(text=raw_text)}
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "extracted_fields",
                "schema": EXTRACTION_SCHEMA,
                "strict": True
            }
        },
        "max_tokens": 500,
        "temperature": 0
    }

    headers = {
        "Authorization": f"Bearer {_client_api_key}",
        "Content-Type": "application/json"
    }

    try:
        with httpx.Client(timeout=30) as client:
            response = client.post(GROQ_API_URL, headers=headers, json=payload)
            response.raise_for_status()
        logger.info("GROQ API call: success")
    except httpx.HTTPStatusError as e:
        logger.warning("GROQ API call: failed", extra={
            "error_type": type(e).__name__,
            "status": e.response.status_code,
            "error_message": str(e)[:200]
        })
        return _api_failure_fallback(raw_text)
    except Exception as e:
        logger.warning("GROQ API call: failed", extra={
            "error_type": type(e).__name__,
            "status": None,
            "error_message": str(e)[:200]
        })
        return _api_failure_fallback(raw_text)

    try:
        response_json = response.json()
        content = response_json["choices"][0]["message"]["content"]
        data = json.loads(content)
        logger.info("GROQ response JSON: valid")
    except (KeyError, IndexError, json.JSONDecodeError) as e:
        logger.warning("GROQ response JSON: invalid", extra={"error_type": type(e).__name__})
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
        ai_summary="[FALLBACK — no GROQ_API_KEY set] Could not parse request: " + raw_text[:120],
    )


def _api_failure_fallback(raw_text: str) -> ExtractedFields:
    """Used when the Groq API call itself fails (rate limit/outage/etc.)
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