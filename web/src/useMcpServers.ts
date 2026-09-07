import { onScopeDispose, ref } from 'vue'
import type { McpAddResponse, McpConnectResponse, McpServer, McpServersResponse } from './types/mcp'

function errorOf(res: Response, body: unknown): string {
  const detail = (body as { error?: string } | null)?.error
  return detail || `request failed (${res.status})`
}

const POPUP = 'popup=yes,width=640,height=720'

/**
 * The MCP server list behind the settings dialog, and the calls that mutate it. The dialog polls
 * while any server is mid-sign-in: the OAuth callback closes its popup in the browser, and this
 * poll is what notices the registry went READY on the server side.
 */
export function useMcpServers() {
  const servers = ref<McpServer[]>([])
  const busy = ref(false)
  const error = ref<string | null>(null)
  let timer: ReturnType<typeof setInterval> | null = null

  function stopPolling(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function pollWhileAuthenticating(): void {
    if (servers.value.some((s) => s.state === 'authenticating')) {
      timer ??= setInterval(() => {
        void refresh()
      }, 2000)
    } else {
      stopPolling()
    }
  }

  async function refresh(): Promise<void> {
    try {
      const res = await fetch('/api/mcp/servers')
      const body: unknown = await res.json()
      if (!res.ok) {
        error.value = errorOf(res, body)
        return
      }
      error.value = null
      servers.value = (body as McpServersResponse).servers
      pollWhileAuthenticating()
    } catch {
      // Keep the last list: the next refresh retries, and the dialog already has something to show.
    }
  }
  void refresh()

  /** One mutating call: the Worker's `{ error }` lands in `error`, anything else comes back parsed.
   *  The refresh is not awaited, so a sign-in popup opened right after this still counts as the
   *  user's click and is not blocked. */
  async function mutate<T>(path: string, init: RequestInit): Promise<T | null> {
    error.value = null
    busy.value = true
    try {
      const res = await fetch(path, init)
      const body: unknown = await res.json()
      if (!res.ok) {
        error.value = errorOf(res, body)
        return null
      }
      return body as T
    } finally {
      busy.value = false
      void refresh()
    }
  }

  const openSignIn = (authUrl: string | null | undefined) => {
    if (authUrl) {
      window.open(authUrl, '_blank', POPUP)
    }
  }

  async function add(name: string, url: string, bearer?: string): Promise<McpServer | null> {
    const body = await mutate<McpAddResponse>('/api/mcp/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, url, bearer: bearer?.trim() || undefined }),
    })
    openSignIn(body?.server.authUrl)
    return body?.server ?? null
  }

  async function connect(id: string): Promise<void> {
    const body = await mutate<McpConnectResponse>(`/api/mcp/servers/${encodeURIComponent(id)}/connect`, {
      method: 'POST',
    })
    openSignIn(body?.authUrl)
  }

  async function remove(id: string): Promise<void> {
    await mutate(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  onScopeDispose(stopPolling)

  return { servers, busy, error, refresh, add, connect, remove }
}
