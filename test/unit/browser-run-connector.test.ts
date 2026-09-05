import { fetchMock } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { fetchPageMarkdown } from '../../src/connectors/browser-run.connector'

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => fetchMock.assertNoPendingInterceptors())

const CF = 'https://api.cloudflare.com'

describe('fetchPageMarkdown', () => {
  it('POSTs the url with bearer auth and returns markdown', async () => {
    let sent: Record<string, unknown> | undefined
    let auth = ''
    fetchMock
      .get(CF)
      .intercept({ method: 'POST', path: '/client/v4/accounts/test-account/browser-rendering/markdown' })
      .reply(
        200,
        ({ body, headers }) => {
          sent = JSON.parse(body as string)
          auth = (headers as Record<string, string>).authorization ?? (headers as Record<string, string>).Authorization
          return { success: true, result: '# Page\n\nHello' }
        },
        { headers: { 'content-type': 'application/json' } },
      )

    const md = await fetchPageMarkdown('test-account', 'test-cf-token', 'https://example.com/x')
    expect(md).toBe('# Page\n\nHello')
    expect(sent).toEqual({ url: 'https://example.com/x' })
    expect(auth).toBe('Bearer test-cf-token')
  })

  it('returns the full page so the caller can strip boilerplate before capping', async () => {
    fetchMock
      .get(CF)
      .intercept({ method: 'POST', path: '/client/v4/accounts/test-account/browser-rendering/markdown' })
      .reply(200, { success: true, result: 'x'.repeat(20_000) }, { headers: { 'content-type': 'application/json' } })
    const md = await fetchPageMarkdown('test-account', 't', 'https://example.com')
    expect(md.length).toBeGreaterThan(8000)
    expect(md.endsWith('…[truncated]')).toBe(false)
  })

  it('throws a descriptive error on failure responses', async () => {
    fetchMock
      .get(CF)
      .intercept({ method: 'POST', path: '/client/v4/accounts/test-account/browser-rendering/markdown' })
      .reply(
        429,
        { success: false, errors: [{ message: 'daily browser time exhausted' }] },
        { headers: { 'content-type': 'application/json' } },
      )
    await expect(fetchPageMarkdown('test-account', 't', 'https://example.com')).rejects.toThrow(/read_page failed: 429/)
  })

  it('throws when the response is 200 but success is false', async () => {
    fetchMock
      .get(CF)
      .intercept({ method: 'POST', path: '/client/v4/accounts/test-account/browser-rendering/markdown' })
      .reply(
        200,
        { success: false, errors: [{ message: 'could not render page' }] },
        { headers: { 'content-type': 'application/json' } },
      )
    await expect(fetchPageMarkdown('test-account', 't', 'https://example.com')).rejects.toThrow(/read_page failed/)
  })
})
