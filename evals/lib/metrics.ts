export function recallAtK(ranked: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) {
    return 0
  }
  const top = new Set(ranked.slice(0, k))
  const found = relevant.filter((r) => top.has(r)).length
  return found / relevant.length
}

export function reciprocalRank(ranked: string[], relevant: string[]): number {
  const rel = new Set(relevant)
  const i = ranked.findIndex((id) => rel.has(id))
  return i === -1 ? 0 : 1 / (i + 1)
}

export function ndcgAtK(ranked: string[], relevant: string[], k: number): number {
  const rel = new Set(relevant)
  let dcg = 0
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (rel.has(ranked[i])) {
      dcg += 1 / Math.log2(i + 2)
    }
  }
  let ideal = 0
  for (let i = 0; i < Math.min(k, relevant.length); i++) {
    ideal += 1 / Math.log2(i + 2)
  }
  return ideal === 0 ? 0 : dcg / ideal
}

/** Deterministic PRNG so a reported interval can be reproduced exactly. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let x = Math.imul(t ^ (t >>> 15), 1 | t)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Paired on purpose: the same queries score both systems, so resampling queries rather than
 * systems is what isolates the difference from per-query difficulty.
 */
export function pairedBootstrap(
  a: number[],
  b: number[],
  resamples = 10_000,
  seed = 1,
): { meanDiff: number; lower: number; upper: number } {
  if (a.length !== b.length) {
    throw new Error('paired bootstrap needs equal-length inputs')
  }
  const n = a.length
  const diffs = a.map((v, i) => v - b[i])
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
  const rand = mulberry32(seed)

  const means: number[] = []
  for (let r = 0; r < resamples; r++) {
    let sum = 0
    for (let i = 0; i < n; i++) {
      sum += diffs[Math.floor(rand() * n)]
    }
    means.push(sum / n)
  }
  means.sort((x, y) => x - y)
  return {
    meanDiff: mean(diffs),
    lower: means[Math.floor(0.025 * resamples)],
    upper: means[Math.floor(0.975 * resamples)],
  }
}

/** Duplicated from src/agent/memory/embedding-index.ts: importing it would drag a bundler in. */
export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  // A short vector would otherwise read undefined past its end and score NaN, which sorts
  // arbitrarily and turns a stale embeddings file into a plausible-looking wrong number.
  if (a.length !== b.length) {
    throw new Error(`cosine: dimension mismatch (${a.length} vs ${b.length})`)
  }
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) {
    return 0
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
