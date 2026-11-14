// A scriptable ACP agent used by the test suite.
//
// It implements just enough of the protocol to exercise the bridge: the
// handshake (including advertised capabilities), sessions with model/effort/mode
// config options, streaming updates in the order real agents emit them, a
// permission request, and the `cancelled` stop reason. Behaviour is selected by
// `FAKE_ACP_MODE` so each test can ask for exactly the failure it cares about.

import readline from 'node:readline'

const MODE = process.env.FAKE_ACP_MODE ?? 'normal'
const MODEL_ID = process.env.FAKE_ACP_MODEL ?? 'fake/model-one'
const TEXT = process.env.FAKE_ACP_TEXT ?? 'pong from the fake agent'
const THOUGHT = process.env.FAKE_ACP_THOUGHT ?? 'thinking about the ping'

let nextRequestId = 1000
const sessions = new Map()
const pendingPermissions = new Map()

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

function update(sessionId, payload) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: payload } })
}

/** Ask the client for permission and resolve with its chosen outcome. */
function requestPermission(sessionId, toolCall, options) {
  const id = nextRequestId++
  return new Promise((resolve) => {
    pendingPermissions.set(id, resolve)
    send({
      jsonrpc: '2.0',
      id,
      method: 'session/request_permission',
      params: { sessionId, toolCall, options },
    })
  })
}

async function handlePrompt(id, params) {
  const session = sessions.get(params.sessionId)
  if (session === undefined) {
    fail(id, -32602, `Invalid params: session not found: ${params.sessionId}`)
    return
  }
  const promptText = (params.prompt ?? []).map((block) => block.text ?? '').join('\n')
  session.turns += 1
  session.lastPrompt = promptText

  if (MODE === 'fail-prompt' || MODE === 'error') {
    fail(id, -32000, MODE === 'error' ? 'the fake agent crashed mid-turn' : 'the fake agent cannot answer')
    return
  }

  update(params.sessionId, {
    sessionUpdate: 'available_commands_update',
    availableCommands: [{ name: 'init', description: 'Initialise the project' }],
  })

  if (MODE === 'permission') {
    const decision = await requestPermission(params.sessionId, {
      toolCallId: 'call_1',
      title: 'Write report.txt',
      kind: 'edit',
      status: 'pending',
    }, [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ])
    update(params.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: decision?.outcome?.optionId === 'allow-once' ? 'completed' : 'failed',
    })
  }

  if (MODE === 'tool') {
    update(params.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_2',
      title: 'Read package.json',
      kind: 'read',
      status: 'pending',
      locations: [{ path: 'package.json' }],
    })
    update(params.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_2',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '{"name":"demo"}' } }],
    })
  }

  if (MODE !== 'no-thought' && MODE !== 'slow') {
    update(params.sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: THOUGHT },
    })
  }

  if (MODE === 'slow') {
    // Emit a first chunk immediately, then hold: the test aborts mid-turn.
    update(params.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg_slow',
      content: { type: 'text', text: 'working' },
    })
    await new Promise((resolve) => {
      session.cancel = () => resolve()
      setTimeout(resolve, 15_000).unref?.()
    })
    update(params.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg_slow',
      content: { type: 'text', text: ' interrupted' },
    })
    reply(id, { stopReason: 'cancelled' })
    return
  }
  // Split the answer so the bridge must coalesce multiple chunks per block.
  const half = Math.ceil(TEXT.length / 2)
  for (const part of [TEXT.slice(0, half), TEXT.slice(half)]) {
    if (part === '') continue
    update(params.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg_1',
      content: { type: 'text', text: part },
    })
  }
  update(params.sessionId, {
    sessionUpdate: 'usage_update',
    used: 1234,
    size: 200_000,
    cost: { amount: 0.0004, currency: 'USD' },
  })

  reply(id, {
    stopReason: MODE === 'max-tokens' ? 'max_tokens' : 'end_turn',
    usage: {
      inputTokens: 1_200,
      outputTokens: 42,
      totalTokens: 1_262,
      thoughtTokens: 9,
      cachedReadTokens: 200,
    },
  })
}

const rl = readline.createInterface({ input: process.stdin })

rl.on('line', (line) => {
  if (line.trim() === '') return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  // Responses to our own permission requests.
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pendingPermissions.get(message.id)
    if (resolve !== undefined) {
      pendingPermissions.delete(message.id)
      resolve(message.result ?? message.error)
    }
    return
  }
  const { id, method, params } = message
  switch (method) {
    case 'initialize': {
      if (MODE === 'no-handshake') return
      if (MODE === 'handshake-error') {
        fail(id, -32603, 'the fake agent refuses the handshake')
        return
      }
      reply(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: false },
          sessionCapabilities: { close: true, list: true },
        },
        agentInfo: { name: 'Fake Agent', version: '9.9.9' },
        authMethods: [{ id: 'fake-login', name: 'Login with fake', description: 'Not needed' }],
      })
      return
    }
    case 'session/new': {
      const sessionId = `ses_fake_${sessions.size + 1}`
      sessions.set(sessionId, { id: sessionId, cwd: params?.cwd, turns: 0, cancel: undefined })
      reply(id, {
        sessionId,
        configOptions: [
          {
            id: 'model',
            category: 'model',
            type: 'select',
            currentValue: MODEL_ID,
            options: [
              { value: MODEL_ID, name: 'Fake Model One' },
              { value: 'fake/model-two', name: 'Fake Model Two' },
            ],
          },
          {
            id: 'effort',
            category: 'thought_level',
            type: 'select',
            current: 'default',
            options: [{ value: 'default', name: 'Default' }, { value: 'high', name: 'High' }],
          },
          {
            id: 'mode',
            category: 'mode',
            type: 'select',
            current: 'build',
            options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }],
          },
        ],
        modes: { currentModeId: 'build', availableModes: [] },
      })
      return
    }
    case 'session/set_config_option': {
      const session = sessions.get(params?.sessionId)
      if (session === undefined) {
        fail(id, -32602, `Invalid params: session not found: ${params?.sessionId}`)
        return
      }
      session.config = { ...(session.config ?? {}), [params.configId]: params.value }
      reply(id, {
        configOptions: [{
          id: params.configId,
          category: params.configId === 'model' ? 'model' : 'select',
          type: 'select',
          currentValue: params.value,
          options: [{ value: params.value, name: params.value }],
        }],
      })
      return
    }
    case 'session/prompt': {
      void handlePrompt(id, params)
      return
    }
    case 'session/cancel': {
      const session = sessions.get(params?.sessionId)
      session?.cancel?.()
      return
    }
    case 'session/close': {
      sessions.delete(params?.sessionId)
      reply(id, {})
      return
    }
    default:
      fail(id, -32601, `method not found: ${method}`)
  }
})

rl.on('close', () => {
  process.exit(0)
})
