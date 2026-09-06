import type { SqlTag } from './memory/embedding-index'
import type { HistoryMessage } from '../types'

export function sqlTag(sql: SqlStorage): SqlTag {
  return (<T>(strings: TemplateStringsArray, ...values: unknown[]) =>
    sql.exec(strings.raw.join('?'), ...(values as never[])).toArray() as T[]) as SqlTag
}

export type ArchiveType = 'compaction-start' | 'compaction' | 'compaction-end' | 'feedback' | 'tool-result'

interface ArchiveRow<T = unknown> {
  seq: number
  time: number
  type: ArchiveType
  data: T
}

export interface FeedbackRecord {
  message: string
  rating: 'up' | 'down' | 'none'
  note?: string
}

export interface ToolResultRecord {
  tool: string
  args: string
  content: string
}

export interface CompactionRecord {
  evicted: HistoryMessage[]
  summary: string
  shadows: string[]
  unsummarized: number
}

interface Row {
  seq: number
  time: number
  type: string
  data: string
}

function toArchiveRow<T>(r: Row): ArchiveRow<T> {
  return { seq: r.seq, time: r.time, type: r.type as ArchiveType, data: JSON.parse(r.data) as T }
}

function ensureTable(sql: SqlTag): void {
  sql`CREATE TABLE IF NOT EXISTS archive (seq INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL)`
}

export function appendArchive(sql: SqlTag, type: ArchiveType, data: unknown): number {
  ensureTable(sql)
  const rows = sql<{
    seq: number
  }>`INSERT INTO archive (time, type, data) VALUES (${Date.now()}, ${type}, ${JSON.stringify(data)}) RETURNING seq`
  return rows[0]?.seq ?? 0
}

export function readArchive<T = unknown>(sql: SqlTag, since = 0): ArchiveRow<T>[] {
  ensureTable(sql)
  const rows = sql<Row>`SELECT * FROM archive WHERE time > ${since} ORDER BY seq`
  return rows.map((r) => toArchiveRow<T>(r))
}

export function dropArchive(sql: SqlTag): void {
  sql`DROP TABLE IF EXISTS archive`
}

export function readArchiveRow<T = unknown>(sql: SqlTag, seq: number): ArchiveRow<T> | null {
  ensureTable(sql)
  const rows = sql<Row>`SELECT * FROM archive WHERE seq = ${seq}`
  return rows[0] ? toArchiveRow<T>(rows[0]) : null
}

const SNIPPET_CHARS = 300

export interface ToolResultMatch {
  ref: number
  at: number
  tool: string
  args: string
  snippet: string
  total: number
}

export function searchToolResults(sql: SqlTag, query: string, limit: number): ToolResultMatch[] {
  ensureTable(sql)
  const needle = query.toLowerCase()
  return sql<{ ref: number; at: number; tool: string; args: string; snippet: string; total: number }>`
    WITH filed AS (
      SELECT seq, time,
             json_extract(data, '$.tool') AS tool,
             json_extract(data, '$.args') AS args,
             json_extract(data, '$.content') AS content
      FROM archive WHERE type = 'tool-result'
    )
    SELECT seq AS ref, time AS at, tool, args,
           substr(content, max(1, instr(lower(content), ${needle}) - ${SNIPPET_CHARS / 2}), ${SNIPPET_CHARS}) AS snippet,
           length(content) AS total
    FROM filed
    WHERE instr(lower(content), ${needle}) > 0 OR instr(lower(args), ${needle}) > 0
    ORDER BY seq DESC LIMIT ${limit}`
}

export function toolArchiveOver(sql: SqlTag) {
  return {
    save: (record: ToolResultRecord) => appendArchive(sql, 'tool-result', record),
    read: (ref: number) => {
      const row = readArchiveRow<ToolResultRecord>(sql, ref)
      return row?.type === 'tool-result' ? { ...row.data, at: row.time } : null
    },
    search: (query: string, limit: number) => searchToolResults(sql, query, limit),
  }
}
