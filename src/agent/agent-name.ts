const DEFAULT_FOLDER = 'home'
const DEFAULT_THREAD = 'main'

export const WEB_IDENTITY = 'dev-user'

export function threadId(raw: string | undefined): string {
  return raw && /^[a-z0-9-]{1,40}$/.test(raw) ? raw : DEFAULT_THREAD
}

export function webAgentName(identity: string, thread: string | undefined): string {
  return `web:${identity}:${DEFAULT_FOLDER}:${threadId(thread)}`
}

export function threadOf(agentName: string): string | undefined {
  const parts = agentName.split(':')
  return parts[0] === 'web' ? parts[3] : undefined
}
