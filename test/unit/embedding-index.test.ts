import { env, runInDurableObject } from 'cloudflare:test'
import { getAgentByName } from 'agents'
import { describe, expect, it } from 'vitest'
import {
  chunkForEmbedding,
  cosineSimilarity,
  deserializeVec,
  EmbeddingIndex,
  reindexInto,
  serializeVec,
} from '@/agent/memory/embedding-index'
import type { SqlTag } from '@/agent/memory/embedding-index'
import type { PersonalAgent } from '@/agent/personal-agent'
import type { Env } from '@/types'

describe('cosineSimilarity', () => {
  it('is 1 for identical, 0 for orthogonal, and handles zero vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})

describe('vec (de)serialization', () => {
  it('round-trips a float vector through bytes', () => {
    const v = [0.5, -0.25, 1, 0]
    const back = deserializeVec(serializeVec(v))
    expect(Array.from(back)).toEqual(v)
  })
})

// A fake embedder: map text to a tiny vector by keyword so similarity is predictable.
const fakeEmbed = async (t: string): Promise<number[]> => {
  const s = t.toLowerCase()
  return [s.includes('tea') ? 1 : 0, s.includes('coffee') ? 1 : 0, s.includes('vienna') ? 1 : 0]
}

describe('chunkForEmbedding', () => {
  it('leaves a short text whole', () => {
    expect(chunkForEmbedding('short')).toEqual(['short'])
  })

  it('covers a long text with overlapping windows, so no cut loses its sentence', () => {
    const text = 'x'.repeat(4000)
    const chunks = chunkForEmbedding(text)
    expect(chunks.length).toBe(3)
    expect(chunks[0].length).toBe(1600)
    // Each window starts 200 chars before the previous one ended.
    expect(chunks.at(-1)).toBe(text.slice(2800))
  })

  it('emits no trailing window that is pure overlap', () => {
    // 3000 chars: 0-1600, 1400-3000, and nothing after — a third step would re-emit seen text.
    expect(chunkForEmbedding('x'.repeat(3000))).toHaveLength(2)
  })
})

describe('EmbeddingIndex over real DO SQLite', () => {
  it('gives a long file one row per chunk and ranks it by its best one', async () => {
    const stub = await getAgentByName((env as Env).PERSONAL_AGENT, `idx-${crypto.randomUUID()}`)
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      const index = new EmbeddingIndex((agent.sql as unknown as SqlTag).bind(agent), fakeEmbed)
      // 'vienna' sits past char 1600, where a single head-truncated vector would never see it.
      await index.upsert('memory', 'long', `${'filler. '.repeat(300)}a trip to Vienna`)
      await index.upsert('memory', 'short', 'Sam likes tea')

      expect(await index.count()).toBe(3)
      const hits = await index.search('vienna', 5)
      expect(hits[0]).toMatchObject({ kind: 'memory', slug: 'long' })
      // Folded to one row per file: the long file must not occupy two of the five slots.
      expect(hits.filter((h) => h.slug === 'long')).toHaveLength(1)
    })
  })

  it('drops the old tail when a file shrinks, so stale chunks stop matching', async () => {
    const stub = await getAgentByName((env as Env).PERSONAL_AGENT, `idx-${crypto.randomUUID()}`)
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      const index = new EmbeddingIndex((agent.sql as unknown as SqlTag).bind(agent), fakeEmbed)
      await index.upsert('memory', 'a', `${'filler. '.repeat(300)}coffee`)
      expect(await index.count()).toBe(2)
      await index.upsert('memory', 'a', 'tea')
      expect(await index.count()).toBe(1)
      // `search` has no score floor — it always returns up to `limit` rows — so the evidence that
      // the coffee chunk is gone is that nothing scores against it any more.
      expect((await index.search('coffee', 5))[0]?.score).toBe(0)
    })
  })

  it('treats vectors built under a different split as stale, even at the same etag', async () => {
    const stub = await getAgentByName((env as Env).PERSONAL_AGENT, `idx-${crypto.randomUUID()}`)
    await runInDurableObject(stub, async (agent: PersonalAgent, state: DurableObjectState) => {
      const index = new EmbeddingIndex((agent.sql as unknown as SqlTag).bind(agent), fakeEmbed)
      await index.upsert('memory', 'a', 'tea', 'etag-1')
      expect(await index.fingerprints()).toEqual(new Map([['memory:a', 'etag-1']]))

      // A chunk-size change leaves every vault etag untouched, so without the split in the stored
      // stamp the reconcile would report the file unchanged and keep vectors from the old split.
      state.storage.sql.exec(`UPDATE memory_vectors SET sha = 'etag-1@9999:0'`)
      expect(await index.fingerprints()).toEqual(new Map([['memory:a', '']]))
    })
  })

  it('reports one fingerprint per file, not one per chunk', async () => {
    const stub = await getAgentByName((env as Env).PERSONAL_AGENT, `idx-${crypto.randomUUID()}`)
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      const index = new EmbeddingIndex((agent.sql as unknown as SqlTag).bind(agent), fakeEmbed)
      await index.upsert('memory', 'a', 'x'.repeat(4000), 'sha-a')
      expect(await index.count()).toBe(3)
      expect(await index.fingerprints()).toEqual(new Map([['memory:a', 'sha-a']]))
    })
  })

  it('upserts, ranks by cosine, counts, and removes', async () => {
    const stub = await getAgentByName((env as Env).PERSONAL_AGENT, `idx-${crypto.randomUUID()}`)
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      // Agent.sql's values are typed narrower (string|number|boolean|null) than SqlTag's
      // unknown[] (which must also accept the Uint8Array BLOB param); cast only this access.
      const index = new EmbeddingIndex((agent.sql as unknown as SqlTag).bind(agent), fakeEmbed)
      await index.upsert('memory', 'sam-likes-tea', 'Sam likes tea, green tea')
      await index.upsert('memory', 'vienna-trip', 'planning a trip to Vienna')
      expect(await index.count()).toBe(2)

      const hits = await index.search('what hot drink does he prefer? tea', 2)
      expect(hits[0].slug).toBe('sam-likes-tea')

      await index.remove('memory', 'sam-likes-tea')
      expect(await index.count()).toBe(1)

      await index.upsert('memory', 'coffee-note', 'Sam also drinks coffee', 'sha-1')
      expect(await index.count()).toBe(2)
      const after = await index.search('coffee', 1)
      expect(after[0].slug).toBe('coffee-note')

      // Only rows written with a fingerprint can be skipped on the next reconcile.
      expect(await index.fingerprints()).toEqual(
        new Map([
          ['memory:vienna-trip', ''],
          ['memory:coffee-note', 'sha-1'],
        ]),
      )
    })
  })

  it('falls back to empty results when the query embeds to a dataless vector', async () => {
    const stub = await getAgentByName((env as Env).PERSONAL_AGENT, `idx-${crypto.randomUUID()}`)
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      const emptyEmbed = async (): Promise<number[]> => []
      const index = new EmbeddingIndex((agent.sql as unknown as SqlTag).bind(agent), emptyEmbed)
      await index.upsert('memory', 'some-note', 'anything at all')

      const hits = await index.search('anything', 5)
      expect(hits).toEqual([])
    })
  })
})

