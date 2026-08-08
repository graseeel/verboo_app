import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  SUPPORTED_NODE_TARGETS,
  loadNodeManifest,
  nodeSidecarFilename,
  requestedTarget,
  verifySha256,
} from './build-node-sidecar.mjs'

test('pins Node 24.19.0 and every current desktop target', async () => {
  const manifest = await loadNodeManifest()
  assert.equal(manifest.version, '24.19.0')
  assert.equal(manifest.modules, '137')
  assert.equal(manifest.napi, '10')
  assert.deepEqual(Object.keys(manifest.targets), [
    'aarch64-apple-darwin',
    'x86_64-apple-darwin',
    'x86_64-pc-windows-msvc',
    'x86_64-unknown-linux-gnu',
  ])
  assert.deepEqual([...SUPPORTED_NODE_TARGETS], Object.keys(manifest.targets))
  for (const definition of Object.values(manifest.targets)) {
    assert.match(definition.sha256, /^[a-f0-9]{64}$/)
    assert.match(definition.archive, /^node-v24\.19\.0-/)
    assert.match(definition.entry, /^node-v24\.19\.0-/)
    assert.match(definition.license, /^node-v24\.19\.0-.*\/LICENSE$/)
  }
})

test('uses Tauri target-qualified sidecar names', () => {
  assert.equal(
    nodeSidecarFilename('aarch64-apple-darwin'),
    'verboo-node-aarch64-apple-darwin',
  )
  assert.equal(
    nodeSidecarFilename('x86_64-pc-windows-msvc'),
    'verboo-node-x86_64-pc-windows-msvc.exe',
  )
})

test('requires a supported explicit target', () => {
  assert.equal(requestedTarget(['--target', 'x86_64-unknown-linux-gnu'], {}), 'x86_64-unknown-linux-gnu')
  assert.throws(() => requestedTarget([], {}, () => undefined), /explicit --target/i)
  assert.throws(() => requestedTarget(['--target', 'aarch64-unknown-linux-gnu'], {}), /unsupported target/i)
})

test('fails closed when cached or downloaded bytes do not match the pin', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'verboo-node-sidecar-test-'))
  const archive = path.join(directory, 'node.tar.xz')
  await writeFile(archive, 'changed bytes')
  try {
    await assert.rejects(verifySha256(archive, '0'.repeat(64)), /Node archive SHA-256 mismatch/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
