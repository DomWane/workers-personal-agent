import { z } from 'zod'
import { fetchPageMarkdown } from '../../connectors/browser-run.connector'
import { firecrawlScrape } from '../../connectors/firecrawl.connector'
import { ORPHAN_LOG, type TurnLog } from '../log'
import { extractMain } from './page-text'
import { defineTool, type ToolDef } from './registry'
import { rethrowIfExhausted } from '../subrequest-budget'

/**
 * How much of a page the model sees **the first time**, and nothing more than that: the handler
 * returns the whole fetch, the loop archives the whole fetch, and `truncate` cuts only the copy
 * that goes into the request. `read_tool_result` reaches the rest at any point after. So this is a
 * view, not a limit — the page is never lost by being over it.
 *
 * Picked from this vault's own distribution: 50,000 cut every real page measured (72k, 64k, 38k,
 * 27k, 24k) and 100,000 clears all of them. The cost is unmeasured and deliberately so — a page
 * between the two is re-sent whole until the pruner reaches it, at round four earliest. That trade
 * is arm D of `evals/results/inline-page-size-preregistration.md`; this ships the arm, not an answer.
 */
export const MAX_PAGE_CHARS = 100_000

function logRead(log: TurnLog, via: string, fellBack: boolean, chars: number, why?: string): void {
  // `why` is why the primary was abandoned. It was dropped on the success path, so the only
  // recorded reason across two real runs was a single 429 — and the comment below claimed WAF.
  log.event({ at: 'read_page', via, fellBack, chars, why: why?.slice(0, 120) })
  // `cap`, not `shown`: below ~333k tokens of window the loop cuts further still, and
  // `stage: 'window-capped'` is what reports that.
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
    // Two sequential 10s-abort connectors (Browser Run, then Firecrawl) + margin;
    // the loop's 10s default would always discard the fallback result.
    timeoutMs: 25_000,
    // Pages are tens of thousands of characters; the loop's 4k default left no room for the article.
    maxResultChars: MAX_PAGE_CHARS,
    handler: async ({ url }, ctx) => {
      // Which provider served a read was invisible, so neither "how often is Browser Rendering
      // blocked" nor the real cost of a read could be answered — a fallback spends two
      // subrequests, because the budget charges on attempt rather than on success.
      const log = ctx.log ?? ORPHAN_LOG
      if (ctx.alreadyTried?.(url)) {
        log.event({ at: 'read_page', stage: 'already-tried' })
        return 'error: this run already fetched this URL — read something else'
      }
      try {
        const markdown = extractMain(
          await fetchPageMarkdown(ctx.env.CF_ACCOUNT_ID, ctx.env.CF_API_TOKEN, url, ctx.budget?.fetch),
        )
        logRead(log, 'browser-run', false, markdown.length)
        ctx.onPageRead?.(url, true)
        return markdown
      } catch (err) {
        // Running out of budget is not Browser Rendering failing, and the fallback below would
        // spend two more subrequests discovering the same thing.
        rethrowIfExhausted(err)
        const original = err instanceof Error ? err : new Error(String(err))
        // Usually our own concurrency rather than the site: this endpoint is rate-limited per
        // account, and a wave of scouts reads past it. `why` above is what tells the two apart.
        // Firecrawl answers keyless, so the fallback runs with or without FIRECRAWL_API_KEY.
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
            // `why` is the *primary's* reason, so without this the vendor that actually lost the
            // page goes unrecorded — as it did for fourteen of thirty reads on one run.
            fallbackWhy: fallbackNote.slice(0, 120),
          })
          ctx.onPageRead?.(url, false)
          // The fallback's error is the cause; the primary's survives in the message, which is the
          // half a log line ever shows.
          throw new Error(`${original.message}; firecrawl fallback also failed: ${fallbackNote}`, {
            cause: fallbackErr,
          })
        }
      }
    },
  }),
]
