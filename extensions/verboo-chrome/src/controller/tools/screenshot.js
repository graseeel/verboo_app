/**
 * screenshot.js — capture the visible tab as a PNG data URL.
 *
 * Uses chrome.tabs.captureVisibleTab (no debugger needed). For
 * fullPage captures we'd need chrome.debugger + Page.captureScreenshot
 * with `captureBeyondViewport: true` — that lands when the debugger
 * permission is re-added. For now, viewport-only.
 *
 * Chrome requires either `<all_urls>` host permission or temporary
 * `activeTab` for captureVisibleTab — plain http(s) patterns are NOT
 * enough (common "Could not capture" failure from the side panel).
 *
 * @param {{ name: 'screenshot'; format?: 'viewport' | 'fullPage'; risk?: string; input?: string }} tool
 * @param {{ activeTabId?: number }} [ctx]
 * @returns {Promise<{ dataUrl: string; format: string; width: number; height: number }>}
 */

import { preparePresenceForAction } from '../../presence/inject.js'
import { resolveTargetTab } from '../targetTab.js'

const CAPTURE_RETRIES = 4
const CAPTURE_RETRY_MS = 180

export async function screenshot(tool, ctx = {}) {
  const format = tool?.format ?? 'viewport'
  if (format === 'fullPage') {
    throw new Error('screenshot: fullPage requires debugger permission (not yet enabled)')
  }

  const tab = await resolveTargetTab(ctx?.activeTabId)
  if (!tab?.id) throw new Error('screenshot: no active tab')
  if (!tab.windowId && tab.windowId !== 0) {
    throw new Error('screenshot: active tab has no window')
  }

  const url = tab.url ?? ''
  if (url && !isCapturableUrl(url)) {
    throw new Error(
      `screenshot failed: cannot capture restricted page (${schemeOf(url) || 'unknown'}). Navigate to an http(s) page first.`,
    )
  }

  // captureVisibleTab targets the active tab in the specified window. The
  // window does not need to become the user's focused window, which lets a
  // dedicated Verboo workspace stay behind whatever the user is doing.
  const visible = await isTabActiveInWindow(tab)
  let dataUrl
  if (visible) {
    try {
      await preparePresenceForAction(tab.id)
    } catch {
      /* presence is best-effort */
    }
    dataUrl = await captureWithRetries(tab.windowId)
  } else {
    // CICLO DEPURAÇÃO SISTEMÁTICA (B): captureVisibleTab só captura a aba
    // visível — com o lease em background (usuário trocou de aba), TODO
    // screenshot falha. Erro honesto com dica dirigida: a aba está em
    // segundo plano, screenshots indisponíveis, use read_page. Sem a dica,
    // o modelo re-tenta 99x (evidência 8d61dcb).
    throw new Error(
      'screenshot indisponível: a aba de trabalho está em segundo plano (captureVisibleTab só captura a aba visível). ' +
      'Use read_page para inspecionar o conteúdo da aba de trabalho.',
    )
  }

  let width = 0
  let height = 0
  try {
    const [size] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ w: window.innerWidth, h: window.innerHeight }),
    })
    width = size?.result?.w ?? 0
    height = size?.result?.h ?? 0
  } catch {
    /* size is optional — capture itself succeeded */
  }

  return {
    dataUrl,
    format: 'viewport',
    width,
    height,
  }
}

/**
 * Check if the target is the active tab in its own window. Window focus is
 * deliberately irrelevant: changing it would steal the user's screen.
 * @param {{ id: number, windowId: number }} tab
 * @returns {Promise<boolean>}
 */
async function isTabActiveInWindow(tab) {
  try {
    const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId })
    return active?.id === tab.id
  } catch {
    return false
  }
}

/**
 * @param {number} windowId
 * @returns {Promise<string>}
 */
async function captureWithRetries(windowId) {
  let lastErr = null
  for (let attempt = 0; attempt < CAPTURE_RETRIES; attempt++) {
    if (attempt > 0) await sleep(CAPTURE_RETRY_MS * attempt)
    try {
      // Prefer jpeg for smaller LLM payloads; fall back to png.
      try {
        return await chrome.tabs.captureVisibleTab(windowId, {
          format: 'jpeg',
          quality: 85,
        })
      } catch {
        return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
      }
    } catch (err) {
      lastErr = err
    }
  }
  const detail = lastErr?.message ?? String(lastErr ?? 'captureVisibleTab denied')
  throw new Error(
    `screenshot failed: ${detail}. Ensure the workspace tab is active in its own window and the page is http(s). Reload the extension after permission updates.`,
  )
}

function isCapturableUrl(url) {
  return /^https?:\/\//i.test(url) || /^file:\/\//i.test(url)
}

function schemeOf(url) {
  try {
    return new URL(url).protocol.replace(':', '')
  } catch {
    return ''
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
