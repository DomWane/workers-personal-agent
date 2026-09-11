import { fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createLlmClient } from '@/connectors/llm.connector'
import { runResearchRound, runScoutWave, writeResearchReport, type ScoutOutcome } from '@/agent/research/runner'
import { MAX_SCOUTS, applyRound, proposeResearch, startResearch } from '@/agent/research/state'
import type { ResearchState } from '@/types'
import { SubrequestBudget } from '@/agent/subrequest-budget'
import type { ToolArchive, ToolContext } from '@/agent/tools/registry'
import type { ToolResultRecord } from '@/agent/archive'
import { requestBody } from '../helpers/request'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

const BASE = 'https://llm.example'
const CF = 'https://api.cloudflare.com'

const running = (over: Partial<ResearchState> = {}): ResearchState => ({
  ...(startResearch(proposeResearch('agent eval trends', ['who publishes']), 'run-1') as ResearchState),
  ...over,
})

/** A Map, which is what `ToolArchive` is an interface rather than a `SqlTag` for. */
function fakeArchive(): ToolArchive {
  const rows = new Map<number, ToolResultRecord & { at: number }>()
  return {
    save: (record) => {
      const ref = rows.size + 1
      rows.set(ref, { ...record, at: 0 })
      return ref
    },
    read: (ref) => rows.get(ref) ?? null,
    search: () => [],
  }
}

function ctxFor(budget: SubrequestBudget, env: Record<string, string> = {}): ToolContext {
  return {
    env: { CF_ACCOUNT_ID: 'test-account', CF_API_TOKEN: 'test-cf-token', VAULT_AGENT_DIR: 'agent', ...env },
    chatId: 7,
    agent: {},
    budget,
  } as unknown as ToolContext
}

function queueLlm(msg: Record<string, unknown>) {
  fetchMock
    .get(BASE)
    .intercept({ method: 'POST', path: '/v1/chat/completions' })
    .reply(200, { choices: [{ message: msg }] }, { headers: { 'content-type': 'application/json' } })
}

function queuePageRead(url = 'https://example.com/a') {
  queueLlm({
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_page', arguments: JSON.stringify({ url }) } }],
  })
  fetchMock
    .get(CF)
    .intercept({ method: 'POST', path: '/client/v4/accounts/test-account/browser-rendering/markdown' })
    .reply(
      200,
      {
        success: true,
        result: '# Findings\n\nA long enough article body to count as prose for the extractor to keep.',
      },
      { headers: { 'content-type': 'application/json' } },
    )
}

const NOTES = '## Findings\nTwo labs published in 2026.\n\n## Open questions\n- what about cost?\n\n## Done\nno'

