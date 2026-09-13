from lib.corpus import Chunk
from retrievers.keyword import KeywordRetriever


def test_mirrors_production_substring_matching_case_and_diacritics_insensitively(corpus: list[Chunk]) -> None:
    r = KeywordRetriever(corpus)
    assert 'c1' in r.search('cache', 3)
    assert 'c1' in r.search('CACHE', 3)
    assert 'c4' in r.search('kava', 3)


def test_returns_nothing_when_no_token_appears_rather_than_an_arbitrary_ranking(corpus: list[Chunk]) -> None:
    assert KeywordRetriever(corpus).search('kvantová chromodynamika', 3) == []


def test_ties_keep_corpus_order_like_the_typescript_sort(corpus: list[Chunk]) -> None:
    assert KeywordRetriever(corpus).search('Workers', 2) == ['c1', 'c2']
