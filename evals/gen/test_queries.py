import json
from pathlib import Path

from gen.queries import load_done_chunk_ids, process_chunk, select_todo
from lib.corpus import Chunk
from lib.leakage import build_idf


def mk(id: str, text: str) -> Chunk:
    return Chunk(id=id, text=text, session='s', ts='t', project='p')


CORPUS = [mk('c1', 'cache invalidace přes tag purge'), mk('c2', 'nákupní seznam')]
IDF = build_idf(CORPUS)


def test_returns_no_done_ids_when_the_file_does_not_exist(tmp_path: Path) -> None:
    assert load_done_chunk_ids(tmp_path / 'missing.jsonl') == set()


def test_picks_up_chunk_ids_already_written_so_a_re_run_skips_them(tmp_path: Path) -> None:
    file = tmp_path / 'candidates.jsonl'
    file.write_text(json.dumps({'chunkId': 'c1', 'query': 'q', 'leakage': 0.1}) + '\n')
    done = load_done_chunk_ids(file)
    assert done == {'c1'}
    assert [c.id for c in select_todo(CORPUS, done)] == ['c2']


def test_tolerates_a_partially_written_last_line_from_an_interrupted_append(tmp_path: Path) -> None:
    file = tmp_path / 'candidates.jsonl'
    file.write_text(json.dumps({'chunkId': 'c1', 'query': 'q', 'leakage': 0.1}) + '\n{"chunkId":"c2","que')
    assert load_done_chunk_ids(file) == {'c1'}


def test_writes_on_the_first_non_leaking_attempt() -> None:
    result = process_chunk(CORPUS[0], IDF, lambda _: 'jak jsme mazali data', 3, 0.25)
    assert result.status == 'written'
    assert result.leakage_rejections == 0


def test_reports_exhausted_not_error_when_every_attempt_leaks() -> None:
    result = process_chunk(CORPUS[0], IDF, lambda _: 'tag purge invalidace cache', 3, 0.25)
    assert result.status == 'exhausted'
    assert result.leakage_rejections == 3


def test_reports_error_distinct_from_exhausted_when_the_call_raises_and_does_not_retry() -> None:
    calls = 0

    def failing(_: Chunk) -> str:
        nonlocal calls
        calls += 1
        raise RuntimeError('openrouter 429')

    result = process_chunk(CORPUS[0], IDF, failing, 3, 0.25)
    assert result.status == 'error'
    assert calls == 1
    assert result.leakage_rejections == 0


def test_retries_after_a_leak_and_can_still_succeed_within_the_attempt_budget() -> None:
    answers = iter(['tag purge invalidace cache', 'jak jsme mazali data'])
    result = process_chunk(CORPUS[0], IDF, lambda _: next(answers), 3, 0.25)
    assert result.status == 'written'
    assert result.leakage_rejections == 1


def test_never_writes_a_candidate_for_a_blank_query_however_the_guard_scores_it() -> None:
    assert process_chunk(CORPUS[0], IDF, lambda _: '   ', 3, 0.25).status != 'written'


def test_retries_a_blank_completion_and_keeps_the_query_that_arrives() -> None:
    answers = iter(['', 'Jak jsme mazali uložená data?'])
    result = process_chunk(CORPUS[0], IDF, lambda _: next(answers), 3, 0.25)
    assert result.status == 'written'
    assert result.candidate is not None
    assert result.candidate['query'] == 'Jak jsme mazali uložená data?'
