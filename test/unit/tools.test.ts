import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ARCHIVE_MIN_CHARS } from '@/agent/loop/tool-loop'
import { buildTools } from '@/agent/tools'
import { MAX_PAGE_CHARS } from '@/agent/tools/browser.tools'
import type { CitationVerdict } from '@/agent/provenance'
import {
  DEFAULT_RESULT_CHARS,
  pageKey,
  toolSpec,
  type ScheduleInfo,
  type ToolContext,
  type ToolDef,
} from '@/agent/tools/registry'
import { MAX_SCHEDULED_TASKS } from '@/agent/tools/schedule.tools'
import type { Env } from '@/types'
import { readVault, seedVault } from '../helpers/vault'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

/**
 * Handlers are wrapped in their own schema so these tests cannot call one with arguments the loop
 * would have refused. It throws where `executeTool` returns a tool result — the production shape of
 * a refusal is covered in `tool-loop.test.ts`, not here.
 */
const tools: Record<
  string,
  { params: z.ZodType; handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> }
> = Object.fromEntries(
  buildTools().map((t) => [
    t.name,
    {
      params: t.params!,
      handler: (args: Record<string, unknown>, ctx: ToolContext) => t.handler(t.params!.parse(args) as never, ctx),
    },
  ]),
)

/** One citable turn, one that is the assistant's, and everything else absent. */
const VERDICTS: Record<string, CitationVerdict> = {
  m7: { ok: true, message: { role: 'user', content: 'that is wrong', id: 'm7' } },
  m8: { ok: false, why: 'not-a-user-turn' },
}

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    env: {
      FIRECRAWL_API_KEY: 'test-fc-key',
      CF_API_TOKEN: 'test-cf-token',
      CF_ACCOUNT_ID: 'test-account',
      VAULT_AGENT_DIR: 'agent',
      VAULT: (env as Env).VAULT,
    } as never,
    source: { thread: 't-1', turn: 'm7', at: 1_700_000_000_000 },
    verifyCitation: async (thread: string, turn: string) =>
      thread !== 't-1' ? { ok: false, why: 'thread-gone' } : (VERDICTS[turn] ?? { ok: false, why: 'missing' }),
    agent: {
      schedule: vi.fn(async () => ({ id: 'sched-1' })),
      listSchedules: vi.fn(async (): Promise<ScheduleInfo[]> => []),
      cancelSchedule: vi.fn(async () => true),
    },
    ...over,
  }
}

function callTool(name: string, args: Record<string, unknown>) {
  return tools[name].handler(args, makeCtx())
}

describe('registry', () => {
  it('exposes all eighteen tools', () => {
    expect(Object.keys(tools).sort()).toEqual([
      'cancel_scheduled',
      'delete_memory',
      'list_memories',
      'list_scheduled',
      'list_skills',
      'read_page',
      'read_research_report',
      'read_skill',
      'read_tool_result',
      'save_memory',
      'save_skill',
      'search_memory',
      'search_tool_results',
      'set_reminder',
      'set_scheduled_task',
      'update_agent_notes',
      'update_user_profile',
      'web_search',
    ])
  })
})

