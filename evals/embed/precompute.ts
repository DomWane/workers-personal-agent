import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { chunkConfigFromEnv, expandChunks } from '../lib/chunk.ts'
import { type Chunk, CORPUS, corpusTextHash, type EmbeddingsIndex } from '../lib/corpus.ts'
import { readJsonLines } from '../lib/jsonl.ts'
import { packVectors } from '../lib/vectors.ts'

/**
 * Must stay at or above the ingest cap, or the corpus keeps text the dense retriever never sees:
 * with this at 1600 a chunk cap of 2400 and one of 3600 produced byte-identical vectors, and the
 * experiment comparing them silently measured nothing. `truncate_inputs` makes the model the
 * backstop for anything genuinely over its window, so this is a request-size guard, not a limit.
 */
const MAX_CHARS = Number.parseInt(process.env.EVAL_EMBED_MAX_CHARS ?? '1600', 10)
const BATCH = 25
const BIN = 'evals/data/embeddings.bin'
const INDEX = 'evals/data/embeddings.index.json'
const QUERY_VECTORS = 'evals/data/query-vectors.json'

/**
 * Chunk vectors are the expensive half of this run, and appending a hard query set to the
 * labels is a normal reason to re-run it. Reuse is safe only when the stored ids are the same
 * ids in the same order — embeddings.bin is a flat array positionally keyed to them, so any
 * divergence means a re-ingest renumbered the corpus and every vector must be recomputed.
 */
export function canReuseCorpusVectors(
  chunks: Array<{ id: string; text: string }>,
  meta: EmbeddingsIndex | null,
  maxChars = MAX_CHARS,
): boolean {
  if (!meta || meta.dim <= 0 || meta.ids.length !== chunks.length) {
    return false
  }
  // The stored vectors are only current for the truncation they were built with: raising the
  // limit leaves the corpus text identical while the model now sees more of it, so the text hash
  // alone reports fresh and the run silently compares one setting against another's vectors.
  if (meta.maxChars !== maxChars) {
    return false
  }
  if (!meta.ids.every((id, i) => id === chunks[i].id)) {
    return false
  }
  // An index written before the hash existed cannot be shown to be current, so it isn't reused.
  return !!meta.textHash && meta.textHash === corpusTextHash(chunks)
}

/** Only queries with no usable vector cost money; the rest are carried over verbatim. */
export function queriesToEmbed(queries: string[], existing: Record<string, number[]>, dim: number): string[] {
  return [...new Set(queries)].filter((q) => (existing[q]?.length ?? 0) !== dim)
}

async function embedBatch(texts: string[], account: string, token: string): Promise<number[][]> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/baai/bge-m3`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: texts.map((t) => t.slice(0, MAX_CHARS)), truncate_inputs: true }),
  })
  if (!res.ok) {
    throw new Error(`workers-ai ${res.status}: ${await res.text()}`)
  }
  const data = (await res.json()) as { result?: { data?: number[][] } }
  const out = data.result?.data
  if (!out || out.length !== texts.length) {
    throw new Error('workers-ai returned a short batch')
  }
  // Without this a short vector is silently zero-padded by packVectors' flat.set and becomes
  // a plausible-looking wrong embedding.
  const dim = out[0]?.length ?? 0
  for (const [i, v] of out.entries()) {
    if (v.length !== dim) {
      throw new Error(`workers-ai vector ${i} has dim ${v.length}, expected ${dim}`)
    }
  }
  return out
}

async function main(): Promise<void> {
  const account = process.env.CF_ACCOUNT_ID
  const token = process.env.CF_API_TOKEN
  if (!account || !token) {
    throw new Error('CF_ACCOUNT_ID and CF_API_TOKEN must be set')
  }

  const cfg = chunkConfigFromEnv()
  const corpus = readJsonLines<Chunk>(CORPUS, { required: true })
  const chunks = expandChunks(corpus, cfg)
  const ids = chunks.map((c) => c.id)
  if (cfg) {
    console.log(`chunking ${corpus.length} corpus entries into ${chunks.length} at ${cfg.chars}/${cfg.overlap}`)
  }

  const meta =
    existsSync(BIN) && existsSync(INDEX)
      ? (JSON.parse(readFileSync(INDEX, 'utf8')) as { dim: number; ids: string[] })
      : null
  let dim: number

  if (meta && canReuseCorpusVectors(chunks, meta)) {
    dim = meta.dim
    console.log(
      `reusing ${meta.ids.length} corpus vectors from ${BIN} (dim ${dim}, texts unchanged) — embedding queries only`,
    )
  } else {
    console.log(`re-embedding all ${chunks.length} corpus chunks (no ${BIN} matching these ids and texts)`)
    const vectors: number[][] = []
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH)
      vectors.push(
        ...(await embedBatch(
          batch.map((c) => c.text),
          account,
          token,
        )),
      )
      console.log(`${Math.min(i + BATCH, chunks.length)}/${chunks.length}`)
    }
    dim = vectors[0]?.length ?? 0
    writeFileSync(BIN, packVectors(vectors, dim))
    const index: EmbeddingsIndex = {
      dim,
      ids,
      textHash: corpusTextHash(chunks),
      maxChars: MAX_CHARS,
      ...(cfg && { chunkChars: cfg.chars, chunkOverlap: cfg.overlap }),
    }
    writeFileSync(INDEX, `${JSON.stringify(index, null, 2)}\n`)
    console.log(`embedded ${vectors.length} chunks, dim ${dim}`)
  }

  const queries = readJsonLines<{ query: string }>('evals/data/retrieval.labels.jsonl', { required: true }).map(
    (l) => l.query,
  )
  const qv: Record<string, number[]> = existsSync(QUERY_VECTORS)
    ? (JSON.parse(readFileSync(QUERY_VECTORS, 'utf8')) as Record<string, number[]>)
    : {}
  const unique = new Set(queries).size
  const todo = queriesToEmbed(queries, qv, dim)
  console.log(`queries: ${todo.length} to embed, ${unique - todo.length} of ${unique} reused`)
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH)
    const vecs = await embedBatch(batch, account, token)
    batch.forEach((q, j) => {
      qv[q] = vecs[j]
    })
    // Persist per batch: the whole point of resume is that an interruption keeps what was paid for.
    writeFileSync(QUERY_VECTORS, `${JSON.stringify(qv)}\n`)
  }
  writeFileSync(QUERY_VECTORS, `${JSON.stringify(qv)}\n`)
}

// Guarded like the other entrypoints: without this, importing the module fires paid API calls.
if (/[\\/]embed[\\/]precompute\.ts$/.test(process.argv[1] ?? '')) {
  await main()
}
