import { describe, expect, it } from 'vitest'
import { cosine, ndcgAtK, pairedBootstrap, recallAtK, reciprocalRank } from './metrics.ts'

describe('recallAtK', () => {
  it('is the share of relevant items found in the top k', () => {
    expect(recallAtK(['a', 'b', 'c'], ['a', 'c'], 3)).toBe(1)
    expect(recallAtK(['a', 'b', 'c'], ['a', 'z'], 3)).toBe(0.5)
    expect(recallAtK(['b', 'a'], ['a'], 1)).toBe(0)
  })

  it('is 0 when nothing is relevant rather than dividing by zero', () => {
    expect(recallAtK(['a'], [], 1)).toBe(0)
  })
})

describe('reciprocalRank', () => {
  it('is one over the rank of the first hit', () => {
    expect(reciprocalRank(['a', 'b'], ['a'])).toBe(1)
    expect(reciprocalRank(['x', 'a'], ['a'])).toBe(0.5)
    expect(reciprocalRank(['x', 'y'], ['a'])).toBe(0)
  })
})

describe('ndcgAtK', () => {
  it('matches a hand-computed value for a single hit at rank 2', () => {
    // DCG = 1/log2(3) = 0.63093; ideal DCG = 1/log2(2) = 1
    expect(ndcgAtK(['x', 'a'], ['a'], 3)).toBeCloseTo(0.63093, 4)
  })

  it('is 1 when all relevant items lead the ranking', () => {
    // DCG = 1/log2(2) + 1/log2(3) = ideal DCG for two relevant items
    expect(ndcgAtK(['a', 'b', 'x'], ['a', 'b'], 3)).toBeCloseTo(1, 6)
  })

  it('caps the ideal ranking at k', () => {
    expect(ndcgAtK(['a'], ['a', 'b', 'c'], 1)).toBeCloseTo(1, 6)
  })
})

/** The rejected alternative, kept only as the contrast the paired test asserts against. */
function unpairedBootstrap(a: number[], b: number[], resamples: number, seed: number) {
  let s = seed >>> 0
  const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296
  const draw = (xs: number[]) => {
    let sum = 0
    for (let i = 0; i < xs.length; i++) {
      sum += xs[Math.floor(rand() * xs.length)]
    }
    return sum / xs.length
  }
  const means = Array.from({ length: resamples }, () => draw(a) - draw(b)).sort((x, y) => x - y)
  return { lower: means[Math.floor(0.025 * resamples)], upper: means[Math.floor(0.975 * resamples)] }
}

describe('pairedBootstrap', () => {
  it('brackets a consistent improvement away from zero', () => {
    const a = Array.from({ length: 60 }, () => 0.4)
    const b = Array.from({ length: 60 }, () => 0.7)
    const { meanDiff, lower } = pairedBootstrap(b, a, 2000, 1)
    expect(meanDiff).toBeCloseTo(0.3, 6)
    expect(lower).toBeGreaterThan(0)
  })

  it('spans zero when the two systems only differ by noise', () => {
    const a = Array.from({ length: 60 }, (_, i) => (i % 2 ? 0.2 : 0.8))
    const b = Array.from({ length: 60 }, (_, i) => (i % 2 ? 0.8 : 0.2))
    const { lower, upper } = pairedBootstrap(b, a, 2000, 1)
    expect(lower).toBeLessThan(0)
    expect(upper).toBeGreaterThan(0)
  })

  it('separates a small consistent delta from large per-query variance', () => {
    // The zero-variance cases above would also pass under independent resampling, so they do
    // not actually pin the paired property. Here per-query difficulty swamps the delta: only
    // resampling the *pairs* keeps the difference visible.
    const base = Array.from({ length: 60 }, (_, i) => ((i * 37) % 90) / 100)
    const better = base.map((x) => x + 0.04)

    const { meanDiff, lower } = pairedBootstrap(better, base, 4000, 3)
    expect(meanDiff).toBeCloseTo(0.04, 6)
    expect(lower).toBeGreaterThan(0)

    // Same data, systems resampled independently: the interval swallows the effect.
    const unpaired = unpairedBootstrap(better, base, 4000, 3)
    expect(unpaired.lower).toBeLessThan(0)
    expect(unpaired.upper).toBeGreaterThan(0)
  })

  it('is deterministic for a given seed', () => {
    const a = [0.1, 0.5, 0.9, 0.2]
    const b = [0.3, 0.4, 0.8, 0.6]
    expect(pairedBootstrap(a, b, 500, 7)).toEqual(pairedBootstrap(a, b, 500, 7))
  })
})

describe('cosine', () => {
  it('is 1 for identical vectors and 0 for orthogonal ones', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6)
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6)
  })

  it('is 0 rather than NaN for a zero vector', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0)
  })

  it('throws on a dimension mismatch instead of scoring NaN', () => {
    expect(() => cosine([1, 2, 3], [1, 2])).toThrow(/dimension mismatch \(3 vs 2\)/)
    expect(() => cosine([1, 2], [1, 2, 3])).toThrow(/dimension mismatch/)
  })
})
