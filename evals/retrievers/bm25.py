import math
from collections import Counter
from collections.abc import Callable

from lib.corpus import Chunk
from lib.tokenize import tokenize

Tokenizer = Callable[[str], list[str]]

K1 = 1.2
B = 0.75


class BM25Retriever:
    def __init__(self, chunks: list[Chunk], name: str = 'bm25', tokenizer: Tokenizer = tokenize) -> None:
        self.name = name
        self.tokenizer = tokenizer
        self.docs = [(c.id, tokenizer(c.text)) for c in chunks]
        self.avg_len = sum(len(terms) for _, terms in self.docs) / (len(self.docs) or 1)
        self.tf = [Counter(terms) for _, terms in self.docs]
        self.df = Counter(term for counts in self.tf for term in counts)
        self.n = len(self.docs)

    def search(self, query: str, k: int) -> list[str]:
        terms = self.tokenizer(query)
        scored: list[tuple[str, float]] = []
        for i, (id, doc_terms) in enumerate(self.docs):
            score = 0.0
            for term in terms:
                f = self.tf[i][term]
                if not f:
                    continue
                n = self.df[term]
                idf = math.log(1 + (self.n - n + 0.5) / (n + 0.5))
                norm = f + K1 * (1 - B + (B * len(doc_terms)) / self.avg_len)
                score += idf * ((f * (K1 + 1)) / norm)
            scored.append((id, score))
        hits = [(id, score) for id, score in scored if score > 0]
        ranked = sorted(hits, key=lambda pair: pair[1], reverse=True)
        return [id for id, _ in ranked[:k]]
