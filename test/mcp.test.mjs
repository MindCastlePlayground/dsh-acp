// MCP injection: the server DSH offers to an ACP agent.
//
// These tests exercise the protocol against stubbed Host services, so they can
// assert exact wire shapes without a model or a real agent. The gateway and the
// stdio shim are tested as real carriers — a socket and a child process — because
// that is where token handling and framing mistakes actually live.

import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { McpServer, MCP_ERRORS, MCP_LATEST_PROTOCOL, truncateContent } from '../lib/mcp.js'
import {
  createDshMcpSurface,
  matchesPattern,
  resultToMcp,
  selectTools,
} from '../lib/mcp-tools.js'
import { McpGateway } from '../lib/mcp-gateway.js'
import { chooseTransport } from '../lib/mcp-bridge.js'
import { normalizeConfig } from '../lib/config.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHIM = path.join(here, '..', 'lib', 'mcp-stdio.js')

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

function makeConfig(overrides = {}) {
  return normalizeConfig({
    agents: {
      fake: {
        command: process.execPath,
        args: ['test/fake-agent.mjs'],
        autoStart: false,
        mcp: overrides.mcp,
      },
    },
  }).agents[0]
}

/** A tools registry double that records what executed. */
function stubTools({ schemas, calls = [] } = {}) {
  return {
    calls,
    schemas: () => schemas ?? [
      { name: 'bash', description: 'Run a command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'acp_status', description: 'Own control.', parameters: { type: 'object', properties: {} } },
    ],
    async execute(exec) {
      calls.push(exec)
      if (exec.name === 'bash') {
        return { isError: false, content: [{ type: 'text', text: `ran ${exec.arguments.command}` }], value: { code: 0 } }
      }
      if (exec.name === 'read_file') {
        return { isError: true, content: [{ type: 'text', text: 'Error: no such file' }], error: { message: 'no such file' } }
      }
      return { isError: false, content: [{ type: 'text', text: 'ok' }] }
    },
  }
}

function stubSkills() {
  return {
    async list() {
      return [
        { name: 'demo-skill', description: 'A demo skill.', invocation: { modelInvocable: true, userInvocable: true } },
        { name: 'internal-only', description: 'Hidden.', invocation: { modelInvocable: false, userInvocable: true } },
      ]
    },
    async get(name) {
      if (name !== 'demo-skill') return undefined
      return { name, description: 'A demo skill.', content: 'Do the demo thing.', whenToUse: 'when demoing' }
    },
  }
}

function stubCtx({ tools = stubTools(), skills = stubSkills() } = {}) {
  return {
    logger: silentLogger,
    get: (key) => (key === 'tools' ? tools : key === 'skills' ? skills : undefined),
  }
}

function makeServer({ config = makeConfig(), ctx = stubCtx(), context = { agent: undefined, cwd: process.cwd() } } = {}) {
  const surface = createDshMcpSurface({ ctx, config, log: undefined, context })
  const server = new McpServer({
    surface,
    serverInfo: { name: 'dsh-fake', version: '0.2.0' },
    log: undefined,
  })
  return { server, surface, config, ctx, context }
}

async function call(server, method, params = {}) {
  const reply = await server.handle({ jsonrpc: '2.0', id: 1, method, params })
  return reply
}

test('tool masks select by include and always honour exclude', () => {
  assert.equal(matchesPattern('acp_status', 'acp_*'), true)
  assert.equal(matchesPattern('bash', 'acp_*'), false)
  assert.equal(matchesPattern('bash', 'b*'), true)
  assert.equal(matchesPattern('bash', 'bash'), true)
  assert.equal(matchesPattern('bash-tool', 'bash'), false)

  const tools = [{ name: 'bash' }, { name: 'read_file' }, { name: 'acp_status' }]
  assert.deepEqual(selectTools(tools, { include: [], exclude: ['acp_*'] }).map((tool) => tool.name), ['bash', 'read_file'])
  assert.deepEqual(selectTools(tools, { include: ['read_*'], exclude: [] }).map((tool) => tool.name), ['read_file'])
  // Exclude wins over include, so a wide mask cannot re-expose a control tool.
  assert.deepEqual(selectTools(tools, { include: ['acp_*'], exclude: ['acp_*'] }), [])
})

test('initialize advertises only the capabilities the surface implements', async () => {
  const { server } = makeServer()
  const reply = await call(server, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'probe', version: '1' } })
  assert.equal(reply.result.protocolVersion, '2025-06-18')
  assert.equal(reply.result.serverInfo.name, 'dsh-fake')
  assert.deepEqual(reply.result.capabilities.tools, { listChanged: false })
  assert.deepEqual(reply.result.capabilities.prompts, { listChanged: false })
  assert.equal(reply.result.capabilities.resources.subscribe, false)
  assert.equal(reply.result.capabilities.resources.templates, true)
  assert.match(reply.result.instructions, /DeepSeek Harness/)

  // An older client keeps its own version rather than being upgraded silently.
  const older = await call(server, 'initialize', { protocolVersion: '2024-11-05' })
  assert.equal(older.result.protocolVersion, '2024-11-05')
  const unknown = await call(server, 'initialize', { protocolVersion: '1999-01-01' })
  assert.equal(unknown.result.protocolVersion, MCP_LATEST_PROTOCOL)
})

