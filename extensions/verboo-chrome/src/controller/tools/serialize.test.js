/**
 * serialize.test.js — BLINDAGEM DE TESTE contra a classe inteira de
 * defeitos de serialização do chrome.scripting.executeScript (round 9).
 *
 * CAUSA-RAIZ: executeScript serializa SÓ o `func` — seu corpo é
 * reconstruído na página sem o escopo do módulo. Qualquer helper de
 * módulo (dispatchEnter, buildSelector, escapeAttr, sleep externo)
 * referenciado dentro do func vira ReferenceError na página REAL.
 * Os mocks jsdom dos outros testes invocam o func no escopo do módulo,
 * onde os helpers existem — a suíte fica verde e o campo quebra.
 *
 * Este arquivo invoca os funcs injetados VIA SERIALIZAÇÃO: eval de
 * fn.toString() num escopo isolado (new Function), exatamente como o
 * Chrome faz. Closure externo quebra AQUI como quebra no Chrome.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'

/**
 * Serializa e reidrata o func como o chrome.scripting faz: o corpo é
 * avaliado num escopo NOVO (vm context isolado), sem closures do
 * módulo de origem, com os globals da PÁGINA (document, Event,
 * KeyboardEvent, rAF, matchMedia...) injetados como o Chrome injeta
 * na página. jsdom não implementa PointerEvent — o Chrome sim; polyfill
 * mínimo (subclass de MouseEvent). scrollIntoView também não existe no
 * jsdom — noop default (o Chrome o fornece).
 * @param {Function} func
 * @param {import('jsdom').DOMWindow} pageWindow
 * @returns {Function}
 */
export function rehydrate(func, pageWindow) {
  if (typeof pageWindow.Element.prototype.scrollIntoView !== 'function') {
    pageWindow.Element.prototype.scrollIntoView = function scrollIntoView() {}
  }
  const PointerEvent = pageWindow.PointerEvent
    ?? class PointerEvent extends pageWindow.MouseEvent {}
  const context = vm.createContext({
    window: pageWindow,
    document: pageWindow.document,
    Event: pageWindow.Event,
    KeyboardEvent: pageWindow.KeyboardEvent,
    PointerEvent,
    MouseEvent: pageWindow.MouseEvent,
    Date,
    Promise,
    Object,
    setTimeout: (cb, ms) => pageWindow.setTimeout(cb, ms),
    requestAnimationFrame: (cb) => pageWindow.setTimeout(() => cb(Date.now()), 16),
    matchMedia: (q) => ({ matches: true, media: q }),
    getComputedStyle: (el) => pageWindow.getComputedStyle(el),
  })
  const factory = new vm.Script(`(${func.toString()})`)
  return (...args) => factory.runInContext(context)(...args)
}

/**
 * Cria o mock do chrome.scripting que executa o func SERIALIZADO no
 * documento jsdom fornecido. Erros do func viram [{ result: undefined }]
 * com o erro cru anexado para diagnóstico (o Chrome reporta a falha de
 * execução, não o throw do módulo).
 * @param {import('jsdom').DOMWindow} window
 */
export function serializedScripting(window) {
  return {
    tabs: {
      // resolveTargetTab faz chrome.tabs.get(preferredTabId) — devolve
      // o id PEDIDO (fiel ao Chrome).
      get: async (id) => ({ id, url: 'https://example.com' }),
      query: async () => [{ id: 42, url: 'https://example.com' }],
    },
    scripting: {
      executeScript: async ({ func, args }) => {
        // B-3 (Farol, REGRESSÃO DE CAMPO): o Chrome rejeita a chamada
        // INTEIRA quando o array args contém undefined (não é
        // JSON-serializável) — o b0cb393 passou tool.deadlines (undefined
        // em produção) e quebrou type/click/find em campo. O harness valida
        // os ARGS de TODA chamada a executeScript (type/click/find/presença):
        // nenhum undefined no array + round-trip JSON sem perda/erro.
        const argList = args ?? []
        if (argList.some((a) => a === undefined)) {
          throw new Error(
            `executeScript: args contêm undefined (não JSON-serializável) — o Chrome rejeitaria a chamada inteira. args: ${JSON.stringify(argList)}`,
          )
        }
        const roundTripped = JSON.parse(JSON.stringify(argList))
        if (JSON.stringify(roundTripped) !== JSON.stringify(argList)) {
          throw new Error('executeScript: args não sobrevivem round-trip JSON (perda/erro de serialização)')
        }
        const pageFunc = rehydrate(func, window)
        try {
          const value = await pageFunc(...argList)
          return [{ result: value }]
        } catch (error) {
          return [{ result: undefined, __error: error }]
        }
      },
    },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    runtime: { lastError: undefined },
  }
}

