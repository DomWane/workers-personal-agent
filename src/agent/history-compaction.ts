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

function promptSize(agent: PersonalAgent): number {
  return agent.state.promptTokens ?? historyTokens(agent.state.messages, agent.state.historySummary)
}

function contextWindow(agent: PersonalAgent): number {
  return agent.state.contextModel === agent.model
    ? (agent.state.contextTokens ?? DEFAULT_CONTEXT_TOKENS)
    : DEFAULT_CONTEXT_TOKENS
}

export async function maybeCompactHistory(agent: PersonalAgent, log: TurnLog): Promise<void> {
  if (promptSize(agent) <= compactAt(contextWindow(agent))) {
    return
  }
  try {
    await agent.scheduleChain('runCompactHistory', 0)
  } catch (err) {
    log.error({ at: 'compact', stage: 'schedule-failed', error: errorFields(err) })
  }
}

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
    if (context === undefined) {
      log.event({ at: 'compact', stage: 'context-unlisted', model: agent.model, assumed: DEFAULT_CONTEXT_TOKENS })
      return DEFAULT_CONTEXT_TOKENS
    }
    agent.setState({ ...agent.state, contextModel: agent.model, contextTokens: context })
    return context
  } catch (err) {
    log.error({ at: 'compact', stage: 'context-unknown', model: agent.model, error: errorFields(err) })
    return DEFAULT_CONTEXT_TOKENS
  }
}

export async function compactHistory(
  agent: PersonalAgent,
  log: TurnLog,
  opts: { force?: boolean; budget?: SubrequestBudget } = {},
): Promise<void> {
  const budget = opts.budget ?? agent.budget()
  const context = await resolveContextWindow(agent, budget, log)
  if (!opts.force && promptSize(agent) <= compactAt(context)) {
    return
  }
  const evicted = planCompaction(agent.state.messages, opts.force ? 0 : compactKeep(context))
  if (evicted.length === 0) {
    log.event({
      at: 'compact',
      stage: 'nothing-to-evict',
      context,
      promptTokens: promptSize(agent),
      summaryChars: agent.state.historySummary?.length ?? 0,
    })
    return
  }
  const { summarize } = fitHead(spoken(evicted), compactKeep(context))
  const started = appendArchive(agent.archiveSql, 'compaction-start', { evicted: evicted.length })
  const outerStatus = agent.state.status
  agent.setState({ ...agent.state, status: 'compacting' })
  if (summarize.length === 0) {
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
      log.error({ at: 'compact', stage: 'empty-summary', evicted: evicted.length, folded: summarize.length })
    }
    const summary = written || (agent.state.historySummary ?? '')
    const unsummarized = evicted.length - (written ? summarize.length : 0)
    if (agent.state.messages[0]?.id !== evicted[0]?.id) {
      log.event({ at: 'compact', stage: 'abandoned', start: started, subrequests: budget.spent })
      return
    }
    // Before the trim: a failed INSERT loses nothing, a record over a failed setState is only a duplicate.
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
        promptTokens: undefined,
      }),
    )
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
    log.error({ at: 'compact', outcome: 'error', subrequests: budget.spent, error: errorFields(err) })
  } finally {
    if (agent.state.status === 'compacting') {
      agent.setState({ ...agent.state, status: outerStatus })
    }
  }
}
