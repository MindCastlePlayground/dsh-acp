// DSH LlmAdapter over an ACP agent.
//
// The adapter is the only place where ACP's agent-owned conversation model meets
// DSH's provider-neutral chunk protocol. Two invariants keep that mapping honest:
//
//  1. Every stream ends in exactly one terminal `finish` chunk. ACP reports
//     cancellation and failure through a stop reason or a JSON-RPC error, and a
//     generator that simply returns would be read by DSH as a clean `stop`.
//  2. Blocks are opened lazily and closed in index order. ACP interleaves
//     thought chunks, message chunks and tool activity freely, so a reasoning
//     block closes as soon as prose starts, and a new one opens if the agent
//     thinks again later.

import { planPrompt } from './transcript.js'
import { AsyncQueue, QUEUE_END } from './queue.js'

/** Map an ACP `stopReason` onto DSH's finish vocabulary. */
export function mapStopReason(stopReason) {
  switch (stopReason) {
    case 'end_turn': return { kind: 'stop' }
    case 'max_tokens': return { kind: 'max-tokens' }
    case 'max_turn_requests': return { kind: 'max-tokens' }
    case 'refusal': return { kind: 'stop', refusal: true }
    case 'cancelled': return { kind: 'aborted' }
    default: return { kind: 'stop' }
  }
}

/**
 * Flatten an ACP error into one line, keeping the agent's own classification.
 *
 * ACP puts the machine-readable reason in `error.data` (`{service, errorName}`),
 * which would otherwise be dropped between the wire and the DSH failure.
 */
export function describeRpcError(error) {
  const message = String(error?.message ?? error)
  const data = error?.data
  if (data === null || typeof data !== 'object') return message
  const parts = []
  for (const key of ['errorName', 'service', 'code']) {
    const value = data[key]
    if (typeof value === 'string' && value !== '') parts.push(`${key}=${value}`)
  }
  return parts.length === 0 ? message : `${message} (${parts.join(', ')})`
}

/**
 * A refusal often carries its real reason in the agent's private `_meta`
 * instead of the message. Probe a short key list so a quota refusal does not
 * reach DSH as an ordinary empty answer.
 */
