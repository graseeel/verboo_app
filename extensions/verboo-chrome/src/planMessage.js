/**
 * planMessage.js — agent planner heuristic (P2 stub).
 *
 * Pure functions. No chrome.* calls. Imported by background.js to
 * produce a plan of ToolCalls from a user message. Extracted to its own
 * module so it can be unit-tested with `node --test` without spinning
 * up a service-worker shim.
 *
 * Contract:
 *   - planForMessage(userMessage, activeTabUrl) returns:
 *       { plan: ToolCall[], assistantMessage?: string }
 *   - If `assistantMessage` is set, the caller should broadcast
 *     AGENT_TURN_COMPLETE with that message and an empty toolResults.
 *     The plan will be empty in that case.
 *   - If the active tab URL is non-controllable (chrome://, about:,
 *     edge://, chrome-extension://) AND the user asked to navigate
 *     somewhere or named a site, we plan a navigate to the resolved
 *     URL — that bypasses the unreachable tab entirely.
 *   - If the active tab URL is non-controllable AND there is no
 *     navigate intent / no site name, we return an empty plan with a
 *     friendly assistant message telling the user to open a normal
 *     website first.
 *
 * Multi-user: zero hardcoded accounts / paths / users.
 */

/**
 * @typedef {import('./controller/protocol.js').ToolCall} ToolCall
 */

// ── Constants ───────────────────────────────────────────────

/**
 * Navigate-intent verbs in EN + PT (with optional prepositions).
 * Word-boundary anchored so words like "openest" or "opening" still
 * match (intentional — these are common in user chat).
 */
const NAVIGATE_INTENT_RE =
  /\b(open|go\s+to|navigate|visit|abra|abrir|abre|vai\s+para|ir\s+para|acessar|acesso)\b/i

/**
 * Known site tokens → canonical URL. Order matters: when a message
 * contains multiple tokens (e.g. "search youtube for X"), the first
 * match wins (see extractUrl).
 *
 * NOT exhaustive — bare domain-like words that aren't in this map
 * must NOT be guessed. Only sites we are confident about ship here.
 */
const SITE_TOKEN_MAP = Object.freeze({
  youtube: 'https://www.youtube.com',
  'you tube': 'https://www.youtube.com',
  'youtu.be': 'https://www.youtube.com',
  google: 'https://www.google.com',
  github: 'https://github.com',
  'git hub': 'https://github.com',
  gmail: 'https://mail.google.com',
  twitter: 'https://x.com',
  x: 'https://x.com',
  'x.com': 'https://x.com',
  reddit: 'https://www.reddit.com',
  stackoverflow: 'https://stackoverflow.com',
  'stack overflow': 'https://stackoverflow.com',
  wikipedia: 'https://www.wikipedia.org',
  chatgpt: 'https://chatgpt.com',
  'chat gpt': 'https://chatgpt.com',
  claude: 'https://claude.ai',
  verboo: 'https://verboo.ai',
})

/**
 * Schemes that the extension cannot act on. The navigate tool's
 * defense-in-depth check rejects these, and executeScript cannot run
 * on them either. Surfacing a friendly message is better than letting
 * the raw Chrome exception propagate to the panel.
 */
const NON_CONTROLLABLE_SCHEMES = Object.freeze([
  'chrome:',
  'chrome-extension:',
  'chrome-search:',
  'chrome-devtools:',
  'edge:',
  'about:',
  'devtools:',
  'view-source:',
  'file:',
])

const PURCHASE_INTENT_RE = /\b(buy|purchase|checkout|order|pay|payment)\b/i

/**
 * YouTube search / play-music intent (EN + PT).
 * Captures the query string when present.
 *
 * Examples matched:
 *   - "search cats on youtube"
 *   - "search youtube for lo-fi"
 *   - "pesquise gatos no youtube"
 *   - "tocar musica lo-fi"
 *   - "tocar música X"
 */
const YOUTUBE_SEARCH_RE =
  /(?:search\s+(?:for\s+)?(.+?)\s+on\s+youtube|search\s+youtube\s+for\s+(.+)|(?:pesquise|pesquisar|procure|procurar)\s+(.+?)\s+no\s+youtube|tocar\s+m[uú]sica\s+(.+)|play\s+(?:music|song)\s+(.+?)(?:\s+on\s+youtube)?)/i

