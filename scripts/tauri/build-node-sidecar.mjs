import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const scriptDirectory = path.dirname(scriptPath)
const repositoryRoot = path.resolve(scriptDirectory, '../..')
const manifestPath = path.join(scriptDirectory, 'node-sidecars.json')

export const SUPPORTED_NODE_TARGETS = Object.freeze([
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
])

function assertSupportedTarget(target) {
  if (!SUPPORTED_NODE_TARGETS.includes(target)) {
    throw new Error(`Unsupported target: ${target || '<empty>'}`)
  }
  return target
}

export function nodeSidecarFilename(target) {
  assertSupportedTarget(target)
  return `verboo-node-${target}${target.includes('windows') ? '.exe' : ''}`
}

export function requestedTarget(
  args = process.argv.slice(2),
  env = process.env,
  resolveHost = () => execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host:\s*(\S+)$/m)?.[1],
) {
  const inline = args.find(argument => argument.startsWith('--target='))
  const index = args.indexOf('--target')
  const explicit = inline?.slice('--target='.length) || (index >= 0 ? args[index + 1] : undefined)
  const target = explicit || env.TAURI_ENV_TARGET_TRIPLE || resolveHost()
  if (!target) throw new Error('An explicit --target is required')
  return assertSupportedTarget(target)
}

export async function loadNodeManifest() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (
    manifest.version !== '24.19.0' ||
    manifest.modules !== '137' ||
    manifest.napi !== '10' ||
    manifest.baseUrl !== 'https://nodejs.org/dist/v24.19.0/'
  ) {
    throw new Error('Unexpected embedded Node runtime contract')
  }
  if (JSON.stringify(Object.keys(manifest.targets)) !== JSON.stringify(SUPPORTED_NODE_TARGETS)) {
    throw new Error('Embedded Node targets do not match the desktop release matrix')
  }
  for (const target of SUPPORTED_NODE_TARGETS) {
    const definition = manifest.targets[target]
    if (!definition || !/^[a-f0-9]{64}$/.test(definition.sha256)) {
      throw new Error(`Invalid Node SHA-256 pin for ${target}`)
    }
    const expectedPrefix = `node-v${manifest.version}-`
    if (
      !definition.archive.startsWith(expectedPrefix) ||
      !definition.entry.startsWith(expectedPrefix) ||
      !definition.license.startsWith(expectedPrefix) ||
      !definition.license.endsWith('/LICENSE')
    ) {
      throw new Error(`Invalid Node archive layout for ${target}`)
    }
  }
  return manifest
}

export async function verifySha256(file, expected) {
  const hash = createHash('sha256')
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(file)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', rejectPromise)
    stream.on('end', resolvePromise)
  })
  const actual = hash.digest('hex')
  if (actual !== expected) {
    throw new Error(`Node archive SHA-256 mismatch: expected ${expected}, got ${actual}`)
  }
  return actual
}

export async function prepareNodeSidecar({
  target = requestedTarget(),
  outputDirectory = path.join(repositoryRoot, 'src-tauri', 'binaries'),
  resourceDirectory = path.join(repositoryRoot, 'src-tauri', 'resources', 'node-runtime'),
  cacheDirectory = process.env.VERBOO_NODE_SIDECAR_CACHE
    || path.join(homedir(), '.cache', 'verboo-node-sidecars'),
  fetchImpl = fetch,
} = {}) {
  assertSupportedTarget(target)
  const manifest = await loadNodeManifest()
  const definition = manifest.targets[target]
  const cacheRoot = path.join(cacheDirectory, manifest.version, target)
  const archivePath = path.join(cacheRoot, definition.archive)
  await mkdir(cacheRoot, { recursive: true })

  if (!(await fileExists(archivePath)) || !(await matchesSha256(archivePath, definition.sha256))) {
    await downloadPinnedArchive(
      new URL(definition.archive, manifest.baseUrl).href,
      archivePath,
      definition.sha256,
      fetchImpl,
    )
  }
  await verifySha256(archivePath, definition.sha256)

  const extractionRoot = await mkdtemp(path.join(cacheRoot, '.extract-'))
  const destination = path.join(outputDirectory, nodeSidecarFilename(target))
  try {
    execFileSync(
      'tar',
      ['-xf', archivePath, '-C', extractionRoot, definition.entry, definition.license],
      { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    await mkdir(outputDirectory, { recursive: true })
    await mkdir(resourceDirectory, { recursive: true })
    await copyFile(path.join(extractionRoot, definition.entry), destination)
    if (!target.includes('windows')) await chmod(destination, 0o755)
    await copyFile(path.join(extractionRoot, definition.license), path.join(resourceDirectory, 'LICENSE'))
    assertRuntimeContract(destination, manifest)
    process.stdout.write(`Prepared embedded Node ${manifest.version}: ${destination}\n`)
    return { destination, license: path.join(resourceDirectory, 'LICENSE'), manifest }
  } catch (error) {
    await rm(destination, { force: true })
    throw error
  } finally {
    await rm(extractionRoot, { recursive: true, force: true })
  }
}

function assertRuntimeContract(executable, manifest) {
  const result = spawnSync(
    executable,
    ['-p', 'JSON.stringify({node:process.versions.node,modules:process.versions.modules,napi:process.versions.napi})'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Embedded Node smoke failed: ${result.stderr || result.stdout || result.status}`)
  }
  const versions = JSON.parse(result.stdout)
  if (
    versions.node !== manifest.version ||
    versions.modules !== manifest.modules ||
    versions.napi !== manifest.napi
  ) {
    throw new Error(`Embedded Node runtime mismatch: ${result.stdout.trim()}`)
  }
}

async function downloadPinnedArchive(url, destination, sha256, fetchImpl) {
  if (!url.startsWith('https://nodejs.org/dist/v24.19.0/')) {
    throw new Error(`Refusing non-official Node URL: ${url}`)
  }
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const partial = `${destination}.partial-${process.pid}-${randomUUID()}`
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) })
      if (!response.ok) throw new Error(`Node download returned HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      await writeFile(partial, bytes, { flag: 'wx' })
      await verifySha256(partial, sha256)
      await rename(partial, destination)
      return
    } catch (error) {
      lastError = error
      await rm(partial, { force: true })
    }
  }
  throw new Error(`Could not download verified Node runtime: ${lastError instanceof Error ? lastError.message : lastError}`)
}

async function matchesSha256(file, expected) {
  try {
    await verifySha256(file, expected)
    return true
  } catch {
    return false
  }
}

async function fileExists(file) {
  try {
    await stat(file)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await prepareNodeSidecar()
}
