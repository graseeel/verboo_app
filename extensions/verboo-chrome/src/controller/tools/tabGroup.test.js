import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

import { tabGroup } from './tabGroup.js'

const originalChrome = globalThis.chrome
afterEach(() => { globalThis.chrome = originalChrome })

test('tab groups cannot mutate tabs outside the leased workspace', async () => {
  let grouped = false
  globalThis.chrome = {
    tabs: {
      get: async (tabId) => ({ id: tabId, windowId: tabId === 42 ? 7 : 9 }),
      group: async () => { grouped = true; return 3 },
    },
  }

  await assert.rejects(
    () => tabGroup(
      { name: 'tab_group', action: 'create', tabIds: [42, 99] },
      { workspaceWindowId: 7 },
    ),
    /outside_workspace/,
  )
  assert.equal(grouped, false)
})

test('creating a group keeps its tabs inside the leased workspace window', async () => {
  const groupCalls = []
  globalThis.chrome = {
    tabs: {
      get: async (tabId) => ({ id: tabId, windowId: 7 }),
      group: async (options) => {
        groupCalls.push(options)
        return 3
      },
    },
    tabGroups: {
      update: async () => {},
    },
  }

  await tabGroup(
    { name: 'tab_group', action: 'create', tabIds: [42], title: 'Work' },
    { workspaceWindowId: 7 },
  )

  assert.deepEqual(groupCalls, [{
    tabIds: [42],
    createProperties: { windowId: 7 },
  }])
})