/** YouTube search box — common stable selectors. */
const YOUTUBE_SEARCH_SELECTOR = 'input#search, input[name="search_query"]'

// ── Public API ───────────────────────────────────────────────

/**
 * Plan tool calls for a user message.
 *
 * @param {string} userMessage
 * @param {string} [activeTabUrl] - URL string of the active tab (may be a chrome:// URL).
 * @returns {{ plan: ToolCall[], assistantMessage?: string }}
 */
export function planForMessage(userMessage, activeTabUrl) {
  const lower = String(userMessage ?? '').toLowerCase().trim()
  if (!lower) {
    return {
      plan: [],
      assistantMessage:
        'I did not catch that. Type what you want me to do, for example "open youtube".',
    }
  }

  const isPurchase = PURCHASE_INTENT_RE.test(lower)
  const wantsNavigate = NAVIGATE_INTENT_RE.test(lower)
  const url = extractUrl(userMessage)
  const siteToken = matchSiteToken(userMessage)
  const youtubeQuery = extractYoutubeSearchQuery(userMessage)

  const onInternalPage = !isControllableUrl(activeTabUrl)

  /** @type {ToolCall[]} */
  const plan = []

  // 0) YouTube search / play-music — navigate then type into the search box.
  //    Takes priority over a bare navigate when a query was extracted.
  if (youtubeQuery) {
    plan.push(
      buildNavigateToolCall('https://www.youtube.com', 'Open YouTube for search'),
    )
    plan.push(
      buildTypeToolCall(
        YOUTUBE_SEARCH_SELECTOR,
        youtubeQuery,
        'Type the YouTube search query',
      ),
    )
    return { plan }
  }

  // 1) Navigate branch — explicit URL, OR explicit intent with a
  //    recognised site token, OR explicit intent with no token (we'll
  //    let the URL extractor find an embedded URL, otherwise we don't
  //    invent one).
  if (url || (wantsNavigate && siteToken)) {
    const resolved = url ?? siteToken
    plan.push(buildNavigateToolCall(resolved, 'Open the requested page'))
  } else if (wantsNavigate && onInternalPage) {
    // "abra o youtube para mim" on chrome://extensions — navigate
    // intent is present but no URL/site was extracted yet. Try the
    // token map one more time against the original message (case-
    // insensitive, broader match).
    if (siteToken) {
      plan.push(buildNavigateToolCall(siteToken, 'Open the requested page'))
    } else {
      // Intent without a recognisable site — be honest about it.
      return {
        plan: [],
        assistantMessage:
          'I can open a website for you, but I need a name or URL. Try "open youtube" or "go to https://example.com".',
      }
    }
  } else if (wantsNavigate) {
    // Intent on a controllable page but no URL and no recognised site —
    // same honest response. Do NOT invent an arbitrary URL.
    return {
      plan: [],
      assistantMessage:
        'I can open a website for you, but I need a name or URL. Try "open youtube" or "go to https://example.com".',
    }
  }

  // 2) Purchase branch — routes to click on a buy-now selector so the
  //    Hard Block fires as designed.
  if (isPurchase) {
    plan.push({
      id: cryptoRandomId(),
      name: 'click',
      risk: 'mutate',
      input: 'click selector=button#buy-now text=Buy Now',
      params: { selector: 'button#buy-now' },
      reasoning: 'Click the buy button as the user requested',
    })
  }

  // 3) Read fallback — only on a controllable page, and only if no
  //    other action was planned.
  if (plan.length === 0) {
    if (onInternalPage) {
      return {
        plan: [],
        assistantMessage:
          'This page cannot be controlled (internal browser page like chrome:// or about:). Open a normal website first, then ask me to read or act on it.',
      }
    }
    plan.push({
      id: cryptoRandomId(),
      name: 'read_page',
      risk: 'read',
      input: 'read_page selector=body',
      params: { selector: 'body' },
      reasoning: 'Read the current page content',
    })
  }

  return { plan }
}

/**
 * Extract a full URL from text. Returns the first http(s):// match.
 * If none, returns null (caller decides what to do).
 *
 * @param {string} text
 * @returns {string | null}
 */
