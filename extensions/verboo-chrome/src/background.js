/**
 * background.js — Verboo Chrome Extension service worker.
 *
 * Responsibilities:
 * - P1: Open side panel on toolbar icon click
 * - P2: Message handler for Browser Tool calls + agent turn loop.
 *       Every tool call passes through execute() → evaluateToolPolicy
 *       before any chrome.* API is touched.
 *
 * P3+: real agent client, Native Messaging host
 *
 * Multi-user: zero hardcoded accounts.
 */

import { execute } from './controller/execute.js'
import { loadMode } from './policy/modesStore.js'
import { getGrant } from './policy/siteGrantsStore.js'
import { MSG } from './controller/protocol.js'
import { planForMessage } from './planMessage.js'
import {
  loadSession,
  logout,
  startApiKeyLogin,
  loadModels,
  selectModel,
  getSelectedModelId,
} from './auth/auth.js'
import {
  ensureVerbooTabGroup,
  showPresenceFrame,
  clearPresenceBestEffort,
} from './presence/inject.js'
import { runLlmAgentTurn } from './agent/loop.js'

// ── Native Messaging host name ──────────────────────────────────
// Matches the manifest at native-messaging/com.verboo.code.browser_extension.json.template
// and the install script scripts/install-chrome-native-host.sh.
const NATIVE_HOST_NAME = 'com.verboo.code.browser_extension'

// ── Open side panel on toolbar click ──────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.id) {
    await chrome.sidePanel.open({ tabId: tab.id })
  }
})

// ── Extension install / update ────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[Verboo] Extension installed. Opening side panel on next toolbar click.')
  }
  // Probe the Desktop bridge on install/update so the panel shows the
  // correct connection state without waiting for the first user action.
  probeDesktopBridge()
})

// ── Desktop bridge (Native Messaging) ────────────────────────────
//
// The extension opens a persistent chrome.runtime.connectNative port to
// the Verboo Code Desktop (Tauri) process. The Desktop side spawns the
// native host binary (host.mjs) which relays browserTool messages to the
// Tauri chrome_bridge service. Until the Desktop bridge ships, the port
// will disconnect immediately — the extension degrades to the local
// heuristic agent loop and broadcasts desktop:status=disconnected.
//
// Reconnect strategy: Desktop-owned. The extension does NOT auto-reconnect;
// if the port drops, the next user action re-probes. This matches the
// PROTOCOL.md invariant "Reconnect strategy: Desktop-owned".

/** @type {chrome.runtime.Port | null} */
let desktopPort = null
/** @type {'connected' | 'disconnected' | 'unknown'} */
let desktopState = 'unknown'

/**
 * Probe the Desktop bridge by opening a connectNative port and sending a
 * ping. If the host is not installed or Desktop is not running, Chrome
 * fires onDisconnect almost immediately — we treat that as disconnected.
 */
function probeDesktopBridge() {
  try {
    desktopPort = chrome.runtime.connectNative(NATIVE_HOST_NAME)
    desktopState = 'unknown'
    broadcast({ type: 'desktop:status', state: 'unknown' })

    desktopPort.onMessage.addListener((msg) => {
      if (msg?.type === 'pong') {
        desktopState = 'connected'
        broadcast({ type: 'desktop:status', state: 'connected' })
      } else if (msg?.type === 'desktopStatus') {
        desktopState = msg.connected ? 'connected' : 'disconnected'
        broadcast({ type: 'desktop:status', state: desktopState, reason: msg.reason })
      } else if (msg?.type === 'browserTool') {
        // Desktop-originated tool call — route through execute() so the
        // policy gate still applies. Result is sent back over the port.
        handleBrowserTool(msg.tool)
          .then((result) => {
            try { desktopPort?.postMessage({ type: 'browserTool', result }) } catch { /* port closed */ }
          })
          .catch((err) => {
            try {
              desktopPort?.postMessage({
                type: 'browserTool',
                result: {
                  ok: false,
                  error: err?.message ?? String(err),
                  policy: { allowed: false, needsApproval: false, reason: 'handler_exception' },
                },
              })
            } catch { /* port closed */ }
          })
      }
    })

    desktopPort.onDisconnect.addListener(() => {
      desktopPort = null
      if (desktopState !== 'disconnected') {
        desktopState = 'disconnected'
        broadcast({ type: 'desktop:status', state: 'disconnected' })
      }
    })

    // Send a ping to confirm the host is alive.
    try {
      desktopPort.postMessage({ type: 'ping' })
    } catch {
      // postMessage can throw if the port is already disconnected.
      // onDisconnect will fire and update state.
    }
  } catch (err) {
    desktopPort = null
    desktopState = 'disconnected'
    broadcast({ type: 'desktop:status', state: 'disconnected', reason: 'connect_failed' })
  }
}

