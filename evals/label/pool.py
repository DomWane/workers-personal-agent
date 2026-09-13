import json
import os
import sys
from typing import cast

from lib.corpus import CORPUS, Chunk, EmbeddingsIndex
from lib.jsonl import append_json_line, read_json_lines
from lib.paths import DATA
from lib.pool import build_pool, key, shuffle_within_query
from lib.stem import tokenize_stemmed
from lib.vectors import unpack_vectors
from retrievers.bm25 import BM25Retriever
from retrievers.dense import DenseRetriever
from retrievers.fasttext import FasttextRetriever
from retrievers.keyword import KeywordRetriever, Retriever
from retrievers.rerank import RerankRetriever
from retrievers.rrf import RrfRetriever, Weighted
from run_retrieval import Kind, Labelled, assert_dense_inputs_fresh

LABELS = DATA / 'retrieval.labels.jsonl'
JUDGED = DATA / 'retrieval.pool-judged.jsonl'


def save_labels(labels: list[Labelled]) -> None:
    tmp = LABELS.with_suffix('.jsonl.tmp')
    tmp.write_text(
        ''.join(json.dumps(label, ensure_ascii=False) + '\n' for label in labels), encoding='utf-8'
    )
    os.replace(tmp, LABELS)


def main(kind: Kind, depth: int) -> None:
    chunks = [Chunk(**c) for c in read_json_lines(CORPUS, required=True)]
    labels: list[Labelled] = read_json_lines(LABELS, required=True)

    if not (DATA / 'embeddings.bin').exists() or not (DATA / 'query-vectors.json').exists():
        raise SystemExit(
            'pooling needs every retriever, and the dense one has no vectors — run embed.precompute first'
        )
    meta: EmbeddingsIndex = json.loads((DATA / 'embeddings.index.json').read_text(encoding='utf-8'))
    vectors = unpack_vectors((DATA / 'embeddings.bin').read_bytes(), meta['dim'], len(meta['ids']))
    qv: dict[str, list[float]] = json.loads((DATA / 'query-vectors.json').read_text(encoding='utf-8'))
    assert_dense_inputs_fresh(chunks, meta, [label['query'] for label in labels], qv)

    dense = DenseRetriever(meta['ids'], vectors, lambda q: qv[q])
    lexical = BM25Retriever(chunks, name='bm25-stem', tokenizer=tokenize_stemmed)
    retrievers: list[Retriever] = [KeywordRetriever(chunks), BM25Retriever(chunks), lexical, dense]
    for weight in (1, 2, 4):
        retrievers.append(
            RrfRetriever([Weighted(dense, weight), Weighted(lexical, 1)], depth=20, name=f'rrf-{weight}:1')
        )
    if (DATA / 'rerank.jsonl').exists():
        retrievers.append(RerankRetriever(read_json_lines(DATA / 'rerank.jsonl')))
    if (DATA / 'fasttext-vectors.json').exists():
        ft = json.loads((DATA / 'fasttext-vectors.json').read_text(encoding='utf-8'))
        retrievers.append(FasttextRetriever(chunks, ft['vectors'], ft['dim']))

    by_id = {c.id: c for c in chunks}
    judged = {key(j['query'], j['chunkId']) for j in read_json_lines(JUDGED)}
    targets = [label for label in labels if label['kind'] == kind]
    pool = shuffle_within_query(build_pool([Target(label) for label in targets], retrievers, depth, judged))

    print(f'pooling {kind} do hloubky {depth}: {len(pool)} dvojic k posouzení')
    print('Nevíš, který retriever chunk vrátil — a je to schválně. Posuzuješ odpověď, ne systém.')
    print('Ptej se jen: odpovídá tenhle chunk na ten dotaz? Ne jestli je to nejlepší odpověď.\n')

    accepted = done = 0
    for item in pool:
        chunk = by_id.get(item.chunk_id)
        if chunk is None:
            continue
        print(f'\n──── {done + 1}/{len(pool)} ────')
        print(f'DOTAZ: {item.query}')
        print(f'{"─" * 70}\n{chunk.text}\n{"─" * 70}')
        ans = input('odpovídá to na dotaz? [a]no / [n]e / [q]uit > ').strip().lower()
        if ans == 'q':
            break
        relevant = ans == 'a'
        append_json_line(JUDGED, {'query': item.query, 'chunkId': item.chunk_id, 'relevant': relevant})
        if relevant:
            label = next((label for label in labels if label['query'] == item.query), None)
            if label is not None and item.chunk_id not in label['relevant']:
                label['relevant'].append(item.chunk_id)
                save_labels(labels)
            accepted += 1
        done += 1

    per_query = accepted / max(1, len(targets))
    print(f'\nposouzeno {done}/{len(pool)}, doplněno {accepted} relevantních ({per_query:.2f} na dotaz)')
    print('spusť run_retrieval — čísla by měla vyrůst všem třem retrieverům')


class Target:
    def __init__(self, label: Labelled) -> None:
        self.query = label['query']
        self.relevant = label['relevant']


if __name__ == '__main__':
    kind = cast(Kind, sys.argv[1]) if len(sys.argv) > 1 else 'hard'
    main(kind, int(sys.argv[2]) if len(sys.argv) > 2 else 3)
