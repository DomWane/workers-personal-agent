import type { ResearchState } from '@/types'

/**
 * `visited` is every URL a request was spent on; `read` is the ones that produced content. The card
 * printed the first under the word "read", so a run losing half its pages to a provider's rate
 * limit looked like a thorough one.
 *
 * `read` is absent only in a seeded fixture, and absent is **unknown, not zero** — zero would
 * report every page as lost.
 */
export function pageCounts(research: ResearchState): { label: string; lost: number } {
  const { visited, read } = research
  return read === undefined
    ? { label: `${visited.length} pages`, lost: 0 }
    : { label: `${read} pages read`, lost: visited.length - read }
}
