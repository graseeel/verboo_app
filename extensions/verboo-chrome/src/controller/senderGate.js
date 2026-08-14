/**
 * senderGate.js — pure sender validation for the service worker's
 * chrome.runtime.onMessage listener (FRENTE-B / B-2).
 *
 * ALLOWLIST discipline: message types are born PROTECTED. A content
 * script (page context) may only send the message types explicitly
 * listed in CONTENT_SCRIPT_ALLOWED_TYPES; every other type requires an
 * extension-page sender (side panel / options page). New controller
 * messages therefore reject content scripts by default until they are
 * consciously allowlisted.
 *
 * Chrome sets sender.id / sender.url itself, so a page-injected script
 * cannot spoof them: content scripts report the http(s) URL of the tab,
 * while extension pages report chrome-extension://<id>/src/panel/*.
 *
 * Pure — no chrome.*. Unit-tested in background.test.js.
 */

import { MSG } from './protocol.js'

/** Message types a content script may legitimately send. */
export const CONTENT_SCRIPT_ALLOWED_TYPES = Object.freeze(new Set([
  // The recorder collector (src/routines/recording/inject.js) runs on
  // http(s) pages and streams recorded events to the background.
  MSG.ROUTINE_RECORD_EVENT,
]))

/**
 * @param {string} runtimeId — chrome.runtime.id
 * @param {{ id?: string; url?: string } | undefined} sender
 * @returns {boolean}
 */
export function isExtensionPageSender(runtimeId, sender) {
  return sender?.id === runtimeId
    && typeof sender?.url === 'string'
    && sender.url.startsWith(`chrome-extension://${runtimeId}/`)
}

/**
 * Gate decision for a message type + sender pair.
 *
 * @param {string} runtimeId — chrome.runtime.id
 * @param {string} messageType
 * @param {{ id?: string; url?: string; tab?: unknown } | undefined} sender
 * @returns {'allowed' | { rejected: true, reason: 'not_our_extension' | 'content_script_not_allowlisted' }}
 */
export function checkMessageSender(runtimeId, messageType, sender) {
  if (sender?.id !== runtimeId) {
    return { rejected: true, reason: 'not_our_extension' }
  }
  if (CONTENT_SCRIPT_ALLOWED_TYPES.has(messageType)) return 'allowed'
  if (isExtensionPageSender(runtimeId, sender)) return 'allowed'
  return { rejected: true, reason: 'content_script_not_allowlisted' }
}
