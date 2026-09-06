import { env, fetchMock, runInDurableObject } from 'cloudflare:test'
import { getAgentByName } from 'agents'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PersonalAgent } from '../../src/agent/personal-agent'
import { appendArchive, readArchive, type CompactionRecord } from '../../src/agent/archive'
import { sqlTag } from '../../src/agent/archive'
import type { AgentState, Env, HistoryMessage } from '../../src/types'
import { readVault } from '../helpers/vault'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

const testEnv = env as Env

/**
 * A window small enough that a handful of messages crosses it, seeded rather than fetched: the
 * catalogue lookup is skipped entirely while `contextModel` matches the model in use.
 */
const CONTEXT = 1_000
const KNOWN_WINDOW = { contextModel: 'test-model', contextTokens: CONTEXT }

async function freshAgent() {
  return getAgentByName(testEnv.PERSONAL_AGENT, `compact-${crypto.randomUUID()}`)
}

/** 300 chars ≈ 100 tokens each: ten messages is a whole 1000-token window. */
function seedMessages(n: number): HistoryMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `turn ${i} `.padEnd(300, '.'),
    id: `m${i}`,
    at: 1_700_000_000_000 + i,
  }))
}

function seed(agent: PersonalAgent, state: Partial<AgentState>): void {
  agent.setState({ ...agent.state, ...KNOWN_WINDOW, ...state })
}

function mockCompletion(reply: string, capture?: (b: Record<string, unknown>) => void) {
  fetchMock
    .get('https://llm.example')
    .intercept({ method: 'POST', path: '/v1/chat/completions' })
    .reply(
      200,
      ({ body }) => {
        capture?.(JSON.parse(body as string) as Record<string, unknown>)
        return { choices: [{ message: { content: reply } }] }
      },
      { headers: { 'content-type': 'application/json' } },
    )
}

const archiveOf = (state: DurableObjectState) => readArchive(sqlTag(state.storage.sql))

describe('history growth schedules compaction', () => {
  it('schedules runCompactHistory once the surface passes the threshold', async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      // 6 × 100 tokens is under 0.70 × 1000; the reminder's own message tips it over.
      seed(agent, { messages: seedMessages(7) })
      await agent.fireReminder({ text: 'stand up '.padEnd(300, '.') })

      const pending = (await agent.listSchedules()).filter((s) => s.callback === 'runCompactHistory')
      expect(pending).toHaveLength(1)
      // Cancel: an alarm outliving the test corrupts later tests' isolated storage.
      await agent.cancelSchedule(pending[0].id)
    })
  })

  it('schedules nothing while the surface fits', async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      seed(agent, { messages: seedMessages(2) })
      await agent.fireReminder({ text: 'stand up' })
      expect((await agent.listSchedules()).filter((s) => s.callback === 'runCompactHistory')).toHaveLength(0)
    })
  })

  it("prefers the provider's own token count over the estimate", async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      // The estimate would be far over the threshold; the measured count says otherwise, and the
      // measured one is what a real prompt cost.
      seed(agent, { messages: seedMessages(20), promptTokens: 100 })
      await agent.fireReminder({ text: 'stand up' })
      expect((await agent.listSchedules()).filter((s) => s.callback === 'runCompactHistory')).toHaveLength(0)
    })
  })

  it('re-checks on a model switch, with no new turn to notice', async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      // 20k tokens: comfortable in the 131k window it was written in, over the threshold of the
      // 24k default the newly-picked model falls back to until the catalogue answers.
      seed(agent, { messages: seedMessages(200), contextTokens: 131_072 })
      await agent.setModel('something-smaller')

      const pending = (await agent.listSchedules()).filter((s) => s.callback === 'runCompactHistory')
      expect(pending).toHaveLength(1)
      await agent.cancelSchedule(pending[0].id)
    })
  })
})

