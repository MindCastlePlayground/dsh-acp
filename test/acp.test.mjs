// End-to-end tests for the ACP bridge against a scripted ACP agent.
//
// The fake agent is a real child process speaking real newline-delimited
// JSON-RPC, so these tests cover the parts a unit test cannot: spawn quoting,
// the handshake, notification interleaving, cancellation, restart, and the
// adapter's chunk protocol as DSH's assembler would see it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeConfig, AcpConfigError } from '../lib/config.js'
import { AcpAgent } from '../lib/agent.js'
import { createAcpAdapter, mapStopReason, mapUsage, decidePermission, contentText } from '../lib/adapter.js'
import { planPrompt, renderTranscript, projectCall } from '../lib/transcript.js'
import { McpGateway } from '../lib/mcp-gateway.js'
import { createMcpBridge } from '../lib/mcp-bridge.js'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const fakeAgent = path.join(testDir, 'fake-agent.mjs')

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

function makeCtx() {
  return { logger: silentLogger, emit() {}, get() { return undefined } }
}

function makeConfig(overrides = {}) {
  return normalizeConfig({
    agents: {
      fake: {
        command: process.execPath,
        args: [fakeAgent],
        autoStart: false,
        restart: { maxRestarts: 1, initialDelayMs: 10, maxDelayMs: 20 },
        logs: { maxLines: 200 },
        provider: {
          route: 'acp-fake',
          models: [{ id: 'fake/model-one', name: 'Fake One', contextWindow: 100_000, maxTokens: 4_096 }],
        },
        ...overrides,
      },
    },
  })
}

function userTurn(text) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

/** Run one stream and collect chunks, returning them with the terminal reason. */
async function collect(stream) {
  const chunks = []
  let finish
  for await (const chunk of stream) {
    chunks.push(chunk)
    if (chunk.type === 'finish') finish = chunk.reason
  }
  return { chunks, finish }
}

/** Concatenate chunks the way DSH's assembler would. */
function assemble(chunks) {
  const blocks = new Map()
  let usage
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') blocks.set(chunk.index, { type: chunk.blockType, text: '' })
    else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      const block = blocks.get(chunk.index)
      assert.ok(block, `delta for unopened block ${chunk.index}`)
      block.text += chunk.text
    } else if (chunk.type === 'block-end') {
      const block = blocks.get(chunk.index)
      assert.ok(block, `block-end for unopened block ${chunk.index}`)
      assert.equal(block.text, chunk.block.text, 'block-end text must match accumulated deltas')
    } else if (chunk.type === 'usage') usage = chunk.usage
  }
  return {
    blocks: [...blocks.entries()].sort((left, right) => left[0] - right[0]).map(([, block]) => block),
    usage,
  }
}

async function withAgent(t, config, body) {
  const agent = new AcpAgent({ config: config.agents[0], ctx: makeCtx(), resolveCwd: () => process.cwd() })
  t.after(async () => {
    await agent.dispose()
  })
  await body(agent)
}

test('configuration rejects malformed agent rows', () => {
  assert.throws(() => normalizeConfig({ agents: { bad: { command: '' } } }), AcpConfigError)
  assert.throws(() => normalizeConfig({ agents: { bad: { command: 'x', provider: { route: 'r' }, shell: 'sometimes' } } }), AcpConfigError)
  assert.throws(() => normalizeConfig({ agents: 'not-an-agent' }), /must be an object keyed by agent id/)
  assert.equal(normalizeConfig({ agents: [] }).agents.length, 0, 'an empty list simply leaves the plugin dormant')
  const config = normalizeConfig({ agents: [{ id: 'a', command: 'x' }] })
  assert.equal(config.agents[0].args.length, 1)
  assert.equal(config.agents[0].args[0], 'acp', 'a bare agent row defaults to the ACP subcommand')
  assert.equal(config.agents[0].provider.route, 'acp-a')
})