describe('runResearchRound', () => {
  it('reports the pages it read, so the next round can skip them', async () => {
    queueLlm({
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_page', arguments: '{"url":"https://example.com/a"}' } },
      ],
    })
    fetchMock
      .get(CF)
      .intercept({ method: 'POST', path: '/client/v4/accounts/test-account/browser-rendering/markdown' })
      .reply(
        200,
        {
          success: true,
          result: '# Findings\n\nA long enough article body to count as prose for the extractor to keep.',
        },
        { headers: { 'content-type': 'application/json' } },
      )
    queueLlm({ content: NOTES })

    const budget = new SubrequestBudget()
    const result = await runResearchRound(running(), {
      client: createLlmClient('k', `${BASE}/v1`, budget.fetch),
      model: 'm',
      ctx: ctxFor(budget),
      budget,
    })

    expect(result.urls).toEqual(['https://example.com/a'])
    expect(result.findings).toBe('Two labs published in 2026.')
    expect(result.openQuestions).toEqual(['what about cost?'])
    expect(result.modelDone).toBe(false)
  })

  it('offers read_tool_result only where an archive can answer it', async () => {
    // Without an archive the marker naming a cut has nothing behind it and the pruner has no ref to
    // shorten, so results accumulate whole until the request overflows.
    const toolsAskedFor = async (ctx: ToolContext, budget: SubrequestBudget) => {
      let asked = ''
      fetchMock
        .get(BASE)
        .intercept({ method: 'POST', path: '/v1/chat/completions' })
        .reply(
          200,
          (opts) => {
            asked = requestBody(opts)
            return { choices: [{ message: { content: NOTES } }] }
          },
          { headers: { 'content-type': 'application/json' } },
        )
      await runResearchRound(running(), {
        client: createLlmClient('k', `${BASE}/v1`, budget.fetch),
        model: 'm',
        ctx,
        budget,
      })
      return asked
    }

    const withArchive = new SubrequestBudget()
    const offered = await toolsAskedFor({ ...ctxFor(withArchive), toolArchive: fakeArchive() }, withArchive)
    expect(offered).toContain('read_tool_result')

    // Mutation check: drop the `toolArchive` condition in `runResearchRound` and this contains it
    // too — a tool whose every call can only answer "no earlier results are available here".
    const bare = new SubrequestBudget()
    expect(await toolsAskedFor(ctxFor(bare), bare)).not.toContain('read_tool_result')
  })

  it('refuses to pay twice for a page an earlier round already read', async () => {
    // The prompt only shows a window of the visited list, so "do not re-read" is guidance, not
    // enforcement — past round four the older URLs are not even in front of the model.
    queueLlm({
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_page', arguments: '{"url":"https://example.com/old"}' } },
      ],
    })
    queueLlm({ content: NOTES })
    const budget = new SubrequestBudget()

    const result = await runResearchRound(running({ visited: ['https://example.com/old'] }), {
      client: createLlmClient('k', `${BASE}/v1`, budget.fetch),
      model: 'm',
      ctx: ctxFor(budget),
      budget,
    })

    expect(result.urls).toEqual([])
    // The spend is what proves it: a failed read looks the same from `urls`, because a page that
    // could not be fetched is not recorded either — but it is still charged for.
    expect(budget.spent).toBe(2)
  })

  it('counts a page it could not fetch as ground covered, not as a page read', async () => {
    // Otherwise a fetch outage reads as topical exhaustion: every read fails, no URL is recorded,
    // and the run stops with "found nothing new" while the topic is untouched.
    queueLlm({
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'read_page', arguments: '{"url":"https://example.com/dead"}' },
        },
      ],
    })
    fetchMock
      .get(CF)
      .intercept({ method: 'POST', path: '/client/v4/accounts/test-account/browser-rendering/markdown' })
      .reply(500, 'nope')
    queueLlm({ content: NOTES })

    const budget = new SubrequestBudget()
    const result = await runResearchRound(running(), {
      client: createLlmClient('k', `${BASE}/v1`, budget.fetch),
      model: 'm',
      ctx: ctxFor(budget),
      budget,
    })

    expect(result.urls).toEqual(['https://example.com/dead'])
    expect(result.readUrls).toEqual([])
  })

  it('charges the round for what it actually spent', async () => {
    queueLlm({ content: NOTES })
    const budget = new SubrequestBudget()

    const result = await runResearchRound(running(), {
      client: createLlmClient('k', `${BASE}/v1`, budget.fetch),
      model: 'm',
      ctx: ctxFor(budget),
      budget,
    })

    expect(result.spent).toBe(budget.spent)
    expect(result.spent).toBeGreaterThan(0)
  })

  it('asks for the write-up itself when the loop did not produce it', async () => {
    // Observed 2026-08-08: the loop's forced final call came back as leaked tool-call markup, so
    // nine pages of reading were thrown away. The pages are already paid for; one more call to
    // write them up is far cheaper than the round that fetched them.
    // The round has to have read something: findings a round could not source at all are dropped
    // before the retry ever matters, which is the failure this rescue exists for.
    queuePageRead()
    queueLlm({ content: 'I could not find anything structured.' })
    queueLlm({ content: '## Findings\nRescued on the retry.\n\n## Done\nno' })
    const budget = new SubrequestBudget()

    const result = await runResearchRound(running(), {
      client: createLlmClient('k', `${BASE}/v1`, budget.fetch),
      model: 'm',
      ctx: ctxFor(budget),
      budget,
    })

    expect(result.findings).toBe('Rescued on the retry.')
  })

  it('gives up after one retry rather than spending the round on reformatting', async () => {
    queuePageRead()
    queueLlm({ content: 'still prose' })
    queueLlm({ content: 'still prose when asked for the shape' })
    queueLlm({ content: 'still prose on the retry too' })
    const budget = new SubrequestBudget()

    const result = await runResearchRound(running({ findings: ['what we already knew'] }), {
      client: createLlmClient('k', `${BASE}/v1`, budget.fetch),
      model: 'm',
      ctx: ctxFor(budget),
      budget,
    })

    // Empty, not the earlier round's text: appending a copy would make the report say it twice.
    expect(result.findings).toBe('')
  })

  it('says out loud that a round produced no usable rewrite', async () => {
    // Observed 2026-08-08: a run spent 25 requests over two rounds and reported "(no findings)".
    // The only trace was notesChars staying at 0, which reads exactly like a round that searched
    // and found nothing.
    queueLlm({ content: 'I looked around but there is nothing structured to report.' })
    queueLlm({ content: 'nothing structured when asked for the shape' })
    queueLlm({ content: 'still nothing structured on the retry' })
    const events: Record<string, unknown>[] = []
    const budget = new SubrequestBudget()

    await runResearchRound(running(), {
      client: createLlmClient('k', `${BASE}/v1`, budget.fetch),
      model: 'm',
      ctx: ctxFor(budget),
      budget,
      log: { turnId: 't', event: (f: Record<string, unknown>) => void events.push(f), error: () => {} } as never,
    })

    expect(events).toContainEqual(expect.objectContaining({ at: 'research', stage: 'unparsed-round' }))
  })

  it('leaves the earlier rounds untouched when this one answers in prose', async () => {
    // A wasted round costs the round, not the run: what earlier rounds found is in the state and
    // this result adds nothing to it.
    queueLlm({ content: 'I looked around but there is nothing structured to report.' })
    queueLlm({ content: 'prose when asked for the shape' })
    queueLlm({ content: 'and the retry is prose too' })
    const budget = new SubrequestBudget()
    const before = running({ findings: ['what we already knew'], openQuestions: ['still open?'] })

    const result = await runResearchRound(before, {
      client: createLlmClient('k', `${BASE}/v1`, budget.fetch),
      model: 'm',
      ctx: ctxFor(budget),
      budget,
    })

    expect(applyRound(before, result).findings).toEqual(['what we already knew'])
    expect(result.openQuestions).toEqual(['still open?'])
  })

  it('writes the report once from every round, not from the last one', async () => {
    // The point of appending: the write sees all twelve rounds, so each was compressed once
    // instead of being rewritten eleven more times.
    let asked = ''
    fetchMock
      .get(BASE)
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        (opts) => {
          asked = requestBody(opts)
          return {
            choices: [{ message: { content: 'the written report' } }],
            usage: { prompt_tokens: 1200, completion_tokens: 300 },
          }
        },
        { headers: { 'content-type': 'application/json' } },
      )
    const budget = new SubrequestBudget()

    const out = await writeResearchReport(running({ findings: ['round one found A', 'round two found B'] }), {
      client: createLlmClient('k', `${BASE}/v1`, budget.fetch),
      model: 'm',
      budget,
    })

    expect(out.text).toBe('the written report')
    // The one call of a run that is not a tool loop, so its usage is read here or lost.
    expect(out.tokens).toBe(1500)
    expect(asked).toContain('round one found A')
    expect(asked).toContain('round two found B')
  })

  it('reports its running counts as it goes, and keys every url the way the cache does', async () => {
    // The counts are what a scout sends its parent mid-wave. The key is what keeps `/a/` and `/a`
    // from being two visited pages. Mutation checks: drop `onProgress` and the list is empty; store
    // the raw url and `urls` carries the slash.
    queuePageRead('https://example.com/a/')
    queueLlm({ content: NOTES })
    const budget = new SubrequestBudget()
    const progress: { reads: number; searches: number }[] = []

    const result = await runResearchRound(running(), {
      client: createLlmClient('k', `${BASE}/v1`, budget.fetch),
      model: 'm',
      ctx: ctxFor(budget),
      budget,
      onProgress: (p) => progress.push({ ...p }),
    })

    expect(progress).toEqual([{ reads: 1, searches: 0 }])
    expect(result.urls).toEqual(['https://example.com/a'])
    expect(result.readUrls).toEqual(['https://example.com/a'])
  })

  it('reports what the round spent, as the provider counted it', async () => {
    // Mutation check: drop `tokens` from the result and the card has nothing to sum.
    fetchMock
      .get(BASE)
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        {
          choices: [{ message: { content: '## Findings\nCovered.\n\n## Done\nyes' } }],
          usage: { prompt_tokens: 900, completion_tokens: 100 },
        },
        { headers: { 'content-type': 'application/json' } },
      )
    const budget = new SubrequestBudget()

    const result = await runResearchRound(running(), {
      client: createLlmClient('k', `${BASE}/v1`, budget.fetch),
      model: 'm',
      ctx: ctxFor(budget),
      budget,
    })

    expect(result.tokens).toBe(1000)
  })

  it('carries the model verdict through when it says it is done', async () => {
    queueLlm({ content: '## Findings\nCovered.\n\n## Done\nyes' })
    const budget = new SubrequestBudget()

    const result = await runResearchRound(running(), {
      client: createLlmClient('k', `${BASE}/v1`, budget.fetch),
      model: 'm',
      ctx: ctxFor(budget),
      budget,
    })

    expect(result.modelDone).toBe(true)
  })
})

