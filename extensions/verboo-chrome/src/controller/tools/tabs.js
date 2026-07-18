/**
 * tabs.js — tab management: list, switch, close, new.
 *
 * Uses chrome.tabs only (no debugger). All actions operate on the
 * current window by default.
 *
 * @param {{ name: 'tabs'; action: 'list' | 'switch' | 'close' | 'new'; tabId?: number; url?: string; risk?: string; input?: string }} tool
 * @returns {Promise<unknown>}
 */
export async function tabs(tool) {
  const action = tool?.action
  switch (action) {
    case 'list':
      return listTabs()
    case 'switch':
      if (typeof tool.tabId !== 'number') throw new Error('tabs.switch: missing tabId')
      await chrome.tabs.update(tool.tabId, { active: true })
      return { tabId: tool.tabId, switched: true }
    case 'close':
      if (typeof tool.tabId !== 'number') throw new Error('tabs.close: missing tabId')
      await chrome.tabs.remove(tool.tabId)
      return { tabId: tool.tabId, closed: true }
    case 'new':
      return newTab(tool.url)
    default:
      throw new Error(`tabs: unknown action: ${action}`)
  }
}

async function listTabs() {
  const all = await chrome.tabs.query({ currentWindow: true })
  return {
    tabs: all.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
      windowId: t.windowId,
    })),
    count: all.length,
  }
}

async function newTab(url) {
  const safeUrl = url && typeof url === 'string' ? url : 'about:newtab'
  // Defense-in-depth: only allow http(s) and about:newtab.
  if (!/^https?:\/\//i.test(safeUrl) && safeUrl !== 'about:newtab') {
    throw new Error(`tabs.new: unsupported scheme: ${safeUrl.split(':')[0]}`)
  }
  const tab = await chrome.tabs.create({ url: safeUrl })
  return { tabId: tab.id, url: safeUrl }
}
