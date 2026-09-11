import type { TurnLog } from '../log'
import { presetOf, RESEARCH_SUBREQUEST_BUDGET } from './state'
import { pageKey } from '../tools/registry'
import type { ResearchState } from '../../types'

const VISITED_SHOWN = 30

const FINDINGS_SHOWN = 3

function focusFor(round: number, waved: boolean): string {
  return !waved && round < 2
    ? 'Cover the plan broadly: touch every angle in it before going deep on any one of them.'
    : 'Go deep now: chase an open question, a contradiction between sources, or a source that looked unusually relevant.'
}

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
    .filter(Boolean)
    .join('\n')
}

export function buildRoundPrompt(state: ResearchState, log?: TurnLog, now: number = Date.now()): string {
  const remaining = Math.max(0, RESEARCH_SUBREQUEST_BUDGET - state.spent)
  const deadlineMs = presetOf(state).deadlineMs
  const remainingMs = state.startedAt ? state.startedAt + deadlineMs - now : deadlineMs
  const recent = state.visited.slice(-VISITED_SHOWN)
  const omitted = state.visited.length - recent.length
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
    `<progress>Round ${state.round + 1}. About ${Math.max(0, Math.round(remainingMs / 1000))} seconds of the run remain, ` +
      'and the run ends when they do. Say you are done only if another round would add nothing.</progress>',
    `<focus>${focusFor(state.round, state.waved ?? false)}</focus>`,
    `<budget>${remaining} requests remain of ${RESEARCH_SUBREQUEST_BUDGET}.</budget>`,
  ]
    .filter(Boolean)
    .join('\n')
}

function findingsBlock(state: ResearchState, log?: TurnLog): string {
  if (!state.findings.length) {
    return '<earlier_findings>\n(first round — nothing found yet)\n</earlier_findings>'
  }
  const shown = state.findings.slice(-FINDINGS_SHOWN)
  const omitted = state.findings.length - shown.length
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

export function ungroundedCitations(findings: string, visited: string[]): string[] {
  const cited = findings.match(/https?:\/\/[^\s)\]<>"'`]+/g) ?? []
  const out: string[] = []
  const known = new Set(visited.map(pageKey))
  for (const raw of cited) {
    const url = pageKey(raw.replace(/[.,;:]+$/, ''))
    if (!known.has(url) && !out.includes(url)) {
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

// A line scan: JavaScript has no `\z`, so a lookahead regex never terminates the last section.
function section(text: string, heading: string): string | undefined {
  const wanted = heading.toLowerCase()

  let openedAt = 0
  const body: string[] = []
  for (const line of text.split('\n')) {
    const m = /^(#{1,6})\s+(\S.*)$/.exec(line)
    if (m) {
      const level = m[1].length
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

export function formatResearchProposal(state: ResearchState): string {
  return [
    `Proposed: "${state.topic}"`,
    state.plan.length ? `\nI would look for:\n${state.plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '',
    state.plan.length < 2 ? '\nOnly one angle, so this will not fan out — revise it to widen it.' : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function concatFindings(state: ResearchState): string {
  return state.findings.join('\n\n') || '(no findings)'
}

export function formatResearchOffer(state: ResearchState): string {
  const chars = state.report?.length ?? 0
  return [
    `🔎 ${state.topic} — done.`,
    `${state.round} rounds, ${state.read} pages read of ${state.visited.length} tried, ${chars} characters.`,
    '',
    'Save it into memory, where agent can find it later, or drop it.',
  ].join('\n')
}
