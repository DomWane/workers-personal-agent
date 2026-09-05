import type { Chunk } from '../lib/corpus.ts'
import { tokenize } from '../lib/tokenize.ts'
import type { Retriever } from './keyword.ts'

const K1 = 1.2
const B = 0.75

/**
 * The tokenizer is a parameter so a stemmed variant is the same retriever over different terms —
 * anything else would compare two implementations rather than the one thing under test.
 */
export function bm25Retriever(
  chunks: Chunk[],
  opts: { name?: string; tokenizer?: (text: string) => string[] } = {},
): Retriever {
  const { name = 'bm25', tokenizer = tokenize } = opts
  const docs = chunks.map((c) => ({ id: c.id, terms: tokenizer(c.text) }))
  const avgLen = docs.reduce((s, d) => s + d.terms.length, 0) / (docs.length || 1)

  const df = new Map<string, number>()
  const tf: Array<Map<string, number>> = docs.map((d) => {
    const counts = new Map<string, number>()
    for (const t of d.terms) {
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    for (const t of counts.keys()) {
      df.set(t, (df.get(t) ?? 0) + 1)
    }
    return counts
  })

  const N = docs.length
  return {
    name,
    search(query, k) {
      const terms = tokenizer(query)
      const scored = docs.map((d, i) => {
        let score = 0
        for (const t of terms) {
          const f = tf[i].get(t)
          if (!f) {
            continue
          }
          const n = df.get(t) ?? 0
          const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
          const norm = f + K1 * (1 - B + (B * d.terms.length) / avgLen)
          score += idf * ((f * (K1 + 1)) / norm)
        }
        return { id: d.id, score }
      })
      return scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map((s) => s.id)
    },
  }
}
