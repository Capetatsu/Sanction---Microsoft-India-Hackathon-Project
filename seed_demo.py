"""
Send the three canned demo requests to a running Sanction backend.

Usage:
    python seed_demo.py --case clean
    python seed_demo.py --case risky
    python seed_demo.py --case garbage
    python seed_demo.py --case all --base https://sanction.onrender.com --secret <webhook secret>

Each run uses a fresh idempotency key, so re-running a case creates a new
request (and — for the risky case — a fresh row waiting for a Notion decision).
"""
import argparse
import json
import os
import uuid
from urllib.error import HTTPError
from urllib.request import Request, urlopen

CASES = {
    "clean": (
        "Need Rs 2000 for printing posters from Copy King for the fest"
    ),
    "risky": (
        "Need Rs 18000 to print the fest programme from Printing Corner, event is in 2 days"
    ),
    "garbage": (
        "I need money urgently"
    ),
}


def send(case: str, base: str, secret: str):
    raw_text = CASES[case] if case in CASES else case
    payload = {
        "idempotency_key": f"seed-{uuid.uuid4().hex[:12]}",
        "requester_name": "Aisha Mehta (seed)",
        "requester_contact": "aisha@campus.edu",
        "raw_text": raw_text,
    }
    req = Request(
        f"{base.rstrip('/')}/webhook/request",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "X-Webhook-Secret": secret},
        method="POST",
    )
    try:
        with urlopen(req, timeout=20) as resp:
            body = json.loads(resp.read().decode())
    except HTTPError as e:
        body = {"error": e.code, "detail": e.read().decode()[:500]}
    print(json.dumps(body, indent=2))
    return body


def main():
    ap = argparse.ArgumentParser(description="Send a canned Sanction demo request")
    ap.add_argument("--case", required=True, help="clean | risky | garbage | or any raw sentence")
    ap.add_argument("--base", default=os.getenv("SANCTION_BASE", "http://localhost:8000"))
    ap.add_argument("--secret", default=os.getenv("WEBHOOK_SECRET", ""))
    args = ap.parse_args()
    if not args.secret:
        print("set --secret (or WEBHOOK_SECRET) — the webhook fails closed without it", file=sys.stderr)
        sys.exit(1)
    send(args.case, args.base, args.secret)


if __name__ == "__main__":
    main()