from lib.http import dig


def test_dig_walks_nested_dicts_and_lists() -> None:
    data = {'choices': [{'message': {'content': 'ahoj'}}]}
    assert dig(data, 'choices', 0, 'message', 'content') == 'ahoj'


def test_dig_returns_none_for_any_missing_step_instead_of_raising() -> None:
    assert dig({'result': None}, 'result', 'data') is None
    assert dig({'choices': []}, 'choices', 0) is None
    assert dig('not a dict', 'key') is None
