from lib.corpus import Chunk
from lib.find import (
    GiveUp,
    Period,
    Project,
    Terms,
    find_by_period,
    find_by_project,
    find_by_terms,
    parse_search,
    preview,
    reply_preview,
)


def chunk(id: str, text: str, ts: str = '2026-07-01T00:00:00Z', project: str = 'ai-agent') -> Chunk:
    return Chunk(id=id, text=text, session='s', ts=ts, project=project)


def ids(chunks: list[Chunk]) -> list[str]:
    return [c.id for c in chunks]


def test_reads_plain_words_as_search_terms() -> None:
    assert parse_search('cache email') == Terms(['cache', 'email'])


def test_reads_a_leading_slash_as_a_period_and_projekt_as_a_project() -> None:
    assert parse_search('/2026-07') == Period('2026-07')
    assert parse_search('/projekt acme') == Project('acme')


def test_treats_an_empty_answer_and_a_lone_dot_as_giving_up() -> None:
    assert parse_search('') == GiveUp()
    assert parse_search(' . ') == GiveUp()


def test_matches_without_diacritics_in_either_direction() -> None:
    chunks = [chunk('a', 'řešení účtu'), chunk('b', 'neco jineho')]
    assert ids(find_by_terms(chunks, ['ucet'])) == []
    assert ids(find_by_terms(chunks, ['uctu'])) == ['a']
    assert ids(find_by_terms([chunk('c', 'resim ucet')], ['účet'])) == ['c']


def test_requires_every_term_not_any() -> None:
    chunks = [chunk('a', 'cache a email'), chunk('b', 'jen cache')]
    assert ids(find_by_terms(chunks, ['cache', 'email'])) == ['a']


def test_searches_the_project_field_too() -> None:
    assert ids(find_by_terms([chunk('a', 'nic', project='acme-shop')], ['acme'])) == ['a']


def test_returns_hits_chronologically_so_no_retriever_opinion_leaks_in() -> None:
    chunks = [
        chunk('late', 'cache cache cache cache', '2026-07-20T00:00:00Z'),
        chunk('early', 'cache once', '2026-07-01T00:00:00Z'),
    ]
    assert ids(find_by_terms(chunks, ['cache'])) == ['early', 'late']


def test_sorts_an_undated_chunk_last_instead_of_letting_it_head_the_list() -> None:
    chunks = [chunk('undated', 'cache', ''), chunk('dated', 'cache', '2026-07-01T00:00:00Z')]
    assert ids(find_by_terms(chunks, ['cache'])) == ['dated', 'undated']


def test_returns_nothing_for_an_empty_term_list_rather_than_the_whole_corpus() -> None:
    assert find_by_terms([chunk('a', 'cokoliv')], []) == []
    assert find_by_terms([chunk('a', 'cokoliv')], ['  ']) == []


def test_matches_a_timestamp_prefix() -> None:
    chunks = [chunk('a', 'x', '2026-07-30T10:00:00Z'), chunk('b', 'x', '2026-06-30T10:00:00Z')]
    assert ids(find_by_period(chunks, '2026-07')) == ['a']


def test_matches_a_project_substring_folded() -> None:
    assert ids(find_by_project([chunk('a', 'x', project='AI-Agent')], 'ai-ag')) == ['a']


def test_returns_nothing_for_an_empty_prefix_or_name() -> None:
    assert find_by_period([chunk('a', 'x')], '') == []
    assert find_by_project([chunk('a', 'x')], ' ') == []


def test_preview_centres_the_window_on_the_first_hit() -> None:
    text = f'{"a" * 400} JEHLA {"b" * 400}'
    out = preview(text, ['jehla'], 60)
    assert 'JEHLA' in out
    assert out.startswith('…')
    assert out.endswith('…')


def test_preview_falls_back_to_the_head_when_no_term_matches_and_does_not_pad_a_short_chunk() -> None:
    assert preview('krátký text', ['chybí'], 60) == 'krátký text'


def test_preview_collapses_newlines_so_a_hit_stays_on_one_line() -> None:
    assert preview('prvni\n\ndruhy', ['druhy'], 60) == 'prvni druhy'


def test_reply_preview_shows_the_reply_because_the_prompt_is_often_y() -> None:
    out = reply_preview('y\n\nZahodím BE commit a přidám varování před odesláním.')
    assert 'Zahodím BE commit' in out
    assert out.startswith('y →')


def test_reply_preview_falls_back_to_the_whole_text_when_there_is_no_reply_to_split_off() -> None:
    assert reply_preview('jen jeden odstavec') == 'jen jeden odstavec'
