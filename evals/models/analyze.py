import math
import os
from typing import NamedTuple

from lib.env import require_env
from lib.jsonl import read_json_lines
from lib.metrics import mulberry32
from lib.paths import DATA
from models.compare import Run, run_key
from models.judge import Preference
from run_retrieval import Labelled

SET = 'bulk' if os.environ.get('EVAL_SET') == 'bulk' else 'hard'
RUN_TAG = os.environ.get('EVAL_RUN_TAG', 'hfe')
RUNS = DATA / f'model-runs.{RUN_TAG}.{SET}.jsonl'
PASS = os.environ.get('EVAL_JUDGE_PASS', 'blind')
PREFS = DATA / f'model-preferences.{RUN_TAG}.{SET}.{PASS}.jsonl'


def first_per_pair(runs: list[Run]) -> list[Run]:
    seen: set[str] = set()
    out: list[Run] = []
    for r in runs:
        k = run_key(r['model'], r['query'])
        if k not in seen:
            seen.add(k)
            out.append(r)
    return out


def by_seed_group(runs: list[Run]) -> dict[str, list[Run]]:
    by_pair: dict[str, list[Run]] = {}
    for r in runs:
        by_pair.setdefault(run_key(r['model'], r['query']), []).append(r)
    return by_pair


def repeat_spreads(runs: list[Run]) -> list[float]:
    out: list[float] = []
    for rs in by_seed_group(runs).values():
        if len(rs) < 2:
            continue
        lens = [r['reasoningChars'] for r in rs]
        if max(lens) > 0:
            out.append((max(lens) - min(lens)) / max(lens))
    return out


def median(xs: list[float]) -> float:
    if not xs:
        return math.nan
    s = sorted(xs)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


def median_across_seeds(runs: list[Run]) -> list[Run]:
    out: list[Run] = []
    for rs in by_seed_group(runs).values():
        tokens = [r['completionTokens'] if r['completionTokens'] is not None else math.nan for r in rs]
        merged: Run = {
            **rs[0],
            'reasoningChars': int(median([r['reasoningChars'] for r in rs])),
            'completionTokens': int(median(tokens)) if not math.isnan(median(tokens)) else None,
        }
        out.append(merged)
    return out


def bootstrap_median(values: list[float], seed: int = 7, rounds: int = 10_000) -> tuple[float, float]:
    if not values:
        return math.nan, math.nan
    rand = mulberry32(seed)
    n = len(values)
    medians = sorted(median([values[math.floor(rand() * n)] for _ in range(n)]) for _ in range(rounds))
    return medians[math.floor(rounds * 0.025)], medians[math.floor(rounds * 0.975)]