describe('runScoutWave', () => {
  const outcome = (angle: string, over: Partial<ScoutOutcome> = {}): ScoutOutcome => ({
    angle,
    findings: `f:${angle}`,
    openQuestions: [],
    urls: [],
    readUrls: [],
    spent: 0,
    ...over,
  })

  it('sends one scout per angle and returns them in plan order', async () => {
    const seen: string[] = []
    const out = await runScoutWave(['a', 'b', 'c'], async (angle) => {
      seen.push(angle)
      return outcome(angle)
    })
    expect(seen).toEqual(['a', 'b', 'c'])
    expect(out.map((o) => o.angle)).toEqual(['a', 'b', 'c'])
  })

  it('runs them at once rather than one after another', async () => {
    // The whole case for the wave is concurrency: awaiting children costs this invocation no CPU
    // and each gets its own fifty subrequests.
    let running = 0
    let peak = 0
    await runScoutWave(['a', 'b', 'c'], async (angle) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return outcome(angle)
    })
    expect(peak).toBe(3)
  })

  it('caps the wave and says so, rather than fanning out over a runaway plan', async () => {
    const events: Record<string, unknown>[] = []
    const angles = Array.from({ length: MAX_SCOUTS + 2 }, (_, i) => `angle-${i}`)
    const out = await runScoutWave(angles, async (angle) => outcome(angle), {
      turnId: 't',
      event: (f) => events.push(f),
      error: () => {},
    })
    expect(out).toHaveLength(MAX_SCOUTS)
    expect(events).toContainEqual(
      expect.objectContaining({ stage: 'scouts-truncated', total: angles.length, sent: MAX_SCOUTS }),
    )
  })

  it('carries on when one angle throws, instead of losing the whole wave', async () => {
    const errors: Record<string, unknown>[] = []
    const out = await runScoutWave(
      ['a', 'b'],
      async (angle) => {
        if (angle === 'a') {
          throw new Error('scout blew up')
        }
        return outcome(angle)
      },
      { turnId: 't', event: () => {}, error: (f) => errors.push(f) },
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ angle: 'a', findings: '', error: expect.stringContaining('scout blew up') })
    expect(out[1]).toMatchObject({ angle: 'b', findings: 'f:b' })
    expect(errors).toContainEqual(expect.objectContaining({ stage: 'scout-failed', angle: 'a' }))
  })
})

