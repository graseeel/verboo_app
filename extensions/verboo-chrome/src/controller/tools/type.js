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
  if (!result.result || result.result === false) {
    // R-T4/GENERALIZAÇÃO-2: when the call carried pressEnter, the error
    // reminds the model of the parameter — a retry after "element not
    // found" tends to drop it, silently losing the commit.
    throw new Error(pressEnter
      ? `type: element not found: ${selector} (the call had pressEnter: true — retry with the same arguments)`
      : `type: element not found: ${selector}`)
  }
  // R-T5/GENERALIZAÇÃO-2: with pressEnter the page returns { found,
  // handled } — pressedEnter reflects whether the APP handled the Enter;
  // when it did not (no preventDefault, no form submit), the value may
  // not have committed, and a neutral note reaches the model through the
  // tool result JSON (no loop changes).
  const handled = pressEnter && typeof result.result === 'object'
    ? result.result.handled === true
    : undefined
  const note = pressEnter && handled === false
    ? 'Enter dispatched but the app did not intercept it — confirm the effect with read_page; the value may not have committed.'
    : undefined
  // SECURITY: never return the typed text in the result. The agent
  // transcript broadcasts AGENT_TOOL_RESULT to the panel; if we include
  // `text` here, secrets (passwords, API keys, 2FA codes) typed via
  // this tool would leak into the transcript. Return only the length
  // so the UI can show "typed 12 chars" without exposing the content.
  return {
    selector,
    textLength: text.length,
    ...(pressEnter ? { pressedEnter: handled === true } : {}),
    ...(note ? { note } : {}),
    url: tab.url ?? '',
  }
}

/**
 * In-page function. Returns true (found+typed), false (not found after
 * the readiness wait), or — with pressEnter — { found: true, handled }
 * where handled tells whether the app intercepted the Enter.
 * @param {string} selector
 * @param {string} text
 * @param {boolean} clear
 * @param {boolean} pressEnter
 * @returns {Promise<boolean | { found: true, handled: boolean }>}
 */
async function typeInPage(selector, text, clear, pressEnter) {
  // R-C1/GENERALIZAÇÃO-2: the first tool call of a turn can race the
  // framework's mount (the lease tab may still be loading, React may not
  // have rendered the input yet). Zero cost on a ready page (the
  // readyState check is instant and the selector is usually present).
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const readyDeadline = Date.now() + 5000
  while (document.readyState !== 'complete' && Date.now() < readyDeadline) {
    await sleep(100)
  }
  const elementDeadline = Date.now() + 3000
  let el = /** @type {HTMLInputElement | HTMLTextAreaElement | null} */ (null)
  for (;;) {
    el = /** @type {HTMLInputElement | HTMLTextAreaElement | null} */ (document.querySelector(selector))
    if (el) break
    if (Date.now() >= elementDeadline) return false
    await sleep(100)
  }
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
    return { found: true, handled: dispatchEnter(el) }
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
