import type { Thread } from '../../types'
export interface MemoryEntry {
  name: string
  description: string
  content: string
  /** Where the memory came from. Absent on entries *read* back from before provenance existed;
   *  required to write one, because a fact with no source cannot be checked against anything. */
  source?: MemorySource
}

/** A pointer into the conversation that produced a memory: `turn` resolves against the thread's
 *  live surface first, its archive second. */
export interface MemorySource {
  thread: string
  turn?: string
  at: number
}

export type ProfileOp = 'add' | 'replace' | 'remove'

/** What the embedding index keys on alongside a slug. A memory and a session can share a slug,
 *  and now a research report can share one with either. */
export type IndexedKind = 'memory' | 'session' | 'research'

export interface SkillMeta {
  slug: string
  name: string
  description: string
  useCount: number
  lastUsed?: string
  date?: string
  pinned: boolean
}

export interface SkillEntry extends SkillMeta {
  content: string
}

export interface MemoryStore {
  save(entry: MemoryEntry & { source: MemorySource }): Promise<string>
  search(query: string): Promise<MemoryEntry[]>
  list(): Promise<string>
  getUserProfile(): Promise<string>
  updateUserProfile(op: ProfileOp, text: string, replaceWith?: string): Promise<string>
  getAgentNotes(): Promise<string>
  updateAgentNotes(op: ProfileOp, text: string, replaceWith?: string): Promise<string>
  listSkills(): Promise<SkillMeta[]>
  readSkill(name: string): Promise<SkillEntry | null>
  saveSkill(entry: MemoryEntry): Promise<string>
  archiveSkill(slug: string): Promise<string>
  /** `grounds` is the verified citation that justified destroying it, filed with the memory. */
  archiveMemory(slug: string, grounds?: MemorySource): Promise<string>
  resolveMemorySlug(name: string): Promise<string>
  readEntry(kind: IndexedKind, slug: string): Promise<MemoryEntry | null>
  /** A finished research report, kept whole and indexed like anything else in the vault. */
  saveResearch(topic: string, report: string): Promise<string>
  /** One listing per folder: what the search index should hold, and each file's fingerprint. */
  indexManifest(): Promise<Array<{ kind: IndexedKind; slug: string; sha: string }>>
  /** The thread registry. A DO namespace cannot be listed, so this is the only route back to a
   *  conversation whose id is not written down somewhere. */
  listThreads(): Promise<Thread[]>
  touchThread(id: string, title?: string): Promise<void>
  renameThread(id: string, title: string): Promise<void>
  removeThread(id: string): Promise<void>
}
