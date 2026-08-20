# Demo script — 3 scenarios, under 5 minutes

Prepared for a live shared screen. The backend must already be deployed and
warm (hit `/health` a few times before the judges sit down).

## Pre-flight (before the demo)

1. `GET https://<your-app>.onrender.com/health` twice — proves it's live and
   not cold-sleeping.
2. Open the demo form (`https://<your-app>/`), the Notion Dashboard page, and
   an email inbox in tabs.
3. Confirm the Run Log's last rows carry **real** backend timestamps, not one
   faked night (BUILD_PLAN PART 22).

## Scenario 1 — Safe request (~45s)

> "Here's a real request coming in through our live form — not a script, this
> hits our deployed backend."

Type (or paste) into the form:

```
Need Rs 2000 for printing posters from Copy King for the fest
```

Submit. Say, while it loads:

> "The backend assigns a request_id and checks its idempotency key. The AI
> parses vendor, amount, category from the messy sentence — no structured form,
> no spreadsheet. Our policy engine then checks this against the actual budget
> in Notion — in code, not in the prompt. The amount's tiny relative to the
> category cap, no recent similar vendor, nothing missing — so it auto-clears."

Show the Notion row: `Auto-Approved`, the AI Summary, and the Run Log rows
(`Received` → `Auto-Approved` → `Action-Sent`). Open the inbox: the
authorization email with the PDF attachment.

> "And here's the real external action — the payment-authorization document,
> generated and emailed automatically."

## Scenario 2 — Risky request, centerpiece (~90s)

Submit in the form or via seed:

> Need Rs 18000 to print the fest programme from Printing Corner, event is in 2 days

> "This one is flagged — Pending Approval. Here's the outlier in plain English,
> from the policy engine, not the model: [read aloud the Risk Reasons — e.g.
> 'Request is 89% of remaining category budget']. Our AI never approves money.
> It explains. The decision is either this policy engine or — above the
> threshold — a human. And the human does their part in Notion, natively:
> no admin build from us."

Set `Decision = Approved` on the row, in the Notion UI, live.

> "Our backend is polling Notion for exactly this — watch. It picked it up, set
> Status to Approved, wrote the decided-by, generated and emailed the PDF, and
> finished the Run Log trail: Escalated → Approved → Action-Sent."

Show the Run Log timeline and the second email.

## Shortcut — Rejection (if time, verbal)

> "And the same flow handles rejection with zero guesswork: if our treasurer had
> set Decision = Rejected, the Run Log shows Escalated → Rejected and no email
> ever goes out. The backend never actions a rejected request — it's a terminal,
> fully logged state."

## Scenario 3 — Garbage / missing input (~45s)

Submit:

> I need money urgently

Watch it land as `Needs Clarification`.

> "No amount, no vendor — the AI returns null rather than invent answers, and
> the policy engine sends it to a human-facing state with zero execution. Nothing
> got guessed, nothing crashed, and the Run LoG shows it stopped safely right
> here."

Point briefly at an earlier seeded duplicate if one exists:

> "(The same guard catches repeats: two requests with the same vendor and
> near-same amount within the window never both auto-approve — the second lands
> with its `duplicate_of` field pointing at the overlap, flagged for the human.
> See that `duplicate_of` link on this seeded row.)"

## Close (~30s)

Kill the backend (pause the pin / note "process stopped"), walk Notion alone:

> "Now imagine our service is off mid-judging — which is exactly what we'll
> leave behind. A stranger opens this dashboard: what's pending right now, how
> budgets stand, and a Run Log that a complete stranger can read top to bottom
> and reconstruct exactly what happened and who decided — because every row was
> written by our integration token on real timestamps, never typed by hand."

Shut down and take the audience to the "two-one-sentence" closer:

> "Why doesn't the AI decide? Because approval on money is a deterministic policy
> / plus a human's call — and if an if-statement can do it, an if-statement should
> do it. Why isn't Notion just a database? Because the actual working parts — the
> parsing, the checks, the execution, the logging — live in this code, and Notion
> is where the treasurer's human approval and the audit trail live."

## Timing tips

- Practice twice against a stopwatch (aim < 4:30 to absorb a demo-turned-bad).
- Preload the browser tabs so the demo has no dead air.
- The risky case's approval must be clicked by hand — that IS the demo.
- `print Demo complete; python` ❌ — nothing in the demo runs by hand.

## Post-demo readiness

- [ ] health-check live, hit twice in the minute before judging.
- [ ] Notion Run Log shows real timestamps from earlier in the event (not one night).
- [ ] Dashboard organizes: Pending Approval, Budget Usage, Run Log views embedded.
- [ ] Demo form reachable at the live root URL.