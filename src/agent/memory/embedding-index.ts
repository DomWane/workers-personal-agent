import type { MemoryStore } from './memory-store'

export type SqlTag = <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) => T[]

export interface MemoryIndex {
  upsert(kind: string, slug: string, text: string, sha?: string): Promise<void>
  remove(kind: string, slug: string): Promise<void>
  search(query: string, limit: number): Promise<Array<{ kind: string; slug: string; score: number }>>
  count(): Promise<number>
  fingerprints(): Promise<Map<string, string>>
}

export function indexKey(kind: string, slug: string): string {
  return `${kind}:${slug}`
}

export function cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) {
    return 0
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export function serializeVec(v: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(v).buffer)
}

export function deserializeVec(buf: Uint8Array | ArrayBuffer): Float32Array {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return new Float32Array(u8.slice().buffer)
}

const MAX_EMBED_CHARS = 1600
const EMBED_OVERLAP_CHARS = 200

const SPLIT = `${MAX_EMBED_CHARS}:${EMBED_OVERLAP_CHARS}`
const stamp = (sha?: string) => (sha === undefined ? null : `${sha}@${SPLIT}`)
const unstamp = (stored: string | null) => (stored?.endsWith(`@${SPLIT}`) ? stored.slice(0, -SPLIT.length - 1) : '')

export function chunkForEmbedding(text: string): string[] {
  if (text.length <= MAX_EMBED_CHARS) {
    return [text]
  }
  const step = MAX_EMBED_CHARS - EMBED_OVERLAP_CHARS
  const out: string[] = []
  for (let start = 0; start < text.length; start += step) {
    out.push(text.slice(start, start + MAX_EMBED_CHARS))
    if (start + MAX_EMBED_CHARS >= text.length) {
      break
    }
  }
  return out
}

export class EmbeddingIndex implements MemoryIndex {
  constructor(
    private sql: SqlTag,
    private embed: (text: string) => Promise<number[]>,
  ) {}

  private ensureTable(): void {
    this
      .sql`CREATE TABLE IF NOT EXISTS memory_vectors (kind TEXT NOT NULL, slug TEXT NOT NULL, ord INTEGER NOT NULL, vec BLOB NOT NULL, sha TEXT, PRIMARY KEY (kind, slug, ord))`
    const cols = this.sql<{ name: string; pk: number }>`PRAGMA table_info(memory_vectors)`
    const staleSchema = !cols.some((c) => c.name === 'sha') || cols.filter((c) => c.pk > 0).length < 3
    if (staleSchema) {
      this.sql`DROP TABLE memory_vectors`
      this
        .sql`CREATE TABLE memory_vectors (kind TEXT NOT NULL, slug TEXT NOT NULL, ord INTEGER NOT NULL, vec BLOB NOT NULL, sha TEXT, PRIMARY KEY (kind, slug, ord))`
      console.log(JSON.stringify({ at: 'reindex', stage: 'schema-reset', cols: cols.map((c) => `${c.name}:${c.pk}`) }))
    }
  }

  async upsert(kind: string, slug: string, text: string, sha?: string): Promise<void> {
    this.ensureTable()
    await this.remove(kind, slug)
    const chunks = chunkForEmbedding(text)
    for (const [ord, chunk] of chunks.entries()) {
      const vec = serializeVec(await this.embed(chunk))
      this
        .sql`INSERT OR REPLACE INTO memory_vectors (slug, kind, ord, vec, sha) VALUES (${slug}, ${kind}, ${ord}, ${vec}, ${stamp(sha)})`
    }
  }

  async fingerprints(): Promise<Map<string, string>> {
    this.ensureTable()
    const rows = this.sql<{
      kind: string
      slug: string
      sha: string | null
    }>`SELECT DISTINCT kind, slug, sha FROM memory_vectors`
    return new Map(rows.map((r) => [indexKey(r.kind, r.slug), unstamp(r.sha)]))
  }

  async remove(kind: string, slug: string): Promise<void> {
    this.ensureTable()
    this.sql`DELETE FROM memory_vectors WHERE kind = ${kind} AND slug = ${slug}`
  }

  async count(): Promise<number> {
    this.ensureTable()
    const rows = this.sql<{ n: number }>`SELECT count(*) AS n FROM memory_vectors`
    return rows[0]?.n ?? 0
  }

  async search(query: string, limit: number): Promise<Array<{ kind: string; slug: string; score: number }>> {
    this.ensureTable()
    const q = await this.embed(query.slice(0, MAX_EMBED_CHARS))
    if (q.length === 0) {
      return []
    }
    const rows = this.sql<{ kind: string; slug: string; vec: Uint8Array }>`SELECT kind, slug, vec FROM memory_vectors`
    const best = new Map<string, { kind: string; slug: string; score: number }>()
    for (const r of rows) {
      const score = cosineSimilarity(q, deserializeVec(r.vec))
      const key = indexKey(r.kind, r.slug)
      const prev = best.get(key)
      if (!prev || score > prev.score) {
        best.set(key, { kind: r.kind, slug: r.slug, score })
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit)
  }
}

export interface ReindexReport {
  indexed: number
  removed: number
  unchanged: number
  unreadable: number
  remaining: number
}

export async function reindexInto(
  index: MemoryIndex,
  store: Pick<MemoryStore, 'indexManifest' | 'readEntry'>,
  canContinue: (cost: number) => boolean = () => true,
): Promise<ReindexReport> {
  const manifest = await store.indexManifest()
  const known = await index.fingerprints()
  const live = new Set(manifest.map((m) => indexKey(m.kind, m.slug)))

  let removed = 0
  for (const key of known.keys()) {
    if (!live.has(key)) {
      const sep = key.indexOf(':')
      await index.remove(key.slice(0, sep), key.slice(sep + 1))
      removed++
    }
  }

  let indexed = 0
  let unchanged = 0
  let unreadable = 0
  let remaining = 0
  for (const m of manifest) {
    if (known.get(indexKey(m.kind, m.slug)) === m.sha) {
      unchanged++
      continue
    }
    const entry = await store.readEntry(m.kind, m.slug)
    if (!entry) {
      unreadable++
      continue
    }
    const text = m.kind === 'memory' ? `${entry.name}\n${entry.description}\n${entry.content}` : entry.content
    if (!canContinue(chunkForEmbedding(text).length)) {
      remaining++
      continue
    }
    await index.upsert(m.kind, m.slug, text, m.sha)
    indexed++
  }

  return { indexed, removed, unchanged, unreadable, remaining }
}
