/**
 * panel.js — Verboo Chrome Extension side panel controller.
 *
 * P2 responsibilities:
 * - Apply i18n strings to the DOM
 * - Render auth status (stub login/logout via auth.js)
 * - Persist Chrome Permission Mode (manual/auto/skip)
 * - Manage Site Grants (add/remove, persisted)
 * - Chat: send user message → AGENT_TURN_START; render agent events
 *   (thought, tool_request, tool_executing, tool_result, turn_complete,
 *   turn_error) as transcript cards
 * - Tool approval prompts: once/always/deny for needsApproval tools
 *
 * Multi-user: zero hardcoded accounts, paths, or tokens.
 */

import { loadMode, saveMode } from '../policy/modesStore.js'
import {
  loadGrants,
  upsertGrant,
  removeGrant,
} from '../policy/siteGrantsStore.js'
import {
  loadSession,
  saveSession,
  clearSession,
} from '../auth/auth.js'
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
}

// ── Auth ──────────────────────────────────────────────────────────

function renderAuth(session) {
  const statusEl = document.getElementById('auth-status')
  const statusText = statusEl.querySelector('.auth-status-text')
  const actionBtn = document.getElementById('auth-action')

  if (session?.email) {
    statusEl.classList.add('is-signed-in')
    statusText.textContent = `${t('auth_signedInAs')} ${session.email}`
    actionBtn.textContent = t('auth_logout')
    actionBtn.dataset.action = 'logout'
  } else {
    statusEl.classList.remove('is-signed-in')
    statusText.textContent = t('auth_notSignedIn')
    actionBtn.textContent = t('auth_login')
    actionBtn.dataset.action = 'login'
  }
}

async function handleAuthAction() {
  const btn = document.getElementById('auth-action')
  const action = btn.dataset.action
  if (action === 'login') {
    // Stub: in P3 this opens the Verboo OAuth flow. For P2 we use a
    // placeholder email prompt so the UI is testable without a backend.
    const email = window.prompt('Verboo account email (stub):')
    if (email && email.includes('@')) {
      const sessionToken = `stub-${crypto.randomUUID()}`
      await saveSession({ sessionToken, email, signedInAt: Date.now() })
    }
  } else if (action === 'logout') {
    await clearSession()
  }
  const session = await loadSession()
  renderAuth(session)
}

// ── Mode selector ────────────────────────────────────────────────

async function initModes() {
  const mode = await loadMode()
  const radio = document.querySelector(`input[name="mode"][value="${mode}"]`)
  if (radio) radio.checked = true

  for (const input of document.querySelectorAll('input[name="mode"]')) {
    input.addEventListener('change', async (e) => {
      await saveMode(/** @type {any} */ (e.target).value)
    })
  }
}

// ── Site grants ─────────────────────────────────────────────────

function normalizeHost(raw) {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return ''
  return trimmed
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
}

function decisionLabel(decision) {
  switch (decision) {
    case 'always': return t('siteGrants_alwaysAllow')
    case 'once': return t('siteGrants_allowOnce')
    case 'deny': return t('siteGrants_deny')
    default: return decision
  }
}

async function renderGrants() {
  const grants = await loadGrants()
  const list = document.getElementById('grants-list')
  list.innerHTML = ''
  for (const grant of grants) {
    const li = document.createElement('li')
    li.className = 'grant-item'

    const host = document.createElement('span')
    host.className = 'grant-host'
    host.textContent = grant.host
    host.title = grant.host

    const decision = document.createElement('span')
    decision.className = 'grant-decision'
    decision.dataset.decision = grant.decision
    decision.textContent = decisionLabel(grant.decision)

    const remove = document.createElement('button')
    remove.className = 'grant-remove'
    remove.type = 'button'
    remove.textContent = '×'
    remove.setAttribute('aria-label', t('siteGrants_remove'))
    remove.title = t('siteGrants_remove')
    remove.addEventListener('click', async () => {
      await removeGrant(grant.host)
      await renderGrants()
    })

    li.append(host, decision, remove)
    list.appendChild(li)
  }
}

async function handleAddGrant() {
  const input = document.getElementById('grants-host-input')
  const select = document.getElementById('grants-decision-select')
  const host = normalizeHost(input.value)
  if (!host) return
  const decision = select.value
  await upsertGrant(host, decision)
  input.value = ''
  await renderGrants()
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
  return name
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
    alwaysBtn.addEventListener('click', async () => {
      // Persist grant for the active host before approving.
      const host = await activeHost()
      if (host) await upsertGrant(host, 'always')
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
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&#39;')
}

async function activeHost() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.url) return ''
    return new URL(tab.url).host
  } catch {
    return ''
  }
}

// ── Chat send ────────────────────────────────────────────────────

function initChat() {
  const form = document.getElementById('chat-form')
  const input = document.getElementById('chat-input')

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    input.value = ''

    const session = await loadSession()
    if (!session?.sessionToken) {
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

  // ── Privacy policy link (P3) ───────────────────────────────
  const privacyBtn = document.getElementById('privacy-link')
  if (privacyBtn) {
    privacyBtn.addEventListener('click', async () => {
      // Open the bundled privacy.html in a new tab. ANVIL ships it at
      // the extension root; chrome.runtime.getURL resolves the
      // chrome-extension://<id>/privacy.html URL.
      await chrome.tabs.create({ url: chrome.runtime.getURL('privacy.html') })
    })
  }
}

// ── Agent event listener ─────────────────────────────────────────

function initAgentEventListener() {
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return

    switch (message.type) {
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
      case 'desktop:status': {
        renderDesktopStatus(message.state)
        break
      }
      default:
        break
    }
  })
}

// ── Desktop connection status (P4) ───────────────────────────────
//
// Listens for 'desktop:status' messages from the background (which
// probes the native host / Tauri IPC). States: 'connected',
// 'disconnected', 'unknown'. Default is 'unknown' until the first
// message arrives.

function renderDesktopStatus(state) {
  const chip = document.getElementById('desktop-status-chip')
  if (!chip) return
  const textEl = chip.querySelector('.desktop-status-text')
  const valid = ['connected', 'disconnected', 'unknown'].includes(state)
  const next = valid ? state : 'unknown'
  chip.dataset.state = next
  const key = `desktop_status_${next}`
  if (textEl) textEl.textContent = t(key)
}

// ── Init ─────────────────────────────────────────────────────────

async function init() {
  applyI18n(document)

  const session = await loadSession()
  renderAuth(session)

  await initModes()
  await renderGrants()
  initChat()
  initAgentEventListener()

  document.getElementById('auth-action').addEventListener('click', handleAuthAction)
  document.getElementById('grants-add-btn').addEventListener('click', handleAddGrant)
  document.getElementById('grants-host-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleAddGrant()
    }
  })

  // Re-render auth + grants when storage changes (e.g. from another surface).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if ('verbooSession' in changes) {
      renderAuth(changes.verbooSession.newValue ?? null)
    }
    if ('siteGrants' in changes) {
      void renderGrants()
    }
  })
}

init().catch((err) => {
  console.error('[Verboo panel] init failed', err)
})
