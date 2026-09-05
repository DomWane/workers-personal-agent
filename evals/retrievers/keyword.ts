import type { Chunk } from '../lib/corpus.ts'
import { tokenize } from '../lib/tokenize.ts'

export type Retriever = { name: string; search(query: string, k: number): string[] }

/**
 * Mirrors the agent's keyword fallback (case-insensitive substring), which is the baseline
 * embeddings have to beat to justify their cost. Kept here rather than imported: src modules
 * use extensionless imports Node cannot resolve.
 */
export function keywordRetriever(chunks: Chunk[]): Retriever {
  const folded = chunks.map((c) => ({ id: c.id, hay: tokenize(c.text).join(' ') }))
  return {
    name: 'keyword',
    search(query, k) {
      const terms = tokenize(query)
      if (terms.length === 0) {
        return []
      }
      return folded
        .map((c) => ({ id: c.id, hits: terms.filter((t) => c.hay.includes(t)).length }))
        .filter((c) => c.hits > 0)
        .sort((a, b) => b.hits - a.hits)
        .slice(0, k)
        .map((c) => c.id)
    },
  }
}
