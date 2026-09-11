import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { archiveStaleSkills, citationLabels, isStale, runReflectionLoop } from '@/agent/reflection'
import type { MemoryStore } from '@/agent/memory/memory-store'
import { transcript } from '@/agent/sessions'
import { SubrequestBudget } from '@/agent/subrequest-budget'
import type { ToolContext } from '@/agent/tools/registry'
import { createLlmClient } from '@/connectors/llm.connector'
import type { Env } from '@/types'
import { requestBody } from '../helpers/request'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

const TODAY = '2026-07-07'

describe('isStale', () => {
  it('flags skills unused for more than 90 days, using last_used over date', () => {
    expect(isStale({ lastUsed: '2026-03-01', pinned: false }, TODAY)).toBe(true)
    expect(isStale({ lastUsed: '2026-06-01', pinned: false }, TODAY)).toBe(false)
    expect(isStale({ date: '2026-01-01', pinned: false }, TODAY)).toBe(true)
    expect(isStale({ lastUsed: '2026-06-30', date: '2026-01-01', pinned: false }, TODAY)).toBe(false)
  })

  it('never flags pinned skills or skills with no dates', () => {
    expect(isStale({ lastUsed: '2025-01-01', pinned: true }, TODAY)).toBe(false)
    expect(isStale({ pinned: false }, TODAY)).toBe(false)
  })
})

describe('archiveStaleSkills', () => {
  it('archives exactly the stale ones and reports their slugs', async () => {
    const store = {
      listSkills: vi.fn(async () => [
        { slug: 'stale', name: 's', description: '', useCount: 1, lastUsed: '2026-01-01', pinned: false },
        { slug: 'fresh', name: 'f', description: '', useCount: 5, lastUsed: '2026-07-01', pinned: false },
        { slug: 'pinned-old', name: 'p', description: '', useCount: 0, lastUsed: '2025-01-01', pinned: true },
      ]),
      archiveSkill: vi.fn(async (slug: string) => `archived skill "${slug}"`),
    } as unknown as MemoryStore

    await expect(archiveStaleSkills(store, TODAY)).resolves.toEqual(['stale'])
    expect(store.archiveSkill).toHaveBeenCalledTimes(1)
    expect(store.archiveSkill).toHaveBeenCalledWith('stale')
  })
})

