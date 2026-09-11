import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { appendArchive, searchToolResults, type ToolResultRecord } from '@/agent/archive'
import { sqlTag } from '@/agent/archive'
import type { Env } from '@/types'

/**
 * Against real Durable Object SQLite rather than a fake, because the whole point of this search is
 * that `json_extract`, `instr` and `substr` do the cutting — a stubbed seam would prove none of it.
 */
async function withArchive(name: string, run: (sql: ReturnType<typeof sqlTag>) => void): Promise<void> {
  const ns = (env as Env).MAINTENANCE
  const stub = ns.get(ns.idFromName(name))
  await runInDurableObject(stub, async (_instance, state) => run(sqlTag(state.storage.sql)))
}

const page = (content: string, url = 'https://x.example'): ToolResultRecord => ({
  tool: 'read_page',
  args: `{"url":"${url}"}`,
  content,
})

describe('searchToolResults against Durable Object SQLite', () => {
  it('cuts the snippet around the match without returning the page', async () => {
    await withArchive('cut', (sql) => {
      appendArchive(sql, 'tool-result', page(`${'x'.repeat(5_000)} the CLOUDFLARE answer ${'y'.repeat(5_000)}`))

      const [hit] = searchToolResults(sql, 'cloudflare', 5)

      expect(hit.snippet).toContain('the CLOUDFLARE answer')
      // The row holds 10k; a snippet that came back whole would mean the cut happened in JS.
      expect(hit.snippet.length).toBeLessThan(400)
      expect(hit.total).toBeGreaterThan(10_000)
      expect(hit.tool).toBe('read_page')
    })
  })

  it('reads `%` and `_` as characters, not as wildcards', async () => {
    await withArchive('wildcards', (sql) => {
      appendArchive(sql, 'tool-result', page('inflation reached 100% last year'))
      appendArchive(sql, 'tool-result', page('nothing numeric here at all'))

      // Under `LIKE` this matched both rows, because `%` meant "anything".
      expect(searchToolResults(sql, '100%', 5)).toHaveLength(1)
      expect(searchToolResults(sql, 'a_l', 5)).toHaveLength(0)
    })
  })

  it('matches the text rather than the JSON it is stored in', async () => {
    await withArchive('escapes', (sql) => {
      appendArchive(sql, 'tool-result', page('a line\nand another'))

      // The stored row contains the two characters \ and n; the content contains a newline. A
      // search for the escape must not find the text that produced it.
      expect(searchToolResults(sql, '\\n', 5)).toHaveLength(0)
      expect(searchToolResults(sql, 'line', 5)).toHaveLength(1)
    })
  })

  it('finds a page by its arguments, so a URL is searchable', async () => {
    await withArchive('by-args', (sql) => {
      appendArchive(sql, 'tool-result', page('body says nothing useful', 'https://cloudflare.com/docs'))

      const [hit] = searchToolResults(sql, 'cloudflare.com', 5)
      expect(hit.args).toContain('cloudflare.com/docs')
      // Matched outside the body, so the snippet shows the opening rather than nothing.
      expect(hit.snippet).toContain('body says')
    })
  })

  it('returns newest first and honours the limit', async () => {
    await withArchive('order', (sql) => {
      for (const n of [1, 2, 3]) {
        appendArchive(sql, 'tool-result', page(`match number ${n}`))
      }

      const hits = searchToolResults(sql, 'match', 2)
      expect(hits).toHaveLength(2)
      expect(hits[0].ref).toBeGreaterThan(hits[1].ref)
    })
  })

  it('ignores rows that are not tool results', async () => {
    await withArchive('kinds', (sql) => {
      appendArchive(sql, 'compaction', { evicted: [], summary: 'a compaction mentioning cloudflare', shadows: [] })

      expect(searchToolResults(sql, 'cloudflare', 5)).toHaveLength(0)
    })
  })
})
