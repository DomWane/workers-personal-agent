import { Agent, callable, getAgentByName } from 'agents'
import type OpenAI from 'openai'
import { createLlmClient } from '@/connectors/llm.connector'
import { llmConfig } from '@/agent/llm-config'
import type { SqlTag } from '@/agent/memory/embedding-index'
import { threadOf } from '@/agent/agent-name'
import { INDEX_INSTANCE } from '@/agent/maintenance-agent'
import { createMemoryStore } from '@/agent/memory/vault-store'
import {
  appendArchive,
  dropArchive,
  readArchive,
  toolArchiveOver,
  type CompactionRecord,
  type FeedbackRecord,
} from '@/agent/archive'
import { historyForTurn, isContextOverflow, pairedOnly, spoken } from '@/agent/loop/context-window'
import * as compaction from '@/agent/loop/history-compaction'
import { mcpRegistry } from '@/agent/mcp/registry'
import type { McpClientRpc } from '@/agent/mcp/client'
import { buildMcpTools } from '@/agent/mcp/tools'
import { verdictFor, type CitationVerdict } from '@/agent/provenance'
import { buildSystemPrompt, renderSkillIndex } from '@/agent/system-prompt'
import { contentEnabled, createLog, errorFields, ORPHAN_LOG, type LogSource, type TurnLog } from '@/agent/log'
import { FREE_PLAN_SUBREQUESTS, SubrequestBudget } from '@/agent/subrequest-budget'
import { cachedSubrequestLimit } from '@/agent/workers-plan'
import * as research from '@/agent/research/commands'
import { runToolLoop, turnToolTraffic, type StopReason } from '@/agent/loop/tool-loop'
import { buildTools } from '@/agent/tools'
import type { ToolContext, ToolDef } from '@/agent/tools/registry'
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
} from '@/types'

interface TurnOutcome {
  reply: string
  stopReason: StopReason
  roundsUsed: number
  toolsUsed: string[]
  elapsedMs: number
  tokensSpent: number
  mcpTools: number
}

function turnFields(o: TurnOutcome) {
  return {
    outcome: 'ok',
    stopReason: o.stopReason,
    roundsUsed: o.roundsUsed,
    toolsUsed: o.toolsUsed,
    elapsedMs: o.elapsedMs,
    tokensSpent: o.tokensSpent,
    mcpTools: o.mcpTools,
  }
}

type ChainCallback = 'runResearchRound' | 'runCompactHistory'

function toChatMessages(history: HistoryMessage[], log?: TurnLog): ChatMessage[] {
  return pairedOnly(history, log).map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool' as const, tool_call_id: m.tool_call_id!, content: m.content }
    }
    if (m.role === 'assistant' && m.tool_calls) {
      return { role: 'assistant' as const, content: m.content || null, tool_calls: m.tool_calls }
    }
    return { role: m.role, content: m.content }
  })
}

const SKILL_COMMAND_RE = /^\/([a-z][\w-]{1,63})(?:@\w+)?(?:\s+([\s\S]+))?$/i

export class PersonalAgent extends Agent<Env, AgentState> {
  initialState: AgentState = { messages: [] }
  // `protected` on DurableObject; `declare` widens it without emitting a field over the base one.
  declare env: Env

  llm(budget: SubrequestBudget): OpenAI {
    const cfg = llmConfig(this.env)
    return createLlmClient(cfg.apiKey, cfg.baseUrl, budget.fetch)
  }

  private assertDevOnly(entrypoint: string): void {
    if (this.env.ENVIRONMENT !== 'localhost') {
      throw new Error(`${entrypoint} is localhost-only`)
    }
  }

  async seedState(state: AgentState): Promise<void> {
    this.assertDevOnly('seedState')
    this.setState(state)
  }

  async handleUserMessage(text: string, modelOverride?: string): Promise<string> {
    this.assertDevOnly('handleUserMessage')
    const budget = this.budget()
    const log = this.newLog('dev')
    const outcome = await this.generateReply(text, budget, log, { modelOverride })
    log.event({ at: 'turn', ...turnFields(outcome), subrequests: budget.spent })
    return outcome.reply
  }

  async registerThread(firstText: string, log: TurnLog): Promise<void> {
    const id = threadOf(this.name)
    if (!id) {
      return
    }
    try {
      const untitled = !this.state.messages.some((m) => m.role === 'user')
      const title = untitled ? firstText.replace(/\s+/g, ' ').slice(0, 60) : undefined
      await createMemoryStore(this.env).touchThread(id, title)
    } catch (err) {
      log.error({ at: 'thread', stage: 'register-failed', thread: id, error: errorFields(err) })
    }
  }

