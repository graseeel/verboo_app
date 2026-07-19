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
const CURSOR_RIPPLE_ID = 'verboo-agent-cursor-ripple'

/** Inclusive lower bound for the random presence pause (ms). */
export const PRESENCE_ACTION_DELAY_MS_MIN = 420
/** Inclusive upper bound for the random presence pause (ms). */
export const PRESENCE_ACTION_DELAY_MS_MAX = 580
/**
 * Representative delay in the presence range (for tests / docs).
 * Runtime uses {@link randomBetween} each action — long enough to see the cursor.
 */
export const PRESENCE_ACTION_DELAY_MS = 500

/** Cursor glide duration (ms) — matches in-page CSS transition. */
export const CURSOR_MOVE_MS = 420

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
 * When target is null/omitted, places cursor near viewport center with
 * a soft entrance (so presence is always visible during control).
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
 * Brief click pulse + ripple at the cursor tip (feedback before DOM click).
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export async function pulseAgentCursor(tabId) {
  if (typeof tabId !== 'number') return
  await chrome.scripting.executeScript({
    target: { tabId },
    func: pulseAgentCursorInPage,
    args: [CURSOR_ID, CURSOR_RIPPLE_ID],
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
    args: [[CURSOR_ID, CURSOR_STYLE_ID, CURSOR_RIPPLE_ID]],
  })
}

/**
 * Hide frame + cursor on a known tab (end of agent control).
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export async function clearPresence(tabId) {
  if (typeof tabId !== 'number') return
  // Clear independently so one failure does not leave the other visible.
  try {
    await hidePresenceFrame(tabId)
  } catch {
    /* ignore */
  }
  try {
    await hideAgentCursor(tabId)
  } catch {
    /* ignore */
  }
}

/**
 * Best-effort clear of presence overlays. Resolves the active tab when
 * `tabId` is omitted. Never throws — presence must not block turn teardown.
 *
 * @param {number} [tabId]
 * @returns {Promise<void>}
 */
export async function clearPresenceBestEffort(tabId) {
  try {
    let id = tabId
    if (typeof id !== 'number') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      id = tab?.id
    }
    if (typeof id !== 'number') return
    await clearPresence(id)
  } catch {
    // chrome:// pages, closed tabs, missing APIs — ignore.
  }
}

/**
 * Clear presence overlays on every tab that could have them. Targets:
 *   - All tabs in any "Verboo" tab group (any window)
 *   - Plus the active tab in every window (fallback when no group exists)
 *
 * Use at turn teardown when the agent may have opened / switched tabs
 * mid-turn and we don't want a stale frame left behind on a background tab.
 *
 * Never throws — presence cleanup must not block turn teardown.
 *
 * @returns {Promise<void>}
 */
export async function clearPresenceOnAllTabs() {
  try {
    /** @type {Set<number>} */
    const tabIds = new Set()
    try {
      const groups = await chrome.tabGroups.query({ title: VERBOO_TAB_GROUP_TITLE })
      for (const g of groups) {
        const tabs = await chrome.tabs.query({ groupId: g.id })
        for (const t of tabs) {
          if (typeof t.id === 'number') tabIds.add(t.id)
        }
      }
    } catch {
      // tabGroups may be unavailable — fall through to active-tab fallback.
    }
    try {
      const windows = await chrome.windows.getAll()
      for (const w of windows) {
        const [active] = await chrome.tabs.query({
          active: true,
          windowId: w.id,
        })
        if (typeof active?.id === 'number') tabIds.add(active.id)
      }
    } catch {
      // windows/tabs query failure — best-effort.
    }
    await Promise.all(
      Array.from(tabIds).map((id) => clearPresence(id).catch(() => {})),
    )
  } catch {
    // Whole-operation failure — ignore.
  }
}

/**
 * Frame + cursor for the whole control session (turn start / after navigate).
 * Always shows the cursor (viewport center when no target) so presence is
 * never "frame only".
 *
 * @param {number} tabId
 * @param {{ x: number; y: number } | { selector: string } | null | undefined} [target]
 * @returns {Promise<void>}
 */
export async function ensureAgentPresence(tabId, target) {
  if (typeof tabId !== 'number') return
  try {
    await showPresenceFrame(tabId)
    await showAgentCursor(tabId, target ?? null)
  } catch {
    // chrome:// pages, closed tabs, CSP — ignore.
  }
}

/**
 * Best-effort presence prelude used by click/type/read/screenshot:
 * frame + cursor (selector or center) + delay. Never throws.
 * Delay is randomBetween(280, 380) unless reduced-motion (0).
 *
 * @param {number} tabId
 * @param {string} [selector]
 * @returns {Promise<void>}
 */
