/**
 * leaseFidelity.test.js — DECISÃO DO DONO (workspace, 2026-08-15/16):
 * com lease vivo, TODAS as tools + presença agem no lease — NENHUMA
 * superfície resolve para a aba ativa. O usuário pode trocar de aba/janela
 * livremente mid-turn; o trabalho continua na aba de origem.
 *
 * T3 TodoMVC (build fcc1b8fe) violou isso: um type executou na aba ativa
 * (X.com) em vez do lease. Este arquivo testa CADA tool por isolamento:
 * mock com lease tab (aba 1) + active tab diferente (aba 2), chamar a tool
 * com ctx.activeTabId = 1, e provar que ela age em aba 1 (nunca consulta
 * aba ativa).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

/**
 * Mock chrome com lease tab (aba 1) viva + active tab (aba 2) diferente.
 * Rastreia TODAS as consultas de aba ativa — qualquer tool que as faça
 * fica visível no `activeQueries` counter.
 *
 * `runFunc`: se true, o executeScript roda o func no jsdom do lease
 * (para tools que precisam do resultado real); se false, retorna
 * [{result: true}] sem rodar (para tools cujo func é testado em
 * serialize.test.js — aqui só importa o TARGET.tabId).
 */
function makeChromeWithLeaseAndActive({ leaseTab, activeTab, dom, runFunc = true }) {
  const activeQueries = []
  const executeScriptTargets = []
  const tabsUpdates = []
  const chrome = {
    tabs: {
      get: async (id) => {
        if (id === leaseTab.id) return leaseTab
        if (id === activeTab.id) return activeTab
        throw new Error(`tab ${id} missing`)
      },
      query: async (q) => {
        if (q.active === true) {
          activeQueries.push(q)
          return [activeTab]
        }
        return []
      },
      update: async (id, props) => {
        tabsUpdates.push({ id, props })
        return { ...leaseTab, ...props }
      },
      captureVisibleTab: async () => 'data:image/jpeg;base64,mock',
      onUpdated: { addListener: () => {}, removeListener: () => {} },
    },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        executeScriptTargets.push(target.tabId)
        if (!runFunc) return [{ result: true }]
        if (target.tabId === leaseTab.id && dom && typeof func === 'function') {
          try {
            const value = await func(...(args ?? []))
            return [{ result: value }]
          } catch (error) {
            return [{ result: undefined, __error: error }]
          }
        }
        return [{ result: undefined }]
      },
    },
    storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
    runtime: { lastError: undefined },
  }
  return { chrome, activeQueries, executeScriptTargets, tabsUpdates }
}

const LEASE_TAB = { id: 1, windowId: 10, url: 'https://todomvc.com/', active: false, status: 'complete' }
const ACTIVE_TAB = { id: 2, windowId: 10, url: 'https://x.com/home', active: true, status: 'complete' }

/**
 * navigate espera o load via onUpdated (waitForTabComplete). O mock base
 * descarta o listener — sem isso cada teste de navigate espera o timeout
 * de 30s. Este helper guarda o listener e dispara 'complete' após o
 * tabs.update, tornando o teste rápido e realista.
 */
function fireCompleteOnUpdate(chrome) {
  let listener = null
  chrome.tabs.onUpdated = {
    addListener: (fn) => { listener = fn },
    removeListener: () => { listener = null },
  }
  const originalUpdate = chrome.tabs.update
  chrome.tabs.update = async (id, props) => {
    const result = await originalUpdate(id, props)
    // navigate registra o listener DEPOIS do update resolver — disparar
    // 'complete' num timer curto garante que o listener já está no lugar.
    setTimeout(() => listener?.(id, { status: 'complete' }), 5)
    return result
  }
}

test('type: com lease vivo + aba ativa diferente, age no lease (nunca consulta aba ativa)', async () => {
  const dom = new JSDOM('<input id="t">', { url: 'https://todomvc.com/' })
  const { chrome, activeQueries, executeScriptTargets } = makeChromeWithLeaseAndActive({ leaseTab: LEASE_TAB, activeTab: ACTIVE_TAB, dom })
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.chrome = chrome
  try {
    const { typeText } = await import('./type.js')
    const result = await typeText({ name: 'type', selector: '#t', text: 'buy milk' }, { activeTabId: 1 })
    assert.equal(result.url, 'https://todomvc.com/', 'resultado carrega URL do lease, não da aba ativa')
    assert.equal(executeScriptTargets[0], 1, 'executeScript no lease (aba 1)')
    assert.equal(activeQueries.length, 0, 'NUNCA consultou aba ativa')
  } finally {
    delete globalThis.document
    delete globalThis.Event
    delete globalThis.KeyboardEvent
    delete globalThis.chrome
  }
})

