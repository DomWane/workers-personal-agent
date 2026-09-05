import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { Chunk } from './lib/corpus.ts'
import { chunkConfigFromEnv, expandChunks } from './lib/chunk.ts'
import { CORPUS, corpusTextHash, type EmbeddingsIndex } from './lib/corpus.ts'
import { readJsonLines } from './lib/jsonl.ts'
import { tokenizeStemmed } from './lib/stem.ts'
import { ndcgAtK, pairedBootstrap, recallAtK, reciprocalRank } from './lib/metrics.ts'
import { unpackVectors } from './lib/vectors.ts'
import { bm25Retriever } from './retrievers/bm25.ts'
import { byParent } from './retrievers/by-parent.ts'
import { denseRetriever } from './retrievers/dense.ts'
import { fasttextRetriever } from './retrievers/fasttext.ts'
import { keywordRetriever, type Retriever } from './retrievers/keyword.ts'

/**
 * A label pointing at a chunk that no longer exists is not a retrieval failure — it is a stale
 * label, and scoring it as a miss quietly lowers every number with no visible cause.
 */
export function partitionLabels(labels: Labelled[], chunks: Chunk[]): { usable: Labelled[]; stale: number } {
  const ids = new Set(chunks.map((c) => c.id))
  const usable = labels.filter((l) => l.relevant.every((id) => ids.has(id)))
  return { usable, stale: labels.length - usable.length }
}

export type Labelled = {
  query: string
  relevant: string[]
  kind: 'bulk' | 'hard'
  edited?: boolean
  /** How a hard-set target was located: by typing words into the corpus, or by date/project. */
  via?: 'search' | 'browse'
}

/**
 * Two ways of writing a label bypass the leakage guard, and both would raise the numbers rather
 * than the realism if they leaked: an edited query is written with its chunk on screen, and a
 * search-located hard target is by construction a chunk containing the words that were typed.
 * Neither can be prevented outright, so each is recorded and scored apart from its complement —
 * if the exposed half scores higher, that gap is the leak, printed instead of buried in the mean.
 */
function reportSplit(
  name: string,
  subset: Labelled[],
  rest: Labelled[],
  retrievers: Retriever[],
  warning: string,
): void {
  if (subset.length === 0 || rest.length === 0) {
    return
  }
  console.log(`\n${name}: ${subset.length} of ${subset.length + rest.length}`)
  for (const r of retrievers) {
    const a = score(r, subset).row
    const b = score(r, rest).row
    console.log(
      `${r.name.padEnd(10)} ndcg@10 ${name} ${fmt(a.ndcg10, subset.length)} (n=${subset.length}) ` +
        `vs rest ${fmt(b.ndcg10, rest.length)} (n=${rest.length})`,
    )
  }
  console.log(warning)
}

type Row = {
  retriever: string
  kind: string
  n: number
  r1: number
  r3: number
  r3max: number
  r10: number
  mrr: number
  ndcg10: number
  p50ms: number
  p95ms: number
}

type Comparison = {
  better: string
  worse: string
  kind: string
  metric: string
  n: number
  meanDiff: number
  lower: number
  upper: number
}

const REMEDY = 're-run pnpm eval:embed'

/**
 * Chunk ids are content-addressed, so an id surviving does not prove the embedding matches —
 * only the text hash does. Likewise a query appended to the labels after the last
 * embed run has no vector. Both fail as a uniform zero score folded into the mean with no
 * warning — the most interesting-looking result in the table, and fabricated. Crash instead.
 */
export function assertDenseInputsFresh(
  chunks: Array<{ id: string; text: string }>,
  meta: EmbeddingsIndex,
  queries: string[],
  qv: Record<string, number[]>,
): void {
  const corpusIds = chunks.map((c) => c.id)
  const corpus = new Set(corpusIds)
  const embedded = new Set(meta.ids)
  const missing = corpusIds.filter((id) => !embedded.has(id))
  const stale = meta.ids.filter((id) => !corpus.has(id))
  if (missing.length || stale.length) {
    throw new Error(
      `embeddings.index.json does not match the corpus: ${missing.length} chunk(s) unembedded, ` +
        `${stale.length} embedded id(s) no longer in the corpus — ${REMEDY}`,
    )
  }
  // Ids can match while every chunk body has been rewritten by an ingest-rule or cap change;
  // without this the dense scores would be computed against text that no longer exists.
  if (meta.textHash !== corpusTextHash(chunks)) {
    throw new Error(
      `embeddings.index.json was built from different chunk text (same ids, ` +
        `${meta.textHash ? 'hash mismatch' : 'no hash recorded'}) — ${REMEDY}`,
    )
  }
  const bad = queries.filter((q) => (qv[q]?.length ?? 0) !== meta.dim)
  if (bad.length) {
    throw new Error(
      `${bad.length}/${queries.length} labelled queries have no vector of dim ${meta.dim} ` +
        `(first: ${JSON.stringify(bad[0])}) — ${REMEDY}`,
    )
  }
}

