import { R2VaultConnector } from '../../connectors/r2-vault.connector'
import type { Env, Thread } from '../../types'
import type {
  IndexedKind,
  MemoryEntry,
  MemorySource,
  MemoryStore,
  ProfileOp,
  SkillEntry,
  SkillMeta,
} from './memory-store'
import {
  MAX_CONTENT_CHARS,
  parseFrontmatter,
  parseIndexLines,
  parseMemoryFile,
  renderFrontmatter,
  renderSkillFile,
  slugCandidates,
  slugify,
  toSkillMeta,
} from './vault-format'

const INDEX_HEADER = '# Agent memory'
const MAX_MEMORY_RESULTS = 3
export const USER_PROFILE_MAX = 1300
export const AGENT_NOTES_MAX = 2000
const MAX_SESSION_RESULTS = 2
const MAX_SKILLS = 30

function collapseNewlines(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ')
}

function fmValue(s: string): string {
  return sanitize(collapseNewlines(s))
}

export function sanitize(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
}

export interface VaultBackend {
  getFile(path: string): Promise<{ content: string; sha: string } | null>
  putFile(path: string, content: string, message: string, sha?: string): Promise<void>
  listDir(path: string): Promise<{ name: string; sha: string }[]>
  deleteFile(path: string, message: string, sha: string): Promise<void>
}

export class VaultStore implements MemoryStore {
  constructor(
    private vault: VaultBackend,
    private dir: string,
    private today?: string,
  ) {}

  private memPath(slug: string): string {
    return `${this.dir}/memory/${slug}.md`
  }
  private indexPath(): string {
    return `${this.dir}/MEMORY.md`
  }
  private sessionPath(slug: string): string {
    return `${this.dir}/sessions/${slug}.md`
  }
  private researchPath(slug: string): string {
    return `${this.dir}/research/${slug}.md`
  }
  private profilePath(): string {
    return `${this.dir}/USER.md`
  }
  private agentNotesPath(): string {
    return `${this.dir}/AGENT.md`
  }
  private threadsPath(): string {
    return `${this.dir}/threads.json`
  }
  private skillPath(slug: string): string {
    return `${this.dir}/skills/${slug}.md`
  }

  private todayStr(): string {
    return this.today ?? new Date().toISOString().slice(0, 10)
  }

  async listThreads(): Promise<Thread[]> {
    return this.readThreads().then((r) => r.threads)
  }

