import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'

import { applyVersionBadge, extensionVersion } from './versionBadge.js'
import EN_US from '../i18n/en-US.js'
import PT_BR from '../i18n/pt-BR.js'

const panelHtml = await readFile(new URL('./panel.html', import.meta.url), 'utf8')
const optionsHtml = await readFile(new URL('./options.html', import.meta.url), 'utf8')

function withMockedManifest(version, fn) {
  const originalChrome = globalThis.chrome
  globalThis.chrome = { runtime: { getManifest: () => ({ version }) } }
  try {
    fn()
  } finally {
    globalThis.chrome = originalChrome
  }
}

test('version badge renders the runtime manifest version, never a pinned literal', () => {
  const dom = new JSDOM('<!doctype html><p class="version-badge" data-version-badge></p>')
  const el = dom.window.document.querySelector('[data-version-badge]')

  // Two different mocked manifests → the badge follows each one, so a
  // manifest bump changes the UI without touching this code or the test.
  for (const mocked of ['9.9.9-mock.one', '4.5.6-mock.two']) {
    withMockedManifest(mocked, () => {
      applyVersionBadge(dom.window.document, 'Version')
      assert.equal(el.textContent, `Version ${mocked}`)
    })
  }
})

test('version badge stays empty when the manifest version is unavailable', () => {
  const dom = new JSDOM('<!doctype html><p class="version-badge" data-version-badge></p>')
  const el = dom.window.document.querySelector('[data-version-badge]')
  withMockedManifest(undefined, () => {
    applyVersionBadge(dom.window.document, 'Version')
    assert.equal(el.textContent, '')
  })
})

test('version badge renders via textContent only (markup stays inert text)', () => {
  const dom = new JSDOM('<!doctype html><p class="version-badge" data-version-badge></p>')
  const el = dom.window.document.querySelector('[data-version-badge]')
  withMockedManifest('<img src=x>', () => {
    applyVersionBadge(dom.window.document, 'Version')
    assert.equal(el.textContent, 'Version <img src=x>')
    assert.equal(el.querySelector('img'), null)
  })
})

test('extensionVersion reads chrome.runtime.getManifest() at call time', () => {
  withMockedManifest('1.2.3-runtime', () => {
    assert.equal(extensionVersion(), '1.2.3-runtime')
  })
})

test('panel and options markup expose the badge element', () => {
  assert.match(panelHtml, /class="version-badge login-version" data-version-badge/)
  assert.match(optionsHtml, /<span class="version-badge" data-version-badge><\/span>/)
})

test('version_label copy exists in both locale bundles with key parity', () => {
  assert.equal(typeof EN_US.version_label?.message, 'string', 'en-US missing version_label')
  assert.equal(typeof PT_BR.version_label?.message, 'string', 'pt-BR missing version_label')
  assert.notEqual(EN_US.version_label.message, PT_BR.version_label.message)
  assert.deepEqual(Object.keys(PT_BR).sort(), Object.keys(EN_US).sort())
})
