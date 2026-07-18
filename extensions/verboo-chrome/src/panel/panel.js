/**
 * panel.js — Verboo Chrome Extension side panel controller.
 *
 * Responsibilities:
 * - Apply i18n strings to the DOM
 * - Render auth status (API key login via MSG.AUTH_LOGIN_API_KEY)
 * - Persist Chrome Permission Mode (manual/auto/skip) via the inline chip
 * - Chat: send user message → AGENT_TURN_START; render agent events
 *   (thought, tool_request, tool_executing, tool_result, turn_complete,
 *   turn_error) as transcript cards
 * - Tool approval prompts: once/always/deny for needsApproval tools
 * - Open the settings page (chrome.runtime.openOptionsPage) from the gear
 * - Surface the desktop connection status ONLY when connected (no
 *   unknown/disconnected noise in the panel chrome)
 *
 * Site Grants live in options.html, not here.
 *
 * Multi-user: zero hardcoded accounts, paths, or tokens.
 */

import { loadMode, saveMode } from '../policy/modesStore.js'
import { loadSession } from '../auth/auth.js'
import { MSG } from '../controller/protocol.js'

// ── i18n ────────────────────────────────────────────────────────
import EN_US from '../i18n/en-US.js'
import PT_BR from '../i18n/pt-BR.js'

const LOCALE_MAP = {
  'en': EN_US,
  'en-US': EN_US,
  'pt': PT_BR,
  'pt-BR': PT_BR,
}

function pickLocaleBundle() {
  const ui = (chrome.i18n?.getUILanguage?.() ?? 'en') || 'en'
  const base = ui.split('-')[0]
  return LOCALE_MAP[ui] ?? LOCALE_MAP[base] ?? EN_US
}

function t(key) {
  const bundle = pickLocaleBundle()
  return bundle[key]?.message ?? EN_US[key]?.message ?? key
}

function applyI18n(root) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n')
    el.textContent = t(key)
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    const key = el.getAttribute('data-i18n-placeholder')
    el.setAttribute('placeholder', t(key))
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const key = el.getAttribute('data-i18n-title')
    el.setAttribute('title', t(key))
  }
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) {
    const key = el.getAttribute('data-i18n-aria-label')
    el.setAttribute('aria-label', t(key))
  }
}

// ── Auth (login-first gate) ───────────────────────────────────────

/**
 * Session is active when accessToken is present and not expired.
 * API-key sessions have no email — accessToken is the source of truth.
 * @param {import('../auth/auth.js').VerbooSession | null | undefined} session
 */
function isSessionActive(session) {
  if (!session?.accessToken) return false
  if (session.expiresAt != null && session.expiresAt <= Date.now()) return false
  return true
}

/**
 * @param {import('../auth/auth.js').VerbooSession | null | undefined} session
 * @returns {string}
 */
function sessionDisplayLabel(session) {
  if (!session) return ''
  if (session.email) return session.email
  if (session.accountId) return session.accountId
  return t('auth_apiKeyLabel')
}

/**
 * Toggle login gate vs workspace. Signed-out shows only the login card.
 * Signed-in unlocks the chat workspace.
 * @param {import('../auth/auth.js').VerbooSession | null | undefined} session
 */
function renderAuth(session) {
  const app = document.getElementById('app')
  const workspace = document.getElementById('workspace')
  const signedIn = isSessionActive(session)

  app.dataset.auth = signedIn ? 'signed-in' : 'signed-out'
  if (workspace) workspace.hidden = !signedIn

  const userEl = document.getElementById('topbar-user')
  if (userEl) {
    const label = sessionDisplayLabel(session)
    userEl.textContent = signedIn ? `${t('auth_signedInAs')} ${label}` : ''
    userEl.title = signedIn ? label : ''
  }

  const logoutBtn = document.getElementById('auth-action')
  if (logoutBtn) {
    logoutBtn.dataset.action = 'logout'
    logoutBtn.textContent = t('auth_logout')
  }

  // Empty chat greeting (CSS :empty::before pulls attr(data-empty))
  const messages = document.getElementById('chat-messages')
  if (messages) messages.dataset.empty = t('chat_greeting')
}

function showLoginError(message) {
  const err = document.getElementById('login-error')
  if (!err) return
  if (message) {
    err.hidden = false
    err.textContent = message
  } else {
    err.hidden = true
    err.textContent = ''
  }
}

/**
 * @param {boolean} loading
 */
