import { describe, expect, it } from 'vitest'
import {
  buildRoundPrompt,
  buildScoutPrompt,
  formatResearchProposal,
  parseRoundOutput,
  ungroundedCitations,
} from '@/agent/research/round'
import { RESEARCH_SUBREQUEST_BUDGET, applyRound, proposeResearch, startResearch } from '@/agent/research/state'
import type { ResearchState } from '@/types'

const running = (over: Partial<ResearchState> = {}): ResearchState => ({
  ...(startResearch(proposeResearch('agent eval trends', ['who publishes']), 'run-1') as ResearchState),
  ...over,
})

describe('parseRoundOutput', () => {
  const wellFormed = [
    '## Findings',
    'Two labs published agent-eval work in 2026. [1] https://example.com/a',
    '',
    '## Open questions',
    '- does anyone measure trajectory cost?',
    '- what does the ACM paper claim?',
    '',
    '## Done',
    'no',
  ].join('\n')

  it('reads notes, questions and the done flag', () => {
    expect(parseRoundOutput(wellFormed)).toEqual({
      findings: 'Two labs published agent-eval work in 2026. [1] https://example.com/a',
      openQuestions: ['does anyone measure trajectory cost?', 'what does the ACM paper claim?'],
      modelDone: false,
    })
  })

  it('reads done as true only on an affirmative', () => {
    expect(parseRoundOutput(wellFormed.replace('\nno', '\nyes'))?.modelDone).toBe(true)
    expect(parseRoundOutput(wellFormed.replace('\nno', '\nYES'))?.modelDone).toBe(true)
    expect(parseRoundOutput(wellFormed.replace('## Done\nno', ''))?.modelDone).toBe(false)
  })

  it('keeps sub-headings inside a section instead of ending it on them', () => {
    // Observed 2026-08-08 on a real run: the model structured 6642 characters of notes under
    // `###` sub-headings. Any heading ended the section, so the body came out empty and a good
    // answer was discarded and re-asked for.
    const nested = [
      '## Findings',
      '',
      '### What RAG is',
      'A two-stage architecture. [1] https://example.com/a',
      '',
      '### How it is measured',
      'Disaggregated per component.',
      '',
      '## Done',
      'no',
    ].join('\n')

    const out = parseRoundOutput(nested)
    expect(out?.findings).toContain('### What RAG is')
    expect(out?.findings).toContain('Disaggregated per component.')
    expect(out?.findings).not.toContain('## Done')
  })

  it('tolerates heading case and bullet style', () => {
    const loose = '## FINDINGS\nbody text here\n\n## open questions\n* first\n1. second\n'
    expect(parseRoundOutput(loose)).toMatchObject({
      findings: 'body text here',
      openQuestions: ['first', 'second'],
    })
  })

  it('returns null when there are no findings, rather than an empty string', () => {
    // The caller appends nothing on null. Accepting an empty string would put a blank round into
    // the findings the report is written from.
    expect(parseRoundOutput('I could not find anything useful.')).toBeNull()
    expect(parseRoundOutput('## Findings\n\n## Open questions\n- a')).toBeNull()
    expect(parseRoundOutput('')).toBeNull()
  })

  it('treats a missing open-questions section as none left, not as a parse failure', () => {
    expect(parseRoundOutput('## Findings\nfindings\n')).toEqual({
      findings: 'findings',
      openQuestions: [],
      modelDone: false,
    })
  })
})

describe('formatResearchProposal', () => {
  it('numbers the plan so a revision can name one line', () => {
    const text = formatResearchProposal(running({ plan: ['who publishes', 'what they measure'] }))

    expect(text).toContain('1. who publishes')
    expect(text).toContain('2. what they measure')
    // The ways out are buttons in the client, so naming commands here would advertise a surface
    // the UI does not show.
    expect(text).not.toMatch(/\/research/)
  })

  it('quotes no cost, because one number over every run is not a thing to decide on', () => {
    // Dropped deliberately: a per-run budget says nothing until the scope is chosen, and the model
    // relaying the proposal dropped the line anyway.
    expect(formatResearchProposal(running())).not.toMatch(new RegExp(String(RESEARCH_SUBREQUEST_BUDGET)))
  })
})

