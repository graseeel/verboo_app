/**
 * nativeMessaging.ts — P4 Native Messaging contracts.
 *
 * Single source of truth for:
 *   - Native Messaging host name (stable, non-personal identifier)
 *   - Allowed origins (extension ID placeholder — filled at build/install time)
 *   - Desktop → Extension tool call envelope (reuses protocol.js shapes)
 *   - Extension → Desktop result/error envelopes
 *
 * INVARIANT: The Browser Controller stays in the extension. Desktop/CLI are
 * clients. They send tool calls; the extension's `execute()` runs the policy
 * gate and dispatches. Desktop never calls `chrome.*` directly.
 *
 * Multi-user: zero personal paths, names, tokens, or machine-specific config.
 * The host name is a product identifier, not a developer identifier.
 *
 * No code here — contracts only. ANVIL implements the runtime against these.
 */

// ── Native Messaging host name ──────────────────────────────
/**
 * Stable, non-personal host identifier. Registered in:
 *   - macOS:   ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.verboo.code.browser_extension.json
 *   - Windows: %USERPROFILE%\AppData\Local\Google\Chrome\User Data\NativeMessagingHosts\com.verboo.code.browser_extension.json
 *   - Linux:   ~/.config/google-chrome/NativeMessagingHosts/com.verboo.code.browser_extension.json
 *
 * The Tauri installer writes these manifests at install time using OS-standard
 * directory resolution (dirs::config_dir / std::env). Source code MUST NOT
 * hardcode absolute paths — resolve at runtime.
 *
 * The host binary itself lives in the Tauri app bundle, referenced by the
 * manifest's `path` field (also resolved at install time, never hardcoded).
 */
export const NATIVE_MESSAGING_HOST_NAME = 'com.verboo.code.browser_extension' as const

// ── Extension ID (placeholder) ─────────────────────────────
/**
 * Chrome assigns the extension ID at install time based on the public key.
 * During development (load unpacked) the ID is derived from the local key;
 * for Store distribution it is fixed by the uploaded public key.
 *
 * Until the Store key is generated, this stays a placeholder. The Native
 * Messaging host manifest's `allowed_origins` field lists the extension ID
 * in the form `chrome-extension://<EXTENSION_ID>/`.
 *
 * ANVIL/Estaleiro: do NOT commit a real extension ID. Leave the placeholder
 * and resolve via build-time env (e.g. VERBOO_CHROME_EXTENSION_ID) or via
 * the installed manifest's `key` field. Never hardcode a developer's local ID.
 */
export const EXTENSION_ID_PLACEHOLDER = '<VERBOO_CHROME_EXTENSION_ID>' as const

/**
 * allowed_origins entry for the Native Messaging host manifest.
 * Format: `chrome-extension://<EXTENSION_ID>/`
 * The Tauri installer substitutes the placeholder with the real ID at install
 * time (read from the installed extension's manifest `key` field).
 */
export function allowedOrigin(extensionId: string): string {
  return `chrome-extension://${extensionId}/`
}

// ── Wire protocol — Desktop → Extension ────────────────────
/**
 * Envelope for messages sent from Desktop/CLI to the extension over Native
 * Messaging. The extension's background service worker demuxes by `type`
 * and routes to `controller.execute()` or the auth/policy modules.
 *
 * Reuses MSG enum values from protocol.js — no parallel vocabulary.
 *
 * Native Messaging framing: each message is prefixed with a 4-byte
 * little-endian length header (Chrome's standard NM framing). The host
 * binary (Tauri Rust) handles framing; the extension handles it via
 * chrome.runtime.connectNative / onNativeMessage.
 *
 * @typedef {Object} DesktopToExtensionMessage
 * @property {string} type - One of MSG.AGENT_TURN_START | MSG.TOOL_APPROVE | MSG.TOOL_DENY | MSG.AUTH_LOGIN | MSG.AUTH_LOGOUT | MSG.POLICY_MODE_SET | MSG.POLICY_GRANT_UPSERT | MSG.POLICY_GRANT_REMOVE
 * @property {string} turnId - UUID for the turn (required for AGENT_TURN_START)
 * @property {string} [toolCallId] - For TOOL_APPROVE / TOOL_DENY
 * @property {string} [userMessage] - For AGENT_TURN_START
 * @property {ToolCall} [toolCall] - For TOOL_APPROVE (echoed back from a prior AGENT_TOOL_REQUEST)
 * @property {string} [reason] - For TOOL_DENY (why the user denied)
 * @property {string} [mode] - For POLICY_MODE_SET ('manual'|'auto'|'skip')
 * @property {{host: string, decision: 'once'|'always'|'deny'}} [grant] - For POLICY_GRANT_UPSERT
 * @property {string} [host] - For POLICY_GRANT_REMOVE
 * @property {string} [source] - 'desktop' | 'cli' (for audit logging; never used for authz)
 */

