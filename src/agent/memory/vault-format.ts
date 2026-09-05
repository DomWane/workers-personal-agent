import type { MemoryEntry, SkillMeta } from './memory-store'

/**
 * How the vault's files are named, and how they are written and read back — pure text, no R2 and
 * no `this`, so the rules of the format can be read and tested against string literals.
 *
 * `sanitize` and the two helpers over it stayed in `vault-store.ts`: they guard what a model may
 * put in a file, which is the write path's concern rather than the format's.
 */

/** How much of one file's body reaches a prompt. Silent — nothing tells the model it was cut. */
export const MAX_CONTENT_CHARS = 4000

/** Shared by both spellings below so a change to one can never drift from the other. */
function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function slugify(name: string): string {
  // a trailing -YYYY-MM-DD is a naming artifact that breaks update-in-place; drop it
  return normalise(name).replace(/-\d{4}-\d{2}-\d{2}$/, '')
}

/**
 * Naming and finding are different operations: trimming the date on the way *in* once archived
 * `open-follow-ups` for a request aimed at `open-follow-ups-2026-07-07`. Lookups try the name as
 * given first, the trimmed form second.
 */
export function slugCandidates(name: string): string[] {
  const untrimmed = normalise(name)
  const trimmed = slugify(name)
  return untrimmed && untrimmed !== trimmed ? [untrimmed, trimmed] : [trimmed || name]
}

/** MEMORY.md is `- slug — description`, one per memory. Its header and any prose are skipped. */
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

// Stable key order keeps vault diffs reviewable across stamp/update rewrites.
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
    // Absent on every memory written before provenance existed, which is most of the vault: an
    // unsourced memory is old, not suspect, and the gate that cares says so where it matters.
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