test('tools list and call round-trip through the registry', async () => {
  const config = makeConfig()
  const tools = stubTools()
  const { server } = makeServer({ config, ctx: stubCtx({ tools }) })

  const listed = await call(server, 'tools/list')
  const names = listed.result.tools.map((tool) => tool.name)
  assert.deepEqual(names, ['bash', 'read_file', 'dsh_skills'])
  assert.equal(listed.result.tools[0].inputSchema.required[0], 'command')

  const ok = await call(server, 'tools/call', { name: 'bash', arguments: { command: 'echo hi' } })
  assert.equal(ok.result.isError, undefined)
  assert.deepEqual(ok.result.content, [{ type: 'text', text: 'ran echo hi' }])
  assert.equal(tools.calls.length, 1)
  assert.equal(tools.calls[0].name, 'bash')
  assert.deepEqual(tools.calls[0].arguments, { command: 'echo hi' })
  assert.equal(tools.calls[0].callId.startsWith('acp-mcp-'), true)
  assert.equal(tools.calls[0].agent, undefined)

  // A failing tool is a result, not a protocol error: the model must read it.
  const failed = await call(server, 'tools/call', { name: 'read_file', arguments: { path: '/nope' } })
  assert.equal(failed.result.isError, true)
  assert.match(failed.result.content[0].text, /no such file/)

  const unknown = await call(server, 'tools/call', { name: 'nope', arguments: {} })
  assert.equal(unknown.result.isError, true)
  assert.match(unknown.result.content[0].text, /unknown tool "nope"/)

  const method = await call(server, 'tools/nope')
  assert.equal(method.error.code, MCP_ERRORS.methodNotFound)
})

test('the generated skill tool lists and loads skills', async () => {
  const { server } = makeServer()
  const list = await call(server, 'tools/call', { name: 'dsh_skills', arguments: {} })
  assert.match(list.result.content[0].text, /demo-skill: A demo skill\./)
  // A skill the registry keeps model-invocable=false never leaks into the catalog.
  assert.doesNotMatch(list.result.content[0].text, /internal-only/)

  const loaded = await call(server, 'tools/call', { name: 'dsh_skills', arguments: { name: 'demo-skill' } })
  assert.match(loaded.result.content[0].text, /<skill_instructions>\nDo the demo thing\./)
  assert.match(loaded.result.content[0].text, /When to use: when demoing/)

  const missing = await call(server, 'tools/call', { name: 'dsh_skills', arguments: { name: 'ghost' } })
  assert.equal(missing.result.isError, true)
})