test('click: com lease vivo + aba ativa diferente, age no lease', async () => {
  const dom = new JSDOM('<button id="b">OK</button>', { url: 'https://todomvc.com/' })
  dom.window.Element.prototype.scrollIntoView = function () {}
  // click chama preparePresenceForAction (presence funcs) — runFunc false
  // aqui: o func do click é testado em serialize.test.js; aqui só provamos
  // que o TARGET.tabId é o lease (não a aba ativa).
  const { chrome, activeQueries, executeScriptTargets } = makeChromeWithLeaseAndActive({ leaseTab: LEASE_TAB, activeTab: ACTIVE_TAB, dom, runFunc: false })
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.PointerEvent = dom.window.PointerEvent ?? class PointerEvent extends dom.window.MouseEvent {}
  globalThis.chrome = chrome
  try {
    const { click } = await import('./click.js')
    await click({ name: 'click', selector: '#b' }, { activeTabId: 1 })
    assert.ok(executeScriptTargets.every((t) => t === 1), 'todos executeScript no lease (aba 1)')
    assert.equal(activeQueries.length, 0, 'NUNCA consultou aba ativa')
  } finally {
    delete globalThis.document
    delete globalThis.Event
    delete globalThis.MouseEvent
    delete globalThis.PointerEvent
    delete globalThis.chrome
  }
})

test('find: com lease vivo + aba ativa diferente, age no lease', async () => {
  const dom = new JSDOM('<button id="b" title="Salvar">Salvar</button>', { url: 'https://todomvc.com/' })
  const { chrome, activeQueries, executeScriptTargets } = makeChromeWithLeaseAndActive({ leaseTab: LEASE_TAB, activeTab: ACTIVE_TAB, dom })
  globalThis.document = dom.window.document
  globalThis.chrome = chrome
  try {
    const { findTool } = await import('./find.js')
    const result = await findTool({ name: 'find', text: 'salvar' }, { activeTabId: 1 })
    assert.equal(result.url, 'https://todomvc.com/', 'find no lease')
    assert.equal(executeScriptTargets[0], 1)
    assert.equal(activeQueries.length, 0, 'NUNCA consultou aba ativa')
  } finally {
    delete globalThis.document
    delete globalThis.chrome
  }
})

test('read_page: com lease vivo + aba ativa diferente, age no lease', async () => {
  const dom = new JSDOM('<div id="root">TodoMVC content</div>', { url: 'https://todomvc.com/' })
  const { chrome, activeQueries, executeScriptTargets } = makeChromeWithLeaseAndActive({ leaseTab: LEASE_TAB, activeTab: ACTIVE_TAB, dom })
  globalThis.document = dom.window.document
  globalThis.chrome = chrome
  try {
    const { readPage } = await import('./readPage.js')
    await readPage({ name: 'read_page', selector: '#root' }, { activeTabId: 1 })
    assert.equal(executeScriptTargets[0], 1, 'read_page no lease')
    assert.equal(activeQueries.length, 0, 'NUNCA consultou aba ativa')
  } finally {
    delete globalThis.document
    delete globalThis.chrome
  }
})

test('screenshot: com lease vivo + aba ativa diferente, captura a JANELA do lease (nunca a aba ativa)', async () => {
  const dom = new JSDOM('<html><body></body></html>', { url: 'https://todomvc.com/' })
  const captures = []
  const executeScriptTargets = []
  // Consultas de aba ativa SEM windowId = o padrão da fuga (resolveTargetTab
  // sem lease). A checagem de capacidade do screenshot (isTabActiveInWindow)
  // é windowId-escopada e legítima — o alvo da captura é o lease.
  const targetQueries = []
  const chrome = {
    tabs: {
      get: async (id) => {
        if (id === LEASE_TAB.id) return LEASE_TAB
        if (id === ACTIVE_TAB.id) return ACTIVE_TAB
        throw new Error(`tab ${id} missing`)
      },
      query: async (q) => {
        if (q.active === true && Number.isInteger(q.windowId)) {
          // Capacidade: o lease está ativo NA PRÓPRIA janela (captureVisibleTab
          // exige isso) — não é resolução de alvo.
          return [LEASE_TAB]
        }
        if (q.active === true) {
          targetQueries.push(q)
          return [ACTIVE_TAB]
        }
        return []
      },
      captureVisibleTab: async (windowId, opts) => {
        captures.push({ windowId, opts })
        return 'data:image/jpeg;base64,mock'
      },
      onUpdated: { addListener: () => {}, removeListener: () => {} },
    },
    scripting: {
      executeScript: async ({ target }) => {
        executeScriptTargets.push(target.tabId)
        return [{ result: { w: 100, h: 50 } }]
      },
    },
    storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
    runtime: { lastError: undefined },
  }
  globalThis.document = dom.window.document
  globalThis.chrome = chrome
  try {
    const { screenshot } = await import('./screenshot.js')
    const result = await screenshot({ name: 'screenshot' }, { activeTabId: 1 })
    assert.equal(captures.length, 1, 'capturou exatamente uma vez')
    assert.equal(captures[0].windowId, 10, 'captura a janela do lease (10), não a da aba ativa')
    assert.ok(executeScriptTargets.length > 0, 'presença + dimensões executaram no lease')
    assert.ok(executeScriptTargets.every((t) => t === 1), 'todos executeScript no lease (aba 1)')
    assert.equal(targetQueries.length, 0, 'NUNCA consultou aba ativa para resolução de alvo')
    assert.equal(result.dataUrl, 'data:image/jpeg;base64,mock')
  } finally {
    delete globalThis.document
    delete globalThis.chrome
  }
})

