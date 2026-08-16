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
  const getCalls = []
  const updates = []
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
          updates.push({ tabId, properties })
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
    updates,
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

// ── PÓS-CAMPO-7: lease URL EQUALITY (stale-but-controllable lease) ──

test('PÓS-CAMPO-7: a stale-but-controllable lease is re-navigated to the user URL and the load is awaited', async () => {
  const { chromeApi, updates } = makeChromeApi({
    // Stale lease from the morning tests: controllable (http) but the
    // WRONG page — the round-7 evidence (dead localhost).
    leaseTab: { id: 99, windowId: 9, url: 'http://localhost:3000/' },
    sourceTab: { id: 5, windowId: 9, url: 'https://todomvc.com/examples/react/dist' },
    statusSequence: ['loading', 'complete'],
  })
  const manager = createBackgroundWorkspaceManager({ chromeApi })
  await chromeApi.storage.local.set({ verbooBackgroundWorkspace: { tabId: 99, windowId: 9 } })

  const lease = await manager.acquireControllable({
    sourceTabId: 5,
    resume: true,
    isControllableUrl: (url) => /^https?:\/\//i.test(String(url ?? '')),
  })

  // SAME invisible workspace tab (no user-tab theft), navigated to the
  // user's current page, with the load awaited before use.
  assert.equal(lease.snapshot().tabId, 99)
  assert.deepEqual(updates.map((u) => u.properties.url), [
    'https://todomvc.com/examples/react/dist',
  ])
  const tab = await chromeApi.tabs.get(99)
  assert.equal(tab.url, 'https://todomvc.com/examples/react/dist')
  assert.equal(tab.status, 'complete')
})

test('PÓS-CAMPO-7: a matching lease URL causes ZERO extra navigation (no SPA reload)', async () => {
  const { chromeApi, updates } = makeChromeApi({
    leaseTab: { id: 99, windowId: 9, url: 'https://todomvc.com/examples/react/dist#/active' },
    sourceTab: { id: 5, windowId: 9, url: 'https://todomvc.com/examples/react/dist' },
  })
  const manager = createBackgroundWorkspaceManager({ chromeApi })
  await chromeApi.storage.local.set({ verbooBackgroundWorkspace: { tabId: 99, windowId: 9 } })

  await manager.acquireControllable({
    sourceTabId: 5,
    resume: true,
    isControllableUrl: (url) => /^https?:\/\//i.test(String(url ?? '')),
  })

  // Hash-only difference (SPA route state on the same document) → NO
  // reload; the user's SPA state is preserved.
  assert.equal(updates.length, 0, 'a hash-only difference must not reload the page')
})

test('PÓS-CAMPO-7: a non-controllable source tab keeps the current behavior (no navigation)', async () => {
  const { chromeApi, updates } = makeChromeApi({
    leaseTab: { id: 99, windowId: 9, url: 'https://old.example/keep' },
    sourceTab: { id: 5, windowId: 9, url: 'chrome://settings' },
  })
  const manager = createBackgroundWorkspaceManager({ chromeApi })
  await chromeApi.storage.local.set({ verbooBackgroundWorkspace: { tabId: 99, windowId: 9 } })

  const lease = await manager.acquireControllable({
    sourceTabId: 5,
    resume: true,
    isControllableUrl: (url) => /^https?:\/\//i.test(String(url ?? '')),
  })

  assert.equal(updates.length, 0, 'chrome:// source must not trigger a lease navigation')
  assert.equal(lease.snapshot().tabId, 99)
})

test('PÓS-CAMPO-7: mid-turn model navigation is never re-validated (turn-start only)', async () => {
  const { chromeApi, updates } = makeChromeApi({
    leaseTab: { id: 99, windowId: 9, url: 'https://todomvc.com/examples/react/dist' },
    sourceTab: { id: 5, windowId: 9, url: 'https://todomvc.com/examples/react/dist' },
  })
  const manager = createBackgroundWorkspaceManager({ chromeApi })
  await chromeApi.storage.local.set({ verbooBackgroundWorkspace: { tabId: 99, windowId: 9 } })

  const lease = await manager.acquireControllable({
    sourceTabId: 5,
    resume: true,
    isControllableUrl: (url) => /^https?:\/\//i.test(String(url ?? '')),
  })
  const updatesAtStart = updates.length

  // The model's mid-turn tabs action moves the lease target — the manager
  // must NOT re-validate or re-navigate it afterwards (same workspace
  // window, as selectTab enforces).
  await lease.selectTab(43, 9)
  assert.equal(lease.snapshot().tabId, 43)
  assert.equal(updates.length, updatesAtStart, 'mid-turn lease changes are never re-validated')
})

// ── DECISÃO DO DONO (workspace, 2026-08-15): the tab where the panel was
//    when the prompt was sent IS the working tab. leaseSourceTab leases
//    the user's own tab — NO invisible mirror window, NO tab/window
//    creation. Background work happens without focus; the user may switch
//    tabs freely. If the tab is closed mid-turn, tools fail honestly.

test('DECISÃO DO DONO: leaseSourceTab leases the user\'s own tab and NEVER creates a window', async () => {
  const creates = []
  const tabs = new Map([
    [99, { id: 99, windowId: 9, url: 'https://source.example/form', active: true, status: 'complete' }],
  ])
  const windows = new Map([[9, { id: 9, focused: true }]])
  const chromeApi = {
    tabs: { get: async (id) => { const t = tabs.get(id); if (!t) throw new Error('tab missing'); return t } },
    windows: {
      create: async (options) => { creates.push(options); throw new Error('must not be called') },
      get: async (id) => { const w = windows.get(id); if (!w) throw new Error('window missing'); return w },
    },
    storage: {
      session: { get: async () => ({}), set: async () => {} },
      local: { get: async () => ({}), set: async () => {} },
    },
  }
  const { createBackgroundWorkspaceManager } = await import('./backgroundWorkspace.js')
  const manager = createBackgroundWorkspaceManager({ chromeApi })
  const lease = await manager.leaseSourceTab(99)
  assert.equal(lease.snapshot().tabId, 99, 'lease aponta para a aba de origem')
  assert.equal(lease.snapshot().windowId, 9, 'windowId é o da aba de origem')
  assert.equal(creates.length, 0, 'NENHUMA janela criada — a aba do usuário é a aba de trabalho')
})

test('DECISÃO DO DONO: leaseSourceTab fails honestly when the source tab is gone (no silent fallback)', async () => {
  const tabs = new Map() // 99 não existe
  const chromeApi = {
    tabs: { get: async (id) => { const t = tabs.get(id); if (!t) throw new Error('tab missing'); return t } },
    windows: { create: async () => { throw new Error('must not be called') }, get: async () => null },
    storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  }
  const { createBackgroundWorkspaceManager } = await import('./backgroundWorkspace.js')
  const manager = createBackgroundWorkspaceManager({ chromeApi })
  await assert.rejects(() => manager.leaseSourceTab(99), /target_tab_unavailable|tab missing/)
})