/**
 * @returns {'connected' | 'disconnected' | 'unknown'}
 */
function getDesktopState() {
  return desktopState
}

// ── Pending approvals (toolCallId → resolver) ────────────────────
/** @type {Map<string, { resolve: (grant: 'once'|'always'|'deny'|'cancelled') => void }>} */
const pendingApprovals = new Map()

// ── Message router ────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false

  switch (message.type) {
    case MSG.AGENT_TURN_START: {
      void runAgentTurn(message.turnId, message.userMessage, sender.tab?.id)
        .catch((err) => {
          try {
            void clearPresenceBestEffort(sender.tab?.id)
          } catch {
            /* presence cleanup is best-effort */
          }
          broadcast({
            type: MSG.AGENT_TURN_ERROR,
            turnId: message.turnId,
            error: err?.message ?? String(err),
          })
        })
      sendResponse({ ok: true })
      return false
    }

    case MSG.AGENT_TURN_CANCEL: {
      cancelTurn(message.turnId)
      sendResponse({ ok: true })
      return false
    }

    case MSG.TOOL_APPROVE: {
      const pending = pendingApprovals.get(message.toolCallId)
      if (pending) {
        // 'always' upgrade is decided by the panel via POLICY_GRANT_UPSERT
        // before sending TOOL_APPROVE; here we just resolve with 'once'.
        pending.resolve('once')
        pendingApprovals.delete(message.toolCallId)
      }
      sendResponse({ ok: true })
      return false
    }

    case MSG.TOOL_DENY: {
      const pending = pendingApprovals.get(message.toolCallId)
      if (pending) {
        pending.resolve('deny')
        pendingApprovals.delete(message.toolCallId)
      }
      sendResponse({ ok: true })
      return false
    }

    case 'browserTool': {
      handleBrowserTool(message.tool)
        .then(sendResponse)
        .catch((err) => {
          sendResponse({
            ok: false,
            error: err?.message ?? String(err),
            policy: { allowed: false, needsApproval: false, reason: 'handler_exception' },
          })
        })
      return true
    }

    case 'desktop:probe': {
      // Panel asks the background to re-probe the Desktop bridge.
      probeDesktopBridge()
      sendResponse({ ok: true, state: getDesktopState() })
      return false
    }

    case 'desktop:status': {
      // Panel asks for the current Desktop bridge state.
      sendResponse({ ok: true, state: getDesktopState() })
      return false
    }

    case MSG.AUTH_LOGIN_API_KEY: {
      const apiKey = message.apiKey
      startApiKeyLogin(apiKey)
        .then(async ({ session, models }) => {
          const selectedId = await getSelectedModelId()
          broadcast({ type: MSG.AUTH_STATE_CHANGED, session })
          broadcast({
            type: MSG.MODELS_STATE_CHANGED,
            models,
            selectedId: selectedId ?? undefined,
          })
          sendResponse({ ok: true, session, models, selectedId })
        })
        .catch((err) => {
          sendResponse({ ok: false, error: err?.message ?? String(err) })
        })
      return true // async sendResponse
    }

    case MSG.AUTH_LOGOUT: {
      logout()
        .then(async () => {
          broadcast({ type: MSG.AUTH_STATE_CHANGED, session: null })
          broadcast({ type: MSG.MODELS_STATE_CHANGED, models: [], selectedId: undefined })
          sendResponse({ ok: true })
        })
        .catch((err) => {
          sendResponse({ ok: false, error: err?.message ?? String(err) })
        })
      return true
    }

    case MSG.AUTH_STATE_REQUEST: {
      loadSession()
        .then(async (session) => {
          broadcast({ type: MSG.AUTH_STATE_CHANGED, session })
          sendResponse({ ok: true, session })
        })
        .catch((err) => {
          sendResponse({ ok: false, error: err?.message ?? String(err) })
        })
      return true
    }

    case MSG.MODELS_LIST: {
      const forceRefresh = message.forceRefresh === true
      loadModels(forceRefresh)
        .then(async (models) => {
          const selectedId = await getSelectedModelId()
          broadcast({
            type: MSG.MODELS_STATE_CHANGED,
            models,
            selectedId: selectedId ?? undefined,
          })
          sendResponse({ ok: true, models, selectedId })
        })
        .catch((err) => {
          sendResponse({ ok: false, error: err?.message ?? String(err) })
        })
      return true
    }

    case MSG.MODELS_SELECT: {
      const modelId = message.modelId
      selectModel(modelId)
        .then(async () => {
          const models = await loadModels(false)
          const selectedId = await getSelectedModelId()
          broadcast({
            type: MSG.MODELS_STATE_CHANGED,
            models,
            selectedId: selectedId ?? undefined,
          })
          sendResponse({ ok: true, selectedId })
        })
        .catch((err) => {
          sendResponse({ ok: false, error: err?.message ?? String(err) })
        })
      return true
    }

    default:
      return false
  }
})

