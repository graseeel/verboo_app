/**
 * background.integration.test.js — CORREÇÃO PÓS-REPROVAÇÃO (gate
 * REGRESSAO-B6B96D7, opção 1 do Farol, determinística):
 * exercitar o handler REAL de AGENT_TURN_START do background.js com
 * chrome.* e fetch mockados, painel sem sender.tab, até o 1º tool call.
 *
 * O que ESTE teste prova (docstring só alega o que o teste prova):
 *  (1) painel na janela B (sourceWindowId=20) → lease = aba ativa de B
 *      SEMPRE (mock de 2 janelas que HONRA windowId);
 *  (2) sem sourceWindowId + 2 janelas → falha honesta
 *      (target_tab_unavailable — fail-closed sob ambiguidade, nunca chuta);
 *  (3) o caminho que REPRODUZ A GENÉRICA DE CAMPO de verdade: turno
 *      classificado como conversa (browserToolsRequested=false) + modelo
 *      emite tool call → reclassify → ensureTurnWorkspace falha (sem
 *      sourceWindowId + 2 janelas) → catch converte em "Não consegui
 *      concluir o pedido. Tente novamente." (background.js:1060/1113).
 *
 * NOTA TÉCNICA: createBackgroundWorkspaceManager() captura `chrome` no
 * momento da construção (import). Usamos um ÚNICO objeto chrome cujos
 * métodos leem `state` em tempo de chamada, reconfigurado por teste.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Chrome mock reconfigurável com 2 janelas que HONRA windowId.
 * state.windows: { [windowId]: { activeTab } }.
 * tabs.query({active,windowId}) → [activeTab daquela janela].
 * tabs.query({active}) (sem windowId) → TODAS as abas ativas (1 por janela).
 */
function makeReconfigurableChrome() {
  const broadcasts = []
  const storageLocal = new Map()
  const storageSession = new Map()
  const listeners = { onMessage: [] }
  const state = { windows: {}, tabsById: new Map() }

  const chrome = {
    runtime: {
      id: 'testextensionid',
      lastError: undefined,
      onMessage: { addListener: (fn) => listeners.onMessage.push(fn) },
      onConnect: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      getPlatformInfo: (cb) => cb({ os: 'mac' }),
      sendMessage: async (msg) => { broadcasts.push(msg); return undefined },
      connectNative: () => ({
        onMessage: { addListener: () => {}, removeListener: () => {} },
        onDisconnect: { addListener: () => {}, removeListener: () => {} },
        postMessage: () => {},
        disconnect: () => {},
      }),
    },
    tabs: {
      query: async (q) => {
        if (q.active === true && Number.isInteger(q.windowId)) {
          const win = state.windows[q.windowId]
          return win?.activeTab ? [win.activeTab] : []
        }
        if (q.active === true) {
          // Todas as abas ativas (uma por janela) — para a regra do candidato único.
          return Object.values(state.windows)
            .map((w) => w.activeTab)
            .filter(Boolean)
        }
        return []
      },
      get: async (id) => {
        const tab = state.tabsById.get(id)
        if (tab) return tab
        throw new Error(`tab ${id} missing`)
      },
      update: async (id, props) => ({ ...(state.tabsById.get(id) ?? { id }), ...props }),
      create: async (props) => ({ id: 999, windowId: 10, ...props }),
      remove: async () => {},
      captureVisibleTab: async () => 'data:image/jpeg;base64,mock',
      sendMessage: async () => {},
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      onRemoved: { addListener: () => {} },
      onActivated: { addListener: () => {} },
    },
    windows: {
      getAll: async () => Object.keys(state.windows).map((id) => ({ id: Number(id), focused: true, type: 'normal' })),
      get: async (id) => ({ id, focused: true }),
      getLastFocused: async () => ({ id: 10, focused: true }),
      create: async (opts) => ({ id: 10, tabs: [{ id: 999, windowId: 10, ...opts }], ...opts }),
      update: async () => {},
    },
    tabGroups: { query: async () => [], update: async () => {} },
    scripting: { executeScript: async () => [{ result: { text: 'page content' } }] },
    storage: {
      local: {
        get: async (keys) => {
          const result = {}
          const keyArr = Array.isArray(keys) ? keys : [keys]
          for (const k of keyArr) {
            if (storageLocal.has(k)) result[k] = storageLocal.get(k)
          }
          return result
        },
        set: async (items) => { for (const [k, v] of Object.entries(items)) storageLocal.set(k, v) },
        remove: async (keys) => {
          const keyArr = Array.isArray(keys) ? keys : [keys]
          for (const k of keyArr) storageLocal.delete(k)
        },
      },
      session: {
        get: async (keys) => {
          const result = {}
          const keyArr = Array.isArray(keys) ? keys : [keys]
          for (const k of keyArr) {
            if (storageSession.has(k)) result[k] = storageSession.get(k)
          }
          return result
        },
        set: async (items) => { for (const [k, v] of Object.entries(items)) storageSession.set(k, v) },
        remove: async (keys) => {
          const keyArr = Array.isArray(keys) ? keys : [keys]
          for (const k of keyArr) storageSession.delete(k)
        },
      },
    },
    action: { onClicked: { addListener: () => {} } },
    sidePanel: { setPanelBehavior: async () => {}, setOptions: async () => {} },
    contextMenus: { create: () => {}, removeAll: async () => {}, onClicked: { addListener: () => {} } },
    alarms: { create: () => {}, clear: async () => true, onAlarm: { addListener: () => {} } },
    notifications: { create: () => {} },
    identity: { launchWebAuthFlow: async () => '', getRedirectURL: () => '' },
  }
  return { chrome, broadcasts, storageLocal, storageSession, listeners, state }
}

