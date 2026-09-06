import { z } from 'zod'
import { fetchPageMarkdown } from '../../connectors/browser-run.connector'
import { firecrawlScrape } from '../../connectors/firecrawl.connector'
import { ORPHAN_LOG, type TurnLog } from '../log'
import { extractMain } from './page-text'
import { defineTool, pageKey, type ToolDef } from './registry'
import { rethrowIfExhausted } from '../subrequest-budget'

export const MAX_PAGE_CHARS = 100_000

function logRead(log: TurnLog, via: string, fellBack: boolean, chars: number, why?: string): void {
  log.event({ at: 'read_page', via, fellBack, chars, why: why?.slice(0, 120) })
  if (chars > MAX_PAGE_CHARS) {
    log.event({ at: 'read_page', stage: 'over-first-view', via, chars, cap: MAX_PAGE_CHARS })
  }
}

export const browserTools: ToolDef[] = [
  defineTool({
    name: 'read_page',
    description:
      'Fetch a web page (including JavaScript-rendered content) and return it as markdown. Use after web_search to read a promising result.',
    params: z.object({ url: z.string().describe('Full URL of the page to read') }),
    timeoutMs: 25_000,
    maxResultChars: MAX_PAGE_CHARS,
    handler: async ({ url }, ctx) => {
      const log = ctx.log ?? ORPHAN_LOG
      if (ctx.alreadyTried?.(url)) {
        log.event({ at: 'read_page', stage: 'already-tried' })
        return 'error: this run already fetched this URL — read something else'
      }
      const cached = ctx.pageCache?.get(pageKey(url))
      if (cached) {
        const markdown = extractMain(cached)
        logRead(log, 'search-cache', false, markdown.length)
        ctx.onPageRead?.(url, true)
        return markdown
      }
      try {
        const markdown = extractMain(
          await fetchPageMarkdown(ctx.env.CF_ACCOUNT_ID, ctx.env.CF_API_TOKEN, url, ctx.budget?.fetch),
        )
        logRead(log, 'browser-run', false, markdown.length)
        ctx.onPageRead?.(url, true)
        return markdown
      } catch (err) {
        rethrowIfExhausted(err)
        const original = err instanceof Error ? err : new Error(String(err))
        try {
          const markdown = extractMain(await firecrawlScrape(ctx.env.FIRECRAWL_API_KEY, url, ctx.budget?.fetch))
          logRead(log, 'firecrawl', true, markdown.length, original.message)
          ctx.onPageRead?.(url, true)
          return markdown
        } catch (fallbackErr) {
          rethrowIfExhausted(fallbackErr)
          const fallbackNote = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
          log.error({
            at: 'read_page',
            via: 'firecrawl',
            fellBack: true,
            ok: false,
            why: original.message.slice(0, 120),
            fallbackWhy: fallbackNote.slice(0, 120),
          })
          ctx.onPageRead?.(url, false)
          throw new Error(`${original.message}; firecrawl fallback also failed: ${fallbackNote}`, {
            cause: fallbackErr,
          })
        }
      }
    },
  }),
]
