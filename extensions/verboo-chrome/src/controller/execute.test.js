/**
 * execute.test.js — unit tests for the Browser Controller execute() gate.
 *
 * Run with: node --test src/controller/execute.test.js
 *
 * Mocks chrome.tabs and chrome.scripting for pure-logic verification.
 * Tool implementation tests (navigate, click, etc.) live in tools/*.test.js.
 */

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

// ── Setup chrome mocks ──────────────────────────────────────
const fakeTabs = new Map()
let currentWindowTabId = 42
globalThis.chrome = {
  tabs: {
    query: async (opts) => {
      if (opts?.active && opts?.currentWindow) {
        const tab = fakeTabs.get(currentWindowTabId) ?? { id: currentWindowTabId, url: 'https://example.com', title: 'Example' }
        return [tab]
      }
      return Array.from(fakeTabs.values())
    },
    get: async (id) => fakeTabs.get(id) ?? { id, url: 'https://example.com' },
    update: async (id) => { /* noop */ },
  },
  scripting: {
    executeScript: async () => [{ result: 'mocked' }],
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {},
    },
  },
}

// Register a default tab so queries work.
fakeTabs.set(42, { id: 42, url: 'https://example.com', active: true, windowId: 1, title: 'Example' })

const { execute } = await import('./execute.js')

function makeCtx(overrides = {}) {
  return {
    mode: 'manual',
    getSiteGrant: async () => undefined,
    activeTabId: 42,
    ...overrides,
  }
}

// ── Tests: policy gate enforces before any tool runs ─────────

test('execute: hard blocked tool returns policy denial (no dispatch)', async () => {
  const r = await execute(
    { name: 'click', risk: 'mutate', input: 'click text=Buy Now' },
    makeCtx(),
  )
  assert.equal(r.ok, false)
  assert.equal(r.policy.reason, 'hard_block')
  assert.equal(r.policy.hardBlockLabel, 'purchase')
})

test('execute: site denied returns policy denial', async () => {
  const r = await execute(
    { name: 'read_page', risk: 'read', input: 'read_page selector=h1' },
    makeCtx({ mode: 'skip', getSiteGrant: async () => 'deny' }),
  )
  assert.equal(r.ok, false)
  assert.equal(r.policy.reason, 'site_denied')
})

test('execute: manual + no grant + mutate returns needsApproval (no dispatch)', async () => {
  const r = await execute(
    { name: 'click', risk: 'mutate', input: 'click text=Submit' },
    makeCtx({ mode: 'manual' }),
  )
  assert.equal(r.ok, false)
  assert.equal(r.policy.reason, 'manual_needs_approval')
  assert.equal(r.policy.needsApproval, true)
})

test('execute: skip + no grant + mutate dispatches and returns result', async () => {
  const r = await execute(
    { name: 'read_page', risk: 'read', input: 'read_page selector=h1' },
    makeCtx({ mode: 'skip' }),
  )
  assert.equal(r.ok, true)
  assert.ok(r.result != null)
  assert.equal(r.policy.reason, 'skip_no_grant')
})

test('execute: site always + mutate dispatches', async () => {
  const r = await execute(
    { name: 'read_page', risk: 'read', input: 'read_page selector=h1' },
    makeCtx({ mode: 'manual', getSiteGrant: async () => 'always' }),
  )
  assert.equal(r.ok, true)
  assert.equal(r.policy.reason, 'site_always_allowed')
})

test('execute: elevated always needsApproval', async () => {
  const r = await execute(
    { name: 'file_upload', risk: 'elevated', input: 'file_upload path=/etc/passwd' },
    makeCtx({ mode: 'skip', getSiteGrant: async () => 'always' }),
  )
  assert.equal(r.ok, false)
  assert.equal(r.policy.reason, 'elevated_requires_approval')
  assert.equal(r.policy.needsApproval, true)
})

test('execute: invalid tool call returns error', async () => {
  const r = await execute(null, makeCtx())
  assert.equal(r.ok, false)
  assert.equal(r.policy.reason, 'invalid_tool_call')
})

test('execute: unknown tool name returns error', async () => {
  const r = await execute(
    { name: 'unknown_tool_xyz', risk: 'mutate', input: 'unknown_tool_xyz' },
    makeCtx({ mode: 'skip' }),
  )
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('unknown_tool_xyz'))
})

// ── Tests: execute returns policy in every response ─────────
test('execute: policy field always present in result', async () => {
  // Allowed case
  const r = await execute(
    { name: 'read_page', risk: 'read', input: 'read_page selector=h1' },
    makeCtx({ mode: 'skip' }),
  )
  assert.ok(r.policy != null)

  // Denied case
  const d = await execute(null, makeCtx())
  assert.ok(d.policy != null)
})
