// Minimal Model Context Protocol server.
//
// ACP only injects tools as MCP servers: `session/new` takes a list of MCP
// server descriptors and the agent connects to them itself. So the direction
// this file implements is the reverse of DSH's own mcp-client — DSH is the MCP
// *server*, the ACP agent is the client.
//
// The protocol is small and stable, and the bundled @modelcontextprotocol SDK
// is not resolvable from a profile-installed plugin, so the transport-agnostic
// message handling lives here and the carriers live next door:
//
//   mcp.js          JSON-RPC methods and their results (this file)
//   mcp-tools.js    what DSH exposes through them (tools, prompts, resources)
//   mcp-gateway.js  loopback HTTP carrier + per-session capability tokens
//   mcp-stdio.js    stdio shim for agents that only speak stdio MCP
//
// Responses are MCP-shaped. Method results never throw: a failing tool becomes
// `isError: true` content, and only protocol-level mistakes become JSON-RPC
// errors.

// Versions this server can answer. The tools/prompts/resources surface is
// unchanged across them, and unknown methods fail cleanly, so accepting a newer
// client revision is safer than forcing a downgrade handshake.
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
export const MCP_LATEST_PROTOCOL = MCP_PROTOCOL_VERSIONS[0]

export const MCP_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
}

export class McpError extends Error {
  constructor(message, code = MCP_ERRORS.internal, data) {
    super(message)
    this.name = 'McpError'
    this.code = code
    this.data = data
  }
}

/** Build a success response envelope. */
export function mcpResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

/** Build an error response envelope. */
export function mcpError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  }
}

function invalid(message, data) {
  return new McpError(message, MCP_ERRORS.invalidParams, data)
}

/**
 * A transport-agnostic MCP server.
 *
 * `surface` answers the domain questions and may return plain values; this
 * class owns the protocol: method names, capability advertisement, and turning
 * a domain failure into the one result shape the client expects.
 */
export class McpServer {
  #surface
  #serverInfo
  #log
  #initialized = false
  #clientInfo

  constructor({ surface, serverInfo, log }) {
    this.#surface = surface
    this.#serverInfo = serverInfo
    this.#log = log
  }

  get initialized() {
    return this.#initialized
  }

  get clientInfo() {
    return this.#clientInfo
  }

