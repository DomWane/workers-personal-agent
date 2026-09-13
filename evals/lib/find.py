import re
import unicodedata
from dataclasses import dataclass

from lib.corpus import Chunk

COMBINING_MARKS = re.compile(r'[̀-ͯ]')
WHITESPACE = re.compile(r'\s+')
PROJECT_COMMAND = re.compile(r'^/(?:projekt|project)\s+(.+)$', re.IGNORECASE)


def fold(s: str) -> str:
    return COMBINING_MARKS.sub('', unicodedata.normalize('NFD', s)).lower()


@dataclass(frozen=True, slots=True)
class Terms:
    terms: list[str]


@dataclass(frozen=True, slots=True)
class Period:
    prefix: str


@dataclass(frozen=True, slots=True)
class Project:
    name: str


@dataclass(frozen=True, slots=True)
class GiveUp:
    pass


SearchMode = Terms | Period | Project | GiveUp


def parse_search(raw: str) -> SearchMode:
    s = raw.strip()
    if s in ('', '.'):
        return GiveUp()
    project = PROJECT_COMMAND.match(s)
    if project:
        return Project(project.group(1).strip())
    if s.startswith('/'):
        return Period(s[1:].strip())
    return Terms(s.split())


def find_by_terms(chunks: list[Chunk], terms: list[str]) -> list[Chunk]:
    needles = [n for n in (fold(t) for t in terms) if n]
    if not needles:
        return []
    return by_time([c for c in chunks if all(n in fold(f'{c.text} {c.project}') for n in needles)])


def find_by_period(chunks: list[Chunk], prefix: str) -> list[Chunk]:
    if not prefix:
        return []
    return by_time([c for c in chunks if c.ts.startswith(prefix)])


def find_by_project(chunks: list[Chunk], name: str) -> list[Chunk]:
    needle = fold(name)
    if not needle:
        return []
    return by_time([c for c in chunks if needle in fold(c.project)])


def by_time(chunks: list[Chunk]) -> list[Chunk]:
    return sorted(chunks, key=lambda c: c.ts or '￿')


def reply_preview(text: str, width: int = 220) -> str:
    parts = text.split('\n\n')
    if len(parts) == 1:
        return cut(text, width)
    return f'{cut(parts[0], 45)} → {cut(" ".join(parts[1:]), width)}'


def cut(s: str, n: int) -> str:
    flat = WHITESPACE.sub(' ', s).strip()
    return f'{flat[:n]}…' if len(flat) > n else flat


def preview(text: str, terms: list[str], width: int = 220) -> str:
    flat = WHITESPACE.sub(' ', text)
    hay = fold(flat)
    hits = [i for i in (hay.find(fold(t)) for t in terms) if i >= 0]
    at = min(hits) if hits else 0
    start = max(0, at - width // 3)
    body = flat[start : start + width]
    head = '…' if start > 0 else ''
    tail = '…' if start + width < len(flat) else ''
    return f'{head}{body}{tail}'
