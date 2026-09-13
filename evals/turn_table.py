from collections import Counter

from lib.jsonl import read_json_lines
from lib.paths import DATA, RESULTS
from lib.records import from_exported_event, group_turns
from lib.turn_table import project_turn, to_csv

IN = DATA / 'traces.jsonl'
OUT = RESULTS / 'turns.csv'


def main() -> None:
    raw = read_json_lines(IN, required=True)
    usable = [r for r in (from_exported_event(event) for event in raw) if r is not None]
    turns = group_turns(usable)
    rows = [project_turn(t) for t in turns]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(to_csv(rows) + '\n', encoding='utf-8')

    by_source = Counter(str(row['source']) for row in rows)
    dropped = len(raw) - len(usable)
    print(f'{len(raw)} records in, {len(usable)} with an envelope ({dropped} pre-schema, dropped)')
    print(f'{len(turns)} turns → {OUT}')
    for source, n in sorted(by_source.items()):
        print(f'  {n:>4}  {source}')
    unfinished = sum(1 for row in rows if row['outcome'] == 'unfinished')
    if unfinished:
        print(f'  {unfinished:>4}  unfinished (no turn record)')


if __name__ == '__main__':
    main()
