import type OpenAI from 'openai'
import { buildRoundPrompt, parseRoundOutput, type RoundOutput } from './round'
import { MAX_SCOUTS, SCOUT_TIMEOUT_MS, type RoundResult } from './state'
import type { SubrequestBudget } from '../subrequest-budget'
import { runToolLoop } from '../loop/tool-loop'
import { browserTools } from '../tools/browser.tools'
import { searchTools } from '../tools/search.tools'
import { readToolResultTool } from '../tools/tool-archive.tools'
import { pageKey, type ToolContext } from '../tools/registry'
import type { TurnLog } from '../log'
import type { ChatMessage, ResearchState, ScoutCounts } from '../../types'

const ROUND_PROMPT = `You are one round of a multi-round research task. Search and read, then report what this round found.

- Do not re-read a URL listed as already tried.
- Stop searching and write up as soon as any of these is true: you can answer the angle you took
  comprehensively, you have three or more concrete sources on it, or consecutive searches are
  returning the same material.
- Report only what THIS round found. Earlier rounds are kept; you are not rewriting them.
- Keep every fact and every source URL. Write them out in full rather than describing them: what
  you leave out here is gone, because the pages are not carried to the next round.
- Your final message must be exactly this shape, and nothing else:

## Findings
What this round established, in full, with the source URL beside each claim. Say plainly when a
source contradicts an earlier one.

## Open questions
- one per line, or omit the section when nothing is open

## Done
yes or no — yes only when the topic is genuinely covered.`

const REPORT_PROMPT =
  'Write the final research report from the findings of every round, for someone who has read none ' +
  'of them. Group what belongs together under `##` headings instead of listing findings in the order ' +
  'they arrived. Markdown is rendered, so cite inline — [what the source is](url) — rather than ' +
  'ending every sentence with a bare URL. Keep every source. Prefer losing repetition to losing a ' +
  'fact, and write no preamble about what you are doing.'

export async function writeResearchReport(
  state: ResearchState,
  deps: Omit<RoundDeps, 'ctx'>,
): Promise<{ text: string; tokens: number }> {
  const res = await deps.client.chat.completions.create({
    model: deps.model,
    messages: [
      { role: 'system', content: REPORT_PROMPT },
      {
        role: 'user',
        content: `<topic>${state.topic}</topic>\n\n${state.findings.map((f, i) => `<round n="${i + 1}">\n${f}\n</round>`).join('\n\n')}`,
      },
    ],
  })
  const text = (res.choices[0]?.message?.content ?? '').trim()
  const tokens = (res.usage?.prompt_tokens ?? 0) + (res.usage?.completion_tokens ?? 0)
  deps.log?.event({
    at: 'research',
    stage: 'report-written',
    rounds: state.findings.length,
    chars: text.length,
    tokens,
  })
  return { text, tokens }
}

const PLAN_PROMPT =
  'Plan a research run on the topic the user gives. Reply with two to four lines, one angle per line, ' +
  'each a concrete thing to look for. No numbering, no preamble, no commentary.'

const MAX_PLAN_LINES = 4

export interface PlanRevision {
  plan: string[]
  note: string
}

export async function planResearch(
  topic: string,
  deps: Omit<RoundDeps, 'ctx'>,
  revision?: PlanRevision,
): Promise<string[]> {
  const ask = revision
    ? `Topic: ${topic}\n\nCurrent plan:\n${revision.plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nThe user wants this changed: ${revision.note}\n\nGive the revised plan, same shape.`
    : topic
  const res = await deps.client.chat.completions.create({
    model: deps.model,
    messages: [
      { role: 'system', content: PLAN_PROMPT },
      { role: 'user', content: ask },
    ],
  })
  const lines = (res.choices[0]?.message?.content ?? '')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
  if (lines.length > MAX_PLAN_LINES) {
    deps.log?.event({ at: 'research', stage: 'plan-truncated', got: lines.length, kept: MAX_PLAN_LINES })
  }
  return lines.slice(0, MAX_PLAN_LINES)
}

export interface RoundDeps {
  client: OpenAI
  model: string
  ctx: ToolContext
  budget?: SubrequestBudget
  log?: TurnLog
  prompt?: string
  onProgress?: (counts: ScoutCounts) => void
}

export interface ScoutOutcome extends RoundResult {
  angle: string
  error?: string
}

export function emptyOutcome(angle: string, error: string): ScoutOutcome {
  return {
    angle,
    findings: '',
    openQuestions: [],
    urls: [],
    seenUrls: [],
    readUrls: [],
    spent: 0,
    tokens: 0,
    error,
  }
}

