import math
from collections.abc import Callable, Iterable, Sequence
from typing import NamedTuple


def recall_at_k(ranked: list[str], relevant: list[str], k: int) -> float:
    if not relevant:
        return 0
    return len(set(ranked[:k]) & set(relevant)) / len(relevant)


def reciprocal_rank(ranked: list[str], relevant: list[str]) -> float:
    rel = set(relevant)
    for position, item in enumerate(ranked, start=1):
        if item in rel:
            return 1 / position
    return 0


def ndcg_at_k(ranked: list[str], relevant: list[str], k: int) -> float:
    rel = set(relevant)
    dcg = naive_sum(1 / math.log2(i + 2) for i, item in enumerate(ranked[:k]) if item in rel)
    ideal = naive_sum(1 / math.log2(i + 2) for i in range(min(k, len(relevant))))
    return dcg / ideal if ideal else 0


# mulberry32 is a 32-bit algorithm: JS `>>> 0` and `Math.imul` drop the overflow, Python ints never
# overflow, so every add and multiply is masked or the sequence diverges from the TypeScript one.
MASK32 = 0xFFFFFFFF


def mulberry32(seed: int) -> Callable[[], float]:
    t = seed & MASK32

    def rand() -> float:
        nonlocal t
        t = (t + 0x6D2B79F5) & MASK32
        x = ((t ^ (t >> 15)) * (1 | t)) & MASK32
        x = (x + (((x ^ (x >> 7)) * (61 | x)) & MASK32)) ^ x
        x &= MASK32
        return ((x ^ (x >> 14)) & MASK32) / 4294967296

    return rand


def naive_sum(xs: Iterable[float]) -> float:
    total = 0.0
    for x in xs:
        total += x
    return total


def mean(xs: Sequence[float]) -> float:
    return naive_sum(xs) / len(xs) if xs else 0


class Bootstrap(NamedTuple):
    mean_diff: float
    lower: float
    upper: float


def paired_bootstrap(a: list[float], b: list[float], resamples: int = 10_000, seed: int = 1) -> Bootstrap:
    if len(a) != len(b):
        raise ValueError('paired bootstrap needs equal-length inputs')
    n = len(a)
    diffs = [x - y for x, y in zip(a, b, strict=True)]
    rand = mulberry32(seed)

    means = sorted(naive_sum(diffs[math.floor(rand() * n)] for _ in range(n)) / n for _ in range(resamples))
    return Bootstrap(
        mean_diff=mean(diffs),
        lower=means[math.floor(0.025 * resamples)],
        upper=means[math.floor(0.975 * resamples)],
    )


def cosine(a: list[float], b: list[float]) -> float:
    if len(a) != len(b):
        raise ValueError(f'cosine: dimension mismatch ({len(a)} vs {len(b)})')
    dot = naive_sum(x * y for x, y in zip(a, b, strict=True))
    na = naive_sum(x * x for x in a)
    nb = naive_sum(y * y for y in b)
    if na == 0 or nb == 0:
        return 0
    return dot / (math.sqrt(na) * math.sqrt(nb))
