import type { Chunk } from './corpus.ts'
import { tokenize } from './tokenize.ts'

export function buildIdf(chunks: Chunk[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const c of chunks) {
    for (const t of new Set(tokenize(c.text))) {
      df.set(t, (df.get(t) ?? 0) + 1)
    }
  }
  const N = chunks.length || 1
  const idf = new Map<string, number>()
  for (const [t, n] of df) {
    idf.set(t, Math.log(N / n))
  }
  return idf
}

/**
 * Share of the chunk's rare-term weight that the query reuses. A query generated from a chunk
 * tends to inherit its vocabulary, which inflates lexical baselines and makes the task too easy.
 */
export function leakageScore(query: string, chunk: string, idf: Map<string, number>): number {
  const qTerms = new Set(tokenize(query))
  const cTerms = new Set(tokenize(chunk))
  let shared = 0
  let total = 0
  for (const t of cTerms) {
    const w = idf.get(t) ?? 0
    total += w
    if (qTerms.has(t)) {
      shared += w
    }
  }
  return total === 0 ? 0 : shared / total
}
