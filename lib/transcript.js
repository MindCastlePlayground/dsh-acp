// Project a DSH model call onto an ACP prompt.
//
// ACP reverses the usual shape: the *agent* owns the conversation, not the
// client. `session/prompt` carries only the new turn, and the agent replays its
// own history. DSH, meanwhile, rebuilds the whole transcript for every call.
// This module reconciles the two:
//
//  * a call whose messages extend exactly the transcript already sent reuses the
//    ACP session and forwards only the new user turn;
//  * any other call (edited history, regenerated turn, different system prompt)
//    opens a fresh ACP session and sends the transcript as one prompt, because
//    an agent cannot un-see a turn it was already given.

import { createHash } from 'node:crypto'

/** Text of one message's content blocks, in order. */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool-call') {
      parts.push(`[tool call ${block.name ?? block.id ?? 'unknown'}] ${typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})}`)
    } else if (block.type === 'tool-result') {
      const text = typeof block.content === 'string' ? block.content : textOfContent(block.content)
      parts.push(`[tool result ${block.toolCallId ?? block.name ?? ''}] ${text}`)
    } else if (block.type === 'image') {
      parts.push('[image omitted: the ACP agent reads images from the prompt it received, not from DSH attachments]')
    } else if (block.type === 'file') {
      parts.push(`[file ${block.name ?? block.attachment?.name ?? 'attachment'}]`)
    }
  }
  return parts.join('\n')
}

const ROLE_LABEL = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
  developer: 'Developer',
  tool: 'Tool',
}

/**
 * Flatten a call into ordered segments: system text first, then the
 * conversation. Each segment keeps the source message index so a later call can
 * prove it is extending the same prefix.
 */
export function projectCall(options, { includeToolActivity = true } = {}) {
  const system = []
  if (typeof options.system === 'string' && options.system.trim() !== '') system.push(options.system)

  const messages = Array.isArray(options.messages) ? options.messages : []
  const segments = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message === null || typeof message !== 'object') continue
    const role = typeof message.role === 'string' ? message.role : 'user'
    const text = textOfContent(message.content).trim()
    if (role === 'system' || role === 'developer') {
      if (text !== '') system.push(text)
      continue
    }
    if (text === '') continue
    if (role === 'tool' && !includeToolActivity) continue
    segments.push({ index, role, text })
  }
  return { system: system.join('\n\n'), segments }
}

/** Stable digest of the conversation prefix that decides session reuse. */
export function fingerprint(segments) {
  const hash = createHash('sha256')
  for (const segment of segments) {
    hash.update(segment.role)
    hash.update('\u0000')
    hash.update(segment.text)
    hash.update('\u0001')
  }
  return hash.digest('hex')
}

/** Render the transcript for a fresh ACP session, newest turn last. */
export function renderTranscript(segments, { maxChars = 400_000, system = '' } = {}) {
  const parts = []
  if (system !== '') parts.push(`# System\n\n${system}`)
  parts.push('# Conversation\n')
  let budget = maxChars
  const rendered = []
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i]
    const chunk = `## ${ROLE_LABEL[segment.role] ?? segment.role}\n\n${segment.text}\n`
    if (chunk.length > budget) {
      // Keep the newest turns whole; older history degrades to a marker rather
      // than being cut mid-sentence.
      if (rendered.length === 0) rendered.push(`${chunk.slice(0, Math.max(0, budget))}\n[…truncated…]\n`)
      else rendered.push(`## ${ROLE_LABEL[segment.role] ?? segment.role}\n\n[earlier turn omitted to fit the prompt budget]\n`)
      budget = 0
      continue
    }
    rendered.push(chunk)
    budget -= chunk.length
  }
  parts.push(...rendered.reverse())
  return parts.join('\n')
}

/**
 * Decide how to talk to the agent for this call.
 *
 * @returns {{ mode: 'delta'|'fresh', prompt: string, sentCount: number }}
 */
export function planPrompt(options, previous, { includeToolActivity = true, maxChars = 400_000 } = {}) {
  const projection = projectCall(options, { includeToolActivity })
  const { segments } = projection
  const digest = fingerprint(segments)

  if (previous !== undefined && previous.system === projection.system) {
    const { segments: sentSegments } = previous
    const extendsPrefix = segments.length > sentSegments.length
      && sentSegments.every((segment, index) => segments[index].role === segment.role && segments[index].text === segment.text)
    if (extendsPrefix) {
      // The agent already owns everything up to `sentCount`, including the
      // assistant turn it produced, so only the new user input is forwarded.
      const delta = segments.slice(sentSegments.length)
        .filter((segment) => segment.role === 'user' || segment.role === 'tool')
        .map((segment) => segment.text)
        .join('\n\n')
      if (delta.trim() !== '') {
        return { mode: 'delta', prompt: delta, sentCount: segments.length, projection, digest }
      }
    }
  }
  return {
    mode: 'fresh',
    prompt: renderTranscript(segments, { maxChars, system: projection.system }),
    sentCount: segments.length,
    projection,
    digest,
  }
}
