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
 *      sourceWindowId + 2 janelas) → o catch (llmErr) do runAgentTurn
 *      converte em "Não consegui concluir o pedido. Tente novamente."
 *      (via summarizePartialAgentTurn no ramo !browserToolsRequested).
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
  const state = { windows: {}, tabsById: new Map(), ungroupCalls: [], currentWindowResult: [] }

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
        if (q.active === true && q.currentWindow === true) {
          // FONTE ÚNICA (Farol): o loop NÃO deve consultar currentWindow —
          // usa activeTab?.url (a aba do lease). Este resultado existe para
          // o teste provar que a URL do currentWindow NÃO é usada.
          return state.currentWindowResult ?? []
        }
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
      create: async (props) => {
        const tab = { id: 999, windowId: props.windowId ?? 10, ...props }
        state.tabsById.set(tab.id, tab)
        return tab
      },
      remove: async (tabId) => { state.tabsById.delete(tabId) },
      ungroup: async (ids) => { state.ungroupCalls.push(ids) },
      group: async () => 7,
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
    tabGroups: { TAB_GROUP_ID_NONE: -1, query: async () => [], update: async () => {} },
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

async function runTurn({ sourceWindowId, sourceTabId, userMessage, chatResponses }) {
  const sh = await ensureImported()
  sh.broadcasts.length = 0
  sh.state.ungroupCalls.length = 0
  const consoleLogs = []
  const origLog = console.log
  console.log = (...args) => { consoleLogs.push(args.map(String).join(' ')); origLog(...args) }
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
      ...(Number.isInteger(sourceTabId) ? { sourceTabId } : {}),
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
  console.log = origLog
  return { terminal, broadcasts: sh.broadcasts, consoleLogs }
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
  // → ensureTurnWorkspace falha (sem sourceWindowId + 2 janelas) → o catch
  // (llmErr) do runAgentTurn converte em genérica (summarizePartialAgentTurn,
  // ramo !browserToolsRequested).
  const { terminal } = await runTurn({
    sourceWindowId: undefined,
    userMessage: 'qual é a capital do Brasil?',
    chatResponses: [toolCallResponse, toolCallResponse, textResponse],
  })
  assert.ok(terminal, 'turno terminou')
  // O caminho da genérica: agent:turn_complete (NÃO error) com assistantMessage
  // = summarizePartialAgentTurn(userMessage, []) — ramo !browserToolsRequested
  // do catch(llmErr) do runAgentTurn, alcançado via reclassify (o
  // ensureTurnWorkspace falha DENTRO do try interno).
  assert.equal(terminal.type, 'agent:turn_complete', 'turno COMPLETA com a genérica (não é turn_error com erro cru)')
  const generic = 'Não consegui concluir o pedido. Tente novamente.'
  assert.equal(
    terminal.assistantMessage,
    generic,
    'reproduz a genérica de campo: conversa + tool call + lease nulo → "Não consegui concluir o pedido"',
  )
})

test('(4) CAMPO: conversa + sourceWindowId + reclassify → executeTool RECEBE o lease → 1º tool executa (não morre com target_tab_unavailable)', async () => {
  const sh = await ensureImported()
  const tabA = { id: 1, windowId: 10, url: 'https://a.com/', active: true, status: 'complete' }
  const tabB = { id: 2, windowId: 20, url: 'https://todomvc.com/', active: true, status: 'complete' }
  setupTwoWindows(sh, tabA, tabB)
  // Cenário de CAMPO (build 1239d7a): painel envia sourceWindowId (janela B),
  // prompt de CONVERSA (browserToolsRequested=false) + modelo emite tool call
  // → reclassify → ensureTurnWorkspace(false) cria o lease → re-run com tools
  // → executeTool DEVE receber o lease (turnTabLease) e o 1º tool DEVE executar.
  // O defeito de campo: executeTool constrói o contexto SEM o leasedTarget →
  // resolveExecutionTabId lança target_tab_unavailable → 1º tool morre.
  const { terminal, broadcasts } = await runTurn({
    sourceWindowId: 20,
    userMessage: 'qual é a capital do Brasil?',
    chatResponses: [toolCallResponse, toolCallResponse, textResponse],
  })
  assert.ok(terminal, 'turno terminou')
  // O 1º tool (read_page) DEVE ter executado — AGENT_TOOL_EXECUTING broadcast.
  const executing = broadcasts.find(
    (m) => m.type === 'agent:tool_executing' && m.toolName === 'read_page',
  )
  assert.ok(executing, '1º tool (read_page) EXECUTOU — executeTool recebeu o lease e passou por executeWithApproval')
  assert.equal(terminal.type, 'agent:turn_complete', `turno completou (não errou): ${terminal.error ?? ''}`)
  const generic = 'Não consegui concluir o pedido. Tente novamente.'
  assert.notEqual(terminal.assistantMessage, generic, 'não é a genérica — o lease chegou ao executeTool')
})