  private async readThreads(): Promise<{ threads: Thread[]; sha?: string }> {
    const file = await this.vault.getFile(this.threadsPath())
    if (!file) {
      return { threads: [] }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(file.content)
    } catch (err) {
      throw new Error(`${this.threadsPath()} is not valid JSON: ${(err as Error).message}`, { cause: err })
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${this.threadsPath()} is not an array`)
    }
    return { threads: parsed as Thread[], sha: file.sha }
  }

  async touchThread(id: string, title?: string): Promise<void> {
    const { threads, sha } = await this.readThreads()
    const existing = threads.find((t) => t.id === id)
    const at = Date.now()
    if (existing) {
      existing.at = at
      if (title && !existing.title) {
        existing.title = title
      }
    } else {
      threads.push({ id, title: title ?? '', at })
    }
    await this.vault.putFile(this.threadsPath(), `${JSON.stringify(threads, null, 2)}\n`, `threads: ${id}`, sha)
  }

  async renameThread(id: string, title: string): Promise<void> {
    const { threads, sha } = await this.readThreads()
    const existing = threads.find((t) => t.id === id)
    if (existing) {
      existing.title = title
    } else {
      threads.push({ id, title, at: Date.now() })
    }
    await this.vault.putFile(this.threadsPath(), `${JSON.stringify(threads, null, 2)}\n`, `threads: rename ${id}`, sha)
  }

  async removeThread(id: string): Promise<void> {
    const { threads, sha } = await this.readThreads()
    if (!sha) {
      return
    }
    const left = threads.filter((t) => t.id !== id)
    await this.vault.putFile(this.threadsPath(), `${JSON.stringify(left, null, 2)}\n`, `threads: -${id}`, sha)
  }

  async save(entry: MemoryEntry & { source: MemorySource }): Promise<string> {
    const name = fmValue(entry.name)
    const description = fmValue(entry.description)
    const slug = slugify(name) || 'untitled'
    const fm = [
      `name: ${name}`,
      `description: ${description}`,
      `date: ${this.todayStr()}`,
      `source_thread: ${fmValue(entry.source.thread)}`,
    ]
    if (entry.source.turn) {
      fm.push(`source_turn: ${fmValue(entry.source.turn)}`)
    }
    fm.push(`source_at: ${entry.source.at}`)
    const file = renderFrontmatter(fm, sanitize(entry.content))

    const existing = await this.vault.getFile(this.memPath(slug))
    await this.vault.putFile(this.memPath(slug), file, `memory: ${slug}`, existing?.sha)

    const index = await this.vault.getFile(this.indexPath())
    const line = `- ${slug} — ${description}`
    let lines = (index?.content ?? `${INDEX_HEADER}\n`).trimEnd().split('\n')
    const i = lines.findIndex((l) => l.startsWith(`- ${slug} — `))
    if (i >= 0) {
      lines[i] = line
    } else {
      if (lines.length === 1) {
        lines.push('')
      }
      lines.push(line)
    }
    await this.vault.putFile(this.indexPath(), `${lines.join('\n')}\n`, `memory index: ${slug}`, index?.sha)
    return existing ? `updated memory "${slug}"` : `saved memory "${slug}"`
  }

  async search(query: string): Promise<MemoryEntry[]> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return [...(await this.searchMemories(words)), ...(await this.searchSessions(words))]
  }

  private async searchMemories(words: string[]): Promise<MemoryEntry[]> {
    const index = await this.vault.getFile(this.indexPath())
    const matches = parseIndexLines(index?.content ?? '')
      .filter((x) => words.some((w) => x.slug.includes(w) || x.description.toLowerCase().includes(w)))
      .slice(0, MAX_MEMORY_RESULTS)

    const entries: MemoryEntry[] = []
    for (const m of matches) {
      const f = await this.vault.getFile(this.memPath(m.slug))
      if (f) {
        entries.push(parseMemoryFile(f.content))
      }
    }
    return entries
  }

  private async searchSessions(words: string[]): Promise<MemoryEntry[]> {
    try {
      const sessions = await this.vault.listDir(`${this.dir}/sessions`)
      const hits = sessions
        .filter((s) => s.name.endsWith('.md'))
        .filter((s) => words.some((w) => s.name.toLowerCase().includes(w)))
        .sort((a, b) => b.name.localeCompare(a.name))
        .slice(0, MAX_SESSION_RESULTS)

      const entries: MemoryEntry[] = []
      for (const s of hits) {
        const f = await this.vault.getFile(`${this.dir}/sessions/${s.name}`)
        if (!f) {
          continue
        }
        entries.push({
          name: s.name.replace(/\.md$/, ''),
          description: 'past session summary',
          content: f.content.trim().slice(0, MAX_CONTENT_CHARS),
        })
      }
      return entries
    } catch (err) {
      console.error('[vault-store] session search failed', err)
      return []
    }
  }

  async list(): Promise<string> {
    const index = await this.vault.getFile(this.indexPath())
    return index?.content ?? '(no memories saved yet)'
  }

  async saveResearch(topic: string, report: string): Promise<string> {
    const clean = fmValue(topic)
    const base = `${this.todayStr()}-${slugify(clean) || 'research'}`
    let slug = base
    for (let n = 2; await this.vault.getFile(this.researchPath(slug)); n++) {
      slug = `${base}-${n}`
    }
    await this.vault.putFile(this.researchPath(slug), `# ${clean}\n\n${sanitize(report)}\n`, `research: ${slug}`)
    return slug
  }

  async getUserProfile(): Promise<string> {
    const f = await this.vault.getFile(this.profilePath())
    return f?.content.trim() ?? ''
  }

  private async updateBounded(
    path: string,
    max: number,
    op: ProfileOp,
    text: string,
    replaceWith?: string,
  ): Promise<string> {
    const f = await this.vault.getFile(path)
    const current = f?.content.trim() ?? ''
    const t = sanitize(text).trim()
    if (!t) {
      return 'error: text must not be empty'
    }

    let next: string
    if (op === 'add') {
      next = current ? `${current}\n${t}` : t
    } else {
      if (!current.includes(t)) {
        return `error: text not found: "${t.slice(0, 80)}"\ncurrent content:\n${current}`
      }
      const replacement = op === 'replace' ? sanitize(replaceWith ?? '').trim() : ''
      if (op === 'replace' && !replacement) {
        return 'error: replace requires replace_with'
      }
      next = current
        .replace(t, replacement)
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+$/gm, '')
        .trim()
    }

    if (next.length > max) {
      return `error: profile would be ${next.length}/${max} chars — consolidate first: replace or remove less important lines, move details to save_memory`
    }
    await this.vault.putFile(path, `${next}\n`, `notes: ${op}`, f?.sha)
    return `profile updated (${next.length}/${max} chars)`
  }

