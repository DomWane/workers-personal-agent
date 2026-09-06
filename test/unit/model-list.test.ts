import { createExecutionContext, env, fetchMock, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import worker from '../../src/index'
import type { Env } from '../../src/types'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

// Called through the module rather than SELF: the pool hands the test a copy of the bindings, so
// mutating `env` does not reach the running Worker, and the Cloudflare branch is precisely the one
// where LLM_BASE_URL is absent while the suite pins it.
async function getModels(over: Partial<Env> = {}) {
  const ctx = createExecutionContext()
  const res = await worker.fetch(new Request('http://agent/api/models'), { ...(env as Env), ...over }, ctx)
  await waitOnExecutionContext(ctx)
  return { status: res.status, body: (await res.json()) as ModelListBody, headers: res.headers }
}

interface ModelListBody {
  current: string
  models: Array<{ id: string; tools: boolean; paid: boolean; context?: number; priceIn?: number; priceOut?: number }>
}

const CLOUDFLARE_PATH = '/client/v4/accounts/test-account/ai/models/search?task=Text%20Generation&per_page=100'

function interceptCloudflare(status: number, body: object) {
  fetchMock
    .get('https://api.cloudflare.com')
    .intercept({ method: 'GET', path: CLOUDFLARE_PATH })
    .reply(status, body, { headers: { 'content-type': 'application/json' } })
}

function cfModel(name: string, props: Record<string, unknown>) {
  return {
    name,
    properties: Object.entries(props).map(([property_id, value]) => ({ property_id, value })),
  }
}

describe('GET /api/models', () => {
  it('flags and orders a Cloudflare catalogue', async () => {
    interceptCloudflare(200, {
      result: [
        cfModel('@cf/vendor/no-tools', { context_window: '8192' }),
        cfModel('@cf/vendor/paid-tools', { function_calling: 'true', require_workers_paid: 'true' }),
        cfModel('@cf/vendor/free-tools', { function_calling: 'true', context_window: '128000' }),
      ],
    })

    const { status, body } = await getModels({ LLM_BASE_URL: undefined })
    expect(status).toBe(200)
    expect(body.current).toBe('test-model')
    expect(body.models).toEqual([
      { id: '@cf/vendor/free-tools', tools: true, paid: false, context: 128000 },
      { id: '@cf/vendor/no-tools', tools: false, paid: false, context: 8192 },
      { id: '@cf/vendor/paid-tools', tools: true, paid: true },
    ])
  })

  it('reads an OpenAI-shaped catalogue from the configured base URL', async () => {
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'GET', path: '/v1/models' })
      .reply(
        200,
        { data: [{ id: 'z/plain' }, { id: 'a/tools', supported_parameters: ['tools'], context_length: 200000 }] },
        { headers: { 'content-type': 'application/json' } },
      )

    const { body } = await getModels()
    expect(body.models).toEqual([
      { id: 'a/tools', tools: true, paid: false, context: 200000 },
      { id: 'z/plain', tools: false, paid: false },
    ])
  })

  it('follows a changed base URL on the next load, and tells the browser not to keep the list', async () => {
    // An hour of cache once outlived a change of LLM_BASE_URL: the picker kept the old provider's
    // models and the switch read as broken. Mutation check: put `max-age` back and the header
    // assertion fails; cache by request again (both calls are the same URL) and the second
    // interceptor stays pending.
    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'GET', path: '/v1/models' })
      .reply(200, { data: [{ id: 'first/provider' }] }, { headers: { 'content-type': 'application/json' } })
    fetchMock
      .get('https://other.example')
      .intercept({ method: 'GET', path: '/v1/models' })
      .reply(200, { data: [{ id: 'second/provider' }] }, { headers: { 'content-type': 'application/json' } })

    const before = await getModels()
    const after = await getModels({ LLM_BASE_URL: 'https://other.example/v1' })

    expect(before.headers.get('cache-control')).toBe('no-store')
    expect(before.body.models.map((m) => m.id)).toEqual(['first/provider'])
    expect(after.body.models.map((m) => m.id)).toEqual(['second/provider'])
  })

  it('normalises both catalogues to dollars per million tokens', async () => {
    // The two vendors publish the same fact in different units — Cloudflare already per million,
    // OpenRouter per token — so a picker that showed them raw would be off by a factor of a million.
    interceptCloudflare(200, {
      result: [
        cfModel('@cf/vendor/priced', {
          function_calling: 'true',
          price: [
            { unit: 'per M input tokens', price: 0.0605 },
            { unit: 'per M output tokens', price: 0.4 },
          ],
        }),
      ],
    })
    const cf = await getModels({ LLM_BASE_URL: undefined })
    expect(cf.body.models[0]).toMatchObject({ priceIn: 0.0605, priceOut: 0.4 })

    fetchMock
      .get('https://llm.example')
      .intercept({ method: 'GET', path: '/v1/models' })
      .reply(
        200,
        { data: [{ id: 'a/priced', pricing: { prompt: '0.000000079996', completion: '0.000000252' } }] },
        { headers: { 'content-type': 'application/json' } },
      )
    const openai = await getModels()
    expect(openai.body.models[0].priceIn).toBeCloseTo(0.08, 2)
    expect(openai.body.models[0].priceOut).toBeCloseTo(0.252, 3)
  })

  it('still names the current model when the catalogue fails', async () => {
    interceptCloudflare(500, { errors: [{ message: 'boom' }] })

    const { status, body } = await getModels({ LLM_BASE_URL: undefined })
    expect(status).toBe(200)
    expect(body).toEqual({ current: 'test-model', models: [] })
  })
})
