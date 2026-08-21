# Notion workspace setup (manual — the API cannot create a top-level workspace)

~15 minutes. Do this once; everything after is automatic.

## 1. Parent page

Create a Notion page called **Sanction** (any location in your workspace).
Every database below lives inside it.

## 2. Integration + token

1. Go to <https://www.notion.so/my-integrations> → **New integration** → name
   it `Sanction` → create.
2. Copy the "Internal Integration Token" — this is `NOTION_TOKEN` in `.env`.
3. Share the database for `Sanction` test-only during setup; later restrict
   sharing to only the three pages below (PART 13 of BUILD_PLAN).

## 3. Share the databases with the integration

Open each of the three databases → `...` → **Connections** → add the `Sanction`
integration. All three must show it or the API 404s on them.

## 4. Databases (create each inside the Sanction page)

### 4.1 Requests — one row per expense request

| Property          | Type                     |
|-------------------|--------------------------|
| Name              | Title                    |
| Requester         | Text                      |
| Vendor            | Text                      |
| Amount            | Number (format: currency, ₹) |
| Category          | Select — Decorations · Stationery · Food & Refreshments · Printing · Transport · Equipment Rental · Other |
| Purpose           | Text                      |
| Urgency           | Select — normal · urgent  |
| Status            | Select — Color-coded     |
| AI Summary        | Text (block)              |
| Risk Reasons      | Text (block)              |
| Duplicate Of      | Relation → Requests (self) |
| Decision          | Select (empty by default) with options "Approved" / "Rejected", empty default |
| Decided By        | Text                      |
| Decided At        | Date                      |
| Received At       | Date                      |
| Raw Request       | Text (block, collapsed)   |

Backend writes every field except `Decision` (the one field a human edits).

### 4.2 Budgets — one row per category cap

| Property | Type |
|----------|------|
| Category | title (must match the Requests Category select names exactly) |
| Cap      | Number |
| Spent    | Number (auto-updated by the backend after each approved request) |
| Remaining | Formula = `Cap - prop("Spent")` |
| Period   | Text |

Seed one row per category you will demo (e.g. `Printing: Cap 50000, Spent 5000`,
`Decorations: Cap 20000, Spent 15000`).  The backend automatically increments
`Spent` when a request reaches a terminal success state (Auto-Approved or
human-Approved).  Rejected and Needs-Clarification requests do not consume
budget.

### 4.3 Run Log — append-only audit trail

| Property | Type |
|----------|------|
| Name        | title (e.g. `REQ-XXXXXXXX — Escalated`) |
| Request ID  | Relation → Requests |
| Action      | Select — Received · Auto-Approved · Escalated · Needs Clarification · Approved · Rejected · Action-Sent · Error |
| Actor       | Text |
| Detail      | Text (block) |
| Timestamp    | Date |
| Error        | Text (empty normally) |

## 5. Views + dashboard page

On the **Requests** database create views:

- `Pending Approval` — filter Status = *Pending Approval*, sort Received At asc
- `Auto-Approved` — filter Status = *Auto-Approved*
- `Flagged / Needs Clarification` — filter Status = *Needs Clarification*
- `Rejected` — filter Status = *Rejected*
- `All Requests` — default table, sort Received At desc

On **Budgets**: `Budget Usage` (board or table + a formula property showing
percentage used).

On **Run Log**: `Timeline` default, sort by Timestamp desc.

Then create a top-level **Dashboard** page inside `Sanction` and embed live
linked views: Pending Approval on top (what needs a human *now*), Budget Usage
below it, Run Log timeline at the bottom. This is the screen you share in the
demo — it is fully usable with the backend turned off.

## 6. Copy database IDs into `.env`

For each database, open it and copy the id from the URL:
`notion.so/<parent>/<DATABASE_ID>?v=...` → set `NOTION_REQUESTS_DB_ID`,
`NOTION_BUDGETS_DB_ID`, `NOTION_RUNLOG_DB_ID`.

## 7. Smoke-test the write path

```bash
python seed_demo.py --case garbage --base http://localhost:8000 --secret <secret>
```

A `Needs Clarification` row should appear in **All Requests** within a second,
and one `Received` row in the Run Log.