describe('web_search tool', () => {
  function tavilyReply(body: object | string, status = 200) {
    fetchMock
      .get('https://api.tavily.com')
      .intercept({ method: 'POST', path: '/search' })
      .reply(status, body, { headers: { 'content-type': 'application/json' } })
  }

  function firecrawlReply(body: object | string, status = 200) {
    fetchMock
      .get('https://api.firecrawl.dev')
      .intercept({ method: 'POST', path: '/v2/search' })
      .reply(status, body, { headers: { 'content-type': 'application/json' } })
  }

  const withTavily = () => makeCtx({ env: { FIRECRAWL_API_KEY: 'test-fc-key', TAVILY_API_KEY: 'tvly-key' } as never })

  it('asks Tavily first and never reaches Firecrawl', async () => {
    // 1 credit a search against 2, and 100/min against 10 — the second is why 15 of 43 searches
    // came back as "(no results)" on a real run.
    tavilyReply({ results: [{ title: 'T', url: 'https://t.example/', content: 'D' }] })
    const out = await tools.web_search.handler({ query: 'x' }, withTavily())
    expect(out).toBe('1. T\nhttps://t.example/\nD')
  })

  it('hands a page that came with a hit to the round, and says so under the results', async () => {
    tavilyReply({
      results: [
        { title: 'T', url: 'https://t.example/', content: 'D', raw_content: '# Whole page' },
        { title: 'U', url: 'https://u.example/', content: 'E' },
      ],
    })
    // Mutation check: drop the `set` and the cache stays empty, so every read pays a fetch again.
    const pageCache = new Map<string, string>()
    const ctx = makeCtx({ env: { FIRECRAWL_API_KEY: 'test-fc-key', TAVILY_API_KEY: 'tvly-key' } as never, pageCache })

    const out = await tools.web_search.handler({ query: 'x' }, ctx)

    expect([...pageCache]).toEqual([['https://t.example', '# Whole page']])
    // The list itself is unchanged: ten whole pages inline would overflow a 24k window.
    expect(out).toBe(
      '1. T\nhttps://t.example/\nD\n\n2. U\nhttps://u.example/\nE\n\n(read_page returns 1 of these whole without a fetch)',
    )
  })

  it('returns the whole result list and declares its cap, rather than cutting it itself', async () => {
    const results = Array.from({ length: 60 }, (_, i) => ({
      title: `T${i}`,
      url: `https://t.example/${i}`,
      content: 'd'.repeat(200),
    }))
    tavilyReply({ results })

    const out = await tools.web_search.handler({ query: 'x' }, withTavily())

    // Mutation check: cut in the handler again and this drops to that cap — with the archive filed
    // from the cut string, which is how `search_memory` lost two thirds of a result while still
    // offering a ref to the rest.
    expect(out.length).toBeGreaterThan(10_000)
    // The cap sits above what ten results can reach by construction (~6,700), not merely above the
    // 4,748–5,979 measured. Under the distribution — the inherited 2,000 was — every search is cut
    // and `truncate` says nothing about it.
    expect(buildTools().find((t) => t.name === 'web_search')?.maxResultChars).toBe(10_000)
  })

  it('lets search_memory past the loop default, and keeps every cut redeemable', () => {
    // It was the one tool of nineteen overflowing 4,000 systematically — 12,213 characters measured
    // against a structural ceiling near 20,000. Mutation check: drop the cap and this reads 4,000,
    // which is a result cut to a third of itself on every recall.
    expect(buildTools().find((t) => t.name === 'search_memory')?.maxResultChars).toBe(20_000)

    // The invariant spans two files, so a test is the only place it can hold: anything cut is over
    // the smallest cap, hence over `ARCHIVE_MIN_CHARS`, hence always filed with a ref that undoes
    // the cut. Mutation check either way — raise that constant past 4,000, or give a tool a cap
    // under it, and a cut result leaves the model a marker it cannot redeem.
    const caps = buildTools().map((t) => t.maxResultChars ?? DEFAULT_RESULT_CHARS)
    expect(Math.min(...caps)).toBeGreaterThan(ARCHIVE_MIN_CHARS)
  })

  it('asks the vendor for ten, not the connector default', async () => {
    let asked: Record<string, unknown> | undefined
    fetchMock
      .get('https://api.tavily.com')
      .intercept({ method: 'POST', path: '/search' })
      .reply(
        200,
        ({ body }) => {
          asked = JSON.parse(body as string) as Record<string, unknown>
          return { results: [{ title: 'T', url: 'https://t.example/', content: 'D' }] }
        },
        { headers: { 'content-type': 'application/json' } },
      )

    await tools.web_search.handler({ query: 'x' }, withTavily())

    // Mutation check: drop the argument and each connector falls back to its own default of 5,
    // which nothing else here would notice — the count is only visible in the request.
    expect(asked).toMatchObject({ max_results: 10 })
  })

  it('names the narrowing it applied, so an empty result is not read as the web being empty', async () => {
    tavilyReply({ results: [{ title: 'T', url: 'https://t.example/', content: 'D' }] })

    const out = await tools.web_search.handler(
      { query: 'x', time_range: 'week', exclude_domains: ['reddit.com'] },
      withTavily(),
    )

    expect(out).toContain('published within the last week')
    expect(out).toContain('excluding reddit.com')
  })

  it('adds no note at all when nothing was narrowed', async () => {
    tavilyReply({ results: [{ title: 'T', url: 'https://t.example/', content: 'D' }] })
    const out = await tools.web_search.handler({ query: 'x' }, withTavily())
    expect(out).toBe('1. T\nhttps://t.example/\nD')
  })

  it('falls through to Firecrawl when Tavily is rate limited', async () => {
    tavilyReply('blocked', 429)
    firecrawlReply({ success: true, data: { web: [{ title: 'F', url: 'https://f.example/', description: 'D' }] } })
    const out = await tools.web_search.handler({ query: 'x' }, withTavily())
    expect(out).toBe('1. F\nhttps://f.example/\nD')
  })

  it('falls through when Tavily answers with nothing at all', async () => {
    tavilyReply({ results: [] })
    firecrawlReply({ success: true, data: { web: [{ title: 'F', url: 'https://f.example/', description: 'D' }] } })
    const out = await tools.web_search.handler({ query: 'x' }, withTavily())
    expect(out).toContain('https://f.example/')
  })

  it('says a refused search is a tool failure, not an empty web', async () => {
    // 15 of 43 searches on one real run were Firecrawl 429s delivered as "(no results)". The
    // scouts read that as a fact about the topic and wrote from memory.
    tavilyReply('blocked', 429)
    firecrawlReply('blocked', 429)
    const seen: string[] = []
    const errors: Record<string, unknown>[] = []
    const ctx = makeCtx({
      env: { FIRECRAWL_API_KEY: 'test-fc-key', TAVILY_API_KEY: 'tvly-key' } as never,
      onSearchResults: (urls: string[]) => void seen.push(...urls),
      log: { turnId: 't', event: () => {}, error: (f: Record<string, unknown>) => void errors.push(f) } as never,
    })

    const out = await tools.web_search.handler({ query: 'x' }, ctx)

    expect(out).toMatch(/tool failure/i)
    expect(out).not.toContain('(no results)')
    // Never filed as a query that found nothing: that count is the diagnostic for empty searches.
    expect(seen).toHaveLength(0)
    expect(errors).toContainEqual(expect.objectContaining({ stage: 'unavailable' }))
  })

  it('still reports a genuinely empty web as no results', async () => {
    tavilyReply({ results: [] })
    firecrawlReply({ success: true, data: { web: [] } })
    const ctx = makeCtx({ env: { FIRECRAWL_API_KEY: 'test-fc-key', TAVILY_API_KEY: 'tvly-key' } as never })

    expect(await tools.web_search.handler({ query: 'x' }, ctx)).toBe('(no results)')
  })

  it('searches keyless when no vendor key is set', async () => {
    // Mutation check: gate the vendors on their keys again and Tavily is never asked, so this reads
    // "(no results)" and the interceptor stays pending — a deploy with no search secret went blind.
    tavilyReply({ results: [{ title: 'T', url: 'https://t.example/', content: 'D' }] })
    const out = await tools.web_search.handler({ query: 'x' }, makeCtx({ env: {} as never }))
    expect(out).toBe('1. T\nhttps://t.example/\nD')
  })
})

