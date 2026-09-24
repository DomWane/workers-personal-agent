import { afterEach, describe, expect, it, vi } from 'vitest'
import { throttle } from '@/agent/throttle'

describe('throttle', () => {
  afterEach(() => vi.useRealTimers())

  it('delivers the latest value once per window, window after window', () => {
    vi.useFakeTimers()
    const seen: string[] = []
    const draft = throttle<string>(250, (v) => seen.push(v))

    draft.push('a')
    draft.push('ab')
    expect(seen).toEqual([])
    vi.advanceTimersByTime(250)
    expect(seen).toEqual(['ab'])

    draft.push('abc')
    vi.advanceTimersByTime(250)
    expect(seen).toEqual(['ab', 'abc'])
  })

  it('delivers nothing after cancel, even with a value pending', () => {
    vi.useFakeTimers()
    const seen: string[] = []
    const draft = throttle<string>(250, (v) => seen.push(v))

    draft.push('a')
    draft.cancel()
    vi.advanceTimersByTime(1000)
    expect(seen).toEqual([])
  })
})