/**
 * Monta globals do jsdom + chrome serializado.
 * @param {string} html
 * @param {string} [url] — page URL the document claims (like a real tab)
 */
export function serializedPage(html, url = 'https://example.com') {
  const dom = new JSDOM(html, { url })
  const chrome = serializedScripting(dom.window)
  return { dom, chrome }
}

test('serialization harness: rehydrate strips module scope — a func referencing an outer helper must throw', async () => {
  // Sanity do próprio harness: helper de módulo visível DIRETO...
  const moduleScopeHelper = () => 1
  const broken = () => moduleScopeHelper() + 1
  assert.equal(broken(), 2, 'no escopo do módulo o helper existe')
  // ...mas INVISÍVEL via serialização (vm context sem o closure).
  // ReferenceError do vm realm tem protótipo próprio — assert pelo nome.
  const dom = new JSDOM('<html><body></body></html>')
  const rehydrated = rehydrate(broken, dom.window)
  assert.throws(() => rehydrated(), (e) => e.name === 'ReferenceError')
})

test('type: the injected func is self-contained — pressEnter works via serialization (RED→GREEN evidence)', async () => {
  const { dom, chrome } = serializedPage('<input id="t">')
  const received = []
  dom.window.document.addEventListener('keydown', (e) => {
    received.push(e.key)
    e.preventDefault()
  })
  const originalDocument = globalThis.document
  const originalChrome = globalThis.chrome
  globalThis.document = dom.window.document
  globalThis.chrome = chrome
  try {
    const { typeText } = await import('./type.js')
    const result = await typeText(
      { name: 'type', selector: '#t', text: 'comprar café', pressEnter: true },
      { activeTabId: 42 },
    )
    assert.equal(result.textLength, 12)
    assert.equal(result.pressedEnter, true, 'Enter deve chegar via func serializado')
    assert.equal(received.length, 1)
  } finally {
    globalThis.document = originalDocument
    globalThis.chrome = originalChrome
  }
})

test('click: the injected func is self-contained — full pointer sequence works via serialization', async () => {
  const { dom, chrome } = serializedPage('<button id="b">OK</button>')
  const clicked = []
  dom.window.document.addEventListener('click', (e) => clicked.push(e.type))
  const originalDocument = globalThis.document
  const originalChrome = globalThis.chrome
  globalThis.document = dom.window.document
  globalThis.chrome = chrome
  try {
    const { click } = await import('./click.js')
    const result = await click({ name: 'click', selector: '#b' }, { activeTabId: 42 })
    assert.equal(result.clicked, true)
    assert.equal(clicked.length, 1)
  } finally {
    globalThis.document = originalDocument
    globalThis.chrome = originalChrome
  }
})

test('find: the injected func is self-contained — selectors derive via serialization', async () => {
  const { dom, chrome } = serializedPage('<button id="b" title="Salvar">Salvar</button>')
  const originalDocument = globalThis.document
  const originalChrome = globalThis.chrome
  globalThis.document = dom.window.document
  globalThis.chrome = chrome
  try {
    const { findTool } = await import('./find.js')
    const result = await findTool({ name: 'find', text: 'salvar' }, { activeTabId: 42 })
    assert.equal(result.matches.length, 1)
    assert.equal(result.matches[0].selector, '[title="Salvar"]')
  } finally {
    globalThis.document = originalDocument
    globalThis.chrome = originalChrome
  }
})

// ── ROUND 9, blade 2: null page result fails honestly on every tool ──

test('ROUND 9 guard: type/click/find report an honest error (with tab identity) when the page result is null', async () => {
  // The func crashing in-page delivers [{ result: null }] — the round-9
  // field crash ("reading 'handled'"). Each tool must throw the honest
  // page-function-failed error instead of a TypeError or a silent [].
  const { dom, chrome } = serializedPage('<input id="t"><button id="b">OK</button>')
  chrome.scripting.executeScript = async () => [{ result: null }]
  const originalDocument = globalThis.document
  const originalChrome = globalThis.chrome
  globalThis.document = dom.window.document
  globalThis.chrome = chrome
  try {
    const { typeText } = await import('./type.js')
    const { click } = await import('./click.js')
    const { findTool } = await import('./find.js')
    await assert.rejects(
      typeText({ name: 'type', selector: '#t', text: 'x', pressEnter: true }, { activeTabId: 42 }),
      /type: page function failed in the document \(ran in tab 42: https:\/\/example\.com\)/,
    )
    await assert.rejects(
      click({ name: 'click', selector: '#b' }, { activeTabId: 42 }),
      /click: page function failed in the document \(ran in tab 42: https:\/\/example\.com\)/,
    )
    await assert.rejects(
      findTool({ name: 'find', text: 'ok' }, { activeTabId: 42 }),
      /find: page function failed in the document \(ran in tab 42: https:\/\/example\.com\)/,
    )
  } finally {
    globalThis.document = originalDocument
    globalThis.chrome = originalChrome
  }
})

