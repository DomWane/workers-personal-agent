import hashlib
import os
from collections.abc import Iterable
from dataclasses import dataclass
from typing import NotRequired, Protocol, TypedDict

CORPUS = os.environ.get('EVAL_CORPUS', 'evals/data/corpus.jsonl')


@dataclass(frozen=True, slots=True)
class Chunk:
    id: str
    text: str
    session: str
    ts: str
    project: str


class EmbeddingsIndex(TypedDict):
    dim: int
    ids: list[str]
    textHash: NotRequired[str]
    maxChars: NotRequired[int]
    chunkChars: NotRequired[int]
    chunkOverlap: NotRequired[int]


class HasText(Protocol):
    @property
    def text(self) -> str: ...


def corpus_text_hash(chunks: Iterable[HasText]) -> str:
    h = hashlib.sha256()
    for chunk in chunks:
        encoded = chunk.text.encode('utf-8')
        h.update(f'{len(encoded)}\n'.encode())
        h.update(encoded)
    return h.hexdigest()
