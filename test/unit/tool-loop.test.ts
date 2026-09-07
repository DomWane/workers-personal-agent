import { fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createLlmClient } from '../../src/connectors/llm.connector'
import { createLog, type TurnLog } from '../../src/agent/log'
import { FINAL_ANSWER_RESERVE, PRUNE_OVER_CHARS, runToolLoop, turnToolTraffic } from '../../src/agent/tool-loop'
import { resultCap } from '../../src/agent/context-window'
import { rethrowIfExhausted, SubrequestBudget } from '../../src/agent/subrequest-budget'
import { defineTool, type ToolContext, type ToolDef } from '../../src/agent/tools/registry'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

const BASE = 'https://llm.example'
const ctx = { env: {}, chatId: 1, agent: {} } as unknown as ToolContext

function queueResponse(msg: Record<string, unknown>, capture?: (b: Record<string, unknown>) => void) {
  fetchMock
    .get(BASE)
    .intercept({ method: 'POST', path: '/v1/chat/completions' })
    .reply(200, ({ body }) => (capture?.(JSON.parse(body as string)), { choices: [{ message: msg }] }), {
      headers: { 'content-type': 'application/json' },
    })
}

const echoTool: ToolDef = defineTool({
  name: 'echo',
  description: 'echoes',
  params: z.object({ text: z.string().optional() }),
  handler: async (args) => `echo:${args.text}`,
})

/** The loop dispatches by name, so fixtures vary only in that and in what the handler does. */
const named = (name: string, handler: (args: unknown, ctx: ToolContext) => Promise<string>, timeoutMs?: number) =>
  defineTool({ name, description: 'echoes', params: z.object({}), handler, timeoutMs })

function loop(tools: ToolDef[], overrides: Partial<Parameters<typeof runToolLoop>[0]> = {}) {
  return runToolLoop({
    client: createLlmClient('k', `${BASE}/v1`),
    model: 'z-ai/glm-5.2',
    systemPrompt: 'You are a test.',
    history: [{ role: 'user', content: 'go' }],
    tools,
    ctx,
    ...overrides,
  })
}

describe('runToolLoop', () => {
  it('returns immediately when the model answers without tools', async () => {
    queueResponse({ content: 'plain answer' })
    await expect(loop([echoTool])).resolves.toMatchObject({
      text: 'plain answer',
      toolsUsed: [],
      stopReason: 'complete',
      roundsUsed: 1,
    })
  })

  it('returns a fallback string when the model replies with empty content and no tool calls', async () => {
    queueResponse({ content: '' })
    await expect(loop([echoTool])).resolves.toMatchObject({
      text: '(no answer produced — try rephrasing)',
      toolsUsed: [],
      stopReason: 'complete',
      roundsUsed: 1,
    })
  })

  it('executes a tool call, feeds the result back, returns the final answer', async () => {
    let second: Record<string, unknown> | undefined
    queueResponse({
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"text":"hi"}' } }],
    })
    queueResponse({ content: 'done' }, (b) => (second = b))

    const out = await loop([echoTool])
    expect(out).toMatchObject({ text: 'done', toolsUsed: ['echo'], stopReason: 'complete', roundsUsed: 2 })
    const msgs = second?.messages as Record<string, unknown>[]
    // system, user, assistant(tool_calls), tool result
    expect(msgs.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: 'echo:hi' })
    expect(msgs.at(-2)).toMatchObject({ role: 'assistant' })
  })

  it('feeds error strings back for unknown tools and bad arguments', async () => {
    let second: Record<string, unknown> | undefined
    queueResponse({
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'nope', arguments: '{}' } },
        { id: 'c2', type: 'function', function: { name: 'echo', arguments: 'not-json' } },
      ],
    })
    queueResponse({ content: 'recovered' }, (b) => (second = b))

    const out = await loop([echoTool])
    expect(out.text).toBe('recovered')
    const msgs = second?.messages as { role: string; content: string }[]
    expect(msgs.at(-2)?.content).toMatch(/error: unknown tool nope/)
    expect(msgs.at(-1)?.content).toMatch(/error: invalid arguments/)
  })

  it('names the field when an argument has the wrong type, and never enters the handler', async () => {
    // The model is the sender, so a field declared `string` can arrive as an object. It used to
    // reach the handler and be stringified into `[object Object]`; now it comes back as something
    // the model can act on, which it only can if the message says which field was wrong.
    let entered = false
    const strict = defineTool({
      name: 'strict',
      description: 'wants a string',
      params: z.object({ text: z.string() }),
      handler: async () => {
        entered = true
        return 'ran'
      },
    })
    let second: Record<string, unknown> | undefined
    queueResponse({
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'strict', arguments: '{"text":{"a":1}}' } }],
    })
    queueResponse({ content: 'ok' }, (b) => (second = b))

    await loop([strict])
    expect(entered).toBe(false)
    expect((second!.messages as { content: string }[]).at(-1)?.content).toMatch(/invalid arguments[\s\S]*at text/)
  })

  it('converts handler failures and timeouts into tool results', async () => {
    const boom = named('boom', async () => {
      throw new Error('kaput')
    })
    const slow = named('slow', () => new Promise((r) => setTimeout(() => r('late'), 5_000)))
    let second: Record<string, unknown> | undefined
    queueResponse({
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'boom', arguments: '{}' } },
        { id: 'c2', type: 'function', function: { name: 'slow', arguments: '{}' } },
      ],
    })
    queueResponse({ content: 'ok' }, (b) => (second = b))

    const out = await loop([boom, slow], { perToolTimeoutMs: 50 })
    expect(out.text).toBe('ok')
    const msgs = second?.messages as { content: string }[]
    expect(msgs.at(-2)?.content).toMatch(/error: kaput/)
    expect(msgs.at(-1)?.content).toMatch(/error: tool timed out/)
  })

  it('lets a per-tool timeoutMs override win over the default perToolTimeoutMs', async () => {
    const slowButAllowed = named('slow_ok', () => new Promise((r) => setTimeout(() => r('made it'), 100)), 200)
    let second: Record<string, unknown> | undefined
    queueResponse({
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'slow_ok', arguments: '{}' } }],
    })
    queueResponse({ content: 'ok' }, (b) => (second = b))

    const out = await loop([slowButAllowed], { perToolTimeoutMs: 50 })
    expect(out.text).toBe('ok')
    const msgs = second?.messages as { content: string }[]
    expect(msgs.at(-1)?.content).toBe('made it')
  })

  it('skips the forced final answer when the caller says it will ask for itself', async () => {
    // Measured 2026-08-08: three rounds out of three, the forced tool_choice:'none' call came back
    // as leaked tool-call markup. A caller that has to ask again in its own shape anyway pays for
    // that call twice.
    const captured: Record<string, unknown>[] = []
    // Different arguments each round: identical tool results would trip the no-progress guard and
    // the loop would stop for that reason instead of at the cap.
    for (const arg of ['x', 'y']) {
      queueResponse(
        {
          content: null,
          tool_calls: [{ id: `c${arg}`, type: 'function', function: { name: 'echo', arguments: `{"text":"${arg}"}` } }],
        },
        (b) => captured.push(b),
      )
    }

    const out = await loop([echoTool], { maxRounds: 2, forceFinalAnswer: false })

    expect(out.text).toBe('')
    expect(out.stopReason).toBe('max-rounds')
    // Two rounds, no third call: assertNoPendingInterceptors would not catch a call that never
    // had an interceptor, so count them.
    expect(captured).toHaveLength(2)
    expect(out.messages.at(-1)).toMatchObject({ role: 'tool' })
  })

  it('forces a final answer with tool_choice none at the round cap', async () => {
    const captured: Record<string, unknown>[] = []
    // maxRounds 2: two tool-call rounds, then the forced final call
    for (let i = 0; i < 2; i++) {
      queueResponse(
        {
          content: null,
          tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'echo', arguments: '{"text":"x"}' } }],
        },
        (b) => captured.push(b),
      )
    }
    queueResponse({ content: 'forced final' }, (b) => captured.push(b))

    const out = await loop([echoTool], { maxRounds: 2 })
    expect(out.text).toBe('forced final')
    expect(captured.at(-1)).toMatchObject({ tool_choice: 'none' })
  })
})