describe('read_page records which provider served it', () => {
  // The fallback was silent, so "how often is Browser Rendering blocked" could not be answered
  // from the traces. It also matters for cost: a fallback spends two subrequests, not one,
  // because the budget charges on attempt.
  function captureLog() {
    const records: Record<string, unknown>[] = []
    return {
      records,
      log: {
        turnId: 't1',
        event: (f: Record<string, unknown>) => void records.push(f),
        error: (f: Record<string, unknown>) => void records.push(f),
      },
    }
  }

  it('reports browser-run when the primary succeeds', async () => {
    fetchMock
      .get('https://api.cloudflare.com')
      .intercept({ method: 'POST', path: '/client/v4/accounts/test-account/browser-rendering/markdown' })
      .reply(200, { success: true, result: '# md' }, { headers: { 'content-type': 'application/json' } })

    const { records, log } = captureLog()
    await tools.read_page.handler({ url: 'https://example.com' }, makeCtx({ log } as never))

    expect(records).toContainEqual(expect.objectContaining({ at: 'read_page', via: 'browser-run' }))
  })

  it('records the cap a long page ran past, and does not claim it is what was shown', async () => {
    // Observed 2026-08-08: a page came back at 340783 characters against a cap of 8000, and nothing
    // recorded that the model saw a fraction of it. Nothing is *thrown away* — the archive keeps the
    // fetch whole and `read_tool_result` reaches the rest, so `kept` was the wrong word too.
    // The field is `cap` because the loop may cut below it again when the window is tighter.
    const long = `# Title\n\n${'A real sentence that survives the prose extractor. '.repeat(3000)}`
    expect(long.length).toBeGreaterThan(MAX_PAGE_CHARS)
    fetchMock
      .get('https://api.cloudflare.com')
      .intercept({ method: 'POST', path: '/client/v4/accounts/test-account/browser-rendering/markdown' })
      .reply(200, { success: true, result: long }, { headers: { 'content-type': 'application/json' } })

    const { records, log } = captureLog()
    await tools.read_page.handler({ url: 'https://example.com' }, makeCtx({ log } as never))

    const rec = records.find((r) => r.at === 'read_page' && r.stage === 'over-first-view')
    expect(rec).toBeDefined()
    expect(Number(rec?.chars)).toBeGreaterThan(MAX_PAGE_CHARS)
    expect(rec?.cap).toBe(MAX_PAGE_CHARS)
    expect(rec?.shown).toBeUndefined()
  })

  it('reports firecrawl when the primary was blocked', async () => {
    fetchMock
      .get('https://api.cloudflare.com')
      .intercept({ method: 'POST', path: '/client/v4/accounts/test-account/browser-rendering/markdown' })
      .reply(403, { errors: [{ message: 'challenged' }] }, { headers: { 'content-type': 'application/json' } })
    fetchMock
      .get('https://api.firecrawl.dev')
      .intercept({ method: 'POST', path: '/v2/scrape' })
      .reply(
        200,
        { success: true, data: { markdown: '# via firecrawl' } },
        { headers: { 'content-type': 'application/json' } },
      )

    const { records, log } = captureLog()
    await tools.read_page.handler({ url: 'https://example.com' }, makeCtx({ log } as never))

    // Two subrequests were spent on one read; the record has to say so or the budget maths lies.
    expect(records).toContainEqual(expect.objectContaining({ at: 'read_page', via: 'firecrawl', fellBack: true }))
    // And why the primary was abandoned. Dropped on this path, the only reason recorded across two
    // real runs was a single 429, while the code claimed WAF challenges.
    expect(records.find((r) => r.via === 'firecrawl')?.why).toMatch(/403/)
  })
})

describe('read_page tool', () => {
  it('finds the cached page under a trailing slash or a fragment, which is how the model asks', async () => {
    // Four of eight rate-limited fetches on one real run were `…/playwright/` for a cached
    // `…/playwright`. Mutation check: key by the raw URL and this fetches, which fails here.
    const ctx = makeCtx({
      pageCache: new Map([
        [
          pageKey('https://example.com/docs/'),
          '# Docs\n\nA long enough article body to count as prose for the extractor to keep.',
        ],
      ]),
    })
    await expect(tools.read_page.handler({ url: 'https://example.com/docs#top' }, ctx)).resolves.toContain(
      'A long enough',
    )
  })

  it('serves a page a search already brought back, without a fetch', async () => {
    // No interceptor at all: a fetch here fails under disableNetConnect. Mutation check: drop the
    // `pageCache` lookup and the read pays Browser Rendering for a page it already had.
    const reads: [string, boolean][] = []
    const ctx = makeCtx({
      pageCache: new Map([
        [
          'https://example.com',
          '# Whole page\n\nA long enough article body to count as prose for the extractor to keep.',
        ],
      ]),
      onPageRead: (url, ok) => reads.push([url, ok]),
    })

    await expect(tools.read_page.handler({ url: 'https://example.com' }, ctx)).resolves.toContain(
      'A long enough article',
    )
    // Counted as a read: the model saw the page, and the report counts pages seen.
    expect(reads).toEqual([['https://example.com', true]])
  })

  it('returns page markdown via browser run', async () => {
    fetchMock
      .get('https://api.cloudflare.com')
      .intercept({ method: 'POST', path: '/client/v4/accounts/test-account/browser-rendering/markdown' })
      .reply(200, { success: true, result: '# md' }, { headers: { 'content-type': 'application/json' } })
    await expect(tools.read_page.handler({ url: 'https://example.com' }, makeCtx())).resolves.toBe('# md')
  })

  it('falls back to firecrawl when browser run fails and a key is set', async () => {
    fetchMock
      .get('https://api.cloudflare.com')
      .intercept({ method: 'POST', path: '/client/v4/accounts/test-account/browser-rendering/markdown' })
      .reply(
        429,
        { success: false, errors: [{ message: 'daily browser time exhausted' }] },
        { headers: { 'content-type': 'application/json' } },
      )
    fetchMock
      .get('https://api.firecrawl.dev')
      .intercept({ method: 'POST', path: '/v2/scrape' })
      .reply(
        200,
        { success: true, data: { markdown: '# via firecrawl' } },
        { headers: { 'content-type': 'application/json' } },
      )

    await expect(tools.read_page.handler({ url: 'https://example.com' }, makeCtx())).resolves.toBe('# via firecrawl')
  })

  it('falls back to Firecrawl keyless when browser run fails and no firecrawl key is set', async () => {
    // Mutation check: gate the fallback on FIRECRAWL_API_KEY again and this rejects with the
    // Browser Rendering error while the scrape interceptor stays pending.
    fetchMock
      .get('https://api.cloudflare.com')
      .intercept({ method: 'POST', path: '/client/v4/accounts/test-account/browser-rendering/markdown' })
      .reply(
        429,
        { success: false, errors: [{ message: 'daily browser time exhausted' }] },
        { headers: { 'content-type': 'application/json' } },
      )
    let auth: string | undefined = 'unset'
    fetchMock
      .get('https://api.firecrawl.dev')
      .intercept({ method: 'POST', path: '/v2/scrape' })
      .reply(
        200,
        ({ headers }) => {
          auth = (headers as Record<string, string>).authorization
          return { success: true, data: { markdown: '# Keyless\n\nstill read' } }
        },
        { headers: { 'content-type': 'application/json' } },
      )

    const ctx = makeCtx({ env: { ...makeCtx().env, FIRECRAWL_API_KEY: undefined } as never })
    await expect(tools.read_page.handler({ url: 'https://example.com' }, ctx)).resolves.toContain('still read')
    expect(auth).toBeUndefined()
  })
})

