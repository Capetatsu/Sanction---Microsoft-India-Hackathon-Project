# Sanction — Automated expense-request approval for college clubs

**The one job:** a club/fest expense request arrives as messy text → the backend
extracts it (AI), checks it against the budget and past spend (deterministic
code), flag anything risky or duplicate → safe requests auto-clear, risky ones
pause in Notion for a human → once approved, the backend generates a
payment-authorization PDF and emails it to accounts → every step is written to
the Notion Run Log by the integration token, with real timestamps.

**Why AI doesn't decide and Notion isn't just a database:**
The LLM only converts free text into structured fields plus a human-readable
summary — it never approves anything. Every approve/escalate/reject decision is
a plain if-statement in `app/policy.py`, auditable by a judge. Notion is the
system of record and the human's only approval surface, but the logic live
downstream of it in this repo; with the backend off, nothing new happens.

## Pipeline

```
POST /webhook/request (secret-guarded)
  -> request_id + idempotency check (Postgres)
  -> AI extraction (one structured-JSON Anthropic call)
  -> policy.decide(): missing / duplicate / over-budget / over-threshold
  -> safe -> auto-approve                          risky -> Notion "Pending Approval"
  -> Run Log row at every transition
  -> external action: authorization PDF (reportlab) + email (Resend)
  -> POST /notion/check-approvals (polled by cron) resumes human decisions
```

## Repository layout

```
app/main.py           FastAPI: webhook intake + approval polling + action runner
app/models.py         Pydantic schemas (thin validation at the door, PART 13)
app/extraction.py     LLM call: free text → structured fields + summary
app/policy.py         Deterministic decision engine (the actual authority)
app/notion_client.py  Notion API wrapper (requests / budgets / run log / polling)
app/actions.py        Authorization PDF (reportlab) + email (Resend HTTPS)
app/store.py          Durable Postgres: records + idempotency keys
app/runlog.py         Single choke point for Run Log writes
app/config.py         Env var loading
static/demo_form.html One-page live trigger form
seed_demo.py          Posts the canned clean/risky/garbage cases
docs/notion_setup.md  Manual steps: 3 databases + integration + views
docs/demo_script.md   The 3-scenario walkthrough
tests/                policy, extraction/actions fallbacks, store, end-to-end
```

## Setup

```bash
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in NOTION_*, ANTHROPIC_API_KEY, RESEND_API_KEY,
                       # DATABASE_URL, WEBHOOK_SECRET
uvicorn app.main:app --reload
```

Run the tests (no credentials needed):

```bash
pytest -q
```

## Live demo (local)

```bash
pytest -q; uvicorn app.main:app --reload
python seed_demo.py --case clean   # → Auto-Approved + PDF email + Run Log
python seed_demo.py --case risky   # → Pending Approval in Notion
python seed_demo.py --case garbage # → Needs Clarification, no guesswork
```

Or open `http://localhost:8000/` and type a request in the form.

For the risky case, set `Decision = Approved` on the Notion row, then hit
`POST /notion/check-approvals` (or wait for the cron) — the workflow resumes by
itself: status → Approved, PDF email sent, Run Log completes.

## Production

- **Render.com free web service** — `Procfile` runs `uvicorn app.main:app`.
  Add Postgres (`DATABASE_URL`) via a free database plan; the store needs it
  (ephemeral disks otherwise).
- **Scheduler for `/notion/check-approvals`** — Render can't keep a persistent
  loop on the free tier, so use cron-job.org / UptimeRobot to hit
  `POST /notion/check-approvals` every ~15s.
- **Health check** — `GET /health`. Wire it into UptimeRobot (or cron-job) so
  the free web service hasn't cold-slept mid-demo.
- Fill `WEBHOOK_SECRET` and set it in the demo form and seed script, shared
  secret; the webhook fails closed (500) if unset and 401s on a bad secret.
- Notion resources: see `docs/notion_setup.md` — three databases (Requests,
  Budgets, Run Log) shared with one integration.

## Tested behaviors

1. Safe request → auto-approve → PDF + email (or local fallback log) → Run Log
2. Risky request → Pending in Notion → approve → resumes → action → Run Log
3. Risky request → reject → no external action → Run Log
4. Garbage/incomplete request → Needs Clarification, never guessed or crashed
5. Duplicate webhook delivery → `duplicate_ignored`, no double processing
6. Duplicate expense → escalated with `duplicate_of`, never auto-approved
7. AI failure / Notion failure / email failure → honest Error row or honest
   fallback, never a silently claimed success

## Demo script

See `docs/demo_script.md` — 3 scenarios, cast in under 5 minutes.