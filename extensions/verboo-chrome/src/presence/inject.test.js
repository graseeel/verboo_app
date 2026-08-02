/**
 * inject.test.js — pure-logic unit tests for presence constants/helpers.
 *
 * Does not exercise chrome.* (those require the extension runtime).
 * Run with: node --test src/presence/inject.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  VERBOO_TAB_GROUP_TITLE,
  VERBOO_TAB_GROUP_COLOR,
  PRESENCE_ACTION_DELAY_MS,
  PRESENCE_ACTION_DELAY_MS_MIN,
  PRESENCE_ACTION_DELAY_MS_MAX,
  CURSOR_MOVE_MS,
  randomBetween,
  clearPresence,
  clearPresenceBestEffort,
  clearPresenceOnAllTabs,
} from './inject.js'

test('Verboo tab group title is "Verboo"', () => {
  assert.equal(VERBOO_TAB_GROUP_TITLE, 'Verboo')
})

test('Verboo tab group color is chrome.tabGroups purple', () => {
  assert.equal(VERBOO_TAB_GROUP_COLOR, 'purple')
})

test('presence action delay is visible long enough (cursor dwell)', () => {
  assert.equal(CURSOR_MOVE_MS, 760)
  assert.equal(PRESENCE_ACTION_DELAY_MS_MIN, 840)
  assert.equal(PRESENCE_ACTION_DELAY_MS_MAX, 980)
  assert.ok(PRESENCE_ACTION_DELAY_MS >= 840)
  assert.ok(PRESENCE_ACTION_DELAY_MS <= 980)
  assert.ok(PRESENCE_ACTION_DELAY_MS_MIN > CURSOR_MOVE_MS)
})

test('randomBetween stays within [min, max]', () => {
  for (let i = 0; i < 40; i++) {
    const n = randomBetween(840, 980)
    assert.ok(n >= 840 && n <= 980, `got ${n}`)
  }
})

test('clearPresence and clearPresenceBestEffort are exported functions', () => {
  assert.equal(typeof clearPresence, 'function')
  assert.equal(typeof clearPresenceBestEffort, 'function')
  assert.equal(typeof clearPresenceOnAllTabs, 'function')
})

test('ensureAgentPresence and pulseAgentCursor are exported', async () => {
  const mod = await import('./inject.js')
  assert.equal(typeof mod.ensureAgentPresence, 'function')
  assert.equal(typeof mod.pulseAgentCursor, 'function')
  assert.equal(typeof mod.preparePresenceForAction, 'function')
  assert.equal(typeof mod.showAgentCursor, 'function')
})

test('showAgentCursor passes the slower Flow duration to the page injector', async () => {
  const mod = await import('./inject.js')
  const originalChrome = globalThis.chrome
  const calls = []
  globalThis.chrome = {
    scripting: {
      executeScript: async (options) => calls.push(options),
    },
  }
  try {
    await mod.showAgentCursor(42, { x: 120, y: 240 })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].args.slice(0, 3), [
      'verboo-agent-cursor',
      'verboo-agent-cursor-style',
      { x: 120, y: 240 },
    ])
    assert.equal(calls[0].args[3], CURSOR_MOVE_MS)
  } finally {
    globalThis.chrome = originalChrome
  }
})

test('clearPresence no-ops without a numeric tabId', async () => {
  await assert.doesNotReject(() => clearPresence(/** @type {any} */ (undefined)))
  await assert.doesNotReject(() => clearPresence(/** @type {any} */ (null)))
})

test('openVerbooWorkspace scopes the panel to one tab and groups that tab', async () => {
  const mod = await import('./inject.js')
  assert.equal(typeof mod.openVerbooWorkspace, 'function')

  const originalChrome = globalThis.chrome
  const calls = []
  let finishPanelConfiguration
  globalThis.chrome = {
    sidePanel: {
      setOptions: (options) => {
        calls.push(['setOptions', options])
        return new Promise((resolve) => {
          finishPanelConfiguration = resolve
        })
      },
      open: async (options) => calls.push(['open', options]),
    },
    tabs: {
      get: async (tabId) => ({ id: tabId, windowId: 3, groupId: -1 }),
      group: async (options) => {
        calls.push(['group', options])
        return 12
      },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      query: async () => [],
      update: async (groupId, options) => calls.push(['updateGroup', groupId, options]),
    },
  }
  try {
    const workspace = mod.openVerbooWorkspace(42)
    await Promise.resolve()
    assert.deepEqual(calls.slice(0, 2), [
      ['setOptions', {
        tabId: 42,
        path: 'src/panel/panel.html',
        enabled: true,
      }],
      ['open', { tabId: 42 }],
    ], 'sidePanel.open must be invoked before awaiting setOptions so the toolbar gesture is preserved')
    finishPanelConfiguration()
    await workspace
    assert.deepEqual(calls, [
      ['setOptions', {
        tabId: 42,
        path: 'src/panel/panel.html',
        enabled: true,
      }],
      ['open', { tabId: 42 }],
      ['group', { tabIds: [42] }],
      ['updateGroup', 12, { title: 'Verboo', color: 'purple' }],
    ])
  } finally {
    globalThis.chrome = originalChrome
  }
})

test('disableGlobalVerbooPanel removes the global fallback panel', async () => {
  const mod = await import('./inject.js')
  assert.equal(typeof mod.disableGlobalVerbooPanel, 'function')

  const originalChrome = globalThis.chrome
  const calls = []
  globalThis.chrome = {
    sidePanel: {
      setOptions: async (options) => calls.push(options),
    },
  }
  try {
    await mod.disableGlobalVerbooPanel()
    assert.deepEqual(calls, [{ enabled: false }])
  } finally {
    globalThis.chrome = originalChrome
  }
})
