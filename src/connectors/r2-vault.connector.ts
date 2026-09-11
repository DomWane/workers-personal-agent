import type { VaultEntry, VaultMeta } from '@/agent/memory/vault-store'

export class R2VaultConnector {
  constructor(private bucket: R2Bucket) {}

  async getFile(path: string): Promise<{ content: string; sha: string } | null> {
    const obj = await this.bucket.get(path)
    if (!obj) {
      return null
    }
    return { content: await obj.text(), sha: obj.etag }
  }

  async putFile(path: string, content: string, _message: string, sha?: string, meta?: VaultMeta): Promise<void> {
    const res = await this.bucket.put(path, content, {
      onlyIf: sha ? { etagMatches: sha } : undefined,
      customMetadata: meta,
    })
    if (sha && res === null) {
      throw new Error(`r2 putFile conflict: ${path} changed since it was read`)
    }
  }

  async listDir(path: string): Promise<VaultEntry[]> {
    const prefix = `${path}/`
    const out: VaultEntry[] = []
    let cursor: string | undefined
    do {
      const page = await this.bucket.list({
        prefix,
        delimiter: '/',
        cursor,
        include: ['customMetadata'],
      } as R2ListOptions)
      for (const obj of page.objects) {
        out.push({ name: obj.key.slice(prefix.length), sha: obj.etag, meta: obj.customMetadata })
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return out
  }

  async deleteFile(path: string, _message: string, _sha: string): Promise<void> {
    await this.bucket.delete(path)
  }
}
