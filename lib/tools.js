// Model-facing lifecycle and diagnostics tools.
//
// ACP agents fail in ways a stack trace does not explain: the handshake can
// succeed while every prompt stalls, and the agent's own stdout is where the
// real reason lives. These tools therefore return stable, compact JSON, and
// `acp_logs` is the only supported way to read the agent's raw traffic.

const renderJSON = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

function summarize(agent) {
  const snapshot = agent.snapshot()
  const uptimeMs = snapshot.startedAt === undefined ? 0 : Date.now() - Date.parse(snapshot.startedAt)
  return {
    id: snapshot.id,
    state: snapshot.state,
    running: snapshot.running,
    route: snapshot.route,
    ...(snapshot.pid === undefined ? {} : { pid: snapshot.pid }),
    ...(uptimeMs > 0 ? { uptimeMs } : {}),
    restarts: snapshot.restarts,
    activeSessions: snapshot.activeSessions,
    ...(snapshot.lastError === undefined ? {} : { lastError: snapshot.lastError }),
    ...(snapshot.providerError === undefined ? {} : { providerError: snapshot.providerError }),
    ...(snapshot.lastExit === undefined ? {} : {
      lastExit: `code=${snapshot.lastExit.code ?? 'null'} signal=${snapshot.lastExit.signal ?? 'null'} at=${snapshot.lastExit.at}`,
    }),
    agent: {
      name: snapshot.agentInfo?.name ?? snapshot.command,
      ...(snapshot.agentInfo?.version === undefined ? {} : { version: snapshot.agentInfo.version }),
      protocolVersion: snapshot.protocolVersion,
    },
    ...(snapshot.authMethods.length === 0 ? {} : {
      authMethods: snapshot.authMethods.map((method) => ({
        id: method.id,
        ...(method.name === undefined ? {} : { name: method.name }),
        ...(method.description === undefined ? {} : { description: method.description }),
      })),
    }),
    capabilities: {
      loadSession: snapshot.capabilities?.loadSession === true,
      prompt: snapshot.capabilities?.promptCapabilities ?? {},
      mcp: snapshot.capabilities?.mcpCapabilities ?? {},
      session: snapshot.capabilities?.sessionCapabilities ?? {},
    },
    ...(agent.config?.logs?.file === undefined ? {} : { logFile: agent.config.logs.file }),
  }
}

const statusSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['agents'],
  properties: {
    agents: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'state', 'running', 'route'],
        properties: {
          id: { type: 'string' },
          state: { type: 'string' },
          running: { type: 'boolean' },
          route: { type: 'string' },
          pid: { type: 'number' },
          uptimeMs: { type: 'number' },
          restarts: { type: 'number' },
          activeSessions: { type: 'number' },
          lastError: { type: 'string' },
          providerError: { type: 'string' },
          lastExit: { type: 'string' },
          agent: {
            type: 'object',
            additionalProperties: false,
            required: ['name'],
            properties: {
              name: { type: 'string' },
              version: { type: 'string' },
              protocolVersion: { type: 'number' },
            },
          },
          authMethods: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id'],
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
          capabilities: { type: 'object', additionalProperties: true },
          logFile: { type: 'string' },
        },
      },
    },
  },
}

