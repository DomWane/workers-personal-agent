import { fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { tavilySearch } from '@/connectors/tavily.connector'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

const TV = 'https://api.tavily.com'

function reply(body: unknown, status = 200) {
  const seen: { sent?: Record<string, unknown>; auth?: string; mode?: string } = {}
  fetchMock
    .get(TV)
    .intercept({ method: 'POST', path: '/search' })
    .reply(
      status,
      ({ body: b, headers }) => {
        seen.sent = JSON.parse(b as string)
        const h = headers as Record<string, string>
        seen.auth = h.authorization ?? h.Authorization
        seen.mode = h['x-tavily-access-mode']
        return body
      },
      { headers: { 'content-type': 'application/json' } },
    )
  return seen
}

describe('tavilySearch', () => {
  it('POSTs the query with bearer auth at basic depth', async () => {
    // basic is 1 credit and advanced is 2, which is what Firecrawl already charged: the saving
    // lives entirely in the cheaper tier.
    const seen = reply({ results: [{ title: 'T', url: 'https://a.example', content: 'snippet' }] })

    const out = await tavilySearch('tvly-key', 'agent stopping criteria', 5)

    expect(seen.auth).toBe('Bearer tvly-key')
    expect(seen.mode).toBeUndefined()
    expect(seen.sent).toMatchObject({ query: 'agent stopping criteria', search_depth: 'basic', max_results: 5 })
    expect(out).toEqual([{ title: 'T', url: 'https://a.example', description: 'snippet' }])
  })

  it('asks for keyless access instead of sending an empty bearer when there is no key', async () => {
    // Mutation check: send `Bearer undefined` and Tavily answers 401; the keyless header is what
    // the docs name for /search, and it is the only way a deploy without the secret can search.
    const seen = reply({ results: [{ title: 'T', url: 'https://a.example', content: 'snippet' }] })

    await tavilySearch(undefined, 'agent stopping criteria', 5)

    expect(seen.auth).toBeUndefined()
    expect(seen.mode).toBe('keyless')
  })

  it('maps content to description, which is the shape the round already reads', async () => {
    reply({ results: [{ title: 'T', url: 'https://a.example', content: 'x'.repeat(900) }] })
    const out = await tavilySearch('k', 'q')
    // One whole chunk of the three Tavily joins, each up to 500. At 400 the cut landed inside the
    // first one and kept a third of what the search had already paid for: 29 of 30 results measured
    // 2026-09-01 were over it.
    expect(out[0].description).toHaveLength(500)
  })

  it('asks for the whole page with every hit, and hands it on as raw', async () => {
    // Same one credit and one subrequest as the bare search (probed keyless 2026-09-06). Mutation
    // check: drop `include_raw_content` and `raw` is never filled, so every read_page pays again.
    const seen = reply({
      results: [
        { title: 'T', url: 'https://a.example', content: 'snippet', raw_content: '# Whole page' },
        { title: 'U', url: 'https://b.example', content: 'snippet', raw_content: null },
      ],
    })

    const out = await tavilySearch('k', 'q')

    expect(seen.sent).toMatchObject({ include_raw_content: 'markdown' })
    expect(out[0].raw).toBe('# Whole page')
    expect(out[1]).not.toHaveProperty('raw')
  })

  it('passes the filters the model asked for, in the vendor spelling', async () => {
    const seen = reply({ results: [{ title: 'T', url: 'https://a.example', content: 'c' }] })

    await tavilySearch('k', 'q', 10, { timeRange: 'week', excludeDomains: ['reddit.com'] })

    // Mutation check: drop the spread and these are absent — the model would narrow a search that
    // was never narrowed, and read what came back as the web's answer.
    expect(seen.sent).toMatchObject({ time_range: 'week', exclude_domains: ['reddit.com'] })
  })

  it('sends no filter keys at all when the model asked for none', async () => {
    const seen = reply({ results: [{ title: 'T', url: 'https://a.example', content: 'c' }] })

    await tavilySearch('k', 'q')

    expect(seen.sent).not.toHaveProperty('time_range')
    expect(seen.sent).not.toHaveProperty('exclude_domains')
  })

  it('drops a result with no url rather than emitting an empty one', async () => {
    reply({
      results: [
        { title: 'no url', content: 'x' },
        { title: 'T', url: 'https://a.example' },
      ],
    })
    const out = await tavilySearch('k', 'q')
    expect(out.map((r) => r.url)).toEqual(['https://a.example'])
  })

  it('returns nothing when the response carries no results', async () => {
    reply({})
    expect(await tavilySearch('k', 'q')).toEqual([])
  })

  it('throws with the status, so the caller can tell a rate limit from an outage', async () => {
    fetchMock
      .get(TV)
      .intercept({ method: 'POST', path: '/search' })
      .reply(429, 'Your request has been blocked due to excessive requests.')

    await expect(tavilySearch('k', 'q')).rejects.toThrow(/tavily search failed: 429/)
  })
})
