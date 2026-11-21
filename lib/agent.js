// One supervised ACP agent: process lifecycle, handshake, and capability cache.
//
// The ACP handshake is the only place an agent states what it supports, so the
// initialize result is cached for the lifetime of one connection and reused by
// `listModels`, permission handling and session creation. A restart invalidates
// it, which is why every read goes through `AgentConnection` rather than a
// snapshot taken at registration time.

import { spawn } from 'node:child_process'
import path from 'node:path'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { AcpConnection, AcpRpcError } from './rpc.js'
import { BoundedLog } from './log.js'
import { delay, killTree, resolveSpawnSpec } from './process.js'

const ACP_PROTOCOL_VERSION = 1

/** Normalized model catalog entry derived from a session's `configOptions`. */
function modelOptionToModel(option) {
  const values = Array.isArray(option.options) ? option.options : []
  return values.map((entry) => ({
    id: typeof entry.value === 'string' ? entry.value : String(entry.value ?? entry.name ?? ''),
    name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : String(entry.value ?? ''),
    description: typeof entry.description === 'string' ? entry.description : undefined,
    group: option.id,
  })).filter((entry) => entry.id !== '')
}

export class AcpAgent {
  #config
  #log
  #connection
  #child
  #initResult
  #restarts = 0
  #restartWindowStart = 0
  #restartTimer
  #starting
  #disposed = false
  #activeSessions = new Set()
  #modelCache
  #lastCwd

