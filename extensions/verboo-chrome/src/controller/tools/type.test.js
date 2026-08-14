/**
 * type.test.js — type tool with pressEnter (GENERALIZAÇÃO, R-T2).
 *
 * jsdom-based behavioral tests: a framework-style listener (React
 * delegation on the root container) MUST receive the Enter keydown with
 * bubbles + composed, and requestSubmit must NOT fire when the app
 * handled the keydown (preventDefault). No framework-specific code is
 * tested — only standard DOM events.
 */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

import { typeText } from './type.js'

const originalChrome = globalThis.chrome
const originalDocument = globalThis.document
const originalEvent = globalThis.Event
const originalKeyboardEvent = globalThis.KeyboardEvent

afterEach(() => {
  globalThis.chrome = originalChrome
  globalThis.document = originalDocument
  globalThis.Event = originalEvent
  globalThis.KeyboardEvent = originalKeyboardEvent
})

/**
 * Runs typeText against a JSDOM page. `before` may register page
 * listeners (e.g. the framework delegation) BEFORE the tool runs.
 * The in-page function executes in the jsdom document; presence
 * injections are best-effort (swallowed).
 */
async function typeInto(html, tool, before = () => {}) {
  const dom = new JSDOM(html)
  globalThis.document = dom.window.document
  globalThis.Event = dom.window.Event
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.chrome = {
    tabs: {
      get: async () => ({ id: 42, url: 'https://example.com' }),
      query: async () => [{ id: 42, url: 'https://example.com' }],
    },
    scripting: {
      executeScript: async ({ func, args }) => {
        const isTypeFn = Array.isArray(args) && args.length === 4 && typeof args[0] === 'string'
        try {
          return [{ result: isTypeFn ? func(...args) : true }]
        } catch {
          return [{ result: undefined }]
        }
      },
    },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    runtime: { lastError: undefined },
  }
  before(dom.window)
  const result = await typeText(
    { name: 'type', selector: '#t', text: 'comprar café', ...tool },
    { activeTabId: 42 },
  )
  return { result, window: dom.window }
}

test('type: pressEnter delivers the Enter keydown to a ROOT listener (React delegation) with bubbles+composed', async () => {
  const received = []
  let keypressCount = 0
  let keyupCount = 0
  const { result } = await typeInto('<input id="t">', { pressEnter: true }, (window) => {
    // React 16-18 delegates listeners on the ROOT container — outside the
    // target element — so the events must bubble AND be composed to reach
    // it. The app handles Enter (preventDefault) — TodoMVC's onKeyDown.
    window.document.addEventListener('keydown', (e) => {
      received.push({
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        bubbles: e.bubbles,
        composed: e.composed,
        cancelable: e.cancelable,
      })
      e.preventDefault()
    })
    window.document.addEventListener('keypress', () => { keypressCount += 1 })
    window.document.addEventListener('keyup', () => { keyupCount += 1 })
  })

  assert.equal(result.pressedEnter, true)
  assert.equal(received.length, 1, 'keydown must reach the delegated root listener')
  assert.equal(received[0].key, 'Enter')
  assert.equal(received[0].code, 'Enter')
  assert.equal(received[0].keyCode, 13)
  assert.equal(received[0].bubbles, true)
  assert.equal(received[0].composed, true)
  assert.equal(received[0].cancelable, true)
  // The app handled the keydown → no keypress, no synthetic submit.
  assert.equal(keypressCount, 0)
  assert.equal(keyupCount, 1, 'keyup still completes the sequence')
})

test('type: requestSubmit fires ONLY when the keydown was NOT handled, and only inside a form', async () => {
  let submitted = 0
  const { result } = await typeInto(
    '<form id="f"><input id="t" name="todo"></form>',
    { pressEnter: true },
    (window) => {
      window.document.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault()
        submitted += 1
      })
    },
  )

  // No keydown handler → default not prevented → keypress + requestSubmit.
  // pressedEnter only reports that the Enter sequence was dispatched (the
  // app signals "handled" through the submit/state, not through the tool).
  assert.equal(result.pressedEnter, true)
  assert.equal(submitted, 1, 'requestSubmit must mirror the native Enter submit')
})

test('type: requestSubmit does NOT fire when the app handled the keydown (no double submit)', async () => {
  let submitted = 0
  const { result } = await typeInto(
    '<form id="f"><input id="t"></form>',
    { pressEnter: true },
    (window) => {
      // The app listens for Enter on the element itself (Vue/Svelte/vanilla).
      window.document.querySelector('#t').addEventListener('keydown', (e) => {
        e.preventDefault()
      })
      window.document.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault()
        submitted += 1
      })
    },
  )

  assert.equal(result.pressedEnter, true)
  assert.equal(submitted, 0, 'preventDefault must suppress the form submit')
})

test('type: without pressEnter no keyboard event is dispatched', async () => {
  let keydownCount = 0
  const { result } = await typeInto('<input id="t">', {}, (window) => {
    window.document.addEventListener('keydown', () => { keydownCount += 1 })
  })

  assert.equal(result.pressedEnter, undefined)
  assert.equal(keydownCount, 0)
  assert.equal(result.textLength, 12)
})

test('type: clear + text + pressEnter combine (value set through the native setter)', async () => {
  const { window } = await typeInto('<input id="t" value="old">', { clear: true, pressEnter: true })
  const input = window.document.querySelector('#t')
  assert.equal(input.value, 'comprar café')
})
