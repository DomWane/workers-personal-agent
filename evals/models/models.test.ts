import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildPrompt,
  doneKeys,
  reasoningTextOf,
  reasoningTokensOf,
  runKey,
  separateTrace,
  splitThinking,
  type Run,
} from './compare.ts'
import { buildPairs } from './judge.ts'
import { cohenKappa, collapseOrders } from './judge-agreement.ts'

const chunk = (id: string, text: string) => ({ id, text, session: 's', ts: '2026-07-01T00:00:00Z', project: 'p' })
const run = (query: string, model: string): Run => ({
  query,
  model,
  answer: `odpověď od ${model}`,
  reasoningTokens: 1,
  reasoningChars: 10,
  completionTokens: 2,
  promptTokens: 3,
  latencyMs: 4,
  seed: 1,
  finishReason: 'stop',
  provider: null,
  generationId: null,
  contextIds: [],
})

describe('reasoningTokensOf', () => {
  it('reads both shapes providers use', () => {
    expect(reasoningTokensOf({ completion_tokens_details: { reasoning_tokens: 120 } })).toBe(120)
    expect(reasoningTokensOf({ reasoning_tokens: 90 })).toBe(90)
  })

  it('returns null when the field is absent, never zero', () => {
    // Zero would read as "did no reasoning" and make the saving look total.
    expect(reasoningTokensOf({ completion_tokens: 50 })).toBeNull()
    expect(reasoningTokensOf(undefined)).toBeNull()
  })
})

describe('reasoningTextOf', () => {
  it('reads the trace under either provider name', () => {
    expect(reasoningTextOf({ reasoning: 'uvažuji' })).toBe('uvažuji')
    expect(reasoningTextOf({ reasoning_content: 'uvažuji' })).toBe('uvažuji')
  })

  it('gives the trace when the count says zero, which is what one provider actually does', () => {
    // Sference returns 143 tokens of reasoning_content alongside reasoning_tokens: 0. Trusting
    // the count would record a model that thought as having not thought, and report a 100% saving.
    expect(reasoningTokensOf({ completion_tokens_details: { reasoning_tokens: 0 } })).toBe(0)
    expect(reasoningTextOf({ reasoning_content: 'dlouhá úvaha' }).length).toBeGreaterThan(0)
  })

  it('is empty when the model returned no trace at all', () => {
    expect(reasoningTextOf({})).toBe('')
    expect(reasoningTextOf(undefined)).toBe('')
  })
})

describe('splitThinking', () => {
  it('separates the trace a raw vLLM server leaves inline', () => {
    const { answer, thinking } = splitThinking('<think>rozmýšlím se</think>\n\nOdpověď je 42.')
    expect(thinking).toBe('rozmýšlím se')
    expect(answer).toBe('Odpověď je 42.')
  })

  it('leaves content untouched when the provider already split the trace out', () => {
    const { answer, thinking } = splitThinking('Odpověď je 42.')
    expect(thinking).toBe('')
    expect(answer).toBe('Odpověď je 42.')
  })

  it('treats an unclosed tag as all-trace, which is what hitting the ceiling looks like', () => {
    // Truncation mid-thought leaves no closing tag. Keeping the fragment as the answer would
    // enter a stream of reasoning into the data as if the model had answered.
    const { answer, thinking } = splitThinking('<think>pořád ještě přemýšlím a nedošel jsem')
    expect(answer).toBe('')
    expect(thinking).toBe('pořád ještě přemýšlím a nedošel jsem')
  })

  it('treats a lone closing tag as the end of the trace, which is what this template produces', () => {
    // The chat template puts the opening tag in the generation prompt, so the model only ever
    // emits the closing one. Read literally, the whole trace would be recorded as the answer and
    // the saving under test would measure 100%.
    const { answer, thinking } = splitThinking('rozmýšlím se\n</think>\n\nOdpověď je 42.')
    expect(thinking).toBe('rozmýšlím se')
    expect(answer).toBe('Odpověď je 42.')
  })

  it('counts every block when a model opens the tag more than once', () => {
    const { answer, thinking } = splitThinking('<think>první</think>mezitím<think>druhá</think>konec')
    expect(thinking).toBe('první\ndruhá')
    expect(answer).toBe('mezitímkonec')
  })
})

describe('separateTrace', () => {
  it('prefers the provider field when there is one', () => {
    const r = separateTrace({ content: 'Odpověď.', reasoning_content: 'úvaha' }, 'stop')
    expect(r).toEqual({ answer: 'Odpověď.', reasoningText: 'úvaha' })
  })

  it('falls back to the inline block when there is not', () => {
    const r = separateTrace({ content: 'úvaha\n</think>\nOdpověď.' }, 'stop')
    expect(r).toEqual({ answer: 'Odpověď.', reasoningText: 'úvaha' })
  })

  it('reads a tagless completion cut off by the ceiling as all trace, never as an answer', () => {
    // Truncated mid-thought and with the opening tag in the prompt, this is shaped like a plain
    // answer. Recorded as one it would report a long answer and no reasoning at all.
    const r = separateTrace({ content: 'pořád ještě zvažuji, jestli' }, 'length')
    expect(r).toEqual({ answer: '', reasoningText: 'pořád ještě zvažuji, jestli' })
  })

  it('still trusts a tagless completion that stopped normally', () => {
    const r = separateTrace({ content: 'Odpověď je 42.' }, 'stop')
    expect(r).toEqual({ answer: 'Odpověď je 42.', reasoningText: '' })
  })
})

