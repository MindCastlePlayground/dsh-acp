// Process helpers shared by the ACP supervisor.
//
// Windows needs two accommodations: a batch wrapper (`opencode.cmd`) cannot be
// spawned without a shell, and a child that owns grandchildren (the ACP agent
// usually boots a server) can only be removed with `taskkill /T /F`.

import { execFile, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    function onAbort() {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const NEEDS_QUOTE_RE = /[\s"&<>|^%()]/

export function quoteToken(token) {
  if (token === '') return '""'
  if (!NEEDS_QUOTE_RE.test(token)) return token
  return `"${token.replace(/"/g, '\\"')}"`
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * Find the real launcher for a bare command name.
 *
 * Node's `spawn` resolves `PATH` but not `PATHEXT`, so a bare `opencode` on
 * Windows never finds `opencode.cmd` and fails with ENOENT. Resolving here also
 * tells the caller which shell it needs: a `.cmd`/`.bat` wrapper must run
 * through a shell, an `.exe` must not.
 *
 * @returns {{ command: string, fromPath: boolean }}
 */
export function resolveExecutable(command, { env = process.env, platform = process.platform } = {}) {
  // An explicit path is the caller's decision; do not second-guess it.
  if (command.includes('/') || command.includes('\\') || /^[A-Za-z]:/.test(command)) {
    return { command, fromPath: false }
  }
  const pathValue = env.PATH ?? env.Path ?? env.path ?? ''
  const dirs = pathValue.split(platform === 'win32' ? ';' : ':').filter((dir) => dir !== '')
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '').map((ext) => ext.toLowerCase())
    : ['']
  const hasExtension = platform === 'win32' && extensions.some((ext) => command.toLowerCase().endsWith(ext))
  for (const dir of dirs) {
    const base = path.join(dir, command)
    if (hasExtension) {
      if (isFile(base)) return { command: base, fromPath: true }
      continue
    }
    if (platform !== 'win32') {
      if (isFile(base)) return { command: base, fromPath: true }
      continue
    }
    for (const ext of extensions) {
      const candidate = `${base}${ext}`
      if (isFile(candidate)) return { command: candidate, fromPath: true }
    }
  }
  return { command, fromPath: false }
}

/**
 * Decide how to hand a command to `child_process.spawn`.
 *
 * `auto` asks for a shell only where Node refuses a direct spawn: a Windows
 * `.cmd`/`.bat` wrapper. Everywhere else the exact argv is preserved, because a
 * shell would reparse quotes and globs that belong to the agent.
 */
export function resolveSpawnSpec({ command, args, shell }, { env = process.env, platform = process.platform } = {}) {
  const resolved = resolveExecutable(command, { env, platform })
  const batchWrapper = platform === 'win32' && /\.(cmd|bat)$/i.test(resolved.command)
  const useShell = shell === 'always' || (shell !== 'never' && batchWrapper)
  if (useShell) {
    return { command: [resolved.command, ...args].map(quoteToken).join(' '), args: [], shell: true }
  }
  return { command: resolved.command, args: [...args], shell: false }
}

function runTaskkill(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
  })
}

/**
 * Agents spawned by this process, so a host exit does not orphan them.
 *
 * A host crash cannot run `killTree` — nothing is left to await it — so the only
 * workable answer is a synchronous last-gasp hook. Without one, every crashed
 * session leaves an agent process (and the server it booted) holding a port and
 * burning CPU until someone notices.
 */
const liveChildPids = new Set()
let reaperArmed = false

function reapLiveChildrenSync() {
  for (const pid of liveChildPids) {
    try {
      if (process.platform === 'win32') {
        // `execFileSync` is not usable here: the exit hook may run while the
        // event loop is already tearing down. A detached-less `spawnSync` with
        // ignored stdio is the only call guaranteed to complete.
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } else {
        try { process.kill(pid, 'SIGKILL') } catch {}
      }
    } catch {}
  }
  liveChildPids.clear()
}

/**
 * Track a spawned agent so it cannot outlive this process.
 *
 * @returns {() => void} an untracker, for a child that exited on its own.
 */
export function trackAgentChild(child) {
  const pid = child?.pid
  if (pid === undefined) return () => {}
  liveChildPids.add(pid)
  if (!reaperArmed) {
    reaperArmed = true
    // `exit` is the only hook that runs on both a clean quit and an uncaught
    // throw; signal handlers would change the host's own disposition, so they
    // are deliberately not installed here.
    process.once('exit', reapLiveChildrenSync)
  }
  const forget = () => { liveChildPids.delete(pid) }
  child.once('exit', forget)
  child.once('close', forget)
  return forget
}

/** Terminate a child and its descendants; resolves once the attempt settled. */
export async function killTree(child, { signalGraceMs = 3_000 } = {}) {
  if (child === undefined || child === null) return
  const pid = child.pid
  if (pid === undefined) {
    try { child.kill('SIGKILL') } catch {}
    return
  }
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    child.once('exit', () => resolve())
  })
  if (process.platform === 'win32') {
    await runTaskkill(pid)
  } else {
    try { child.kill('SIGTERM') } catch {}
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
    }, signalGraceMs)
    timer.unref?.()
    await Promise.race([exited, delay(signalGraceMs + 1_000).catch(() => {})])
    clearTimeout(timer)
    try { child.kill('SIGKILL') } catch {}
  }
  await Promise.race([exited, delay(5_000).catch(() => {})])
}
