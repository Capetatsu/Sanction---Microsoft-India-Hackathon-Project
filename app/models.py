from __future__ import annotations
from datetime import datetime
from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field


class RequestStatus(str, Enum):
    AUTO_APPROVED = "Auto-Approved"
    PENDING_APPROVAL = "Pending Approval"
    NEEDS_CLARIFICATION = "Needs Clarification"
    APPROVED = "Approved"
    REJECTED = "Rejected"


class IncomingRequest(BaseModel):
    """Raw payload hitting the webhook — as messy as real life. Field caps
    (PART 13) stop oversized input from reaching the LLM or Notion writes."""
    idempotency_key: str = Field(max_length=200)
    requester_name: str = Field(max_length=200)
    requester_contact: str = Field(max_length=200)
    raw_text: str = Field(max_length=2000)
    received_at: datetime = Field(default_factory=datetime.utcnow)


class ExtractedFields(BaseModel):
    """What the AI pulls out of raw_text. Facts only — no decision."""
    vendor: Optional[str] = None
    amount: Optional[float] = None
    category: Optional[str] = None
    purpose: Optional[str] = None
    urgency: Optional[str] = None  # "normal" | "urgent"
    missing_fields: list[str] = Field(default_factory=list)
    ai_summary: str = ""


class Decision(BaseModel):
    """Output of the deterministic policy engine — this, not the LLM, decides."""
    status: RequestStatus
    risk_reasons: list[str] = Field(default_factory=list)
    duplicate_of: Optional[str] = None  # request_id it may duplicate


class RequestRecord(BaseModel):
    request_id: str
    incoming: IncomingRequest
    extracted: ExtractedFields
    decision: Decision
    notion_page_id: Optional[str] = None
    decided_by: Optional[str] = None
    decided_at: Optional[datetime] = None