test('configuration expands ${env:} and refuses duplicate routes', () => {
  process.env.DSH_ACP_TEST_TOKEN = 'token-value'
  const config = normalizeConfig({
    agents: {
      one: { command: 'x', env: { TOKEN: '${env:DSH_ACP_TEST_TOKEN}', EMPTY: '${env:DSH_ACP_MISSING}' } },
    },
  })
  assert.equal(config.agents[0].env.TOKEN, 'token-value')
  assert.equal(config.agents[0].env.EMPTY, '')
  assert.throws(() => normalizeConfig({
    agents: {
      one: { command: 'x', provider: { route: 'same' } },
      two: { command: 'x', provider: { route: 'same' } },
    },
  }), /duplicate provider route/)
  delete process.env.DSH_ACP_TEST_TOKEN
})

test('handshake exposes agent info, capabilities and discovered models', async (t) => {
  const config = makeConfig()
  config.agents[0].provider.models = []
  config.agents[0].provider.discoverModels = true
  await withAgent(t, config, async (agent) => {
    const snapshot = await agent.start()
    assert.equal(snapshot.state, 'running')
    assert.equal(snapshot.agentInfo.name, 'Fake Agent')
    assert.equal(snapshot.capabilities.sessionCapabilities.close, true)
    const models = await agent.listModels()
    assert.deepEqual(models.map((model) => model.id), ['fake/model-one', 'fake/model-two'])
    assert.equal(models[1].name, 'Fake Model Two')
  })
})

test('a turn streams reasoning and text blocks with usage, then finishes', async (t) => {
  const config = makeConfig()
  await withAgent(t, config, async (agent) => {
    const adapter = createAcpAdapter({ agent, config: config.agents[0], log: agent.logs })
    const { chunks, finish } = await collect(adapter.stream({
      provider: 'acp-fake',
      model: 'fake/model-one',
      messages: [userTurn('ping')],
      signal: new AbortController().signal,
    }))
    const { blocks, usage } = assemble(chunks)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0].type, 'reasoning')
    assert.match(blocks[0].text, /thinking about the ping/)
    assert.equal(blocks[1].type, 'text')
    assert.equal(blocks[1].text, 'pong from the fake agent')
    assert.deepEqual(finish, { kind: 'stop' })
    // ACP folds cache reads into inputTokens; DSH needs them disjoint.
    assert.deepEqual(usage, {
      inputTokens: 1_000,
      outputTokens: 42,
      totalTokens: 1_262,
      cacheReadTokens: 200,
      reasoningTokens: 9,
    })
    await adapter.release()
  })
})

test('a second call on the same DSH session reuses the ACP session and sends only the new turn', async (t) => {
  const config = makeConfig()
  await withAgent(t, config, async (agent) => {
    const adapter = createAcpAdapter({ agent, config: config.agents[0], log: agent.logs })
    const first = await collect(adapter.stream({
      provider: 'acp-fake',
      model: 'fake/model-one',
      sessionId: 'dsh-session-1',
      messages: [userTurn('ping')],
    }))
    assert.deepEqual(first.finish, { kind: 'stop' })
    assert.equal(adapter.poolSize(), 1)
    assert.match(agent.logs.text({ limit: 200 }), /"mode":"fresh"/)

    const second = await collect(adapter.stream({
      provider: 'acp-fake',
      model: 'fake/model-one',
      sessionId: 'dsh-session-1',
      messages: [
        userTurn('ping'),
        { role: 'assistant', content: [{ type: 'text', text: 'pong from the fake agent' }] },
        userTurn('ping again'),
      ],
    }))
    assert.deepEqual(second.finish, { kind: 'stop' })
    assert.equal(adapter.poolSize(), 1, 'a continued conversation keeps the same ACP session')
    assert.match(agent.logs.text({ limit: 20 }), /"mode":"delta"/, 'the follow-up sent only the new turn')

    // A rewritten history cannot extend the agent's transcript, so the old
    // session is retired and a new one is created.
    const rewritten = await collect(adapter.stream({
      provider: 'acp-fake',
      model: 'fake/model-one',
      sessionId: 'dsh-session-1',
      messages: [userTurn('a completely different question')],
    }))
    assert.deepEqual(rewritten.finish, { kind: 'stop' })
    assert.match(agent.logs.text({ limit: 20 }), /"mode":"fresh"/)
    const text = assemble(rewritten.chunks).blocks.map((block) => block.text).join('\n')
    assert.match(text, /pong from the fake agent/)
    await adapter.release()
  })
})

