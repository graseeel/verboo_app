/**
 * presence/inject.js — agent presence for Verboo (tab group + frame + cursor).
 *
 * Visual + tab-group cues while Verboo controls the browser:
 *   - Purple "Verboo" tab group
 *   - Animated purple viewport frame
 *   - Classic purple SVG mouse-arrow cursor that moves to the interaction target
 *
 * Prefer chrome.scripting.executeScript (no content_scripts) so overlays
 * only appear during control. All public helpers are best-effort: failures
 * (chrome:// pages, missing permissions) are swallowed by callers so
 * presence never blocks real tool actions.
 *
 * Multi-user: zero hardcoded path/user/token.
 */

/** @type {string} */
export const VERBOO_TAB_GROUP_TITLE = 'Verboo'

/** chrome.tabGroups color enum value */
export const VERBOO_TAB_GROUP_COLOR = 'purple'

const FRAME_ID = 'verboo-presence-frame'
const FRAME_STYLE_ID = 'verboo-presence-frame-style'
const CURSOR_ID = 'verboo-agent-cursor'
const CURSOR_STYLE_ID = 'verboo-agent-cursor-style'

/** Inclusive lower bound for the random presence pause (ms). */
export const PRESENCE_ACTION_DELAY_MS_MIN = 280
/** Inclusive upper bound for the random presence pause (ms). */
export const PRESENCE_ACTION_DELAY_MS_MAX = 380
/**
 * Representative delay in the [280, 380] range (for tests / docs).
 * Runtime uses {@link randomBetween}(280, 380) each action.
 */
export const PRESENCE_ACTION_DELAY_MS = 330

/**
 * Inclusive integer random in [min, max].
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randomBetween(min, max) {
  const lo = Math.ceil(min)
  const hi = Math.floor(max)
  return Math.floor(Math.random() * (hi - lo + 1)) + lo
}

// ── Tab group ──────────────────────────────────────────────────

/**
 * Ensure `tabId` is in a purple tab group titled "Verboo".
 * Reuses an existing Verboo group in the same window when present.
 *
 * @param {number} tabId
 * @returns {Promise<{ groupId: number }>}
 */
export async function ensureVerbooTabGroup(tabId) {
  if (typeof tabId !== 'number') {
    throw new Error('ensureVerbooTabGroup: missing tabId')
  }

  const tab = await chrome.tabs.get(tabId)
  const windowId = tab.windowId

  // Prefer an existing Verboo group in this window.
  const existing = await chrome.tabGroups.query({
    title: VERBOO_TAB_GROUP_TITLE,
    windowId,
  })

  let groupId
  if (existing.length > 0) {
    groupId = await chrome.tabs.group({ groupId: existing[0].id, tabIds: [tabId] })
  } else if (
    tab.groupId != null &&
    tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE
  ) {
    // Tab already grouped — if that group is already Verboo, just restyle.
    try {
      const current = await chrome.tabGroups.get(tab.groupId)
      if (current.title === VERBOO_TAB_GROUP_TITLE) {
        await chrome.tabGroups.update(current.id, {
          title: VERBOO_TAB_GROUP_TITLE,
          color: VERBOO_TAB_GROUP_COLOR,
        })
        return { groupId: current.id }
      }
    } catch {
      // Fall through to create/move.
    }
    groupId = await chrome.tabs.group({ tabIds: [tabId] })
  } else {
    groupId = await chrome.tabs.group({ tabIds: [tabId] })
  }

  await chrome.tabGroups.update(groupId, {
    title: VERBOO_TAB_GROUP_TITLE,
    color: VERBOO_TAB_GROUP_COLOR,
  })
  return { groupId }
}

// ── Viewport frame ─────────────────────────────────────────────

