import json
import os
import time
from typing import Any

from lib.env import require_env
from lib.http import HttpError, dig, post_json
from lib.ingest_filter import is_from_service, strip_client_metadata
from lib.jsonl import append_json_line, read_json_lines
from lib.paths import DATA

OUT = DATA / 'traces.jsonl'
SERVICE = 'personal-agent'
PAGE = 2000
MAX_PAGES = 50
WINDOW_DAYS = int(os.environ.get('TRACE_WINDOW_DAYS', '3'))


def event_id(event: object) -> str | None:
    id = dig(event, '$metadata', 'id')
    return id if isinstance(id, str) else None


def page(account: str, token: str, from_ms: int, to_ms: int, offset: str | None) -> list[Any]:
    body: dict[str, Any] = {
        'queryId': 'trace-export',
        'view': 'events',
        'limit': PAGE,
        'dry': False,
        'parameters': {'datasets': []},
        'timeframe': {'from': from_ms, 'to': to_ms},
    }
    if offset:
        body['offset'] = offset
        body['offsetDirection'] = 'next'
    try:
        data = post_json(
            f'https://api.cloudflare.com/client/v4/accounts/{account}/workers/observability/telemetry/query',
            body,
            token,
        )
    except HttpError as err:
        raise SystemExit(f'observability query failed: {err.status} {err.body[:500]}') from err
    events: list[Any] | None = dig(data, 'result', 'events', 'events')
    if events is None:
        raise SystemExit(f'unexpected response shape: {json.dumps(data)[:500]}')
    return events


def main() -> None:
    account, token = require_env('CF_ACCOUNT_ID', 'CF_API_TOKEN')
    seen = {id for id in (event_id(e) for e in read_json_lines(OUT)) if id}
    before = len(seen)
    to_ms = int(time.time() * 1000)
    from_ms = to_ms - WINDOW_DAYS * 24 * 60 * 60 * 1000

    added = 0
    offset: str | None = None
    for p in range(MAX_PAGES):
        events = page(account, token, from_ms, to_ms, offset)
        if not events:
            break
        fresh = 0
        foreign = 0
        for e in events:
            id = event_id(e)
            if not id or id in seen:
                continue
            seen.add(id)
            if not is_from_service(e, SERVICE):
                foreign += 1
                continue
            append_json_line(OUT, strip_client_metadata(e))
            added += 1
            fresh += 1
        if foreign:
            print(f'  page {p}: skipped {foreign} records from other workers')
        last = event_id(events[-1])
        if len(events) < PAGE or not last or last == offset:
            break
        offset = last

    total = len(read_json_lines(OUT))
    print(f'{added} new records, {total} in {OUT} (was {before})')
    if added == 0 and before == 0:
        raise SystemExit('nothing exported — check the token has Account Analytics: Read on this account')


if __name__ == '__main__':
    main()
