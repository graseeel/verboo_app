/**
 * D-D cross-fence contract test (2026-07-31).
 *
 * ──────────────────────────────────────────────────────────────────────
 * WHAT THIS TEST PROTECTS
 * ──────────────────────────────────────────────────────────────────────
 * The Rust bypass at `services/turn_service.rs::build_prompt_internal`
 * only fires for commands listed in the Rust `RESERVED_SLASH_COMMANDS`
 * slice. Commands NOT in that slice get wrapped by the workspace/app-
 * instructions prefix and the CLI's native interceptor never fires.
 *
 * The renderer side declares its reserved commands in
 * `features/composer/slashCommands.ts::RESERVED_COMMANDS`. If someone
 * adds a NEW reserved command on the renderer side that gets
 * dispatched to the CLI's --print path (i.e., goes through
 * `runTurn` / `createQueuedFollowUp` in App.tsx), they MUST also add
 * the same name to the Rust slice. If they forget, the new command
 * silently dies — wrapped by the prefix and routed to the model as
 * text. The user sees the model respond ABOUT the command instead of
 * the command firing.
 *
 * This is exactly how /compact was broken until the D-D fix: the
 * renderer side added `/compact` as a reserved command, but the
 * Rust side's bypass list didn't know about it. The new test
 * ensures that the two sides stay in sync.
 *
 * ──────────────────────────────────────────────────────────────────────
 * WHO WROTE THIS TEST
 * ──────────────────────────────────────────────────────────────────────
 * The src-tauri fence (PERISCOPIO) is normally forbidden from touching
 * src/renderer/** (MOSAICO's fence). This test is a PONTUAL EXCEPTION
 * — written by the src-tauri fence as a one-off, with the
 * authorization noted by the Maestro in the D-D cycle. It is NOT a
 * relaxation of the fence; future src-tauri work should still defer
 * cross-fence tests to MOSAICO unless the Maestro grants another
 * explicit exception.
 *
 * ──────────────────────────────────────────────────────────────────────
 * WHY THIS MORA HERE (not in src-tauri/src)
 * ──────────────────────────────────────────────────────────────────────
 * The boundary is symmetric — Rust declares the bypass list, the
 * renderer declares the dispatch list — but the FRONTIER is in the
 * renderer: it is the renderer that decides whether a slash command
 * goes to the CLI or stays renderer-side. Without a renderer-side
 * test, a renderer-only change (adding a new `handleCompact`-style
 * dispatch) could silently break the Rust bypass contract. Living
 * in vitest means the test runs in the renderer's normal test cycle,
 * catching the regression at the point where the new dispatch is
 * introduced.
 *
 * ──────────────────────────────────────────────────────────────────────
 * METHOD (source-text comparison)
 * ──────────────────────────────────────────────────────────────────────
 * Same pattern as `features/goal/rustSerdeContract.test.ts`: read the
 * Rust source as text, read the renderer source as text, parse the
 * declarations, compare. Runtime introspection does not work here
 * because:
 *   - TypeScript types are erased at compile time — we cannot read
 *     `RESERVED_COMMANDS` through a typed import and confirm its
 *     contents at runtime (we CAN read it via getReservedSlashCommandNames()
 *     but that is a different concern from the source contract).
 *   - Rust const slices have no JS-equivalent runtime representation
 *     in the renderer — we MUST read the .rs file as text.
 */

import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ─── Source-file loaders (text only — no transpile, no runtime import) ──

const TURN_SERVICE_RS =
  'src-tauri/src/services/turn_service.rs'

const SLASH_COMMANDS_TS =
  'src/renderer/features/composer/slashCommands.ts'

const APP_TSX = 'src/renderer/App.tsx'

function readRepoFile(relPath: string): string {
  // vitest runs from the renderer/ directory; resolve against cwd.
  const abs = path.resolve(process.cwd(), relPath)
  // Strip \r so //.*$ regex comment stripping works on Windows (CRLF).
  return fs.readFileSync(abs, 'utf8').replace(/\r/g, '')
}

// ─── Parsers ────────────────────────────────────────────────────────────

/**
 * Extract the entries of the Rust `RESERVED_SLASH_COMMANDS` const
 * slice from `turn_service.rs`. Returns the literal strings inside
 * the slice, in declaration order.
 *
 * The parser is intentionally simple: it locates the `const
 * RESERVED_SLASH_COMMANDS: &[&str] = &[ ... ];` block, then grabs
 * every `"/..."` literal on a NON-COMMENT line. Whitespace between
 * entries is tolerated; doc comments (`// ...`) containing quoted
 * strings (e.g. `status:"compacting"` referenced in the bypass
 * documentation) are excluded.
 */