/**
 * Inject (or re-assert) the purple presence frame on the page.
 * Idempotent — does not double-inject.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export async function showPresenceFrame(tabId) {
  if (typeof tabId !== 'number') return
  await chrome.scripting.executeScript({
    target: { tabId },
    func: injectPresenceFrameInPage,
    args: [FRAME_ID, FRAME_STYLE_ID],
  })
}

/**
 * Remove the presence frame overlay from the page (optional end of turn).
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export async function hidePresenceFrame(tabId) {
  if (typeof tabId !== 'number') return
  await chrome.scripting.executeScript({
    target: { tabId },
    func: removeByIdsInPage,
    args: [[FRAME_ID, FRAME_STYLE_ID]],
  })
}

// ── Agent cursor ───────────────────────────────────────────────

/**
 * Show / move the agent cursor. Accepts viewport coords or a selector
 * (centers on the element's bounding rect; scrolls into view first).
 *
 * @param {number} tabId
 * @param {{ x: number; y: number } | { selector: string } | null | undefined} target
 * @returns {Promise<void>}
 */
export async function showAgentCursor(tabId, target) {
  if (typeof tabId !== 'number') return
  const payload =
    target && typeof target === 'object'
      ? target
      : null
  await chrome.scripting.executeScript({
    target: { tabId },
    func: injectAgentCursorInPage,
    args: [CURSOR_ID, CURSOR_STYLE_ID, payload],
  })
}

/**
 * Remove the agent cursor overlay.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export async function hideAgentCursor(tabId) {
  if (typeof tabId !== 'number') return
  await chrome.scripting.executeScript({
    target: { tabId },
    func: removeByIdsInPage,
    args: [[CURSOR_ID, CURSOR_STYLE_ID]],
  })
}

/**
 * Best-effort presence prelude used by click/type: frame + cursor + delay.
 * Never throws. Delay is randomBetween(280, 380) unless reduced-motion (0).
 *
 * @param {number} tabId
 * @param {string} [selector]
 * @returns {Promise<void>}
 */
export async function preparePresenceForAction(tabId, selector) {
  try {
    await showPresenceFrame(tabId)
    if (selector) {
      await showAgentCursor(tabId, { selector })
    }
    const delayMs = await resolvePresenceDelayMs(tabId)
    if (delayMs > 0) await sleep(delayMs)
  } catch {
    // chrome:// pages, closed tabs, CSP edge cases — ignore.
  }
}

/**
 * @param {number} tabId
 * @returns {Promise<number>} 0 when prefers-reduced-motion, else 280–380
 */
async function resolvePresenceDelayMs(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        typeof matchMedia === 'function' &&
        matchMedia('(prefers-reduced-motion: reduce)').matches,
    })
    if (r?.result) return 0
  } catch {
    // Fall through to random delay.
  }
  return randomBetween(PRESENCE_ACTION_DELAY_MS_MIN, PRESENCE_ACTION_DELAY_MS_MAX)
}

// ── In-page injectors (serialized into the page via executeScript) ──

/**
 * @param {string} frameId
 * @param {string} styleId
 */
function injectPresenceFrameInPage(frameId, styleId) {
  if (document.getElementById(frameId)) return

  const reduced =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches

  if (!document.getElementById(styleId)) {
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = `
#${frameId} {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483646;
  box-shadow:
    inset 0 0 0 3px rgba(147, 85, 255, 0.55),
    inset 0 0 24px 4px rgba(169, 109, 255, 0.22),
    0 0 18px 2px rgba(147, 85, 255, 0.18);
  border-radius: 0;
}
@keyframes verboo-presence-pulse {
  from {
    box-shadow:
      inset 0 0 0 3px rgba(147, 85, 255, 0.42),
      inset 0 0 16px 2px rgba(169, 109, 255, 0.14),
      0 0 10px 1px rgba(147, 85, 255, 0.10);
    opacity: 0.88;
  }
  to {
    box-shadow:
      inset 0 0 0 3px rgba(147, 85, 255, 0.78),
      inset 0 0 32px 6px rgba(169, 109, 255, 0.34),
      0 0 26px 4px rgba(147, 85, 255, 0.28);
    opacity: 1;
  }
}
#${frameId}.verboo-animate {
  animation: verboo-presence-pulse 2s ease-in-out infinite alternate;
}
`.trim()
    ;(document.documentElement || document.body).appendChild(style)
  }

  const frame = document.createElement('div')
  frame.id = frameId
  frame.setAttribute('aria-hidden', 'true')
  if (!reduced) frame.classList.add('verboo-animate')
  ;(document.documentElement || document.body).appendChild(frame)
}

