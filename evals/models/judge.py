import os
from typing import NamedTuple, TypedDict

from lib.jsonl import append_json_line, read_json_lines
from lib.metrics import mulberry32
from lib.paths import DATA
from models.compare import Run

SET = 'bulk' if os.environ.get('EVAL_SET') == 'bulk' else 'hard'
RUN_TAG = os.environ.get('EVAL_RUN_TAG', 'hfe')
RUNS = DATA / f'model-runs.{RUN_TAG}.{SET}.jsonl'
PASS = os.environ.get('EVAL_JUDGE_PASS', 'blind')
OUT = DATA / f'model-preferences.{RUN_TAG}.{SET}.{PASS}.jsonl'


class Pair(NamedTuple):
    query: str
    left: Run
    right: Run
    left_is_first_model: bool


class Preference(TypedDict):
    query: str
    winner: str


def build_pairs(runs: list[Run], seed: int = 1) -> list[Pair]:
    rand = mulberry32(seed)
    by_query: dict[str, list[Run]] = {}
    for r in runs:
        seen = by_query.setdefault(r['query'], [])
        if not any(s['model'] == r['model'] for s in seen):
            seen.append(r)
    out: list[Pair] = []
    for query, pair in by_query.items():
        if len(pair) != 2 or not pair[0]['answer'].strip() or not pair[1]['answer'].strip():
            continue
        flip = rand() < 0.5
        out.append(Pair(query, pair[1] if flip else pair[0], pair[0] if flip else pair[1], not flip))
    return out


def main() -> None:
    runs: list[Run] = read_json_lines(RUNS, required=True)
    judged = {p['query'] for p in read_json_lines(OUT)}
    pairs = [p for p in build_pairs(runs) if p.query not in judged]

    print(f'{len(pairs)} dvojic k posouzení. Nevíš, který model je vlevo — je to schválně.')
    print('Ptej se: která odpověď je věcně lepší? Ne která je delší nebo hezčí.\n')

    done = 0
    for p in pairs:
        print(f'\n──── {done + 1}/{len(pairs)} ────')
        print(f'OTÁZKA: {p.query}')
        print(f'\n{"═" * 70}\nA:\n{p.left["answer"]}')
        print(f'\n{"═" * 70}\nB:\n{p.right["answer"]}\n{"═" * 70}')
        ans = input('lepší? [a] / [b] / [t]ie / [q]uit > ').strip().lower()
        if ans == 'q':
            break
        winner = p.left['model'] if ans == 'a' else p.right['model'] if ans == 'b' else 'tie'
        row: Preference = {'query': p.query, 'winner': winner}
        append_json_line(OUT, row)
        done += 1

    print(f'\nposouzeno {done}/{len(pairs)}, zapsáno do {OUT}')
    print('analýzu spusť až po dokončení — viz thinkingcap-preregistration.md')


if __name__ == '__main__':
    main()
