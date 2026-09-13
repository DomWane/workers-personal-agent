from pathlib import Path

import pytest

from lib.jsonl import append_json_line, read_json_lines


def test_reads_complete_lines(tmp_path: Path) -> None:
    p = tmp_path / 'a.jsonl'
    p.write_text('{"a":1}\n{"a":2}\n')
    assert read_json_lines(p) == [{'a': 1}, {'a': 2}]


def test_keeps_everything_before_a_truncated_trailing_line_from_an_interrupted_append(tmp_path: Path) -> None:
    p = tmp_path / 'b.jsonl'
    p.write_text('{"a":1}\n{"a":2}\n{"a":')
    assert read_json_lines(p) == [{'a': 1}, {'a': 2}]


def test_returns_nothing_for_a_file_that_does_not_exist_yet(tmp_path: Path) -> None:
    assert read_json_lines(tmp_path / 'nope.jsonl') == []


def test_raises_for_a_missing_file_the_caller_declared_required(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match='missing input file'):
        read_json_lines(tmp_path / 'nope.jsonl', required=True)


def test_append_writes_one_line_per_record_and_reads_back_unchanged(tmp_path: Path) -> None:
    p = tmp_path / 'out' / 'c.jsonl'
    append_json_line(p, {'q': 'káva'})
    append_json_line(p, {'q': 'čaj'})
    assert read_json_lines(p) == [{'q': 'káva'}, {'q': 'čaj'}]
    assert 'káva' in p.read_text(encoding='utf-8')