// ── SELECT: type on a <select> resolves the option (text OR value) ──
// Field evidence: clicking a synthetic <option> does not commit in Chrome.
// The fix lives INSIDE typeInPage (self-contained — serialization lesson).

const SELECT_HTML = '<select id="s">'
  + '<option value="">Pick…</option>'
  + '<option value="1">One</option>'
  + '<option value="2">Two</option>'
  + '<option value="3">Three</option>'
  + '</select>'

test('SELECT: type "Two" (by visible text, case-insensitive) selects option value 2 via serialization', async () => {
  const { dom, chrome } = serializedPage(SELECT_HTML)
  const originalDocument = globalThis.document
  const originalChrome = globalThis.chrome
  globalThis.document = dom.window.document
  globalThis.chrome = chrome
  try {
    const { typeText } = await import('./type.js')
    const result = await typeText({ name: 'type', selector: '#s', text: 'Two' }, { activeTabId: 42 })
    assert.equal(dom.window.document.querySelector('#s').value, '2', 'select.value deve ser 2')
    assert.equal(result.selected, true, 'result.selected deve ser true')
    assert.equal(result.selectedValue, '2')
  } finally {
    globalThis.document = originalDocument
    globalThis.chrome = originalChrome
  }
})

test('SELECT: type "2" (by value) selects option Two via serialization', async () => {
  const { dom, chrome } = serializedPage(SELECT_HTML)
  const originalDocument = globalThis.document
  const originalChrome = globalThis.chrome
  globalThis.document = dom.window.document
  globalThis.chrome = chrome
  try {
    const { typeText } = await import('./type.js')
    const result = await typeText({ name: 'type', selector: '#s', text: '2' }, { activeTabId: 42 })
    assert.equal(dom.window.document.querySelector('#s').value, '2')
    assert.equal(result.selected, true)
    assert.equal(result.selectedValue, '2')
  } finally {
    globalThis.document = originalDocument
    globalThis.chrome = originalChrome
  }
})

test('SELECT: type "two" (case-insensitive text) selects option Two', async () => {
  const { dom, chrome } = serializedPage(SELECT_HTML)
  const originalDocument = globalThis.document
  const originalChrome = globalThis.chrome
  globalThis.document = dom.window.document
  globalThis.chrome = chrome
  try {
    const { typeText } = await import('./type.js')
    const result = await typeText({ name: 'type', selector: '#s', text: 'two' }, { activeTabId: 42 })
    assert.equal(dom.window.document.querySelector('#s').value, '2')
    assert.equal(result.selected, true)
  } finally {
    globalThis.document = originalDocument
    globalThis.chrome = originalChrome
  }
})

test('SELECT: pressEnter:true does NOT leak the did-not-intercept note (note only applies to input/textarea)', async () => {
  // FAROL ressalva (pré-commit): handled = result.result.handled === true
  // vira false quando o select não retorna handled → a note de Enter
  // vazava no resultado de um select com pressEnter. A note só se aplica
  // a input/textarea com pressEnter real — o select ignora pressEnter.
  const { dom, chrome } = serializedPage(SELECT_HTML)
  const originalDocument = globalThis.document
  const originalChrome = globalThis.chrome
  globalThis.document = dom.window.document
  globalThis.chrome = chrome
  try {
    const { typeText } = await import('./type.js')
    const result = await typeText({ name: 'type', selector: '#s', text: 'Two', pressEnter: true }, { activeTabId: 42 })
    assert.equal(result.selected, true)
    assert.equal(result.selectedValue, '2')
    assert.equal(dom.window.document.querySelector('#s').value, '2')
    assert.equal('note' in result, false, 'resultado de select nunca carrega a note de Enter')
    assert.equal('pressedEnter' in result, false, 'pressEnter é ignorado no select')
  } finally {
    globalThis.document = originalDocument
    globalThis.chrome = originalChrome
  }
})

test('SELECT: nonexistent option fails honestly with the document identity', async () => {
  const { dom, chrome } = serializedPage(SELECT_HTML)
  const originalDocument = globalThis.document
  const originalChrome = globalThis.chrome
  globalThis.document = dom.window.document
  globalThis.chrome = chrome
  try {
    const { typeText } = await import('./type.js')
    await assert.rejects(
      typeText({ name: 'type', selector: '#s', text: 'Four' }, { activeTabId: 42 }),
      /type: option not found: "Four".*ran in tab 42: https:\/\/example\.com/,
    )
    // The select must be UNCHANGED (no silent default commit).
    assert.equal(dom.window.document.querySelector('#s').value, '')
  } finally {
    globalThis.document = originalDocument
    globalThis.chrome = originalChrome
  }
})
