from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, TypeGuard, cast

SUPPORTED_SCHEMA_VERSION = 1

AgentRecord = dict[str, Any]


def as_record(value: object) -> AgentRecord | None:
    return cast(AgentRecord, value) if isinstance(value, dict) else None


@dataclass(frozen=True, slots=True)
class Turn:
    turn_id: str
    source: str
    started_at: int
    records: list[AgentRecord] = field(default_factory=list[AgentRecord])
    outcome: str | None = None
    stop_reason: str | None = None
    subrequests: int | None = None
    rounds_used: int | None = None
    complete: bool = False


def is_agent_record(value: object) -> TypeGuard[AgentRecord]:
    r = as_record(value)
    if r is None:
        return False
    turn_id = r.get('turnId')
    return (
        r.get('v') == SUPPORTED_SCHEMA_VERSION
        and isinstance(turn_id, str)
        and len(turn_id) > 0
        and isinstance(r.get('seq'), int | float)
        and isinstance(r.get('at'), str)
    )


def from_exported_event(event: object) -> AgentRecord | None:
    outer = as_record(event)
    if outer is None:
        return None
    if is_agent_record(outer):
        return outer
    nested = outer.get('source')
    return nested if is_agent_record(nested) else None


def group_turns(records: list[AgentRecord]) -> list[Turn]:
    by_turn: defaultdict[str, list[AgentRecord]] = defaultdict(list)
    for record in records:
        if is_agent_record(record):
            by_turn[record['turnId']].append(record)

    turns: list[Turn] = []
    for turn_id, unordered in by_turn.items():
        ordered = sorted(unordered, key=lambda r: r['seq'])
        turn_record = next((r for r in ordered if r['at'] == 'turn'), None)
        done = next((r for r in ordered if r['at'] == 'tool-loop' and r.get('stage') == 'done'), None)
        turns.append(
            Turn(
                turn_id=turn_id,
                source=ordered[0]['source'],
                started_at=min(r['ts'] for r in ordered),
                records=ordered,
                outcome=turn_record.get('outcome') if turn_record else None,
                stop_reason=(turn_record or {}).get('stopReason') or (done or {}).get('stopReason'),
                subrequests=turn_record.get('subrequests') if turn_record else None,
                rounds_used=done.get('roundsUsed') if done else None,
                complete=turn_record is not None,
            )
        )
    return sorted(turns, key=lambda t: t.started_at)
