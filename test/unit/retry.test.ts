import { describe, expect, it, vi } from 'vitest'
import { retryOnce } from '../../src/agent/retry'

describe('retryOnce', () => {
  it('does not retry work that succeeded', async () => {
    const work = vi.fn(() => 'ok')
    const onRetry = vi.fn()

    await expect(retryOnce(work, onRetry)).resolves.toBe('ok')
    expect(work).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('survives a failure that does not repeat', async () => {
    // A `SqlError: internal error` out of setState threw away a whole wave on 2026-08-10 — four
    // scouts and 57 subrequests — because the round's only durable write was that one call.
    let attempts = 0
    const work = vi.fn(() => {
      if (attempts++ === 0) {
        throw new Error('SQL query failed: internal error')
      }
      return 'saved'
    })

    await expect(retryOnce(work)).resolves.toBe('saved')
    expect(work).toHaveBeenCalledTimes(2)
  })

  it('says out loud that the first attempt failed', async () => {
    // A retry that succeeds silently hides the fault it survived, and the fault is the thing worth
    // knowing about.
    let attempts = 0
    const seen: unknown[] = []

    await retryOnce(
      () => {
        if (attempts++ === 0) {
          throw new Error('transient')
        }
        return 1
      },
      (err) => void seen.push(err),
    )

    expect(seen).toHaveLength(1)
    expect(String(seen[0])).toContain('transient')
  })

  it('rethrows when the second attempt fails too, rather than pretending it saved', async () => {
    const work = vi.fn(() => {
      throw new Error('broken for good')
    })

    await expect(retryOnce(work)).rejects.toThrow('broken for good')
    // Two attempts, not three: a third only delays the report of a fault that is not transient.
    expect(work).toHaveBeenCalledTimes(2)
  })

  it('awaits async work rather than treating the promise as the result', async () => {
    let attempts = 0
    const out = await retryOnce(async () => {
      if (attempts++ === 0) {
        throw new Error('transient')
      }
      return 'async ok'
    })
    expect(out).toBe('async ok')
  })
})
