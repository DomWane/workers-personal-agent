import math
from collections import Counter

from lib.corpus import Chunk
from lib.tokenize import tokenize


def build_idf(chunks: list[Chunk]) -> dict[str, float]:
    df = Counter(term for c in chunks for term in set(tokenize(c.text)))
    n = len(chunks) or 1
    return {term: math.log(n / count) for term, count in df.items()}


def leakage_score(query: str, chunk: str, idf: dict[str, float]) -> float:
    q_terms = set(tokenize(query))
    shared = 0.0
    total = 0.0
    for term in set(tokenize(chunk)):
        w = idf.get(term, 0.0)
        total += w
        if term in q_terms:
            shared += w
    return 0 if total == 0 else shared / total