/**
 * @param {import('./controller/execute.js').ToolCall} toolCall
 * @returns {Promise<import('./controller/execute.js').ExecutionResult>}
 */
async function handleBrowserTool(toolCall) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const mode = await loadMode()
  const ctx = {
    mode,
    getSiteGrant: (host) => getGrant(host),
    activeTabId: tab?.id,
  }
  return execute(toolCall, ctx)
}

// ── Agent loop (P2 stub) ──────────────────────────────────────────
//
// Stub that emits a plausible sequence of events for a chat turn. P3
// replaces the plan generation with a real LLM call; P2 only needs to
// prove the panel <-> background <-> controller wiring.
//
// Flow per turn:
//   1. AGENT_TURN_STARTED
//   2. AGENT_THOUGHT (planning)
//   3. for each planned tool:
//        - run policy gate via execute()
//        - if hard_block / site_denied → AGENT_TOOL_REQUEST (with
//          policyDecision) + AGENT_TOOL_RESULT (error)
//        - if needsApproval → AGENT_TOOL_REQUEST → wait for
//          TOOL_APPROVE/DENY → if 'always' upgrade grant →
//          AGENT_TOOL_EXECUTING → AGENT_TOOL_RESULT
//        - if allowed → AGENT_TOOL_EXECUTING → AGENT_TOOL_RESULT
//   4. AGENT_TURN_COMPLETE (assistant summary)

/** @type {Map<string, AbortController>} */
const turnControllers = new Map()

/**
 * @param {string} turnId
 * @param {string} userMessage
 * @param {number} [senderTabId]
 */
