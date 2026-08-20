"""
The real, external action: a payment-authorization PDF, emailed to the
accounts contact and the requester. Deliberately not "payment sent" —
that claim would be undemonstrable and dishonest. This is a concrete,
verifiable action that happens outside Notion, which is what the track
requires.

Email is sent via the Resend HTTPS API, not smtplib — Render's free tier
blocks outbound traffic on SMTP ports 25/465/587.
"""
import base64
import os
import httpx
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from app.config import settings
from app.models import RequestRecord

OUTPUT_DIR = "/tmp/sanction_authorizations"
os.makedirs(OUTPUT_DIR, exist_ok=True)

RESEND_URL = "https://api.resend.com/emails"


class EmailSendError(Exception):
    pass


def generate_authorization_pdf(record: RequestRecord) -> str:
    path = os.path.join(OUTPUT_DIR, f"{record.request_id}.pdf")
    c = canvas.Canvas(path, pagesize=A4)
    width, height = A4
    y = height - 60

    c.setFont("Helvetica-Bold", 16)
    c.drawString(50, y, "Payment Authorization")
    y -= 30
    c.setFont("Helvetica", 10)
    c.drawString(50, y, f"Request ID: {record.request_id}")
    y -= 18
    c.drawString(50, y, f"Requester: {record.incoming.requester_name} ({record.incoming.requester_contact})")
    y -= 18
    c.drawString(50, y, f"Vendor: {record.extracted.vendor}")
    y -= 18
    c.drawString(50, y, f"Category: {record.extracted.category}")
    y -= 18
    c.drawString(50, y, f"Amount: Rs. {record.extracted.amount:,.2f}")
    y -= 18
    c.drawString(50, y, f"Purpose: {record.extracted.purpose}")
    y -= 18
    c.drawString(50, y, f"Status: {record.decision.status.value}")
    y -= 18
    c.drawString(50, y, f"Decided by: {record.decided_by or 'Auto-approved by policy engine'}")
    y -= 18
    c.drawString(50, y, f"Decided at: {record.decided_at}")
    y -= 30
    c.setFont("Helvetica-Oblique", 9)
    c.drawString(50, y, "Generated automatically by Sanction. Full audit trail in the Notion Run Log.")
    c.save()
    return path


def send_authorization_email(record: RequestRecord, pdf_path: str) -> bool:
    """Send via Resend. Returns True if the email was actually sent, False if
    no provider key is configured (local fallback — logged, not silently
    claimed as sent). Raises EmailSendError when the send genuinely fails;
    caller (main.py) catches that and writes an honest Run Log Error row."""
    body = (
        f"A request has been {record.decision.status.value.lower()}.\n\n"
        f"Amount: Rs. {record.extracted.amount:,.2f}\n"
        f"Vendor: {record.extracted.vendor}\n"
        f"Category: {record.extracted.category}\n"
        f"Decided by: {record.decided_by or 'Auto-approved by policy engine'}\n\n"
        f"Full audit trail: see the Sanction Run Log in Notion, request {record.request_id}."
    )

    if not settings.RESEND_API_KEY:
        # No email provider configured — log instead of failing, so the
        # pipeline is still demoable without live credentials. This is
        # NOT the same as a send failure and is not logged as one.
        print(f"[actions] RESEND_API_KEY not set — would send email:\n{body[:500]}")
        return False

    with open(pdf_path, "rb") as f:
        attachment_b64 = base64.b64encode(f.read()).decode("ascii")

    payload = {
        "from": settings.FROM_EMAIL,
        "to": [settings.ACCOUNTS_EMAIL],
        "cc": [record.incoming.requester_contact],
        "subject": f"Payment Authorization — {record.request_id} — {record.extracted.vendor}",
        "text": body,
        "attachments": [
            {"filename": os.path.basename(pdf_path), "content": attachment_b64}
        ],
    }
    headers = {"Authorization": f"Bearer {settings.RESEND_API_KEY}"}

    try:
        with httpx.Client(timeout=15) as client:
            resp = client.post(RESEND_URL, headers=headers, json=payload)
            resp.raise_for_status()
    except httpx.HTTPError as e:
        raise EmailSendError(f"Resend send failed: {e}") from e
    return True
