/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, key, type EngineForSettings, type Executor, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { sourceTrigger } from './ticket-context.ts'
import { HiFoxExecutor } from '../executor/hifox.ts'
import { hiFoxScope, type HiFoxAgent, type HiFoxPilot, type HiFoxScope } from '../executor/hifox-port.ts'
import { DINGTALK, dingTalkKind, pilotTrigger, receiveDingTalk, type DingTalkIntake, type DingTalkIntakeResult } from '../sources/dingtalk.ts'
import { openDingTalkSocket } from '../sources/dingtalk-socket.ts'
import type { DingTalkListener, DingTalkListenerStatus } from '../sources/dingtalk-listener.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Dreaming } from './dreaming/dreaming.ts'
import { DreamingAgent } from './dreaming/agent.ts'
import { collectOpenVikingAudit } from './dreaming/audit.ts'
import { openVikingMemory } from './dreaming/memory.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { retireSources } from './retired-sources.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { dingTalkClarifications } from './dingtalk-clarifications.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `HiFoxExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly dreaming: Dreaming
  private readonly dreamingAgent: DreamingAgent
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: Executor & Pick<HiFoxExecutor, 'activeCount' | 'resume'>
  readonly hiFox?: HiFoxExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost
  private readonly dingTalk?: DingTalkIntake
  private readonly listenDingTalk?: boolean
  private readonly hiFoxScope?: HiFoxScope
  private readonly hiFoxAgents?: HiFoxPilot['gateway']['agents']
  private readonly readDingTalkContext?: HiFoxPilot['readDingTalkContext']
  private ingressListening = false
  private dingTalkSocket?: ReturnType<typeof openDingTalkSocket>
  private dingTalkListener?: DingTalkListener
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void, hiFoxPilot?: HiFoxPilot, private readonly hiFoxDetail?: string) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const release = lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      this.dreamingAgent = new DreamingAgent(ctx, machine.stateDir, this.lifetime)
      this.dreaming = new Dreaming(store, effects, this.dreamingAgent, this.lifetime)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const links: LinkHost = { store, sources }
      const link = async (trigger: Trigger) => sourceLink(trigger)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        repliedTo: trigger => repliedTo(links, trigger), sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime,
        closing: () => this.closing(),
        tools: agent => mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      if (hiFoxPilot) {
        const { gateway, reconcileMs } = hiFoxPilot
        this.listenDingTalk = hiFoxPilot.dingTalkSocket === true
        if (reconcileMs !== undefined && (!Number.isFinite(reconcileMs) || reconcileMs <= 0)) {
          throw new Error('HiFox reconciliation window must be a positive number of milliseconds')
        }
        const pilot = { scope: hiFoxScope.parse(hiFoxPilot.scope), gateway,
          ...(reconcileMs === undefined ? {} : { reconcileMs }),
          ...(hiFoxPilot.codexDesktop ? { codexDesktop: hiFoxPilot.codexDesktop } : {}),
          ...(hiFoxPilot.codexHistory ? { codexHistory: hiFoxPilot.codexHistory } : {}),
          ...(hiFoxPilot.clarifications ? { clarifications: hiFoxPilot.clarifications } : {}),
          sendDingTalk: hiFoxPilot.sendDingTalk.bind(hiFoxPilot) }
        this.hiFoxScope = pilot.scope
        this.hiFoxAgents = gateway.agents.bind(gateway)
        this.readDingTalkContext = hiFoxPilot.readDingTalkContext
        this.disposers.push(sources.register(dingTalkKind(pilot.scope, async message => {
          if (hiFoxPilot.requireTerminalOrigin) {
            const ticket = message.ticketId && store.tickets.get(message.ticketId)
            const trigger = ticket && store.triggers.get(ticket.origin.triggerId)
            const meta = trigger && pilotTrigger(trigger, pilot.scope)
            const address = message.channel.address
            if (!ticket || ticket.executionTarget !== 'hifox' || !meta || !message.hiFoxTerminal
              || meta.messageId !== address.messageId || meta.conversationId !== address.conversationId) return 'gone'
          }
          return pilot.sendDingTalk(message)
        })))
        this.hiFox = new HiFoxExecutor({ store, effects, get engine() { return runtime.engine }, pilot, policy,
          paused: () => this.paused(), lifetime: this.lifetime })
        this.dingTalk = {
          scope: pilot.scope, getTrigger: id => store.triggers.get(id),
          getReference: id => store.triggers.disposition(id)?.filtered ? undefined : store.triggers.get(id),
          receive: trigger => this.passes.receive(trigger),
        }
        this.dingTalkListener = hiFoxPilot.createDingTalkListener?.(message => this.receiveDingTalk(message))
      }
      this.executor = this.hiFox ?? {
        start() { throw new Error('HiFox is not configured.') },
        deliver() {},
        stop() {},
        activeCount: () => 0,
        resume() {},
      }
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor: this.executor,
        outbox, prepareTicket: (ticket, outcome) => {
          if (sourceTrigger({ store }, ticket)?.source !== DINGTALK || !this.hiFox) {
            throw new Error('Only DingTalk requests can be assigned to the configured HiFox executor.')
          }
          if (!outcome.hiFoxAgent || outcome.hiFoxAgent.space !== this.hiFoxScope?.space) {
            throw new Error('Choose an eligible HiFox Agent before accepting the DingTalk request.')
          }
          return { ...ticket, executionTarget: 'hifox', hiFoxAgent: outcome.hiFoxAgent,
            ...(outcome.hiFoxQuote ? { hiFoxQuote: outcome.hiFoxQuote } : {}),
            ...(outcome.note ? { hiFoxRoutingNote: outcome.note } : {}) }
        }, emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
        } })
      if (hiFoxPilot?.clarifications) {
        dingTalkClarifications(store, effects, engine, hiFoxPilot.clarifications,
          () => this.closing() || this.paused() || !sources.instance(DINGTALK)?.enabled)
      }
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, receive: trigger => this.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        hiFoxAgents: (triggerId, signal) => {
          this.dingTalkOrigin(triggerId)
          return this.liveHiFoxRoster(signal)
        },
        dingTalkContext: async (triggerId, signal) => {
          const origin = this.dingTalkOrigin(triggerId)
          const room = origin.meta
          const nearby = await this.readDingTalkContext?.({ conversationId: room.conversationId, messageId: room.messageId,
            ...(room.quotedMessageId ? { quotedMessageId: room.quotedMessageId } : {}), at: origin.trigger.at },
          AbortSignal.any([this.lifetime, signal]))
          return { original: { conversationId: room.conversationId, messageId: room.messageId,
            text: origin.trigger.text, at: origin.trigger.at }, ...(nearby ?? {}) }
        },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  links(): LinkTarget { return channel => this.sources.link(channel, {}) }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult {
    if (trigger.source === 'feishu') throw new Error('The Feishu source has been removed')
    if (trigger.source === DINGTALK) throw new Error('Use receiveDingTalk for authenticated pilot events')
    return this.passes.receive(trigger)
  }
  receiveDingTalk(message: unknown): DingTalkIntakeResult {
    if (!this.dingTalk) throw new Error('The DingTalk pilot is unavailable')
    return receiveDingTalk(this.dingTalk, message)
  }
  private dingTalkOrigin(id: string) {
    const trigger = this.store.triggers.get(id)
    const meta = trigger && this.dingTalk && pilotTrigger(trigger, this.dingTalk.scope)
    if (!trigger || !meta || this.store.triggers.disposition(id)?.filtered || !this.engine.candidate(id)) {
      throw new Error('DingTalk routing requires an active, admitted candidate in the configured conversation.')
    }
    return { trigger, meta }
  }
  private async liveHiFoxRoster(signal = this.lifetime): Promise<{ space: string; agents: HiFoxAgent[] }> {
    if (!this.hiFoxAgents || !this.hiFoxScope) throw new Error('HiFox is not configured.')
    return { space: this.hiFoxScope.space, agents: await this.hiFoxAgents(AbortSignal.any([this.lifetime, signal])) }
  }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    this.dreamingAgent.install()
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    if (this.listenDingTalk) {
      this.dingTalkSocket = openDingTalkSocket(this.machine.stateDir, this.lifetime, event => this.receiveDingTalk(event))
      this.ingressListening = !!await this.dingTalkSocket
      if (this.closing()) return
    }
    this.quiet++
    try { retireSources(this.store, this.engine, this.effects) } finally { this.quiet-- }
    this.executor.resume()
    const dreaming = this.machine.dreamingOpenViking
    if (dreaming?.automatic) {
      this.dreaming.enableMaintenance(openVikingMemory(dreaming.cli, this.lifetime), () => {
        const signal = AbortSignal.any([this.lifetime, AbortSignal.timeout(180_000)])
        return collectOpenVikingAudit(dreaming.cli, openVikingMemory(dreaming.cli, signal).snapshot, signal, undefined, this.store)
      }, () => this.paused() || this.closing())
    }
    this.passes.start()
    this.effects.start()
    this.startListener()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  private hiFoxStatus() {
    const scope = this.hiFoxScope
    if (!scope) return { state: 'unconfigured' as const, listener: this.listenerStatus() }
    return {
      state: this.paused() || this.closing() || !this.sources.instance(DINGTALK)?.enabled ? 'paused' as const : 'configured' as const,
      ingress: this.ingressListening && !this.closing() ? 'socket' as const : this.listenDingTalk ? 'offline' as const : 'direct' as const,
      space: scope.space, listener: this.listenerStatus(),
    }
  }
  private listenerStatus(): DingTalkListenerStatus {
    return this.dingTalkListener?.status() ?? { state: 'unavailable', ...(this.hiFoxDetail ? { detail: this.hiFoxDetail } : {}) }
  }
  private startListener(): DingTalkListenerStatus {
    if (!this.dingTalkListener) return this.listenerStatus()
    const status = this.dingTalkListener.status()
    if (status.state === 'listening' || status.state === 'starting' || status.state === 'stopping') return status
    if (this.closing() || this.paused() || !this.sources.instance(DINGTALK)?.enabled) {
      return { state: 'error', detail: 'Resume the DingTalk source and DSH processing before starting the listener.' }
    }
    return this.dingTalkListener.start()
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks,
      dreaming: this.dreaming, lifetime: this.lifetime,
      get deployment() { return setup.deployment },
      hiFoxStatus: () => runtime.hiFoxStatus(),
      hiFoxAgentRoster: async () => ({ agents: runtime.hiFoxScope ? (await runtime.liveHiFoxRoster()).agents : [] }),
      listenerStatus: () => runtime.listenerStatus(), listenerStart: () => runtime.startListener(),
      listenerStop: () => runtime.dingTalkListener?.stop() ?? runtime.listenerStatus(),
      get setupProblem() { return setup.problem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    try {
      await this.dingTalkListener?.dispose()
      // Abort closes active clients. Wait for binding and teardown before releasing the state-directory lock.
      const closeSocket = await this.dingTalkSocket?.catch(() => undefined)
      await closeSocket?.()
      this.assessor.stop()
      const agent: Agent | undefined = this.ctx.agents.get(this.masterId as SessionId)
      agent?.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), agent?.whenIdle()])
      await this.dreamingAgent.shutdown()
      this.sessions.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