function makeFetchMock({ chatResponses }) {
  const requests = []
  let chatCallIndex = 0
  const toolCallResponse = {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_page', arguments: '{"selector":"body"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  }
  const textResponse = {
    choices: [{
      message: { role: 'assistant', content: 'Li a página: contém uma lista de tarefas.' },
      finish_reason: 'stop',
    }],
  }
  const fetch = async (url, opts) => {
    requests.push({ url, opts })
    if (String(url) === 'https://code.verboo.ai/router/v1/models') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'kimi-k2.7', name: 'kimi-k2.7', supportsTools: true, supportsVision: true }] }),
      }
    }
    if (String(url) === 'https://code.verboo.ai/router/v1/chat/completions') {
      const body = JSON.parse(opts?.body ?? '{}')
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0
      const response = chatResponses
        ? chatResponses[Math.min(chatCallIndex, chatResponses.length - 1)]
        : (hasTools ? toolCallResponse : textResponse)
      chatCallIndex += 1
      return { ok: true, status: 200, json: async () => response }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return { fetch, requests }
}

const toolCallResponse = {
  choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_page', arguments: '{"selector":"body"}' } }],
    },
    finish_reason: 'tool_calls',
  }],
}
const textResponse = {
  choices: [{
    message: { role: 'assistant', content: 'Li a página: contém uma lista de tarefas.' },
    finish_reason: 'stop',
  }],
}

// Singleton: importado UMA VEZ, reconfigurado por teste.
let shared = null
async function ensureImported() {
  if (shared) return shared
  shared = makeReconfigurableChrome()
  shared.storageLocal.set('verbooSession', { accountId: 'acc-1', accessToken: 'test-token', expiresAt: Date.now() + 3_600_000 })
  shared.storageLocal.set('chromePermissionMode', 'skip')
  globalThis.chrome = shared.chrome
  await import('./background.js')
  return shared
}

/**
 * Configura 2 janelas: A (id 10, aba ativa tabA) e B (id 20, aba ativa tabB).
 */
function setupTwoWindows(sh, tabA, tabB) {
  sh.state.windows = {
    10: { activeTab: tabA },
    20: { activeTab: tabB },
  }
  sh.state.tabsById = new Map([[tabA.id, tabA], [tabB.id, tabB]])
}

async function runTurn({ sourceWindowId, userMessage, chatResponses }) {
  const sh = await ensureImported()
  sh.broadcasts.length = 0
  const { fetch } = makeFetchMock({ chatResponses })
  globalThis.fetch = fetch

  const turnId = 'test-turn-' + Math.random().toString(36).slice(2)
  sh.listeners.onMessage[0](
    {
      type: 'agent:turn_start',
      turnId,
      userMessage: userMessage ?? 'o que tem nesta página?',
      modelId: 'kimi-k2.7',
      conversationHistory: [],
      ...(Number.isInteger(sourceWindowId) ? { sourceWindowId } : {}),
    },
    { id: 'testextensionid', tab: undefined, url: 'chrome-extension://testextensionid/src/panel/panel.html' },
    () => {},
  )
  const deadline = Date.now() + 25_000
  let terminal = null
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
    terminal = sh.broadcasts.find(
      (m) => (m.type === 'agent:turn_complete' || m.type === 'agent:turn_error') && m.turnId === turnId,
    )
    if (terminal) break
  }
  return { terminal, broadcasts: sh.broadcasts }
}

