#!/usr/bin/env node
// Fills the web agent with a conversation that exercises every part of the chat UI: markdown,
// per-message tool usage, a compacted history marker, and a finished research run with a report
// and sources. Run `pnpm dev` first, then `node scripts/seed-web-chat.mjs [--phase proposed|running|done]`.
//
// `--scenario` sets up the states that are awkward to reach by typing — a conversation long enough
// to compact, or one that a smaller model could not hold. See docs/manual-e2e.md.

const base = process.env.SEED_URL ?? 'http://localhost:8787/dev/seed'
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback)
const phase = arg('--phase', 'done')
const scenario = arg('--scenario', 'chat')
const now = Date.now()
const min = 60_000

let seq = 0
const msg = (role, content, extra = {}) => ({
  role,
  content,
  id: `seed-${seq++}`,
  at: now - (30 - seq) * min,
  ...extra,
})

const REPORT = `# Deep research on Cloudflare Workers free-tier limits

## What was measured

Three limits decide how much work a single invocation can do, and two of them are
undocumented for Workers AI:

| Limit | Value | Evidence |
| :--- | :--- | :--- |
| External subrequests | 50 | dies on the 51st |
| Calls to another Durable Object | 1,000 | distinct error message |
| CPU per Durable Object | 30 s | \`exceededCpu\` at 32,000 ms |

## Why fan-out multiplies the budget

A child Durable Object spends from **its own** fifty subrequests, and a parent awaiting
children pays almost no CPU of its own. Five children therefore carry 250 external
requests where one invocation carries 50.

\`\`\`ts
const outcomes = await Promise.all(angles.map((angle, i) => callScout(angle, i)))
\`\`\`

## Open questions

- Whether Vectorize is usable on the Free plan (the pricing page contradicts itself).
- Whether \`read_page\` fallbacks are blocking or our own concurrency.
`

const messages = [
  msg('user', 'Hi! What can you do?'),
  msg(
    'assistant',
    'I search the web, read pages, keep notes in a vault, and can run a **deep research** pass from the mode picker in the composer.\n\nTry, for instance:\n\n1. switching the mode to research and asking about "Cloudflare Workers limits"\n2. picking another model right in the composer\n3. asking what I remember about you',
  ),
  msg('user', 'What does a Firecrawl search cost?'),
  msg(
    'assistant',
    'Firecrawl charges **2 credits** a search and allows 10 requests a minute. Tavily is cheaper: 1 credit and 100 a minute, which is why it leads the chain here.',
    { tools: ['search_memory', 'web_search', 'read_page'] },
  ),
  msg('user', 'And embeddings, do they count against subrequests?'),
  msg(
    'assistant',
    'Yes — `env.AI.run` counts against the **external** limit of 50, even though the docs do not say so. R2 through a binding does not count at all (measured: 200 of 200 passed).',
    { tools: ['search_memory'] },
  ),
]

const research = {
  proposed: {
    runId: 'seed-run',
    topic: 'Cloudflare Workers free-tier limits',
    phase: 'proposed',
    plan: [
      'What the documentation states about subrequests, CPU and Durable Objects',
      'What practitioners report measuring in production',
      'Whether Workers AI and R2 count against the same budget',
      'What the paid plan changes, and at what price',
    ],
    round: 0,
    spent: 0,
    visited: [],
    findings: [],
    openQuestions: [],
    startedAt: now,
  },
  running: {
    runId: 'seed-run',
    topic: 'Cloudflare Workers free-tier limits',
    phase: 'running',
    plan: [
      'What the documentation states about subrequests, CPU and Durable Objects',
      'What practitioners report measuring in production',
      'Whether Workers AI and R2 count against the same budget',
    ],
    round: 2,
    spent: 84,
    scoutSpent: 57,
    visited: [
      'https://developers.cloudflare.com/workers/platform/limits/',
      'https://developers.cloudflare.com/durable-objects/platform/limits/',
      'https://blog.cloudflare.com/workers-ai/',
      'https://community.cloudflare.com/t/subrequest-limit/',
    ],
    findings: ['Round 1 covered the documented limits.', 'Round 2 is chasing the Workers AI question.'],
    openQuestions: ['Does env.AI.run count against the external 50?', 'Is Vectorize available on the Free plan?'],
    startedAt: now - 2 * min,
  },
  done: {
    runId: 'seed-run',
    topic: 'Cloudflare Workers free-tier limits',
    phase: 'done',
    plan: [
      'What the documentation states about subrequests, CPU and Durable Objects',
      'What practitioners report measuring in production',
      'Whether Workers AI and R2 count against the same budget',
    ],
    round: 5,
    spent: 190,
    scoutSpent: 143,
    visited: [
      'https://developers.cloudflare.com/workers/platform/limits/',
      'https://developers.cloudflare.com/durable-objects/platform/limits/',
      'https://developers.cloudflare.com/workers-ai/platform/limits/',
      'https://blog.cloudflare.com/workers-ai/',
      'https://community.cloudflare.com/t/subrequest-limit/',
    ],
    findings: ['Documented limits.', 'Measured limits.', 'Where the two disagree.'],
    openQuestions: ['Whether Vectorize is usable on the Free plan.'],
    stopCause: 'time',
    report: REPORT,
    startedAt: now - 5 * min,
  },
}