function setLoginLoading(loading) {
  const btn = document.getElementById('login-submit')
  if (!btn) return
  btn.disabled = loading
  btn.classList.toggle('is-loading', loading)
  btn.setAttribute('aria-busy', loading ? 'true' : 'false')
  const label = btn.querySelector('.btn-label')
  if (label) {
    label.textContent = loading ? t('auth_loginLoading') : t('auth_login')
  }
}

/**
 * Promise wrapper around chrome.runtime.sendMessage.
 * @param {Record<string, unknown>} message
 * @returns {Promise<any>}
 */
function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message })
          return
        }
        resolve(response ?? { ok: false, error: 'no response' })
      })
    } catch (err) {
      resolve({ ok: false, error: err?.message ?? String(err) })
    }
  })
}

// ── Models select ────────────────────────────────────────────────

/**
 * @param {Array<{ id: string, name?: string, displayName?: string, supportsVision?: boolean }>} models
 * @param {string | null | undefined} selectedId
 */
function populateModelSelect(models, selectedId) {
  const select = document.getElementById('model-select')
  if (!select) return

  select.innerHTML = ''
  const list = Array.isArray(models) ? models : []
  if (list.length === 0) {
    select.disabled = true
    return
  }

  for (const model of list) {
    if (!model?.id) continue
    const opt = document.createElement('option')
    opt.value = model.id
    const name = model.displayName || model.name || model.id
    opt.textContent = model.supportsVision ? `${name} 👁` : name
    select.appendChild(opt)
  }

  if (selectedId && list.some((m) => m.id === selectedId)) {
    select.value = selectedId
  }
  select.disabled = select.options.length === 0
}

function clearModelSelect() {
  const select = document.getElementById('model-select')
  if (!select) return
  select.innerHTML = ''
  select.disabled = true
}

function initModelSelect() {
  const select = document.getElementById('model-select')
  if (!select) return
  select.addEventListener('change', () => {
    const modelId = select.value
    if (!modelId) return
    void sendMessage({ type: MSG.MODELS_SELECT, modelId })
  })
}

async function handleLoginSubmit(event) {
  event.preventDefault()
  showLoginError('')

  const input = document.getElementById('login-api-key')
  const apiKey = (input?.value ?? '').trim()
  if (!apiKey) {
    showLoginError(t('auth_apiKeyRequired'))
    input?.focus()
    return
  }

  setLoginLoading(true)
  try {
    const response = await sendMessage({
      type: MSG.AUTH_LOGIN_API_KEY,
      apiKey,
    })
    if (!response?.ok) {
      showLoginError(response?.error || t('auth_loginFailed'))
      return
    }
    renderAuth(response.session)
    populateModelSelect(response.models ?? [], response.selectedId)
    if (input) input.value = ''
  } catch (err) {
    showLoginError(err?.message ?? t('auth_loginFailed'))
  } finally {
    setLoginLoading(false)
  }
}

async function handleLogout() {
  showLoginError('')
  const response = await sendMessage({ type: MSG.AUTH_LOGOUT })
  if (!response?.ok && response?.error) {
    console.warn('[Verboo panel] logout failed', response.error)
  }
  renderAuth(null)
  clearModelSelect()
}

function initApiKeyToggle() {
  const toggle = document.getElementById('login-key-toggle')
  const input = document.getElementById('login-api-key')
  if (!toggle || !input) return
  toggle.addEventListener('click', () => {
    const show = input.type === 'password'
    input.type = show ? 'text' : 'password'
    toggle.setAttribute('aria-pressed', show ? 'true' : 'false')
  })
}

/**
 * Ask the service worker for current auth + models on panel open.
 */
async function hydrateAuthFromBackground() {
  const authRes = await sendMessage({ type: MSG.AUTH_STATE_REQUEST })
  if (authRes?.ok && isSessionActive(authRes.session)) {
    renderAuth(authRes.session)
    const modelsRes = await sendMessage({ type: MSG.MODELS_LIST })
    if (modelsRes?.ok) {
      populateModelSelect(modelsRes.models ?? [], modelsRes.selectedId)
    }
    return
  }
  // Fallback: local storage (tests / offline SW race)
  const local = await loadSession()
  if (isSessionActive(local)) {
    renderAuth(local)
    const modelsRes = await sendMessage({ type: MSG.MODELS_LIST })
    if (modelsRes?.ok) {
      populateModelSelect(modelsRes.models ?? [], modelsRes.selectedId)
    }
  } else {
    renderAuth(null)
    clearModelSelect()
  }
}

// ── Mode selector (inline chip next to composer) ────────────────

