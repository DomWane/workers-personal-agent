from label.hard import Hits, hits_for, query_key
from lib.corpus import Chunk


def chunk(id: str, text: str, ts: str = '2026-07-01T00:00:00Z', project: str = 'ai-agent') -> Chunk:
    return Chunk(id=id, text=text, session='s', ts=ts, project=project)


CORPUS = [
    chunk('a', 'jak cachovat email', '2026-07-02T00:00:00Z'),
    chunk('b', 'neco o r2', '2026-06-02T00:00:00Z', 'acme-shop'),
]


def found(raw: str) -> Hits:
    hits = hits_for(raw, CORPUS)
    assert hits is not None
    return hits


def test_marks_word_search_and_date_or_project_browsing_apart() -> None:
    assert found('cachovat').via == 'search'
    assert found('/2026-06').via == 'browse'
    assert found('/projekt acme').via == 'browse'


def test_returns_none_when_the_labeller_gives_up_rather_than_an_empty_hit_list() -> None:
    assert hits_for('.', CORPUS) is None
    assert hits_for('', CORPUS) is None


def test_finds_nothing_for_a_term_that_is_absent_without_falling_back_to_the_whole_corpus() -> None:
    assert found('neexistuje').hits == []


def test_passes_the_terms_through_so_the_preview_can_centre_on_the_match() -> None:
    assert found('cachovat email').terms == ['cachovat', 'email']
    assert found('/2026-06').terms == []


def test_query_key_catches_the_same_question_typed_with_different_accents_case_and_spacing() -> None:
    assert query_key('Jak jsem řešil  cache?') == query_key('jak jsem resil cache?')


def test_query_key_keeps_genuinely_different_questions_apart() -> None:
    assert query_key('jak jsem řešil cache') != query_key('jak jsem řešil embed')
