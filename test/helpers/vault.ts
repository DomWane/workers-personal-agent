import { env } from 'cloudflare:test'
import type { Env } from '@/types'

/**
 * Seeds the R2 vault for a test. The suite used to register GitHub HTTP interceptors for
 * every vault read; R2 goes through a binding, so there is nothing to intercept and the
 * bucket itself is the fixture. A file that is simply absent is the "404" case — it needs
 * no setup at all, which is why most tests get shorter rather than longer.
 *
 * The Workers pool isolates storage per test, so nothing has to be torn down.
 */
export async function seedVault(files: Record<string, string>): Promise<void> {
  const bucket = (env as Env).VAULT
  await Promise.all(Object.entries(files).map(([key, body]) => bucket.put(key, body)))
}

export async function readVault(key: string): Promise<string | null> {
  const obj = await (env as Env).VAULT.get(key)
  return obj ? obj.text() : null
}

export async function listVault(prefix: string): Promise<string[]> {
  const page = await (env as Env).VAULT.list({ prefix })
  return page.objects.map((o) => o.key).sort()
}

export function memoryFile(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\ndate: 2026-07-01\n---\n\n${body}\n`
}

export function skillFile(fm: Record<string, string>, body: string): string {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`)
  return `---\n${lines.join('\n')}\n---\n\n${body}\n`
}
