/**
 * click.js — click an element in the active tab.
 *
 * Uses chrome.scripting.executeScript (no debugger needed). The
 * injected function dispatches a real PointerEvent so SPA click
 * handlers fire correctly.
 *
 * Target resolution (R5-A): either a CSS selector OR viewport pixel
 * coordinates { x, y } (elementFromPoint). Coordinates support models
 * that emit computer-use style clicks; presence (frame + cursor) is
 * only shown when a selector is available, since coordinates have no
 * element to frame before resolution.
 *
 * @param {{ name: 'click'; selector?: string; x?: number; y?: number; button?: number; risk?: string; input?: string }} tool
 * @param {{ activeTabId?: number }} [ctx]
 * @returns {Promise<{ selector?: string; x?: number; y?: number; clicked: boolean; url: string }>}
 */

import { preparePresenceForAction, pulseAgentCursor } from '../../presence/inject.js'
import { resolveTargetTab } from '../targetTab.js'

export async function click(tool, ctx = {}) {
  const selector = typeof tool?.selector === 'string' && tool.selector.length > 0
    ? tool.selector
    : null
  const hasCoordinates = Number.isInteger(tool?.x) && Number.isInteger(tool?.y)
  if (!selector && !hasCoordinates) {
    throw new Error('click: missing selector or x/y coordinates')
  }
  const button = typeof tool.button === 'number' ? tool.button : 0
  const x = hasCoordinates ? tool.x : null
  const y = hasCoordinates ? tool.y : null

  const tab = await resolveTargetTab(ctx.activeTabId)
  if (!tab?.id) throw new Error('click: no active tab')

  // Agent presence: frame + cursor glide to target, dwell, click pulse, then DOM click.
  // Coordinate clicks have nothing to frame before the point is resolved.
  if (selector) {
    await preparePresenceForAction(tab.id, selector)
    try {
      await pulseAgentCursor(tab.id)
    } catch {
      /* presence is best-effort */
    }
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: clickInPage,
    args: [selector, x, y, button],
  })

  if (!result) throw new Error('click: no result from page')
  // ROUND 9 (see type.js): a null result means the in-page func threw —
  // fail honestly with the tab identity instead of mis-processing.
  if (result.result == null) {
    throw new Error(
      `click: page function failed in the document (ran in tab ${tab.id}: ${tab.url ?? 'unknown'}) — the page may have navigated or the injection was blocked; retry, or use read_page to inspect the document`,
    )
  }
  const pageResult = result.result
  const pageNotFound = pageResult === false
    || (pageResult && typeof pageResult === 'object' && pageResult.found === false)
  if (pageNotFound) {
    // INSTRUMENTAÇÃO (pós-round 8): document identity — tab id + the
    // document's own location/title (see type.js).
    const docInfo = pageResult && typeof pageResult === 'object' && pageResult.docUrl
      ? ` (ran in tab ${tab.id}: ${pageResult.docUrl}${pageResult.docTitle ? ` "${pageResult.docTitle}"` : ''})`
      : ` (ran in tab ${tab.id}: ${tab.url ?? 'unknown'})`
    // PÓS-CAMPO-3 (item 1): the recovery hint points at the find/read_page
    // TOOLS — never at repeating the same selector/coordinates.
    throw new Error(selector
      ? `click: selector not found: ${selector}${docInfo} — call the find tool to get a valid selector for this element, then retry`
      : `click: no element at coordinates ${x},${y}${docInfo} — use find or read_page to locate the target, then retry`)
  }
  return {
    ...(selector ? { selector } : {}),
    ...(hasCoordinates ? { x, y } : {}),
    clicked: true,
    url: tab.url ?? '',
  }
}

/**
 * In-page function. Returns true if the element was found and clicked.
 * R-C1/GENERALIZAÇÃO-2: waits for readiness + the selector (the first
 * tool call of a turn can race the framework's mount). Zero cost on a
 * ready page; coordinate clicks skip the selector poll.
 * @param {string|null} selector
 * @param {number|null} x
 * @param {number|null} y
 * @param {number} button
 * @returns {Promise<boolean>}
 */
async function clickInPage(selector, x, y, button) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const readyDeadline = Date.now() + 5000
  while (document.readyState !== 'complete' && Date.now() < readyDeadline) {
    await sleep(100)
  }
  let el = null
  if (selector !== null) {
    const elementDeadline = Date.now() + 3000
    for (;;) {
      el = document.querySelector(selector)
      if (el) break
      if (Date.now() >= elementDeadline) {
        // INSTRUMENTAÇÃO: document identity for the not-found error.
        return { found: false, docUrl: document.location.href, docTitle: document.title }
      }
      await sleep(100)
    }
  } else {
    el = document.elementFromPoint(x, y)
    if (!el) {
      return { found: false, docUrl: document.location.href, docTitle: document.title }
    }
  }
  if (!el) return { found: false, docUrl: document.location.href, docTitle: document.title }
  if (selector !== null) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
  }
  const rect = el.getBoundingClientRect()
  const opts = {
    bubbles: true,
    cancelable: true,
    view: window,
    button,
    clientX: (selector !== null) ? rect.left + rect.width / 2 : x,
    clientY: (selector !== null) ? rect.top + rect.height / 2 : y,
  }
  el.dispatchEvent(new PointerEvent('pointerdown', opts))
  el.dispatchEvent(new MouseEvent('mousedown', opts))
  el.dispatchEvent(new PointerEvent('pointerup', opts))
  el.dispatchEvent(new MouseEvent('mouseup', opts))
  el.dispatchEvent(new MouseEvent('click', opts))
  return true
}
