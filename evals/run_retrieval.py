import argparse
import json
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal, NamedTuple, NotRequired, TypedDict

from lib.chunk import HasIdText, chunk_config_from_env, expand_chunks
from lib.corpus import CORPUS, Chunk, EmbeddingsIndex, corpus_text_hash
from lib.jsonl import read_json_lines
from lib.metrics import mean, ndcg_at_k, paired_bootstrap, recall_at_k, reciprocal_rank
from lib.paths import DATA, RESULTS
from lib.stem import tokenize_stemmed
from lib.vectors import unpack_vectors
from retrievers.bm25 import BM25Retriever
from retrievers.by_parent import ByParent
from retrievers.dense import DenseRetriever
from retrievers.fasttext import FasttextRetriever
from retrievers.keyword import KeywordRetriever, Retriever

Kind = Literal['bulk', 'hard']
KINDS: tuple[Kind, ...] = ('bulk', 'hard')


class Labelled(TypedDict):
    query: str
    relevant: list[str]
    kind: Kind
    edited: NotRequired[bool]
    via: NotRequired[Literal['search', 'browse']]


class Partitioned(NamedTuple):
    usable: list[Labelled]
    stale: int


def partition_labels(labels: list[Labelled], chunks: Sequence[HasIdText]) -> Partitioned:
    ids = {c.id for c in chunks}
    usable = [label for label in labels if all(id in ids for id in label['relevant'])]
    return Partitioned(usable, len(labels) - len(usable))


@dataclass(frozen=True, slots=True)
class Stats:
    n: int
    r1: float
    r3: float
    r3max: float
    r10: float
    mrr: float
    ndcg10: float
    p50ms: float
    p95ms: float


@dataclass(frozen=True, slots=True)
class Row(Stats):
    retriever: str
    kind: str


class Scored(NamedTuple):
    row: Stats
    per_query: list[float]


REMEDY = 're-run pnpm eval:embed'


def assert_dense_inputs_fresh(
    chunks: Sequence[HasIdText], meta: EmbeddingsIndex, queries: list[str], qv: Mapping[str, Sequence[float]]
) -> None:
    corpus_ids = [c.id for c in chunks]
    corpus = set(corpus_ids)
    embedded = set(meta['ids'])
    missing = [id for id in corpus_ids if id not in embedded]
    stale = [id for id in meta['ids'] if id not in corpus]
    if missing or stale:
        raise ValueError(
            f'embeddings.index.json does not match the corpus: {len(missing)} chunk(s) unembedded, '
            f'{len(stale)} embedded id(s) no longer in the corpus — {REMEDY}'
        )
    text_hash = meta.get('textHash')
    if text_hash != corpus_text_hash(chunks):
        why = 'hash mismatch' if text_hash else 'no hash recorded'
        raise ValueError(
            f'embeddings.index.json was built from different chunk text (same ids, {why}) — {REMEDY}'
        )
    bad = [q for q in queries if len(qv.get(q, ())) != meta['dim']]
    if bad:
        raise ValueError(
            f'{len(bad)}/{len(queries)} labelled queries have no vector of dim {meta["dim"]} '
            f'(first: {json.dumps(bad[0], ensure_ascii=False)}) — {REMEDY}'
        )


def score(r: Retriever, items: list[Labelled]) -> Scored:
    times: list[float] = []
    ranked: list[list[str]] = []
    for it in items:
        t0 = time.perf_counter()
        ranked.append(r.search(it['query'], 10))
        times.append((time.perf_counter() - t0) * 1000)
    times.sort()

    def pct(p: float) -> float:
        return times[min(len(times) - 1, int(p * len(times)))] if times else 0

    def each(metric: Callable[[list[str], list[str]], float]) -> float:
        return mean([metric(rk, it['relevant']) for rk, it in zip(ranked, items, strict=True)])

    ndcg = [ndcg_at_k(rk, it['relevant'], 10) for rk, it in zip(ranked, items, strict=True)]
    row = Stats(
        n=len(items),
        r1=each(lambda rk, rel: recall_at_k(rk, rel, 1)),
        r3=each(lambda rk, rel: recall_at_k(rk, rel, 3)),
        r3max=mean([min(3, len(it['relevant'])) / len(it['relevant']) for it in items]),
        r10=each(lambda rk, rel: recall_at_k(rk, rel, 10)),
        mrr=each(reciprocal_rank),
        ndcg10=mean(ndcg),
        p50ms=pct(0.5),
        p95ms=pct(0.95),
    )
    return Scored(row, ndcg)


def fmt(x: float, n: int) -> str:
    return f'{x:.2f}*' if n < 10 else f'{x:.3f}'


def report_split(
    name: str, subset: list[Labelled], rest: list[Labelled], retrievers: Sequence[Retriever], warning: str
) -> None:
    if not subset or not rest:
        return
    print(f'\n{name}: {len(subset)} of {len(subset) + len(rest)}')
    for r in retrievers:
        a = score(r, subset).row
        b = score(r, rest).row
        print(
            f'{r.name:<10} ndcg@10 {name} {fmt(a.ndcg10, len(subset))} (n={len(subset)}) '
            f'vs rest {fmt(b.ndcg10, len(rest))} (n={len(rest)})'
        )
    print(warning)