async function initModes() {
  const mode = await loadMode()
  const radio = document.querySelector(`input[name="mode"][value="${mode}"]`)
  if (radio) radio.checked = true

  for (const input of document.querySelectorAll('input[name="mode"]')) {
    input.addEventListener('change', async (e) => {
      const value = /** @type {HTMLInputElement} */ (e.target).value
      await saveMode(/** @type {any} */ (value))
    })
  }
}

// ── Chat transcript ──────────────────────────────────────────────
//
// Cards rendered into #chat-messages:
//   - user bubble
//   - assistant bubble (turn_complete)
//   - thought bubble (muted)
//   - tool_request card (with risk badge + Approve/Deny buttons when
//     needsApproval; or hard_block/site_denied denial card)
//   - tool_executing state (spinner replaces buttons)
//   - tool_result chip (success=green, error=red)
//   - turn_error bubble

/** @type {Map<string, HTMLElement>} card by toolCallId */
const toolCards = new Map()

function appendUserMessage(text) {
  const messages = document.getElementById('chat-messages')
  const msg = document.createElement('div')
  msg.className = 'chat-message'
  msg.dataset.role = 'user'
  msg.textContent = text
  messages.appendChild(msg)
  messages.scrollTop = messages.scrollHeight
}

function appendAssistantMessage(text) {
  const messages = document.getElementById('chat-messages')
  const msg = document.createElement('div')
  msg.className = 'chat-message'
  msg.dataset.role = 'assistant'
  msg.textContent = text
  messages.appendChild(msg)
  messages.scrollTop = messages.scrollHeight
}

function appendThought(text) {
  const messages = document.getElementById('chat-messages')
  const bubble = document.createElement('div')
  bubble.className = 'chat-thought'
  bubble.textContent = text
  messages.appendChild(bubble)
  messages.scrollTop = messages.scrollHeight
}

function appendTurnError(text) {
  const messages = document.getElementById('chat-messages')
  const bubble = document.createElement('div')
  bubble.className = 'chat-message chat-error'
  bubble.dataset.role = 'assistant'
  bubble.textContent = text
  messages.appendChild(bubble)
  messages.scrollTop = messages.scrollHeight
}

function riskBadgeClass(risk) {
  switch (risk) {
    case 'read': return 'risk-read'
    case 'mutate': return 'risk-mutate'
    case 'elevated': return 'risk-elevated'
    default: return 'risk-mutate'
  }
}

function riskLabel(risk) {
  switch (risk) {
    case 'read': return t('risk_read')
    case 'mutate': return t('risk_mutate')
    case 'elevated': return t('risk_elevated')
    default: return risk
  }
}

function toolNameLabel(name) {
  // i18n lookup with fallback to the raw tool name.
  const key = `tool_name_${name}`
  const bundle = pickLocaleBundle()
  return bundle[key]?.message ?? EN_US[key]?.message ?? name
}

function renderToolCard(toolCall, policyDecision) {
  const messages = document.getElementById('chat-messages')
  const card = document.createElement('div')
  card.className = 'tool-card'
  card.dataset.toolCallId = toolCall.id
  card.dataset.state = policyDecision?.needsApproval ? 'awaiting' : (policyDecision?.reason === 'hard_block' || policyDecision?.reason === 'site_denied' ? 'denied' : 'info')

  // Header: tool name + risk badge
  const header = document.createElement('div')
  header.className = 'tool-card-header'
  const name = document.createElement('span')
  name.className = 'tool-card-name'
  name.textContent = toolNameLabel(toolCall.name)
  const badge = document.createElement('span')
  badge.className = `risk-badge ${riskBadgeClass(toolCall.risk)}`
  badge.textContent = riskLabel(toolCall.risk)
  header.append(name, badge)
  card.appendChild(header)

  // Params
  const params = document.createElement('div')
  params.className = 'tool-card-params'
  params.textContent = formatParams(toolCall)
  card.appendChild(params)

  // Reasoning (if any)
  if (toolCall.reasoning) {
    const reasoning = document.createElement('div')
    reasoning.className = 'tool-card-reasoning'
    reasoning.textContent = toolCall.reasoning
    card.appendChild(reasoning)
  }

  // Policy reason
  if (policyDecision?.reason) {
    const reason = document.createElement('div')
    reason.className = 'tool-card-policy'
    reason.dataset.reason = policyDecision.reason
    reason.textContent = policyReasonLabel(policyDecision)
    card.appendChild(reason)
  }

  // Approval actions (only when needsApproval)
  if (policyDecision?.needsApproval) {
    const actions = document.createElement('div')
    actions.className = 'tool-card-actions'

    const denyBtn = document.createElement('button')
    denyBtn.type = 'button'
    denyBtn.className = 'btn btn-secondary tool-deny'
    denyBtn.textContent = t('tool_deny')
    denyBtn.addEventListener('click', () => {
      void chrome.runtime.sendMessage({
        type: MSG.TOOL_DENY,
        toolCallId: toolCall.id,
        reason: 'user_denied',
      })
    })

    const onceBtn = document.createElement('button')
    onceBtn.type = 'button'
    onceBtn.className = 'btn btn-secondary tool-once'
    onceBtn.textContent = t('siteGrants_allowOnce')
    onceBtn.addEventListener('click', () => {
      void chrome.runtime.sendMessage({
        type: MSG.TOOL_APPROVE,
        toolCallId: toolCall.id,
      })
    })

    const alwaysBtn = document.createElement('button')
    alwaysBtn.type = 'button'
    alwaysBtn.className = 'btn btn-primary tool-always'
    alwaysBtn.textContent = t('siteGrants_alwaysAllow')
    alwaysBtn.addEventListener('click', () => {
      void chrome.runtime.sendMessage({
        type: MSG.TOOL_APPROVE,
        toolCallId: toolCall.id,
      })
    })

    actions.append(denyBtn, onceBtn, alwaysBtn)
    card.appendChild(actions)
  }

  messages.appendChild(card)
  messages.scrollTop = messages.scrollHeight
  toolCards.set(toolCall.id, card)
  return card
}

