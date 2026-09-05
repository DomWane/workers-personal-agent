import { describe, expect, it } from 'vitest'
import type { Chunk } from './corpus.ts'
import { findByPeriod, findByProject, findByTerms, parseSearch, preview, replyPreview } from './find.ts'

const chunk = (id: string, text: string, ts = '2026-07-01T00:00:00Z', project = 'ai-agent'): Chunk => ({
  id,
  text,
  session: 's',
  ts,
  project,
})

describe('parseSearch', () => {
  it('reads plain words as search terms', () => {
    expect(parseSearch('cache email')).toEqual({ kind: 'terms', terms: ['cache', 'email'] })
  })

  it('reads a leading slash as a period and /projekt as a project', () => {
    expect(parseSearch('/2026-07')).toEqual({ kind: 'period', prefix: '2026-07' })
    expect(parseSearch('/projekt acme')).toEqual({ kind: 'project', name: 'acme' })
  })

  it('treats an empty answer and a lone dot as giving up', () => {
    expect(parseSearch('')).toEqual({ kind: 'give-up' })
    expect(parseSearch(' . ')).toEqual({ kind: 'give-up' })
  })
})

describe('findByTerms', () => {
  it('matches without diacritics in either direction', () => {
    const chunks = [chunk('a', 'řešení účtu'), chunk('b', 'neco jineho')]
    expect(findByTerms(chunks, ['ucet']).map((c) => c.id)).toEqual([])
    expect(findByTerms(chunks, ['uctu']).map((c) => c.id)).toEqual(['a'])
    expect(findByTerms([chunk('c', 'resim ucet')], ['účet']).map((c) => c.id)).toEqual(['c'])
  })

  it('requires every term, not any', () => {
    const chunks = [chunk('a', 'cache a email'), chunk('b', 'jen cache')]
    expect(findByTerms(chunks, ['cache', 'email']).map((c) => c.id)).toEqual(['a'])
  })

  it('searches the project field too, so a project name finds its chunks', () => {
    expect(findByTerms([chunk('a', 'nic', '2026-07-01T00:00:00Z', 'acme-shop')], ['acme']).map((c) => c.id)).toEqual([
      'a',
    ])
  })

  it('returns hits chronologically — no relevance order, so no retriever opinion leaks in', () => {
    const chunks = [
      chunk('late', 'cache cache cache cache', '2026-07-20T00:00:00Z'),
      chunk('early', 'cache once', '2026-07-01T00:00:00Z'),
    ]
    // The term-dense chunk would top any ranked list; here it stays second.
    expect(findByTerms(chunks, ['cache']).map((c) => c.id)).toEqual(['early', 'late'])
  })

  it('sorts an undated chunk last instead of letting it head the list', () => {
    const chunks = [chunk('undated', 'cache', ''), chunk('dated', 'cache', '2026-07-01T00:00:00Z')]
    expect(findByTerms(chunks, ['cache']).map((c) => c.id)).toEqual(['dated', 'undated'])
  })

  it('returns nothing for an empty term list rather than the whole corpus', () => {
    expect(findByTerms([chunk('a', 'cokoliv')], [])).toEqual([])
    expect(findByTerms([chunk('a', 'cokoliv')], ['  '])).toEqual([])
  })
})

describe('findByPeriod / findByProject', () => {
  it('matches a timestamp prefix', () => {
    const chunks = [chunk('a', 'x', '2026-07-30T10:00:00Z'), chunk('b', 'x', '2026-06-30T10:00:00Z')]
    expect(findByPeriod(chunks, '2026-07').map((c) => c.id)).toEqual(['a'])
  })

  it('matches a project substring, folded', () => {
    expect(findByProject([chunk('a', 'x', '2026-07-01T00:00:00Z', 'AI-Agent')], 'ai-ag').map((c) => c.id)).toEqual([
      'a',
    ])
  })

  it('returns nothing for an empty prefix or name', () => {
    expect(findByPeriod([chunk('a', 'x')], '')).toEqual([])
    expect(findByProject([chunk('a', 'x')], ' ')).toEqual([])
  })
})

describe('preview', () => {
  it('centres the window on the first hit instead of showing the identical opening', () => {
    const text = `${'a'.repeat(400)} JEHLA ${'b'.repeat(400)}`
    const out = preview(text, ['jehla'], 60)
    expect(out).toContain('JEHLA')
    expect(out.startsWith('…')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
  })

  it('falls back to the head when no term matches, and does not pad a short chunk', () => {
    expect(preview('krátký text', ['chybí'], 60)).toBe('krátký text')
  })

  it('collapses newlines so a hit stays on one line', () => {
    expect(preview('prvni\n\ndruhy', ['druhy'], 60)).toBe('prvni druhy')
  })
})

describe('replyPreview', () => {
  it('shows the reply, because the prompt is often "y" and identifies nothing', () => {
    const out = replyPreview('y\n\nZahodím BE commit a přidám varování před odesláním.')
    expect(out).toContain('Zahodím BE commit')
    expect(out.startsWith('y →')).toBe(true)
  })

  it('falls back to the whole text when there is no reply to split off', () => {
    expect(replyPreview('jen jeden odstavec')).toBe('jen jeden odstavec')
  })
})
