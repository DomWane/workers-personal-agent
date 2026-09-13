import json
import time
import urllib.error
import urllib.request
from typing import Any, cast

Json = dict[str, Any]


class HttpError(Exception):
    def __init__(self, status: int, body: str) -> None:
        super().__init__(f'HTTP {status}: {body[:400]}')
        self.status = status
        self.body = body


def post_json(url: str, body: object, token: str, timeout: float = 180) -> Json:
    request = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
        headers={'authorization': f'Bearer {token}', 'content-type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as err:
        raise HttpError(err.code, err.read().decode('utf-8', errors='replace')) from err


def dig(value: object, *path: str | int) -> Any:
    current: Any = value
    for key in path:
        if isinstance(key, int):
            items = cast(list[Any], current) if isinstance(current, list) else []
            current = items[key] if len(items) > key else None
        else:
            mapping = cast(Json, current) if isinstance(current, dict) else {}
            current = mapping.get(key)
        if current is None:
            return None
    return current


RETRY_WAITS = (2, 8, 30)


def post_json_with_retry(url: str, body: object, token: str, label: str, timeout: float = 180) -> Json:
    for wait in (*RETRY_WAITS, None):
        try:
            return post_json(url, body, token, timeout)
        except HttpError as err:
            if wait is None or (err.status != 429 and err.status < 500):
                raise
            print(f'  {label}: HTTP {err.status}, zkouším znovu za {wait}s')
        except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
            if wait is None:
                raise
            print(f'  {label}: {err}, zkouším znovu za {wait}s')
        time.sleep(wait)
    raise AssertionError('unreachable')