test('cancellation produces an aborted finish, not a silent stop', async (t) => {
  const config = makeConfig({ env: { FAKE_ACP_MODE: 'slow' }, turnTimeoutMs: 30_000 })
  await withAgent(t, config, async (agent) => {
    const adapter = createAcpAdapter({ agent, config: config.agents[0], log: agent.logs })
    const controller = new AbortController()
    const chunks = []
    let finish
    for await (const chunk of adapter.stream({
      provider: 'acp-fake',
      model: 'fake/model-one',
      messages: [userTurn('ping')],
      signal: controller.signal,
    })) {
      chunks.push(chunk)
      if (chunk.type === 'finish') finish = chunk.reason
      if (chunk.type === 'text-delta') controller.abort(new Error('user cancelled'))
    }
    assert.equal(finish.kind, 'aborted')
    const { blocks } = assemble(chunks)
    assert.equal(blocks[0].text, 'working interrupted')
    await adapter.release()
  })
})

test('a JSON-RPC error on the prompt becomes an error finish with the agent code', async (t) => {
  const config = makeConfig({ env: { FAKE_ACP_MODE: 'error' } })
  await withAgent(t, config, async (agent) => {
    const adapter = createAcpAdapter({ agent, config: config.agents[0], log: agent.logs })
    const { chunks, finish } = await collect(adapter.stream({
      provider: 'acp-fake',
      model: 'fake/model-one',
      messages: [userTurn('ping')],
    }))
    assert.equal(finish.kind, 'error')
    assert.match(finish.failure.message, /crashed mid-turn/)
    assert.deepEqual(assemble(chunks).blocks, [], 'no blocks survive a failed turn')
    await adapter.release()
  })
})

test('a refused handshake surfaces as an activation error and stops the process', async (t) => {
  const config = makeConfig({ env: { FAKE_ACP_MODE: 'handshake-error' } })
  await withAgent(t, config, async (agent) => {
    await assert.rejects(() => agent.start(), /refuses the handshake/)
    assert.equal(agent.running, false)
    assert.equal(agent.snapshot().state, 'failed')
  })
})

test('stop terminates the agent and a restart boots a new process', async (t) => {
  const config = makeConfig()
  await withAgent(t, config, async (agent) => {
    const first = await agent.start()
    assert.ok(first.pid > 0)
    await agent.stop()
    assert.equal(agent.running, false)
    const second = await agent.restart()
    assert.ok(second.pid > 0)
    assert.notEqual(second.pid, first.pid)
  })
})