export function refusalFailure(meta) {
  if (meta === null || typeof meta !== 'object') return undefined
  const keys = ['code', 'errorName', 'error', 'reason', 'detail', 'message']
  const seen = new Set()
  const walk = (value, depth) => {
    if (value === null || typeof value !== 'object' || depth > 3 || seen.has(value)) return undefined
    seen.add(value)
    for (const key of keys) {
      const candidate = value[key]
      if (typeof candidate === 'string' && candidate !== '') return { key, text: candidate }
    }
    for (const nested of Object.values(value)) {
      const found = walk(nested, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  const found = walk(meta, 0)
  if (found === undefined) return undefined
  const quota = /quota|balance|rate.?limit|insufficient|credit/i.test(found.text)
  return {
    code: quota ? 'RATE_LIMITED' : 'REFUSED',
    message: `the ACP agent refused the turn (${found.key}: ${found.text})`,
  }
}

/** Normalize an ACP usage report onto DSH's disjoint token vocabulary. */
export function mapUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const num = (value) => (Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined)
  const cacheReadTokens = num(usage.cachedReadTokens ?? usage.cacheReadTokens)
  const rawInput = num(usage.inputTokens)
  const outputTokens = num(usage.outputTokens)
  const reasoningTokens = num(usage.thoughtTokens)
  const reportedTotal = num(usage.totalTokens)
  // ACP's inputTokens already folds cache reads in (opencode reports 14736
  // input alongside 14720 cached). DSH expects inputTokens to be uncached, so
  // subtract to keep input + cacheRead + output consistent.
  const inputTokens = rawInput === undefined
    ? undefined
    : cacheReadTokens === undefined ? rawInput : Math.max(0, rawInput - cacheReadTokens)
  const totalTokens = reportedTotal
    ?? (inputTokens === undefined && outputTokens === undefined
      ? undefined
      : (inputTokens ?? 0) + (outputTokens ?? 0) + (cacheReadTokens ?? 0))
  if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === undefined && totalTokens === undefined) {
    return undefined
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

/** Longest single block of agent-supplied text kept in a transcript segment. */
const MAX_CONTENT_CHARS = 16_000

// How long to wait for an agent to acknowledge `session/cancel` before giving up
// on the turn. A cancellation is a notification, so an agent that ignores it
// would otherwise hold the turn (and its session slot) until turnTimeoutMs.
const CANCEL_FALLBACK_MS = 15_000

function clip(text) {
  if (text.length <= MAX_CONTENT_CHARS) return text
  return `${text.slice(0, MAX_CONTENT_CHARS)}\n…[truncated ${text.length - MAX_CONTENT_CHARS} chars]`
}

/** A `diff` block, rendered the way a human reads a patch. */
function diffText(content) {
  const target = content.path ?? content.file ?? content.uri ?? '(unknown file)'
  const before = typeof content.oldText === 'string' ? content.oldText.split('\n') : []
  const after = typeof content.newText === 'string' ? content.newText.split('\n') : []
  // Trim the identical head and tail so the patch shows the change rather than
  // repeating the whole file twice.
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1
  let tail = 0
  while (
    tail < before.length - head
    && tail < after.length - head
    && before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail += 1
  const lines = [`[diff ${target}]`]
  const context = before.slice(Math.max(0, head - 3), head)
  for (const line of context) lines.push(`  ${line}`)
  for (const line of before.slice(head, before.length - tail)) lines.push(`- ${line}`)
  for (const line of after.slice(head, after.length - tail)) lines.push(`+ ${line}`)
  if (lines.length === 1) lines.push('(no textual change)')
  return lines.join('\n')
}

/**
 * Text carried by an ACP `content` value (a chunk or a list of content blocks).
 *
 * Nothing is dropped silently: a block kind this bridge does not model is
 * rendered as its JSON, so an agent's `audio`, `terminal` or newer payload still
 * reaches the transcript instead of vanishing.
 */
export function contentText(content) {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return clip(content)
  if (Array.isArray(content)) return clip(content.map((entry) => contentText(entry)).join(''))
  if (typeof content !== 'object') return ''
  if (content.type === 'text' && typeof content.text === 'string') return clip(content.text)
  if (content.type === 'content' || content.type === 'content_block') return contentText(content.content)
  if (content.type === 'diff') return clip(diffText(content))
  if (content.type === 'image') {
    // The bytes cannot cross this bridge as an image, but the identification
    // can: an agent that names its own attachment is still debuggable.
    const mime = content.mimeType ?? content.mediaType ?? 'unknown type'
    const bytes = typeof content.data === 'string' ? content.data.length : undefined
    return `[image ${mime}${bytes === undefined ? '' : `, ${bytes} base64 chars`}${typeof content.uri === 'string' ? ` ${content.uri}` : ''}]`
  }
  if (content.type === 'audio') {
    const mime = content.mimeType ?? content.mediaType ?? 'unknown type'
    return `[audio ${mime}${typeof content.uri === 'string' ? ` ${content.uri}` : ''}]`
  }
  if (content.type === 'resource' || content.type === 'resource_link') {
    const resource = content.resource ?? content
    if (typeof resource.text === 'string') return clip(resource.text)
    if (typeof resource.uri === 'string') return `[resource ${resource.uri}]`
    return '[resource]'
  }
  try {
    return clip(`[${content.type ?? 'content'}] ${JSON.stringify(content)}`)
  } catch {
    return `[${content.type ?? 'content'}]`
  }
}

function toolCallLine(update) {
  const title = update.title ?? update.name ?? update.kind ?? update.toolCallId ?? 'tool'
  const status = update.status ?? 'pending'
  const detail = contentText(update.content)
  const head = `[tool ${title}: ${status}]\n`
  return detail === '' ? head : `${head}${detail}\n`
}

/**
 * Turns one ACP update into DSH chunks. Stateful per turn because block indexes
 * and open blocks span the whole stream.
 */
class TurnMapper {
  constructor({ includeThoughts, includeToolActivity, log }) {
    this.includeThoughts = includeThoughts
    this.includeToolActivity = includeToolActivity
    this.log = log
    this.nextIndex = 0
    this.blocks = new Map()
    this.textIndex = undefined
    this.reasoningIndex = undefined
    this.answerText = ''
    this.thoughtText = ''
    this.sawTool = false
  }

  open(blockType) {
    const index = this.nextIndex++
    this.blocks.set(index, { type: blockType, text: '' })
    return { index, chunk: { type: 'block-start', index, blockType } }
  }

  *close(index) {
    const block = this.blocks.get(index)
    if (block === undefined) return
    this.blocks.delete(index)
    yield { type: 'block-end', index, block: { type: block.type, text: block.text } }
  }

  *closeAll() {
    for (const index of [...this.blocks.keys()].sort((left, right) => left - right)) {
      yield* this.close(index)
    }
    this.textIndex = undefined
    this.reasoningIndex = undefined
  }

  *appendText(text) {
    if (this.textIndex === undefined) {
      if (this.reasoningIndex !== undefined) {
        yield* this.close(this.reasoningIndex)
        this.reasoningIndex = undefined
      }
      const opened = this.open('text')
      this.textIndex = opened.index
      yield opened.chunk
    }
    this.blocks.get(this.textIndex).text += text
    yield { type: 'text-delta', index: this.textIndex, text }
  }

  *appendThought(text) {
    if (this.reasoningIndex === undefined) {
      if (this.textIndex !== undefined) {
        yield* this.close(this.textIndex)
        this.textIndex = undefined
      }
      const opened = this.open('reasoning')
      this.reasoningIndex = opened.index
      yield opened.chunk
    }
    this.blocks.get(this.reasoningIndex).text += text
    yield { type: 'reasoning-delta', index: this.reasoningIndex, text }
  }

  *map(update) {
    if (update === null || typeof update !== 'object') return
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = contentText(update.content)
        if (text === '') return
        this.answerText += text
        yield* this.appendText(text)
        return
      }
      case 'agent_thought_chunk': {
        const text = contentText(update.content)
        if (text === '') return
        this.thoughtText += text
        if (!this.includeThoughts) return
        yield* this.appendThought(text)
        return
      }
      case 'tool_call':
      case 'tool_call_update': {
        this.sawTool = true
        this.log?.trace('tool activity', {
          name: update.name ?? update.title,
          kind: update.kind,
          status: update.status,
          toolCallId: update.toolCallId,
        })
        if (!this.includeToolActivity) return
        yield* this.appendText(toolCallLine(update))
        return
      }
      case 'usage_update': {
        // ACP reports context-window pressure and cost here, not token totals;
        // authoritative usage arrives with the prompt result.
        this.log?.trace('usage_update', update)
        return
      }
      default:
        this.log?.trace('update', update)
    }
  }
}

/**
 * Build the ACP-backed adapter and its session pool.
 *
 * The pool holds one entry per DSH session id, plus a fingerprint index for
 * callers that supply no session id. An entry records exactly which transcript
 * prefix the agent has seen, which is what makes incremental prompting safe.
 */
export function createAcpAdapter({ agent, config, log, ctx, mcpBridge }) {
  const route = config.provider.route
  const pools = new Map()
  // One entry per ACP session id that currently has an unanswered prompt.
  const turnSlots = new Map()
  const MAX_POOL = 32

  /**
   * The DSH agent that owns this call.
   *
   * Tool calls from the ACP agent must run with the same scope as a DSH model
   * turn — same workspace, same approvals, same registry restrictions — so the
   * Agent is looked up by the session id DSH already gave us.
   */
  function owningAgent(options) {
    if (typeof options?.sessionId !== 'string' || options.sessionId === '') return undefined
    const agents = ctx?.get?.('agents')
    return agents?.get?.(options.sessionId)
  }

  function providerInfo(provider) {
    return { id: provider, name: config.provider.displayName, description: config.description }
  }

  // ACP is a local agent, not an HTTP endpoint: it has no retry-after semantics
  // and no image accounting, so pricing stays undefined and DSH applies its
  // neutral defaults. They must still exist: LlmRuntime calls them
  // unconditionally during registration.
  //
  // Retry is the one default that must not be inherited. An ACP turn is a
  // conversation, not a request: re-sending it replays a message the agent
  // already answered, and a transient `EMPTY_RESPONSE` would silently consume
  // the turn twice. The agent's own restart budget is the right recovery, so
  // this states "no retry" explicitly instead of leaving it to DSH.
  function providerRetryPolicy() {
    return { mode: 'normal', maxRetries: 0 }
  }

  function imageRequestPricing() {
    return undefined
  }

  function imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  async function listModels(provider) {
    const models = await agent.listModels()
    // LlmRuntime validates catalog entries: `provider` must be the owning route,
    // and ids must be unique. Extra fields are dropped by the runtime, so the
    // catalog stays minimal on purpose.
    return models.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
      inputModalities: ['text'],
    }))
  }

  async function resolveModel(provider, model) {
    let models = []
    try {
      models = await agent.listModels()
    } catch {}
    const known = models.find((entry) => entry.id === model)
    return {
      provider,
      id: model,
      name: known?.name ?? model,
      ...(known?.description === undefined ? {} : { description: known.description }),
      // DSH validates `context.contextWindow` when present and defaults
      // `maxTokens` from `defaultMaxTokens`.
      context: { contextWindow: known?.contextWindow ?? config.provider.contextWindow },
      defaultMaxTokens: known?.maxTokens ?? config.provider.maxTokens,
      // ACP carries no image support through this bridge: attachments become
      // transcript placeholders rather than being silently dropped.
      inputModalities: ['text'],
    }
  }

  function keyFor(options) {
    if (typeof options.sessionId === 'string' && options.sessionId !== '') return `session:${options.sessionId}`
    return undefined
  }

  function remember(key, entry) {
    pools.set(key, entry)
    while (pools.size > MAX_POOL) {
      const oldest = pools.keys().next().value
      // Evicting only forgets the mapping; the agent keeps the session until it
      // exits, which is the agent's own resource to reclaim. The MCP endpoint is
      // ours to withdraw, though, so it does not leak a token per eviction.
      try { pools.get(oldest)?.mcp?.release?.() } catch {}
      pools.delete(oldest)
    }
  }

  function drop(key) {
    if (key === undefined) return
    pools.delete(key)
  }

  async function retire(entry) {
    if (entry === undefined) return
    try { entry.mcp?.release?.() } catch {}
    try { await entry.agent.closeSession(entry.session.sessionId) } catch {}
  }

  /**
   * Apply configured model, effort and mode to a session.
   *
   * Failures are logged rather than fatal: an agent that rejects an option id
   * should still answer, and the operator can see why in `acp_logs`.
   */
  async function applySessionOptions(session, requestedModel) {
    const options = Array.isArray(session.configOptions) ? session.configOptions : []
    const byCategory = (category) => options.find((option) => option.category === category)
    const byId = (id) => (id === undefined ? undefined : options.find((option) => option.id === id))
    const modelOption = byId(config.session.modelOptionId) ?? byCategory('model')
    const effortOption = byId(config.session.effortOptionId) ?? byCategory('thought_level')
    const modeOption = byId(config.session.modeOptionId) ?? byCategory('mode')

    const wanted = []
    const modelValue = config.session.modelOptionId
      ?? (requestedModel === 'default' || requestedModel === undefined ? undefined : requestedModel)
    if (modelOption !== undefined && modelValue !== undefined) {
      const current = modelOption.currentValue ?? modelOption.current
      if (modelValue !== current) {
        const allowed = new Set((modelOption.options ?? []).map((entry) => entry.value))
        if (allowed.size === 0 || allowed.has(modelValue)) wanted.push([modelOption.id, modelValue])
        else log?.trace('skipping unknown model option', { wanted: modelValue, allowed: [...allowed].slice(0, 20) })
      }
    }
    if (effortOption !== undefined && config.session.effortOptionId !== undefined) {
      wanted.push([effortOption.id, config.session.effortOptionId])
    }
    if (modeOption !== undefined && config.session.modeValue !== undefined) {
      wanted.push([modeOption.id, config.session.modeValue])
    }
    // Deployment-supplied options come last so an operator can override one of
    // the category guesses above for an agent this plugin has never seen.
    for (const option of config.session.options) wanted.push([option.id, option.value])

    for (const [configId, value] of wanted) {
      try {
        session.configOptions = await agent.setConfigOption(session.sessionId, configId, value)
      } catch (error) {
        log?.trace('set_config_option failed', {
          sessionId: session.sessionId,
          configId,
          value,
          message: String(error?.message ?? error),
        })
      }
    }
    return session
  }

  /** Build the MCP descriptors for a new ACP session and bind its context. */
  async function openMcp(context) {
    if (mcpBridge === undefined) return { servers: [], release: () => {} }
    try {
      return await mcpBridge.forSession(config, agent, context)
    } catch (error) {
      // A broken MCP endpoint must not cost the model route: the agent can still
      // answer, it just cannot call DSH tools.
      log?.trace('mcp endpoint unavailable', String(error?.message ?? error))
      return { servers: [], release: () => {} }
    }
  }

  /** Resolve or create the ACP session for this call, plus its prompt plan. */
  async function acquire(options, includeToolActivity) {
    const key = keyFor(options)
    let entry = key === undefined ? undefined : pools.get(key)
    if (entry !== undefined && !entry.agent.running) {
      drop(key)
      entry = undefined
    }
    if (entry !== undefined && config.session.reuse === 'fresh') {
      // `fresh` trades continuity for isolation: every call starts clean.
      drop(key)
      await retire(entry)
      entry = undefined
    }
    if (entry !== undefined && Date.now() - (entry.lastUsedAt ?? 0) > config.sessionIdleMs) {
      // An unused agent session keeps a process-side conversation and an MCP
      // endpoint alive; both are worth reclaiming once the gap is long enough.
      drop(key)
      await retire(entry)
      entry = undefined
    }

    const previous = entry === undefined ? undefined : { system: entry.system, segments: entry.sentSegments }
    const plan = planPrompt(options, previous, {
      includeToolActivity,
      maxChars: config.prompt.maxTranscriptChars,
    })

    let session = entry?.session
    let reused = session !== undefined && plan.mode === 'delta'
    if (session !== undefined && !reused) {
      // The caller's transcript no longer extends what the agent saw (an edited
      // turn, a regeneration, or a model switch), so the old session is retired.
      drop(key)
      await retire(entry)
      session = undefined
    }

    let mcp
    if (session === undefined) {
      // The transport choice reads the handshake, so the agent must be up before
      // the descriptors are built; `createSession` then just reuses it.
      await agent.start()
      // The agent connects to this endpoint during `session/new`, so the token
      // exists before the call and the context is filled in after it returns.
      const context = { agent: owningAgent(options), cwd: undefined }
      mcp = await openMcp(context)
      try {
        session = await agent.createSession({ mcpServers: mcp.servers })
      } catch (error) {
        mcp.release()
        throw error
      }
      context.cwd = session.cwd
      await applySessionOptions(session, options.model)
      reused = false
    }
    return { key, entry, session, plan, reused, mcp }
  }

  /**
   * Wait for any in-flight turn on this DSH session, then claim the slot.
   *
   * One ACP session is one conversation: sending a second `session/prompt`
   * while the first is unanswered makes the agent interleave two turns into one
   * history. DSH can legitimately issue concurrent calls on one session, so the
   * second one queues here rather than corrupting the transcript.
   *
   * The claim happens *before* the session is resolved, not after: `acquire` may
   * retire a pooled session when the transcript no longer extends it, and doing
   * that to a session another turn is still streaming on would yank it out from
   * under that turn.
   */
  async function claimTurn(key) {
    if (key === undefined) return () => {}
    const previous = turnSlots.get(key)
    if (previous !== undefined) await previous.catch(() => {})
    let release
    const slot = new Promise((resolve) => { release = resolve })
    turnSlots.set(key, slot)
    return () => {
      if (turnSlots.get(key) === slot) turnSlots.delete(key)
      release()
    }
  }

  async function* stream_(options) {
    const key = keyFor(options)
    const includeToolActivity = config.stream.includeToolActivity
    const releaseTurn = await claimTurn(key)
    let acquired
    try {
      acquired = await acquire(options, config.prompt.includeToolActivity)
    } catch (error) {
      releaseTurn()
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'ACP_SESSION', message: String(error?.message ?? error) } },
      }
      return
    }

    const { session, plan } = acquired
    const connection = agent.connection
    if (connection === undefined || connection.closed) {
      drop(key)
      acquired.mcp?.release?.()
      releaseTurn()
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'ACP_NOT_RUNNING', message: `agent "${config.id}" is not running` } },
      }
      return
    }

    const mapper = new TurnMapper({
      includeThoughts: config.stream.includeThoughts,
      includeToolActivity,
      log,
    })
    const queue = new AsyncQueue()

    const onNotification = (message) => {
      if (message?.method !== 'session/update') return
      const params = message.params
      if (params?.sessionId !== session.sessionId) return
      queue.push(params.update ?? {})
    }
    connection.on('notification', onNotification)

    const permissionDisposer = agent.setPermissionHandler(session.sessionId, (params, meta) => {
      const decision = decidePermission(config, params, log)
      const granted = decision.grantedKind
      const record = {
        sessionId: params?.sessionId ?? session.sessionId,
        requestId: meta?.id,
        toolCall: params?.toolCall?.title ?? params?.toolCall?.kind,
        kind: params?.toolCall?.kind,
        outcome: decision.outcome?.outcome,
        optionId: decision.outcome?.optionId,
        grantedKind: granted,
        offered: (Array.isArray(params?.options) ? params.options : []).map((option) => String(option?.kind ?? '')),
      }
      log?.trace('permission decision', record)
      // A blanket grant must not look like a one-shot one in the log: it is the
      // difference between "this call was approved" and "this session is open".
      if (granted !== undefined && granted !== 'allow_once') {
        try {
          agent.ctx?.logger?.warn?.(`[dsh-acp:${config.id}] granted "${granted}" to ${record.toolCall ?? record.kind ?? 'a tool'} (session ${record.sessionId})`)
        } catch {}
      }
      return decision
    })

    let cancelled = false
    let cancelFallback
    let abandoned = false
    const sendCancel = () => {
      if (cancelled) return
      cancelled = true
      try { connection.notify('session/cancel', { sessionId: session.sessionId }) } catch {}
      // `session/cancel` is a notification: a conforming agent answers it, but
      // nothing forces it to. Without a fallback an ignored cancel holds the turn
      // — and its session slot — until the full turn timeout.
      cancelFallback = setTimeout(() => {
        abandoned = true
        try { queue.close() } catch {}
      }, CANCEL_FALLBACK_MS)
      cancelFallback.unref?.()
    }
    const onAbort = () => sendCancel()
    if (options.signal !== undefined) {
      if (options.signal.aborted) sendCancel()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    // The slot was claimed before `acquire` resolved the session, so nothing can
    // put a second prompt on this ACP session while this one is unanswered.

    const promptText = plan.mode === 'delta' ? plan.prompt : wrapFreshPrompt(plan.prompt)
    const startedAt = Date.now()
    const request = connection.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: promptText }],
    }, {
      timeoutMs: config.turnTimeoutMs,
      // The wire request must outlive the caller's abort so that the agent's
      // `cancelled` answer still arrives and the session stays consistent.
    })

    let promptResult
    let promptError
    const settled = request.then((value) => {
      promptResult = value
    }, (error) => {
      promptError = error
    }).finally(() => {
      queue.close()
    })

    try {
      while (true) {
        const item = await queue.shift()
        if (item === QUEUE_END) break
        for (const chunk of mapper.map(item)) yield chunk
      }
      // The fallback closes the queue but the prompt request stays outstanding,
      // so this must be decided before waiting on it.
      if (abandoned) {
        drop(key)
        await retire({ agent, session, mcp: acquired.mcp })
        log?.trace('turn abandoned after cancel', { sessionId: session.sessionId, afterMs: CANCEL_FALLBACK_MS })
        yield {
          type: 'finish',
          reason: {
            kind: 'aborted',
            failure: {
              code: 'ABORTED',
              message: `the agent did not answer session/cancel within ${CANCEL_FALLBACK_MS}ms; the turn was abandoned`,
            },
          },
        }
        return
      }
      await settled
      yield* mapper.closeAll()

      const usage = mapUsage(promptResult?.usage)
      if (usage !== undefined) yield { type: 'usage', usage }

      if (promptError !== undefined) {
        const code = typeof promptError.code === 'string' ? promptError.code : 'ACP_TURN'
        const aborted = code === 'ACP_CANCELLED' || code === 'ABORTED' || options.signal?.aborted === true
        const message = describeRpcError(promptError)
        drop(key)
        if (!acquired.reused) await retire({ agent, session, mcp: acquired.mcp })
        log?.trace('turn failed', { sessionId: session.sessionId, code, message, data: promptError.data })
        yield {
          type: 'finish',
          reason: aborted
            ? { kind: 'aborted', failure: { code: 'ABORTED', message } }
            : { kind: 'error', failure: { code: code === 'ACP_TIMEOUT' ? 'TIMEOUT' : code, message } },
        }
        return
      }

      const stopReason = promptResult?.stopReason
      log?.trace('turn finished', {
        sessionId: session.sessionId,
        stopReason,
        usage,
        mode: plan.mode,
        reused: acquired.reused,
        answerChars: mapper.answerText.length,
        thoughtChars: mapper.thoughtText.length,
        sawTool: mapper.sawTool,
        elapsedMs: Date.now() - startedAt,
      })

      if (stopReason === 'cancelled') {
        drop(key)
        await retire({ agent, session, mcp: acquired.mcp })
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'the ACP turn was cancelled' } },
        }
        return
      }

      // A refusal with a machine-readable reason behind it is a failure, not an
      // empty answer: DSH cannot retry or report what it cannot classify.
      if (stopReason === 'refusal') {
        const failure = refusalFailure(promptResult?._meta)
        if (failure !== undefined) {
          drop(key)
          await retire({ agent, session, mcp: acquired.mcp })
          log?.trace('turn refused', { sessionId: session.sessionId, code: failure.code })
          yield { type: 'finish', reason: { kind: 'error', failure } }
          return
        }
      }

      // Record the prefix the agent now owns, including its own answer, so the
      // next call on this DSH session can send only the new user turn.
      if (key !== undefined) {
        remember(key, {
          agent,
          session,
          mcp: acquired.mcp,
          model: options.model,
          lastUsedAt: Date.now(),
          system: plan.projection.system,
          sentSegments: [
            ...plan.projection.segments,
            ...(mapper.answerText === '' ? [] : [{ index: -1, role: 'assistant', text: mapper.answerText }]),
          ],
        })
      } else {
        // Nothing pools a session that has no DSH id, so this turn's is done.
        acquired.mcp?.release?.()
        await retire({ agent, session })
      }

      yield { type: 'finish', reason: mapStopReason(stopReason) }
    } finally {
      connection.removeListener('notification', onNotification)
      permissionDisposer?.()
      options.signal?.removeEventListener('abort', onAbort)
      clearTimeout(cancelFallback)
      releaseTurn()
      queue.close()
    }
  }

  function wrapFreshPrompt(transcript) {
    return [
      'You are being consulted through the DeepSeek Harness as a model route.',
      'The transcript below is the conversation so far. Answer the final user turn.',
      'Do not restate the transcript, do not ask for confirmation, and do not wait for further input. Answer directly.',
      '',
      transcript,
    ].join('\n')
  }

  return {
    id: route,
    provider: route,
    providerInfo,
    providerRetryPolicy,
    imageRequestPricing,
    imageRequestTarget,
    listModels,
    resolveModel,
    prepareCall: async (provider, model, signal) => {
      signal?.throwIfAborted?.()
      return {
        model: await resolveModel(provider, model, signal),
        stream: (options) => stream_({ ...options, provider, model }),
      }
    },
    stream: stream_,
    /** Test seam: number of pooled ACP sessions. */
    poolSize: () => pools.size,
    /** Close every pooled ACP session and forget them. */
    release: async () => {
      const entries = [...pools.values()]
      pools.clear()
      await Promise.allSettled(entries.map((entry) => retire(entry)))
    },
  }
}

