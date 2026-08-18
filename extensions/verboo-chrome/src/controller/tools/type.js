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
    // B-2 (Farol): deadlines injetáveis — tool.deadlines é só para testes
    // (default de produção em typeInPage); o modelo nunca envia.
    args: [selector, text, clear, pressEnter, tool.deadlines],
  })

  if (!result) throw new Error('type: no result from page')
  // ROUND 9: when the in-page func THROWS, Chrome delivers a null
  // result — the old post-processing dereferenced result.result.handled
  // and crashed with "Cannot read properties of null (reading
  // 'handled')" instead of reporting. Fail honestly, carrying the tab
  // identity so the panel shows which surface executed.
  if (result.result == null) {
    throw new Error(
      `type: page function failed in the document (ran in tab ${tab.id}: ${tab.url ?? 'unknown'}) — the page may have navigated or the injection was blocked; retry, or use read_page to inspect the document`,
    )
  }
  const pageResult = result.result
  const pageNotFound = pageResult === false
    || (pageResult && typeof pageResult === 'object' && pageResult.found === false)
  if (pageNotFound) {
    // INSTRUMENTAÇÃO (pós-round 8): the error carries the identity of the
    // DOCUMENT the in-page function ran in — tab id + the document's own
    // location.href/title (truth of the document, not of the tab object) —
    // so the panel card shows exactly which surface executed (a stale
    // workspace tab, a hidden window, the user's own tab).
    const docInfo = pageResult && typeof pageResult === 'object' && pageResult.docUrl
      ? ` (ran in tab ${tab.id}: ${pageResult.docUrl}${pageResult.docTitle ? ` "${pageResult.docTitle}"` : ''})`
      : ` (ran in tab ${tab.id}: ${tab.url ?? 'unknown'})`
    // PÓS-CAMPO-3 (item 1): the recovery hint points at the find TOOL,
    // never at "repeat the same arguments" — a weak model took "retry
    // with the same arguments" literally and repeated the invalid
    // selector. When pressEnter was set, the hint also preserves it.
    throw new Error(pressEnter
      ? `type: selector not found: ${selector}${docInfo} — call the find tool to get a valid selector for this element, then retry type keeping pressEnter: true`
      : `type: selector not found: ${selector}${docInfo} — call the find tool to get a valid selector for this element, then retry`)
  }
  // SELECT: the option was not found — honest error with the requested
  // text, the available options (value/text pairs) and the DOCUMENT
  // identity (the select may live in a different surface than expected).
  if (pageResult && typeof pageResult === 'object' && pageResult.selectOptionNotFound === true) {
    const available = Array.isArray(pageResult.available)
      ? pageResult.available.map((o) => `"${String(o?.text ?? o?.value ?? '').trim()}"`).join(', ')
      : ''
    const docInfo = pageResult.docUrl
      ? ` (ran in tab ${tab.id}: ${pageResult.docUrl}${pageResult.docTitle ? ` "${pageResult.docTitle}"` : ''})`
      : ` (ran in tab ${tab.id}: ${tab.url ?? 'unknown'})`
    throw new Error(
      `type: option not found: "${pageResult.requested ?? text}" in select ${selector} — available options: ${available || 'none'}${docInfo}; call find or read_page to inspect the current options, then retry type with a valid option text or value`,
    )
  }
  // SELECT: report what was chosen — value only, never the typed text
  // (the requested option text is fine, it is not a secret the user
  // typed into the page; the VALUE is what the page now holds).
  const selected = result.result && typeof result.result === 'object'
    ? result.result.selected === true
    : undefined
  // R-T5/GENERALIZAÇÃO-2: with pressEnter the page returns { found,
  // handled } — pressedEnter reflects whether the APP handled the Enter;
  // when it did not (no preventDefault, no form submit), the value may
  // not have committed, and a neutral note reaches the model through the
  // tool result JSON (no loop changes). FAROL ressalva: a SELECT never
  // returns `handled`, so `handled === false` would be true for it — the
  // note must never appear on a select result (pressEnter is ignored
  // there; choosing IS the commit).
  const handled = pressEnter && !selected && typeof result.result === 'object'
    ? result.result.handled === true
    : undefined
  const note = pressEnter && !selected && handled === false
    ? 'Enter dispatched but the app did not intercept it — confirm the effect with read_page; the value may not have committed.'
    : undefined
  // SECURITY: never return the typed text in the result. The agent
  // transcript broadcasts AGENT_TOOL_RESULT to the panel; if we include
  // `text` here, secrets (passwords, API keys, 2FA codes) typed via
  // this tool would leak into the transcript. Return only the length
  // so the UI can show "typed 12 chars" without exposing the content.
  return {
    selector,
    textLength: selected ? 0 : text.length,
    ...(selected ? { selected: true, selectedValue: result.result.selectedValue } : {}),
    ...(pressEnter && !selected ? { pressedEnter: handled === true } : {}),
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
async function typeInPage(selector, text, clear, pressEnter, deadlines) {
  // R-C1/GENERALIZAÇÃO-2: the first tool call of a turn can race the
  // framework's mount (the lease tab may still be loading, React may not
  // have rendered the input yet). Zero cost on a ready page (the
  // readyState check is instant and the selector is usually present).
  // B-2 (Farol): deadlines injetáveis para teste — defaults de produção
  // (5000ms ready / 3000ms element).
  const readyMs = deadlines?.readyMs ?? 5000
  const elementMs = deadlines?.elementMs ?? 3000
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const readyDeadline = Date.now() + readyMs
  while (document.readyState !== 'complete' && Date.now() < readyDeadline) {
    await sleep(100)
  }
  const elementDeadline = Date.now() + elementMs
  let el = /** @type {HTMLInputElement | HTMLTextAreaElement | null} */ (null)
  for (;;) {
    el = /** @type {HTMLInputElement | HTMLTextAreaElement | null} */ (document.querySelector(selector))
    if (el) break
    if (Date.now() >= elementDeadline) {
      // INSTRUMENTAÇÃO: document identity for the not-found error.
      return { found: false, docUrl: document.location.href, docTitle: document.title }
    }
    await sleep(100)
  }
  el.focus()
  // SELECT: typing into a <select> means CHOOSING an option. Clicking a
  // synthetic <option> does not commit in Chrome (field evidence —
  // 'escolha Two' submitted with the default). Resolve the option by
  // value OR visible text (case-insensitive), set via the native setter
  // so React controlled components see the change, and dispatch change
  // (bubbles) so framework onChange handlers fire. pressEnter is ignored
  // for selects — choosing IS the commit. All inline (serialization).
  if (el.tagName === 'SELECT') {
    const norm = (s) => String(s ?? '').trim().toLowerCase()
    const needle = norm(text)
    const options = Array.from(el.options)
    const byValueExact = options.find((o) => o.value === text)
    const byValueNorm = options.find((o) => norm(o.value) === needle)
    const byTextNorm = options.find((o) => norm(o.textContent) === needle)
    const byTextIncludes = options.find((o) => norm(o.textContent).includes(needle))
    const matched = byValueExact ?? byValueNorm ?? byTextNorm ?? byTextIncludes
    if (!matched) {
      return {
        found: true,
        selectOptionNotFound: true,
        requested: text,
        available: options.map((o) => ({ value: o.value, text: String(o.textContent).trim() })),
        docUrl: document.location.href,
        docTitle: document.title,
      }
    }
    const proto = Object.getPrototypeOf(el)
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) {
      setter.call(el, matched.value)
    } else {
      el.value = matched.value
    }
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { found: true, selected: true, selectedValue: matched.value }
  }
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
    // ROUND 9: dispatchEnter is INLINED — chrome.scripting serializes
    // ONLY this function's body, so any module-scope helper becomes a
    // ReferenceError in the real page (the text typed but Enter never
    // fired — rounds 1-8).
    //
    // R-T2/GENERALIZAÇÃO rationale: frameworks listen to STANDARD DOM
    // keyboard events — React 16-18 delegates on the root container, so
    // the events must bubble AND be composed; Vue/Svelte/vanilla attach
    // directly, bubbling suffices; a classic <form> submits on native
    // Enter → requestSubmit() mirrors it. keyCode/which are legacy init
    // extensions accepted by Chromium. requestSubmit runs ONLY when
    // nothing handled the keydown (defaultPrevented === false) — an app
    // that listens for Enter prevents the default, so there is no
    // double submit.
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
    return { found: true, handled }
  }
  return true
}