export function score(r: Retriever, items: Labelled[]): { row: Omit<Row, 'retriever' | 'kind'>; perQuery: number[] } {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0)
  // Per-query timing: for the dense retriever this is the brute-force cosine scan, which is
  // the number that decides when a real vector index becomes necessary.
  const times: number[] = []
  const ranked = items.map((it) => {
    const t0 = performance.now()
    const out = r.search(it.query, 10)
    times.push(performance.now() - t0)
    return out
  })
  times.sort((x, y) => x - y)
  const pct = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))] ?? 0
  const ndcg = ranked.map((rk, i) => ndcgAtK(rk, items[i].relevant, 10))
  return {
    row: {
      n: items.length,
      r1: mean(ranked.map((rk, i) => recallAtK(rk, items[i].relevant, 1))),
      r3: mean(ranked.map((rk, i) => recallAtK(rk, items[i].relevant, 3))),
      // Recall divides by the number of relevant chunks, so a query with eight of them caps
      // recall@3 at 3/8 — pooling lowers the ceiling of the metric it was meant to fix. Printed
      // next to the score because a reader comparing 0.22 against 1.0 draws the wrong conclusion.
      r3max: mean(items.map((it) => Math.min(3, it.relevant.length) / it.relevant.length)),
      r10: mean(ranked.map((rk, i) => recallAtK(rk, items[i].relevant, 10))),
      mrr: mean(ranked.map((rk, i) => reciprocalRank(rk, items[i].relevant))),
      ndcg10: mean(ndcg),
      p50ms: pct(0.5),
      p95ms: pct(0.95),
    },
    // nDCG rather than recall@3 drives the comparisons: it handles several relevant chunks
    // without a ceiling that moves per query, so two queries stay comparable after pooling.
    perQuery: ndcg,
  }
}

export function fmt(x: number, n: number): string {
  // Never dress up a tiny sample as a percentage.
  return n < 10 ? `${x.toFixed(2)}*` : x.toFixed(3)
}