function extractRustReservedSlashCommands(rustSource: string): string[] {
  const startMarker = 'const RESERVED_SLASH_COMMANDS: &[&str] = &['
  const startIdx = rustSource.indexOf(startMarker)
  if (startIdx < 0) {
    throw new Error(
      `D-D contract: could not find \`const RESERVED_SLASH_COMMANDS\` declaration in turn_service.rs. ` +
      `The Rust bypass list must remain a const slice named exactly RESERVED_SLASH_COMMANDS.`
    )
  }
  const bodyStart = startIdx + startMarker.length
  const endIdx = rustSource.indexOf('];', bodyStart)
  if (endIdx < 0) {
    throw new Error(
      `D-D contract: RESERVED_SLASH_COMMANDS const slice is missing its closing \`];\` in turn_service.rs.`
    )
  }
  const body = rustSource.slice(bodyStart, endIdx)
  const results: string[] = []
  for (const rawLine of body.split('\n')) {
    // Strip the Rust line comment (// ...) to avoid capturing
    // quoted strings inside doc comments — e.g. the bypass doc
    // mentions `status:"compacting"` and we'd otherwise treat that
    // as a literal entry.
    const codeOnly = rawLine.replace(/\/\/.*$/, '')
    const matches = codeOnly.match(/"([^"]+)"/g) ?? []
    for (const s of matches) {
      results.push(s.slice(1, -1))
    }
  }
  return results
}

/**
 * Extract the entries of the renderer's `RESERVED_COMMANDS` set
 * from `slashCommands.ts`. Returns the literal strings inside the
 * set, in declaration order.
 */
function extractRendererReservedCommands(tsSource: string): string[] {
  // The const is `const RESERVED_COMMANDS = new Set([...])`. We
  // locate the array literal and grab every 'name' string.
  const startMarker = 'new Set(['
  const startIdx = tsSource.indexOf(startMarker)
  if (startIdx < 0) {
    throw new Error(
      `D-D contract: could not find \`new Set([...])\` declaration for RESERVED_COMMANDS in slashCommands.ts.`
    )
  }
  const bodyStart = startIdx + startMarker.length
  const endIdx = tsSource.indexOf('])', bodyStart)
  if (endIdx < 0) {
    throw new Error(
      `D-D contract: RESERVED_COMMANDS set literal is missing its closing \`]) in slashCommands.ts.`
    )
  }
  const body = tsSource.slice(bodyStart, endIdx)
  const matches = body.match(/'([^']+)'/g) ?? []
  return matches.map(s => s.slice(1, -1))
}

/**
 * Detect every renderer-reserved command name that is dispatched to
 * the CLI's --print path. The detection looks for the pattern
 *
 *   `/<name>` or `/<name> ${...}`
 *
 * inside `App.tsx`, in code (NOT comment lines) that follows
 * (within ~30 lines) a call to `createQueuedFollowUp(...)` or
 * `runTurn(...)`. The heuristic mirrors the actual D-D bug:
 * /compact was constructed in handleCompactCommand and dispatched
 * via runTurn (App.tsx:2910-2915).
 *
 * Comment exclusion is load-bearing: the doc comment on
 * handleCompactCommand mentions `/goal` and `/pet` as comparison
 * points ("reserved system command like /goal and /pet"), and a
 * naive 30-line window from createQueuedFollowUp would catch that
 * comment and falsely classify /goal as CLI-dispatching.
 *
 * Returns the names of all CLI-dispatching commands found, in the
 * order they appear in App.tsx.
 */
