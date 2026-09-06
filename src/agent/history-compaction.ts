/**
 * Compaction as the agent runs it: when to schedule it, and the pass itself. The arithmetic is in
 * `context-window.ts`; this is the part that needs the Durable Object, and takes it as its first
 * argument. Why not methods on the class: see `PersonalAgent`.
 */
import { appendArchive, type CompactionRecord } from './archive'
import {
  compactAt,
  compactKeep,
  DEFAULT_CONTEXT_TOKENS,
  fitHead,
  historyTokens,
  planCompaction,
  spoken,
} from './context-window'
import { errorFields, type TurnLog } from './log'
import { contextWindowOf } from './model-catalogue'
import type { PersonalAgent } from './personal-agent'
import { retryOnce } from './retry'
import { summarizeHead } from './sessions'
import type { SubrequestBudget } from './subrequest-budget'

/** Measured beats estimated: the provider's own count is what the request actually cost. */
function promptSize(agent: PersonalAgent): number {
  return agent.state.promptTokens ?? historyTokens(agent.state.messages, agent.state.historySummary)
}

/** Known only after the alarm has asked the catalogue, and invalidated by a model switch: one
 *  model's window says nothing about another's. */
function contextWindow(agent: PersonalAgent): number {
  return agent.state.contextModel === agent.model
    ? (agent.state.contextTokens ?? DEFAULT_CONTEXT_TOKENS)
    : DEFAULT_CONTEXT_TOKENS
}

/** A turn only notices that compaction is due; losing the schedule is harmless, the next turn
 *  over the threshold makes another. A `/model` switch calls this too — switching *down* can put
 *  an already-fine surface over the new window with no new turn at all. */
export async function maybeCompactHistory(agent: PersonalAgent, log: TurnLog): Promise<void> {
  // Against the default while this model's window is unknown; the alarm resolves the real one
  // and returns without a model call if there is room after all.
  if (promptSize(agent) <= compactAt(contextWindow(agent))) {
    return
  }
  try {
    await agent.scheduleChain('runCompactHistory', 0)
  } catch (err) {
    log.error({ at: 'compact', stage: 'schedule-failed', error: errorFields(err) })
  }
}

/** One external subrequest, and only when the model has changed; the answer stays in state. */
export async function resolveContextWindow(
  agent: PersonalAgent,
  budget: SubrequestBudget,
  log: TurnLog,
): Promise<number> {
  if (agent.state.contextModel === agent.model) {
    return contextWindow(agent)
  }
  try {
    const context = await contextWindowOf(agent.env, agent.model, budget.fetch)
    // A catalogue that answered but does not list this model is not an answer: pinning the
    // default against its name would leave the thread assuming 24k for good, silently. Left
    // unpinned it costs one lookup per compaction check and fixes itself if the model appears.
    if (context === undefined) {
      log.event({ at: 'compact', stage: 'context-unlisted', model: agent.model, assumed: DEFAULT_CONTEXT_TOKENS })
      return DEFAULT_CONTEXT_TOKENS
    }
    agent.setState({ ...agent.state, contextModel: agent.model, contextTokens: context })
    return context
  } catch (err) {
    // The default is the smallest window this deployment has seen, so an unanswered catalogue
    // compacts early rather than letting a thread grow past a window nobody knows.
    log.error({ at: 'compact', stage: 'context-unknown', model: agent.model, error: errorFields(err) })
    return DEFAULT_CONTEXT_TOKENS
  }
}

/**
 * `force` is the overflow path and the Compact button: someone has decided the surface is too
 * long — the provider by refusing it, or the user by asking — and neither is interested in what
 * the threshold thinks. It also empties the tail budget, keeping only the floor of one exchange:
 * against a million-token window a forced compaction otherwise found nothing to evict and
 * returned in silence, which reads as a broken button.
 */
