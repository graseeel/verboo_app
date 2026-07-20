import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  humanizeModelId,
  modelDisplayName,
  safeMarkdownToHtml,
} from './presentation.js'

test('modelDisplayName: prefers router presentation metadata', () => {
  assert.equal(
    modelDisplayName({ id: 'provider/model-v2', displayName: 'Model V2 Fast' }),
    'Model V2 Fast',
  )
})

test('modelDisplayName: humanizes unknown IDs without a model allowlist', () => {
  assert.equal(modelDisplayName({ id: 'kimi-k2.7' }), 'Kimi K2.7')
  assert.equal(humanizeModelId('newprovider-27b-flash'), 'Newprovider 27B Flash')
})

test('safeMarkdownToHtml: renders summary emphasis and line breaks', () => {
  assert.equal(
    safeMarkdownToHtml('Pronto! **Juno** está tocando.\n`youtube.com`'),
    'Pronto! <strong>Juno</strong> está tocando.<br><code>youtube.com</code>',
  )
})

test('safeMarkdownToHtml: escapes model-provided markup before formatting', () => {
  const html = safeMarkdownToHtml('<img src=x onerror=alert(1)> **ok**')
  assert.doesNotMatch(html, /<img/i)
  assert.match(html, /&lt;img/)
  assert.match(html, /<strong>ok<\/strong>/)
})