describe('what a turn sends the model', () => {
  it('carries the compaction summary in the system prompt', async () => {
    const stub = await freshAgent()
    let sent: Record<string, unknown> | undefined
    mockCompletion('answered', (b) => {
      sent = b
    })
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      seed(agent, { historySummary: 'Earlier: Sam picked the Vienna itinerary.' })
      await agent.handleUserMessage('what did we decide?')
    })
    const system = (sent!.messages as { content: string }[])[0].content
    expect(system).toContain('<earlier_conversation_summary>')
    expect(system).toContain('Earlier: Sam picked the Vienna itinerary.')
  })

  /**
   * Against the real agent, not `turnToolTraffic` alone: the unit test for that helper passes with
   * its call site deleted, so nothing else pins that the persistence path uses it at all.
   *
   * The seeded history is also deliberately unsendable. `pairedOnly` drops the orphan before the
   * loop sees it, so the loop is handed fewer messages than state holds — and anything that counts
   * the *state* instead slices this turn's own traffic from the wrong offset and persists half a
   * pair, a fault the next turn's sanitizer hides while blaming an upstream that is fine.
   */
  it('keeps the call and its result in history, shortened, so a later turn can quote the ref', async () => {
    const stub = await freshAgent()
    const page = 'PAGE-START'.padEnd(20_000, 'y')
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        () => ({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: 'c1', type: 'function', function: { name: 'read_tool_result', arguments: '{"ref":1}' } },
                ],
              },
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    mockCompletion('answered')

    await runInDurableObject(stub, async (agent: PersonalAgent, state) => {
      appendArchive(sqlTag(state.storage.sql), 'tool-result', { tool: 'read_page', args: '{}', content: page })
      // A window this turn cannot cross. The rest of the file runs on 1000 tokens, where a 5k stub
      // schedules a compaction whose alarm then fires after teardown — reported as "Isolated
      // storage failed", which reads as a bug in whatever ran next.
      seed(agent, {
        contextTokens: 200_000,
        // An orphaned result from some earlier turn. `pairedOnly` removes it on the way out, which
        // is what makes the loop's history shorter than state — the condition the offset must
        // survive. It is also why this thread starts with a message nobody sent.
        messages: [{ role: 'tool', content: 'orphan', id: 'orphan', at: 1, tool_call_id: 'gone' }],
      })
      await agent.handleUserMessage('read ref 1')

      // The seeded orphan stays in state — sanitizing is done on the copy that goes out, not on
      // what is stored — and this turn's own four messages follow it in order.
      const roles = agent.state.messages.map((m) => m.role)
      expect(roles).toEqual(['tool', 'user', 'assistant', 'tool', 'assistant'])

      const [, , asked, result] = agent.state.messages
      expect(asked.role === 'assistant' && asked.tool_calls?.[0].id).toBe('c1')
      expect(result.role === 'tool' && result.tool_call_id).toBe('c1')
      // The 20k page came back through the archive and must not have followed it into state, which
      // is re-sent every turn and broadcast to every client. `read_tool_result` sets `noArchive`,
      // so this copy carries no ref and takes the hard-cap branch rather than the head/tail one —
      // the same branch a result whose filing threw would take, which is the case that would
      // otherwise put a whole page in broadcast state.
      expect(result.content).toContain('PAGE-START')
      // A fraction of the 20k page, not a fixed cap: the head and tail sizes move whenever the
      // evidence behind them does, and this test is about state staying small, not about them.
      expect(result.content.length).toBeLessThan(20_000 / 2)
    })
  })
})