  constructor({ config, ctx, resolveCwd }) {
    this.#config = config
    this.ctx = ctx
    this.resolveCwd = resolveCwd
    this.#log = new BoundedLog({
      maxLines: config.logs.maxLines,
      maxBytes: config.logs.maxBytes,
      file: config.logs.file,
      logger: ctx.logger,
      prefix: `acp:${config.id}`,
    })
    this.state = 'idle'
    this.lastError = undefined
    this.startedAt = undefined
    this.lastExit = undefined
    // Set when `llm.registerAdapter` rejects this route, which otherwise leaves
    // a running agent that no model request can reach.
    this.providerError = undefined
  }

  get id() {
    return this.#config.id
  }

  get config() {
    return this.#config
  }

  get logs() {
    return this.#log
  }

  get connection() {
    return this.#connection
  }

  get running() {
    return this.#connection !== undefined && !this.#connection.closed
  }

  get capabilities() {
    return this.#initResult?.agentCapabilities ?? {}
  }

  get agentInfo() {
    return this.#initResult?.agentInfo ?? this.#initResult?._meta?.['agentInfo']
  }

  get authMethods() {
    return this.#initResult?.authMethods ?? []
  }

  snapshot() {
    return {
      id: this.#config.id,
      state: this.state,
      running: this.running,
      pid: this.#child?.pid,
      startedAt: this.startedAt,
      restarts: this.#restarts,
      lastError: this.lastError,
      ...(this.providerError === undefined ? {} : { providerError: this.providerError }),
      lastExit: this.lastExit,
      command: this.#config.command,
      args: this.#config.args,
      route: this.#config.provider.route,
      agentInfo: this.agentInfo,
      protocolVersion: this.#initResult?.protocolVersion,
      authMethods: this.authMethods.map((method) => ({
        id: method.id,
        name: method.name,
        description: method.description,
      })),
      capabilities: this.capabilities,
      activeSessions: this.#activeSessions.size,
      pendingRequests: this.#connection?.pendingCount ?? 0,
      ...(this.#config.logs.file === undefined ? {} : { logFile: this.#config.logs.file }),
    }
  }

  /** Start the process and complete the ACP handshake, or throw. */
  async start({ signal } = {}) {
    if (this.running) return this.snapshot()
    if (this.#starting !== undefined) return this.#starting
    this.#starting = this.#startOnce({ signal }).finally(() => {
      this.#starting = undefined
    })
    return this.#starting
  }

  async #startOnce({ signal } = {}) {
    if (this.#disposed) throw new AcpRpcError(`agent "${this.#config.id}" is disposed`, { code: 'ACP_DISPOSED' })
    this.state = 'starting'
    const cwd = await this.resolveCwd(this.#config)
    const spec = resolveSpawnSpec(this.#config)
    this.#log.trace('spawn', { command: spec.command, args: spec.args, shell: spec.shell, cwd })

    const env = { ...process.env }
    for (const [key, value] of Object.entries(this.#config.env)) {
      if (value === null) delete env[key]
      else env[key] = value
    }

    let child
    try {
      child = spawn(spec.command, spec.args, {
        cwd,
        env,
        shell: spec.shell,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      this.state = 'failed'
      this.lastError = `cannot spawn "${this.#config.command}": ${String(error?.message ?? error)}`
      throw new AcpRpcError(this.lastError, { code: 'ACP_SPAWN' })
    }
    this.#child = child
    const connection = new AcpConnection({ child, log: this.#log })
    this.#connection = connection

    child.on('exit', (code, exitSignal) => {
      this.lastExit = { code, signal: exitSignal, at: new Date().toISOString() }
      this.#log.push('trace', `agent exited code=${code ?? 'null'} signal=${exitSignal ?? 'null'}`)
      if (this.#connection === connection) {
        this.#connection = undefined
        this.#initResult = undefined
        this.#modelCache = undefined
        // Only a live agent that dies on its own earns a restart. A deliberate
        // stop, a failed handshake, or an exhausted budget must not resurrect it.
        if ((this.state === 'running' || this.state === 'starting') && !this.#disposed) {
          this.state = 'exited'
          this.#scheduleRestart(`agent exited (code=${code ?? 'null'}, signal=${exitSignal ?? 'null'})`)
        } else if (this.state !== 'stopped') {
          this.state = this.state === 'starting' ? 'failed' : 'stopped'
        }
      }
      this.emitState()
    })

    connection.on('error', (error) => {
      this.#log.push('trace', `connection error: ${String(error?.message ?? error)}`)
    })

    this.#installDefaultRequestHandlers(connection)

    try {
      const init = await connection.request('initialize', {
        protocolVersion: this.#config.protocolVersion ?? ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
        clientInfo: this.#config.clientInfo,
      }, { timeoutMs: this.#config.startupTimeoutMs, ...(signal === undefined ? {} : { signal }) })
      this.#initResult = init ?? {}
      this.startedAt = new Date().toISOString()
      this.state = 'running'
      this.lastError = undefined
      this.#log.trace('initialize', {
        protocolVersion: this.#initResult.protocolVersion,
        agentInfo: this.agentInfo,
        agentCapabilities: this.capabilities,
        authMethods: this.authMethods.map((method) => method.id),
      })
      this.ctx.logger.info(`[dsh-acp:${this.#config.id}] connected to ${this.agentInfo?.name ?? this.#config.command} ${this.agentInfo?.version ?? ''}`.trim())
      this.emitState()
      // A login-required agent answers `initialize` fine and fails every prompt
      // with "not authenticated"; doing the configured authenticate here turns
      // that into one clear activation error instead.
      if (this.#config.auth.methodId !== undefined && this.#config.auth.auto) {
        await this.authenticate(this.#config.auth.methodId, { signal }).catch((error) => {
          this.#log.trace('authenticate failed', String(error?.message ?? error))
          this.ctx.logger.warn(`[dsh-acp:${this.#config.id}] authenticate("${this.#config.auth.methodId}") failed: ${String(error?.message ?? error)}`)
        })
      }
      return this.snapshot()
    } catch (error) {
      this.lastError = String(error?.message ?? error)
      this.state = 'failed'
      this.#log.trace('initialize failed', this.lastError)
      // The handshake failed: this is an activation problem, not a crash, so the
      // process is killed without arming the restart budget.
      await killTree(child)
      if (this.#connection === connection) {
        connection.dispose()
        this.#connection = undefined
      }
      this.#initResult = undefined
      this.state = 'failed'
      this.emitState()
      throw error
    }
  }

  #installDefaultRequestHandlers(connection) {
    // fs/* are advertised so agents that defer file I/O to the client keep
    // working. Both paths are resolved inside the session's cwd when possible
    // and refuse traversal outside it, because the client is the last line of
    // defence for an agent that guessed a path.
    connection.onRequest('fs/read_text_file', async (params) => {
      const target = this.#resolveInsideCwd(params?.path)
      const text = await readFile(target, 'utf8')
      const line = params?.line
      const limit = params?.limit
      if (Number.isInteger(line) && line > 0) {
        const lines = text.split('\n')
        const start = line - 1
        const end = Number.isInteger(limit) && limit > 0 ? start + limit : undefined
        return { content: lines.slice(start, end).join('\n') }
      }
      return { content: text }
    })
    connection.onRequest('fs/write_text_file', async (params) => {
      const target = this.#resolveInsideCwd(params?.path)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, String(params?.content ?? ''), 'utf8')
      return {}
    })
  }

  #resolveInsideCwd(rawPath) {
    const base = this.#lastCwd ?? process.cwd()
    const resolved = path.resolve(base, String(rawPath ?? ''))
    const relative = path.relative(base, resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new AcpRpcError(`refusing to touch "${resolved}" outside the agent directory "${base}"`, { code: 'ACP_PATH_ESCAPE' })
    }
    return resolved
  }

  emitState() {
    try { this.ctx.emit?.('acp/state', { id: this.#config.id, ...this.snapshot() }) } catch {}
  }

  #scheduleRestart(reason) {
    if (this.#disposed) return
    const policy = this.#config.restart
    if (!policy.enabled) {
      this.state = 'failed'
      this.lastError = `${reason}; restart is disabled`
      return
    }
    this.lastError = reason
    const now = Date.now()
    if (now - this.#restartWindowStart > policy.windowMs) {
      this.#restartWindowStart = now
      this.#restarts = 0
    }
    if (this.#restarts >= policy.maxRestarts) {
      this.state = 'failed'
      this.lastError = `${reason}; restart budget of ${policy.maxRestarts} per ${policy.windowMs}ms is exhausted`
      this.ctx.logger.warn(`[dsh-acp:${this.#config.id}] ${this.lastError}`)
      this.emitState()
      return
    }
    this.#restarts += 1
    const backoff = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (this.#restarts - 1))
    this.state = 'restarting'
    this.#log.trace('restart scheduled', { attempt: this.#restarts, backoff, reason })
    this.ctx.logger.warn(`[dsh-acp:${this.#config.id}] ${reason}; restarting in ${backoff}ms (attempt ${this.#restarts}/${policy.maxRestarts})`)
    this.emitState()
    const timer = setTimeout(() => {
      this.#restartTimer = undefined
      this.start().catch((error) => {
        this.ctx.logger.warn(`[dsh-acp:${this.#config.id}] restart failed: ${String(error?.message ?? error)}`)
        if (!this.#disposed && this.state === 'failed' && this.#connection === undefined) {
          this.#scheduleRestart(String(error?.message ?? error))
        }
      })
    }, backoff)
    timer.unref?.()
    this.#restartTimer = timer
  }

  /** Ask the agent for a fresh session and read its model options. */
  async createSession({ cwd, mcpServers = [] } = {}) {
    await this.start()
    const connection = this.#connection
    if (connection === undefined) throw new AcpRpcError(`agent "${this.#config.id}" is not running`, { code: 'ACP_NOT_RUNNING' })
    const directory = cwd ?? (await this.resolveCwd(this.#config))
    this.#lastCwd = directory
    const result = await connection.request('session/new', { cwd: directory, mcpServers }, {
      timeoutMs: this.#config.startupTimeoutMs,
    })
    if (typeof result?.sessionId !== 'string' || result.sessionId === '') {
      throw new AcpRpcError('the ACP agent returned no sessionId for session/new', { code: 'ACP_PROTOCOL' })
    }
    const session = {
      sessionId: result.sessionId,
      configOptions: Array.isArray(result.configOptions) ? result.configOptions : [],
      modes: result.modes,
      _meta: result._meta,
      agent: this,
      cwd: directory,
    }
    this.#activeSessions.add(session.sessionId)
    this.#log.trace('session created', { sessionId: session.sessionId, configIds: session.configOptions.map((option) => option.id) })
    if (this.#modelCache === undefined && session.configOptions.length > 0) {
      this.#modelCache = { at: Date.now(), models: this.#modelsFromOptions(session.configOptions) }
    }
    return session
  }

  #modelsFromOptions(configOptions) {
    const modeOption = configOptions.find((option) => option.category === 'model')
    if (modeOption === undefined) return []
    const models = []
    const seen = new Set()
    for (const entry of modelOptionToModel(modeOption)) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      models.push({
        id: entry.id,
        name: entry.name,
        description: entry.description ?? `ACP model "${entry.id}" served by ${this.#config.displayName}`,
        contextWindow: this.#config.provider.contextWindow,
        maxTokens: this.#config.provider.maxTokens,
      })
    }
    return models
  }

  /**
   * The model catalog this agent exposes. Configured models win; otherwise the
   * list is discovered from a probe session and cached for `modelCacheMs`,
   * because `listModels` runs on every GUI render.
   *
   * An agent with no model option still needs one routable id, otherwise DSH
   * cannot address the route at all. That id is synthetic: it is never sent to
   * the agent, and `applySessionOptions` skips unknown options.
   */
  async listModels({ force = false } = {}) {
    if (this.#config.provider.models.length > 0) {
      return this.#config.provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }))
    }
    if (!this.#config.provider.discoverModels) return this.#fallbackModels()
    const cacheMs = this.#config.provider.modelCacheMs
    if (!force && this.#modelCache !== undefined && Date.now() - this.#modelCache.at < cacheMs) {
      return this.#modelCache.models
    }
    try {
      const session = await this.createSession()
      const discovered = this.#modelsFromOptions(session.configOptions)
      const models = discovered.length === 0 ? this.#fallbackModels() : discovered
      this.#modelCache = { at: Date.now(), models }
      // A discovery session has no conversation; leave no session behind.
      void this.closeSession(session.sessionId).catch(() => {})
      return models
    } catch (error) {
      this.#log.trace('model discovery failed', String(error?.message ?? error))
      if (this.#modelCache !== undefined) return this.#modelCache.models
      return this.#fallbackModels()
    }
  }

  #fallbackModels() {
    const provider = this.#config.provider
    const label = this.agentInfo?.name ?? this.#config.displayName
    return [{
      id: provider.fallbackModel,
      name: provider.fallbackModelName ?? `${label} (agent default)`,
      description: `The single model ${this.#config.displayName} serves; it has no model picker of its own.`,
      contextWindow: provider.contextWindow,
      maxTokens: provider.maxTokens,
    }]
  }

  /** Run ACP's `authenticate` for an API-key style login method. */
  async authenticate(methodId, { signal } = {}) {
    const connection = this.#connection
    if (connection === undefined) throw new AcpRpcError(`agent "${this.#config.id}" is not running`, { code: 'ACP_NOT_RUNNING' })
    const id = methodId ?? this.#config.auth.methodId ?? this.authMethods[0]?.id
    if (id === undefined) throw new AcpRpcError(`agent "${this.#config.id}" reports no authentication method`, { code: 'ACP_AUTH' })
    const result = await connection.request('authenticate', { methodId: id }, {
      timeoutMs: this.#config.startupTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    })
    this.#log.trace('authenticate', { methodId: id })
    return result ?? {}
  }

  async setConfigOption(sessionId, configId, value) {
    const connection = this.#connection
    if (connection === undefined) throw new AcpRpcError(`agent "${this.#config.id}" is not running`, { code: 'ACP_NOT_RUNNING' })
    const result = await connection.request('session/set_config_option', { sessionId, configId, value }, {
      timeoutMs: this.#config.startupTimeoutMs,
    })
    return Array.isArray(result?.configOptions) ? result.configOptions : []
  }

  async closeSession(sessionId) {
    this.#activeSessions.delete(sessionId)
    const connection = this.#connection
    if (connection === undefined || connection.closed) return
    if (this.capabilities?.sessionCapabilities?.close === false) return
    try {
      await connection.request('session/close', { sessionId }, { timeoutMs: this.#config.stopTimeoutMs })
    } catch (error) {
      this.#log.trace('session/close failed', { sessionId, message: String(error?.message ?? error) })
    }
  }

  /** Stop the agent: close sessions, then terminate the process tree. */
  async stop({ timeoutMs } = {}) {
    const budget = timeoutMs ?? this.#config.stopTimeoutMs
    const connection = this.#connection
    const child = this.#child
    if (this.#restartTimer !== undefined) {
      clearTimeout(this.#restartTimer)
      this.#restartTimer = undefined
    }
    if (connection === undefined && child === undefined) {
      this.state = 'stopped'
      this.emitState()
      return
    }
    this.state = 'stopping'
    this.emitState()
    if (connection !== undefined && !connection.closed) {
      // Best effort with a short ceiling: an agent that ignores `session/close`
      // still gets its process tree killed, and shutdown must not spend the
      // whole stop budget waiting for politeness.
      await Promise.race([
        Promise.allSettled([...this.#activeSessions].map((sessionId) => this.closeSession(sessionId))),
        delay(Math.min(budget, 1_000)),
      ])
    }
    this.#activeSessions.clear()
    if (child !== undefined) await killTree(child, { signalGraceMs: Math.min(budget, 3_000) })
    connection?.dispose()
    if (this.#connection === connection) this.#connection = undefined
    this.#child = undefined
    this.#initResult = undefined
    this.#modelCache = undefined
    this.state = 'stopped'
    this.emitState()
  }

  async restart() {
    await this.stop()
    this.#restarts = 0
    this.#restartWindowStart = 0
    return this.start()
  }

  async dispose() {
    this.#disposed = true
    if (this.#restartTimer !== undefined) {
      clearTimeout(this.#restartTimer)
      this.#restartTimer = undefined
    }
    await this.stop()
    await this.#log.dispose()
  }
}
