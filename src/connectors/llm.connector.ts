import OpenAI from 'openai'
import type { ChatMessage, ToolCall } from '../types'

/**
 * The provider is reached through its OpenAI-compatible endpoint, so we point the
 * `openai` client at a configured base URL. Keeping this behind a tiny connector
 * means swapping providers is a config change, not a code change.
 */
export function createLlmClient(apiKey: string, baseURL: string, doFetch?: typeof globalThis.fetch): OpenAI {
  // maxRetries: 0 — the SDK retries timeouts by default, which multiplies wait time
  // on an already-slow model. We handle failures ourselves and fail fast.
  return new OpenAI({ apiKey, baseURL, maxRetries: 0, ...(doFetch ? { fetch: doFetch } : {}) })
}

export interface ChatOptions {
  maxTokens?: number
  timeoutMs?: number
}

/**
 * Deliberately sends only standard OpenAI fields. An earlier version added NVIDIA's
 * chat_template_kwargs for glm/nemotron families; routed through OpenRouter that reaches
 * arbitrary upstreams, some of which mishandle or reject the unknown parameter.
 */
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

/**
 * Single non-streaming chat completion. Returns the assistant's final text.
 * Reasoning content (if any) is intentionally discarded — never surfaced.
 */
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

/** Token counts as the provider reported them. Absent when the upstream omits `usage`. */
export interface CompletionUsage {
  inputTokens?: number
  outputTokens?: number
  /** Billed as output but not present in the content, so it has to be counted separately. */
  reasoningTokens?: number
}

export interface CompletionResult {
  content: string
  toolCalls: ToolCall[]
  /** Diagnostics only — never used for control flow. */
  finishReason?: string
  /** OpenRouter routes the same model to different upstreams per request; behaviour varies by upstream. */
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
    // Omitted entirely rather than zero-filled: a provider that reports no usage and one that
    // genuinely spent nothing must not average together into the same cost figure.
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
