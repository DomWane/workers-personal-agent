import type { TurnLog } from './log'
import { RESEARCH_DEADLINE_MS, RESEARCH_SUBREQUEST_BUDGET, type ResearchState } from './research-state'

/**
 * The prompt one research round is given, and the parser for what it returns. Pure, so the two
 * places where a run loses information — a malformed rewrite, or a prompt that has grown past
 * what it can carry — are testable without touching a model.
 */

/** Enough to avoid re-fetching, bounded so a long run cannot crowd out the findings. */
const VISITED_SHOWN = 30

/** How many earlier rounds a round is shown. It needs continuity, not the whole run: the report
 *  is written from every finding at the end, so nothing shown here is the only copy. */
const FINDINGS_SHOWN = 3

/**
 * Breadth before depth. Our prompt asked for depth from round one, and the model closed one angle
 * and declared the topic covered on three runs out of three. A wave already covered every angle in
 * parallel, so after one there is no breadth left to ask for.
 */
function focusFor(round: number, waved: boolean): string {
  return !waved && round < 2
    ? 'Cover the plan broadly: touch every angle in it before going deep on any one of them.'
    : 'Go deep now: chase an open question, a contradiction between sources, or a source that looked unusually relevant.'
}

/** No plan, no progress and no budget line: a scout sees one angle, has an invocation of its own to
 *  spend, and its round count is not the run's. */
