from lib.records import AgentRecord, from_exported_event, group_turns, is_agent_record


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


def test_accepts_a_record_carrying_the_envelope() -> None:
    assert is_agent_record(record())


def test_rejects_anything_without_a_turn_id_rather_than_inventing_one() -> None:
    assert not is_agent_record({**record(), 'turnId': None})
    assert not is_agent_record({'v': 1, 'at': 'ddg', 'status': 200})


def test_rejects_a_schema_version_it_does_not_understand() -> None:
    assert not is_agent_record({**record(), 'v': 2})


def test_rejects_non_objects_without_raising() -> None:
    assert not is_agent_record(None)
    assert not is_agent_record('a string')


def test_assembles_records_into_turns_ordered_by_seq() -> None:
    turns = group_turns(
        [
            record(seq=2, at='turn', outcome='ok', stopReason='complete', subrequests=16),
            record(seq=0, at='tool-loop', stage='round', round=0),
            record(seq=1, at='tool-loop', stage='done', roundsUsed=1, stopReason='complete'),
        ]
    )
    assert len(turns) == 1
    assert turns[0].turn_id == 'a3f1c092'
    assert turns[0].source == 'telegram'
    assert [r['seq'] for r in turns[0].records] == [0, 1, 2]


def test_keeps_turns_separate_and_orders_them_by_when_they_started() -> None:
    turns = group_turns(
        [
            record(turnId='bbbb2222', ts=2000, seq=0),
            record(turnId='aaaa1111', ts=1000, seq=0),
            record(turnId='bbbb2222', ts=2100, seq=1),
        ]
    )
    assert [t.turn_id for t in turns] == ['aaaa1111', 'bbbb2222']
    assert len(turns[1].records) == 2


def test_drops_records_without_a_turn_id_instead_of_pooling_them_under_one() -> None:
    turns = group_turns(
        [
            record(seq=0),
            {'at': 'ddg', 'status': 200},
            {'v': 1, 'at': 'vault', 'stage': 'skills-truncated'},
            {'v': 1, 'ts': 1, 'level': 'info', 'source': 'schedule', 'seq': 0, 'at': 'post-notice'},
        ]
    )
    assert len(turns) == 1
    assert len(turns[0].records) == 1


def test_surfaces_the_turn_record_and_the_loop_outcome_without_a_second_pass() -> None:
    [turn] = group_turns(
        [
            record(seq=0, at='tool-loop', stage='round'),
            record(seq=1, at='tool-loop', stage='done', roundsUsed=3, stopReason='max-rounds'),
            record(seq=2, at='turn', outcome='ok', stopReason='max-rounds', subrequests=22),
        ]
    )
    assert turn.outcome == 'ok'
    assert turn.stop_reason == 'max-rounds'
    assert turn.subrequests == 22
    assert turn.rounds_used == 3


def test_falls_back_to_the_loop_record_for_why_an_unfinished_turn_stopped() -> None:
    [turn] = group_turns(
        [
            record(seq=0, at='tool-loop', stage='round'),
            record(seq=1, at='tool-loop', stage='done', roundsUsed=6, stopReason='max-rounds'),
        ]
    )
    assert turn.complete is False
    assert turn.stop_reason == 'max-rounds'


def test_reports_a_turn_that_produced_no_turn_record_at_all() -> None:
    [turn] = group_turns([record(seq=0, at='tool-loop', stage='round')])
    assert turn.outcome is None
    assert turn.complete is False


def test_separates_dev_traffic_from_organic_so_a_rate_is_never_pooled_across_them() -> None:
    turns = group_turns(
        [
            record(turnId='aaaa1111', source='telegram'),
            record(turnId='bbbb2222', source='dev'),
            record(turnId='cccc3333', source='reflection'),
        ]
    )
    assert [t.source for t in turns] == ['telegram', 'dev', 'reflection']


def test_counts_a_failed_turn_by_its_error_record() -> None:
    [turn] = group_turns(
        [
            record(seq=0, at='tool-loop', stage='round'),
            record(seq=1, level='error', at='turn', outcome='error', stopReason='error', subrequests=9),
        ]
    )
    assert turn.outcome == 'error'
    assert turn.stop_reason == 'error'
    assert turn.complete is True


def test_unwraps_the_envelope_the_export_nests_under_source() -> None:
    exported = {
        'dataset': 'cloudflare-workers',
        'timestamp': 1_786_132_472_080,
        '$metadata': {'id': 'x', 'service': 'personal-agent'},
        'source': {
            'v': 1,
            'ts': 1_786_132_472_080,
            'level': 'info',
            'source': 'reindex',
            'turnId': '8337db20',
            'seq': 0,
            'at': 'reindex',
            'rows': 38,
        },
    }
    rec = from_exported_event(exported)
    assert rec is not None
    assert rec['turnId'] == '8337db20'
    assert rec['at'] == 'reindex'
    assert rec['source'] == 'reindex'
    assert rec['rows'] == 38


def test_accepts_a_record_that_is_already_unwrapped() -> None:
    flat = {
        'v': 1,
        'ts': 1,
        'level': 'info',
        'source': 'telegram',
        'turnId': 'aaaa1111',
        'seq': 0,
        'at': 'turn',
    }
    rec = from_exported_event(flat)
    assert rec is not None
    assert rec['turnId'] == 'aaaa1111'


def test_returns_none_for_an_event_carrying_no_envelope_at_all() -> None:
    assert from_exported_event({'source': {'level': 'error', 'message': 'reflection failed'}}) is None
    assert from_exported_event({'$metadata': {'id': 'x'}}) is None
    assert from_exported_event(None) is None
