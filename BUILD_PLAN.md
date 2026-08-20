# Sanction — Complete Build Plan
*Automate India Hackathon — Notion Track*

Source of truth for every requirement cited below: `Theme - Notion Track.pdf`.
Anything not directly stated in that PDF is labeled **[inference]**.

---

## PART 1 — Final Product Definition

**One-sentence definition:** Sanction is a backend service that receives free-text expense requests, auto-clears the ones that are clean and within budget, pauses risky ones for a human decision inside Notion, and — once cleared — generates and emails a payment-authorization document, logging every step.

**Exact problem:** club/committee treasurers manually read, judge, and track expense requests sent as informal text, with no audit trail and no consistent policy.

**Exact target user:** a single college club/fest committee treasurer and their approver (faculty advisor or senior member).

**Exact workflow automated:** *expense request → understand → check against budget/policy/history → auto-clear or escalate → human decision if escalated → authorization document generated and sent → logged.*

**Inside the MVP:**
- One intake channel (webhook, PART 6)
- AI extraction of vendor/amount/category/purpose/urgency
- Deterministic policy engine (budget cap, duplicate detection, missing-field check)
- Notion as the only interface for approval, budget view, and Run Log
- One real external action: authorization PDF + email
- Idempotent, logged, reliable pipeline

**Explicitly OUTSIDE scope:** real payment/UPI transfer, multi-club/multi-org support, a frontend web app beyond a demo form, general accounting/ledger features, receipts/OCR, multi-language input **[inference: cut for time, not because it's a bad idea]**, mobile app, analytics dashboards beyond what Notion natively gives you, any second job (e.g., budget planning, reimbursement disputes).

**What changes vs. your current concept doc:** drop "WhatsApp message sent to requester" from the external action — keep the action to *one* reliable channel (email) as PART 10 argues; the PDF requires *a* real action, not several.

---

## PART 2 — Architecture

```text
Form/webhook (trigger)
      ↓
Backend (FastAPI) — receives, generates request_id, checks idempotency key
      ↓
AI layer (Claude, structured JSON) — extracts fields, writes plain-language summary
      ↓
Policy engine (deterministic Python) — budget check, duplicate check, missing-field check
      ↓
      ┌─────────────┴─────────────┐
      ↓                           ↓
   Safe                        Risky / incomplete
      ↓                           ↓
 Auto-execute              Notion: Requests DB row,
      ↓                     Status = Pending Approval
 (skip to Run Log)               ↓
                            Human opens Notion,
                            sets Decision = Approved/Rejected
                                 ↓
                       Backend polls Notion, detects decision
                                 ↓
                            Resume: execute or stop
      ↓                           ↓
      └─────────────┬─────────────┘
                     ↓
        External action: generate authorization PDF,
        email to accounts contact + requester
                     ↓
        Run Log row written by backend (Notion API)
```

**Every step, what happens:**
1. **Trigger** — an HTTP POST hits your deployed backend. Nothing is run by hand.
2. **Backend** — validates payload shape, checks `idempotency_key` against SQLite, generates `request_id`.
3. **AI layer** — one Claude call, structured-JSON-only prompt, returns facts + a one-line summary. No decision authority.
4. **Policy engine** — pure Python `if` logic: missing fields → clarification; duplicate match → escalate; over threshold or over budget → escalate; otherwise → auto-approve. This is the actual decision-maker, satisfying "don't let the AI blindly authorize."
5. **Notion write** — every request gets one row in Requests DB regardless of outcome (auto or pending).
6. **Approval (if risky)** — human sets a `Decision` select field in Notion. No custom UI needed — Notion's native property editing *is* the approval interface, satisfying "a person has to be able to do their whole part of the job inside Notion."
7. **Resume** — a polling endpoint (`/notion/check-approvals`), hit by a cron job, detects the decision and continues.
8. **External action** — PDF generated with `reportlab`, emailed with `smtplib`.
9. **Run Log** — one row per meaningful transition, written via the Notion API with the integration token (not typed by hand — this is checkable, per the PDF's explicit warning).

**Frontend:** none beyond a one-page HTML/plain form for the demo trigger, or just `curl`/a seed script. **[inference — the PDF penalizes "a React app that treats Notion as a database and gives the human nothing," so building a rich frontend is actively counterproductive.]**

**Auth/security:** see PART 13.

**Hosting:** see PART 3.

---

## PART 3 — Tech Stack (decided, not optional)

```text
Backend:          Python 3.11 + FastAPI
AI:                Anthropic Claude (claude-sonnet-4-6), structured JSON output, one call per request
Database:          SQLite (idempotency + local request cache only — Notion is system of record)
Notion:            Official Notion REST API via httpx, integration token, 3 databases
Frontend:          None — a static HTML form (~30 lines) is enough for the live trigger
Hosting:           Render.com free web service (always specify a health-check route so it doesn't cold-sleep mid-demo) or Railway free tier
External Action:   Generated PDF (reportlab) + email (smtplib via Gmail app password or SendGrid free tier)
Testing:           pytest + httpx test client
Dev tools:         GitHub (commits spread across days — the PDF explicitly checks this), python-dotenv for config, Postman/curl for manual trigger testing
```

**Why this stack:**
- **FastAPI over Node/Express:** async-native, typed request models via Pydantic catch malformed input at the door (PART 12), and your team already has the scaffold (see `app/` in this repo).
- **One LLM call, structured output, nothing agentic:** the PDF wants AI to do *extraction*, not run a multi-step agent loop. A single prompt-in/JSON-out call is faster, cheaper, and more testable than a tool-using agent — and it's the correct scope per "if an if-statement could do it, an if-statement should do it" (the extraction is the one part that can't be an if-statement; the decision can, so it isn't AI).
- **SQLite, not Postgres:** you need durable idempotency and a local cache to avoid re-querying Notion on every poll — you do not need a relational system of record, because **Notion is explicitly required to be that.** Adding Postgres would be an unnecessary technology per your own constraint.
- **Polling over Notion webhooks:** Notion does not offer reliable outbound webhooks on property changes for all plan tiers as of this build; a 10–15 second poll loop against `Pending Approval` rows is simple, debuggable, and good enough for a live demo. **[inference — verify current Notion webhook availability before committing; polling is the safe fallback either way.]**
- **PDF + email over WhatsApp:** WhatsApp Business API requires template approval with real lead time — a genuine risk to reliability on demo day. Email is instant, requires no third-party approval process, and is just as "real" a real-world action.
- **Render/Railway free tier over a laptop:** the PDF explicitly disqualifies "running a script by hand during your demo" — the service must already be deployed and running.

---

## PART 4 — Data Design

### Expense Request
| Field | Type | Notes |
|---|---|---|
| request_id | string | `REQ-XXXXXXXX`, generated by backend |
| requester_name, requester_contact | string | from trigger payload |
| raw_text | string | original message, stored verbatim |
| vendor, category, purpose | string (AI-extracted) | |
| amount | number (AI-extracted) | |
| urgency | "normal"/"urgent" | AI-extracted |
| missing_fields | list | AI-extracted |
| ai_summary | string | AI-extracted, human-readable |
| status | enum | Auto-Approved / Pending Approval / Needs Clarification / Approved / Rejected |
| risk_reasons | list of string | policy-engine output |
| duplicate_of | request_id or null | policy-engine output |
| decided_by, decided_at | string, datetime | set on human or auto decision |
| received_at | datetime | set by backend on intake |

### Budget
| Field | Type |
|---|---|
| category | select |
| cap | number |
| spent | number (rollup from approved Requests, or updated by backend post-action) |
| remaining | formula = cap − spent |
| period | text, e.g. "Fest 2026" **[inference]** |

### Run Log
| Field | Type |
|---|---|
| run_id | string, e.g. `{request_id}-{action}` |
| request_id | string, relation to Requests |
| trigger | text — what fired this (webhook payload id) |
| action | select — Received / Auto-Approved / Escalated / Approved / Rejected / Needs Clarification / Action-Sent / Error |
| actor | text — "system" or approver's name |
| detail | text — free-form reasoning/result |
| timestamp | date, set by backend at write time |
| error | text, populated only on failure paths |

### Approval — what a human needs to decide
Shown directly on the Requests row: `ai_summary`, `raw_text`, `amount`, `vendor`, `category`, `risk_reasons`, `duplicate_of` (as a relation, clickable), current `remaining` budget for that category. A `Decision` select property (`Approved`/`Rejected`, empty by default) is the only field the human edits.

---

## PART 5 — Notion Workspace Design

**Databases (3, under one parent page — API cannot create a fresh workspace, only pages/databases inside one you create manually first):**

**1. Requests**
Properties: `Name` (title = request_id), `Requester`, `Vendor`, `Amount` (number, currency-formatted), `Category` (select), `Purpose`, `Urgency` (select), `Status` (select, color-coded: yellow=Pending, green=Auto/Approved, red=Rejected, gray=Needs Clarification), `AI Summary`, `Risk Reasons`, `Duplicate Of` (relation → self), `Decision` (select, human-editable: blank/Approved/Rejected), `Decided By`, `Decided At`, `Received At`, `Raw Request` (long text, collapsed by default).

**2. Budgets**
`Category` (title), `Cap` (number), `Spent` (rollup, sum of related Requests' Amount where Status is Approved-family), `Remaining` (formula), `Period` (text).

**3. Run Log**
`Name` (title), `Request ID` (relation → Requests), `Action` (select), `Actor`, `Detail`, `Timestamp` (date), `Error` (text, optional).

**Relations:** Requests ↔ Run Log (one-to-many), Requests ↔ Budgets (via Category rollup or manual relation), Requests ↔ Requests (self-relation for `Duplicate Of`).

**Views:**
- Requests → `Pending Approval` (filter Status=Pending Approval, sort by Received At asc — oldest first)
- Requests → `Auto-Approved` (filter Status=Auto-Approved)
- Requests → `Flagged / Needs Clarification`
- Requests → `Rejected`
- Requests → `All Requests` (default table, sort by Received At desc)
- Budgets → `Budget Usage` (board or table view, with a progress-bar formula property showing % used)
- Run Log → `Timeline` (default, sorted by Timestamp desc — this is the audit trail a stranger scans first)

**Dashboard page (top-level):** a single Notion page with linked views embedded: Pending Approval at top (what needs a human *now*), Budget Usage below, Run Log timeline at the bottom. This is what you screen-share during the demo and what judges see when your service is off.

---

## PART 6 — Input / Trigger

**Chosen primary method: webhook (`POST /webhook/request`)**, fed by a simple HTML form for the live demo. This satisfies "webhook, a cron, or an inbound event" directly and is the least fragile option — no dependency on email parsing or WhatsApp API approval.

1. Request enters via `POST /webhook/request` with `{idempotency_key, requester_name, requester_contact, raw_text}`.
2. FastAPI validates shape via Pydantic (`IncomingRequest` model) — malformed payloads get a `422` immediately, never reach the AI/policy layer.
3. `request_id` generated as `REQ-{uuid4 hex[:8]}` at intake, never client-supplied (prevents ID collision/spoofing).
4. Duplicate webhook delivery prevented via `idempotency_key` (client-supplied, e.g. form-submission nonce) checked against SQLite before any processing — see `app/idempotency.py`.
5. Request is stored in-memory/SQLite immediately on receipt, before AI/Notion calls, so a crash mid-pipeline doesn't lose the record. **[inference: current scaffold stores after Notion write — tighten this in Phase 2, see PART 12.]**
6. Processing (extraction → policy → Notion write → possible action) happens synchronously inside the same request handler — for hackathon scale this is fine and simpler to demo/debug than a queue.

---

## PART 7 — AI Pipeline

**Step 1:** `raw_text` is sent as-is inside a fixed prompt template (see `app/extraction.py`) — no user-supplied text is ever used to construct instructions to the model beyond the quoted request itself (basic prompt-injection hygiene).

**Step 2:** model returns strict JSON:
```json
{"vendor": "Sharma Decorators", "amount": 5000, "category": "Decorations",
 "purpose": "Event decorations", "urgency": "high",
 "missing_fields": [], "ai_summary": "..."}
```

**Step 3 — validation:** parse with `json.loads` inside try/except; on failure, fall back to a "could not parse" `ExtractedFields` with all fields missing — this routes straight to `Needs Clarification`, never crashes, never guesses.

**Step 4 — missing information:** if the model itself reports `missing_fields`, or `amount`/`vendor` come back null, the policy engine forces `Needs Clarification` regardless of anything else (PART 8) — this check happens in code, not by trusting the model's self-report alone.

**Step 5 — ambiguous input:** ambiguity is treated as missing information, not guessed at. "I need money urgently" → vendor=null, amount=null → `missing_fields` populated → clarification. The model is explicitly told (in the prompt) to return `null` rather than invent values.

**Step 6 — duplicate detection:** *not* done by the LLM. Fuzzy string match (`difflib.SequenceMatcher`) on vendor name + amount-within-20% against the last N days of requests, in `policy.py`. Deterministic, explainable, testable.

**Step 7 — risk score:** not a single opaque number — a list of concrete `risk_reasons` strings (over-cap, near-cap-threshold, duplicate-suspect, urgent-with-no-history), each generated by an explicit rule. This is more defensible to judges than "AI risk score: 0.73."

**LLM vs. deterministic code — the line:**
- **LLM does:** free-text → structured fields, one-line human-readable summary.
- **Code does:** every threshold check, every approve/escalate/reject decision, all duplicate matching, all budget math. **The LLM never approves anything.** This is the single most important design decision in the whole project — repeat it explicitly to judges.

---

## PART 8 — Policy / Decision Engine

Implemented in `app/policy.py`. Config lives in `.env`, not hardcoded, so thresholds can change without touching logic:

```text
AUTO_APPROVE_CAP_FRACTION=0.15   # a request above 15% of remaining category budget escalates
DUPLICATE_WINDOW_DAYS=7
```

**Auto-process when ALL true:**
- vendor and amount present, amount > 0
- no fuzzy-duplicate match within the window
- amount ≤ remaining budget for category
- amount / remaining ≤ `AUTO_APPROVE_CAP_FRACTION`

**Escalate to human when ANY true:**
- amount exceeds remaining budget
- amount is a large fraction of remaining budget (per threshold above)
- duplicate suspected
- marked urgent with no prior request history from this requester **[soft signal — inference]**

**Clarification (never reaches policy proper) when:**
- vendor or amount missing/null
- amount ≤ 0

**Changing policy without rewriting the app:** every threshold is an env var; category caps and spend-to-date live in the Notion Budgets DB, not in code — a treasurer can change a cap in Notion directly and the next request checks against the new number automatically.

---

## PART 9 — Human Approval Flow

```text
Risk detected → Requests row created, Status=Pending Approval, Decision=<blank>
     ↓
Human opens Notion, reads AI Summary + Risk Reasons + Raw Request
     ↓
Human sets Decision = Approved (or Rejected)
     ↓
Cron hits POST /notion/check-approvals every ~15s
     ↓
Backend reads Decision property for every Pending row via Notion API
     ↓
On Approved: Status→Approved, decided_by/at set, execute action, log
On Rejected: Status→Rejected, decided_by/at set, no action, log
```

**Mechanism chosen: polling**, not Notion webhooks. **[inference — see PART 3 for why; if your team confirms webhook availability on your Notion plan during setup, switching `check-approvals` to a webhook receiver is a drop-in change since the resume logic is already isolated in one function.]**

**Preventing double approval / duplicate action:** the backend only ever transitions a request out of `Pending Approval` once — after `_execute_action` runs, `Status` is immediately set to `Approved`, so the next poll cycle's query (filtered to `Status = Pending Approval`) will never see that row again. This makes the action idempotent at the state-machine level, not just at the webhook-delivery level.

**Stale approvals / approval after rejection:** once `Status` leaves `Pending Approval`, later edits to `Decision` in Notion are not re-read (the poll only queries rows still in `Pending Approval`). **[inference: add a Notion automation or manual convention — "don't edit Decision after Status changes" — noted as a known limitation, not silently unsafe, since the row stays fully visible in the audit trail either way.]**

**Race conditions:** single backend process, no concurrent workers reading the same in-memory store in this MVP, so no lock is needed. If you scale beyond one instance, add a `SELECT ... FOR UPDATE`-style guard — out of scope for a hackathon.

---

## PART 10 — Real External Action

**Chosen: generate a payment-authorization PDF, email it to the accounts contact (cc requester).**

Implementation (`app/actions.py`): `reportlab` renders a one-page PDF with request_id, requester, vendor, category, amount, purpose, status, decided_by/at. `smtplib` sends it via Gmail app-password SMTP or SendGrid free tier, to `ACCOUNTS_EMAIL` (env var), cc'd to the requester's contact.

Why this beats alternatives: no third-party approval process (unlike WhatsApp Business API templates), no claim of moving real money (defensible under judge scrutiny), fully demoable live (open the received email + attachment on screen), and directly matches the PDF's own example ("a message sent, a file made, an API called").

**Failure handling:** if SMTP credentials are absent, the action logs the would-be email instead of throwing — so the pipeline never crashes mid-demo on a misconfigured `.env`; this is caught in PART 12/16.

---

## PART 11 — Run Log

Written every time via `app/runlog.py` → `notion_client.append_run_log`, called at every transition:
`Received`, `Auto-Approved`, `Escalated`, `Needs Clarification`, `Approved`, `Rejected`, `Action-Sent`, and `Error` (added in Phase 5, PART 12).

Timestamps: `datetime.utcnow().isoformat()`, generated by the backend at the moment of the write — never backdated, never typed by hand.

**Example row:**
```text
Name:        REQ-4F2A9C1B — Escalated
Request ID:  REQ-4F2A9C1B
Action:      Escalated
Actor:       system
Detail:      Possible duplicate of REQ-1B7E20AA — similar vendor
             ('Sharma Decorators') and amount within 7 days;
             Request is 62% of remaining category budget.
Timestamp:   2026-08-21T14:32:07Z
Error:       (blank)
```

Full execution reconstruction: filter Run Log by `Request ID` relation → every row for that request, in timestamp order, tells the complete story from intake to final action, with no gaps.

---

## PART 12 — Reliability

| Failure case | Handling |
|---|---|
| Malformed input (bad JSON, missing required trigger fields) | Pydantic model rejects at `422`, never reaches AI/policy — nothing logged as a "request" since none was validly received |
| Missing amount / vendor | AI reports `missing_fields`; policy forces `Needs Clarification`, logged, no action |
| Ambiguous request | Same path — model told to return `null` not guess |
| Duplicate request (same content, new submission) | Fuzzy vendor+amount match → escalated with `duplicate_of` set, never silently auto-approved |
| Duplicate webhook delivery (network retry) | `idempotency_key` check short-circuits before any processing — returns the original `request_id` |
| AI/API failure (Anthropic API down/timeout) | try/except around the API call; on failure, fall back to an all-missing `ExtractedFields` → routes to `Needs Clarification`, logged with `Error` detail — **never** silently skipped |
| Notion API failure | wrap all `notion_client` calls; on failure, retry once with backoff, then log an `Error` row locally (SQLite) to be re-synced — **[Phase 5 addition, not yet in the initial scaffold]** |
| External action failure (SMTP down) | logs the would-be email and marks the Run Log row `Action-Sent (local fallback)`; does not silently claim success |
| Network timeout generally | `httpx` client timeouts set explicitly (e.g. 10s); on timeout, same Error-row pattern |
| Human rejection | logged, no action executes, full stop — this is a correct terminal state, not a failure |
| Retry | idempotency key + state-machine (request only leaves `Pending` once) makes retries safe by construction |
| Partial success (e.g. PDF generated but email fails) | `_execute_action` should catch and log each sub-step separately so you can see exactly which half succeeded — **[Phase 5: split into two try/except blocks, not one]** |

**Never does:** silently drop a request (every path ends in a Run Log write or a `422` before any request object exists), execute twice (idempotency + state-machine), or auto-approve on AI uncertainty (missing/uncertain fields always route to a human-facing state, never to auto-approve).

---

## PART 13 — Security

- **API keys / secrets:** all in `.env`, never committed (`.gitignore` includes `.env`); `.env.example` checked in with placeholders only.
- **Notion integration token:** scoped to only the 3 databases it needs (share only those pages with the integration in Notion's UI).
- **Webhook security [inference — add before demo]:** require a shared-secret header (`X-Sanction-Signature`) on `/webhook/request`, checked before any processing, so a random internet user can't inject fake requests during judging.
- **Input validation:** Pydantic models on every endpoint; string length caps on `raw_text` before it's sent to the LLM or stored (already 2000-char truncation on Notion writes in the scaffold).
- **Preventing unauthorized approvals:** in a real deployment, `/notion/check-approvals` would additionally check the Notion user who edited `Decision` against an allow-list of approver emails **[inference — cut for hackathon scope, note it explicitly as a known limitation in the demo, don't pretend it's solved]**.
- **Preventing duplicate execution:** covered in PART 9/12.
- **Logging sensitive data:** don't log full SMTP credentials or the raw Anthropic API key anywhere (only load via `os.getenv`); Run Log details are safe to be verbose since they contain no secrets, only request content.

---

## PART 14 — Project Structure

```text
sanction/
├── app/
│   ├── main.py          FastAPI app: webhook intake + approval-check endpoint
│   ├── models.py         Pydantic schemas (IncomingRequest, ExtractedFields, Decision, RequestRecord)
│   ├── extraction.py      AI call: raw text -> structured JSON facts
│   ├── policy.py          Deterministic decision engine
│   ├── notion_client.py   Notion API wrapper (create/update pages, poll, run log)
│   ├── actions.py         PDF generation + email sending
│   ├── idempotency.py     SQLite dedup store
│   ├── runlog.py          Single choke-point for Run Log writes
│   └── config.py          Env var loading
├── static/
│   └── demo_form.html     [Phase 6] one-page trigger form for the live demo
├── tests/
│   ├── test_policy.py
│   ├── test_extraction.py
│   └── test_end_to_end.py
├── docs/
│   ├── notion_setup.md    Manual steps to create the 3 databases + share with integration
│   └── demo_script.md     Word-for-word walkthrough (PART 18)
├── seed_demo.py           Sends the demo requests (clean case, risky case, garbage case)
├── requirements.txt
├── .env.example
├── .gitignore
├── README.md
└── BUILD_PLAN.md          this document
```

---

## PART 15 — Build Order

### Phase 0 — Setup (target: first 10% of time)
1. Create GitHub repo, push the scaffold (already done in this session — `app/*.py`, `requirements.txt`, `.env.example`, `README.md`).
2. Create Notion parent page + 3 databases exactly per PART 5; create an integration at notion.so/my-integrations, share all 3 DBs with it.
3. Get Anthropic API key; deploy a "hello world" FastAPI app to Render/Railway *immediately* so the running-service requirement is satisfied from day one.
- **Test:** `curl` the deployed health-check route returns `200`.
- **Do not start:** AI or policy logic yet.

### Phase 1 — Basic backend (10–25%)
1. Wire `/webhook/request` to accept `IncomingRequest`, generate `request_id`, store in-memory, return it.
2. Add idempotency check (SQLite) before storage.
3. Add basic input validation tests.
- **Test:** POST the same payload twice → second call returns `duplicate_ignored`.
- **Do not start:** Notion or AI integration yet.

### Phase 2 — Notion integration (25–40%)
1. Implement `notion_client.create_request_page`, `update_request_status`, `append_run_log`, `get_budget`, `get_request_decision` exactly against your real database IDs.
2. Every webhook call creates a real Notion row (skip AI/policy for now — hardcode `Status=Pending Approval` to test the write path).
3. Implement `/notion/check-approvals` polling and verify manually setting `Decision=Approved` in the Notion UI gets picked up.
- **Test:** create a request via curl, see it appear in Notion within a second; manually approve in Notion, see the poll endpoint report it as resumed.
- **Do not start:** real AI extraction or the PDF/email action yet — use dummy `ExtractedFields`.

### Phase 3 — AI pipeline (40–55%)
1. Implement `extraction.py` against the real Anthropic API with the fixed prompt.
2. Validate against 10 real example sentences your team writes (see PART 16).
3. Wire extraction into `/webhook/request`, replacing the dummy fields.
- **Test:** each of the 10 example sentences produces sane structured output; malformed model output falls back correctly (temporarily force a bad prompt to verify the except path).
- **Do not start:** policy engine yet — everything still auto-goes-to-Pending for now.

### Phase 4 — Policy engine (55–65%)
1. Implement `policy.py` fully: missing-field check, duplicate fuzzy-match, budget check, threshold check.
2. Wire into `/webhook/request` — now the full safe/risky branch is live.
- **Test:** the 4 canonical cases from PART 16 (normal, risky, duplicate, garbage) all route correctly.

### Phase 5 — External action + reliability (65–80%)
1. Implement `actions.py` (PDF + email), wire into `_execute_action` for both auto and human-approved paths.
2. Add the Error-row logging paths from PART 12 (Notion API failure, AI failure, SMTP failure) — this phase is what makes the system demo-safe, don't skip it.
3. Add the webhook shared-secret check (PART 13).
- **Test:** full run of a clean request end-to-end produces a real email with a real PDF attached, and a complete Run Log trail.

### Phase 6 — Notion polish + demo form (80–90%)
1. Build all views from PART 5 (Pending Approval, Auto-Approved, Flagged, Rejected, Budget Usage, Run Log Timeline), assemble the dashboard page.
2. Build the one-page HTML trigger form (`static/demo_form.html`) — purely so a judge can watch you type a request live, not required by the PDF but good demo theater.
3. Seed realistic Budget rows and a few days' worth of backdated-but-real Run Log history if time allows — **[the PDF explicitly wants commits/logs spread over days, not faked in one night — do this by actually running seed requests across multiple real days of the event, not by backdating timestamps]**.
- **Test:** turn the backend off, open only Notion, confirm a stranger can understand system state.

### Phase 7 — Final demo ready (90–100%)
1. Rehearse the exact PART 18 script twice, timed.
2. Freeze scope — no new features.
3. Write `docs/demo_script.md` and finalize `README.md`.
4. Final GitHub push, confirm deployed service is live and warmed up (hit it a few times so Render's free tier isn't cold-starting mid-demo).

---

## PART 16 — Testing Plan

**Normal case:** POST `{"raw_text": "Need Rs 2000 for printing posters from Copy King for the fest", ...}` → expect `Auto-Approved`, one email received with a PDF, 3 Run Log rows (Received, Auto-Approved, Action-Sent).

**Risky case:** POST an amount near/over the category's remaining budget → expect `Pending Approval` with `risk_reasons` populated; manually set `Decision=Approved` in Notion; call `/notion/check-approvals` → expect `Approved`, email sent, Run Log shows Escalated → Approved → Action-Sent.

**Rejection:** same as above but `Decision=Rejected` → expect `Rejected` status, no email, Run Log shows Escalated → Rejected, nothing further.

**Duplicate:** POST the same vendor+similar amount twice within the window → second request expects `Pending Approval` with `duplicate_of` set to the first request's ID, never auto-approved twice.

**Garbage input:** POST `{"raw_text": "I need money urgently", ...}` → expect `Needs Clarification`, no Notion approval flow triggered, one Run Log row.

**Additional tests:**
- Duplicate webhook delivery (same `idempotency_key` twice) → second call short-circuits, no second Notion row created.
- Anthropic API forced-failure (bad API key temporarily) → falls back to `Needs Clarification`, doesn't crash the server.
- SMTP unset → action logs locally instead of throwing, Run Log still gets an `Action-Sent` row (marked local-fallback).
- Malformed JSON body → `422` before any processing.

---

## PART 17 — Hackathon Requirement Checklist

| Official Requirement | How Sanction satisfies it | Proof in demo |
|---|---|---|
| Runs without manual script | Deployed on Render/Railway, triggered via webhook | Show the live URL, hit it from the demo form, no terminal script run |
| Human approval in Notion | `Decision` select property on Requests, edited natively in Notion | Live-approve the risky request on screen |
| Real external action | Authorization PDF generated + emailed | Open the received email + PDF live |
| Integration-written Run Log | All rows written via `notion_client.append_run_log` using the integration token | Show Run Log timeline, note rows were never typed |
| AI used meaningfully | Free-text → structured extraction + summary; not used for the decision itself | Show the AI Summary field next to the raw request text |
| Bad-input handling | `Needs Clarification` path, tested explicitly | Submit the garbage-input demo case live |
| Not a chatbot | No chat interface anywhere; intake is a structured webhook | N/A — architecturally true |
| Not a dashboard-only project | Backend makes real decisions and takes real action; Notion is downstream of logic, not the logic itself | Show the repo, show `policy.py` |
| Not a no-code/Zapier chain | Delete-the-repo test: with the backend down, Notion holds only historical data, nothing new happens | Explicitly state this to judges |
| One job fully automated | Scope is expense request → decision → action → log, nothing else | State PART 1 scope explicitly |
| Notion useful as operations hub | Dashboard page usable cold, per PART 5 | Turn the backend off and walk through Notion alone |

---

## PART 18 — Demo Plan (3–5 minutes)

**Scenario 1 — Safe request (45s):** "Here's a real request coming in through our live form — not a script, this hits our deployed backend." Type/submit the clean-case sentence. "Our AI just parsed vendor, amount, category. Our policy engine checked it against the actual budget in Notion — here's the row, Auto-Approved, and here's the email with the authorization PDF that just went out. And here's the Run Log entry, timestamped by our backend."

**Scenario 2 — Risky request, the centerpiece (90s):** Submit the risky-case sentence (near-cap amount, or a vendor/amount close to the earlier one). "This one's flagged — Pending Approval, and here's why, in plain language: [read the risk_reasons]. Our AI never approves money — it only explains. Now I'll actually approve this the way our treasurer would, right inside Notion." Click `Decision=Approved` live. "Our backend is polling for exactly this — watch." Show the resumed status, the new email, the completed Run Log trail.

**Scenario 3 — Failure/bad input (45s):** Submit the garbage-input sentence. "No amount, no vendor — this doesn't get guessed at, it goes to Needs Clarification and stops here, safely." Also mention (don't necessarily demo live) the duplicate-detection case verbally, pointing at the `duplicate_of` field on an earlier seeded row if you have one.

**Close (30s):** Turn the backend off (kill the Render service or just say "imagine this is off"). Walk through the Notion dashboard cold: Pending Approval, Budget Usage, Run Log. "A treasurer who's never seen our code can run this job entirely from here."

---

## PART 19 — Team of 3

**Person 1 — Backend + policy logic:** owns `main.py`, `models.py`, `policy.py`, `idempotency.py`, deployment. Must finish the intake+storage skeleton (Phase 1) before Person 2/3 can integrate against real endpoints. Delivers the policy engine (Phase 4) which blocks final end-to-end testing.

**Person 2 — AI + extraction:** owns `extraction.py`, prompt design/iteration, the 10-example validation set (PART 16). Depends on Person 1's `models.py` schema being stable; blocks Phase 4 (policy needs real `ExtractedFields`).

**Person 3 — Notion + action layer + demo:** owns `notion_client.py`, the 3 Notion databases (PART 5), `actions.py`, the demo form, `docs/demo_script.md`, and rehearsing the live walkthrough. Depends on Person 1's `RequestRecord` schema; their Notion schema work (Phase 0-2) should start in parallel with Person 1's backend work, not after.

**Do together:** Phase 0 schema decisions (everyone needs to agree on `models.py` before writing against it), Phase 5 reliability review (all three failure-injection tests), final demo rehearsal (Phase 7).

---

## PART 20 — Timeline (percentage-based)

- **First 20%:** Phase 0–1. Deployed hello-world service live; basic intake + idempotency working.
- **Next 30%:** Phase 2–3. Notion fully wired (writes + polling); AI extraction validated on real examples.
- **Next 30%:** Phase 4–5. Policy engine live; external action + reliability/error-path hardening — **this is the phase most teams under-invest in and it's what the PDF explicitly judges hardest.**
- **Final 20%:** Phase 6–7. Notion visual polish, dashboard page, demo form, full rehearsal, freeze scope.

Nice-to-haves (multi-day-history seeding for visual realism, budget board view styling) only happen inside the final 20%, and only after Phase 7's core checklist is green.

---

## PART 21 — What NOT to Build

Full accounting/ledger system · payment gateway / real UPI or bank transfer · complete club-management platform · attendance · a general chatbot · analytics/BI dashboards beyond Notion's native views · a mobile app · multiple simultaneous input channels (pick webhook, not webhook+email+WhatsApp) · multi-organization/multi-tenant support · multiple AI agents or an agentic tool-loop (one structured-output call is enough) · a custom frontend beyond the one-page trigger form · WhatsApp integration for the MVP (cut per PART 3's risk analysis) · receipts/OCR · budget planning/forecasting features.

---

## PART 22 — Final "Done" Definition

```text
[ ] User can submit a real request via the deployed webhook (not a local script)
[ ] Backend receives it automatically and generates a request_id
[ ] AI extracts structured fields + a human-readable summary
[ ] Policy engine evaluates deterministically (missing/duplicate/budget/threshold)
[ ] Safe case executes automatically end-to-end (PDF + email + Run Log)
[ ] Risky case creates a Pending Approval row in Notion with clear risk reasons
[ ] Human can approve/reject natively inside Notion (no custom UI needed)
[ ] Backend polls and resumes automatically within ~15s of a decision
[ ] Real external action occurs (authorization PDF generated + emailed)
[ ] Every meaningful transition is logged by the backend via the Notion API
[ ] Duplicate webhook deliveries and duplicate requests are both handled safely
[ ] Garbage/incomplete input routes to Needs Clarification, never guessed or crashed
[ ] AI failure, Notion API failure, and SMTP failure all degrade safely, never silently
[ ] Deployment is live and warmed up ahead of judging
[ ] Notion dashboard is understandable with the backend turned off
[ ] Full 3-scenario demo (safe / risky / bad-input) rehearsed and timed under 5 minutes
[ ] GitHub history shows work spread across the event, not one night
[ ] Team can state, in one sentence each, why AI doesn't decide and why Notion isn't just a database
```

---

## Where your current concept needs to change before implementation

1. **Drop WhatsApp from the external action.** Your Image 1/6 notes still list "WhatsApp message sent to requester" — cut it. One reliable channel (email) only.
2. **Tighten the storage-before-Notion-write ordering** in Phase 1/5 — the current code scaffold stores the record in `_STORE` *after* the Notion write; a Notion failure between those two lines currently loses the idempotency-marked record from local state. Fix in Phase 5 alongside the other Notion-failure handling.
3. **Add the webhook shared-secret check** (PART 13) before demo day — not present in the original scaffold, and without it anyone can inject fake requests into your live deployment during judging.
4. **Don't backdate Run Log rows to fake multi-day history** — the PDF explicitly checks for this ("we check"). Seed real requests across real days instead.
