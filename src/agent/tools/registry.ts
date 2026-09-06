import { z } from 'zod'
import type { TurnLog } from '../log'
import type { MemoryIndex } from '../memory/embedding-index'
import type { MemorySource } from '../memory/memory-store'
import type { CitationVerdict } from '../provenance'
import type { SubrequestBudget } from '../subrequest-budget'
import type { ToolResultMatch, ToolResultRecord } from '../archive'
import type { Env } from '../../types'

export interface ToolArchive {
  save(record: ToolResultRecord): number
  read(ref: number): (ToolResultRecord & { at: number }) | null
  search(query: string, limit: number): ToolResultMatch[]
}

export function pageKey(url: string): string {
  return url.replace(/#.*$/, '').replace(/\/+$/, '')
}

export interface ToolContext {
  env: Env
  agent?: SchedulerLike
  index?: Pick<MemoryIndex, 'search' | 'remove' | 'upsert'>
  budget?: SubrequestBudget
  source?: MemorySource
  verifyCitation?: (thread: string, turn: string) => Promise<CitationVerdict>
  log?: TurnLog
  pendingReport?: () => string | undefined
  toolArchive?: ToolArchive
  onPageRead?: (url: string, ok: boolean) => void
  onSearchResults?: (urls: string[], query: string) => void
  pageCache?: Map<string, string>
  alreadyTried?: (url: string) => boolean
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

export interface ToolDef {
  name: string
  description: string
  params: z.ZodType
  handler(args: never, ctx: ToolContext): Promise<string>
  timeoutMs?: number
  maxResultChars?: number
  noArchive?: boolean
}

export function defineTool<S extends z.ZodType>(
  def: Omit<ToolDef, 'params' | 'handler'> & {
    params: S
    handler: (args: z.infer<S>, ctx: ToolContext) => Promise<string>
  },
): ToolDef {
  return def as ToolDef
}

export function toolSpec(tool: ToolDef) {
  const { $schema: _unused, ...parameters } = z.toJSONSchema(tool.params, { io: 'input' }) as Record<string, unknown>
  return { type: 'function' as const, function: { name: tool.name, description: tool.description, parameters } }
}

export const recoverableAt = (ref: number, note: string) => `[kept whole as ref ${ref}; ${note}]`
export const REF_MARKER = /\[kept whole as ref (\d+);/

const TAIL_SHARE = 0.2

export const DEFAULT_RESULT_CHARS = 4000

export function truncate(s: string, max = DEFAULT_RESULT_CHARS): string {
  if (s.length <= max) {
    return s
  }
  // `slice(-0)` is the whole string.
  const tail = Math.max(1, Math.floor(max * TAIL_SHARE))
  const head = max - tail
  return `${s.slice(0, head)}\n…[${s.length - max} characters cut from the middle]…\n${s.slice(-tail)}`
}
