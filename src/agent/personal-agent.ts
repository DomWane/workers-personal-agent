import { Agent, callable } from 'agents'
import type OpenAI from 'openai'
import { createLlmClient } from '../connectors/llm.connector'
import { llmConfig } from './llm-config'
import type { SqlTag } from './memory/embedding-index'
import { threadOf } from './agent-name'
import { INDEX_INSTANCE } from './maintenance-agent'
import { createMemoryStore } from './memory/vault-store'
import {
  appendArchive,
  dropArchive,
  readArchive,
  toolArchiveOver,
  type CompactionRecord,
  type FeedbackRecord,
} from './archive'
import { historyForTurn, isContextOverflow, pairedOnly, spoken } from './context-window'
import * as compaction from './history-compaction'
import { verdictFor, type CitationVerdict } from './provenance'
import { buildSystemPrompt } from './system-prompt'
import { contentEnabled, createLog, errorFields, ORPHAN_LOG, type LogSource, type TurnLog } from './log'
import { FREE_PLAN_SUBREQUESTS, SubrequestBudget } from './subrequest-budget'
import { cachedSubrequestLimit } from './workers-plan'
import * as research from './research-commands'
import { runToolLoop, turnToolTraffic, type StopReason } from './tool-loop'
import { buildTools } from './tools'
import type { ToolContext } from './tools/registry'
import type {
  AgentState,
  ChatMessage,
  Env,
  HistoryMessage,
  ReminderPayload,
  ResearchPreset,
  ScoutCounts,
  TaskPayload,
  WebMessagePayload,
} from '../types'

/** What a completed turn is worth recording, so the turn record answers without a join. */
interface TurnOutcome {
  reply: string
  stopReason: StopReason
  roundsUsed: number
  toolsUsed: string[]
  elapsedMs: number
  tokensSpent: number
}

function turnFields(o: TurnOutcome) {
  return {
    outcome: 'ok',
    stopReason: o.stopReason,
    roundsUsed: o.roundsUsed,
    toolsUsed: o.toolsUsed,
    elapsedMs: o.elapsedMs,
    // The one number that scales with what a turn actually costs; rounds and seconds do not.
    tokensSpent: o.tokensSpent,
  }
}

/** Callbacks that reschedule themselves. The Agents SDK rejects a name with no method behind
 *  it at schedule time, so this widens only when the callback actually exists. */
type ChainCallback = 'runResearchRound' | 'runCompactHistory'

/**
 * Persisted history carries UI fields (id, at, tools, tokens) the OpenAI-compatible API must not
 * see, and tool traffic it must see in a shape we do not store: an assistant that only called tools
 * holds `''` here and needs `null` on the wire.
 */
function toChatMessages(history: HistoryMessage[], log?: TurnLog): ChatMessage[] {
  return pairedOnly(history, log).map((m) => {
    if (m.role === 'tool') {
      // Non-null by `pairedOnly`, which drops a `tool` row with no id along with its partner.
      return { role: 'tool' as const, tool_call_id: m.tool_call_id!, content: m.content }
    }
    if (m.role === 'assistant' && m.tool_calls) {
      return { role: 'assistant' as const, content: m.content || null, tool_calls: m.tool_calls }
    }
    return { role: m.role, content: m.content }
  })
}

/** The one slash form left, because it is the one action with no button: everything else the user
 *  can ask for is a `@callable` the UI names. */
const SKILL_COMMAND_RE = /^\/([a-z][\w-]{1,63})(?:@\w+)?(?:\s+([\s\S]+))?$/i

/**
 * One Durable Object instance per thread. Holds conversation history and runs the tool loop.
 *
 * Research and compaction live in `research-commands.ts` and `history-compaction.ts` as functions
 * over the instance; the `@callable`s and alarm callbacks here stay one-line wrappers because the
 * Agents SDK resolves both by method name. Rejected: a helper class behind a host interface — one
 * implementation, and every call still lands here. The members those files use are not `private`;
 * the client's surface is the `@callable`s, not visibility.
 */
export class PersonalAgent extends Agent<Env, AgentState> {
  initialState: AgentState = { messages: [] }
  // `protected` on DurableObject. `declare` widens it without emitting a field over the base one.
  declare env: Env

  llm(budget: SubrequestBudget): OpenAI {
    const cfg = llmConfig(this.env)
    return createLlmClient(cfg.apiKey, cfg.baseUrl, budget.fetch)
  }