async function runAgentTurn(turnId, userMessage, senderTabId) {
  const controller = new AbortController()
  turnControllers.set(turnId, controller)

  broadcast({ type: MSG.AGENT_TURN_STARTED, turnId, userMessage })

  // Resolve the active tab up front so the planner can decide between
  // a navigate (e.g. "abra o youtube" on chrome://extensions) and a
  // read_page on the current tab.
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const activeTabUrl = activeTab?.url
  const selectedModelId = await getSelectedModelId()

  // ── LLM path: try real multi-step agent when session + model exist.
  // On any failure, fall back to the heuristic planMessage path below.
  const session = await loadSession()
  const apiKey = session?.accessToken

  // Agent presence: purple Verboo tab group + viewport frame while we control.
  // Presence is UX chrome — not a BrowserTool — so it does not go through
  // execute()/evaluateToolPolicy. Failures (chrome:// etc.) are ignored.
  const presenceTabId = activeTab?.id ?? senderTabId
  if (typeof presenceTabId === 'number') {
    try {
      await ensureVerbooTabGroup(presenceTabId)
      await showPresenceFrame(presenceTabId)
    } catch {
      // Non-controllable page or missing APIs — continue the turn.
    }
  }

  if (apiKey && selectedModelId) {
    try {
      const llmResult = await runLlmAgentTurn({
        turnId,
        userMessage,
        apiKey,
        modelId: selectedModelId,
        broadcast: (msg) => broadcast(msg),
        executeTool: async (tc) => {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
          const mode = await loadMode()
          const ctx = {
            mode,
            getSiteGrant: (host) => getGrant(host),
            activeTabId: tab?.id ?? senderTabId,
          }
          return execute(tc, ctx)
        },
        getActiveTabMeta: async () => {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
          return { url: tab?.url, title: tab?.title, id: tab?.id }
        },
        signal: controller.signal,
      })
      broadcast({
        type: MSG.AGENT_TURN_COMPLETE,
        turnId,
        assistantMessage: llmResult.assistantMessage,
        toolResults: llmResult.toolResults,
      })
      try {
        await clearPresenceBestEffort(presenceTabId)
      } catch {
        /* presence cleanup is best-effort */
      }
      turnControllers.delete(turnId)
      return
    } catch (llmErr) {
      // LLM failed → fall back to heuristic planMessage below.
      broadcast({
        type: MSG.AGENT_THOUGHT,
        turnId,
        text: `LLM agent unavailable (${llmErr?.message ?? llmErr}), using local planner…`,
      })
    }
  }

  // ── Heuristic fallback path (planMessage) ─────────────────────

  const { plan, assistantMessage } = planForMessage(userMessage, activeTabUrl)

  broadcast({
    type: MSG.AGENT_THOUGHT,
    turnId,
    text:
      plan.length > 0
        ? `Planning ${plan.length} tool call(s) for: "${userMessage}"`
        : `No tool action — replying directly for: "${userMessage}"`,
    modelId: selectedModelId ?? undefined,
  })

  // Empty plan + assistantMessage → reply directly without executing
  // anything (e.g. user is on chrome:// and asked a question with no
  // navigate intent, or asked us to navigate to something unrecognised).
  if (plan.length === 0) {
    broadcast({
      type: MSG.AGENT_TURN_COMPLETE,
      turnId,
      assistantMessage: assistantMessage ?? 'I have nothing to do for that request.',
      toolResults: [],
    })
    try {
      await clearPresenceBestEffort(presenceTabId)
    } catch {
      /* presence cleanup is best-effort */
    }
    turnControllers.delete(turnId)
    return
  }

  /** @type {import('./controller/protocol.js').ToolResult[]} */
  const toolResults = []

  for (const toolCall of plan) {
    if (controller.signal.aborted) break

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const mode = await loadMode()
    const ctx = {
      mode,
      getSiteGrant: (host) => getGrant(host),
      activeTabId: tab?.id ?? senderTabId,
    }

    // Single chokepoint: execute() runs evaluateToolPolicy first, then
    // dispatches to the real tool handler in src/controller/tools/*.js.
    // We never call a second dispatcher — execute() is the only path to
    // chrome.* APIs.
    const policyCheck = await execute(toolCall, ctx)
    const policy = policyCheck.policy

    // Hard Block denial — surface without prompting.
    if (!policyCheck.ok && policy?.reason === 'hard_block') {
      broadcast({
        type: MSG.AGENT_TOOL_REQUEST,
        toolCall,
        policyDecision: policy,
      })
      const tr = {
        toolCallId: toolCall.id,
        success: false,
        error: `hard_block:${policy.hardBlockLabel ?? 'unknown'}`,
        durationMs: 0,
      }
      broadcast({ type: MSG.AGENT_TOOL_RESULT, toolResult: tr })
      toolResults.push(tr)
      continue
    }

    // Site denied — surface as denial.
    if (!policyCheck.ok && policy?.reason === 'site_denied') {
      broadcast({
        type: MSG.AGENT_TOOL_REQUEST,
        toolCall,
        policyDecision: policy,
      })
      const tr = {
        toolCallId: toolCall.id,
        success: false,
        error: 'site_denied',
        durationMs: 0,
      }
      broadcast({ type: MSG.AGENT_TOOL_RESULT, toolResult: tr })
      toolResults.push(tr)
      continue
    }

    // Needs approval — prompt the user via the panel, then re-execute
    // with fresh grants (the panel upserts an 'always' grant before
    // sending TOOL_APPROVE, so the second execute() dispatches without
    // prompting).
    if (policy?.needsApproval) {
      broadcast({
        type: MSG.AGENT_TOOL_REQUEST,
        toolCall,
        policyDecision: policy,
      })

      const decision = await waitForApproval(toolCall.id, controller.signal)

      broadcast({
        type: 'agent:approval_closed',
        approvalId: toolCall.id,
        decision,
      })

      if (decision === 'deny' || decision === 'cancelled') {
        const tr = {
          toolCallId: toolCall.id,
          success: false,
          error: decision === 'deny' ? 'denied_by_user' : 'cancelled',
          durationMs: 0,
        }
        broadcast({ type: MSG.AGENT_TOOL_RESULT, toolResult: tr })
        toolResults.push(tr)
        continue
      }

      // Re-resolve grants and re-execute. The panel may have upserted
      // an 'always' grant; we re-read it so the second execute() sees
      // the updated state and dispatches without prompting.
      const ctx2 = {
        ...ctx,
        // Force re-read by passing a fresh closure (getGrant reads
        // chrome.storage.local each call, so this is already live).
      }
      const recheck = await execute(toolCall, ctx2)
      broadcast({
        type: MSG.AGENT_TOOL_EXECUTING,
        turnId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      })
      const tr = recheck.ok
        ? {
            toolCallId: toolCall.id,
            success: true,
            data: recheck.result,
            durationMs: 0,
          }
        : {
            toolCallId: toolCall.id,
            success: false,
            error: recheck.error ?? 'execute_failed',
            durationMs: 0,
          }
      broadcast({ type: MSG.AGENT_TOOL_RESULT, toolResult: tr })
      toolResults.push(tr)
      continue
    }

    // Allowed on first execute — use its result. No second dispatch.
    broadcast({
      type: MSG.AGENT_TOOL_EXECUTING,
      turnId,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    })
    const tr = policyCheck.ok
      ? {
          toolCallId: toolCall.id,
          success: true,
          data: policyCheck.result,
          durationMs: 0,
        }
      : {
          toolCallId: toolCall.id,
          success: false,
          error: policyCheck.error ?? 'execute_failed',
          durationMs: 0,
        }
    broadcast({ type: MSG.AGENT_TOOL_RESULT, toolResult: tr })
    toolResults.push(tr)
  }

  // Final assistant message summarising the turn.
  const finalMessage = summarize(plan, toolResults)
  broadcast({
    type: MSG.AGENT_TURN_COMPLETE,
    turnId,
    assistantMessage: finalMessage,
    toolResults,
  })
  try {
    await clearPresenceBestEffort(presenceTabId)
  } catch {
    /* presence cleanup is best-effort */
  }

  turnControllers.delete(turnId)
}