describe('runToolLoop — leak and convergence guards', () => {
  const call = (name: string, args: string, id = 'c1') => ({
    id,
    type: 'function',
    function: { name, arguments: args },
  })

  it('never returns a tool call leaked as prose', async () => {
    queueResponse({ content: '<tool_call>read_page<arg_key>url</arg_key><arg_value>https://x</arg_value></tool_call>' })
    await expect(loop([echoTool])).resolves.toMatchObject({
      text: '(no answer produced — try rephrasing)',
      toolsUsed: [],
      stopReason: 'complete',
      roundsUsed: 1,
    })
  })

  it('catches the leak in the fullwidth-pipe form some providers emit', async () => {
    // Observed 2026-08-08 from deepseek-v4-flash via StreamLake, on a forced tool_choice:'none'
    // call. The guard used ASCII '|' and this markup uses U+FF5C, so 362 characters of it went
    // straight through as the answer.
    queueResponse({
      content:
        '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="read_page">\n<｜DSML｜parameter name="url" string="true">https://x</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>',
    })
    await expect(loop([echoTool])).resolves.toMatchObject({ text: '(no answer produced — try rephrasing)' })
  })

  it('stops calling a tool that keeps returning the same result', async () => {
    // A tool whose output never changes: the model would otherwise burn every round.
    const stuck = defineTool({
      name: 'stuck',
      description: 'always empty',
      params: z.object({}),
      handler: async () => '(no results)',
    })
    queueResponse({ content: null, tool_calls: [call('stuck', '{"q":"a"}')] })
    queueResponse({ content: null, tool_calls: [call('stuck', '{"q":"b"}', 'c2')] })
    queueResponse({ content: 'answering without more searching' })

    const out = await loop([stuck])
    expect(out.toolsUsed).toEqual(['stuck', 'stuck'])
    expect(out.text).toBe('answering without more searching')
  })
})

describe('runToolLoop under a subrequest budget', () => {
  it('stops looping while enough budget remains to answer, and answers', async () => {
    const budget = new SubrequestBudget(FINAL_ANSWER_RESERVE + 1)
    // One round fits; the second would leave too little for the final call and the send.
    queueResponse({
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"text":"hi"}' } }],
    })
    queueResponse({ content: 'answered before the cap' })

    const out = await loop([echoTool], {
      client: createLlmClient('k', `${BASE}/v1`, budget.fetch),
      subrequests: budget,
    })

    expect(out.text).toBe('answered before the cap')
    expect(budget.spent).toBe(2)
  })

  it('returns the last content instead of throwing when nothing is left', async () => {
    const budget = new SubrequestBudget(1)
    budget.charge(1)
    // No interceptor queued: an exhausted budget must not attempt a call at all.
    const out = await loop([echoTool], { subrequests: budget })

    expect(out.text).toContain('ran out of its request budget')
    expect(budget.spent).toBe(1)
  })
})

