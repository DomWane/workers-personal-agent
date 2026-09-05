/**
 * A web instance is named `web:<identity>:<folder>:<thread>`. The client picks only the thread;
 * identity and folder are server-chosen, because a client that could choose its whole name could
 * address any Durable Object in the namespace.
 *
 * The folder is always `home` until folders land. It ships now regardless: a Durable Object's name
 * cannot be changed afterwards without stranding the instance and everything in it.
 */
const DEFAULT_FOLDER = 'home'
const DEFAULT_THREAD = 'main'

/** Constant until Cloudflare Access JWT verification lands. Here rather than in the Worker because
 *  the nightly reflection has to build the same names from the thread registry. */
export const WEB_IDENTITY = 'dev-user'

/** Anything that could add a segment or escape the prefix falls back to the default thread rather
 *  than 404ing: a bad id is a client bug, and a working default is more useful than an error. */
export function threadId(raw: string | undefined): string {
  return raw && /^[a-z0-9-]{1,40}$/.test(raw) ? raw : DEFAULT_THREAD
}

export function webAgentName(identity: string, thread: string | undefined): string {
  return `web:${identity}:${DEFAULT_FOLDER}:${threadId(thread)}`
}

/** The thread an instance belongs to, or undefined for one whose name has no thread segment —
 *  `dev:*`, and the maintenance instances. */
export function threadOf(agentName: string): string | undefined {
  const parts = agentName.split(':')
  return parts[0] === 'web' ? parts[3] : undefined
}
