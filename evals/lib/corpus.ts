import { createHash } from 'node:crypto'

/** Overridable so one arm of an experiment cannot overwrite another's corpus. Shared, because the
 *  embedder and the runner pointed at different files would score vectors against text they were
 *  not built from. */
export const CORPUS = process.env.EVAL_CORPUS ?? 'evals/data/corpus.jsonl'

/**
 * One exchange, as everything downstream sees it. Here rather than beside the reader that produces
 * it: every retriever, labeller and scorer needs the shape, and only one step needs the reader.
 */
export type Chunk = { id: string; text: string; session: string; ts: string; project: string }

/** The shape of embeddings.index.json, shared by the writer and the reader. */
export type EmbeddingsIndex = {
  dim: number
  ids: string[]
  textHash?: string
  maxChars?: number
  /** Absent means one vector per corpus chunk; present records the split those vectors came from. */
  chunkChars?: number
  chunkOverlap?: number
}

/**
 * Chunk ids are content-addressed over the raw exchange, so they survive unchanged when the
 * *stored text* changes — an ingest rule or ASSISTANT_CAP rewrites every body under the same ids.
 * Comparing ids alone would then let stale vectors be reused and pass the freshness check.
 *
 * Covers the chunk texts, in corpus order, and nothing else: it is the exact input the embedder
 * was given. Each text is length-prefixed so no rechunking can produce a colliding stream.
 */
export function corpusTextHash(chunks: Array<{ text: string }>): string {
  const h = createHash('sha256')
  for (const c of chunks) {
    const buf = Buffer.from(c.text, 'utf8')
    h.update(`${buf.length}\n`)
    h.update(buf)
  }
  return h.digest('hex')
}
