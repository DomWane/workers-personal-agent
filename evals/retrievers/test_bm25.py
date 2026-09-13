from lib.corpus import Chunk
from lib.stem import tokenize_stemmed
from retrievers.bm25 import BM25Retriever


def test_ranks_the_chunk_sharing_the_rarer_term_first(corpus: list[Chunk]) -> None:
    assert BM25Retriever(corpus).search('Workers KV', 2)[0] == 'c2'


def test_respects_k(corpus: list[Chunk]) -> None:
    assert len(BM25Retriever(corpus).search('Workers', 1)) == 1


def test_returns_nothing_for_a_query_with_no_shared_vocabulary(corpus: list[Chunk]) -> None:
    assert BM25Retriever(corpus).search('kvantová chromodynamika', 3) == []


def test_a_stemmed_variant_is_the_same_retriever_over_different_terms(corpus: list[Chunk]) -> None:
    r = BM25Retriever(corpus, name='bm25-stem', tokenizer=tokenize_stemmed)
    assert r.name == 'bm25-stem'
    assert r.search('čtením', 1) == ['c2']


def test_scores_match_the_typescript_implementation(corpus: list[Chunk]) -> None:
    assert BM25Retriever(corpus).search('Workers KV', 4) == ['c2', 'c1']
