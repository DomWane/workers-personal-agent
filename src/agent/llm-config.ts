import type { Env } from '../types'

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  /** Where the model picker reads the catalogue; not always `${baseUrl}/models`. */
  catalogueUrl: string
  catalogue: 'openai' | 'cloudflare'
}

/**
 * Resolves the chat endpoint and its catalogue together, because Cloudflare splits them: it serves
 * OpenAI-compatible chat at `/ai/v1/chat/completions` but has no `/ai/v1/models` (405, "GET not
 * supported") — the catalogue lives at `/ai/models/search`. A second env var could carry that URL,
 * but then a deployment that sets one and not the other is silently wrong.
 */
export function llmConfig(env: Env): LlmConfig {
  const account = env.CF_ACCOUNT_ID
  if (!env.LLM_BASE_URL) {
    return {
      baseUrl: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`,
      // Never LLM_API_KEY here: a key left over from another provider is a 401 from Cloudflare
      // with nothing in the log to say which credential was sent.
      apiKey: env.CF_API_TOKEN,
      catalogueUrl: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/models/search?task=Text%20Generation&per_page=100`,
      catalogue: 'cloudflare',
    }
  }

  const baseUrl = env.LLM_BASE_URL.replace(/\/$/, '')
  return {
    baseUrl,
    apiKey: env.LLM_API_KEY ?? '',
    catalogueUrl: `${baseUrl}/models`,
    catalogue: 'openai',
  }
}