describe('memory tools', () => {
  it('save_memory writes via the vault store', async () => {
    await expect(
      tools.save_memory.handler({ name: 'tea', description: 'd', content: 'c' }, makeCtx()),
    ).resolves.toMatch(/saved memory/)
    // The vault is real storage now, so assert on what is in it rather than on a mocked PUT.
    const file = await readVault('agent/memory/tea.md')
    expect(file).toContain('name: tea')
    expect(file).toContain('source_thread: t-1')
    expect(file).toContain('source_turn: m7')
    expect(await readVault('agent/MEMORY.md')).toContain('- tea — d')
  })

  it('refuses to save a memory it cannot say the source of', async () => {
    // A research scout has a vault and no conversation to point at. Writing anyway would put a
    // fact in the vault that a later reflection could only take on trust.
    const ctx = makeCtx({ source: undefined })
    await expect(tools.save_memory.handler({ name: 'tea', description: 'd', content: 'c' }, ctx)).resolves.toMatch(
      /^error:/,
    )
    expect(await readVault('agent/memory/tea.md')).toBeNull()
  })

  it('search_memory handles no matches', async () => {
    await expect(tools.search_memory.handler({ query: 'anything' }, makeCtx())).resolves.toBe('(no matching memories)')
  })

  it('search_memory wraps each hit in a delimited <memory> block', async () => {
    await seedVault({
      'agent/MEMORY.md': '# Agent memory\n\n- sam-likes-tea — prefers tea over coffee\n',
      'agent/memory/sam-likes-tea.md':
        '---\nname: Sam likes tea\ndescription: prefers tea over coffee\ndate: 2026-07-06\n---\n\nGreen tea.\n',
    })

    const result = await tools.search_memory.handler({ query: 'tea' }, makeCtx())
    expect(result).toContain('<memory name="Sam likes tea">')
    expect(result).toContain('</memory>')
    expect(result).toContain('Green tea.')
  })

  it('search_memory hands back every hit whole, and lets the loop do the cutting', async () => {
    const body = 'lorem ipsum dolor sit amet '.repeat(200)
    await seedVault({
      'agent/MEMORY.md': '# Agent memory\n\n- a-lorem — lorem\n- b-lorem — lorem\n- c-lorem — lorem\n',
      'agent/memory/a-lorem.md': `---\nname: a\ndescription: lorem\n---\n\n${body}`,
      'agent/memory/b-lorem.md': `---\nname: b\ndescription: lorem\n---\n\n${body}`,
      'agent/memory/c-lorem.md': `---\nname: c\ndescription: lorem\n---\n\n${body}`,
    })

    const result = await tools.search_memory.handler({ query: 'lorem' }, makeCtx())

    // Mutation check: wrap `renderEntries`' output in `truncate()` again and this is ~4000.
    // Found by hand on 2026-09-01: that call ran inside the handler, so the *archive* was filed
    // with the cut text — 12,213 characters became 4,041 and `read_tool_result` then offered the
    // rest of something nothing had kept. The model's copy is unaffected either way; the loop
    // applies `truncate`'s default on the way out.
    expect(result.length).toBeGreaterThan(8_192)
    expect(result).toContain('<memory name="c">')
  })

  it('search_memory uses the semantic index when present and fetches hits from the vault', async () => {
    await seedVault({
      'agent/memory/sam-likes-tea.md':
        '---\nname: Sam likes tea\ndescription: prefers tea\ndate: 2026-07-01\n---\n\nGreen tea.\n',
    })

    const index = {
      count: async () => 3,
      search: async () => [{ kind: 'memory', slug: 'sam-likes-tea', score: 0.9 }],
      upsert: async () => {},
      remove: async () => {},
      fingerprints: async () => new Map(),
    }
    const out = await tools.search_memory.handler({ query: 'hot drinks' }, makeCtx({ index }))
    expect(out).toContain('<memory name="Sam likes tea">')
    expect(out).toContain('Green tea.')
  })

  it('save_memory embeds into the index after writing', async () => {
    const upserts: string[] = []
    const index = {
      count: async () => 0,
      search: async () => [],
      upsert: async (_k: string, slug: string) => {
        upserts.push(slug)
      },
      remove: async () => {},
      fingerprints: async () => new Map(),
    }
    await tools.save_memory.handler({ name: 'tea', description: 'd', content: 'c' }, makeCtx({ index }))
    expect(upserts).toEqual(['tea'])
  })

  it('delete_memory archives via the store when the citation checks out', async () => {
    await seedVault({ 'agent/memory/x.md': '---\nname: X\ndescription: d\ndate: 2026-07-01\n---\n\nbody\n' })

    await expect(tools.delete_memory.handler({ name: 'X', cited_turn: 'm7' }, makeCtx())).resolves.toBe(
      'archived memory "x"',
    )
  })

  describe('the destructive-write gate', () => {
    // Huang et al. (ICLR 2024): a model correcting itself without external feedback tends to make
    // things worse. Archiving is the one memory write that destroys something, so it is the one
    // that has to show a turn the user actually wrote.
    const seedOne = () =>
      seedVault({ 'agent/memory/x.md': '---\nname: X\ndescription: d\ndate: 2026-07-01\n---\n\nbody\n' })

    it('falls back to the turn being answered when a chat omits the citation', async () => {
      await seedOne()
      // In a chat the evidence is the message the user just sent, and it is the only citable thing
      // there: the history the model sees carries no ids at all.
      await expect(tools.delete_memory.handler({ name: 'X' }, makeCtx())).resolves.toBe('archived memory "x"')
    })

    it('files the grounds with the archived memory, not in a log that expires', async () => {
      await seedOne()
      await tools.delete_memory.handler({ name: 'X', cited_turn: 'm7' }, makeCtx())

      // Workers Logs keep three days; the vault keeps the fact. A memory destroyed for a reason
      // nobody can find afterwards is indistinguishable from one destroyed on a whim.
      const archived = await readVault('agent/memory/archive/x.md')
      expect(archived).toContain('archived_because_thread: t-1')
      expect(archived).toContain('archived_because_turn: m7')
      expect(archived).toMatch(/archived_at: \d+/)
      // and the memory itself is unchanged below the added keys
      expect(archived).toContain('name: X')
    })

    it('refuses where there is no citation and no turn being answered', async () => {
      await seedOne()
      const ctx = makeCtx({ source: { thread: 't-1', at: 1 } })
      await expect(tools.delete_memory.handler({ name: 'X' }, ctx)).resolves.toMatch(/needs cited_turn/)
      expect(await readVault('agent/memory/x.md')).toContain('name: X')
    })

    it('reads a citation in the shape the transcript displays it', async () => {
      await seedOne()
      // The transcript labels turns as `[3]`, so `[m7]` is what a model copying carefully produces.
      await expect(tools.delete_memory.handler({ name: 'X', cited_turn: '[m7]' }, makeCtx())).resolves.toBe(
        'archived memory "x"',
      )
    })

    it('refuses an id the thread does not have', async () => {
      await seedOne()
      const out = await tools.delete_memory.handler({ name: 'X', cited_turn: 'invented' }, makeCtx())
      expect(out).toMatch(/not in that thread/)
      // Assert the world, not the report: the memory is still there.
      expect(await readVault('agent/memory/x.md')).toContain('name: X')
    })

    it('refuses a turn the user did not write', async () => {
      await seedOne()
      const out = await tools.delete_memory.handler({ name: 'X', cited_turn: 'm8' }, makeCtx())
      expect(out).toMatch(/not something the user said/)
    })

    it('says a deleted thread is gone rather than missing', async () => {
      await seedOne()
      const out = await tools.delete_memory.handler({ name: 'X', cited_turn: 'm7', thread: 't-deleted' }, makeCtx())
      // A memory whose source was destroyed is a different fact from one that never had a source.
      expect(out).toMatch(/was deleted — its source is gone/)
    })

    it('refuses where no thread can be reached to check', async () => {
      await seedOne()
      const out = await tools.delete_memory.handler(
        { name: 'X', cited_turn: 'm7' },
        makeCtx({ verifyCitation: undefined }),
      )
      expect(out).toMatch(/cannot check a citation/)
    })
  })

  it('delete_memory removes the slug from the index on success', async () => {
    await seedVault({ 'agent/memory/x.md': '---\nname: X\ndescription: d\ndate: 2026-07-01\n---\n\nbody\n' })

    const removed: string[] = []
    const index = {
      count: async () => 0,
      search: async () => [],
      upsert: async () => {},
      remove: async (_kind: string, slug: string) => {
        removed.push(slug)
      },
      fingerprints: async () => new Map(),
    }
    await tools.delete_memory.handler({ name: 'X', cited_turn: 'm7' }, makeCtx({ index }))
    expect(removed).toEqual(['x'])
  })
})

