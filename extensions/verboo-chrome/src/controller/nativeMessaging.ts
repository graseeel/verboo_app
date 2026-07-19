/**
 * Versioned contract reserved for the packaged Verboo in Chrome MCP bridge.
 *
 * This file is intentionally runtime-free. The current extension does not
 * request `nativeMessaging` or call `connectNative`; those paths are added only
 * when the Rust host, installer, and extension-ID configuration ship together.
 */

export const NATIVE_MESSAGING_HOST_NAME = 'com.verboo.code.browser_extension' as const
export const BROWSER_BRIDGE_PROTOCOL_VERSION = 1 as const
export const MAX_HOST_TO_CHROME_BYTES = 1024 * 1024
export const MAX_CHROME_TO_HOST_BYTES = 64 * 1024 * 1024

export type BrowserBridgeMessageKind =
  | 'hello'
  | 'toolRequest'
  | 'toolResponse'
  | 'error'

export interface BrowserBridgeEnvelope {
  version: typeof BROWSER_BRIDGE_PROTOCOL_VERSION
  id: string
  kind: BrowserBridgeMessageKind
  secret?: string
  payload: unknown
}
