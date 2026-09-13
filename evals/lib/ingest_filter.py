from typing import Any, cast

Json = dict[str, Any]


def as_object(value: object) -> Json | None:
    return cast(Json, value) if isinstance(value, dict) else None


def is_from_service(event: object, service: str) -> bool:
    e = as_object(event)
    if e is None:
        return False
    metadata = as_object(e.get('$metadata')) or {}
    workers = as_object(e.get('$workers')) or {}
    named = metadata.get('service', workers.get('scriptName'))
    return named == service


def strip_client_metadata[T](event: T) -> T:
    e = as_object(event)
    if e is None:
        return event
    workers = as_object(e.get('$workers'))
    inner = as_object(workers.get('event')) if workers else None
    request = as_object(inner.get('request')) if inner else None
    if workers is None or inner is None or request is None:
        return event

    rest_of_request = {k: v for k, v in request.items() if k not in ('headers', 'cf')}
    headers = as_object(request.get('headers')) or {}
    if headers.get('content-type'):
        rest_of_request['headers'] = {'content-type': headers['content-type']}
    stripped: Json = {**e, '$workers': {**workers, 'event': {**inner, 'request': rest_of_request}}}
    return stripped  # type: ignore[return-value]
