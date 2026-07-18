/**
 * protocol.js — Message protocol contracts for background ↔ panel ↔ controller.
 *
 * Single source of truth for message types and shapes. ANVIL (controller) and
 * PRISM (panel) MUST import from here — no magic strings.
 *
 * All messages flow through chrome.runtime.sendMessage / onMessage.
 * The controller (service worker) is the authority; the panel is a view.
 *
 * Multi-user: zero hardcoded path/user/token.
 *
 * ── INVARIANT: execute() is the only entry point for tool execution ──
 *
 * Tool handlers (chrome.tabs, chrome.scripting, chrome.debugger, etc.) MUST
 * NEVER be called directly from agent.js, background.js, or panel.js. The
 * single chokepoint is `controller.execute(toolCall)` in controller.js.
 *
 * `execute()` enforces the policy gate (evaluateToolPolicy) before any
 * dispatch. Bypassing it means bypassing Hard Blocks, site grants, and the
 * Manual/Auto/Skip mode contract — which is a security violation.
 *
 * Forbidden patterns (AEGIS audits for these in review):
 *   - chrome.scripting.executeScript(...) called outside src/controller/tools/*
 *   - chrome.tabs.update(...) called outside src/controller/tools/navigate.js
 *   - chrome.debugger.attach(...) called outside src/controller/tools/screenshot.js
 *   - Any tool handler imported and invoked from agent.js or background.js
 *     without going through controller.execute()
 *   - Panel sending a message that directly triggers a tool handler (panel
 *     may only send MSG.AGENT_TURN_START, MSG.TOOL_APPROVE, MSG.TOOL_DENY)
 *
 * The dispatchTool() helper inside controller.js is the ONLY function allowed
 * to call tool handlers directly. It is private to the controller module and
 * must never be exported.
 */

// ── Message types ──────────────────────────────────────────

export const MSG = Object.freeze({
  // Panel → Controller
  AGENT_TURN_START: 'agent:turn_start',       // user submits a chat message
  AGENT_TURN_CANCEL: 'agent:turn_cancel',     // user cancels in-flight turn
  TOOL_APPROVE: 'tool:approve',               // user approves a needsApproval tool
  TOOL_DENY: 'tool:deny',                     // user denies a needsApproval tool
  AUTH_LOGIN: 'auth:login',                   // start OAuth flow (legacy)
  AUTH_LOGIN_API_KEY: 'auth:login_api_key',   // login with Verboo dashboard API key
  AUTH_LOGOUT: 'auth:logout',
  AUTH_REFRESH: 'auth:refresh',
  AUTH_STATE_REQUEST: 'auth:state_request',   // panel asks SW for current session
  MODELS_LIST: 'models:list',                 // panel asks SW for available models
  MODELS_SELECT: 'models:select',             // panel persists selected modelId
  POLICY_MODE_SET: 'policy:mode_set',
  POLICY_GRANT_UPSERT: 'policy:grant_upsert',
  POLICY_GRANT_REMOVE: 'policy:grant_remove',

  // Controller → Panel
  AGENT_TURN_STARTED: 'agent:turn_started',
  AGENT_THOUGHT: 'agent:thought',             // streaming assistant thought
  AGENT_TOOL_REQUEST: 'agent:tool_request',  // tool call awaiting approval
  AGENT_TOOL_EXECUTING: 'agent:tool_executing',
  AGENT_TOOL_RESULT: 'agent:tool_result',
  AGENT_TURN_COMPLETE: 'agent:turn_complete',
  AGENT_TURN_ERROR: 'agent:turn_error',
  AUTH_STATE_CHANGED: 'auth:state_changed',
  MODELS_STATE_CHANGED: 'models:state_changed',
  POLICY_MODE_CHANGED: 'policy:mode_changed',
  POLICY_GRANT_CHANGED: 'policy:grant_changed',
})

// ── Tool Call envelope ────────────────────────────────────

/**
 * Tool catalog version. Bumped when a new tool kind is added or when the
 * shape of an existing tool's params changes in a non-backward-compatible way.
 * Clients (panel, Desktop bridge, agent loop) compare this against the version
 * they were built against and refuse to start a turn if it is older than the
 * minimum supported.
 *
 * Version history:
 *   - 0.1.0 (P1): hard blocks + site grants + mode store, no tools yet
 *   - 0.2.0 (P2): MVP catalog — navigate, read_page, click, type, screenshot, tabs, tab_group
 *   - 0.3.0 (P5): full catalog — +console_reader, network_reader, console_clear,
 *                 gif_recording, session_recording, file_upload, schedule_task,
 *                 workflow_record, workflow_replay, history_read
 *
 * Adding a tool:
 *   1. Add the kind to BrowserTool in src/controller/types.ts (TS contract)
 *   2. Add the risk class to TOOL_RISK_MAP below (gate input)
 *   3. Implement handler in src/controller/tools/<name>.js
 *   4. Add dispatch case in src/controller/execute.js dispatch()
 *   5. Add unit test in src/controller/tools/<name>.test.js
 *   6. Bump CATALOG_VERSION, append a version-history line above
 *   7. Update PRIVACY.md + PERMISSIONS.md + STORE_LISTING.md if the tool
 *      requires a new permission (AEGIS audit required for elevated tools)
 *
 * Multi-user: zero hardcoded path/user/token. accountId from session
 * distinguishes users.
 */

