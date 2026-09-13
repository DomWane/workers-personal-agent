import numpy as np

from retrievers.dense import DenseRetriever

VECS = np.array([[1, 0, 0], [0, 1, 0], [0.9, 0.1, 0]], dtype=np.float32)


def test_ranks_by_cosine_similarity_to_the_query_vector() -> None:
    r = DenseRetriever(['a', 'b', 'c'], VECS, lambda _: [1.0, 0.0, 0.0])
    assert r.search('anything', 2) == ['a', 'c']


def test_returns_nothing_for_an_empty_query_embedding_instead_of_an_arbitrary_ranking() -> None:
    r = DenseRetriever(['a', 'b', 'c'], VECS, lambda _: [])
    assert r.search('anything', 3) == []


def test_respects_k() -> None:
    r = DenseRetriever(['a', 'b', 'c'], VECS, lambda _: [1.0, 0.0, 0.0])
    assert r.search('q', 1) == ['a']


def test_a_zero_row_scores_0_rather_than_nan_and_sorts_last() -> None:
    with_zero = np.array([[0, 0, 0], [1, 0, 0]], dtype=np.float32)
    r = DenseRetriever(['zero', 'a'], with_zero, lambda _: [1.0, 0.0, 0.0])
    assert r.search('q', 2) == ['a', 'zero']