test('prompts and resources expose skills, and file reads stay inside cwd', async () => {
  const { server } = makeServer()
  const prompts = await call(server, 'prompts/list')
  assert.deepEqual(prompts.result.prompts.map((prompt) => prompt.name), ['demo-skill'])

  const prompt = await call(server, 'prompts/get', { name: 'demo-skill' })
  assert.equal(prompt.result.messages[0].role, 'user')
  assert.match(prompt.result.messages[0].content.text, /Do the demo thing\./)
  assert.equal((await call(server, 'prompts/get', { name: 'ghost' })).error.code, MCP_ERRORS.invalidParams)

  const resources = await call(server, 'resources/list')
  const uris = resources.result.resources.map((resource) => resource.uri)
  assert.deepEqual(uris, ['dsh://skill/demo-skill', 'dsh://session'])

  const templates = await call(server, 'resources/templates/list')
  assert.equal(templates.result.resourceTemplates[0].uriTemplate, 'dsh://file/{+path}')

  const session = await call(server, 'resources/read', { uri: 'dsh://session' })
  const summary = JSON.parse(session.result.contents[0].text)
  assert.deepEqual(summary.tools, ['bash', 'read_file'])
  assert.deepEqual(summary.skills, ['demo-skill'])

  const skill = await call(server, 'resources/read', { uri: 'dsh://skill/demo-skill' })
  assert.equal(skill.result.contents[0].mimeType, 'text/markdown')

  const pkg = await call(server, 'resources/read', { uri: 'dsh://file/package.json' })
  assert.match(pkg.result.contents[0].text, /"name": "@local\/dsh-acp"/)

  // Traversal out of the session directory is refused, not resolved.
  const escape = await call(server, 'resources/read', { uri: 'dsh://file/../../etc/passwd' })
  assert.equal(escape.error.code, MCP_ERRORS.internal)
  assert.match(escape.error.message, /outside the session directory/)
})

test('notifications are never answered and unknown methods fail cleanly', async () => {
  const { server } = makeServer()
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined)
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }), undefined)

  const bad = await server.handle({ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: {} })
  assert.equal(bad.error.code, MCP_ERRORS.invalidParams)

  const notRequest = await server.handle({ jsonrpc: '2.0', id: 4 })
  assert.equal(notRequest.error.code, MCP_ERRORS.invalidRequest)
})

test('tool results are truncated to the configured byte budget', () => {
  const content = truncateContent([{ type: 'text', text: 'x'.repeat(100) }], 40)
  assert.equal(content.length, 1)
  assert.match(content[0].text, /truncated/)
  assert.ok(Buffer.byteLength(content[0].text, 'utf8') <= 40, 'the notice must fit inside the budget')
  // When the notice cannot fit, the budget still wins.
  const tight = truncateContent([{ type: 'text', text: 'y'.repeat(50) }], 8)
  assert.ok(Buffer.byteLength(tight[0].text, 'utf8') <= 8)

  assert.deepEqual(truncateContent([{ type: 'text', text: 'short' }], 0), [{ type: 'text', text: 'short' }])
  assert.deepEqual(resultToMcp({ isError: false, content: [], value: { a: 1 } }, 1000), [{ type: 'text', text: '{\n  "a": 1\n}' }])
  assert.deepEqual(resultToMcp({ isError: true, content: [] }, 1000), [{ type: 'text', text: 'Error' }])
  assert.match(resultToMcp({ content: [{ type: 'image', attachment: { id: 'img_1' } }] }, 1000)[0].text, /img_1/)
})

test('transport selection follows the agent handshake', () => {
  const config = makeConfig()
  assert.equal(chooseTransport(config, { capabilities: { mcpCapabilities: { http: true } } }), 'http')
  assert.equal(chooseTransport(config, { capabilities: { mcpCapabilities: { http: false } } }), 'stdio')
  assert.equal(chooseTransport(config, { capabilities: {} }), 'stdio')
  const stdioOnly = makeConfig({ mcp: { transport: 'stdio' } })
  assert.equal(chooseTransport(stdioOnly, { capabilities: { mcpCapabilities: { http: true } } }), 'stdio')
  const httpOnly = makeConfig({ mcp: { transport: 'http' } })
  assert.equal(chooseTransport(httpOnly, { capabilities: {} }), 'http')
})