describe('buildPrompt', () => {
  it('gives both models byte-identical input, which is the experiment', () => {
    const ctx = [chunk('a', 'první'), chunk('b', 'druhý')]
    expect(buildPrompt('proč?', ctx)).toBe(buildPrompt('proč?', ctx))
    expect(buildPrompt('proč?', ctx)).toContain('OTÁZKA: proč?')
  })
})

describe('doneKeys', () => {
  it('has nothing to resume from before the first run', () => {
    expect(doneKeys('evals/fixtures/missing.jsonl')).toEqual(new Set())
  })

  /**
   * The original version of this test only checked the missing-file case, so it passed while the
   * two sides of the resume check built their keys with different separators — every already-
   * answered question was asked and paid for a second time, and nothing failed.
   */
  it('produces keys the caller can actually look up', () => {
    const path = join(tmpdir(), 'model-runs-test.jsonl')
    writeFileSync(path, `${JSON.stringify(run('proč to spadlo?', 'base'))}\n`)
    expect(doneKeys(path).has(runKey('base', 'proč to spadlo?', 1))).toBe(true)
    rmSync(path)
  })

  it('keys on the model and query pair, so one model finishing does not skip the other', () => {
    expect(runKey('base', 'q')).not.toBe(runKey('tuned', 'q'))
  })

  it('keys on the seed too, or every pass after the first is skipped as already done', () => {
    expect(runKey('base', 'q', 1)).not.toBe(runKey('base', 'q', 2))
  })
})

describe('buildPairs', () => {
  const runs = [run('q1', 'base'), run('q1', 'tuned'), run('q2', 'base'), run('q2', 'tuned')]

  it('randomises sides, so a position preference cannot read as a model preference', () => {
    const pairs = buildPairs(runs)
    expect(pairs.map((p) => p.leftIsFirstModel)).not.toEqual([true, true])
  })

  it('is deterministic, so a resumed session shows the same sides', () => {
    expect(buildPairs(runs)).toEqual(buildPairs(runs))
  })

  it('skips a question only one model answered rather than scoring it against nothing', () => {
    expect(buildPairs([run('q1', 'base')])).toEqual([])
  })

  it('judges a question once even when a run was recorded twice', () => {
    const twice = [run('q1', 'base'), run('q1', 'base'), run('q1', 'tuned')]
    expect(buildPairs(twice)).toHaveLength(1)
  })

  it('skips a pair where one side hit the ceiling and returned nothing', () => {
    // The empty side would lose every time, and the verdict would measure max_tokens, not a model.
    const empty: Run = { ...run('q1', 'base'), answer: '', finishReason: 'length' }
    expect(buildPairs([empty, run('q1', 'tuned')])).toEqual([])
  })
})

describe('cohenKappa', () => {
  it('is 1 when the two judges never disagree', () => {
    expect(cohenKappa(['a', 'b', 'tie'], ['a', 'b', 'tie'])).toBeCloseTo(1)
  })

  it('is near 0 for a judge that agrees only as often as chance would', () => {
    // Raw agreement here is 50%, which reads as respectable until chance is subtracted.
    expect(cohenKappa(['a', 'a', 'b', 'b'], ['a', 'b', 'a', 'b'])).toBeCloseTo(0)
  })

  it('does not reward a judge that always says the same thing', () => {
    // 60% raw agreement from answering "tie" every time. Kappa is 0: exactly chance, which is the
    // whole reason raw agreement is not the number reported.
    const human = ['tie', 'tie', 'tie', 'a', 'b']
    expect(cohenKappa(human, ['tie', 'tie', 'tie', 'tie', 'tie'])).toBeCloseTo(0)
  })
})

describe('collapseOrders', () => {
  const v = (query: string, firstShown: string, winner: string) => ({ query, firstShown, winner, raw: winner })

  it('keeps a verdict the judge gave in both presentations', () => {
    expect(collapseOrders([v('q', 'base', 'base'), v('q', 'tuned', 'base')]).get('q')).toBe('base')
  })

  it('calls it a tie when swapping the sides swaps the winner', () => {
    // The judge preferred whichever answer came first, which is a position preference and not a
    // preference between the answers.
    expect(collapseOrders([v('q', 'base', 'base'), v('q', 'tuned', 'tuned')]).get('q')).toBe('tie')
  })
})
