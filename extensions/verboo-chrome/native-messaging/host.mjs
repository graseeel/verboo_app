#!/usr/bin/env node
/**
 * host.mjs — Native Messaging host for the Verboo Chrome extension.
 *
 * Chrome spawns this process when the extension calls
 * `chrome.runtime.connectNative('com.verboo.code.browser_extension')`.
 * The host reads framed JSON messages from stdin (4-byte little-endian
 * length prefix + UTF-8 JSON payload) and writes framed JSON responses
 * to stdout.
 *
 * In P4 this host is a thin relay: it forwards `browserTool` messages
 * to the Verboo Code Desktop (Tauri) process over a local IPC channel
 * (Unix domain socket on macOS/Linux, named pipe on Windows) and
 * relays the desktop's response back to the extension. The Desktop side
 * is implemented in `src-tauri/src/services/chrome_bridge.rs`.
 *
 * Until the Desktop bridge ships, the host echoes `ping` and `desktopStatus`
 * and returns a `desktop_unavailable` error for `browserTool` so the
 * extension can degrade gracefully (local heuristic agent loop).
 *
 * Message protocol (reuses `src/controller/protocol.js` MSG enum):
 *   - { type: 'ping' }                              → { type: 'pong' }
 *   - { type: 'desktopStatus' }                     → { type: 'desktopStatus', connected: boolean }
 *   - { type: 'browserTool', tool: ToolCall }       → { type: 'browserTool', result: ToolResult }
 *
 * Multi-user: zero hardcoded paths. The Desktop IPC path is resolved
 * from the VERBOO_DESKTOP_IPC env var (set by the install script or
 * the Desktop app on launch). No personal paths in this file.
 *
 * @typedef {import('../src/controller/protocol.js').ToolCall} ToolCall
 * @typedef {import('../src/controller/protocol.js').ToolResult} ToolResult
 */

import { Buffer } from 'node:buffer'
import { connect } from 'node:net'
import { platform } from 'node:os'

const HOST_NAME = 'com.verboo.code.browser_extension'
const IPC_ENV = 'VERBOO_DESKTOP_IPC'
const MAX_MESSAGE_BYTES = 1 << 24 // 16 MiB — Chrome's native messaging cap

// ── Framed stdin/stdout ──────────────────────────────────────

/**
 * Read a single framed message from stdin.
 * Chrome's native messaging framing: 4-byte LE length + UTF-8 JSON.
 * @returns {Promise<object | null>} null on EOF
 */
async function readMessage() {
  const header = await readExact(4)
  if (header === null) return null
  const length = header.readUInt32LE(0)
  if (length === 0) return {}
  if (length > MAX_MESSAGE_BYTES) {
    throw new Error(`message too large: ${length} bytes`)
  }
  const body = await readExact(length)
  if (body === null) return null
  return JSON.parse(body.toString('utf8'))
}

/**
 * Read exactly `n` bytes from stdin. Returns null on EOF.
 * @param {number} n
 * @returns {Promise<Buffer | null>}
 */
function readExact(n) {
  return new Promise((resolve) => {
    let chunks = []
    let remaining = n
    const onData = (chunk) => {
      if (remaining <= 0) return
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining))
        remaining = 0
        // Push back the rest — stdin is a stream we keep reading.
        process.stdin.unshift(chunk.subarray(remaining))
      } else {
        chunks.push(chunk)
        remaining -= chunk.length
      }
      if (remaining === 0) {
        process.stdin.removeListener('data', onData)
        process.stdin.removeListener('end', onEnd)
        process.stdin.pause()
        resolve(Buffer.concat(chunks))
      }
    }
    const onEnd = () => {
      process.stdin.removeListener('data', onData)
      resolve(remaining === n ? null : Buffer.concat(chunks))
    }
    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    process.stdin.resume()
  })
}

/**
 * Write a framed message to stdout.
 * @param {object} message
 */
function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  process.stdout.write(Buffer.concat([header, body]))
}

// ── Desktop IPC (P4 stub) ────────────────────────────────────

/**
 * Resolve the Desktop IPC path from the environment.
 * @returns {string | null}
 */
