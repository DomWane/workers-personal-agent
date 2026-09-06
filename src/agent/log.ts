export const LOG_SCHEMA_VERSION = 1

export type LogSource = 'web' | 'dev' | 'reflection' | 'reindex' | 'research' | 'schedule'

export function errorFields(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message.slice(0, 300) }
  }
  return { name: typeof err, message: String(err).slice(0, 300) }
}

export interface LogContent {
  sample?: string
  args?: string
  resultHead?: string
}

export interface TurnLog {
  readonly turnId: string | null
  event(fields: Record<string, unknown>, content?: LogContent): void
  error(fields: Record<string, unknown>, content?: LogContent): void
}

export function contentEnabled(env: { LOG_CONTENT?: string }): boolean {
  return env.LOG_CONTENT === 'true' || env.LOG_CONTENT === '1'
}

export interface LogOptions {
  turnId?: string | null
  content?: boolean
}

export function createLog(source: LogSource, opts: LogOptions = {}): TurnLog {
  const turnId = opts.turnId === null ? null : (opts.turnId ?? crypto.randomUUID().slice(0, 8))
  let seq = 0
  const emit = (level: 'info' | 'error', fields: Record<string, unknown>, content?: LogContent): void => {
    console.log(
      JSON.stringify({
        v: LOG_SCHEMA_VERSION,
        ts: Date.now(),
        level,
        source,
        ...(turnId === null ? {} : { turnId }),
        seq: seq++,
        ...fields,
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

export const ORPHAN_LOG: TurnLog = createLog('schedule', { turnId: null })