describe('runCompactHistory', () => {
  it('folds the head into historySummary and keeps a tail sized by the window', async () => {
    const stub = await freshAgent()
    let sent: Record<string, unknown> | undefined
    mockCompletion('Sam asked about the early turns.', (b) => {
      sent = b
    })

    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent, state) => {
        seed(agent, { messages: seedMessages(10) })
        await agent.runCompactHistory()

        // 0.25 × 1000 tokens of tail: two messages of 100 fit, the rest is evicted.
        expect(agent.state.messages.map((m) => m.id)).toEqual(['m8', 'm9'])
        expect(agent.state.historySummary).toBe('Sam asked about the early turns.')

        const rows = archiveOf(state)
        expect(rows.map((r) => r.type)).toEqual(['compaction-start', 'compaction', 'compaction-end'])
        const record = rows[1].data as CompactionRecord
        expect(record.evicted.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'])
        expect(record.summary).toBe('Sam asked about the early turns.')
        expect(record.shadows).toContain('m7')
      })
    } finally {
      spy.mockRestore()
    }

    const prompt = (sent!.messages as { content: string }[])[0].content
    // The head is the material and the tail is context, in that order: the summarizer sees what
    // stays so it cannot call settled things pending. Mutation check: hand it `[]` and turn 9 is gone.
    const tailAt = prompt.indexOf('keeps verbatim')
    expect(prompt.indexOf('turn 7')).toBeLessThan(tailAt)
    expect(prompt.indexOf('turn 9')).toBeGreaterThan(tailAt)

    const record = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((r) => r.at === 'compact')
    expect(record).toMatchObject({ context: CONTEXT, evicted: 8, kept: 2 })
  })

  /**
   * The summarizer is the *second* caller of `transcript`, and the one missed when the reflection
   * path was filtered: `transcript` renders anything that is not a user as "Assistant", so a page
   * folded in here becomes assistant speech inside `historySummary` — which then rides in the
   * system prompt on every later turn. The archive still keeps the row; only the summary is spared.
   */
  it('never folds tool traffic into the summary as something the assistant said', async () => {
    const stub = await freshAgent()
    let sent: Record<string, unknown> | undefined
    mockCompletion('A summary.', (b) => (sent = b))

    await runInDurableObject(stub, async (agent: PersonalAgent, state) => {
      // Position matters twice over, and getting it wrong makes this pass for the wrong reason:
      // the group has to sit inside the evicted head *and* inside the newest slice of it, since
      // `fitHead` only summarizes what one call can read and archives the rest raw. Index 8 of 10
      // is both; index 4 is neither, and goes green against the unfiltered version.
      const withTools = seedMessages(10)
      withTools.splice(
        8,
        0,
        {
          role: 'assistant',
          content: '',
          id: 'call',
          at: 1_700_000_000_100,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_page', arguments: '{}' } }],
        },
        // 900 chars is 300 tokens against a 250-token tail, so it cannot be kept verbatim and has
        // to be evicted — which is what puts it in front of the summarizer.
        {
          role: 'tool',
          content: 'SECRET-PAGE-BODY'.padEnd(900, 'x'),
          id: 'result',
          at: 1_700_000_000_101,
          tool_call_id: 'c1',
        },
      )
      seed(agent, { messages: withTools })
      await agent.runCompactHistory()

      const record = archiveOf(state).find((r) => r.type === 'compaction')?.data as CompactionRecord
      expect(record.evicted.map((m) => m.id)).toContain('result')
    })

    const prompt = (sent!.messages as { content: string }[])[0].content
    expect(prompt).not.toContain('SECRET-PAGE-BODY')
    expect(prompt).not.toContain('read_page')
  })

  /**
   * The head can be nothing but tool traffic, and before the filter moved ahead of `fitHead` this
   * spent a model call on an empty transcript and wrote whatever came back over the summary.
   */
  it('skips the model when the evicted head has nothing anyone said', async () => {
    const stub = await freshAgent()
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        // Two long tool results and one exchange: the tail keeps the exchange, so everything
        // evicted is traffic. No `mockCompletion`, so a call here would fail the run outright.
        seed(agent, {
          historySummary: 'Earlier: the Vienna itinerary.',
          messages: [
            {
              role: 'assistant',
              content: '',
              id: 'call',
              at: 1,
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_page', arguments: '{}' } }],
            },
            // 800 tokens: enough that the thread crosses the 800-token threshold on its own, and
            // far past the 250-token tail, so this pair is what gets evicted.
            { role: 'tool', content: 'x'.repeat(2_400), id: 'r1', at: 2, tool_call_id: 'c1' },
            ...seedMessages(2),
          ],
        })
        await agent.runCompactHistory()

        // Kept, not overwritten by a summary of nothing.
        expect(agent.state.historySummary).toBe('Earlier: the Vienna itinerary.')
      })
    } finally {
      spy.mockRestore()
    }

    const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(records.some((r) => r.stage === 'nothing-to-summarize')).toBe(true)
  })

  /**
   * Found by hand on 2026-09-01, not by this suite: a stub that answered the summarizing call with
   * a tool call returned no text, and the empty string went straight into `historySummary`. The
   * head is gone by then, so the running summary was the only description left of it.
   */
  it('keeps the running summary when the summarizer answers with nothing', async () => {
    const stub = await freshAgent()
    mockCompletion('   ')

    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        seed(agent, { messages: seedMessages(10), historySummary: 'Earlier: Sam moved to Prague.' })
        await agent.runCompactHistory()

        // Mutation check: write `written` rather than `written || historySummary` and this is ''.
        expect(agent.state.historySummary).toBe('Earlier: Sam moved to Prague.')
      })
    } finally {
      spy.mockRestore()
    }

    const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    // Loud, and `unsummarized` counts the whole head: the call was spent and described none of it,
    // which a count taken before the answer would have reported as zero.
    expect(records.find((r) => r.stage === 'empty-summary')).toBeDefined()
    expect(records.find((r) => r.at === 'compact' && r.stage === undefined)).toMatchObject({ unsummarized: 8 })
  })

  it('archives what the summarizer had no room for, and says how much', async () => {
    const stub = await freshAgent()
    let sent: Record<string, unknown> | undefined
    mockCompletion('Only the recent part.', (b) => {
      sent = b
    })

    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent, state) => {
        // 30 messages is 3000 tokens of evictable head against a 250-token summarizing budget.
        seed(agent, { messages: seedMessages(30) })
        await agent.runCompactHistory()

        const record = archiveOf(state).find((r) => r.type === 'compaction')?.data as CompactionRecord
        expect(record.evicted).toHaveLength(28)
        expect(record.unsummarized).toBe(26)
        // The raw text of the dropped stretch is still here — that is what makes losing it
        // recoverable rather than silent.
        expect(record.evicted[0].id).toBe('m0')
      })
    } finally {
      spy.mockRestore()
    }

    const prompt = (sent!.messages as { content: string }[])[0].content
    expect(prompt).not.toContain('turn 0 ')
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((r) => r.at === 'compact')).toMatchObject({
      unsummarized: 26,
    })
  })

  it('says so when the threshold is met but there is nothing left to fold', async () => {
    const stub = await freshAgent()
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        // The summary alone is over the threshold, and compaction cannot trim a summary: without
        // this record the thread would schedule an empty pass every turn and say nothing.
        seed(agent, { messages: seedMessages(2), historySummary: 'x'.repeat(3000) })
        await agent.runCompactHistory()
        expect(agent.state.historySummary).toHaveLength(3000)
      })
    } finally {
      spy.mockRestore()
    }
    expect(
      lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((r) => r.stage === 'nothing-to-evict'),
    ).toMatchObject({ summaryChars: 3000 })
  })

  it('merges the existing summary rather than replacing it blind', async () => {
    const stub = await freshAgent()
    let sent: Record<string, unknown> | undefined
    mockCompletion('Merged summary.', (b) => {
      sent = b
    })

    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      seed(agent, { messages: seedMessages(10), historySummary: 'Earlier: Sam moved to Prague.' })
      await agent.runCompactHistory()
      expect(agent.state.historySummary).toBe('Merged summary.')
    })
    expect((sent!.messages as { content: string }[])[0].content).toContain('Earlier: Sam moved to Prague.')
  })

  it('does nothing below the threshold, and calls no model', async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent, state) => {
      seed(agent, { messages: seedMessages(3) })
      await agent.runCompactHistory()
      expect(agent.state.messages).toHaveLength(3)
      expect(agent.state.historySummary).toBeUndefined()
      expect(archiveOf(state)).toEqual([])
    })
    // No interceptor was registered: afterEach's assertNoPendingInterceptors proves the model
    // was not called, and any call would have failed on disableNetConnect.
  })

  // Mutation check: delete the `this.state.messages[0]?.id !== evicted[0]?.id` guard in
  // `compactHistory`, or weaken it to `!==` on the array length, and this test must fail — the
  // trimmed surface would then start at `xm10`, ten live turns short.
  it('abandons the write when the history moved while the model was answering', async () => {
    const stub = await freshAgent()
    // Slow on purpose: the racing write has to land while the model call is in flight, and an
    // instant mock closes that window before the test can reach it.
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        { choices: [{ message: { content: 'summary of turns nobody has any more' } }] },
        {
          headers: { 'content-type': 'application/json' },
        },
      )
      .delay(100)

    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent, state) => {
        seed(agent, { messages: seedMessages(10) })
        // The replacement lands after the snapshot is taken and before the reply is written back:
        // the compaction suspends on the model call, so this is that window.
        const running = agent.runCompactHistory()
        // The start row is written just before the model call, so its arrival is the window.
        await vi.waitFor(() => expect(archiveOf(state)).toHaveLength(1))
        agent.setState({ ...agent.state, messages: seedMessages(10).map((m) => ({ ...m, id: `x${m.id}` })) })
        await running

        expect(agent.state.historySummary).toBeUndefined()
        expect(agent.state.messages[0].id).toBe('xm0')
        // A start row with no record after it: an abandoned compaction leaves a trace rather than
        // nothing, which is the whole reason the start is written before the model call.
        expect(archiveOf(state).map((r) => r.type)).toEqual(['compaction-start'])
      })
    } finally {
      spy.mockRestore()
    }

    const record = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((r) => r.at === 'compact')
    expect(record?.stage).toBe('abandoned')
  })

  it('leaves history untouched when the summarizing call fails', async () => {
    const stub = await freshAgent()
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(500, { message: 'boom' }, { headers: { 'content-type': 'application/json' } })

    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      seed(agent, { messages: seedMessages(10) })
      await agent.runCompactHistory()
      expect(agent.state.messages).toHaveLength(10)
      expect(agent.state.historySummary).toBeUndefined()
    })
  })
})