function main(): void {
  const chunks = readJsonLines<Chunk>(CORPUS, { required: true })
  const allLabels = readJsonLines<Labelled>('evals/data/retrieval.labels.jsonl', { required: true })
  const { usable: labels, stale } = partitionLabels(allLabels, chunks)
  if (stale > 0) {
    console.log(`WARNING: ${stale} of ${allLabels.length} labels point at chunks that no longer exist.`)
    console.log('Excluded from scoring — those exchanges changed since labelling. Re-label them.')
  }
  const retrievers = [
    keywordRetriever(chunks),
    bm25Retriever(chunks),
    bm25Retriever(chunks, { name: 'bm25-stem', tokenizer: tokenizeStemmed }),
  ]
  // Optional: present only when the fastText vectors have been extracted, so the eval still runs
  // for anyone without a 1.2 GB download.
  if (existsSync('evals/data/fasttext-vectors.json')) {
    const ft = JSON.parse(readFileSync('evals/data/fasttext-vectors.json', 'utf8')) as {
      dim: number
      vectors: Record<string, number[]>
    }
    retrievers.push(fasttextRetriever(chunks, ft.vectors, ft.dim))
  }
  if (existsSync('evals/data/embeddings.bin') && existsSync('evals/data/query-vectors.json')) {
    const meta = JSON.parse(readFileSync('evals/data/embeddings.index.json', 'utf8')) as EmbeddingsIndex
    const raw = readFileSync('evals/data/embeddings.bin')
    const vectors = unpackVectors(raw, meta.dim, meta.ids.length)
    // Query vectors are precomputed too, so the run stays offline and repeatable.
    const qv = JSON.parse(readFileSync('evals/data/query-vectors.json', 'utf8')) as Record<string, number[]>
    // The freshness checks compare ids, order and a hash of the exact embedded texts, so they are
    // given the same expansion the embedder used rather than being taught what chunking is.
    const cfg = chunkConfigFromEnv()
    const embedded = expandChunks(chunks, cfg)
    assertDenseInputsFresh(
      embedded,
      meta,
      labels.map((l) => l.query),
      qv,
    )
    const dense = denseRetriever(meta.ids, vectors, (q) => new Float32Array(qv[q]))
    // Labels name whole exchanges, so a chunked run is scored on its parents. Named for the split
    // it used: two rows called `bge-m3` in one results file would be unreadable.
    retrievers.push(cfg ? byParent(dense, embedded.length, `bge-m3/${cfg.chars}+${cfg.overlap}`) : dense)
  }
  const kinds: Array<'bulk' | 'hard'> = ['bulk', 'hard']

  const rows: Row[] = []
  const perQuery = new Map<string, number[]>()
  for (const r of retrievers) {
    for (const kind of kinds) {
      const items = labels.filter((l) => l.kind === kind)
      if (items.length === 0) {
        continue
      }
      const { row, perQuery: pq } = score(r, items)
      rows.push({ retriever: r.name, kind, ...row })
      perQuery.set(`${r.name}:${kind}`, pq)
    }
  }

  console.log(`corpus: ${chunks.length} chunks | labels: ${labels.length}`)
  // nDCG and MRR lead because they survive pooling; the recall columns follow with the ceiling
  // that pooling imposed on them.
  console.log('retriever  kind   n   ndcg@10 mrr    r@10   r@3    (max)  r@1    p50ms  p95ms')
  for (const r of rows) {
    console.log(
      `${r.retriever.padEnd(10)} ${r.kind.padEnd(6)} ${String(r.n).padStart(3)} ` +
        [r.ndcg10, r.mrr, r.r10, r.r3].map((v) => fmt(v, r.n).padEnd(6)).join(' ') +
        ` ${r.r3max.toFixed(3).padEnd(6)} ${fmt(r.r1, r.n).padEnd(6)}` +
        ` ${r.p50ms.toFixed(2).padEnd(6)} ${r.p95ms.toFixed(2)}`,
    )
  }
  console.log('(max) = highest r@3 reachable — recall divides by the relevant count, so pooling caps it')
  if (rows.some((r) => r.n < 10)) {
    console.log('* n < 10 — raw indication only, not a measurement')
  }

  reportSplit(
    'edited',
    labels.filter((l) => l.edited),
    labels.filter((l) => !l.edited),
    retrievers,
    'edited scoring higher is evidence the edits leaked, not that they were better',
  )
  const hard = labels.filter((l) => l.kind === 'hard')
  reportSplit(
    'search-located',
    hard.filter((l) => l.via === 'search'),
    hard.filter((l) => l.via === 'browse'),
    retrievers,
    'search-located hard targets contain the words that found them — a gap here is that, not skill',
  )

  // The intervals belong in the committed artifact next to the point estimates: a row read
  // without its CI is what turns a noise-sized gap into a claim.
  const comparisons: Comparison[] = []
  for (const [better, worse] of [
    ['bm25', 'keyword'],
    ['bm25-stem', 'bm25'],
    ['fasttext', 'bm25-stem'],
    ['bge-m3', 'fasttext'],
  ] as const) {
    for (const kind of kinds) {
      const a = perQuery.get(`${better}:${kind}`)
      const b = perQuery.get(`${worse}:${kind}`)
      if (!a || !b) {
        continue
      }
      const { meanDiff, lower, upper } = pairedBootstrap(a, b, 10_000, 1)
      comparisons.push({ better, worse, kind, metric: 'ndcg@10', n: a.length, meanDiff, lower, upper })
      console.log(
        `${better} - ${worse} on ${kind} (ndcg@10): ${meanDiff.toFixed(3)} [${lower.toFixed(3)}, ${upper.toFixed(3)}]`,
      )
    }
  }

  mkdirSync('evals/results', { recursive: true })
  writeFileSync(
    'evals/results/latest-retrieval.json',
    `${JSON.stringify({ corpus: chunks.length, rows, comparisons }, null, 2)}\n`,
  )
}

if (process.argv[1]?.endsWith('run-retrieval.ts')) {
  main()
}
