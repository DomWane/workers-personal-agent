import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FREE_PLAN_SUBREQUESTS, PAID_PLAN_SUBREQUESTS } from '../../src/agent/subrequest-budget'
import { cachedSubrequestLimit, fetchSubrequestLimit } from '../../src/agent/workers-plan'
import type { Env } from '../../src/types'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

const API = 'https://api.cloudflare.com'
const PATH = `/client/v4/accounts/${(env as Env).CF_ACCOUNT_ID}/subscriptions`

function subscriptions(body: string | object, status = 200) {
  fetchMock
    .get(API)
    .intercept({ method: 'GET', path: PATH })
    .reply(status, body, { headers: { 'content-type': 'application/json' } })
}

/** What the account actually returned on 2026-08-27, minus the Workers row. */
const OTHER_PRODUCTS = {
  result: [{ rate_plan: { id: 'r2_paid' } }, { rate_plan: { id: 'teams_free' } }],
}

/** A minimal `DurableObjectStorage` — only the three methods this module uses. */
function fakeStorage() {
  const rows = new Map<string, unknown>()
  return {
    rows,
    get: async (k: string) => rows.get(k),
    put: async (k: string, v: unknown) => void rows.set(k, v),
    delete: async (k: string) => rows.delete(k),
  } as unknown as DurableObjectStorage
}

describe('fetchSubrequestLimit', () => {
  it('finds the Workers row among the account products', async () => {
    subscriptions({ result: [...OTHER_PRODUCTS.result, { rate_plan: { id: 'WORKERS_PAID' } }] })
    // Cloudflare's catalogue documents the id upper case and the account endpoint answers lower;
    // matching either is cheaper than betting on one spelling.
    expect(await fetchSubrequestLimit(env as Env)).toBe(PAID_PLAN_SUBREQUESTS)
  })

  it('reads an account with other paid products but no Workers row as free', async () => {
    subscriptions(OTHER_PRODUCTS)
    expect(await fetchSubrequestLimit(env as Env)).toBe(FREE_PLAN_SUBREQUESTS)
  })

  it('answers null rather than free when the account could not be asked', async () => {
    // The distinction is the point: free and "no idea" both spend 50, but only the first is worth
    // remembering for an hour.
    subscriptions('nope', 403)
    expect(await fetchSubrequestLimit(env as Env)).toBeNull()
  })
})

describe('cachedSubrequestLimit', () => {
  it('asks once and serves the answer from storage after that', async () => {
    const storage = fakeStorage()
    subscriptions({ result: [{ rate_plan: { id: 'workers_paid' } }] })

    expect(await cachedSubrequestLimit(storage, env as Env)).toBe(PAID_PLAN_SUBREQUESTS)
    // No second interceptor is queued, so a second call that reached the network would fail here.
    expect(await cachedSubrequestLimit(storage, env as Env)).toBe(PAID_PLAN_SUBREQUESTS)
  })

  it('asks again once the answer is over an hour old', async () => {
    const storage = fakeStorage()
    await storage.put('workers-plan', { limit: PAID_PLAN_SUBREQUESTS, at: Date.now() - 61 * 60 * 1000 })
    subscriptions(OTHER_PRODUCTS)

    // A downgrade believed for a day would over-spend and die past the platform cap silently.
    expect(await cachedSubrequestLimit(storage, env as Env)).toBe(FREE_PLAN_SUBREQUESTS)
  })

  it('does not store a failed lookup, so the next start asks instead of believing a guess', async () => {
    const storage = fakeStorage()
    subscriptions('nope', 500)

    expect(await cachedSubrequestLimit(storage, env as Env)).toBe(FREE_PLAN_SUBREQUESTS)
    expect(await storage.get('workers-plan')).toBeUndefined()
  })

  it('drops an expired paid answer rather than trusting it through an outage', async () => {
    const storage = fakeStorage()
    await storage.put('workers-plan', { limit: PAID_PLAN_SUBREQUESTS, at: Date.now() - 61 * 60 * 1000 })
    subscriptions('nope', 500)

    // The forgiving choice would hold a downgraded account at 10,000 for as long as the endpoint
    // stays down, and that direction dies past the platform cap without saying anything.
    expect(await cachedSubrequestLimit(storage, env as Env)).toBe(FREE_PLAN_SUBREQUESTS)
  })
})