def load_retrievers(chunks: list[Chunk], labels: list[Labelled]) -> list[Retriever]:
    retrievers: list[Retriever] = [
        KeywordRetriever(chunks),
        BM25Retriever(chunks),
        BM25Retriever(chunks, name='bm25-stem', tokenizer=tokenize_stemmed),
    ]
    fasttext_path = DATA / 'fasttext-vectors.json'
    if fasttext_path.exists():
        ft = json.loads(fasttext_path.read_text(encoding='utf-8'))
        retrievers.append(FasttextRetriever(chunks, ft['vectors'], ft['dim']))
    if (DATA / 'embeddings.bin').exists() and (DATA / 'query-vectors.json').exists():
        meta: EmbeddingsIndex = json.loads((DATA / 'embeddings.index.json').read_text(encoding='utf-8'))
        vectors = unpack_vectors((DATA / 'embeddings.bin').read_bytes(), meta['dim'], len(meta['ids']))
        qv: dict[str, list[float]] = json.loads((DATA / 'query-vectors.json').read_text(encoding='utf-8'))
        cfg = chunk_config_from_env()
        embedded = expand_chunks(chunks, cfg)
        assert_dense_inputs_fresh(embedded, meta, [label['query'] for label in labels], qv)
        dense = DenseRetriever(meta['ids'], vectors, lambda q: qv[q])
        retrievers.append(
            ByParent(dense, len(embedded), f'bge-m3/{cfg.chars}+{cfg.overlap}') if cfg else dense
        )
    return retrievers


COMPARISONS = (('bm25', 'keyword'), ('bm25-stem', 'bm25'), ('fasttext', 'bm25-stem'), ('bge-m3', 'fasttext'))


def main(out: Path) -> None:
    chunks = [Chunk(**c) for c in read_json_lines(CORPUS, required=True)]
    all_labels: list[Labelled] = read_json_lines(DATA / 'retrieval.labels.jsonl', required=True)
    labels, stale = partition_labels(all_labels, chunks)
    if stale > 0:
        print(f'WARNING: {stale} of {len(all_labels)} labels point at chunks that no longer exist.')
        print('Excluded from scoring — those exchanges changed since labelling. Re-label them.')
    retrievers = load_retrievers(chunks, labels)

    rows: list[Row] = []
    per_query: dict[str, list[float]] = {}
    for r in retrievers:
        for kind in KINDS:
            items = [label for label in labels if label['kind'] == kind]
            if not items:
                continue
            scored = score(r, items)
            rows.append(Row(retriever=r.name, kind=kind, **asdict(scored.row)))
            per_query[f'{r.name}:{kind}'] = scored.per_query

    print(f'corpus: {len(chunks)} chunks | labels: {len(labels)}')
    print('retriever  kind   n   ndcg@10 mrr    r@10   r@3    (max)  r@1    p50ms  p95ms')
    for row in rows:
        print(
            f'{row.retriever:<10} {row.kind:<6} {row.n:>3} '
            + ' '.join(f'{fmt(v, row.n):<6}' for v in (row.ndcg10, row.mrr, row.r10, row.r3))
            + f' {row.r3max:<6.3f} {fmt(row.r1, row.n):<6}'
            + f' {row.p50ms:<6.2f} {row.p95ms:.2f}'
        )
    print('(max) = highest r@3 reachable — recall divides by the relevant count, so pooling caps it')
    if any(row.n < 10 for row in rows):
        print('* n < 10 — raw indication only, not a measurement')

    report_split(
        'edited',
        [label for label in labels if label.get('edited')],
        [label for label in labels if not label.get('edited')],
        retrievers,
        'edited scoring higher is evidence the edits leaked, not that they were better',
    )
    hard = [label for label in labels if label['kind'] == 'hard']
    report_split(
        'search-located',
        [label for label in hard if label.get('via') == 'search'],
        [label for label in hard if label.get('via') == 'browse'],
        retrievers,
        'search-located hard targets contain the words that found them — a gap here is that, not skill',
    )

    comparisons: list[dict[str, str | int | float]] = []
    for better, worse in COMPARISONS:
        for kind in KINDS:
            a = per_query.get(f'{better}:{kind}')
            b = per_query.get(f'{worse}:{kind}')
            if a is None or b is None:
                continue
            ci = paired_bootstrap(a, b, 10_000, 1)
            comparisons.append(
                {
                    'better': better,
                    'worse': worse,
                    'kind': kind,
                    'metric': 'ndcg@10',
                    'n': len(a),
                    'meanDiff': ci.mean_diff,
                    'lower': ci.lower,
                    'upper': ci.upper,
                }
            )
            print(
                f'{better} - {worse} on {kind} (ndcg@10): {ci.mean_diff:.3f} [{ci.lower:.3f}, {ci.upper:.3f}]'
            )

    out.parent.mkdir(parents=True, exist_ok=True)
    report = {'corpus': len(chunks), 'rows': [asdict(row) for row in rows], 'comparisons': comparisons}
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Score every retriever over the labelled queries')
    parser.add_argument('--out', type=Path, default=RESULTS / 'latest-retrieval.json')
    args = parser.parse_args(sys.argv[1:])
    main(args.out)
