import { z } from 'zod'
import { firecrawlSearch } from '../../connectors/firecrawl.connector'
import { tavilySearch, type SearchFilters, type SearchResult } from '../../connectors/tavily.connector'
import type { Env } from '../../types'
import { ORPHAN_LOG } from '../log'
import { defineTool, type ToolDef } from './registry'
import { rethrowIfExhausted } from '../subrequest-budget'

/**
 * `failures` is what separates "the web has nothing on this" from "every vendor refused us". Both
 * used to arrive at the model as `(no results)`, and it read the second as the first: on one real
 * run 15 of 43 searches were Firecrawl 429s, and the scouts that saw them wrote from memory and
 * declared their angle covered.
 */
interface SearchOutcome {
  results: SearchResult[]
  failures: string[]
}

/**
 * How many results to ask each vendor for. There is no "everything it has": Tavily returns what it
 * is asked for and only runs short once the query itself does — measured 2026-09-01 over four
 * queries, asking 20 returned 17, 19, 19 and 8.
 *
 * 10 rather than 20 because a round opens one or two pages, not nineteen, and the difference is
 * paid on every search: ~1,760 tokens against ~1,000 at five, and a wave of five scouts ran 19
 * searches in a minute. Whether more results produce better answers is unmeasured in both
 * directions.
 */
const SEARCH_RESULTS = 10

/**
 * Above the *structural* ceiling, not just the sample — the lesson of the 2,000 this replaces.
 * Ten results at 500-character snippets measured 4,748–5,979 on 2026-09-01 and can reach ~6,700 by
 * construction (10 × (500 + a title + a URL)).
 *
 * **10,000 rather than that 6,700**, because a cap that can never fire is the point: this one is a
 * tripwire for the connector's snippet slice moving, not a policy on width. Deleting it is not the
 * neutral act it looks like — the tool would inherit `DEFAULT_RESULT_CHARS` and every search would
 * be cut to 4,000, silently, which is what the inherited 2,000 already did to 8 of 8.
 */
const MAX_SEARCH_CHARS = 10_000

/**
 * The chain, in the order it is tried. Tavily leads on the two tiers compared in
 * `docs/decisions/research.md`, of which the rate limit is the one that hurt. Firecrawl stays under
 * it because a second vendor costs nothing until the first fails. Both answer without a key — each
 * connector says how — so a deploy with neither still searches, at the keyless rate limits; a key
 * only raises them. There is no scraper at the bottom: DuckDuckGo's HTML endpoint answered every
 * request from a Worker with a challenge page.
 */
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
    // Running out of budget is not Tavily failing, and the chain below would report it as one.
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
      // Every vendor refused, so nothing was learned about the topic. Reported as a tool fault and
      // never handed to onSearchResults, which would file it as a query that found nothing.
      if (results.length === 0 && failures.length > 0) {
        ;(ctx.log ?? ORPHAN_LOG).error({ at: 'web_search', stage: 'unavailable', failures })
        // Says what happened and what it does not mean. No instruction to retry: that phrasing once
        // made the model re-search until the loop ran out.
        return 'error: every search provider refused this request (rate limit or outage). This is a tool failure and says nothing about whether sources exist.'
      }
      // A result the model was shown but never opened is still a source it can honestly cite, so the
      // grounding check has to know about it or every snippet citation reads as invented.
      ctx.onSearchResults?.(
        results.map((r) => r.url),
        query,
      )
      // Says what the search actually was, rather than leaving the model to infer it from its own
      // call: an empty result under a narrowing has to read as narrowed, not as the web being empty.
      const note = asked.length ? `(${asked.join(', ')})\n\n` : ''
      // Must read as a fact, not an instruction: "try again" made the model re-search until the loop ran out.
      if (results.length === 0) {
        return `${note}(no results)`
      }
      return note + results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.description}`).join('\n\n')
    },
  }),
]
