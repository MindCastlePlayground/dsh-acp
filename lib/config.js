// Configuration normalization for the ACP model bridge.
//
// Everything is validated once, here, so the connection, session pool, adapter
// and tools can assume a complete shape. The plugin deliberately declares no
// dependency on @deepseek-ai/* packages: a profile-installed ESM package cannot
// reliably resolve the Harness package tree on Windows, so runtime services are
// reached through the Cordis context and everything else is a Node built-in.

export class AcpConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AcpConfigError'
    this.code = 'DSH_ACP_CONFIG'
  }
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail(message) {
  throw new AcpConfigError(message)
}

function asString(value, field, fallback) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback
    fail(`${field} is required`)
  }
  if (typeof value !== 'string' || value.length === 0) fail(`${field} must be a non-empty string`)
  return value
}

function asOptionalString(value, field) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail(`${field} must be a string`)
  return value === '' ? undefined : value
}

function asBoolean(value, field, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') fail(`${field} must be a boolean`)
  return value
}

function asInteger(value, field, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback
    fail(`${field} is required`)
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer between ${min} and ${max}`)
  }
  return value
}

/** An integer that may be omitted entirely; `undefined` survives. */
function asOptionalInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return undefined
  return asInteger(value, field, undefined, { min, max })
}

function asEnum(value, field, allowed, fallback) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback
    fail(`${field} is required`)
  }
  if (!allowed.includes(value)) fail(`${field} must be one of: ${allowed.join(', ')}`)
  return value
}

function asStringArray(value, field, fallback = []) {
  if (value === undefined || value === null) return [...fallback]
  if (!Array.isArray(value)) fail(`${field} must be an array of strings`)
  return value.map((entry, index) => {
    if (typeof entry !== 'string') fail(`${field}[${index}] must be a string`)
    return entry
  })
}

/** Expand `${env:NAME}` in configured strings; unknown placeholders stay literal. */
export function expandString(value, extra = {}) {
  return value.replace(/\$\{([^}]+)\}/g, (whole, expression) => {
    const expr = expression.trim()
    if (expr.startsWith('env:')) return process.env[expr.slice(4)] ?? ''
    if (Object.hasOwn(extra, expr)) return String(extra[expr] ?? '')
    return whole
  })
}

function normalizeEnv(raw, field) {
  if (raw === undefined || raw === null) return {}
  if (!isPlainObject(raw)) fail(`${field} must be an object`)
  const env = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail(`${field}.${key} is not a valid environment variable name`)
    if (value === null) {
      env[key] = null
      continue
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      fail(`${field}.${key} must be a string, number, boolean or null`)
    }
    env[key] = expandString(String(value))
  }
  return env
}

function normalizeModels(raw, at) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) fail(`${at} must be an array`)
  return raw.map((entry, index) => {
    const item = `${at}[${index}]`
    if (!isPlainObject(entry)) fail(`${item} must be an object`)
    return {
      id: asString(entry.id, `${item}.id`),
      name: asString(entry.name, `${item}.name`, asString(entry.id, `${item}.id`)),
      contextWindow: asOptionalInteger(entry.contextWindow, `${item}.contextWindow`, { min: 1 }),
      maxTokens: asOptionalInteger(entry.maxTokens, `${item}.maxTokens`, { min: 1 }),
    }
  })
}

function normalizeAgent(entry, at, defaults) {
  if (!isPlainObject(entry)) fail(`${at} must be an object`)
  const id = asString(entry.id, `${at}.id`)
  if (!ID_RE.test(id)) fail(`${at}.id "${id}" must match ${ID_RE}`)

  const command = asString(entry.command, `${at}.command`)
  const args = asStringArray(entry.args, `${at}.args`, defaults.args)

  const restart = isPlainObject(entry.restart) ? entry.restart : {}
  const logs = isPlainObject(entry.logs) ? entry.logs : {}
  const session = isPlainObject(entry.session) ? entry.session : {}
  const permission = isPlainObject(entry.permission) ? entry.permission : {}
  const provider = isPlainObject(entry.provider) ? entry.provider : {}
  const prompt = isPlainObject(entry.prompt) ? entry.prompt : {}
  const stream = isPlainObject(entry.stream) ? entry.stream : {}
  const clientInfo = isPlainObject(entry.clientInfo) ? entry.clientInfo : {}

  const rawModels = normalizeModels(provider.models ?? entry.models, `${at}.provider.models`)
  const route = asOptionalString(provider.route, `${at}.provider.route`) ?? `acp-${id}`
  const providerEnabled = asBoolean(provider.enabled, `${at}.provider.enabled`, true)

  const defaultModel = asOptionalString(provider.defaultModel, `${at}.provider.defaultModel`)
    ?? rawModels[0]?.id

  return {
    id,
    displayName: asString(entry.displayName, `${at}.displayName`, id),
    description: asString(entry.description, `${at}.description`, `ACP agent "${id}" exposed as a DSH model route.`),
    enabled: asBoolean(entry.enabled, `${at}.enabled`, true),
    command,
    args,
    // `auto` runs through a shell only when the resolved command is a Windows
    // batch wrapper (.cmd/.bat), which Node cannot execute directly.
    shell: asEnum(entry.shell, `${at}.shell`, ['auto', 'always', 'never'], process.platform === 'win32' ? 'auto' : 'never'),
    cwd: asOptionalString(entry.cwd, `${at}.cwd`),
    env: normalizeEnv(entry.env, `${at}.env`),
    clientInfo: {
      name: asString(clientInfo.name, `${at}.clientInfo.name`, defaults.clientInfo.name),
      title: asString(clientInfo.title, `${at}.clientInfo.title`, defaults.clientInfo.title),
      version: asString(clientInfo.version, `${at}.clientInfo.version`, defaults.clientInfo.version),
    },
    protocolVersion: asInteger(entry.protocolVersion, `${at}.protocolVersion`, 1, { min: 1 }),
    autoStart: asBoolean(entry.autoStart, `${at}.autoStart`, true),
    startupTimeoutMs: asInteger(entry.startupTimeoutMs, `${at}.startupTimeoutMs`, 30_000, { min: 1_000 }),
    turnTimeoutMs: asInteger(entry.turnTimeoutMs, `${at}.turnTimeoutMs`, 900_000, { min: 1_000 }),
    stopTimeoutMs: asInteger(entry.stopTimeoutMs, `${at}.stopTimeoutMs`, 5_000, { min: 100 }),
    sessionIdleMs: asInteger(entry.sessionIdleMs, `${at}.sessionIdleMs`, 1_800_000, { min: 10_000 }),
    restart: {
      enabled: asBoolean(restart.enabled, `${at}.restart.enabled`, true),
      maxRestarts: asInteger(restart.maxRestarts, `${at}.restart.maxRestarts`, 5, { min: 0 }),
      windowMs: asInteger(restart.windowMs, `${at}.restart.windowMs`, 3_600_000, { min: 1_000 }),
      initialDelayMs: asInteger(restart.initialDelayMs, `${at}.restart.initialDelayMs`, 1_000, { min: 10 }),
      maxDelayMs: asInteger(restart.maxDelayMs, `${at}.restart.maxDelayMs`, 15_000, { min: 10 }),
    },
    permission: {
      policy: asEnum(permission.policy, `${at}.permission.policy`, ['allow', 'deny'], 'allow'),
      // A `deny` policy still allows read-only kinds when this stays true, which
      // keeps an inspecting agent useful without granting writes.
      allowReadOnly: asBoolean(permission.allowReadOnly, `${at}.permission.allowReadOnly`, true),
    },
    session: {
      // Empty values mean "use whatever the agent reports for that category".
      modelOptionId: asOptionalString(session.modelOptionId, `${at}.session.modelOptionId`),
      effortOptionId: asOptionalString(session.effortOptionId, `${at}.session.effortOptionId`),
      modeOptionId: asOptionalString(session.modeOptionId, `${at}.session.modeOptionId`),
      modeValue: asOptionalString(session.modeValue, `${at}.session.modeValue`),
      // `reuse` keeps one ACP session per DSH session while the transcript
      // prefix is stable; `fresh` opens a new ACP session for every call.
      reuse: asEnum(session.reuse, `${at}.session.reuse`, ['reuse', 'fresh'], 'reuse'),
    },
    prompt: {
      includeToolActivity: asBoolean(prompt.includeToolActivity, `${at}.prompt.includeToolActivity`, true),
      maxTranscriptChars: asInteger(prompt.maxTranscriptChars, `${at}.prompt.maxTranscriptChars`, 400_000, { min: 1_000 }),
    },
    stream: {
      // Agent thoughts map onto DSH reasoning blocks; an operator that finds the
      // reasoning noisy can drop it without losing the answer.
      includeThoughts: asBoolean(stream.includeThoughts, `${at}.stream.includeThoughts`, true),
      // Live tool activity is the agent's own work, not DSH tool calls, so it is
      // logged by default rather than injected into the assistant text.
      includeToolActivity: asBoolean(stream.includeToolActivity, `${at}.stream.includeToolActivity`, false),
    },
    logs: {
      maxLines: asInteger(logs.maxLines, `${at}.logs.maxLines`, 2_000, { min: 1 }),
      maxBytes: asInteger(logs.maxBytes, `${at}.logs.maxBytes`, 1_048_576, { min: 1_024 }),
      file: asOptionalString(logs.file, `${at}.logs.file`),
    },
    provider: {
      enabled: providerEnabled,
      route: asString(route, `${at}.provider.route`),
      displayName: asString(provider.displayName, `${at}.provider.displayName`, `${asString(entry.displayName, `${at}.displayName`, id)} (ACP)`),
      defaultModel: defaultModel === undefined ? undefined : asString(defaultModel, `${at}.provider.defaultModel`),
      contextWindow: asInteger(provider.contextWindow, `${at}.provider.contextWindow`, 200_000, { min: 1 }),
      maxTokens: asInteger(provider.maxTokens, `${at}.provider.maxTokens`, 32_768, { min: 1 }),
      discoverModels: asBoolean(provider.discoverModels, `${at}.provider.discoverModels`, rawModels.length === 0),
      modelCacheMs: asInteger(provider.modelCacheMs, `${at}.provider.modelCacheMs`, 300_000, { min: 0 }),
      models: rawModels,
    },
  }
}

/**
 * Normalize the row config. `agents` accepts either a map keyed by id or a list
 * whose entries carry `id`, so a patch can stay terse for the common single
 * agent case.
 */
export function normalizeConfig(rawConfig, { packageDir } = {}) {
  const raw = rawConfig === undefined || rawConfig === null ? {} : rawConfig
  if (!isPlainObject(raw)) fail('config must be an object')

  const defaults = {
    args: ['acp'],
    clientInfo: { name: 'dsh-acp', title: 'DSH ACP Bridge', version: '0.1.0' },
  }

  const rawAgents = raw.agents ?? raw.agent
  const agents = []
  if (rawAgents === undefined || rawAgents === null) {
    // A row with no agents stays dormant instead of failing activation.
  } else if (Array.isArray(rawAgents)) {
    rawAgents.forEach((entry, index) => agents.push(normalizeAgent(entry, `agents[${index}]`, defaults)))
  } else if (isPlainObject(rawAgents)) {
    for (const [id, entry] of Object.entries(rawAgents)) {
      if (!isPlainObject(entry)) fail(`agents.${id} must be an object`)
      agents.push(normalizeAgent({ ...entry, id }, `agents.${id}`, defaults))
    }
  } else {
    fail('agents must be an object keyed by agent id, or an array of agent objects')
  }
  const seen = new Set()
  for (const agent of agents) {
    if (seen.has(agent.id)) fail(`duplicate agent id "${agent.id}"`)
    seen.add(agent.id)
  }
  const routes = new Set()
  for (const agent of agents) {
    if (!agent.provider.enabled) continue
    if (routes.has(agent.provider.route)) fail(`duplicate provider route "${agent.provider.route}"`)
    routes.add(agent.provider.route)
  }

  return {
    agents,
    ...(packageDir === undefined ? {} : { packageDir }),
  }
}