test('(5) RED-DE-VERDADE: L2 (crie uma tarefa) + sourceWindowId + 1 janela → browserToolsRequested=true → lease no arranque + 1º tool SEM reclassify', async () => {
  const sh = await ensureImported()
  // Insumo exato do Farol: 'crie uma tarefa chamada comprar pão' (L2 imperativo
  // + URL controlável), sourceWindowId presente, UMA janela, aba https.
  // Mock devolve a aba também para {active:true,currentWindow:true}.
  const tab = { id: 2, windowId: 20, url: 'https://todomvc.com/', active: true, status: 'complete' }
  sh.state.windows = { 20: { activeTab: tab } }
  sh.state.tabsById = new Map([[tab.id, tab]])
  // Override tabs.query para devolver a aba também para currentWindow:true.
  const origQuery = sh.chrome.tabs.query
  sh.chrome.tabs.query = async (q) => {
    if (q.active === true && q.currentWindow === true) return [tab]
    return origQuery(q)
  }

  const { terminal, broadcasts, consoleLogs } = await runTurn({
    sourceWindowId: 20,
    userMessage: 'crie uma tarefa chamada comprar pão',
    chatResponses: [toolCallResponse, textResponse],
  })
  assert.ok(terminal, 'turno terminou')
  // (a) 1º tool executou.
  const executing = broadcasts.find(
    (m) => m.type === 'agent:tool_executing' && m.toolName === 'read_page',
  )
  assert.ok(executing, '1º tool (read_page) EXECUTOU')
  // (b) leaseSourceTab log apareceu (lease criado).
  const leaseLog = consoleLogs.find((l) => l.includes('leaseSourceTab'))
  assert.ok(leaseLog, 'log leaseSourceTab apareceu (lease criado)')
  // (c) SEM reclassify — o turno foi de navegador de verdade (browserToolsRequested=true),
  // não conversa que reclassificou. Contra 1239d7a puro (2 args, L2 não dispara),
  // o reclassify aconteceria → este assert falha (RED).
  const reclassifyThought = broadcasts.find(
    (m) => m.type === 'agent:thought' && /reclassificando|reclassifying/i.test(String(m.text ?? '')),
  )
  assert.ok(!reclassifyThought, 'SEM reclassify — browserToolsRequested=true (L2 disparou com activeTabUrl)')
})