describe('update_user_profile tool', () => {
  it('applies an add op through the store', async () => {
    const out = await callTool('update_user_profile', { op: 'add', text: '- Sam likes tea' })
    expect(out).toBe('profile updated (15/1300 chars)')
  })

  it('rejects an unknown op at the schema, before any handler runs', () => {
    // The check moved from the handler to the schema, so it now fires before the handler is
    // entered at all — the loop turns this into a tool result naming the field.
    const bad = tools.update_user_profile.params.safeParse({ op: 'append', text: 'x' })
    expect(bad.success).toBe(false)
    expect(JSON.stringify(bad.error?.issues)).toContain('op')
  })

  it('gates the ops that destroy a line, and only those', async () => {
    await seedVault({ 'agent/USER.md': '- Works at OLDCORP\n' })
    // The profile is what the nightly pass is told to consolidate, so it is where an unaided
    // "newest wins" would quietly delete a fact that held for a year.
    const ungrounded = makeCtx({ source: { thread: 't-1', at: 1 }, verifyCitation: undefined })

    await expect(tools.update_user_profile.handler({ op: 'add', text: '- Likes tea' }, ungrounded)).resolves.toMatch(
      /profile updated/,
    )
    await expect(
      tools.update_user_profile.handler({ op: 'remove', text: '- Works at OLDCORP' }, ungrounded),
    ).resolves.toMatch(/^error:/)
    await expect(
      tools.update_user_profile.handler(
        { op: 'replace', text: '- Works at OLDCORP', replace_with: '- Works at ACME' },
        ungrounded,
      ),
    ).resolves.toMatch(/^error:/)

    // Assert the world: the line the model wanted gone is still there.
    expect(await readVault('agent/USER.md')).toContain('- Works at OLDCORP')

    // With a citation the thread actually holds, the same call goes through.
    await expect(
      tools.update_user_profile.handler(
        { op: 'replace', text: '- Works at OLDCORP', replace_with: '- Works at ACME', cited_turn: 'm7' },
        makeCtx(),
      ),
    ).resolves.toMatch(/profile updated/)
    expect(await readVault('agent/USER.md')).toContain('- Works at ACME')
  })
})

