import { constants, existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, join, sep } from 'node:path'

let cachedNodePath: string | undefined

export async function resolveNodeRuntimePath(): Promise<string> {
  if (cachedNodePath) return cachedNodePath

  for (const candidate of nodeRuntimeCandidates()) {
    if (await isExecutable(candidate)) {
      cachedNodePath = candidate
      return candidate
    }
  }

  throw new Error(
    'Node.js não foi encontrado. Instale o Node.js ou defina VERBOO_NODE_PATH com o caminho absoluto do executável node.',
  )
}

export function createNodeRuntimeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  delete env.ELECTRON_RUN_AS_NODE
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
