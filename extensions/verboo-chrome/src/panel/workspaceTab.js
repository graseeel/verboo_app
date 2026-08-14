/**
 * workspaceTab.js — pure helpers for the workspace-tab indicator (panel).
 *
 * The agent works in a dedicated, unfocused workspace tab. These helpers keep
 * the panel's "which tab is Verboo acting on?" surface testable without a DOM.
 *
 * Tab titles and URLs are page-derived, untrusted strings: callers must render
 * them with textContent, never innerHTML. No model, provider, or user data is
 * hardcoded here.
 */

const TAB_TITLE_MAX = 60

/**
 * Collapse whitespace and bound a tab title for a single-line chip.
 * @param {unknown} title
 * @param {number} [max]
 * @returns {string}
 */
export function truncateTabTitle(title, max = TAB_TITLE_MAX) {
  const text = String(title ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/**
 * Display host for a tab URL ('' when the URL is missing or not parseable).
 * @param {unknown} url
 * @returns {string}
 */
export function tabUrlHost(url) {
  try {
    const parsed = new URL(String(url ?? ''))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return parsed.hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

/**
 * Human label for a workspace tab: truncated title, else host, else ''.
 * Callers fall back to their localized "untitled" string when this is empty.
 * @param {{ title?: unknown, url?: unknown } | null | undefined} tab
 * @returns {string}
 */
export function workspaceTabLabel(tab) {
  const title = truncateTabTitle(tab?.title)
  if (title) return title
  return tabUrlHost(tab?.url)
}

/**
 * A tab descriptor the panel can render. tabId is required; windowId is only
 * needed to focus the tab.
 * @param {unknown} tab
 * @returns {tab is { tabId: number, windowId?: number, title?: string, url?: string }}
 */
export function isWorkspaceTab(tab) {
  return Boolean(
    tab &&
    typeof tab === 'object' &&
    Number.isInteger(/** @type {{tabId?: unknown}} */ (tab).tabId) &&
    (/** @type {{title?: unknown}} */ (tab).title == null ||
      typeof /** @type {{title?: unknown}} */ (tab).title === 'string') &&
    (/** @type {{url?: unknown}} */ (tab).url == null ||
      typeof /** @type {{url?: unknown}} */ (tab).url === 'string'),
  )
}

/**
 * Focusing needs both ids; without them the chip stays read-only.
 * @param {unknown} tab
 */
export function canFocusWorkspaceTab(tab) {
  return isWorkspaceTab(tab) && Number.isInteger(/** @type {{windowId?: unknown}} */ (tab).windowId)
}

/**
 * Chip visibility: hidden without a valid tab, closed when the tab went away
 * mid-turn, otherwise visible (caller picks the acting/result phase).
 * @param {{ tab?: unknown, closed?: boolean }} [state]
 * @returns {'hidden' | 'closed' | 'visible'}
 */
export function workspaceTabChipState({ tab, closed } = {}) {
  if (!isWorkspaceTab(tab)) return 'hidden'
  return closed ? 'closed' : 'visible'
}

/**
 * Tab ids a tool call targets (tabs switch/close, tab_group assign/create),
 * deduped and capped at 3 for display.
 * @param {{ params?: unknown } | null | undefined} toolCall
 * @returns {number[]}
 */
export function toolCallTabIds(toolCall) {
  const params = toolCall?.params
  if (!params || typeof params !== 'object') return []
  const record = /** @type {{ tabId?: unknown, tabIds?: unknown }} */ (params)
  const ids = []
  if (Number.isInteger(record.tabId)) ids.push(/** @type {number} */ (record.tabId))
  if (Array.isArray(record.tabIds)) {
    for (const id of record.tabIds) {
      if (Number.isInteger(id)) ids.push(id)
    }
  }
  return [...new Set(ids)].slice(0, 3)
}
