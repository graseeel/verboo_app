import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

const originalChrome = globalThis.chrome

function installChromeMock() {
  const updates = []
  const scriptTargets = []
  const tabs = new Map([
    [42, { id: 42, url: 'https://agent.example/start', active: true, windowId: 7, groupId: -1 }],
    [99, { id: 99, url: 'https://user.example/work', active: true, windowId: 9, groupId: -1 }],
  ])
  const updatedListeners = []

  globalThis.chrome = {
    tabs: {
      get: async (tabId) => tabs.get(tabId),
      query: async (query) => {
        if (query?.active && query?.windowId === 7) return [tabs.get(42)]
        if (query?.active) return [tabs.get(99)]
        return [...tabs.values()]
      },
      update: async (tabId, properties) => {
        updates.push({ tabId, properties })
        const current = tabs.get(tabId)
        if (current && properties.url) tabs.set(tabId, { ...current, url: properties.url })
        return tabs.get(tabId)
      },
      group: async () => 3,
      onUpdated: {
        addListener: (listener) => {
          updatedListeners.push(listener)
          setTimeout(() => listener(updates.at(-1)?.tabId, { status: 'complete' }), 0)
        },
        removeListener: (listener) => {
          const index = updatedListeners.indexOf(listener)
          if (index >= 0) updatedListeners.splice(index, 1)
        },
      },
    },
    windows: {
      getAll: async () => [],
      update: async () => {
        throw new Error('focus must never be requested')
      },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      query: async () => [],
      update: async () => {},
    },
    scripting: {
      executeScript: async ({ target }) => {
        scriptTargets.push(target.tabId)
        return [{ result: true }]
      },
    },
    storage: {
      session: {
        get: async () => ({}),
        set: async () => {},
      },
    },
  }

  return { updates, scriptTargets }
}

afterEach(() => {
  globalThis.chrome = originalChrome
})

test('controller keeps navigate, click, and type on the turn target while another tab is active', async () => {
  const { execute } = await import('./execute.js')
  const { updates, scriptTargets } = installChromeMock()
  const context = {
    mode: 'skip',
    activeTabId: 42,
    getSiteGrant: async () => undefined,
  }

  const navigated = await execute({
    id: 'navigate-background',
    name: 'navigate',
    params: { url: 'https://agent.example/next' },
  }, context)
  const clicked = await execute({
    id: 'click-background',
    name: 'click',
    params: { selector: '#continue' },
  }, context)
  const typed = await execute({
    id: 'type-background',
    name: 'type',
    params: { selector: '#name', text: 'Verboo' },
  }, context)

  assert.equal(navigated.ok, true)
  assert.equal(clicked.ok, true)
  assert.equal(typed.ok, true)
  assert.deepEqual(updates, [
    { tabId: 42, properties: { url: 'https://agent.example/next' } },
  ])
  assert.ok(scriptTargets.length > 0)
  assert.deepEqual(new Set(scriptTargets), new Set([42]))
  assert.equal(updates.some(({ properties }) => properties.active === true), false)
})