export function buildScoutPrompt(topic: string, angle: string, alreadyTried: string[]): string {
  const recent = alreadyTried.slice(-VISITED_SHOWN)
  return [
    `<topic>\n${topic}\n</topic>`,
    '',
    `<your_angle>\n${angle}\n</your_angle>`,
    '',
    `<already_tried count="${alreadyTried.length}">`,
    recent.join('\n') || '(nothing yet)',
    '</already_tried>',
    '',
    '<focus>Several researchers are covering different angles of this topic at the same time. ' +
      'Cover yours and only yours — the others are taken. Go wide within it: find the sources and ' +
      'what they say, not the last word on the topic.</focus>',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export function buildRoundPrompt(state: ResearchState, log?: TurnLog, now: number = Date.now()): string {
  const remaining = Math.max(0, RESEARCH_SUBREQUEST_BUDGET - state.spent)
  const remainingMs = state.startedAt ? state.startedAt + RESEARCH_DEADLINE_MS - now : RESEARCH_DEADLINE_MS
  const recent = state.visited.slice(-VISITED_SHOWN)
  const omitted = state.visited.length - recent.length
  // Loud rather than silent: what the prompt shows and what the run has actually read stop being
  // the same thing here, and only read_page's own refusal keeps the difference from costing money.
  if (omitted > 0) {
    log?.event({ at: 'research', stage: 'visited-truncated', total: state.visited.length, shown: recent.length })
  }

  return [
    `<topic>\n${state.topic}\n</topic>`,
    '',
    state.plan.length ? `<plan>\n${state.plan.map((p) => `- ${p}`).join('\n')}\n</plan>` : '',
    '',
    findingsBlock(state, log),
    '',
    state.openQuestions.length
      ? `<open_questions>\n${state.openQuestions.map((q) => `- ${q}`).join('\n')}\n</open_questions>`
      : '<open_questions>\n(none recorded)\n</open_questions>',
    '',
    `<already_tried count="${state.visited.length}">`,
    recent.join('\n') || '(nothing yet)',
    omitted > 0 ? `…and ${omitted} earlier` : '',
    '</already_tried>',
    '',
    // Time rather than a round count: the deadline is what ends the run, and a model told it has
    // eleven rounds left paces itself for eleven rounds it will not get.
    `<progress>Round ${state.round + 1}. About ${Math.max(0, Math.round(remainingMs / 1000))} seconds of the run remain, ` +
      'and the run ends when they do. Say you are done only if another round would add nothing.</progress>',
    `<focus>${focusFor(state.round, state.waved ?? false)}</focus>`,
    `<budget>${remaining} requests remain of ${RESEARCH_SUBREQUEST_BUDGET}.</budget>`,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

function findingsBlock(state: ResearchState, log?: TurnLog): string {
  if (!state.findings.length) {
    return '<earlier_findings>\n(first round — nothing found yet)\n</earlier_findings>'
  }
  const shown = state.findings.slice(-FINDINGS_SHOWN)
  const omitted = state.findings.length - shown.length
  // The window is for continuity only. Saying so keeps a reader of the log from mistaking it for
  // the loss the rewritten-notes design used to cause.
  if (omitted > 0) {
    log?.event({ at: 'research', stage: 'findings-windowed', total: state.findings.length, shown: shown.length })
  }
  return [
    `<earlier_findings rounds="${state.findings.length}">`,
    omitted > 0 ? `(the ${omitted} earlier rounds are kept for the report but not shown here)` : '',
    ...shown,
    '</earlier_findings>',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * URLs a round cited that the run never opened. `visited` is the run's own record of what it paid
 * for, so the check needs no model and no network — and reviewing the finished report could not
 * find these anyway, because an invented citation looks exactly like a read one.
 */
export function ungroundedCitations(findings: string, visited: string[]): string[] {
  const cited = findings.match(/https?:\/\/[^\s)\]<>"'`]+/g) ?? []
  const out: string[] = []
  for (const raw of cited) {
    // Trailing punctuation belongs to the prose, not the URL, and would fail every comparison.
    const url = raw.replace(/[.,;:]+$/, '')
    if (!visited.includes(url) && !out.includes(url)) {
      out.push(url)
    }
  }
  return out
}

export interface RoundOutput {
  findings: string
  openQuestions: string[]
  modelDone: boolean
}

/**
 * Line scan rather than one regex: the obvious `(?=^#{1,6}|\z)` lookahead silently never
 * terminates the last section, because JavaScript has no `\z` and reads it as the letter z.
 */
function section(text: string, heading: string): string | undefined {
  const wanted = heading.toLowerCase()

  let openedAt = 0
  const body: string[] = []
  for (const line of text.split('\n')) {
    const m = /^(#{1,6})\s+(\S.*)$/.exec(line)
    if (m) {
      const level = m[1].length
      // Only a heading at the same depth or shallower ends the section. A `###` under `## Findings`
      // is how the model structures the notes, and treating it as a terminator threw away 6642
      // characters of a good answer on 2026-08-08.
      if (openedAt && level <= openedAt) {
        break
      }
      if (!openedAt && m[2].trim().toLowerCase() === wanted) {
        openedAt = level
        continue
      }
      if (!openedAt) {
        continue
      }
    }
    if (openedAt) {
      body.push(line)
    }
  }
  return openedAt ? body.join('\n').trim() || undefined : undefined
}

/**
 * Null means "this round produced nothing usable" — the caller appends nothing and the earlier
 * rounds stand. Returning an empty string instead would put a blank entry in the findings the
 * report is written from.
 */
export function parseRoundOutput(text: string): RoundOutput | null {
  const findings = section(text, 'findings')
  if (!findings) {
    return null
  }

  const questionBlock = section(text, 'open questions') ?? ''
  const openQuestions = questionBlock
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .filter((q) => !/^\(none/i.test(q))

  const done = section(text, 'done') ?? ''
  return { findings, openQuestions, modelDone: /^(yes|true|done)\b/i.test(done.trim()) }
}

/**
 * What the user is asked to approve. Both entry points send this, so the tool cannot offer a
 * thinner gate than the command does. No cost figure: one number covering every run says nothing
 * a decision can turn on, and the model dropped it when relaying anyway.
 */
export function formatResearchProposal(state: ResearchState): string {
  return [
    `Proposed: "${state.topic}"`,
    // Numbered so a revision can name one: "drop 2" is the shortest revision that works, and a
    // bulleted list gives the user nothing to point at.
    state.plan.length ? `\nI would look for:\n${state.plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '',
    // A one-angle plan silently turns the breadth wave back into a single sequential round, which
    // is the whole feature going quiet. Said here because only the user can widen it.
    state.plan.length < 2 ? '\nOnly one angle, so this will not fan out — revise it to widen it.' : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * The fallback report: every finding, in order, with nothing thrown away. Used when the write call
 * fails, so a run that gathered material never ends with nothing to show for it.
 */
export function concatFindings(state: ResearchState): string {
  return state.findings.join('\n\n') || '(no findings)'
}

/**
 * What arrives when a run finishes: the shape of it, and the two ways out. The report itself is
 * already in broadcast state, so this is the offer and not the delivery.
 */
export function formatResearchOffer(state: ResearchState): string {
  const chars = state.report?.length ?? 0
  return [
    `🔎 ${state.topic} — done.`,
    `${state.round} rounds, ${state.read} pages read of ${state.visited.length} tried, ${chars} characters.`,
    '',
    'Save it into memory, where agent can find it later, or drop it.',
  ].join('\n')
}
