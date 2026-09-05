import type { Chunk } from '../lib/corpus.ts'
import { cosine } from '../lib/metrics.ts'
import { tokenize } from '../lib/tokenize.ts'
import type { Retriever } from './keyword.ts'

/**
 * Static word vectors averaged into a document vector — the pre-transformer way to do semantic
 * retrieval, and the point of comparison for what a contextual multilingual model actually buys.
 *
 * Weighted by IDF rather than plain mean: an unweighted average is dominated by the words every
 * chunk contains, so two documents about different subjects end up near each other because both
 * are made of Czech function words. IDF gives the weight to the words that distinguish them.
 *
 * Out-of-vocabulary words are skipped rather than zero-filled. A zero vector is not "no
 * information" — averaged in, it pulls every document toward the origin by an amount that depends
 * on how many words happen to be missing, which is a length artefact rather than a meaning.
 */
export function fasttextRetriever(
  chunks: Chunk[],
  vectors: Record<string, number[]>,
  dim: number,
  name = 'fasttext',
): Retriever {
  const df = new Map<string, number>()
  const docTokens = chunks.map((c) => tokenize(c.text))
  for (const terms of docTokens) {
    for (const t of new Set(terms)) {
      df.set(t, (df.get(t) ?? 0) + 1)
    }
  }
  const N = chunks.length
  const idf = (t: string) => Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5))

  function embed(terms: string[]): Float32Array | null {
    const out = new Float32Array(dim)
    let total = 0
    for (const t of terms) {
      const v = vectors[t]
      if (!v) {
        continue
      }
      const w = idf(t)
      for (let i = 0; i < dim; i++) {
        out[i] += v[i] * w
      }
      total += w
    }
    // Every word was out of vocabulary: there is nothing to compare, and returning a zero vector
    // would score identically against everything rather than saying so.
    if (total === 0) {
      return null
    }
    for (let i = 0; i < dim; i++) {
      out[i] /= total
    }
    return out
  }

  const docVectors = docTokens.map(embed)

  return {
    name,
    search(query, k) {
      const q = embed(tokenize(query))
      if (!q) {
        return []
      }
      return docVectors
        .map((v, i) => ({ id: chunks[i].id, score: v ? cosine(q, v) : -1 }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map((s) => s.id)
    },
  }
}
