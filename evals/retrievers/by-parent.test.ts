import { describe, expect, it } from 'vitest'
import { byParent } from './by-parent.ts'
import type { Retriever } from './keyword.ts'

function fixed(ranked: string[]): Retriever & { asked: number[] } {
  const asked: number[] = []
  return {
    name: 'fixed',
    asked,
    search(_query, k) {
      asked.push(k)
      return ranked.slice(0, k)
    },
  }
}

describe('byParent', () => {
  it('folds chunk hits to their parent, keeping the best rank', () => {
    const r = byParent(fixed(['b#2', 'a#0', 'b#0', 'c#1']), 100)
    expect(r.search('q', 3)).toEqual(['b', 'a', 'c'])
  })

  it('folds before cutting, or one long document eats the whole top-k', () => {
    // Without the fold this returns three chunks of `a` and the effective k is 1.
    const r = byParent(fixed(['a#0', 'a#1', 'a#2', 'b#0', 'c#0']), 100)
    expect(r.search('q', 3)).toEqual(['a', 'b', 'c'])
  })

  it('asks the inner retriever for the whole corpus, not a multiple of k', () => {
    const inner = fixed(['a#0', 'b#0'])
    byParent(inner, 673).search('q', 10)
    expect(inner.asked).toEqual([673])
  })

  it('stops as soon as k distinct parents are found', () => {
    const r = byParent(fixed(['a#0', 'b#0', 'c#0', 'd#0']), 100)
    expect(r.search('q', 2)).toEqual(['a', 'b'])
  })

  it('passes unchunked ids through unchanged', () => {
    const r = byParent(fixed(['a', 'b']), 100)
    expect(r.search('q', 5)).toEqual(['a', 'b'])
  })
})
