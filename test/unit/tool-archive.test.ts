import { env, runInDurableObject } from 'cloudflare:test'
import { getAgentByName } from 'agents'
import { describe, expect, it } from 'vitest'
import type { PersonalAgent } from '../../src/agent/personal-agent'
import { appendArchive } from '../../src/agent/archive'
import { sqlTag } from '../../src/agent/archive'
import { truncate, type ToolContext, type ToolDef } from '../../src/agent/tools/registry'
import { resultCap } from '../../src/agent/context-window'
import { MAX_READBACK_CHARS, toolArchiveTools } from '../../src/agent/tools/tool-archive.tools'
import type { Env } from '../../src/types'

const testEnv = env as Env

const tool = (name: string): ToolDef => toolArchiveTools.find((t) => t.name === name)!

function run(def: ToolDef, args: unknown, ctx: ToolContext): Promise<string> {
  return def.handler(def.params.parse(args) as never, ctx)
}

/**
 * Through the agent's own `toolContext`, not a stand-in: the closures there are the only place the
 * archive's rows are turned into what the tools read, and every other test of this feature hands
 * the loop a fake. A row's `time` becoming the record's `at` is the specific thing that has no
 * other coverage — mapped from the wrong field it yields `Invalid Date`, not an error.
 */
async function withContext(run: (ctx: ToolContext, agent: PersonalAgent) => Promise<void>): Promise<void> {
  const stub = await getAgentByName(testEnv.PERSONAL_AGENT, `archive-${crypto.randomUUID()}`)
  await runInDurableObject(stub as never, async (agent: PersonalAgent) => {
    const ctx = (agent as unknown as { toolContext(): ToolContext }).toolContext()
    await run(ctx, agent)
  })
}

const PAGE = `opening line\n${'body '.repeat(600)}\nthe CLOUDFLARE answer`

describe('the tool archive as the agent wires it', () => {
  it('reads back what it saved, with the row time as the fetch date', async () => {
    await withContext(async (ctx) => {
      const ref = ctx.toolArchive!.save({ tool: 'read_page', args: '{"url":"https://x.example"}', content: PAGE })

      const out = await run(tool('read_tool_result'), { ref }, ctx)

      expect(out).toContain('the CLOUDFLARE answer')
      expect(out).toContain('tool="read_page"')
      expect(out).toContain('https://x.example')
      // The mapping under test: a date, not `Invalid Date`, and this decade rather than 1970.
      expect(out).toMatch(/fetched="20\d\d-\d\d-\d\d \d\d:\d\d"/)
      // Whole in one window, so nothing offers a continuation.
      expect(out).not.toContain('more=')
    })
  })

  /**
   * `chars=` and `more=` are the only things telling the model where it got to, and both are
   * computed here while the loop cuts the reply afterwards. Sized from `WINDOW_CHARS` alone they
   * name an offset past text that never arrived, and a model following `more=` skips the gap — the
   * one place the absolute-versus-window mismatch produces a wrong *instruction* rather than a
   * smaller view. It bites on any window under ~134,000 tokens, so every picker model but the
   * default.
   */
  it('never names an offset past what the loop will let through', async () => {
    await withContext(async (ctx) => {
      const long = 'z'.repeat(120_000)
      const ref = ctx.toolArchive!.save({ tool: 'read_page', args: '{"url":"https://x.example"}', content: long })
      const small = { ...ctx, contextTokens: 24_000 }

      const out = await run(tool('read_tool_result'), { ref }, small)

      // Mutation check: restore `Math.min(from + WINDOW_CHARS, total)` and this reply is ~40,300
      // characters against a 7,200 cap, with `more="read_tool_result(N, 40000)"` on it.
      const cap = resultCap(MAX_READBACK_CHARS, 24_000)
      expect(out.length).toBeLessThanOrEqual(cap)
      expect(out).not.toContain('cut from the middle')

      // What it claims to have delivered is what it delivered: the next offset is inside the reply.
      const next = Number(out.match(/more="read_tool_result\(\d+, (\d+)\)"/)?.[1])
      expect(next).toBeGreaterThan(0)
      expect(out).toContain(`chars="0-${next} of 120000"`)
      expect(next).toBeLessThan(cap)
    })
  })

  it('refuses a ref that lands on a row of another kind', async () => {
    await withContext(async (ctx, agent) => {
      const sql = sqlTag((agent as unknown as { ctx: DurableObjectState }).ctx.storage.sql)
      const ref = appendArchive(sql, 'compaction', { evicted: [], summary: 'secret', shadows: [], unsummarized: 0 })

      const out = await run(tool('read_tool_result'), { ref }, ctx)

      expect(out).toBe(`error: no result kept under ref ${ref}`)
      expect(out).not.toContain('secret')
    })
  })

  it('finds a saved result again through search, and the ref it quotes reads', async () => {
    await withContext(async (ctx) => {
      ctx.toolArchive!.save({ tool: 'read_page', args: '{"url":"https://x.example"}', content: PAGE })

      const hits = await run(tool('search_tool_results'), { query: 'cloudflare' }, ctx)

      const ref = Number(hits.match(/ref="(\d+)"/)?.[1])
      expect(ref).toBeGreaterThan(0)
      expect(await run(tool('read_tool_result'), { ref }, ctx)).toContain('the CLOUDFLARE answer')
    })
  })
})

describe('truncate', () => {
  it('leaves anything at or under the cap alone', () => {
    expect(truncate('abc', 3)).toBe('abc')
    expect(truncate('', 10)).toBe('')
  })

  it('keeps both ends and counts what went', () => {
    const out = truncate(`START${'x'.repeat(1_000)}END`, 100)

    expect(out.startsWith('START')).toBe(true)
    expect(out.endsWith('END')).toBe(true)
    expect(out).toContain('[908 characters cut from the middle]')
  })

  it('never returns more than it was given', () => {
    // `slice(-0)` is the whole string, so a cap small enough to floor the tail to zero used to
    // return the input plus a marker claiming it had been shortened.
    for (const max of [1, 2, 3, 4, 5, 10]) {
      expect(truncate('abcdefghijklmnop', max).length).toBeLessThan('abcdefghijklmnop'.length + 60)
      expect(truncate('abcdefghijklmnop', max)).not.toContain('abcdefghijklmnop')
    }
  })
})
