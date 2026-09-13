from retrievers.by_parent import ByParent


class Fixed:
    name = 'fixed'

    def __init__(self, ranked: list[str]) -> None:
        self.ranked = ranked
        self.asked: list[int] = []

    def search(self, query: str, k: int) -> list[str]:
        self.asked.append(k)
        return self.ranked[:k]


def test_folds_chunk_hits_to_their_parent_keeping_the_best_rank() -> None:
    r = ByParent(Fixed(['b#2', 'a#0', 'b#0', 'c#1']), 100)
    assert r.search('q', 3) == ['b', 'a', 'c']


def test_folds_before_cutting_or_one_long_document_eats_the_whole_top_k() -> None:
    r = ByParent(Fixed(['a#0', 'a#1', 'a#2', 'b#0', 'c#0']), 100)
    assert r.search('q', 3) == ['a', 'b', 'c']


def test_asks_the_inner_retriever_for_the_whole_corpus_not_a_multiple_of_k() -> None:
    inner = Fixed(['a#0', 'b#0'])
    ByParent(inner, 673).search('q', 10)
    assert inner.asked == [673]


def test_stops_as_soon_as_k_distinct_parents_are_found() -> None:
    r = ByParent(Fixed(['a#0', 'b#0', 'c#0', 'd#0']), 100)
    assert r.search('q', 2) == ['a', 'b']


def test_passes_unchunked_ids_through_unchanged() -> None:
    r = ByParent(Fixed(['a', 'b']), 100)
    assert r.search('q', 5) == ['a', 'b']


def test_takes_the_inner_name_unless_given_one() -> None:
    assert ByParent(Fixed([]), 1).name == 'fixed'
    assert ByParent(Fixed([]), 1, 'bge-m3/1600+200').name == 'bge-m3/1600+200'