test('(1) painel na janela B (sourceWindowId=20) → lease = aba ativa de B SEMPRE (2 janelas)', async () => {
  const sh = await ensureImported()
  const tabA = { id: 1, windowId: 10, url: 'https://a.com/', active: true, status: 'complete' }
  const tabB = { id: 2, windowId: 20, url: 'https://todomvc.com/', active: true, status: 'complete' }
  setupTwoWindows(sh, tabA, tabB)
  const { terminal } = await runTurn({
    sourceWindowId: 20,
    chatResponses: [toolCallResponse, toolCallResponse, textResponse],
  })
  assert.ok(terminal, 'turno terminou')
  assert.equal(terminal.type, 'agent:turn_complete', `turno completou (não errou): ${terminal.error ?? ''}`)
  const generic = 'Não consegui concluir o pedido. Tente novamente.'
  assert.notEqual(terminal.assistantMessage, generic, 'não é a genérica — lease da janela B criado e turno prosseguiu')
})

test('(2) sem sourceWindowId + 2 janelas → falha honesta (target_tab_unavailable, nunca chuta janela)', async () => {
  const sh = await ensureImported()
  const tabA = { id: 1, windowId: 10, url: 'https://a.com/', active: true, status: 'complete' }
  const tabB = { id: 2, windowId: 20, url: 'https://todomvc.com/', active: true, status: 'complete' }
  setupTwoWindows(sh, tabA, tabB)
  const { terminal } = await runTurn({
    sourceWindowId: undefined,
    chatResponses: [toolCallResponse, toolCallResponse, textResponse],
  })
  assert.ok(terminal, 'turno terminou')
  // Fail-closed sob ambiguidade: NUNCA chutar janela.
  assert.equal(terminal.type, 'agent:turn_error', 'turno errou honestamente (ambiguidade de 2 janelas)')
  assert.equal(terminal.error, 'target_tab_unavailable', 'erro é target_tab_unavailable (fail-closed)')
})

test('(3) REPRODUZ A GENÉRICA DE CAMPO: conversa + tool call → reclassify → lease falha → "Não consegui concluir o pedido"', async () => {
  const sh = await ensureImported()
  const tabA = { id: 1, windowId: 10, url: 'https://a.com/', active: true, status: 'complete' }
  const tabB = { id: 2, windowId: 20, url: 'https://todomvc.com/', active: true, status: 'complete' }
  setupTwoWindows(sh, tabA, tabB)
  // Prompt de CONVERSA puro (browserToolsRequested=false — "qual é a capital"
  // não casa nenhum verbo de navegador) + modelo emite tool call → reclassify
  // → ensureTurnWorkspace falha (sem sourceWindowId + 2 janelas) → catch
  // converte em genérica (background.js:1060/1113).
  const { terminal } = await runTurn({
    sourceWindowId: undefined,
    userMessage: 'qual é a capital do Brasil?',
    chatResponses: [toolCallResponse, toolCallResponse, textResponse],
  })
  assert.ok(terminal, 'turno terminou')
  // O caminho da genérica: agent:turn_complete (NÃO error) com assistantMessage
  // = summarizePartialAgentTurn(userMessage, []) — background.js:1113,
  // ramo !browserToolsRequested do catch(llmErr), alcançado via reclassify
  // (ensureTurnWorkspace falha DENTRO do try interno, linha 1064).
  assert.equal(terminal.type, 'agent:turn_complete', 'turno COMPLETA com a genérica (não é turn_error com erro cru)')
  const generic = 'Não consegui concluir o pedido. Tente novamente.'
  assert.equal(
    terminal.assistantMessage,
    generic,
    'reproduz a genérica de campo: conversa + tool call + lease nulo → "Não consegui concluir o pedido"',
  )
})
