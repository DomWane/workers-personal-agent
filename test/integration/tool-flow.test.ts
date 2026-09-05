import { env, fetchMock, runInDurableObject } from 'cloudflare:test'
import { getAgentByName } from 'agents'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { PersonalAgent } from '../../src/agent/personal-agent'
import type { Env } from '../../src/types'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

const LLM_BASE = 'https://llm.example'

const freshAgent = (name: string) => getAgentByName((env as Env).PERSONAL_AGENT, `${name}-${crypto.randomUUID()}`)

function queueLlm(msg: Record<string, unknown>) {
  fetchMock
    .get(LLM_BASE)
    .intercept({ method: 'POST', path: '/v1/chat/completions' })
    .reply(200, { choices: [{ message: msg }] }, { headers: { 'content-type': 'application/json' } })
}

/** Every path here ends in broadcast state, so the assistant's last word is the assertion. */
const lastReply = (agent: PersonalAgent) => agent.state.messages.at(-1)?.content ?? ''

describe('tool flow end to end', () => {
  it('web message → tool_calls web_search → search vendor → final answer in state', async () => {
    queueLlm({
      content: null,
      tool_calls: [
        { id: 't1', type: 'function', function: { name: 'web_search', arguments: '{"query":"cf agents sdk"}' } },
      ],
    })
    fetchMock
      .get('https://api.firecrawl.dev')
      .intercept({ method: 'POST', path: '/v2/search' })
      .reply(
        200,
        {
          success: true,
          data: { web: [{ url: 'https://developers.cloudflare.com/agents/', title: 'Agents', description: 'docs' }] },
        },
        { headers: { 'content-type': 'application/json' } },
      )
    queueLlm({ content: 'Found it: the Agents SDK docs. Checked: web_search' })

    const stub = await freshAgent('tool-flow')
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.processWebMessage({ text: 'find the cf agents sdk docs' })
      expect(lastReply(agent)).toContain('Found it')
    })
  })

  it('fireReminder puts the reminder text in the thread', async () => {
    const stub = await freshAgent('reminder')
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.fireReminder({ text: 'stand up' })
      expect(lastReply(agent)).toBe('⏰ stand up')
    })
  })

  it('runTask puts the completion text in the thread on success', async () => {
    queueLlm({ content: 'daily digest ready' })
    const stub = await freshAgent('runtask-success')
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.runTask({ prompt: 'do the digest' })
      expect(lastReply(agent)).toBe('daily digest ready')
    })
  })

  it('runTask puts a failure notice in the thread when the model call errors', async () => {
    fetchMock
      .get(LLM_BASE)
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(500, { error: 'boom' }, { headers: { 'content-type': 'application/json' } })

    const stub = await freshAgent('runtask-failure')
    await runInDurableObject(stub, async (agent: PersonalAgent) => {
      await agent.runTask({ prompt: 'do the digest' })
      // A scheduled task nobody watched run has only this line to say it failed.
      expect(lastReply(agent)).toContain('⚠️ Scheduled task failed')
    })
  })
})