describe('what a memory saved during a turn can point at', () => {
  it('names the turn on a path that persists its own user message', async () => {
    const stub = await freshAgent()
    // A turn that saves a memory: tool call, then the answer.
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'c1',
                    type: 'function',
                    function: {
                      name: 'save_memory',
                      arguments: '{"name":"Sam in Brno","description":"moved to Brno","content":"Since August."}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { headers: { 'content-type': 'application/json' } },
      )
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(200, { choices: [{ message: { content: 'noted' } }] }, { headers: { 'content-type': 'application/json' } })

    let turnId: string | undefined
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      seed(agent, { messages: [] })
      await agent.handleUserMessage('remember that I moved to Brno')
      turnId = agent.state.messages.find((m) => m.role === 'user')?.id
      for (const s of await agent.listSchedules()) {
        await agent.cancelSchedule(s.id)
      }
    })

    // `/dev/chat` persists its own user message, and passing only the *found* one
    // left this empty — a memory with a thread and no turn, which reads exactly like one written
    // before provenance existed.
    const file = await readVault('agent/memory/sam-in-brno.md')
    expect(file).toContain(`source_turn: ${turnId}`)
  })
})

describe('verifyCitation, the real one', () => {
  it('accepts a user turn this thread holds and refuses everything else', async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      seed(agent, { messages: seedMessages(4) })

      expect(await agent.verifyCitation('m2')).toMatchObject({ ok: true })
      // m1 is the assistant: a turn the agent wrote cannot evidence that the agent was wrong.
      expect(await agent.verifyCitation('m1')).toEqual({ ok: false, why: 'not-a-user-turn' })
      expect(await agent.verifyCitation('invented')).toEqual({ ok: false, why: 'missing' })
    })
  })

  it('still accepts a turn compaction has moved into the archive', async () => {
    const stub = await freshAgent()
    mockCompletion('Folded.')
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      seed(agent, { messages: seedMessages(10) })
      await agent.runCompactHistory()
      expect(agent.state.messages.map((m) => m.id)).toEqual(['m8', 'm9'])

      // The evidence for archiving a memory is usually old, which is the whole reason compaction
      // shadows rather than deletes.
      expect(await agent.verifyCitation('m2')).toMatchObject({ ok: true })
    })
  })
})

