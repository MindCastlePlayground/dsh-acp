#!/usr/bin/env node
// stdio MCP shim: the transport an ACP agent gets when it cannot speak HTTP MCP.
//
// The agent spawns this file as an MCP server, so it must read newline-delimited
// JSON-RPC on stdin and write replies on stdout — nothing else may touch stdout.
// Requests are forwarded to the Host's loopback endpoint, which is where the
// DSH tool registry actually lives; this process only relays bytes.
//
// Configuration comes from the environment the plugin sets on `session/new`:
//
//   DSH_ACP_MCP_URL    full endpoint, e.g. http://127.0.0.1:51234/mcp/<token>
//   DSH_ACP_MCP_TOKEN  capability token for that endpoint
//
// Exit codes are deliberately boring: an unreachable Host closes stdin's loop
// and the process ends, which the agent sees as a dead MCP server.

import readline from 'node:readline'

const url = process.env.DSH_ACP_MCP_URL ?? process.argv[2]
const token = process.env.DSH_ACP_MCP_TOKEN

if (!url || !token) {
  process.stderr.write('dsh-acp mcp-stdio: DSH_ACP_MCP_URL and DSH_ACP_MCP_TOKEN are required\n')
  process.exit(2)
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** Forward one message and return the Host's reply envelope, if any. */
async function forward(message) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(message),
  })
  if (response.status === 202) return undefined
  const text = await response.text()
  if (!response.ok) {
    return {
      jsonrpc: '2.0',
      id: message.id ?? null,
      error: { code: -32603, message: `dsh-acp mcp endpoint returned ${response.status}: ${text.slice(0, 400)}` },
    }
  }
  return text === '' ? undefined : JSON.parse(text)
}

// One request at a time keeps replies in order: an agent that pipelines calls
// still gets them answered deterministically.
let queue = Promise.resolve()
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  queue = queue.then(async () => {
    let message
    try {
      message = JSON.parse(text)
    } catch (error) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `parse error: ${String(error?.message ?? error)}` } })
      return
    }
    try {
      const reply = await forward(message)
      if (reply !== undefined) write(reply)
    } catch (error) {
      // Only a request with an id can be answered; a notification gets silence.
      if (message !== null && typeof message === 'object' && message.id !== undefined) {
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error?.message ?? error) } })
      }
      process.stderr.write(`dsh-acp mcp-stdio: ${String(error?.message ?? error)}\n`)
    }
  })
})

rl.on('close', () => {
  queue.then(() => process.exit(0), () => process.exit(1))
})
