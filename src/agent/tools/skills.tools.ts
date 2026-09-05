import { z } from 'zod'
import { createMemoryStore } from '../memory/vault-store'
import { defineTool, truncate, type ToolDef } from './registry'

export const skillTools: ToolDef[] = [
  defineTool({
    name: 'list_skills',
    description:
      'List saved skills (reusable workflows) with descriptions. Check before starting a multi-step task that might match a known workflow.',
    params: z.object({}),
    // listDir + one GET per skill file — needs more than the 10s default
    timeoutMs: 20_000,
    handler: async (_args, ctx) => {
      const skills = await createMemoryStore(ctx.env).listSkills()
      if (skills.length === 0) {
        return '(no skills saved yet)'
      }
      return skills
        .map((s) => `- ${s.slug} — ${s.description}${s.pinned ? ' [pinned]' : ''} (used ${s.useCount}×)`)
        .join('\n')
    },
  }),
  defineTool({
    name: 'read_skill',
    description: 'Read a saved skill by name; returns the full procedure to follow for the current task.',
    params: z.object({ name: z.string().describe('Skill name or slug from list_skills') }),
    handler: async ({ name }, ctx) => {
      const skill = await createMemoryStore(ctx.env).readSkill(name)
      if (!skill) {
        return `(no skill named "${name}")`
      }
      return truncate(`<skill name="${skill.name.replaceAll('"', "'")}">\n${skill.content}\n</skill>`)
    },
  }),
  defineTool({
    name: 'save_skill',
    description:
      'Save or update a reusable workflow as a skill. Structure content as: ## When to Use / ## Procedure / ## Pitfalls / ## Verification. Reuse the same name to update.',
    params: z.object({
      name: z.string().describe('Short stable title, e.g. "Daily AI news digest"'),
      description: z.string().describe('One line: what task this skill handles'),
      content: z.string().describe('The skill body (markdown, template above)'),
    }),
    handler: (args, ctx) => createMemoryStore(ctx.env).saveSkill(args),
  }),
]

/** Reflection-only: the chat toolset must not archive skills on its own judgment. */
export const archiveSkillTool: ToolDef = defineTool({
  name: 'archive_skill',
  description: 'Move a stale or superseded skill to the archive folder (never deletes). Only for curation.',
  params: z.object({ slug: z.string().describe('Skill slug from the skill list') }),
  // copy + delete = two sequential github calls
  timeoutMs: 20_000,
  handler: ({ slug }, ctx) => createMemoryStore(ctx.env).archiveSkill(slug),
})
