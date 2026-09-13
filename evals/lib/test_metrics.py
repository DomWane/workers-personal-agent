import math

import pytest

from lib.metrics import cosine, ndcg_at_k, paired_bootstrap, recall_at_k, reciprocal_rank


def test_recall_is_the_share_of_relevant_items_found_in_the_top_k() -> None:
    assert recall_at_k(['a', 'b', 'c'], ['a', 'c'], 3) == 1
    assert recall_at_k(['a', 'b', 'c'], ['a', 'z'], 3) == 0.5
    assert recall_at_k(['b', 'a'], ['a'], 1) == 0


def test_recall_is_0_when_nothing_is_relevant_rather_than_dividing_by_zero() -> None:
    assert recall_at_k(['a'], [], 1) == 0


def test_reciprocal_rank_is_one_over_the_rank_of_the_first_hit() -> None:
    assert reciprocal_rank(['a', 'b'], ['a']) == 1
    assert reciprocal_rank(['x', 'a'], ['a']) == 0.5
    assert reciprocal_rank(['x', 'y'], ['a']) == 0


def test_ndcg_matches_a_hand_computed_value_for_a_single_hit_at_rank_2() -> None:
    assert ndcg_at_k(['x', 'a'], ['a'], 3) == pytest.approx(1 / math.log2(3), abs=1e-4)


def test_ndcg_is_1_when_all_relevant_items_lead_the_ranking() -> None:
    assert ndcg_at_k(['a', 'b', 'x'], ['a', 'b'], 3) == pytest.approx(1, abs=1e-6)


def test_ndcg_caps_the_ideal_ranking_at_k() -> None:
    assert ndcg_at_k(['a'], ['a', 'b', 'c'], 1) == pytest.approx(1, abs=1e-6)


def unpaired_bootstrap(a: list[float], b: list[float], resamples: int, seed: int) -> tuple[float, float]:
    state = seed & 0xFFFFFFFF

    def rand() -> float:
        nonlocal state
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        return state / 4294967296

    def draw(xs: list[float]) -> float:
        return sum(xs[math.floor(rand() * len(xs))] for _ in xs) / len(xs)

    means = sorted(draw(a) - draw(b) for _ in range(resamples))
    return means[math.floor(0.025 * resamples)], means[math.floor(0.975 * resamples)]


def test_bootstrap_brackets_a_consistent_improvement_away_from_zero() -> None:
    a = [0.4] * 60
    b = [0.7] * 60
    result = paired_bootstrap(b, a, 2000, 1)
    assert result.mean_diff == pytest.approx(0.3, abs=1e-6)
    assert result.lower > 0


def test_bootstrap_spans_zero_when_the_two_systems_only_differ_by_noise() -> None:
    a = [0.2 if i % 2 else 0.8 for i in range(60)]
    b = [0.8 if i % 2 else 0.2 for i in range(60)]
    result = paired_bootstrap(b, a, 2000, 1)
    assert result.lower < 0
    assert result.upper > 0


def test_bootstrap_separates_a_small_consistent_delta_from_large_per_query_variance() -> None:
    base = [((i * 37) % 90) / 100 for i in range(60)]
    better = [x + 0.04 for x in base]

    result = paired_bootstrap(better, base, 4000, 3)
    assert result.mean_diff == pytest.approx(0.04, abs=1e-6)
    assert result.lower > 0

    lower, upper = unpaired_bootstrap(better, base, 4000, 3)
    assert lower < 0
    assert upper > 0


def test_bootstrap_is_deterministic_for_a_given_seed() -> None:
    a = [0.1, 0.5, 0.9, 0.2]
    b = [0.3, 0.4, 0.8, 0.6]
    assert paired_bootstrap(a, b, 500, 7) == paired_bootstrap(a, b, 500, 7)


def test_bootstrap_reproduces_the_typescript_interval_bit_for_bit() -> None:
    a = [0.1, 0.5, 0.9, 0.2]
    b = [0.3, 0.4, 0.8, 0.6]
    result = paired_bootstrap(a, b, 500, 7)
    assert result.mean_diff == pytest.approx(-0.1, abs=1e-12)
    assert result.lower == pytest.approx(-0.3, abs=1e-12)
    assert result.upper == pytest.approx(0.09999999999999998, abs=1e-12)


def test_bootstrap_rejects_unequal_lengths() -> None:
    with pytest.raises(ValueError, match='equal-length'):
        paired_bootstrap([0.1, 0.2], [0.1], 10, 1)


def test_cosine_is_1_for_identical_vectors_and_0_for_orthogonal_ones() -> None:
    assert cosine([1, 2, 3], [1, 2, 3]) == pytest.approx(1, abs=1e-6)
    assert cosine([1, 0], [0, 1]) == pytest.approx(0, abs=1e-6)


def test_cosine_is_0_rather_than_nan_for_a_zero_vector() -> None:
    assert cosine([0, 0], [1, 1]) == 0


def test_cosine_raises_on_a_dimension_mismatch_instead_of_scoring_nan() -> None:
    with pytest.raises(ValueError, match=r'dimension mismatch \(3 vs 2\)'):
        cosine([1, 2, 3], [1, 2])
    with pytest.raises(ValueError, match='dimension mismatch'):
        cosine([1, 2], [1, 2, 3])
