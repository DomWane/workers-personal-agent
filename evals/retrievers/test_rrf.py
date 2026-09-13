from retrievers.rrf import RrfRetriever, Weighted


class Fixed:
    def __init__(self, name: str, ids: list[str]) -> None:
        self.name = name
        self.ids = ids

    def search(self, query: str, k: int) -> list[str]:
        return self.ids[:k]


def test_promotes_a_chunk_both_retrievers_rank_moderately_over_one_only_a_single_retriever_ranks_first() -> (
    None
):
    fused = RrfRetriever(
        [Weighted(Fixed('a', ['x', 'shared', 'p']), 1), Weighted(Fixed('b', ['y', 'shared', 'q']), 1)]
    )
    assert fused.search('q', 1) == ['shared']


def test_respects_weights_so_a_stronger_retriever_can_be_trusted_more() -> None:
    strong = Fixed('strong', ['s'])
    weak = Fixed('weak', ['w'])
    even = RrfRetriever([Weighted(strong, 1), Weighted(weak, 1)])
    tilted = RrfRetriever([Weighted(strong, 3), Weighted(weak, 1)])
    assert len(even.search('q', 2)) == 2
    assert tilted.search('q', 1) == ['s']


def test_fuses_deeper_than_it_returns_which_is_the_point_of_fusing_at_all() -> None:
    a = Fixed('a', ['a1', 'a2', 'a3', 'target'])
    b = Fixed('b', ['b1', 'b2', 'b3', 'target'])
    shallow = RrfRetriever([Weighted(a, 1), Weighted(b, 1)], depth=3)
    assert 'target' not in shallow.search('q', 4)
    deep = RrfRetriever([Weighted(a, 1), Weighted(b, 1)], depth=10)
    assert deep.search('q', 1) == ['target']


def test_is_deterministic_when_scores_tie_so_a_run_can_be_reproduced() -> None:
    fused = RrfRetriever([Weighted(Fixed('a', ['m', 'n']), 1)])
    assert fused.search('q', 2) == fused.search('q', 2)


def test_names_itself_after_its_parts_like_the_typescript_one() -> None:
    fused = RrfRetriever([Weighted(Fixed('bge-m3', []), 4), Weighted(Fixed('bm25-stem', []), 1)])
    assert fused.name == 'rrf(bge-m3:4+bm25-stem:1)'