  async updateUserProfile(op: ProfileOp, text: string, replaceWith?: string): Promise<string> {
    return this.updateBounded(this.profilePath(), USER_PROFILE_MAX, op, text, replaceWith)
  }

  async getAgentNotes(): Promise<string> {
    const f = await this.vault.getFile(this.agentNotesPath())
    return f?.content.trim() ?? ''
  }

  async updateAgentNotes(op: ProfileOp, text: string, replaceWith?: string): Promise<string> {
    return this.updateBounded(this.agentNotesPath(), AGENT_NOTES_MAX, op, text, replaceWith)
  }

  async saveSkill(entry: MemoryEntry): Promise<string> {
    const name = fmValue(entry.name)
    const description = fmValue(entry.description)
    const slug = slugify(name) || 'untitled'
    const existing = await this.vault.getFile(this.skillPath(slug))
    const prev = existing ? parseFrontmatter(existing.content).fm : undefined

    const fm: Record<string, string> = {
      name,
      description,
      date: prev?.date ?? this.todayStr(),
      use_count: prev?.use_count ?? '0',
    }
    if (prev?.last_used) {
      fm.last_used = prev.last_used
    }
    if (prev?.pinned === 'true') {
      fm.pinned = 'true'
    }

    await this.vault.putFile(
      this.skillPath(slug),
      renderSkillFile(fm, sanitize(entry.content).trim()),
      `skill: ${slug}`,
      existing?.sha,
    )
    return existing ? `updated skill "${slug}"` : `saved skill "${slug}"`
  }

  async listSkills(): Promise<SkillMeta[]> {
    const entries = await this.vault.listDir(`${this.dir}/skills`)
    const all = entries.filter((e) => e.name.endsWith('.md'))
    const mdFiles = all.slice(0, MAX_SKILLS)
    if (all.length > mdFiles.length) {
      console.log(JSON.stringify({ at: 'vault', stage: 'skills-truncated', total: all.length, listed: mdFiles.length }))
    }
    const metas = await Promise.all(
      mdFiles.map(async (e) => {
        const slug = e.name.replace(/\.md$/, '')
        const f = await this.vault.getFile(this.skillPath(slug))
        return f ? toSkillMeta(slug, parseFrontmatter(f.content).fm) : null
      }),
    )
    return metas.filter((m): m is SkillMeta => m !== null)
  }

  async readSkill(name: string): Promise<SkillEntry | null> {
    let slug = ''
    let f: { content: string; sha: string } | null = null
    for (const c of slugCandidates(name)) {
      f = await this.vault.getFile(this.skillPath(c))
      if (f) {
        slug = c
        break
      }
    }
    if (!f) {
      return null
    }
    const { fm, body } = parseFrontmatter(f.content)
    const meta = toSkillMeta(slug, fm)
    try {
      const stamped = { ...fm, use_count: String(meta.useCount + 1), last_used: this.todayStr() }
      await this.vault.putFile(this.skillPath(slug), renderSkillFile(stamped, body), `skill use: ${slug}`, f.sha)
    } catch (err) {
      console.error('[vault-store] skill stamp failed', err)
    }
    return { ...meta, content: body }
  }

