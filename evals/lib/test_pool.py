from dataclasses import dataclass, field

from lib.pool import PoolItem, build_pool, key, shuffle_within_query


class Fixed:
    def __init__(self, name: str, ids: list[str]) -> None:
        self.name = name
        self.ids = ids

    def search(self, query: str, k: int) -> list[str]:
        return self.ids[:k]


@dataclass(frozen=True)
class Label:
    query: str
    relevant: list[str] = field(default_factory=list[str])


LABELS = [Label('q1', ['known'])]


def test_unions_every_retriever_so_no_system_is_credited_with_anothers_finds() -> None:
    pool = build_pool(LABELS, [Fixed('a', ['x', 'y']), Fixed('b', ['y', 'z'])], 2, set())
    assert [p.chunk_id for p in pool] == ['x', 'y', 'z']


def test_never_re_offers_the_chunk_that_is_already_the_labels_target() -> None:
    pool = build_pool(LABELS, [Fixed('a', ['known', 'x'])], 2, set())
    assert [p.chunk_id for p in pool] == ['x']


def test_respects_depth_rather_than_taking_everything_a_retriever_returns() -> None:
    pool = build_pool(LABELS, [Fixed('a', ['x', 'y', 'z'])], 2, set())
    assert [p.chunk_id for p in pool] == ['x', 'y']


def test_skips_pairs_already_judged_including_the_ones_judged_not_relevant() -> None:
    pool = build_pool(LABELS, [Fixed('a', ['x', 'y'])], 2, {key('q1', 'x')})
    assert [p.chunk_id for p in pool] == ['y']


def test_judges_a_chunk_per_query_so_the_same_chunk_is_still_asked_about_for_another_query() -> None:
    two = [Label('q1'), Label('q2')]
    pool = build_pool(two, [Fixed('a', ['x'])], 1, {key('q1', 'x')})
    assert pool == [PoolItem('q2', 'x')]


ITEMS = [PoolItem('q1', chunk_id) for chunk_id in ['a', 'b', 'c', 'd', 'e']]


def test_reorders_candidates_so_their_position_carries_no_hint_of_which_retriever_ranked_them() -> None:
    assert [i.chunk_id for i in shuffle_within_query(ITEMS)] != ['a', 'b', 'c', 'd', 'e']


def test_keeps_the_same_set_and_is_deterministic() -> None:
    once = shuffle_within_query(ITEMS)
    assert shuffle_within_query(ITEMS) == once
    assert sorted(i.chunk_id for i in once) == ['a', 'b', 'c', 'd', 'e']


def test_shuffles_in_the_typescript_order_so_a_session_labelled_there_resumes_here() -> None:
    assert [i.chunk_id for i in shuffle_within_query(ITEMS)] == ['e', 'c', 'b', 'a', 'd']


def test_does_not_interleave_queries_so_the_reviewer_stays_on_one_question_at_a_time() -> None:
    mixed = [PoolItem('q1', 'a'), PoolItem('q2', 'b'), PoolItem('q1', 'c')]
    assert [i.query for i in shuffle_within_query(mixed)] == ['q1', 'q1', 'q2']
