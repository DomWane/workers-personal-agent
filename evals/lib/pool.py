import math
from collections import defaultdict
from collections.abc import Sequence
from typing import NamedTuple, Protocol

from lib.metrics import mulberry32
from retrievers.keyword import Retriever


class PoolItem(NamedTuple):
    query: str
    chunk_id: str


class Labelled(Protocol):
    @property
    def query(self) -> str: ...

    @property
    def relevant(self) -> Sequence[str]: ...


def build_pool(
    labels: Sequence[Labelled], retrievers: Sequence[Retriever], depth: int, judged: set[str]
) -> list[PoolItem]:
    out: list[PoolItem] = []
    for label in labels:
        seen = set(label.relevant)
        for r in retrievers:
            for chunk_id in r.search(label.query, depth):
                if chunk_id in seen or key(label.query, chunk_id) in judged:
                    continue
                seen.add(chunk_id)
                out.append(PoolItem(label.query, chunk_id))
    return out


def key(query: str, chunk_id: str) -> str:
    return f'{query} {chunk_id}'


def shuffle_within_query(items: list[PoolItem], seed: int = 1) -> list[PoolItem]:
    rand = mulberry32(seed)
    by_query: defaultdict[str, list[PoolItem]] = defaultdict(list)
    for item in items:
        by_query[item.query].append(item)
    out: list[PoolItem] = []
    for group in by_query.values():
        for i in range(len(group) - 1, 0, -1):
            j = math.floor(rand() * (i + 1))
            group[i], group[j] = group[j], group[i]
        out.extend(group)
    return out
