import type { SearchFilters } from './tavily.connector'

const TIMEOUT_MS = 10_000

export interface FirecrawlSearchResult {
  title: string
  url: string
  description: string
}

/** Firecrawl spells a time range as Google's `tbs`, so the shared field has to be mapped. */
const TBS: Record<NonNullable<SearchFilters['timeRange']>, string> = {
  day: 'qdr:d',
  week: 'qdr:w',
  month: 'qdr:m',
  year: 'qdr:y',
}

/** Firecrawl is keyless since 2026-06-16: a request with no `Authorization` draws on a free monthly
 *  allowance the launch post puts at 1,000 credits, and a key is only what raises it. */
function headers(apiKey: string | undefined): Record<string, string> {
  return { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }
}

export async function firecrawlSearch(
  apiKey: string | undefined,
  query: string,
  limit = 5,
  filters: SearchFilters = {},
  doFetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args),
): Promise<FirecrawlSearchResult[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await doFetch('https://api.firecrawl.dev/v2/search', {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({
        query,
        limit,
        ...(filters.timeRange ? { tbs: TBS[filters.timeRange] } : {}),
        ...(filters.excludeDomains?.length ? { excludeDomains: filters.excludeDomains } : {}),
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`firecrawl search failed: ${res.status} ${await res.text()}`)
    }
    const data = (await res.json()) as { success: boolean; data?: { web?: FirecrawlSearchResult[] } }
    if (!data.success) {
      throw new Error('firecrawl search failed: success=false')
    }
    return (data.data?.web ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      description: (r.description ?? '').slice(0, 500),
    }))
  } finally {
    clearTimeout(timer)
  }
}

export async function firecrawlScrape(
  apiKey: string | undefined,
  url: string,
  doFetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args),
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await doFetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({ url, formats: ['markdown'] }),
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`firecrawl scrape failed: ${res.status} ${await res.text()}`)
    }
    const data = (await res.json()) as { success: boolean; data?: { markdown?: string } }
    if (!data.success) {
      throw new Error('firecrawl scrape failed: success=false')
    }
    const md = data.data?.markdown ?? ''
    return md
  } finally {
    clearTimeout(timer)
  }
}
