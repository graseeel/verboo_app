/**
 * readPage.js — read text content (or an attribute) from the active tab.
 *
 * Uses chrome.scripting.executeScript (no debugger needed). The
 * injected function runs in the page's isolated world (MV3 default).
 *
 * Fails with a friendly error when the active tab is on a non-
 * controllable scheme (chrome://, about:, edge://, file://, etc.).
 * Chrome would otherwise throw a raw "Cannot access a chrome:// URL"
 * exception that's useless to the user.
 */

import { isControllableUrl, nonControllablePageMessage } from '../../planMessage.js'
import { preparePresenceForAction } from '../../presence/inject.js'

/**
 * @param {{ name: 'read_page'; selector?: string; attribute?: string; risk?: string; input?: string }} tool
 * @returns {Promise<{ text: string; selector?: string; attribute?: string; url: string }>}
 */
export async function readPage(tool) {
  const selector = tool?.selector
  const attribute = tool?.attribute

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('read_page: no active tab')

  if (!isControllableUrl(tab.url)) {
    throw new Error(nonControllablePageMessage(tab.url))
  }

  // Cursor presence while reading so control never looks "invisible".
  await preparePresenceForAction(tab.id, typeof selector === 'string' ? selector : undefined)

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: readInPage,
    args: [selector ?? null, attribute ?? null],
  })

  if (!result) throw new Error('read_page: no result from page')
  return {
    text: String(result.result ?? ''),
    selector: selector,
    attribute: attribute,
    url: tab.url ?? '',
  }
}

/**
 * In-page function. Runs in the page's main world via executeScript.
 * Returns textContent of the first match (or the whole document if
 * no selector). If `attribute` is set, returns that attribute's value
 * instead of textContent.
 * @param {string | null} selector
 * @param {string | null} attribute
 * @returns {string}
 */
function readInPage(selector, attribute) {
  const el = selector ? document.querySelector(selector) : document.body
  if (!el) return ''
  if (attribute) {
    const v = el.getAttribute(attribute)
    return v ?? ''
  }
  return el.textContent ?? ''
}