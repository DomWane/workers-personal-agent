from typing import Protocol

from lib.corpus import Chunk
from lib.tokenize import tokenize


class Retriever(Protocol):
    @property
    def name(self) -> str: ...

    def search(self, query: str, k: int) -> list[str]: ...


class KeywordRetriever:
    name = 'keyword'

    def __init__(self, chunks: list[Chunk]) -> None:
        self.folded = [(c.id, ' '.join(tokenize(c.text))) for c in chunks]

    def search(self, query: str, k: int) -> list[str]:
        terms = tokenize(query)
        if not terms:
            return []
        scored = [(id, sum(1 for t in terms if t in hay)) for id, hay in self.folded]
        hits = [(id, n) for id, n in scored if n > 0]
        hits.sort(key=lambda pair: pair[1], reverse=True)
        return [id for id, _ in hits[:k]]
