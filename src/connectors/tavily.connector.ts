const TIMEOUT_MS = 10_000

export interface SearchResult {
  title: string
  url: string
  description: string
  /** The whole page as markdown, when the vendor sent it with the hit. Tavily does at no extra
   *  credit; Firecrawl's search would charge a scrape per result, so it never fills this. */
  raw?: string
}

/** What the model may narrow a search by. Both vendors honour both fields, each in its own wire
 *  format; `web_search` echoes what was applied so an empty result under a filter reads as filtered
 *  rather than as the web being empty. */
export interface SearchFilters {
  timeRange?: 'day' | 'week' | 'month' | 'year'
  excludeDomains?: string[]
}

/**
 * Tavily's search API, which the round prefers over Firecrawl's. It exists because of one run: a
 * wave of five scouts asked for 19 searches in a minute and Firecrawl rejected 15 of 43 across it,
 * and a rejected search reached the model as "(no results)" — which reads as a fact about the world.
 *
 * The two vendors' tiers are compared in `docs/decisions/research.md`; `basic` depth is the cheap
 * half of that comparison, and dropping to `advanced` would spend the saving it was chosen for.
 *
 * Without a key the request goes keyless: Tavily documents `X-Tavily-Access-Mode: keyless` for
 * `/search` and `/extract`, rate-limited at a number it does not publish. A key raises the limit and
 * changes nothing in the response.
 */
export async function tavilySearch(
  apiKey: string | undefined,
  query: string,
  limit = 5,
  filters: SearchFilters = {},
  doFetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args),
): Promise<SearchResult[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await doFetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : { 'x-tavily-access-mode': 'keyless' }),
      },
      body: JSON.stringify({
        query,
        search_depth: 'basic',
        max_results: limit,
        // Same credit as the bare search; measured in `docs/decisions/research.md`.
        include_raw_content: 'markdown',
        ...(filters.timeRange ? { time_range: filters.timeRange } : {}),
        ...(filters.excludeDomains?.length ? { exclude_domains: filters.excludeDomains } : {}),
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`tavily search failed: ${res.status} ${await res.text()}`)
    }
    const data = (await res.json()) as {
      results?: { title?: string; url?: string; content?: string; raw_content?: string | null }[]
    }
    return (data.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({
        title: r.title ?? '',
        url: r.url as string,
        // One whole chunk. Tavily returns `chunks_per_source` snippets of up to 500 characters and
        // joins them, so 400 — the old value, shared with Firecrawl for no reason but symmetry —
        // cut inside the first one. Measured 2026-09-01: 29 of 30 results were over it, and it kept
        // 11,743 of 35,243 characters we had already paid for.
        description: (r.content ?? '').slice(0, 500),
        ...(r.raw_content ? { raw: r.raw_content } : {}),
      }))
  } finally {
    clearTimeout(timer)
  }
}
