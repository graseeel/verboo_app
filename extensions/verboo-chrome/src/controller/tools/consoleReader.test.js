import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

import { consoleReader } from './consoleReader.js'

const originalChrome = globalThis.chrome
afterEach(() => { globalThis.chrome = originalChrome })

test('console clear uses the leased target instead of the user foreground tab', async () => {
  const targets = []
  let queried = false
  globalThis.chrome = {
    tabs: {
      get: async () => ({ id: 42, windowId: 7 }),
      query: async () => {
        queried = true
        return [{ id: 99, windowId: 9 }]
      },
    },
    scripting: {
      executeScript: async ({ target }) => targets.push(target.tabId),
    },
  }

  await consoleReader({ name: 'console_reader', action: 'clear' }, { activeTabId: 42 })

  assert.deepEqual(targets, [42])
  assert.equal(queried, false)
})