describe('update_agent_notes tool', () => {
  it('applies an add op through the store', async () => {
    const out = await callTool('update_agent_notes', { op: 'add', text: '- vault repo is owner/vault' })
    expect(out).toMatch(/profile updated \(\d+\/2000 chars\)/)
  })

  it('rejects an unknown op at the schema, before any handler runs', () => {
    const bad = tools.update_agent_notes.params.safeParse({ op: 'append', text: 'x' })
    expect(bad.success).toBe(false)
    expect(JSON.stringify(bad.error?.issues)).toContain('op')
  })
})

describe('schedule tools', () => {
  it('set_reminder with ISO time schedules fireReminder with a Date', async () => {
    const ctx = makeCtx()
    const out = await tools.set_reminder.handler({ when: '2026-07-07T09:00:00Z', text: 'stand up' }, ctx)
    expect(out).toMatch(/sched-1/)
    const [when, cb, payload] = (ctx.agent!.schedule as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(when).toBeInstanceOf(Date)
    expect(cb).toBe('fireReminder')
    expect(payload).toEqual({ text: 'stand up' })
  })

  it('set_scheduled_task with cron schedules runTask with the cron string', async () => {
    const ctx = makeCtx()
    await tools.set_scheduled_task.handler({ when: '0 8 * * *', prompt: 'search AI news and summarize' }, ctx)
    const [when, cb, payload] = (ctx.agent!.schedule as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(when).toBe('0 8 * * *')
    expect(cb).toBe('runTask')
    expect(payload).toEqual({ prompt: 'search AI news and summarize' })
  })

  it('refuses a task more frequent than hourly, and says what to send instead', async () => {
    // Mutation check: drop the `HOURLY_AT_MOST` test in `set_scheduled_task` and both schedule.
    const ctx = makeCtx()
    for (const when of ['* * * * *', '*/5 * * * *']) {
      expect(await tools.set_scheduled_task.handler({ when, prompt: 'poll' }, ctx)).toMatch(/^error: .*once an hour/)
    }
    expect(ctx.agent!.schedule).not.toHaveBeenCalled()
    // Reminders are one message, not a tool loop, so the floor does not apply to them.
    await tools.set_reminder.handler({ when: '*/5 * * * *', text: 'drink' }, ctx)
    expect(ctx.agent!.schedule).toHaveBeenCalledTimes(1)
  })

  it('refuses a task past the cap, counting tasks and not reminders', async () => {
    // Mutation check: remove the `MAX_SCHEDULED_TASKS` guard and the twenty-first schedules.
    const row = (i: number, callback: string): ScheduleInfo => ({
      id: `s${i}`,
      callback,
      payload: {},
      time: 1783500000,
      type: 'cron',
    })
    const withSchedules = (list: ScheduleInfo[]) =>
      makeCtx({
        agent: {
          schedule: vi.fn(async () => ({ id: 'sched-1' })),
          listSchedules: vi.fn(async () => list),
          cancelSchedule: vi.fn(async () => true),
        },
      })
    const full = Array.from({ length: MAX_SCHEDULED_TASKS }, (_, i) => row(i, 'runTask'))
    const ctx = withSchedules(full)
    expect(await tools.set_scheduled_task.handler({ when: '0 8 * * *', prompt: 'digest' }, ctx)).toMatch(
      /^error: 20 tasks/,
    )
    expect(ctx.agent!.schedule).not.toHaveBeenCalled()

    const roomy = withSchedules(full.map((s) => ({ ...s, callback: 'fireReminder' })))
    expect(await tools.set_scheduled_task.handler({ when: '0 8 * * *', prompt: 'digest' }, roomy)).toMatch(/sched-1/)
  })

  it('rejects garbage times at the schema, so nothing can be scheduled', () => {
    const bad = tools.set_reminder.params.safeParse({ when: 'someday maybe', text: 'x' })
    expect(bad.success).toBe(false)
    // The advice has to survive the move: it is what the model needs to send a usable time.
    expect(JSON.stringify(bad.error?.issues)).toMatch(/ISO datetime.*cron/)
  })

  it('parses a cron string and an ISO time into what the scheduler takes', () => {
    // `Agent.schedule` overloads on exactly this difference, so the transform is what decides it.
    const when = (v: string) => (tools.set_reminder.params.parse({ when: v, text: 'x' }) as { when: unknown }).when
    expect(when('0 8 * * *')).toBe('0 8 * * *')
    expect(when('2026-07-07T09:00:00Z')).toBeInstanceOf(Date)
  })

  it('list_scheduled formats schedules; cancel_scheduled reports both outcomes', async () => {
    const ctx = makeCtx({
      agent: {
        schedule: vi.fn(async () => ({ id: 's' })),
        listSchedules: vi.fn(async (): Promise<ScheduleInfo[]> => [
          {
            id: 'a1',
            callback: 'fireReminder',
            payload: { text: 'stand up' },
            time: 1783500000,
            type: 'scheduled',
          },
        ]),
        cancelSchedule: vi.fn(async (id: string) => id === 'a1'),
      },
    })
    const listed = await tools.list_scheduled.handler({}, ctx)
    expect(listed).toContain('a1')
    expect(listed).toContain('stand up')
    expect(listed).toContain('2026-')
    await expect(tools.cancel_scheduled.handler({ id: 'a1' }, ctx)).resolves.toMatch(/cancelled/)
    await expect(tools.cancel_scheduled.handler({ id: 'zz' }, ctx)).resolves.toMatch(/not found/)
  })

  it('list_scheduled reports when empty', async () => {
    await expect(tools.list_scheduled.handler({}, makeCtx())).resolves.toBe('(nothing scheduled)')
  })

  it("hides the agent's own alarms from the list and refuses to cancel them", async () => {
    // Mutation check: drop the callback filter in `userSchedules` and the running turn's row
    // lists as an empty task and is cancellable by id.
    const cancelSchedule = vi.fn(async () => true)
    const ctx = makeCtx({
      agent: {
        schedule: vi.fn(async () => ({ id: 's' })),
        listSchedules: vi.fn(async (): Promise<ScheduleInfo[]> => [
          { id: 'turn', callback: 'processWebMessage', payload: { text: 'hi' }, time: 1783500000, type: 'delayed' },
          { id: 'digest', callback: 'runTask', payload: { prompt: 'digest' }, time: 1783500000, type: 'cron' },
        ]),
        cancelSchedule,
      },
    })
    const listed = await tools.list_scheduled.handler({}, ctx)
    expect(listed).toContain('digest')
    expect(listed).not.toContain('turn')
    await expect(tools.cancel_scheduled.handler({ id: 'turn' }, ctx)).resolves.toMatch(/not found/)
    expect(cancelSchedule).not.toHaveBeenCalled()
    await expect(tools.cancel_scheduled.handler({ id: 'digest' }, ctx)).resolves.toMatch(/cancelled/)
  })
})

describe('skill tools', () => {
  it('list_skills renders slug, description, pin marker and use count', async () => {
    await seedVault({
      'agent/skills/daily-digest.md':
        '---\nname: Daily digest\ndescription: how to build the daily digest\ndate: 2026-07-06\nuse_count: 2\n---\n\nDo the thing.\n',
    })

    const out = await callTool('list_skills', {})
    expect(out).toContain('- daily-digest — how to build the daily digest (used 2×)')
  })

  it('list_skills reports when none exist', async () => {
    await expect(callTool('list_skills', {})).resolves.toBe('(no skills saved yet)')
  })

  it('read_skill returns a delimited skill body and a friendly miss message', async () => {
    await seedVault({
      'agent/skills/daily-digest.md':
        '---\nname: Daily digest\ndescription: how to build the daily digest\ndate: 2026-07-06\nuse_count: 2\n---\n\nDo the thing.\n',
    })

    const out = await callTool('read_skill', { name: 'daily-digest' })
    expect(out).toContain('<skill name="Daily digest">')
    expect(out).toContain('Do the thing.')

    await expect(callTool('read_skill', { name: 'nope' })).resolves.toBe('(no skill named "nope")')
    // read_skill stamps usage on the way out; the stamp must land on the file, not be lost.
    expect(await readVault('agent/skills/daily-digest.md')).toContain('use_count: 3')
  })

  it('save_skill writes through the store', async () => {
    await expect(callTool('save_skill', { name: 'New skill', description: 'd', content: 'c' })).resolves.toBe(
      'saved skill "new-skill"',
    )
  })

  it('buildTools exposes the skill tools but not archive_skill', () => {
    const names = buildTools().map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['list_skills', 'read_skill', 'save_skill']))
    expect(names).not.toContain('archive_skill')
  })
})

