// What DSH exposes to an ACP agent through MCP.
//
// Three DSH surfaces map onto the three MCP ones:
//
//   ctx.tools   -> tools      every tool any plugin registered, including the
//                             Cordis plugins mounted in this profile
//   ctx.skills  -> prompts    (plus a generated `dsh_skills` tool, because most
//                             agents surface tools and ignore prompts)
//   workspace   -> resources  read-only file access under the session cwd
//
// The tool set is resolved through the owning agent's scope, so an agent sees
// exactly what a DSH model in that session sees: registry restrictions, plugin
// tools, and visibility rules all apply. Calls run through `ctx.tools.execute`,
// which means DSH's own approval, sandbox and guard pipeline still decides.

import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { McpError, MCP_ERRORS, truncateContent } from './mcp.js'

const MAX_RESOURCE_BYTES = 512 * 1024
// A skill body is instruction text, not command output: it is bounded tighter
// than a tool result, and the catalog is bounded again on its own.
const MAX_SKILL_LINES = 2_000
const DEFAULT_SKILL_LINES = 400
const MAX_SKILLS_LISTED = 200
const MAX_SKILL_DESCRIPTION = 1_000

// Never injected back into an agent, whatever the row config says.
export const RESERVED_TOOL_MASKS = Object.freeze(['acp_*'])

/** DSH's two invocation flags, defaulted on when a provider omits them. */
export const modelVisible = (entry) => entry?.invocation?.modelInvocable !== false
export const userVisible = (entry) => entry?.invocation?.userInvocable !== false