describe('runToolLoop — cost and timing per round', () => {
  it('carries usage and durationMs onto the round record', async () => {
    fetchMock
      .get(BASE)
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        {
          provider: 'Baidu',
          usage: { prompt_tokens: 1840, completion_tokens: 96, completion_tokens_details: { reasoning_tokens: 12 } },
          choices: [{ message: { content: 'done' } }],
        },
        { headers: { 'content-type': 'application/json' } },
      )

    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await runToolLoop({
        client: createLlmClient('k', `${BASE}/v1`),
        model: 'm',
        systemPrompt: 's',
        history: [{ role: 'user', content: 'hi' }],
        tools: [echoTool],
        ctx,
      })
    } finally {
      spy.mockRestore()
    }

    const round = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r.at === 'tool-loop' && r.stage === 'round')

    expect(round?.usage).toEqual({ inputTokens: 1840, outputTokens: 96, reasoningTokens: 12 })
    // Per round rather than per turn: a turn total cannot say which round was expensive.
    expect(typeof round?.durationMs).toBe('number')
    expect(round?.durationMs as number).toBeGreaterThanOrEqual(0)
  })

  it('leaves usage off the record when the provider reported none', async () => {
    queueResponse({ content: 'done' })

    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await runToolLoop({
        client: createLlmClient('k', `${BASE}/v1`),
        model: 'm',
        systemPrompt: 's',
        history: [{ role: 'user', content: 'hi' }],
        tools: [echoTool],
        ctx,
      })
    } finally {
      spy.mockRestore()
    }

    const round = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r.at === 'tool-loop' && r.stage === 'round')
    expect(round).toBeDefined()
    expect('usage' in (round as object)).toBe(false)
  })
})

describe('runToolLoop — stopReason', () => {
  const toolCall = (name: string, args: string, id = 'c1') => ({
    id,
    type: 'function',
    function: { name, arguments: args },
  })

  function doneRecord(lines: string[]): Record<string, unknown> | undefined {
    return lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r.at === 'tool-loop' && r.stage === 'done')
  }

  async function capture(run: () => Promise<{ stopReason?: string }>) {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      const out = await run()
      return { out, done: doneRecord(lines) }
    } finally {
      spy.mockRestore()
    }
  }

  it('reports complete when the model answers on its own', async () => {
    queueResponse({ content: 'plain answer' })
    const { out, done } = await capture(() => loop([echoTool]))
    expect(out.stopReason).toBe('complete')
    expect(done?.stopReason).toBe('complete')
  })

  it('reports max-rounds when the loop runs out of rounds', async () => {
    queueResponse({ content: null, tool_calls: [toolCall('echo', '{"text":"a"}')] })
    queueResponse({ content: 'forced answer' })
    const { out, done } = await capture(() => loop([echoTool], { maxRounds: 1 }))
    expect(out.stopReason).toBe('max-rounds')
    expect(done?.stopReason).toBe('max-rounds')
  })

  it('reports time-budget when the wall clock runs out', async () => {
    queueResponse({ content: 'forced answer' })
    const { out, done } = await capture(() => loop([echoTool], { budgetMs: -1 }))
    expect(out.stopReason).toBe('time-budget')
    expect(done?.stopReason).toBe('time-budget')
  })

  it('reports subrequest-budget when only the reserve is left', async () => {
    // One below the reserve: the loop must not start a round, but the final answer call
    // still fits and still has to be made.
    const budget = new SubrequestBudget(FINAL_ANSWER_RESERVE - 1)
    queueResponse({ content: 'forced answer' })
    const { out, done } = await capture(() =>
      loop([echoTool], {
        client: createLlmClient('k', `${BASE}/v1`, budget.fetch),
        subrequests: budget,
      }),
    )
    expect(out.stopReason).toBe('subrequest-budget')
    expect(done?.stopReason).toBe('subrequest-budget')
  })

  it('reports no-progress when the same call is answered the same way twice', async () => {
    const stuck = defineTool({
      name: 'stuck',
      description: 'always empty',
      params: z.object({}),
      handler: async () => '(no results)',
    })
    // The *same* arguments both rounds: that is what makes it a loop rather than a second attempt.
    queueResponse({ content: null, tool_calls: [toolCall('stuck', '{"q":"a"}')] })
    queueResponse({ content: null, tool_calls: [toolCall('stuck', '{"q":"a"}', 'c2')] })
    queueResponse({ content: 'answering without more searching' })
    const { out, done } = await capture(() => loop([stuck]))
    expect(out.stopReason).toBe('no-progress')
    expect(done?.stopReason).toBe('no-progress')
  })

  it('keeps going when a different call fails the same way', async () => {
    // A rate limit answers every URL with one string. Keyed on the result alone this read as a model
    // going in circles, and it ended two of four scouts on a real research run: the refusal was the
    // world's, and asking about a different page is progress whatever comes back.
    //
    // Mutation check: drop `call.function.arguments` from the repeat key in `runToolLoop` and this
    // stops at `no-progress` on round two, never reaching the answer below.
    const limited = defineTool({
      name: 'read_page',
      description: 'reads',
      params: z.object({ url: z.string() }),
      handler: async () => 'error: Rate limit exceeded',
    })
    queueResponse({ content: null, tool_calls: [toolCall('read_page', '{"url":"https://a.example"}')] })
    queueResponse({ content: null, tool_calls: [toolCall('read_page', '{"url":"https://b.example"}', 'c2')] })
    queueResponse({ content: 'both refused, reporting from what I have' })

    const out = await loop([limited])

    expect(out.stopReason).toBe('complete')
    expect(out.text).toBe('both refused, reporting from what I have')
    // Three: two refused reads, and the round that answered anyway.
    expect(out.roundsUsed).toBe(3)
  })

  it('reports the spent budget, not the identical refusals it produced', async () => {
    // Two calls turned away for the same reason are the same string, and the repeat guard read
    // that as a model going in circles — hiding the fault that actually stopped the turn.
    const budget = new SubrequestBudget(10)
    const greedy = defineTool({
      name: 'greedy',
      description: 'spends',
      params: z.object({}),
      handler: async () => {
        budget.charge(3)
        return '(no results)'
      },
    })
    queueResponse({
      content: null,
      tool_calls: [toolCall('greedy', '{"q":"a"}'), toolCall('greedy', '{"q":"b"}', 'c2')],
    })
    queueResponse({ content: 'answered with what I had' })

    const { out, done } = await capture(() =>
      loop([greedy], { client: createLlmClient('k', `${BASE}/v1`, budget.fetch), subrequests: budget }),
    )

    expect(out.stopReason).toBe('subrequest-budget')
    expect(done?.stopReason).toBe('subrequest-budget')
  })

  it('carries exactly one reason and none of the booleans it replaced', async () => {
    // Three independent flags could be true at once and said nothing about which fired first.
    queueResponse({ content: 'plain answer' })
    const { done } = await capture(() => loop([echoTool]))
    for (const gone of ['budgetHit', 'subrequestsHit', 'noProgress']) {
      expect(done).not.toHaveProperty(gone)
    }
    expect(typeof done?.stopReason).toBe('string')
  })
})

