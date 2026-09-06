import { env, fetchMock, runInDurableObject } from 'cloudflare:test'
import { getAgentByName } from 'agents'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../../src/agent/memory/vault-store'
import { PersonalAgent } from '../../src/agent/personal-agent'
import {
  proposeResearch,
  RESEARCH_DEADLINE_MS,
  RESEARCH_SUBREQUEST_BUDGET,
  startResearch,
} from '../../src/agent/research-state'
import type { Env } from '../../src/types'
import { requestBody } from '../helpers/request'
import { listVault, readVault } from '../helpers/vault'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

const freshAgent = () => getAgentByName((env as Env).PERSONAL_AGENT, `research-${crypto.randomUUID()}`)

/**
 * A command's replies land in broadcast state, so `emit` is the seam they all pass through. Spied
 * and called through rather than replaced: these tests assert on what a run *did* as well as on
 * what it said, and a stubbed emit would take the history with it.
 */
type Emit = (text: string) => Promise<void>

function captureSends() {
  const sent: string[] = []
  const proto = PersonalAgent.prototype as unknown as { emit: Emit }
  const original = proto.emit
  const spy = vi.spyOn(proto, 'emit').mockImplementation(async function (this: PersonalAgent, text) {
    sent.push(text)
    return original.call(this, text)
  } as Emit)
  return { sent, restore: () => spy.mockRestore() }
}

async function pending(agent: PersonalAgent) {
  return (await agent.listSchedules()).filter((s) => s.callback === 'runResearchRound')
}

/** Proposing costs one model call: the plan the user is asked to approve. */
function queuePlan(lines = 'who publishes\nwhat they measure') {
  fetchMock
    .get('https://llm.example')
    .intercept({ method: 'POST', path: '/v1/chat/completions' })
    .reply(200, { choices: [{ message: { content: lines } }] }, { headers: { 'content-type': 'application/json' } })
}

describe('proposing a run', () => {
  it('registers the thread under the topic, so a run started from the landing reaches the sidebar', async () => {
    // Registration used to happen only on a chat message; a thread opened straight into research
    // had none and was never listed. Mutation check: drop `registerThread` from the proposal.
    const stub = await getAgentByName((env as Env).PERSONAL_AGENT, 'web:dev-user:home:proposed-first')
    const { restore } = captureSends()
    queuePlan()
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.proposeResearch('agent eval trends')
      })
      const threads = await createMemoryStore(env as Env).listThreads()
      expect(threads.find((t) => t.id === 'proposed-first')?.title).toBe('agent eval trends')
    } finally {
      restore()
    }
  })

  it('says why a plan failed, not only that it did', async () => {
    // A thread created from the landing ran on a model id the provider did not know, and "try
    // again" was the whole notice. Mutation check: drop the reason from the emit and this fails.
    const stub = await freshAgent()
    const { sent, restore } = captureSends()
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        400,
        { error: { message: '@cf/vendor/model is not a valid model ID' } },
        { headers: { 'content-type': 'application/json' } },
      )
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.proposeResearch('agent eval trends')
        expect(agent.state.research).toBeUndefined()
      })
      expect(sent.at(-1)).toContain('Could not plan that research: 400')
      expect(sent.at(-1)).toContain('is not a valid model ID')
    } finally {
      restore()
    }
  })

  it('proposes without starting anything, and says it is working while it does', async () => {
    const stub = await freshAgent()
    const { sent, restore } = captureSends()
    // Read from inside the plan call, which is the only moment the indicator is supposed to be up.
    let planning: PersonalAgent | undefined
    let duringPlan: string | undefined
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        () => {
          duringPlan = planning?.state.status
          return { choices: [{ message: { content: 'who publishes\nwhat they measure' } }] }
        },
        { headers: { 'content-type': 'application/json' } },
      )
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        planning = agent
        await agent.proposeResearch('agent eval trends')

        expect(agent.state.research).toMatchObject({ phase: 'proposed', topic: 'agent eval trends' })
        // Nothing is scheduled: a run that costs hundreds of requests is not started by a typo.
        expect(await pending(agent)).toHaveLength(0)
        // Several seconds of model time behind a button used to look like nothing happening.
        expect(agent.state.status).toBeUndefined()
      })
    } finally {
      restore()
    }
    // The proposal names the plan, not a command: starting and dropping are buttons in the client.
    expect(sent.join('\n')).toMatch(/agent eval trends/i)
    // Mutation check: drop the `setState` in `planWithModel` and this is undefined.
    expect(duringPlan).toBe('thinking')
  })

  it('says what it would look for, not just what it would cost', async () => {
    // The proposal is the confirmation gate. One that echoes the topic and a number asks the user
    // to approve something they cannot see.
    const stub = await freshAgent()
    const { sent, restore } = captureSends()
    queuePlan('which labs publish agent evals\nwhat they measure trajectories against')
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.proposeResearch('agent eval trends')
        expect(agent.state.research?.plan).toEqual([
          'which labs publish agent evals',
          'what they measure trajectories against',
        ])
      })
    } finally {
      restore()
    }
    expect(sent.join('\n')).toContain('which labs publish agent evals')
  })

  it('says so when planning fails, instead of letting the rejection reach waitUntil', async () => {
    // The only network call on the command path, and the command is not a turn: unhandled here
    // means the user hears nothing at all.
    const stub = await freshAgent()
    const { sent, restore } = captureSends()
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(500, { message: 'boom' }, { headers: { 'content-type': 'application/json' } })
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.proposeResearch('agent eval trends')

        expect(agent.state.research).toBeUndefined()
      })
    } finally {
      restore()
    }
    expect(sent.join('\n')).toMatch(/could not plan/i)
  })

  it('keeps the proposal when the reply cannot be delivered', async () => {
    // Observed against a deliberately invalid bot token, back when replying meant sending: the
    // proposal was recorded, the reply to it threw, and Start twelve seconds later found nothing
    // to run — an escaping rejection rolls the Durable Object's writes back with it. The channel
    // that failed is gone; a throwing `emit` reaches the same catch.
    const stub = await freshAgent()
    const proto = PersonalAgent.prototype as unknown as { emit: Emit }
    const spy = vi.spyOn(proto, 'emit').mockRejectedValue(new Error('state write failed'))
    queuePlan()
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await expect(agent.proposeResearch('agent eval trends')).resolves.toBeUndefined()
        expect(agent.state.research).toMatchObject({ phase: 'proposed', topic: 'agent eval trends' })
      })
    } finally {
      spy.mockRestore()
    }
  })

  it('asks for a topic instead of proposing an empty one', async () => {
    const stub = await freshAgent()
    const { sent, restore } = captureSends()
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.proposeResearch('')
        expect(agent.state.research).toBeUndefined()
      })
    } finally {
      restore()
    }
    expect(sent.join('\n')).toMatch(/topic/i)
  })
})

