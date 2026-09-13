from lib.corpus import Chunk
from lib.leakage import build_idf, leakage_score


def mk(id: str, text: str) -> Chunk:
    return Chunk(id=id, text=text, session='s', ts='t', project='p')


CORPUS = [
    mk('c1', 'cache invalidace přes tag purge na Cloudflare'),
    mk('c2', 'cache je rychlá'),
    mk('c3', 'cache a KV'),
    mk('c4', 'nákupní seznam'),
]
IDF = build_idf(CORPUS)


def test_is_high_when_the_query_reuses_the_rare_terms_of_its_chunk() -> None:
    assert leakage_score('tag purge invalidace Cloudflare', CORPUS[0].text, IDF) > 0.5


def test_is_low_for_a_paraphrase_that_shares_only_common_words() -> None:
    assert leakage_score('jak jsme řešili mazání uložených dat', CORPUS[0].text, IDF) < 0.3


def test_ignores_terms_that_are_common_across_the_corpus() -> None:
    assert leakage_score('cache', CORPUS[0].text, IDF) < 0.3
