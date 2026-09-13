from lib.corpus import Chunk
from retrievers.fasttext import FasttextRetriever

VECTORS = {
    'cache': [1.0, 0.0],
    'workers': [0.0, 1.0],
    'kava': [-1.0, 0.0],
}


def test_ranks_by_idf_weighted_mean_of_word_vectors(corpus: list[Chunk]) -> None:
    r = FasttextRetriever(corpus, VECTORS, 2)
    assert r.search('cache', 1) == ['c1']
    assert r.search('káva', 1) == ['c4']


def test_returns_nothing_when_every_query_word_is_out_of_vocabulary(corpus: list[Chunk]) -> None:
    assert FasttextRetriever(corpus, VECTORS, 2).search('kvantová chromodynamika', 3) == []


def test_skips_documents_made_only_of_unknown_words_rather_than_scoring_them(corpus: list[Chunk]) -> None:
    assert 'c3' not in FasttextRetriever(corpus, VECTORS, 2).search('cache workers', 4)
