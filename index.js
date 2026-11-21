// DSH ACP bridge plugin entry.
//
// The plugin supervises local ACP (Agent Client Protocol) agents and registers
// each one as a DSH model route, so an ACP-speaking agent — opencode, or any
// other ACP implementation — can be selected as a model inside the Harness.
//
// The layering:
//
//   index.js    activation, route registration, lifecycle effect
//   lib/rpc.js  JSON-RPC 2.0 over stdio
//   lib/agent.js one supervised agent: spawn, handshake, restart, sessions
//   lib/adapter.js  ACP updates -> DSH StreamChunks
//   lib/transcript.js  DSH transcript -> ACP prompt, and session reuse
//   lib/tools.js  acp_status / acp_control / acp_logs / acp_selftest

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeConfig, AcpConfigError } from './lib/config.js'
import { AcpManager } from './lib/manager.js'
import { registerAcpTools } from './lib/tools.js'
import { createMcpBridge } from './lib/mcp-bridge.js'
import { McpGateway } from './lib/mcp-gateway.js'

const packageDir = path.dirname(fileURLToPath(import.meta.url))

export const name = 'acp'

export const inject = ['tools', 'llm']

export function apply(ctx, rawConfig) {
  let config
  try {
    config = normalizeConfig(rawConfig, { packageDir })
  } catch (error) {
    const message = error instanceof AcpConfigError ? error.message : String(error?.message ?? error)
    ctx.logger.error(`[dsh-acp] invalid configuration: ${message}`)
    throw error
  }

  if (config.agents.length === 0) {
    ctx.logger.info('[dsh-acp] no agents configured; plugin is dormant')
    return
  }

  // An agent's default directory is the workspace DSH would run a subprocess in,
  // so an ACP agent's file tools land where the operator expects them.
  const defaultCwd = () => {
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory !== undefined && typeof workingDirectory.defaultDirectory === 'string') {
      return workingDirectory.defaultDirectory
    }
    return process.cwd()
  }

  // MCP traffic is traced into the owning agent's log, but the gateway is built
  // before the manager that owns those logs, so it writes through this indirection.
  const mcpLog = {
    trace(event, data) {
      try {
        for (const agent of manager.agents) agent.logs.trace(`mcp:${event}`, data)
      } catch {}
    },
  }

  // One listener serves every agent: the endpoint path carries the session
  // token, so a peer cannot reach another session's tools by guessing a port.
  const gateway = new McpGateway({ log: mcpLog })
  const mcpBridge = createMcpBridge({ ctx, gateway, log: mcpLog })

  const manager = new AcpManager({ config, ctx, defaultCwd, mcpGateway: gateway, mcpBridge })

  const llm = ctx.get('llm')
  if (llm === undefined) {
    ctx.logger.warn('[dsh-acp] the llm service is unavailable; agents will run without model routes')
  }

  const adapterHandles = []
  if (llm !== undefined) {
    for (const agent of manager.agents) {
      const agentConfig = agent.config
      if (!agentConfig.provider.enabled) {
        ctx.logger.info(`[dsh-acp:${agent.id}] provider registration disabled; agent is tool-only`)
        continue
      }
      const adapter = manager.adapter(agent.id)
      if (adapter === undefined) continue
      try {
        adapterHandles.push(llm.registerAdapter([agentConfig.provider.route], adapter))
        ctx.logger.info(`[dsh-acp:${agent.id}] registered model route "${agentConfig.provider.route}"`)
      } catch (error) {
        // A route that fails to register leaves a running agent nobody can
        // reach, so the reason is recorded on the agent and shown by acp_status.
        agent.providerError = String(error?.message ?? error)
        ctx.logger.error(`[dsh-acp:${agent.id}] cannot register model route "${agentConfig.provider.route}": ${agent.providerError}`)
      }
    }
  }

  ctx.logger.info(`[dsh-acp] managing ${config.agents.length} agent(s): ${manager.ids().join(', ')}`)

  const toolsDisposer = registerAcpTools(ctx, manager)

  // Autostart is asynchronous: activation must not block the Host while an agent
  // boots. The effect owns the timer so an unload during boot cannot leave a
  // process behind.
  ctx.effect(() => {
    let disposed = false
    const timer = setTimeout(() => {
      if (disposed) return
      manager.startAll().then((results) => {
        for (const result of results) {
          if (!result.ok) ctx.logger.warn(`[dsh-acp:${result.id}] autostart failed: ${result.error}`)
        }
      }).catch((error) => {
        ctx.logger.error(`[dsh-acp] autostart error: ${String(error?.message ?? error)}`)
      })
    }, 50)
    timer.unref?.()

    return async () => {
      disposed = true
      clearTimeout(timer)
      try { toolsDisposer?.() } catch {}
      for (const handle of adapterHandles) {
        try { handle() } catch {}
      }
      await manager.releaseSessions()
      await manager.dispose()
      await gateway.dispose()
    }
  }, 'dsh-acp: lifecycle and autostart')
}

export { normalizeConfig, AcpConfigError }