export async function preparePresenceForAction(tabId, selector) {
  try {
    await showPresenceFrame(tabId)
    // Always animate the cursor — even without a selector (center target).
    await showAgentCursor(
      tabId,
      typeof selector === 'string' && selector ? { selector } : null,
    )
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
  // Must be self-contained (serialized into the page). Avoids innerHTML —
  // YouTube Trusted Types can reject string HTML injection.
  if (document.getElementById(frameId)) {
    const existing = document.getElementById(frameId)
    if (existing) existing.classList.add('verboo-frame-visible')
    return
  }

  const reduced =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches

  if (!document.getElementById(styleId)) {
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = `
#${frameId} {
  position: fixed !important;
  inset: 0 !important;
  pointer-events: none !important;
  z-index: 2147483646 !important;
  box-shadow:
    inset 0 0 0 3px rgba(147, 85, 255, 0.55),
    inset 0 0 24px 4px rgba(169, 109, 255, 0.22),
    0 0 18px 2px rgba(147, 85, 255, 0.18) !important;
  border-radius: 0 !important;
  opacity: 0;
  transition: opacity 220ms cubic-bezier(0.23, 1, 0.32, 1);
  margin: 0 !important;
  padding: 0 !important;
}
#${frameId}.verboo-frame-visible {
  opacity: 1 !important;
}
@keyframes verboo-presence-pulse {
  from {
    box-shadow:
      inset 0 0 0 3px rgba(147, 85, 255, 0.42),
      inset 0 0 16px 2px rgba(169, 109, 255, 0.14),
      0 0 10px 1px rgba(147, 85, 255, 0.10);
  }
  to {
    box-shadow:
      inset 0 0 0 3px rgba(147, 85, 255, 0.78),
      inset 0 0 32px 6px rgba(169, 109, 255, 0.34),
      0 0 26px 4px rgba(147, 85, 255, 0.28);
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
  requestAnimationFrame(() => {
    const f = document.getElementById(frameId)
    if (f) f.classList.add('verboo-frame-visible')
  })
}

/**
 * @param {string} cursorId
 * @param {string} styleId
 * @param {{ x?: number; y?: number; selector?: string } | null} target
 */
function injectAgentCursorInPage(cursorId, styleId, target) {
  // Self-contained (serialized into the page). No outer helpers, no innerHTML
  // (YouTube Trusted Types rejects string HTML injection).
  function buildPointerSvg() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '24')
    svg.setAttribute('height', '24')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('fill', '#9355ff')
    path.setAttribute('stroke', '#ffffff')
    path.setAttribute('stroke-width', '0.9')
    path.setAttribute('stroke-linejoin', 'round')
    path.setAttribute('d', 'M4 3 L4 19 L9 14 L12 21 L14.5 20 L11.5 13 L18 13 Z')
    svg.appendChild(path)
    return svg
  }

  const reduced =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches

  let x = window.innerWidth * 0.5
  let y = window.innerHeight * 0.42

  if (target && typeof target.selector === 'string') {
    let el = null
    try {
      el = document.querySelector(target.selector)
    } catch {
      el = null
    }
    if (el) {
      try {
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
      } catch {
        try {
          el.scrollIntoView(true)
        } catch {
          /* ignore */
        }
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
    style.textContent = `
#${cursorId} {
  position: fixed !important;
  left: 0 !important;
  top: 0 !important;
  width: 28px !important;
  height: 28px !important;
  pointer-events: none !important;
  z-index: 2147483647 !important;
  opacity: 0;
  transform-origin: 0 0;
  filter: drop-shadow(0 3px 6px rgba(0, 0, 0, 0.4)) drop-shadow(0 0 12px rgba(147, 85, 255, 0.55));
  will-change: transform, opacity;
  line-height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  background: transparent !important;
  border: none !important;
}
#${cursorId}.verboo-cursor-visible {
  opacity: 1 !important;
}
#${cursorId} svg {
  display: block !important;
  width: 24px !important;
  height: 24px !important;
  overflow: visible !important;
}
#${cursorId}.verboo-cursor-animate {
  transition:
    transform 420ms cubic-bezier(0.23, 1, 0.32, 1),
    opacity 200ms cubic-bezier(0.23, 1, 0.32, 1);
}
@keyframes verboo-cursor-idle {
  0%, 100% {
    filter: drop-shadow(0 3px 6px rgba(0, 0, 0, 0.4)) drop-shadow(0 0 10px rgba(147, 85, 255, 0.4));
  }
  50% {
    filter: drop-shadow(0 5px 10px rgba(0, 0, 0, 0.35)) drop-shadow(0 0 18px rgba(147, 85, 255, 0.75));
  }
}
#${cursorId}.verboo-cursor-idle {
  animation: verboo-cursor-idle 1.4s ease-in-out infinite;
}
#${cursorId}.verboo-cursor-click {
  transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1) !important;
  transform: var(--verboo-cursor-t) scale(0.86) !important;
}
@keyframes verboo-cursor-ripple {
  from {
    opacity: 0.65;
    transform: translate(-50%, -50%) scale(0.3);
  }
  to {
    opacity: 0;
    transform: translate(-50%, -50%) scale(1.85);
  }
}
#${cursorId}-ripple {
  position: fixed !important;
  width: 36px !important;
  height: 36px !important;
  border-radius: 50% !important;
  pointer-events: none !important;
  z-index: 2147483646 !important;
  border: 2px solid rgba(147, 85, 255, 0.85) !important;
  background: rgba(147, 85, 255, 0.22) !important;
  animation: verboo-cursor-ripple 480ms cubic-bezier(0.23, 1, 0.32, 1) forwards;
  margin: 0 !important;
  padding: 0 !important;
}
`.trim()
    ;(document.documentElement || document.body).appendChild(style)
  }

  let cursor = document.getElementById(cursorId)
  const transform = `translate(${x}px, ${y}px)`

  if (!cursor) {
    cursor = document.createElement('div')
    cursor.id = cursorId
    cursor.setAttribute('aria-hidden', 'true')
    cursor.appendChild(buildPointerSvg())
    const enterX = Math.max(0, x - 36)
    const enterY = Math.max(0, y - 24)
    cursor.style.transform = `translate(${enterX}px, ${enterY}px)`
    cursor.style.setProperty('--verboo-cursor-t', transform)
    ;(document.documentElement || document.body).appendChild(cursor)
    if (!reduced) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const c = document.getElementById(cursorId)
          if (!c) return
          c.classList.add('verboo-cursor-animate', 'verboo-cursor-visible')
          c.style.transform = transform
          c.style.setProperty('--verboo-cursor-t', transform)
          setTimeout(() => {
            const live = document.getElementById(cursorId)
            if (live) live.classList.add('verboo-cursor-idle')
          }, 450)
        })
      })
    } else {
      cursor.classList.add('verboo-cursor-visible')
      cursor.style.transform = transform
    }
  } else {
    if (!cursor.querySelector('svg')) {
      while (cursor.firstChild) cursor.removeChild(cursor.firstChild)
      cursor.appendChild(buildPointerSvg())
    }
    cursor.classList.remove('verboo-cursor-idle', 'verboo-cursor-click')
    if (reduced) {
      cursor.classList.remove('verboo-cursor-animate')
      cursor.classList.add('verboo-cursor-visible')
    } else {
      cursor.classList.add('verboo-cursor-animate', 'verboo-cursor-visible')
    }
    cursor.style.transform = transform
    cursor.style.setProperty('--verboo-cursor-t', transform)
    if (!reduced) {
      setTimeout(() => {
        const live = document.getElementById(cursorId)
        if (live) live.classList.add('verboo-cursor-idle')
      }, 450)
    }
  }
}

/**
 * @param {string} cursorId
 * @param {string} rippleId
 */
function pulseAgentCursorInPage(cursorId, rippleId) {
  const cursor = document.getElementById(cursorId)
  if (!cursor) return

  const reduced =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches

  const m = /translate\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px\s*\)/.exec(
    cursor.style.transform || '',
  )
  const x = m ? Number(m[1]) : window.innerWidth / 2
  const y = m ? Number(m[2]) : window.innerHeight / 2
  const base = `translate(${x}px, ${y}px)`
  cursor.style.setProperty('--verboo-cursor-t', base)

  if (!reduced) {
    cursor.classList.remove('verboo-cursor-idle')
    cursor.classList.add('verboo-cursor-click')
    setTimeout(() => {
      const c = document.getElementById(cursorId)
      if (!c) return
      c.classList.remove('verboo-cursor-click')
      c.style.transform = base
      c.classList.add('verboo-cursor-idle')
    }, 160)
  }

  document.getElementById(rippleId)?.remove()
  if (reduced) return
  const ripple = document.createElement('div')
  ripple.id = rippleId
  ripple.setAttribute('aria-hidden', 'true')
  ripple.style.left = `${x}px`
  ripple.style.top = `${y}px`
  ;(document.documentElement || document.body).appendChild(ripple)
  setTimeout(() => ripple.remove(), 500)
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