/** Choose a permission outcome from the configured policy and offered options. */
export function decidePermission(config, params, log) {
  const options = Array.isArray(params?.options) ? params.options : []
  const kindOf = (option) => String(option?.kind ?? '')
  const policy = config.permission.policy
  const readOnlyKind = String(params?.toolCall?.kind ?? '')

  if (policy === 'allow') {
    const allow = options.find((option) => kindOf(option) === 'allow_once')
      ?? options.find((option) => kindOf(option) === 'allow_always')
    if (allow !== undefined) return { outcome: { outcome: 'selected', optionId: allow.optionId }, grantedKind: kindOf(allow) }
  } else if (config.permission.allowReadOnly && ['read', 'search', 'think', 'fetch', 'switch_mode'].includes(readOnlyKind)) {
    const allow = options.find((option) => kindOf(option) === 'allow_once')
      ?? options.find((option) => kindOf(option) === 'allow_always')
    if (allow !== undefined) return { outcome: { outcome: 'selected', optionId: allow.optionId }, grantedKind: kindOf(allow) }
  }

  const reject = options.find((option) => kindOf(option) === 'reject_once')
    ?? options.find((option) => kindOf(option) === 'reject_always')
  if (reject !== undefined) return { outcome: { outcome: 'selected', optionId: reject.optionId }, grantedKind: kindOf(reject) }
  log?.trace('permission request without an actionable option', { options: options.map(kindOf) })
  return { outcome: { outcome: 'cancelled' } }
}
