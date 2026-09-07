import { env, fetchMock, runInDurableObject } from 'cloudflare:test'
import { getAgentByName } from 'agents'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { PersonalAgent } from '../../src/agent/personal-agent'
import type { Env, WebMessagePayload } from '../../src/types'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

const testEnv = env as Env

async function freshAgent() {
  return getAgentByName(testEnv.PERSONAL_AGENT, `web-${crypto.randomUUID()}`)
}

/** An unfired alarm runs after this test's isolated storage is torn down and corrupts the next
 *  test's, so every schedule a test creates is taken and cancelled before it returns. */
async function takeSchedules(agent: PersonalAgent, callback: string) {
  const pending = (await agent.listSchedules()).filter((s) => s.callback === callback)
  await Promise.all(pending.map((s) => agent.cancelSchedule(s.id)))
  return pending
}

/** Keeps the schedule row and disarms the alarm behind it, so a turn the test runs by hand is not
 *  run a second time by the SDK after the test has returned. */
const disarmAlarm = (agent: PersonalAgent) =>
  (agent as unknown as { ctx: DurableObjectState }).ctx.storage.deleteAlarm()

function replyOnce(content: string, capture?: (body: string) => void) {
  fetchMock
    .get('https://llm.example')
    .intercept({ method: 'POST', path: '/v1/chat/completions' })
    .reply(200, ({ body }) => (capture?.(body as string), { choices: [{ message: { content } }] }), {
      headers: { 'content-type': 'application/json' },
    })
}

describe('enqueueWebMessage', () => {
  it('shows the message and the thinking state before the model is called', async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.enqueueWebMessage('hello')

      expect(agent.state.status).toBe('thinking')
      expect(agent.state.messages).toHaveLength(1)
      expect(agent.state.messages[0]).toMatchObject({ role: 'user', content: 'hello' })
      expect(agent.state.messages[0].id).toBeDefined()
      expect(agent.state.messages[0].at).toBeDefined()

      expect(await takeSchedules(agent, 'processWebMessage')).toHaveLength(1)
    })
  })
})

/** Every other test here calls `processWebMessage` directly, which leaves no schedule row — and
 *  that absence is what hid the bug. These two put the row there first, the way the SDK does. */
describe('the indicator against the row the turn is running from', () => {
  it('clears when the only queued message is the one being answered', async () => {
    const stub = await freshAgent()
    replyOnce('answered')
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.enqueueWebMessage('hello')
      const [scheduled] = (await agent.listSchedules()).filter((s) => s.callback === 'processWebMessage')
      const payload = scheduled.payload as WebMessagePayload

      // The row stays, the way it is when the SDK hands the callback its turn.
      await disarmAlarm(agent)
      await agent.processWebMessage(payload)
      expect(agent.state.status).toBeUndefined()

      await takeSchedules(agent, 'processWebMessage')
    })
  })

  it('keeps it on while a second message is still queued', async () => {
    const stub = await freshAgent()
    replyOnce('first answer')
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.enqueueWebMessage('one')
      await agent.enqueueWebMessage('two')
      const queued = (await agent.listSchedules()).filter((s) => s.callback === 'processWebMessage')
      expect(queued).toHaveLength(2)

      await disarmAlarm(agent)
      await agent.processWebMessage(queued[0].payload as WebMessagePayload)
      // Mutation check: drop the exclusion entirely and this goes undefined — "done" with the
      // second question unanswered.
      expect(agent.state.status).toBe('thinking')

      await takeSchedules(agent, 'processWebMessage')
    })
  })
})

describe('waking up', () => {
  it('clears a thinking indicator whose turn did not survive', async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      // What a lost turn leaves behind: the status the enqueue wrote, and no alarm behind it.
      agent.setState({ ...agent.state, status: 'thinking' })
      await agent.onStart()
      expect(agent.state.status).toBeUndefined()
    })
  })

  it('leaves it alone while the work is still queued', async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.enqueueWebMessage('hello')
      await agent.onStart()
      // Mutation check: drop the `working` guard and this goes undefined — a restart mid-queue
      // would then say "done" with the answer still coming.
      expect(agent.state.status).toBe('thinking')
      await takeSchedules(agent, 'processWebMessage')
    })
  })
})

