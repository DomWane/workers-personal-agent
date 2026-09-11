import { describe, expect, it } from 'vitest'
import { llmConfig } from '@/agent/llm-config'
import type { Env } from '@/types'

function makeEnv(over: Partial<Env>): Env {
  return { CF_ACCOUNT_ID: 'acct-1', CF_API_TOKEN: 'cf-token', ...over } as Env
}

describe('llmConfig', () => {
  it('uses an explicit base URL and its OpenAI-convention catalogue', () => {
    const cfg = llmConfig(makeEnv({ LLM_BASE_URL: 'https://openrouter.ai/api/v1', LLM_API_KEY: 'or-key' }))
    expect(cfg).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'or-key',
      catalogueUrl: 'https://openrouter.ai/api/v1/models',
      catalogue: 'openai',
    })
  })

  it('strips a trailing slash rather than producing //models', () => {
    const cfg = llmConfig(makeEnv({ LLM_BASE_URL: 'https://llm.example/v1/', LLM_API_KEY: 'k' }))
    expect(cfg.baseUrl).toBe('https://llm.example/v1')
    expect(cfg.catalogueUrl).toBe('https://llm.example/v1/models')
  })

  it('derives Cloudflare when no base URL is set', () => {
    const cfg = llmConfig(makeEnv({}))
    expect(cfg.baseUrl).toBe('https://api.cloudflare.com/client/v4/accounts/acct-1/ai/v1')
    expect(cfg.catalogue).toBe('cloudflare')
    // Not `${baseUrl}/models`: that path answers 405 on Cloudflare.
    expect(cfg.catalogueUrl).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-1/ai/models/search?task=Text%20Generation&per_page=100',
    )
  })

  it('authenticates the Cloudflare default with CF_API_TOKEN even when LLM_API_KEY is set', () => {
    // A key left over from another provider must not reach Cloudflare: it answers 401 with no body.
    expect(llmConfig(makeEnv({})).apiKey).toBe('cf-token')
    expect(llmConfig(makeEnv({ LLM_API_KEY: 'leftover' })).apiKey).toBe('cf-token')
  })
})
