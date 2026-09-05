import { env, fetchMock, runInDurableObject } from 'cloudflare:test'
import { getAgentByName } from 'agents'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type PersonalAgent } from '../../src/agent/personal-agent'
import type { Env } from '../../src/types'
import { VaultStore } from '../../src/agent/memory/vault-store'
import { seedVault } from '../helpers/vault'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

const testEnv = env as Env

async function freshAgent() {
  return getAgentByName(testEnv.PERSONAL_AGENT, `alarm-${crypto.randomUUID()}`)
}

// If runInDurableObject rejects the agents-SDK stub type, cast: (stub as never).
// It works because tests run in the same isolate (singleWorker: true).

describe('processWebMessage', () => {
  it('answers into broadcast state', async () => {
    const stub = await freshAgent()
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        { choices: [{ message: { content: 'hi Sam' } }] },
        { headers: { 'content-type': 'application/json' } },
      )

    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.processWebMessage({ text: 'hi' })
      expect(agent.state.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'hi Sam' })
    })
  })

  it('puts an error notice in the thread when the model call fails', async () => {
    const stub = await freshAgent()
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(500, { message: 'boom' }, { headers: { 'content-type': 'application/json' } })

    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.processWebMessage({ text: 'hi' })
      // A turn that failed must still say so: silence is indistinguishable from one still thinking.
      expect(agent.state.messages.at(-1)?.content).toContain('Sorry')
    })
  })
})

describe('scheduleChain', () => {
  it('replaces a pending link instead of adding a second one', async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      // Cancel-then-schedule, not schedule-if-absent: a running alarm cannot tell whether it
      // still counts as pending, and guessing wrong ends the chain with the work half done.
      await agent.scheduleChain('runCompactHistory', 600)
      await agent.scheduleChain('runCompactHistory', 600)

      const pending = (await agent.listSchedules()).filter((s) => s.callback === 'runCompactHistory')
      expect(pending).toHaveLength(1)
      await agent.cancelSchedule(pending[0].id)
    })
  })
})

describe('a failed turn logs one structured error record', () => {
  it('reports name and message as fields, not a concatenated string', async () => {
    const stub = await freshAgent()
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(500, { message: 'boom' }, { headers: { 'content-type': 'application/json' } })

    const lines: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.processWebMessage({ text: 'hi' })
      })
    } finally {
      logSpy.mockRestore()
    }

    const errors = lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((r): r is Record<string, unknown> => r !== null && r.level === 'error')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ at: 'turn', outcome: 'error', stopReason: 'error' })
    expect(typeof errors[0].subrequests).toBe('number')
    // Queryable fields, not a string that has to be regexed apart after the fact.
    expect(errors[0].error).toMatchObject({ name: expect.any(String), message: expect.any(String) })
  })
})

describe('swallowed failures inside a turn', () => {
  it('records them as queryable events carrying the turn they happened in', async () => {
    const stub = await freshAgent()
    // Losing the profile must not fail the turn — but it must not vanish either, and it has to
    // be attributable to the turn whose answer was degraded by it.
    const boom = vi.spyOn(VaultStore.prototype, 'getUserProfile').mockRejectedValue(new Error('vault down'))
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        { choices: [{ message: { content: 'still answered' } }] },
        { headers: { 'content-type': 'application/json' } },
      )
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.processWebMessage({ text: 'hi' })
      })
    } finally {
      spy.mockRestore()
      boom.mockRestore()
    }

    const records = lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((r): r is Record<string, unknown> => r !== null)

    const degraded = records.find((r) => r.level === 'error' && r.at === 'profile-load')
    expect(degraded).toBeDefined()
    expect(degraded?.error).toMatchObject({ name: 'Error', message: 'vault down' })
    // The turn still succeeded, and the swallowed failure shares its turnId.
    const turn = records.find((r) => r.at === 'turn')
    expect(turn?.outcome).toBe('ok')
    expect(degraded?.turnId).toBe(turn?.turnId)
  })
})

describe('the turn record carries why the loop stopped', () => {
  it('reports the loop stopReason on a successful turn', async () => {
    const stub = await freshAgent()
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        { choices: [{ message: { content: 'hi Sam' } }] },
        { headers: { 'content-type': 'application/json' } },
      )
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.processWebMessage({ text: 'hi' })
      })
    } finally {
      spy.mockRestore()
    }

    const turn = lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .find((r) => r !== null && r.at === 'turn')

    // The turn record must answer on its own terms: needing a join back to the loop record is
    // the thing the envelope was added to remove.
    expect(turn).toMatchObject({ outcome: 'ok', stopReason: 'complete', roundsUsed: 1, toolsUsed: [] })
    expect(typeof turn?.elapsedMs).toBe('number')
  })
})

