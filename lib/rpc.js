// Newline-delimited JSON-RPC 2.0 over a child process's stdio.
//
// ACP is JSON-RPC with no framing beyond one JSON object per line, so this
// transport is deliberately small: it owns request correlation, timeouts,
// cancellation of in-flight requests, inbound agent→client requests, and the
// observable event stream a session needs. Malformed stdout lines are kept as
// diagnostics instead of killing the connection, because agents commonly log
// to stdout before the handshake.

import { EventEmitter } from 'node:events'

export class AcpRpcError extends Error {
  constructor(message, { code, data, method } = {}) {
    super(message)
    this.name = 'AcpRpcError'
    this.code = code ?? 'ACP_RPC'
    this.rpcCode = code
    this.data = data
    this.method = method
  }
}

export class AcpTimeoutError extends AcpRpcError {
  constructor(method, timeoutMs) {
    super(`ACP request "${method}" timed out after ${timeoutMs}ms`, { code: 'ACP_TIMEOUT', method })
    this.name = 'AcpTimeoutError'
  }
}

const MAX_LINE_BYTES = 8 * 1_048_576
// Five minutes: generous for a handler that waits on a human, but bounded so an
// agent's tool call always gets an answer.
const DEFAULT_INBOUND_TIMEOUT_MS = 300_000

/**
 * Await `promise`, but settle with a timeout error after `ms`.
 *
 * The handler itself is not cancelled — it has no signal — so this only bounds
 * how long the *agent* waits, which is the thing that wedges a turn.
 */
function withDeadline(promise, ms, message, log) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      log?.push('trace', message)
      reject(new AcpRpcError(message, { code: 'ACP_INBOUND_TIMEOUT' }))
    }, ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * One JSON-RPC connection bound to a child process's stdio pipes.
 *
 * Events: `notification` ({method, params}), `request` ({method, params, id}),
 * `unparsed` (string), `error` (Error), `close`.
 */
export class AcpConnection extends EventEmitter {
  #child
  #onLine
  #onExit
  #buffer = ''
  #nextId = 1
  #pending = new Map()
  #closed = false
  #requestHandlers = new Map()
  #log
  #inboundTimeoutMs = DEFAULT_INBOUND_TIMEOUT_MS

