import { z } from 'zod'
import { errorFields } from '../log'
import type { IndexedKind, MemoryEntry, MemoryStore } from '../memory/memory-store'
import { slugify } from '../memory/vault-format'
import { createMemoryStore } from '../memory/vault-store'
import { checkGrounds, groundsFields } from './grounds'
import { defineTool, type ToolContext, type ToolDef } from './registry'

function renderEntries(entries: MemoryEntry[]): string {
  return entries
    .map((h) => `<memory name="${h.name.replaceAll('"', "'")}">\n${h.description}\n\n${h.content}\n</memory>`)
    .join('\n\n')
}

const SEMANTIC_HITS = 5

async function searchIndex(store: MemoryStore, query: string, ctx: ToolContext): Promise<string | null> {
  if (!ctx.index) {
    return null
  }
  try {
    const hits = await ctx.index.search(query, SEMANTIC_HITS)
    const found = await Promise.all(hits.map((h) => store.readEntry(h.kind as IndexedKind, h.slug)))
    const entries = found.filter((e) => e !== null)
    return entries.length > 0 ? renderEntries(entries) : null
  } catch (err) {
    ctx.log?.error({ at: 'search_memory', stage: 'index-unavailable', degraded: true, error: errorFields(err) })
    return null
  }
}

export const memoryTools: ToolDef[] = [
  defineTool({
    name: 'save_memory',
    description:
      'Save a durable fact, preference or note to long-term memory (the markdown vault). Use a stable name to update an existing memory.',
    params: z.object({
      name: z.string().describe('Short stable title, e.g. "prefers tea"'),
      description: z.string().describe('One-line summary used for recall'),
      content: z.string().describe('The full note content (markdown)'),
    }),
    handler: async ({ name, description, content }, ctx) => {
      if (!ctx.source) {
        return 'error: cannot save a memory from here — nothing to record as its source'
      }
      const result = await createMemoryStore(ctx.env).save({
        name,
        description,
        content,
        source: ctx.source,
      })
      try {
        await ctx.index?.upsert('memory', slugify(name), `${name}\n${description}\n${content}`)
      } catch (err) {
        console.error('[memory] index upsert failed', err)
      }
      return result
    },
  }),
  defineTool({
    name: 'search_memory',
    description: 'Search long-term memory for facts about the user or past notes.',
    maxResultChars: 20_000,
    params: z.object({ query: z.string() }),
    handler: async ({ query }, ctx) => {
      const store = createMemoryStore(ctx.env)
      const semantic = await searchIndex(store, query, ctx)
      if (semantic) {
        return semantic
      }
      const hits = await store.search(query)
      if (hits.length === 0) {
        return '(no matching memories)'
      }
      return renderEntries(hits)
    },
  }),
  defineTool({
    name: 'list_memories',
    description: 'List all saved memories (the memory index).',
    params: z.object({}),
    handler: (_args, ctx) => createMemoryStore(ctx.env).list(),
  }),
  defineTool({
    name: 'delete_memory',
    description:
      'Archive an obsolete or superseded memory by name (it is moved to an archive folder, never lost). Use when a memory is wrong, replaced, or consolidated into another. Requires cited_turn: the id of the user message that shows this memory is wrong or superseded.',
    params: z.object({
      name: z.string().describe('The memory name or slug to archive'),
      ...groundsFields({
        citedTurn:
          'Message id of the user turn that evidences this. It is checked against that conversation; an id that does not exist, or one the user did not write, is refused.',
        thread: 'The thread="..." of the conversation the cited turn is in.',
      }),
    }),
    handler: async (args, ctx) => {
      const checked = await checkGrounds(args, ctx)
      if (!checked.ok) {
        return checked.error
      }

      const store = createMemoryStore(ctx.env)
      const slug = await store.resolveMemorySlug(args.name)
      const result = await store.archiveMemory(slug, checked.grounds)
      if (!result.startsWith('error:')) {
        try {
          await ctx.index?.remove('memory', slug)
        } catch (err) {
          console.error('[memory] index remove failed', err)
        }
      }
      return result
    },
  }),
]
