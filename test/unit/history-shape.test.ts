import { describe, expect, it, vi } from 'vitest'
import { historyForTurn, pairedOnly, spoken } from '../../src/agent/context-window'
import type { TurnLog } from '../../src/agent/log'
import type { HistoryMessage } from '../../src/types'

const user = (id: string): HistoryMessage => ({ role: 'user', content: `q ${id}`, id })
const answer = (id: string): HistoryMessage => ({ role: 'assistant', content: `a ${id}`, id })
const asked = (id: string, callId: string): HistoryMessage => ({
  role: 'assistant',
  content: '',
  id,
  tool_calls: [{ id: callId, type: 'function', function: { name: 'read_page', arguments: '{}' } }],
})
const replied = (id: string, callId: string): HistoryMessage => ({
  role: 'tool',
  content: 'the page',
  id,
  tool_call_id: callId,
})

describe('historyForTurn', () => {
  /**
   * Two messages in flight: the second was queued while the first was still answering, so the first
   * question is no longer last in state and the turn that answers it has to rebuild its own view.
   */
  const state = [user('u1'), user('u2'), asked('a1', 'c1'), replied('t1', 'c1'), answer('a2')]

  it('keeps the later turn answers and none of their tool traffic', () => {
    const out = historyForTurn(state, 0, user('u1'))

    // `a1` and `t1` belong to the answer given to `u2`. Keeping `a1` alone would be an assistant
    // whose call is never answered, which the API refuses with the same 400 as an unmatched id —
    // and it is the shape `filter(role === 'assistant')` would have produced.
    expect(out.map((m) => m.id)).toEqual(['a2', 'u1'])
  })

  it('puts the question being answered last, whatever landed since', () => {
    expect(historyForTurn(state, 0, user('u1')).at(-1)?.id).toBe('u1')
  })
})

/**
 * All three are a 400 on a request the provider would otherwise have answered, and a permissive
 * endpoint hides every one of them until the model is switched — which is a button in the composer.
 */
describe('pairedOnly', () => {
  it('drops a result whose call is gone, and the call whose result is gone', () => {
    const orphanResult = [user('u1'), replied('t1', 'c1'), answer('a1')]
    expect(pairedOnly(orphanResult).map((m) => m.id)).toEqual(['u1', 'a1'])

    // The other direction, which a turn dying between a round and its results produces without
    // anything being wrong in the writer.
    const orphanCall = [user('u1'), asked('a1', 'c1'), answer('a2')]
    expect(pairedOnly(orphanCall).map((m) => m.id)).toEqual(['u1', 'a2'])
  })

  it('drops a result with no id at all, rather than sending an empty one', () => {
    // Cast because the type now forbids this shape — and the runtime check stays anyway: state is
    // parsed JSON written by an older deploy or by hand, which no union polices.
    const idless = { role: 'tool', content: 'x', id: 't1' } as unknown as HistoryMessage
    const noId: HistoryMessage[] = [user('u1'), asked('a1', 'c1'), idless]

    // Both halves go: keeping the assistant would leave a call nothing answers.
    expect(pairedOnly(noId).map((m) => m.id)).toEqual(['u1'])
  })

  it('takes the answered half of a partly-answered round with the assistant it belonged to', () => {
    const partly: HistoryMessage[] = [
      user('u1'),
      {
        role: 'assistant',
        content: '',
        id: 'a1',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read_page', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'read_page', arguments: '{}' } },
        ],
      },
      replied('t1', 'c1'),
    ]

    // `a1` goes because `c2` was never answered. Deciding the results against the original calls
    // would keep `t1`, which is then an answer to a question no longer in the request.
    //
    // Mutation check: build `live` from `history` rather than from the messages that survived
    // `fullyAnswered`, and this returns `['u1', 't1']` — `pairedOnly` stops being a fixpoint.
    expect(pairedOnly(partly).map((m) => m.id)).toEqual(['u1'])
  })

  it('keeps a whole group untouched, and says nothing when there is nothing to drop', () => {
    const whole = [user('u1'), asked('a1', 'c1'), replied('t1', 'c1'), answer('a2')]
    const log = { error: vi.fn() } as unknown as TurnLog

    expect(pairedOnly(whole, log)).toEqual(whole)
    expect(log.error).not.toHaveBeenCalled()
  })

  it('reports what it dropped — a silent trim is the failure this repo keeps a list of', () => {
    const log = { error: vi.fn() } as unknown as TurnLog

    pairedOnly([user('u1'), replied('t1', 'c1')], log)

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ at: 'history', stage: 'unpaired-tool-traffic', dropped: 1 }),
    )
  })
})

describe('spoken', () => {
  it('drops both halves of a group, never one', () => {
    expect(spoken([user('u1'), asked('a1', 'c1'), replied('t1', 'c1'), answer('a2')]).map((m) => m.id)).toEqual([
      'u1',
      'a2',
    ])
  })

  it('leaves a thread that called no tools exactly as it was', () => {
    const plain = [user('u1'), answer('a1')]
    expect(spoken(plain)).toEqual(plain)
  })
})
