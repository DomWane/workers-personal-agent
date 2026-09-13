import math
import os

from lib.jsonl import read_json_lines
from lib.paths import DATA
from models.judge import Preference
from models.llm_judge import LlmVerdict

RUN_TAG = os.environ.get('EVAL_RUN_TAG', 'hfe')
SET = 'bulk' if os.environ.get('EVAL_SET') == 'bulk' else 'hard'
HUMAN = DATA / f'model-preferences.{RUN_TAG}.{SET}.blind.jsonl'
LLM = DATA / f'model-preferences.{RUN_TAG}.{SET}.llm.jsonl'


def cohen_kappa(a: list[str], b: list[str]) -> float:
    if not a or len(a) != len(b):
        return math.nan
    labels = set(a) | set(b)
    observed = sum(1 for x, y in zip(a, b, strict=True) if x == y) / len(a)
    expected = sum((a.count(label) / len(a)) * (b.count(label) / len(b)) for label in labels)
    return math.nan if expected == 1 else (observed - expected) / (1 - expected)


def collapse_orders(verdicts: list[LlmVerdict]) -> dict[str, str]:
    by_query: dict[str, list[str]] = {}
    for v in verdicts:
        by_query.setdefault(v['query'], []).append(v['winner'])
    return {query: winners[0] if len(set(winners)) == 1 else 'tie' for query, winners in by_query.items()}


def main() -> None:
    human: list[Preference] = read_json_lines(HUMAN, required=True)
    raw: list[LlmVerdict] = read_json_lines(LLM, required=True)
    llm = collapse_orders(raw)

    shared = [h for h in human if h['query'] in llm]
    hv = [h['winner'] for h in shared]
    lv = [llm[h['query']] for h in shared]
    agreed = sum(1 for x, y in zip(hv, lv, strict=True) if x == y)
    print(f'{SET} set — {len(shared)} otázek posouzených oběma')
    print(f'hrubá shoda   {agreed / len(shared) * 100:.1f}%  ({agreed}/{len(shared)})')
    print(f'Cohenovo κ    {cohen_kappa(hv, lv):.3f}')

    by_query: dict[str, list[str]] = {}
    for v in raw:
        by_query.setdefault(v['query'], []).append(v['winner'])
    flipped = sum(1 for ws in by_query.values() if len(ws) == 2 and ws[0] != ws[1])
    print(f'otočení stran změnilo verdikt u {flipped}/{len(by_query)} otázek')

    print('\n## Kde se rozcházejí')
    for h, human_winner, llm_winner in zip(shared, hv, lv, strict=True):
        if human_winner != llm_winner:
            print(f'  člověk {human_winner:<12} judge {llm_winner:<12} {h["query"][:60]}')


if __name__ == '__main__':
    main()
