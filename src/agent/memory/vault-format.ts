import type { MemoryEntry, SkillMeta } from './memory-store'

export const MAX_CONTENT_CHARS = 4000

function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function slugify(name: string): string {
  return normalise(name).replace(/-\d{4}-\d{2}-\d{2}$/, '')
}

export function slugCandidates(name: string): string[] {
  const untrimmed = normalise(name)
  const trimmed = slugify(name)
  return untrimmed && untrimmed !== trimmed ? [untrimmed, trimmed] : [trimmed || name]
}

export function parseIndexLines(content: string): { slug: string; description: string }[] {
  return content
    .split('\n')
    .map((l) => l.match(/^- (\S+) — (.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ slug: m[1], description: m[2] }))
}

export function renderFrontmatter(lines: string[], body: string): string {
  return `---\n${lines.join('\n')}\n---\n\n${body}\n`
}

export function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?\n?([\s\S]*)$/)
  const fm: Record<string, string> = {}
  for (const line of (m?.[1] ?? '').split('\n')) {
    const kv = line.match(/^([\w-]+): (.*)$/)
    if (kv) {
      fm[kv[1]] = kv[2]
    }
  }
  return { fm, body: (m?.[2] ?? raw).trim() }
}

const SKILL_FM_KEYS = ['name', 'description', 'date', 'use_count', 'last_used', 'pinned'] as const

export function renderSkillFile(fm: Record<string, string>, body: string): string {
  return renderFrontmatter(
    SKILL_FM_KEYS.filter((k) => fm[k] !== undefined).map((k) => `${k}: ${fm[k]}`),
    body,
  )
}

export function toSkillMeta(slug: string, fm: Record<string, string>): SkillMeta {
  return {
    slug,
    name: fm.name ?? slug,
    description: fm.description ?? '',
    useCount: Number(fm.use_count ?? 0) || 0,
    lastUsed: fm.last_used,
    date: fm.date,
    pinned: fm.pinned === 'true',
  }
}

export function parseMemoryFile(raw: string): MemoryEntry {
  const { fm, body } = parseFrontmatter(raw)
  return {
    name: fm.name ?? '',
    description: fm.description ?? '',
    content: body.slice(0, MAX_CONTENT_CHARS),
    ...(fm.source_thread
      ? {
          source: {
            thread: fm.source_thread,
            ...(fm.source_turn ? { turn: fm.source_turn } : {}),
            at: Number(fm.source_at) || 0,
          },
        }
      : {}),
  }
}