test('the HTTP gateway authenticates by capability token only', async (t) => {
  const gateway = new McpGateway({ log: undefined })
  t.after(() => gateway.dispose())
  const { surface } = makeServer()
  const endpoint = gateway.endpointFor({
    surface,
    serverInfo: { name: 'dsh-fake', version: '0.2.0' },
    context: { agent: undefined, cwd: process.cwd() },
  })
  await gateway.start()
  const url = `${gateway.origin}${endpoint.path}`
  assert.match(gateway.origin, /^http:\/\/127\.0\.0\.1:\d+$/)

  const post = (body, headers = {}, target = url) => fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

  // No token, wrong token, and an unknown endpoint are all refused.
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).status, 401)
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { authorization: 'Bearer nope' })).status, 401)
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, {}, `${gateway.origin}/mcp/unknown`)).status, 404)

  const authorized = await post(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { authorization: `Bearer ${endpoint.token}` },
  )
  assert.equal(authorized.status, 200)
  const body = await authorized.json()
  assert.equal(body.result.serverInfo.name, 'dsh-fake')

  // A notification-only batch is acknowledged with 202 and no body.
  const notification = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { authorization: `Bearer ${endpoint.token}` })
  assert.equal(notification.status, 202)
  assert.equal(await notification.text(), '')

  const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { authorization: `Bearer ${endpoint.token}` })
  assert.equal((await listed.json()).result.tools.length, 3)

  // GET carries no server-initiated stream in this implementation.
  const get = await fetch(url, { headers: { authorization: `Bearer ${endpoint.token}` } })
  assert.equal(get.status, 405)

  // Withdrawing the endpoint invalidates the token immediately.
  endpoint.release()
  assert.equal((await post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { authorization: `Bearer ${endpoint.token}` })).status, 404)
})

test('the stdio shim relays to the gateway and answers on stdout', async (t) => {
  const gateway = new McpGateway({ log: undefined })
  t.after(() => gateway.dispose())
  const { surface } = makeServer()
  const endpoint = gateway.endpointFor({
    surface,
    serverInfo: { name: 'dsh-fake', version: '0.2.0' },
    context: { agent: undefined, cwd: process.cwd() },
  })
  await gateway.start()

  const child = spawn(process.execPath, [SHIM], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DSH_ACP_MCP_URL: `${gateway.origin}${endpoint.path}`,
      DSH_ACP_MCP_TOKEN: endpoint.token,
    },
  })
  t.after(() => child.kill())

  const lines = []
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, index)))
      buffer = buffer.slice(index + 1)
    }
  })
  const waitFor = async (count) => {
    const deadline = Date.now() + 5_000
    while (lines.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
    return lines
  }

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bash', arguments: { command: 'ls' } } })}\n`)
  const replies = await waitFor(2)
  assert.equal(replies.length, 2, 'notifications must not produce a reply')
  assert.equal(replies[0].result.serverInfo.name, 'dsh-fake')
  assert.deepEqual(replies[1].result.content, [{ type: 'text', text: 'ran ls' }])
})

test('MCP injection can be disabled per agent', async () => {
  const config = makeConfig({ mcp: { enabled: false } })
  const { createMcpBridge } = await import('../lib/mcp-bridge.js')
  const gateway = new McpGateway({ log: undefined })
  try {
    const bridge = createMcpBridge({ ctx: stubCtx(), gateway, log: undefined })
    const result = await bridge.forSession(config, { capabilities: {} }, { agent: undefined, cwd: process.cwd() })
    assert.deepEqual(result.servers, [])
    // Nothing was bound, so no listener was even started.
    assert.equal(gateway.port, undefined)
  } finally {
    await gateway.dispose()
  }
})
