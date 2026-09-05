/** Multilingual embeddings (handles Czech + cross-lingual) via Workers AI bge-m3. */
export async function embedText(ai: Ai, text: string, budget?: { charge(n?: number): void }): Promise<number[]> {
  // A binding call is a subrequest like any fetch, and this one runs inside the tool loop.
  budget?.charge()
  // `truncate_inputs: false` is Cloudflare's documented default — error rather than silently drop
  // the tail. Callers chunk to 1600 chars, so it can only fire if that ever stops being true, which
  // is exactly when a quiet half-embedding would be worst.
  const res = (await ai.run('@cf/baai/bge-m3', { text: [text], truncate_inputs: false })) as { data?: number[][] }
  return res.data?.[0] ?? []
}