function markToolExecuting(toolCallId, toolName) {
  const card = toolCards.get(toolCallId)
  if (!card) return
  card.dataset.state = 'executing'

  // Replace actions with executing indicator
  const actions = card.querySelector('.tool-card-actions')
  if (actions) actions.remove()

  const executing = document.createElement('div')
  executing.className = 'tool-card-executing'
  executing.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${t('tool_executing')}</span>`
  card.appendChild(executing)
}

function renderToolResult(toolResult) {
  const card = toolCards.get(toolResult.toolCallId)
  const messages = document.getElementById('chat-messages')

  const chip = document.createElement('div')
  chip.className = `tool-result-chip ${toolResult.success ? 'success' : 'error'}`
  const label = toolResult.success
    ? t('tool_result_success')
    : t('tool_result_error')
  const detail = toolResult.success
    ? formatResultData(toolResult.data)
    : (toolResult.error || '')
  chip.innerHTML = `<span class="tool-result-label">${label}</span><span class="tool-result-detail">${escapeHtml(detail)}</span>`

  if (card) {
    // Replace executing indicator with result chip
    const executing = card.querySelector('.tool-card-executing')
    if (executing) executing.remove()
    card.dataset.state = toolResult.success ? 'done' : 'failed'
    card.appendChild(chip)
  } else {
    // Orphan result (no prior card) — append standalone
    messages.appendChild(chip)
  }
  messages.scrollTop = messages.scrollHeight
}

function closeApprovalCard(toolCallId, decision) {
  const card = toolCards.get(toolCallId)
  if (!card) return
  // If still awaiting (user responded), remove action buttons
  const actions = card.querySelector('.tool-card-actions')
  if (actions) {
    const note = document.createElement('div')
    note.className = 'tool-card-closed'
    note.textContent = decision === 'deny'
      ? t('tool_denied')
      : decision === 'cancelled'
        ? t('tool_cancelled')
        : t('tool_approved')
    actions.replaceWith(note)
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function formatParams(toolCall) {
  const p = toolCall.params
  if (!p || typeof p !== 'object') return toolCall.input || ''
  try {
    return Object.entries(p)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ')
  } catch {
    return toolCall.input || ''
  }
}

function formatResultData(data) {
  if (data == null) return ''
  if (typeof data === 'string') return data.slice(0, 200)
  try {
    return JSON.stringify(data).slice(0, 200)
  } catch {
    return ''
  }
}

function policyReasonLabel(decision) {
  switch (decision.reason) {
    case 'hard_block':
      return `${t('policy_hard_block')}: ${decision.hardBlockLabel ?? 'unknown'}`
    case 'site_denied':
      return t('policy_site_denied')
    case 'site_always_allowed':
      return t('policy_site_always_allowed')
    case 'site_once_allowed':
      return t('policy_site_once_allowed')
    case 'manual_needs_approval':
      return t('policy_manual_needs_approval')
    case 'elevated_requires_approval':
      return t('policy_elevated_requires_approval')
    case 'auto_no_grant':
      return t('policy_auto_no_grant')
    case 'skip_no_grant':
      return t('policy_skip_no_grant')
    default:
      return decision.reason
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ── Chat send ────────────────────────────────────────────────────

function updateSendEnabled() {
  const input = document.getElementById('chat-input')
  const send = document.getElementById('chat-send')
  if (!input || !send) return
  const hasText = input.value.trim().length > 0
  send.disabled = !hasText
}

function initChat() {
  const form = document.getElementById('chat-form')
  const input = document.getElementById('chat-input')

  input.addEventListener('input', updateSendEnabled)
  updateSendEnabled()

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    updateSendEnabled()

    const session = await loadSession()
    if (!isSessionActive(session)) {
      appendTurnError(t('chat_signInRequired'))
      return
    }

    appendUserMessage(text)

    const turnId = crypto.randomUUID()
    await chrome.runtime.sendMessage({
      type: MSG.AGENT_TURN_START,
      turnId,
      userMessage: text,
    })
  })
}

// ── Agent event listener ─────────────────────────────────────────

function initAgentEventListener() {
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return

    switch (message.type) {
      case MSG.AUTH_STATE_CHANGED: {
        renderAuth(message.session ?? null)
        if (!isSessionActive(message.session)) {
          clearModelSelect()
        }
        break
      }
      case MSG.MODELS_STATE_CHANGED: {
        populateModelSelect(message.models ?? [], message.selectedId)
        break
      }
      case MSG.AGENT_THOUGHT: {
        appendThought(message.text)
        break
      }
      case MSG.AGENT_TOOL_REQUEST: {
        renderToolCard(message.toolCall, message.policyDecision)
        break
      }
      case MSG.AGENT_TOOL_EXECUTING: {
        markToolExecuting(message.toolCallId, message.toolName)
        break
      }
      case MSG.AGENT_TOOL_RESULT: {
        renderToolResult(message.toolResult)
        break
      }
      case 'agent:approval_closed': {
        closeApprovalCard(message.approvalId, message.decision)
        break
      }
      case MSG.AGENT_TURN_COMPLETE: {
        appendAssistantMessage(message.assistantMessage)
        break
      }
      case MSG.AGENT_TURN_ERROR: {
        appendTurnError(message.error)
        break
      }
      default:
        break
    }
  })
}

// ── Desktop connection status ────────────────────────────────────
//
// Background broadcasts 'desktop:status' messages with state
// 'connected' | 'disconnected' | 'unknown'. Per the quiet-chrome rule,
// we only react to 'connected' — unknown/disconnected stay silent in
// the panel and surface (with reason) in the options page instead.
// The function remains so the message channel stays wired; if the
// element isn't present (default chrome has none) it's a no-op.

function renderDesktopStatus(state) {
  if (state !== 'connected') return
  // Quiet by design — connected state is acknowledged but never
  // shouted. If the design later adds a subtle indicator, the chip
  // selector would be #desktop-status-chip.
  const chip = document.getElementById('desktop-status-chip')
  if (!chip) return
  chip.dataset.state = 'connected'
  const textEl = chip.querySelector('.desktop-status-text')
  if (textEl) textEl.textContent = t('desktop_status_connected')
}

function openSettings() {
  // chrome.runtime.openOptionsPage falls back to options.html if no
  // options_ui is declared in the manifest.
  void chrome.runtime.openOptionsPage()
}

function openPrivacy() {
  void chrome.tabs.create({ url: chrome.runtime.getURL('privacy.html') })
}

// ── Init ─────────────────────────────────────────────────────────

function resolveBrandAssets() {
  // Extension-root paths so mascot/icons resolve regardless of panel nesting.
  const mascot = chrome.runtime.getURL('icons/verboo-mascot.png')
  for (const img of document.querySelectorAll('.login-mascot, .topbar-mascot')) {
    img.src = mascot
  }
}

async function init() {
  applyI18n(document)
  resolveBrandAssets()

  initAgentEventListener()
  initModelSelect()
  initApiKeyToggle()

  await hydrateAuthFromBackground()

  await initModes()
  initChat()

  document.getElementById('login-form')?.addEventListener('submit', (e) => {
    void handleLoginSubmit(e)
  })
  document.getElementById('auth-action')?.addEventListener('click', () => {
    void handleLogout()
  })
  document.getElementById('settings-btn')?.addEventListener('click', openSettings)

  document.getElementById('privacy-link-login')?.addEventListener('click', openPrivacy)

  // Backup if AUTH_STATE_CHANGED broadcast is missed (e.g. race).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if ('verbooSession' in changes) {
      renderAuth(changes.verbooSession.newValue ?? null)
      if (!isSessionActive(changes.verbooSession.newValue)) {
        clearModelSelect()
      }
    }
  })
}

init().catch((err) => {
  console.error('[Verboo panel] init failed', err)
})