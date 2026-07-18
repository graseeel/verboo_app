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
    throw new Error('screenshot: fullPage requires debugger permission (not yet enabled)')
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('screenshot: no active tab')

  // Ensure the tab is active before capture — captureVisibleTab captures the
  // window's active tab, which may differ from the tab we queried if the
  // extension runs in the background. The brief sleep lets the browser settle.
  await chrome.tabs.update(tab.id, { active: true })
  await sleep(50)

  let dataUrl
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  } catch (err) {
    throw new Error(
      `screenshot failed: ${err?.message ?? 'captureVisibleTab denied'}. The tab may not be focused or the page is restricted (chrome://, pdf viewer, etc.). Wait for navigation to complete and try again.`,
    )
  }

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
