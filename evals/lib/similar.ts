import type { Chunk } from './corpus.ts'
import { tokenize } from './tokenize.ts'

/**
 * Chunk-to-chunk similarity only. A query never enters this file: ranking chunks against the
 * query to suggest extra relevant ones would let the labeller inherit a retriever's opinion,
 * and the eval would then be scoring that retriever against its own suggestions.
 */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0
  }
  let shared = 0
  for (const t of a) {
    if (b.has(t)) {
      shared++
    }
  }
  return shared / (a.size + b.size - shared)
}

export type Neighbour = { chunk: Chunk; score: number }

/** The `limit` chunks most like `target`, best first, excluding the target itself. */
export function neighboursOf(target: Chunk, chunks: Chunk[], limit = 5): Neighbour[] {
  const mine = new Set(tokenize(target.text))
  return chunks
    .filter((c) => c.id !== target.id)
    .map((chunk) => ({ chunk, score: similarity(mine, new Set(tokenize(chunk.text))) }))
    .filter((n) => n.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/** Parses "1,3" into the picked neighbours, ignoring anything out of range. */
export function pickNeighbours(answer: string, neighbours: Neighbour[]): string[] {
  return answer
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= neighbours.length)
    .map((n) => neighbours[n - 1].chunk.id)
}
