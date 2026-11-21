// Turns one ACP session's MCP surface into the descriptor `session/new` takes.
//
// ACP has two MCP transports and an agent advertises which it speaks through
// `mcpCapabilities` in the handshake. `auto` therefore asks the agent: HTTP when
// it says `http: true`, otherwise the stdio shim, which every ACP agent supports
// because stdio MCP is the protocol's baseline.
//
// The descriptor is built from a *live* context object: `session/new` is what
// creates the ACP session, and the agent may connect to the MCP endpoint before
// that call returns. So the token is registered first and the context is filled
// in afterwards.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDshMcpSurface } from './mcp-tools.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHIM_PATH = path.join(here, 'mcp-stdio.js')

const SERVER_VERSION = '0.2.0'

/** Which transport to advertise to this agent. */
export function chooseTransport(config, agent) {
  const requested = config.mcp.transport
  if (requested === 'http' || requested === 'stdio') return requested
  const http = agent?.capabilities?.mcpCapabilities?.http
  return http === true ? 'http' : 'stdio'
}

/** Descriptors for `session/new`, plus the disposer that withdraws them. */
export function createMcpDescriptors({ config, gateway, context, transport, surface, log }) {
  const endpoint = gateway.endpointFor({
    surface,
    context,
    serverInfo: {
      name: `dsh-${config.id}`,
      title: `DeepSeek Harness (${config.displayName})`,
      version: SERVER_VERSION,
    },
  })
  const name = config.mcp.name
  if (transport === 'http') {
    const url = `${gateway.origin}${endpoint.path}`
    log?.trace('mcp endpoint', { transport, name, url: redactUrl(url), scoped: context.agent !== undefined })
    return {
      servers: [{
        type: 'http',
        name,
        url,
        headers: [{ name: 'Authorization', value: endpoint.header }],
      }],
      release: endpoint.release,
    }
  }
  const url = `${gateway.origin}${endpoint.path}`
  log?.trace('mcp endpoint', { transport, name, url: redactUrl(url), scoped: context.agent !== undefined })
  return {
    servers: [{
      name,
      command: process.execPath,
      args: [SHIM_PATH, url],
      env: [
        { name: 'DSH_ACP_MCP_URL', value: url },
        { name: 'DSH_ACP_MCP_TOKEN', value: endpoint.token },
      ],
    }],
    release: endpoint.release,
  }
}

/** Keep a token out of the trace log while leaving the endpoint readable. */
function redactUrl(url) {
  return url.replace(/\/mcp\/[^/?#]+/, '/mcp/<token>')
}

/**
 * The bridge the adapter calls for each new ACP session.
 *
 * Returns an empty descriptor set when MCP injection is disabled, so the
 * adapter never branches on the feature being absent.
 */
export function createMcpBridge({ ctx, gateway, log }) {
  return {
    async forSession(config, agent, context) {
      if (!config.mcp.enabled) return { servers: [], release: () => {} }
      await gateway.start()
      const surface = createDshMcpSurface({ ctx, config, log, context })
      const transport = chooseTransport(config, agent)
      return createMcpDescriptors({ config, gateway, context, transport, surface, log })
    },
  }
}
