import { z } from 'zod'
import { firecrawlSearch } from '../../connectors/firecrawl.connector'
import { tavilySearch, type SearchFilters, type SearchResult } from '../../connectors/tavily.connector'
import type { Env } from '../../types'
import { ORPHAN_LOG } from '../log'
import { defineTool, pageKey, type ToolDef } from './registry'
import { rethrowIfExhausted } from '../subrequest-budget'

interface SearchOutcome {
  results: SearchResult[]
  failures: string[]
}

const SEARCH_RESULTS = 10

const MAX_SEARCH_CHARS = 10_000

async function search(
  query: string,
  env: Pick<Env, 'TAVILY_API_KEY' | 'FIRECRAWL_API_KEY'>,
  filters: SearchFilters,
  doFetch?: typeof globalThis.fetch,
): Promise<SearchOutcome> {
  const failures: string[] = []
  try {
    const hits = await tavilySearch(env.TAVILY_API_KEY, query, SEARCH_RESULTS, filters, doFetch)
    if (hits.length > 0) {
      return { results: hits, failures }
    }
  } catch (err) {
    rethrowIfExhausted(err)
    failures.push(`tavily: ${String(err).slice(0, 120)}`)
  }
  try {
    const hits = await firecrawlSearch(env.FIRECRAWL_API_KEY, query, SEARCH_RESULTS, filters, doFetch)
    if (hits.length > 0) {
      return { results: hits, failures }
    }
  } catch (err) {
    rethrowIfExhausted(err)
    failures.push(`firecrawl: ${String(err).slice(0, 120)}`)
  }
  return { results: [], failures }
}

export const searchTools: ToolDef[] = [
  defineTool({
    name: 'web_search',
    description: 'Search the web for current information. Returns top results with titles, URLs and snippets.',
    params: z.object({
      query: z.string().describe('The search query'),
      time_range: z
        .enum(['day', 'week', 'month', 'year'])
        .optional()
        .describe('Only results published within this period. Omit unless the question is about recent events.'),
      exclude_domains: z
        .array(z.string())
        .optional()
        .describe('Hostnames to drop from the results, e.g. ["reddit.com"]. No protocol, no path.'),
    }),
    maxResultChars: MAX_SEARCH_CHARS,
    handler: async ({ query, time_range, exclude_domains }, ctx) => {
      const filters: SearchFilters = { timeRange: time_range, excludeDomains: exclude_domains }
      const asked = [
        time_range ? `published within the last ${time_range}` : '',
        exclude_domains?.length ? `excluding ${exclude_domains.join(', ')}` : '',
      ].filter(Boolean)
      const { results, failures } = await search(query, ctx.env, filters, ctx.budget?.fetch)
      if (results.length === 0 && failures.length > 0) {
        ;(ctx.log ?? ORPHAN_LOG).error({ at: 'web_search', stage: 'unavailable', failures })
        return 'error: every search provider refused this request (rate limit or outage). This is a tool failure and says nothing about whether sources exist.'
      }
      ctx.onSearchResults?.(
        results.map((r) => r.url),
        query,
      )
      let cached = 0
      for (const r of results) {
        if (r.raw && ctx.pageCache) {
          ctx.pageCache.set(pageKey(r.url), r.raw)
          cached++
        }
      }
      const note = asked.length ? `(${asked.join(', ')})\n\n` : ''
      if (results.length === 0) {
        return `${note}(no results)`
      }
      const footer = cached ? `\n\n(read_page returns ${cached} of these whole without a fetch)` : ''
      return note + results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.description}`).join('\n\n') + footer
    },
  }),
]
