import type { Chunk } from './corpus.ts'

/** Czech is routinely typed without diacritics, and a lookup that missed "ucet" would be useless. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // combining marks, escaped so the source survives copy/paste
    .toLowerCase()
}

export type SearchMode =
  | { kind: 'terms'; terms: string[] }
  | { kind: 'period'; prefix: string }
  | { kind: 'project'; name: string }
  | { kind: 'give-up' }

/** `/2026-07` and `/projekt x` locate a chunk by when or where, never by the words of the query. */
export function parseSearch(raw: string): SearchMode {
  const s = raw.trim()
  if (s === '' || s === '.') {
    return { kind: 'give-up' }
  }
  const project = s.match(/^\/(?:projekt|project)\s+(.+)$/i)
  if (project) {
    return { kind: 'project', name: project[1].trim() }
  }
  if (s.startsWith('/')) {
    return { kind: 'period', prefix: s.slice(1).trim() }
  }
  return { kind: 'terms', terms: s.split(/\s+/).filter(Boolean) }
}

/**
 * Deliberately an unranked AND-filter. Ordering these hits by relevance would mean running a
 * retriever, and the labeller would then pick the target off the top of a list that retriever
 * chose — the hard set would end up scoring it against its own suggestions. Chronological order
 * carries no opinion about which chunk answers the query.
 */
export function findByTerms(chunks: Chunk[], terms: string[]): Chunk[] {
  const needles = terms.map(fold).filter(Boolean)
  if (needles.length === 0) {
    return []
  }
  return byTime(
    chunks.filter((c) => {
      const hay = fold(`${c.text} ${c.project}`)
      return needles.every((n) => hay.includes(n))
    }),
  )
}

export function findByPeriod(chunks: Chunk[], prefix: string): Chunk[] {
  if (!prefix) {
    return []
  }
  return byTime(chunks.filter((c) => c.ts.startsWith(prefix)))
}

export function findByProject(chunks: Chunk[], name: string): Chunk[] {
  const needle = fold(name)
  if (!needle) {
    return []
  }
  return byTime(chunks.filter((c) => fold(c.project).includes(needle)))
}

/** Undated chunks sort last rather than first, so a missing timestamp cannot head the list. */
function byTime(chunks: Chunk[]): Chunk[] {
  return [...chunks].sort((a, b) => (a.ts || '￿').localeCompare(b.ts || '￿'))
}

/**
 * A window around the first hit rather than a fixed head: chunks open with the human prompt, so
 * a head preview shows near-identical openings and hides the very text that matched.
 */
/**
 * Browsing by date has no term to centre on, and the head of a chunk is the human turn — which is
 * routinely "y", "podivej se" or "base staging". Listing those identifies nothing, so the reply is
 * what gets shown: it is the half that says what the exchange was about.
 */
export function replyPreview(text: string, width = 220): string {
  const parts = text.split('\n\n')
  const cut = (s: string, n: number) => {
    const flat = s.replace(/\s+/g, ' ').trim()
    return flat.length > n ? `${flat.slice(0, n)}…` : flat
  }
  // A chunk with no reply half has nothing to pair the prompt with, and echoing it twice reads
  // as two different fields holding the same text.
  if (parts.length === 1) {
    return cut(text, width)
  }
  return `${cut(parts[0], 45)} → ${cut(parts.slice(1).join(' '), width)}`
}

export function preview(text: string, terms: string[], width = 220): string {
  const flat = text.replace(/\s+/g, ' ')
  const hay = fold(flat)
  const hits = terms.map((t) => hay.indexOf(fold(t))).filter((i) => i >= 0)
  const at = hits.length ? Math.min(...hits) : 0
  const start = Math.max(0, at - Math.floor(width / 3))
  const body = flat.slice(start, start + width)
  return `${start > 0 ? '…' : ''}${body}${start + width < flat.length ? '…' : ''}`
}
