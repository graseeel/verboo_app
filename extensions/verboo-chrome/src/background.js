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
})

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

  const plan = planForMessage(userMessage)

  broadcast({
    type: MSG.AGENT_THOUGHT,
    turnId,
    text: `Planning ${plan.length} tool call(s) for: "${userMessage}"`,
  })

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
  const assistantMessage = summarize(plan, toolResults)
  broadcast({
    type: MSG.AGENT_TURN_COMPLETE,
    turnId,
    assistantMessage,
    toolResults,
  })

  turnControllers.delete(turnId)
}

/**
 * Plan tool calls from user message (P2 stub heuristic).
 * Routes "buy"/"purchase"/"checkout" to click on a buy-now selector
 * to trigger Hard Block. Routes "open/go to/navigate/visit" + URL to
 * navigate. Otherwise reads the page.
 * @param {string} userMessage
 */
function planForMessage(userMessage) {
  const lower = userMessage.toLowerCase()
  const isPurchase = /\b(buy|purchase|checkout|order|pay|payment)\b/.test(lower)
  const wantsNavigate = /\b(open|go\s+to|navigate|visit)\b/.test(lower)

  /** @type {import('./controller/protocol.js').ToolCall[]} */
  const plan = []

  if (wantsNavigate) {
    const url = extractUrl(userMessage) ?? 'https://example.com'
    plan.push({
      id: crypto.randomUUID(),
      name: 'navigate',
      risk: 'mutate',
      input: `navigate url=${url}`,
      params: { url },
      reasoning: 'Open the requested page',
    })
  }

  if (isPurchase) {
    // This will hit the `purchase` Hard Block.
    plan.push({
      id: crypto.randomUUID(),
      name: 'click',
      risk: 'mutate',
      input: 'click selector=button#buy-now text=Buy Now',
      params: { selector: 'button#buy-now' },
      reasoning: 'Click the buy button as the user requested',
    })
  } else if (plan.length === 0) {
    // Fallback: read_page so the transcript shows a tool activity card
    // without triggering prompts or blocks.
    plan.push({
      id: crypto.randomUUID(),
      name: 'read_page',
      risk: 'read',
      input: 'read_page selector=body',
      params: { selector: 'body' },
      reasoning: 'Read the current page content',
    })
  }

  return plan
}

/**
 * @param {string} text
 * @returns {string | null}
 */
function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s]+/i)
  return m ? m[0] : null
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
