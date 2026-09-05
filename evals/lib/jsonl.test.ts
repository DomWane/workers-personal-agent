import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readJsonLines } from './jsonl.ts'

let dir: string
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function write(name: string, content: string): string {
  dir = mkdtempSync(join(tmpdir(), 'jsonl-'))
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

describe('readJsonLines', () => {
  it('reads complete lines', () => {
    const p = write('a.jsonl', '{"a":1}\n{"a":2}\n')
    expect(readJsonLines<{ a: number }>(p)).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('keeps everything before a truncated trailing line from an interrupted append', () => {
    // Ctrl-C during eval:gen or eval:label is the normal way this file ends up half-written.
    const p = write('b.jsonl', '{"a":1}\n{"a":2}\n{"a":')
    expect(readJsonLines<{ a: number }>(p)).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('returns nothing for a file that does not exist yet', () => {
    const p = write('c.jsonl', '')
    expect(readJsonLines(join(p, 'nope.jsonl'))).toEqual([])
  })

  it('throws for a missing file the caller declared required', () => {
    const p = write('d.jsonl', '')
    expect(() => readJsonLines(join(p, 'nope.jsonl'), { required: true })).toThrow(/missing input file/)
  })
})
