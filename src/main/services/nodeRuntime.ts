import { constants, existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, join, sep } from 'node:path'

let cachedNodePath: string | undefined
let cachedIsElectron = false

// Pure, dependency-injected core so the fallback logic is testable without
// touching the real filesystem. In development it can use a system Node; in a
// packaged app it must use Electron's bundled Node so ESM can resolve packages
// inside app.asar.
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

  // In packaged macOS builds, external Node cannot read app.asar. Prefer the
  // bundled Electron runtime there; keep system Node available for local dev.
  const candidates = shouldUseBundledElectronNode() ? [] : nodeRuntimeCandidates()
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

export function resolvePackedJavaScriptEntryPath(filePath: string): string {
  const unpackedMarker = `.asar.unpacked${sep}`
  const unpackedIndex = filePath.indexOf(unpackedMarker)
  if (unpackedIndex === -1) return filePath

  const packedPath = `${filePath.slice(0, unpackedIndex)}.asar${sep}${filePath.slice(unpackedIndex + unpackedMarker.length)}`
  return existsSync(packedPath) ? packedPath : filePath
}

function shouldUseBundledElectronNode(): boolean {
  if (process.env.VERBOO_FORCE_ELECTRON_NODE === '1') return true
  if (process.env.VERBOO_FORCE_SYSTEM_NODE === '1') return false
  return Boolean(process.versions.electron && !process.defaultApp)
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
