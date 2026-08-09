import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

import { navigate } from './navigate.js'

const originalChrome = globalThis.chrome
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout

afterEach(() => {
  globalThis.chrome = originalChrome
  globalThis.setTimeout = originalSetTimeout
  globalThis.clearTimeout = originalClearTimeout
})

test('navigate clears its 30 second fallback timer after the target finishes loading', async () => {
  const listeners = []
  const cleared = []
  const timeoutToken = { kind: 'navigation-timeout' }
  globalThis.setTimeout = (callback, delay) => {
    if (delay === 30_000) return timeoutToken
    queueMicrotask(callback)
    return { kind: 'short-delay' }
  }
  globalThis.clearTimeout = (token) => cleared.push(token)
  globalThis.chrome = {
    tabs: {
      get: async () => ({ id: 42, windowId: 7, url: 'https://example.com' }),
      update: async () => ({}),
      query: async () => [],
      group: async () => 3,
      onUpdated: {
        addListener: (listener) => {
          listeners.push(listener)
          queueMicrotask(() => listener(42, { status: 'complete' }))
        },
        removeListener: () => {},
      },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      query: async () => [],
      update: async () => {},
    },
    scripting: { executeScript: async () => [{ result: true }] },
    storage: { session: { get: async () => ({}), set: async () => {} } },
  }

  await navigate({ name: 'navigate', url: 'https://example.com/next' }, { activeTabId: 42 })

  assert.equal(listeners.length, 1)
  assert.deepEqual(cleared, [timeoutToken])
})
