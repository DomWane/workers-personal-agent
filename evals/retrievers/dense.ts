import { cosine } from '../lib/metrics.ts'
import type { Retriever } from './keyword.ts'

export function denseRetriever(
  ids: string[],
  vectors: Float32Array[],
  queryVec: (q: string) => Float32Array,
): Retriever {
  return {
    name: 'bge-m3',
    search(query, k) {
      const q = queryVec(query)
      // Mirrors production: an empty embedding would score every row 0 and return arbitrary hits.
      if (q.length === 0) {
        return []
      }
      return ids
        .map((id, i) => ({ id, score: cosine(q, vectors[i]) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map((s) => s.id)
    },
  }
}