  async archiveSkill(slug: string): Promise<string> {
    const f = await this.vault.getFile(this.skillPath(slug))
    if (!f) {
      return `error: skill not found: ${slug}`
    }
    const archivePath = `${this.dir}/skills/archive/${slug}.md`
    const existing = await this.vault.getFile(archivePath)
    await this.vault.putFile(archivePath, f.content, `archive skill: ${slug}`, existing?.sha)
    await this.vault.deleteFile(this.skillPath(slug), `archive skill: ${slug}`, f.sha)
    return `archived skill "${slug}"`
  }

  async resolveMemorySlug(name: string): Promise<string> {
    const candidates = slugCandidates(name)
    for (const slug of candidates) {
      if (await this.vault.getFile(this.memPath(slug))) {
        return slug
      }
    }
    return candidates[candidates.length - 1]
  }

  async archiveMemory(slug: string, grounds?: MemorySource): Promise<string> {
    const f = await this.vault.getFile(this.memPath(slug))
    if (!f) {
      return `error: memory not found: ${slug}`
    }
    const archivePath = `${this.dir}/memory/archive/${slug}.md`
    const existing = await this.vault.getFile(archivePath)
    const content = grounds ? withArchiveGrounds(f.content, grounds) : f.content
    await this.vault.putFile(archivePath, content, `archive memory: ${slug}`, existing?.sha)
    await this.vault.deleteFile(this.memPath(slug), `archive memory: ${slug}`, f.sha)

    const index = await this.vault.getFile(this.indexPath())
    if (index) {
      const kept = index.content.split('\n').filter((l) => !l.startsWith(`- ${slug} — `))
      await this.vault.putFile(
        this.indexPath(),
        `${kept.join('\n').trimEnd()}\n`,
        `memory index: archive ${slug}`,
        index.sha,
      )
    }
    return `archived memory "${slug}"`
  }

  async readEntry(kind: IndexedKind, slug: string): Promise<MemoryEntry | null> {
    if (kind === 'memory') {
      const f = await this.vault.getFile(this.memPath(slug))
      return f ? parseMemoryFile(f.content) : null
    }
    const path = kind === 'research' ? this.researchPath(slug) : this.sessionPath(slug)
    const f = await this.vault.getFile(path)
    if (!f) {
      return null
    }
    const description = kind === 'research' ? 'research report' : 'past session summary'
    return { name: slug, description, content: f.content.trim().slice(0, MAX_CONTENT_CHARS) }
  }

  async indexManifest(): Promise<Array<{ kind: IndexedKind; slug: string; sha: string }>> {
    const [memories, sessions, research] = await Promise.all([
      this.vault.listDir(`${this.dir}/memory`),
      this.vault.listDir(`${this.dir}/sessions`),
      this.vault.listDir(`${this.dir}/research`),
    ])
    const md = (files: { name: string; sha: string }[], kind: IndexedKind) =>
      files.filter((f) => f.name.endsWith('.md')).map((f) => ({ kind, slug: f.name.replace(/\.md$/, ''), sha: f.sha }))
    return [...md(memories, 'memory'), ...md(sessions, 'session'), ...md(research, 'research')]
  }
}

function withArchiveGrounds(raw: string, grounds: MemorySource): string {
  const added = [`archived_at: ${grounds.at}`, `archived_because_thread: ${fmValue(grounds.thread)}`]
  if (grounds.turn) {
    added.push(`archived_because_turn: ${fmValue(grounds.turn)}`)
  }
  return raw.replace(/^---\n/, `---\n${added.join('\n')}\n`)
}

export function createMemoryStore(env: Env): MemoryStore {
  return new VaultStore(new R2VaultConnector(env.VAULT), env.VAULT_AGENT_DIR)
}