test('tool activity is logged but stays out of the answer unless enabled', async (t) => {
  const config = makeConfig({ env: { FAKE_ACP_MODE: 'tool' } })
  await withAgent(t, config, async (agent) => {
    const adapter = createAcpAdapter({ agent, config: config.agents[0], log: agent.logs })
    const { chunks } = await collect(adapter.stream({
      provider: 'acp-fake',
      model: 'fake/model-one',
      messages: [userTurn('read the package.json')],
    }))
    const text = assemble(chunks).blocks.map((block) => block.text).join('')
    assert.doesNotMatch(text, /\[tool Read package\.json/)
    assert.match(agent.logs.text({ limit: 200 }), /tool activity/)
    await adapter.release()
  })
})

test('permission policy grants on allow and refuses on deny', async (t) => {
  const allowConfig = makeConfig({ env: { FAKE_ACP_MODE: 'permission' } })
  await withAgent(t, allowConfig, async (agent) => {
    const adapter = createAcpAdapter({ agent, config: allowConfig.agents[0], log: agent.logs })
    const { finish } = await collect(adapter.stream({
      provider: 'acp-fake',
      model: 'fake/model-one',
      messages: [userTurn('write the report')],
    }))
    assert.deepEqual(finish, { kind: 'stop' })
    assert.match(agent.logs.text({ limit: 200 }), /permission decision/)
    await adapter.release()
  })

  const denyConfig = makeConfig({
    env: { FAKE_ACP_MODE: 'permission' },
    permission: { policy: 'deny', allowReadOnly: true },
  })
  await withAgent(t, denyConfig, async (agent) => {
    const adapter = createAcpAdapter({ agent, config: denyConfig.agents[0], log: agent.logs })
    const { finish } = await collect(adapter.stream({
      provider: 'acp-fake',
      model: 'fake/model-one',
      messages: [userTurn('write the report')],
    }))
    assert.deepEqual(finish, { kind: 'stop' })
    assert.match(agent.logs.text({ limit: 200 }), /permission decision/)
    await adapter.release()
  })
})

test('the adapter publishes the full duck-typed surface DSH validates', async (t) => {
  const config = makeConfig()
  await withAgent(t, config, async (agent) => {
    const adapter = createAcpAdapter({ agent, config: config.agents[0], log: agent.logs })
    for (const method of ['providerInfo', 'providerRetryPolicy', 'imageRequestPricing', 'imageRequestTarget', 'listModels', 'resolveModel', 'prepareCall', 'stream']) {
      assert.equal(typeof adapter[method], 'function', `adapter.${method} must exist`)
    }
    assert.equal(adapter.providerRetryPolicy('acp-fake'), undefined)
    assert.equal(adapter.imageRequestPricing('acp-fake', 'fake/model-one'), undefined)
    assert.deepEqual(
      adapter.imageRequestTarget('acp-fake', 'fake/model-one', { width: 4, height: 5, bytes: 6 }),
      { width: 4, height: 5, maxBytes: 6 },
    )
    await agent.start()
    // DSH requires the catalog to name its own provider and keep ids unique.
    const models = await adapter.listModels('acp-fake')
    assert.ok(models.length > 0)
    for (const model of models) {
      assert.equal(model.provider, 'acp-fake')
      assert.equal(typeof model.name, 'string')
    }
    assert.equal(new Set(models.map((model) => model.id)).size, models.length)
    const info = await adapter.resolveModel('acp-fake', 'fake/model-one')
    assert.equal(info.provider, 'acp-fake')
    assert.equal(info.id, 'fake/model-one')
    assert.equal(info.context.contextWindow, 100_000)
    assert.equal(info.defaultMaxTokens, 4_096)
    await adapter.release()
  })
})

test('stop reasons and usage map onto the DSH vocabulary', () => {
  assert.deepEqual(mapStopReason('end_turn'), { kind: 'stop' })
  assert.deepEqual(mapStopReason('max_tokens'), { kind: 'max-tokens' })
  assert.deepEqual(mapStopReason('cancelled'), { kind: 'aborted' })
  assert.deepEqual(mapStopReason('refusal'), { kind: 'stop', refusal: true })
  assert.deepEqual(mapStopReason('something_new'), { kind: 'stop' })
  assert.equal(mapUsage(undefined), undefined)
  assert.equal(mapUsage({}), undefined)
  assert.deepEqual(mapUsage({ inputTokens: 10, outputTokens: 2 }), {
    inputTokens: 10, outputTokens: 2, totalTokens: 12,
  })
})

test('transcript planning chooses delta or fresh from the recorded prefix', () => {
  const call1 = {
    messages: [userTurn('one')],
  }
  const plan1 = planPrompt(call1, undefined)
  assert.equal(plan1.mode, 'fresh')
  assert.match(plan1.prompt, /## User\n\none/)

  const sent = {
    system: '',
    segments: [...plan1.projection.segments, { index: -1, role: 'assistant', text: 'answer one' }],
  }
  const call2 = {
    messages: [
      userTurn('one'),
      { role: 'assistant', content: [{ type: 'text', text: 'answer one' }] },
      userTurn('two'),
    ],
  }
  const plan2 = planPrompt(call2, sent)
  assert.equal(plan2.mode, 'delta')
  assert.equal(plan2.prompt, 'two')

  const edited = { messages: [userTurn('one edited')] }
  assert.equal(planPrompt(edited, sent).mode, 'fresh')

  const changedSystem = { system: 'new persona', messages: call2.messages }
  assert.equal(planPrompt(changedSystem, sent).mode, 'fresh')
})

test('transcript rendering keeps the newest turns and marks trimmed history', () => {
  const segments = [
    { index: 0, role: 'user', text: 'a'.repeat(400) },
    { index: 1, role: 'user', text: 'b'.repeat(400) },
    { index: 2, role: 'assistant', text: 'c'.repeat(400) },
  ]
  const text = renderTranscript(segments, { maxChars: 900, system: 'be brief' })
  assert.match(text, /# System/)
  assert.match(text, /be brief/)
  assert.match(text, /\[earlier turn omitted to fit the prompt budget\]/)
  assert.match(text, /c{400}/, 'the newest turn survives intact')
})

test('projection flattens tool blocks and honours the tool-activity switch', () => {
  const options = {
    messages: [
      userTurn('hi'),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          { type: 'tool-call', id: 't1', name: 'read', arguments: '{"path":"a.txt"}' },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', content: 'file body' }] },
    ],
  }
  const withTools = projectCall(options)
  assert.equal(withTools.segments.length, 3)
  assert.match(withTools.segments[1].text, /tool call read/)
  const withoutTools = projectCall(options, { includeToolActivity: false })
  assert.equal(withoutTools.segments.length, 2)
  assert.equal(contentText([{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }]), 'xy')
  assert.equal(contentText({ type: 'content', content: { type: 'text', text: 'z' } }), 'z')
})

test('permission decisions fall back to cancelled when the agent offers no matching option', () => {
  const config = { permission: { policy: 'allow', allowReadOnly: true } }
  const decision = decidePermission(config, { toolCall: { kind: 'edit' }, options: [] }, { trace() {} })
  assert.deepEqual(decision, { outcome: { outcome: 'cancelled' } })
  const rejected = decidePermission(config, {
    toolCall: { kind: 'edit' },
    options: [{ optionId: 'no', kind: 'reject_once' }],
  }, { trace() {} })
  assert.deepEqual(rejected, { outcome: { outcome: 'selected', optionId: 'no' } })
})

// --- MCP injection over a real session -------------------------------------

/** A ctx whose services are the doubles a test cares about. */
function makeServiceCtx({ tools, skills, agents } = {}) {
  const services = { tools, skills, agents }
  return {
    logger: silentLogger,
    emit() {},
    get(key) { return services[key] },
  }
}

function stubToolsRegistry() {
  const calls = []
  return {
    calls,
    schemas: () => [
      { name: 'bash', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { name: 'acp_status', description: 'Bridge control.', parameters: { type: 'object', properties: {} } },
    ],
    async execute(exec) {
      calls.push(exec)
      return { isError: false, content: [{ type: 'text', text: `ran ${exec.arguments.command}` }], value: { code: 0 } }
    },
  }
}

test('an agent with no model picker still gets one routable model', async (t) => {
  const config = makeConfig({
    env: { FAKE_ACP_MODE: 'no-model-options' },
    provider: { route: 'acp-fake', discoverModels: true, models: [] },
  })
  await withAgent(t, config, async (agent) => {
    const models = await agent.listModels()
    assert.equal(models.length, 1)
    assert.equal(models[0].id, 'default')
    assert.match(models[0].name, /Fake/)
    // The synthetic id is never sent to an agent that has no options.
    const session = await agent.createSession()
    assert.deepEqual(session.configOptions, [])
    await agent.closeSession(session.sessionId)
  })
})

test('session/new carries an HTTP MCP descriptor when the agent advertises it', async (t) => {
  const config = makeConfig()
  const ctx = makeServiceCtx({ tools: stubToolsRegistry() })
  const gateway = new McpGateway({ log: undefined })
  t.after(() => gateway.dispose())
  const bridge = createMcpBridge({ ctx, gateway, log: undefined })
  await withAgent(t, config, async (agent) => {
    const adapter = createAcpAdapter({ agent, config: config.agents[0], log: agent.logs, ctx, mcpBridge: bridge })
    const { finish } = await collect(adapter.stream({
      provider: 'acp-fake',
      model: 'fake/model-one',
      sessionId: 'dsh-session-1',
      messages: [userTurn('ping')],
    }))
    assert.deepEqual(finish, { kind: 'stop' })

    const state = await agent.connection.request('debug/state')
    assert.equal(state.sessions.length, 1)
    const [server] = state.sessions[0].mcpServers
    assert.equal(server.name, 'dsh')
    assert.equal(server.type, 'http')
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]+$/)
    assert.equal(server.headers[0].name, 'Authorization')
    assert.match(server.headers[0].value, /^Bearer [0-9a-f]+$/)

    // The advertised endpoint really serves the owning agent's tools.
    const post = (body) => fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: server.headers[0].value },
      body: JSON.stringify(body),
    })
    const listed = await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['bash'])
    const called = await (await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'bash', arguments: { command: 'pwd' } },
    })).json()
    assert.deepEqual(called.result.content, [{ type: 'text', text: 'ran pwd' }])
    await adapter.release()
  })
})

