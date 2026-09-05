const TIMEOUT_MS = 10_000

export async function fetchPageMarkdown(
  accountId: string,
  apiToken: string,
  url: string,
  doFetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args),
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await doFetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/markdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`read_page failed: ${res.status} ${await res.text()}`)
    }
    const data = (await res.json()) as { success: boolean; result?: string; errors?: unknown }
    if (!data.success) {
      throw new Error('read_page failed: cloudflare returned success=false')
    }
    const md = data.result ?? ''
    return md
  } finally {
    clearTimeout(timer)
  }
}
