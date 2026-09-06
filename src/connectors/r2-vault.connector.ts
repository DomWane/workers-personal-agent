export class R2VaultConnector {
  constructor(private bucket: R2Bucket) {}

  async getFile(path: string): Promise<{ content: string; sha: string } | null> {
    const obj = await this.bucket.get(path)
    if (!obj) {
      return null
    }
    return { content: await obj.text(), sha: obj.etag }
  }

  async putFile(path: string, content: string, _message: string, sha?: string): Promise<void> {
    const res = await this.bucket.put(path, content, sha ? { onlyIf: { etagMatches: sha } } : undefined)
    if (sha && res === null) {
      throw new Error(`r2 putFile conflict: ${path} changed since it was read`)
    }
  }

  async listDir(path: string): Promise<{ name: string; sha: string }[]> {
    const prefix = `${path}/`
    const out: { name: string; sha: string }[] = []
    let cursor: string | undefined
    do {
      const page = await this.bucket.list({ prefix, delimiter: '/', cursor })
      for (const obj of page.objects) {
        out.push({ name: obj.key.slice(prefix.length), sha: obj.etag })
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return out
  }

  async deleteFile(path: string, _message: string, _sha: string): Promise<void> {
    await this.bucket.delete(path)
  }
}
