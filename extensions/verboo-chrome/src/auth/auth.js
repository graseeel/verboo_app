/**
 * auth.js — Verboo account session shell (NOT API-key).
 *
 * P1: stub OAuth flow. P2 wires real Verboo account login popup.
 *
 * Session shape: VerbooSession { accountId, email, idToken, accessToken,
 * refreshToken, expiresAt } — no apiKey field anywhere.
 *
 * Multi-user: zero hardcoded accounts; accountId distinguishes users.
 */

const STORAGE_KEY = 'verbooSession'

/**
 * @typedef {Object} VerbooSession
 * @property {string} accountId - Verboo account identifier (NOT an API key)
 * @property {string} email - Display email
 * @property {string} idToken - OIDC ID token (P2)
 * @property {string} accessToken - OAuth access token (P2)
 * @property {string} [refreshToken] - OAuth refresh token (P2)
 * @property {number} expiresAt - Token expiry (ms since epoch)
 */

// ── Public API ─────────────────────────────────────────────

/** Load session from chrome.storage.local. @returns {Promise<VerbooSession|null>} */
export async function loadSession() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY)
    return result[STORAGE_KEY] ?? null
  } catch { return null }
}

/** Persist session. @param {VerbooSession|null} session */
export async function saveSession(session) {
  if (session) {
    await chrome.storage.local.set({ [STORAGE_KEY]: session })
  } else {
    await chrome.storage.local.remove(STORAGE_KEY)
  }
}

/** Logout — clear session. */
export async function logout() {
  await saveSession(null)
}

/** @returns {Promise<boolean>} */
export async function isSignedIn() {
  const s = await loadSession()
  return s !== null && !!s.accountId && !!s.accessToken
}

/**
 * Start the Verboo OAuth flow.
 *
 * P1 STUB: simulates by prompting for an email and synthesizing a session.
 * P2 will open a real popup to the Verboo account login endpoint and exchange
 * the resulting authorization code for tokens.
 *
 * @returns {Promise<VerbooSession|null>}
 */
export async function startOAuthFlow() {
  // P1 stub — replace with chrome.windows.create popup in P2.
  const email = window.prompt('Verboo account email (stub — OAuth lands in P2):')
  if (!email || !email.includes('@')) return null

  const now = Date.now()
  /** @type {VerbooSession} */
  const session = {
    accountId: `acct_${crypto.randomUUID()}`,
    email,
    idToken: `stub-id-${crypto.randomUUID()}`,
    accessToken: `stub-access-${crypto.randomUUID()}`,
    refreshToken: `stub-refresh-${crypto.randomUUID()}`,
    expiresAt: now + 60 * 60 * 1000, // 1 hour
  }
  await saveSession(session)
  return session
}

/**
 * Refresh the session using the stored refresh token.
 * P1 stub: re-synthesizes. P2 will call the Verboo token endpoint.
 * @returns {Promise<VerbooSession|null>}
 */
export async function refreshSession() {
  const current = await loadSession()
  if (!current?.refreshToken) return null
  const now = Date.now()
  const refreshed = {
    ...current,
    accessToken: `stub-access-${crypto.randomUUID()}`,
    idToken: `stub-id-${crypto.randomUUID()}`,
    expiresAt: now + 60 * 60 * 1000,
  }
  await saveSession(refreshed)
  return refreshed
}