  /** Guarded here as well as at the route: one entrypoint overwrites a conversation and the other
   *  spends tokens on any model handed to it, and a second caller would reach past the route. */
  private assertDevOnly(entrypoint: string): void {
    if (this.env.ENVIRONMENT !== 'localhost') {
      throw new Error(`${entrypoint} is localhost-only`)
    }
  }

  /** Dev entrypoint: overwrite state wholesale so the web UI can be exercised without model calls. */
  async seedState(state: AgentState): Promise<void> {
    this.assertDevOnly('seedState')
    this.setState(state)
  }

  /** Dev entrypoint: returns the reply synchronously (used by POST /dev/chat). */
  async handleUserMessage(text: string, modelOverride?: string): Promise<string> {
    this.assertDevOnly('handleUserMessage')
    // `dev` traffic is hand-made and must never be pooled with organic turns in a measurement,
    // which needs a turn record of its own — not just a source on the loop records.
    const budget = this.budget()
    const log = this.newLog('dev')
    const outcome = await this.generateReply(text, budget, log, { modelOverride })
    log.event({ at: 'turn', ...turnFields(outcome), subrequests: budget.spent })
    return outcome.reply
  }

  /**
   * On the first message rather than on connect: a client that opens a tab and types nothing has
   * produced no conversation to list, and connecting is far more frequent than starting.
   */
  async registerThread(firstText: string, log: TurnLog): Promise<void> {
    const id = threadOf(this.name)
    if (!id) {
      return
    }
    try {
      // "No user turn yet" rather than "no messages": a model picked on the landing lands in the
      // new thread as a "Model switched" message before the first turn, and titled it nothing.
      const untitled = !this.state.messages.some((m) => m.role === 'user')
      const title = untitled ? firstText.replace(/\s+/g, ' ').slice(0, 60) : undefined
      await createMemoryStore(this.env).touchThread(id, title)
    } catch (err) {
      // The thread still works; it is only harder to find again. Losing the turn over that
      // would be the worse trade.
      log.error({ at: 'thread', stage: 'register-failed', thread: id, error: errorFields(err) })
    }
  }

  /**
   * The user turn is written here rather than by the alarm: `setState` is what the web client
   * renders from, so a message that waited for the model would not appear until the answer did.
   */
  @callable()
  async enqueueWebMessage(text: string): Promise<void> {
    const log = this.newLog('schedule')
    await this.registerThread(text, log)
    const entry: HistoryMessage = { role: 'user', content: text, id: crypto.randomUUID(), at: Date.now() }
    this.setState({ ...this.state, messages: [...this.state.messages, entry], status: 'thinking' })
    await this.schedule(0, 'processWebMessage', { text, id: entry.id } satisfies WebMessagePayload)
  }

