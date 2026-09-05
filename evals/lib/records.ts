/**
 * The one place that knows the log schema. Both the eval runners and any later trajectory
 * debugger read turns through here, so raising `v` to 2 changes one file rather than every
 * consumer that happened to reach into a record.
 *
 * The types are restated here rather than imported from `src/agent/log.ts` because reader and
 * writer version independently: the Worker emits one schema version, a trace file on disk holds
 * every version ever written, and this side has to keep understanding the old ones after the
 * Worker has stopped producing them.
 */

export const SUPPORTED_SCHEMA_VERSION = 1

export type LogSource = 'telegram' | 'dev' | 'reflection' | 'reindex' | 'research' | 'schedule'

export interface AgentRecord {
  v: number
  ts: number
  level: 'info' | 'error'
  source: LogSource
  turnId: string
  seq: number
  at: string
  stage?: string
  round?: number
  roundsUsed?: number
  stopReason?: string
  outcome?: string
  subrequests?: number
  /** Present only when the deployment opted in; see LOG_CONTENT. */
  content?: { sample?: string; args?: string; resultHead?: string }
  [key: string]: unknown
}

export interface Turn {
  turnId: string
  source: LogSource
  /** Wall-clock of the first record; only meaningful for ordering turns against each other. */
  startedAt: number
  records: AgentRecord[]
  /** From the `turn` record, absent when the invocation died before writing one. */
  outcome?: string
  stopReason?: string
  subrequests?: number
  /** From the loop's `done` record. */
  roundsUsed?: number
  /** Whether a `turn` record was ever written. A false here is a finding, not a parse failure. */
  complete: boolean
}

/**
 * One record, two shapes. The observability *query* API flattens structured logs into top-level
 * keys; the *export* nests the whole object under `source`. Reading the wrong one looks exactly
 * like "the agent logged nothing", which it did not.
 *
 * Note the name collision: our envelope's own `source` (which entry point) sits inside
 * Cloudflare's `source` (the console call). Unwrapping keeps ours.
 */
export function fromExportedEvent(event: unknown): AgentRecord | null {
  if (typeof event !== 'object' || event === null) {
    return null
  }
  const outer = event as Record<string, unknown>
  if (isAgentRecord(outer)) {
    return outer
  }
  const nested = outer.source
  return isAgentRecord(nested) ? nested : null
}

export function isAgentRecord(value: unknown): value is AgentRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const r = value as Record<string, unknown>
  return (
    r.v === SUPPORTED_SCHEMA_VERSION &&
    typeof r.turnId === 'string' &&
    r.turnId.length > 0 &&
    typeof r.seq === 'number' &&
    typeof r.at === 'string'
  )
}

/**
 * Groups records into turns. Anything without an envelope is dropped rather than pooled under a
 * synthetic id: an unattributable record is missing data, and inventing an id for it would make
 * it read as a turn that never happened.
 */
export function groupTurns(records: readonly AgentRecord[]): Turn[] {
  const byTurn = new Map<string, AgentRecord[]>()
  for (const record of records) {
    if (!isAgentRecord(record)) {
      continue
    }
    const bucket = byTurn.get(record.turnId)
    if (bucket) {
      bucket.push(record)
    } else {
      byTurn.set(record.turnId, [record])
    }
  }

  const turns: Turn[] = []
  for (const [turnId, unordered] of byTurn) {
    // seq is the order the code emitted them in; ts cannot be, since records inside one
    // invocation routinely share a millisecond.
    const ordered = [...unordered].sort((a, b) => a.seq - b.seq)
    const turnRecord = ordered.find((r) => r.at === 'turn')
    const done = ordered.find((r) => r.at === 'tool-loop' && r.stage === 'done')
    turns.push({
      turnId,
      source: ordered[0].source,
      startedAt: Math.min(...ordered.map((r) => r.ts)),
      records: ordered,
      outcome: turnRecord?.outcome as string | undefined,
      stopReason: (turnRecord?.stopReason ?? done?.stopReason) as string | undefined,
      subrequests: turnRecord?.subrequests as number | undefined,
      roundsUsed: done?.roundsUsed as number | undefined,
      complete: turnRecord !== undefined,
    })
  }

  return turns.sort((a, b) => a.startedAt - b.startedAt)
}
