import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sidecarFilename } from './build-chrome-helper.mjs'

test('builds the exact Tauri sidecar filename for supported targets', () => {
  assert.equal(
    sidecarFilename('verboo-in-chrome', 'aarch64-apple-darwin', 'darwin'),
    'verboo-in-chrome-aarch64-apple-darwin',
  )
  assert.equal(
    sidecarFilename('verboo-ios-simulator', 'aarch64-apple-darwin', 'darwin'),
    'verboo-ios-simulator-aarch64-apple-darwin',
  )
  assert.equal(
    sidecarFilename('verboo-in-chrome', 'x86_64-unknown-linux-gnu', 'linux'),
    'verboo-in-chrome-x86_64-unknown-linux-gnu',
  )
  assert.equal(
    sidecarFilename('verboo-ios-simulator', 'x86_64-pc-windows-msvc', 'win32'),
    'verboo-ios-simulator-x86_64-pc-windows-msvc.exe',
  )
})

test('rejects an empty or malformed target triple', () => {
  assert.throws(() => sidecarFilename('verboo-in-chrome', '', 'darwin'), /target triple/i)
  assert.throws(() => sidecarFilename('verboo-in-chrome', '../escape', 'linux'), /target triple/i)
  assert.throws(() => sidecarFilename('../escape', 'aarch64-apple-darwin', 'darwin'), /binary name/i)
})
