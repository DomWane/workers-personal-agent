import type { MemoryStore } from './memory-store'

export type SqlTag = <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) => T[]

export interface MemoryIndex {
  upsert(kind: string, slug: string, text: string, sha?: string): Promise<void>
  remove(kind: string, slug: string): Promise<void>
  search(query: string, limit: number): Promise<Array<{ kind: string; slug: string; score: number }>>
  count(): Promise<number>
  /** `kind:slug` -> the vault fingerprint the stored vector was built from. */
  fingerprints(): Promise<Map<string, string>>
}

/**
 * A slug is unique only within its folder, and a memory can share one with a session — a note
 * named after the session it came out of ends up with the same slug in both. Keying rows by slug
 * alone let the two overwrite each other: every reconcile re-embedded whichever lost, and only
 * one of them was searchable at a time, flipping on each run.
 */
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
  // .slice() gives a zero-offset copy so the Float32Array view is always aligned
  return new Float32Array(u8.slice().buffer)
}

/** One embedding covers this much text. It used to be a truncation — everything past it was
 *  silently unsearchable, which measured at half the vault's characters — and is now the size of
 *  a chunk, so nothing is left out. */
const MAX_EMBED_CHARS = 1600
/** A cut lands mid-sentence and neither half then means anything; the overlap puts the sentence
 *  whole into one of the two. 12.5% is mid-range against the common splitter defaults, which sit
 *  anywhere from none to a fifth depending on the library and the version. */
const EMBED_OVERLAP_CHARS = 200

/**
 * A stored fingerprint is the vault etag *and* the split that produced the vectors. Without the
 * second half, changing the chunk size or overlap leaves every etag untouched, so a reconcile
 * reports the whole vault unchanged and keeps serving vectors built from a different split — the
 * silent-stale-vector trap the eval harness hit once, arriving here by a different route. A row
 * from another split unstamps to `''`, which the reconcile reads as changed.
 */
const SPLIT = `${MAX_EMBED_CHARS}:${EMBED_OVERLAP_CHARS}`
const stamp = (sha?: string) => (sha === undefined ? null : `${sha}@${SPLIT}`)
const unstamp = (stored: string | null) => (stored?.endsWith(`@${SPLIT}`) ? stored.slice(0, -SPLIT.length - 1) : '')

/**
 * Exported because the reindex has to know what a file will cost *before* paying for it: Workers AI
 * counts against the 50 external subrequests per invocation, and a file is no longer one of them.
 */
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
    // The index is derived data, so a schema change drops and rebuilds instead of migrating:
    // one reconcile restores it, and a migration path would have to stay correct forever.
    // A missing `sha` marks the pre-fingerprint era; fewer than three primary-key columns marks
    // the era before a file could hold more than one vector.
    const cols = this.sql<{ name: string; pk: number }>`PRAGMA table_info(memory_vectors)`
    const staleSchema = !cols.some((c) => c.name === 'sha') || cols.filter((c) => c.pk > 0).length < 3
    if (staleSchema) {
      this.sql`DROP TABLE memory_vectors`
      this
        .sql`CREATE TABLE memory_vectors (kind TEXT NOT NULL, slug TEXT NOT NULL, ord INTEGER NOT NULL, vec BLOB NOT NULL, sha TEXT, PRIMARY KEY (kind, slug, ord))`
      // Derived data silently disappearing is worth a line: a reconcile that suddenly
      // re-embeds the whole vault is otherwise indistinguishable from one that went wrong.
      console.log(JSON.stringify({ at: 'reindex', stage: 'schema-reset', cols: cols.map((c) => `${c.name}:${c.pk}`) }))
    }
  }

  async upsert(kind: string, slug: string, text: string, sha?: string): Promise<void> {
    this.ensureTable()
    // Delete first: a file that shrinks to fewer chunks would otherwise keep the old tail rows,
    // and they would go on matching queries with text the file no longer contains.
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
    // DISTINCT: every chunk of a file carries the file's stamp, and the reconcile compares per file.
    const rows = this.sql<{
      kind: string
      slug: string
      sha: string | null
    }>`SELECT DISTINCT kind, slug, sha FROM memory_vectors`
    // The manifest hands out bare etags, so the stamp is undone here rather than teaching the
    // reconcile that a fingerprint has parts.
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
    // A dataless embed (empty vector) would score every row 0 and return arbitrary
    // hits; return nothing so search_memory falls back to keyword search.
    if (q.length === 0) {
      return []
    }
    const rows = this.sql<{ kind: string; slug: string; vec: Uint8Array }>`SELECT kind, slug, vec FROM memory_vectors`
    // Fold to the best chunk per file before cutting to `limit`, or one long memory fills every
    // slot with slices of itself and crowds the others out.
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
  /** In the manifest but not readable. Its own counter: folded into `unchanged`, a vault full
   *  of broken files reported perfect health. */
  unreadable: number
  /** Files that still need indexing but did not fit; > 0 means run again. */
  remaining: number
}

/**
 * Reconciles the index against the vault, which is the source of truth. Costs two
 * directory listings plus one read and one embedding per *changed* file — a full
 * sweep would spend two subrequests per file in the vault, which is what used to
 * exhaust the invocation before it could finish.
 *
 * `canContinue` stops the sweep while the caller can still act on the report. What is
 * left over is derived from the fingerprints on the next run, so there is no cursor to
 * persist and nothing that can disagree with the vault between slices.
 *
 * It is asked about a *cost*, not a file, because a file is no longer one embedding: the entry is
 * read first (R2 through a binding spends no subrequest, measured 2026-08-06), its chunk count is
 * known, and only then is the budget consulted. A cap counted in files would have let one long
 * memory spend twenty of the fifty.
 */
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
    // Not `remaining`: it will not become readable next slice, and the chain would never end.
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
