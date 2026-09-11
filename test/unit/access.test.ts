import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '@/index'
import type { Env } from '@/types'

afterEach(() => vi.restoreAllMocks())

/** `/api/threads` rather than a made-up path: the gate has to sit in front of a route that answers,
 *  or a 503 would prove nothing about whether it was the gate that produced it. */
async function get(opts: { environment: string; behindAccess?: boolean; allowUnprotected?: string }) {
  const logged: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line: string) => void logged.push(line))
  const ctx = createExecutionContext()
  const res = await worker.fetch(
    new Request('http://agent/api/threads', {
      headers: opts.behindAccess ? { 'cf-access-jwt-assertion': 'a.b.c' } : {},
    }),
    { ...(env as Env), ENVIRONMENT: opts.environment, ALLOW_UNPROTECTED: opts.allowUnprotected },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return { status: res.status, body: await res.text(), logged }
}

describe('the Access gate', () => {
  it('refuses a production request that did not come through Access', async () => {
    const { status, body, logged } = await get({ environment: 'production' })
    expect(status).toBe(503)
    // The refusal says what to do: a bare 503 on a fresh deploy reads as a broken Worker.
    expect(body).toMatch(/Zero Trust/)
    expect(logged.map((l) => JSON.parse(l) as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({ at: 'access', stage: 'refused' }),
    )
  })

  it('serves a request Access forwarded', async () => {
    const { status } = await get({ environment: 'production', behindAccess: true })
    expect(status).toBe(200)
  })

  it('serves an explicit opt-out, and says so every time', async () => {
    const { status, logged } = await get({ environment: 'production', allowUnprotected: 'true' })
    expect(status).toBe(200)
    expect(logged.map((l) => JSON.parse(l) as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({ at: 'access', stage: 'unprotected', allowed: true }),
    )
  })

  it('opts out only on the exact word, so a typo fails closed', async () => {
    // `'1'`, `'yes'` and `'TRUE'` all mean someone tried and did not manage it. Closed is the
    // answer that tells them, and the one that cannot leak while they work it out.
    expect((await get({ environment: 'production', allowUnprotected: '1' })).status).toBe(503)
  })

  // Local development has no Access and never will; refusing there would make the gate the first
  // thing every contributor turns off.
  it('stays out of the way on localhost', async () => {
    expect((await get({ environment: 'localhost' })).status).toBe(200)
  })

  it('treats any other environment as a deployment, so a typo fails closed', async () => {
    // Mutation check: gate on `!== 'production'` instead of `=== 'localhost'` and this serves.
    expect((await get({ environment: 'staging' })).status).toBe(503)
  })
})