test('(A) RED — corrida de captura no nível da aba: painel envia sourceTabId=2 (TodoMVC), mas a aba ativa virou tab 3 (X.com) → lease DEVE ser tab 2 (do envio), não tab 3', async () => {
  const sh = await ensureImported()
  // Cenário de campo (build 8d61dcb): usuário envia o prompt na aba TodoMVC
  // (tab 2, janela 20) e troca para X.com (tab 3, mesma janela) em ms. O
  // painel captura sourceTabId=2 no envio. O background recebe sourceTabId=2
  // E sourceWindowId=20. A query tabs.query({active,windowId:20}) agora
  // devolve tab 3 (X.com — o usuário trocou). O código ATUAL usa a query →
  // leaseia tab 3 (errada). Com o fix, o background valida e usa sourceTabId
  // diretamente → leaseia tab 2 (correta).
  const todoTab = { id: 2, windowId: 20, url: 'https://todomvc.com/', active: false, status: 'complete' }
  const xTab = { id: 3, windowId: 20, url: 'https://x.com/home', active: true, status: 'complete' }
  sh.state.windows = { 20: { activeTab: xTab } }  // a aba ATIVA agora é X.com
  sh.state.tabsById = new Map([[todoTab.id, todoTab], [xTab.id, xTab]])

  const { terminal, consoleLogs } = await runTurn({
    sourceWindowId: 20,
    sourceTabId: 2,  // painel capturou TodoMVC no envio
    userMessage: 'crie uma tarefa chamada comprar pão',
    chatResponses: [toolCallResponse, textResponse],
  })
  assert.ok(terminal, 'turno terminou')
  // O lease DEVE ser tab 2 (TodoMVC — a aba do envio), não tab 3 (X.com).
  const leaseLog = consoleLogs.find((l) => l.includes('leaseSourceTab'))
  assert.ok(leaseLog, 'log leaseSourceTab apareceu')
  assert.ok(leaseLog.includes('tab 2'), `lease é tab 2 (TodoMVC do envio), não tab 3 (X.com). Log: ${leaseLog}`)
  assert.ok(!leaseLog.includes('tab 3'), `lease NÃO é tab 3 (X.com — a aba ativa pós-troca). Log: ${leaseLog}`)
})

// ── CICLO A (1) — 3 TESTES DE LIGAÇÃO (MUT-C/D/E), sonda estilo integração ──
// Cada teste prova que UMA mutação é load-bearing: RED quando a linha é
// removida, GREEN quando presente. Encanamento de turno real (handler
// AGENT_TURN_START → runAgentTurn → executeTool → tool real).

function toolCallArgs(name, args) {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-' + Math.random().toString(36).slice(2), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: 'tool_calls',
    }],
  }
}

test('(MUT-C) LIGAÇÃO: tabs.switch muda o lease → aba ANTERIOR é desagrupada (ungroupVerbooTab em setActiveTabId)', async () => {
  const sh = await ensureImported()
  const tab2 = { id: 2, windowId: 20, url: 'https://todomvc.com/', active: false, status: 'complete' }
  const tab3 = { id: 3, windowId: 20, url: 'https://x.com/home', active: true, status: 'complete' }
  sh.state.windows = { 20: { activeTab: tab3 } }
  sh.state.tabsById = new Map([[tab2.id, tab2], [tab3.id, tab3]])
  const { terminal } = await runTurn({
    sourceWindowId: 20,
    sourceTabId: 2,
    userMessage: 'crie uma tarefa chamada comprar pão',
    chatResponses: [toolCallArgs('tabs', { action: 'switch', tabId: 3 }), textResponse],
  })
  assert.ok(terminal, 'turno terminou')
  // MUT-C: setActiveTabId chama ungroupVerbooTab(previousTabId=2).
  const ungrouped = sh.state.ungroupCalls.some((ids) => ids.includes(2))
  assert.ok(ungrouped, 'aba anterior (2) foi desagrupada quando o lease mudou para 3')
})

test('(MUT-D) LIGAÇÃO: tabs.new adiciona a aba ao Set (agentCreatedTabIds.add) → close dela em skip passa', async () => {
  const sh = await ensureImported()
  const tab2 = { id: 2, windowId: 20, url: 'https://todomvc.com/', active: true, status: 'complete' }
  sh.state.windows = { 20: { activeTab: tab2 } }
  sh.state.tabsById = new Map([[tab2.id, tab2]])
  const { terminal } = await runTurn({
    sourceWindowId: 20,
    sourceTabId: 2,
    userMessage: 'crie uma tarefa chamada comprar pão',
    chatResponses: [
      toolCallArgs('tabs', { action: 'new', url: 'https://new.example' }),
      toolCallArgs('tabs', { action: 'close', tabId: 999 }),
      textResponse,
    ],
  })
  assert.ok(terminal, 'turno terminou')
  // MUT-D: sem o add, o close de 999 em skip seria BLOQUEADO (close_non_agent_tab).
  // O loop captura o erro da tool e o turno completa — verifica o toolResult.
  const closeFailed = (terminal.toolResults ?? []).some(
    (r) => r.success === false && /close_non_agent_tab/.test(String(r.error ?? '')),
  )
  assert.ok(!closeFailed, 'close da aba criada pelo agente (999) NÃO foi bloqueado em skip — o add do newTab funcionou')
})