test('navigate: com lease vivo, navega o lease (não a aba ativa) e NÃO foca', async () => {
  const dom = new JSDOM('<html><body></body></html>', { url: 'https://todomvc.com/' })
  const { chrome, activeQueries, tabsUpdates } = makeChromeWithLeaseAndActive({ leaseTab: LEASE_TAB, activeTab: ACTIVE_TAB, dom })
  globalThis.document = dom.window.document
  globalThis.chrome = chrome
  // navigate usa onUpdated listener para waitForTabComplete — dispara
  // 'complete' após o update (sem isso o teste espera o timeout de 30s).
  fireCompleteOnUpdate(chrome)
  try {
    const { navigate } = await import('./navigate.js')
    const result = await navigate({ name: 'navigate', url: 'https://todomvc.com/examples/vue/' }, { activeTabId: 1 })
    assert.equal(result.tabId, 1, 'navegou o lease (aba 1), não a aba ativa (aba 2)')
    // tabs.update deve ser { url } SEM active: true (não foca)
    const navUpdate = tabsUpdates.find((u) => u.id === 1 && u.props?.url)
    assert.ok(navUpdate, 'navegou o lease via tabs.update({url})')
    assert.equal(navUpdate.props.active, undefined, 'navigate NÃO foca a aba (sem active:true)')
    assert.equal(activeQueries.length, 0, 'NUNCA consultou aba ativa')
  } finally {
    delete globalThis.document
    delete globalThis.chrome
  }
})

test('navigate: NÃO muda o lease (não chama setActiveTabId)', async () => {
  const dom = new JSDOM('<html><body></body></html>', { url: 'https://todomvc.com/' })
  const { chrome } = makeChromeWithLeaseAndActive({ leaseTab: LEASE_TAB, activeTab: ACTIVE_TAB, dom })
  globalThis.document = dom.window.document
  globalThis.chrome = chrome
  fireCompleteOnUpdate(chrome)
  try {
    const { navigate } = await import('./navigate.js')
    let setActiveCalled = false
    await navigate({ name: 'navigate', url: 'https://todomvc.com/examples/vue/' }, {
      activeTabId: 1,
      workspaceWindowId: 10,
      setActiveTabId: () => { setActiveCalled = true },
    })
    assert.equal(setActiveCalled, false, 'navigate NÃO chama setActiveTabId — o lease fica na mesma aba (só a URL mudou)')
  } finally {
    delete globalThis.document
    delete globalThis.chrome
  }
})

test('tabs.switch: NÃO foca a aba (regra do dono: foco automático NUNCA, só gesto no chip)', async () => {
  const dom = new JSDOM('<html><body></body></html>', { url: 'https://todomvc.com/' })
  const { chrome, tabsUpdates } = makeChromeWithLeaseAndActive({ leaseTab: LEASE_TAB, activeTab: ACTIVE_TAB, dom })
  globalThis.document = dom.window.document
  globalThis.chrome = chrome
  try {
    const { tabs } = await import('./tabs.js')
    await tabs({ name: 'tabs', action: 'switch', tabId: 1 }, { activeTabId: 1, workspaceWindowId: 10, setActiveTabId: () => {} })
    const focusUpdates = tabsUpdates.filter((u) => u.props?.active === true)
    assert.equal(focusUpdates.length, 0, 'tabs.switch NÃO chama tabs.update({active:true}) — foco só no gesto do chip')
  } finally {
    delete globalThis.document
    delete globalThis.chrome
  }
})

test('tabs.new: NÃO foca a aba nova (regra do dono)', async () => {
  const dom = new JSDOM('<html><body></body></html>', { url: 'https://todomvc.com/' })
  const { chrome } = makeChromeWithLeaseAndActive({ leaseTab: LEASE_TAB, activeTab: ACTIVE_TAB, dom })
  globalThis.document = dom.window.document
  globalThis.chrome = chrome
  // tabs.new usa chrome.tabs.create — mock para capturar active
  const creates = []
  chrome.tabs.create = async (props) => {
    creates.push(props)
    return { id: 3, windowId: props.windowId ?? 10, url: props.url, active: props.active }
  }
  chrome.tabGroups = { update: async () => {} }
  try {
    const { tabs } = await import('./tabs.js')
    await tabs({ name: 'tabs', action: 'new', url: 'https://example.com/' }, { activeTabId: 1, workspaceWindowId: 10, setActiveTabId: () => {} })
    assert.equal(creates.length, 1)
    assert.notEqual(creates[0].active, true, 'tabs.new NÃO foca a aba nova (sem active:true)')
  } finally {
    delete globalThis.document
    delete globalThis.chrome
  }
})