describe('/research plan', () => {
  it('revises the plan and shows the proposal again', async () => {
    const stub = await freshAgent()
    const { sent, restore } = captureSends()
    queuePlan()
    // Captured from the wire: a canned reply comes back whether or not the note was sent, so the
    // request body is the only thing that shows the refinement reached the model.
    let asked = ''
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        (opts) => {
          asked = requestBody(opts)
          return { choices: [{ message: { content: 'token cost per trajectory\nwho pays for reruns' } }] }
        },
        { headers: { 'content-type': 'application/json' } },
      )
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.proposeResearch('agent eval trends')
        await agent.revisePlan('add the cost angle')

        expect(agent.state.research).toMatchObject({ phase: 'proposed', topic: 'agent eval trends' })
        expect(agent.state.research?.plan).toEqual(['token cost per trajectory', 'who pays for reruns'])
      })
    } finally {
      restore()
    }
    expect(sent.at(-1)).toContain('token cost per trajectory')
    expect(asked).toContain('add the cost angle')
    // The old plan travels too, so the model revises rather than starting over.
    expect(asked).toContain('who publishes')
    // Numbered so "remove 2." has a referent — see `planResearch`.
    expect(asked).toContain('1. who publishes')
    expect(asked).not.toContain('- who publishes')
  })

  it('keeps four angles and says which it dropped', async () => {
    // The user is told the cap in the card; the log is how we find out it bit.
    const stub = await freshAgent()
    const { restore } = captureSends()
    queuePlan('one\ntwo\nthree\nfour\nfive\nsix')
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.proposeResearch('agent eval trends')
        expect(agent.state.research?.plan).toEqual(['one', 'two', 'three', 'four'])
      })
    } finally {
      spy.mockRestore()
      restore()
    }
    // Mutation check: drop the `if` around the event and this is undefined.
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({ stage: 'plan-truncated', got: 6, kept: 4 }),
    )
  })

  it('keeps the preset the card chose on the run, and anything else as normal', async () => {
    const stub = await freshAgent()
    const { restore } = captureSends()
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        const startWith = async (preset?: string) => {
          queuePlan()
          await agent.proposeResearch('agent eval trends')
          await (preset === undefined ? agent.startResearch() : agent.startResearch(preset as never))
          for (const s of await agent.listSchedules()) {
            await agent.cancelSchedule(s.id)
          }
          const kept = agent.state.research?.preset
          await agent.stopResearch()
          return kept
        }
        expect(await startWith('deep')).toBe('deep')
        expect(await startWith()).toBe('normal')
        // Over RPC the argument is whatever the client sent. Mutation check: `in` instead of
        // `hasOwn` and `toString` is kept as a preset, and every round then reads
        // `presetOf(state).deadlineMs` off a function.
        expect(await startWith('bogus')).toBe('normal')
        expect(await startWith('toString')).toBe('normal')
      })
    } finally {
      restore()
    }
  })

  it('refuses once the run is going, rather than replanning under a round', async () => {
    const stub = await freshAgent()
    const { sent, restore } = captureSends()
    queuePlan()
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.proposeResearch('agent eval trends')
        await agent.startResearch()
        // No second plan call queued: refusing must not reach the model at all.
        await agent.revisePlan('something else')

        // Everything, not just the round: if the refusal ever stops refusing, the failure should
        // be this assertion and not an alarm firing after teardown.
        for (const s of await agent.listSchedules()) {
          await agent.cancelSchedule(s.id)
        }
        expect(agent.state.research?.phase).toBe('running')
      })
    } finally {
      restore()
    }
    expect(sent.at(-1)).toMatch(/already going|stop first/i)
  })

  it('says there is nothing to replan when no topic was proposed', async () => {
    const stub = await freshAgent()
    const { sent, restore } = captureSends()
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.revisePlan('whatever')
        expect(agent.state.research).toBeUndefined()
      })
    } finally {
      restore()
    }
    expect(sent.at(-1)).toMatch(/nothing proposed/i)
  })
})

