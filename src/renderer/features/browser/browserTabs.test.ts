import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { activeBrowserTab, emptyBrowserSession, MAX_LIVE_BROWSER_TABS } from './browserTabs'
import { rustTabFields, rustSessionFields } from './browserTabsConcordance'
import type { BrowserSessionSnapshot, BrowserTabSnapshot } from './browserTabs'

function tab(id: string, overrides: Partial<BrowserTabSnapshot> = {}): BrowserTabSnapshot {
  return {
    id, label: `label-${id}`, url: 'about:blank', title: '',
    canGoBack: false, canGoForward: false, loading: false,
    generation: 0, recoverableError: null, evicted: false,
    ...overrides,
  }
}

describe('browserTabs', () => {
  it('exposes a canonical empty session with no tabs and no active id', () => {
    expect(emptyBrowserSession).toEqual({ tabs: [], activeTabId: null, visible: false })
  })

  it('selects the active tab by id', () => {
    const session: BrowserSessionSnapshot = {
      tabs: [tab('tab-a'), tab('tab-b')],
      activeTabId: 'tab-b',
      visible: true,
    }
    expect(activeBrowserTab(session)?.id).toBe('tab-b')
  })

  it('returns undefined when the active id is not present in the tabs', () => {
    const session: BrowserSessionSnapshot = {
      tabs: [tab('tab-a')],
      activeTabId: 'tab-missing',
      visible: true,
    }
    expect(activeBrowserTab(session)).toBeUndefined()
  })

  it('returns undefined when there is no active tab', () => {
    const session: BrowserSessionSnapshot = {
      tabs: [tab('tab-a')],
      activeTabId: null,
      visible: true,
    }
    expect(activeBrowserTab(session)).toBeUndefined()
  })

  it('preserves the full active tab snapshot, including generation and recoverable error', () => {
    const active = tab('tab-a', {
      url: 'https://example.com', title: 'Example',
      canGoBack: true, canGoForward: false, loading: true,
      generation: 7, recoverableError: 'net err',
    })
    const session: BrowserSessionSnapshot = {
      tabs: [tab('tab-b'), active],
      activeTabId: 'tab-a',
      visible: true,
    }
    expect(activeBrowserTab(session)).toEqual(active)
  })
})

describe('browserTabs — Rust-TS field concordance', () => {
  const rustPath = resolve(__dirname, '../../../../src-tauri/src/services/browser_session.rs')

  it('BrowserTabSnapshot keys match the camelCase fields of the Rust BrowserTabSnapshot struct', () => {
    const rustFields = rustTabFields(rustPath)
    const sample: Record<keyof BrowserTabSnapshot, unknown> = {
      id: '', label: '', url: '', title: '', canGoBack: false,
      canGoForward: false, loading: false, generation: 0, recoverableError: null,
      evicted: false,
    }
    const tsKeys = new Set(Object.keys(sample))

    const rustOnly = [...rustFields].filter(f => !tsKeys.has(f))
    const tsOnly = [...tsKeys].filter(f => !rustFields.has(f))
    if (rustOnly.length || tsOnly.length) {
      throw new Error(
        'BrowserTabSnapshot diverged — ' +
        (rustOnly.length ? `Rust-only: ${rustOnly.join(', ')}; ` : '') +
        (tsOnly.length ? `TS-only: ${tsOnly.join(', ')}` : ''),
      )
    }
    expect(rustFields).toEqual(tsKeys)
  })

  it('BrowserSessionSnapshot keys match the camelCase fields of the Rust BrowserSessionSnapshot struct', () => {
    const rustFields = rustSessionFields(rustPath)
    const sample: Record<keyof BrowserSessionSnapshot, unknown> = {
      tabs: [], activeTabId: null, visible: false,
    }
    const tsKeys = new Set(Object.keys(sample))

    const rustOnly = [...rustFields].filter(f => !tsKeys.has(f))
    const tsOnly = [...tsKeys].filter(f => !rustFields.has(f))
    if (rustOnly.length || tsOnly.length) {
      throw new Error(
        'BrowserSessionSnapshot diverged — ' +
        (rustOnly.length ? `Rust-only: ${rustOnly.join(', ')}; ` : '') +
        (tsOnly.length ? `TS-only: ${tsOnly.join(', ')}` : ''),
      )
    }
    expect(rustFields).toEqual(tsKeys)
  })

  it('keeps the renderer live-tab cap pinned to the measured Rust limit', () => {
    const rustSource = readFileSync(
      resolve(__dirname, '../../../../src-tauri/src/services/browser_panel.rs'),
      'utf8',
    )

    // Cross-component selector/contract rule: pin against the foreign source,
    // never against a renderer-authored copy of the same number.
    const rustLimit = rustSource.match(/pub const MAX_LIVE_TABS: usize = (\d+);/)?.[1]
    expect(Number(rustLimit)).toBe(MAX_LIVE_BROWSER_TABS)
  })
})