  @callable()
  async enqueueWebMessage(text: string): Promise<void> {
    const log = this.newLog('schedule')
    await this.registerThread(text, log)
    const entry: HistoryMessage = { role: 'user', content: text, id: crypto.randomUUID(), at: Date.now() }
    this.setState({ ...this.state, messages: [...this.state.messages, entry], status: 'thinking' })
    await this.schedule(0, 'processWebMessage', { text, id: entry.id } satisfies WebMessagePayload)
  }

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

  async processWebMessage(payload: WebMessagePayload): Promise<void> {
    const budget = this.budget()
    const log = this.newLog('web')
    try {
      const userMessageId = payload.id ?? this.state.messages.at(-1)?.id
      const outcome = await this.generateReply(payload.text, budget, log, { userMessageId })
      await this.clearStatusIfIdle(payload.id)
      log.event({ at: 'turn', ...turnFields(outcome), subrequests: budget.spent })
    } catch (err) {
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

  async clearStatusIfIdle(mine?: string): Promise<void> {
    const pending = (await this.listSchedules()) as { callback: string; payload?: WebMessagePayload }[]
    const queued = pending.some((s) => s.callback === 'processWebMessage' && s.payload?.id !== mine)
    if (!queued) {
      this.setState({ ...this.state, status: undefined })
    }
  }

  private planLimit = FREE_PLAN_SUBREQUESTS

  budget(): SubrequestBudget {
    return new SubrequestBudget(this.planLimit)
  }

  async onStart(): Promise<void> {
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

  @callable()
  async setModel(id: string | null): Promise<void> {
    const log = this.newLog('web')
    this.setState({ ...this.state, modelOverride: id ?? undefined })
    await this.emit(id ? `Model switched to ${id}` : `Back to the default model (${this.env.LLM_MODEL}).`)
    await compaction.resolveContextWindow(this, this.budget(), log)
    await compaction.maybeCompactHistory(this, log)
  }

  async emit(text: string): Promise<void> {
    const entry: HistoryMessage = { role: 'assistant', content: text, id: crypto.randomUUID(), at: Date.now() }
    this.setState({ ...this.state, messages: [...this.state.messages, entry] })
    await compaction.maybeCompactHistory(this, ORPHAN_LOG)
  }

  private sessionStarted(): boolean {
    return this.state.messages.some((m) => m.role === 'user')
  }

  private async loadUserProfile(log: TurnLog = ORPHAN_LOG): Promise<string> {
    if (this.sessionStarted() && this.state.userProfile !== undefined) {
      return this.state.userProfile
    }
    try {
      const profile = await createMemoryStore(this.env).getUserProfile()
      this.setState({ ...this.state, userProfile: profile })
      return profile
    } catch (err) {
      log.error({ at: 'profile-load', degraded: true, error: errorFields(err) })
      return this.state.userProfile ?? ''
    }
  }

  private async loadAgentNotes(log: TurnLog = ORPHAN_LOG): Promise<string> {
    if (this.sessionStarted() && this.state.agentNotes !== undefined) {
      return this.state.agentNotes
    }
    try {
      const notes = await createMemoryStore(this.env).getAgentNotes()
      this.setState({ ...this.state, agentNotes: notes })
      return notes
    } catch (err) {
      log.error({ at: 'agent-notes-load', degraded: true, error: errorFields(err) })
      return this.state.agentNotes ?? ''
    }
  }

  private async loadSkillIndex(log: TurnLog): Promise<string> {
    try {
      return renderSkillIndex(await createMemoryStore(this.env).listSkills())
    } catch (err) {
      log.error({ at: 'skill-index-load', degraded: true, error: errorFields(err) })
      return ''
    }
  }

  maintenance() {
    return this.env.MAINTENANCE.get(this.env.MAINTENANCE.idFromName(INDEX_INSTANCE))
  }

  private async turnTools(log: TurnLog): Promise<{ tools: ToolDef[]; mcpTools: number }> {
    const native = buildTools()
    try {
      const catalog = await mcpRegistry(this.env).listTools()
      const mcp = buildMcpTools(
        catalog,
        async (serverId, name, args) => {
          const client = (await getAgentByName(this.env.MCP_CLIENT, serverId)) as unknown as McpClientRpc
          return client.callTool(name, args)
        },
        native.map((t) => t.name),
        log,
      )
      return { tools: [...native, ...mcp], mcpTools: mcp.length }
    } catch (err) {
      log.error({ at: 'mcp', stage: 'catalog-failed', error: errorFields(err) })
      return { tools: native, mcpTools: 0 }
    }
  }

  toolContext(budget?: SubrequestBudget, log?: TurnLog, turn?: HistoryMessage): ToolContext {
    const thisThread = threadOf(this.name) ?? this.name
    return {
      env: this.env,
      pageCache: new Map(),
      agent: this as never,
      index: this.maintenance(),
      budget,
      log,
      source: { thread: thisThread, ...(turn ? { turn: turn.id } : {}), at: Date.now() },
      verifyCitation: async (thread, cited) => {
        if (thread !== thisThread) {
          return { ok: false, why: 'missing' }
        }
        if (turn && cited === turn.id) {
          return verdictFor(turn)
        }
        return this.verifyCitation(cited)
      },
      pendingReport: () => this.state.research?.report,
      toolArchive: toolArchiveOver(this.archiveSql),
      contextTokens: this.windowFor(this.model),
    }
  }

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
      log.error({ at: 'skill-lookup', degraded: true, error: errorFields(err) })
      return text
    }
  }

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
    const at = opts.userMessageId ? this.state.messages.findIndex((m) => m.id === opts.userMessageId) : -1
    const persistedUser = at >= 0 ? this.state.messages[at] : undefined
    const ownTurn: HistoryMessage = { role: 'user', content: text, id: crypto.randomUUID(), at: Date.now() }
    const withUser: HistoryMessage[] = persistedUser
      ? historyForTurn(this.state.messages, at, { ...persistedUser, content: resolved })
      : [...this.state.messages, { ...ownTurn, content: resolved }]

    const outgoing = toChatMessages(withUser, log)

    const startedAt = Date.now()
    const client = this.llm(budget)
    const { tools, mcpTools } = await this.turnTools(log)
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
        await this.loadSkillIndex(log),
        this.state.historySummary,
      ),
      history: outgoing,
      tools,
      ctx: this.toolContext(budget, log, opts.userMessageId ? persistedUser : ownTurn),
      subrequests: budget,
      log,
    })

    const combined: HistoryMessage[] = [
      ...this.state.messages,
      ...(opts.userMessageId ? [] : [ownTurn]),
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

    this.setState({
      ...this.state,
      messages: combined,
      promptTokens,
      ...(toolsUsed.includes('update_user_profile') ? { userProfile: undefined } : {}),
      ...(toolsUsed.includes('update_agent_notes') ? { agentNotes: undefined } : {}),
    })
    await compaction.maybeCompactHistory(this, log)
    return {
      reply,
      stopReason,
      roundsUsed,
      toolsUsed,
      tokensSpent,
      elapsedMs: Date.now() - startedAt,
      mcpTools,
    }
  }

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

  async verifyCitation(turn: string): Promise<CitationVerdict> {
    return verdictFor(await this.resolveTurn(turn))
  }

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

  async recentActivity(since: number): Promise<HistoryMessage[]> {
    const archived = readArchive<CompactionRecord>(this.archiveSql, since)
      .filter((r) => r.type === 'compaction')
      .flatMap((r) => r.data.evicted)
    const byId = new Map<string, HistoryMessage>()
    const messages = spoken([...archived, ...this.state.messages])
    for (const m of messages) {
      if ((m.at ?? 0) > since && !byId.has(m.id)) {
        byId.set(m.id, m)
      }
    }
    return [...byId.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  }

  async fireReminder(payload: ReminderPayload): Promise<void> {
    try {
      await this.emit(`⏰ ${payload.text}`)
    } catch (err) {
      this.newLog('schedule').error({ at: 'reminder', outcome: 'error', error: errorFields(err) })
    }
  }

  async runTask(payload: TaskPayload): Promise<void> {
    const budget = this.budget()
    const log = this.newLog('schedule')
    try {
      const client = this.llm(budget)
      const { tools, mcpTools } = await this.turnTools(log)
      const { text, stopReason, roundsUsed, toolsUsed } = await runToolLoop({
        log,
        client,
        model: this.model,
        systemPrompt: buildSystemPrompt(
          await this.loadUserProfile(log),
          await this.loadAgentNotes(log),
          await this.loadSkillIndex(log),
        ),
        history: [{ role: 'user', content: payload.prompt }],
        tools,
        ctx: this.toolContext(budget, log),
        subrequests: budget,
      })
      log.event({ at: 'task', outcome: 'ok', stopReason, roundsUsed, toolsUsed, mcpTools, subrequests: budget.spent })
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

  @callable()
  async compactNow(): Promise<void> {
    await compaction.compactHistory(this, this.newLog('web'), { force: true })
  }

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

  async scheduleChain(callback: ChainCallback, seconds: number): Promise<void> {
    await this.cancelChain(callback)
    await this.schedule(seconds, callback, undefined)
  }

  async cancelChain(callback: ChainCallback): Promise<void> {
    const pending = (await this.listSchedules()).filter((s) => s.callback === callback)
    await Promise.all(pending.map((s) => this.cancelSchedule(s.id)))
  }
}