describe('rateMessage', () => {
  it('records a rating against an assistant turn, in the archive rather than in state', async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent, state) => {
      seed(agent, { messages: seedMessages(4) })

      await agent.rateMessage('m3', 'down', '  wrong about the vault  ')

      const rows = archiveOf(state).filter((r) => r.type === 'feedback')
      expect(rows).toHaveLength(1)
      expect(rows[0].data).toEqual({ message: 'm3', rating: 'down', note: 'wrong about the vault' })
      // Not on the surface: it has to outlive the compaction that will evict the turn it judges.
      expect(JSON.stringify(agent.state.messages)).not.toContain('wrong about the vault')
    })
  })

  it('withdraws by appending, so a changed mind keeps its history', async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent, state) => {
      seed(agent, { messages: seedMessages(4) })

      await agent.rateMessage('m3', 'down', 'wrong')
      await agent.rateMessage('m3', 'none')
      await agent.rateMessage('m3', 'up')

      // Append-only: nothing is rewritten, and the last row for a message is the current verdict.
      const ratings = archiveOf(state)
        .filter((r) => r.type === 'feedback')
        .map((r) => (r.data as { rating: string }).rating)
      expect(ratings).toEqual(['down', 'none', 'up'])
    })
  })

  it('refuses a rating that points at nothing, or at the user — out loud', async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent, state) => {
      seed(agent, { messages: seedMessages(4) })

      // Throws rather than returning quietly: the client has already drawn the thumb, so a silent
      // refusal leaves the UI claiming a judgement the archive never took.
      await expect(agent.rateMessage('nonexistent', 'down')).rejects.toThrow(/not an assistant turn/)
      // m2 is a user turn; rating one is meaningless as evidence about an answer.
      await expect(agent.rateMessage('m2', 'up')).rejects.toThrow(/not an assistant turn/)

      expect(archiveOf(state).filter((r) => r.type === 'feedback')).toEqual([])
    })
  })

  it('still finds a turn compaction has already evicted', async () => {
    const stub = await freshAgent()
    mockCompletion('Folded.')
    await runInDurableObject(stub, async (agent: PersonalAgent, state) => {
      seed(agent, { messages: seedMessages(10) })
      await agent.runCompactHistory()
      expect(agent.state.messages.map((m) => m.id)).toEqual(['m8', 'm9'])

      // The whole reason compaction shadows rather than deletes: a pointer stays good afterwards.
      await agent.rateMessage('m3', 'down')

      const rows = archiveOf(state).filter((r) => r.type === 'feedback')
      expect(rows[0]?.data).toMatchObject({ message: 'm3', rating: 'down' })
    })
  })
})

