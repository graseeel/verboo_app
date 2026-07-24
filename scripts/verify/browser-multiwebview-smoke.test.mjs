import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLaunch, assertRuntimeReport } from './browser-multiwebview-smoke.mjs'

// ── Helpers ────────────────────────────────────────────────────────────

// Returns a complete, valid report that assertRuntimeReport should accept.
// Each test overrides the specific field being tested.
function validReport(overrides = {}) {
  return {
    success: true,
    navigated: true,
    boundsUpdated: true,
    destroyed: true,
    snapshotMs: 50,
    snapshotBytes: 12000,
    bridgeReceived: true,
    evaluated: true,
    createdTabs: 2,
    activatedSecondTab: true,
    closedTabs: 2,
    ...overrides,
  }
}

// ── resolveLaunch ──────────────────────────────────────────────────────

describe('resolveLaunch', () => {
  test('macOS .app resolves to inner executable using default executableName', () => {
    const macOSBundle = '/tmp/Verboo Code.app'
    assert.deepEqual(resolveLaunch(macOSBundle, 'darwin'), {
      executable: '/tmp/Verboo Code.app/Contents/MacOS/verboo-desktop',
      args: [],
    })
  })

  test('macOS .app honors executableName read from Info.plist', () => {
    // The real caller reads CFBundleExecutable from the bundle's Info.plist
    // and passes it here, so the smoke never hardcodes a binary name in a
    // product shipped to many users.
    const macOSBundle = '/tmp/Verboo Code.app'
    assert.deepEqual(resolveLaunch(macOSBundle, 'darwin', 'verboo-code'), {
      executable: '/tmp/Verboo Code.app/Contents/MacOS/verboo-code',
      args: [],
    })
  })

  test('Windows .exe resolves as-is', () => {
    const exePath = 'C:\\build\\verboo-desktop.exe'
    assert.deepEqual(resolveLaunch(exePath, 'win32'), {
      executable: 'C:\\build\\verboo-desktop.exe',
      args: [],
    })
  })

  test('Linux binary resolves as-is', () => {
    const binPath = '/build/verboo-desktop'
    assert.deepEqual(resolveLaunch(binPath, 'linux'), {
      executable: '/build/verboo-desktop',
      args: [],
    })
  })

  test('unknown extension on darwin passes through as-is', () => {
    assert.deepEqual(resolveLaunch('/tmp/verboo-desktop', 'darwin'), {
      executable: '/tmp/verboo-desktop',
      args: [],
    })
  })
})

// ── assertRuntimeReport ────────────────────────────────────────────────

describe('assertRuntimeReport', () => {
  test('accepts a complete valid report', () => {
    assert.doesNotThrow(() => assertRuntimeReport(validReport()))
  })

  test('rejects bridgeReceived = false', () => {
    assert.throws(
      () => assertRuntimeReport(validReport({ bridgeReceived: false })),
      { message: /bridge not received/ },
    )
  })

  test('rejects evaluated = false', () => {
    assert.throws(
      () => assertRuntimeReport(validReport({ evaluated: false })),
      { message: /evaluate did not return/ },
    )
  })

  test('rejects createdTabs = 1 (< 2)', () => {
    assert.throws(
      () => assertRuntimeReport(validReport({ createdTabs: 1 })),
      { message: /expected >= 2 created tabs/ },
    )
  })

  test('rejects closedTabs = 1 (< 2)', () => {
    assert.throws(
      () => assertRuntimeReport(validReport({ closedTabs: 1 })),
      { message: /expected >= 2 closed tabs/ },
    )
  })

  test('rejects non-null error', () => {
    assert.throws(
      () => assertRuntimeReport(validReport({ error: 'WKWebView creation timed out' })),
      { message: /smoke reported error/ },
    )
  })

  test('rejects missing lifecycle field (destroyed = false)', () => {
    assert.throws(
      () => assertRuntimeReport(validReport({ destroyed: false })),
      { message: /incomplete runtime smoke/ },
    )
  })

  test('rejects snapshotBytes = 0', () => {
    assert.throws(
      () => assertRuntimeReport(validReport({ snapshotBytes: 0 })),
      { message: /snapshot budget failed/ },
    )
  })

  test('rejects snapshotMs over budget (200 > 100)', () => {
    assert.throws(
      () => assertRuntimeReport(validReport({ snapshotMs: 200 })),
      { message: /snapshot budget failed/ },
    )
  })
})
