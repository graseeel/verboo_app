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

import { executeWithApproval } from './controller/approvedExecute.js'
import { loadMode } from './policy/modesStore.js'
import { getGrant } from './policy/siteGrantsStore.js'
import { MSG } from './controller/protocol.js'
import { planForMessage } from './planMessage.js'
import {
  loadSession,
  logout,
  startOAuthLogin,
  getAuthCapabilities,
  loadModels,
  selectModel,
  getSelectedModelId,
  resolveModelSelection,
} from './auth/auth.js'
import {
  ensureVerbooTabGroup,
  ensureAgentPresence,
  clearPresenceOnAllTabs,
} from './presence/inject.js'
import {
  runLlmAgentTurn,
  shouldOfferBrowserTools,
  summarizePartialAgentTurn,
} from './agent/loop.js'

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
      // runAgentTurn always emits COMPLETE or ERROR in finally; this catch is
      // a last-resort if the function itself rejects before that path runs.
      void runAgentTurn(
        message.turnId,
        message.userMessage,
        sender.tab?.id,
        message.modelId,
        message.conversationHistory,
      )
        .catch((err) => {
          try {
            void clearPresenceOnAllTabs()
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

    case MSG.AUTH_LOGIN: {
      startOAuthLogin()
        .then(async (session) => {
          const models = await loadModels(true)
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
          sendResponse({ ok: true, session, capabilities: getAuthCapabilities() })
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
  const controller = new AbortController()
  return executeWithApproval(
    toolCall,
    () => makeExecutionContext(undefined, undefined),
    makeApprovalUi(undefined, controller.signal),
  )
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
 * Strip heavy tool payloads (screenshots, full page text) before broadcast.
 * Large chrome.runtime messages can fail silently and leave the panel on Working…
 * @param {unknown} results
 * @returns {Array<object>}
 */
function slimToolResultsForBroadcast(results) {
  if (!Array.isArray(results)) return []
  return results.map((r) => {
    if (!r || typeof r !== 'object') return r
    const row = /** @type {Record<string, unknown>} */ (r)
    return {
      toolCallId: row.toolCallId,
      success: row.success,
      error: row.error ?? null,
      durationMs: row.durationMs ?? 0,
    }
  })
}

/**
 * @param {string} turnId
 * @param {string} userMessage
 * @param {number} [senderTabId]
 * @param {string} [requestedModelId]
 * @param {Array<object>} [conversationHistory]
 */
async function runAgentTurn(
  turnId,
  userMessage,
  senderTabId,
  requestedModelId,
  conversationHistory,
) {
  const controller = new AbortController()
  turnControllers.set(turnId, controller)
  const browserToolsRequested = shouldOfferBrowserTools(userMessage)

  // MV3 service workers can suspend mid-fetch; frozen timers then never fire the
  // router 60s abort, and the panel never gets COMPLETE/ERROR → permanent Working…
  // Periodic chrome API touch keeps the worker alive for the duration of the turn.
  const keepAliveId = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo(() => {})
    } catch {
      /* ignore */
    }
  }, 20_000)

  /** @type {boolean} */
  let terminalSent = false
  /**
   * Emit at most one COMPLETE or ERROR so the panel always leaves Working…
   * @param {object} msg
   */
  const sendTerminal = (msg) => {
    if (terminalSent) return
    terminalSent = true
    broadcast(msg)
  }

  try {
    broadcast({ type: MSG.AGENT_TURN_STARTED, turnId, userMessage })

    // Resolve the active tab up front so the planner can decide between
    // a navigate (e.g. "abra o youtube" on chrome://extensions) and a
    // read_page on the current tab.
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const activeTabUrl = activeTab?.url
    // ── LLM path: try real multi-step agent when session + model exist.
    // On any failure, fall back to the heuristic planMessage path below.
    const session = await loadSession()
    const accessToken = session?.accessToken
    const storedModelId = await getSelectedModelId()
    let models = []
    if (accessToken) {
      try {
        models = await loadModels(false)
      } catch {
        // A cached/stored selection can still run if the catalog refresh fails.
      }
    }
    const selectedModel = resolveModelSelection(models, requestedModelId, storedModelId)
    const selectedModelId = selectedModel?.id ?? (
      models.length === 0 && typeof requestedModelId === 'string' && requestedModelId
        ? requestedModelId
        : storedModelId
    )
    const modelSupportsVision = selectedModel?.supportsVision === true

    // Agent presence: purple Verboo tab group + viewport frame while we control.
    // Presence is UX chrome — not a BrowserTool — so it does not go through
    // execute()/evaluateToolPolicy. Failures (chrome:// etc.) are ignored.
    const presenceTabId = activeTab?.id ?? senderTabId
    if (browserToolsRequested && typeof presenceTabId === 'number') {
      try {
        await ensureVerbooTabGroup(presenceTabId)
        // Frame + animated cursor from the first moment of control.
        await ensureAgentPresence(presenceTabId)
      } catch {
        // Non-controllable page or missing APIs — continue the turn.
      }
    }

    if (accessToken && selectedModelId) {
      try {
        const llmResult = await runLlmAgentTurn({
          turnId,
          userMessage,
          accessToken,
          modelId: selectedModelId,
          modelSupportsVision,
          conversationHistory,
          broadcast: (msg) => broadcast(msg),
          executeTool: (tc) => executeWithApproval(
            tc,
            () => makeExecutionContext(senderTabId, turnId),
            makeApprovalUi(turnId, controller.signal),
          ),
          getActiveTabMeta: async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
            return { url: tab?.url, title: tab?.title, id: tab?.id }
          },
          signal: controller.signal,
        })
        sendTerminal({
          type: MSG.AGENT_TURN_COMPLETE,
          turnId,
          assistantMessage: llmResult.assistantMessage ?? 'Done.',
          toolResults: slimToolResultsForBroadcast(llmResult.toolResults),
        })
        return
      } catch (llmErr) {
        if (controller.signal.aborted) {
          sendTerminal({
            type: MSG.AGENT_TURN_ERROR,
            turnId,
            error: 'cancelled',
          })
          return
        }
        // Partial progress attached on some errors (defensive).
        const partial = llmErr?.partialToolResults
        if (Array.isArray(partial) && partial.length > 0) {
          sendTerminal({
            type: MSG.AGENT_TURN_COMPLETE,
            turnId,
            assistantMessage: summarizePartialAgentTurn(userMessage, partial),
            toolResults: slimToolResultsForBroadcast(partial),
          })
          return
        }
        // A failed conversational response must never fall through to the
        // heuristic browser planner and start reading the unrelated active tab.
        if (!browserToolsRequested) {
          sendTerminal({
            type: MSG.AGENT_TURN_COMPLETE,
            turnId,
            assistantMessage: summarizePartialAgentTurn(userMessage, []),
            toolResults: [],
          })
          return
        }
        // LLM failed with zero tools → fall back to heuristic planMessage below.
        broadcast({
          type: MSG.AGENT_THOUGHT,
          turnId,
          text: `LLM agent unavailable (${llmErr?.message ?? llmErr}), using local planner…`,
        })
      }
    }

    // ── Heuristic fallback path (planMessage) ─────────────────────
    // Without an available model we cannot synthesize a normal chat answer.
    // Still never reinterpret that message as a request to control the page.
    if (!browserToolsRequested) {
      sendTerminal({
        type: MSG.AGENT_TURN_COMPLETE,
        turnId,
        assistantMessage: summarizePartialAgentTurn(userMessage, []),
        toolResults: [],
      })
      return
    }

    // Prefer *current* tab URL so we don't re-search YouTube after the LLM
    // already navigated (stale activeTabUrl is from turn start).
    let planTabUrl = activeTabUrl
    try {
      const [live] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (live?.url) planTabUrl = live.url
    } catch {
      /* keep turn-start URL */
    }

    const { plan, assistantMessage } = planForMessage(userMessage, planTabUrl)

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
      sendTerminal({
        type: MSG.AGENT_TURN_COMPLETE,
        turnId,
        assistantMessage: assistantMessage ?? 'I have nothing to do for that request.',
        toolResults: [],
      })
      return
    }

    /** @type {import('./controller/protocol.js').ToolResult[]} */
    const toolResults = []

    /** @type {string | null} */
    let lastSucceededTool = null

    for (const toolCall of plan) {
      if (controller.signal.aborted) break

      // YouTube SPA: give results a beat to render before clicking the first card.
      if (
        lastSucceededTool === 'navigate' &&
        toolCall.name === 'click' &&
        /youtube|video-title/i.test(String(toolCall.selector || toolCall.params?.selector || toolCall.input || ''))
      ) {
        await new Promise((r) => setTimeout(r, 700))
      }

      const execution = await executeWithApproval(
        toolCall,
        () => makeExecutionContext(senderTabId, turnId),
        makeApprovalUi(turnId, controller.signal),
      )
      const canonicalTool = execution.toolCall ?? toolCall
      const error = execution.policy?.reason === 'hard_block'
        ? `hard_block:${execution.policy.hardBlockLabel ?? 'unknown'}`
        : execution.error
      const tr = execution.ok
        ? {
            toolCallId: canonicalTool.id,
            success: true,
            data: execution.result,
            durationMs: 0,
          }
        : {
            toolCallId: canonicalTool.id,
            success: false,
            error: error ?? 'execute_failed',
            durationMs: 0,
          }
      broadcast({ type: MSG.AGENT_TOOL_RESULT, toolResult: tr })
      toolResults.push(tr)
      lastSucceededTool = execution.ok ? canonicalTool.name : null
    }

    if (controller.signal.aborted) {
      sendTerminal({
        type: MSG.AGENT_TURN_ERROR,
        turnId,
        error: 'cancelled',
      })
      return
    }

    // Final assistant message summarising the turn.
    const finalMessage = summarize(plan, toolResults, userMessage)
    sendTerminal({
      type: MSG.AGENT_TURN_COMPLETE,
      turnId,
      assistantMessage: finalMessage,
      toolResults: slimToolResultsForBroadcast(toolResults),
    })
  } catch (err) {
    sendTerminal({
      type: MSG.AGENT_TURN_ERROR,
      turnId,
      error: err?.message ?? String(err),
    })
  } finally {
    clearInterval(keepAliveId)
    try {
      await clearPresenceOnAllTabs()
    } catch {
      /* presence cleanup is best-effort */
    }
    turnControllers.delete(turnId)
    // Never leave the panel stuck if a path forgot to send a terminal event.
    if (!terminalSent) {
      broadcast({
        type: MSG.AGENT_TURN_ERROR,
        turnId,
        error: 'Agent turn ended unexpectedly.',
      })
    }
  }
}

/**
 * @param {string} approvalId
 * @param {AbortSignal} signal
 * @param {number} [timeoutMs]
 * @returns {Promise<'once'|'always'|'deny'|'cancelled'|'timeout'>}
 */
function waitForApproval(approvalId, signal, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve('cancelled')
      return
    }
    let settled = false
    const finish = (decision) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      signal.removeEventListener('abort', onAbort)
      if (pendingApprovals.get(approvalId)?.resolve === finish) {
        pendingApprovals.delete(approvalId)
      }
      resolve(decision)
    }
    const onAbort = () => {
      finish('cancelled')
    }
    signal.addEventListener('abort', onAbort)
    const timeoutId = setTimeout(() => finish('timeout'), timeoutMs)
    const existing = pendingApprovals.get(approvalId)
    existing?.resolve('cancelled')
    pendingApprovals.set(approvalId, { resolve: finish })
  })
}

