import { onScopeDispose, ref, watch, type Ref } from 'vue'
import { AgentClient } from 'agents/client'
import { toast } from './useToasts'
import type { AgentState } from './types'

/** How long a not-yet-open socket gets before an RPC gives up on it. A handshake, not a call: the
 *  slow ones — a compaction runs tens of seconds — are on a socket that is already open, which is
 *  what makes a bound safe here and unsafe around `socket.call`. */
const HANDSHAKE_MS = 5_000

/**
 * One WebSocket to the PersonalAgent Durable Object holding this thread.
 *
 * The name sent here is only the thread: the Worker rewrites the segment to
 * `web:{identity}:{folder}:{thread}` before routing, so identity and folder cannot be chosen from
 * the browser — a client that could pick its whole name could address any DO in the namespace.
 */
export function useAgent(thread: Ref<string>, closed: Ref<string | null>) {
  const state = ref<AgentState>({ messages: [] })
  const connected = ref(false)
  let socket: AgentClient<unknown, AgentState>
  /** Every RPC waits on this. Without it the first message after a connect — a page load, or a
   *  thread switch — races the handshake and is sent on a socket that is not open yet. */
  let ready: Promise<void>

  function connect(): void {
    socket = new AgentClient<unknown, AgentState>({
      agent: 'personal-agent',
      name: thread.value,
      host: location.host,
      onStateUpdate: (next) => {
        if (next) {
          state.value = next
        }
      },
    })
    ready = new Promise<void>((resolve) => {
      // Not `{ once: true }`: `partysocket` reconnects this same client and dispatches `open`
      // again, so a one-shot listener left `connected` false forever after the first idle drop and
      // `rpc` refused to send on a socket that was fine. Re-resolving `ready` is a no-op.
      socket.addEventListener('open', () => {
        connected.value = true
        resolve()
      })
    })
    socket.addEventListener('close', () => (connected.value = false))
  }
  connect()

  // A thread is a different Durable Object, so switching means a new socket rather than a message
  // on the old one. Synchronous, because the ref *is* the connection's identity: a caller that
  // switches and immediately sends must not be answered by the thread it just left. The blank
  // state matters too — the previous thread's messages left on screen under a new title read as
  // the new thread already having them.
  watch(
    thread,
    () => {
      socket.close()
      connected.value = false
      state.value = { messages: [] }
      if (!closed.value) {
        connect()
      }
    },
    { flush: 'sync' },
  )

  /** `AgentClient` reconnects on its own, so a refused deployment retries forever — a
   *  `stage: 'refused'` line every few seconds. Reopening on clear is what makes Try again work. */
  watch(closed, (why) => {
    if (why) {
      socket.close()
      connected.value = false
    } else {
      connect()
    }
  })

  onScopeDispose(() => socket.close())

  /**
   * Every failure gets a toast, here rather than at each call site: an RPC that rejects used to
   * leave a console line and a UI still showing the rename, the delete or the rating as done.
   *
   * It answers `false` rather than throwing. Every one of these sits behind a click, and a click
   * that raises an unhandled rejection is a console line again; a caller that has something to
   * undo — or a navigation to skip — reads the answer instead.
   *
   * The disconnected case is checked rather than timed out. A dropped socket makes `call` wait for
   * a reconnection that may never come — measured with the Worker stopped: the click vanished and
   * nothing was reported — while a timeout short enough to catch that would also fire on a
   * compaction, which legitimately takes tens of seconds.
   */
  async function rpc(method: string, args: unknown[] = [], what = 'That did not go through'): Promise<boolean> {
    // Refusing on `connected` alone comes too early: the thread watcher reconnects synchronously,
    // so the message that *caused* the switch was refused before `ready` was ever awaited, and
    // every first message from the landing page was lost. Waiting costs nothing on a dropped
    // socket — `ready` is then the old connection's, resolved, so the race returns at once.
    if (!connected.value) {
      await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, HANDSHAKE_MS))])
    }
    if (!connected.value) {
      toast(`${what}. Not connected to the agent — check that it is running, then try again.`)
      return false
    }
    try {
      await socket.call(method, args)
      return true
    } catch (err) {
      toast(`${what}. ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /** Everything the user types. A leading slash is not special here: the only one left names a
   *  saved skill, and the turn resolves it. */
  const say = (text: string) => rpc('enqueueWebMessage', [text.trim()], 'The message was not sent')

  /** `null` is back to the deployment's own model, which the picker must always be able to offer. */
  const setModel = (id: string | null) => rpc('setModel', [id], 'The model was not switched')

  const research = {
    propose: (topic: string) => rpc('proposeResearch', [topic], 'The research was not proposed'),
    revise: (note: string) => rpc('revisePlan', [note], 'The plan was not revised'),
    start: () => rpc('startResearch', [], 'The research did not start'),
    stop: () => rpc('stopResearch', [], 'The research was not stopped'),
    save: () => rpc('saveResearch', [], 'The report was not saved'),
  }

  /** Clears the thread's history and drops it from the registry; the caller decides where to go
   *  next, because this instance has nothing left to show. */
  const deleteThread = () => rpc('deleteThread', [], 'The chat was not deleted')
  const renameThread = (title: string) => rpc('renameThread', [title], 'The chat was not renamed')
  /** Deliberate compaction. Nothing is returned: the folded thread arrives as broadcast state,
   *  the same way it does when the threshold fires it. */
  const compactNow = () => rpc('compactNow', [], 'The chat was not compacted')
  /** The rating lands in the thread's archive, not in broadcast state — it has to outlive the
   *  compaction that will eventually evict the message it judges. */
  const rateMessage = (id: string, rating: 'up' | 'down' | 'none', note?: string) =>
    rpc('rateMessage', [id, rating, note], 'The rating was not recorded')

  return { state, connected, say, setModel, research, deleteThread, renameThread, compactNow, rateMessage }
}
