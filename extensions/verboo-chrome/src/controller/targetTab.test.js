import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

const originalChrome = globalThis.chrome

afterEach(() => {
  globalThis.chrome = originalChrome
})

test('an explicit closed target fails closed instead of falling back to the user tab', async () => {
  const target = await import('./targetTab.js').catch(() => ({}))
  assert.equal(typeof target.resolveTargetTab, 'function')
  let queried = false
  globalThis.chrome = {
    tabs: {
      get: async () => { throw new Error('No tab with id') },
      query: async () => {
        queried = true
        return [{ id: 99, windowId: 9, active: true }]
      },
    },
  }

  await assert.rejects(() => target.resolveTargetTab(42), /target_tab_unavailable/)
  assert.equal(queried, false)
})

test('legacy callers without a target can still resolve the current tab', async () => {
  const { resolveTargetTab } = await import('./targetTab.js')
  globalThis.chrome = {
    tabs: {
      query: async () => [{ id: 99, windowId: 9, active: true }],
    },
  }

  assert.equal((await resolveTargetTab()).id, 99)
})

// ── DECISÃO DO DONO (workspace, 2026-08-15): resolveTargetTab with a
//    lease NEVER falls back to the active tab — the user may switch tabs
//    freely mid-turn; tools keep acting on the leased working tab.

test('DECISÃO DO DONO: with a lease, returns the leased tab even when another tab is active', async () => {
  const { resolveTargetTab } = await import('./targetTab.js')
  let queried = false
  globalThis.chrome = {
    tabs: {
      get: async (id) => ({ id, windowId: 9, url: 'https://source.example/form', active: false, status: 'complete' }),
      query: async () => { queried = true; return [{ id: 777, windowId: 9, active: true }] },
    },
  }
  const tab = await resolveTargetTab(42)
  assert.equal(tab.id, 42, 'retorna a aba do lease, não a aba ativa')
  assert.equal(queried, false, 'NUNCA consulta a aba ativa quando há lease')
})

test('DECISÃO DO DONO: mid-turn tab switch does not divert tools (lease is sticky)', async () => {
  const { resolveTargetTab } = await import('./targetTab.js')
  // O usuário troca de aba mid-turn: a aba ativa muda, mas o lease
  // aponta para a aba de origem. Duas chamadas consecutivas devem
  // retornar a MESMA aba do lease.
  globalThis.chrome = {
    tabs: {
      get: async (id) => ({ id, windowId: 9, active: false, status: 'complete' }),
      query: async () => [{ id: 999, windowId: 9, active: true }],
    },
  }
  const t1 = await resolveTargetTab(42)
  const t2 = await resolveTargetTab(42)
  assert.equal(t1.id, 42)
  assert.equal(t2.id, 42, 'segunda chamada ainda retorna o lease — troca mid-turn não desvia')
})

test('DECISÃO DO DONO: closed working tab mid-turn fails honestly (no silent migration)', async () => {
  const { resolveTargetTab } = await import('./targetTab.js')
  let queried = false
  globalThis.chrome = {
    tabs: {
      get: async () => { throw new Error('No tab with id') },
      query: async () => { queried = true; return [{ id: 555, windowId: 9, active: true }] },
    },
  }
  await assert.rejects(() => resolveTargetTab(42), /target_tab_unavailable/)
  assert.equal(queried, false, 'NUNCA cai em active tab — o caso chrome:// do teste 1 não se repete')
})

// ── DECISÃO DO DONO (workspace, 2026-08-16): the execution context's
//    target decision (makeExecutionContext) NEVER falls back to the user's
//    active tab. With a live lease the lease tab wins; with no lease and
//    no explicit fallback the context FAILS CLOSED (target_tab_unavailable)
//    — the legacy handleBrowserTool surface (no lease, no sender) must not
//    silently act on whatever the user is looking at (T3: type ran on the
//    active X.com tab while the lease was TodoMVC).

test('resolveExecutionTabId: lease wins over any fallback', async () => {
  const { resolveExecutionTabId } = await import('./targetTab.js')
  assert.equal(resolveExecutionTabId({ tabId: 1 }, 2), 1)
  assert.equal(resolveExecutionTabId({ tabId: 1 }, undefined), 1)
})

test('resolveExecutionTabId: explicit fallback tab id wins when no lease', async () => {
  const { resolveExecutionTabId } = await import('./targetTab.js')
  assert.equal(resolveExecutionTabId(null, 42), 42)
  assert.equal(resolveExecutionTabId(undefined, 42), 42)
})

test('resolveExecutionTabId: no lease + no fallback FAILS CLOSED (never active tab)', async () => {
  const { resolveExecutionTabId } = await import('./targetTab.js')
  assert.throws(() => resolveExecutionTabId(null, undefined), /target_tab_unavailable/)
  assert.throws(() => resolveExecutionTabId(undefined, undefined), /target_tab_unavailable/)
  assert.throws(() => resolveExecutionTabId(null, null), /target_tab_unavailable/)
})
