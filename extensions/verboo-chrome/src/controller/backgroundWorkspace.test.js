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
    [99, { id: 99, windowId: 9, url: 'https://source.example/form', active: true, status: 'complete' }],
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
        const tab = { id: 42, windowId: 7, url: options.url, active: true, status: 'complete' }
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

// ── PÓS-CAMPO-6 (B): lease target revalidation + load wait ─────────

const { createBackgroundWorkspaceManager } = await import('./backgroundWorkspace.js')

function makeChromeApi({ leaseTab, sourceTab, statusSequence = [] } = {}) {
  const tabs = new Map()
  if (leaseTab) tabs.set(leaseTab.id, { ...leaseTab, status: 'complete' })
  if (sourceTab) tabs.set(sourceTab.id, { ...sourceTab, status: 'complete' })
  const storage = { local: {}, session: {} }
  let statusIndex = 0
  const getCalls = []
  return {
    chromeApi: {
      tabs: {
        get: async (tabId) => {
          getCalls.push(tabId)
          const tab = tabs.get(tabId)
          if (!tab) throw new Error('tab missing')
          // Status sequence drives the load-wait (PÓS-CAMPO-6): first
          // 'loading', then 'complete'.
          if (statusSequence.length > 0 && getCalls.filter((id) => id === tabId).length <= statusSequence.length) {
            const step = getCalls.filter((id) => id === tabId).length - 1
            if (step < statusSequence.length) return { ...tab, status: statusSequence[step] }
          }
          return tab
        },
        update: async (tabId, properties) => {
          const next = { ...tabs.get(tabId), ...properties }
          tabs.set(tabId, next)
          return next
        },
      },
      windows: {
        create: async (options) => {
          const tab = { id: 42, windowId: 7, url: options.url, active: true, status: 'complete' }
          tabs.set(42, tab)
          return { id: 7, focused: false, tabs: [tab] }
        },
        get: async (windowId) => ({ id: windowId, focused: false }),
      },
      storage: {
        local: {
          get: async (key) => ({ [key]: storage.local[key] }),
          set: async (kv) => { Object.assign(storage.local, kv) },
          remove: async (key) => { delete storage.local[key] },
        },
        session: {
          get: async (key) => ({ [key]: storage.session[key] }),
          set: async (kv) => { Object.assign(storage.session, kv) },
          remove: async (key) => { delete storage.session[key] },
        },
      },
    },
    storage,
    getCalls,
  }
}

test('PÓS-CAMPO-6: acquire waits for the lease tab navigation to land (loading → complete)', async () => {
  const { chromeApi, getCalls } = makeChromeApi({
    leaseTab: { id: 99, windowId: 9, url: 'about:blank' },
    sourceTab: { id: 5, windowId: 9, url: 'https://source.example/form' },
    statusSequence: ['loading', 'complete'],
  })
  const manager = createBackgroundWorkspaceManager({ chromeApi })
  // Seed the durable lease from a previous turn so acquire() reuses it
  // (the wait-under-test is the navigation after the re-target update).
  await chromeApi.storage.local.set({ verbooBackgroundWorkspace: { tabId: 99, windowId: 9 } })

  const lease = await manager.acquire({ sourceTabId: 5 })

  assert.equal(lease.snapshot().tabId, 99)
  // The wait polled tabs.get until 'complete' (multiple reads of tab 99).
  const reads = getCalls.filter((id) => id === 99).length
  assert.ok(reads >= 2, `expected the load poll to read the lease tab, got ${reads}`)
})

test('PÓS-CAMPO-6: acquireControllable discards a non-controllable lease and re-acquires', async () => {
  const { chromeApi, storage } = makeChromeApi({
    // Stale lease from a previous turn sitting on a NON-controllable URL
    // (edge://) with NO source tab available (sourceTabId undefined) —
    // the acquire cannot re-navigate it, so the revalidation must kick in.
    leaseTab: { id: 99, windowId: 9, url: 'edge://settings' },
  })
  const manager = createBackgroundWorkspaceManager({ chromeApi })
  await chromeApi.storage.local.set({ verbooBackgroundWorkspace: { tabId: 99, windowId: 9 } })

  const lease = await manager.acquireControllable({
    sourceTabId: undefined,
    isControllableUrl: (url) => /^https?:\/\//i.test(String(url ?? '')),
  })

  // The stale non-controllable lease was discarded and a fresh one created.
  assert.equal(lease.snapshot().tabId, 42)
  assert.equal(storage.local.verbooBackgroundWorkspace?.tabId, 42, 'the fresh lease is persisted')
})

test('PÓS-CAMPO-6: reset clears the lease storage', async () => {
  const { chromeApi, storage } = makeChromeApi({
    leaseTab: { id: 99, windowId: 9, url: 'https://source.example/form' },
  })
  const manager = createBackgroundWorkspaceManager({ chromeApi })
  await manager.acquire({ sourceTabId: undefined })
  assert.ok(storage.local.verbooBackgroundWorkspace, 'lease persisted after acquire')

  await manager.reset()
  assert.equal(storage.local.verbooBackgroundWorkspace, undefined)
  assert.equal(storage.session.verbooBackgroundWorkspace, undefined)
})
