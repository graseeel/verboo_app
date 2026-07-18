/**
 * background.js — Verboo Chrome Extension service worker.
 *
 * Responsibilities (P1):
 * - Open side panel on toolbar icon click
 * - Relay auth session state (stub)
 *
 * P2+: agent client, tab group management, Native Messaging host
 *
 * Multi-user: zero hardcoded accounts.
 */

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
