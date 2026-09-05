import { parentOf } from '../lib/chunk.ts'
import type { Retriever } from './keyword.ts'

/**
 * Scores a chunked retriever against labels that name whole documents: fold `<parent>#<ord>` hits
 * back to their parent, keeping each parent's best rank, then take the top k.
 *
 * The fold has to happen before the cut, not after: five chunks of one long document would
 * otherwise fill the top five and the effective k would silently shrink. `depth` is therefore the
 * whole embedded corpus rather than a multiple of k — the inner retrievers all score every row and
 * slice at the end, so asking for everything costs nothing and removes the guess.
 */
export function byParent(inner: Retriever, depth: number, name = inner.name): Retriever {
  return {
    name,
    search(query, k) {
      const seen = new Set<string>()
      for (const id of inner.search(query, depth)) {
        seen.add(parentOf(id))
        if (seen.size === k) {
          break
        }
      }
      return [...seen]
    },
  }
}
