import { describe, expect, it } from 'vitest'
import { groupTurns } from '@/agent/loop/turns'
import type { HistoryMessage, ToolCall } from '@/types'

const call = (id: string, name = 'web_search'): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: '{}' },
})
const user = (id: string): HistoryMessage => ({ role: 'user', content: `q ${id}`, id })
const step = (id: string, content: string, calls: ToolCall[]): HistoryMessage => ({
  role: 'assistant',
  content,
  id,
  tool_calls: calls,
})
const result = (id: string, callId: string): HistoryMessage => ({
  role: 'tool',
  content: `r ${callId}`,
  id,
  tool_call_id: callId,
})
const answer = (id: string, content = 'done'): HistoryMessage => ({ role: 'assistant', content, id, tokens: 12 })

describe('groupTurns', () => {
  it('folds every step and result into the turn of the answer that followed them', () => {
    const turns = groupTurns([
      user('u1'),
      step('a1', '', [call('c1'), call('c2')]),
      result('t1', 'c1'),
      result('t2', 'c2'),
      step('a2', 'Wrote this before saving', [call('c3', 'save_memory')]),
      result('t3', 'c3'),
      answer('a3', 'Saved.'),
    ])

    expect(turns.map((t) => [t.from, t.id])).toEqual([
      ['user', 'u1'],
      ['assistant', 'u1:0'],
    ])
    expect(turns[1].final?.id).toBe('a3')
    expect(turns[1].final?.tokens).toBe(12)
    expect(
      turns[1].segments.map((s) =>
        s.kind === 'text' ? ['text', s.message.content] : ['tool', s.call.id, s.result?.content],
      ),
    ).toEqual([
      ['tool', 'c1', 'r c1'],
      ['tool', 'c2', 'r c2'],
      ['text', 'Wrote this before saving'],
      ['tool', 'c3', 'r c3'],
      ['text', 'Saved.'],
    ])
  })

  it('keeps an answer with no steps before it as a turn of its own', () => {
    const turns = groupTurns([user('u1'), answer('a1'), answer('a2', 'Reminder: standup')])
    expect(turns.map((t) => t.id)).toEqual(['u1', 'u1:0', 'u1:1'])
    expect(turns[2].segments).toEqual([{ kind: 'text', message: expect.objectContaining({ id: 'a2' }) }])
  })

  it('leaves a running turn open, with no final', () => {
    const turns = groupTurns([user('u1'), step('a1', 'Looking…', [call('c1')]), result('t1', 'c1')])
    expect(turns[1]).toMatchObject({ from: 'assistant', id: 'u1:0' })
    expect(turns[1].final).toBeUndefined()
    expect(turns[1].segments).toHaveLength(2)
  })

  it('keeps a turn id from draft to live steps to landed answer, so the client never remounts it', () => {
    const drafting = groupTurns([user('u1')], 'Looking')
    const running = groupTurns([user('u1'), step('live-1', 'Looking', [call('c1')]), result('live-2', 'c1')])
    const landed = groupTurns([user('u1'), step('a1', 'Looking', [call('c1')]), result('t1', 'c1'), answer('a2')])

    expect([drafting[1].id, running[1].id, landed[1].id]).toEqual(['u1:0', 'u1:0', 'u1:0'])
  })

  it('closes an open turn at the next user message, and ignores a result whose call is not in it', () => {
    const turns = groupTurns([user('u1'), step('a1', '', [call('c1')]), user('u2'), result('t9', 'c1'), answer('a2')])
    expect(turns.map((t) => t.id)).toEqual(['u1', 'u1:0', 'u2', 'u2:0'])
    expect(turns[3].segments).toEqual([{ kind: 'text', message: expect.objectContaining({ id: 'a2' }) }])
  })

  it('appends the draft to the open turn, and opens one for it when nothing is running', () => {
    const open = groupTurns([user('u1'), step('a1', '', [call('c1')])], 'Writing')
    expect(open[1].segments.at(-1)).toEqual({
      kind: 'text',
      message: { role: 'assistant', content: 'Writing', id: 'draft' },
    })
    expect(open[1].final).toBeUndefined()

    const alone = groupTurns([user('u1')], 'Writing')
    expect(alone.map((t) => t.id)).toEqual(['u1', 'u1:0'])
    expect(alone[1].final).toBeUndefined()

    expect(groupTurns([user('u1'), answer('a1')], 'Writing').map((t) => t.id)).toEqual(['u1', 'u1:0', 'u1:1'])
  })

  it('treats an empty tool_calls list as an answer, the way the thread filter does', () => {
    const turns = groupTurns([{ role: 'assistant', content: 'plain', id: 'a1', tool_calls: [] }])
    expect(turns[0]).toMatchObject({ id: 'start:0', final: { id: 'a1' } })
  })
})