describe('runToolLoop — content segregation', () => {
  const toolCall = {
    id: 'c1',
    type: 'function',
    function: { name: 'echo', arguments: '{"text":"kdy má máma narozeniny"}' },
  }

  async function recordsFrom(log?: ReturnType<typeof createLog>) {
    queueResponse({ content: null, tool_calls: [toolCall] })
    queueResponse({ content: 'done' })
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await loop([echoTool], log ? { log } : {})
    } finally {
      spy.mockRestore()
    }
    return lines.map((l) => JSON.parse(l) as Record<string, unknown>)
  }

  it('keeps every message body out of the records by default', async () => {
    const records = await recordsFrom()
    for (const r of records) {
      expect('content' in r).toBe(false)
    }
    // Nor may the old top-level fields survive as a back door.
    for (const r of records) {
      expect(r.args).toBeUndefined()
      expect(r.resultHead).toBeUndefined()
      expect(r.sample).toBeUndefined()
    }
    expect(JSON.stringify(records)).not.toContain('narozeniny')
  })

  it('carries args and resultHead on the tool-result record when enabled', async () => {
    const records = await recordsFrom(createLog('dev', { content: true }))
    const toolResult = records.find((r) => r.stage === 'tool-result')
    expect(toolResult?.content).toMatchObject({
      args: '{"text":"kdy má máma narozeniny"}',
      resultHead: 'echo:kdy má máma narozeniny',
    })
  })

  it('carries the sample on a round record when the model leaked or was cut off', async () => {
    fetchMock
      .get(BASE)
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        { choices: [{ finish_reason: 'length', message: { content: 'cut off mid-sen' } }] },
        { headers: { 'content-type': 'application/json' } },
      )
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await loop([echoTool], { log: createLog('dev', { content: true }) })
    } finally {
      spy.mockRestore()
    }
    const round = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((r) => r.stage === 'round')
    expect(round?.content).toMatchObject({ sample: 'cut off mid-sen' })
  })
})

describe('runToolLoop — the reserve holds inside a round, not just between rounds', () => {
  const call = (id: string) => ({ id, type: 'function', function: { name: 'greedy', arguments: '{}' } })

  it('stops executing tool calls once the reserve is all that is left', async () => {
    // The model can ask for many tools in one round. Checking the budget only at the top of the
    // round let a single round spend far past the reserve — a real turn hit 55 of 50 that way.
    const budget = new SubrequestBudget(10)
    const executed: string[] = []
    const greedy = defineTool({
      name: 'greedy',
      description: 'spends',
      params: z.object({}),
      handler: async () => {
        // Charged before the tally, so this counts only calls the budget *allowed* to spend — a
        // handler that counted on entry would count the refusals too.
        budget.charge(2)
        executed.push('run')
        // Distinct results, or the no-progress guard fires first and hides what is under test.
        return `ok ${executed.length}`
      },
    })

    let finalBody: Record<string, unknown> | undefined
    queueResponse({ content: null, tool_calls: [call('c1'), call('c2'), call('c3')] })
    queueResponse({ content: 'answered with what I had' }, (b) => (finalBody = b))

    const out = await runToolLoop({
      client: createLlmClient('k', `${BASE}/v1`, budget.fetch),
      model: 'm',
      systemPrompt: 's',
      history: [{ role: 'user', content: 'go' }],
      tools: [greedy],
      ctx,
      subrequests: budget,
    })

    // One, not two: 1 for the round plus 2 for the first tool leaves exactly the reserve, so the
    // second is turned away at 4 of 4 and never runs.
    expect(executed).toHaveLength(1)
    expect(out.stopReason).toBe('subrequest-budget')
    // Exact rather than "at most", which is all a check before each call could promise.
    expect(budget.remaining).toBe(FINAL_ANSWER_RESERVE)

    // Every tool_call still needs an answer or the next request is rejected for an unmatched id.
    const messages = finalBody?.messages as { role: string; tool_call_id?: string }[]
    const answered = messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
    expect(answered).toEqual(['c1', 'c2', 'c3'])
  })
})

