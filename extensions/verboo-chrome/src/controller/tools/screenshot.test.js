import { test } from 'node:test'
import assert from 'node:assert/strict'
import { screenshot } from './screenshot.js'

/**
 * The agent must never steal the user's focus or active tab. These tests
 * assert the NEGATIVE: chrome.windows.update({focused:true}) and
 * chrome.tabs.update({active:true}) are never dispatched — in both the
 * visible-tab path (no need) and the background-tab path (forbidden).
 */

function installChromeMock({ targetIsActive, windowFocused, captureUrl = 'data:image/jpeg;base64,AAA' }) {
  const windowsUpdateCalls = []
  const tabsUpdateCalls = []
  const captureCalls = []

  const chrome = {
    tabs: {
      get: async (tabId) => ({ id: tabId, url: 'https://example.com', windowId: 7 }),
      query: async (query) => {
        // screenshot asks for the active tab in the target window. The
        // window itself may remain unfocused while the user works elsewhere.
        if (query.active && query.windowId === 7) {
          return [targetIsActive ? { id: 42, windowId: 7 } : { id: 999, windowId: 7 }]
        }
        return [{ id: 42, url: 'https://example.com', windowId: 7 }]
      },
      captureVisibleTab: async (windowId, opts) => {
        captureCalls.push({ windowId, opts })
        return captureUrl
      },
      update: async (tabId, props) => {
        tabsUpdateCalls.push({ tabId, props })
        return {}
      },
    },
    windows: {
      get: async (windowId) => ({ id: windowId, focused: windowFocused }),
      update: async (windowId, props) => {
        windowsUpdateCalls.push({ windowId, props })
        return {}
      },
      getAll: async () => [],
    },
    scripting: {
      executeScript: async () => [{ result: { w: 1280, h: 720 } }],
    },
  }

  globalThis.chrome = chrome
  return { windowsUpdateCalls, tabsUpdateCalls, captureCalls }
}

test('screenshot of a visible tab captures without focus or active calls', async () => {
  const originalChrome = globalThis.chrome
  const { windowsUpdateCalls, tabsUpdateCalls, captureCalls } = installChromeMock({
    targetIsActive: true,
    windowFocused: true,
  })

  try {
    const result = await screenshot({ name: 'screenshot' }, { activeTabId: 42 })

    assert.ok(result.dataUrl, 'capture should succeed for a visible tab')
    assert.equal(captureCalls.length, 1, 'captureVisibleTab should fire once')
    assert.equal(
      windowsUpdateCalls.filter((c) => c.props?.focused === true).length,
      0,
      'must never call windows.update({focused:true}) — tab is already visible',
    )
    assert.equal(
      tabsUpdateCalls.filter((c) => c.props?.active === true).length,
      0,
      'must never call tabs.update({active:true}) — tab is already active',
    )
  } finally {
    globalThis.chrome = originalChrome
  }
})

test('screenshot captures the active tab of an unfocused workspace window', async () => {
  const originalChrome = globalThis.chrome
  const { windowsUpdateCalls, tabsUpdateCalls, captureCalls } = installChromeMock({
    targetIsActive: true,
    windowFocused: false,
  })

  try {
    const result = await screenshot({ name: 'screenshot' }, { activeTabId: 42 })

    assert.ok(result.dataUrl)
    assert.deepEqual(captureCalls.map((call) => call.windowId), [7])
    assert.equal(windowsUpdateCalls.length, 0, 'the workspace window must stay unfocused')
    assert.equal(tabsUpdateCalls.length, 0, 'the user tab must never be replaced')
  } finally {
    globalThis.chrome = originalChrome
  }
})

test('screenshot of a background tab never steals focus (negative assertion)', async () => {
  const originalChrome = globalThis.chrome
  const { windowsUpdateCalls, tabsUpdateCalls, captureCalls } = installChromeMock({
    targetIsActive: false,
    windowFocused: false,
  })

  try {
    // Without the debugger permission, the background path throws a clear
    // error. The point of this test is NOT the error — it is that the
    // focus/active calls never fire, even when capture is impossible.
    await assert.rejects(
      screenshot({ name: 'screenshot' }, { activeTabId: 42 }),
      /target_tab_not_active_in_workspace/,
    )

    assert.equal(
      captureCalls.length,
      0,
      'captureVisibleTab must not fire for a background tab',
    )
    assert.equal(
      windowsUpdateCalls.length,
      0,
      'FORBIDDEN: windows.update must never be called in the background path',
    )
    assert.equal(
      tabsUpdateCalls.length,
      0,
      'FORBIDDEN: tabs.update must never be called in the background path',
    )
  } finally {
    globalThis.chrome = originalChrome
  }
})
