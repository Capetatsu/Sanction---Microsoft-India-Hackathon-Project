"""
This module — not the LLM — makes the approve/escalate/reject call. The
extraction step only supplies facts; every threshold here is a plain
if-statement, on purpose, so the decision is explainable and auditable.
"""
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from app.config import settings
from app.models import ExtractedFields, Decision, RequestStatus, RequestRecord


def _vendor_similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


def decide(
    extracted: ExtractedFields,
    budget_cap: float,
    budget_spent: float,
    recent_requests: list[RequestRecord],
) -> Decision:
    reasons: list[str] = []

    # 1. Missing required fields -> cannot decide at all
    if extracted.missing_fields or extracted.amount is None or extracted.vendor is None:
        return Decision(
            status=RequestStatus.NEEDS_CLARIFICATION,
            risk_reasons=[f"Missing required field(s): {', '.join(extracted.missing_fields) or 'amount/vendor'}"],
        )

    if extracted.amount <= 0:
        return Decision(
            status=RequestStatus.NEEDS_CLARIFICATION,
            risk_reasons=["Amount is zero or invalid."],
        )

    # 1b. Hard sanity ceiling — guards against a prompt-injection/model error
    # producing a large-but-under-budget-threshold number that would
    # otherwise sail through Auto-Approved.
    if extracted.amount > settings.MAX_AUTO_APPROVE_AMOUNT:
        return Decision(
            status=RequestStatus.PENDING_APPROVAL,
            risk_reasons=[
                f"Amount (₹{extracted.amount:.0f}) exceeds the hard sanity ceiling "
                f"(₹{settings.MAX_AUTO_APPROVE_AMOUNT:.0f}) — requires human review."
            ],
        )

    # 2. Duplicate detection: same/similar vendor + similar amount within window
    duplicate_of = None
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.DUPLICATE_WINDOW_DAYS)
    for r in recent_requests:
        if r.incoming.received_at < cutoff:
            continue
        if r.extracted.vendor is None or r.extracted.amount is None:
            continue
        vendor_sim = _vendor_similarity(r.extracted.vendor, extracted.vendor)
        amount_close = (
            abs(r.extracted.amount - extracted.amount) / max(r.extracted.amount, 1) < 0.2
        )
        if vendor_sim > 0.75 and amount_close:
            duplicate_of = r.request_id
            reasons.append(
                f"Possible duplicate of request {r.request_id} — similar vendor "
                f"('{r.extracted.vendor}') and amount within the last "
                f"{settings.DUPLICATE_WINDOW_DAYS} days."
            )
            break

    # 3. Budget check
    remaining = budget_cap - budget_spent
    if extracted.amount > remaining:
        reasons.append(
            f"Request (₹{extracted.amount:.0f}) exceeds remaining budget "
            f"(₹{remaining:.0f}) for category '{extracted.category}'."
        )
    elif remaining > 0 and extracted.amount / remaining > settings.AUTO_APPROVE_CAP_FRACTION:
        reasons.append(
            f"Request is {extracted.amount / remaining:.0%} of remaining category "
            f"budget — above the {settings.AUTO_APPROVE_CAP_FRACTION:.0%} auto-approve threshold."
        )

    # 4. Urgency + no prior history is a soft risk signal, not a hard block
    if extracted.urgency == "urgent" and not recent_requests:
        reasons.append("Marked urgent with no prior request history from this requester.")

    if reasons:
        return Decision(status=RequestStatus.PENDING_APPROVAL, risk_reasons=reasons, duplicate_of=duplicate_of)

    return Decision(status=RequestStatus.AUTO_APPROVED, risk_reasons=[])
