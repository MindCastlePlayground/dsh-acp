// Owns the configured agents and their adapters: lookup, bulk lifecycle, and
// the single place that decides a working directory for an agent.
//
// Kept deliberately thin: process lifecycle belongs to AcpAgent, protocol
// translation to the adapter, and this module only answers "which agent" and
// "which directory".

import { AcpAgent } from './agent.js'
import { createAcpAdapter } from './adapter.js'
import { AcpRpcError } from './rpc.js'

export class AcpManager {
  #agents = new Map()
  #adapters = new Map()
  #ctx
  #config
  #mcpGateway

  constructor({ config, ctx, defaultCwd, mcpGateway, mcpBridge }) {
    this.#ctx = ctx
    this.#config = config
    this.defaultCwd = defaultCwd
    this.#mcpGateway = mcpGateway
    for (const agentConfig of config.agents) {
      const agent = new AcpAgent({
        config: agentConfig,
        ctx,
        resolveCwd: (entry) => this.resolveCwd(entry),
      })
      this.#agents.set(agentConfig.id, agent)
      if (agentConfig.provider.enabled) {
        this.#adapters.set(agentConfig.id, createAcpAdapter({
          agent,
          config: agentConfig,
          log: agent.logs,
          ctx,
          mcpBridge,
        }))
      }
    }
  }

  get mcpGateway() {
    return this.#mcpGateway
  }

  get agents() {
    return [...this.#agents.values()]
  }

  ids() {
    return [...this.#agents.keys()]
  }

  has(id) {
    return this.#agents.has(id)
  }

  get(id) {
    return this.#agents.get(id)
  }

  adapter(id) {
    return this.#adapters.get(id)
  }

  /** Resolve `id`, or the only agent when the caller named none. */
  require(id) {
    if (id !== undefined && id !== null) {
      const agent = this.#agents.get(id)
      if (agent === undefined) throw new AcpRpcError(`unknown agent "${id}"; configured agents: ${this.ids().join(', ') || '(none)'}`, { code: 'ACP_UNKNOWN_AGENT' })
      return agent
    }
    const all = this.agents
    if (all.length === 1) return all[0]
    if (all.length === 0) throw new AcpRpcError('no ACP agents are configured', { code: 'ACP_NO_AGENT' })
    throw new AcpRpcError(`agent id is required when ${all.length} agents are configured: ${this.ids().join(', ')}`, { code: 'ACP_AMBIGUOUS_AGENT' })
  }

  /**
   * Working directory for one agent.
   *
   * A configured `cwd` wins. Otherwise the agent runs in the DSH default
   * directory, which is the session workspace an operator expects an agent's
   * file tools to touch.
   */
  async resolveCwd(agentConfig) {
    if (agentConfig?.cwd !== undefined) return agentConfig.cwd
    return this.defaultCwd()
  }

  list() {
    return this.agents.map((agent) => agent.snapshot())
  }

  async startAll() {
    const results = []
    for (const agent of this.agents) {
      if (!agent.config.enabled || !agent.config.autoStart) {
        results.push({ id: agent.id, ok: true, skipped: true })
        continue
      }
      try {
        await agent.start()
        results.push({ id: agent.id, ok: true })
      } catch (error) {
        results.push({ id: agent.id, ok: false, error: String(error?.message ?? error) })
      }
    }
    return results
  }

  async stopAll() {
    await Promise.allSettled(this.agents.map((agent) => agent.stop()))
  }

  async dispose() {
    await Promise.allSettled(this.agents.map((agent) => agent.dispose()))
  }

  /** Release pooled ACP sessions across every adapter (used before shutdown). */
  async releaseSessions() {
    await Promise.allSettled([...this.#adapters.values()].map((adapter) => adapter.release()))
  }
}
