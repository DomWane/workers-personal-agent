from collections import defaultdict
from typing import NamedTuple

from retrievers.keyword import Retriever

RRF_K = 60


class Weighted(NamedTuple):
    retriever: Retriever
    weight: float


class RrfRetriever:
    def __init__(
        self, parts: list[Weighted], depth: int = 20, name: str | None = None, k: int = RRF_K
    ) -> None:
        self.parts = parts
        self.depth = depth
        self.damping = k
        self.name = name or 'rrf(' + '+'.join(f'{p.retriever.name}:{p.weight:g}' for p in parts) + ')'

    def search(self, query: str, k: int) -> list[str]:
        scores: defaultdict[str, float] = defaultdict(float)
        for retriever, weight in self.parts:
            for i, id in enumerate(retriever.search(query, self.depth)):
                scores[id] += weight / (self.damping + i + 1)
        ranked = sorted(scores.items(), key=lambda pair: (-pair[1], pair[0]))
        return [id for id, _ in ranked[:k]]