/** Glob with `*` only: enough for tool masks, and cheap to reason about. */
export function matchesPattern(name, pattern) {
  if (pattern === name || pattern === '*') return true
  if (!pattern.includes('*')) return false
  const escaped = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${escaped.join('.*')}$`).test(name)
}

export function matchesAny(name, patterns) {
  return patterns.some((pattern) => matchesPattern(name, pattern))
}

/**
 * Keep the tools a mask selects. An empty include list means "everything the
 * agent can see"; `exclude` always wins, so a deployment cannot widen `include`
 * past a mask it also excludes.
 */
export function selectTools(definitions, { include = [], exclude = [] } = {}) {
  // The plugin's own controls are never injectable back into an agent, however
  // the row is configured: `acp_control` can restart the process serving the
  // turn, which is a deadlock rather than a feature.
  const masks = [...new Set([...exclude, ...RESERVED_TOOL_MASKS])]
  const visible = include.length === 0
    ? definitions
    : definitions.filter((definition) => matchesAny(definition.name, include))
  return visible.filter((definition) => !matchesAny(definition.name, masks))
}

/** File attachments cannot cross this bridge as images; name them instead. */
function blockToMcp(block) {
  if (block === null || typeof block !== 'object') return { type: 'text', text: String(block) }
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text }
  if (block.type === 'image') {
    // Reading attachment bytes needs the attachments service, which is not part
    // of this plugin's injected surface; the reference stays useful to a human.
    const ref = block.attachment ?? block.source ?? block
    const id = ref?.id ?? ref?.attachmentId ?? ref?.uri ?? 'unknown'
    return { type: 'text', text: `[image attachment ${id} is not transferred over MCP]` }
  }
  if (block.type === 'resource_link' || block.type === 'resource') {
    const uri = block.uri ?? block.resource?.uri
    if (typeof uri === 'string') return { type: 'text', text: `[resource ${uri}]` }
  }
  try {
    return { type: 'text', text: JSON.stringify(block) }
  } catch {
    return { type: 'text', text: String(block) }
  }
}

/** Project one `ctx.tools.execute` outcome onto MCP content. */
export function resultToMcp(result, maxResultBytes) {
  const blocks = Array.isArray(result?.content) ? result.content.map(blockToMcp) : []
  if (blocks.length === 0 && result?.value !== undefined) {
    blocks.push({ type: 'text', text: JSON.stringify(result.value, null, 2) })
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: result?.isError === true ? 'Error' : '(no output)' })
  return truncateContent(blocks, maxResultBytes)
}

/**
 * Containment test on two already-canonical paths.
 *
 * `relative === '..'` and a `'..' + sep` prefix are the only escapes: a sibling
 * named `..draft.md` is a legal child, and a bare `startsWith('..')` would
 * wrongly refuse it.
 */
function isInside(base, target) {
  const relative = path.relative(base, target)
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/**
 * Resolve `file` against `base` and refuse anything that lands outside it.
 *
 * Both ends are canonicalized first, so a symlink inside the directory that
 * points outside is followed and then refused, while a legitimate in-tree
 * symlink still resolves. Canonicalizing the base matters too: on Windows a
 * junction, or `/tmp` on macOS, would otherwise reject every legitimate path.
 */
async function resolveInside(base, file) {
  const root = await realpath(base)
  const lexical = path.resolve(root, file)
  // Refuse a traversal before touching the filesystem, so the message names the
  // policy rather than a missing file.
  if (!isInside(root, lexical)) throw outside(lexical, root)
  const resolved = await realpath(lexical)
  // Canonicalization again, because a symlink inside the tree may point out.
  if (!isInside(root, resolved)) throw outside(resolved, root)
  return { root, resolved }
}

function outside(target, root) {
  return new Error(`refusing to read "${target}" outside the directory "${root}"`)
}

async function readTextResource(file, cwd) {
  const base = cwd ?? process.cwd()
  const { resolved } = await resolveInside(base, file)
  // `stat` follows the already-resolved path, so this also rejects a FIFO or a
  // device node before a single byte is read.
  const info = await stat(resolved)
  if (!info.isFile()) throw new Error(`"${resolved}" is not a file`)
  if (info.size > MAX_RESOURCE_BYTES) throw new Error(`"${resolved}" is ${info.size} bytes, over the ${MAX_RESOURCE_BYTES}-byte resource limit`)
  return readFile(resolved, 'utf8')
}

/**
 * Render one skill as the `<skill_content>` block DSH's own renderer produces.
 *
 * The `<skill_resources>` section is what makes a skill's sibling files usable:
 * an ACP agent brings its own read tools, so telling it the base directory is
 * enough for it to load `reference/*.md` on demand instead of up front.
 */
function skillDocument(skill, { maxLines = DEFAULT_SKILL_LINES } = {}) {
  const parts = [`<skill_content name="${skill.name}">`]
  if (typeof skill.description === 'string' && skill.description !== '') parts.push(skill.description)
  if (typeof skill.whenToUse === 'string' && skill.whenToUse !== '') parts.push(`When to use: ${skill.whenToUse}`)
  const base = skill.resourceBase
  if (base?.kind === 'directory' && typeof base.path === 'string' && base.path !== '') {
    parts.push(
      '<skill_resources>',
      `Base directory for this skill: ${base.path}`,
      'Resolve relative paths mentioned by this skill against the base directory, and load referenced resources only as needed.',
      '</skill_resources>',
    )
  }
  const body = String(skill.content ?? '')
  const lines = body.split('\n')
  const limit = Math.max(1, Math.min(MAX_SKILL_LINES, maxLines))
  // Announce the cut: a truncated body that looks complete makes an agent
  // believe it has read the whole skill.
  const text = lines.length <= limit
    ? body
    : `${lines.slice(0, limit).join('\n')}\n\n[truncated: showing the first ${limit} of ${lines.length} lines; call again with a larger maxLines to read more]`
  parts.push('<skill_instructions>', text, '</skill_instructions>', '</skill_content>')
  return parts.join('\n')
}

/**
 * Build the MCP surface for one ACP session.
 *
 * `context` is a live object owned by that session: `{ agent, cwd }`. It is
 * filled in after `session/new` returns, and read on every request, which is
 * why it is passed by reference rather than captured.
 */
export function createDshMcpSurface({ ctx, config, log, context }) {
  const settings = config.mcp
  let counter = 0

  const toolsService = () => ctx.get('tools')
  const skillsService = () => ctx.get('skills')
  const cwd = () => context.cwd
  const agent = () => context.agent
  const scopeOptions = () => ({
    ...(agent() === undefined ? {} : { scope: agent() }),
    ...(cwd() === undefined ? {} : { cwd: cwd() }),
  })

  async function visibleTools() {
    const tools = toolsService()
    if (tools === undefined) return []
    let schemas
    try {
      schemas = tools.schemas(agent())
    } catch (error) {
      log?.trace('mcp tools/list failed; falling back to the global view', String(error?.message ?? error))
      schemas = tools.schemas()
    }
    // `acp_*` is not configurable: an agent that can restart or reconfigure the
    // process serving its own turn is a deadlock, so the mask is unioned in even
    // when a deployment widens `exclude`.
    return selectTools(schemas ?? [], settings.tools)
  }

  /**
   * Skills to advertise on one surface.
   *
   * `modelInvocable` governs every model-facing surface (the tool catalog, the
   * `dsh://skill` resource) while `userInvocable` governs prompts, which a
   * client renders as slash commands for a human. Resolving both from one
   * listing but filtering per surface is what keeps the listing and the read
   * path from disagreeing.
   *
   * Returns `undefined` when the skill service itself failed, so a broken
   * provider never reads as "this profile has no skills".
   */
  async function skillSummaries({ forPrompts = false } = {}) {
    if (!settings.skills && !settings.prompts) return []
    const skills = skillsService()
    if (skills === undefined) return []
    try {
      const listed = await skills.list(scopeOptions())
      return (listed ?? []).filter((entry) => (forPrompts ? userVisible(entry) : modelVisible(entry)))
    } catch (error) {
      log?.trace('mcp skills/list failed', String(error?.message ?? error))
      return undefined
    }
  }

  /** The generated skill tools exist only when a skill service and no real `skill` tool do. */
  function needsSkillTool(tools) {
    if (!settings.skills || skillsService() === undefined) return false
    const names = new Set(tools.map((tool) => tool.name))
    return !names.has(settings.skillToolName) && !names.has('skill')
  }

  /** One catalog line: normalized, capped, and never able to break the list. */
  function catalogLine(entry) {
    const description = String(entry.description ?? '').replace(/\s+/g, ' ').trim()
    const capped = description.length > MAX_SKILL_DESCRIPTION
      ? `${description.slice(0, MAX_SKILL_DESCRIPTION)}…`
      : description
    return `- ${entry.name}${capped === '' ? '' : `: ${capped}`}`
  }

  /**
   * Load one skill and render it, or explain why it cannot be loaded.
   *
   * The invocation policy is re-tested on the loaded definition, not just on
   * the listing, so a `disable-model-invocation` skill stays unreachable by
   * name rather than being merely unlisted.
   */
  async function loadSkill(name, { forPrompts = false } = {}) {
    const skills = skillsService()
    if (skills === undefined) return { error: 'Error: this profile has no skill service' }
    const skill = await skills.get(name, scopeOptions())
    if (skill === undefined) return { error: `Error: unknown skill "${name}"` }
    const allowed = forPrompts ? userVisible(skill) : modelVisible(skill)
    if (!allowed) {
      return { error: `Error: skill "${name}" is not available for ${forPrompts ? 'user' : 'model'} invocation` }
    }
    return { skill }
  }

  async function callSkillTool(args) {
    const name = typeof args?.name === 'string' ? args.name : undefined
    if (name === undefined || name === '') {
      const summaries = await skillSummaries()
      if (summaries === undefined) {
        return { content: [{ type: 'text', text: 'Error: the DeepSeek Harness skill service failed; the catalog cannot be listed' }], isError: true }
      }
      if (summaries.length === 0) return { content: [{ type: 'text', text: 'No skills are available in this profile.' }] }
      const shown = summaries.slice(0, MAX_SKILLS_LISTED)
      const lines = shown.map(catalogLine)
      const omitted = summaries.length - shown.length
      if (omitted > 0) lines.push(`… [truncated: ${omitted} more skills omitted]`)
      return { content: truncateContent([{ type: 'text', text: `Available skills:\n${lines.join('\n')}` }], settings.skillMaxBytes) }
    }
    const loaded = await loadSkill(name)
    if (loaded.error !== undefined) return { content: [{ type: 'text', text: loaded.error }], isError: true }
    const text = skillDocument(loaded.skill, { maxLines: args?.maxLines })
    return { content: truncateContent([{ type: 'text', text }], settings.skillMaxBytes) }
  }

  async function callSkillRead(args) {
    const name = typeof args?.name === 'string' ? args.name : ''
    if (name === '') return { content: [{ type: 'text', text: 'Error: dsh_skill_read requires a skill name' }], isError: true }
    const loaded = await loadSkill(name)
    if (loaded.error !== undefined) return { content: [{ type: 'text', text: loaded.error }], isError: true }
    const skill = loaded.skill
    const file = typeof args?.file === 'string' && args.file !== '' ? args.file : undefined
    if (file === undefined) {
      const text = skillDocument(skill, { maxLines: args?.maxLines })
      return { content: truncateContent([{ type: 'text', text }], settings.skillMaxBytes) }
    }
    // Sibling files are addressed relative to the skill directory. The agent's
    // own `fs/read_text_file` cannot reach them, because that path is confined
    // to the session cwd, which is a different tree from the skills roots.
    const base = skill.resourceBase
    if (base?.kind !== 'directory' || typeof base.path !== 'string' || base.path === '') {
      return { content: [{ type: 'text', text: `Error: skill "${name}" has no directory to resolve "${file}" against` }], isError: true }
    }
    if (file.includes('\0') || path.isAbsolute(file) || path.win32.isAbsolute(file)) {
      return { content: [{ type: 'text', text: `Error: "${file}" must be a relative path inside the skill directory` }], isError: true }
    }
    try {
      const text = await readTextResource(file, base.path)
      return { content: truncateContent([{ type: 'text', text }], settings.skillMaxBytes) }
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${String(error?.message ?? error)}` }], isError: true }
    }
  }

  return {
    instructions: [
      'These tools belong to the DeepSeek Harness hosting you.',
      'Calling one runs real code and real file operations in the Harness session,',
      'under the Harness\'s own approval and sandbox policy: a call may be refused,',
      'or may wait for the operator to approve it.',
    ].join(' '),

    async listTools() {
      const tools = await visibleTools()
      const list = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters ?? { type: 'object', properties: {} },
      }))
      if (needsSkillTool(tools)) {
        list.push({
          name: settings.skillToolName,
          title: 'DeepSeek Harness skills',
          annotations: { readOnlyHint: true },
          description: 'List or load a DeepSeek Harness skill. Call with no arguments to list skill names and descriptions, or with a name to load that skill\'s instructions. Call `' + settings.skillReadToolName + '` instead when you need a reference file beside SKILL.md or a deliberate line window.',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', description: 'Exact skill name from the listing.' },
              maxLines: { type: 'integer', minimum: 1, maximum: MAX_SKILL_LINES, default: DEFAULT_SKILL_LINES, description: 'Keep only the first N lines of the skill body.' },
            },
          },
        })
        list.push({
          name: settings.skillReadToolName,
          title: 'Read one DeepSeek Harness skill file',
          annotations: { readOnlyHint: true },
          description: 'Read one skill (SKILL.md by default), or a reference file beside it, optionally limited to the first maxLines lines. Relative paths resolve against the skill\'s own directory, so `reference/schema.md` works even though it is outside the session cwd.',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['name'],
            properties: {
              name: { type: 'string', description: 'Exact skill name from the listing.' },
              file: { type: 'string', description: 'Relative path inside the skill directory. Omit to read SKILL.md.' },
              maxLines: { type: 'integer', minimum: 1, maximum: MAX_SKILL_LINES, default: DEFAULT_SKILL_LINES, description: 'Keep only the first N lines.' },
            },
          },
        })
      }
      return list
    },

    async callTool(name, args, { signal } = {}) {
      const tools = await visibleTools()
      const known = tools.some((tool) => tool.name === name)
      if (!known && needsSkillTool(tools)) {
        if (name === settings.skillToolName) return callSkillTool(args)
        if (name === settings.skillReadToolName) return callSkillRead(args)
      }
      if (!known) {
        return {
          content: [{
            type: 'text',
            text: `Error: unknown tool "${name}". Available: ${tools.map((tool) => tool.name).join(', ') || '(none)'}`,
          }],
          isError: true,
        }
      }
      const service = toolsService()
      if (service === undefined || typeof service.execute !== 'function') {
        return { content: [{ type: 'text', text: 'Error: the tools service is unavailable' }], isError: true }
      }
      counter += 1
      const callId = `acp-mcp-${counter}`
      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(new Error(`tool "${name}" exceeded the ${settings.timeoutMs}ms MCP budget`)),
        settings.timeoutMs,
      )
      timer.unref?.()
      // The agent may abandon the answer; that abort must reach the tool, which
      // is the only thing that can actually stop the work.
      const onOuterAbort = () => controller.abort(signal.reason ?? new Error('cancelled by the MCP client'))
      if (signal !== undefined) {
        if (signal.aborted) onOuterAbort()
        else signal.addEventListener('abort', onOuterAbort, { once: true })
      }
      const startedAt = Date.now()
      try {
        const result = await service.execute({
          name,
          arguments: args ?? {},
          callId,
          signal: controller.signal,
          ...(agent() === undefined ? {} : { agent: agent() }),
        })
        log?.trace('mcp tool call', {
          name,
          callId,
          isError: result?.isError === true,
          elapsedMs: Date.now() - startedAt,
          scoped: agent() !== undefined,
        })
        return {
          content: resultToMcp(result, settings.maxResultBytes),
          ...(result?.isError === true ? { isError: true } : {}),
        }
      } catch (error) {
        log?.trace('mcp tool call threw', { name, message: String(error?.message ?? error) })
        return { content: [{ type: 'text', text: `Error: ${String(error?.message ?? error)}` }], isError: true }
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onOuterAbort)
      }
    },

    async listPrompts() {
      if (!settings.prompts) return []
      // Prompts are a human surface (clients render them as slash commands), so
      // they follow `userInvocable`, not the model catalog's flag.
      const summaries = (await skillSummaries({ forPrompts: true })) ?? []
      return summaries.slice(0, MAX_SKILLS_LISTED).map((entry) => ({
        name: entry.name,
        description: entry.description,
        arguments: [],
      }))
    },

    async getPrompt(name) {
      if (!settings.prompts) return undefined
      const loaded = await loadSkill(name, { forPrompts: true })
      if (loaded.error !== undefined) return undefined
      return {
        description: loaded.skill.description,
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: truncateContent([{ type: 'text', text: skillDocument(loaded.skill) }], settings.skillMaxBytes)[0].text,
          },
        }],
      }
    },

    async listResources() {
      if (!settings.resources) return []
      const summaries = (await skillSummaries()) ?? []
      const resources = summaries.slice(0, MAX_SKILLS_LISTED).map((entry) => ({
        uri: `dsh://skill/${encodeURIComponent(entry.name)}`,
        name: entry.name,
        description: entry.description,
        mimeType: 'text/markdown',
      }))
      resources.push({
        uri: 'dsh://session',
        name: 'session',
        description: 'JSON summary of the DeepSeek Harness session hosting this agent.',
        mimeType: 'application/json',
      })
      return resources
    },

    async listResourceTemplates() {
      if (!settings.resources) return []
      return [{
        uriTemplate: 'dsh://file/{+path}',
        name: 'workspace-file',
        description: 'Read a UTF-8 file under this session\'s working directory.',
        mimeType: 'text/plain',
      }]
    },

    async readResource(uri) {
      if (uri === 'dsh://session') {
        const tools = await visibleTools()
        const summaries = (await skillSummaries()) ?? []
        return [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({
            agent: config.id,
            cwd: cwd() ?? null,
            scoped: agent() !== undefined,
            tools: tools.map((tool) => tool.name),
            skills: summaries.slice(0, MAX_SKILLS_LISTED).map((entry) => entry.name),
            skillsListed: Math.min(summaries.length, MAX_SKILLS_LISTED),
            skillsTotal: summaries.length,
          }, null, 2),
        }]
      }
      if (uri.startsWith('dsh://skill/')) {
        const name = decodeURIComponent(uri.slice('dsh://skill/'.length))
        const loaded = await loadSkill(name)
        if (loaded.error !== undefined) throw new McpError(loaded.error, MCP_ERRORS.invalidParams)
        const text = skillDocument(loaded.skill)
        return [{ uri, mimeType: 'text/markdown', text: truncateContent([{ type: 'text', text }], settings.skillMaxBytes)[0].text }]
      }
      if (uri.startsWith('dsh://file/')) {
        const file = decodeURIComponent(uri.slice('dsh://file/'.length))
        try {
          return [{ uri, mimeType: 'text/plain', text: await readTextResource(file, cwd()) }]
        } catch (error) {
          // A bad target is the caller's mistake, not an internal failure.
          throw new McpError(String(error?.message ?? error), MCP_ERRORS.invalidParams)
        }
      }
      throw new McpError(`unknown resource "${uri}"`, MCP_ERRORS.invalidParams)
    },
  }
}