describe('runReflectionLoop', () => {
  const call = (name: string, args: string) => ({
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: args } }],
  })

  function queueLlm(msg: Record<string, unknown>) {
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(200, { choices: [{ message: msg }] }, { headers: { 'content-type': 'application/json' } })
  }

  function ctxFor(budget: SubrequestBudget): ToolContext {
    return { env: env as Env, chatId: 7, budget } as unknown as ToolContext
  }

  const activity = [
    {
      id: 't-work',
      title: 'work',
      messages: [
        { role: 'user' as const, content: 'we shipped the wave', id: 'm1', at: 1 },
        { role: 'assistant' as const, content: 'noted', id: 'm2', at: 2 },
      ],
    },
  ]

  it('asks for the summary when the loop ended on a guard instead of an answer', async () => {
    // Observed 2026-08-10: the loop hit its time budget at 113.6 s, the forced final call came back
    // as a tool call with contentLen 0, and the night's work was reported as "(no answer produced)".
    // The same tool result twice ends the loop on no-progress with no text of its own.
    queueLlm(call('update_agent_notes', '{"text":"noted"}'))
    queueLlm(call('update_agent_notes', '{"text":"noted"}'))
    const asked: string[] = []
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        (opts) => {
          asked.push(requestBody(opts))
          return { choices: [{ message: { content: 'Tightened the profile and dropped one stale note.' } }] }
        },
        { headers: { 'content-type': 'application/json' } },
      )

    const budget = new SubrequestBudget()
    const out = await runReflectionLoop(
      createLlmClient('k', 'https://llm.example/v1', budget.fetch),
      'm',
      ctxFor(budget),
      activity,
    )

    expect(out.report).toBe('Tightened the profile and dropped one stale note.')
    expect(out.changed).toBe(true)
    // Asked for, not forced. The loop's own `tool_choice: 'none'` call is what returned a tool call
    // with no text on the night this broke, so the distinction is the fix.
    expect(asked[0]).toContain('say what you changed tonight')
    expect(asked[0]).not.toContain('tool_choice')
  })

  it('does not buy a summary on a night that changed nothing', async () => {
    // The report is only ever sent when a mutating tool ran, so a read-only night that asks for one
    // pays for a model call nobody reads. Observed in production 2026-08-11.
    queueLlm(call('search_memory', '{"query":"anything"}'))
    queueLlm(call('search_memory', '{"query":"anything"}'))

    const budget = new SubrequestBudget()
    const out = await runReflectionLoop(
      createLlmClient('k', 'https://llm.example/v1', budget.fetch),
      'm',
      ctxFor(budget),
      activity,
    )

    // Two loop calls and no third: an unqueued interceptor would fail assertNoPendingInterceptors,
    // and a third call would have nothing to match.
    expect(out.changed).toBe(false)
    expect(out.report).toBe('')
  })

  it('does not pay for a summary the loop already gave', async () => {
    queueLlm({ content: 'Nothing worth changing tonight.' })

    const budget = new SubrequestBudget()
    const out = await runReflectionLoop(
      createLlmClient('k', 'https://llm.example/v1', budget.fetch),
      'm',
      ctxFor(budget),
      activity,
    )

    expect(out.report).toBe('Nothing worth changing tonight.')
    // Read-only: nothing mutating ran, so the nightly message stays unsent.
    expect(out.changed).toBe(false)
  })

  it('spends nothing at all when nothing was said since the last run', async () => {
    const budget = new SubrequestBudget()
    const out = await runReflectionLoop(
      createLlmClient('k', 'https://llm.example/v1', budget.fetch),
      'm',
      ctxFor(budget),
      [{ id: 't-work', title: 'work', messages: [] }],
    )
    expect(out).toEqual({ changed: false, report: 'no new conversation' })
  })

  it('labels turns by position and resolves those labels back to message ids', () => {
    // The two must agree or every citation is refused; they are two functions apart, so this is
    // the seam that says so.
    const labels = citationLabels(activity)
    expect(labels.get('t-work#1')).toBe('m1')
    expect(labels.get('t-work#2')).toBe('m2')
    expect(labels.get('t-work#3')).toBeUndefined()
  })

  /**
   * The alignment holds because both functions walk the same array with the same index, and it
   * breaks the moment either one filters. Deleting the filter in `recentActivity` is caught
   * elsewhere; what nothing else catches is *adding* a second one here "for safety" while leaving
   * that one in place — a move already made once in this feature, where a defensive filter inside
   * `summarizeHead` hid a defect for a review round.
   *
   * The tool row is fed in deliberately unfiltered. That is not what the reflection is handed —
   * `recentActivity` removes it — it is the only way to show that the numbering does not care.
   */
  it('numbers the same positions transcript renders, whatever shares the array', () => {
    const withTools = [
      { role: 'user' as const, content: 'first', id: 'm1' },
      {
        role: 'assistant' as const,
        content: '',
        id: 'called',
        tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'read_page', arguments: '{}' } }],
      },
      { role: 'tool' as const, content: 'a page', id: 'result', tool_call_id: 'c1' },
      { role: 'user' as const, content: 'the turn a memory would cite', id: 'm2' },
    ]
    const thread = [{ id: 't-work', title: 'work', messages: withTools }]

    const labels = citationLabels(thread)
    const lines = transcript(withTools, { labels: true }).split('\n\n')

    // One line per message, first — a filter on either side shows up here as a count, which says
    // what went wrong, where the label assertions below would only say the answer was undefined.
    expect(lines).toHaveLength(withTools.length)
    // `[4]` must be the fourth line and must resolve to the fourth message. A filter on either
    // side moves one of them and the gate then reads a citation as pointing at another turn.
    expect(labels.get('t-work#4')).toBe('m2')
    expect(lines[3]).toContain('[4] ')
    expect(lines[3]).toContain('the turn a memory would cite')
  })

  it('shows each thread by its id, with a citable label on every turn', async () => {
    let sent = ''
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        (opts) => {
          sent = requestBody(opts)
          return { choices: [{ message: { content: 'NO_CHANGES' } }] }
        },
        { headers: { 'content-type': 'application/json' } },
      )

    const budget = new SubrequestBudget()
    await runReflectionLoop(createLlmClient('k', 'https://llm.example/v1', budget.fetch), 'm', ctxFor(budget), [
      ...activity,
      { id: 't-trip', title: 'trip', messages: [{ role: 'user' as const, content: 'book Vienna', id: 'm9', at: 3 }] },
    ])

    const material = (JSON.parse(sent) as { messages: { content: string }[] }).messages[1].content
    // The id, not the title: `delete_memory` checks the citation against the registry, and a title
    // is neither unique nor stable.
    expect(material).toContain('<conversation thread="t-work" title="work">')
    expect(material).toContain('<conversation thread="t-trip" title="trip">')
    // Position, not the 36-char uuid: a model copying an id out of a long transcript slips a
    // character and the refusal that follows is indistinguishable from a fabricated citation.
    expect(material).toContain('[1] User: book Vienna')
  })
})