function resolveDesktopIpcPath() {
  const env = process.env[IPC_ENV]
  if (env && typeof env === 'string' && env.trim()) return env.trim()
  // Default per-platform path — multi-user, $HOME-relative.
  // The Desktop app creates this socket on launch.
  const home = process.env.HOME || process.env.USERPROFILE
  if (!home) return null
  if (platform() === 'win32') {
    return `\\\\.\\pipe\\verboo-desktop-browser-bridge`
  }
  return `${home}/.verboo/browser-bridge.sock`
}

/**
 * Forward a `browserTool` message to the Desktop and await its response.
 * @param {ToolCall} tool
 * @returns {Promise<ToolResult>}
 */
async function forwardToDesktop(tool) {
  const path = resolveDesktopIpcPath()
  if (!path) {
    return {
      toolCallId: tool?.id ?? '',
      success: false,
      error: 'desktop_ipc_path_unset',
      durationMs: 0,
    }
  }
  return new Promise((resolve) => {
    const socket = connect(path)
    const timeout = setTimeout(() => {
      socket.destroy()
      resolve({
        toolCallId: tool?.id ?? '',
        success: false,
        error: 'desktop_timeout',
        durationMs: 0,
      })
    }, 5000)
    socket.on('error', (err) => {
      clearTimeout(timeout)
      resolve({
        toolCallId: tool?.id ?? '',
        success: false,
        error: `desktop_unavailable:${err?.code ?? err?.message ?? 'unknown'}`,
        durationMs: 0,
      })
    })
    socket.on('connect', () => {
      const body = Buffer.from(JSON.stringify({ type: 'browserTool', tool }), 'utf8')
      const header = Buffer.alloc(4)
      header.writeUInt32LE(body.length, 0)
      socket.write(Buffer.concat([header, body]))
    })
    socket.on('data', (chunk) => {
      clearTimeout(timeout)
      try {
        const response = JSON.parse(chunk.toString('utf8'))
        resolve(response?.result ?? {
          toolCallId: tool?.id ?? '',
          success: false,
          error: 'desktop_malformed_response',
          durationMs: 0,
        })
      } catch (err) {
        resolve({
          toolCallId: tool?.id ?? '',
          success: false,
          error: `desktop_parse_error:${err?.message ?? 'unknown'}`,
          durationMs: 0,
        })
      } finally {
        socket.destroy()
      }
    })
  })
}

// ── Main loop ───────────────────────────────────────────────

async function main() {
  while (true) {
    let message
    try {
      message = await readMessage()
    } catch (err) {
      process.stderr.write(`[verboo-host] read error: ${err?.message ?? err}\n`)
      // On read error, exit — Chrome will respawn on next connectNative.
      process.exit(1)
    }
    if (message === null) {
      // EOF — Chrome disconnected. Exit cleanly.
      process.exit(0)
    }

    switch (message.type) {
      case 'ping':
        writeMessage({ type: 'pong' })
        break
      case 'desktopStatus': {
        const path = resolveDesktopIpcPath()
        if (!path) {
          writeMessage({ type: 'desktopStatus', connected: false, reason: 'ipc_path_unset' })
          break
        }
        // Probe the socket without sending a tool call.
        const socket = connect(path)
        let settled = false
        const timeout = setTimeout(() => {
          if (settled) return
          settled = true
          socket.destroy()
          writeMessage({ type: 'desktopStatus', connected: false, reason: 'timeout' })
        }, 1000)
        socket.on('error', () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          writeMessage({ type: 'desktopStatus', connected: false, reason: 'desktop_not_running' })
        })
        socket.on('connect', () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          socket.destroy()
          writeMessage({ type: 'desktopStatus', connected: true })
        })
        break
      }
      case 'browserTool': {
        const result = await forwardToDesktop(message.tool)
        writeMessage({ type: 'browserTool', result })
        break
      }
      default:
        writeMessage({ type: 'error', error: `unknown_message_type:${message.type}` })
    }
  }
}

main().catch((err) => {
  process.stderr.write(`[verboo-host] fatal: ${err?.message ?? err}\n`)
  process.exit(1)
})