  capabilities() {
    return {
      ...(this.#surface.listTools === undefined ? {} : { tools: { listChanged: false } }),
      ...(this.#surface.listPrompts === undefined ? {} : { prompts: { listChanged: false } }),
      ...(this.#surface.listResources === undefined && this.#surface.listResourceTemplates === undefined
        ? {}
        : {
          resources: {
            subscribe: false,
            listChanged: false,
            ...(this.#surface.listResourceTemplates === undefined ? {} : { templates: true }),
          },
        }),
    }
  }

  /**
   * Handle one decoded JSON-RPC message.
   *
   * @returns a response envelope, or `undefined` for notifications (which are
   *   never answered).
   */
  async handle(message) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      return mcpError(null, MCP_ERRORS.invalidRequest, 'a JSON-RPC message must be an object')
    }
    const isNotification = message.id === undefined
    const { method } = message
    if (typeof method !== 'string') {
      if (isNotification) return undefined
      // A response from the client (we never send requests) is ignored.
      if (message.result !== undefined || message.error !== undefined) return undefined
      return mcpError(message.id, MCP_ERRORS.invalidRequest, 'a request must carry a method')
    }
    if (isNotification) {
      if (method === 'notifications/initialized') {
        this.#log?.trace('mcp client initialized', this.#clientInfo)
      } else if (method === 'notifications/cancelled') {
        this.#log?.trace('mcp client cancelled a request', message.params)
      }
      return undefined
    }
    try {
      const result = await this.#dispatch(method, message.params)
      return mcpResult(message.id, result)
    } catch (error) {
      const code = error instanceof McpError ? error.code : MCP_ERRORS.internal
      const message2 = String(error?.message ?? error)
      if (!(error instanceof McpError)) this.#log?.trace('mcp method failed', { method, message: message2 })
      return mcpError(message.id, code, message2)
    }
  }

  async #dispatch(method, params) {
    switch (method) {
      case 'initialize': return this.#initialize(params)
      case 'ping': return {}
      case 'tools/list': return { tools: await this.#tools() }
      case 'tools/call': return this.#callTool(params)
      case 'prompts/list': return { prompts: await this.#prompts() }
      case 'prompts/get': return this.#getPrompt(params)
      case 'resources/list': return { resources: await this.#resources() }
      case 'resources/templates/list': return { resourceTemplates: await this.#resourceTemplates() }
      case 'resources/read': return this.#readResource(params)
      default:
        throw new McpError(`unknown method "${method}"`, MCP_ERRORS.methodNotFound)
    }
  }

  #initialize(params) {
    const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : undefined
    this.#clientInfo = params?.clientInfo ?? this.#clientInfo
    this.#initialized = true
    this.#log?.trace('mcp initialize', {
      protocolVersion: requested,
      clientInfo: params?.clientInfo,
      capabilities: params?.capabilities,
    })
    return {
      // Answer with the client's version when it is one this server speaks, so
      // an older client is not forced through a compatibility branch.
      protocolVersion: requested !== undefined && MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_LATEST_PROTOCOL,
      capabilities: this.capabilities(),
      serverInfo: this.#serverInfo,
      ...(this.#surface.instructions === undefined ? {} : { instructions: this.#surface.instructions }),
    }
  }

  async #tools() {
    if (this.#surface.listTools === undefined) throw new McpError('this server exposes no tools', MCP_ERRORS.methodNotFound)
    return this.#surface.listTools()
  }

  async #callTool(params) {
    if (this.#surface.callTool === undefined) throw new McpError('this server exposes no tools', MCP_ERRORS.methodNotFound)
    const name = params?.name
    if (typeof name !== 'string' || name === '') throw invalid('tools/call requires a tool name')
    const args = params?.arguments ?? {}
    if (args !== null && (typeof args !== 'object' || Array.isArray(args))) {
      throw invalid('tools/call arguments must be an object')
    }
    const result = await this.#surface.callTool(name, args)
    // A tool failure is a result, not a protocol error: the model has to read
    // it to recover, which a JSON-RPC error would hide.
    return {
      content: result.content,
      ...(result.isError === true ? { isError: true } : {}),
      ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
    }
  }

  async #prompts() {
    if (this.#surface.listPrompts === undefined) throw new McpError('this server exposes no prompts', MCP_ERRORS.methodNotFound)
    return this.#surface.listPrompts()
  }

  async #getPrompt(params) {
    if (this.#surface.getPrompt === undefined) throw new McpError('this server exposes no prompts', MCP_ERRORS.methodNotFound)
    const name = params?.name
    if (typeof name !== 'string' || name === '') throw invalid('prompts/get requires a prompt name')
    const prompt = await this.#surface.getPrompt(name, params?.arguments ?? {})
    if (prompt === undefined) throw invalid(`unknown prompt "${name}"`)
    return {
      description: prompt.description,
      messages: prompt.messages,
    }
  }

  async #resources() {
    if (this.#surface.listResources === undefined) throw new McpError('this server exposes no resources', MCP_ERRORS.methodNotFound)
    return this.#surface.listResources()
  }

  async #resourceTemplates() {
    if (this.#surface.listResourceTemplates === undefined) {
      throw new McpError('this server exposes no resource templates', MCP_ERRORS.methodNotFound)
    }
    return this.#surface.listResourceTemplates()
  }

  async #readResource(params) {
    if (this.#surface.readResource === undefined) throw new McpError('this server exposes no resources', MCP_ERRORS.methodNotFound)
    const uri = params?.uri
    if (typeof uri !== 'string' || uri === '') throw invalid('resources/read requires a uri')
    const contents = await this.#surface.readResource(uri)
    return { contents }
  }
}

/**
 * Cap the text of a tool result so one runaway command cannot flood an agent's
 * context. `maxBytes` is a budget for the whole call, not per block.
 */
export function truncateContent(content, maxBytes) {
  if (maxBytes === undefined || maxBytes <= 0) return content
  let remaining = maxBytes
  const output = []
  for (const block of content) {
    if (block.type !== 'text' || remaining <= 0) {
      if (remaining > 0) output.push(block)
      continue
    }
    const size = Buffer.byteLength(block.text, 'utf8')
    if (size <= remaining) {
      remaining -= size
      output.push(block)
      continue
    }
    const over = size - remaining
    // The notice describes why the text stops, but it must fit in what is left
    // of the budget rather than pushing the result over it.
    const detailed = `\n\n[truncated: ${over} bytes over the ${maxBytes}-byte MCP result budget]`
    const notice = detailed.length <= remaining ? detailed : '\n[truncated]'
    const keep = Math.max(0, remaining - notice.length)
    let text = block.text.slice(0, keep) + notice
    // A budget smaller than the marker still wins: the limit is the contract.
    while (Buffer.byteLength(text, 'utf8') > remaining) text = text.slice(0, -1)
    output.push({ type: 'text', text })
    remaining = 0
  }
  return output
}
