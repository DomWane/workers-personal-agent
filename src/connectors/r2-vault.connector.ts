/**
 * The vault backed by R2. It replaced a GitHub Contents API backend behind the same four methods,
 * so `vault-store.ts` never noticed.
 *
 * The reason for the swap is the subrequest class: measured on 2026-08-06, R2 binding
 * calls do not count against the Free plan's 50 external subrequests, so reading memory
 * during a turn stops competing with the LLM rounds for the same budget.
 */
export class R2VaultConnector {
  constructor(private bucket: R2Bucket) {}

  /** `sha` is the R2 etag here; callers only ever compare it or hand it back. */
  async getFile(path: string): Promise<{ content: string; sha: string } | null> {
    const obj = await this.bucket.get(path)
    if (!obj) {
      return null
    }
    return { content: await obj.text(), sha: obj.etag }
  }

  /**
   * `message` is a GitHub commit message and has no counterpart here; it is kept in the
   * signature so the two connectors stay interchangeable.
   *
   * When `sha` is given the write is conditional, which preserves the lost-update
   * protection the Contents API gave for free. A *create* (no `sha`) is not guarded —
   * GitHub would have rejected it if the file already existed, R2 overwrites. Only the
   * agent writes to the vault, so nothing races today; if hand editing comes back, this
   * is the line that has to change.
   */
  async putFile(path: string, content: string, _message: string, sha?: string): Promise<void> {
    const res = await this.bucket.put(path, content, sha ? { onlyIf: { etagMatches: sha } } : undefined)
    if (sha && res === null) {
      throw new Error(`r2 putFile conflict: ${path} changed since it was read`)
    }
  }

  /**
   * Files directly under a prefix. The delimiter keeps subfolders out, matching the
   * Contents API — archived entries live in `archive/` and must stay invisible here.
   */
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