/**
 * @param {string} approvalId
 * @param {AbortSignal} signal
 * @returns {Promise<'once'|'always'|'deny'|'cancelled'>}
 */
function waitForApproval(approvalId, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve('cancelled')
      return
    }
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      resolve('cancelled')
    }
    signal.addEventListener('abort', onAbort)
    pendingApprovals.set(approvalId, { resolve: (d) => { cleanup(); resolve(d) } })
  })
}

/**
 * @param {string} turnId
 */
function cancelTurn(turnId) {
  const c = turnControllers.get(turnId)
  if (c) c.abort()
  // Resolve any pending approvals as cancelled.
  for (const [id, p] of pendingApprovals.entries()) {
    p.resolve('cancelled')
    pendingApprovals.delete(id)
  }
  turnControllers.delete(turnId)
  try {
    void clearPresenceBestEffort()
  } catch {
    /* presence cleanup is best-effort */
  }
}

/**
 * @param {Array<import('./controller/protocol.js').ToolCall>} plan
 * @param {Array<import('./controller/protocol.js').ToolResult>} results
 */
function summarize(plan, results) {
  const ok = results.filter((r) => r.success).length
  const blocked = results.filter((r) => r.error?.startsWith('hard_block:')).length
  const denied = results.filter((r) => r.error === 'denied_by_user' || r.error === 'site_denied').length
  if (blocked > 0) {
    return `Stopped — Hard Block denied ${blocked} action(s). ${ok} succeeded.`
  }
  if (denied > 0) {
    return `Stopped — ${denied} action(s) denied. ${ok} succeeded.`
  }
  return `Done — ${ok}/${plan.length} action(s) completed.`
}

/**
 * Broadcast a message to all extension contexts (side panel, popup, etc.).
 * @param {object} message
 */
function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Listener may be absent (panel closed); ignore.
  })
}
