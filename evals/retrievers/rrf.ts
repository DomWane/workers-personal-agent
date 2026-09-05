import type { Retriever } from './keyword.ts'

/**
 * Reciprocal Rank Fusion over two or more retrievers. Fuses ranks rather than scores, because the
 * scores here are not comparable: BM25 returns an unbounded term-weight sum and the dense
 * retriever a cosine in [-1, 1]. Normalising those onto one scale requires assuming a
 * distribution; ranks require nothing.
 *
 * Cormack et al. 2009. score(d) = Σ w_i / (k + rank_i(d)), rank 1-based, missing lists skipped.
 */

/**
 * Damping constant from the original paper. Large relative to the ranks in play, so the gap
 * between rank 1 and rank 2 stays small and no single retriever can dominate the fusion by being
 * confident. Lowering it makes the fusion behave more like "whoever ranked it first wins".
 */
export const RRF_K = 60

export type Weighted = { retriever: Retriever; weight: number }

/**
 * `depth` is how far down each list is fused, not how many results come back. It has to exceed the
 * requested k: fusing only the top-k of each retriever throws away exactly the evidence that makes
 * fusion worth doing, namely a chunk both systems rank moderately rather than one ranking first.
 */
export function rrfRetriever(parts: Weighted[], opts: { depth?: number; name?: string; k?: number } = {}): Retriever {
  const depth = opts.depth ?? 20
  const k = opts.k ?? RRF_K
  return {
    name: opts.name ?? `rrf(${parts.map((p) => `${p.retriever.name}:${p.weight}`).join('+')})`,
    search(query, want) {
      const scores = new Map<string, number>()
      for (const { retriever, weight } of parts) {
        const ranked = retriever.search(query, depth)
        for (let i = 0; i < ranked.length; i++) {
          scores.set(ranked[i], (scores.get(ranked[i]) ?? 0) + weight / (k + i + 1))
        }
      }
      return [...scores.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, want)
        .map(([id]) => id)
    },
  }
}
