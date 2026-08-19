/**
 * find.js — discover real, clickable references on the current page by
 * visible text (optionally scoped to a CSS selector).
 *
 * G1-CHROME: the model must never guess CSS selectors from memory when the
 * user names a target. This tool reads the page and returns matches with a
 * working selector DERIVED FROM THE ACTUAL ELEMENT (title / aria-label /
 * href / DOM path). The selector is generic — no site-specific knowledge
 * is embedded anywhere.
 */

import { isControllableUrl, nonControllablePageMessage } from '../../planMessage.js'
import { preparePresenceForAction } from '../../presence/inject.js'
import { resolveTargetTab } from '../targetTab.js'

const MAX_MATCHES = 20 // mirrored inside findInPage (serialized copy) — ROUND 9

/**
 * @param {{ name: 'find'; text?: string; selector?: string; risk?: string; input?: string }} tool
 * @param {{ activeTabId?: number }} [ctx]
 * @returns {Promise<{ matches: Array<{ text: string; tag: string; selector: string; href?: string }>, url: string }>}
 */
export async function findTool(tool, ctx = {}) {
  const text = tool?.text
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new Error('find: text is required')
  }

  const tab = await resolveTargetTab(ctx?.activeTabId)
  if (!tab?.id) throw new Error('find: no active tab')

  if (!isControllableUrl(tab.url)) {
    throw new Error(nonControllablePageMessage(tab.url))
  }

  await preparePresenceForAction(tab.id, typeof tool?.selector === 'string' ? tool.selector : undefined)

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: findInPage,
    // B-2 (Farol): deadlines injetáveis — tool.deadlines só para testes.
    // B-3 (Farol, REGRESSÃO DE CAMPO): `?? null` — undefined no array args
    // NÃO é JSON-serializável e o Chrome rejeita a chamada INTEIRA.
    args: [text.trim(), tool?.selector ?? null, tool.deadlines ?? null],
  })

  if (!result) throw new Error('find: no result from page')
  // ROUND 9 (see type.js): a null result means the in-page func threw —
  // fail honestly with the tab identity; returning [] here would look
  // like "no elements found", a silent lie about a crashed injection.
  if (result.result == null) {
    throw new Error(
      `find: page function failed in the document (ran in tab ${tab.id}: ${tab.url ?? 'unknown'}) — the page may have navigated or the injection was blocked; retry, or use read_page to inspect the document`,
    )
  }
  const matches = Array.isArray(result.result) ? result.result : []
  return {
    matches,
    url: tab.url ?? '',
    // INSTRUMENTAÇÃO (pós-round 8): the empty result carries the identity
    // of the tab the find ran in — so the panel/model can see exactly
    // which surface returned nothing (a stale workspace tab vs the user's
    // page).
    ...(matches.length === 0
      ? { note: `No elements found (ran in tab ${tab.id}: ${tab.url ?? 'unknown'}${tab.title ? ` "${tab.title}"` : ''})` }
      : {}),
  }
}

/**
 * In-page function. Runs in the page's main world via executeScript.
 * Returns up to MAX_MATCHES clickable elements whose visible text contains
 * the needle (case-insensitive). Selectors are derived from the element.
 * R-C1/GENERALIZAÇÃO-2: waits for readiness (and for the scope selector
 * when given) so the first tool call of a turn cannot race the
 * framework's mount. Zero cost on a ready page.
 * @param {string} text
 * @param {string | null} scopeSelector
 * @returns {Promise<Array<{ text: string; tag: string; selector: string; href?: string }>}>
 */
async function findInPage(text, scopeSelector, deadlines) {
  // B-2 (Farol): deadlines injetáveis para teste — defaults de produção.
  const readyMs = deadlines?.readyMs ?? 5000
  const elementMs = deadlines?.elementMs ?? 3000
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const readyDeadline = Date.now() + readyMs
  while (document.readyState !== 'complete' && Date.now() < readyDeadline) {
    await sleep(100)
  }
  let scope = null
  if (scopeSelector) {
    const elementDeadline = Date.now() + elementMs
    for (;;) {
      scope = document.querySelector(scopeSelector)
      if (scope) break
      if (Date.now() >= elementDeadline) return []
      await sleep(100)
    }
  } else {
    scope = document
  }
  if (!scope) return []

  const candidates = scope.querySelectorAll(
    'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], summary, label, input[type="submit"], input[type="button"]',
  )
  const needle = text.toLowerCase()
  const matches = []
  // ROUND 9: maxMatches/buildSelector/escapeAttr are INLINED —
  // chrome.scripting serializes ONLY this function's body, so module-
  // scope helpers (and even the module's MAX_MATCHES const) become
  // ReferenceErrors in the real page.
  const maxMatches = 20
  const escapeAttr = (value) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  // Derive a stable CSS selector from the REAL element. Preference
  // order: title attribute → aria-label → exact href → DOM path. No
  // site-specific knowledge is embedded.
  const buildSelector = (el) => {
    const title = el.getAttribute?.('title')
    if (title) return `[title="${escapeAttr(title)}"]`
    const aria = el.getAttribute?.('aria-label')
    if (aria) return `[aria-label="${escapeAttr(aria)}"]`
    if (el.tagName === 'A' && el.getAttribute?.('href')) {
      return `a[href="${escapeAttr(el.getAttribute('href'))}"]`
    }
    const parts = []
    let node = el
    while (node && node !== document.documentElement) {
      const tag = node.tagName.toLowerCase()
      const parent = node.parentElement
      const siblings = parent
        ? [...parent.children].filter((sibling) => sibling.tagName === node.tagName)
        : []
      const index = siblings.length > 1 ? siblings.indexOf(node) + 1 : 1
      parts.unshift(index > 1 ? `${tag}:nth-of-type(${index})` : tag)
      node = parent
    }
    return parts.join(' > ')
  }

  for (const el of candidates) {
    if (matches.length >= maxMatches) break
    const visible = (el.innerText ?? el.textContent ?? '').trim()
    if (!visible) continue
    if (!visible.toLowerCase().includes(needle)) continue

    const match = {
      text: visible.length > 200 ? `${visible.slice(0, 200)}…` : visible,
      tag: el.tagName.toLowerCase(),
      selector: buildSelector(el),
    }
    if (el.href) match.href = el.href
    matches.push(match)
  }

  return matches
}
