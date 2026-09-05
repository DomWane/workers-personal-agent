import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { Chunk, EmbeddingsIndex } from '../lib/corpus.ts'
import { readJsonLines } from '../lib/jsonl.ts'
import { tokenizeStemmed } from '../lib/stem.ts'
import { unpackVectors } from '../lib/vectors.ts'
import { bm25Retriever } from '../retrievers/bm25.ts'
import { denseRetriever } from '../retrievers/dense.ts'
import type { Labelled } from '../run-retrieval.ts'

/**
 * Second stage of a two-stage pipeline: a cross-encoder scores the query against each candidate
 * jointly, which is what lets it promote a chunk buried at rank 12 — the thing rank fusion
 * demonstrably cannot do on this corpus.
 *
 * Ranking is precomputed to a file rather than done at query time so the eval stays offline and
 * deterministic, the same arrangement as the embeddings.
 */

/** Overridable so a run at a different input window lands in its own file instead of shadowing. */
const OUT = process.env.EVAL_RERANK_OUT ?? 'evals/data/rerank.jsonl'
const MODEL = '@cf/baai/bge-reranker-base'
/** How deep the first stage goes. The reranker can only reorder what it is handed. */
const DEPTH = Number.parseInt(process.env.EVAL_RERANK_DEPTH ?? '20', 10)
/**
 * Cross-encoders take a fixed input window and the API truncates silently. Recording the cap in
 * every row means a later run with a different value cannot be mistaken for the same experiment —
 * a hardcoded, unrecorded cap already made one experiment in this project measure nothing.
 */
const MAX_CHARS = Number.parseInt(process.env.EVAL_RERANK_MAX_CHARS ?? '1600', 10)

export type RerankRow = {
  query: string
  /** Identifies the candidate set, so a changed first stage invalidates rather than silently reuses. */
  candidateHash: string
  ranked: string[]
  scores: number[]
  depth: number
  maxChars: number
}

export function candidateHash(ids: string[]): string {
  return createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 16)
}

/** Union of both first-stage lists, dense first so its order breaks ties in the candidate set. */
export function candidatesFor(dense: string[], lexical: string[]): string[] {
  return [...new Set([...dense, ...lexical])]
}

type RerankResponse = { result?: { response?: Array<{ id: number; score: number }> } }

async function rerank(
  query: string,
  texts: string[],
  account: string,
  token: string,
): Promise<Array<{ index: number; score: number }>> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${MODEL}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      contexts: texts.map((text) => ({ text: text.slice(0, MAX_CHARS) })),
      top_k: texts.length,
    }),
  })
  if (!res.ok) {
    throw new Error(`${MODEL} ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  const data = (await res.json()) as RerankResponse
  const out = data.result?.response
  // A short response would silently drop candidates and read as the reranker demoting them.
  if (!out || out.length !== texts.length) {
    throw new Error(`${MODEL} returned ${out?.length ?? 0} scores for ${texts.length} contexts`)
  }
  return out.map((r) => ({ index: r.id, score: r.score }))
}

async function main(): Promise<void> {
  const account = process.env.CF_ACCOUNT_ID
  const token = process.env.CF_API_TOKEN
  if (!account || !token) {
    throw new Error('CF_ACCOUNT_ID and CF_API_TOKEN must be set')
  }

  const chunks = readJsonLines<Chunk>('evals/data/corpus.jsonl', { required: true })
  const labels = readJsonLines<Labelled>('evals/data/retrieval.labels.jsonl', { required: true })
  const meta = JSON.parse(readFileSync('evals/data/embeddings.index.json', 'utf8')) as EmbeddingsIndex
  const vectors = unpackVectors(readFileSync('evals/data/embeddings.bin'), meta.dim, meta.ids.length)
  const qv = JSON.parse(readFileSync('evals/data/query-vectors.json', 'utf8')) as Record<string, number[]>

  const dense = denseRetriever(meta.ids, vectors, (q) => new Float32Array(qv[q]))
  const lexical = bm25Retriever(chunks, { tokenizer: tokenizeStemmed, name: 'bm25-stem' })
  const byId = new Map(chunks.map((c) => [c.id, c]))

  const done = new Map((existsSync(OUT) ? readJsonLines<RerankRow>(OUT) : []).map((r) => [r.query, r]))
  let ran = 0

  for (const label of labels) {
    const ids = candidatesFor(dense.search(label.query, DEPTH), lexical.search(label.query, DEPTH))
    const hash = candidateHash(ids)
    const prev = done.get(label.query)
    if (prev && prev.candidateHash === hash && prev.depth === DEPTH && prev.maxChars === MAX_CHARS) {
      continue
    }

    const scored = await rerank(
      label.query,
      ids.map((id) => byId.get(id)!.text),
      account,
      token,
    )
    scored.sort((a, b) => b.score - a.score)
    const row: RerankRow = {
      query: label.query,
      candidateHash: hash,
      ranked: scored.map((s) => ids[s.index]),
      scores: scored.map((s) => s.score),
      depth: DEPTH,
      maxChars: MAX_CHARS,
    }
    appendFileSync(OUT, `${JSON.stringify(row)}\n`)
    ran++
    console.log(`${ran} ${label.query.slice(0, 50)} | ${ids.length} kandidátů`)
  }

  console.log(`\nhotovo: ${ran} dotazů přeuspořádáno, ${labels.length - ran} beze změny`)
}

if (/[\\/]rerank-precompute\.ts$/.test(process.argv[1] ?? '')) {
  await main()
}
