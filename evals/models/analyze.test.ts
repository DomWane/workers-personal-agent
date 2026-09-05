import { describe, expect, it } from 'vitest'
import type { Run } from './compare.ts'
import { bootstrapMedian, firstPerPair, median, repeatSpreads, wilson } from './analyze.ts'

const run = (query: string, model: string, chars: number): Run => ({
  query,
  model,
  answer: 'x',
  reasoningTokens: null,
  reasoningChars: chars,
  completionTokens: 10,
  promptTokens: 20,
  latencyMs: 1,
  seed: 1,
  finishReason: 'stop',
  provider: null,
  generationId: null,
  contextIds: [],
})

describe('median', () => {
  it('averages the middle two on an even count', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([3, 1, 2])).toBe(2)
  })
})

describe('firstPerPair', () => {
  it('keeps the first run per model and question, so a duplicate is not counted twice', () => {
    const runs = [run('q', 'base', 100), run('q', 'base', 500), run('q', 'tuned', 50)]
    expect(firstPerPair(runs).map((r) => r.reasoningChars)).toEqual([100, 50])
  })
})

describe('repeatSpreads', () => {
  it('measures one model against itself on identical input, which is the noise floor', () => {
    const runs = [run('q', 'base', 100), run('q', 'base', 50), run('q', 'tuned', 80)]
    expect(repeatSpreads(runs)).toEqual([0.5])
  })

  it('is empty when nothing was run twice', () => {
    expect(repeatSpreads([run('q', 'base', 100)])).toEqual([])
  })
})

describe('bootstrapMedian', () => {
  it('is deterministic, so a reported interval can be reproduced', () => {
    const v = [0.1, 0.3, 0.5, 0.2, 0.4]
    expect(bootstrapMedian(v, 7, 500)).toEqual(bootstrapMedian(v, 7, 500))
  })

  it('brackets the sample median', () => {
    const v = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]
    const [lo, hi] = bootstrapMedian(v, 7, 2000)
    expect(lo).toBeLessThanOrEqual(median(v))
    expect(hi).toBeGreaterThanOrEqual(median(v))
  })
})

describe('wilson', () => {
  it('stays inside [0,1] where the normal approximation would not', () => {
    const [lo, hi] = wilson(12, 12)
    expect(lo).toBeGreaterThan(0)
    expect(hi).toBeLessThanOrEqual(1)
  })

  it('brackets a half-and-half split symmetrically around 0.5', () => {
    const [lo, hi] = wilson(10, 20)
    expect((lo + hi) / 2).toBeCloseTo(0.5, 10)
  })
})
