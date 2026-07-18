/**
 * panel.js — Verboo Chrome Extension side panel controller.
 *
 * P1 responsibilities:
 * - Apply i18n strings to the DOM
 * - Render auth status (stub login/logout)
 * - Persist Chrome Permission Mode (manual/auto/skip)
 * - Manage Site Grants (add/remove, persisted)
 * - Chat shell stub (echo only — no agent loop)
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

// ── i18n ────────────────────────────────────────────────────────
// Chrome's built-in chrome.i18n.getMessage reads from _locales/<lang>/messages.json.
// We ship messages as JS objects in src/i18n/ for parity with desktop conventions
// and to keep the build step-free. Pick locale by UI language with pt-BR fallback.

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

// ── Auth (stub) ──────────────────────────────────────────────────
// P1: stub session. Real Verboo OAuth flow lands in P2.
// Session shape: { sessionToken, email, signedInAt } — no apiKey field.
// Storage handled by src/auth/auth.js (single source, key 'verbooSession').

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
    // Stub: in P2 this opens the Verboo OAuth flow. For P1 we use a
    // placeholder email prompt so the UI is testable without a backend.
    const email = window.prompt('Verboo account email (stub):')
    if (email && email.includes('@')) {
      // P1 placeholder session — no apiKey. P2 replaces with real OAuth token.
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
  // Strip scheme and path; keep bare host.
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

// ── Chat shell (stub) ────────────────────────────────────────────
// P1: echo only. P2 wires the Verboo Session agent client.

function appendMessage(role, text) {
  const messages = document.getElementById('chat-messages')
  const msg = document.createElement('div')
  msg.className = 'chat-message'
  msg.dataset.role = role
  msg.textContent = text
  messages.appendChild(msg)
  messages.scrollTop = messages.scrollHeight
}

function initChat() {
  const form = document.getElementById('chat-form')
  const input = document.getElementById('chat-input')
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    appendMessage('user', text)
    input.value = ''
    // Stub assistant reply — no real agent loop in P1.
    setTimeout(() => {
      appendMessage('assistant', t('chat_stubNotice'))
    }, 200)
  })
}

// ── Init ─────────────────────────────────────────────────────────

async function init() {
  applyI18n(document)

  const session = await loadSession()
  renderAuth(session)

  await initModes()
  await renderGrants()
  initChat()

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
