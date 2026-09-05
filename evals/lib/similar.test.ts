import { describe, expect, it } from 'vitest'
import type { Chunk } from './corpus.ts'
import { neighboursOf, pickNeighbours, similarity } from './similar.ts'

const mk = (id: string, text: string): Chunk => ({ id, text, session: 's', ts: 't', project: 'p' })

describe('similarity', () => {
  it('is 1 for identical sets, 0 for disjoint, 0 for empty', () => {
    expect(similarity(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1)
    expect(similarity(new Set(['a']), new Set(['b']))).toBe(0)
    expect(similarity(new Set(), new Set(['a']))).toBe(0)
  })
})

describe('neighboursOf', () => {
  const target = mk('t', 'cache invalidace přes tag purge na Cloudflare Workers')
  const corpus = [
    target,
    mk('near', 'cache invalidace na Cloudflare Workers přes purge tagu'),
    mk('far', 'nákupní seznam mléko chléb káva'),
  ]

  it('ranks the topically close chunk first and excludes the target', () => {
    const out = neighboursOf(target, corpus)
    expect(out.map((n) => n.chunk.id)).not.toContain('t')
    expect(out[0].chunk.id).toBe('near')
  })

  it('drops chunks sharing nothing rather than padding the list', () => {
    expect(neighboursOf(target, corpus).map((n) => n.chunk.id)).not.toContain('far')
  })
})

describe('pickNeighbours', () => {
  const ns = [
    { chunk: mk('a', 'x'), score: 0.3 },
    { chunk: mk('b', 'y'), score: 0.2 },
  ]

  it('maps typed numbers to chunk ids', () => {
    expect(pickNeighbours('1,2', ns)).toEqual(['a', 'b'])
  })

  it('ignores blanks and out-of-range input rather than guessing', () => {
    expect(pickNeighbours('', ns)).toEqual([])
    expect(pickNeighbours('3, x, 0', ns)).toEqual([])
  })
})
