import re
from typing import Literal

from gen.queries import Candidate
from lib.corpus import CORPUS, Chunk
from lib.jsonl import read_json_lines
from lib.paths import DATA
from lib.similar import similarity
from lib.tokenize import tokenize

APOSTROPHE = "['" + chr(0x2019) + ']'
SCAFFOLD = re.compile(
    rf'\b(I{APOSTROPHE}ll (look|investigate|check|start|wait|verify|run|dispatch)'
    r'|Let me (first|look|check|start|wait|run)'
    r'|dispatched an agent|waiting for|before (proposing|diagnosing|saying)'
    rf'|I{APOSTROPHE}m in Phase \d'
    r'|Podívám se|Ověřím|Zkontroluju|Počkám)',
    re.IGNORECASE,
)
CONCLUSION = re.compile(
    r'\b(root cause|the (problem|issue|bug|answer|pattern|rule|fix) (is|was)|is clear|turns out'
    r'|in short|so the|therefore|conclusion|fixed|opraveno|hotovo|because|protože|důvod|takže'
    r'|závěr|řešení|výsledek|ukázalo se|zjistil jsem)\b',
    re.IGNORECASE,
)
STATUS = re.compile(
    r'^\s*(hotovo|done|ok|opraveno|nasazeno|deployed|committed|pushed|pr opened|merged|tests? pass|✅)',
    re.IGNORECASE,
)
META = re.compile(
    r'────\s*\d+/\d+\s*────|\[k\]eep / \[d\]rop|leakage \d|labelov|eval:gen|eval:label', re.IGNORECASE
)
CLAIMS_SOURCES = re.compile(r'^\s*(Zdroje|Checked|Sources)\s*:', re.IGNORECASE | re.MULTILINE)
SEARCH_FIXED_AT = '2026-07-29T10:50:57Z'
THIN_CHARS = 300
TWIN_SIMILARITY = 0.15

Flag = Literal['scaffolding', 'status', 'thin', 'meta', 'sourced', 'fabricated-era']

REASON: dict[Flag, str] = {
    'scaffolding': 'chunk jen plánuje, nedojde k závěru',
    'status': 'chunk je hlášení o dokončení, ne znalost',
    'thin': 'chunk je příliš krátký na smysluplný cíl',
    'meta': 'chunk je z ladění evalu, ne trvalá znalost',
    'sourced': 'chunk se odvolává na zdroje — tvrdí něco o vnějším světě, ověř to',
    'fabricated-era': 'chunk cituje zdroje a je z doby před opravou searche — doložená fabrikace',
}


def reply_of(text: str) -> str:
    return '\n\n'.join(text.split('\n\n')[1:])


def flags_for(chunk: Chunk) -> list[Flag]:
    flags: list[Flag] = []
    reply = reply_of(chunk.text)
    if SCAFFOLD.search(reply) and not CONCLUSION.search(reply):
        flags.append('scaffolding')
    if STATUS.search(reply.strip()) and len(reply.strip()) < 200:
        flags.append('status')
    if len(chunk.text) < THIN_CHARS:
        flags.append('thin')
    if META.search(chunk.text):
        flags.append('meta')
    if CLAIMS_SOURCES.search(chunk.text):
        flags.append('fabricated-era' if chunk.ts and chunk.ts < SEARCH_FIXED_AT else 'sourced')
    return flags


def main() -> None:
    chunks = [Chunk(**c) for c in read_json_lines(CORPUS, required=True)]
    candidates: list[Candidate] = read_json_lines(DATA / 'retrieval.candidates.jsonl', required=True)
    by_id = {c.id: c for c in chunks}
    tokens = {c.id: set(tokenize(c.text)) for c in chunks}

    lines = ['# Předfiltr kandidátů', '', 'Flagy jsou návrh, ne rozhodnutí — projdi je a rozhodni sám.', '']
    twin_counts: list[tuple[int, str, int]] = []
    flagged = 0

    for i, cand in enumerate(candidates, start=1):
        chunk = by_id.get(cand['chunkId'])
        if chunk is None:
            continue
        mine = tokens[chunk.id]
        twins = sum(
            1
            for other in chunks
            if other.id != chunk.id and similarity(mine, tokens[other.id]) >= TWIN_SIMILARITY
        )
        twin_counts.append((i, cand['query'], twins))
        flags = flags_for(chunk)
        if not flags:
            continue
        flagged += 1
        lines.append(f'## {i}/{len(candidates)} — {", ".join(flags)}')
        lines.append(f'DOTAZ: {cand["query"]}')
        lines.extend(f'- {REASON[f]}' for f in flags)
        lines.append('')

    top = sorted((t for t in twin_counts if t[2] > 0), key=lambda t: -t[2])[:15]
    if top:
        lines += ['## Nejvíc lexikálně podobných sousedů (jen informace, ne flag)', '']
        lines.append('Vysoké číslo = chunk se v korpusu doslova opakuje. Nízké NEznamená jednoznačný cíl:')
        lines += ['téma řešené víckrát jinými slovy se sem nedostane a musíš ho poznat sám.', '']
        lines.extend(f'- {i}/{len(candidates)} — {twins} podobných — {query}' for i, query, twins in top)
        lines.append('')

    (DATA / 'prescreen.md').write_text('\n'.join(lines), encoding='utf-8')
    print(f'kandidátů: {len(candidates)} | označených: {flagged} | čistých: {len(candidates) - flagged}')
    print(f'report: {DATA / "prescreen.md"} — flagy jsou návrh, rozhoduješ ty')


if __name__ == '__main__':
    main()
