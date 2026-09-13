import json
from typing import Any

from lib.ingest_filter import is_from_service, strip_client_metadata


def event(**over: object) -> dict[str, Any]:
    return {
        'dataset': 'cloudflare-workers',
        'timestamp': 1_786_135_480_817,
        '$metadata': {'id': 'abc', 'service': 'personal-agent', 'requestId': 'R1'},
        '$workers': {
            'scriptName': 'personal-agent',
            'eventType': 'fetch',
            'outcome': 'ok',
            'cpuTimeMs': 4,
            'event': {
                'request': {
                    'url': 'https://personal-agent.example.workers.dev/api/threads',
                    'method': 'POST',
                    'headers': {
                        'cf-connecting-ip': '2001:db8::1',
                        'x-real-ip': '2001:db8::1',
                        'content-type': 'application/json',
                    },
                    'cf': {
                        'city': 'Springfield',
                        'postalCode': '00000',
                        'latitude': '0.00',
                        'longitude': '0.00',
                        'country': 'XX',
                    },
                },
                'response': {'status': 200},
            },
        },
        'source': {'v': 1, 'turnId': 'a3f1c092', 'at': 'turn'},
        **over,
    }


def test_keeps_this_agent_and_drops_other_workers_on_the_same_account() -> None:
    assert is_from_service(event(), 'personal-agent')
    other = {'id': 'x', 'service': 'other-worker'}
    assert not is_from_service(event(**{'$metadata': other}), 'personal-agent')


def test_falls_back_to_the_workers_block_when_metadata_carries_no_service() -> None:
    assert is_from_service(event(**{'$metadata': {'id': 'x'}}), 'personal-agent')


def test_drops_an_event_that_names_no_service_at_all_rather_than_guessing_it_is_ours() -> None:
    assert not is_from_service({'$metadata': {'id': 'x'}, '$workers': {}}, 'personal-agent')


def test_removes_the_caller_ip_and_location_which_no_metric_uses() -> None:
    dumped = json.dumps(strip_client_metadata(event()))
    assert '2001:db8' not in dumped
    assert 'Springfield' not in dumped
    assert '00000' not in dumped
    assert '0.00' not in dumped


def test_keeps_what_a_turn_is_reconstructed_from() -> None:
    dumped = json.dumps(strip_client_metadata(event()), separators=(',', ':'))
    assert 'a3f1c092' in dumped
    assert 'personal-agent' in dumped
    assert '/api/threads' in dumped
    assert '"status":200' in dumped


def test_does_not_mutate_the_event_it_was_given() -> None:
    original = event()
    strip_client_metadata(original)
    assert original['$workers']['event']['request']['cf']['city'] == 'Springfield'


def test_survives_an_event_with_no_request_block() -> None:
    alarm = {'$metadata': {'id': 'x'}, '$workers': {'eventType': 'alarm'}, 'source': {'v': 1}}
    assert strip_client_metadata(alarm)['source'] == {'v': 1}
