from typing import TypedDict


class RerankRow(TypedDict):
    query: str
    candidateHash: str
    ranked: list[str]
    scores: list[float]
    depth: int
    maxChars: int


class RerankRetriever:
    def __init__(self, rows: list[RerankRow], name: str = 'rerank') -> None:
        self.name = name
        self.by_query = {r['query']: r['ranked'] for r in rows}

    def search(self, query: str, k: int) -> list[str]:
        ranked = self.by_query.get(query)
        if ranked is None:
            raise LookupError(f'no reranked order for query: {query[:60]} — rerun eval:rerank')
        return ranked[:k]
