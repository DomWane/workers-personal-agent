import { describe, expect, it } from 'vitest'
import type { Retriever } from '../retrievers/keyword.ts'
import { buildPool, key, shuffleWithinQuery } from './pool.ts'

const fixed = (name: string, ids: string[]): Retriever => ({ name, search: (_q, k) => ids.slice(0, k) })

describe('buildPool', () => {
  const labels = [{ query: 'q1', relevant: ['known'] }]

  it('unions every retriever, so no system is credited with another system’s finds', () => {
    const pool = buildPool(labels, [fixed('a', ['x', 'y']), fixed('b', ['y', 'z'])], 2, new Set())
    expect(pool.map((p) => p.chunkId)).toEqual(['x', 'y', 'z'])
  })

  it('never re-offers the chunk that is already the label’s target', () => {
    const pool = buildPool(labels, [fixed('a', ['known', 'x'])], 2, new Set())
    expect(pool.map((p) => p.chunkId)).toEqual(['x'])
  })

  it('respects depth rather than taking everything a retriever returns', () => {
    const pool = buildPool(labels, [fixed('a', ['x', 'y', 'z'])], 2, new Set())
    expect(pool.map((p) => p.chunkId)).toEqual(['x', 'y'])
  })

  it('skips pairs already judged, including the ones judged not relevant', () => {
    const pool = buildPool(labels, [fixed('a', ['x', 'y'])], 2, new Set([key('q1', 'x')]))
    expect(pool.map((p) => p.chunkId)).toEqual(['y'])
  })

  it('judges a chunk per query, so the same chunk is still asked about for another query', () => {
    const two = [
      { query: 'q1', relevant: [] },
      { query: 'q2', relevant: [] },
    ]
    const pool = buildPool(two, [fixed('a', ['x'])], 1, new Set([key('q1', 'x')]))
    expect(pool).toEqual([{ query: 'q2', chunkId: 'x' }])
  })
})

describe('shuffleWithinQuery', () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map((chunkId) => ({ query: 'q1', chunkId }))

  it('reorders candidates, so their position carries no hint of which retriever ranked them', () => {
    expect(shuffleWithinQuery(items).map((i) => i.chunkId)).not.toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('keeps the same set and is deterministic, so an interrupted session resumes in its order', () => {
    const once = shuffleWithinQuery(items)
    expect(shuffleWithinQuery(items)).toEqual(once)
    expect(once.map((i) => i.chunkId).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('does not interleave queries, so the reviewer stays on one question at a time', () => {
    const mixed = [
      { query: 'q1', chunkId: 'a' },
      { query: 'q2', chunkId: 'b' },
      { query: 'q1', chunkId: 'c' },
    ]
    expect(shuffleWithinQuery(mixed).map((i) => i.query)).toEqual(['q1', 'q1', 'q2'])
  })
})
