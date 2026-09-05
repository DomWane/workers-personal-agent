import { Agent, callable } from 'agents'
import type OpenAI from 'openai'
import { createLlmClient } from '../connectors/llm.connector'
import { llmConfig } from './llm-config'
import type { SqlTag } from './memory/embedding-index'
import { threadOf } from './agent-name'
import { INDEX_INSTANCE } from './maintenance-agent'
import { createMemoryStore } from './memory/vault-store'
import { retryOnce } from './retry'
import {
  appendArchive,
  dropArchive,
  readArchive,
  toolArchiveOver,
  type CompactionRecord,
  type FeedbackRecord,
} from './archive'
import {
  compactAt,
  compactKeep,
  DEFAULT_CONTEXT_TOKENS,
  fitHead,
  historyForTurn,
  historyTokens,
  isContextOverflow,
  pairedOnly,
  planCompaction,
  spoken,
} from './context-window'
import { contextWindowOf } from './model-catalogue'
import { verdictFor, type CitationVerdict } from './provenance'
import { summarizeHead } from './sessions'
import { buildSystemPrompt } from './system-prompt'
import { contentEnabled, createLog, errorFields, ORPHAN_LOG, type LogSource, type TurnLog } from './log'
import { FREE_PLAN_SUBREQUESTS, SubrequestBudget } from './subrequest-budget'
import { cachedSubrequestLimit } from './workers-plan'
import { concatFindings, formatResearchOffer, formatResearchProposal, ungroundedCitations } from './research-round'
import {
  planResearch,
  runResearchRound,
  runScoutWave,
  writeResearchReport,
  type PlanRevision,
  type ScoutOutcome,
} from './research-runner'
import {
  applyRound,
  applyWave,
  canPropose,
  chargeRound,
  finishRun,
  isCurrentRun,
  recordRoundDuration,
  waveAngles,
  RESEARCH_ROUND_GAP_SECONDS,
  // Aliased: the `@callable`s below carry the same names, and `proposeResearch(...)` inside
  // `proposeResearch()` reads as recursion to anyone who does not know it resolves to the import.
  proposeResearch as newProposal,
  replan,
  shouldContinue,
  startResearch as runFromProposal,
  RESEARCH_SCOUT_BUDGET,
  type ResearchState,
  type StopCause,
} from './research-state'
import { runToolLoop, turnToolTraffic, type StopReason } from './tool-loop'
import { buildTools } from './tools'
import type { ToolContext } from './tools/registry'
import type {
  AgentState,
  ChatMessage,
  Env,
  HistoryMessage,
  ReminderPayload,
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

/** One Durable Object instance per thread. Holds conversation history and runs the tool loop. */
export class PersonalAgent extends Agent<Env, AgentState> {
  initialState: AgentState = { messages: [] }

  private llm(budget: SubrequestBudget): OpenAI {
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
  private async registerThread(firstText: string, log: TurnLog): Promise<void> {
    const id = threadOf(this.name)
    if (!id) {
      return
    }
    try {
      const title = this.state.messages.length === 0 ? firstText.replace(/\s+/g, ' ').slice(0, 60) : undefined
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

  /**
   * Forgetting a thread in the browser leaves its Durable Object alive and, with no way to
   * enumerate the namespace, unreachable forever. The instance itself cannot be destroyed, but an
   * empty one costs nothing.
   */
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
  private async clearStatusIfIdle(mine?: string): Promise<void> {
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
  private budget(): SubrequestBudget {
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
    await this.resolveContextWindow(this.budget(), log)
    // Evaluated at the switch rather than at the next message: a switch *down* can put an
    // already-fine surface over the new window with no new turn to notice it.
    await this.maybeCompactHistory(log)
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
  private async emit(text: string): Promise<void> {
    const entry: HistoryMessage = { role: 'assistant', content: text, id: crypto.randomUUID(), at: Date.now() }
    this.setState({ ...this.state, messages: [...this.state.messages, entry] })
    await this.maybeCompactHistory(ORPHAN_LOG)
  }

  /** A round's whole result becomes durable in this one write, and a `SqlError: internal error`
   *  out of it discarded a four-scout wave on 2026-08-10. Hence the retry. */
  private async saveResearchState(next: ResearchState | undefined, log: TurnLog): Promise<void> {
    await retryOnce(
      () => this.setState({ ...this.state, research: next }),
      (err) => log.error({ at: 'research', stage: 'state-write-retry', error: errorFields(err) }),
    )
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
   * the point — they come out of the thousand rather than out of this turn's fifty.
   */
  /** The stub goes to tools unwrapped: it already carries the methods `ToolContext` asks for, and
   *  an adapter around it was only a second place to keep in step. */
  private maintenance() {
    return this.env.MAINTENANCE.get(this.env.MAINTENANCE.idFromName(INDEX_INSTANCE))
  }

  private toolContext(budget?: SubrequestBudget, log?: TurnLog, turn?: HistoryMessage): ToolContext {
    // `dev:*` instances have no thread segment, so the fallback is the instance's own name — still
    // stable, and a provenance pointer written from /dev/chat resolves against the right one.
    const thisThread = threadOf(this.name) ?? this.name
    // `as never` bridge: Agent's schedule() is typed with keyof this, SchedulerLike uses string
    return {
      env: this.env,
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
      await this.compactHistory(log, { force: true, budget })
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
      model: opts.modelOverride ?? this.state.modelOverride ?? this.env.LLM_MODEL,
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
    await this.maybeCompactHistory(log)
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
        model: this.state.modelOverride ?? this.env.LLM_MODEL,
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
  private windowFor(model: string): number | undefined {
    return model === this.state.contextModel ? this.state.contextTokens : undefined
  }

  private get archiveSql(): SqlTag {
    return this.sql.bind(this) as SqlTag
  }

  private get model(): string {
    return this.state.modelOverride ?? this.env.LLM_MODEL
  }

  /** Measured beats estimated: the provider's own count is what the request actually cost. */
  private promptSize(): number {
    return this.state.promptTokens ?? historyTokens(this.state.messages, this.state.historySummary)
  }

  /** Known only after the alarm has asked the catalogue, and invalidated by a model switch: one
   *  model's window says nothing about another's. */
  private get contextWindow(): number {
    return this.state.contextModel === this.model
      ? (this.state.contextTokens ?? DEFAULT_CONTEXT_TOKENS)
      : DEFAULT_CONTEXT_TOKENS
  }

  /** A turn only notices that compaction is due; losing the schedule is harmless, the next turn
   *  over the threshold makes another. A `/model` switch calls this too — switching *down* can put
   *  an already-fine surface over the new window with no new turn at all. */
  private async maybeCompactHistory(log: TurnLog): Promise<void> {
    // Against the default while this model's window is unknown; the alarm resolves the real one
    // and returns without a model call if there is room after all.
    if (this.promptSize() <= compactAt(this.contextWindow)) {
      return
    }
    try {
      await this.scheduleChain('runCompactHistory', 0)
    } catch (err) {
      log.error({ at: 'compact', stage: 'schedule-failed', error: errorFields(err) })
    }
  }

  /** One external subrequest, and only when the model has changed; the answer stays in state. */
  private async resolveContextWindow(budget: SubrequestBudget, log: TurnLog): Promise<number> {
    if (this.state.contextModel === this.model) {
      return this.contextWindow
    }
    try {
      const context = await contextWindowOf(this.env, this.model, budget.fetch)
      // A catalogue that answered but does not list this model is not an answer: pinning the
      // default against its name would leave the thread assuming 24k for good, silently. Left
      // unpinned it costs one lookup per compaction check and fixes itself if the model appears.
      if (context === undefined) {
        log.event({ at: 'compact', stage: 'context-unlisted', model: this.model, assumed: DEFAULT_CONTEXT_TOKENS })
        return DEFAULT_CONTEXT_TOKENS
      }
      this.setState({ ...this.state, contextModel: this.model, contextTokens: context })
      return context
    } catch (err) {
      // The default is the smallest window this deployment has seen, so an unanswered catalogue
      // compacts early rather than letting a thread grow past a window nobody knows.
      log.error({ at: 'compact', stage: 'context-unknown', model: this.model, error: errorFields(err) })
      return DEFAULT_CONTEXT_TOKENS
    }
  }

  async runCompactHistory(): Promise<void> {
    await this.compactHistory(this.newLog('schedule'))
  }

  /**
   * The deliberate version of what the threshold does on its own. Forced, because a user who asks
   * for it has decided the surface is too long whatever the threshold thinks — and because the
   * button is how a downward model switch gets compacted before it is made, rather than after the
   * next message overflows.
   */
  @callable()
  async compactNow(): Promise<void> {
    await this.compactHistory(this.newLog('web'), { force: true })
  }

  /**
   * `force` is the overflow path and the Compact button: someone has decided the surface is too
   * long — the provider by refusing it, or the user by asking — and neither is interested in what
   * the threshold thinks. It also empties the tail budget, keeping only the floor of one exchange:
   * against a million-token window a forced compaction otherwise found nothing to evict and
   * returned in silence, which reads as a broken button.
   */
  private async compactHistory(log: TurnLog, opts: { force?: boolean; budget?: SubrequestBudget } = {}): Promise<void> {
    // The overflow path runs inside a turn and hands its own budget in, or the summarizing call and
    // the catalogue lookup would spend against the fifty without the turn's counter seeing them.
    const budget = opts.budget ?? this.budget()
    const context = await this.resolveContextWindow(budget, log)
    if (!opts.force && this.promptSize() <= compactAt(context)) {
      return
    }
    const evicted = planCompaction(this.state.messages, opts.force ? 0 : compactKeep(context))
    if (evicted.length === 0) {
      // At the floor of one exchange, so what is over the threshold is not history: the running
      // summary, and on the measured path the system prompt. Neither is trimmable or bounded, and
      // the threshold re-schedules this every turn, so it says so rather than returning mute.
      log.event({
        at: 'compact',
        stage: 'nothing-to-evict',
        context,
        promptTokens: this.promptSize(),
        summaryChars: this.state.historySummary?.length ?? 0,
      })
      return
    }
    // A switch to a five-times-smaller window can evict more than the new model could ever fold,
    // so the summarizer reads what fits and the rest is archived raw. Chaining passes until it all
    // fit would summarize a summary repeatedly, and that degradation is invisible.
    // Filtered *before* `fitHead` chooses, not after. Sizing the slice over rows the summarizer
    // will never read picks a slice that can be entirely tool traffic — the call is then spent on
    // an empty transcript, and `shadows` records that the summary replaced ids it never saw.
    const { summarize } = fitHead(spoken(evicted), compactKeep(context))
    // Before the model call, and its record only after the state write: a pass that dies anywhere
    // in between leaves a start with nothing after it, which is a trace rather than a lie.
    const started = appendArchive(this.archiveSql, 'compaction-start', { evicted: evicted.length })
    // Restored rather than cleared: the overflow path compacts *inside* a turn, where clearing
    // would take the turn's own "thinking" with it and leave the client waiting in silence.
    const outerStatus = this.state.status
    this.setState({ ...this.state, status: 'compacting' })
    if (summarize.length === 0) {
      // A head that was all tool traffic. The rows still go to the archive and still leave the
      // surface; what is skipped is a model call over an empty transcript, whose answer would then
      // overwrite a summary it had nothing to add to.
      log.event({ at: 'compact', stage: 'nothing-to-summarize', evicted: evicted.length })
    }
    try {
      const written = summarize.length
        ? await summarizeHead(this.llm(budget), this.model, this.state.historySummary, summarize)
        : ''
      if (summarize.length && !written) {
        // Taking the answer as written replaced the running summary with the empty string, and the
        // head it described is archived by then. It still leaves the surface; nothing describes it.
        log.error({ at: 'compact', stage: 'empty-summary', evicted: evicted.length, folded: summarize.length })
      }
      const summary = written || (this.state.historySummary ?? '')
      // Counted against everything evicted rather than against the head the summarizer read: the
      // tool traffic `spoken` dropped also leaves with no summary describing it, and on the empty
      // answer above nothing was described at all.
      const unsummarized = evicted.length - (written ? summarize.length : 0)
      // The history can have been replaced while the model was answering — `deleteThread` is the
      // racer now — and dropping `evicted.length` messages off the front of a different history
      // would eat live turns and describe them with a summary of turns that are gone.
      if (this.state.messages[0]?.id !== evicted[0]?.id) {
        log.event({ at: 'compact', stage: 'abandoned', start: started, subrequests: budget.spent })
        return
      }
      // Before the trim, and do not swap the two: a failed INSERT loses nothing, while a record
      // over a failed `setState` is only a duplicate, which `recentActivity` dedupes by id. The
      // tidier order trades that duplicate for permanent loss.
      appendArchive(this.archiveSql, 'compaction', {
        evicted,
        summary,
        shadows: summarize.map((m) => m.id),
        unsummarized,
      } satisfies CompactionRecord)
      await retryOnce(() =>
        this.setState({
          ...this.state,
          messages: this.state.messages.slice(evicted.length),
          historySummary: summary,
          // The surface it described is gone, so the last measured size is no longer about it.
          promptTokens: undefined,
        }),
      )
      // Last, so the archive alone says the trim landed — the log line saying so expires in three
      // days.
      appendArchive(this.archiveSql, 'compaction-end', { start: started })
      log.event({
        at: 'compact',
        context,
        evicted: evicted.length,
        kept: this.state.messages.length,
        unsummarized,
        summaryChars: summary.length,
        subrequests: budget.spent,
      })
    } catch (err) {
      // The surface is untouched unless the failure was the trim itself, in which case the archive
      // holds a record of turns that are still on it — the duplicate above, not a loss. Either way
      // the next turn over the threshold schedules this again.
      log.error({ at: 'compact', outcome: 'error', subrequests: budget.spent, error: errorFields(err) })
    } finally {
      // Only if nobody moved it meanwhile: a message sent during a compaction sets `thinking`, and
      // restoring the captured value over it would drop the indicator of a turn still running.
      if (this.state.status === 'compacting') {
        this.setState({ ...this.state, status: outerStatus })
      }
    }
  }

  /** Every invocation logs under its own turn id; content stays out unless this deployment opts in. */
  private newLog(source: LogSource): TurnLog {
    return createLog(source, { content: contentEnabled(this.env) })
  }

  /**
   * Proposing and starting are deliberately separate: a run costs hundreds of requests and several
   * minutes, so it is not something one click should be able to launch. This only writes a plan.
   */
  @callable()
  async proposeResearch(topic: string): Promise<void> {
    const clean = topic.trim()
    if (!clean) {
      return this.emit('Give me a topic to research.')
    }
    if (!canPropose(this.state.research)) {
      return this.emit(
        this.state.research?.phase === 'done'
          ? `A finished report on "${this.state.research.topic}" is waiting. Save it or drop it first.`
          : `Already researching "${this.state.research?.topic}". Stop that run first.`,
      )
    }
    const log = this.newLog('web')
    const plan = await this.planWithModel(clean, log)
    if (!plan) {
      return
    }

    const proposal = newProposal(clean, plan)
    this.setState({ ...this.state, research: proposal })
    log.event({ at: 'research', stage: 'proposed', planLines: plan.length, fansOut: plan.length >= 2 })
    await this.announce(formatResearchProposal(proposal), log)
  }

  @callable()
  async revisePlan(note: string): Promise<void> {
    const clean = note.trim()
    if (!clean) {
      return this.emit('Say what to change about the plan.')
    }
    const current = this.state.research
    if (current?.phase !== 'proposed') {
      return this.emit(current ? 'The run is already going — stop it first.' : 'Nothing proposed yet.')
    }
    const log = this.newLog('web')
    const revised = await this.planWithModel(current.topic, log, { plan: current.plan, note: clean })
    if (!revised) {
      return
    }
    const next = replan(current, revised)
    if (!next) {
      return
    }
    this.setState({ ...this.state, research: next })
    log.event({ at: 'research', stage: 'replanned', planLines: next.plan.length, fansOut: next.plan.length >= 2 })
    await this.announce(formatResearchProposal(next), log)
  }

  /**
   * A proposal is written, then described. Losing the description is a nuisance; losing the
   * proposal with it is the bug this exists for — an escaping rejection rolls the Durable Object's
   * writes back, and Start twelve seconds later found nothing to run. Observed in
   * production against an invalid token, back when describing meant sending.
   */
  private async announce(text: string, log: TurnLog): Promise<void> {
    try {
      await this.emit(text)
    } catch (err) {
      log.error({ at: 'research', stage: 'announce-failed', error: errorFields(err) })
    }
  }

  @callable()
  async startResearch(): Promise<void> {
    const started = runFromProposal(this.state.research, crypto.randomUUID())
    if (!started) {
      return this.emit(this.state.research ? 'A run is already going.' : 'Nothing to start — propose a topic first.')
    }
    await this.scheduleChain('runResearchRound', 0)
    this.newLog('web').event({ at: 'research', stage: 'started', topic: started.topic })
    this.setState({ ...this.state, research: started })
  }

  @callable()
  async stopResearch(): Promise<void> {
    // Read before the clear: the reply is the only signal the user gets that the stop landed on
    // something, and after setState there is nothing left to read.
    const was = this.state.research
    await this.cancelChain('runResearchRound')
    // Clear the state too: a surviving run would be resumed by the next round as if nothing
    // had been cancelled.
    this.setState({ ...this.state, research: undefined })
    this.newLog('web').event({ at: 'research', stage: 'stopped', phase: was?.phase })
    await this.emit(was ? 'Research stopped.' : 'Research stopped (nothing was running).')
  }

  /** Files the report in the vault and ends the run. There is no "post it to the thread" twin: the
   *  report is in broadcast state from the moment it is written, so the client already has it. */
  @callable()
  async saveResearch(): Promise<void> {
    const log = this.newLog('web')
    const done = this.state.research
    if (done?.phase !== 'done' || !done.report) {
      return this.emit('Nothing to save — no finished research is waiting.')
    }
    const slug = await createMemoryStore(this.env).saveResearch(done.topic, done.report)
    this.setState({ ...this.state, research: undefined })
    log.event({ at: 'research', stage: 'delivered', slug, chars: done.report.length })
    // The file is new and the nightly sweep is hours away, so one reconcile runs now. It is an
    // RPC, so the embeddings are charged to the index instance's own invocation, not to this turn.
    await this.maintenance().reconcile()
    await this.emit(`In memory as research/${slug}.md — reindexing so search_memory can find it.`)
  }

  /**
   * Undefined means the user has already been told why there is no plan. This is the only outbound
   * call on the command path and a command is not a turn, so an unhandled rejection here would
   * reach ctx.waitUntil and the user would hear nothing at all.
   */
  private async planWithModel(topic: string, log: TurnLog, revision?: PlanRevision): Promise<string[] | undefined> {
    const budget = this.budget()
    // Proposing and revising are model calls of several seconds behind a button, and only messages
    // used to raise the indicator — so a click looked like nothing had happened.
    this.setState({ ...this.state, status: 'thinking' })
    try {
      const client = this.llm(budget)
      const plan = await planResearch(topic, { client, model: this.researchModel(), budget, log }, revision)
      log.event({ at: 'research', stage: 'planned', planLines: plan.length, subrequests: budget.spent })
      return plan
    } catch (err) {
      log.error({ at: 'research', stage: 'plan-failed', subrequests: budget.spent, error: errorFields(err) })
      await this.emit('⚠️ Could not plan that research. Try again.')
      return undefined
    } finally {
      // Not unconditionally: a message sent while this was working owns the indicator now.
      await this.clearStatusIfIdle()
    }
  }

  /** The main model, like a chat turn: research reads and reasons over pages, which is the work
   *  the configured model was chosen for. `/model` still overrides it. */
  private researchModel(): string {
    return this.state.modelOverride ?? this.env.LLM_MODEL
  }

  /**
   * `/model` wins here, unlike REFLECTION_MODEL above, which overrides it. The nightly reflection is
   * a background job that should stay cheap whatever the chat is doing; a scout is part of the work
   * `/model` is being used to try out, and a run whose scouts quietly kept the old model would make
   * that experiment half-invalid.
   */
  private scoutModel(): string {
    return this.state.modelOverride ?? this.env.SCOUT_MODEL ?? this.env.LLM_MODEL
  }

  /**
   * Named per run, round and angle, so two runs never share an instance and a retried wave
   * addresses the same one rather than accumulating instances.
   */
  private scoutCaller(state: ResearchState, log: TurnLog) {
    return (angle: string, index: number): Promise<ScoutOutcome> => {
      const id = this.env.RESEARCH_SCOUT.idFromName(`${state.runId}:${state.round}:${index}`)
      return this.env.RESEARCH_SCOUT.get(id).scout({
        topic: state.topic,
        angle,
        model: this.scoutModel(),
        turnId: log.turnId,
        alreadyTried: state.visited,
        contextTokens: this.windowFor(this.scoutModel()),
      })
    }
  }

  private logAbandoned(state: ResearchState, budget: SubrequestBudget, log: TurnLog): void {
    log.event({ at: 'research', stage: 'abandoned', round: state.round, subrequests: budget.spent })
  }

  /**
   * Alarm callback: one round of a research run. Each round is its own invocation with its own
   * fifty requests, which is the whole reason the run is a chain rather than a long turn.
   */
  async runResearchRound(): Promise<void> {
    const state = this.state.research
    if (!state || state.phase !== 'running') {
      return
    }

    const log = this.newLog('research')
    // Checked on the way in as well as on the way out: a round the platform killed is retried from
    // the state it left behind, and that retry has to meet a cap rather than the model.
    const gate = shouldContinue(state)
    if (!gate.go) {
      return this.finishResearch(state, gate.reason, log)
    }

    // Pessimistic, then corrected from the actuals below. See chargeRound.
    this.setState({ ...this.state, research: chargeRound(state) })

    const budget = this.budget()
    const roundStarted = Date.now()
    try {
      const angles = waveAngles(state)
      // Loud, because the run silently narrowing to sequential rounds looks the same from outside
      // as a plan that never had angles to split.
      if (!angles && (state.scoutSpent ?? 0) >= RESEARCH_SCOUT_BUDGET) {
        log.event({
          at: 'research',
          stage: 'scout-budget-spent',
          scoutSpent: state.scoutSpent,
          cap: RESEARCH_SCOUT_BUDGET,
        })
      }
      let seenUrls: string[]
      let next: ResearchState
      if (angles) {
        const outcomes = await runScoutWave(angles, this.scoutCaller(state, log), log)
        // The state may have moved on while the round was working — a stop, or a new proposal. The
        // write-back below would put the cancelled run back on its feet and reschedule it.
        if (!isCurrentRun(this.state.research, state)) {
          return this.logAbandoned(state, budget, log)
        }
        next = applyWave(state, outcomes, budget.spent)
        seenUrls = outcomes.flatMap((o) => o.seenUrls ?? [])
        log.event({
          at: 'research',
          stage: 'wave',
          angles: angles.length,
          failed: outcomes.filter((o) => o.error).length,
          // A scout that opened nothing and still wrote findings reported from the model's memory,
          // not from the web. Observed on two of four scouts the first time this ran.
          unread: outcomes.filter((o) => o.read === 0 && o.findings).length,
          reads: outcomes.reduce((n, o) => n + o.read, 0),
          // Pages paid for that produced nothing. `unread` misses this — it counts a scout that
          // opened *nothing*, so a wave losing 14 of 30 to a rate limit still read as healthy.
          lost: outcomes.reduce((n, o) => n + (o.urls.length - o.read), 0),
          scoutSpent: next.scoutSpent,
        })
      } else {
        const result = await runResearchRound(state, {
          client: this.llm(budget),
          model: this.researchModel(),
          ctx: this.toolContext(budget, log),
          budget,
          log,
        })
        if (!isCurrentRun(this.state.research, state)) {
          return this.logAbandoned(state, budget, log)
        }
        next = applyRound(state, result)
        seenUrls = result.seenUrls ?? []
      }
      next = recordRoundDuration(next, Date.now() - roundStarted)
      // Everything the round did becomes durable here and nowhere else, so this write is the one
      // that must not be lost to a transient failure.
      await this.saveResearchState(next, log)

      // A source the run never opened, cited as though it had been. Loud rather than removed: what
      // to do about one is a judgement, and a run that quietly dropped citations would read as
      // clean while losing real ones to a formatting slip.
      // Grounded by what the round saw, not only by what it opened: a claim cited from a search
      // snippet is honest sourcing, and counting it as invented cried wolf seventeen times in one
      // round the first time this ran.
      const ungrounded = ungroundedCitations(next.findings.slice(state.findings.length).join('\n'), [
        ...next.visited,
        ...seenUrls,
      ])
      if (ungrounded.length) {
        log.event(
          { at: 'research', stage: 'ungrounded-citations', round: next.round, count: ungrounded.length },
          { sample: ungrounded.slice(0, 5).join(' ') },
        )
      }

      const verdict = shouldContinue(next)
      log.event({
        at: 'research',
        round: next.round,
        spent: next.spent,
        subrequests: budget.spent,
        visited: next.visited.length,
        findingsChars: next.findings.join('').length,
        rounds: next.findings.length,
        openQuestions: next.openQuestions.length,
        stopCause: verdict.go ? undefined : verdict.reason,
      })

      if (verdict.go) {
        await this.scheduleChain('runResearchRound', RESEARCH_ROUND_GAP_SECONDS)
        return
      }
      await this.finishResearch(next, verdict.reason, log)
    } catch (err) {
      log.error({ at: 'research', outcome: 'error', subrequests: budget.spent, error: errorFields(err) })
      // The run is abandoned rather than retried: a round that threw has already spent, and a
      // chain that retries a failing round burns the budget without making progress. Clearing is
      // conditional for the same reason the success path's write-back is: whatever replaced this
      // run while it was failing is not ours to delete.
      //
      // Its own try/catch: when the round failed on a state write, this clear was the next write
      // and failed too, and the escaping rejection is what got the alarm retried.
      try {
        if (isCurrentRun(this.state.research, state)) {
          await this.saveResearchState(undefined, log)
        }
      } catch (clearErr) {
        log.error({ at: 'research', stage: 'clear-failed', error: errorFields(clearErr) })
      }
      await this.emit('⚠️ Research failed. Check logs.')
    }
  }

  /** The one place a run ends: write the report, clear the state, then post from a fresh invocation. */
  private async finishResearch(state: ResearchState, reason: StopCause, log: TurnLog): Promise<void> {
    const budget = this.budget()
    let report = concatFindings(state)
    if (state.findings.length) {
      try {
        const client = this.llm(budget)
        report = await writeResearchReport(state, { client, model: this.researchModel(), budget, log })
      } catch (err) {
        // Every finding still goes out, unwritten. A run that gathered material must not end with
        // nothing to show because the last call of twelve failed.
        log.error({ at: 'research', stage: 'report-failed', error: errorFields(err) })
      }
    }
    const done = finishRun(state, reason, report)
    this.setState({ ...this.state, research: done })
    log.event({
      at: 'research',
      stage: 'finished',
      round: done.round,
      spent: done.spent,
      stopCause: reason,
      reportChars: report.length,
    })
    // The offer only: the report itself is already in broadcast state.
    await this.emit(formatResearchOffer(done))
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

  private async cancelChain(callback: ChainCallback): Promise<void> {
    const pending = (await this.listSchedules()).filter((s) => s.callback === callback)
    await Promise.all(pending.map((s) => this.cancelSchedule(s.id)))
  }
}