describe('the tool archive', () => {
  const call = (name: string) => ({ id: 'c1', type: 'function', function: { name, arguments: '{"p":1}' } })

  /** What the model was actually handed — the assertions here are all about that text. */
  const toolMessage = (body?: Record<string, unknown>) =>
    ((body?.messages ?? []) as { role: string; content: string }[]).find((m) => m.role === 'tool')

  /** The seam the loop writes through, as a list so a test can assert on what was filed. */
  function fakeArchive() {
    const rows: Array<{ tool: string; args: string; content: string }> = []
    return { rows, save: (r: (typeof rows)[number]) => rows.push(r) }
  }

  const withArchive = (archive: ReturnType<typeof fakeArchive>) =>
    ({ ...ctx, toolArchive: archive }) as unknown as ToolContext

  const doc = (name: string, chars: number) => named(name, async () => 'y'.repeat(chars))
  const failing = (name: string, chars: number) => named(name, async () => `error: ${'x'.repeat(chars)}`)

  it('files a long result whole and tells the model its ref', async () => {
    const archive = fakeArchive()
    let secondBody: Record<string, unknown> | undefined
    queueResponse({ content: null, tool_calls: [call('big')] })
    queueResponse({ content: 'done' }, (b) => (secondBody = b))

    await loop([doc('big', 9000)], { ctx: withArchive(archive) })

    expect(archive.rows).toHaveLength(1)
    // Whole, not the copy the model got: recovering the middle is the entire point.
    expect(archive.rows[0].content).toHaveLength(9000)
    expect(archive.rows[0].args).toBe('{"p":1}')

    const toolMsg = toolMessage(secondBody)
    expect(toolMsg?.content).toContain('read_tool_result(1)')
    // Both ends survive the cut, and the gap says how much is missing rather than just "truncated".
    expect(toolMsg?.content).toMatch(/…\[5000 characters cut from the middle]…/)
    expect(toolMsg?.content).toContain('skips the middle of 9000 characters')
    // The copy in the conversation stays capped; filing must not smuggle 9000 chars back in.
    expect(toolMsg?.content.length).toBeLessThan(4500)
  })

  it('files a result that fits, because a later turn cannot see it either', async () => {
    const archive = fakeArchive()
    let secondBody: Record<string, unknown> | undefined
    queueResponse({ content: null, tool_calls: [call('mid')] })
    queueResponse({ content: 'done' }, (b) => (secondBody = b))

    await loop([doc('mid', 2500)], { ctx: withArchive(archive) })

    expect(archive.rows).toHaveLength(1)
    const toolMsg = toolMessage(secondBody)
    // Not truncated, so it must not claim to be.
    expect(toolMsg?.content).toContain('ref 1')
    expect(toolMsg?.content).not.toContain('shortened')
  })

  it('files neither a short result nor a failure', async () => {
    const archive = fakeArchive()
    queueResponse({ content: null, tool_calls: [call('small')] })
    queueResponse({ content: 'done' })
    await loop([doc('small', 100)], { ctx: withArchive(archive) })
    expect(archive.rows).toHaveLength(0)

    queueResponse({ content: null, tool_calls: [call('err-big')] })
    queueResponse({ content: 'done' })
    await loop([failing('err-big', 9000)], { ctx: withArchive(archive) })
    // An error is not a document. Filing it would offer the model a ref to a failure.
    expect(archive.rows).toHaveLength(0)
  })

  it('does not file the result of a tool that read the archive', async () => {
    const archive = fakeArchive()
    const reader = defineTool({
      name: 'read_tool_result',
      description: 'reads back',
      params: z.object({}),
      noArchive: true,
      handler: async () => 'y'.repeat(9000),
    })
    queueResponse({ content: null, tool_calls: [call('read_tool_result')] })
    queueResponse({ content: 'done' })

    await loop([reader], { ctx: withArchive(archive) })

    // Otherwise every read back costs a row and hands the model a second ref to the same text.
    expect(archive.rows).toHaveLength(0)
  })

  it('files on the second attempt, because the failure it catches is transient', async () => {
    let attempts = 0
    const flaky = {
      rows: [] as Array<{ tool: string; args: string; content: string }>,
      save(r: { tool: string; args: string; content: string }) {
        attempts++
        if (attempts === 1) {
          throw new Error('SqlError: SQL query failed: internal error')
        }
        return this.rows.push(r)
      },
    }
    let secondBody: Record<string, unknown> | undefined
    queueResponse({ content: null, tool_calls: [call('big')] })
    queueResponse({ content: 'done' }, (b) => (secondBody = b))

    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await loop([doc('big', 9000)], {
        log: createLog('web'),
        ctx: withArchive(flaky as unknown as ReturnType<typeof fakeArchive>),
      })
    } finally {
      spy.mockRestore()
    }

    // Kept, not lost: the row is what makes the middle of the page recoverable, and one retry is
    // what this repo already does for a write it must not lose.
    expect(attempts).toBe(2)
    expect(flaky.rows).toHaveLength(1)
    expect(toolMessage(secondBody)?.content).toContain('read_tool_result(1)')
    // A retry that succeeds leaves no other trace: without this line a store failing on every first
    // attempt reads as a healthy one, which is the whole reason the record exists.
    expect(lines.some((l) => l.includes('archive-retried'))).toBe(true)
  })

  it('answers the turn when filing throws, and says so', async () => {
    const failsToFile = {
      save: () => {
        throw new Error('SQL query failed: internal error')
      },
    }
    let secondBody: Record<string, unknown> | undefined
    queueResponse({ content: null, tool_calls: [call('big')] })
    queueResponse({ content: 'answered anyway' }, (b) => (secondBody = b))

    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    let out: Awaited<ReturnType<typeof loop>>
    try {
      out = await loop([doc('big', 9000)], {
        log: createLog('web'),
        ctx: { ...ctx, toolArchive: failsToFile } as unknown as ToolContext,
      })
    } finally {
      spy.mockRestore()
    }

    // Filing is the optional half. Losing the turn over it would trade a whole answer for a copy
    // nobody may ever read.
    expect(out.text).toBe('answered anyway')
    expect(toolMessage(secondBody)?.content).not.toContain('ref')
    expect(lines.some((l) => l.includes('archive-failed'))).toBe(true)
  })

  it('keeps one result from taking the whole of a small window, and says it did', async () => {
    let secondBody: Record<string, unknown> | undefined
    queueResponse({ content: null, tool_calls: [call('big')] })
    queueResponse({ content: 'done' }, (b) => (secondBody = b))

    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      // A page tool with a 50,000-char cap against a 24k window: a tenth of the window is 7,200.
      const page = defineTool({
        name: 'big',
        description: 'reads',
        params: z.object({}),
        maxResultChars: 50_000,
        handler: async () => 'y'.repeat(40_000),
      })
      await loop([page], {
        log: createLog('web'),
        ctx: { ...ctx, contextTokens: 24_000 } as unknown as ToolContext,
      })
    } finally {
      spy.mockRestore()
    }

    // 7,200 of content plus the marker naming what went: a cap bounds what is *kept*, not the
    // string, which is how `truncate` has always behaved.
    //
    // Mutation check: return `toolCap` unconditionally from `resultCap` and this is 40,000 — which
    // is 13k tokens of a 24k window, and in a scout the request the provider refuses outright.
    expect(toolMessage(secondBody)?.content.length).toBeLessThan(7_400)
    expect(lines.some((l) => l.includes('window-capped'))).toBe(true)
  })

  it('leaves results alone where there is no archive to file them in', async () => {
    let secondBody: Record<string, unknown> | undefined
    queueResponse({ content: null, tool_calls: [call('big')] })
    queueResponse({ content: 'done' }, (b) => (secondBody = b))

    // A research scout has no thread, so `toolArchive` is absent and nothing may mention a ref.
    await loop([doc('big', 9000)])

    const toolMsg = toolMessage(secondBody)
    expect(toolMsg?.content).not.toContain('ref')
  })
})

