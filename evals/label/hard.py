import re
from collections import Counter
from collections.abc import Callable
from typing import Literal, NamedTuple

from label.retrieval import choose_also_relevant
from lib.corpus import CORPUS, Chunk
from lib.find import (
    GiveUp,
    Period,
    Project,
    Terms,
    find_by_period,
    find_by_project,
    find_by_terms,
    fold,
    parse_search,
    preview,
    reply_preview,
)
from lib.jsonl import append_json_line, read_json_lines
from lib.paths import DATA
from run_retrieval import Labelled

OUT = DATA / 'retrieval.labels.jsonl'
UNMATCHED = DATA / 'hard.unmatched.jsonl'
PAGE = 12
TARGET = 30
WHITESPACE = re.compile(r'\s+')

Via = Literal['search', 'browse']


class Hits(NamedTuple):
    hits: list[Chunk]
    terms: list[str]
    via: Via


def hits_for(raw: str, corpus: list[Chunk]) -> Hits | None:
    mode = parse_search(raw)
    match mode:
        case GiveUp():
            return None
        case Terms(terms):
            return Hits(find_by_terms(corpus, terms), terms, 'search')
        case Period(prefix):
            return Hits(find_by_period(corpus, prefix), [], 'browse')
        case Project(name):
            return Hits(find_by_project(corpus, name), [], 'browse')


def query_key(query: str) -> str:
    return WHITESPACE.sub(' ', fold(query)).strip()


class Located(NamedTuple):
    chunk: Chunk
    via: Via


def show_help(corpus: list[Chunk]) -> None:
    counts = Counter(c.project for c in corpus)
    for project, n in counts.most_common():
        print(f'  /projekt {project} — {n}')
    dates = sorted(c.ts[:10] for c in corpus if c.ts)
    if dates:
        print(f'  /obdobi: {dates[0]} … {dates[-1]} (prefix, např. /2026-07 nebo /2026-07-30)')


def locate(corpus: list[Chunk], ask: Callable[[str], str]) -> Located | None:
    while True:
        raw = ask('  hledat (slova | /2026-07 | /projekt jmeno | /? = nápověda | . = nenašel jsem) > ')
        if raw.strip() == '/?':
            show_help(corpus)
            continue
        found = hits_for(raw, corpus)
        if found is None:
            return None
        hits, terms, via = found
        if not hits:
            print('  nic nenalezeno, zkus jiná slova')
            continue
        page = 0
        while True:
            shown = hits[page * PAGE : page * PAGE + PAGE]
            for i, c in enumerate(shown, start=page * PAGE + 1):
                print(f'  {i:>2}. [{c.ts[:10]}] {c.project}')
                print(f'      {preview(c.text, terms) if terms else reply_preview(c.text)}')
            more = len(hits) - (page * PAGE + len(shown))
            if more > 0:
                print(f'  … a dalších {more} — [+] další stránka')
            answer = ask('  číslo (enter = hledat znovu, . = nenašel jsem) > ').strip()
            if answer == '+' and more > 0:
                page += 1
                continue
            break
        if answer.isdigit() and 1 <= int(answer) <= len(hits):
            chunk = hits[int(answer) - 1]
            print(f'\n{"─" * 70}\n{chunk.text}\n{"─" * 70}')
            if (
                ask('  odpovídá to na dotaz? [a]no / cokoliv jiného = zpět na hledání > ').strip().lower()
                == 'a'
            ):
                return Located(chunk, via)
            continue
        if answer == '.':
            return None


def main() -> None:
    corpus = [Chunk(**c) for c in read_json_lines(CORPUS, required=True)]
    existing: list[Labelled] = read_json_lines(OUT)
    seen = {query_key(label['query']) for label in existing}
    hard = sum(1 for label in existing if label['kind'] == 'hard')

    print('Hard set: dotazy z hlavy, tvými slovy, jako bys je za půl roku poslal agentovi.')
    print('Dotaz napiš DŘÍV, než začneš hledat — po nalezení cíle už ho tenhle skript nepustí měnit,')
    print('protože přepsaný dotaz sklouzne do slov cílového chunku a přestane být těžký.')
    print(f'Cíl je ~{TARGET}. Prázdný dotaz = konec, můžeš pokračovat kdykoliv později.')

    added = unmatched = 0
    while True:
        print(f'\n──── hard hotovo {hard}/{TARGET} ────')
        query = input('dotaz z hlavy (enter = konec) > ').strip()
        if not query:
            break
        if query_key(query) in seen:
            print('  tenhle dotaz už v sadě je, přeskakuju')
            continue
        seen.add(query_key(query))

        found = locate(corpus, input)
        if found is None:
            append_json_line(UNMATCHED, {'query': query})
            print(f'  uloženo do {UNMATCHED} — v korpusu na to zřejmě odpověď není')
            unmatched += 1
            continue
        also = choose_also_relevant(found.chunk, corpus, input)
        row: Labelled = {
            'query': query,
            'relevant': [found.chunk.id, *also],
            'kind': 'hard',
            'via': found.via,
        }
        append_json_line(OUT, row)
        hard += 1
        added += 1

    print(f'\ntahle session: {added} hard dotazů, {unmatched} bez cíle v korpusu')
    print(f'celkem hard: {hard}/{TARGET}')


if __name__ == '__main__':
    main()
