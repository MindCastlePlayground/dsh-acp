// One supervised ACP agent: process lifecycle, handshake, and capability cache.
//
// The ACP handshake is the only place an agent states what it supports, so the
// initialize result is cached for the lifetime of one connection and reused by
// `listModels`, permission handling and session creation. A restart invalidates
// it, which is why every read goes through `AgentConnection` rather than a
// snapshot taken at registration time.

import { spawn } from 'node:child_process'
import path from 'node:path'
import { readFile, mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { AcpConnection, AcpRpcError } from './rpc.js'
import { BoundedLog } from './log.js'
import { delay, killTree, resolveSpawnSpec, trackAgentChild } from './process.js'

// One fs request must not be able to move an unbounded buffer through the wire
// or into memory; a larger file is paged with line/limit instead.
const MAX_FS_BYTES = 2 * 1024 * 1024

/** Containment on two canonical paths; `..foo` is a legal child, `..` is not. */
function isInside(base, target) {
  const relative = path.relative(base, target)
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/**
 * Canonicalize the deepest existing ancestor of a path that does not exist yet.
 *
 * A write target usually has no inode, but the directories leading to it do, and
 * those are where a symlink could redirect the write outside the session.
 */
async function realpathDeepest(target) {
  let current = target
  for (let depth = 0; depth < 64; depth += 1) {
    const resolved = await realpath(current).catch(() => undefined)
    if (resolved !== undefined) {
      const rest = path.relative(current, target)
      return rest === '' ? resolved : path.join(resolved, rest)
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return target
}

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
  // One ACP process holds many sessions, so the fs fence has to be per session:
  // a single field would apply the newest session's boundary to every other one.
  #cwdBySession = new Map()
  // Permission decisions are routed by session id, so concurrent turns never
  // share (or steal) a handler.
  #permissionHandlers = new Map()

  /**
   * Route this session's permission asks to `handler` until the returned
   * disposer runs. Registered per session, resolved per request.
   */
  setPermissionHandler(sessionId, handler) {
    this.#permissionHandlers.set(sessionId, handler)
    return () => {
      if (this.#permissionHandlers.get(sessionId) === handler) this.#permissionHandlers.delete(sessionId)
    }
  }

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
    // A host crash cannot await `killTree`, so the child is registered with a
    // synchronous exit hook; otherwise every crashed session orphans an agent
    // that keeps its port and its CPU until someone notices.
    trackAgentChild(child)
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
    // Permission handling is installed ONCE for the process, not per turn: a
    // connection holds one handler per method, so a per-turn install would let
    // two concurrent sessions steal it from each other, and the first turn to
    // finish would delete the very handler the other one still needs.
    connection.onRequest('session/request_permission', (params, meta) => {
      const sessionId = params?.sessionId
      const handler = typeof sessionId === 'string' ? this.#permissionHandlers.get(sessionId) : undefined
      if (handler === undefined) {
        // Not a failure: an unroutable ask must not leave the agent waiting, and
        // `cancelled` is the only answer ACP defines for "no decision".
        this.#log.trace('permission request for an unknown session', { sessionId, requestId: meta?.id })
        return { outcome: { outcome: 'cancelled' } }
      }
      return handler(params, meta)
    })
    // fs/* are advertised so agents that defer file I/O to the client keep
    // working. Both paths are resolved inside *the requesting session's* cwd and
    // refuse traversal outside it, because the client is the last line of
    // defence for an agent that guessed a path.
    connection.onRequest('fs/read_text_file', async (params) => {
      const target = await this.resolveFsPath(params?.path, params?.sessionId)
      const info = await stat(target).catch(() => undefined)
      if (info === undefined) throw new AcpRpcError(`fs read refused: "${target}" cannot be read`, { code: 'ACP_FS_MISSING' })
      if (!info.isFile()) throw new AcpRpcError(`fs read refused: "${target}" is not a regular file`, { code: 'ACP_FS_NOT_FILE' })
      if (info.size > MAX_FS_BYTES) {
        throw new AcpRpcError(
          `fs read refused: "${target}" is ${info.size} bytes, over the ${MAX_FS_BYTES}-byte limit; page it with line/limit or read a smaller file`,
          { code: 'ACP_FS_TOO_LARGE' },
        )
      }
      const text = await readFile(target, 'utf8')
      // Either field may arrive alone: `limit` without `line` means "the first N
      // lines", not "the whole file".
      const line = params?.line
      const limit = params?.limit
      if (Number.isInteger(line) || Number.isInteger(limit)) {
        const lines = text.split('\n')
        const start = Math.max(0, (Number.isInteger(line) && line > 0 ? line : 1) - 1)
        const end = Number.isInteger(limit) && limit > 0 ? start + limit : undefined
        return { content: lines.slice(start, end).join('\n') }
      }
      return { content: text }
    })
    connection.onRequest('fs/write_text_file', async (params) => {
      const target = await this.resolveFsPath(params?.path, params?.sessionId)
      const content = String(params?.content ?? '')
      if (Buffer.byteLength(content, 'utf8') > MAX_FS_BYTES) {
        throw new AcpRpcError(
          `fs write refused: ${Buffer.byteLength(content, 'utf8')} bytes exceeds the ${MAX_FS_BYTES}-byte limit`,
          { code: 'ACP_FS_TOO_LARGE' },
        )
      }
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
      return {}
    })
  }

  /**
   * The working directory that confines one session's fs requests.
   *
   * A process holds many ACP sessions, so a single `lastCwd` field would apply
   * the most recent session's boundary to every other one — a wrong-directory
   * write, not just a leak. The most recent value is only a fallback for agents
   * that omit `sessionId` (the field is not universal in practice).
   */
  #cwdFor(sessionId) {
    const known = typeof sessionId === 'string' ? this.#cwdBySession.get(sessionId) : undefined
    const base = known ?? this.#lastCwd
    if (base === undefined) {
      throw new AcpRpcError('fs request refused: no session working directory has been established yet', { code: 'ACP_NO_SESSION_CWD' })
    }
    return base
  }

  /** Record the cwd that confines one session's fs requests. */
  rememberCwd(sessionId, cwd) {
    this.#cwdBySession.set(sessionId, cwd)
    this.#lastCwd = cwd
  }

  /**
   * The path one session may touch, or an `AcpRpcError` refusal.
   *
   * Public so the fence can be verified directly: it is a policy about the
   * *client's* filesystem, and every branch of it is a refusal a user depends on.
   */
  async resolveFsPath(rawPath, sessionId) {
    const base = this.#cwdFor(sessionId)
    // Canonicalize the base first: a junction or a symlinked workspace would
    // otherwise reject every legitimate path.
    const realBase = await realpath(base).catch(() => path.resolve(base))
    const lexical = path.resolve(realBase, String(rawPath ?? ''))
    if (!isInside(realBase, lexical)) {
      throw new AcpRpcError(`refusing to touch "${lexical}" outside the agent directory "${realBase}"`, { code: 'ACP_PATH_ESCAPE' })
    }
    // A symlink *inside* the tree may still point out of it. Canonicalize the
    // deepest existing ancestor: for a write, the leaf usually does not exist,
    // and a path that cannot exist yet cannot be a link.
    const real = await realpath(lexical).catch(async () => realpathDeepest(lexical))
    if (!isInside(realBase, real)) {
      throw new AcpRpcError(`refusing to touch "${real}" outside the agent directory "${realBase}"`, { code: 'ACP_PATH_ESCAPE' })
    }
    return lexical
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
    this.rememberCwd(session.sessionId, directory)
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
    this.#cwdBySession.delete(sessionId)
    this.#permissionHandlers.delete(sessionId)
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
    this.#cwdBySession.clear()
    this.#permissionHandlers.clear()
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



