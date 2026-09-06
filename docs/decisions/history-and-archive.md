# History, compaction and the archive

The current thresholds are in the ceilings table in [ARCHITECTURE.md](../../ARCHITECTURE.md).

## Compaction is measured against the model's context window

**Decision.** A turn schedules `runCompactHistory`; the alarm folds the head into `historySummary`,
which rides in the system prompt as `<earlier_conversation_summary>`. `COMPACT_AT_FRACTION = 0.80`
schedules it, `COMPACT_KEEP_FRACTION = 0.25` sizes the verbatim tail. The size is the provider's
`prompt_tokens` where a call reported one, else `chars / 3`, an overestimate on purpose.
**Why.** A message is ten characters or ten thousand, and the picker switches between 24k and 131k
mid-thread (measured 2026-08-12), so no message count fits both. 0.80 is `dsh-compaction-basic`'s
ratio, the one comparable number from a harness that has run this longer.
**Window.** Asked of the catalogue by the alarm and by `setModel`, kept in state per model;
`DEFAULT_CONTEXT_TOKENS = 24_000` stands in until known, the smallest window measured here. The web
client duplicates the fractions in `web/src/lib/context.ts` to predict whether a switch would
compact; nothing keeps the two in step.

## Three triggers, and the overflow one is load-bearing

After a turn; on `setModel`, because a switch down puts an already-fine surface over a smaller
window with no new turn; and on the provider refusing the prompt, which compacts inline and retries
once. The third breaks "maintenance never runs inside a turn" on purpose: the turn is already lost.
A model larger than the default corrects itself on the first check; a smaller one only through
`setModel` or overflow. A catalogue that does not list the model is not pinned
(`stage: 'context-unlisted'`), or the thread would assume 24k for good.

## Compaction records what it destroys

One row in `archive(seq, time, type, data)` in the thread's own SQLite: the evicted messages, the
summary, the ids it shadows. No retention; 10 GB against ~2 KB a turn.
**Rejected.** A journal in the vault written by compaction and an idle flush. Two writers on one
artifact needed a marker, dated segments and an ordering rule to stay disjoint.

## The record is written before the trim

A failed INSERT loses nothing; a record over a failed `setState` is a duplicate, which
`recentActivity` dedupes by id. The reverse order trades that duplicate for permanent loss.
`compaction-start` goes in before the model call so a pass that dies leaves a trace, and
`compaction-end` last, so the archive alone says the trim landed after the log expired. The alarm
abandons the write if the first message id changed; `deleteThread` is the racer.

## `state.messages` carries tool traffic, stubbed

The model needs a ref to quote at `read_tool_result`, so a turn persists its calls and results. Over
`PRUNE_OVER_CHARS = 8192` a result is head, tail and ref, and the archive holds the rest. Three
consequences:

- Pruning inside a turn destroys nothing. A result whose filing threw has no ref, is hard-capped on
  the way into state and logged `archive-failed`.
- Every reader that treats history as speech filters with `spoken()` where the messages are chosen:
  `transcript` renders anything not a user as "Assistant", and `citationLabels` and `fitHead` work
  by position over the array they are given.
- Nothing reaches the provider half-paired. Compaction moves its boundary onto the assistant that
  owns the group, and `pairedOnly` drops whatever is still unpaired from the outgoing copy. A
  permissive endpoint hides the fault until a model switch; deepseek-harness hit it with a local
  server that accepted what the vendor rejected.

## No cap on the number of messages sent

Rejected: it is a count, the unit this design abandoned, and it would show the user a conversation
the model did not see. Compaction failing while a thread grows is already caught by the threshold
rescheduling and by the provider's refusal.

## No reset, no session files, no idle flush

Deleting or starting a thread is the gesture; a reset is ambiguous about which thread it meant. An
idle flush would blank the web thread, and the token cost it existed for is what compaction bounds.
Older `agent/sessions/` files stay readable through `indexManifest()` and the keyword path.

## Reflection reads the threads, with a watermark

The `reflection` instance unions archive rows and live messages newer than its watermark from every
registered thread. The two are disjoint by construction and deduped by id for the pre-trim
duplicate; messages are filtered by their own timestamp, not the row's, or a row written last night
would re-report days-old turns. The watermark moves only if every thread answered
(`stage: 'watermark-held'` otherwise). A second channel means a registry entry, not a second path
into reflection.

## Three row types read a pass's fate

`compaction-start` alone means it never completed; `start` plus `compaction` means the record was
written and the trim is uncertain; `compaction-end` says it landed. `feedback` and `tool-result`
share the table and take no part.