describe('buildRoundPrompt', () => {
  it('carries what earlier rounds found, the open questions and the remaining budget', () => {
    const state = applyRound(running(), {
      findings: 'what we know so far',
      openQuestions: ['is cost measured?'],
      urls: ['https://example.com/a'],
      readUrls: ['https://example.com/a'],
      spent: 40,
    })

    const prompt = buildRoundPrompt(state)

    expect(prompt).toContain('agent eval trends')
    expect(prompt).toContain('what we know so far')
    expect(prompt).toContain('is cost measured?')
    // Remaining, not spent: the model is being asked to decide how much more to do.
    expect(prompt).toContain(String(RESEARCH_SUBREQUEST_BUDGET - 40))
  })

  it('tells the model how long the preset leaves, not the five-minute constant', () => {
    // A model told it has five minutes paces itself for five on a two-minute run. Mutation check:
    // read RESEARCH_DEADLINE_MS again and this says 300.
    expect(buildRoundPrompt(running({ preset: 'quick', startedAt: 0 }))).toContain('About 120 seconds')
  })

  it('tells the model which pages are already read so it does not re-fetch them', () => {
    const state = running({ visited: ['https://example.com/a', 'https://example.com/b'] })
    const prompt = buildRoundPrompt(state)

    expect(prompt).toContain('https://example.com/a')
    expect(prompt).toContain('https://example.com/b')
  })

  it('caps the visited list so a long run cannot crowd out the notes', () => {
    // Twenty rounds of reading would otherwise grow this section without bound — the exact
    // failure the notes design exists to avoid.
    const many = Array.from({ length: 200 }, (_, i) => `https://example.com/${i}`)
    const lines = buildRoundPrompt(running({ visited: many })).split('\n')

    const listed = lines.filter((l) => l.startsWith('https://example.com/'))
    expect(listed.length).toBeLessThan(50)
    // The most recent are the ones that matter for not repeating yourself; the oldest are gone
    // but their count is not, so the model still knows how much ground is covered.
    expect(listed).toContain('https://example.com/199')
    expect(listed).not.toContain('https://example.com/0')
    expect(lines.join('\n')).toContain('count="200"')
  })

  it('says out loud that the list was cut, because the prompt is not the deduplication', () => {
    // The truncated tail stays enforced by read_page; this line is so a reader of the log can
    // tell a prompt that showed everything from one that showed a window.
    const many = Array.from({ length: 200 }, (_, i) => `https://example.com/${i}`)
    const events: Record<string, unknown>[] = []
    buildRoundPrompt(running({ visited: many }), { event: (f: Record<string, unknown>) => events.push(f) } as never)

    expect(events).toContainEqual(expect.objectContaining({ stage: 'visited-truncated', total: 200 }))
  })

  it('carries the plan, so round one looks for what the proposal promised', () => {
    expect(buildRoundPrompt(running())).toContain('who publishes')
  })

  it('tells the model how long is left, not how many rounds', () => {
    // The deadline is what ends the run. A model told it has eleven rounds left paces itself for
    // eleven rounds it will not get.
    const prompt = buildRoundPrompt(running({ round: 2, startedAt: 1_000_000 }), undefined, 1_060_000)
    expect(prompt).toMatch(/Round 3\./)
    expect(prompt).toMatch(/240 seconds of the run remain/)
  })

  it('asks the early rounds for breadth and the later ones for depth', () => {
    // The prompt asked for depth from round one, and the model closed a single angle and called
    // the topic covered on three runs out of three. Breadth first is what fixed that.
    expect(buildRoundPrompt(running({ round: 0 }))).toMatch(/broadly|every angle/i)
    expect(buildRoundPrompt(running({ round: 4 }))).toMatch(/deep|contradiction/i)
  })

  it('says the round is the first one when there are no notes yet', () => {
    expect(buildRoundPrompt(running())).toMatch(/first round|no notes yet/i)
  })
})

describe('buildScoutPrompt', () => {
  it('names the one angle and says the others are taken', () => {
    const prompt = buildScoutPrompt('agent evals', 'who publishes', [])
    expect(prompt).toContain('<your_angle>\nwho publishes\n</your_angle>')
    expect(prompt).toMatch(/only yours/i)
  })

  it('carries the pages the run already paid for', () => {
    const prompt = buildScoutPrompt('agent evals', 'who publishes', ['https://x'])
    expect(prompt).toContain('https://x')
    expect(prompt).toContain('count="1"')
  })

  it('states no round count: a scout is not a round of the run', () => {
    const prompt = buildScoutPrompt('agent evals', 'who publishes', [])
    expect(prompt).not.toContain('<progress>')
    expect(prompt).not.toContain('<plan>')
  })
})

describe('focus after a wave', () => {
  const waved = (over: Partial<ResearchState>): ResearchState => running({ waved: true, ...over })

  it('goes deep from the round after the wave, with no second breadth pass', () => {
    // Without a wave rounds 0 and 1 are the breadth pass; the wave covered every angle at once,
    // so there is no breadth left to ask for.
    expect(buildRoundPrompt(waved({ round: 1 }))).toMatch(/Go deep now/)
  })

  it('still opens with breadth when no wave ran', () => {
    expect(buildRoundPrompt(running({ round: 1 }))).toMatch(/Cover the plan broadly/)
  })
})

describe('ungroundedCitations', () => {
  it('names a source the run never opened', () => {
    // The report is written from the findings and never checked against what was read, so an
    // invented citation reaches the reader looking exactly like a real one.
    const found = ungroundedCitations('Claim. https://invented.example/paper', ['https://real.example/a'])
    expect(found).toEqual(['https://invented.example/paper'])
  })

  it('says nothing when every citation was read', () => {
    expect(ungroundedCitations('Claim. https://real.example/a', ['https://real.example/a'])).toEqual([])
  })

  it('does not blame a full stop for an unread page', () => {
    expect(ungroundedCitations('As shown at https://real.example/a.', ['https://real.example/a'])).toEqual([])
    // A page read under one spelling and cited under another is the same page: twelve real pages
    // were flagged in one round for a trailing slash. Mutation check: compare raw strings again.
    expect(
      ungroundedCitations('See https://real.example/a/ and https://real.example/a#top', ['https://real.example/a']),
    ).toEqual([])
  })

  it('reports a repeated invention once', () => {
    const text = 'One https://invented.example/x and again https://invented.example/x'
    expect(ungroundedCitations(text, [])).toEqual(['https://invented.example/x'])
  })
})

describe('a plan that will not fan out', () => {
  it('says so on the proposal, because only the user can widen it', () => {
    const one = { ...running(), plan: ['who publishes'] }
    expect(formatResearchProposal(one)).toMatch(/will not fan out/i)
  })

  it('stays quiet when the plan has angles to split', () => {
    const two = { ...running(), plan: ['who publishes', 'what they measure'] }
    expect(formatResearchProposal(two)).not.toMatch(/will not fan out/i)
  })
})