/**
 * @param {string} cursorId
 * @param {string} styleId
 * @param {{ x?: number; y?: number; selector?: string } | null} target
 */
function injectAgentCursorInPage(cursorId, styleId, target) {
  // Must be self-contained: chrome.scripting.executeScript serializes this
  // function alone (no outer module scope). Classic pointer tip ≈ top-left.
  const cursorSvgHtml =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="#9355ff" stroke="#fff" stroke-width="0.8" d="M4 3 L4 19 L9 14 L12 21 L14.5 20 L11.5 13 L18 13 Z"/>' +
    '</svg>'

  const reduced =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches

  let x = window.innerWidth / 2
  let y = window.innerHeight / 2

  if (target && typeof target.selector === 'string') {
    const el = document.querySelector(target.selector)
    if (el) {
      // Instant scroll so getBoundingClientRect matches the final position
      // before the action delay (smooth would leave coords mid-scroll).
      try {
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
      } catch {
        el.scrollIntoView(true)
      }
      const rect = el.getBoundingClientRect()
      x = rect.left + rect.width / 2
      y = rect.top + rect.height / 2
    }
  } else if (
    target &&
    typeof target.x === 'number' &&
    typeof target.y === 'number' &&
    Number.isFinite(target.x) &&
    Number.isFinite(target.y)
  ) {
    x = target.x
    y = target.y
  }

  if (!document.getElementById(styleId)) {
    const style = document.createElement('style')
    style.id = styleId
    // Classic SVG pointer: tip at transform-origin 0 0, soft purple drop-shadow.
    style.textContent = `
#${cursorId} {
  position: fixed;
  left: 0;
  top: 0;
  width: 20px;
  height: 20px;
  pointer-events: none;
  z-index: 2147483647;
  opacity: 0.95;
  transform-origin: 0 0;
  filter: drop-shadow(0 3px 5px rgba(0, 0, 0, 0.3)) drop-shadow(0 0 8px rgba(147, 85, 255, 0.25));
  will-change: transform;
  line-height: 0;
}
#${cursorId} svg {
  display: block;
  width: 20px;
  height: 20px;
  overflow: visible;
}
#${cursorId}.verboo-cursor-animate {
  transition: transform 380ms cubic-bezier(0.23, 1, 0.32, 1);
}
`.trim()
    ;(document.documentElement || document.body).appendChild(style)
  }

  let cursor = document.getElementById(cursorId)
  // Tip of the arrow is the hotspot (origin 0,0) — no centering offset.
  const transform = `translate(${x}px, ${y}px)`

  if (!cursor) {
    cursor = document.createElement('div')
    cursor.id = cursorId
    cursor.setAttribute('aria-hidden', 'true')
    cursor.innerHTML = cursorSvgHtml
    // Place without transition first, then enable animation for later moves.
    cursor.style.transform = transform
    ;(document.documentElement || document.body).appendChild(cursor)
    if (!reduced) {
      // Next frame: enable transition for subsequent moves.
      requestAnimationFrame(() => {
        const c = document.getElementById(cursorId)
        if (c) c.classList.add('verboo-cursor-animate')
      })
    }
  } else {
    if (!cursor.querySelector('svg')) {
      cursor.innerHTML = cursorSvgHtml
    }
    if (reduced) {
      cursor.classList.remove('verboo-cursor-animate')
    } else {
      cursor.classList.add('verboo-cursor-animate')
    }
    cursor.style.transform = transform
  }
}

/**
 * @param {string[]} ids
 */
function removeByIdsInPage(ids) {
  for (const id of ids) {
    document.getElementById(id)?.remove()
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
