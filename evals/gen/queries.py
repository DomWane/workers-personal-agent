import os
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, TypedDict

from lib.corpus import CORPUS, Chunk
from lib.env import require_env
from lib.http import dig, post_json
from lib.jsonl import append_json_line, read_json_lines
from lib.leakage import build_idf, leakage_score
from lib.paths import DATA

LEAKAGE_MAX = 0.25
TARGET = 150
ATTEMPTS = 3
OUT = DATA / 'retrieval.candidates.jsonl'

PROMPT = ' '.join(
    [
        'Níže je úryvek konverzace. Napiš JEDINOU otázku v češtině, kterou by o tomhle tématu',
        'položil člověk po několika měsících — pamatuje si jen téma, ne detaily.',
        'NESMÍŠ použít odborné termíny, názvy nástrojů ani identifikátory z textu.',
        'Odpověz pouze tou otázkou, bez uvozovek a bez vysvětlení.',
    ]
)


class Candidate(TypedDict):
    chunkId: str
    query: str
    leakage: float


def sample(chunks: list[Chunk], n: int) -> list[Chunk]:
    by_project: defaultdict[str, list[Chunk]] = defaultdict(list)
    for c in chunks:
        by_project[c.project].append(c)
    for group in by_project.values():
        group.sort(key=lambda c: c.ts)
    out: list[Chunk] = []
    keys = list(by_project)
    i = 0
    while len(out) < n and keys:
        key = keys[i % len(keys)]
        group = by_project[key]
        if not group:
            keys.pop(i % len(keys))
            continue
        out.append(group.pop(len(group) // 2))
        i += 1
    return out


def load_done_chunk_ids(path: Path) -> set[str]:
    return {c['chunkId'] for c in read_json_lines(path)}


def select_todo(chunks: list[Chunk], done: set[str]) -> list[Chunk]:
    return [c for c in chunks if c.id not in done]


def generate(chunk: Chunk, key: str, model: str) -> str:
    data = post_json(
        'https://openrouter.ai/api/v1/chat/completions',
        {
            'model': model,
            'messages': [
                {'role': 'system', 'content': PROMPT},
                {'role': 'user', 'content': chunk.text[:1500]},
            ],
            'temperature': 0.7,
            'max_tokens': 1200,
        },
        key,
    )
    text: str = (dig(data, 'choices', 0, 'message', 'content') or '').strip().strip('"\'')
    if not text:
        finish_reason = dig(data, 'choices', 0, 'finish_reason') or 'unknown'
        raise RuntimeError(f'empty completion (finish_reason: {finish_reason})')
    return text


Status = Literal['written', 'exhausted', 'error']


@dataclass(frozen=True, slots=True)
class Outcome:
    status: Status
    candidate: Candidate | None = None
    leakage_rejections: int = 0


def process_chunk(
    chunk: Chunk,
    idf: dict[str, float],
    generate_fn: Callable[[Chunk], str],
    attempts: int = ATTEMPTS,
    leakage_max: float = LEAKAGE_MAX,
) -> Outcome:
    rejections = 0
    for _ in range(attempts):
        try:
            query = generate_fn(chunk)
        except Exception:
            return Outcome('error', leakage_rejections=rejections)
        if not query.strip():
            rejections += 1
            continue
        leakage = leakage_score(query, chunk.text, idf)
        if leakage <= leakage_max:
            candidate: Candidate = {'chunkId': chunk.id, 'query': query, 'leakage': leakage}
            return Outcome('written', candidate, rejections)
        rejections += 1
    return Outcome('exhausted', leakage_rejections=rejections)


def main() -> None:
    [key] = require_env('LLM_API_KEY')
    model = os.environ.get('EVAL_GEN_MODEL', 'deepseek/deepseek-v4-flash')
    chunks = [Chunk(**c) for c in read_json_lines(CORPUS, required=True)]
    idf = build_idf(chunks)
    picked = sample(chunks, TARGET)
    done = load_done_chunk_ids(OUT)
    todo = select_todo(picked, done)
    if done:
        print(f'resuming: {len(done)} candidates already in {OUT}, {len(todo)} chunks left')

    written = exhausted = api_errors = leakage_rejections = 0
    for i, chunk in enumerate(todo, start=1):
        result = process_chunk(chunk, idf, lambda c: generate(c, key, model))
        leakage_rejections += result.leakage_rejections
        if result.status == 'written':
            append_json_line(OUT, result.candidate)
            written += 1
        elif result.status == 'exhausted':
            exhausted += 1
        else:
            api_errors += 1
        if i % 20 == 0:
            print(
                f'{i}/{len(todo)} (written {written}, leakage-rejected attempts {leakage_rejections}, '
                f'exhausted {exhausted}, errors {api_errors})'
            )

    print(
        f'candidates written this run: {written} | leakage-rejected attempts: {leakage_rejections} | '
        f'chunks skipped after exhausting attempts: {exhausted} | chunks lost to API errors: {api_errors}'
    )


if __name__ == '__main__':
    main()
