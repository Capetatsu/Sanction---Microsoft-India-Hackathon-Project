"""
Single choke point for writing Run Log rows, so no code path can skip
logging an action. Every meaningful state transition calls this.

A Run Log write failure is logged to stdout and swallowed rather than
raised — losing one log row must never crash the handler that's mid-way
through actually processing/approving a request.
"""
from app import notion_client


async def log(request_id: str, action: str, actor: str = "system", detail: str = ""):
    try:
        await notion_client.append_run_log(request_id, action, actor, detail)
    except notion_client.NotionAPIError as e:
        print(f"[runlog] FAILED to write Run Log row ({request_id} / {action}): {e}")