/**
 * ToolCall — what the agent loop produces and the controller executes.
 *
 * @typedef {Object} ToolCall
 * @property {string} id                  - UUID, stable across the turn
 * @property {string} name                - Tool kind (see TOOL_RISK_MAP)
 * @property {'read'|'mutate'|'elevated'} risk - Risk class for policy gate
 * @property {string} input               - Tool name + params joined for Hard Block matching
 * @property {Record<string, unknown>} params - Tool-specific parameters (BrowserTool shape)
 * @property {string} [reasoning]         - Why the agent chose this tool (shown in panel)
 */
export const TOOL_RISK = Object.freeze({
  READ: 'read',
  MUTATE: 'mutate',
  ELEVATED: 'elevated',
})

/** Bump on every catalog change (see comment above). */
export const CATALOG_VERSION = '0.3.0'

// Risk classification per tool kind — single source of truth for the policy gate.
// 'elevated' tools ALWAYS re-prompt, even with an 'always' site grant and even in
// Auto/Skip mode (see policy/evaluateToolPolicy.js).
export const TOOL_RISK_MAP = Object.freeze({
  // ── MVP (P2) ─────────────────────────────────────────
  navigate: 'mutate',
  read_page: 'read',
  click: 'mutate',
  type: 'mutate',
  screenshot: 'read',
  tabs: 'mutate',
  tab_group: 'mutate',

  // ── P5: full catalog ────────────────────────────────
  // Read-only additions. No new permissions required.
  console_reader: 'read',       // chrome.scripting + console API override
  network_reader: 'read',       // chrome.debugger Network domain

  // Mutate additions. console_clear + session recording.
  console_clear: 'mutate',
  session_recording: 'mutate',  // recorded events for later replay
  schedule_task: 'mutate',      // chrome.alarms — REQUIRES 'alarms' permission
  workflow_record: 'mutate',    // record sequence of tool calls
  workflow_replay: 'mutate',    // replay recorded sequence

  // Elevated additions. ALWAYS re-prompt; NO always-allow override.
  file_upload: 'elevated',      // chrome.debugger DOM.setFileInputFiles — filesystem access
  history_read: 'elevated',    // chrome.history.search — REQUIRES 'history' permission
  gif_recording: 'elevated',    // MediaRecorder in panel — captures screen (PII/passwords visible)

  // Aliases (short names) — same risk as canonical long names
  console: 'read',
  network: 'read',
  upload: 'elevated',
  gif_record: 'elevated',

  // Future (post-P5, do not implement yet):
  // evaluate: 'elevated',     // Runtime.evaluate in isolated world — needs debugger permission
})

// ── Policy Decision (mirrors evaluateToolPolicy.js output) ──

/**
 * @typedef {Object} PolicyDecision
 * @property {boolean} allowed
 * @property {boolean} needsApproval
 * @property {string} reason
 * @property {string} [hardBlockLabel]
 */

// ── Tool Result ───────────────────────────────────────────

/**
 * @typedef {Object} ToolResult
 * @property {string} toolCallId           - Matches ToolCall.id
 * @property {boolean} success
 * @property {unknown} [data]              - Tool-specific result payload
 * @property {string} [error]              - Error message if !success
 * @property {number} durationMs
 */

// ── Agent Turn envelope ───────────────────────────────────

/**
 * @typedef {Object} AgentTurnStart
 * @property {string} turnId               - UUID for the whole turn
 * @property {string} userMessage          - User's chat input
 */

/**
 * @typedef {Object} AgentTurnComplete
 * @property {string} turnId
 * @property {string} assistantMessage     - Final assistant text
 * @property {ToolResult[]} toolResults    - All tool results from this turn
 */

// ── Message payload shapes (for type-checking in handlers) ──

export const MSG_SHAPES = Object.freeze({
  [MSG.AGENT_TURN_START]: { turnId: 'string', userMessage: 'string' },
  [MSG.AGENT_TURN_CANCEL]: { turnId: 'string' },
  [MSG.TOOL_APPROVE]:      { toolCallId: 'string' },
  [MSG.TOOL_DENY]:         { toolCallId: 'string', reason: 'string?' },
  [MSG.AGENT_TOOL_REQUEST]:{ toolCall: 'object', policyDecision: 'object' },
  [MSG.AGENT_TOOL_RESULT]: { toolResult: 'object' },
  [MSG.AGENT_TURN_COMPLETE]:{ turnId: 'string', assistantMessage: 'string', toolResults: 'array' },
  [MSG.AGENT_TURN_ERROR]:  { turnId: 'string', error: 'string' },
  [MSG.AUTH_STATE_CHANGED]:{ session: 'object?' },
  [MSG.MODELS_STATE_CHANGED]:{ models: 'array', selectedId: 'string?' },
  [MSG.POLICY_MODE_CHANGED]:{ mode: 'string' },
  [MSG.POLICY_GRANT_CHANGED]:{ grants: 'array' },
})

// ── Helper: build a ToolCall ──────────────────────────────

/**
 * @param {string} name - Tool kind
 * @param {Record<string, unknown>} params - Tool-specific params
 * @param {string} [reasoning]
 * @returns {ToolCall}
 */
export function makeToolCall(name, params, reasoning) {
  const id = crypto.randomUUID()
  const risk = TOOL_RISK_MAP[name] ?? 'elevated' // fail safe — unknown tools prompt
  const input = `${name} ${serializeParams(params)}`
  return { id, name, risk, input, params, reasoning }
}

/** @param {Record<string, unknown>} params */
function serializeParams(params) {
  try {
    return Object.entries(params)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ')
  } catch {
    return ''
  }
}
