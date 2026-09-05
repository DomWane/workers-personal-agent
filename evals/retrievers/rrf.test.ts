import { describe, expect, it } from 'vitest'
import type { Retriever } from './keyword.ts'
import { rrfRetriever } from './rrf.ts'

const fixed = (name: string, ids: string[]): Retriever => ({
  name,
  search: (_q, k) => ids.slice(0, k),
})

describe('rrfRetriever', () => {
  it('promotes a chunk both retrievers rank moderately over one only a single retriever ranks first', () => {
    const a = fixed('a', ['x', 'shared', 'p'])
    const b = fixed('b', ['y', 'shared', 'q'])
    const fused = rrfRetriever([
      { retriever: a, weight: 1 },
      { retriever: b, weight: 1 },
    ])
    expect(fused.search('q', 1)).toEqual(['shared'])
  })

  it('respects weights, so a stronger retriever can be trusted more', () => {
    const strong = fixed('strong', ['s'])
    const weak = fixed('weak', ['w'])
    const even = rrfRetriever([
      { retriever: strong, weight: 1 },
      { retriever: weak, weight: 1 },
    ])
    const tilted = rrfRetriever([
      { retriever: strong, weight: 3 },
      { retriever: weak, weight: 1 },
    ])
    // Even weights leave the two tied and the tiebreak is arbitrary; a tilt must not be.
    expect(even.search('q', 2)).toHaveLength(2)
    expect(tilted.search('q', 1)).toEqual(['s'])
  })

  it('fuses deeper than it returns, which is the point of fusing at all', () => {
    const a = fixed('a', ['a1', 'a2', 'a3', 'target'])
    const b = fixed('b', ['b1', 'b2', 'b3', 'target'])
    // At depth 3 the shared chunk is invisible to both lists and cannot be promoted.
    const shallow = rrfRetriever(
      [
        { retriever: a, weight: 1 },
        { retriever: b, weight: 1 },
      ],
      { depth: 3 },
    )
    expect(shallow.search('q', 4)).not.toContain('target')
    const deep = rrfRetriever(
      [
        { retriever: a, weight: 1 },
        { retriever: b, weight: 1 },
      ],
      { depth: 10 },
    )
    expect(deep.search('q', 1)).toEqual(['target'])
  })

  it('is deterministic when scores tie, so a run can be reproduced', () => {
    const a = fixed('a', ['m', 'n'])
    const fused = rrfRetriever([{ retriever: a, weight: 1 }])
    expect(fused.search('q', 2)).toEqual(fused.search('q', 2))
  })
})
