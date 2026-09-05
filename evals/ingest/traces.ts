import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { isFromService, stripClientMetadata } from '../lib/ingest-filter.ts'

/**
 * Free-plan Workers Logs are retained 3 days, so a missed run loses those turns permanently.
 * This exports the whole window unfiltered rather than only the agent's structured `at` lines:
 * uncaught exceptions and request-level records are what a vanished turn leaves behind, and
 * deciding at export time that they are uninteresting is a decision that cannot be revisited.
 */

const ACCOUNT = process.env.CF_ACCOUNT_ID
const TOKEN = process.env.CF_API_TOKEN
const OUT = 'evals/data/traces.jsonl'
const SERVICE = 'personal-agent'
const PAGE = 2000
const MAX_PAGES = 50
const WINDOW_DAYS = Number.parseInt(process.env.TRACE_WINDOW_DAYS ?? '3', 10)

if (!ACCOUNT || !TOKEN) {
  console.error('set CF_ACCOUNT_ID and CF_API_TOKEN (Account Analytics: Read) in .env')
  process.exit(1)
}

type Event = { $metadata?: { id?: string } }

const seen = new Set<string>()
if (existsSync(OUT)) {
  for (const line of readFileSync(OUT, 'utf8').split('\n')) {
    if (!line.trim()) {
      continue
    }
    const id = (JSON.parse(line) as Event).$metadata?.id
    if (id) {
      seen.add(id)
    }
  }
}
const before = seen.size

const to = new Date()
const from = new Date(to.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000)

async function page(offset?: string): Promise<Event[]> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        queryId: 'trace-export',
        view: 'events',
        limit: PAGE,
        // Defaults to true server-side, which returns metadata and no events.
        dry: false,
        ...(offset ? { offset, offsetDirection: 'next' } : {}),
        parameters: { datasets: [] },
        // The API takes epoch millis here; ISO strings are rejected with a 400.
        timeframe: { from: from.getTime(), to: to.getTime() },
      }),
    },
  )
  const text = await res.text()
  if (!res.ok) {
    console.error(`observability query failed: ${res.status} ${text.slice(0, 500)}`)
    process.exit(1)
  }
  const body = JSON.parse(text) as { result?: { events?: { events?: Event[] } } }
  const events = body.result?.events?.events
  if (!events) {
    console.error(`unexpected response shape: ${text.slice(0, 500)}`)
    process.exit(1)
  }
  return events
}

mkdirSync('evals/data', { recursive: true })

let added = 0
let offset: string | undefined
for (let p = 0; p < MAX_PAGES; p++) {
  const events = await page(offset)
  if (events.length === 0) {
    break
  }

  let fresh = 0
  let foreign = 0
  for (const e of events) {
    const id = e.$metadata?.id
    if (!id || seen.has(id)) {
      continue
    }
    seen.add(id)
    // The account runs more than one Worker and the query returns all of them.
    if (!isFromService(e, SERVICE)) {
      foreign++
      continue
    }
    appendFileSync(OUT, `${JSON.stringify(stripClientMetadata(e))}\n`)
    added++
    fresh++
  }

  if (foreign) {
    console.log(`  page ${p}: skipped ${foreign} records from other workers`)
  }
  const last = events[events.length - 1]?.$metadata?.id
  // A page whose ids are all known still has to be walked past: the window is re-queried from
  // the start on every run, so early pages are duplicates by design and are not an end signal.
  if (events.length < PAGE || !last || last === offset) {
    break
  }
  offset = last
  if (fresh === 0 && p > 0 && events.length < PAGE) {
    break
  }
}

const total = existsSync(OUT) ? readFileSync(OUT, 'utf8').split('\n').filter(Boolean).length : 0
console.log(`${added} new records, ${total} in ${OUT} (was ${before})`)
if (added === 0 && before === 0) {
  console.error('nothing exported — check the token has Account Analytics: Read on this account')
  process.exit(1)
}