  constructor({ child, log, inboundTimeoutMs } = {}) {
    super()
    this.#child = child
    this.#log = log
    if (Number.isFinite(inboundTimeoutMs)) this.#inboundTimeoutMs = inboundTimeoutMs
    this.exit = new Promise((resolve) => {
      this.#onExit = resolve
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve({ code: child.exitCode, signal: child.signalCode })
      }
    })

    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    this.#onLine = (chunk) => this.#ingest(chunk)
    child.stdout?.on('data', this.#onLine)
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk)
      this.#log?.push('stderr', text)
      this.emit('stderr', text)
    })
    child.on('exit', (code, signal) => {
      this.#closed = true
      this.#failAll(new AcpRpcError(`ACP agent exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`, { code: 'ACP_EXITED' }))
      this.#onExit({ code, signal })
      this.emit('close', { code, signal })
    })
    child.on('error', (error) => {
      this.#log?.push('trace', `child error: ${String(error?.message ?? error)}`)
      this.emit('error', error)
      this.#closed = true
      this.#failAll(new AcpRpcError(`ACP agent process error: ${String(error?.message ?? error)}`, { code: 'ACP_PROCESS' }))
    })
  }

  get closed() {
    return this.#closed
  }

  get pendingCount() {
    return this.#pending.size
  }

  /** Register the handler for one agent→client request method. */
  onRequest(method, handler) {
    this.#requestHandlers.set(method, handler)
    return () => this.#requestHandlers.delete(method)
  }

  #ingest(chunk) {
    this.#buffer += chunk
    if (this.#buffer.length > MAX_LINE_BYTES) {
      this.#log?.push('trace', 'stdout buffer exceeded the line limit; dropping it')
      this.#buffer = ''
      return
    }
    let index
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).replace(/\r$/, '')
      this.#buffer = this.#buffer.slice(index + 1)
      if (line.trim() === '') continue
      this.#dispatch(line)
    }
  }

  #dispatch(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.#log?.push('stdout', line)
      this.emit('unparsed', line)
      return
    }
    if (message === null || typeof message !== 'object') {
      this.#log?.push('stdout', line)
      this.emit('unparsed', line)
      return
    }
    this.#log?.push('in', line)
    if (typeof message.method === 'string') {
      if (message.id !== undefined && message.id !== null) {
        void this.#handleRequest(message)
      } else {
        this.emit('notification', { method: message.method, params: message.params })
      }
      return
    }
    if (message.id !== undefined && message.id !== null) {
      this.#settle(message)
      return
    }
    this.emit('unparsed', line)
  }

  #settle(message) {
    const pending = this.#pending.get(message.id)
    if (pending === undefined) return
    this.#pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error !== undefined && message.error !== null) {
      const error = message.error
      pending.reject(new AcpRpcError(
        typeof error.message === 'string' && error.message !== '' ? error.message : 'ACP request failed',
        { code: typeof error.code === 'number' ? `ACP_${error.code}` : 'ACP_RPC', data: error.data, method: pending.method },
      ))
      return
    }
    pending.resolve(message.result ?? {})
  }

  async #handleRequest(message) {
    const method = message.method
    const handler = this.#requestHandlers.get(method)
    if (handler === undefined) {
      this.#log?.push('trace', `unhandled agent request "${method}"`)
      this.#write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${method}` } })
      return
    }
    this.emit('request', { method, params: message.params, id: message.id })
    try {
      // An agent→client request must not be able to wedge the agent forever. The
      // current handlers answer synchronously, so this is insurance for the day
      // one of them waits on a human — but without it, that change would hang a
      // tool call with no log entry at all.
      const result = this.#inboundTimeoutMs > 0
        ? await withDeadline(
          handler(message.params, { id: message.id, method }),
          this.#inboundTimeoutMs,
          `agent request "${method}" was abandoned after ${this.#inboundTimeoutMs}ms`,
          this.#log,
        )
        : await handler(message.params, { id: message.id, method })
      this.#write({ jsonrpc: '2.0', id: message.id, result: result ?? {} })
    } catch (error) {
      const text = String(error?.message ?? error)
      this.#log?.push('trace', `agent request "${method}" failed: ${text}`)
      // The agent can only act on what it is told: forwarding our own code in
      // `data` is what turns a bare -32603 into "that path escaped the session".
      this.#write({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: text,
          ...(typeof error?.code === 'string' ? { data: { code: error.code, message: text } } : {}),
        },
      })
    }
  }

  #write(message) {
    if (this.#closed || this.#child.stdin === null || this.#child.stdin === undefined) return false
    const line = JSON.stringify(message)
    this.#log?.push('out', line)
    try {
      this.#child.stdin.write(`${line}\n`)
      return true
    } catch (error) {
      this.#log?.push('trace', `stdin write failed: ${String(error?.message ?? error)}`)
      return false
    }
  }

  notify(method, params) {
    return this.#write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  /**
   * Send one request and await its result.
   *
   * `signal` cancels only the caller's interest: the wire request stays
   * correlated, so a late result cannot be mistaken for another call.
   */
  request(method, params, { timeoutMs, signal } = {}) {
    if (this.#closed) {
      return Promise.reject(new AcpRpcError(`cannot send "${method}": the ACP agent is not running`, { code: 'ACP_NOT_RUNNING', method }))
    }
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.#pending.delete(id)
        fn(value)
      }
      const timer = timeoutMs === undefined || timeoutMs <= 0
        ? undefined
        : setTimeout(() => {
            this.#pending.delete(id)
            finish(reject, new AcpTimeoutError(method, timeoutMs))
          }, timeoutMs)
      timer?.unref?.()
      const onAbort = () => finish(reject, signal?.reason ?? new AcpRpcError(`ACP request "${method}" was cancelled`, { code: 'ACP_CANCELLED', method }))
      if (signal !== undefined) {
        if (signal.aborted) {
          finish(reject, signal.reason ?? new AcpRpcError(`ACP request "${method}" was cancelled`, { code: 'ACP_CANCELLED', method }))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.#pending.set(id, { resolve: (value) => finish(resolve, value), reject: (error) => finish(reject, error), method, timer })
      if (!this.#write({ jsonrpc: '2.0', id, method, params })) {
        finish(reject, new AcpRpcError(`cannot send "${method}": the ACP agent stdin is closed`, { code: 'ACP_NOT_RUNNING', method }))
      }
    })
  }

  #failAll(error) {
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(new AcpRpcError(error.message, { code: error.code, method: pending.method }))
    }
  }

  /** Stop reading and fail anything outstanding; the caller kills the child. */
  dispose() {
    this.#closed = true
    this.#failAll(new AcpRpcError('the ACP connection was closed', { code: 'ACP_CLOSED' }))
    try { this.#child.stdout?.off('data', this.#onLine) } catch {}
    this.removeAllListeners()
  }
}