describe('web_search provider order', () => {
  it('uses Firecrawl alone when it is the only key present', async () => {
    fetchMock
      .get('https://api.firecrawl.dev')
      .intercept({ method: 'POST', path: '/v2/search' })
      .reply(
        200,
        { success: true, data: { web: [{ url: 'https://fc.example/', title: 'FC', description: 'from firecrawl' }] } },
        { headers: { 'content-type': 'application/json' } },
      )
    const out = await tools.web_search.handler({ query: 'x' }, makeCtx())
    expect(out).toBe('1. FC\nhttps://fc.example/\nfrom firecrawl')
  })

  it('reports no results as a fact, never as an instruction to retry', async () => {
    fetchMock
      .get('https://api.tavily.com')
      .intercept({ method: 'POST', path: '/search' })
      .reply(200, { results: [] }, { headers: { 'content-type': 'application/json' } })
    fetchMock
      .get('https://api.firecrawl.dev')
      .intercept({ method: 'POST', path: '/v2/search' })
      .reply(200, { success: true, data: { web: [] } }, { headers: { 'content-type': 'application/json' } })
    const out = await tools.web_search.handler({ query: 'x' }, makeCtx())
    expect(out).toBe('(no results)')
    expect(out).not.toMatch(/try again|rephrase/i)
  })
})

describe('research is not the model’s to reach for', () => {
  it('offers it no way to propose a run', () => {
    // Removed 2026-08-23; the composer's toggle is the only way in. Why: docs/decisions/research.md.
    expect(buildTools().map((t) => t.name)).not.toContain('deep_research')
  })
})

describe('read_research_report tool', () => {
  it('reads the report the user is looking at but the conversation never carried', async () => {
    const ctx = makeCtx({ pendingReport: () => 'The written report.' } as never)
    expect(await tools.read_research_report.handler({}, ctx)).toBe('The written report.')
  })

  it('records the cap an oversized report ran past', async () => {
    const events: Record<string, unknown>[] = []
    const ctx = makeCtx({
      pendingReport: () => 'r'.repeat(41_000),
      log: { turnId: 't', event: (f: Record<string, unknown>) => void events.push(f), error: () => {} },
    } as never)

    await tools.read_research_report.handler({}, ctx)

    // Mutation check: drop the `if` and this is empty. The two reports ever measured were ~10k, so
    // this line is the only thing that would say the distribution had moved.
    expect(events).toContainEqual(expect.objectContaining({ stage: 'over-first-view', chars: 41_000, cap: 40_000 }))
  })

  it('stays quiet about a report that fits', async () => {
    const events: Record<string, unknown>[] = []
    const ctx = makeCtx({
      pendingReport: () => 'r'.repeat(10_587),
      log: { turnId: 't', event: (f: Record<string, unknown>) => void events.push(f), error: () => {} },
    } as never)

    await tools.read_research_report.handler({}, ctx)

    expect(events).toEqual([])
  })

  it('says so rather than inventing one when nothing has finished', async () => {
    const out = await tools.read_research_report.handler({}, makeCtx({ pendingReport: () => undefined } as never))
    expect(out).toMatch(/^error:/)
  })

  // Absent wherever there is no agent state to read — a research scout — and the handler must not
  // assume the callback is there.
  it('says so where the entry point has no state at all', async () => {
    expect(await tools.read_research_report.handler({}, makeCtx())).toMatch(/^error:/)
  })
})

