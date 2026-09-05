import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadDroppedIds, loadKeptIds, selectTodo } from './retrieval.ts'

describe('loadKeptIds / loadDroppedIds / selectTodo (resume)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'retrieval-test-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('treats a resume file that does not exist yet as no decisions made', () => {
    expect(loadDroppedIds(join(dir, 'missing.jsonl'))).toEqual(new Set())
  })

  it('skips a partially-written trailing line instead of throwing', () => {
    const file = join(dir, 'dropped.jsonl')
    writeFileSync(file, `${JSON.stringify({ chunkId: 'c1' })}\n{"chunkId":"c2` /* no closing brace/newline */)
    expect(loadDroppedIds(file)).toEqual(new Set(['c1']))
  })

  it('loadKeptIds reads relevant[0] from label lines', () => {
    const file = join(dir, 'labels.jsonl')
    writeFileSync(file, `${JSON.stringify({ query: 'q', relevant: ['c1'], kind: 'bulk' })}\n`)
    expect(loadKeptIds(file)).toEqual(new Set(['c1']))
  })

  it('a dropped candidate does not reappear in todo, distinct from a kept one', () => {
    const candidates = [
      { chunkId: 'c1', query: 'q1', leakage: 0.1 },
      { chunkId: 'c2', query: 'q2', leakage: 0.1 },
      { chunkId: 'c3', query: 'q3', leakage: 0.1 },
    ]
    const excluded = new Set(['c1', 'c2']) // c1 kept, c2 dropped — both excluded from todo
    expect(selectTodo(candidates, excluded).map((c) => c.chunkId)).toEqual(['c3'])
  })
})