describe('reindexInto', () => {
  type Manifest = Array<{ kind: 'memory' | 'session'; slug: string; sha: string }>

  // Keys are `kind:slug` because that, not the slug, is what identifies a vault entry.
  function fakeIndex(initial: Array<[string, string]> = []) {
    const shas = new Map(initial.map(([k, v]) => [k.includes(':') ? k : `memory:${k}`, v]))
    const upserts: string[] = []
    const removals: string[] = []
    return {
      upserts,
      removals,
      index: {
        upsert: async (kind: string, slug: string, _t: string, sha?: string) => {
          upserts.push(slug)
          shas.set(`${kind}:${slug}`, sha ?? '')
        },
        remove: async (kind: string, slug: string) => {
          removals.push(slug)
          shas.delete(`${kind}:${slug}`)
        },
        search: async () => [],
        count: async () => shas.size,
        fingerprints: async () => new Map(shas),
      },
    }
  }

  function fakeStore(manifest: Manifest, reads: string[]) {
    return {
      indexManifest: async () => manifest,
      readEntry: async (_k: 'memory' | 'session', slug: string) => {
        reads.push(slug)
        return { name: slug, description: 'd', content: 'body' }
      },
    }
  }

  it('reads and embeds only the files whose fingerprint changed', async () => {
    const reads: string[] = []
    const { index, upserts } = fakeIndex([
      ['unchanged', 'sha-same'],
      ['edited', 'sha-old'],
    ])
    const store = fakeStore(
      [
        { kind: 'memory', slug: 'unchanged', sha: 'sha-same' },
        { kind: 'memory', slug: 'edited', sha: 'sha-new' },
        { kind: 'session', slug: 'brand-new', sha: 'sha-3' },
      ],
      reads,
    )

    const report = await reindexInto(index, store)

    expect(reads).toEqual(['edited', 'brand-new'])
    expect(upserts).toEqual(['edited', 'brand-new'])
    expect(report).toEqual({ indexed: 2, removed: 0, unchanged: 1, unreadable: 0, remaining: 0 })
  })

  it('stops when the budget runs out and reports what is left', async () => {
    const reads: string[] = []
    const { index, upserts } = fakeIndex()
    const store = fakeStore(
      [
        { kind: 'memory', slug: 'first', sha: 'sha-1' },
        { kind: 'memory', slug: 'second', sha: 'sha-2' },
        { kind: 'memory', slug: 'third', sha: 'sha-3' },
      ],
      reads,
    )

    const report = await reindexInto(index, store, () => upserts.length < 1)

    expect(upserts).toEqual(['first'])
    expect(report).toEqual({ indexed: 1, removed: 0, unchanged: 0, unreadable: 0, remaining: 2 })
  })

  it('offers the next file its real chunk count, not one per file', async () => {
    const reads: string[] = []
    const { index } = fakeIndex()
    const costs: number[] = []
    // 4000 chars is three chunks; the short one is a single embedding. A cap counted in files
    // would have offered `1` for both and let the long file spend three of the fifty unbudgeted.
    const store = {
      indexManifest: async () => [
        { kind: 'memory', slug: 'long', sha: 'sha-l' },
        { kind: 'memory', slug: 'short', sha: 'sha-s' },
      ],
      readEntry: async (_kind: string, slug: string) => {
        reads.push(slug)
        return { name: slug, description: '', content: slug === 'long' ? 'x'.repeat(4000) : 'x' }
      },
    } as unknown as Parameters<typeof reindexInto>[1]

    await reindexInto(index, store, (cost) => (costs.push(cost), true))
    expect(costs).toEqual([3, 1])
  })

  it('defers a file it cannot afford instead of overspending on it', async () => {
    const { index, upserts } = fakeIndex()
    const store = {
      indexManifest: async () => [
        { kind: 'memory', slug: 'long', sha: 'sha-l' },
        { kind: 'memory', slug: 'short', sha: 'sha-s' },
      ],
      readEntry: async (_kind: string, slug: string) => ({
        name: slug,
        description: '',
        content: slug === 'long' ? 'x'.repeat(4000) : 'x',
      }),
    } as unknown as Parameters<typeof reindexInto>[1]

    let left = 2
    const report = await reindexInto(index, store, (cost) => {
      if (cost > left) {
        return false
      }
      left -= cost
      return true
    })

    expect(upserts).toEqual(['short'])
    expect(report).toMatchObject({ indexed: 1, remaining: 1 })
  })

  it('resumes from the fingerprints alone, with no cursor carried between slices', async () => {
    const reads: string[] = []
    const { index, upserts } = fakeIndex()
    const manifest: Manifest = [
      { kind: 'memory', slug: 'first', sha: 'sha-1' },
      { kind: 'memory', slug: 'second', sha: 'sha-2' },
      { kind: 'memory', slug: 'third', sha: 'sha-3' },
    ]
    let report = await reindexInto(index, fakeStore(manifest, reads), () => upserts.length < 1)
    expect(report.remaining).toBe(2)

    // Second slice: same index, same manifest, no state passed in — it must pick up at 'second'.
    report = await reindexInto(index, fakeStore(manifest, reads))

    expect(upserts).toEqual(['first', 'second', 'third'])
    expect(report).toEqual({ indexed: 2, removed: 0, unchanged: 1, unreadable: 0, remaining: 0 })
  })

  it('counts an unreadable entry separately, not as unchanged', async () => {
    // Folding it into `unchanged` made a vault full of broken files report perfect health.
    // It still must not count as remaining, or the chain reschedules itself forever.
    const { index } = fakeIndex()
    const store = {
      indexManifest: async () => [
        { kind: 'memory' as const, slug: 'ghost', sha: 'sha-1' },
        { kind: 'memory' as const, slug: 'fine', sha: 'sha-2' },
      ],
      readEntry: async (_k: 'memory' | 'session', slug: string) =>
        slug === 'ghost' ? null : { name: slug, description: 'd', content: 'body' },
    }

    const report = await reindexInto(index, store)

    expect(report).toEqual({ indexed: 1, removed: 0, unchanged: 0, unreadable: 1, remaining: 0 })
  })

  it('keeps a memory and a session that share a slug as two separate entries', async () => {
    // Observed in production: a memory named after the session it came out of lands in both
    // folders under one slug. Keyed by slug alone, each reconcile re-embedded one and evicted
    // the other, so exactly one of the two was searchable and which one flipped every run.
    const shared = '2026-07-12-vendor-proposal-review'
    const reads: string[] = []
    const { index, upserts } = fakeIndex()
    const manifest: Manifest = [
      { kind: 'memory', slug: shared, sha: 'sha-mem' },
      { kind: 'session', slug: shared, sha: 'sha-sess' },
    ]

    const first = await reindexInto(index, fakeStore(manifest, reads))
    expect(first).toEqual({ indexed: 2, removed: 0, unchanged: 0, unreadable: 0, remaining: 0 })

    // Second pass over an unchanged vault must cost nothing at all.
    const second = await reindexInto(index, fakeStore(manifest, reads))
    expect(second).toEqual({ indexed: 0, removed: 0, unchanged: 2, unreadable: 0, remaining: 0 })
    expect(upserts).toHaveLength(2)
  })

  it('drops rows for files that left the vault', async () => {
    const reads: string[] = []
    const { index, removals } = fakeIndex([
      ['kept', 'sha-1'],
      ['archived', 'sha-2'],
    ])
    const store = fakeStore([{ kind: 'memory', slug: 'kept', sha: 'sha-1' }], reads)

    const report = await reindexInto(index, store)

    expect(removals).toEqual(['archived'])
    expect(reads).toEqual([])
    expect(report).toEqual({ indexed: 0, removed: 1, unchanged: 1, unreadable: 0, remaining: 0 })
  })

  it('costs nothing beyond the manifest when the vault has not moved', async () => {
    const reads: string[] = []
    const { index, upserts, removals } = fakeIndex([['a', 'sha-a']])
    const report = await reindexInto(index, fakeStore([{ kind: 'memory', slug: 'a', sha: 'sha-a' }], reads))

    expect([...reads, ...upserts, ...removals]).toEqual([])
    expect(report).toEqual({ indexed: 0, removed: 0, unchanged: 1, unreadable: 0, remaining: 0 })
  })
})
