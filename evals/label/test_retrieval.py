import json
from pathlib import Path

from gen.queries import Candidate
from label.retrieval import load_dropped_ids, load_kept_ids, select_todo


def test_treats_a_resume_file_that_does_not_exist_yet_as_no_decisions_made(tmp_path: Path) -> None:
    assert load_dropped_ids(tmp_path / 'missing.jsonl') == set()


def test_skips_a_partially_written_trailing_line_instead_of_raising(tmp_path: Path) -> None:
    file = tmp_path / 'dropped.jsonl'
    file.write_text(json.dumps({'chunkId': 'c1'}) + '\n{"chunkId":"c2')
    assert load_dropped_ids(file) == {'c1'}


def test_load_kept_ids_reads_relevant_0_from_label_lines(tmp_path: Path) -> None:
    file = tmp_path / 'labels.jsonl'
    file.write_text(json.dumps({'query': 'q', 'relevant': ['c1'], 'kind': 'bulk'}) + '\n')
    assert load_kept_ids(file) == {'c1'}


def test_a_dropped_candidate_does_not_reappear_in_todo_distinct_from_a_kept_one() -> None:
    candidates: list[Candidate] = [
        {'chunkId': 'c1', 'query': 'q1', 'leakage': 0.1},
        {'chunkId': 'c2', 'query': 'q2', 'leakage': 0.1},
        {'chunkId': 'c3', 'query': 'q3', 'leakage': 0.1},
    ]
    assert [c['chunkId'] for c in select_todo(candidates, {'c1', 'c2'})] == ['c3']
