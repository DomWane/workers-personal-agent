import json

from lib.records import AgentRecord, group_turns
from lib.turn_table import PUBLIC_COLUMNS, project_turn, to_csv


def record(**over: object) -> AgentRecord:
    return {
        'v': 1,
        'ts': 1_754_400_000_000,
        'level': 'info',
        'source': 'telegram',
        'turnId': 'a3f1c092',
        'seq': 0,
        'at': 'tool-loop',
        **over,
    }


def healthy_turn(**over: object) -> list[AgentRecord]:
    return [
        record(
            seq=0,
            stage='round',
            round=0,
            model='deepseek/deepseek-v4-flash',
            provider='Baidu',
            durationMs=795,
            usage={'inputTokens': 1840, 'outputTokens': 96, 'reasoningTokens': 12},
            toolCalls=['search_memory'],
            empty=False,
            **over,
        ),
        record(seq=1, stage='tool-result', round=0, tool='search_memory', resultLen=412, isError=False),
        record(
            seq=2,
            stage='round',
            round=1,
            model='deepseek/deepseek-v4-flash',
            provider='Baidu',
            durationMs=410,
            usage={'inputTokens': 2100, 'outputTokens': 40},
            toolCalls=[],
            empty=False,
        ),
        record(
            seq=3,
            stage='done',
            roundsUsed=2,
            stopReason='complete',
            elapsedMs=1300,
            toolsUsed=['search_memory'],
        ),
        record(
            seq=4,
            at='turn',
            outcome='ok',
            stopReason='complete',
            roundsUsed=2,
            toolsUsed=['search_memory'],
            elapsedMs=1300,
            subrequests=16,
        ),
    ]


def test_emits_exactly_the_allowlisted_columns_and_nothing_else() -> None:
    [turn] = group_turns(healthy_turn())
    assert sorted(project_turn(turn)) == sorted(PUBLIC_COLUMNS)


def test_carries_the_numbers_the_eval_is_about() -> None:
    [turn] = group_turns(healthy_turn())
    row = project_turn(turn)
    expected = {
        'turnId': 'a3f1c092',
        'source': 'telegram',
        'model': 'deepseek/deepseek-v4-flash',
        'provider': 'Baidu',
        'roundsUsed': 2,
        'toolCalls': 1,
        'stopReason': 'complete',
        'outcome': 'ok',
        'subrequests': 16,
        'elapsedMs': 1300,
    }
    assert {k: row[k] for k in expected} == expected


def test_sums_token_usage_across_the_rounds_of_a_turn() -> None:
    [turn] = group_turns(healthy_turn())
    row = project_turn(turn)
    assert (row['inputTokens'], row['outputTokens'], row['reasoningTokens']) == (3940, 136, 12)


def test_leaves_usage_empty_rather_than_zero_when_no_round_reported_any() -> None:
    records = [{k: v for k, v in r.items() if k != 'usage'} for r in healthy_turn()]
    row = project_turn(group_turns(records)[0])
    assert row['inputTokens'] == ''
    assert row['outputTokens'] == ''


def test_drops_content_even_when_the_deployment_was_logging_it() -> None:
    with_content = healthy_turn()
    with_content[0] = {**with_content[0], 'content': {'sample': 'kdy má máma narozeniny'}}
    with_content[1] = {
        **with_content[1],
        'content': {'args': '{"query":"máma"}', 'resultHead': '<memory name="Máma">…'},
    }
    row = json.dumps(project_turn(group_turns(with_content)[0]), ensure_ascii=False)
    assert 'narozeniny' not in row
    assert 'máma' not in row
    assert 'Máma' not in row


def test_counts_an_empty_completion_which_is_the_failure_the_eval_exists_for() -> None:
    records = healthy_turn()
    records[2] = {**records[2], 'empty': True}
    assert project_turn(group_turns(records)[0])['empty'] == 1
    assert project_turn(group_turns(healthy_turn())[0])['empty'] == 0


def test_marks_a_turn_that_never_finished_instead_of_dropping_it() -> None:
    row = project_turn(group_turns(healthy_turn()[:3])[0])
    assert row['outcome'] == 'unfinished'
    assert row['stopReason'] == ''


def test_does_not_call_maintenance_unfinished() -> None:
    maintenance = [record(turnId='cccc3333', source='reindex', at='reindex', seq=0, indexed=0, rows=38)]
    assert project_turn(group_turns(maintenance)[0])['outcome'] == ''


def test_keeps_dev_turns_labelled_so_a_rate_is_never_pooled_across_sources() -> None:
    dev = [{**r, 'source': 'dev'} for r in healthy_turn()]
    assert project_turn(group_turns(dev)[0])['source'] == 'dev'


def test_csv_writes_a_stable_header_in_the_allowlist_order() -> None:
    [turn] = group_turns(healthy_turn())
    header = to_csv([project_turn(turn)]).split('\n')[0]
    assert header == ','.join(PUBLIC_COLUMNS)


def test_csv_quotes_a_field_containing_a_comma_so_the_column_count_survives() -> None:
    [turn] = group_turns(healthy_turn())
    row = {**project_turn(turn), 'model': 'a,b'}
    assert '"a,b"' in to_csv([row]).split('\n')[1]


def test_csv_produces_a_header_even_with_no_rows() -> None:
    assert to_csv([]) == ','.join(PUBLIC_COLUMNS)
