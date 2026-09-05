import { describe, expect, it } from 'vitest'
import type { Chunk } from '../lib/corpus.ts'
import { tokenize } from '../lib/tokenize.ts'
import { bm25Retriever } from './bm25.ts'
import { keywordRetriever } from './keyword.ts'

const mk = (id: string, text: string): Chunk => ({ id, text, session: 's', ts: 't', project: 'p' })
const corpus: Chunk[] = [
  mk('c1', 'Cache invalidace na Cloudflare Workers přes tag purge'),
  mk('c2', 'Workers KV je eventually consistent, čtení je rychlé'),
  mk('c3', 'Telegram bot odpovídá na zprávy pomocí webhooku'),
  mk('c4', 'Nákupní seznam: mléko, chléb, káva'),
]

describe('tokenize', () => {
  it('lowercases and folds Czech diacritics so a query typed without them still matches', () => {
    expect(tokenize('Příliš ŽLUŤOUČKÝ kůň')).toEqual(['prilis', 'zlutoucky', 'kun'])
  })

  it('splits on punctuation and drops one-character tokens', () => {
    expect(tokenize('mléko, chléb; a káva!')).toEqual(['mleko', 'chleb', 'kava'])
  })
})

describe('keywordRetriever', () => {
  it('mirrors production substring matching, case- and diacritics-insensitively', () => {
    const r = keywordRetriever(corpus)
    expect(r.search('cache', 3)).toContain('c1')
    expect(r.search('CACHE', 3)).toContain('c1')
    expect(r.search('kava', 3)).toContain('c4')
  })

  it('returns nothing when no token appears, rather than an arbitrary ranking', () => {
    expect(keywordRetriever(corpus).search('kvantová chromodynamika', 3)).toEqual([])
  })
})

describe('bm25Retriever', () => {
  it('ranks the chunk sharing the rarer term first', () => {
    const r = bm25Retriever(corpus)
    // "Workers" appears in c1 and c2; "KV" only in c2, so it should decide the order.
    expect(r.search('Workers KV', 2)[0]).toBe('c2')
  })

  it('respects k', () => {
    expect(bm25Retriever(corpus).search('Workers', 1)).toHaveLength(1)
  })

  it('returns nothing for a query with no shared vocabulary', () => {
    expect(bm25Retriever(corpus).search('kvantová chromodynamika', 3)).toEqual([])
  })
})
