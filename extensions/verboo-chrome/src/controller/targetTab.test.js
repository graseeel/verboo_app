import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

const originalChrome = globalThis.chrome

afterEach(() => {
  globalThis.chrome = originalChrome
})

test('an explicit closed target fails closed instead of falling back to the user tab', async () => {
  const target = await import('./targetTab.js').catch(() => ({}))
  assert.equal(typeof target.resolveTargetTab, 'function')
  let queried = false
  globalThis.chrome = {
    tabs: {
      get: async () => { throw new Error('No tab with id') },
      query: async () => {
        queried = true
        return [{ id: 99, windowId: 9, active: true }]
      },
    },
  }

  await assert.rejects(() => target.resolveTargetTab(42), /target_tab_unavailable/)
  assert.equal(queried, false)
})

test('legacy callers without a target can still resolve the current tab', async () => {
  const { resolveTargetTab } = await import('./targetTab.js')
  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 99, windowId: 9, active: true }],
    },
  }

  assert.equal((await resolveTargetTab()).id, 99)
})
