import { z } from 'zod'
import { ORPHAN_LOG } from '../log'
import { defineTool, type ToolDef } from './registry'

/**
 * Above every report ever produced: 10,587 and 10,098 characters, the only two measured, against a
 * vault whose largest file of any kind is 14,444. So this is a ceiling for a pathological report
 * rather than a working limit — unlike `web_search`'s inherited 2,000, which sat *under* its own
 * distribution and cut all of it.
 *
 * What bounds a report is the writer model's own output limit, which `writeResearchReport` does not
 * pin. That makes an absolute number here the shape `HISTORY_SOFT_CAP` had to stop being; it holds
 * only while the picker's models keep answering at this length.
 */
const MAX_REPORT_CHARS = 40_000

/**
 * The model cannot start research, and since 2026-08-23 it cannot propose one either — the composer's
 * Deep research toggle is the only trigger. A run costs minutes and hundreds of requests, and a
 * judgement call about that is one the model was getting wrong in both directions.
 */
export const researchTools: ToolDef[] = [
  defineTool({
    name: 'read_research_report',
    /**
     * A finished report is in the agent's state and on the user's screen, but never in the
     * conversation — it would cost ~6.5k tokens on every turn until it was filed, against a
     * default window of 24k. So it is fetched on demand instead: the turn that needs it pays,
     * and the turns that do not, do not.
     */
    description:
      'Read the finished research report the user is currently looking at, before they save or drop ' +
      'it. Call it whenever they ask about a run that has just finished — you cannot see the report ' +
      'otherwise. Once they save it, search_memory finds it instead.',
    params: z.object({}),
    // A whole report rather than the default 4000, which would show the model a quarter of one.
    maxResultChars: MAX_REPORT_CHARS,
    handler: async (_args, ctx) => {
      const report = ctx.pendingReport?.()
      if (!report) {
        return 'error: no finished research report is waiting — nothing has been researched yet'
      }
      // `truncate` marks its cut in the model's copy and nowhere else, so without this a report
      // losing its tail is invisible in a trace — and this is the constant most likely to be
      // outgrown quietly, by a model that simply writes longer.
      if (report.length > MAX_REPORT_CHARS) {
        ;(ctx.log ?? ORPHAN_LOG).event({
          at: 'read_research_report',
          stage: 'over-first-view',
          chars: report.length,
          // The tool's cap, not what the model saw: the loop cuts further when the window is the
          // tighter bound, and `stage: 'window-capped'` is where that shows.
          cap: MAX_REPORT_CHARS,
        })
      }
      return report
    },
  }),
]
