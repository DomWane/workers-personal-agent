import type { Thread } from '../../types'
export interface MemoryEntry {
  name: string
  description: string
  content: string
  source?: MemorySource
}

export interface MemorySource {
  thread: string
  turn?: string
  at: number
}

export type ProfileOp = 'add' | 'replace' | 'remove'

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
  archiveMemory(slug: string, grounds?: MemorySource): Promise<string>
  resolveMemorySlug(name: string): Promise<string>
  readEntry(kind: IndexedKind, slug: string): Promise<MemoryEntry | null>
  saveResearch(topic: string, report: string): Promise<string>
  indexManifest(): Promise<Array<{ kind: IndexedKind; slug: string; sha: string }>>
  listThreads(): Promise<Thread[]>
  touchThread(id: string, title?: string): Promise<void>
  renameThread(id: string, title: string): Promise<void>
  removeThread(id: string): Promise<void>
}
