import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '../..')

export function sidecarFilename(binaryName, targetTriple, platform = process.platform) {
  if (!['verboo-in-chrome', 'verboo-ios-simulator'].includes(binaryName)) {
    throw new Error(`Invalid sidecar binary name: ${binaryName || '<empty>'}`)
  }
  if (
    typeof targetTriple !== 'string' ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]+$/.test(targetTriple) ||
    targetTriple.split('-').length < 3
  ) {
    throw new Error(`Invalid target triple: ${targetTriple || '<empty>'}`)
  }
  const windows = platform === 'win32' || targetTriple.includes('windows')
  return `${binaryName}-${targetTriple}${windows ? '.exe' : ''}`
}

export function requestedTarget(args = process.argv.slice(2), env = process.env) {
  const inline = args.find((argument) => argument.startsWith('--target='))
  if (inline) return inline.slice('--target='.length)
  const index = args.indexOf('--target')
  if (index >= 0) return args[index + 1]
  if (env.TAURI_ENV_TARGET_TRIPLE) return env.TAURI_ENV_TARGET_TRIPLE
  const details = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
  const host = details.match(/^host:\s*(\S+)$/m)?.[1]
  if (!host) throw new Error('Could not determine the Rust target triple')
  return host
}

export async function buildChromeHelper({
  targetTriple = requestedTarget(),
  platform = process.platform,
} = {}) {
  const manifestPath = path.join(
    repositoryRoot,
    'src-tauri/verboo-in-chrome/Cargo.toml',
  )
  execFileSync(
    'cargo',
    [
      '+1.89.0',
      'build',
      '--release',
      '--manifest-path',
      manifestPath,
      '--target',
      targetTriple,
    ],
    { cwd: repositoryRoot, stdio: 'inherit' },
  )

  const destinationDirectory = path.join(repositoryRoot, 'src-tauri/binaries')
  await mkdir(destinationDirectory, { recursive: true })
  const destinations = []
  for (const binaryName of ['verboo-in-chrome', 'verboo-ios-simulator']) {
    const executable = platform === 'win32' || targetTriple.includes('windows')
      ? `${binaryName}.exe`
      : binaryName
    const source = path.join(
      repositoryRoot,
      'src-tauri/verboo-in-chrome/target',
      targetTriple,
      'release',
      executable,
    )
    const destination = path.join(
      destinationDirectory,
      sidecarFilename(binaryName, targetTriple, platform),
    )
    await copyFile(source, destination)
    if (platform !== 'win32') await chmod(destination, 0o755)
    destinations.push(destination)
    process.stdout.write(`Prepared MCP sidecar: ${destination}\n`)
  }
  return destinations
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await buildChromeHelper()
}
