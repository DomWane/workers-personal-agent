# History, compaction, and the archive that survives it

Read this before changing what a thread keeps, what it sends, or what the nightly reflection is
allowed to see. The short version is in ARCHITECTURE.md's ceilings table; the reasons are here.

**History compacts instead of truncating, and the threshold is the model's own context window.**
A turn *schedules* `runCompactHistory` — maintenance never runs inside a turn — and the alarm folds
the head into `historySummary`, which rides in the system prompt as `<earlier_conversation_summary>`.
`COMPACT_AT_FRACTION = 0.80 × context` schedules it and `COMPACT_KEEP_FRACTION = 0.25 × context`
sizes the verbatim tail; 0.80 is `dsh-compaction-basic`'s `thresholdRatio`, the one comparable
number from a harness that has run this longer. A message count cannot express that threshold: a
message is anywhere between ten characters and ten thousand, and the picker switches models
mid-thread across a fivefold spread of windows (measured 2026-08-12: 24k to 131k), so any fixed
count is wrong for at least one of them. The size is the provider's own `usage.prompt_tokens` where
a call has reported one and `chars / 3` — deliberately an overestimate — before that. The window
comes from the catalogue, asked for by the alarm and by a `setModel` switch and kept in state per
model; until it answers, `DEFAULT_CONTEXT_TOKENS = 24_000` stands in, the smallest window measured
here, so an unknown model compacts early rather than overflowing. The web client keeps its own copy
of the fractions, because it predicts whether a model *switch* would compact against a window only
the browser's catalogue knows; nothing keeps the two in step.

**The stored window is not always current, and the three ways it can be wrong are worth knowing.**
A model *larger* than the default corrects itself on the first check: the assumed 24k schedules an
alarm, the alarm looks the real window up, finds room, and returns without a model call. A model
*smaller* than the default cannot — the threshold it is measured against is higher than its own
window, so nothing schedules — which is why `setModel` resolves it outright, in both directions. What
is left is a deployment whose `LLM_MODEL` is under 24k and a thread that never switches: it learns
the window from its first overflow, which is what the third trigger is for. And a vendor that
*changes* a model's window is invisible to a thread that already stored it. A catalogue that answers
but does not list the model is not pinned at all (`stage: 'context-unlisted'`): pinning the default
against its name would make that thread assume 24k for good.

Three triggers, and the third is the load-bearing one: after a turn, on a `setModel` switch (a switch
*down* can put an already-fine surface over the new window with no new turn at all), and on a
provider refusing the prompt for its size — which no proactive threshold can rule out, since one
large tool result overflows more easily than a model switch. The overflow path compacts inline and
retries once; that breaks the maintenance-outside-a-turn rule deliberately, because the turn is
already lost otherwise.

**Compaction is the only thing that destroys history, so it records what it destroys.** Beside the
trim it appends one row to `archive(seq, time, type, data)` in the thread's own SQLite, holding the
evicted messages, the summary, and the ids the summary shadows. One writer, one table, one `INSERT`
— the design this replaced put a journal in the vault, where compaction and an idle flush shared one
artifact and needed a marker, dated segments and an ordering rule to stay disjoint. Retention: none.
DO SQLite is 10 GB against ~2 KB a turn.

**`state.messages` carries tool traffic, and never at full size.** A turn persists the calls it made
and the results it got, because the model needs a ref to quote at `read_tool_result` and the tool
messages themselves do not survive a turn. What it persists is the stub, not the page:
`PRUNE_OVER_CHARS = 8192` is the point at which a result becomes head, tail and its ref, and the
archive holds the rest. Which results get a ref, and why the threshold sits where it does, is in
[tool-boundary.md](tool-boundary.md); compaction is what makes that decision safe, because it
archives **everything** it evicts, tool traffic included, so a result too small for a ref still
leaves the surface into a `compaction` row like any other message.

Three consequences of carrying tool traffic in history:

