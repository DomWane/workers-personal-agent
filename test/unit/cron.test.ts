import { env, fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { runNightly } from '../../src/index'
import type { Env } from '../../src/types'

const testEnv = env as Env

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

/**
 * The maintenance namespace is faked rather than driven for real: the two instances are named
 * constants, so they outlive the pool's isolated-storage stack and every real call from here
 * fails teardown. What is under test is the cron's own branching, which needs no storage.
 */
function fakeMaintenance(behaviour: {
  reconcile?: () => Promise<{ remaining: number }>
  reflect?: () => Promise<void>
}) {
  const calls: string[] = []
  const namespace = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      reconcile: async () => {
        calls.push(`reconcile:${name}`)
        return (await behaviour.reconcile?.()) ?? { remaining: 0 }
      },
      reflect: async () => {
        calls.push(`reflect:${name}`)
        await behaviour.reflect?.()
      },
    }),
  }
  return { calls, env: { ...testEnv, MAINTENANCE: namespace } as unknown as Env }
}

describe('the nightly run', () => {
  it('reconciles on the index instance and reflects on the reflection one', async () => {
    const { calls, env: fake } = fakeMaintenance({})
    await runNightly(fake)
    // Two names, not one: a four-minute reflection must not hold the instance every
    // search_memory enters.
    expect(calls).toEqual(['reconcile:index', 'reflect:reflection'])
  })

  it('keeps calling reconcile while a slice leaves work behind', async () => {
    let left = 2
    const { calls, env: fake } = fakeMaintenance({
      reconcile: async () => ({ remaining: left-- > 0 ? 1 : 0 }),
    })
    await runNightly(fake)
    expect(calls.filter((c) => c.startsWith('reconcile'))).toHaveLength(3)
  })

  it('stops chaining rather than spinning when the vault never converges', async () => {
    const { calls, env: fake } = fakeMaintenance({ reconcile: async () => ({ remaining: 1 }) })
    await runNightly(fake)
    expect(calls.filter((c) => c.startsWith('reconcile'))).toHaveLength(10)
  })

  it('logs a failed reflection rather than letting the cron end silently', async () => {
    // Nothing is delivered at 04:00 — no client is connected — so the log is the whole report, and
    // a nightly failure that left no line would be invisible until someone noticed stale memory.
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
    const { env: fake } = fakeMaintenance({
      reflect: async () => {
        throw new Error('boom')
      },
    })
    try {
      await runNightly(fake)
    } finally {
      spy.mockRestore()
    }
    const record = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r.at === 'reflection' && r.stage === 'notify')
    expect(String(record?.error)).toContain('boom')
  })
})