async function makeExecutionContext(fallbackTabId, turnId) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return {
    mode: await loadMode(),
    getSiteGrant: (host) => getGrant(host),
    activeTabId: tab?.id ?? fallbackTabId,
    onExecuting: (toolCall) => broadcast({
      type: MSG.AGENT_TOOL_EXECUTING,
      ...(turnId ? { turnId } : {}),
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    }),
  }
}

function makeApprovalUi(turnId, signal) {
  return {
    request: ({ toolCall, policy }) => {
      broadcast({
        type: MSG.AGENT_TOOL_REQUEST,
        ...(turnId ? { turnId } : {}),
        toolCall,
        policyDecision: policy,
      })
      return waitForApproval(toolCall.id, signal)
    },
    onApprovalClosed: ({ toolCall, decision }) => broadcast({
      type: 'agent:approval_closed',
      ...(turnId ? { turnId } : {}),
      approvalId: toolCall.id,
      decision,
    }),
    onPolicyDenied: ({ toolCall, policy }) => broadcast({
      type: MSG.AGENT_TOOL_REQUEST,
      ...(turnId ? { turnId } : {}),
      toolCall,
      policyDecision: policy,
    }),
  }
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
    void clearPresenceOnAllTabs()
  } catch {
    /* presence cleanup is best-effort */
  }
}

