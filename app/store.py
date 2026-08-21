"""
Durable state: request records + idempotency keys.

Backed by Postgres (DATABASE_URL) — required in production because Render's
free web services have an ephemeral filesystem (wiped on redeploy/restart/
spin-down). If DATABASE_URL is not set, falls back to an in-memory dict so
`pytest`/local dev without a database still works — this fallback is NOT
durable and must never be relied on for a deployed instance.
"""
import json
from datetime import datetime, timezone
from typing import Optional
import asyncpg
from app.config import settings
from app.models import RequestRecord

_pool: Optional[asyncpg.Pool] = None

# Fallback only used when DATABASE_URL is unset (local/dev/test).
_MEM_STORE: dict[str, RequestRecord] = {}
_MEM_IDEMPOTENCY: dict[str, str] = {}
_MEM_ACTION_CLAIMS: set[str] = set()  # tracks which records have had action taken


async def init():
    global _pool
    if not settings.DATABASE_URL:
        print("[store] WARNING: DATABASE_URL not set — using in-memory store "
              "(NOT durable, dev/test only).")
        return
    _pool = await asyncpg.create_pool(settings.DATABASE_URL, min_size=1, max_size=5)
    async with _pool.acquire() as conn:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS requests (
                request_id TEXT PRIMARY KEY,
                data JSONB NOT NULL,
                received_at TIMESTAMPTZ NOT NULL
            )
            """
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS idempotency (
                idempotency_key TEXT PRIMARY KEY,
                request_id TEXT NOT NULL
            )
            """
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS action_claims (
                request_id TEXT PRIMARY KEY,
                claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )


async def close():
    if _pool:
        await _pool.close()


async def save_record(record: RequestRecord):
    if not _pool:
        _MEM_STORE[record.request_id] = record
        return
    async with _pool.acquire() as conn:
        received = record.incoming.received_at
        if received.tzinfo is None:
            received = received.replace(tzinfo=timezone.utc)
        await conn.execute(
            """
            INSERT INTO requests (request_id, data, received_at)
            VALUES ($1, $2::jsonb, $3)
            ON CONFLICT (request_id) DO UPDATE SET data = EXCLUDED.data
            """,
            record.request_id,
            record.model_dump_json(),
            received,
        )


async def get_record(request_id: str) -> Optional[RequestRecord]:
    if not _pool:
        return _MEM_STORE.get(request_id)
    async with _pool.acquire() as conn:
        row = await conn.fetchrow("SELECT data FROM requests WHERE request_id = $1", request_id)
        if not row:
            return None
        data = row["data"]
        if isinstance(data, str):
            data = json.loads(data)
        return RequestRecord.model_validate(data)


async def recent_records() -> list[RequestRecord]:
    if not _pool:
        records = list(_MEM_STORE.values())
        records.sort(key=lambda r: r.incoming.received_at, reverse=True)
        return records[:500]
    async with _pool.acquire() as conn:
        rows = await conn.fetch("SELECT data FROM requests ORDER BY received_at DESC LIMIT 500")
        out = []
        for r in rows:
            data = r["data"]
            if isinstance(data, str):
                data = json.loads(data)
            out.append(RequestRecord.model_validate(data))
        return out


async def pending_records() -> list[RequestRecord]:
    records = await recent_records()
    from app.models import RequestStatus
    return [r for r in records if r.decision.status == RequestStatus.PENDING_APPROVAL]


async def already_processed(idempotency_key: str) -> Optional[str]:
    if not _pool:
        return _MEM_IDEMPOTENCY.get(idempotency_key)
    async with _pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT request_id FROM idempotency WHERE idempotency_key = $1", idempotency_key
        )
        return row["request_id"] if row else None


async def mark_processed(idempotency_key: str, request_id: str):
    if not _pool:
        # Match the Postgres path: first write wins, later marks are no-ops.
        if idempotency_key not in _MEM_IDEMPOTENCY:
            _MEM_IDEMPOTENCY[idempotency_key] = request_id
        return
    async with _pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO idempotency (idempotency_key, request_id) VALUES ($1, $2) "
            "ON CONFLICT DO NOTHING",
            idempotency_key,
            request_id,
        )


async def claim_action(request_id: str) -> bool:
    """Atomically claim a record for action (PDF + email).  Returns True on
    first claim, False if another concurrent poll already claimed it.
    This prevents _execute_action from firing twice for the same approval
    under overlapping /notion/check-approvals polls."""
    if not _pool:
        if request_id in _MEM_ACTION_CLAIMS:
            return False
        _MEM_ACTION_CLAIMS.add(request_id)
        return True
    async with _pool.acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO action_claims (request_id) VALUES ($1) "
            "ON CONFLICT DO NOTHING RETURNING request_id",
            request_id,
        )
        return row is not None
