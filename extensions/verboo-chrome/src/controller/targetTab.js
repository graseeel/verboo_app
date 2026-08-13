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
