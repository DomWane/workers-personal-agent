import type OpenAI from 'openai'
import { buildRoundPrompt, parseRoundOutput, type RoundOutput } from './research-round'
import { MAX_SCOUTS, SCOUT_TIMEOUT_MS, type ResearchState, type RoundResult } from './research-state'
import type { SubrequestBudget } from './subrequest-budget'
import { runToolLoop } from './tool-loop'
import { browserTools } from './tools/browser.tools'
import { searchTools } from './tools/search.tools'
import { readToolResultTool } from './tools/tool-archive.tools'
import type { ToolContext } from './tools/registry'
import type { TurnLog } from './log'
import type { ChatMessage } from '../types'

/**
 * One round: search, read, and rewrite the notes. The rewrite is the loop's *final answer*
 * rather than a second model call — the loop already forces one with `tool_choice: 'none'`, so
 * asking for the notes there saves one call per round, twenty across a run.
 */
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

/**
 * The report is written once, at the end, from every round's findings. Writing it incrementally
 * would recompress the early rounds once per round; this compresses each of them exactly once.
 */
const REPORT_PROMPT =
  'Write the final research report from the findings of every round, for someone who has read none ' +
  'of them. Group what belongs together under `##` headings instead of listing findings in the order ' +
  'they arrived. Markdown is rendered, so cite inline — [what the source is](url) — rather than ' +
  'ending every sentence with a bare URL. Keep every source. Prefer losing repetition to losing a ' +
  'fact, and write no preamble about what you are doing.'

export async function writeResearchReport(state: ResearchState, deps: Omit<RoundDeps, 'ctx'>): Promise<string> {
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
  deps.log?.event({ at: 'research', stage: 'report-written', rounds: state.findings.length, chars: text.length })
  return text
}

/**
 * The proposal has to say what the run will look for, not just what it costs — a confirmation
 * gate whose whole content is the echoed topic asks the user to approve something they cannot
 * see. One call, no tools: the plan is a sketch, and the rounds are free to leave it.
 */
const PLAN_PROMPT =
  'Plan a research run on the topic the user gives. Reply with two to four lines, one angle per line, ' +
  'each a concrete thing to look for. No numbering, no preamble, no commentary.'

/** Stated to the user in `ResearchProposal.vue` ("at most four angles"), because the truncation
 *  below is silent and the revise box is where someone asks for a fifth. Change both. */
const MAX_PLAN_LINES = 4

/** A plan the user asked to change, and what they said about it. */
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
    ? // Numbered, because the proposal card renders an <ol> and the user refers to what they can
      // see: "remove 2." against a bulleted list has no referent, and the model read it as "remove
      // two" and dropped the last two lines. Same mismatch the citation labels exist to prevent.
      `Topic: ${topic}\n\nCurrent plan:\n${revision.plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nThe user wants this changed: ${revision.note}\n\nGive the revised plan, same shape.`
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
  // The user asked for the fifth angle and the card will show four, with nothing saying which went.
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
  /** A scout's prompt, which is built from one angle rather than from the run's state. Everything
   *  after the prompt — the loop, the parse, the write-up retry — is the same work. */
  prompt?: string
}

export interface ScoutOutcome extends RoundResult {
  angle: string
  /** Set when this angle produced nothing: a throw, or the scout timeout. */
  error?: string
}

export function emptyOutcome(angle: string, error: string): ScoutOutcome {
  return { angle, findings: '', openQuestions: [], urls: [], seenUrls: [], read: 0, spent: 0, error }
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
    // Left pending, the timer keeps the invocation alive for its full duration after the wave is
    // already done.
    clearTimeout(timer)
  }
}

/**
 * One scout per angle, all at once. Each runs in its own Durable Object, so each gets its own fifty
 * subrequests rather than a share of this invocation's (measured 2026-08-08).
 *
 * A failed angle is a gap in the wave, never the end of it: hence `allSettled`, and a scout that
 * throws comes back as an outcome carrying the reason.
 */
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