describe('processWebMessage', () => {
  it('answers into state without duplicating the user turn', async () => {
    const stub = await freshAgent()
    let sent: string | undefined
    replyOnce('hi from web', (body) => {
      sent = body
    })
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.enqueueWebMessage('hello')
      const [scheduled] = await takeSchedules(agent, 'processWebMessage')

      await agent.processWebMessage(scheduled.payload as WebMessagePayload)

      expect(agent.state.messages.map((m) => ({ role: m.role, content: m.content }))).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi from web' },
      ])
      expect(agent.state.messages.every((m) => m.id !== undefined)).toBe(true)
      expect(agent.state.status).toBeUndefined()
    })

    // The turn the enqueue persisted must reach the model exactly once: appending it again for
    // the request is the other half of the double-append trap.
    const request = JSON.parse(sent ?? '{}') as { messages: { role: string; content: string }[] }
    expect(request.messages.filter((m) => m.role === 'user' && m.content === 'hello')).toHaveLength(1)
  })

  it('answers each of two queued messages as its own turn', async () => {
    const stub = await freshAgent()
    const sent: string[] = []
    replyOnce('first answer', (b) => sent.push(b))
    replyOnce('second answer', (b) => sent.push(b))

    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      // Sent while the first is still answering, which is one click away in a real chat.
      await agent.enqueueWebMessage('one')
      await agent.enqueueWebMessage('two')
      const queued = await takeSchedules(agent, 'processWebMessage')
      expect(queued).toHaveLength(2)
      for (const s of queued) {
        await agent.processWebMessage(s.payload as WebMessagePayload)
      }

      expect(agent.state.messages.map((m) => m.content)).toEqual(['one', 'two', 'first answer', 'second answer'])
      // The second turn was still queued when the first ended, so the indicator stayed on.
      expect(agent.state.status).toBeUndefined()
    })

    const prompts = sent.map((body) =>
      (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages
        .slice(1)
        .map((m) => `${m.role}:${m.content}`),
    )
    // Each turn sees its own question last and nothing that was still waiting for a turn of its
    // own. Taking the last message instead of finding it by id gave turn 1 "one" twice and turn 2
    // "two" as an assistant line — a conversation neither party had.
    expect(prompts[0]).toEqual(['user:one'])
    // Rebuilt in the order it happened, not the order it is stored in: the answer to "one" landed
    // after "two" was already queued.
    expect(prompts[1]).toEqual(['user:one', 'assistant:first answer', 'user:two'])
  })

  it('answers an alarm queued before the payload carried an id', async () => {
    const stub = await freshAgent()
    replyOnce('answered', () => {})

    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.enqueueWebMessage('hello')
      await takeSchedules(agent, 'processWebMessage')

      // The shape the old code scheduled. A deploy does not stop those alarms from firing, and
      // without the fallback this turn would persist the user's message a second time.
      await agent.processWebMessage({ text: 'hello' } as WebMessagePayload)

      expect(agent.state.messages.map((m) => `${m.role}:${m.content}`)).toEqual(['user:hello', 'assistant:answered'])
    })
  })

  it('clears the thinking state and notices into state when the model fails', async () => {
    const stub = await freshAgent()
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(500, { message: 'boom' }, { headers: { 'content-type': 'application/json' } })
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.enqueueWebMessage('hello')
      const [scheduled] = await takeSchedules(agent, 'processWebMessage')

      await agent.processWebMessage(scheduled.payload as WebMessagePayload)
      // Cleared *before* the notice: a client left on "thinking" would wait for an answer the
      // notice has already said is not coming.
      expect(agent.state.status).toBeUndefined()

      expect(agent.state.messages.at(-1)).toMatchObject({ role: 'assistant' })
      expect(agent.state.messages.at(-1)?.content).toContain('Sorry')
    })
  })
})

describe('setModel', () => {
  it('records the override and takes null back to the deployment default', async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.setModel('x')
      expect(agent.state.modelOverride).toBe('x')
      // The picker's way back to the deployment's own model, which it must always offer.
      await agent.setModel(null)
      expect(agent.state.modelOverride).toBeUndefined()
    })
  })

  it('leaves a slash word to the turn, since the only one left names a skill', async () => {
    const stub = await freshAgent()
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.enqueueWebMessage('/what-is-the-weather')

      expect(agent.state.messages.map((m) => m.content)).toEqual(['/what-is-the-weather'])
      expect(agent.state.status).toBe('thinking')
      expect(await takeSchedules(agent, 'processWebMessage')).toHaveLength(1)
    })
  })
})
