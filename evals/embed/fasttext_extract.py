import gzip
import json
import os
import re
import unicodedata
from pathlib import Path

from lib.corpus import CORPUS, Chunk
from lib.jsonl import read_json_lines
from lib.paths import DATA
from lib.tokenize import tokenize

SOURCE = Path(os.environ.get('FASTTEXT_VEC', Path.home() / 'Downloads' / 'cc.cs.300.vec.gz'))
OUT = DATA / 'fasttext-vectors.json'
COMBINING_MARKS = re.compile(r'[̀-ͯ]')


def corpus_vocabulary(chunks: list[Chunk], queries: list[str]) -> set[str]:
    vocab = {t for c in chunks for t in tokenize(c.text)}
    vocab.update(t for q in queries for t in tokenize(q))
    return vocab


def fold_word(word: str) -> str:
    return COMBINING_MARKS.sub('', unicodedata.normalize('NFD', word)).lower()


def main() -> None:
    chunks = [Chunk(**c) for c in read_json_lines(CORPUS, required=True)]
    labels = read_json_lines(DATA / 'retrieval.labels.jsonl', required=True)
    vocab = corpus_vocabulary(chunks, [row['query'] for row in labels])
    print(f'hledám {len(vocab)} slov korpusu v {SOURCE}')

    vectors: dict[str, list[float]] = {}
    dim = 0
    seen = 0
    with gzip.open(SOURCE, 'rt', encoding='utf-8', errors='replace') as source:
        for line in source:
            seen += 1
            if seen == 1:
                dim = int(line.split()[1])
                continue
            word, _, rest = line.partition(' ')
            if not word:
                continue
            folded = fold_word(word)
            if folded not in vocab or folded in vectors:
                continue
            vectors[folded] = [float(x) for x in rest.split()]
            if seen % 200_000 == 0:
                print(f'  {seen} řádků, nalezeno {len(vectors)}/{len(vocab)}')

    found = len(vectors)
    OUT.write_text(json.dumps({'dim': dim, 'vectors': vectors}) + '\n', encoding='utf-8')
    print(f'\nřádků ve zdroji: {seen} | dim: {dim}')
    print(f'nalezeno {found}/{len(vocab)} slov — OOV {(len(vocab) - found) / len(vocab) * 100:.1f}%')
    print(f'zapsáno {OUT}')


if __name__ == '__main__':
    main()
