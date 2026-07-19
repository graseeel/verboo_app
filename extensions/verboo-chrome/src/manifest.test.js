import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const manifest = JSON.parse(
  await readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
)

test('manifest does not advertise Native Messaging without a packaged host', () => {
  assert.equal(manifest.permissions.includes('nativeMessaging'), false)
})

test('manifest declares identity for user-initiated OAuth PKCE', () => {
  assert.equal(manifest.permissions.includes('identity'), true)
})
