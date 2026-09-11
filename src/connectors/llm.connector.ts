import OpenAI from 'openai'
import type { ChatMessage, ToolCall } from '@/types'

export function createLlmClient(apiKey: string, baseURL: string, doFetch?: typeof globalThis.fetch): OpenAI {
  return new OpenAI({ apiKey, baseURL, maxRetries: 0, ...(doFetch ? { fetch: doFetch } : {}) })
}

export interface ChatOptions {
  maxTokens?: number
  timeoutMs?: number
}

function buildBody(
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const { maxTokens = 4096 } = opts
  return {
    model,
    messages,
    temperature: 0.6,
    top_p: 0.95,
    max_tokens: maxTokens,
    ...extra,
  }
}

export async function chatCompletion(
  client: OpenAI,
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  const { timeoutMs = 120_000 } = opts
  const body = buildBody(model, messages, opts)

  const completion = await client.chat.completions.create(body as never, {
    timeout: timeoutMs,
  })

  return (completion as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content?.trim() ?? ''
}

export interface CompletionUsage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}

export interface CompletionResult {
  content: string
  toolCalls: ToolCall[]
  finishReason?: string
  provider?: string
  usage?: CompletionUsage
}

export async function chatCompletionWithTools(
  client: OpenAI,
  model: string,
  messages: ChatMessage[],
  tools: object[],
  opts: ChatOptions & { toolChoice?: 'auto' | 'none' } = {},
): Promise<CompletionResult> {
  const { timeoutMs = 120_000, toolChoice = 'auto' } = opts
  const body = buildBody(model, messages, opts, { tools, tool_choice: toolChoice })

  const completion = await client.chat.completions.create(body as never, { timeout: timeoutMs })
  const raw = completion as {
    provider?: string
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      completion_tokens_details?: { reasoning_tokens?: number }
    }
    choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: ToolCall[] } }[]
  }
  const choice = raw.choices?.[0]
  const usage = raw.usage
  return {
    content: choice?.message?.content?.trim() ?? '',
    toolCalls: choice?.message?.tool_calls ?? [],
    finishReason: choice?.finish_reason,
    provider: raw.provider,
    ...(usage
      ? {
          usage: {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
          },
        }
      : {}),
  }
}