export function extractUrl(text) {
  if (typeof text !== 'string') return null
  const m = text.match(/https?:\/\/[^\s<>"']+/i)
  if (m) return m[0]
  const siteToken = matchSiteToken(text)
  return siteToken
}

/**
 * Match a known site token from a user message. Returns the canonical
 * URL for the first matched token, or null if no token matches.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function matchSiteToken(text) {
  if (typeof text !== 'string') return null
  const lower = text.toLowerCase()
  // Try multi-word tokens first (e.g. "stack overflow") so we don't
  // accidentally match a single word that's a substring.
  const ordered = Object.keys(SITE_TOKEN_MAP).sort((a, b) => b.length - a.length)
  for (const token of ordered) {
    // Word-boundary match for short tokens (≤2 chars like "x") to
    // avoid matching arbitrary words.
    const re = token.length <= 2
      ? new RegExp(`(?:^|\\b)${escapeRegExp(token)}(?:\\b|$)`, 'i')
      : new RegExp(`(?:^|\\b)${escapeRegExp(token)}(?:\\b|$)`, 'i')
    if (re.test(lower)) return SITE_TOKEN_MAP[token]
  }
  return null
}

/**
 * Returns true when a URL is a normal http(s) page the extension can
 * act on. Returns false for chrome://, about:, edge://, file://, etc.
 *
 * Empty / missing / unparseable URLs return false (fail safe).
 *
 * @param {string|undefined|null} url
 * @returns {boolean}
 */
export function isControllableUrl(url) {
  if (!url || typeof url !== 'string') return false
  const lower = url.trim().toLowerCase()
  for (const scheme of NON_CONTROLLABLE_SCHEMES) {
    if (lower.startsWith(scheme)) return false
  }
  // http(s) is controllable. Anything else (e.g. ftp://) is not.
  return /^https?:\/\//i.test(lower)
}

/**
 * Friendly error message returned by tools when the active page is
 * non-controllable. Surfaced in the panel instead of the raw Chrome
 * exception ("Cannot access a chrome:// URL").
 *
 * @param {string|undefined|null} [url]
 * @returns {string}
 */
export function nonControllablePageMessage(url) {
  return `This page cannot be controlled (${shortScheme(url)} or other internal page). Open a normal website first, then ask me to read or act on it.`
}

// ── Internal helpers ─────────────────────────────────────────

function buildNavigateToolCall(url, reasoning) {
  return {
    id: cryptoRandomId(),
    name: 'navigate',
    risk: 'mutate',
    input: `navigate url=${url}`,
    params: { url },
    url, // top-level for execute.dispatch() → navigate(tool) reads tool.url
    reasoning,
  }
}

/**
 * @param {string} selector
 * @param {string} text
 * @param {string} reasoning
 * @returns {ToolCall}
 */
function buildTypeToolCall(selector, text, reasoning) {
  return {
    id: cryptoRandomId(),
    name: 'type',
    risk: 'mutate',
    input: `type selector=${selector} text=${text}`,
    params: { selector, text, clear: true },
    selector,
    text,
    clear: true,
    reasoning,
  }
}

/**
 * Extract a YouTube search query from EN/PT phrases.
 * Returns null when the message is not a YouTube-search intent.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function extractYoutubeSearchQuery(text) {
  if (typeof text !== 'string') return null
  const m = text.match(YOUTUBE_SEARCH_RE)
  if (!m) return null
  // Capture groups are alternatives — first non-empty wins.
  for (let i = 1; i < m.length; i++) {
    const q = (m[i] ?? '').trim()
    if (q) return q.replace(/\s+/g, ' ').trim()
  }
  return null
}

function shortScheme(url) {
  if (!url || typeof url !== 'string') return 'internal page'
  const m = url.match(/^([a-z][a-z0-9+.-]*):/i)
  return m ? `${m[1]}://` : 'internal page'
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * crypto.randomUUID is available in service workers (Chrome MV3) and
 * Node 19+. Provide a tiny fallback for older test runners.
 */
function cryptoRandomId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch { /* fall through */ }
  // RFC4122-ish fallback (sufficient for test uniqueness, not a real UUID).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}