export function registerAcpTools(ctx, manager) {
  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'acp_status',
    description: 'List ACP agents bridged by the dsh-acp plugin: lifecycle state, PID, restart count, protocol version, agent capabilities, auth methods, live ACP session count, and last error. Use this before controlling an agent or when an ACP-backed model route fails.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: statusSchema, render: renderJSON },
    async execute() {
      return { agents: manager.agents.map((agent) => summarize(agent)) }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'acp_control',
    description: 'Start, stop, or restart one bridged ACP agent process. The plugin already auto-starts agents and restarts crashes with backoff; use this for deliberate maintenance, or to recover an agent whose restart budget is exhausted. Returns the resulting status.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'action'],
      properties: {
        id: { type: 'string', description: 'Agent id from acp_status.' },
        action: { type: 'string', enum: ['start', 'stop', 'restart'], description: 'Lifecycle action to perform.' },
      },
    },
    output: { schema: statusSchema.properties.agents.items, render: renderJSON },
    async execute(args) {
      const agent = manager.require(args.id)
      if (args.action === 'start') await agent.start()
      else if (args.action === 'stop') await agent.stop()
      else await agent.restart()
      return summarize(agent)
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'acp_logs',
    description: 'Read the bounded, redacted log of one ACP agent: JSON-RPC frames in both directions, stderr, and protocol traces. Use this to diagnose a failed handshake, a stalled turn, an unsupported session config option, or a permission decision.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Agent id from acp_status.' },
        limit: { type: 'number', description: 'Maximum lines to return, 1-500. Defaults to 120.' },
        stream: { type: 'string', enum: ['in', 'out', 'stderr', 'stdout', 'trace'], description: 'Only return one stream. Omit for all.' },
        text: { type: 'string', description: 'Only return entries containing this substring (case-insensitive).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'lines', 'returned'],
        properties: {
          id: { type: 'string' },
          returned: { type: 'number' },
          lines: { type: 'array', items: { type: 'string' } },
        },
      },
      render: renderJSON,
    },
    async execute(args) {
      const agent = manager.require(args.id)
      const limit = Math.max(1, Math.min(500, Number.isInteger(args.limit) ? args.limit : 120))
      let lines = agent.logs.lines({ limit: Math.max(limit, 200), ...(args.stream === undefined ? {} : { stream: args.stream }) })
      if (typeof args.text === 'string' && args.text !== '') {
        const needle = args.text.toLowerCase()
        lines = lines.filter((line) => line.toLowerCase().includes(needle))
      }
      const selected = lines.slice(-limit)
      return { id: agent.id, returned: selected.length, lines: selected }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'acp_selftest',
    description: 'Run one real ACP turn through a bridged agent and return the assembled text, thought text, stop reason, usage and latency. Use this to prove the agent, its credentials, the ACP handshake and the model route all work end to end.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Agent id. Defaults to the only configured agent.' },
        model: { type: 'string', description: 'Model id to select for the probe turn. Defaults to the configured default.' },
        prompt: { type: 'string', description: 'Prompt for the probe. Defaults to a short connectivity check.' },
        timeoutMs: { type: 'number', description: 'Probe timeout in milliseconds, 1000-600000. Defaults to 120000.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'id', 'model', 'text', 'finish', 'elapsedMs'],
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          route: { type: 'string' },
          model: { type: 'string' },
          text: { type: 'string' },
          reasoning: { type: 'string' },
          finish: { type: 'string' },
          usage: { type: 'string' },
          elapsedMs: { type: 'number' },
        },
      },
      render: renderJSON,
    },
    async execute(args, exec) {
      const agent = manager.require(args.id)
      const route = agent.config.provider.route
      if (typeof ctx.llm?.stream !== 'function') throw new Error('the llm service is not available')

      // A discovered catalog is empty at config time, so fall back to what the
      // agent reports before deciding there is nothing to test.
      let model = args.model ?? agent.config.provider.defaultModel ?? agent.config.provider.models[0]?.id
      if (model === undefined && agent.config.provider.discoverModels) {
        const discovered = await agent.listModels().catch(() => [])
        model = discovered[0]?.id
      }
      if (model === undefined) {
        throw new Error('acp_selftest needs a model: configure provider.models/defaultModel or pass model')
      }

      const timeoutMs = Math.max(1_000, Math.min(600_000, args.timeoutMs ?? 120_000))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error(`acp selftest timed out after ${timeoutMs}ms`)), timeoutMs)
      const onAbort = () => controller.abort(exec?.signal?.reason ?? new Error('acp selftest cancelled'))
      if (exec?.signal?.aborted) onAbort()
      else exec?.signal?.addEventListener('abort', onAbort, { once: true })

      const started = Date.now()
      let text = ''
      let reasoning = ''
      let finish = 'none'
      let usage
      try {
        for await (const chunk of ctx.llm.stream({
          provider: route,
          model,
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: args.prompt ?? 'Reply with exactly: acp ok' }],
          }],
          signal: controller.signal,
        })) {
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
          else if (chunk.type === 'usage') usage = chunk.usage
          else if (chunk.type === 'finish') {
            finish = chunk.reason?.kind ?? 'unknown'
            if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
              const failure = chunk.reason.failure
              throw new Error(`${chunk.reason.kind}: ${failure?.message ?? 'ACP turn failed'} (${failure?.code ?? 'UNKNOWN'})`)
            }
          }
        }
      } finally {
        clearTimeout(timer)
        exec?.signal?.removeEventListener('abort', onAbort)
      }
      return {
        ok: finish === 'stop' || finish === 'max-tokens',
        id: agent.id,
        route,
        model,
        text,
        ...(reasoning === '' ? {} : { reasoning }),
        finish,
        ...(usage === undefined ? {} : { usage: JSON.stringify(usage) }),
        elapsedMs: Date.now() - started,
      }
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
  }
}
