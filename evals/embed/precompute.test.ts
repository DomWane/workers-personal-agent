import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { packVectors, unpackVectors } from '../lib/vectors.ts'
import { corpusTextHash } from '../lib/corpus.ts'
import { canReuseCorpusVectors, queriesToEmbed } from './precompute.ts'

const chunk = (id: string, text: string) => ({ id, text, session: 's', ts: 't', project: 'p' })

// Importing precompute.ts must not fire a paid API call — main() is entrypoint-guarded, and
// this import is what would break if the guard were removed.
describe('canReuseCorpusVectors', () => {
  const chunks = [chunk('s:0', 'první text'), chunk('s:1', 'druhý text')]
  const meta = { dim: 3, ids: ['s:0', 's:1'], textHash: corpusTextHash(chunks) }

  it('reuses when the stored ids and chunk texts both match', () => {
    expect(canReuseCorpusVectors(chunks, { ...meta, maxChars: 1600 }, 1600)).toBe(true)
  })

  it('re-embeds when the truncation limit changed, which leaves the corpus text identical', () => {
    expect(canReuseCorpusVectors(chunks, { ...meta, maxChars: 1600 }, 3200)).toBe(false)
  })

  it('re-embeds an index written before the limit was recorded, rather than assuming it matched', () => {
    expect(canReuseCorpusVectors(chunks, meta, 1600)).toBe(false)
  })

  it('re-embeds when there is nothing stored', () => {
    expect(canReuseCorpusVectors(chunks, null)).toBe(false)
  })

  it('re-embeds when a re-ingest changed the chunk count', () => {
    expect(canReuseCorpusVectors([...chunks, chunk('s:2', 'třetí')], meta)).toBe(false)
  })

  it('re-embeds when the ids match as a set but not positionally', () => {
    // embeddings.bin is positional, so a reordered index would mislabel every vector.
    expect(canReuseCorpusVectors([chunks[1], chunks[0]], meta)).toBe(false)
  })

  it('re-embeds when the chunk text changed under unchanged ids', () => {
    // Ids are `session:index`, so an ingest-rule or ASSISTANT_CAP change rewrites every chunk
    // body while leaving every id identical. Ids alone cannot see this.
    const rewritten = [chunk('s:0', 'první text'), chunk('s:1', 'druhý text, jinak')]
    expect(canReuseCorpusVectors(rewritten, meta)).toBe(false)
  })

  it('re-embeds when the stored index predates the text hash', () => {
    expect(canReuseCorpusVectors(chunks, { dim: 3, ids: ['s:0', 's:1'] })).toBe(false)
  })
})

describe('queriesToEmbed', () => {
  it('only pays for queries with no usable vector', () => {
    const existing = { known: [1, 2, 3] }
    expect(queriesToEmbed(['known', 'hard'], existing, 3)).toEqual(['hard'])
  })

  it('re-embeds a stored vector of the wrong dimension', () => {
    expect(queriesToEmbed(['q'], { q: [1, 2] }, 3)).toEqual(['q'])
  })

  it('charges once for a query that appears in the labels twice', () => {
    expect(queriesToEmbed(['dup', 'dup'], {}, 3)).toEqual(['dup'])
  })
})

// Calls the same pack/unpack functions precompute.ts and run-retrieval.ts use, so a regression
// to either side's byte-offset handling fails here, not just a private copy of the old logic.
let dir: string

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('embeddings.bin round trip', () => {
  it('recovers the exact vectors written, in order, per id', () => {
    dir = mkdtempSync(join(tmpdir(), 'embed-roundtrip-'))
    const dim = 4
    const vectors = [
      [1, 2, 3, 4],
      [-1.5, 0, 100.25, -0.001],
      [0, 0, 0, 0],
    ]

    const binPath = join(dir, 'embeddings.bin')
    writeFileSync(binPath, packVectors(vectors, dim))

    const raw = readFileSync(binPath)
    const rebuiltVectors = unpackVectors(raw, dim, vectors.length)

    expect(rebuiltVectors).toHaveLength(3)
    for (let i = 0; i < vectors.length; i++) {
      expect(Array.from(rebuiltVectors[i])).toEqual(
        vectors[i].map((x) => Math.fround(x)), // Float32 precision, same rounding on both ends
      )
    }
  })
})