async function withTimeout(work: Promise<ScoutOutcome>): Promise<ScoutOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`scout timed out after ${SCOUT_TIMEOUT_MS}ms`)), SCOUT_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function runScoutWave(
  angles: string[],
  callScout: (angle: string, index: number) => Promise<ScoutOutcome>,
  log?: TurnLog,
): Promise<ScoutOutcome[]> {
  const chosen = angles.slice(0, MAX_SCOUTS)
  if (angles.length > chosen.length) {
    log?.event({ at: 'research', stage: 'scouts-truncated', total: angles.length, sent: chosen.length })
  }
  const settled = await Promise.allSettled(chosen.map((angle, i) => withTimeout(callScout(angle, i))))
  return settled.map((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      return outcome.value
    }
    const reason = String(outcome.reason)
    log?.error({ at: 'research', stage: 'scout-failed', angle: chosen[i], error: reason })
    return emptyOutcome(chosen[i], reason)
  })
}

const WRITE_UP =
  'Stop searching. From what you have already read this round, reply using exactly the ' +
  '"## Findings" / "## Open questions" / "## Done" headings and nothing else. Report only what ' +
  'this round found, in full, with the source URL beside each claim. Do not request any tool.'

const WRITE_UP_AGAIN = `${WRITE_UP}\n\nYour last message was not in that shape and was discarded.`

async function askForWriteUp(messages: ChatMessage[], deps: RoundDeps, prompt: string): Promise<RoundOutput | null> {
  const res = await deps.client.chat.completions.create({
    model: deps.model,
    messages: [...messages, { role: 'user', content: prompt }] as never,
  })
  return parseRoundOutput(res.choices[0]?.message?.content ?? '')
}

export async function runResearchRound(state: ResearchState, deps: RoundDeps): Promise<RoundResult> {
  const urls: string[] = []
  const readUrls: string[] = []
  const seenUrls: string[] = []
  const emptyQueries: string[] = []
  let searches = 0
  const report = () => deps.onProgress?.({ reads: readUrls.length, searches })
  const log = deps.log ?? deps.ctx.log
  const { text, messages, toolsUsed, tokensSpent } = await runToolLoop({
    client: deps.client,
    model: deps.model,
    systemPrompt: ROUND_PROMPT,
    history: [{ role: 'user', content: deps.prompt ?? buildRoundPrompt(state, log) }],
    tools: [...searchTools, ...browserTools, ...(deps.ctx.toolArchive ? [readToolResultTool] : [])],
    ctx: {
      ...deps.ctx,
      onPageRead: (url, ok) => {
        const key = pageKey(url)
        urls.push(key)
        if (ok) {
          readUrls.push(key)
        }
        report()
      },
      onSearchResults: (found, query) => {
        searches++
        if (!found.length) {
          emptyQueries.push(query)
        }
        for (const url of found) {
          const key = pageKey(url)
          if (!seenUrls.includes(key)) {
            seenUrls.push(key)
          }
        }
        report()
      },
      pageCache: new Map(),
      alreadyTried: (url) => state.visited.includes(pageKey(url)) || urls.includes(pageKey(url)),
      log,
    },
    subrequests: deps.budget,
    forceFinalAnswer: false,
    log,
  })

  log?.event(
    {
      at: 'research',
      stage: 'round-tools',
      searches: toolsUsed.filter((t) => t === 'web_search').length,
      emptySearches: emptyQueries.length,
      reads: toolsUsed.filter((t) => t === 'read_page').length,
    },
    emptyQueries.length ? { sample: emptyQueries.slice(0, 5).join(' | ') } : undefined,
  )

  let parsed = parseRoundOutput(text)
  if (!parsed) {
    parsed = await askForWriteUp(messages, deps, WRITE_UP)
  }
  if (!parsed) {
    log?.event({ at: 'research', stage: 'unparsed-round', chars: text.length }, { sample: text.slice(0, 400) })
    parsed = await askForWriteUp(messages, deps, WRITE_UP_AGAIN)
    log?.event({ at: 'research', stage: 'write-up-retry', rescued: parsed !== null })
  }
  const grounded = readUrls.length > 0 || seenUrls.length > 0
  if (!grounded && parsed?.findings) {
    log?.event({ at: 'research', stage: 'ungrounded-round', chars: parsed.findings.length })
  }

  return {
    findings: grounded ? (parsed?.findings ?? '') : '',
    openQuestions: parsed?.openQuestions ?? state.openQuestions,
    urls,
    seenUrls,
    readUrls,
    spent: deps.budget?.spent ?? 0,
    tokens: tokensSpent,
    modelDone: parsed?.modelDone ?? false,
  }
}
