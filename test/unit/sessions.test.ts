import { fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { summarizeHead } from '../../src/agent/sessions'
import { createLlmClient } from '../../src/connectors/llm.connector'
import type { HistoryMessage } from '../../src/types'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

const LLM_BASE = 'https://llm.example'

const MESSAGES: HistoryMessage[] = [
  { role: 'user', content: 'plan my trip to Vienna', id: 'm1' },
  { role: 'assistant', content: 'Here is a plan...', id: 'm2' },
]

function mockSummary(reply: string, capture?: (b: Record<string, unknown>) => void) {
  fetchMock
    .get(LLM_BASE)
    .intercept({ method: 'POST', path: '/v1/chat/completions' })
    .reply(
      200,
      ({ body }) => {
        capture?.(JSON.parse(body as string))
        return { choices: [{ message: { content: reply } }] }
      },
      { headers: { 'content-type': 'application/json' } },
    )
}

describe('summarizeHead', () => {
  it('merges an existing summary with the evicted turns', async () => {
    let sent: Record<string, unknown> | undefined
    mockSummary('  Sam is planning Vienna and booked flights.  ', (b) => {
      sent = b
    })
    const client = createLlmClient('k', `${LLM_BASE}/v1`)
    const out = await summarizeHead(client, 'z-ai/glm-5.2', 'Earlier: Sam booked flights.', MESSAGES)

    expect(out).toBe('Sam is planning Vienna and booked flights.')
    const prompt = (sent!.messages as { content: string }[])[0].content
    expect(prompt).toContain('Earlier: Sam booked flights.')
    expect(prompt).toContain('User: plan my trip to Vienna')
  })

  it('says there is no summary yet on the first compaction', async () => {
    let sent: Record<string, unknown> | undefined
    mockSummary('First summary.', (b) => {
      sent = b
    })
    const client = createLlmClient('k', `${LLM_BASE}/v1`)
    await summarizeHead(client, 'z-ai/glm-5.2', undefined, MESSAGES)
    expect((sent!.messages as { content: string }[])[0].content).toContain('no existing summary yet')
  })
})
