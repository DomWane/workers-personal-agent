import { describe, expect, it } from 'vitest'
import type { Chunk } from './corpus.ts'
import { buildIdf, leakageScore } from './leakage.ts'

const mk = (id: string, text: string): Chunk => ({ id, text, session: 's', ts: 't', project: 'p' })
const corpus = [
  mk('c1', 'cache invalidace přes tag purge na Cloudflare'),
  mk('c2', 'cache je rychlá'),
  mk('c3', 'cache a KV'),
  mk('c4', 'nákupní seznam'),
]
const idf = buildIdf(corpus)

describe('leakageScore', () => {
  it('is high when the query reuses the rare terms of its chunk', () => {
    const s = leakageScore('tag purge invalidace Cloudflare', corpus[0].text, idf)
    expect(s).toBeGreaterThan(0.5)
  })

  it('is low for a paraphrase that shares only common words', () => {
    const s = leakageScore('jak jsme řešili mazání uložených dat', corpus[0].text, idf)
    expect(s).toBeLessThan(0.3)
  })

  it('ignores terms that are common across the corpus', () => {
    // "cache" is in 3 of 4 chunks, so reusing it alone must not count as leakage.
    expect(leakageScore('cache', corpus[0].text, idf)).toBeLessThan(0.3)
  })
})
