import type { Env } from '@/types'

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  catalogueUrl: string
  catalogue: 'openai' | 'cloudflare'
}

export function llmConfig(env: Env): LlmConfig {
  const account = env.CF_ACCOUNT_ID
  if (!env.LLM_BASE_URL) {
    return {
      baseUrl: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`,
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
