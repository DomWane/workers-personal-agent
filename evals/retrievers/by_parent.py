from lib.chunk import parent_of
from retrievers.keyword import Retriever


class ByParent:
    def __init__(self, inner: Retriever, depth: int, name: str | None = None) -> None:
        self.inner = inner
        self.depth = depth
        self.name = name or inner.name

    def search(self, query: str, k: int) -> list[str]:
        seen: dict[str, None] = {}
        for id in self.inner.search(query, self.depth):
            seen[parent_of(id)] = None
            if len(seen) == k:
                break
        return list(seen)
