import assert from 'node:assert'
import { execFileSync } from 'node:child_process'

// Transpile the real module (no electron deps needed for resolveNodeRuntime).
execFileSync('npx', ['esbuild', 'src/main/services/nodeRuntime.ts',
  '--format=esm', '--bundle', '--platform=node', '--external:electron',
  '--outfile=scripts/verify/_noderuntime.mjs'], { stdio: 'inherit' })

const { resolveNodeRuntime } = await import('./_noderuntime.mjs')

// 1) No system Node anywhere -> fall back to Electron's bundled runtime.
const r1 = await resolveNodeRuntime([], '/fake/Electron', async () => false)
assert.deepEqual(r1, { path: '/fake/Electron', isElectron: true }, 'should fall back to electron when no node found')

// 2) A real system Node exists -> use it, never electron.
const r2 = await resolveNodeRuntime(
  ['/usr/bin/node', '/opt/homebrew/bin/node'],
  '/fake/Electron',
  async p => p === '/opt/homebrew/bin/node',
)
assert.deepEqual(r2, { path: '/opt/homebrew/bin/node', isElectron: false }, 'should prefer an existing system node')

// 3) First existing candidate wins.
const r3 = await resolveNodeRuntime(['/a/node', '/b/node'], '/fake/Electron', async () => true)
assert.deepEqual(r3, { path: '/a/node', isElectron: false }, 'first candidate wins')

console.log('node-runtime-fallback: all assertions passed')
