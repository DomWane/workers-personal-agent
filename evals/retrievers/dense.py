from collections.abc import Callable, Sequence

import numpy as np

from lib.vectors import Vectors


class DenseRetriever:
    def __init__(self, ids: list[str], vectors: Vectors, query_vec: Callable[[str], Sequence[float]]) -> None:
        self.name = 'bge-m3'
        self.ids = ids
        self.query_vec = query_vec
        self.matrix = vectors.astype(np.float64)
        self.norms = np.linalg.norm(self.matrix, axis=1)

    def search(self, query: str, k: int) -> list[str]:
        q = np.asarray(self.query_vec(query), dtype=np.float64)
        if q.size == 0:
            return []
        q_norm = float(np.linalg.norm(q))
        denominator = self.norms * q_norm
        with np.errstate(divide='ignore', invalid='ignore'):
            scores = np.where(denominator == 0, 0.0, (self.matrix @ q) / denominator)
        order = np.argsort(-scores, kind='stable')[:k]
        return [self.ids[i] for i in order]
