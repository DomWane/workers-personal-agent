import { describe, expect, it } from 'vitest'
import type { Chunk } from '../lib/corpus.ts'
import { hitsFor, queryKey } from './hard.ts'

const chunk = (id: string, text: string, ts = '2026-07-01T00:00:00Z', project = 'ai-agent'): Chunk => ({
  id,
  text,
  session: 's',
  ts,
  project,
})

const corpus = [
  chunk('a', 'jak cachovat email', '2026-07-02T00:00:00Z'),
  chunk('b', 'neco o r2', '2026-06-02T00:00:00Z', 'acme-shop'),
]

describe('hitsFor', () => {
  it('marks word search and date/project browsing apart, so the runner can score them apart', () => {
    expect(hitsFor('cachovat', corpus)?.via).toBe('search')
    expect(hitsFor('/2026-06', corpus)?.via).toBe('browse')
    expect(hitsFor('/projekt acme', corpus)?.via).toBe('browse')
  })

  it('returns null when the labeller gives up rather than an empty hit list', () => {
    expect(hitsFor('.', corpus)).toBeNull()
    expect(hitsFor('', corpus)).toBeNull()
  })

  it('finds nothing for a term that is absent, without falling back to the whole corpus', () => {
    expect(hitsFor('neexistuje', corpus)?.hits).toEqual([])
  })

  it('passes the terms through so the preview can centre on the match', () => {
    expect(hitsFor('cachovat email', corpus)?.terms).toEqual(['cachovat', 'email'])
    expect(hitsFor('/2026-06', corpus)?.terms).toEqual([])
  })
})

describe('queryKey', () => {
  it('catches the same question typed with different accents, case and spacing', () => {
    expect(queryKey('Jak jsem řešil  cache?')).toBe(queryKey('jak jsem resil cache?'))
  })

  it('keeps genuinely different questions apart', () => {
    expect(queryKey('jak jsem řešil cache')).not.toBe(queryKey('jak jsem řešil embed'))
  })
})