describe('what the nightly reflection is shown', () => {
  it('unions the archive with the live surface and counts a message once', async () => {
    const stub = await freshAgent()
    mockCompletion('Summary of the head.')

    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      seed(agent, { messages: seedMessages(10) })
      await agent.runCompactHistory()

      // Everything: eight turns now only in the archive, two still on the surface.
      const all = await agent.recentActivity(0)
      expect(all.map((m) => m.id)).toEqual(seedMessages(10).map((m) => m.id))
    })
  })

  it('shows only what happened after the watermark', async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      seed(agent, { messages: seedMessages(4) })
      const since = 1_700_000_000_001
      expect((await agent.recentActivity(since)).map((m) => m.id)).toEqual(['m2', 'm3'])
    })
  })

  /**
   * The reflection reads this to decide what to write into memory, and `transcript` renders
   * anything that is not a user as "Assistant" — so an unfiltered page arrives as something the
   * assistant said, inside the prompt that gates destructive writes. Filtered in `recentActivity`
   * rather than in `transcript`, because `citationLabels` numbers positions over the same array.
   */
  it('hands over no tool traffic, from the archive or the surface', async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      const withTools = seedMessages(4)
      withTools.splice(
        2,
        0,
        {
          role: 'assistant',
          content: '',
          id: 'call',
          at: 1_700_000_000_100,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_page', arguments: '{}' } }],
        },
        { role: 'tool', content: 'PAGE-BODY', id: 'result', at: 1_700_000_000_101, tool_call_id: 'c1' },
      )
      seed(agent, { messages: withTools })

      const ids = (await agent.recentActivity(0)).map((m) => m.id)
      expect(ids).toEqual(['m0', 'm1', 'm2', 'm3'])
    })
  })

  it('contributes nothing from a thread that has been quiet', async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      seed(agent, { messages: seedMessages(4) })
      expect(await agent.recentActivity(Date.now())).toEqual([])
    })
  })
})

