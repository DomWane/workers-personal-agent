import { describe, expect, it } from 'vitest'
import type { Chunk } from '../lib/corpus.ts'
import { flagsFor, replyOf } from './prescreen.ts'

const mk = (text: string): Chunk => ({ id: 'c', text, session: 's', ts: 't', project: 'p' })
const long = 'a'.repeat(400)

describe('flagsFor', () => {
  it('flags a reply that only plans', () => {
    expect(flagsFor(mk(`otázka\n\nLet me first look at the code. ${long}`))).toContain('scaffolding')
  })

  it('does not flag a reply that plans and then concludes', () => {
    expect(flagsFor(mk(`otázka\n\nLet me check. The root cause is a late webhook. ${long}`))).not.toContain(
      'scaffolding',
    )
  })

  it('flags a completion notice', () => {
    expect(flagsFor(mk(`otázka\n\nHotovo, nasazeno.`))).toContain('status')
  })

  it('leaves an ordinary informative chunk unflagged', () => {
    const text = `Jak funguje cache invalidace?\n\nCache se invaliduje přes tag purge, protože ${long}`
    expect(flagsFor(mk(text))).toEqual([])
  })
})

describe('replyOf', () => {
  it('takes everything after the prompt half', () => {
    expect(replyOf('prompt\n\nodpověď\n\npokračování')).toBe('odpověď\n\npokračování')
  })
})

describe('flagsFor — sourced claims', () => {
  const sourced = (ts: string): Chunk => ({
    id: 'c',
    text: `kdo to je?\n\nJe to výzkumník a spoluzakladatel.\n\nZdroje: web_search (example.com, Crunchbase)`,
    session: 's',
    ts,
    project: 'p',
  })

  it('marks a sourced claim from before the search fix as a documented fabrication', () => {
    expect(flagsFor(sourced('2026-07-29T09:29:00Z'))).toContain('fabricated-era')
  })

  it('still asks for verification of a sourced claim made after the fix', () => {
    const flags = flagsFor(sourced('2026-07-30T09:00:00Z'))
    expect(flags).toContain('sourced')
    expect(flags).not.toContain('fabricated-era')
  })

  it('leaves a chunk about the author own code alone', () => {
    const text = `proč to padá?\n\nRoot cause je pozdní webhook, protože ${'a'.repeat(400)}`
    expect(flagsFor({ id: 'c', text, session: 's', ts: '2026-07-01T00:00:00Z', project: 'p' })).toEqual([])
  })
})

describe('flagsFor — planning that then answers', () => {
  const long = 'a'.repeat(400)

  it('does not flag a Czech plan followed by an English conclusion', () => {
    const text = `kam dam klice\n\nOvěřím konvenci. The pattern is clear now: secrets live on the store. ${long}`
    expect(flagsFor({ id: 'c', text, session: 's', ts: 't', project: 'p' })).not.toContain('scaffolding')
  })

  it('still flags a plan that never lands', () => {
    const text = `otázka\n\nOvěřím konvenci a pak se ozvu. ${long}`
    expect(flagsFor({ id: 'c', text, session: 's', ts: 't', project: 'p' })).toContain('scaffolding')
  })
})
