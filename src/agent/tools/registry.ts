import { z } from 'zod'
import type { TurnLog } from '../log'
import type { MemoryIndex } from '../memory/embedding-index'
import type { MemorySource } from '../memory/memory-store'
import type { CitationVerdict } from '../provenance'
import type { SubrequestBudget } from '../subrequest-budget'
import type { ToolResultMatch, ToolResultRecord } from '../archive'
import type { Env } from '../../types'

/**
 * Keeping a whole tool result and getting it back. An interface rather than the `SqlTag` itself so
 * a test can hand the loop a Map, and so nothing under `tools/` needs to know there is a database.
 */
export interface ToolArchive {
  /** Returns the ref the model quotes back to `read_tool_result`. */
  save(record: ToolResultRecord): number
  /** `at` rides along on both reads: a page's age is what decides whether to fetch it again. */
  read(ref: number): (ToolResultRecord & { at: number }) | null
  /** Snippets, not rows: the whole page a hit came from is never loaded to produce one. */
  search(query: string, limit: number): ToolResultMatch[]
}

/** The model asks for `…/playwright/` when the search returned `…/playwright`: on one real run
 *  four of eight rate-limited fetches were slash or fragment variants of a page already held. */
export function pageKey(url: string): string {
  return url.replace(/#.*$/, '').replace(/\/+$/, '')
}

/** What tool handlers get. `agent` is the DO instance (loosely typed for testability). */
export interface ToolContext {
  env: Env
  /** Absent where there is nothing to schedule on — a research scout runs search and browser tools
   *  in a Durable Object with no alarms of its own. The schedule tools say so rather than throw. */
  agent?: SchedulerLike
  /** The semantic index, held by the maintenance instance and reached over RPC; absent in unit
   *  tests → keyword fallback. Narrowed to what a turn may do: reconciling is not one. */
  index?: Pick<MemoryIndex, 'search' | 'remove' | 'upsert'>
  /** Per-invocation subrequest budget; absent in unit tests → unmetered. */
  budget?: SubrequestBudget
  /** What a memory written here can name as its source. Absent where nothing can be pointed at —
   *  a research scout — and `save_memory` refuses rather than writing an unsourced fact. */
  source?: MemorySource
  /** Resolves a cited turn against the thread that claims to hold it. Absent where no thread can be
   *  reached, and the destructive-write gate then refuses instead of taking the citation on trust. */
  verifyCitation?: (thread: string, turn: string) => Promise<CitationVerdict>
  /** Turn-scoped logger; absent in unit tests → records fall back to the orphan envelope. */
  log?: TurnLog
  /** The finished report the user has not filed yet. A closure rather than the text itself: a turn
   *  that never asks must not carry it, and it can change between rounds of the same turn. */
  pendingReport?: () => string | undefined
  /** The instance's own store of whole tool results — a thread's, or a scout's for the life of the
   *  run. Absent only in a bare context, where the loop then just truncates. */
  toolArchive?: ToolArchive
  /** Notified for each page a fetch was *attempted* on, with whether it produced content. A
   *  research round needs the exact URLs to deduplicate across rounds, and the tool loop does not
   *  report tool arguments. Failures are reported too: a page that could not be fetched has still
   *  been paid for, and retrying it every round pays again. */
  onPageRead?: (url: string, ok: boolean) => void
  /** Every URL a search put in front of the model, opened or not, with the query that found them.
   *  Separate from `onPageRead` because these cost no fetch and must not count as pages read; the
   *  query rides along because a search that returns nothing is only diagnosable with it. */
  onSearchResults?: (urls: string[], query: string) => void
  /** Whole pages a search brought back beside its hits, keyed by `pageKey`, so that `read_page`
   *  on one of them is a lookup rather than a fetch. Absent, every read pays a subrequest as before. */
  pageCache?: Map<string, string>
  /** True for a page this run has already paid for, successfully or not. The prompt only shows a
   *  window of the visited list, so asking the model not to re-read is not what stops a charge. */
  alreadyTried?: (url: string) => boolean
  /**
   * The window of the model that will be sent this result. See `resultCap`.
   *
   * **Absent means unknown, not small** — the opposite of `DEFAULT_CONTEXT_TOKENS`, because
   * guessing 24k would silently cut nine tenths off every page read on the 1.31M default model.
   */
  contextTokens?: number
}

export interface SchedulerLike {
  schedule(when: Date | string | number, callback: string, payload?: unknown): Promise<{ id: string }>
  listSchedules(): Promise<ScheduleInfo[]>
  cancelSchedule(id: string): Promise<boolean>
}

export interface ScheduleInfo {
  id: string
  callback: string
  payload: unknown
  time: number
  type: string
}

/**
 * One tool. `params` is both the schema shown to the model and the parser its reply goes through,
 * so the advertised contract and the enforced one cannot drift.
 *
 * `never` erases the argument shape so a heterogeneous `ToolDef[]` type-checks; `defineTool`
 * recovers it where the handler is written.
 */
export interface ToolDef {
  name: string
  description: string
  params: z.ZodType
  handler(args: never, ctx: ToolContext): Promise<string>
  /** Overrides the loop's default per-tool timeout, for handlers that chain connectors. */
  timeoutMs?: number
  /** Overrides the loop's default result cap, for tools whose value is in the volume they return. */
  maxResultChars?: number
  /** For a tool whose result already came out of the archive. Without it the loop files the copy
   *  under a second ref, spending a row and offering the model a duplicate of what it just read. */
  noArchive?: boolean
}

/** Keeps the handler's parameter typed by the schema beside it, without annotating it by hand. */
export function defineTool<S extends z.ZodType>(
  def: Omit<ToolDef, 'params' | 'handler'> & {
    params: S
    handler: (args: z.infer<S>, ctx: ToolContext) => Promise<string>
  },
): ToolDef {
  return def as ToolDef
}

/** What the model is shown. `$schema` is dropped — no provider reads it and it costs tokens. */
export function toolSpec(tool: ToolDef) {
  const { $schema: _unused, ...parameters } = z.toJSONSchema(tool.params, { io: 'input' }) as Record<string, unknown>
  return { type: 'function' as const, function: { name: tool.name, description: tool.description, parameters } }
}

/**
 * The sentence that makes a tool result prunable: the loop shortens only what says where the whole
 * of it can be read back, because without that the middle would be gone for good.
 *
 * Two things can say it truthfully — the archiver that has just filed a result, and
 * `read_tool_result`, which has just read one *out* of the archive and therefore knows the same ref.
 * The format lives here rather than in either, so a change to the wording cannot make the reader
 * silently stop matching the writer.
 */
export const recoverableAt = (ref: number, note: string) => `[kept whole as ref ${ref}; ${note}]`
export const REF_MARKER = /\[kept whole as ref (\d+);/

const TAIL_SHARE = 0.2

/** What a tool result is cut to when its tool names no cap of its own. */
export const DEFAULT_RESULT_CHARS = 4000

/**
 * Head *and* tail, four fifths to one. Head-only is what this did, and it loses the end of every
 * document — where an article puts its conclusion and a tool result its outcome. Kept as a ratio
 * rather than the two absolute sizes it came from, so it holds at any `max`.
 *
 * The marker names the number of characters removed, because "…[truncated]" cannot be told apart
 * from a document that ends in an ellipsis, and a model reading a gap needs to know it is one.
 */
export function truncate(s: string, max = DEFAULT_RESULT_CHARS): string {
  if (s.length <= max) {
    return s
  }
  // At least one: `slice(-0)` is the whole string, so a cap small enough to floor the tail to zero
  // returned the input untouched under a marker saying it had been cut.
  const tail = Math.max(1, Math.floor(max * TAIL_SHARE))
  const head = max - tail
  return `${s.slice(0, head)}\n…[${s.length - max} characters cut from the middle]…\n${s.slice(-tail)}`
}
