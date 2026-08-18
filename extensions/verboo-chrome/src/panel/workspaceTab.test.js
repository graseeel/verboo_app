import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  canFocusWorkspaceTab,
  isWorkspaceTab,
  tabUrlHost,
  toolCallTabIds,
  toolCallTabLabels,
  truncateTabTitle,
  workspaceTabChipState,
  workspaceTabLabel,
} from './workspaceTab.js'
import EN_US from '../i18n/en-US.js'
import PT_BR from '../i18n/pt-BR.js'

test('truncateTabTitle: keeps short titles and collapses whitespace', () => {
  assert.equal(truncateTabTitle('YouTube'), 'YouTube')
  assert.equal(truncateTabTitle('  minha\naba\t legal '), 'minha aba legal')
  assert.equal(truncateTabTitle(''), '')
  assert.equal(truncateTabTitle(null), '')
})

test('truncateTabTitle: bounds long titles with an ellipsis', () => {
  const long = 'A'.repeat(120)
  const out = truncateTabTitle(long)
  assert.equal(out.length, 60)
  assert.ok(out.endsWith('…'))
})

test('tabUrlHost: extracts a display host and strips www', () => {
  assert.equal(tabUrlHost('https://www.youtube.com/watch?v=1'), 'youtube.com')
  assert.equal(tabUrlHost('http://example.com:8080/a'), 'example.com')
  assert.equal(tabUrlHost('not a url'), '')
  assert.equal(tabUrlHost(undefined), '')
})

test('workspaceTabLabel: title wins; empty title falls back to the host', () => {
  assert.equal(
    workspaceTabLabel({ title: 'Gmail', url: 'https://mail.google.com/inbox' }),
    'Gmail',
  )
  // Empty title mid-navigation: the chip still says something meaningful.
  assert.equal(
    workspaceTabLabel({ title: '', url: 'https://mail.google.com/inbox' }),
    'mail.google.com',
  )
  assert.equal(workspaceTabLabel({ title: '   ', url: 'chrome://extensions' }), '')
  assert.equal(workspaceTabLabel(null), '')
})

test('isWorkspaceTab: requires an integer tabId and string-shaped fields', () => {
  assert.equal(isWorkspaceTab({ tabId: 3, windowId: 1 }), true)
  assert.equal(isWorkspaceTab({ tabId: 3, title: 'a', url: 'https://x.com' }), true)
  assert.equal(isWorkspaceTab(null), false)
  assert.equal(isWorkspaceTab({}), false)
  assert.equal(isWorkspaceTab({ tabId: '3' }), false)
  assert.equal(isWorkspaceTab({ tabId: 3, title: 42 }), false)
})

test('canFocusWorkspaceTab: missing windowId leaves the chip read-only', () => {
  assert.equal(canFocusWorkspaceTab({ tabId: 3, windowId: 1 }), true)
  assert.equal(canFocusWorkspaceTab({ tabId: 3 }), false)
  assert.equal(canFocusWorkspaceTab(null), false)
})

test('workspaceTabChipState: hidden without tab, closed when it died mid-turn', () => {
  assert.equal(workspaceTabChipState({}), 'hidden')
  assert.equal(workspaceTabChipState({ tab: null }), 'hidden')
  assert.equal(workspaceTabChipState({ tab: { tabId: 3 } }), 'visible')
  // Aba fechada no meio do turno: o chip avisa em vez de sumir.
  assert.equal(workspaceTabChipState({ tab: { tabId: 3 }, closed: true }), 'closed')
})

test('toolCallTabIds: collects targets of tab-mutating tools, deduped and capped', () => {
  assert.deepEqual(toolCallTabIds({ params: { action: 'close', tabId: 7 } }), [7])
  assert.deepEqual(toolCallTabIds({ params: { action: 'assign', tabIds: [4, 5, 5] } }), [4, 5])
  assert.deepEqual(
    toolCallTabIds({ params: { tabId: 1, tabIds: [2, 3, 4] } }),
    [1, 2, 3],
  )
  assert.deepEqual(toolCallTabIds({ params: { selector: '#ok' } }), [])
  assert.deepEqual(toolCallTabIds(null), [])
  assert.deepEqual(toolCallTabIds({ params: 'junk' }), [])
})

test('toolCallTabLabels: resolved tabs use title/host, dead tabs fall back to the id', async () => {
  const resolveTab = async (id) =>
    id === 7 ? { title: 'YouTube', url: 'https://www.youtube.com/watch' } : null
  const labels = { untitled: 'Untitled tab', tabId: (id) => `Tab #${id}` }
  // Aba viva: título resolvido.
  assert.deepEqual(await toolCallTabLabels([7], resolveTab, labels), ['YouTube'])
  // Aba morta: fallback para o id — o card ainda nomeia o alvo.
  assert.deepEqual(await toolCallTabLabels([99], resolveTab, labels), ['Tab #99'])
  // Misto: cada id vira um label, na ordem.
  assert.deepEqual(await toolCallTabLabels([7, 99, 5], resolveTab, labels), [
    'YouTube',
    'Tab #99',
    'Tab #5',
  ])
  assert.deepEqual(await toolCallTabLabels([], resolveTab, labels), [])
})

test('toolCallTabLabels: empty title falls back to the host, then to untitled', async () => {
  const resolveTab = async (id) => {
    const tabs = {
      1: { title: '', url: 'https://mail.google.com/inbox' },
      2: { title: '   ', url: 'chrome://extensions' },
    }
    return tabs[id] ?? null
  }
  const labels = { untitled: 'Untitled tab', tabId: (id) => `Tab #${id}` }
  // Título vazio com URL: o host identifica a página.
  assert.deepEqual(await toolCallTabLabels([1], resolveTab, labels), ['mail.google.com'])
  // Título e URL sem host utilizável: label "untitled" localizado.
  assert.deepEqual(await toolCallTabLabels([2], resolveTab, labels), ['Untitled tab'])
})

test('workspace-tab copy exists in both locale bundles with key parity', () => {
  for (const key of [
    'workspaceTab_acting',
    'workspaceTab_result',
    'workspaceTab_show',
    'workspaceTab_closed',
    'workspaceTab_untitled',
    'workspaceTab_onTab',
    'workspaceTab_tabId',
  ]) {
    assert.equal(typeof EN_US[key]?.message, 'string', `en-US missing ${key}`)
    assert.equal(typeof PT_BR[key]?.message, 'string', `pt-BR missing ${key}`)
  }
  assert.deepEqual(Object.keys(PT_BR).sort(), Object.keys(EN_US).sort())
})
