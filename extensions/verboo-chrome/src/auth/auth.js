/**
 * auth.js — Verboo session + model list for the Chrome extension.
 *
 * Mirrors desktop ModelService (model_service.rs):
 *   GET https://code.verboo.ai/router/v1/models
 *   Authorization: Bearer <api-key|token>
 *
 * Session is stored in chrome.storage.local so it survives browser restart.
 * When chrome is undefined (Node unit tests), an in-memory Map is used.
 *
 * Multi-user: zero hardcoded accounts; accountId is derived from the key.
 */

export const ROUTER_URL = 'https://code.verboo.ai/router/v1/models'
export const STORAGE_KEY = 'verbooSession'
export const MODELS_CACHE_KEY = 'verbooModelsCache'
export const SELECTED_MODEL_KEY = 'verbooSelectedModelId'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * @typedef {Object} VerbooSession
 * @property {string} accountId
 * @property {string} [email]
 * @property {string} accessToken
 * @property {string} [refreshToken]
 * @property {number} [expiresAt]
 * @property {'api-key'|'oauth'} source
 */

/**
 * @typedef {Object} VerbooModel
 * @property {string} id
 * @property {string} name
 * @property {string} [displayName]
 * @property {boolean} [supportsVision]
 */

// ── chrome.storage.local with in-memory fallback (Node tests) ────

/** @type {Map<string, unknown>} */
const memoryStore = new Map()

function hasChromeStorage() {
  return typeof chrome !== 'undefined' && !!chrome?.storage?.local
}

/**
 * @param {string|string[]|Record<string, unknown>} keys
 * @returns {Promise<Record<string, unknown>>}
 */
async function storageGet(keys) {
  if (hasChromeStorage()) {
    return chrome.storage.local.get(keys)
  }
  const out = {}
  if (typeof keys === 'string') {
    if (memoryStore.has(keys)) out[keys] = memoryStore.get(keys)
  } else if (Array.isArray(keys)) {
    for (const k of keys) {
      if (memoryStore.has(k)) out[k] = memoryStore.get(k)
    }
  } else if (keys && typeof keys === 'object') {
    for (const k of Object.keys(keys)) {
      out[k] = memoryStore.has(k) ? memoryStore.get(k) : keys[k]
    }
  }
  return out
}

/**
 * @param {Record<string, unknown>} items
 */
async function storageSet(items) {
  if (hasChromeStorage()) {
    await chrome.storage.local.set(items)
    return
  }
  for (const [k, v] of Object.entries(items)) {
    memoryStore.set(k, v)
  }
}

/**
 * @param {string|string[]} keys
 */
async function storageRemove(keys) {
  if (hasChromeStorage()) {
    await chrome.storage.local.remove(keys)
    return
  }
  const list = Array.isArray(keys) ? keys : [keys]
  for (const k of list) memoryStore.delete(k)
}

// ── Public API ─────────────────────────────────────────────

/** Load session from chrome.storage.local. @returns {Promise<VerbooSession|null>} */
export async function loadSession() {
  try {
    const result = await storageGet(STORAGE_KEY)
    return /** @type {VerbooSession|null} */ (result[STORAGE_KEY] ?? null)
  } catch {
    return null
  }
}

/** Persist session. @param {VerbooSession|null} session */
export async function saveSession(session) {
  if (session) {
    await storageSet({ [STORAGE_KEY]: session })
  } else {
    await storageRemove(STORAGE_KEY)
  }
}

/** Logout — clear session, model cache, and selected model. */
export async function logout() {
  await storageRemove([STORAGE_KEY, MODELS_CACHE_KEY, SELECTED_MODEL_KEY])
}

/**
 * Signed in when accessToken is present and not expired.
 * @returns {Promise<boolean>}
 */
export async function isSignedIn() {
  const s = await loadSession()
  if (!s?.accessToken) return false
  if (s.expiresAt == null) return true
  return s.expiresAt > Date.now()
}

/**
 * Login with a Verboo dashboard API key.
 * Validates the key against the Router models endpoint.
 *
 * @param {string} apiKey
 * @returns {Promise<{ session: VerbooSession, models: VerbooModel[] }>}
 */
export async function startApiKeyLogin(apiKey) {
  const key = String(apiKey ?? '').trim()
  if (!key) throw new Error('API key is required')

  const models = await fetchModelsFromRouter(key)
  const now = Date.now()
  const accountId = `api:${simpleHash8(key)}`

  /** @type {VerbooSession} */
  const session = {
    accountId,
    accessToken: key,
    source: 'api-key',
    expiresAt: now + SESSION_TTL_MS,
  }

  await saveSession(session)
  await storageSet({
    [MODELS_CACHE_KEY]: { models, fetchedAt: now },
  })

  const preferred =
    models.find((m) => m.supportsVision) ?? models[0] ?? null
  if (preferred?.id) {
    await storageSet({ [SELECTED_MODEL_KEY]: preferred.id })
  }

  return { session, models }
}

/**
 * Load models: serve from cache if fresh (<24h) unless forceRefresh.
 * Re-fetches with the session token when needed.
 *
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<VerbooModel[]>}
 */
export async function loadModels(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await readModelsCache()
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.models
    }
  }

  const session = await loadSession()
  if (!session?.accessToken) {
    const cached = await readModelsCache()
    return cached?.models ?? []
  }

  const models = await fetchModelsFromRouter(session.accessToken)
  await storageSet({
    [MODELS_CACHE_KEY]: { models, fetchedAt: Date.now() },
  })
  return models
}

/**
 * @param {string} modelId
 */