- **Pruning inside a turn destroys nothing**, because the archive holds the whole result; that is
  the entire reason it is allowed. The one exception is a result whose filing threw — no ref,
  nothing to recover — which is then hard-capped on its way into state and reported by
  `stage: 'archive-failed'`.
- **Every reader that treats history as speech must filter it first.** `transcript` renders anything
  that is not a user as "Assistant", so an unfiltered page reaches the nightly reflection as
  something the assistant said — inside the prompt that gates destructive memory writes — and the
  compaction summarizer as text to fold into `historySummary`. `spoken()` is that filter, applied at
  the point the messages are *chosen*: `citationLabels` numbers by position over the same array, and
  `fitHead` sizes its slice over what it is given, so filtering afterwards can pick a slice that is
  entirely traffic.
- **Nothing may reach the provider half-paired.** A `tool` row whose call was evicted, or a call
  whose result never came, is a 400 on a request that would otherwise have been answered — and it
  stays in state, so the thread is dead rather than degraded. Two guards: compaction moves a
  boundary back onto the assistant that owns the group, and `pairedOnly` drops whatever is still
  unpaired from the copy that goes out. The second exists because a permissive endpoint tolerates
  the fault and a strict one does not, so it can lie dormant until the user switches model;
  `deepseek-harness` hit exactly that with a local server that accepted what the vendor rejected.

**The record is written before the trim, and the order is load-bearing in one direction only.** A
failed `INSERT` throws before anything is trimmed and loses nothing; a record that lands over a
`setState` that then fails leaves the evicted turns in the archive *and* on the surface, which is a
duplicate — the window `recentActivity` dedupes by message id. The tidier-looking order, record
after trim, swaps that recoverable duplicate for permanent loss: the raw text would be in neither.
A record may claim a compaction that did not land; claiming is repairable and losing is not. A
`compaction-start` row goes in before the model call for the same reason, so a pass that dies
leaves a trace.

The alarm re-reads state after its model call and abandons the write if the first message id
changed. Its racer is `deleteThread`, after which there is no state left to write into.

**Nothing bounds the outgoing request except compaction.** A cap on the number of messages sent was
considered and rejected: it is a message *count*, the unit this design abandoned, and it would drop
the oldest turns from the prompt while state kept them — the user seeing a conversation the model
did not. What it would guard against, compaction failing while a thread keeps growing, is already
caught twice: by the threshold that schedules the next attempt and by the provider's own refusal,
which compacts inline and retries. The cost is one refused call in a thread whose compaction is
durably broken; the cost of the cap was a silent divergence nobody would find from a log.

**There is no global reset, and no session files are written.** Deleting or starting a thread is the
honest gesture once threads exist, and a reset is ambiguous about which thread it meant. Nor is
there an idle flush: on web it would blank the thread on screen, and the token cost it would exist
for is what compaction bounds. Older session summaries under `agent/sessions/` stay readable — the
prefix is still in `indexManifest()` and in the keyword path — only new ones stop being written.

**The nightly reflection reads the threads, not the vault's session files.** The `reflection`
instance keeps a watermark, asks each thread in the registry for archive rows and live messages
newer than it, and unions them; the two are disjoint by construction, because compaction moves a
message out of one and into the other in a single `setState`. Messages are filtered by their own
timestamp rather than the archive row's, or a row written last night would re-report turns from days
ago. A message can briefly be in both — the archive row is written before the trim — so the union
dedupes by id. The watermark moves only after the loop returns **and only if every thread answered**
(`stage: 'watermark-held'` when one did not): a thread that was unreachable this run would otherwise
have its turns skipped for good, on the strength of one log line. Not moving it costs a re-read.
Reflection therefore sees exactly what the registry lists, and the answer for any future second
channel is a registry entry per conversation, not a second path into reflection.

**The archive's three compaction row types make a pass's fate readable after its log expired.**
`compaction-start` alone means it never completed — it died, or the id guard abandoned it;
`compaction-start + compaction` means the record was written but the trim may not have landed;
`compaction-end` says it did. Two more types share the table, `feedback` and `tool-result`, and
neither takes part in this.
