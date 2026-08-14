/**
 * type.js — type text into a form field in the active tab.
 *
 * Uses chrome.scripting.executeScript (no debugger needed). Clears
 * the field first if `clear` is true. Dispatches input + change events
 * so React/Vue controlled components pick up the value.
 *
 * Presence: shows the purple frame + purple agent cursor at the
 * target before typing so the user can see where Verboo will act.
 *
 * @param {{ name: 'type'; selector: string; text: string; clear?: boolean; pressEnter?: boolean; risk?: string; input?: string }} tool
 * @param {{ activeTabId?: number }} [ctx]
 * @returns {Promise<{ selector: string; textLength: number; pressedEnter?: boolean; url: string }>}
 */

import { preparePresenceForAction } from '../../presence/inject.js'
import { resolveTargetTab } from '../targetTab.js'

export async function typeText(tool, ctx = {}) {
  const selector = tool?.selector
  if (!selector || typeof selector !== 'string') {
    throw new Error('type: missing selector')
  }
  const text = tool?.text
  if (typeof text !== 'string') throw new Error('type: missing text')
  const clear = tool?.clear === true
  // R-T1/GENERALIZAÇÃO: pressEnter submits the field after typing (Enter).
  // Accepts the boolean from the catalog AND the 'true'/'false' string form
  // normalized by the text parser — defensive at the boundary.
  const pressEnter = tool?.pressEnter === true || tool?.pressEnter === 'true'

  const tab = await resolveTargetTab(ctx.activeTabId)
  if (!tab?.id) throw new Error('type: no active tab')

  // Agent presence: frame + cursor at target, brief delay, then type.
  await preparePresenceForAction(tab.id, selector)

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: typeInPage,
    args: [selector, text, clear, pressEnter],
  })

  if (!result) throw new Error('type: no result from page')
  if (!result.result) throw new Error(`type: element not found: ${selector}`)
  // SECURITY: never return the typed text in the result. The agent
  // transcript broadcasts AGENT_TOOL_RESULT to the panel; if we include
  // `text` here, secrets (passwords, API keys, 2FA codes) typed via
  // this tool would leak into the transcript. Return only the length
  // so the UI can show "typed 12 chars" without exposing the content.
  return {
    selector,
    textLength: text.length,
    ...(pressEnter ? { pressedEnter: result.result === true } : {}),
    url: tab.url ?? '',
  }
}

/**
 * In-page function. Returns true if the element was found and typed into.
 * @param {string} selector
 * @param {string} text
 * @param {boolean} clear
 * @param {boolean} pressEnter
 * @returns {boolean}
 */
function typeInPage(selector, text, clear, pressEnter) {
  const el = /** @type {HTMLInputElement | HTMLTextAreaElement | null} */ (document.querySelector(selector))
  if (!el) return false
  el.focus()
  if (clear) {
    el.value = ''
  }
  // Use the native setter so React controlled components see the change.
  const proto = Object.getPrototypeOf(el)
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) {
    setter.call(el, text)
  } else {
    el.value = text
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  if (pressEnter) {
    dispatchEnter(el)
  }
  return true
}

/**
 * R-T2/GENERALIZAÇÃO: submit the field with a full Enter key sequence.
 *
 * Frameworks listen to STANDARD DOM keyboard events, so no framework-
 * specific code lives here:
 *   - React 16-18 delegates listeners on the root container → the events
 *     must bubble AND be composed (the listener is outside the target);
 *   - Vue / Svelte / vanilla attach directly → bubbling suffices;
 *   - a classic <form> submits on native Enter → requestSubmit() mirrors
 *     it (with native constraint validation).
 *
 * keyCode/which are accepted in the KeyboardEvent init by Chromium as a
 * legacy extension; React reads nativeEvent.key/code, which are set.
 *
 * requestSubmit runs ONLY when nothing handled the keydown
 * (defaultPrevented === false) — an app that listens for Enter (e.g.
 * TodoMVC's onKeyDown) prevents the default, so there is no double
 * submit.
 *
 * @param {HTMLInputElement | HTMLTextAreaElement} el
 * @returns {boolean} true when the app handled the keydown (preventDefault)
 */
function dispatchEnter(el) {
  const init = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
    composed: true,
  }
  const keydown = new KeyboardEvent('keydown', init)
  el.dispatchEvent(keydown)
  const handled = keydown.defaultPrevented
  if (!handled) {
    el.dispatchEvent(new KeyboardEvent('keypress', init))
  }
  el.dispatchEvent(new KeyboardEvent('keyup', init))
  if (!handled && el.form && typeof el.form.requestSubmit === 'function') {
    try {
      el.form.requestSubmit()
    } catch {
      // Native constraint validation may reject the submit — the app
      // decides how to surface it.
    }
  }
  return handled
}