describe('the archive tools', () => {
  const page = 'A'.repeat(120_000)
  const record = { tool: 'read_page', args: '{"url":"https://x.example"}', content: page, at: 1_700_000_000_000 }
  const withArchive = () =>
    makeCtx({
      toolArchive: { save: () => 1, read: (ref: number) => (ref === 7 ? record : null), search: () => [] },
    } as never)

  it('reads a long result one window at a time and names the next offset', async () => {
    const first = await tools.read_tool_result.handler({ ref: 7, from: 0 }, withArchive())
    expect(first).toContain('chars="0-40000 of 120000"')
    expect(first).toContain('more="read_tool_result(7, 40000)"')

    // The whole reason this takes an offset: without it the second read returns the first window
    // again, which is what the model already had from `read_page`.
    const second = await tools.read_tool_result.handler({ ref: 7, from: 40_000 }, withArchive())
    expect(second).toContain('chars="40000-80000 of 120000"')
    expect(second).not.toBe(first)

    const last = await tools.read_tool_result.handler({ ref: 7, from: 80_000 }, withArchive())
    expect(last).toContain('chars="80000-120000 of 120000"')
    // Nothing left, so nothing is offered — otherwise the model reads past the end forever.
    expect(last).not.toContain('more=')

    // A full window plus the header must still fit the cap the loop trims to, or the middle is cut
    // out of the very page this tool exists to deliver whole — and `noArchive` leaves no ref to
    // recover it from. The two constants are set against each other, so nothing else catches this.
    // Not through `tools` above: that map is narrowed to what a handler call needs, and widening it
    // for one assertion would touch every test in this file.
    const cap = buildTools().find((t) => t.name === 'read_tool_result')!.maxResultChars!
    expect(first.length).toBeLessThanOrEqual(cap)
  })

  /**
   * Measured against the real model on 2026-09-01: a follow-up turn spent two `read_tool_result`
   * windows and its input went 4,900 → 16,621 → 26,662, because a window carried no ref and the
   * pruner only shortens what says where the rest is. It came *out* of the archive, so it can say
   * so — this is the one tool whose output is recoverable without ever being filed.
   */
  it('says which ref its window came from, so a later round may shorten it', async () => {
    const out = await tools.read_tool_result.handler({ ref: 7, from: 0 }, withArchive())

    // The same sentence the archiver writes, and the same one the loop matches on.
    expect(out).toContain('[kept whole as ref 7;')
    expect(out).toContain('read_tool_result(7, 0) returns it')
  })

  it('refuses an offset past the end rather than returning an empty block', async () => {
    const out = await tools.read_tool_result.handler({ ref: 7, from: 120_000 }, withArchive())
    expect(out).toMatch(/^error:/)
  })

  it('says so for a ref that was never kept', async () => {
    expect(await tools.read_tool_result.handler({ ref: 99, from: 0 }, withArchive())).toMatch(/^error:/)
  })

  // A research scout has no thread, so neither tool may pretend to have history.
  it('says so where there is no archive at all', async () => {
    expect(await tools.read_tool_result.handler({ ref: 7, from: 0 }, makeCtx())).toMatch(/^error:/)
    expect(await tools.search_tool_results.handler({ query: 'x' }, makeCtx())).toMatch(/^error:/)
  })
})

describe('search_tool_results', () => {
  const hit = (ref: number) => ({
    ref,
    at: 1_700_000_000_000,
    tool: 'read_page',
    args: `{"url":"https://x${ref}.example"}`,
    snippet: `matched text ${ref}`,
    total: 120_000,
  })
  const finding = (n: number) =>
    makeCtx({
      toolArchive: {
        save: () => 1,
        read: () => null,
        search: (_q: string, limit: number) => Array.from({ length: Math.min(n, limit) }, (_, i) => hit(i + 1)),
      },
    } as never)

  it('shows the snippet the database cut, with the ref and the archived size', async () => {
    const out = await tools.search_tool_results.handler({ query: 'text' }, finding(1))
    expect(out).toContain('ref="1"')
    expect(out).toContain('of="120000 chars"')
    expect(out).toContain('…matched text 1…')
  })

  it('says when the cap hid a match, rather than reading as "that is all"', async () => {
    // The tool asks for one more than it shows, so this is a fact about the archive and not a
    // guess. Without it the cap is a silent truncation of the kind this repo keeps a list of.
    const out = await tools.search_tool_results.handler({ query: 'text' }, finding(9))
    expect(out).toContain('ref="5"')
    expect(out).not.toContain('ref="6"')
    expect(out).toContain('at least one more match not shown')
  })

  it('takes the ref as a string too, which is how a model once sent it', async () => {
    // `{"ref": "6"}` for a ref it had just been shown as 6, and the call was refused. Mutation
    // check: `z.number()` again and the parse below throws.
    const record = { tool: 'read_page', args: '{"url":"https://x"}', content: 'A short page.', at: 1_700_000_000_000 }
    const ctx = makeCtx({
      toolArchive: { save: () => 1, read: (ref: number) => (ref === 7 ? record : null), search: () => [] },
    } as never)
    await expect(tools.read_tool_result.handler({ ref: '7', from: 0 }, ctx)).resolves.toContain('A short page.')
  })

  it('says nothing was fetched rather than inventing a search', async () => {
    const out = await tools.search_tool_results.handler({ query: 'text' }, finding(0))
    expect(out).toContain('use web_search or read_page')
    expect(out).not.toContain('more match')
  })
})

describe('passthrough schema tools (MCP)', () => {
  const MCP_SCHEMA = {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  }

  const passthrough: ToolDef = {
    name: 'files_search',
    description: 'searches the files server',
    schema: MCP_SCHEMA,
    handler: async (args: never) => `found ${(args as { query?: string }).query ?? 'nothing'}`,
  }

  it('sends the server schema to the model verbatim, zod untouched', () => {
    expect(toolSpec(passthrough).function.parameters).toEqual(MCP_SCHEMA)
  })

  it('falls back to the zod schema when no passthrough schema is set', () => {
    // Mutation check: make `toolSpec` read `schema` unconditionally and every native tool's
    // parameters on the wire collapse to `undefined`, which no turn test would catch.
    const native: ToolDef = {
      name: 'echo',
      description: 'echoes',
      params: z.object({ text: z.string().optional() }),
      handler: async (args: never) => `echo:${(args as { text?: string }).text ?? ''}`,
    }
    expect(toolSpec(native).function.parameters).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
    })
  })
})