export async function selectModel(modelId) {
  if (!modelId || typeof modelId !== 'string') {
    throw new Error('modelId is required')
  }
  await storageSet({ [SELECTED_MODEL_KEY]: modelId })
}

/** @returns {Promise<string|null>} */
export async function getSelectedModelId() {
  try {
    const result = await storageGet(SELECTED_MODEL_KEY)
    return /** @type {string|null} */ (result[SELECTED_MODEL_KEY] ?? null)
  } catch {
    return null
  }
}

/**
 * OAuth flow — not yet implemented for the extension.
 * @returns {Promise<never>}
 */
export async function startOAuthFlow() {
  throw new Error(
    'not_implemented: OAuth login is not available in the extension yet. Use startApiKeyLogin with a Verboo dashboard API key.',
  )
}

/**
 * Refresh session — only meaningful for OAuth; API-key sessions
 * re-validate by re-fetching models.
 * @returns {Promise<VerbooSession|null>}
 */
export async function refreshSession() {
  const current = await loadSession()
  if (!current?.accessToken) return null
  if (current.source === 'api-key') {
    // Re-validate key by refreshing models.
    await loadModels(true)
    return loadSession()
  }
  throw new Error('not_implemented: OAuth refresh is not available yet')
}

// ── Router fetch + normalize ─────────────────────────────────

/**
 * @param {string} token
 * @returns {Promise<VerbooModel[]>}
 */
async function fetchModelsFromRouter(token) {
  const response = await fetch(ROUTER_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  const payload = await response.json()
  const models = normalizeModels(payload)
  // Vision models first (stable otherwise).
  models.sort((a, b) => {
    const av = a.supportsVision ? 0 : 1
    const bv = b.supportsVision ? 0 : 1
    if (av !== bv) return av - bv
    return String(a.name).localeCompare(String(b.name))
  })
  return models
}

/**
 * @param {unknown} payload
 * @returns {VerbooModel[]}
 */
export function normalizeModels(payload) {
  let items = []
  if (Array.isArray(payload)) {
    items = payload
  } else if (payload && typeof payload === 'object' && Array.isArray(/** @type {any} */ (payload).data)) {
    items = /** @type {any} */ (payload).data
  }

  /** @type {VerbooModel[]} */
  const out = []
  for (const item of items) {
    const m = normalizeModel(item)
    if (m) out.push(m)
  }
  return out
}

/**
 * @param {unknown} item
 * @returns {VerbooModel|null}
 */
function normalizeModel(item) {
  if (!item || typeof item !== 'object') return null
  const obj = /** @type {Record<string, unknown>} */ (item)
  const id = typeof obj.id === 'string' ? obj.id : null
  if (!id) return null

  const displayName =
    (typeof obj.display_name === 'string' && obj.display_name) ||
    (typeof obj.displayName === 'string' && obj.displayName) ||
    (typeof obj.label === 'string' && obj.label) ||
    (typeof obj.name === 'string' && obj.name) ||
    id

  const supportsVision = detectVisionSupport(obj)

  return {
    id,
    name: displayName,
    displayName,
    supportsVision: supportsVision === true,
  }
}

/**
 * Lightweight vision detection aligned with model_service.rs heuristics.
 * @param {Record<string, unknown>} obj
 * @returns {boolean|undefined}
 */
function detectVisionSupport(obj) {
  const boolKeys = [
    'supportsVision',
    'supports_vision',
    'vision',
    'hasVision',
    'has_vision',
    'supportsImages',
    'supports_images',
  ]
  for (const key of boolKeys) {
    if (typeof obj[key] === 'boolean') return /** @type {boolean} */ (obj[key])
  }

  const caps = obj.capabilities
  if (caps && typeof caps === 'object') {
    const c = /** @type {Record<string, unknown>} */ (caps)
    for (const key of boolKeys) {
      if (typeof c[key] === 'boolean') return /** @type {boolean} */ (c[key])
    }
  }

  const modalities = collectStrings(obj, ['input_modalities', 'inputModalities', 'modalities'])
  if (modalities.some((s) => s === 'image' || s === 'vision')) return true

  const idText = [obj.id, obj.display_name, obj.displayName, obj.label, obj.name]
    .filter((v) => typeof v === 'string')
    .join(' ')
    .toLowerCase()
  const tokens = idText.split(/[^a-z0-9]+/).filter(Boolean)
  if (tokens.some((t) => t === 'vision' || t === 'vl' || t === 'omni' || t === 'multimodal')) {
    return true
  }
  return undefined
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} keys
 * @returns {string[]}
 */
function collectStrings(obj, keys) {
  /** @type {string[]} */
  const out = []
  for (const key of keys) {
    const v = obj[key]
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string') out.push(item.toLowerCase())
      }
    } else if (typeof v === 'string') {
      out.push(v.toLowerCase())
    }
  }
  return out
}

/**
 * @returns {Promise<{ models: VerbooModel[], fetchedAt: number } | null>}
 */
async function readModelsCache() {
  try {
    const result = await storageGet(MODELS_CACHE_KEY)
    const cached = result[MODELS_CACHE_KEY]
    if (
      cached &&
      typeof cached === 'object' &&
      Array.isArray(/** @type {any} */ (cached).models) &&
      typeof /** @type {any} */ (cached).fetchedAt === 'number'
    ) {
      return /** @type {{ models: VerbooModel[], fetchedAt: number }} */ (cached)
    }
    return null
  } catch {
    return null
  }
}

/**
 * First 8 hex chars of a simple FNV-1a-ish hash (stable, sync, no secrets logged).
 * @param {string} str
 * @returns {string}
 */
function simpleHash8(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8)
}