function extractCliDispatchingReservedCommands(
  tsSource: string,
  rendererReservedNames: string[],
): string[] {
  const reservedSet = new Set(rendererReservedNames)
  const reservedAlternation = Array.from(reservedSet)
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')

  // Match `/<name>` followed by a word boundary, whitespace, EOL, or
  // the start of a template-literal expression `${`.
  const slashPrefixPattern = new RegExp(
    String.raw`/(${reservedAlternation})(\b|\s|$|\$\{)`,
    'g',
  )

  // Block comments MUST be stripped before line iteration — the
  // JSDoc above handleCompactCommand (App.tsx:2885-2890) lists
  // "/compact — reserved system command (like /goal and /pet)" as
  // documentation, and a 30-line window from createQueuedFollowUp
  // at line 2910 captures ALL THREE as "near-dispatch" sites.
  // `/* ... */` blocks can span multiple lines so the strip must
  // operate on the full source first; only THEN per-line.
  //
  // The regex is non-greedy with the `s` flag (dot-matches-newline)
  // so the smallest block is captured. Line comments are stripped
  // per-line below.
  const codeNoBlocks = tsSource.replace(/\/\*[\s\S]*?\*\//g, '')

  const lines = codeNoBlocks.split('\n')
  const dispatchSites: { line: number; name: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    // Strip the TS line comment (`// ...`).
    const codeOnly = rawLine.replace(/\/\/.*$/, '')
    const linePattern = new RegExp(slashPrefixPattern.source, 'g')
    let m: RegExpExecArray | null
    while ((m = linePattern.exec(codeOnly)) !== null) {
      dispatchSites.push({ line: i + 1, name: m[1] })
    }
  }

  const dispatched = new Set<string>()
  for (const site of dispatchSites) {
    const windowEnd = Math.min(lines.length, site.line + 30)
    for (let i = site.line - 1; i < windowEnd; i++) {
      const line = lines[i]
      if (
        /\bcreateQueuedFollowUp\s*\(/.test(line) ||
        /\brunTurn\s*\(/.test(line)
      ) {
        dispatched.add(site.name)
        break
      }
    }
  }

  // Diagnostic: log every dispatch site found and the window used.
  // Helps diagnose false positives without re-running tests blind.
  // Always printed (vitest shows console output for passing and
  // failing tests alike).
  if (process.env.VITEST_CONTRACT_DEBUG === '1') {
    // eslint-disable-next-line no-console
    console.log(
      `[contract-debug] dispatch sites: ${JSON.stringify(dispatchSites)}\n` +
      `[contract-debug] dispatched: ${JSON.stringify(Array.from(dispatched))}\n` +
      `[contract-debug] renderer commands: ${JSON.stringify(rendererReservedNames)}`,
    )
  }

  return rendererReservedNames.filter(n => dispatched.has(n))
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('D-D cross-fence contract: RESERVED_SLASH_COMMANDS ↔ renderer reserved commands', () => {
  const rustSource = readRepoFile(TURN_SERVICE_RS)
  const rendererSource = readRepoFile(SLASH_COMMANDS_TS)
  const appSource = readRepoFile(APP_TSX)

  const rustCommands = extractRustReservedSlashCommands(rustSource)
  const rendererCommands = extractRendererReservedCommands(rendererSource)
  const dispatchingCommands = extractCliDispatchingReservedCommands(
    appSource,
    rendererCommands,
  )

  // Sanity: the extractors must find what they advertise to find.
  // If any of these is empty, the test set-up itself is broken — the
  // assertions below would silently pass against an empty baseline.
  it('extracts the Rust bypass list (turn_service.rs::RESERVED_SLASH_COMMANDS)', () => {
    expect(rustCommands.length).toBeGreaterThan(0)
  })

  it('extracts the renderer reserved set (slashCommands.ts::RESERVED_COMMANDS)', () => {
    expect(rendererCommands.length).toBeGreaterThan(0)
  })

  it('finds at least one CLI-dispatching reserved command in App.tsx', () => {
    expect(dispatchingCommands.length).toBeGreaterThan(0)
  })

  // ── Direction 1: Rust ⊆ Renderer ────────────────────────────────────
  // Every name in Rust's bypass list must also exist in the
  // renderer's reserved set. If someone adds `/foo` to Rust without
  // adding `foo` to the renderer, the bypass will fire on text the
  // renderer never intended to be a slash command — possibly
  // wrapping it RAW past the prefix when it should have been wrapped.
  it('every Rust reserved slash command has a renderer counterpart', () => {
    for (const cmd of rustCommands) {
      const stripped = cmd.startsWith('/') ? cmd.slice(1) : cmd
      expect(
        rendererCommands,
        `Rust bypass entry \`${cmd}\` (stripped: \`${stripped}\`) has no renderer counterpart in slashCommands.ts::RESERVED_COMMANDS. ` +
        `Either add \`${stripped}\` to the renderer set, or remove the Rust entry.`
      ).toContain(stripped)
    }
  })

  // ── Direction 2: every CLI-dispatching renderer name ⊆ Rust ─────────
  // The D-D field defect: a renderer command dispatched to the CLI
  // but missing from the Rust bypass list gets wrapped by the
  // workspace/app-instructions prefix and silently dies. This is
  // the test that catches a renderer-only addition.
  it('every CLI-dispatching renderer reserved command is in the Rust bypass list', () => {
    const rustStripped = rustCommands.map(c =>
      c.startsWith('/') ? c.slice(1) : c,
    )
    for (const cmd of dispatchingCommands) {
      expect(
        rustStripped,
        `Renderer command \`/${cmd}\` is dispatched to the CLI (found near createQueuedFollowUp/runTurn in App.tsx) ` +
        `but is NOT in turn_service.rs::RESERVED_SLASH_COMMANDS. The bypass will not fire and the prompt will be ` +
        `prefixed, breaking the CLI's native interceptor. Add \`/${cmd}\` to the Rust slice.`
      ).toContain(cmd)
    }
  })

  // ── Direction 3: explicit witness for the original D-D bug ──────────
  // The MEDICAO 2026-07-30 measurement proved `/compact` is a
  // native CLI command. The handleCompactCommand in App.tsx:2892
  // dispatches it via runTurn. The bypass MUST contain /compact or
  // the original bug recurs.
  it('the original D-D bug stays fixed: /compact is in the Rust bypass list', () => {
    expect(rustCommands).toContain('/compact')
  })
})