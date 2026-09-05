import type { SqlTag } from './memory/embedding-index'
import type { HistoryMessage } from '../types'

/**
 * The Agents SDK hands out a tagged template; a plain Durable Object gets `storage.sql`, which
 * takes a query string and its arguments. Here rather than beside its first caller because every
 * caller since has been about this table — the archive in a `ResearchScout`, and the tests that
 * read one.
 */
export function sqlTag(sql: SqlStorage): SqlTag {
  return (<T>(strings: TemplateStringsArray, ...values: unknown[]) =>
    sql.exec(strings.raw.join('?'), ...(values as never[])).toArray() as T[]) as SqlTag
}

/**
 * The append-only record of what compaction destroyed, in the thread's own SQLite. One writer, one
 * table, one INSERT — the design this replaced put it in the vault, where two writers had to
 * coordinate over one artifact. `type` over JSON `data` so a second kind of record needs no
 * migration.
 */
export type ArchiveType = 'compaction-start' | 'compaction' | 'compaction-end' | 'feedback' | 'tool-result'

interface ArchiveRow<T = unknown> {
  seq: number
  time: number
  type: ArchiveType
  data: T
}

/** Here rather than in `state.messages` because it must outlive compaction. `none` is a withdrawal:
 *  the table is append-only, so a reader takes the last row per message. */
export interface FeedbackRecord {
  message: string
  rating: 'up' | 'down' | 'none'
  note?: string
}

/**
 * A tool result kept whole, next to the shortened copy the model was handed. `state.messages` does
 * carry tool traffic — a later turn needs the ref to quote — but only ever the stub: the middle of
 * a page is unreachable without this table, both within the turn and after it.
 *
 * That split is deliberate. Everything in `state` is sent to the model on every later turn and
 * broadcast to every connected client, and a 50k page has no business in either.
 */
export interface ToolResultRecord {
  tool: string
  /** The call's arguments, for telling two reads of different pages apart in a search hit. */
  args: string
  content: string
}

export interface CompactionRecord {
  evicted: HistoryMessage[]
  summary: string
  /** Ids of the messages the summary replaced, so a reader can tell which text it came from. */
  shadows: string[]
  /** Evicted turns the summarizer had no room for — archived raw, never summarized. */
  unsummarized: number
}

/** Named once and read with `SELECT *`, because a shared column list is impossible: `SqlTag` turns
 *  every interpolation into a bound `?`, so a constant spliced in would arrive as a parameter. */
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

/**
 * `since` is exclusive, in epoch ms. The three row types read as a pass's fate long after its log
 * expired: `start` alone never completed, `start + compaction` wrote the record but may not have
 * trimmed, `end` says it did.
 */
export function readArchive<T = unknown>(sql: SqlTag, since = 0): ArchiveRow<T>[] {
  ensureTable(sql)
  const rows = sql<Row>`SELECT * FROM archive WHERE time > ${since} ORDER BY seq`
  return rows.map((r) => toArchiveRow<T>(r))
}

export function dropArchive(sql: SqlTag): void {
  sql`DROP TABLE IF EXISTS archive`
}

/** A `ref` in a tool result is one of these `seq` values. */
export function readArchiveRow<T = unknown>(sql: SqlTag, seq: number): ArchiveRow<T> | null {
  ensureTable(sql)
  const rows = sql<Row>`SELECT * FROM archive WHERE seq = ${seq}`
  return rows[0] ? toArchiveRow<T>(rows[0]) : null
}

/** Enough of a hit to tell which read it came from without paying for the read again; the cut
 *  starts half of it before the match, so the match sits in the middle of what is shown. */
const SNIPPET_CHARS = 300

/** One match, already cut down: the whole page it came from never leaves SQLite. */
export interface ToolResultMatch {
  ref: number
  at: number
  tool: string
  args: string
  /** Characters either side of the match, or the opening where the match is in `args`. */
  snippet: string
  /** The archived length, so the model can weigh reading the rest against fetching the page again. */
  total: number
}

/**
 * Substring search over archived tool results, newest first, cutting each snippet in SQL — the rows
 * carry whole pages, so cutting in JS meant loading megabytes to produce kilobytes.
 *
 * `instr` rather than `LIKE` buys two things: `%` and `_` in a model's query mean themselves, and
 * matching the extracted content rather than the stored JSON stops a quote or a newline from
 * finding the escape sequence that encodes it.
 *
 * Not FTS5, though Durable Objects offer it: an index maintained on every archived page buys word
 * search over a corpus that is one thread's own reads, and a missed word costs a re-fetch — which
 * is what the model would have done anyway.
 */
export function searchToolResults(sql: SqlTag, query: string, limit: number): ToolResultMatch[] {
  ensureTable(sql)
  const needle = query.toLowerCase()
  // `max(1, …)` because `instr` is 1-based and returns 0 for no match; a match inside `args` rather
  // than the body lands there and shows the opening, which is the right thing to show.
  // The CTE names each field once instead of extracting content four times. `EXPLAIN QUERY PLAN`
  // against Durable Object SQLite gives `SCAN archive` for this and for the flattened form alike —
  // it is not materialised, so the pages still never leave the database.
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

/** The closures that turn this table into what the tools read, over any Durable Object's SQLite.
 *  Satisfies `ToolArchive` structurally rather than importing it, so `tools/registry` keeps
 *  importing the record types from here and the dependency stays one-way. */
export function toolArchiveOver(sql: SqlTag) {
  return {
    save: (record: ToolResultRecord) => appendArchive(sql, 'tool-result', record),
    read: (ref: number) => {
      // A ref the model invented could land on a compaction row, which is not its to read.
      const row = readArchiveRow<ToolResultRecord>(sql, ref)
      return row?.type === 'tool-result' ? { ...row.data, at: row.time } : null
    },
    search: (query: string, limit: number) => searchToolResults(sql, query, limit),
  }
}
