import { z } from 'zod'
import type { ReminderPayload, TaskPayload } from '../../types'
import { defineTool, type ToolDef } from './registry'

const CRON_RE = /^[\d*/,-]+ [\d*/,-]+ [\d*/,-]+ [\d*/,-]+ [\d*/,-]+$/

// A recurring task is a whole tool loop, so hourly at most: the minute field has to be one number,
// which refuses every-minute and every-five-minutes crons before a page the model read can plant one.
const HOURLY_AT_MOST = /^\d{1,2} /
// Each task is a tool loop with its own budget; the cap keeps a runaway model from filling the
// calendar with them.
export const MAX_SCHEDULED_TASKS = 20

/** A tool result, not a throw: a model that reaches these in a context without a scheduler needs
 *  an answer it can act on, and an unmatched tool_call id makes the next request a 400. */
const NO_SCHEDULER = 'error: nothing can be scheduled from here'

/** Transforms rather than checks: `Agent.schedule` overloads on cron-string against `Date`, so the
 *  handlers want the parsed value and would otherwise each re-parse it. */
const WHEN = z
  .string()
  .describe('ISO datetime (2026-07-07T09:00:00Z) for one-time, or 5-field cron (0 8 * * *) for recurring')
  .transform((when, ctx): string | Date => {
    if (CRON_RE.test(when)) {
      return when
    }
    const at = new Date(when)
    if (Number.isNaN(at.getTime())) {
      ctx.addIssue({ code: 'custom', message: 'use ISO datetime (2026-07-07T09:00:00Z) or 5-field cron' })
      return z.NEVER
    }
    return at
  })

export const scheduleTools: ToolDef[] = [
  defineTool({
    name: 'set_reminder',
    description: 'Schedule a reminder message to be sent to the user at a given time (one-time or recurring).',
    params: z.object({ when: WHEN, text: z.string().describe('The reminder text to send') }),
    handler: async (args, ctx) => {
      if (!ctx.agent) {
        return NO_SCHEDULER
      }
      const payload: ReminderPayload = { text: args.text }
      const s = await ctx.agent.schedule(args.when, 'fireReminder', payload)
      return `reminder scheduled (id ${s.id})`
    },
  }),
  defineTool({
    name: 'set_scheduled_task',
    description:
      'Schedule an agentic task: at the given time the agent runs the prompt (with tools) and sends the result to the user. Good for recurring digests.',
    params: z.object({ when: WHEN, prompt: z.string().describe('The prompt the agent will execute') }),
    handler: async (args, ctx) => {
      if (!ctx.agent) {
        return NO_SCHEDULER
      }
      if (typeof args.when === 'string' && !HOURLY_AT_MOST.test(args.when)) {
        return 'error: a recurring task runs at most once an hour — give the minute as a number, e.g. "0 8 * * *"'
      }
      const tasks = (await ctx.agent.listSchedules()).filter((s) => s.callback === 'runTask')
      if (tasks.length >= MAX_SCHEDULED_TASKS) {
        return `error: ${MAX_SCHEDULED_TASKS} tasks are already scheduled; cancel one first (see list_scheduled)`
      }
      const payload: TaskPayload = { prompt: args.prompt }
      const s = await ctx.agent.schedule(args.when, 'runTask', payload)
      return `task scheduled (id ${s.id})`
    },
  }),
  defineTool({
    name: 'list_scheduled',
    description: 'List all scheduled reminders and tasks with their ids.',
    params: z.object({}),
    handler: async (_args, ctx) => {
      if (!ctx.agent) {
        return NO_SCHEDULER
      }
      const schedules = await ctx.agent.listSchedules()
      if (schedules.length === 0) {
        return '(nothing scheduled)'
      }
      return schedules
        .map((s) => {
          const p = s.payload as { text?: string; prompt?: string } | undefined
          const what = s.callback === 'fireReminder' ? `reminder: ${p?.text ?? ''}` : `task: ${p?.prompt ?? ''}`
          return `${s.id} | ${s.type} | next: ${new Date(s.time * 1000).toISOString()} | ${what}`
        })
        .join('\n')
    },
  }),
  defineTool({
    name: 'cancel_scheduled',
    description: 'Cancel a scheduled reminder or task by its id (see list_scheduled).',
    params: z.object({ id: z.string() }),
    handler: async ({ id }, ctx) => {
      if (!ctx.agent) {
        return NO_SCHEDULER
      }
      return (await ctx.agent.cancelSchedule(id)) ? `cancelled ${id}` : `not found: ${id}`
    },
  }),
]
