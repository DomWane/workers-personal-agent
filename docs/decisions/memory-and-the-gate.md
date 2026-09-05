# Provenance, the destructive-write gate, and the ratings nothing reads yet

Read this before changing how a memory is written, archived, or justified. The gate exists because
unaided self-correction makes reasoning worse (Huang et al., ICLR 2024, arXiv:2310.01798); what it
actually enforces today is narrower than that, and the gap is recorded here rather than glossed.

**Ratings are collected and nothing reads them yet — neither half.** The design gives the gate three
signals; only one is built. `delete_memory` is grounded on a **cited user turn**, verified against
the thread that holds it; the thumbs-down the design names as the strongest signal is written to the
archive and read by nothing, and the other two — a tool error, and a contradiction evidenced by two
archived turns with times — are not implemented at all. That is a gap, not a design: the gate today
runs on citations alone.

Keeping the ratings anyway is the one case where "no reader yet" is not the argument it usually is.
A judge calibrated only on failures has no false-positive rate — TPR without TNR — so the positive
class is what makes the negatives measurable later; and unlike code, this data cannot be added
retroactively, so switching it on in six months loses everything before that day, at ~100 bytes a
click against DO SQLite's 10 GB. Two things it must not be read as: the ratio of ratings is **not**
a quality metric, because people click when annoyed; and nothing exports the archive today, so
`evals/` cannot reach it — a rating is a label with no path out of the Durable Object it lives in.

**The gate covers both writes that destroy something: archiving a memory, and `op=replace`/`remove`
on the profile.** Appending is free. The profile is the one that matters most and was nearly missed —
it is the write the nightly prompt steers toward first ("reconcile contradictions"), it costs tokens
on every single turn, and a line deleted there is gone from the only memory the model always sees.
Overwriting a memory in place through `save_memory` is *not* gated: updating a fact under its own
name is the intended way to keep memory current, and gating it would refuse most of what the
assistant learns. The previous text of an overwritten memory is genuinely lost — the one hole left in
"compaction is the only thing that destroys history".

**In a chat the gate satisfies itself, deliberately.** With no `cited_turn` the tool falls back to
the user message the turn is answering, which always verifies — so archiving from a conversation is
effectively ungated. That is the honest reading of "an explicit user correction": the user is
present and has just spoken. It is also the only citable thing there, because the history the model
sees carries no ids. The unattended nightly pass has no such fallback, and that is the case the gate
was built for.

This is also why `delete_memory` advertises `cited_turn` and `thread` as **optional** — see
[tool-boundary.md](tool-boundary.md) for the drift that forced the question. The nudge the nightly
pass needs is in `REFLECTION_PROMPT`, the only place the unattended path is told to send a `thread`.
Without one the citation resolves against `reflection`, which is never in the registry, and the
model is told its thread was deleted — the one refusal that is a false statement.

**Withdrawing a rating appends `none` rather than deleting the row.** The table is append-only and a
reader takes the last row per message, so a changed mind stays legible as a sequence — which is the
point of keeping judgements rather than a current-state column.

**Every memory records where it came from, and `save()` will not write one without it.** The type
requires `source: { thread, turn?, at }`, so a caller cannot forget; it lands in the frontmatter as
flat `source_*` keys because the parser reads one `key: value` a line. Reading is tolerant — a
memory written before this existed simply has none, which means old rather than suspect. Archiving
files its grounds the same way (`archived_because_turn`), because a fact destroyed for a reason that
lived only in a log is indistinguishable from one destroyed on a whim, three days later.

What is *not* built: nothing resolves a memory's own pointer back to its turn, so the "source
deleted" case the design asks for cannot arise yet — `resolveTurn` serves the citation check only.

**Citations name a position, not a message id.** The nightly transcript labels turns `[1] User: …`
per thread and `citationLabels()` maps `thread#label` back to the id. Ids are 36-char UUIDs, and a
model copying one out of a long transcript slips a character — which arrives as a refusal
indistinguishable from a fabricated citation. Verified against deepseek-v4-flash on 2026-08-18: it
cited `"cited_turn": "[1]"`, brackets included, which is also why the tool strips them. The two
halves — how `transcript` numbers and how `citationLabels` maps — must agree, and a test says so.
