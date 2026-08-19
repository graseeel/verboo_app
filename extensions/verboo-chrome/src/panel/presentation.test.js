import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  humanizeModelId,
  modelDisplayName,
  safeMarkdownToHtml,
  structuredResultPreview,
} from './presentation.js'
import * as presentation from './presentation.js'

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

test('safeMarkdownToHtml: renders headings and unordered/ordered lists', () => {
  assert.equal(
    safeMarkdownToHtml('## Resumo\n- Primeiro\n- Segundo\n1. Próximo'),
    '<h2>Resumo</h2><br><ul><li>Primeiro</li><li>Segundo</li></ul><br><ol><li>Próximo</li></ol>',
  )
})

test('safeMarkdownToHtml: renders fenced code blocks without exposing delimiters', () => {
  assert.equal(
    safeMarkdownToHtml('Resultado:\n```csv\nNome,Valor\nJuno,42\n```'),
    'Resultado:<br><pre><code>Nome,Valor\nJuno,42</code></pre>',
  )
})

test('safeMarkdownToHtml: escapes model-provided markup before formatting', () => {
  const html = safeMarkdownToHtml('<img src=x onerror=alert(1)> **ok**')
  assert.doesNotMatch(html, /<img/i)
  assert.match(html, /&lt;img/)
  assert.match(html, /<strong>ok<\/strong>/)
})

test('safeMarkdownToHtml: neutralizes a pure residual tool-call block', () => {
  assert.equal(
    safeMarkdownToHtml('<function_calls><invoke name="click">{"selector": "#ok"}</invoke></function_calls>'),
    '',
  )
})

test('safeMarkdownToHtml: preserves the prose around a residual tool-call block', () => {
  assert.equal(
    safeMarkdownToHtml(
      'Feito, cliquei.\n<function_calls><invoke name="click">{"selector": "#ok"}</invoke></function_calls>\nQuer que eu continue?',
    ),
    'Feito, cliquei.<br><br>Quer que eu continue?',
  )
})

test('safeMarkdownToHtml: drops an orphan tool-call opener without eating earlier prose', () => {
  assert.equal(
    safeMarkdownToHtml('Vou clicar no botão:\n<function_calls><invoke name="click">{"selector": "#ok"}'),
    'Vou clicar no botão:',
  )
})

test('safeMarkdownToHtml: neutralizes other tool-call markup families generically', () => {
  assert.equal(safeMarkdownToHtml('<tool_call>{"name": "click"}</tool_call>'), '')
  assert.equal(
    safeMarkdownToHtml('antes\n<minimax:tool_call><invoke name="click">x</invoke></minimax:tool_call>\ndepois'),
    'antes<br><br>depois',
  )
  assert.equal(safeMarkdownToHtml('resultado parcial </function_calls>'), 'resultado parcial')
})

test('safeMarkdownToHtml: keeps prose that only mentions tool-call tags in words', () => {
  assert.equal(
    safeMarkdownToHtml('O modelo descreveu function_calls e tool_call sem marcar nada.'),
    'O modelo descreveu function_calls e tool_call sem marcar nada.',
  )
})

test('structuredResultPreview: shows a useful bounded preview for structured data', () => {
  assert.equal(
    structuredResultPreview({
      format: 'csv',
      url: 'https://example.com',
      data: 'Nome,Valor\nJuno,42',
    }),
    'CSV · Nome,Valor Juno,42',
  )
})

test('translatedErrorMessage: translates known backend codes and hides unknown codes', () => {
  assert.equal(typeof presentation.translatedErrorMessage, 'function')
  const translate = (key) => ({
    routine_recording_page_unavailable: 'Open a website before recording a workflow.',
    routine_record_failed: 'Could not change workflow recording.',
  })[key] ?? key

  assert.equal(
    presentation.translatedErrorMessage(
      'routine_recording_page_unavailable',
      'routine_record_failed',
      translate,
    ),
    'Open a website before recording a workflow.',
  )
  assert.equal(
    presentation.translatedErrorMessage('internal_backend_code', 'routine_record_failed', translate),
    'Could not change workflow recording.',
  )
})

test('shouldAppendError: suppresses only an identical consecutive error', () => {
  assert.equal(typeof presentation.shouldAppendError, 'function')
  assert.equal(presentation.shouldAppendError('Same error', 'Same error'), false)
  assert.equal(presentation.shouldAppendError('Different error', 'Same error'), true)
  assert.equal(presentation.shouldAppendError('', 'Same error'), true)
})

test('shouldSubmitComposerKey: plain Enter submits', () => {
  assert.equal(presentation.shouldSubmitComposerKey?.({ key: 'Enter' }), true)
})

test('shouldSubmitComposerKey: Shift+Enter inserts a line break', () => {
  assert.equal(
    presentation.shouldSubmitComposerKey?.({ key: 'Enter', shiftKey: true }),
    false,
  )
})

test('shouldSubmitComposerKey: IME composition never submits', () => {
  assert.equal(
    presentation.shouldSubmitComposerKey?.({ key: 'Enter', isComposing: true }),
    false,
  )
})

test('shouldSubmitComposerKey: an already handled slash command never submits', () => {
  assert.equal(
    presentation.shouldSubmitComposerKey?.({ key: 'Enter', defaultPrevented: true }),
    false,
  )
})

test('approvalDecisionMessageKey never presents an expired approval as approved', () => {
  assert.equal(typeof presentation.approvalDecisionMessageKey, 'function')
  assert.equal(presentation.approvalDecisionMessageKey('once'), 'tool_approved')
  assert.equal(presentation.approvalDecisionMessageKey('always'), 'tool_approved')
  assert.equal(presentation.approvalDecisionMessageKey('turn'), 'tool_approved')
  assert.equal(presentation.approvalDecisionMessageKey('deny'), 'tool_denied')
  assert.equal(presentation.approvalDecisionMessageKey('cancelled'), 'tool_cancelled')
  assert.equal(presentation.approvalDecisionMessageKey('timeout'), 'tool_approvalExpired')
})

test('cancelled routine errors never leak the raw run_cancelled code', () => {
  assert.equal(presentation.toolErrorMessageKey?.('run_cancelled'), 'tool_cancelled')
  assert.equal(presentation.toolErrorMessageKey?.('cancelled'), 'tool_cancelled')
  assert.equal(presentation.toolErrorMessageKey?.('denied_by_user'), 'tool_denied')
  assert.equal(presentation.toolErrorMessageKey?.('something_else'), null)
})
