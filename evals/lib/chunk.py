import os
from collections.abc import Mapping, Sequence
from typing import NamedTuple, Protocol


class ChunkConfig(NamedTuple):
    chars: int
    overlap: int


def parent_of(id: str) -> str:
    return id.split('#', 1)[0]


def chunk_config_from_env(env: Mapping[str, str] = os.environ) -> ChunkConfig | None:
    chars = _int_or_none(env.get('EVAL_CHUNK_CHARS'))
    if chars is None or chars <= 0:
        return None
    raw_overlap = env.get('EVAL_CHUNK_OVERLAP')
    overlap = 200 if raw_overlap is None else _int_or_none(raw_overlap)
    if overlap is None or overlap < 0 or overlap >= chars:
        raise ValueError(
            f'EVAL_CHUNK_OVERLAP must be >= 0 and < EVAL_CHUNK_CHARS ({chars}), got {raw_overlap}'
        )
    return ChunkConfig(chars, overlap)


def _int_or_none(raw: str | None) -> int | None:
    try:
        return int(raw) if raw is not None else None
    except ValueError:
        return None


def split_text(text: str, cfg: ChunkConfig) -> list[str]:
    if len(text) <= cfg.chars:
        return [text]
    step = cfg.chars - cfg.overlap
    out: list[str] = []
    for start in range(0, len(text), step):
        out.append(text[start : start + cfg.chars])
        if start + cfg.chars >= len(text):
            break
    return out


class HasIdText(Protocol):
    @property
    def id(self) -> str: ...

    @property
    def text(self) -> str: ...


class Piece(NamedTuple):
    id: str
    text: str


def expand_chunks(chunks: Sequence[HasIdText], cfg: ChunkConfig | None) -> Sequence[HasIdText]:
    if cfg is None:
        return chunks
    return [Piece(f'{c.id}#{ord}', text) for c in chunks for ord, text in enumerate(split_text(c.text, cfg))]