describe('a round with nothing to source from', () => {
  it('drops findings the round could not have got from anywhere', async () => {
    // Two scouts on the first real run opened no page and saw no search result, and still wrote
    // two thousand characters each. That is the model's memory, not research, and the report is
    // written from these entries.
    queueLlm({ content: '## Findings\nRecalled from nowhere.\n\n## Done\nno' })
    const events: Record<string, unknown>[] = []
    const budget = new SubrequestBudget()

    const result = await runResearchRound(running(), {
      client: createLlmClient('k', `${BASE}/v1`, budget.fetch),
      model: 'm',
      ctx: ctxFor(budget),
      budget,
      log: { turnId: 't', event: (f: Record<string, unknown>) => void events.push(f), error: () => {} } as never,
    })

    expect(result.findings).toBe('')
    expect(events).toContainEqual(expect.objectContaining({ stage: 'ungrounded-round' }))
  })

  it('keeps findings sourced from a search result alone', async () => {
    // A claim cited from a snippet is honest sourcing; the round need not have opened the page.
    queueLlm({
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"q"}' } }],
    })
    fetchMock
      .get('https://api.firecrawl.dev')
      .intercept({ method: 'POST', path: '/v2/search' })
      .reply(
        200,
        { success: true, data: { web: [{ title: 'T', url: 'https://found.example/x', description: 'd' }] } },
        { headers: { 'content-type': 'application/json' } },
      )
    queueLlm({ content: '## Findings\nFrom the snippet.\n\n## Done\nno' })
    const budget = new SubrequestBudget()

    const result = await runResearchRound(running(), {
      client: createLlmClient('k', `${BASE}/v1`, budget.fetch),
      model: 'm',
      ctx: ctxFor(budget, { FIRECRAWL_API_KEY: 'test-fc-key' }),
      budget,
    })

    expect(result.findings).toBe('From the snippet.')
    expect(result.seenUrls).toEqual(['https://found.example/x'])
    expect(result.readUrls).toEqual([])
  })

  it('names the queries that came back empty, since a count cannot say which', async () => {
    queueLlm({
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'web_search', arguments: '{"query":"a very long natural language question"}' },
        },
      ],
    })
    // Both vendors run keyless now, so an empty web needs both to answer empty.
    fetchMock
      .get('https://api.tavily.com')
      .intercept({ method: 'POST', path: '/search' })
      .reply(200, { results: [] }, { headers: { 'content-type': 'application/json' } })
    fetchMock
      .get('https://api.firecrawl.dev')
      .intercept({ method: 'POST', path: '/v2/search' })
      .reply(200, { success: true, data: { web: [] } }, { headers: { 'content-type': 'application/json' } })
    queueLlm({ content: '## Findings\nNothing.\n\n## Done\nno' })
    const events: [Record<string, unknown>, unknown][] = []
    const budget = new SubrequestBudget()

    await runResearchRound(running(), {
      client: createLlmClient('k', `${BASE}/v1`, budget.fetch),
      model: 'm',
      ctx: ctxFor(budget, { FIRECRAWL_API_KEY: 'test-fc-key' }),
      budget,
      log: {
        turnId: 't',
        event: (f: Record<string, unknown>, c: unknown) => void events.push([f, c]),
        error: () => {},
      } as never,
    })

    const round = events.find(([f]) => f.stage === 'round-tools')
    expect(round?.[0]).toMatchObject({ emptySearches: 1 })
    expect(JSON.stringify(round?.[1])).toContain('a very long natural language question')
  })
})
