import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

if (process.platform !== 'darwin') {
  console.log('Computer Use helper is macOS-only; skipping sidecar build.')
  process.exit(0)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const result = spawnSync(path.join(root, 'src-tauri/swift-helper/build.sh'), [], {
  cwd: root,
  stdio: 'inherit',
})
if (result.status !== 0) process.exit(result.status ?? 1)
