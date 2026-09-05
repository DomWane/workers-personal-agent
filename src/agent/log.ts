/**
 * One envelope for every structured record, so a turn can be reassembled from its parts.
 *
 * `$metadata.requestId` already groups records within one invocation, which is why turn-level
 * metrics were possible before this existed. What it cannot do is span invocations: a webhook,
 * the alarm that answers it, and the alarm that posts a failure notice are three request ids for
 * one exchange the user experiences as continuous.
 */
export const LOG_SCHEMA_VERSION = 1

/** Where the work came from. Organic traffic and hand-made replay must never be pooled. */
export type LogSource = 'web' | 'dev' | 'reflection' | 'reindex' | 'research' | 'schedule'

/**
 * An error as queryable fields. A concatenated string forces every later question — which errors,
 * how often, from where — to be answered by regexing prose that was never designed to be parsed.
 */
export function errorFields(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message.slice(0, 300) }
  }
  return { name: typeof err, message: String(err).slice(0, 300) }
}

/**
 * Message bodies, tool arguments and tool results. Segregated from the rest of the record so a
 * trace file can be shared, replayed or published without its content — and so that decision is
 * one flag rather than a review of every log call.
 */
export interface LogContent {
  sample?: string
  args?: string
  resultHead?: string
}

export interface TurnLog {
  /** Null for work that belongs to no turn; the record then carries no `turnId` at all. */
  readonly turnId: string | null
  event(fields: Record<string, unknown>, content?: LogContent): void
  error(fields: Record<string, unknown>, content?: LogContent): void
}

/**
 * Opt-in only. Anything else — unset, empty, "false", "0" — is off, because the failure mode of
 * guessing wrong is message bodies in a file someone later shares.
 */
export function contentEnabled(env: { LOG_CONTENT?: string }): boolean {
  return env.LOG_CONTENT === 'true' || env.LOG_CONTENT === '1'
}

export interface LogOptions {
  /** Null means "no turn": readers drop such records rather than pooling them under a fake id. */
  turnId?: string | null
  /** Off unless the deployment opts in. Absent, not redacted: a key that is sometimes there is
   *  a key that leaks the day nobody remembers which build wrote the file. */
  content?: boolean
}

/**
 * `seq` orders records within a turn. Wall-clock cannot: several records can share a millisecond,
 * and the timestamp a Worker sees does not advance between I/O operations.
 */
export function createLog(source: LogSource, opts: LogOptions = {}): TurnLog {
  const turnId = opts.turnId === null ? null : (opts.turnId ?? crypto.randomUUID().slice(0, 8))
  let seq = 0
  const emit = (level: 'info' | 'error', fields: Record<string, unknown>, content?: LogContent): void => {
    console.log(
      JSON.stringify({
        v: LOG_SCHEMA_VERSION,
        ts: Date.now(),
        level,
        // `source` rides in the envelope rather than only on the turn record: splitting any
        // per-round metric by organic vs replay would otherwise need a join back to it.
        source,
        ...(turnId === null ? {} : { turnId }),
        seq: seq++,
        ...fields,
        // Last, and only from the dedicated parameter: a caller cannot smuggle a message body
        // into a record by naming an ordinary field `content`.
        ...(opts.content && content ? { content } : { content: undefined }),
      }),
    )
  }
  return {
    turnId,
    event: (fields, content) => emit('info', fields, content),
    error: (fields, content) => emit('error', fields, content),
  }
}

/**
 * For code that can genuinely run outside a turn. The records carry no `turnId`, so a reader
 * drops them rather than pooling unrelated ones into an invented turn.
 */
export const ORPHAN_LOG: TurnLog = createLog('schedule', { turnId: null })