// ── Wire protocol — Extension → Desktop ────────────────────
/**
 * Envelope for messages sent from the extension to Desktop/CLI.
 *
 * @typedef {Object} ExtensionToDesktopMessage
 * @property {string} type - One of MSG.AGENT_TURN_STARTED | MSG.AGENT_THOUGHT | MSG.AGENT_TOOL_REQUEST | MSG.AGENT_TOOL_EXECUTING | MSG.AGENT_TOOL_RESULT | MSG.AGENT_TURN_COMPLETE | MSG.AGENT_TURN_ERROR | MSG.AUTH_STATE_CHANGED | MSG.POLICY_MODE_CHANGED | MSG.POLICY_GRANT_CHANGED
 * @property {string} [turnId]
 * @property {string} [thought] - For AGENT_THOUGHT (streaming assistant text)
 * @property {ToolCall} [toolCall] - For AGENT_TOOL_REQUEST
 * @property {PolicyDecision} [policyDecision] - For AGENT_TOOL_REQUEST
 * @property {ToolResult} [toolResult] - For AGENT_TOOL_RESULT
 * @property {string} [assistantMessage] - For AGENT_TURN_COMPLETE
 * @property {ToolResult[]} [toolResults] - For AGENT_TURN_COMPLETE
 * @property {string} [error] - For AGENT_TURN_ERROR
 * @property {VerbooSession|null} [session] - For AUTH_STATE_CHANGED
 * @property {string} [mode] - For POLICY_MODE_CHANGED
 * @property {SiteGrant[]} [grants] - For POLICY_GRANT_CHANGED
 */

// ── Native Messaging host manifest (template) ──────────────
/**
 * Template for the Native Messaging host manifest JSON file that the Tauri
 * installer writes to the OS-standard NativeMessagingHosts directory.
 *
 * The installer substitutes:
 *   - {{EXTENSION_ID}} → real extension ID (from installed extension's key)
 *   - {{HOST_PATH}} → absolute path to the host binary in the Tauri bundle
 *
 * ANVIL/Estaleiro: never commit a filled-in manifest. The template lives here
 * for reference; the installer generates the real file at install time.
 *
 * @example
 * {
 *   "name": "com.verboo.code.browser_extension",
 *   "description": "Verboo Code Browser Bridge host",
 *   "path": "/Applications/Verboo Code.app/Contents/Resources/browser_bridge_host",
 *   "type": "stdio",
 *   "allowed_origins": [ "chrome-extension://<EXTENSION_ID>/" ]
 * }
 */
export interface NativeMessagingHostManifest {
  name: typeof NATIVE_MESSAGING_HOST_NAME
  description: string
  /** Absolute path to the host binary — resolved at install time, never hardcoded in source. */
  path: string
  type: 'stdio'
  /** Array of allowed_origins entries (chrome-extension://<ID>/). */
  allowed_origins: string[]
}

// ── Connection lifecycle contract ──────────────────────────
/**
 * The Desktop client opens a single persistent Native Messaging port per
 * session (chrome.runtime.connectNative). The extension's service worker
 * keeps the port alive while a turn is in flight.
 *
 * MV3 service worker idle timeout (30s default) is extended by active NM
 * ports — Chrome treats an open NM port as keepalive-worthy. ANVIL must
 * ensure the port is closed when the Desktop client disconnects, so the SW
 * can idle out normally.
 *
 * Reconnect strategy: Desktop-owned. The extension does not reconnect; if
 * the port drops, Desktop reopens it on next tool call.
 */

// ── Authorization boundary ─────────────────────────────────
/**
 * The Native Messaging host manifest's `allowed_origins` is the ONLY
 * authorization layer. Only the Verboo extension with the matching ID can
 * connect. No token, no shared secret, no API key in the NM channel.
 *
 * The extension's `verbooSession` (in chrome.storage.local) is NOT shared
 * with Desktop. Desktop has its own Verboo session (separate process,
 * separate storage, design §8). The NM channel carries tool calls and
 * results, never session tokens.
 *
 * If a tool call from Desktop requires auth (e.g. the agent client needs
 * to call the Verboo API), the extension uses ITS OWN session, not
 * Desktop's. This keeps the auth boundary clean: each process owns its
 * session; the NM channel is pure tool-call transport.
 */

// ── Forbidden patterns (AEGIS audits for these) ───────────
/**
 * - Hardcoded absolute paths in source (must resolve via dirs/std::env at runtime)
 * - Personal identifiers in the host name (com.gabriel.*, com.<dev>.*)
 * - Extension ID committed to the repo (must be placeholder or build-time env)
 * - Session tokens sent over the NM channel (only tool calls + results)
 * - Desktop calling chrome.* APIs directly (must go through execute())
 * - Bypassing evaluateToolPolicy for Desktop-originated calls
 */