describe('the token meter', () => {
  const call = (id: string) => ({ id, type: 'function', function: { name: 'echo', arguments: `{"text":"${id}"}` } })

  /** Same shape as `queueResponse`, plus the `usage` block a real provider returns. */
  function queueWithUsage(msg: Record<string, unknown>, inputTokens: number, outputTokens = 10) {
    fetchMock
      .get(BASE)
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        { choices: [{ message: msg }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens } },
        {
          headers: { 'content-type': 'application/json' },
        },
      )
  }

  it('adds up every round, input and output alike', async () => {
    // Output counted too: a reasoning model spends most of a round there, so input alone would
    // report a fraction of what the turn cost.
    queueWithUsage({ content: null, tool_calls: [call('c1')] }, 600, 400)
    queueWithUsage({ content: 'done' }, 700, 50)

    const out = await loop([echoTool])

    expect(out.roundsUsed).toBe(2)
    expect(out.tokensSpent).toBe(1750)
  })

  it('reports zero and says so when the provider sends no usage at all', async () => {
    queueResponse({ content: null, tool_calls: [call('c1')] })
    queueResponse({ content: 'done' })

    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    let out: Awaited<ReturnType<typeof loop>>
    try {
      out = await loop([echoTool], { log: createLog('web') })
    } finally {
      spy.mockRestore()
    }

    // Zero here is indistinguishable from a turn that genuinely spent nothing, which is why the
    // record exists: without it the meter reads as thrift rather than as blindness.
    expect(out.stopReason).toBe('complete')
    expect(out.tokensSpent).toBe(0)
    expect(lines.some((l) => l.includes('unmetered'))).toBe(true)
  })
})

describe('a spent budget is not a provider failure', () => {
  it('stops a fallback chain instead of letting it report that every provider refused', async () => {
    // The chain catches to try the next provider. Without `rethrowIfExhausted` it would swallow
    // the budget's refusal, try the others, and return "every search provider refused" — the one
    // sentence this repo added so a scout would not read an outage as a fact about the world.
    let attempts = 0
    const chained = named('chained', async (_args, toolCtx) => {
      for (const provider of ['first', 'second', 'third']) {
        try {
          attempts++
          await toolCtx.budget?.fetch('https://provider.example/')
          return `served by ${provider}`
        } catch (err) {
          rethrowIfExhausted(err)
        }
      }
      return 'error: every provider refused'
    })

    const budget = new SubrequestBudget(FINAL_ANSWER_RESERVE + 1)
    let secondBody: Record<string, unknown> | undefined
    queueResponse({
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'chained', arguments: '{}' } }],
    })
    queueResponse({ content: 'done' }, (b) => (secondBody = b))

    await loop([chained], {
      client: createLlmClient('k', `${BASE}/v1`, budget.fetch),
      ctx: { ...ctx, budget } as unknown as ToolContext,
      subrequests: budget,
    })

    // One attempt, not three: the refusal escaped the chain rather than being counted as a failure.
    expect(attempts).toBe(1)
    const toolMsg = ((secondBody?.messages ?? []) as { role: string; content: string }[]).find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('budget exhausted')
    expect(toolMsg?.content).not.toContain('every provider refused')
    // Two calls to the model and nothing else: the refused tool spent zero, which is what holding
    // the reserve buys over predicting what a call will cost.
    expect(budget.spent).toBe(2)
  })
})

describe('a round runs its calls concurrently', () => {
  it('enters every handler before any of them resolves', async () => {
    // A barrier rather than a stopwatch: sequential execution cannot get past the second handler's
    // entry, so this fails by timing out on the gate instead of on a flaky duration comparison.
    let open = (): void => {}
    const gate = new Promise<void>((resolve) => (open = resolve))
    let entered = 0
    const waiting = named('waiting', async () => {
      entered++
      if (entered === 3) {
        open()
      }
      await Promise.race([gate, new Promise((_, reject) => setTimeout(() => reject(new Error('ran in series')), 500))])
      return `entered ${entered}`
    })

    const call = (id: string) => ({ id, type: 'function', function: { name: 'waiting', arguments: '{}' } })
    queueResponse({ content: null, tool_calls: [call('c1'), call('c2'), call('c3')] })
    queueResponse({ content: 'done' })

    const out = await loop([waiting])

    expect(out.text).toBe('done')
    expect(entered).toBe(3)
  })
})