if (!research[phase]) {
  console.error(`unknown phase "${phase}" — use proposed, running or done`)
  process.exit(1)
}

/** Two thousand characters a turn: long enough that ten of them are a real conversation to fold,
 *  short enough to tell apart on screen. */
const bulkTurns = (n) =>
  Array.from({ length: n }, (_, i) => msg(i % 2 === 0 ? 'user' : 'assistant', `turn ${i} `.padEnd(2000, '.')))

const chatState = {
  messages,
  channel: { kind: 'web' },
  historySummary:
    'The user set up the agent on Cloudflare Workers and measured the free-tier limits with a throwaway probe Worker. ' +
    'Decisions: research runs fan out into scout Durable Objects, Tavily leads the search chain, and the run is bounded by a five-minute deadline rather than a round floor.',
  research: research[phase],
}

/**
 * `promptTokens` is what the meter and the compaction threshold read — the provider's own count
 * from the last turn — and it is derived from the seeded text rather than picked, because the two
 * have to agree. A first attempt set it to 150k over 15k of messages: the threshold fired and then
 * found nothing to evict, which looked like a broken feature and was a broken fixture.
 */
const bulk = (n, extra = {}) => {
  const messages = bulkTurns(n)
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0)
  return {
    messages,
    channel: { kind: 'web' },
    promptTokens: Number(arg('--tokens', Math.ceil(chars / 3))),
    ...extra,
  }
}

const scenarios = {
  chat: chatState,
  // Short answers with one plainly wrong: something to disagree with, so the rating and its note
  // have a reason to exist rather than being clicked at random.
  feedback: {
    channel: { kind: 'web' },
    promptTokens: 900,
    messages: [
      msg('user', 'What do you remember about what I drink?'),
      msg('assistant', 'Green tea every morning, and no coffee at all.'),
      msg('user', 'And about work?'),
      msg('assistant', 'You are building a personal agent on Cloudflare Workers, on the free plan.'),
    ],
  },
  // Far under any threshold: only the Compact button can fold this one.
  compact: bulk(10),
  // Over 80% of `--model`'s window, so the next turn schedules a compaction with no button pressed.
  // Needs a small-window model to be over anything: 20 turns is ~13k tokens.
  threshold: bulk(20, { modelOverride: arg('--model', 'stub-small') }),
  // ~7k tokens: fits a large window and not an 8k one, so picking a small model must ask first.
  switch: bulk(10),
  // Already compacted once: the summary marker is on screen and the archive holds the rest.
  compacted: bulk(2, {
    historySummary: 'Earlier: the user walked through the free-tier limits and the wave design.',
  }),
}

if (!scenarios[scenario]) {
  console.error(`unknown scenario "${scenario}" — use ${Object.keys(scenarios).join(', ')}`)
  process.exit(1)
}

const state = scenarios[scenario]

// A real thread, not the landing: sending a message from `main` starts a new one, so anything
// seeded there could never receive the turn that is being tested.
const thread = arg('--thread', `t-${scenario}`)
// The chat scenario is the one in the README image, so it carries a real name.
const title = arg('--title', scenario === 'chat' ? 'Cloudflare free-tier limits' : `seed: ${thread}`)

// A thread that has been running on a model already knows its window — the agent learns it once
// and keeps it. Seeding without it leaves the threshold measured against the conservative default,
// which for a model *smaller* than that default is the difference between the scenario firing and
// silently doing nothing.
const catalogue =
  scenario === 'chat' || state.modelOverride ? await fetch(new URL('/api/models', base)).then((r) => r.json()) : null
// The picture shows whatever this deployment answers with, never a model it could not call.
if (scenario === 'chat') {
  state.modelOverride = catalogue.current
}
if (state.modelOverride) {
  const row = catalogue.models?.find((m) => m.id === state.modelOverride)
  if (row?.context) {
    state.contextModel = state.modelOverride
    state.contextTokens = row.context
  } else {
    console.warn(`model "${state.modelOverride}" is not in the catalogue — the window stays unknown`)
  }
}

const res = await fetch(`${base}?thread=${encodeURIComponent(thread)}&title=${encodeURIComponent(title)}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(state),
})
if (!res.ok) {
  console.error(`seed failed: ${res.status} ${await res.text()}`)
  process.exit(1)
}
console.log(
  `seeded scenario "${scenario}": ${state.messages.length} messages` +
    (state.promptTokens ? `, ${state.promptTokens} prompt tokens` : '') +
    (state.research ? `, research phase "${phase}"` : '') +
    `\nopen http://localhost:8787/?t=${thread}`,
)
