const TIMEOUT_MS = 10_000

export interface SearchResult {
  title: string
  url: string
  description: string
  raw?: string
}

export interface SearchFilters {
  timeRange?: 'day' | 'week' | 'month' | 'year'
  excludeDomains?: string[]
}

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
        description: (r.content ?? '').slice(0, 500),
        ...(r.raw_content ? { raw: r.raw_content } : {}),
      }))
  } finally {
    clearTimeout(timer)
  }
}