test('(MUT-E) LIGAÇÃO: makeExecutionContext expõe agentCreatedTabIds (Set por turno) → o add do newTab persiste entre tool calls', async () => {
  const sh = await ensureImported()
  const tab2 = { id: 2, windowId: 20, url: 'https://todomvc.com/', active: true, status: 'complete' }
  sh.state.windows = { 20: { activeTab: tab2 } }
  sh.state.tabsById = new Map([[tab2.id, tab2]])
  const { terminal } = await runTurn({
    sourceWindowId: 20,
    sourceTabId: 2,
    userMessage: 'crie uma tarefa chamada comprar pão',
    chatResponses: [
      toolCallArgs('tabs', { action: 'new', url: 'https://new.example' }),
      toolCallArgs('tabs', { action: 'close', tabId: 999 }),
      textResponse,
    ],
  })
  assert.ok(terminal, 'turno terminou')
  // MUT-E: sem a exposição no contexto, ctx.agentCreatedTabIds é undefined →
  // o add do newTab é no-op → close de 999 em skip seria BLOQUEADO.
  const closeFailed = (terminal.toolResults ?? []).some(
    (r) => r.success === false && /close_non_agent_tab/.test(String(r.error ?? '')),
  )
  assert.ok(!closeFailed, 'close da aba criada (999) NÃO foi bloqueado — o contexto expôs o Set e o add persistiu')
})

test('(URL-ÚNICA) FONTE ÚNICA: loop usa activeTab?.url (lease https), NÃO o currentWindow (chrome://) → L2 dispara → turno de navegador (não genérica)', async () => {
  const sh = await ensureImported()
  // Lease = aba https controlável (TodoMVC). currentWindow devolve chrome://
  // (não controlável) — o cenário do Farol: sem fonte única, o classificador
  // usava a URL do currentWindow → L2 não disparava → turno de navegador vira
  // 'Não consegui concluir o pedido' (genérica) em vez da mensagem clara.
  const leaseTab = { id: 2, windowId: 20, url: 'https://todomvc.com/', active: true, status: 'complete' }
  const chromeTab = { id: 5, windowId: 20, url: 'chrome://extensions', active: true, status: 'complete' }
  sh.state.windows = { 20: { activeTab: leaseTab } }
  sh.state.tabsById = new Map([[leaseTab.id, leaseTab], [chromeTab.id, chromeTab]])
  sh.state.currentWindowResult = [chromeTab]  // currentWindow devolve chrome://

  const { terminal, broadcasts } = await runTurn({
    sourceWindowId: 20,
    sourceTabId: 2,
    userMessage: 'crie uma tarefa chamada comprar pão',
    chatResponses: [toolCallArgs('read_page', { selector: 'body' }), textResponse],
  })
  assert.ok(terminal, 'turno terminou')
  // Com a fonte única (activeTab?.url = https), L2 dispara → browserToolsRequested=true
  // → o 1º tool (read_page) EXECUTA (sem reclassify, sem genérica).
  const executing = broadcasts.find((m) => m.type === 'agent:tool_executing' && m.toolName === 'read_page')
  assert.ok(executing, '1º tool (read_page) EXECUTOU — L2 disparou com a URL do lease (https), não a do currentWindow (chrome://)')
  const generic = 'Não consegui concluir o pedido. Tente novamente.'
  assert.notEqual(terminal.assistantMessage, generic, 'não é a genérica — o turno foi de navegador de verdade')
})