/**
 * The round asks for its write-up itself rather than taking whatever the loop's forced
 * `tool_choice: 'none'` call produced. That call came back as leaked tool-call markup on three
 * rounds out of three, so it was a wasted request every time and the shape had to be asked for
 * again anyway.
 */
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
  const seenUrls: string[] = []
  const emptyQueries: string[] = []
  let read = 0
  const log = deps.log ?? deps.ctx.log
  const { text, messages, toolsUsed } = await runToolLoop({
    client: deps.client,
    model: deps.model,
    systemPrompt: ROUND_PROMPT,
    history: [{ role: 'user', content: deps.prompt ?? buildRoundPrompt(state, log) }],
    // Offered only where there is something to read back: without an archive the tool can do
    // nothing but return its own error, and a tool that always fails is worse than an absent one.
    tools: [...searchTools, ...browserTools, ...(deps.ctx.toolArchive ? [readToolResultTool] : [])],
    ctx: {
      ...deps.ctx,
      onPageRead: (url, ok) => {
        urls.push(url)
        if (ok) {
          read++
        }
      },
      onSearchResults: (found, query) => {
        if (!found.length) {
          emptyQueries.push(query)
        }
        for (const url of found) {
          if (!seenUrls.includes(url)) {
            seenUrls.push(url)
          }
        }
      },
      alreadyTried: (url) => state.visited.includes(url) || urls.includes(url),
      log,
    },
    subrequests: deps.budget,
    // The round writes itself up below; letting the loop force an answer as well pays twice.
    forceFinalAnswer: false,
    log,
  })

  // Searches per page opened: the cheapest signal that a round is casting about instead of reading.
  log?.event(
    {
      at: 'research',
      stage: 'round-tools',
      searches: toolsUsed.filter((t) => t === 'web_search').length,
      // A round whose searches mostly came back empty reports from memory, not from the web. The
      // queries ride in the content channel because which ones come back empty is the whole question,
      // and a count alone cannot answer it.
      emptySearches: emptyQueries.length,
      reads: toolsUsed.filter((t) => t === 'read_page').length,
    },
    emptyQueries.length ? { sample: emptyQueries.slice(0, 5).join(' | ') } : undefined,
  )

  // `text` is only non-empty when the model chose to answer instead of calling a tool; that answer
  // is already in the round's shape often enough to be worth trying before spending a call.
  let parsed = parseRoundOutput(text)
  if (!parsed) {
    parsed = await askForWriteUp(messages, deps, WRITE_UP)
  }
  if (!parsed) {
    // A wasted round was visible only as the findings not growing, which reads the same as a round
    // that searched and found nothing. Say it, and carry the text the model sent instead.
    log?.event({ at: 'research', stage: 'unparsed-round', chars: text.length }, { sample: text.slice(0, 400) })
    // Once, not until it works: a model that cannot produce the shape will not produce it on the
    // fifth try either, and the pages are already paid for.
    parsed = await askForWriteUp(messages, deps, WRITE_UP_AGAIN)
    log?.event({ at: 'research', stage: 'write-up-retry', rescued: parsed !== null })
  }
  // Nothing opened and nothing even offered by a search: whatever the model wrote came out of its
  // own memory, and passing it on would put unsourced prose in the report beside researched text.
  // Snippets alone still count — a claim cited from a search result is honest sourcing.
  const grounded = read > 0 || seenUrls.length > 0
  if (!grounded && parsed?.findings) {
    log?.event({ at: 'research', stage: 'ungrounded-round', chars: parsed.findings.length })
  }

  // A malformed rewrite wastes the round, not the run: the previous notes stand.
  return {
    findings: grounded ? (parsed?.findings ?? '') : '',
    openQuestions: parsed?.openQuestions ?? state.openQuestions,
    urls,
    seenUrls,
    read,
    spent: deps.budget?.spent ?? 0,
    modelDone: parsed?.modelDone ?? false,
  }
}
