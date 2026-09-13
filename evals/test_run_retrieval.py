import pytest

from lib.chunk import Piece
from lib.corpus import Chunk, EmbeddingsIndex, corpus_text_hash
from run_retrieval import Labelled, assert_dense_inputs_fresh, fmt, partition_labels, score

CHUNKS = [Piece('s:0', 'první text'), Piece('s:1', 'druhý text')]
META: EmbeddingsIndex = {'dim': 3, 'ids': ['s:0', 's:1'], 'textHash': corpus_text_hash(CHUNKS)}
QV = {'a': [1.0, 0.0, 0.0], 'b': [0.0, 1.0, 0.0]}


def test_accepts_a_matching_corpus_and_a_full_set_of_query_vectors() -> None:
    assert_dense_inputs_fresh(CHUNKS, META, ['a', 'b'], QV)


def test_raises_when_the_corpus_was_re_ingested_and_the_ids_were_renumbered() -> None:
    with pytest.raises(ValueError, match=r'does not match the corpus[\s\S]*re-run pnpm eval:embed'):
        assert_dense_inputs_fresh([*CHUNKS, Piece('s:2', 'třetí')], META, ['a', 'b'], QV)


def test_raises_when_an_embedded_id_is_no_longer_in_the_corpus() -> None:
    with pytest.raises(ValueError, match='re-run pnpm eval:embed'):
        assert_dense_inputs_fresh([CHUNKS[0]], META, ['a', 'b'], QV)


def test_raises_when_a_labelled_query_was_appended_after_the_last_embed_run() -> None:
    with pytest.raises(
        ValueError, match=r'1/3 labelled queries have no vector of dim 3[\s\S]*re-run pnpm eval:embed'
    ):
        assert_dense_inputs_fresh(CHUNKS, META, ['a', 'b', 'hard'], QV)


def test_raises_when_the_chunk_text_changed_under_unchanged_ids() -> None:
    rewritten = [CHUNKS[0], Piece('s:1', 'druhý text, jinak')]
    with pytest.raises(ValueError, match=r'chunk text[\s\S]*re-run pnpm eval:embed'):
        assert_dense_inputs_fresh(rewritten, META, ['a', 'b'], QV)


def test_raises_when_the_stored_index_predates_the_text_hash() -> None:
    with pytest.raises(ValueError, match='re-run pnpm eval:embed'):
        assert_dense_inputs_fresh(CHUNKS, {'dim': 3, 'ids': ['s:0', 's:1']}, ['a', 'b'], QV)


def test_raises_when_a_query_vector_has_the_wrong_dimension() -> None:
    with pytest.raises(ValueError, match='no vector of dim 3'):
        assert_dense_inputs_fresh(CHUNKS, META, ['a'], {'a': [1.0, 0.0]})


class Stub:
    def __init__(self, name: str, hits: dict[str, list[str]]) -> None:
        self.name = name
        self.hits = hits

    def search(self, query: str, k: int) -> list[str]:
        return self.hits.get(query, [])


def test_score_returns_per_query_aligned_to_the_items_it_was_given() -> None:
    items: list[Labelled] = [
        {'query': 'q0', 'relevant': ['a'], 'kind': 'bulk'},
        {'query': 'q1', 'relevant': ['b'], 'kind': 'bulk'},
        {'query': 'q2', 'relevant': ['c'], 'kind': 'bulk'},
    ]
    one = score(Stub('one', {'q0': ['a'], 'q1': ['z'], 'q2': ['c']}), items)
    two = score(Stub('two', {'q0': ['z'], 'q1': ['b'], 'q2': ['c']}), items)
    assert one.per_query == [1, 0, 1]
    assert two.per_query == [0, 1, 1]
    assert one.row.r3 == pytest.approx(2 / 3, abs=1e-6)


def test_score_measures_each_item_once_in_order_even_when_queries_repeat() -> None:
    items: list[Labelled] = [
        {'query': 'dup', 'relevant': ['a'], 'kind': 'bulk'},
        {'query': 'dup', 'relevant': ['z'], 'kind': 'bulk'},
    ]
    assert score(Stub('one', {'dup': ['a']}), items).per_query == [1, 0]


def test_fmt_marks_a_sub_10_sample_and_never_emits_a_bare_percentage_for_it() -> None:
    assert fmt(0.5, 9) == '0.50*'
    assert fmt(0.5, 1).endswith('*')
    assert fmt(0, 9).endswith('*')


def test_fmt_emits_a_plain_three_decimal_figure_once_the_sample_reaches_10() -> None:
    assert fmt(0.5, 10) == '0.500'
    assert '*' not in fmt(0.5, 60)


def test_drops_labels_whose_chunk_no_longer_exists_instead_of_scoring_them_as_misses() -> None:
    chunks = [
        Chunk(id='aaa', text='cache invalidace', session='s', ts='t', project='p'),
        Chunk(id='bbb', text='workers kv', session='s', ts='t', project='p'),
    ]
    labels: list[Labelled] = [
        {'query': 'cache', 'relevant': ['aaa'], 'kind': 'bulk'},
        {'query': 'zmizelý', 'relevant': ['ccc'], 'kind': 'bulk'},
    ]
    usable, stale = partition_labels(labels, chunks)
    assert [label['query'] for label in usable] == ['cache']
    assert stale == 1