def wilson(successes: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return math.nan, math.nan
    p = successes / n
    d = 1 + z * z / n
    centre = p + z * z / (2 * n)
    spread = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (centre - spread) / d, (centre + spread) / d


class Paired(NamedTuple):
    query: str
    base: Run
    tuned: Run
    has_relevant_context: bool


def pct(x: float) -> str:
    return f'{x * 100:.1f}%'


def interval(lo: float, hi: float) -> str:
    return f'[{pct(lo)}, {pct(hi)}]'


def pair_up(runs: list[Run], base_model: str, tuned_model: str, labels: list[Labelled]) -> list[Paired]:
    relevant_by_query = {label['query']: set(label['relevant']) for label in labels}
    pairs: list[Paired] = []
    for query in dict.fromkeys(r['query'] for r in runs):
        base = next((r for r in runs if r['query'] == query and r['model'] == base_model), None)
        tuned = next((r for r in runs if r['query'] == query and r['model'] == tuned_model), None)
        if base is None or tuned is None:
            continue
        rel = relevant_by_query.get(query, set())
        pairs.append(Paired(query, base, tuned, any(id in rel for id in base['contextIds'])))
    return pairs


def report_lengths(pairs: list[Paired], all_runs: list[Run]) -> None:
    char_red = [
        (p.base['reasoningChars'] - p.tuned['reasoningChars']) / p.base['reasoningChars'] for p in pairs
    ]
    c_lo, c_hi = bootstrap_median(char_red)
    print('## Primární metrika — délka uvažovací stopy (znaky)')
    print(f'base medián    {median([p.base["reasoningChars"] for p in pairs]):.0f} zn')
    print(f'tuned medián   {median([p.tuned["reasoningChars"] for p in pairs]):.0f} zn')
    print(f'úspora mediánu {pct(median(char_red))}  95% CI {interval(c_lo, c_hi)}')
    print(f'kratší stopa u {sum(1 for x in char_red if x > 0)}/{len(pairs)} otázek')

    spreads = repeat_spreads(all_runs)
    print(f'\npodlaha šumu (rozptyl mezi seedy): medián {pct(median(spreads))}, n = {len(spreads)}')
    if median(char_red) <= median(spreads):
        print('POZOR: úspora nepřesahuje podlahu šumu — viz dodatek 6a.')

    with_tokens = [p for p in pairs if p.base['completionTokens'] and p.tuned['completionTokens']]
    tok_red = [
        (p.base['completionTokens'] - p.tuned['completionTokens']) / p.base['completionTokens']
        for p in with_tokens
        if p.base['completionTokens'] is not None and p.tuned['completionTokens'] is not None
    ]
    t_lo, t_hi = bootstrap_median(tok_red, 11)
    print('\n## Sekundární — completion tokeny')
    print(f'base medián    {median([tokens_or_nan(p.base) for p in pairs]):.0f}')
    print(f'tuned medián   {median([tokens_or_nan(p.tuned) for p in pairs]):.0f}')
    print(f'úspora mediánu {pct(median(tok_red))}  95% CI {interval(t_lo, t_hi)}')

    untrustworthy = sum(
        1
        for r in (run for p in pairs for run in (p.base, p.tuned))
        if r['reasoningTokens'] is None or (r['reasoningTokens'] == 0 and r['reasoningChars'] > 0)
    )
    print(f'\nreasoning_tokens nedůvěryhodné u {untrustworthy}/{len(pairs) * 2} běhů — vyloučeno (dodatek 3)')


def report_quality(pairs: list[Paired], prefs: list[Preference], base_model: str, tuned_model: str) -> None:
    print('\n## Kvalita — slepé párové posouzení')
    winner_of = {p['query']: p['winner'] for p in prefs}
    judged = [(p, winner_of[p.query]) for p in pairs if p.query in winner_of]
    ties = sum(1 for _, w in judged if w == 'tie')
    base_wins = sum(1 for _, w in judged if w == base_model)
    tuned_wins = sum(1 for _, w in judged if w == tuned_model)
    decided = base_wins + tuned_wins
    p_lo, p_hi = wilson(base_wins, decided)
    print(f'posouzeno {len(judged)}, remíz {ties}, rozhodnutých {decided}')
    print(f'base {base_wins} : {tuned_wins} tuned')
    share = pct(base_wins / decided) if decided else '—'
    print(f'podíl pro base {share}  95% CI {interval(p_lo, p_hi)}')
    if p_lo <= 0.5 <= p_hi:
        caveat = '' if decided >= 20 else f', ale {decided} rozhodnutých dvojic ho neumí odhalit'
        print(f'→ interval obsahuje 0.5 — rozdíl neprokázán{caveat}')
    else:
        print('→ interval míjí 0.5 — rozdíl v kvalitě')

    print('\n## Rozpad podle toho, jestli kontext vůbec obsahoval odpověď')
    for with_ctx in (True, False):
        group = [(p, w) for p, w in judged if p.has_relevant_context == with_ctx]
        t = sum(1 for _, w in group if w == 'tie')
        b = sum(1 for _, w in group if w == base_model)
        u = sum(1 for _, w in group if w == tuned_model)
        name = 's relevantním kontextem ' if with_ctx else 'bez relevantního      '
        print(f'{name} n={len(group)}  base {b} : {u} tuned, remíz {t}')

    print('\n## Kontrola sleposti — šel verdikt za délkou odpovědi?')
    decided_pairs = [(p, w) for p, w in judged if w != 'tie']
    longer_won = sum(
        1
        for p, w in decided_pairs
        if len((p.base if w == base_model else p.tuned)['answer'])
        > len((p.tuned if w == base_model else p.base)['answer'])
    )
    l_lo, l_hi = wilson(longer_won, len(decided_pairs))
    print(f'delší odpověď vyhrála {longer_won}/{len(decided_pairs)}  95% CI {interval(l_lo, l_hi)}')
    verdict = (
        'nerozlišitelné od náhody — délka verdikt neřídila'
        if l_lo <= 0.5 <= l_hi
        else 'délka s verdiktem koreluje — nahlásit jako limit'
    )
    print(f'→ {verdict}')


def main() -> None:
    base_model, tuned_model = require_env('BASE_MODEL', 'TUNED_MODEL')
    all_runs: list[Run] = read_json_lines(RUNS, required=True)
    prefs: list[Preference] = read_json_lines(PREFS, required=True)
    labels: list[Labelled] = read_json_lines(DATA / 'retrieval.labels.jsonl', required=True)
    pairs = pair_up(median_across_seeds(all_runs), base_model, tuned_model, labels)
    print(f'{SET} set — n = {len(pairs)} otázek, oba modely, byte-identický vstup\n')
    report_lengths(pairs, all_runs)
    report_quality(pairs, prefs, base_model, tuned_model)


def tokens_or_nan(run: Run) -> float:
    return run['completionTokens'] if run['completionTokens'] is not None else math.nan


if __name__ == '__main__':
    main()
