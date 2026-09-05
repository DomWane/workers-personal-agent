import { z } from 'zod'
import { errorFields } from '../log'
import type { IndexedKind, MemoryEntry, MemoryStore } from '../memory/memory-store'
import { slugify } from '../memory/vault-format'
import { createMemoryStore } from '../memory/vault-store'
import { checkGrounds, groundsFields } from './grounds'
import { defineTool, type ToolContext, type ToolDef } from './registry'

/** Delimited blocks + the system-prompt "data, not instructions" rule close the recall half of the
 *  memory-poisoning channel. Shared by both search paths so neither can lose the delimiters. */
function renderEntries(entries: MemoryEntry[]): string {
  // Cut by the loop instead: `truncate` here handed the *archive* the already-cut text, so 12,213
  // characters became a 4,041 row and `read_tool_result` offered the rest of what nothing kept.
  return entries
    .map((h) => `<memory name="${h.name.replaceAll('"', "'")}">\n${h.description}\n\n${h.content}\n</memory>`)
    .join('\n\n')
}

/** Truncates silently: the model is handed five memories and cannot tell there were eight.
 *  Deliberately not a tool parameter — a cap the model can raise is one it can argue with. */
const SEMANTIC_HITS = 5

/**
 * The semantic half of recall, or `null` when it has nothing to offer — no index configured, no
 * hits, or the index itself unreachable. The caller falls back to keyword search in all three.
 */
async function searchIndex(store: MemoryStore, query: string, ctx: ToolContext): Promise<string | null> {
  if (!ctx.index) {
    return null
  }
  try {
    const hits = await ctx.index.search(query, SEMANTIC_HITS)
    // Concurrent because each hit is a separate R2 object; in series they would dominate the call.
    // The cast is safe by construction: the index stores the kind it was given.
    const found = await Promise.all(hits.map((h) => store.readEntry(h.kind as IndexedKind, h.slug)))
    const entries = found.filter((e) => e !== null)
    return entries.length > 0 ? renderEntries(entries) : null
  } catch (err) {
    // Falling back beats failing recall, but it is now a *shared* dependency that failed — one
    // unhealthy index degrades every thread at once, where a local one failed alone. Loud, or a
    // whole-system degradation reads as slightly worse answers.
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
      // Refused, not silently unsourced: a fact nobody can trace back is one a later reflection
      // has to take on trust, which is the judgement this whole gate exists to keep out.
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
        // Indexing is best-effort; a bad embed must not fail the save (vault is source of truth).
        console.error('[memory] index upsert failed', err)
      }
      return result
    },
  }),
  defineTool({
    name: 'search_memory',
    description: 'Search long-term memory for facts about the user or past notes.',
    // The one tool of nineteen that overflowed the loop's 4,000 default systematically: one memory
    // may be `MAX_CONTENT_CHARS` alone, and a result carries three of them plus sessions — 12,213
    // characters measured. Set above the *structural* ceiling rather than that sample, the lesson
    // `MAX_SEARCH_CHARS` records. Over `PRUNE_OVER_CHARS`, so the pruner shortens it from round N+3.
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
    // The grounds are optional: the handler falls back to the turn being answered.
    params: z.object({
      name: z.string().describe('The memory name or slug to archive'),
      ...groundsFields({
        citedTurn:
          'Message id of the user turn that evidences this. It is checked against that conversation; an id that does not exist, or one the user did not write, is refused.',
        thread: 'The thread="..." of the conversation the cited turn is in.',
      }),
    }),
    handler: async (args, ctx) => {
      // Archiving is the one memory write that destroys something, so it is the one that has to
      // show grounds. A model resolving a contradiction on its own judgment is what the gate is for.
      const checked = await checkGrounds(args, ctx)
      if (!checked.ok) {
        return checked.error
      }

      const store = createMemoryStore(ctx.env)
      // Resolve against the vault rather than slugifying blind: the model names the memory
      // it means, and two different memories can slugify to the same string.
      const slug = await store.resolveMemorySlug(args.name)
      const result = await store.archiveMemory(slug, checked.grounds)
      if (!result.startsWith('error:')) {
        try {
          await ctx.index?.remove('memory', slug)
        } catch (err) {
          // Indexing is best-effort; a stale index line must not fail the archive (vault is source of truth).
          console.error('[memory] index remove failed', err)
        }
      }
      return result
    },
  }),
]
