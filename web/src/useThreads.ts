import { onScopeDispose, ref } from 'vue'
import type { Thread } from './types'

/**
 * The thread list, and which one is open.
 *
 * The open thread lives in the URL rather than in a store: it survives a reload, it can be sent to
 * another tab, and the back button then works without any history of our own.
 *
 * The list itself comes from the server (`agent/threads.json` in the vault) rather than from
 * `localStorage`, because a Durable Object namespace cannot be enumerated — a cleared browser
 * store would leave every conversation alive and permanently unreachable.
 */
/**
 * Where the client sits when no chat is open. It is a real thread id server-side — the Worker
 * defaults to it and a Durable Object exists under that name — but nothing is ever sent to it, so
 * it never reaches the registry and never appears in the list.
 */
export const LANDING = 'main'

export function useThreads() {
  const threads = ref<Thread[]>([])
  const current = ref(new URLSearchParams(location.search).get('t') || LANDING)
  /** Why the agent is refusing, when it is. The app loads before the Worker refuses anything, so
   *  without this the UI is a chat that silently does nothing — a bug, not a missing step. */
  const closed = ref<string | null>(null)

  async function refresh(): Promise<void> {
    try {
      const res = await fetch('/api/threads')
      const body: unknown = await res.json()
      if (!res.ok) {
        // The refusal is the only non-2xx worth rendering; anything else is a transient the next
        // refresh retries.
        const fail = body as { error?: string; detail?: string }
        if (fail.error === 'closed' && fail.detail) {
          closed.value = fail.detail
        }
        return
      }
      closed.value = null
      threads.value = body as Thread[]
    } catch {
      // Keep the last list: it is navigation rather than content, so a stale sidebar is better
      // than an empty one, and the next refresh retries anyway.
    }
  }
  void refresh()

  function open(id: string): void {
    if (id === current.value) {
      return
    }
    const url = new URL(location.href)
    url.searchParams.set('t', id)
    history.pushState({}, '', url)
    current.value = id
  }

  const onPop = () => {
    current.value = new URLSearchParams(location.search).get('t') || LANDING
  }
  addEventListener('popstate', onPop)
  onScopeDispose(() => removeEventListener('popstate', onPop))

  /**
   * A new thread is a name, not a request: the Durable Object comes into being when the first
   * message reaches it, and the registry row is written then too. So this only navigates, and an
   * abandoned empty thread leaves nothing behind to clean up.
   */
  function create(): void {
    open(`t-${Date.now().toString(36)}`)
  }

  return { threads, current, closed, open, create, refresh }
}
