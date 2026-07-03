import { constants, existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, join, sep } from 'node:path'

let cachedNodePath: string | undefined
let cachedIsElectron = false

// Pure, dependency-injected core so the fallback logic is testable without
// touching the real filesystem. Prefers a real system Node; when none exists,
// falls back to the Electron binary running in Node mode.
export async function resolveNodeRuntime(
  candidates: string[],
  electronPath: string,
  check: (path: string) => Promise<boolean>,
): Promise<{ path: string; isElectron: boolean }> {
  for (const candidate of candidates) {
    if (await check(candidate)) return { path: candidate, isElectron: false }
  }
  return { path: electronPath, isElectron: true }
}

export async function resolveNodeRuntimePath(): Promise<string> {
  if (cachedNodePath) return cachedNodePath

  // No system Node.js on this machine? Fall back to Electron's own bundled Node
  // runtime (process.execPath run with ELECTRON_RUN_AS_NODE) so the app works
  // for everyone — not just users who happen to have Node.js installed.
  // Escape hatch: VERBOO_FORCE_ELECTRON_NODE=1 ignores any system Node and forces
  // the bundled runtime (used to reproduce a "no Node installed" machine).
  const candidates = process.env.VERBOO_FORCE_ELECTRON_NODE === '1' ? [] : nodeRuntimeCandidates()
  const resolved = await resolveNodeRuntime(candidates, process.execPath, isExecutable)
  cachedNodePath = resolved.path
  cachedIsElectron = resolved.isElectron
  if (process.env.VERBOO_DEBUG_NODE === '1') {
    console.error(`[verboo:node] runtime=${resolved.isElectron ? 'electron-bundled' : resolved.path}`)
  }
  return cachedNodePath
}

export function createNodeRuntimeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  if (cachedIsElectron) {
    // The runtime is the Electron binary — it only behaves as Node with this
    // flag set, and the CLI's own child processes (spawned via process.execPath)
    // must inherit it so they run as Node too.
    env.ELECTRON_RUN_AS_NODE = '1'
  } else {
    delete env.ELECTRON_RUN_AS_NODE
  }
  return env
}

export function resolveExternalNodePath(filePath: string): string {
  const asarMarker = `.asar${sep}`
  const asarIndex = filePath.indexOf(asarMarker)
  if (asarIndex === -1) return filePath

  const unpackedPath = `${filePath.slice(0, asarIndex)}.asar.unpacked${sep}${filePath.slice(asarIndex + asarMarker.length)}`
  return existsSync(unpackedPath) ? unpackedPath : filePath
}

function nodeRuntimeCandidates(): string[] {
  const envCandidates = [
    process.env.VERBOO_NODE_PATH,
    process.env.npm_node_execpath,
    process.env.NODE_BINARY,
    process.env.NODE,
  ]

  const pathCandidates = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map(pathDir => join(pathDir, 'node'))

  return uniquePaths([
    ...envCandidates,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    ...pathCandidates,
  ])
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const path of paths) {
    if (!path || seen.has(path)) continue
    seen.add(path)
    result.push(path)
  }
  return result
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
