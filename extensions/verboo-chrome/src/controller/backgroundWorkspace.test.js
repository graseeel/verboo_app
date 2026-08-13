import { test } from 'node:test'
import assert from 'node:assert/strict'

test('background workspace is created unfocused and survives user focus changes', async () => {
  const workspaceModule = await import('./backgroundWorkspace.js').catch(() => ({}))
  assert.equal(typeof workspaceModule.createBackgroundWorkspaceManager, 'function')

  const creates = []
  const windowUpdates = []
  const tabUpdates = []
  const sessionStored = {}
  const localStored = {}
  const tabs = new Map([
    [99, { id: 99, windowId: 9, url: 'https://source.example/form', active: true }],
  ])
  const windows = new Map()
  const chromeApi = {
    tabs: {
      get: async (tabId) => {
        const tab = tabs.get(tabId)
        if (!tab) throw new Error('tab missing')
        return tab
      },
      update: async (tabId, properties) => {
        tabUpdates.push({ tabId, properties })
        const next = { ...tabs.get(tabId), ...properties }
        tabs.set(tabId, next)
        return next
      },
    },
    windows: {
      create: async (options) => {
        creates.push(options)
        const tab = { id: 42, windowId: 7, url: options.url, active: true }
        const window = { id: 7, focused: false, tabs: [tab] }
        tabs.set(42, tab)
        windows.set(7, window)
        return window
      },
      get: async (windowId) => {
        const window = windows.get(windowId)
        if (!window) throw new Error('window missing')
        return window
      },
      update: async (windowId, properties) => {
        windowUpdates.push({ windowId, properties })
      },
    },
    storage: {
      session: {
        get: async (key) => ({ [key]: sessionStored[key] }),
        set: async (value) => Object.assign(sessionStored, value),
      },
      local: {
        get: async (key) => ({ [key]: localStored[key] }),
        set: async (value) => Object.assign(localStored, value),
      },
    },
  }

  const manager = workspaceModule.createBackgroundWorkspaceManager({ chromeApi })
  const first = await manager.acquire({ sourceTabId: 99, resume: false })

  assert.deepEqual(first.snapshot(), { tabId: 42, windowId: 7 })
  assert.deepEqual(creates, [{
    url: 'https://source.example/form',
    focused: false,
    type: 'normal',
  }])
  assert.equal(windowUpdates.length, 0)

  // The user can change foreground windows/tabs; resuming must reuse the
  // leased workspace without querying or activating the user's tab.
  tabs.set(99, { ...tabs.get(99), active: false })
  const resumed = await manager.acquire({ sourceTabId: 99, resume: true })
  assert.deepEqual(resumed.snapshot(), { tabId: 42, windowId: 7 })
  assert.equal(creates.length, 1)
  assert.equal(tabUpdates.length, 0)
  assert.equal(windowUpdates.length, 0)

  // Extension reload clears storage.session. A fresh service worker must
  // recover the same Verboo-owned window from durable extension storage.
  delete sessionStored.verbooBackgroundWorkspace
  const reloadedManager = workspaceModule.createBackgroundWorkspaceManager({ chromeApi })
  const afterExtensionReload = await reloadedManager.acquire({ sourceTabId: 99, resume: true })
  assert.deepEqual(afterExtensionReload.snapshot(), { tabId: 42, windowId: 7 })
  assert.equal(creates.length, 1)
})

test('turn lease changes target only after an explicit tabs action', async () => {
  const workspaceModule = await import('./backgroundWorkspace.js').catch(() => ({}))
  assert.equal(typeof workspaceModule.createTurnTabLease, 'function')

  const lease = workspaceModule.createTurnTabLease(42, 7)
  assert.deepEqual(lease.snapshot(), { tabId: 42, windowId: 7 })
  await lease.selectTab(43, 7)
  assert.deepEqual(lease.snapshot(), { tabId: 43, windowId: 7 })
  await assert.rejects(() => lease.selectTab(88, 9), /outside_workspace/)
})
