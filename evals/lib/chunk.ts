/**
 * Splitting a document into several vectors instead of embedding its head, as an arm of the
 * measurement rather than a shipped decision — `evals/results/chunk-cap-experiment.md` found every
 * larger single window scoring *worse*, and chunking is the one option it left untested.
 */

export type ChunkConfig = { chars: number; overlap: number }

/** Sub-chunk ids are `<parentId>#<ord>`; parent ids are 16 hex chars, so `#` cannot collide. */
export function parentOf(id: string): string {
  const i = id.indexOf('#')
  return i === -1 ? id : id.slice(0, i)
}

/**
 * Absent means no chunking, which must stay byte-identical to the pre-chunking path: it is the
 * baseline arm, and a baseline that shifted with the change under test would measure nothing.
 */
export function chunkConfigFromEnv(env: Record<string, string | undefined> = process.env): ChunkConfig | null {
  const chars = Number.parseInt(env.EVAL_CHUNK_CHARS ?? '', 10)
  if (!Number.isFinite(chars) || chars <= 0) {
    return null
  }
  const overlap = Number.parseInt(env.EVAL_CHUNK_OVERLAP ?? '200', 10)
  if (!Number.isFinite(overlap) || overlap < 0 || overlap >= chars) {
    throw new Error(`EVAL_CHUNK_OVERLAP must be >= 0 and < EVAL_CHUNK_CHARS (${chars}), got ${env.EVAL_CHUNK_OVERLAP}`)
  }
  return { chars, overlap }
}

/**
 * A fixed window with overlap, deliberately not snapped to paragraph boundaries. Boundary-aware
 * splitting is what LangChain and LlamaIndex ship, but adding it in the same step would make a null
 * result unattributable — "chunking does not help" and "this boundary rule is bad" would look the
 * same. Overlap is what covers a cut landing mid-sentence.
 */
export function splitText(text: string, { chars, overlap }: ChunkConfig): string[] {
  if (text.length <= chars) {
    return [text]
  }
  const step = chars - overlap
  const out: string[] = []
  for (let start = 0; start < text.length; start += step) {
    out.push(text.slice(start, start + chars))
    if (start + chars >= text.length) {
      break
    }
  }
  return out
}

/**
 * The one place that turns a corpus into the list actually embedded. Both the embedder and the
 * runner call it, so the vector cache's freshness checks — which compare ids, order and a hash of
 * the exact texts — keep working against chunks without knowing chunking exists.
 */
export function expandChunks(
  chunks: Array<{ id: string; text: string }>,
  cfg: ChunkConfig | null,
): Array<{ id: string; text: string }> {
  if (!cfg) {
    return chunks
  }
  return chunks.flatMap((c) => splitText(c.text, cfg).map((text, ord) => ({ id: `${c.id}#${ord}`, text })))
}
