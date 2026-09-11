import { fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { firecrawlScrape, firecrawlSearch } from '@/connectors/firecrawl.connector'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

const FC = 'https://api.firecrawl.dev'

describe('firecrawlScrape', () => {
  it('POSTs the url with bearer auth and markdown format, returns markdown', async () => {
    let sent: Record<string, unknown> | undefined
    let auth = ''
    fetchMock
      .get(FC)
      .intercept({ method: 'POST', path: '/v2/scrape' })
      .reply(
        200,
        ({ body, headers }) => {
          sent = JSON.parse(body as string)
          auth = (headers as Record<string, string>).authorization ?? (headers as Record<string, string>).Authorization
          return { success: true, data: { markdown: '# Page\n\nHello' } }
        },
        { headers: { 'content-type': 'application/json' } },
      )

    const md = await firecrawlScrape('test-fc-key', 'https://example.com/x')
    expect(md).toBe('# Page\n\nHello')
    expect(sent).toEqual({ url: 'https://example.com/x', formats: ['markdown'] })
    expect(auth).toBe('Bearer test-fc-key')
  })

  it("sends no Authorization at all when there is no key, which is Firecrawl's keyless mode", async () => {
    // Mutation check: send `Bearer undefined` and the API answers 401 instead of serving the free
    // monthly allowance.
    let auth: string | undefined = 'unset'
    fetchMock
      .get(FC)
      .intercept({ method: 'POST', path: '/v2/scrape' })
      .reply(
        200,
        ({ headers }) => {
          auth = (headers as Record<string, string>).authorization
          return { success: true, data: { markdown: 'ok' } }
        },
        { headers: { 'content-type': 'application/json' } },
      )

    await firecrawlScrape(undefined, 'https://example.com/x')
    expect(auth).toBeUndefined()
  })

  it('returns the full page so the caller can strip boilerplate before capping', async () => {
    fetchMock
      .get(FC)
      .intercept({ method: 'POST', path: '/v2/scrape' })
      .reply(
        200,
        { success: true, data: { markdown: 'x'.repeat(20_000) } },
        { headers: { 'content-type': 'application/json' } },
      )
    const md = await firecrawlScrape('k', 'https://example.com')
    expect(md.length).toBeGreaterThan(8000)
    expect(md.endsWith('…[truncated]')).toBe(false)
  })

  it('throws a descriptive error on non-2xx (e.g. 402)', async () => {
    fetchMock
      .get(FC)
      .intercept({ method: 'POST', path: '/v2/scrape' })
      .reply(402, { error: 'payment required' }, { headers: { 'content-type': 'application/json' } })
    await expect(firecrawlScrape('k', 'https://example.com')).rejects.toThrow(/firecrawl scrape failed: 402/)
  })

  it('throws when the response is 200 but success is false', async () => {
    fetchMock
      .get(FC)
      .intercept({ method: 'POST', path: '/v2/scrape' })
      .reply(200, { success: false }, { headers: { 'content-type': 'application/json' } })
    await expect(firecrawlScrape('k', 'https://example.com')).rejects.toThrow(/firecrawl scrape failed: success=false/)
  })
})

describe('firecrawlSearch', () => {
  it('POSTs the query and maps data.web to results', async () => {
    let sent: Record<string, unknown> | undefined
    fetchMock
      .get(FC)
      .intercept({ method: 'POST', path: '/v2/search' })
      .reply(
        200,
        ({ body }) => {
          sent = JSON.parse(body as string)
          return {
            success: true,
            data: { web: [{ url: 'https://a.example/', title: 'A', description: 'da', position: 1 }] },
          }
        },
        { headers: { 'content-type': 'application/json' } },
      )
    const out = await firecrawlSearch('k', 'mikolov', 5)
    expect(out).toEqual([{ url: 'https://a.example/', title: 'A', description: 'da' }])
    expect(sent).toMatchObject({ query: 'mikolov', limit: 5 })
  })

  it('spells a time range as Google tbs, which is not what the shared field is called', async () => {
    let sent: Record<string, unknown> | undefined
    fetchMock
      .get(FC)
      .intercept({ method: 'POST', path: '/v2/search' })
      .reply(
        200,
        ({ body }) => {
          sent = JSON.parse(body as string) as Record<string, unknown>
          return { success: true, data: { web: [{ url: 'https://a.example/', title: 'A', description: 'd' }] } }
        },
        { headers: { 'content-type': 'application/json' } },
      )

    await firecrawlSearch('k', 'q', 10, { timeRange: 'week', excludeDomains: ['reddit.com'] })

    // Mutation check: pass `timeRange` straight through and Firecrawl ignores it, so the model
    // narrows a search that was never narrowed and nothing says so.
    expect(sent).toMatchObject({ tbs: 'qdr:w', excludeDomains: ['reddit.com'] })
  })

  it('returns empty when the provider reports no web results', async () => {
    fetchMock
      .get(FC)
      .intercept({ method: 'POST', path: '/v2/search' })
      .reply(200, { success: true, data: {} }, { headers: { 'content-type': 'application/json' } })
    await expect(firecrawlSearch('k', 'nothing')).resolves.toEqual([])
  })
})
