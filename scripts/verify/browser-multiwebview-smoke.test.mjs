import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  SMOKE_WALL_TIMEOUT_MS,
  resolveLaunch,
  assertRuntimeReport,
} from './browser-multiwebview-smoke.mjs'

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

test('wall timeout covers a cold native startup and two slow webview creations', () => {
  assert.ok(SMOKE_WALL_TIMEOUT_MS >= 180_000)
})

// ── assertRuntimeReport ────────────────────────────────────────────────

describe('assertRuntimeReport', () => {
  test('accepts a complete valid report with snapshot ok', () => {
    assert.doesNotThrow(() => assertRuntimeReport(validReport()))
  })

  test('tolerates snapshot-only failure (headless) and emits WARNING', () => {
    // Headless CI runners never compose a WKWebView frame, so the Rust side
    // sets error = "snapshot ... timed out" and success = false. The launcher
    // must NOT block on this — only warn.
    const headlessReport = validReport({
      success: false,
      snapshotBytes: 0,
      snapshotMs: 0,
      error: 'snapshot measured timed out',
    })
    // Capture stderr to assert the WARNING is emitted.
    const originalWrite = process.stderr.write.bind(process.stderr)
    let captured = ''
    process.stderr.write = (chunk) => { captured += String(chunk); return true }
    try {
      assert.doesNotThrow(() => assertRuntimeReport(headlessReport))
    } finally {
      process.stderr.write = originalWrite
    }
    assert.match(captured, /WARNING: snapshot unavailable/)
  })

  test('rejects bridgeReceived = false even with snapshot ok', () => {
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

  test('rejects non-snapshot error (e.g. bridge timeout)', () => {
    // An error that is NOT about snapshot must still block, even if
    // snapshotBytes happens to be 0 — this is the regression the gate exists
    // to catch.
    assert.throws(
      () => assertRuntimeReport(validReport({
        success: false,
        snapshotBytes: 0,
        snapshotMs: 0,
        error: 'tab 2 create timed out',
      })),
      { message: /smoke reported error/ },
    )
  })

  test('rejects missing lifecycle field (destroyed = false)', () => {
    assert.throws(
      () => assertRuntimeReport(validReport({ destroyed: false })),
      { message: /incomplete runtime smoke/ },
    )
  })

  test('rejects snapshotMs over budget when snapshot succeeded', () => {
    // snapshotBytes > 0 means the snapshot ran; then the 100ms budget applies.
    assert.throws(
      () => assertRuntimeReport(validReport({ snapshotMs: 200 })),
      { message: /snapshot budget failed/ },
    )
  })

  test('rejects snapshotBytes = 0 with NO error (silent snapshot failure)', () => {
    // No error string + 0 bytes = the smoke lost information. Block.
    assert.throws(
      () => assertRuntimeReport(validReport({ snapshotBytes: 0, snapshotMs: 0 })),
      { message: /snapshot produced no bytes and no snapshot error/ },
    )
  })

  test('does NOT tolerate snapshot error when snapshotBytes > 0', () => {
    // If bytes were produced, an error mentioning snapshot is suspicious —
    // treat it as a real error, not a headless artifact.
    assert.throws(
      () => assertRuntimeReport(validReport({
        success: false,
        error: 'snapshot measured failed: partial write',
      })),
      { message: /smoke reported error/ },
    )
  })
})

// ── Cross-module contract: Rust error message vs launcher predicate ──

test('rust snapshot-skip error matches the gate predicate (/snapshot/i)', async () => {
  // The launcher (smoke.mjs:48) uses /snapshot/i to distinguish a headless
  // snapshot failure (tolerated) from a real regression (blocking). The Rust
  // side (browser_panel.rs:752) sets report.error in the skip-snapshot path.
  // If either side changes independently, CI releases silently break — every
  // platform smoke blocks with "smoke reported error" instead of the WARNING.
  // This test pins both sides so the mismatch surfaces locally.
  const rustPath = new URL('../../src-tauri/src/services/browser_panel.rs', import.meta.url)
  const rust = await readFile(rustPath, 'utf8')

  // Find the snapshot-skip section — it is gated by VERBOO_SMOKE_SKIP_SNAPSHOT
  // and sets `report.error = Some("...")` right after the `skip_snapshot` line.
  const skipIdx = rust.indexOf('let skip_snapshot =')
  assert.notStrictEqual(skipIdx, -1,
    'Could not find skip_snapshot variable in browser_panel.rs — ' +
    'the Rust snapshot-skip contract may have been removed or renamed.'
  )

  const afterSkip = rust.slice(skipIdx)
  const errorMatch = afterSkip.match(/report\.error\s*=\s*Some\("([^"]+)"\s*(?:\.into\(\))?\s*\)/)
  assert.notStrictEqual(errorMatch, null,
    'Could not find `report.error = Some("...")` after skip_snapshot in ' +
    'browser_panel.rs. The Rust snapshot-skip error message may have changed ' +
    'its assignment pattern (e.g. to format!()). Update this test to match ' +
    'the new pattern and ensure the JS predicate /snapshot/i still matches.'
  )

  const rustLiteral = errorMatch[1]
  assert.ok(
    /snapshot/i.test(rustLiteral),
    `Rust snapshot-skip error "${rustLiteral}" does not match /snapshot/i. ` +
    'The launcher (smoke.mjs assertRuntimeReport) uses /snapshot/i to ' +
    'identify a headless-snapshot failure and allow it (WARNING, not block). ' +
    'If you changed the Rust error message, update assertRuntimeReport in ' +
    'smoke.mjs so the predicate matches both the old and new messages.'
  )
})
