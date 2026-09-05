import { describe, expect, it } from 'vitest'
import { fromExportedEvent, groupTurns, isAgentRecord, type AgentRecord } from './records.ts'

/**
 * Literals, never text pulled from a trace file. The corpus is not committed and a fixture
 * copied out of it would smuggle real messages into the repo one paste at a time.
 */
function record(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    v: 1,
    ts: 1_754_400_000_000,
    level: 'info',
    source: 'telegram',
    turnId: 'a3f1c092',
    seq: 0,
    at: 'tool-loop',
    ...over,
  } as AgentRecord
}

describe('isAgentRecord', () => {
  it('accepts a record carrying the envelope', () => {
    expect(isAgentRecord(record())).toBe(true)
  })

  it('rejects anything without a turnId rather than inventing one', () => {
    // A record that cannot be attributed is not a turn with one record — it is absent data,
    // and filling in a synthetic id would make it look like a turn that never happened.
    expect(isAgentRecord({ ...record(), turnId: undefined })).toBe(false)
    expect(isAgentRecord({ v: 1, at: 'ddg', status: 200 })).toBe(false)
  })

  it('rejects a schema version it does not understand', () => {
    expect(isAgentRecord({ ...record(), v: 2 })).toBe(false)
  })

  it('rejects non-objects without throwing', () => {
    expect(isAgentRecord(null)).toBe(false)
    expect(isAgentRecord('a string')).toBe(false)
  })
})

describe('groupTurns', () => {
  it('assembles records into turns, ordered by seq', () => {
    const turns = groupTurns([
      record({ seq: 2, at: 'turn', outcome: 'ok', stopReason: 'complete', subrequests: 16 }),
      record({ seq: 0, at: 'tool-loop', stage: 'round', round: 0 }),
      record({ seq: 1, at: 'tool-loop', stage: 'done', roundsUsed: 1, stopReason: 'complete' }),
    ])

    expect(turns).toHaveLength(1)
    expect(turns[0].turnId).toBe('a3f1c092')
    expect(turns[0].source).toBe('telegram')
    expect(turns[0].records.map((r) => r.seq)).toEqual([0, 1, 2])
  })

  it('keeps turns separate and orders them by when they started', () => {
    const turns = groupTurns([
      record({ turnId: 'bbbb2222', ts: 2000, seq: 0 }),
      record({ turnId: 'aaaa1111', ts: 1000, seq: 0 }),
      record({ turnId: 'bbbb2222', ts: 2100, seq: 1 }),
    ])

    expect(turns.map((t) => t.turnId)).toEqual(['aaaa1111', 'bbbb2222'])
    expect(turns[1].records).toHaveLength(2)
  })

  it('drops records without a turnId instead of pooling them under one', () => {
    const turns = groupTurns([
      record({ seq: 0 }),
      { at: 'ddg', status: 200 } as unknown as AgentRecord,
      { v: 1, at: 'vault', stage: 'skills-truncated' } as unknown as AgentRecord,
      // What the agent's out-of-turn logger actually emits: a full envelope, no turnId.
      { v: 1, ts: 1, level: 'info', source: 'schedule', seq: 0, at: 'post-notice' } as unknown as AgentRecord,
    ])

    expect(turns).toHaveLength(1)
    expect(turns[0].records).toHaveLength(1)
  })

  it('surfaces the turn record and the loop outcome without a second pass', () => {
    const [turn] = groupTurns([
      record({ seq: 0, at: 'tool-loop', stage: 'round' }),
      record({ seq: 1, at: 'tool-loop', stage: 'done', roundsUsed: 3, stopReason: 'max-rounds' }),
      record({ seq: 2, at: 'turn', outcome: 'ok', stopReason: 'max-rounds', subrequests: 22 }),
    ])

    expect(turn.outcome).toBe('ok')
    expect(turn.stopReason).toBe('max-rounds')
    expect(turn.subrequests).toBe(22)
    expect(turn.roundsUsed).toBe(3)
  })

  it('falls back to the loop record for why an unfinished turn stopped', () => {
    // The invocation died after the loop reported but before the turn record. Without the
    // fallback the one thing that still explains the turn is thrown away.
    const [turn] = groupTurns([
      record({ seq: 0, at: 'tool-loop', stage: 'round' }),
      record({ seq: 1, at: 'tool-loop', stage: 'done', roundsUsed: 6, stopReason: 'max-rounds' }),
    ])

    expect(turn.complete).toBe(false)
    expect(turn.stopReason).toBe('max-rounds')
  })

  it('reports a turn that produced no turn record at all', () => {
    // The invocation died before it could write one. That is the interesting case, not a
    // reason to skip the turn — an unfinished turn is exactly what an eval wants to count.
    const [turn] = groupTurns([record({ seq: 0, at: 'tool-loop', stage: 'round' })])

    expect(turn.outcome).toBeUndefined()
    expect(turn.complete).toBe(false)
  })

  it('separates dev traffic from organic so a rate is never pooled across them', () => {
    const turns = groupTurns([
      record({ turnId: 'aaaa1111', source: 'telegram' }),
      record({ turnId: 'bbbb2222', source: 'dev' }),
      record({ turnId: 'cccc3333', source: 'reflection' }),
    ])

    expect(turns.map((t) => t.source)).toEqual(['telegram', 'dev', 'reflection'])
  })

  it('counts a failed turn by its error record', () => {
    const [turn] = groupTurns([
      record({ seq: 0, at: 'tool-loop', stage: 'round' }),
      record({ seq: 1, level: 'error', at: 'turn', outcome: 'error', stopReason: 'error', subrequests: 9 }),
    ])

    expect(turn.outcome).toBe('error')
    expect(turn.stopReason).toBe('error')
    expect(turn.complete).toBe(true)
  })
})

describe('fromExportedEvent', () => {
  /**
   * The observability query API flattens structured logs into top-level keys; the export nests
   * them under `source`. Two shapes for the same record, and reading the wrong one has now cost
   * two debugging sessions — hence a named function instead of a shrug at each call site.
   */
  it('unwraps the envelope the export nests under source', () => {
    const exported = {
      dataset: 'cloudflare-workers',
      timestamp: 1_786_132_472_080,
      $metadata: { id: 'x', service: 'personal-agent' },
      source: {
        v: 1,
        ts: 1_786_132_472_080,
        level: 'info',
        source: 'reindex',
        turnId: '8337db20',
        seq: 0,
        at: 'reindex',
        rows: 38,
      },
    }

    const record = fromExportedEvent(exported)
    // The inner `source` is ours and names the entry point; the outer one is Cloudflare's wrapper.
    expect(record).toMatchObject({ turnId: '8337db20', at: 'reindex', source: 'reindex', rows: 38 })
  })

  it('accepts a record that is already unwrapped', () => {
    const flat = { v: 1, ts: 1, level: 'info', source: 'telegram', turnId: 'aaaa1111', seq: 0, at: 'turn' }
    expect(fromExportedEvent(flat)?.turnId).toBe('aaaa1111')
  })

  it('returns null for an event carrying no envelope at all', () => {
    // Pre-schema logs and request-level records both land here; dropping them is the point.
    expect(fromExportedEvent({ source: { level: 'error', message: '[personal-agent] reflection failed' } })).toBeNull()
    expect(fromExportedEvent({ $metadata: { id: 'x' } })).toBeNull()
    expect(fromExportedEvent(null)).toBeNull()
  })
})
