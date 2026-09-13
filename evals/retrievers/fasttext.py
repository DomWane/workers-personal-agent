import math
from collections import Counter
from collections.abc import Mapping, Sequence

import numpy as np
from numpy.typing import NDArray

from lib.corpus import Chunk
from lib.tokenize import tokenize

Vector = NDArray[np.float32]


class FasttextRetriever:
    def __init__(
        self, chunks: list[Chunk], vectors: Mapping[str, Sequence[float]], dim: int, name: str = 'fasttext'
    ) -> None:
        self.name = name
        self.ids = [c.id for c in chunks]
        self.vectors = vectors
        self.dim = dim
        doc_tokens = [tokenize(c.text) for c in chunks]
        self.df = Counter(term for terms in doc_tokens for term in set(terms))
        self.n = len(chunks)
        doc_vectors = [self.embed(terms) for terms in doc_tokens]
        self.known = np.array([v is not None for v in doc_vectors])
        self.matrix = np.array([v if v is not None else np.zeros(dim, dtype=np.float32) for v in doc_vectors])
        self.matrix = self.matrix.astype(np.float64)
        self.norms = np.linalg.norm(self.matrix, axis=1)

    def idf(self, term: str) -> float:
        n = self.df[term]
        return math.log(1 + (self.n - n + 0.5) / (n + 0.5))

    def embed(self, terms: list[str]) -> Vector | None:
        out = np.zeros(self.dim, dtype=np.float32)
        total = 0.0
        for term in terms:
            v = self.vectors.get(term)
            if v is None:
                continue
            w = self.idf(term)
            out += np.asarray(v, dtype=np.float64) * w
            total += w
        if total == 0:
            return None
        out /= total
        return out

    def search(self, query: str, k: int) -> list[str]:
        q = self.embed(tokenize(query))
        if q is None:
            return []
        q64 = q.astype(np.float64)
        denominator = self.norms * float(np.linalg.norm(q64))
        with np.errstate(divide='ignore', invalid='ignore'):
            scores = np.where(self.known & (denominator > 0), (self.matrix @ q64) / denominator, -1.0)
        order: list[int] = np.argsort(-scores, kind='stable').tolist()
        return [self.ids[i] for i in order if scores[i] > 0][:k]