test('a stdio-only agent gets the shim, and the token is the only credential', async (t) => {
  const config = makeConfig({
    env: { FAKE_ACP_MODE: 'stdio-mcp' },
    mcp: { transport: 'stdio' },
  })
  const tools = stubToolsRegistry()
  const ctx = makeServiceCtx({ tools })
  const gateway = new McpGateway({ log: undefined })
  t.after(() => gateway.dispose())
  const bridge = createMcpBridge({ ctx, gateway, log: undefined })
  await withAgent(t, config, async (agent) => {
    const adapter = createAcpAdapter({ agent, config: config.agents[0], log: agent.logs, ctx, mcpBridge: bridge })
    await collect(adapter.stream({
      provider: 'acp-fake',
      model: 'fake/model-one',
      sessionId: 'dsh-session-2',
      messages: [userTurn('ping')],
    }))
    const state = await agent.connection.request('debug/state')
    const [server] = state.sessions[0].mcpServers
    assert.equal(server.type, undefined, 'stdio descriptors carry no type field')
    assert.equal(server.command, process.execPath)
    assert.match(server.args[0], /mcp-stdio\.js$/)
    const env = Object.fromEntries(server.env.map((entry) => [entry.name, entry.value]))
    assert.match(env.DSH_ACP_MCP_URL, /^http:\/\/127\.0\.0\.1:\d+\/mcp\//)
    assert.match(env.DSH_ACP_MCP_TOKEN, /^[0-9a-f]+$/)

    // The URL alone is not enough: the token must accompany it.
    const bare = await fetch(env.DSH_ACP_MCP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(bare.status, 401)
    await adapter.release()
  })
})

test('a tool call from the agent runs under the owning DSH agent', async (t) => {
  const config = makeConfig()
  const tools = stubToolsRegistry()
  const dshAgent = { id: 'dsh-agent-stub' }
  const ctx = makeServiceCtx({ tools, agents: { get: (id) => (id === 'dsh-session-3' ? dshAgent : undefined) } })
  const gateway = new McpGateway({ log: undefined })
  t.after(() => gateway.dispose())
  const bridge = createMcpBridge({ ctx, gateway, log: undefined })
  await withAgent(t, config, async (agent) => {
    const adapter = createAcpAdapter({ agent, config: config.agents[0], log: agent.logs, ctx, mcpBridge: bridge })
    await collect(adapter.stream({
      provider: 'acp-fake',
      model: 'fake/model-one',
      sessionId: 'dsh-session-3',
      messages: [userTurn('ping')],
    }))
    const state = await agent.connection.request('debug/state')
    const [server] = state.sessions[0].mcpServers
    await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: server.headers[0].value },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bash', arguments: { command: 'ls' } } }),
    })
    assert.equal(tools.calls.length, 1)
    assert.equal(tools.calls[0].agent, dshAgent, 'the tool must see the session that owns the model call')
    await adapter.release()
  })
})

test('session options and authenticate are applied generically', async (t) => {
  const config = makeConfig({
    session: { options: { custom_option: 'custom-value' } },
    auth: { methodId: 'fake-login', auto: true },
  })
  await withAgent(t, config, async (agent) => {
    await agent.start()
    const state = await agent.connection.request('debug/state')
    assert.equal(state.authenticated, 'fake-login')
    const adapter = createAcpAdapter({ agent, config: config.agents[0], log: agent.logs })
    await collect(adapter.stream({
      provider: 'acp-fake',
      model: 'fake/model-one',
      sessionId: 'dsh-session-4',
      messages: [userTurn('ping')],
    }))
    const after = await agent.connection.request('debug/state')
    assert.equal(after.sessions[0].config.custom_option, 'custom-value')
    await adapter.release()
  })
})
