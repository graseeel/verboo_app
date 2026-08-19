/**
 * Decide the tab a turn's execution context targets. DECISÃO DO DONO
 * (workspace, 2026-08-16): with a live lease the lease tab is the ONLY
 * target; with no lease and no explicit fallback there is NO target —
 * the user's active tab is their own browsing (they may have switched
 * mid-turn), and silently acting there is the lease escape T3 caught
 * (a type ran on the active X.com tab while the lease was TodoMVC).
 * Fail closed: target_tab_unavailable.
 *
 * @param {{ tabId: number } | null | undefined} leasedTarget
 * @param {number | undefined} fallbackTabId
 * @returns {number}
 */
export function resolveExecutionTabId(leasedTarget, fallbackTabId) {
  if (leasedTarget) return leasedTarget.tabId
  if (Number.isInteger(fallbackTabId)) return fallbackTabId
  throw new Error('target_tab_unavailable')
}

/**
 * Resolve the tab owned by the current turn. When an explicit target is gone,
 * fail closed: silently falling back could act on the user's foreground tab.
 */
export async function resolveTargetTab(preferredTabId) {
  if (typeof preferredTabId === 'number') {
    try {
      const tab = await chrome.tabs.get(preferredTabId)
      if (tab?.id) return tab
    } catch {
      /* reported below with a stable controller error */
    }
    throw new Error('target_tab_unavailable')
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab?.id) return tab
  } catch {
    /* older Chrome versions may reject lastFocusedWindow */
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab ?? null
}
