/**
 * options.js — Verboo Chrome Extension options page.
 *
 * Minimal settings page opened via chrome.runtime.openOptionsPage.
 * Owns: full permission mode selector, site grants CRUD, sign-out,
 * and privacy link.
 */

import { loadMode, saveMode } from '../policy/modesStore.js'
import { loadGrants, upsertGrant, removeGrant } from '../policy/siteGrantsStore.js'
import { loadSession } from '../auth/auth.js'
import { MSG } from '../controller/protocol.js'

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
    el.textContent = t(el.getAttribute('data-i18n'))
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')))
  }
}

// ── Auth ────────────────────────────────────────────────────────

/**
 * @param {import('../auth/auth.js').VerbooSession | null | undefined} session
 */
function isSessionActive(session) {
  if (!session?.accessToken) return false
  if (session.expiresAt != null && session.expiresAt <= Date.now()) return false
  return true
}

async function renderAuth(session) {
  const sub = document.getElementById('options-user')
  if (!sub) return
  if (isSessionActive(session)) {
    const label = session.email || session.accountId || t('branding_title')
    sub.textContent = `${t('auth_signedInAs')} ${label}`
  } else {
    sub.textContent = t('auth_notSignedIn')
  }
}

/**
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

async function handleLogout() {
  await sendMessage({ type: MSG.AUTH_LOGOUT })
  await renderAuth(null)
}

// ── Mode selector ───────────────────────────────────────────────

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

// ── Privacy ─────────────────────────────────────────────────────

function openPrivacy() {
  void chrome.tabs.create({ url: chrome.runtime.getURL('privacy.html') })
}

// ── Init ────────────────────────────────────────────────────────

function resolveBrandAssets() {
  const mascot = chrome.runtime.getURL('icons/verboo-mascot.png')
  const img = document.getElementById('options-mascot')
  if (img) img.src = mascot
}

async function init() {
  applyI18n(document)
  resolveBrandAssets()

  const session = await loadSession()
  await renderAuth(session)

  await initModes()
  await renderGrants()

  document.getElementById('grants-add-btn')?.addEventListener('click', () => {
    void handleAddGrant()
  })
  document.getElementById('grants-host-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleAddGrant()
    }
  })

  document.getElementById('auth-action')?.addEventListener('click', () => {
    void handleLogout()
  })
  document.getElementById('privacy-link')?.addEventListener('click', openPrivacy)

  // Re-render grants if any other pane mutated them.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if ('siteGrants' in changes) {
      void renderGrants()
    }
    if ('verbooSession' in changes) {
      void renderAuth(changes.verbooSession.newValue ?? null)
    }
  })
}

init().catch((err) => {
  console.error('[Verboo options] init failed', err)
})
