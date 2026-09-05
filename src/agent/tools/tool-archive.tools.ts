import { z } from 'zod'
import { defineTool, recoverableAt, type ToolDef } from './registry'
import { resultCap } from '../context-window'

/**
 * One window, not a cap on what can be read: anything longer comes back over several calls. Big
 * enough that a normal page arrives in one, small enough that a window does not rewrite the round's
 * context. It is deliberately unrelated to `MAX_PAGE_CHARS` — tying the two would mean raising that
 * one silently made this tool return less than the plain read it exists to complete.
 */
const WINDOW_CHARS = 40_000

/** The cap the loop trims this tool's **reply** to — nothing bounds what is archived, which the old
 *  name `MAX_ARCHIVED_CHARS` claimed. Above the window on purpose: a full window plus the `<result>`
 *  header is longer than the window, and trimming it would cut the middle out of the very page this
 *  tool exists to deliver whole — with `noArchive` set, from a copy nothing can recover. */
export const MAX_READBACK_CHARS = WINDOW_CHARS + 4_000

/** The attrs, the `<result>` tags and the ref footer, with margin — `args` is counted separately
 *  because a search query is not the length of a URL. */
const RENDER_OVERHEAD_CHARS = 400

/** How many matches a search shows. A choice about how much of a round to spend, not a cost limit —
 *  the snippets are cut in SQL, so an unshown match costs nothing. One more is always fetched, and
 *  the reply says when there was one. */
const MAX_HITS = 5

/** `2026-08-27 14:03`, so the model can weigh a hit's age against fetching the page again. */
function fetchedAt(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ')
}

function block(attrs: string, body: string): string {
  return `<result ${attrs}>\n${body}\n</result>`
}

/**
 * Its own export because a **scout** gets this one and not `search_tool_results`: a scout's archive
 * holds one run's own reads, so searching it is nearly searching what it just did, and a scout's
 * prompt is deliberately narrow. Reading back a page the loop shortened is the half it needs.
 */
export const readToolResultTool: ToolDef = defineTool({
  name: 'read_tool_result',
  description:
    'Read a tool result that was shortened or came from an earlier turn, by the ref number quoted beside it. Costs no network request. Long results come back one window at a time; the reply says how to ask for the next.',
  params: z.object({
    ref: z.number().int().describe('The ref number shown with the result'),
    from: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Character to start at. Use the offset the previous reply named to continue.'),
  }),
  maxResultChars: MAX_READBACK_CHARS,
  noArchive: true,
  handler: async ({ ref, from }, ctx) => {
    if (!ctx.toolArchive) {
      return 'error: no earlier results are available here'
    }
    const found = ctx.toolArchive.read(ref)
    if (!found) {
      return `error: no result kept under ref ${ref}`
    }
    const total = found.content.length
    if (from >= total) {
      return `error: ref ${ref} is ${total} characters; there is nothing at ${from}`
    }
    // Sized against the cap the loop will apply, not `WINDOW_CHARS` alone: `chars=` and `more=`
    // below are what the model steers by, and a window wider than what survives names an offset
    // past text that never arrived. Binds under ~134,000 tokens, so on all but the default model.
    const fits = resultCap(MAX_READBACK_CHARS, ctx.contextTokens) - RENDER_OVERHEAD_CHARS - found.args.length
    // Floored so a tiny window cannot put `to` before `from` — an empty result under a header
    // claiming a negative range. Below ~4,700 tokens that trades the honesty above back, and is
    // still the better of the two failures; no model that small exists.
    const window = Math.min(WINDOW_CHARS, Math.max(1_000, fits))
    const to = Math.min(from + window, total)
    // Said even when the whole thing fits, so the model never has to infer whether it has it all.
    const more = to < total ? ` more="read_tool_result(${ref}, ${to})"` : ''
    // Dated, so a model reading a week-old page can decide to fetch it again instead.
    const attrs = `tool="${found.tool}" fetched="${fetchedAt(found.at)}" chars="${from}-${to} of ${total}"${more}`
    // This window is the one tool output that is recoverable without being filed — it came *out*
    // of ref `ref`, so it says so and the loop may shorten it in a later round like any other.
    // Without this the follow-up turn's largest results were the only ones never pruned, which is
    // backwards: it is the tool a model reaches for precisely when it wants volume.
    const footer = recoverableAt(ref, `this window is ${from}-${to}; read_tool_result(${ref}, ${from}) returns it`)
    return `${block(attrs, `${found.args}\n\n${found.content.slice(from, to)}`)}\n\n${footer}`
  },
})

export const toolArchiveTools: ToolDef[] = [
  defineTool({
    name: 'search_tool_results',
    description:
      'Search the full text of pages and search results this conversation already fetched, including in earlier turns. Use this before web_search or read_page when the user refers back to something already looked at — it costs no network request and returns what was actually read.',
    params: z.object({ query: z.string().describe('Words to look for in the fetched text') }),
    // Its own results are the archive read back; filing them again would spend a row per search.
    noArchive: true,
    handler: async ({ query }, ctx) => {
      if (!ctx.toolArchive) {
        return 'error: no earlier results are available here'
      }
      // One more than shown, so "there are others" is a fact rather than a guess: the cap is a
      // choice about how much of a round to spend, and a silent one would read as "that is all".
      const hits = ctx.toolArchive.search(query, MAX_HITS + 1)
      if (hits.length === 0) {
        return '(nothing already fetched matches — use web_search or read_page)'
      }
      const blocks = hits.slice(0, MAX_HITS).map((h) => {
        const attrs = `ref="${h.ref}" tool="${h.tool}" fetched="${fetchedAt(h.at)}" of="${h.total} chars"`
        return block(attrs, `${h.args.slice(0, 120)}\n\n…${h.snippet}…`)
      })
      if (hits.length > MAX_HITS) {
        blocks.push(`(at least one more match not shown — read_tool_result a ref above, or narrow the query)`)
      }
      return blocks.join('\n\n')
    },
  }),
  readToolResultTool,
]
