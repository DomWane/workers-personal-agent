import { describe, expect, it } from 'vitest'
import {
  compactAt,
  compactKeep,
  fitHead,
  historyTokens,
  isContextOverflow,
  planCompaction,
  resultCap,
} from '../../src/agent/loop/context-window'
import type { HistoryMessage } from '../../src/types'

/** 30 chars ≈ 10 tokens at the fallback rate, so a count of messages is a count of tokens × 10. */
function messages(n: number): HistoryMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `${i}`.padEnd(30, '.'),
    id: `m${i}`,
  }))
}

describe('thresholds', () => {
  it('reads as fractions of the model window, not as message counts', () => {
    expect(compactAt(24_000)).toBe(19_200)
    expect(compactKeep(131_072)).toBe(32_768)
  })

  it('counts the running summary too — it rides in every prompt', () => {
    expect(historyTokens(messages(2))).toBe(20)
    expect(historyTokens(messages(2), 'x'.repeat(300))).toBe(120)
  })
})

describe('planCompaction', () => {
  it('evicts everything the budget cannot keep', () => {
    // 30 tokens of tail is three messages of ten; the other seven go.
    expect(planCompaction(messages(10), 30).map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'])
  })

  it('keeps the last exchange even when it alone exceeds the budget', () => {
    expect(planCompaction(messages(6), 1).map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3'])
  })

  it('evicts nothing when the whole history fits', () => {
    expect(planCompaction(messages(3), 1000)).toEqual([])
  })
})

describe('fitHead', () => {
  it('summarizes what one call can read and leaves the rest unsummarized', () => {
    const { summarize, unsummarized } = fitHead(messages(10), 30)
    // The newest evicted turns are the ones folded: the running summary already covers what came
    // before, so the gap this leaves is the one furthest from the live conversation.
    expect(summarize.map((m) => m.id)).toEqual(['m7', 'm8', 'm9'])
    expect(unsummarized).toHaveLength(7)
  })

  it('always summarizes at least one turn', () => {
    const { summarize, unsummarized } = fitHead(messages(4), 1)
    expect(summarize.map((m) => m.id)).toEqual(['m3'])
    expect(unsummarized).toHaveLength(3)
  })

  it('summarizes everything when it fits', () => {
    expect(fitHead(messages(3), 1000).unsummarized).toEqual([])
  })
})

describe('resultCap', () => {
  it('lets a tool keep its own cap where the window is wide enough', () => {
    // 1.31M is the deployment default, measured from `/api/models`. A tenth of it in characters is
    // 393,000, so `read_page`'s 100,000 is what binds — which is the point of having both.
    expect(resultCap(100_000, 1_310_720)).toBe(100_000)
  })

  it('cuts to a share of the window on the picker low end', () => {
    // 24k is the smallest window this deployment has seen. Without this a single page is 33k tokens
    // against a 24k window: the request is refused, and in a scout that loses the whole angle.
    expect(resultCap(100_000, 24_000)).toBe(7_200)
  })

  it('treats an unknown window as unknown, not as small', () => {
    // Mutation check: substitute `DEFAULT_CONTEXT_TOKENS` here and every first page read on the
    // default model drops to 7,200 characters until something asks the catalogue.
    expect(resultCap(100_000, undefined)).toBe(100_000)
  })
})

describe('a tool-call group is never cut in half', () => {
  /**
   * Sized so the boundary lands *between* the assistant and its `tool` reply, which is the only
   * arrangement that can fail. A budget that merely evicts is not enough: at 25 the walk already
   * stops on the assistant, and the test then passes against the broken version too.
   *
   * Costs walking backwards: `a2` 10, `t1` 10, `a1` 4 (empty content, 11 chars of call). A budget
   * of 22 pays the first two and refuses the third, which stops the walk exactly on `t1`.
   */
  const group: HistoryMessage[] = [
    { role: 'user', content: 'q'.padEnd(30, '.'), id: 'u1' },
    {
      role: 'assistant',
      content: '',
      id: 'a1',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_page', arguments: '{}' } }],
    },
    { role: 'tool', content: 'r'.padEnd(30, '.'), id: 't1', tool_call_id: 'call_1' },
    { role: 'assistant', content: 'a'.padEnd(30, '.'), id: 'a2' },
  ]

  it('moves the boundary back onto the assistant that made the call', () => {
    const evicted = planCompaction(group, 22)

    // Without the retreat this is ['u1', 'a1'] and the kept tail starts at `t1` — an answer whose
    // question was evicted. An unmatched `tool_call_id` is a 400 on the next request, and because
    // the orphan stays in state the thread is then dead rather than degraded.
    //
    // Mutation check: return `first` unconditionally from `ownedGroupStart` and this is
    // ['u1', 'a1'].
    expect(evicted.map((m) => m.id)).toEqual(['u1'])
  })

  it('counts an assistant that only called tools, rather than pricing it at zero', () => {
    // `content` is empty, so counting it alone would say this message is free and let the surface
    // drift past the threshold with nothing noticing.
    expect(historyTokens([group[1]])).toBeGreaterThan(0)
  })
})

describe('isContextOverflow', () => {
  it('recognises the wordings the OpenAI-compatible vendors use', () => {
    expect(isContextOverflow(new Error('400 maximum context length is 8192 tokens'))).toBe(true)
    expect(isContextOverflow(new Error("This model's context window is exceeded"))).toBe(true)
    expect(isContextOverflow(new Error('prompt is too long: 210000 tokens'))).toBe(true)
  })

  it('does not swallow ordinary failures', () => {
    expect(isContextOverflow(new Error('500 upstream error'))).toBe(false)
    expect(isContextOverflow(new Error('rate limit exceeded'))).toBe(false)
  })
})
