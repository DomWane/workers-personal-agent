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
    const out = await summarizeHead(client, 'z-ai/glm-5.2', 'Earlier: Sam booked flights.', MESSAGES, [])

    expect(out).toBe('Sam is planning Vienna and booked flights.')
    const prompt = (sent!.messages as { content: string }[])[0].content
    expect(prompt).toContain('Earlier: Sam booked flights.')
    expect(prompt).toContain('User: plan my trip to Vienna')
  })

  it('shows the model the turns that stay, marked as context rather than material', async () => {
    // A summary written from the head alone put "research proposed, the user has not responded"
    // over the very message that filed the finished report, twice: the finish was in the tail.
    // Mutation checks: drop the `kept` block and the tail is absent; drop the sentence and the
    // model is free to fold the tail in, which the surface then repeats verbatim.
    let sent: Record<string, unknown> | undefined
    mockSummary('Summary.', (b) => {
      sent = b
    })
    const client = createLlmClient('k', `${LLM_BASE}/v1`)
    const kept: HistoryMessage[] = [{ role: 'assistant', content: 'Research on Vienna — done.', id: 'm3' }]
    await summarizeHead(client, 'z-ai/glm-5.2', undefined, MESSAGES, kept)
    const prompt = (sent!.messages as { content: string }[])[0].content
    expect(prompt.indexOf('Research on Vienna — done.')).toBeGreaterThan(prompt.indexOf('keeps verbatim'))
    expect(prompt).toMatch(/Do not summarize them/)
    expect(prompt).toMatch(/Call nothing pending, unanswered or open/)
    // The invitation that produced it: "open follow-ups" in the ask.
    expect(prompt).not.toMatch(/follow-ups|still open/)
  })

  it('says nothing about a tail when a forced pass left none', async () => {
    let sent: Record<string, unknown> | undefined
    mockSummary('Summary.', (b) => {
      sent = b
    })
    const client = createLlmClient('k', `${LLM_BASE}/v1`)
    await summarizeHead(client, 'z-ai/glm-5.2', undefined, MESSAGES, [])
    expect((sent!.messages as { content: string }[])[0].content).not.toMatch(/keeps verbatim/)
  })

  it('says there is no summary yet on the first compaction', async () => {
    let sent: Record<string, unknown> | undefined
    mockSummary('First summary.', (b) => {
      sent = b
    })
    const client = createLlmClient('k', `${LLM_BASE}/v1`)
    await summarizeHead(client, 'z-ai/glm-5.2', undefined, MESSAGES, [])
    expect((sent!.messages as { content: string }[])[0].content).toContain('no existing summary yet')
  })
})
