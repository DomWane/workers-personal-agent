import { z } from 'zod'
import { defineTool, recoverableAt, type ToolDef } from './registry'
import { resultCap } from '../loop/context-window'

const WINDOW_CHARS = 40_000

export const MAX_READBACK_CHARS = WINDOW_CHARS + 4_000

const RENDER_OVERHEAD_CHARS = 400

const MAX_HITS = 5

function fetchedAt(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ')
}

function block(attrs: string, body: string): string {
  return `<result ${attrs}>\n${body}\n</result>`
}

export const readToolResultTool: ToolDef = defineTool({
  name: 'read_tool_result',
  description:
    'Read a tool result that was shortened or came from an earlier turn, by the ref number quoted beside it. Costs no network request. Long results come back one window at a time; the reply says how to ask for the next.',
  params: z.object({
    ref: z.coerce.number().int().describe('The ref number shown with the result'),
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
    const fits = resultCap(MAX_READBACK_CHARS, ctx.contextTokens) - RENDER_OVERHEAD_CHARS - found.args.length
    const window = Math.min(WINDOW_CHARS, Math.max(1_000, fits))
    const to = Math.min(from + window, total)
    const more = to < total ? ` more="read_tool_result(${ref}, ${to})"` : ''
    const attrs = `tool="${found.tool}" fetched="${fetchedAt(found.at)}" chars="${from}-${to} of ${total}"${more}`
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
    noArchive: true,
    handler: async ({ query }, ctx) => {
      if (!ctx.toolArchive) {
        return 'error: no earlier results are available here'
      }
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
