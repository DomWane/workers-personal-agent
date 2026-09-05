import { describe, expect, it } from 'vitest'
import { denseRetriever } from './dense.ts'

const vecs = [new Float32Array([1, 0, 0]), new Float32Array([0, 1, 0]), new Float32Array([0.9, 0.1, 0])]

describe('denseRetriever', () => {
  it('ranks by cosine similarity to the query vector', () => {
    const r = denseRetriever(['a', 'b', 'c'], vecs, () => new Float32Array([1, 0, 0]))
    expect(r.search('anything', 2)).toEqual(['a', 'c'])
  })

  it('returns nothing for an empty query embedding instead of an arbitrary ranking', () => {
    const r = denseRetriever(['a', 'b', 'c'], vecs, () => new Float32Array([]))
    expect(r.search('anything', 3)).toEqual([])
  })

  it('respects k', () => {
    const r = denseRetriever(['a', 'b', 'c'], vecs, () => new Float32Array([1, 0, 0]))
    expect(r.search('q', 1)).toEqual(['a'])
  })
})
