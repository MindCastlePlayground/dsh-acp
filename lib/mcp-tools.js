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

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { truncateContent } from './mcp.js'

const MAX_RESOURCE_BYTES = 512 * 1024

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
 * agent can see"; excludes always win, so the default `acp_*` mask removes this
 * plugin's own controls even if a deployment widens `include`.
 */
export function selectTools(definitions, { include = [], exclude = [] } = {}) {
  const visible = include.length === 0
    ? definitions
    : definitions.filter((definition) => matchesAny(definition.name, include))
  return visible.filter((definition) => !matchesAny(definition.name, exclude))
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

async function readTextResource(file, cwd) {
  const base = cwd ?? process.cwd()
  const resolved = path.resolve(base, file)
  const relative = path.relative(base, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`refusing to read "${resolved}" outside the session directory "${base}"`)
  }
  const info = await stat(resolved)
  if (!info.isFile()) throw new Error(`"${resolved}" is not a file`)
  if (info.size > MAX_RESOURCE_BYTES) throw new Error(`"${resolved}" is ${info.size} bytes, over the ${MAX_RESOURCE_BYTES}-byte resource limit`)
  return readFile(resolved, 'utf8')
}

function skillDocument(skill) {
  const parts = [`<skill_content name="${skill.name}">`]
  if (typeof skill.description === 'string' && skill.description !== '') parts.push(skill.description)
  if (typeof skill.whenToUse === 'string' && skill.whenToUse !== '') parts.push(`When to use: ${skill.whenToUse}`)
  parts.push('<skill_instructions>', String(skill.content ?? ''), '</skill_instructions>', '</skill_content>')
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
    return selectTools(schemas ?? [], settings.tools)
  }

  async function skillSummaries() {
    if (!settings.skills && !settings.prompts) return []
    const skills = skillsService()
    if (skills === undefined) return []
    try {
      const listed = await skills.list(scopeOptions())
      return (listed ?? []).filter((entry) => entry?.invocation?.modelInvocable !== false)
    } catch (error) {
      log?.trace('mcp skills/list failed', String(error?.message ?? error))
      return []
    }
  }

  /** The generated skill tool exists only when a skill service and no real `skill` tool do. */
  function needsSkillTool(tools) {
    if (!settings.skills || skillsService() === undefined) return false
    const names = new Set(tools.map((tool) => tool.name))
    return !names.has(settings.skillToolName) && !names.has('skill')
  }

  async function callSkillTool(args) {
    const skills = skillsService()
    if (skills === undefined) return { content: [{ type: 'text', text: 'Error: this profile has no skill service' }], isError: true }
    const name = typeof args?.name === 'string' ? args.name : undefined
    if (name === undefined || name === '') {
      const summaries = await skillSummaries()
      if (summaries.length === 0) return { content: [{ type: 'text', text: 'No skills are available in this profile.' }] }
      const lines = summaries.map((entry) => `- ${entry.name}: ${entry.description ?? ''}`.trim())
      return { content: [{ type: 'text', text: `Available skills:\n${lines.join('\n')}` }] }
    }
    const skill = await skills.get(name, scopeOptions())
    if (skill === undefined) return { content: [{ type: 'text', text: `Error: unknown skill "${name}"` }], isError: true }
    return { content: [{ type: 'text', text: skillDocument(skill) }] }
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
          description: 'List or load a DeepSeek Harness skill. Call with no arguments to list skill names and descriptions, or with a name to load that skill\'s full instructions.',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', description: 'Exact skill name from the listing.' },
            },
          },
        })
      }
      return list
    },

    async callTool(name, args) {
      const tools = await visibleTools()
      const known = tools.some((tool) => tool.name === name)
      if (!known && name === settings.skillToolName && needsSkillTool(tools)) return callSkillTool(args)
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
      }
    },

    async listPrompts() {
      if (!settings.prompts) return []
      const summaries = await skillSummaries()
      return summaries.map((entry) => ({
        name: entry.name,
        description: entry.description,
        arguments: [],
      }))
    },

    async getPrompt(name) {
      if (!settings.prompts) return undefined
      const skills = skillsService()
      if (skills === undefined) return undefined
      const skill = await skills.get(name, scopeOptions())
      if (skill === undefined) return undefined
      return {
        description: skill.description,
        messages: [{ role: 'user', content: { type: 'text', text: skillDocument(skill) } }],
      }
    },

    async listResources() {
      if (!settings.resources) return []
      const summaries = await skillSummaries()
      const resources = summaries.map((entry) => ({
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
        return [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({
            agent: config.id,
            cwd: cwd() ?? null,
            scoped: agent() !== undefined,
            tools: tools.map((tool) => tool.name),
            skills: (await skillSummaries()).map((entry) => entry.name),
          }, null, 2),
        }]
      }
      if (uri.startsWith('dsh://skill/')) {
        const name = decodeURIComponent(uri.slice('dsh://skill/'.length))
        const skills = skillsService()
        const skill = skills === undefined ? undefined : await skills.get(name, scopeOptions())
        if (skill === undefined) throw new Error(`unknown skill "${name}"`)
        return [{ uri, mimeType: 'text/markdown', text: skillDocument(skill) }]
      }
      if (uri.startsWith('dsh://file/')) {
        const file = decodeURIComponent(uri.slice('dsh://file/'.length))
        return [{ uri, mimeType: 'text/plain', text: await readTextResource(file, cwd()) }]
      }
      throw new Error(`unknown resource "${uri}"`)
    },
  }
}