describe('an answered tool result stops being re-sent whole', () => {
  const call = (id: string, name: string) => ({ id, type: 'function', function: { name, arguments: '{"p":1}' } })
  const archive = () => ({ save: () => 1, read: () => null, search: () => [] })
  const withArchive = () => ({ ...ctx, toolArchive: archive() }) as unknown as ToolContext
  const toolsIn = (body?: Record<string, unknown>) =>
    ((body?.messages ?? []) as { role: string; content: string }[]).filter((m) => m.role === 'tool')

  /**
   * `maxResultChars` matters: `truncate`'s default 4000 is below the prune threshold, so only a
   * tool that raised its cap can ever produce a result worth shortening. In production that is
   * `read_page` — which is where the whole cost is, so the narrowness is the design and not a gap.
   */
  let served = 0
  const page = (name: string) =>
    defineTool({
      name,
      description: 'reads',
      params: z.object({}),
      maxResultChars: 50_000,
      // Varied per call, or two identical results trip the no-progress guard and the loop stops
      // before anything is old enough to prune — green for the wrong reason.
      handler: async () => `${served++} ${'y'.repeat(20_000)}`,
    })

  /**
   * The three constants are set against each other and nothing else notices when they are not: a
   * threshold at or below head + tail makes "shortening" return a *longer* string, under a marker
   * reporting a negative count. That exact shape shipped once, as `slice(-0)` returning the whole
   * input. Swept rather than asserted against the constants, so raising the head to follow a new
   * measurement fails here rather than in a log nobody reads.
   */
  it('never grows a result it was asked to shorten, at any size', async () => {
    // Varied per call: identical results trip the no-progress guard and the loop stops after one
    // round, leaving nothing old enough to be pruned and the test green for the wrong reason.
    let n = 0
    const sized = (chars: number) =>
      defineTool({
        name: 'sized',
        description: 'reads',
        params: z.object({}),
        maxResultChars: 60_000,
        handler: async () => `${n++} ${'y'.repeat(chars)}`,
      })

    for (const size of [1_000, 9_216, 16_384, 16_385, 20_000, 50_000]) {
      let last: Record<string, unknown> | undefined
      // Five rounds, so a result is well past the protected window by the final request.
      for (let i = 0; i < 5; i++) {
        queueResponse({ content: null, tool_calls: [call(`c${i}`, 'sized')] })
      }
      queueResponse({ content: 'done' }, (b) => (last = b))

      await loop([sized(size)], { ctx: withArchive() })

      // The footer adds a bounded amount; nothing may come back longer than it arrived plus that.
      const longest = Math.max(...toolsIn(last).map((m) => m.content.length))
      expect({ size, longest: longest <= size + 400 }).toEqual({ size, longest: true })
    }
  })

  /**
   * The property that matters is that shortening *happens* in a turn of the length this agent
   * actually runs. Raising the protected window to three on published evidence (`M = 10` for
   * SWE-agent, `K = 5` for search) silently switched pruning off here and cost 35% more tokens on a
   * real two-fetch turn: those values come from 250- and 500-turn agents, and a turn here is two or
   * three rounds. Asserted as "the oldest is shortened, the newest is not" rather than against the
   * constant, so a window that swallows a short turn fails rather than passing quietly.
   */
  it('shortens the oldest result and leaves the one being read whole', async () => {
    let last: Record<string, unknown> | undefined
    for (let i = 0; i < 3; i++) {
      queueResponse({ content: null, tool_calls: [call(`c${i}`, 'page')] })
    }
    queueResponse({ content: 'done' }, (b) => (last = b))

    await loop([page('page')], { ctx: withArchive() })

    const results = toolsIn(last)
    expect(results).toHaveLength(3)
    expect(results[0].content.length).toBeLessThan(20_000 / 2)
    expect(results[0].content).toContain('has the whole result')
    // The one the model is answering on right now is never touched.
    expect(results.at(-1)!.content.length).toBeGreaterThan(19_000)
  })

  it('leaves a filed result under the threshold exactly as it was', async () => {
    let third: Record<string, unknown> | undefined
    const small = defineTool({
      name: 'small',
      description: 'reads',
      params: z.object({}),
      maxResultChars: 50_000,
      // Filed, so it carries a ref — but head 4096 plus tail 1024 is longer than this, and the
      // marker would report a negative count. The threshold is what stops that, not the ref.
      handler: async () => 'y'.repeat(5_000),
    })
    queueResponse({ content: null, tool_calls: [call('c1', 'small')] })
    queueResponse({ content: null, tool_calls: [call('c2', 'small')] })
    queueResponse({ content: 'done' }, (b) => (third = b))

    await loop([small], { ctx: withArchive() })

    // Mutation check: drop `content.length <= PRUNE_OVER_CHARS` from `shorten` and this grows past
    // 5,200 characters carrying a marker that counts −120.
    const before = toolsIn(third)[0].content
    expect(before).not.toContain('dropped from this copy')
    expect(before.length).toBeLessThan(5_200)
  })

  it('leaves a result alone when nothing can recover the rest', async () => {
    let third: Record<string, unknown> | undefined
    queueResponse({ content: null, tool_calls: [call('c1', 'page')] })
    queueResponse({ content: null, tool_calls: [call('c2', 'page')] })
    queueResponse({ content: 'done' }, (b) => (third = b))

    // No archive: nothing was filed, so shortening would destroy the middle rather than move it.
    await loop([page('page')], { ctx })

    expect(toolsIn(third)[0].content.length).toBeGreaterThan(19_000)
  })

  /**
   * The two caps switch each other off at the picker's low end, which nothing said until it was
   * traced on 2026-09-02. `resultCap` cuts every result to `0.10 × window`, and the smaller the
   * window the more certainly that lands *under* the threshold the pruner acts above — so on a 24k
   * model the pruner is inert, and a scout's results accumulate exactly as they did before it had
   * an archive at all. The crossover is `PRUNE_OVER_CHARS / (RESULT_SHARE_OF_WINDOW × CHARS_PER_TOKEN)`,
   * about 27,300 tokens.
   *
   * Pinned rather than fixed: a window this small is not a model anyone runs research on, and
   * tuning the thresholds against each other buys a round or two before the sum overflows anyway.
   */
  it('cannot prune at all on a window that caps every result under the threshold', async () => {
    let last: Record<string, unknown> | undefined
    // Three, not two: with two rounds the oldest result is still the protected one, so nothing is
    // eligible and the assertion below passes whatever the constants say.
    for (let i = 0; i < 3; i++) {
      queueResponse({ content: null, tool_calls: [call(`c${i}`, 'page')] })
    }
    queueResponse({ content: 'done' }, (b) => (last = b))

    await loop([page('page')], { ctx: { ...withArchive(), contextTokens: 24_000 } as unknown as ToolContext })

    // Mutation check: raise `RESULT_SHARE_OF_WINDOW` to 0.2 and both of these flip — 14,400 clears
    // the threshold and the oldest result is shortened after all.
    expect(toolsIn(last)[0].content).not.toContain('dropped from this copy')
    expect(resultCap(50_000, 24_000)).toBeLessThan(PRUNE_OVER_CHARS)
  })
})

