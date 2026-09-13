from collections.abc import Sequence
from typing import Literal, cast

from lib.records import AgentRecord, Turn, as_record

PUBLIC_COLUMNS = (
    'turnId',
    'source',
    'model',
    'provider',
    'outcome',
    'stopReason',
    'roundsUsed',
    'toolCalls',
    'empty',
    'subrequests',
    'elapsedMs',
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
)

TurnRow = dict[str, str | int]

CONVERSATIONAL = frozenset({'telegram', 'dev'})


def rounds(turn: Turn) -> list[AgentRecord]:
    return [r for r in turn.records if r['at'] == 'tool-loop' and r.get('stage') == 'round']


def sum_usage(turn: Turn, field: Literal['inputTokens', 'outputTokens', 'reasoningTokens']) -> int | str:
    total = 0
    reported = False
    for round in rounds(turn):
        usage = as_record(round.get('usage'))
        value = usage.get(field) if usage else None
        if isinstance(value, int | float) and not isinstance(value, bool):
            total += int(value)
            reported = True
    return total if reported else ''


def project_turn(turn: Turn) -> TurnRow:
    none: AgentRecord = {}
    round_records = rounds(turn)
    first = round_records[0] if round_records else none
    summary = next((r for r in turn.records if r['at'] == 'turn' or r.get('stage') == 'done'), none)
    tools_used = summary.get('toolsUsed')
    turn_record = next((r for r in turn.records if r['at'] == 'turn'), none)
    default_outcome = 'unfinished' if turn.source in CONVERSATIONAL else ''
    return {
        'turnId': turn.turn_id,
        'source': turn.source,
        'model': first.get('model', ''),
        'provider': first.get('provider', ''),
        'outcome': turn.outcome if turn.outcome is not None else default_outcome,
        'stopReason': turn.stop_reason or '',
        'roundsUsed': turn.rounds_used if turn.rounds_used is not None else len(round_records),
        'toolCalls': len(cast(list[object], tools_used)) if isinstance(tools_used, list) else 0,
        'empty': 1 if any(r.get('empty') is True for r in round_records) else 0,
        'subrequests': turn.subrequests if turn.subrequests is not None else '',
        'elapsedMs': turn_record.get('elapsedMs', ''),
        'inputTokens': sum_usage(turn, 'inputTokens'),
        'outputTokens': sum_usage(turn, 'outputTokens'),
        'reasoningTokens': sum_usage(turn, 'reasoningTokens'),
    }


def csv_field(value: str | int) -> str:
    s = str(value)
    return '"' + s.replace('"', '""') + '"' if any(ch in s for ch in '",\n') else s


def to_csv(rows: Sequence[TurnRow]) -> str:
    lines = [','.join(PUBLIC_COLUMNS)]
    lines.extend(','.join(csv_field(row[c]) for c in PUBLIC_COLUMNS) for row in rows)
    return '\n'.join(lines)