describe('the deployment decides whether content is logged', () => {
  it('logs no content when LOG_CONTENT is unset, even with a tool call in the turn', async () => {
    const stub = await freshAgent()
    // vitest.config.ts pins LOG_CONTENT off, which is the code's default and not this
    // deployment's — wrangler.jsonc opts in.
    await seedVault({ 'agent/MEMORY.md': '# Agent memory\n\n- tea — prefers tea\n' })
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
                  { id: 'c1', type: 'function', function: { name: 'search_memory', arguments: '{"query":"tea"}' } },
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
      .reply(
        200,
        { choices: [{ message: { content: 'you prefer tea' } }] },
        { headers: { 'content-type': 'application/json' } },
      )
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.processWebMessage({ text: 'what do I drink?' })
      })
    } finally {
      spy.mockRestore()
    }

    const records = lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((r): r is Record<string, unknown> => r !== null && typeof r.turnId === 'string')

    expect(records.some((r) => r.stage === 'tool-result')).toBe(true)
    for (const r of records) {
      expect('content' in r).toBe(false)
    }
  })
})

describe('failures inside a turn stay attached to it', () => {
  it('attributes a skill-lookup failure to the turn that was degraded by it', async () => {
    const stub = await freshAgent()
    // A slash command sends the turn through resolveSkillInvocation; the vault read fails.
    const boom = vi.spyOn(VaultStore.prototype, 'readSkill').mockRejectedValue(new Error('vault down'))
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        { choices: [{ message: { content: 'answered anyway' } }] },
        { headers: { 'content-type': 'application/json' } },
      )
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.processWebMessage({ text: '/daily-digest for AI news' })
      })
    } finally {
      spy.mockRestore()
      boom.mockRestore()
    }

    const records = lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((r): r is Record<string, unknown> => r !== null)

    const turn = records.find((r) => r.at === 'turn')
    const lookup = records.find((r) => r.at === 'skill-lookup')
    expect(lookup).toBeDefined()
    // Without the turn's own logger this record has no turnId and a reader drops it, so the
    // degraded answer becomes unexplainable.
    expect(lookup?.turnId).toBe(turn?.turnId)
  })
})

describe('turn correlation end to end', () => {
  it('emits one turnId across a whole turn, seq without gaps, source web', async () => {
    const stub = await freshAgent()
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        { choices: [{ message: { content: 'hi Sam' } }] },
        { headers: { 'content-type': 'application/json' } },
      )
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    try {
      await runInDurableObject(stub, async (agent: PersonalAgent) => {
        await agent.processWebMessage({ text: 'hi' })
      })
    } finally {
      spy.mockRestore()
    }

    const records = lines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((r): r is Record<string, unknown> => r !== null && typeof r.turnId === 'string')

    expect(records.length).toBeGreaterThan(1)
    expect(new Set(records.map((r) => r.turnId)).size).toBe(1)
    expect(records.map((r) => r.seq)).toEqual(records.map((_, i) => i))
    expect(new Set(records.map((r) => r.source))).toEqual(new Set(['web']))
    // The turn record is part of the same turn, not a separate one.
    expect(records.some((r) => r.at === 'turn' && r.outcome === 'ok')).toBe(true)
  })
})

describe('emit', () => {
  it('appends to history with the fields a client renders from', async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.fireReminder({ text: 'stand up' })
      expect(agent.state.messages).toHaveLength(1)
      expect(agent.state.messages[0]).toMatchObject({ role: 'assistant', content: '⏰ stand up' })
      expect(agent.state.messages[0].id).toBeDefined()
      expect(agent.state.messages[0].at).toBeDefined()
    })
  })
})

describe('the dev entrypoints refuse to exist outside localhost', () => {
  /** The route's own 404 is the first guard; this is the second, so a future caller — a new route,
   *  an RPC, a `@callable` added by mistake — cannot unlock them by reaching past it.
   *
   *  Mutation check: drop either `assertDevOnly` call in `personal-agent.ts` and this fails. */
  it('throws instead of overwriting a conversation or spending a turn', async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      // `env` is protected on DurableObject and the pool hands every instance the same one, so
      // asking what production does means redefining the property rather than passing a binding.
      const real = (agent as unknown as { env: Env }).env
      Object.defineProperty(agent, 'env', { value: { ...real, ENVIRONMENT: 'production' }, configurable: true })
      try {
        await expect(agent.seedState({ messages: [] })).rejects.toThrow(/localhost-only/)
        await expect(agent.handleUserMessage('hello')).rejects.toThrow(/localhost-only/)
        // Refused, not merely reported as refused: the conversation is untouched and no model was
        // called — an interceptor was never registered, so a call would have failed the suite.
        expect(agent.state.messages).toEqual([])
      } finally {
        Object.defineProperty(agent, 'env', { value: real, configurable: true })
      }
    })
  })
})
