/**
 * Chrome Permission Mode persistence.
 *
 * Modes: 'manual' (default), 'auto', 'skip'.
 * Stored in chrome.storage.local under key 'chromePermissionMode'.
 *
 * Multi-user: mode is per-extension-instance.
 */

const STORAGE_KEY = 'chromePermissionMode'

/** @typedef {'manual' | 'auto' | 'skip'} ChromePermissionMode */

/**
 * @returns {Promise<ChromePermissionMode>}
 */
export async function loadMode() {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  const mode = result[STORAGE_KEY]
  if (mode === 'manual' || mode === 'auto' || mode === 'skip') return mode
  return 'manual' // default
}

/**
 * @param {ChromePermissionMode} mode
 */
export async function saveMode(mode) {
  await chrome.storage.local.set({ [STORAGE_KEY]: mode })
}