describe('compactNow', () => {
  it('shows itself while it runs, and gives the status back afterwards', async () => {
    const stub = await freshAgent()
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        { choices: [{ message: { content: 'Folded.' } }] },
        { headers: { 'content-type': 'application/json' } },
      )
      .delay(100)

    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      // A turn that overflowed compacts inside itself, so the turn's own indicator has to survive:
      // clearing it would leave the client waiting on an answer with nothing on screen.
      seed(agent, { messages: seedMessages(10), status: 'thinking' })
      const running = agent.compactNow()
      await vi.waitFor(() => expect(agent.state.status).toBe('compacting'))
      await running
      expect(agent.state.status).toBe('thinking')
    })
  })

  it('folds down to the last exchange even when the window has room to spare', async () => {
    const stub = await freshAgent()
    mockCompletion('Everything before the last exchange.')

    await runInDurableObject(stub, async (agent: PersonalAgent, state) => {
      // A window a hundred times the conversation: the threshold would leave this alone, and a
      // button that silently does nothing is worse than no button.
      seed(agent, { messages: seedMessages(10), contextTokens: 131_072 })
      await agent.compactNow()

      expect(agent.state.messages.map((m) => m.id)).toEqual(['m8', 'm9'])
      expect(agent.state.historySummary).toBe('Everything before the last exchange.')
      expect(archiveOf(state).map((r) => r.type)).toEqual(['compaction-start', 'compaction', 'compaction-end'])
    })
  })
})

describe('the context window is asked for once per model', () => {
  it('says so, and pins nothing, when the catalogue does not list the model', async () => {
    const stub = await freshAgent()
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'GET', path: '/v1/models' })
      .reply(
        200,
        { data: [{ id: 'some-other-model', context_length: 4096 }] },
        {
          headers: { 'content-type': 'application/json' },
        },
      )

    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        agent.setState({ ...agent.state, messages: seedMessages(2) })
        await agent.runCompactHistory()
        // Pinning the default against this model's name would leave the thread assuming 24k for
        // good, and the next catalogue that lists it could never correct that.
        expect(agent.state.contextModel).toBeUndefined()
        expect(agent.state.contextTokens).toBeUndefined()
      })
    } finally {
      spy.mockRestore()
    }
    expect(
      lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((r) => r.stage === 'context-unlisted'),
    ).toMatchObject({ model: 'test-model', assumed: 24_000 })
  })

  it('reads it from the catalogue and keeps it in state', async () => {
    const stub = await freshAgent()
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'GET', path: '/v1/models' })
      .reply(
        200,
        { data: [{ id: 'test-model', context_length: 4096, supported_parameters: ['tools'] }] },
        { headers: { 'content-type': 'application/json' } },
      )

    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      // No seeded window: the model is unknown, so the alarm resolves it before deciding.
      agent.setState({ ...agent.state, messages: seedMessages(2) })
      await agent.runCompactHistory()
      expect(agent.state.contextModel).toBe('test-model')
      expect(agent.state.contextTokens).toBe(4096)
      // 200 tokens against 0.70 × 4096: nothing to compact, and no summarizing call was made.
      expect(agent.state.historySummary).toBeUndefined()
    })
  })
})

describe('a provider refusing the prompt for its size', () => {
  it('compacts and answers on the retry', async () => {
    const stub = await freshAgent()
    const llm = fetchMock.get('https://llm.example')
    llm.intercept({ method: 'POST', path: '/v1/chat/completions' }).reply(
      400,
      { error: { message: "This model's maximum context length is 8192 tokens" } },
      {
        headers: { 'content-type': 'application/json' },
      },
    )
    // The compaction the overflow forces, then the retried turn.
    llm.intercept({ method: 'POST', path: '/v1/chat/completions' }).reply(
      200,
      { choices: [{ message: { content: 'Summary of the head.' } }] },
      {
        headers: { 'content-type': 'application/json' },
      },
    )
    llm.intercept({ method: 'POST', path: '/v1/chat/completions' }).reply(
      200,
      { choices: [{ message: { content: 'answered after compaction' } }] },
      {
        headers: { 'content-type': 'application/json' },
      },
    )

    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        // Under the threshold, so only the provider's own refusal can trigger this.
        seed(agent, { messages: seedMessages(4) })
        expect(await agent.handleUserMessage('and now?')).toBe('answered after compaction')
        expect(agent.state.historySummary).toBe('Summary of the head.')
        // The turn ends in a threshold check, and an alarm left pending here fires after the
        // pool has torn this test's storage down.
        for (const s of await agent.listSchedules()) {
          await agent.cancelSchedule(s.id)
        }
      })
    } finally {
      spy.mockRestore()
    }
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>).some((r) => r.stage === 'overflow-retry')).toBe(
      true,
    )
  })
})
