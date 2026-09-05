import { fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chatCompletion, chatCompletionWithTools, createLlmClient } from '../../src/connectors/llm.connector'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

const BASE = 'https://llm.example'

describe('chatCompletion', () => {
  it('sends model/messages without template kwargs by default and returns trimmed content', async () => {
    let sent: Record<string, unknown> | undefined
    fetchMock
      .get(BASE)
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        ({ body }) => {
          sent = JSON.parse(body as string)
          return { choices: [{ message: { content: '  Hello!  ' } }] }
        },
        { headers: { 'content-type': 'application/json' } },
      )

    const client = createLlmClient('test-key', `${BASE}/v1`)
    const reply = await chatCompletion(client, 'moonshotai/kimi-k2.6', [{ role: 'user', content: 'hi' }])

    expect(reply).toBe('Hello!')
    expect(sent).toMatchObject({
      model: 'moonshotai/kimi-k2.6',
      messages: [{ role: 'user', content: 'hi' }],
    })
    // kimi-k2.6 500s when chat_template_kwargs is present — must be omitted unless asked for
    expect(sent).not.toHaveProperty('chat_template_kwargs')
  })

  it('never sends provider-specific template kwargs, whatever the model', async () => {
    let sent: Record<string, unknown> | undefined
    fetchMock
      .get(BASE)
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        ({ body }) => {
          sent = JSON.parse(body as string)
          return { choices: [{ message: { content: 'ok' } }] }
        },
        { headers: { 'content-type': 'application/json' } },
      )

    const client = createLlmClient('test-key', `${BASE}/v1`)
    // Model families that once triggered the kwarg must no longer do so: routed through
    // OpenRouter it reaches upstreams that mishandle the unknown parameter.
    await chatCompletion(client, 'z-ai/glm-5.2', [{ role: 'user', content: 'hi' }])

    expect(sent).not.toHaveProperty('chat_template_kwargs')
    expect(sent).toMatchObject({ model: 'z-ai/glm-5.2', temperature: 0.6, top_p: 0.95 })
  })

  it('returns empty string when the response has no content', async () => {
    fetchMock
      .get(BASE)
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(200, { choices: [] }, { headers: { 'content-type': 'application/json' } })

    const client = createLlmClient('test-key', `${BASE}/v1`)
    await expect(chatCompletion(client, 'moonshotai/kimi-k2.6', [{ role: 'user', content: 'hi' }])).resolves.toBe('')
  })

  it('propagates API errors', async () => {
    fetchMock
      .get(BASE)
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(429, { error: 'rate limited' }, { headers: { 'content-type': 'application/json' } })

    const client = createLlmClient('test-key', `${BASE}/v1`)
    await expect(chatCompletion(client, 'moonshotai/kimi-k2.6', [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /429/,
    )
  })
})

describe('chatCompletionWithTools', () => {
  const TOOLS = [{ type: 'function', function: { name: 'web_search', description: 'd', parameters: {} } }]

  it('sends tools + tool_choice and returns tool calls', async () => {
    let sent: Record<string, unknown> | undefined
    fetchMock
      .get(BASE)
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        ({ body }) => {
          sent = JSON.parse(body as string)
          return {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    { id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } },
                  ],
                },
              },
            ],
          }
        },
        { headers: { 'content-type': 'application/json' } },
      )

    const client = createLlmClient('k', `${BASE}/v1`)
    const out = await chatCompletionWithTools(client, 'z-ai/glm-5.2', [{ role: 'user', content: 'hi' }], TOOLS)
    expect(out.toolCalls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } },
    ])
    expect(out.content).toBe('')
    expect(sent).toMatchObject({ tools: TOOLS, tool_choice: 'auto' })
    expect(sent).not.toHaveProperty('chat_template_kwargs')
  })

  it('honors toolChoice none and returns plain content', async () => {
    let sent: Record<string, unknown> | undefined
    fetchMock
      .get(BASE)
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        ({ body }) => ((sent = JSON.parse(body as string)), { choices: [{ message: { content: 'final answer' } }] }),
        { headers: { 'content-type': 'application/json' } },
      )
    const client = createLlmClient('k', `${BASE}/v1`)
    const out = await chatCompletionWithTools(client, 'z-ai/glm-5.2', [{ role: 'user', content: 'hi' }], TOOLS, {
      toolChoice: 'none',
    })
    expect(out).toEqual({ content: 'final answer', toolCalls: [] })
    expect(sent).toMatchObject({ tool_choice: 'none' })
  })

  it('surfaces finish_reason, provider and all three token counts', async () => {
    fetchMock
      .get(BASE)
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        {
          provider: 'Alibaba',
          usage: { prompt_tokens: 1840, completion_tokens: 96, completion_tokens_details: { reasoning_tokens: 210 } },
          choices: [{ finish_reason: 'length', message: { content: 'cut off mid-sen' } }],
        },
        { headers: { 'content-type': 'application/json' } },
      )
    const client = createLlmClient('k', `${BASE}/v1`)
    const out = await chatCompletionWithTools(
      client,
      'deepseek/deepseek-v4-flash',
      [{ role: 'user', content: 'hi' }],
      TOOLS,
    )
    expect(out).toMatchObject({
      finishReason: 'length',
      provider: 'Alibaba',
      usage: { inputTokens: 1840, outputTokens: 96, reasoningTokens: 210 },
    })
  })

  it('omits usage entirely when the provider reports none', async () => {
    fetchMock
      .get(BASE)
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(200, { choices: [{ message: { content: 'hi' } }] }, { headers: { 'content-type': 'application/json' } })
    const client = createLlmClient('k', `${BASE}/v1`)
    const out = await chatCompletionWithTools(client, 'm', [{ role: 'user', content: 'hi' }], TOOLS)
    // Absent, not zero-filled: a silent provider and a free call must not average together.
    expect('usage' in out).toBe(false)
  })

  it('keeps a partial usage block rather than dropping the counts it did get', async () => {
    fetchMock
      .get(BASE)
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(
        200,
        { usage: { prompt_tokens: 12 }, choices: [{ message: { content: 'hi' } }] },
        { headers: { 'content-type': 'application/json' } },
      )
    const client = createLlmClient('k', `${BASE}/v1`)
    const out = await chatCompletionWithTools(client, 'm', [{ role: 'user', content: 'hi' }], TOOLS)
    expect(out.usage).toEqual({ inputTokens: 12, outputTokens: undefined, reasoningTokens: undefined })
  })

  it('leaves diagnostics undefined when the provider omits them', async () => {
    fetchMock
      .get(BASE)
      .intercept({ method: 'POST', path: '/v1/chat/completions' })
      .reply(200, { choices: [{ message: { content: 'ok' } }] }, { headers: { 'content-type': 'application/json' } })
    const client = createLlmClient('k', `${BASE}/v1`)
    const out = await chatCompletionWithTools(client, 'z-ai/glm-5.2', [{ role: 'user', content: 'hi' }], TOOLS)
    expect(out.finishReason).toBeUndefined()
    expect(out.provider).toBeUndefined()
    expect(out.content).toBe('ok')
  })
})
