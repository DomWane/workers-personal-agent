from collections.abc import Callable
from pathlib import Path

from gen.queries import Candidate
from lib.corpus import CORPUS, Chunk
from lib.jsonl import append_json_line, read_json_lines
from lib.paths import DATA
from lib.similar import neighbours_of, pick_neighbours

OUT = DATA / 'retrieval.labels.jsonl'
DROPPED = DATA / 'retrieval.dropped.jsonl'


def load_kept_ids(out_path: Path) -> set[str]:
    return {row['relevant'][0] for row in read_json_lines(out_path)}


def load_dropped_ids(dropped_path: Path) -> set[str]:
    return {row['chunkId'] for row in read_json_lines(dropped_path)}


def select_todo(candidates: list[Candidate], excluded: set[str]) -> list[Candidate]:
    return [c for c in candidates if c['chunkId'] not in excluded]


def choose_also_relevant(chunk: Chunk, chunks: list[Chunk], ask: Callable[[str], str]) -> list[str]:
    neighbours = neighbours_of(chunk, chunks)
    if not neighbours:
        return []
    print('\npodobné chunky (chunk↔chunk, dotaz do toho nevstupuje):')
    for i, n in enumerate(neighbours, start=1):
        print(f'  {i}. ({n.score:.2f}) {n.chunk.text[:150].replace(chr(10), " ")}')
    answer = ask('které z nich taky odpovídají? čísla oddělená čárkou (enter = žádné) > ')
    return pick_neighbours(answer, neighbours)


def main() -> None:
    corpus = [Chunk(**c) for c in read_json_lines(CORPUS, required=True)]
    chunks = {c.id: c for c in corpus}
    candidates: list[Candidate] = read_json_lines(DATA / 'retrieval.candidates.jsonl', required=True)

    excluded = load_kept_ids(OUT) | load_dropped_ids(DROPPED)
    todo = select_todo(candidates, excluded)
    done = len(candidates) - len(todo)
    kept = dropped = 0

    for i, c in enumerate(todo):
        chunk = chunks.get(c['chunkId'])
        if chunk is None:
            continue
        print(
            f'\n──── {done + i + 1}/{len(candidates)} ─── zbývá {len(todo) - i} '
            f'─── minule hotovo {done} ─── leakage {c["leakage"]:.2f} ────'
        )
        print(f'DOTAZ:  {c["query"]}')
        print(f'CHUNK:  {chunk.text[:400].replace(chr(10), " ")}')
        ans = input('[k]eep / [d]rop / [e]dit / [m]ulti / [q]uit > ').strip().lower()

        if ans == 'q':
            break
        if ans == 'd':
            append_json_line(DROPPED, {'chunkId': c['chunkId']})
            dropped += 1
            continue
        query = c['query']
        if ans == 'e':
            query = input('nový dotaz > ').strip() or query
        also = choose_also_relevant(chunk, corpus, input) if ans == 'm' else []
        edited = ans == 'e' and query != c['query']
        row: dict[str, object] = {'query': query, 'relevant': [c['chunkId'], *also], 'kind': 'bulk'}
        if edited:
            row['edited'] = True
        append_json_line(OUT, row)
        kept += 1

    print(f'\ntahle session: {kept} keep, {dropped} drop')
    print(f'celkem hotovo {done + kept + dropped}/{len(candidates)}, zbývá {len(todo) - kept - dropped}')


if __name__ == '__main__':
    main()
