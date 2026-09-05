import type { AgentRecord, Turn } from './records.ts'

/**
 * One row per turn, and the only shape of this data that may ever be published.
 *
 * This is an **allowlist**: a column exists here or it does not reach the file. A blocklist —
 * "everything except content" — would leak the first time a new field was added and nobody
 * thought about the export, which is the failure mode worth designing against rather than
 * remembering to avoid.
 */
export const PUBLIC_COLUMNS = [
  'turnId',
  'source',
  'model',
  'provider',
  'outcome',
  'stopReason',
  'roundsUsed',
  'toolCalls',
  'empty',
  'subrequests',
  'elapsedMs',
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
] as const

export type PublicColumn = (typeof PUBLIC_COLUMNS)[number]
/** Empty string means "not reported", which is not the same as zero and must stay separable. */
export type TurnRow = Record<PublicColumn, string | number>

function rounds(turn: Turn): AgentRecord[] {
  return turn.records.filter((r) => r.at === 'tool-loop' && r.stage === 'round')
}

function sumUsage(turn: Turn, field: 'inputTokens' | 'outputTokens' | 'reasoningTokens'): number | '' {
  let total = 0
  let reported = false
  for (const round of rounds(turn)) {
    const usage = round.usage as Record<string, number | undefined> | undefined
    const value = usage?.[field]
    if (typeof value === 'number') {
      total += value
      reported = true
    }
  }
  return reported ? total : ''
}

/** Only these entry points answer a user and therefore owe a `turn` record. */
const CONVERSATIONAL: ReadonlySet<string> = new Set(['telegram', 'dev'])

export function projectTurn(turn: Turn): TurnRow {
  const roundRecords = rounds(turn)
  const first = roundRecords[0]
  const toolsUsed = turn.records.find((r) => r.at === 'turn' || r.stage === 'done')?.toolsUsed
  return {
    turnId: turn.turnId,
    source: turn.source,
    model: (first?.model as string) ?? '',
    provider: (first?.provider as string) ?? '',
    // An unfinished conversation is a row, not a gap — it is the outcome an eval most wants to
    // count. Maintenance was never going to write a turn record, so calling it unfinished would
    // make every healthy night read as a failure.
    outcome: turn.outcome ?? (CONVERSATIONAL.has(turn.source) ? 'unfinished' : ''),
    stopReason: turn.stopReason ?? '',
    roundsUsed: turn.roundsUsed ?? roundRecords.length,
    toolCalls: Array.isArray(toolsUsed) ? toolsUsed.length : 0,
    empty: roundRecords.some((r) => r.empty === true) ? 1 : 0,
    subrequests: turn.subrequests ?? '',
    elapsedMs: (turn.records.find((r) => r.at === 'turn')?.elapsedMs as number) ?? '',
    inputTokens: sumUsage(turn, 'inputTokens'),
    outputTokens: sumUsage(turn, 'outputTokens'),
    reasoningTokens: sumUsage(turn, 'reasoningTokens'),
  }
}

function csvField(value: string | number): string {
  const s = String(value)
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

/** Header always, rows maybe: an empty run should produce a readable file, not an empty one. */
export function toCsv(rows: readonly TurnRow[]): string {
  const lines = [PUBLIC_COLUMNS.join(',')]
  for (const row of rows) {
    lines.push(PUBLIC_COLUMNS.map((c) => csvField(row[c])).join(','))
  }
  return lines.join('\n')
}
