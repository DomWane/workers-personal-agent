import { describe, expect, it } from 'vitest'
import { corpusTextHash } from './lib/corpus.ts'
import type { Chunk } from './lib/corpus.ts'
import { assertDenseInputsFresh, fmt, partitionLabels, score, type Labelled } from './run-retrieval.ts'
import type { Retriever } from './retrievers/keyword.ts'

const chunk = (id: string, text: string) => ({ id, text, session: 's', ts: 't', project: 'p' })
const chunks = [chunk('s:0', 'první text'), chunk('s:1', 'druhý text')]
const meta = { dim: 3, ids: ['s:0', 's:1'], textHash: corpusTextHash(chunks) }
const qv = { a: [1, 0, 0], b: [0, 1, 0] }

describe('assertDenseInputsFresh', () => {
  it('accepts a matching corpus and a full set of query vectors', () => {
    expect(() => assertDenseInputsFresh(chunks, meta, ['a', 'b'], qv)).not.toThrow()
  })

  it('throws when the corpus was re-ingested and the ids were renumbered', () => {
    expect(() => assertDenseInputsFresh([...chunks, chunk('s:2', 'třetí')], meta, ['a', 'b'], qv)).toThrow(
      /does not match the corpus[\s\S]*re-run pnpm eval:embed/,
    )
  })

  it('throws when an embedded id is no longer in the corpus', () => {
    expect(() => assertDenseInputsFresh([chunks[0]], meta, ['a', 'b'], qv)).toThrow(/re-run pnpm eval:embed/)
  })

  it('throws when a labelled query was appended after the last embed run', () => {
    // The exact hard-set trigger: the query scores 0 everywhere and reads as a real collapse.
    expect(() => assertDenseInputsFresh(chunks, meta, ['a', 'b', 'hard'], qv)).toThrow(
      /1\/3 labelled queries have no vector of dim 3[\s\S]*re-run pnpm eval:embed/,
    )
  })

  it('throws when the chunk text changed under unchanged ids', () => {
    // An ingest-rule or ASSISTANT_CAP change rewrites every chunk body and leaves every id
    // identical, so an id-only check would pass and bge-m3 would be scored against text that
    // no longer exists — silently, which is the whole failure class this assertion exists for.
    const rewritten = [chunks[0], chunk('s:1', 'druhý text, jinak')]
    expect(() => assertDenseInputsFresh(rewritten, meta, ['a', 'b'], qv)).toThrow(
      /chunk text[\s\S]*re-run pnpm eval:embed/,
    )
  })

  it('throws when the stored index predates the text hash', () => {
    expect(() => assertDenseInputsFresh(chunks, { dim: 3, ids: ['s:0', 's:1'] }, ['a', 'b'], qv)).toThrow(
      /re-run pnpm eval:embed/,
    )
  })

  it('throws when a query vector has the wrong dimension', () => {
    expect(() => assertDenseInputsFresh(chunks, meta, ['a'], { a: [1, 0] })).toThrow(/no vector of dim 3/)
  })
})

const stub = (name: string, hits: Record<string, string[]>): Retriever => ({
  name,
  search: (q) => hits[q] ?? [],
})

describe('score', () => {
  it('returns perQuery aligned to the items it was given, so two retrievers stay comparable', () => {
    const items: Labelled[] = [
      { query: 'q0', relevant: ['a'], kind: 'bulk' },
      { query: 'q1', relevant: ['b'], kind: 'bulk' },
      { query: 'q2', relevant: ['c'], kind: 'bulk' },
    ]
    const one = score(stub('one', { q0: ['a'], q1: ['z'], q2: ['c'] }), items)
    const two = score(stub('two', { q0: ['z'], q1: ['b'], q2: ['c'] }), items)

    // The paired bootstrap subtracts index-wise: position i must be query i for both.
    expect(one.perQuery).toEqual([1, 0, 1])
    expect(two.perQuery).toEqual([0, 1, 1])
    expect(one.perQuery).toHaveLength(items.length)
    expect(two.perQuery).toHaveLength(items.length)
    expect(one.row.r3).toBeCloseTo(2 / 3, 6)
  })

  it('measures each item once, in order, even when queries repeat', () => {
    const items: Labelled[] = [
      { query: 'dup', relevant: ['a'], kind: 'bulk' },
      { query: 'dup', relevant: ['z'], kind: 'bulk' },
    ]
    expect(score(stub('one', { dup: ['a'] }), items).perQuery).toEqual([1, 0])
  })
})

describe('fmt', () => {
  it('marks a sub-10 sample and never emits a bare percentage for it', () => {
    expect(fmt(0.5, 9)).toBe('0.50*')
    expect(fmt(0.5, 1)).toMatch(/\*$/)
    expect(fmt(0, 9)).toMatch(/\*$/)
  })

  it('emits a plain three-decimal figure once the sample reaches 10', () => {
    expect(fmt(0.5, 10)).toBe('0.500')
    expect(fmt(0.5, 60)).not.toMatch(/\*/)
  })
})

describe('stale labels', () => {
  const mk = (id: string, text: string): Chunk => ({ id, text, session: 's', ts: 't', project: 'p' })

  it('drops labels whose chunk no longer exists instead of scoring them as misses', () => {
    const chunks = [mk('aaa', 'cache invalidace'), mk('bbb', 'workers kv')]
    const labels: Labelled[] = [
      { query: 'cache', relevant: ['aaa'], kind: 'bulk' },
      { query: 'zmizelý', relevant: ['ccc'], kind: 'bulk' },
    ]
    const { usable, stale } = partitionLabels(labels, chunks)
    expect(usable.map((l) => l.query)).toEqual(['cache'])
    expect(stale).toBe(1)
  })
})
