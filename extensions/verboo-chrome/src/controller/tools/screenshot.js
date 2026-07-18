/**
 * screenshot.js — capture the visible tab as a PNG data URL.
 *
 * Uses chrome.tabs.captureVisibleTab (no debugger needed). For
 * fullPage captures we'd need chrome.debugger + Page.captureScreenshot
 * with `captureBeyondViewport: true` — that lands when the debugger
 * permission is re-added. For now, viewport-only.
 *
 * @param {{ name: 'screenshot'; format?: 'viewport' | 'fullPage'; risk?: string; input?: string }} tool
 * @returns {Promise<{ dataUrl: string; format: string; width: number; height: number }>}
 */
export async function screenshot(tool) {
  const format = tool?.format ?? 'viewport'
  if (format === 'fullPage') {
    // P2 limitation: fullPage requires debugger. Return a clear error
    // so the agent client can fall back to viewport or wait for P3.
    throw new Error('screenshot: fullPage requires debugger permission (not yet enabled)')
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('screenshot: no active tab')

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  // captureVisibleTab doesn't return dimensions; the caller can decode
  // the PNG if needed. We return the tab's viewport size as a hint.
  const [size] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({ w: window.innerWidth, h: window.innerHeight }),
  })
  return {
    dataUrl,
    format: 'viewport',
    width: size?.result?.w ?? 0,
    height: size?.result?.h ?? 0,
  }
}
