import type { RerankRow } from '../embed/rerank-precompute.ts'
import type { Retriever } from './keyword.ts'

/**
 * Serves the precomputed cross-encoder ordering. Fails closed on a query it has no row for rather
 * than returning nothing: an empty result would score as a miss and read as the reranker being
 * bad, when the real cause is a stale precompute.
 */
export function rerankRetriever(rows: RerankRow[], name = 'rerank'): Retriever {
  const byQuery = new Map(rows.map((r) => [r.query, r.ranked]))
  return {
    name,
    search(query, k) {
      const ranked = byQuery.get(query)
      if (!ranked) {
        throw new Error(`no reranked order for query: ${query.slice(0, 60)} — rerun eval:rerank`)
      }
      return ranked.slice(0, k)
    },
  }
}
