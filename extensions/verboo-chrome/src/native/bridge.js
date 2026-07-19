export const NATIVE_MESSAGING_HOST_NAME = 'com.verboo.code.browser_extension'
export const BROWSER_BRIDGE_PROTOCOL_VERSION = 1

const DEFAULT_RECONNECT_DELAY_MS = 750

/**
 * @param {{
 *   chromeApi?: typeof chrome;
 *   executeWithApproval: Function;
 *   contextFactory: Function;
 *   approvalUiFactory: Function;
 *   isApprovalUiAvailable: () => boolean;
 *   reconnectDelayMs?: number;
 * }} dependencies
 */
export function createNativeBridge({
  chromeApi = chrome,
  executeWithApproval,
  contextFactory,
  approvalUiFactory,
  isApprovalUiAvailable,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
}) {
  let port = null
  let stopped = false
  let reconnectUsed = false
  let startupRegistered = false

  function connect() {
    stopped = false
    if (port) return true
    try {
      const nextPort = chromeApi.runtime.connectNative(NATIVE_MESSAGING_HOST_NAME)
      port = nextPort
      nextPort.onMessage.addListener((message) => {
        void handleMessage(nextPort, message)
      })
      nextPort.onDisconnect.addListener(() => {
        if (port !== nextPort) return
        port = null
        if (!stopped && !reconnectUsed) {
          reconnectUsed = true
          setTimeout(() => {
            if (!stopped) connect()
          }, reconnectDelayMs)
        }
      })
      return true
    } catch {
      port = null
      return false
    }
  }

  function disconnect() {
    stopped = true
    const current = port
    port = null
    try {
      current?.disconnect()
    } catch {
      // The native port may already be closed.
    }
  }

  function registerStartup() {
    if (startupRegistered) return
    startupRegistered = true
    chromeApi.runtime.onStartup.addListener(() => {
      reconnectUsed = false
      connect()
    })
  }

  function sendResponse(envelope) {
    return postTo(port, envelope)
  }

  function postTo(target, envelope) {
    if (!target || target !== port) return false
    try {
      target.postMessage(envelope)
      return true
    } catch {
      return false
    }
  }

  async function handleMessage(sourcePort, envelope) {
    const validation = validateEnvelope(envelope)
    if (!validation.ok) {
      postTo(sourcePort, errorEnvelope(validation.id, validation.code, validation.message))
      return
    }

    const { id, payload } = envelope
    const rawToolCall = {
      id,
      name: payload.name,
      params: payload.arguments,
    }
    const baseApprovalUi = approvalUiFactory()
    const approvalUi = {
      ...baseApprovalUi,
      request: async (request) => {
        if (!isApprovalUiAvailable()) {
          const error = new Error('Open the Verboo side panel in Chrome to approve this action.')
          error.code = 'approval_ui_unavailable'
          throw error
        }
        return baseApprovalUi.request(request)
      },
    }

    try {
      const result = await executeWithApproval(rawToolCall, contextFactory, approvalUi)
      if (!result?.ok) {
        const code = executionErrorCode(result?.error)
        postTo(sourcePort, errorEnvelope(id, code, executionErrorMessage(code, result?.error)))
        return
      }
      postTo(sourcePort, {
        version: BROWSER_BRIDGE_PROTOCOL_VERSION,
        id,
        kind: 'toolResponse',
        payload: result,
      })
    } catch (error) {
      const code = error?.code === 'approval_ui_unavailable'
        ? 'approval_ui_unavailable'
        : 'execution_failed'
      postTo(sourcePort, errorEnvelope(id, code, error?.message ?? String(error)))
    }
  }

  return {
    connect,
    disconnect,
    registerStartup,
    sendResponse,
  }
}

function validateEnvelope(envelope) {
  const id = typeof envelope?.id === 'string' && envelope.id ? envelope.id : 'bridge'
  if (!envelope || typeof envelope !== 'object') {
    return { ok: false, id, code: 'malformed_envelope', message: 'Expected an object envelope.' }
  }
  if (envelope.version !== BROWSER_BRIDGE_PROTOCOL_VERSION) {
    return {
      ok: false,
      id,
      code: 'protocol_version_mismatch',
      message: 'Update the Verboo extension and desktop integration to compatible versions.',
    }
  }
  if (
    typeof envelope.id !== 'string' || !envelope.id ||
    envelope.kind !== 'toolRequest' ||
    !envelope.payload || typeof envelope.payload !== 'object' ||
    typeof envelope.payload.name !== 'string' || !envelope.payload.name ||
    !envelope.payload.arguments ||
    typeof envelope.payload.arguments !== 'object' ||
    Array.isArray(envelope.payload.arguments)
  ) {
    return { ok: false, id, code: 'malformed_envelope', message: 'Invalid browser tool request.' }
  }
  return { ok: true }
}

function executionErrorCode(error) {
  switch (error) {
    case 'denied_by_user':
    case 'cancelled':
      return 'approval_rejected'
    case 'timeout':
      return 'approval_timeout'
    case 'approval_ui_unavailable':
      return 'approval_ui_unavailable'
    default:
      return 'execution_failed'
  }
}

function executionErrorMessage(code, fallback) {
  switch (code) {
    case 'approval_ui_unavailable':
      return 'Open the Verboo side panel in Chrome to approve this action.'
    case 'approval_rejected':
      return 'The browser action was not approved in Chrome.'
    case 'approval_timeout':
      return 'The Chrome approval request expired before it was approved.'
    default:
      return fallback || 'The Chrome browser tool failed.'
  }
}

function errorEnvelope(id, code, message) {
  return {
    version: BROWSER_BRIDGE_PROTOCOL_VERSION,
    id,
    kind: 'error',
    payload: { code, message },
  }
}
