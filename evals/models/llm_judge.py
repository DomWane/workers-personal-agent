import os
import re
from typing import TypedDict

from lib.env import require_env
from lib.http import HttpError, dig, post_json
from lib.jsonl import append_json_line, read_json_lines
from lib.paths import DATA
from models.compare import Run
from models.judge import Pair, build_pairs

RUN_TAG = os.environ.get('EVAL_RUN_TAG', 'hfe')
SET = 'bulk' if os.environ.get('EVAL_SET') == 'bulk' else 'hard'
RUNS = DATA / f'model-runs.{RUN_TAG}.{SET}.jsonl'
OUT = DATA / f'model-preferences.{RUN_TAG}.{SET}.llm.jsonl'

SYSTEM = ' '.join(
    [
        'Porovnáváš dvě odpovědi na stejnou otázku, obě psané jen z přiložených úryvků.',
        'Rozhoduj se podle věcné správnosti vůči úryvkům, ne podle délky, tónu ani jistoty.',
        'Odpověď, která si vymýšlí nebo tvrdí víc, než v úryvcích je,',
        'je horší než ta, která přizná, že to tam není.',
        'Odpověz jediným slovem: A, B, nebo tie.',
    ]
)
NON_LETTERS = re.compile(r'[^a-z]')


class LlmVerdict(TypedDict):
    query: str
    firstShown: str
    winner: str
    raw: str


def build_prompt(pair: Pair, flipped: bool) -> str:
    a, b = (pair.right, pair.left) if flipped else (pair.left, pair.right)
    return '\n'.join(
        [f'OTÁZKA: {pair.query}', '', f'ODPOVĚĎ A:\n{a["answer"]}', '', f'ODPOVĚĎ B:\n{b["answer"]}']
    )


def last_line(raw: str) -> str:
    lines = [line for line in raw.strip().split('\n') if line.strip()]
    return lines[-1] if lines else ''


def parse_verdict(raw: str, first: Run, second: Run) -> str:
    v = NON_LETTERS.sub('', last_line(raw).lower())
    if v == 'a':
        return first['model']
    if v == 'b':
        return second['model']
    return 'tie'


def ask(prompt: str, model: str, api_base: str, api_key: str) -> str:
    try:
        data = post_json(
            f'{api_base.rstrip("/")}/chat/completions',
            {
                'model': model,
                'temperature': 0,
                'max_tokens': int(os.environ.get('JUDGE_MAX_TOKENS', '2000')),
                'reasoning': {'effort': 'low'},
                'messages': [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': prompt}],
            },
            api_key,
        )
    except HttpError as err:
        raise RuntimeError(f'judge {err.status}: {err.body[:300]}') from err
    content = dig(data, 'choices', 0, 'message', 'content')
    return content if isinstance(content, str) else ''


def main() -> None:
    model, api_base, api_key = require_env('JUDGE_MODEL', 'JUDGE_API_BASE', 'JUDGE_API_KEY')
    runs: list[Run] = read_json_lines(RUNS, required=True)
    pairs = build_pairs(runs)
    existing: list[LlmVerdict] = read_json_lines(OUT)
    done = {f'{v["query"]}\0{v["firstShown"]}' for v in existing}

    judged = unparsed = 0
    for pair in pairs:
        for flipped in (False, True):
            first, second = (pair.right, pair.left) if flipped else (pair.left, pair.right)
            if f'{pair.query}\0{first["model"]}' in done:
                continue
            raw = ask(build_prompt(pair, flipped), model, api_base, api_key)
            winner = parse_verdict(raw, first, second)
            if winner == 'tie' and last_line(raw).strip().lower() != 'tie':
                unparsed += 1
            row: LlmVerdict = {
                'query': pair.query,
                'firstShown': first['model'],
                'winner': winner,
                'raw': raw,
            }
            append_json_line(OUT, row)
            judged += 1

    verdicts: list[LlmVerdict] = read_json_lines(OUT)
    by_query: dict[str, list[str]] = {}
    for v in verdicts:
        by_query.setdefault(v['query'], []).append(v['winner'])
    flips = sum(1 for ws in by_query.values() if len(ws) == 2 and ws[0] != ws[1])
    print(f'{judged} nových posudků zapsáno do {OUT}')
    print(f'nekonzistentních při otočení stran: {flips}/{len(by_query)}')
    if unparsed:
        print(
            f'POZOR: {unparsed} odpovědí nešlo přečíst jako verdikt a spadlo na remízu — zkontroluj pole raw.'
        )
    print('Pozor: tohle není výsledek. Nejdřív změř shodu se slepým lidským průchodem.')


if __name__ == '__main__':
    main()
