import { fileURLToPath, URL } from 'node:url'
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'
import { defaultExclude } from 'vitest/config'

export default defineWorkersConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // evals/ has its own vitest.evals.config.ts: eval code uses fs/process, which the
    // Workers pool does not provide, so those tests must never run in this pool.
    // internal/ is gitignored local material with the same shape; a clean clone has none.
    exclude: [...defaultExclude, 'evals/**', 'internal/**'],
    poolOptions: {
      workers: {
        singleWorker: true,
        // The `ai` binding has no local sim; without this the pool opens a
        // credentialed remote proxy at startup and fails without CF creds.
        remoteBindings: false,
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            LLM_API_KEY: 'test-key',
            // Pin the LLM endpoint/model here so the suite is independent of the
            // provider chosen in wrangler.jsonc vars (mocks target this base URL).
            LLM_BASE_URL: 'https://llm.example/v1',
            LLM_MODEL: 'test-model',
            // Distinct from LLM_MODEL on purpose: it is the only way to tell a scout's call from a
            // round's on the wire, and the two are supposed to be separately configurable.
            SCOUT_MODEL: 'test-scout-model',
            ENVIRONMENT: 'localhost',
            // Pinned off: wrangler.jsonc opts this deployment in, and a suite that inherited it
            // would assert content logging is off while the binding said otherwise.
            LOG_CONTENT: '',
            FIRECRAWL_API_KEY: 'test-fc-key',
            CF_API_TOKEN: 'test-cf-token',
            VAULT_AGENT_DIR: 'agent',
            CF_ACCOUNT_ID: 'test-account',
          },
        },
      },
    },
  },
})
