import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('worker', () => {
  // The root is the asset server's, not the Worker's: `run_worker_first` lists only the API
  // prefixes, so `/` is served from public/ and the old Worker health check there was unreachable.
  // Asserted on the mount point and not the title: public/ is `pnpm build:web` output now, so a
  // title assertion would break every time the page is renamed.
  it('serves the web client from assets at the root', async () => {
    const res = await SELF.fetch('http://agent/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<div id="app">')
  })
})