describe('what the turn leaves in history', () => {
  const call = (id: string, name: string) => ({ id, type: 'function', function: { name, arguments: '{"p":1}' } })
  const withArchive = () =>
    ({ ...ctx, toolArchive: { save: () => 1, read: () => null, search: () => [] } }) as unknown as ToolContext

  it('carries the call and its answer as a pair, stubbed', async () => {
    queueResponse({ content: null, tool_calls: [call('c1', 'page')] })
    queueResponse({ content: 'done' })

    const page = defineTool({
      name: 'page',
      description: 'reads',
      params: z.object({}),
      maxResultChars: 50_000,
      handler: async () => 'y'.repeat(20_000),
    })
    const out = await loop([page], { ctx: withArchive() })
    // One history message went in, and the system prompt sits before it.
    const persisted = turnToolTraffic(out.messages, 1, 1_700_000_000_000)

    const [asked, result] = persisted
    expect([asked.role, result.role]).toEqual(['assistant', 'tool'])
    // Narrowed rather than optional-chained: the union is what makes "a result always has an id"
    // a fact the compiler holds, and a test that reaches past it stops testing that.
    expect(asked.role === 'assistant' && asked.tool_calls?.[0].id).toBe('c1')
    expect(result.role === 'tool' && result.tool_call_id).toBe('c1')
    // The last round's result is still whole in the loop's own array — it was protected there —
    // so this is the pass that keeps a 20k page out of broadcast state. Asserted as a fraction of
    // what came in, because the head and tail sizes move whenever the evidence for them does.
    expect(persisted[1].content.length).toBeLessThan(20_000 / 2)
    expect(persisted[1].content).toContain('read_tool_result(1)')
  })

  it('refuses to write half a pair, and blames the write rather than the state', async () => {
    const errors: Record<string, unknown>[] = []
    const log = { error: (r: Record<string, unknown>) => errors.push(r) } as unknown as TurnLog
    queueResponse({ content: null, tool_calls: [call('c1', 'echo')] })
    queueResponse({ content: 'done' })

    const out = await loop([echoTool], { ctx: withArchive() })
    // One too many: the assistant carrying the call is skipped, which is what an offset counted
    // over the wrong array does — and the orphan would then be sanitized a turn later, against a
    // stored history that is not at fault.
    const persisted = turnToolTraffic(out.messages, 2, 1_700_000_000_000, log)

    expect(persisted).toHaveLength(0)
    expect(errors).toEqual([expect.objectContaining({ stage: 'unpaired-write', dropped: 1, priorHistory: 2 })])
  })

  it('gives every message an id, because the readers that point at a turn require one', async () => {
    queueResponse({ content: null, tool_calls: [call('c1', 'echo')] })
    queueResponse({ content: 'done' })

    const out = await loop([echoTool], { ctx: withArchive() })
    const persisted = turnToolTraffic(out.messages, 1, 1_700_000_000_000)

    expect(persisted.every((m) => m.id.length > 0)).toBe(true)
  })
})

describe('a passthrough schema tool (MCP) executes what the schema would refuse', () => {
  const passthrough = {
    name: 'files_echo',
    description: 'echoes on the files server',
    schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: async (args: never) => `echo:${(args as { text?: string }).text}`,
  } as ToolDef

  it('rides the server schema on the wire and skips zod, leaving validation to the server', async () => {
    // Mutation check: route schema tools through `params.safeParse` again and `{"text":5}` (valid
    // JSON, wrong per the schema) is refused before the handler — the tool result is an error
    // string instead of `echo:5`, and the model never sees the number the server would answer with.
    let first: Record<string, unknown> | undefined
    let second: Record<string, unknown> | undefined
    queueResponse(
      {
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'files_echo', arguments: '{"text":5}' } }],
      },
      (b) => (first = b),
    )
    queueResponse({ content: 'done' }, (b) => (second = b))

    const out = await loop([passthrough])
    expect(out).toMatchObject({ text: 'done', toolsUsed: ['files_echo'], roundsUsed: 2 })

    const wire = ((first?.tools ?? []) as { function: { name: string; parameters: unknown } }[]).find(
      (t) => t.function.name === 'files_echo',
    )
    expect(wire?.function.parameters).toEqual(passthrough.schema)

    const msgs = second?.messages as { role: string; tool_call_id?: string; content: string }[]
    expect(msgs.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: 'echo:5' })
  })
})
