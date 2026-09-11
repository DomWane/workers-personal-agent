import { z } from 'zod'
import { ORPHAN_LOG } from '@/agent/log'
import { defineTool, type ToolDef } from '@/agent/tools/registry'

const MAX_REPORT_CHARS = 40_000

export const researchTools: ToolDef[] = [
  defineTool({
    name: 'read_research_report',
    description:
      'Read the finished research report the user is currently looking at, before they save or drop ' +
      'it. Call it whenever they ask about a run that has just finished — you cannot see the report ' +
      'otherwise. Once they save it, search_memory finds it instead.',
    params: z.object({}),
    maxResultChars: MAX_REPORT_CHARS,
    handler: async (_args, ctx) => {
      const report = ctx.pendingReport?.()
      if (!report) {
        return 'error: no finished research report is waiting — nothing has been researched yet'
      }
      if (report.length > MAX_REPORT_CHARS) {
        ;(ctx.log ?? ORPHAN_LOG).event({
          at: 'read_research_report',
          stage: 'over-first-view',
          chars: report.length,
          cap: MAX_REPORT_CHARS,
        })
      }
      return report
    },
  }),
]