  /** An instance can only rename itself — the thread id comes from its own name, never from the
   *  caller, so a client cannot retitle someone else's conversation. */
  @callable()
  async renameThread(title: string): Promise<void> {
    const id = threadOf(this.name)
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, 60)
    if (!id || !clean) {
      return
    }
    await createMemoryStore(this.env).renameThread(id, clean)
  }

  /**
   * Forgetting a thread in the browser leaves its Durable Object alive and, with no way to
   * enumerate the namespace, unreachable forever. The instance itself cannot be destroyed, but an
   * empty one costs nothing.
   */
  @callable()
  async deleteThread(): Promise<void> {
    const id = threadOf(this.name)
    const log = this.newLog('schedule')
    for (const s of await this.listSchedules()) {
      await this.cancelSchedule(s.id)
    }
    // The one place raw history is genuinely destroyed rather than shadowed, which is the entire
    // point of the gesture. Any memory whose provenance points in here now dangles.
    dropArchive(this.archiveSql)
    this.setState({ ...this.initialState })
    if (!id) {
      return
    }
    try {
      await createMemoryStore(this.env).removeThread(id)
    } catch (err) {
      log.error({ at: 'thread', stage: 'delete-failed', thread: id, error: errorFields(err) })
    }
  }

  /** Alarm callback: answer a web message. No typing indicator — `status` carries that on this
   *  channel, and it is broadcast rather than sent. */
  async processWebMessage(payload: WebMessagePayload): Promise<void> {
    const budget = this.budget()
    const log = this.newLog('web')
    try {
      // The last message rather than nothing: an id is how the reply finds the turn it answers, and
      // without one `generateReply` appends the user's message a second time.
      const userMessageId = payload.id ?? this.state.messages.at(-1)?.id
      // `generateReply` persists the reply itself, so there is nothing left to do with it here.
      const outcome = await this.generateReply(payload.text, budget, log, { userMessageId })
      await this.clearStatusIfIdle(payload.id)
      log.event({ at: 'turn', ...turnFields(outcome), subrequests: budget.spent })
    } catch (err) {
      // Cleared before the notice: a client left on "thinking" would wait for an answer that the
      // notice has already said is not coming.
      await this.clearStatusIfIdle(payload.id)
      log.error({
        at: 'turn',
        outcome: 'error',
        stopReason: 'error',
        subrequests: budget.spent,
        error: errorFields(err),
      })
      await this.emit('Sorry — I hit a problem answering that. Please try again.')
    }
  }

  /**
   * A message sent while this one was answering has an alarm of its own still waiting, and the
   * indicator belongs to it now: clearing on the first turn's way out would say "done" with a
   * question still unanswered.
   *
   * The turn excludes itself by id, because **its own row is still in the table while it runs** —
   * the SDK deletes a one-shot schedule only after the callback returns, so asking whether any
   * `processWebMessage` is pending always answered yes and the indicator never cleared at all.
   */
  async clearStatusIfIdle(mine?: string): Promise<void> {
    // `listSchedules()` types the payload as `{}`; these rows are ours.
    const pending = (await this.listSchedules()) as { callback: string; payload?: WebMessagePayload }[]
    const queued = pending.some((s) => s.callback === 'processWebMessage' && s.payload?.id !== mine)
    if (!queued) {
      this.setState({ ...this.state, status: undefined })
    }
  }

  /**
   * Resolved in `onStart` rather than on a turn, because a turn needs the budget on its first line
   * and synchronously. Free until the first answer arrives — the direction that fails loudly.
   */
  private planLimit = FREE_PLAN_SUBREQUESTS

  /** So no call site has to know the cap. */
  budget(): SubrequestBudget {
    return new SubrequestBudget(this.planLimit)
  }

  /**
   * A turn that died with its instance — a deploy, an eviction, a throw the catch never saw —
   * leaves `status` set with no alarm behind it, and nothing else would ever clear it. Waking is
   * the first moment the difference is visible, and the schedule table is the evidence.
   */
  async onStart(): Promise<void> {
    // Before the status check below, which returns early: the cap is needed whether or not this
    // instance woke holding a stale indicator.
    this.planLimit = await cachedSubrequestLimit(this.ctx.storage, this.env, this.newLog('schedule'))
    if (!this.state.status) {
      return
    }
    const pending = await this.listSchedules()
    const working = pending.some((s) => s.callback === 'processWebMessage' || s.callback === 'runCompactHistory')
    if (working) {
      return
    }
    this.newLog('schedule').event({ at: 'turn', stage: 'status-orphaned', status: this.state.status })
    this.setState({ ...this.state, status: undefined })
  }

  /**
   * Switching is what makes the window known, so it is resolved here rather than left to the next
   * turn: on the one external subrequest a deliberate switch is worth. Left to the threshold it
   * would be measured against the conservative default, and a model *smaller* than that default
   * would then never trigger a compaction on its own — only overflow.
   *
   * `null` is back to the deployment's own model, which the picker must always be able to offer.
   */
  @callable()
  async setModel(id: string | null): Promise<void> {
    const log = this.newLog('web')
    this.setState({ ...this.state, modelOverride: id ?? undefined })
    await this.emit(id ? `Model switched to ${id}` : `Back to the default model (${this.env.LLM_MODEL}).`)
    await compaction.resolveContextWindow(this, this.budget(), log)
    // Evaluated at the switch rather than at the next message: a switch *down* can put an
    // already-fine surface over the new window with no new turn to notice it.
    await compaction.maybeCompactHistory(this, log)
  }

  /**
   * Assistant-authored text lands in `state.messages`, and `setState` both persists it and
   * broadcasts it to every connected client — which is the whole of delivery. There is no send.
   *
   * Failure notices go through here too, inline. They used to be scheduled onto a fresh alarm
   * because the failure being reported was usually the subrequest cap, which left the invocation
   * unable to send anything at all; with nothing outbound left, that hop reported from one state
   * write instead of another and bought nothing.
   */
  async emit(text: string): Promise<void> {
    const entry: HistoryMessage = { role: 'assistant', content: text, id: crypto.randomUUID(), at: Date.now() }
    this.setState({ ...this.state, messages: [...this.state.messages, entry] })
    await compaction.maybeCompactHistory(this, ORPHAN_LOG)
  }

  /** Session start = no user turn yet. Command replies land in history too, so a bare length
   *  check would see a command's own confirmation as a running session and keep a stale profile. */
  private sessionStarted(): boolean {
    return this.state.messages.some((m) => m.role === 'user')
  }

  private async loadUserProfile(log: TurnLog = ORPHAN_LOG): Promise<string> {
    // Frozen per session: refetch at session start, or once a write has invalidated the copy.
    if (this.sessionStarted() && this.state.userProfile !== undefined) {
      return this.state.userProfile
    }
    try {
      const profile = await createMemoryStore(this.env).getUserProfile()
      this.setState({ ...this.state, userProfile: profile })
      return profile
    } catch (err) {
      // Vault outage must not block chat; stale beats broken.
      log.error({ at: 'profile-load', degraded: true, error: errorFields(err) })
      return this.state.userProfile ?? ''
    }
  }

  private async loadAgentNotes(log: TurnLog = ORPHAN_LOG): Promise<string> {
    // Frozen per session: refetch at session start, or once a write has invalidated the copy.
    if (this.sessionStarted() && this.state.agentNotes !== undefined) {
      return this.state.agentNotes
    }
    try {
      const notes = await createMemoryStore(this.env).getAgentNotes()
      this.setState({ ...this.state, agentNotes: notes })
      return notes
    } catch (err) {
      // Vault outage must not block chat; stale beats broken.
      log.error({ at: 'agent-notes-load', degraded: true, error: errorFields(err) })
      return this.state.agentNotes ?? ''
    }
  }

  /**
   * The index lives in one `MaintenanceAgent`, not here: held per conversation it was rebuilt
   * from scratch by every new instance over the same vault. These calls are internal, which is
   * the point — they come out of the thousand rather than out of this turn's fifty. The stub goes
   * to tools unwrapped: it already carries the methods `ToolContext` asks for, and an adapter
   * around it was only a second place to keep in step.
   */
  maintenance() {
    return this.env.MAINTENANCE.get(this.env.MAINTENANCE.idFromName(INDEX_INSTANCE))
  }

  toolContext(budget?: SubrequestBudget, log?: TurnLog, turn?: HistoryMessage): ToolContext {
    // `dev:*` instances have no thread segment, so the fallback is the instance's own name — still
    // stable, and a provenance pointer written from /dev/chat resolves against the right one.
    const thisThread = threadOf(this.name) ?? this.name
    // `as never` bridge: Agent's schedule() is typed with keyof this, SchedulerLike uses string
    return {
      env: this.env,
      // One turn's worth: the pages a search carries are read in the same turn or not at all.
      pageCache: new Map(),
      agent: this as never,
      index: this.maintenance(),
      budget,
      log,
      // The thread, so a pointer survives being read from another one; the turn, so it points at
      // the exchange rather than at the day.
      source: { thread: thisThread, ...(turn ? { turn: turn.id } : {}), at: Date.now() },
      // Only about itself, and `missing` for anything else: from here another thread's fate is
      // unknown, and claiming it was deleted is the false statement `provenance.ts` prevents.
      // The turn being answered is answered without a lookup — on /dev/chat it is not in
      // `state.messages` until the turn ends, so the gate would otherwise differ by entrypoint.
      verifyCitation: async (thread, cited) => {
        if (thread !== thisThread) {
          return { ok: false, why: 'missing' }
        }
        if (turn && cited === turn.id) {
          return verdictFor(turn)
        }
        return this.verifyCitation(cited)
      },
      // Only a finished run has one — `finishRun` is what writes it — so a run still gathering
      // cannot be answered from as though it had concluded.
      pendingReport: () => this.state.research?.report,
      toolArchive: toolArchiveOver(this.archiveSql),
      contextTokens: this.windowFor(this.model),
    }
  }

  /** Explicit `/<skill-slug> <text>` beats hoping the model picks the right skill on its own. */
  private async resolveSkillInvocation(text: string, log: TurnLog = ORPHAN_LOG): Promise<string> {
    const m = text.trim().match(SKILL_COMMAND_RE)
    if (!m) {
      return text
    }
    const slug = m[1].toLowerCase().replaceAll('_', '-')
    try {
      const skill = await createMemoryStore(this.env).readSkill(slug)
      if (!skill) {
        return text
      }
      return [
        'Apply this saved skill to handle my request.',
        `<skill name="${skill.name.replaceAll('"', "'")}">`,
        skill.content,
        '</skill>',
        '',
        `Request: ${m[2]?.trim() || '(no extra instruction — follow the skill as written)'}`,
      ].join('\n')
    } catch (err) {
      // Vault hiccup: treat as a plain message rather than failing the turn.
      log.error({ at: 'skill-lookup', degraded: true, error: errorFields(err) })
      return text
    }
  }

  /**
   * `userMessageId` is the web path: its enqueue writes the user turn immediately so the broadcast
   * state shows the message before the model answers, and hands the id here. Persisting it a second
   * time would double it, and appending it to the outgoing history would send it twice.
   */
  private async generateReply(
    text: string,
    budget: SubrequestBudget,
    log: TurnLog,
    opts: { modelOverride?: string; userMessageId?: string } = {},
  ): Promise<TurnOutcome> {
    try {
      return await this.runTurn(text, budget, log, opts)
    } catch (err) {
      if (!isContextOverflow(err)) {
        throw err
      }
      // Maintenance inside a turn, deliberately: the turn is already lost, and an alarm would
      // answer the question with an apology. The retry re-enters the whole loop, so tools that ran
      // before the refusal run twice — accepted, an overflow is nearly always the first call.
      log.event({ at: 'compact', stage: 'overflow-retry', model: this.model })
      await compaction.compactHistory(this, log, { force: true, budget })
      return this.runTurn(text, budget, log, opts)
    }
  }

  private async runTurn(
    text: string,
    budget: SubrequestBudget,
    log: TurnLog,
    opts: { modelOverride?: string; userMessageId?: string } = {},
  ): Promise<TurnOutcome> {
    const resolved = await this.resolveSkillInvocation(text, log)
    // Found by id, not by position. `at(-1)` looked right until a second message was sent while
    // the first was still answering: the queued turn is the last one then, so turn 1 rewrote turn
    // 2's text with its own and turn 2 read turn 1's question as an *assistant* line.
    const at = opts.userMessageId ? this.state.messages.findIndex((m) => m.id === opts.userMessageId) : -1
    const persistedUser = at >= 0 ? this.state.messages[at] : undefined
    // Created once and used twice: the model sees it at the end of the outgoing history, and the
    // same id is what gets persisted below, so a turn can be pointed at from the moment it exists.
    const ownTurn: HistoryMessage = { role: 'user', content: text, id: crypto.randomUUID(), at: Date.now() }
    // The persisted turn holds the raw text; the model gets the skill-expanded form, so an
    // already-persisted user turn is swapped rather than appended.
    const withUser: HistoryMessage[] = persistedUser
      ? historyForTurn(this.state.messages, at, { ...persistedUser, content: resolved })
      : [...this.state.messages, { ...ownTurn, content: resolved }]

    // Held rather than inlined: `turnToolTraffic` below slices the loop's array past the history it
    // was given, and `toChatMessages` can hand over fewer messages than `withUser` holds — one
    // dropped pair there would make that slice start late and persist an orphan of this turn's own.
    const outgoing = toChatMessages(withUser, log)

    const startedAt = Date.now()
    const client = this.llm(budget)
    const {
      text: reply,
      toolsUsed,
      stopReason,
      roundsUsed,
      promptTokens,
      tokensSpent,
      messages: loopMessages,
    } = await runToolLoop({
      client,
      model: opts.modelOverride ?? this.model,
      systemPrompt: buildSystemPrompt(
        await this.loadUserProfile(log),
        await this.loadAgentNotes(log),
        this.state.historySummary,
      ),
      history: outgoing,
      tools: buildTools(),
      // `ownTurn` only on the path that persists it — /dev/chat — never as a fallback
      // for an id that was named and not found: that turn is not written anywhere, so the memory
      // would point at something that never existed. No turn at all is the honest record there.
      ctx: this.toolContext(budget, log, opts.userMessageId ? persistedUser : ownTurn),
      subrequests: budget,
      log,
    })

    // Persist the raw command, not the expanded skill: keeps history small and re-triggerable.
    // Persisted already if the caller named a message, *even when that message is no longer on the
    // surface*: a forced compaction can evict it between the failed attempt and the retry, and
    // deciding by whether it was found would then write the user's turn a second time.
    const combined: HistoryMessage[] = [
      ...this.state.messages,
      ...(opts.userMessageId ? [] : [ownTurn]),
      // Between the question and the answer, so the order reads as it happened and a later turn can
      // quote a ref. Stubbed on the way in — see `turnToolTraffic`.
      ...turnToolTraffic(loopMessages, outgoing.length, Date.now(), log),
      {
        role: 'assistant',
        content: reply,
        id: crypto.randomUUID(),
        at: Date.now(),
        ...(toolsUsed.length ? { tools: toolsUsed } : {}),
        ...(tokensSpent ? { tokens: tokensSpent } : {}),
      },
    ]

    // Drop the frozen copy the turn just rewrote, so the next turn sees what is actually in the vault.
    this.setState({
      ...this.state,
      messages: combined,
      // Assigned even when the provider omitted `usage`: keeping the last turn's count would
      // measure a surface that has grown since with a number that has not.
      promptTokens,
      ...(toolsUsed.includes('update_user_profile') ? { userProfile: undefined } : {}),
      ...(toolsUsed.includes('update_agent_notes') ? { agentNotes: undefined } : {}),
    })
    await compaction.maybeCompactHistory(this, log)
    return { reply, stopReason, roundsUsed, toolsUsed, tokensSpent, elapsedMs: Date.now() - startedAt }
  }

  /** Throws rather than refusing quietly: the client draws the thumb on click, so a silent refusal
   *  leaves the UI claiming a judgement the archive never took. */
  @callable()
  async rateMessage(messageId: string, rating: 'up' | 'down' | 'none', note?: string): Promise<void> {
    const message = await this.resolveTurn(messageId)
    if (!message || message.role !== 'assistant') {
      this.newLog('web').error({ at: 'feedback', stage: 'unratable', message: messageId })
      throw new Error(`cannot rate ${messageId}: not an assistant turn in this thread`)
    }
    appendArchive(this.archiveSql, 'feedback', {
      message: messageId,
      rating,
      ...(note?.trim() ? { note: note.trim() } : {}),
    } satisfies FeedbackRecord)
    this.newLog('web').event({ at: 'feedback', rating, message: messageId, noted: !!note?.trim() })
  }

  /** The thread answering about itself. A thread that has been deleted answers nothing at all — the
   *  caller reaches it through the registry, which is where "gone" is known. */
  async verifyCitation(turn: string): Promise<CitationVerdict> {
    return verdictFor(await this.resolveTurn(turn))
  }

  /** Live surface first, archive second: compaction shadows rather than deletes, so a pointer
   *  stays good for the life of the thread. */
  async resolveTurn(id: string): Promise<HistoryMessage | null> {
    const live = this.state.messages.find((m) => m.id === id)
    if (live) {
      return live
    }
    for (const row of readArchive<CompactionRecord>(this.archiveSql)) {
      if (row.type !== 'compaction') {
        continue
      }
      const found = row.data.evicted.find((m) => m.id === id)
      if (found) {
        return found
      }
    }
    return null
  }

  /**
   * For the nightly reflection: archive and live surface unioned, since compaction moves a message
   * from one to the other. Filtered by the message's own timestamp, not the archive row's — a row
   * written last night carries turns from days ago, already reported when they were live.
   */
  async recentActivity(since: number): Promise<HistoryMessage[]> {
    const archived = readArchive<CompactionRecord>(this.archiveSql, since)
      .filter((r) => r.type === 'compaction')
      .flatMap((r) => r.data.evicted)
    // Deduped by id because a `setState` that failed after the archive row was appended leaves one
    // message in both halves.
    const byId = new Map<string, HistoryMessage>()
    const messages = spoken([...archived, ...this.state.messages])
    for (const m of messages) {
      if ((m.at ?? 0) > since && !byId.has(m.id)) {
        byId.set(m.id, m)
      }
    }
    return [...byId.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  }

  /** Alarm callback: post a scheduled reminder. */
  async fireReminder(payload: ReminderPayload): Promise<void> {
    try {
      await this.emit(`⏰ ${payload.text}`)
    } catch (err) {
      this.newLog('schedule').error({ at: 'reminder', outcome: 'error', error: errorFields(err) })
    }
  }

  /** Alarm callback: run a scheduled agentic task through the tool loop and post the result. */
  async runTask(payload: TaskPayload): Promise<void> {
    const budget = this.budget()
    const log = this.newLog('schedule')
    try {
      const client = this.llm(budget)
      // Fresh context on purpose: scheduled tasks must not depend on (or pollute) chat history.
      const { text } = await runToolLoop({
        log,
        client,
        model: this.model,
        systemPrompt: buildSystemPrompt(this.state.userProfile ?? '', this.state.agentNotes ?? ''),
        history: [{ role: 'user', content: payload.prompt }],
        tools: buildTools(),
        ctx: this.toolContext(budget, log),
        subrequests: budget,
      })
      await this.emit(text)
    } catch (err) {
      log.error({
        at: 'task',
        outcome: 'error',
        stopReason: 'error',
        subrequests: budget.spent,
        error: errorFields(err),
      })
      await this.emit('⚠️ Scheduled task failed. Check logs.')
    }
  }

  /**
   * The resolved window, but only when it belongs to the model being asked about — the scout may run
   * `SCOUT_MODEL` while the thread's window was measured for another. Undefined means *unknown*, not
   * small: `contextWindow` substitutes the 24k default, which is right for scheduling a compaction
   * and wrong for deciding how much of a page to show.
   */
  windowFor(model: string): number | undefined {
    return model === this.state.contextModel ? this.state.contextTokens : undefined
  }

  get archiveSql(): SqlTag {
    return this.sql.bind(this) as SqlTag
  }

  get model(): string {
    return this.state.modelOverride ?? this.env.LLM_MODEL
  }

  async runCompactHistory(): Promise<void> {
    await compaction.compactHistory(this, this.newLog('schedule'))
  }

  /**
   * The deliberate version of what the threshold does on its own. Forced, because a user who asks
   * for it has decided the surface is too long whatever the threshold thinks — and because the
   * button is how a downward model switch gets compacted before it is made, rather than after the
   * next message overflows.
   */
  @callable()
  async compactNow(): Promise<void> {
    await compaction.compactHistory(this, this.newLog('web'), { force: true })
  }

  /** Every invocation logs under its own turn id; content stays out unless this deployment opts in. */
  newLog(source: LogSource): TurnLog {
    return createLog(source, { content: contentEnabled(this.env) })
  }

  @callable()
  async proposeResearch(topic: string): Promise<void> {
    await research.proposeResearch(this, topic)
  }

  @callable()
  async revisePlan(note: string): Promise<void> {
    await research.revisePlan(this, note)
  }

  @callable()
  async startResearch(preset: ResearchPreset = 'normal'): Promise<void> {
    await research.startResearch(this, preset)
  }

  @callable()
  async stopResearch(): Promise<void> {
    await research.stopResearch(this)
  }

  @callable()
  async saveResearch(): Promise<void> {
    await research.saveResearch(this)
  }

  async scoutProgress(runId: string, angle: string, counts: ScoutCounts): Promise<void> {
    research.scoutProgress(this, runId, angle, counts)
  }

  async runResearchRound(): Promise<void> {
    await research.runResearchRound(this)
  }

  /**
   * Schedules the next link of a self-rescheduling chain. Cancel-then-schedule rather than
   * schedule-if-absent: the alarm that is currently running cannot tell whether it still counts
   * as pending, and guessing wrong ends the chain silently with the work half done.
   */
  async scheduleChain(callback: ChainCallback, seconds: number): Promise<void> {
    await this.cancelChain(callback)
    // The link carries nothing: both callbacks read the run from state, which is where it has to
    // live anyway for a retry after a killed round to resume from it.
    await this.schedule(seconds, callback, undefined)
  }

  async cancelChain(callback: ChainCallback): Promise<void> {
    const pending = (await this.listSchedules()).filter((s) => s.callback === callback)
    await Promise.all(pending.map((s) => this.cancelSchedule(s.id)))
  }
}
