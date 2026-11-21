// The HTTP carrier for the MCP server.
//
// Each ACP session gets its own token and its own surface, because the surface
// is scoped to the DSH agent and working directory of that session. The token is
// the only credential: it travels in the URL for the stdio shim and in an
// Authorization header for a direct HTTP client, and it is never written to the
// log in full.
//
// The listener binds to loopback on an OS-assigned port and starts lazily on the
// first session that needs it, so a profile that never opens an ACP session
// never opens a socket.

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { MCP_ERRORS, McpServer, mcpError } from './mcp.js'

const MAX_BODY_BYTES = 8 * 1024 * 1024

/** A fresh opaque capability token: the only thing that authorizes an MCP peer. */
function createToken() {
  return randomUUID().replace(/-/g, '')
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body over ${MAX_BODY_BYTES} bytes`))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function send(response, status, payload, extraHeaders = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  response.end(body)
}

/** Constant-time-ish comparison for capability tokens. */
function sameToken(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return diff === 0
}

function isLoopback(address) {
  if (typeof address !== 'string') return false
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

export class McpGateway {
  #log
  #servers = new Map()
  #server
  #port
  #starting

  constructor({ log }) {
    this.#log = log
  }

  get port() {
    return this.#port
  }

  get origin() {
    return this.#port === undefined ? undefined : `http://127.0.0.1:${this.#port}`
  }

  /**
   * Register one ACP session's MCP endpoint.
   *
   * @returns `{ token, url, header }` where `url` is the full endpoint and
   *   `header` is the ready-made Authorization value.
   */
  endpointFor({ surface, serverInfo, context }) {
    const token = createToken()
    const server = new McpServer({ surface, serverInfo, log: this.#log })
    this.#servers.set(token, { server, context })
    return {
      token,
      path: `/mcp/${token}`,
      header: `Bearer ${token}`,
      release: () => this.#servers.delete(token),
    }
  }

  async start() {
    if (this.#port !== undefined) return this.#port
    if (this.#starting !== undefined) return this.#starting
    this.#starting = new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => {
        this.#onRequest(request, response).catch((error) => {
          this.#log?.trace('mcp http handler failed', String(error?.message ?? error))
          try {
            send(response, 500, mcpError(null, MCP_ERRORS.internal, String(error?.message ?? error)))
          } catch {}
        })
      })
      server.on('error', (error) => {
        this.#starting = undefined
        reject(error)
      })
      server.listen(0, '127.0.0.1', () => {
        this.#server = server
        this.#port = server.address().port
        this.#log?.trace('mcp gateway listening', { port: this.#port })
        resolve(this.#port)
      })
      server.unref?.()
    })
    return this.#starting
  }

  async #onRequest(request, response) {
    // The listener is bound to loopback, so a non-loopback peer means something
    // forwarded the connection; refuse rather than trust the token alone.
    if (!isLoopback(request.socket.remoteAddress)) {
      send(response, 403, mcpError(null, MCP_ERRORS.invalidRequest, 'the MCP endpoint accepts loopback peers only'))
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const token = url.pathname.startsWith('/mcp/') ? url.pathname.slice('/mcp/'.length) : undefined
    const entry = token === undefined ? undefined : this.#servers.get(token)
    if (entry === undefined) {
      send(response, 404, mcpError(null, MCP_ERRORS.invalidRequest, 'unknown MCP endpoint'))
      return
    }
    const header = request.headers.authorization
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined
    const presented = bearer ?? url.searchParams.get('token') ?? undefined
    if (!sameToken(presented ?? '', token)) {
      send(response, 401, mcpError(null, MCP_ERRORS.invalidRequest, 'missing or invalid MCP token'))
      return
    }

    if (request.method !== 'POST') {
      // No server-initiated stream and no resumable session: both are optional.
      send(response, 405, mcpError(null, MCP_ERRORS.invalidRequest, 'only POST is supported'), { allow: 'POST' })
      return
    }

    const body = await readBody(request)
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch (error) {
      send(response, 400, mcpError(null, MCP_ERRORS.parse, `parse error: ${String(error?.message ?? error)}`))
      return
    }

    const messages = Array.isArray(parsed) ? parsed : [parsed]
    const replies = []
    for (const message of messages) {
      const reply = await entry.server.handle(message)
      if (reply !== undefined) replies.push(reply)
    }
    if (replies.length === 0) {
      // Notifications only: 202 with no body is the specified acknowledgement.
      response.writeHead(202, { 'content-length': '0', 'cache-control': 'no-store' })
      response.end()
      return
    }
    send(response, 200, Array.isArray(parsed) ? replies : replies[0])
  }

  async dispose() {
    this.#servers.clear()
    const server = this.#server
    this.#server = undefined
    this.#port = undefined
    this.#starting = undefined
    if (server !== undefined) {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(() => resolve()))
    }
  }
}

export { isLoopback }