export async function compactHistory(
  agent: PersonalAgent,
  log: TurnLog,
  opts: { force?: boolean; budget?: SubrequestBudget } = {},
): Promise<void> {
  // The overflow path runs inside a turn and hands its own budget in, or the summarizing call and
  // the catalogue lookup would spend against the fifty without the turn's counter seeing them.
  const budget = opts.budget ?? agent.budget()
  const context = await resolveContextWindow(agent, budget, log)
  if (!opts.force && promptSize(agent) <= compactAt(context)) {
    return
  }
  const evicted = planCompaction(agent.state.messages, opts.force ? 0 : compactKeep(context))
  if (evicted.length === 0) {
    // At the floor of one exchange, so what is over the threshold is not history: the running
    // summary, and on the measured path the system prompt. Neither is trimmable or bounded, and
    // the threshold re-schedules this every turn, so it says so rather than returning mute.
    log.event({
      at: 'compact',
      stage: 'nothing-to-evict',
      context,
      promptTokens: promptSize(agent),
      summaryChars: agent.state.historySummary?.length ?? 0,
    })
    return
  }
  // A switch to a five-times-smaller window can evict more than the new model could ever fold,
  // so the summarizer reads what fits and the rest is archived raw. Chaining passes until it all
  // fit would summarize a summary repeatedly, and that degradation is invisible.
  // Filtered *before* `fitHead` chooses, not after. Sizing the slice over rows the summarizer
  // will never read picks a slice that can be entirely tool traffic — the call is then spent on
  // an empty transcript, and `shadows` records that the summary replaced ids it never saw.
  const { summarize } = fitHead(spoken(evicted), compactKeep(context))
  // Before the model call, and its record only after the state write: a pass that dies anywhere
  // in between leaves a start with nothing after it, which is a trace rather than a lie.
  const started = appendArchive(agent.archiveSql, 'compaction-start', { evicted: evicted.length })
  // Restored rather than cleared: the overflow path compacts *inside* a turn, where clearing
  // would take the turn's own "thinking" with it and leave the client waiting in silence.
  const outerStatus = agent.state.status
  agent.setState({ ...agent.state, status: 'compacting' })
  if (summarize.length === 0) {
    // A head that was all tool traffic. The rows still go to the archive and still leave the
    // surface; what is skipped is a model call over an empty transcript, whose answer would then
    // overwrite a summary it had nothing to add to.
    log.event({ at: 'compact', stage: 'nothing-to-summarize', evicted: evicted.length })
  }
  try {
    const written = summarize.length
      ? await summarizeHead(
          agent.llm(budget),
          agent.model,
          agent.state.historySummary,
          summarize,
          spoken(agent.state.messages.slice(evicted.length)),
        )
      : ''
    if (summarize.length && !written) {
      // Taking the answer as written replaced the running summary with the empty string, and the
      // head it described is archived by then. It still leaves the surface; nothing describes it.
      log.error({ at: 'compact', stage: 'empty-summary', evicted: evicted.length, folded: summarize.length })
    }
    const summary = written || (agent.state.historySummary ?? '')
    // Counted against everything evicted rather than against the head the summarizer read: the
    // tool traffic `spoken` dropped also leaves with no summary describing it, and on the empty
    // answer above nothing was described at all.
    const unsummarized = evicted.length - (written ? summarize.length : 0)
    // The history can have been replaced while the model was answering — `deleteThread` is the
    // racer now — and dropping `evicted.length` messages off the front of a different history
    // would eat live turns and describe them with a summary of turns that are gone.
    if (agent.state.messages[0]?.id !== evicted[0]?.id) {
      log.event({ at: 'compact', stage: 'abandoned', start: started, subrequests: budget.spent })
      return
    }
    // Before the trim, and do not swap the two: a failed INSERT loses nothing, while a record
    // over a failed `setState` is only a duplicate, which `recentActivity` dedupes by id. The
    // tidier order trades that duplicate for permanent loss.
    appendArchive(agent.archiveSql, 'compaction', {
      evicted,
      summary,
      shadows: summarize.map((m) => m.id),
      unsummarized,
    } satisfies CompactionRecord)
    await retryOnce(() =>
      agent.setState({
        ...agent.state,
        messages: agent.state.messages.slice(evicted.length),
        historySummary: summary,
        // The surface it described is gone, so the last measured size is no longer about it.
        promptTokens: undefined,
      }),
    )
    // Last, so the archive alone says the trim landed — the log line saying so expires in three
    // days.
    appendArchive(agent.archiveSql, 'compaction-end', { start: started })
    log.event({
      at: 'compact',
      context,
      evicted: evicted.length,
      kept: agent.state.messages.length,
      unsummarized,
      summaryChars: summary.length,
      subrequests: budget.spent,
    })
  } catch (err) {
    // The surface is untouched unless the failure was the trim itself, in which case the archive
    // holds a record of turns that are still on it — the duplicate above, not a loss. Either way
    // the next turn over the threshold schedules this again.
    log.error({ at: 'compact', outcome: 'error', subrequests: budget.spent, error: errorFields(err) })
  } finally {
    // Only if nobody moved it meanwhile: a message sent during a compaction sets `thinking`, and
    // restoring the captured value over it would drop the indicator of a turn still running.
    if (agent.state.status === 'compacting') {
      agent.setState({ ...agent.state, status: outerStatus })
    }
  }
}
