/**
 * readPage.js — read visible text (or an attribute) from the active tab.
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
import { resolveTargetTab } from '../targetTab.js'

/**
 * @param {{ name: 'read_page'; selector?: string; attribute?: string; risk?: string; input?: string }} tool
 * @param {{ activeTabId?: number }} [ctx]
 * @returns {Promise<{ text: string; interactiveElements: Array<{ selector: string; tag: string; label: string; type?: string; role?: string; disabled: boolean }>; interactiveElementsTruncated: boolean; selector?: string; attribute?: string; url: string }>}
 */
export async function readPage(tool, ctx = {}) {
  const selector = tool?.selector
  const attribute = tool?.attribute

  const tab = await resolveTargetTab(ctx?.activeTabId)
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
  const payload = result.result
  const structuredPayload = payload && typeof payload === 'object' ? payload : null
  return {
    text: String(structuredPayload?.text ?? payload ?? ''),
    interactiveElements: Array.isArray(structuredPayload?.interactiveElements)
      ? structuredPayload.interactiveElements
      : [],
    interactiveElementsTruncated: structuredPayload?.interactiveElementsTruncated === true,
    selector: selector,
    attribute: attribute,
    url: tab.url ?? '',
  }
}

/**
 * In-page function. Runs in the page's main world via executeScript.
 * Returns visible innerText of the first match (or the whole document if
 * no selector). If `attribute` is set, returns that attribute's value
 * instead of visible text.
 * @param {string | null} selector
 * @param {string | null} attribute
 * @returns {{ text: string; interactiveElements: Array<{ selector: string; tag: string; label: string; type?: string; role?: string; disabled: boolean }>; interactiveElementsTruncated: boolean }}
 */
function readInPage(selector, attribute) {
  const el = selector ? document.querySelector(selector) : document.body
  if (!el) return { text: '', interactiveElements: [], interactiveElementsTruncated: false }
  if (attribute) {
    const v = el.getAttribute(attribute)
    return { text: v ?? '', interactiveElements: [], interactiveElementsTruncated: false }
  }
  const text = el.innerText ?? el.textContent ?? ''
  const candidates = typeof el.querySelectorAll === 'function'
    ? Array.from(el.querySelectorAll('a[href], button, input:not([type="hidden"]), textarea, select, [role="button"], [contenteditable="true"]'))
    : []
  const visible = candidates.filter((candidate) => {
    if (candidate.hidden || candidate.getAttribute?.('aria-hidden') === 'true') return false
    if (typeof getComputedStyle !== 'function') return true
    const style = getComputedStyle(candidate)
    return style.display !== 'none' && style.visibility !== 'hidden'
  })
  const interactiveElements = visible.slice(0, 40).map((candidate) => {
    const tag = String(candidate.tagName ?? '').toLowerCase()
    const escapeCss = (value) => typeof globalThis.CSS?.escape === 'function'
      ? globalThis.CSS.escape(value)
      : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&')
    let elementSelector = tag
    if (candidate.id) {
      elementSelector = `#${escapeCss(candidate.id)}`
    } else if (candidate.getAttribute?.('name')) {
      elementSelector = `${tag}[name="${escapeCss(candidate.getAttribute('name'))}"]`
    } else {
      const path = []
      let current = candidate
      while (current && current !== document.body) {
        const currentTag = String(current.tagName ?? '').toLowerCase()
        if (!currentTag) break
        const siblings = current.parentElement
          ? Array.from(current.parentElement.children).filter((sibling) => sibling.tagName === current.tagName)
          : []
        const position = siblings.indexOf(current)
        path.unshift(siblings.length > 1 && position >= 0 ? `${currentTag}:nth-of-type(${position + 1})` : currentTag)
        current = current.parentElement
      }
      if (path.length) elementSelector = `body > ${path.join(' > ')}`
    }
    const normalizedLabel = String(
      candidate.getAttribute?.('aria-label')
      ?? candidate.labels?.[0]?.innerText
      ?? candidate.getAttribute?.('placeholder')
      ?? candidate.getAttribute?.('title')
      ?? candidate.innerText
      ?? candidate.getAttribute?.('name')
      ?? '',
    ).replace(/\s+/g, ' ').trim().slice(0, 120)
    const item = {
      selector: elementSelector,
      tag,
      label: normalizedLabel,
      disabled: candidate.disabled === true,
    }
    if (tag === 'input' && candidate.type) item.type = String(candidate.type)
    const role = candidate.getAttribute?.('role')
    if (role) item.role = String(role)
    return item
  })
  return {
    text,
    interactiveElements,
    interactiveElementsTruncated: visible.length > interactiveElements.length,
  }
}