describe('/research go', () => {
  it('starts the chain from a proposal', async () => {
    const stub = await freshAgent()
    const { restore } = captureSends()
    queuePlan()
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.proposeResearch('agent eval trends')
        await agent.startResearch()

        expect(agent.state.research?.phase).toBe('running')
        const scheduled = await pending(agent)
        expect(scheduled).toHaveLength(1)
        for (const s of scheduled) {
          await agent.cancelSchedule(s.id)
        }
      })
    } finally {
      restore()
    }
  })

  it('does nothing when there is no proposal to start', async () => {
    const stub = await freshAgent()
    const { sent, restore } = captureSends()
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.startResearch()
        expect(await pending(agent)).toHaveLength(0)
      })
    } finally {
      restore()
    }
    expect(sent.join('\n')).toMatch(/nothing|no proposal/i)
  })
})

describe('/research stop', () => {
  it('cancels the chain and clears the state so nothing is left hanging', async () => {
    const stub = await freshAgent()
    const { sent, restore } = captureSends()
    queuePlan()
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.proposeResearch('agent eval trends')
        await agent.startResearch()
        await agent.stopResearch()

        expect(agent.state.research).toBeUndefined()
        // State surviving a stop would make the next round resume a run the user cancelled.
        expect(await pending(agent)).toHaveLength(0)
      })
    } finally {
      restore()
    }
    // Reading the phrasing, not just the state: the reply is the only signal the user gets that
    // the stop landed on something.
    expect(sent.at(-1)).not.toMatch(/nothing was running/i)
  })

  it('says so when there was nothing to stop', async () => {
    const stub = await freshAgent()
    const { sent, restore } = captureSends()
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.stopResearch()
      })
    } finally {
      restore()
    }
    expect(sent.at(-1)).toMatch(/nothing was running/i)
  })
})

describe('a second topic while a run is in flight', () => {
  it('is refused rather than silently replacing the run', async () => {
    // Overwriting the state would leave the scheduled round looking at a proposal, so it would
    // return without a word: the run dies, the notes go, and nobody is told.
    const stub = await freshAgent()
    const { sent, restore } = captureSends()
    queuePlan()
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.proposeResearch('first topic')
        await agent.startResearch()
        await agent.proposeResearch('second topic')

        // Cancel before asserting: a failed assertion here would otherwise leave the round
        // scheduled and the suite dies at teardown instead of reporting the failure.
        for (const s of await pending(agent)) {
          await agent.cancelSchedule(s.id)
        }
        expect(agent.state.research).toMatchObject({ phase: 'running', topic: 'first topic' })
      })
    } finally {
      restore()
    }
    expect(sent.at(-1)).toMatch(/stop/i)
  })
})

describe('scheduleChain keeps chains apart', () => {
  it('schedules compaction and research independently', async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.scheduleChain('runCompactHistory', 600)
      await agent.scheduleChain('runResearchRound', 600)

      const all = await agent.listSchedules()
      expect(all.filter((s) => s.callback === 'runCompactHistory')).toHaveLength(1)
      expect(all.filter((s) => s.callback === 'runResearchRound')).toHaveLength(1)
      for (const s of all) {
        await agent.cancelSchedule(s.id)
      }
    })
  })
})

