from typing import NamedTuple

from lib.corpus import Chunk
from lib.tokenize import tokenize


def similarity(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0
    shared = len(a & b)
    return shared / (len(a) + len(b) - shared)


class Neighbour(NamedTuple):
    chunk: Chunk
    score: float


def neighbours_of(target: Chunk, chunks: list[Chunk], limit: int = 5) -> list[Neighbour]:
    mine = set(tokenize(target.text))
    scored = [Neighbour(c, similarity(mine, set(tokenize(c.text)))) for c in chunks if c.id != target.id]
    hits = [n for n in scored if n.score > 0]
    hits.sort(key=lambda n: n.score, reverse=True)
    return hits[:limit]


def pick_neighbours(answer: str, neighbours: list[Neighbour]) -> list[str]:
    picked: list[str] = []
    for part in answer.split(','):
        try:
            n = int(part.strip())
        except ValueError:
            continue
        if 1 <= n <= len(neighbours):
            picked.append(neighbours[n - 1].chunk.id)
    return picked
