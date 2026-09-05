import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Chunk } from '../lib/corpus.ts'
import { buildIdf } from '../lib/leakage.ts'
import { loadDoneChunkIds, processChunk, selectTodo } from './queries.ts'

const mk = (id: string, text: string): Chunk => ({ id, text, session: 's', ts: 't', project: 'p' })
const corpus = [mk('c1', 'cache invalidace přes tag purge'), mk('c2', 'nákupní seznam')]
const idf = buildIdf(corpus)

describe('loadDoneChunkIds + selectTodo (resume)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'queries-test-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns no done ids when the file does not exist', () => {
    expect(loadDoneChunkIds(join(dir, 'missing.jsonl'))).toEqual(new Set())
  })

  it('picks up chunk ids already written, so a re-run skips them', () => {
    const file = join(dir, 'candidates.jsonl')
    writeFileSync(file, `${JSON.stringify({ chunkId: 'c1', query: 'q', leakage: 0.1 })}\n`)
    const done = loadDoneChunkIds(file)
    expect(done).toEqual(new Set(['c1']))
    expect(selectTodo(corpus, done).map((c) => c.id)).toEqual(['c2'])
  })

  it('tolerates a partially-written last line from an interrupted append', () => {
    const file = join(dir, 'candidates.jsonl')
    writeFileSync(file, `${JSON.stringify({ chunkId: 'c1', query: 'q', leakage: 0.1 })}\n{"chunkId":"c2","que`)
    expect(loadDoneChunkIds(file)).toEqual(new Set(['c1']))
  })
})

describe('processChunk', () => {
  it('writes on the first non-leaking attempt', async () => {
    const result = await processChunk(corpus[0], idf, async () => 'jak jsme mazali data', 3, 0.25)
    expect(result.outcome.status).toBe('written')
    expect(result.leakageRejections).toBe(0)
  })

  it('reports exhausted, not error, when every attempt leaks', async () => {
    const result = await processChunk(corpus[0], idf, async () => 'tag purge invalidace cache', 3, 0.25)
    expect(result.outcome.status).toBe('exhausted')
    expect(result.leakageRejections).toBe(3)
  })

  it('reports error, distinct from exhausted, when the call throws — and does not retry further', async () => {
    let calls = 0
    const result = await processChunk(
      corpus[0],
      idf,
      async () => {
        calls++
        throw new Error('openrouter 429')
      },
      3,
      0.25,
    )
    expect(result.outcome.status).toBe('error')
    expect(calls).toBe(1)
    expect(result.leakageRejections).toBe(0)
  })

  it('retries after a leak and can still succeed within the attempt budget', async () => {
    let calls = 0
    const result = await processChunk(
      corpus[0],
      idf,
      async () => {
        calls++
        return calls === 1 ? 'tag purge invalidace cache' : 'jak jsme mazali data'
      },
      3,
      0.25,
    )
    expect(result.outcome.status).toBe('written')
    expect(result.leakageRejections).toBe(1)
    expect(calls).toBe(2)
  })
})

describe('processChunk — blank completions', () => {
  const chunk: Chunk = {
    id: 'c1',
    text: 'cache invalidace přes tag purge na Cloudflare',
    session: 's',
    ts: 't',
    project: 'p',
  }
  const idf = buildIdf([chunk])

  it('never writes a candidate for a blank query, however the guard scores it', async () => {
    const { outcome } = await processChunk(chunk, idf, async () => '   ', 3, 0.25)
    expect(outcome.status).not.toBe('written')
  })

  it('retries a blank completion and keeps the query that arrives', async () => {
    let call = 0
    const { outcome } = await processChunk(
      chunk,
      idf,
      async () => (++call === 1 ? '' : 'Jak jsme mazali uložená data?'),
      3,
      0.25,
    )
    expect(outcome).toMatchObject({ status: 'written', candidate: { query: 'Jak jsme mazali uložená data?' } })
    expect(call).toBe(2)
  })
})
