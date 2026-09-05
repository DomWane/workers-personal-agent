import { describe, expect, it } from 'vitest'
import { groupTurns, type AgentRecord } from './records.ts'
import { PUBLIC_COLUMNS, projectTurn, toCsv } from './turn-table.ts'

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

/** One healthy two-round turn, written out the way the agent actually emits it. */
function healthyTurn(over: Partial<AgentRecord> = {}): AgentRecord[] {
  return [
    record({
      seq: 0,
      stage: 'round',
      round: 0,
      model: 'deepseek/deepseek-v4-flash',
      provider: 'Baidu',
      durationMs: 795,
      usage: { inputTokens: 1840, outputTokens: 96, reasoningTokens: 12 },
      toolCalls: ['search_memory'],
      empty: false,
      ...over,
    }),
    record({ seq: 1, stage: 'tool-result', round: 0, tool: 'search_memory', resultLen: 412, isError: false }),
    record({
      seq: 2,
      stage: 'round',
      round: 1,
      model: 'deepseek/deepseek-v4-flash',
      provider: 'Baidu',
      durationMs: 410,
      usage: { inputTokens: 2100, outputTokens: 40 },
      toolCalls: [],
      empty: false,
    }),
    record({
      seq: 3,
      stage: 'done',
      roundsUsed: 2,
      stopReason: 'complete',
      elapsedMs: 1300,
      toolsUsed: ['search_memory'],
    }),
    record({
      seq: 4,
      at: 'turn',
      outcome: 'ok',
      stopReason: 'complete',
      roundsUsed: 2,
      toolsUsed: ['search_memory'],
      elapsedMs: 1300,
      subrequests: 16,
    }),
  ]
}

describe('projectTurn', () => {
  it('emits exactly the allowlisted columns and nothing else', () => {
    const [turn] = groupTurns(healthyTurn())
    const row = projectTurn(turn)

    expect(Object.keys(row).sort()).toEqual([...PUBLIC_COLUMNS].sort())
  })

  it('carries the numbers the eval is about', () => {
    const [turn] = groupTurns(healthyTurn())
    const row = projectTurn(turn)

    expect(row).toMatchObject({
      turnId: 'a3f1c092',
      source: 'telegram',
      model: 'deepseek/deepseek-v4-flash',
      provider: 'Baidu',
      roundsUsed: 2,
      toolCalls: 1,
      stopReason: 'complete',
      outcome: 'ok',
      subrequests: 16,
      elapsedMs: 1300,
    })
  })

  it('sums token usage across the rounds of a turn', () => {
    const [turn] = groupTurns(healthyTurn())
    const row = projectTurn(turn)

    expect(row).toMatchObject({ inputTokens: 3940, outputTokens: 136, reasoningTokens: 12 })
  })

  it('leaves usage empty rather than zero when no round reported any', () => {
    // A provider that reports nothing and a turn that cost nothing must stay distinguishable.
    const records = healthyTurn().map((r) => {
      const { usage, ...rest } = r as AgentRecord & { usage?: unknown }
      return rest as AgentRecord
    })
    const row = projectTurn(groupTurns(records)[0])

    expect(row.inputTokens).toBe('')
    expect(row.outputTokens).toBe('')
  })

  it('drops content even when the deployment was logging it', () => {
    // The projection is an allowlist, so this holds by construction rather than by remembering
    // to strip. If it ever fails, the table has become a blocklist.
    const withContent = healthyTurn()
    withContent[0] = { ...withContent[0], content: { sample: 'kdy má máma narozeniny' } } as AgentRecord
    withContent[1] = {
      ...withContent[1],
      content: { args: '{"query":"máma"}', resultHead: '<memory name="Máma">…' },
    } as AgentRecord

    const row = projectTurn(groupTurns(withContent)[0])

    expect(JSON.stringify(row)).not.toContain('narozeniny')
    expect(JSON.stringify(row)).not.toContain('máma')
    expect(JSON.stringify(row)).not.toContain('Máma')
  })

  it('counts an empty completion, which is the failure the eval exists for', () => {
    const records = healthyTurn()
    records[2] = { ...records[2], empty: true } as AgentRecord
    expect(projectTurn(groupTurns(records)[0]).empty).toBe(1)
    expect(projectTurn(groupTurns(healthyTurn())[0]).empty).toBe(0)
  })

  it('marks a turn that never finished instead of dropping it', () => {
    const unfinished = healthyTurn().slice(0, 3)
    const row = projectTurn(groupTurns(unfinished)[0])

    expect(row.outcome).toBe('unfinished')
    expect(row.stopReason).toBe('')
  })

  it('does not call maintenance unfinished — it was never going to write a turn record', () => {
    // reindex, reflection and scheduled work are invocations, not turns. Labelling them
    // unfinished would make every healthy night look like a failure in the outcome column.
    const maintenance = [record({ turnId: 'cccc3333', source: 'reindex', at: 'reindex', seq: 0, indexed: 0, rows: 38 })]
    expect(projectTurn(groupTurns(maintenance)[0]).outcome).toBe('')
  })

  it('keeps dev turns labelled so a rate is never pooled across sources', () => {
    const dev = healthyTurn().map((r) => ({ ...r, source: 'dev' }) as AgentRecord)
    expect(projectTurn(groupTurns(dev)[0]).source).toBe('dev')
  })
})

describe('toCsv', () => {
  it('writes a stable header in the allowlist order', () => {
    const [turn] = groupTurns(healthyTurn())
    const [header] = toCsv([projectTurn(turn)]).split('\n')

    expect(header).toBe(PUBLIC_COLUMNS.join(','))
  })

  it('quotes a field containing a comma so the column count survives', () => {
    const [turn] = groupTurns(healthyTurn())
    const row = { ...projectTurn(turn), model: 'a,b' }
    expect(toCsv([row]).split('\n')[1]).toContain('"a,b"')
  })

  it('produces a header even with no rows, so an empty run is not an empty file', () => {
    expect(toCsv([])).toBe(PUBLIC_COLUMNS.join(','))
  })
})