/**
 * @param {Array<import('./controller/protocol.js').ToolCall>} plan
 * @param {Array<import('./controller/protocol.js').ToolResult>} results
 * @param {string} [userMessage]
 */
function summarize(plan, results, userMessage = '') {
  const ok = results.filter((r) => r.success).length
  const blocked = results.filter((r) => r.error?.startsWith('hard_block:')).length
  const denied = results.filter((r) => r.error === 'denied_by_user' || r.error === 'site_denied').length
  const pt = looksLikePortuguese(userMessage)

  if (blocked > 0) {
    return pt
      ? `Parei — o Hard Block bloqueou ${blocked} ação(ões). ${ok} concluída(s).`
      : `Stopped — Hard Block denied ${blocked} action(s). ${ok} succeeded.`
  }
  if (denied > 0) {
    return pt
      ? `Parei — ${denied} ação(ões) negada(s). ${ok} concluída(s).`
      : `Stopped — ${denied} action(s) denied. ${ok} succeeded.`
  }

  const clicked = results.some(
    (r, i) => r.success && plan[i]?.name === 'click',
  )
  const ytNav = plan.find(
    (p) =>
      p?.name === 'navigate' &&
      /youtube\.com\/results/i.test(String(p?.url || p?.params?.url || '')),
  )
  const query = ytNav ? youtubeQueryFromResultsUrl(ytNav.url || ytNav.params?.url) : null

  if (ok > 0 && clicked && (ytNav || query)) {
    const q = query || '…'
    return pt
      ? `Abri o YouTube, busquei “${q}” e coloquei o primeiro resultado da lista para tocar. ` +
        `Se não for o vídeo certo, diga o nome exato ou o link que eu ajusto.`
      : `I opened YouTube, searched for “${q}”, and started the top result. ` +
        `If that’s the wrong video, tell me the exact title or a link and I’ll fix it.`
  }
  if (ok > 0 && clicked) {
    return pt
      ? `Cliquei no elemento pedido. Se o resultado não for o que você queria, descreva o próximo passo.`
      : `I clicked the target on the page. If that wasn’t right, tell me what to do next.`
  }
  if (ok > 0 && ytNav && !clicked) {
    const q = query || '…'
    return pt
      ? `Abri os resultados do YouTube para “${q}”. Diga qual vídeo tocar se quiser continuar.`
      : `Opened YouTube search results for “${q}”. Tell me which video to play if you want me to continue.`
  }
  return pt
    ? `Pronto — ${ok}/${plan.length} ação(ões) concluída(s).`
    : `Done — ${ok}/${plan.length} action(s) completed.`
}

/**
 * @param {string} [url]
 * @returns {string | null}
 */
function youtubeQueryFromResultsUrl(url) {
  if (!url || typeof url !== 'string') return null
  try {
    const u = new URL(url)
    const q = u.searchParams.get('search_query')
    return q ? decodeURIComponent(q.replace(/\+/g, ' ')).trim() : null
  } catch {
    return null
  }
}

/**
 * Lightweight PT detector for assistant copy (matches agent loop intent).
 * @param {string} text
 */
function looksLikePortuguese(text) {
  const s = String(text ?? '')
  if (/[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(s)) return true
  return /\b(abra|abre|abrir|coloque|coloca|procure|pesquis|toque|tocar|m[uú]sica|musica|quero|pode|obrigad)\w*\b/i.test(
    s,
  )
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