describe('runResearchRound', () => {
  const CF = 'https://api.cloudflare.com'
  const PAGE = '# A\n\nA body long enough to survive the prose extractor unchanged, with real sentences.'

  function queueLlm(msg: Record<string, unknown>) {
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(200, { choices: [{ message: msg }] }, { headers: { 'content-type': 'application/json' } })
  }

  function queueRead() {
    fetchMock
      .get(CF)
      .intercept({ method: 'POST', path: '/client/v4/accounts/test-account/browser-rendering/markdown' })
      .reply(200, { success: true, result: PAGE }, { headers: { 'content-type': 'application/json' } })
  }

  /**
   * Scouts run at once and take queued interceptors in arrival order, so a per-scout script gets
   * interleaved: the second scout answers with the first one's findings and never calls a tool.
   * Replying from the request body instead makes each scout's turn independent of the others'.
   */
  function scoutScript(scouts: number, findings: (n: number) => string) {
    let served = 0
    // Two model calls and one page per scout, and every interceptor is interchangeable because it
    // answers from the request body. Persisting them instead would have leaked into later tests.
    for (let i = 0; i < scouts * 2; i++) {
      fetchMock
        .get('https://llm.example')
        .intercept({ method: 'POST', path: '/v1/chat/completions' })
        .reply(
          200,
          (opts) => {
            const body = requestBody(opts)
            if (!body.includes('"role":"tool"')) {
              return {
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [
                        {
                          id: 'c1',
                          type: 'function',
                          function: { name: 'read_page', arguments: `{"url":"https://found.example/${served}"}` },
                        },
                      ],
                    },
                  },
                ],
              }
            }
            return { choices: [{ message: { content: findings(served++) } }] }
          },
          { headers: { 'content-type': 'application/json' } },
        )
    }
    for (let i = 0; i < scouts; i++) {
      queueRead()
    }
  }

  const readCall = (url: string) => ({
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_page', arguments: JSON.stringify({ url }) } }],
  })

  /**
   * Wound on to the round after the wave by default: these tests are about a depth round, and round
   * zero of a multi-angle plan is the wave, which has its own tests below. Both fields move
   * together because `applyWave` sets them together — `waved` at round zero is not a real state.
   */
  async function startRun(agent: PersonalAgent, opts: { waved?: boolean } = {}) {
    await agent.proposeResearch('agent eval trends')
    await agent.startResearch()
    for (const s of await pending(agent)) {
      await agent.cancelSchedule(s.id)
    }
    if (opts.waved ?? true) {
      const started = agent.state.research as NonNullable<PersonalAgent['state']['research']>
      agent.setState({ ...agent.state, research: { ...started, waved: true, round: 1 } })
    }
  }

  it('stops on the model verdict once the round actually covered ground', async () => {
    const stub = await freshAgent()
    const { sent, restore } = captureSends()
    queuePlan()
    queueLlm(readCall('https://example.com/a'))
    queueRead()
    queueLlm({ content: '## Findings\nFindings so far.\n\n## Done\nyes' })
    queueLlm({ content: 'Findings so far, written up.' })
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent)
        await agent.runResearchRound()

        // Parked, not filed: the run waits for the user to save or drop it.
        expect(agent.state.research).toMatchObject({ phase: 'done' })
        expect(await pending(agent)).toHaveLength(0)

        // The report is in state, which is where the client draws it from.
        expect(agent.state.research?.report).toBe('Findings so far, written up.')
        // Dropping is what ends a run nobody wants filed.
        await agent.stopResearch()
        expect(agent.state.research).toBeUndefined()
      })
    } finally {
      restore()
    }
    expect(sent.join('\n')).toMatch(/done/i)
  })

  it('leaves the finished report in state without being asked for it', async () => {
    // Five minutes of work should not wait behind a command the user has to remember. The client
    // draws the report straight from broadcast state, so the notice is only the offer.
    const stub = await freshAgent()
    const { sent, restore } = captureSends()
    queuePlan('who publishes')
    queueLlm(readCall('https://example.com/new'))
    queueRead()
    queueLlm({ content: '## Findings\nFindings so far.\n\n## Done\nyes' })
    queueLlm({ content: 'The written report.' })
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent)
        await agent.runResearchRound()
        expect(agent.state.research).toMatchObject({ phase: 'done', report: 'The written report.' })
        for (const sch of await agent.listSchedules()) {
          await agent.cancelSchedule(sch.id)
        }
      })
    } finally {
      restore()
    }
    expect(sent.join('\n')).toMatch(/agent eval trends/)
  })

  it('stops on no-new-ground even when the model claims to be done', async () => {
    // Order matters and is fixed: a round that read nothing new stopped for that reason, whatever
    // the model says about itself. The symptom is more trustworthy than the verdict.
    const stub = await freshAgent()
    const { restore } = captureSends()
    queuePlan()
    // A search that turns up only what the run has already seen: sourced, so the findings stand,
    // but no page was opened, which is what no-new-ground is about.
    queueLlm({
      content: null,
      tool_calls: [{ id: 's1', type: 'function', function: { name: 'web_search', arguments: '{"query":"q"}' } }],
    })
    fetchMock
      .get('https://api.firecrawl.dev')
      .intercept({ method: 'POST', path: '/v2/search' })
      .reply(
        200,
        { success: true, data: { web: [{ title: 'T', url: 'https://seen', description: 'd' }] } },
        { headers: { 'content-type': 'application/json' } },
      )
    queueLlm({ content: '## Findings\nNothing new.\n\n## Done\nyes' })
    queueLlm({ content: 'Nothing new, written up.' })
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent)
        const started = agent.state.research as NonNullable<PersonalAgent['state']['research']>
        agent.setState({ ...agent.state, research: { ...started, visited: ['https://seen'] } })
        await agent.runResearchRound()
        expect(agent.state.research?.report).toMatch(/nothing new, written up/i)
      })
    } finally {
      restore()
    }
  })

  it('schedules the next round while there is more to do', async () => {
    const stub = await freshAgent()
    const { restore } = captureSends()
    queuePlan()
    queueLlm(readCall('https://example.com/new'))
    queueRead()
    queueLlm({ content: '## Findings\nPartial.\n\n## Open questions\n- more?\n\n## Done\nno' })
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent)
        await agent.runResearchRound()

        expect(agent.state.research?.phase).toBe('running')
        expect(agent.state.research?.visited).toEqual(['https://example.com/new'])
        const next = await pending(agent)
        expect(next).toHaveLength(1)
        for (const s of next) {
          await agent.cancelSchedule(s.id)
        }
      })
    } finally {
      restore()
    }
  })

  it('reports a round through state rather than posting one message per round', async () => {
    // The run's progress is in broadcast state, which every connected client already re-renders
    // from. Posting a round would put four near-identical messages in the thread.
    const stub = await freshAgent()
    const { sent, restore } = captureSends()
    queuePlan('who publishes')
    queueLlm(readCall('https://example.com/new'))
    queueRead()
    queueLlm({ content: '## Findings\nPartial.\n\n## Done\nno' })
    let after: { round: number; read: number } | undefined
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.proposeResearch('agent eval trends')
        await agent.startResearch()
        for (const s of await pending(agent)) {
          await agent.cancelSchedule(s.id)
        }
        const before = sent.length

        await agent.runResearchRound()
        // Captured and asserted outside: an assertion that throws in here skips the cancel below,
        // and the alarm it leaves fires after teardown as "Isolated storage failed" — which reads
        // as a broken harness rather than the broken behaviour it actually is.
        expect(sent.length).toBe(before)
        const state = agent.state.research
        after = state ? { round: state.round, read: state.read } : undefined
        for (const sch of await agent.listSchedules()) {
          await agent.cancelSchedule(sch.id)
        }
      })
    } finally {
      restore()
    }
    expect(after).toMatchObject({ round: 1, read: 1 })
  })

  it('fans the first round out over the plan, one scout per angle', async () => {
    // Each scout is a Durable Object of its own, so each spends its own fifty subrequests rather
    // than a share of this invocation's — which is the whole reason the breadth pass is a wave.
    const stub = await freshAgent()
    const { restore } = captureSends()
    queuePlan()
    scoutScript(2, (n) => `## Findings\nFound ${n}.\n\n## Done\nyes`)
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent, { waved: false })
        await agent.runResearchRound()

        const state = agent.state.research
        expect(state).toMatchObject({ phase: 'running', round: 1, waved: true })
        // One entry per scout, not one per round: the report is written from all of them.
        expect(state?.findings).toHaveLength(2)
        expect(state?.visited.length).toBeGreaterThan(0)
        // The scouts' spend is reported, never charged to the run's budget.
        expect(state?.scoutSpent).toBeGreaterThan(0)
        expect(state?.spent).toBe(0)
        // A wave never ends a run, however sure the scouts were that their angle was covered.
        expect(state?.modelDone).toBe(false)

        for (const sch of await pending(agent)) {
          await agent.cancelSchedule(sch.id)
        }
      })
    } finally {
      restore()
    }
  })

  it('fans a later round out over the open questions, three wide instead of five', async () => {
    // Static-DRA narrows by two a level: the first round is the landscape and deserves the whole
    // wave, later ones chase what the landscape did not settle.
    const stub = await freshAgent()
    const { restore } = captureSends()
    queuePlan()
    scoutScript(3, (n) => `## Findings\nOn ${n}.\n\n## Done\nno`)
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent)
        const started = agent.state.research as NonNullable<PersonalAgent['state']['research']>
        agent.setState({
          ...agent.state,
          research: { ...started, round: 1, openQuestions: ['q0', 'q1', 'q2', 'q3'], visited: ['https://seen'] },
        })
        await agent.runResearchRound()

        expect(agent.state.research?.findings).toHaveLength(3)
        expect(agent.state.research?.round).toBe(2)
        // Every schedule, not just the next round: with no page read the run finishes here and
        // parks a postNotice, and an alarm left behind fires after teardown.
        for (const sch of await agent.listSchedules()) {
          await agent.cancelSchedule(sch.id)
        }
      })
    } finally {
      restore()
    }
  })

  it('runs the scouts on their own model, and the round on the main one', async () => {
    // A wave is where the tokens go, and a scout reads and reports rather than writing the report,
    // so it is the part worth trading down first.
    const stub = await freshAgent()
    const { restore } = captureSends()
    const asked: string[] = []
    const capture = () =>
      fetchMock
        .get('https://llm.example')
        .intercept({ method: 'POST', path: '/v1/chat/completions' })
        .reply(
          200,
          (opts) => {
            asked.push(String(JSON.parse(requestBody(opts) || '{}').model))
            return { choices: [{ message: { content: '## Findings\nFound.\n\n## Done\nno' } }] }
          },
          { headers: { 'content-type': 'application/json' } },
        )

    queuePlan()
    capture()
    capture()
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent, { waved: false })
        await agent.runResearchRound()
        for (const sch of await agent.listSchedules()) {
          await agent.cancelSchedule(sch.id)
        }
      })
    } finally {
      restore()
    }
    expect(asked).toEqual(['test-scout-model', 'test-scout-model'])
  })

  it('leaves an ordinary round on the main model', async () => {
    const stub = await freshAgent()
    const { restore } = captureSends()
    let asked = ''
    queuePlan('who publishes')
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        (opts) => {
          asked = String(JSON.parse(requestBody(opts) || '{}').model)
          return { choices: [{ message: { content: '## Findings\nFound.\n\n## Done\nno' } }] }
        },
        { headers: { 'content-type': 'application/json' } },
      )
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent, { waved: false })
        await agent.runResearchRound()
        for (const sch of await agent.listSchedules()) {
          await agent.cancelSchedule(sch.id)
        }
      })
    } finally {
      restore()
    }
    expect(asked).toBe('test-model')
  })

  it('takes the ordinary round when the plan has a single angle', async () => {
    const stub = await freshAgent()
    const { restore } = captureSends()
    queuePlan('who publishes')
    queueLlm(readCall('https://example.com/new'))
    queueRead()
    queueLlm({ content: '## Findings\nPartial.\n\n## Done\nno' })
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent, { waved: false })
        await agent.runResearchRound()

        expect(agent.state.research).toMatchObject({ round: 1, findings: ['Partial.'] })
        expect(agent.state.research?.waved).toBeUndefined()
        for (const sch of await pending(agent)) {
          await agent.cancelSchedule(sch.id)
        }
      })
    } finally {
      restore()
    }
  })

  it('stops on the clock, and still writes the report it gathered', async () => {
    // The deadline bounds the gathering, not the report: a run that collected material and then
    // dropped it for the clock would be worse than one that ran half a minute long.
    const stub = await freshAgent()
    const { restore } = captureSends()
    queuePlan()
    queueLlm({ content: 'Written up against the clock.' })
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent)
        const started = agent.state.research as NonNullable<PersonalAgent['state']['research']>
        agent.setState({
          ...agent.state,
          research: { ...started, findings: ['what one round found'], startedAt: Date.now() - RESEARCH_DEADLINE_MS },
        })
        await agent.runResearchRound()

        // The cause rides in state as a wire value; the client is what phrases it.
        expect(agent.state.research).toMatchObject({
          phase: 'done',
          stopCause: 'time',
          report: 'Written up against the clock.',
        })
        await agent.stopResearch()
      })
    } finally {
      restore()
    }
  })

  it('says it is writing while the report is written, and never on the finished state', async () => {
    // The report call is unbounded by the deadline and has taken four minutes; the card said
    // "Researching" throughout. Mutation checks: drop the `writing` setState and the first
    // assertion is undefined; spread `this.state.research` into `finishRun` and the second fails.
    const stub = await freshAgent()
    const { restore } = captureSends()
    queuePlan()
    let inFlight: PersonalAgent | undefined
    let writingSeen: boolean | undefined
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        () => {
          writingSeen = inFlight?.state.research?.writing
          return { choices: [{ message: { content: 'Written.' } }] }
        },
        { headers: { 'content-type': 'application/json' } },
      )
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent)
        inFlight = agent
        const started = agent.state.research as NonNullable<PersonalAgent['state']['research']>
        agent.setState({
          ...agent.state,
          research: { ...started, findings: ['found'], startedAt: Date.now() - RESEARCH_DEADLINE_MS },
        })
        await agent.runResearchRound()

        expect(writingSeen).toBe(true)
        expect(agent.state.research).toMatchObject({ phase: 'done', report: 'Written.' })
        expect(agent.state.research?.writing).toBeUndefined()
        await agent.stopResearch()
      })
    } finally {
      restore()
    }
  })

  it('lets a stop landed during the report stand, rather than finishing over it', async () => {
    // Four minutes with a Stop button under the card: a `done` written after the clear would put
    // the stopped run back with a report attached. Mutation check: drop the `isCurrentRun` check
    // in finishResearch.
    const stub = await freshAgent()
    const { restore } = captureSends()
    queuePlan()
    let inFlight: PersonalAgent | undefined
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        () => {
          inFlight?.setState({ ...inFlight.state, research: undefined })
          return { choices: [{ message: { content: 'Written.' } }] }
        },
        { headers: { 'content-type': 'application/json' } },
      )
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent)
        inFlight = agent
        const started = agent.state.research as NonNullable<PersonalAgent['state']['research']>
        agent.setState({
          ...agent.state,
          research: { ...started, findings: ['found'], startedAt: Date.now() - RESEARCH_DEADLINE_MS },
        })
        await agent.runResearchRound()

        expect(agent.state.research).toBeUndefined()
        expect(await pending(agent)).toHaveLength(0)
      })
    } finally {
      restore()
    }
  })

  it('takes a scout’s running count only for the wave in flight', async () => {
    // A scout from a run the user stopped, or a wave that already landed, must not write into
    // whatever is running now. Mutation check: drop the run-id check and `b` reads 9.
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      const run = startResearch(proposeResearch('t', ['a', 'b']), 'r1') as NonNullable<
        PersonalAgent['state']['research']
      >
      agent.setState({
        ...agent.state,
        research: {
          ...run,
          scouts: [
            { angle: 'a', reads: 0, searches: 0 },
            { angle: 'b', reads: 0, searches: 0 },
          ],
        },
      })
      await agent.scoutProgress('r1', 'a', { reads: 2, searches: 1 })
      await agent.scoutProgress('old', 'b', { reads: 9, searches: 9 })
      expect(agent.state.research?.scouts).toEqual([
        { angle: 'a', reads: 2, searches: 1 },
        { angle: 'b', reads: 0, searches: 0 },
      ])
      agent.setState({ ...agent.state, research: undefined })
    })
  })

  it('says out loud when a round cites a page the run never opened', async () => {
    // Findings are appended and never verified, so an invented source reaches the report looking
    // exactly like a read one.
    const stub = await freshAgent()
    const { restore } = captureSends()
    const events: Record<string, unknown>[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      try {
        events.push(JSON.parse(line))
      } catch {
        /* not one of ours */
      }
    })
    queuePlan('who publishes')
    queueLlm({
      content: null,
      tool_calls: [
        { id: 's1', type: 'function', function: { name: 'web_search', arguments: '{"query":"who publishes"}' } },
      ],
    })
    fetchMock
      .get('https://api.firecrawl.dev')
      .intercept({ method: 'POST', path: '/v2/search' })
      .reply(
        200,
        { success: true, data: { web: [{ title: 'T', url: 'https://snippet.example/seen', description: 'd' }] } },
        { headers: { 'content-type': 'application/json' } },
      )
    // One cited from a snippet the search showed, one from nowhere. Only the second is a finding.
    queueLlm({
      content:
        '## Findings\nFrom the snippet. https://snippet.example/seen\nAnd this. https://invented.example/paper\n\n## Done\nno',
    })
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent, { waved: false })
        // An earlier round already carried one. Re-reporting it every round would turn one warning
        // into a rising count that says nothing about the round that just ran.
        const started = agent.state.research as NonNullable<PersonalAgent['state']['research']>
        agent.setState({
          ...agent.state,
          research: { ...started, findings: ['Old claim. https://also-invented.example/old'] },
        })
        await agent.runResearchRound()
        for (const sch of await agent.listSchedules()) {
          await agent.cancelSchedule(sch.id)
        }
      })
    } finally {
      spy.mockRestore()
      restore()
    }
    const warning = events.find((e) => e.stage === 'ungrounded-citations')
    expect(warning).toMatchObject({ count: 1 })
    // Not the earlier round's, and not the one the search put in front of the model.
    expect(JSON.stringify(warning)).not.toContain('also-invented')
    expect(JSON.stringify(warning)).not.toContain('snippet.example')
  })

  it('abandons the run when a round throws, rather than retrying it forever', async () => {
    // A round that threw has already spent its requests. Rescheduling it burns the budget
    // without making progress, and the user waits for a report that never comes.
    const stub = await freshAgent()
    const { sent, restore } = captureSends()
    queuePlan()
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(500, { message: 'boom' }, { headers: { 'content-type': 'application/json' } })
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent)
        await agent.runResearchRound()

        expect(agent.state.research).toBeUndefined()
        expect(await pending(agent)).toHaveLength(0)
      })
    } finally {
      restore()
    }
    expect(sent.join('\n')).toMatch(/research failed/i)
  })

  it('charges the round before doing the work, so a killed invocation is not retried forever', async () => {
    // An invocation killed rather than thrown out of — CPU limit, eviction — leaves the schedule
    // row in place and the platform retries it. Nothing recorded means nothing to stop the retry.
    const stub = await freshAgent()
    const { restore } = captureSends()
    let atCallTime: { round: number; spent: number } | undefined
    queuePlan()
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent)
        fetchMock
          .get('https://llm.example')
          .intercept({ method: 'POST', path: '/v1/chat/completions' })
          .reply(
            200,
            () => {
              const r = agent.state.research
              atCallTime = { round: r?.round ?? -1, spent: r?.spent ?? -1 }
              return { choices: [{ message: { content: '## Findings\nFindings.\n\n## Done\nno' } }] }
            },
            { headers: { 'content-type': 'application/json' } },
          )

        await agent.runResearchRound()
        for (const s of await pending(agent)) {
          await agent.cancelSchedule(s.id)
        }
      })
    } finally {
      restore()
    }
    expect(atCallTime?.round).toBe(2)
    expect(atCallTime?.spent).toBeGreaterThanOrEqual(50)
  })

  it('reports and clears instead of running when the state is already past a cap', async () => {
    const stub = await freshAgent()
    const { restore } = captureSends()
    // Only the plan call is queued: the entry gate is what stops a retried round from spending.
    queuePlan()
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent)
        const state = agent.state.research as NonNullable<PersonalAgent['state']['research']>
        agent.setState({ ...agent.state, research: { ...state, spent: RESEARCH_SUBREQUEST_BUDGET } })

        await agent.runResearchRound()

        expect(agent.state.research).toMatchObject({ phase: 'done', stopCause: 'budget' })
        expect(await pending(agent)).toHaveLength(0)
      })
    } finally {
      restore()
    }
  })

  it('does not write a stopped run back to life when the stop landed mid-round', async () => {
    // The round captures the state, works, then writes its result. Without the run-id check that
    // write undoes the stop and reschedules a run the user cancelled.
    const stub = await freshAgent()
    const { restore } = captureSends()
    queuePlan()
    queueLlm(readCall('https://example.com/a'))
    queueRead()
    queueLlm({ content: '## Findings\nFindings.\n\n## Done\nno' })
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent)
        const stopMidRound = async () => {
          agent.setState({ ...agent.state, research: undefined })
        }
        // The stop cannot literally interleave inside the call here, so it is applied to the same
        // state the round will write over — which is what interleaving produces.
        const round = agent.runResearchRound()
        await stopMidRound()
        await round

        expect(agent.state.research).toBeUndefined()
        expect(await pending(agent)).toHaveLength(0)
      })
    } finally {
      restore()
    }
  })

  it('sends every finding unwritten when the report call fails', async () => {
    // The write is the last call of a dozen. A run that gathered material must not end with
    // nothing to show because that one failed.
    const stub = await freshAgent()
    const { restore } = captureSends()
    queuePlan()
    queueLlm(readCall('https://example.com/a'))
    queueRead()
    queueLlm({ content: '## Findings\nRaw finding kept verbatim.\n\n## Done\nyes' })
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(500, { message: 'boom' }, { headers: { 'content-type': 'application/json' } })
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent)
        await agent.runResearchRound()

        expect(agent.state.research?.report).toContain('Raw finding kept verbatim.')
      })
    } finally {
      restore()
    }
  })

  it('saves the report as a vault file and reconciles so search_memory can find it', async () => {
    // A file nothing indexed is the trap this vault already has a section about: three read paths,
    // and one of them would never see it.
    const stub = await freshAgent()
    const { sent, restore } = captureSends()
    queuePlan()
    queueLlm(readCall('https://example.com/a'))
    queueRead()
    queueLlm({ content: '## Findings\nA finding worth keeping.\n\n## Done\nyes' })
    queueLlm({ content: 'The written report.' })
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent)
        await agent.runResearchRound()

        await agent.saveResearch()

        expect(agent.state.research).toBeUndefined()
        // The reconcile is an RPC into the index instance, so it schedules nothing here and its
        // embeddings are charged to that instance's own invocation rather than to this turn.
        expect(await agent.listSchedules()).toEqual([])
      })
    } finally {
      restore()
    }
    const files = await listVault('agent/research')
    expect(files).toHaveLength(1)
    expect(await readVault(files[0])).toContain('The written report.')
    // Past tense: the reconcile is awaited before the message, so "reindexing" described a job
    // that had already finished.
    expect(sent.at(-1)).toMatch(/in memory as research\/.*can find it now/i)
  })

  it('shows the indicator while the index catches up, and says so when it cannot', async () => {
    // The card leaves with the state and the reconcile takes seconds, so the save read as stuck;
    // and a reconcile that threw left the state cleared with nothing said. Mutation checks: drop
    // the `status: 'thinking'` and `seen` is undefined; drop the try/catch and the call rejects.
    const stub = await freshAgent()
    const { sent, restore } = captureSends()
    queuePlan()
    queueLlm(readCall('https://example.com/a'))
    queueRead()
    queueLlm({ content: '## Findings\nA finding worth keeping.\n\n## Done\nyes' })
    queueLlm({ content: 'The written report.' })
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent)
        await agent.runResearchRound()
        let seen: string | undefined
        agent.maintenance = () =>
          ({
            reconcile: async () => {
              seen = agent.state.status
              throw new Error('index down')
            },
          }) as never

        await agent.saveResearch()

        expect(seen).toBe('thinking')
        expect(agent.state.status).toBeUndefined()
        expect(agent.state.research).toBeUndefined()
      })
    } finally {
      restore()
    }
    expect(await listVault('agent/research')).toHaveLength(1)
    expect(sent.at(-1)).toMatch(/in memory as research\/.*nightly reindex will pick it up/i)
  })

  it('parks a finished run until it is saved, rather than filing it itself', async () => {
    // Five minutes of work is not filed on the agent's own judgement; the user decides where it
    // goes, and the run waits in `done` until they do.
    const stub = await freshAgent()
    const { restore } = captureSends()
    queuePlan()
    queueLlm(readCall('https://example.com/a'))
    queueRead()
    queueLlm({ content: '## Findings\nKept after showing.\n\n## Done\nyes' })
    queueLlm({ content: 'The written report.' })
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await startRun(agent)
        await agent.runResearchRound()

        expect(agent.state.research).toMatchObject({ phase: 'done' })

        await agent.saveResearch()
        expect(agent.state.research).toBeUndefined()
        for (const sch of await agent.listSchedules()) {
          await agent.cancelSchedule(sch.id)
        }
      })
    } finally {
      restore()
    }
    const files = await listVault('agent/research')
    expect(await readVault(files[0])).toContain('The written report.')
  })

  it('says there is nothing to save when no run has finished', async () => {
    const stub = await freshAgent()
    const { sent, restore } = captureSends()
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.saveResearch()
        expect(await agent.listSchedules()).toHaveLength(0)
      })
    } finally {
      restore()
    }
    expect(sent.at(-1)).toMatch(/nothing to save/i)
  })

  it('does nothing when the run was stopped before the alarm fired', async () => {
    const stub = await freshAgent()
    const { restore } = captureSends()
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        // No interceptor queued: a cancelled run must not reach the model at all.
        await agent.runResearchRound()
        expect(agent.state.research).toBeUndefined()
      })
    } finally {
      restore()
    }
  })
})
