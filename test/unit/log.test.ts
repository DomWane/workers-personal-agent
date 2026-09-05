import { describe, expect, it, vi } from 'vitest'
import { contentEnabled, createLog, errorFields, LOG_SCHEMA_VERSION, ORPHAN_LOG } from '../../src/agent/log'

function capture(run: () => void): Record<string, unknown>[] {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void lines.push(String(m)))
  try {
    run()
  } finally {
    spy.mockRestore()
  }
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('createLog', () => {
  it('stamps every record with one envelope', () => {
    const [record] = capture(() => createLog('web').event({ at: 'turn', outcome: 'ok' }))

    expect(record).toMatchObject({ v: LOG_SCHEMA_VERSION, level: 'info', source: 'web', seq: 0, at: 'turn' })
    expect(typeof record.ts).toBe('number')
    expect(record.turnId).toMatch(/^[0-9a-f]{8}$/)
  })

  it('shares one turnId across a turn and numbers records without gaps', () => {
    const log = createLog('web')
    const records = capture(() => {
      log.event({ at: 'tool-loop', stage: 'round' })
      log.event({ at: 'tool-loop', stage: 'tool-result' })
      log.error({ at: 'turn', outcome: 'failed' })
    })

    expect(new Set(records.map((r) => r.turnId)).size).toBe(1)
    expect(records.map((r) => r.seq)).toEqual([0, 1, 2])
    expect(records.map((r) => r.level)).toEqual(['info', 'info', 'error'])
  })

  it('gives separate turns separate ids', () => {
    const a = createLog('web')
    const b = createLog('web')
    expect(a.turnId).not.toBe(b.turnId)
    // Sequence is per turn, not global: two turns both start at 0.
    const records = capture(() => {
      a.event({ at: 'turn' })
      b.event({ at: 'turn' })
    })
    expect(records.map((r) => r.seq)).toEqual([0, 0])
  })

  it('keeps dev traffic distinguishable from organic', () => {
    // Pooling replay with organic turns makes any failure rate look better than it is, and the
    // two cannot be separated after the fact.
    const records = capture(() => {
      createLog('dev').event({ at: 'turn' })
      createLog('reflection').event({ at: 'reflection' })
      createLog('reindex').event({ at: 'reindex' })
    })
    expect(records.map((r) => r.source)).toEqual(['dev', 'reflection', 'reindex'])
  })

  it('leaves out-of-turn records without a turnId so a reader drops them', () => {
    // A synthetic id would let every unrelated orphan pool into one fake turn sharing one seq
    // counter. Absent is the honest encoding of "this belongs to no turn".
    const [record] = capture(() => ORPHAN_LOG.event({ at: 'vault' }))
    expect('turnId' in record).toBe(false)
    expect(record.v).toBe(LOG_SCHEMA_VERSION)
  })
})

describe('errorFields', () => {
  it('splits an Error into queryable fields', () => {
    expect(errorFields(new TypeError('cannot read x'))).toEqual({ name: 'TypeError', message: 'cannot read x' })
  })

  it('survives a thrown non-Error without losing what was thrown', () => {
    expect(errorFields('plain string')).toEqual({ name: 'string', message: 'plain string' })
    expect(errorFields({ code: 10053 })).toMatchObject({ name: 'object' })
  })

  it('caps the message so one huge throw cannot dominate a log line', () => {
    const long = new Error('x'.repeat(1000))
    expect(errorFields(long).message).toHaveLength(300)
  })
})

describe('content is opt-in', () => {
  it('drops the content block entirely when the flag is off', () => {
    const [record] = capture(() =>
      createLog('web').event({ at: 'tool-loop', stage: 'tool-result' }, { args: '{"q":"kdy má máma narozeniny"}' }),
    )
    // Not empty, not redacted — absent. A key that is sometimes present is a key that leaks
    // the day someone forgets which build produced the file.
    expect('content' in record).toBe(false)
    expect(JSON.stringify(record)).not.toContain('narozeniny')
  })

  it('includes it when the flag is on', () => {
    const [record] = capture(() =>
      createLog('web', { content: true }).event(
        { at: 'tool-loop', stage: 'tool-result' },
        { args: '{"q":"x"}', resultHead: 'result text' },
      ),
    )
    expect(record.content).toEqual({ args: '{"q":"x"}', resultHead: 'result text' })
  })

  it('never lets content in through the ordinary field bag', () => {
    // The only way in is the second parameter, so a caller cannot smuggle a message body
    // into a record by naming a field well.
    const [record] = capture(() => createLog('web').event({ at: 'x', content: { args: 'sneaky' } }))
    expect(record.content).toBeUndefined()
  })

  it('defaults the orphan logger to content off', () => {
    const [record] = capture(() => ORPHAN_LOG.event({ at: 'vault' }, { resultHead: 'secret' }))
    expect('content' in record).toBe(false)
  })
})

describe('contentEnabled', () => {
  it('is off unless the deployment says otherwise', () => {
    // Anything other than an explicit opt-in means off, including a var someone left empty
    // or set to "false" believing that turned it on.
    expect(contentEnabled({} as never)).toBe(false)
    expect(contentEnabled({ LOG_CONTENT: '' } as never)).toBe(false)
    expect(contentEnabled({ LOG_CONTENT: 'false' } as never)).toBe(false)
    expect(contentEnabled({ LOG_CONTENT: '0' } as never)).toBe(false)
  })

  it('accepts the two spellings a human would reach for', () => {
    expect(contentEnabled({ LOG_CONTENT: 'true' } as never)).toBe(true)
    expect(contentEnabled({ LOG_CONTENT: '1' } as never)).toBe(true)
  })
})
