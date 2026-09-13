import pytest

from retrievers.rerank import RerankRetriever, RerankRow

ROW: RerankRow = {
    'query': 'q1',
    'candidateHash': 'abc',
    'ranked': ['c2', 'c1', 'c3'],
    'scores': [0.9, 0.5, 0.1],
    'depth': 20,
    'maxChars': 1600,
}


def test_serves_the_precomputed_order_cut_to_k() -> None:
    assert RerankRetriever([ROW]).search('q1', 2) == ['c2', 'c1']


def test_fails_closed_on_a_query_it_has_no_row_for_rather_than_scoring_a_miss() -> None:
    with pytest.raises(LookupError, match='rerun eval:rerank'):
        RerankRetriever([ROW]).search('unknown', 2)
