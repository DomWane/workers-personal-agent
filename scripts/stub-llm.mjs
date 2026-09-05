#!/usr/bin/env node
// A stand-in provider for manual testing, so a walkthrough that compacts a few times costs nothing
// and answers the same way every run. Start it, then point `wrangler dev` at it:
//
//   node scripts/stub-llm.mjs
//   npx wrangler dev --local \
//     --var LLM_BASE_URL:http://127.0.0.1:8899/v1 --var LLM_API_KEY:stub --var LLM_MODEL:stub-large
//
// `--var` overrides `.env` (verified 2026-08-17, wrangler 4.107), which is what makes this
// work without editing the secrets file.

import { createServer } from 'node:http'

/** The picker reads this, and so does the compaction threshold — a live catalogue would make the
 *  model-switch dialog a different test every week. */
const MODELS = [
  {
    id: 'stub-large',
    context_length: 200_000,
    supported_parameters: ['tools'],
    pricing: { prompt: '0.000001', completion: '0.000002' },
  },
  {
    id: 'stub-small',
    context_length: 8_000,
    supported_parameters: ['tools'],
    pricing: { prompt: '0.000001', completion: '0.000002' },
  },
]

const port = Number(process.env.STUB_LLM_PORT ?? 8899)
const delayMs = Number(process.env.STUB_DELAY_MS ?? 0)

/** Distinguishable on screen: a compaction summary must be tellable from an ordinary answer. */
function reply(body) {
  return /running summary of the earlier part/i.test(body)
    ? 'SUMMARY of the earlier turns, written by the stub.'
    : 'STUB REPLY — the provider was not called.'
}

/** `STUB_OVERFLOW_ONCE=1` refuses the first completion the way a provider refuses an over-long
 *  prompt, which is the only way to reach the compact-and-retry path by hand. */
let overflowLeft = process.env.STUB_OVERFLOW_ONCE ? 1 : 0

function call(name, args) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: `stub-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
    usage: { prompt_tokens: Number(process.env.STUB_PROMPT_TOKENS ?? 1200) },
  }
}

/**
 * `STUB_TOOLS=1` makes the stub drive the tool loop from the user's own words, so the archive can be
 * walked by hand: no real model is asked to remember a ref number, and the same three keystrokes
 * produce the same three rounds every run. The trigger is what the *user* typed, not what the model
 * would decide, which is the half a stub can honestly stand in for.
 *
 * `null` when nothing matches — the caller then answers with plain text.
 */
function toolTurn(req) {
  const messages = req.messages ?? []
  const asked = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  // Counted from the last user message, not over the whole array. Tool traffic has been persisted
  // since 2026-09-01, so an earlier turn's results are in the history the loop sends — and counting
  // those made round 0 of a fresh turn look like round 1, which silently skipped the first tool.
  const lastAsk = messages.map((m) => m.role).lastIndexOf('user')
  const results = messages.slice(lastAsk).filter((m) => m.role === 'tool').length
  // The summarizer's prompt is a `user` message that quotes the whole transcript, so every trigger
  // below matches it. Answering that with a tool call handed the compaction an empty summary —
  // which it then wrote over the running one, found by hand on 2026-09-01.
  if (/running summary of the earlier part/i.test(asked)) {
    return null
  }
  // Two tools before answering, which is the shortest run that reaches the pruner: it fires at the
  // top of a round over what earlier rounds already left behind, so a two-round turn never meets it.
  if (/dump vault twice/i.test(asked) && results === 1) {
    return call('search_tool_results', { query: 'lorem' })
  }
  // The one local shape that actually *trips* the pruner rather than merely reaching it. Only a
  // tool that raised `maxResultChars` can exceed 8,192, and `read_tool_result` is the one of those
  // three that needs no vendor — it reads back a `search_memory` result the archive kept whole.
  // Three tool rounds, then the answer — four in all, which is what `PROTECT_RECENT_RESULTS = 1`
  // requires: the prune runs at the top of a round and skips the newest result, so the first cut is
  // round `N + 3`. A three-round turn reaches the pruner and never trips it.
  const refTwice = /read ref (\d+) twice/i.exec(asked)
  if (refTwice) {
    if (results === 0) {
      return call('read_tool_result', { ref: Number(refTwice[1]) })
    }
    return results < 3 ? call('search_tool_results', { query: 'lorem' }) : null
  }
  // A round that already carries a tool result is the round that answers; without this the loop
  // would call the same tool until `maxRounds` and the walkthrough would show a runaway, not a read.
  if (messages.at(-1)?.role === 'tool') {
    return null
  }
  if (/dump vault/i.test(asked)) {
    return call('search_memory', { query: 'e2e' })
  }
  if (/find in results/i.test(asked)) {
    return call('search_tool_results', { query: 'lorem' })
  }
  const ref = /read ref (\d+)/i.exec(asked)
  if (ref) {
    return call('read_tool_result', { ref: Number(ref[1]) })
  }
  return null
}

createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    if (req.url?.endsWith('/models')) {
      return res.end(JSON.stringify({ data: MODELS }))
    }
    if (overflowLeft > 0) {
      overflowLeft--
      res.statusCode = 400
      return res.end(
        JSON.stringify({
          error: { message: "This model's maximum context length is 8000 tokens", type: 'invalid_request_error' },
        }),
      )
    }
    const wanted = process.env.STUB_TOOLS === '1' ? toolTurn(JSON.parse(body)) : null
    const payload = JSON.stringify(
      wanted ?? {
        choices: [{ message: { content: reply(body) } }],
        // Measured rather than estimated, so the meter is exercised on the path production takes.
        usage: { prompt_tokens: Number(process.env.STUB_PROMPT_TOKENS ?? 1200) },
      },
    )
    // STUB_DELAY_MS is how the in-flight states — "Thinking…", "Compacting…" — stay on screen long
    // enough to look at.
    setTimeout(() => res.end(payload), delayMs)
  })
}).listen(port, () => console.log(`stub llm on http://127.0.0.1:${port} (delay ${delayMs}ms)`))
