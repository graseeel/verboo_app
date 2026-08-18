import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

import { tabs } from './tabs.js'

const originalChrome = globalThis.chrome

afterEach(() => {
  globalThis.chrome = originalChrome
})

test('tabs lists, switches, and closes the requested tab', async () => {
  const updates = []
  const removals = []
  globalThis.chrome = {
    tabs: {
      query: async () => [
        { id: 11, url: 'https://example.com', title: 'Example', active: true, windowId: 2 },
        { id: 12, url: 'https://verboo.ai', title: 'Verboo', active: false, windowId: 2 },
      ],
      update: async (...args) => updates.push(args),
      remove: async (...args) => removals.push(args),
    },
  }

  const listed = await tabs({ name: 'tabs', action: 'list' })
  assert.equal(listed.count, 2)
  assert.deepEqual(listed.tabs.map((tab) => tab.id), [11, 12])

  assert.deepEqual(await tabs({ name: 'tabs', action: 'switch', tabId: 12 }), {
    tabId: 12,
    switched: true,
  })
  // DECISÃO DO DONO: tabs.switch NÃO foca — só muda o lease via setActiveTabId.
  assert.deepEqual(updates, [], 'tabs.switch não chama tabs.update (sem foco automático)')

  assert.deepEqual(await tabs({ name: 'tabs', action: 'close', tabId: 11 }), {
    tabId: 11,
    closed: true,
  })
  assert.deepEqual(removals, [[11]])
})

test('tabs.new creates and groups an HTTP tab', async () => {
  const creates = []
  const grouped = []
  globalThis.chrome = {
    tabs: {
      create: async (options) => {
        creates.push(options)
        return { id: 31, windowId: 4, groupId: -1 }
      },
      get: async () => ({ id: 31, windowId: 4, groupId: -1 }),
      group: async (options) => {
        grouped.push(options)
        return 7
      },
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      query: async () => [],
      update: async () => {},
    },
  }

  const result = await tabs({ name: 'tabs', action: 'new', url: 'https://example.com/new' })

  assert.deepEqual(creates, [{ url: 'https://example.com/new', active: false }])
  assert.deepEqual(grouped, [{ tabIds: [31], createProperties: { windowId: 4 } }])
  assert.deepEqual(result, { tabId: 31, url: 'https://example.com/new' })
})

test('tabs.new rejects privileged schemes before opening a tab', async () => {
  let created = false
  globalThis.chrome = {
    tabs: {
      create: async () => {
        created = true
      },
    },
  }

  await assert.rejects(
    () => tabs({ name: 'tabs', action: 'new', url: 'chrome://extensions' }),
    /unsupported scheme: chrome/,
  )
  assert.equal(created, false)
})

test('tabs actions stay inside the leased background workspace', async () => {
  const queries = []
  const updates = []
  const creates = []
  const selections = []
  const available = new Map([
    [42, { id: 42, windowId: 7, url: 'https://agent.example', active: true }],
    [43, { id: 43, windowId: 7, url: 'https://agent.example/next', active: false }],
    [99, { id: 99, windowId: 9, url: 'https://user.example', active: true }],
  ])
  globalThis.chrome = {
    tabs: {
      get: async (tabId) => available.get(tabId),
      query: async (query) => {
        queries.push(query)
        return [...available.values()].filter((tab) => tab.windowId === query.windowId)
      },
      update: async (tabId, properties) => {
        updates.push({ tabId, properties })
        return { ...available.get(tabId), ...properties }
      },
      create: async (properties) => {
        creates.push(properties)
        return { id: 44, windowId: properties.windowId, url: properties.url, active: properties.active }
      },
      group: async () => 2,
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      query: async () => [],
      update: async () => {},
    },
  }
  const context = {
    activeTabId: 42,
    workspaceWindowId: 7,
    setActiveTabId: (tabId, windowId) => selections.push({ tabId, windowId }),
  }

  const listed = await tabs({ name: 'tabs', action: 'list' }, context)
  const switched = await tabs({ name: 'tabs', action: 'switch', tabId: 43 }, context)
  const created = await tabs({ name: 'tabs', action: 'new', url: 'https://new.example' }, context)

  assert.deepEqual(listed.tabs.map((tab) => tab.id), [42, 43])
  assert.deepEqual(queries, [{ windowId: 7 }])
  assert.deepEqual(switched, { tabId: 43, switched: true })
  // DECISÃO DO DONO: switch e new NÃO focam — sem tabs.update active:true,
  // sem create active:true. O lease muda via setActiveTabId (selections).
  assert.deepEqual(updates, [], 'switch não chama tabs.update (sem foco)')
  assert.deepEqual(creates, [{ url: 'https://new.example', windowId: 7, active: false }])
  assert.deepEqual(created, { tabId: 44, url: 'https://new.example' })
  assert.deepEqual(selections, [
    { tabId: 43, windowId: 7 },
    { tabId: 44, windowId: 7 },
  ])

  await assert.rejects(
    () => tabs({ name: 'tabs', action: 'switch', tabId: 99 }, context),
    /outside_workspace/,
  )
})

test('closing the leased tab selects another tab in the same workspace', async () => {
  const selections = []
  const removals = []
  globalThis.chrome = {
    tabs: {
      get: async (tabId) => ({ id: tabId, windowId: 7 }),
      remove: async (tabId) => removals.push(tabId),
      query: async () => [{ id: 43, windowId: 7, active: true }],
    },
  }

  await tabs(
    { name: 'tabs', action: 'close', tabId: 42 },
    {
      activeTabId: 42,
      workspaceWindowId: 7,
      setActiveTabId: async (tabId, windowId) => selections.push({ tabId, windowId }),
    },
  )

  assert.deepEqual(removals, [42])
  assert.deepEqual(selections, [{ tabId: 43, windowId: 7 }])
})

test('(CLOSE) RED — close de aba NÃO-criada pelo agente BLOQUEADO em skip (erro honesto); close de criada passa', async () => {
  const removals = []
  globalThis.chrome = {
    tabs: {
      get: async (tabId) => ({ id: tabId, windowId: 7, url: 'https://example.com' }),
      remove: async (tabId) => removals.push(tabId),
      query: async () => [{ id: 43, windowId: 7, active: true }],
      create: async (props) => ({ id: 100, windowId: 7, ...props }),
    },
    tabGroups: { TAB_GROUP_ID_NONE: -1, query: async () => [], update: async () => {} },
  }
  // CICLO DEPURAÇÃO SISTEMÁTICA (close): em skip, close da aba do usuário
  // (não-criada pelo agente) deve BLOQUEAR com erro honesto. Código atual
  // executa o close → RED.
  await assert.rejects(
    () => tabs(
      { name: 'tabs', action: 'close', tabId: 99 },
      { mode: 'skip', activeTabId: 42, workspaceWindowId: 7, agentCreatedTabIds: new Set(), setActiveTabId: () => {} },
    ),
    /não foi aberta pelo agente|close_non_agent_tab/,
  )
  assert.equal(removals.length, 0, 'aba do usuário NÃO foi fechada (bloqueada)')
  // close de aba criada pelo agente passa.
  await tabs(
    { name: 'tabs', action: 'close', tabId: 100 },
    { mode: 'skip', activeTabId: 42, workspaceWindowId: 7, agentCreatedTabIds: new Set([100]), setActiveTabId: () => {} },
  )
  assert.deepEqual(removals, [100], 'aba criada pelo agente foi fechada (normal)')
})
