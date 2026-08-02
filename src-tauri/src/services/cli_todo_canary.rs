//! T3-TodoWrite-CANARY (2026-07-31) — short-circuit against a specific
//! silent failure mode: the bundled CLI's `cli.mjs` is renamed in a
//! future bump, and our Rust extractor (which pins the literal string
//! `"todowrite"`) silently stops matching.
//!
//! ──────────────────────────────────────────────────────────────────────
//! WHAT DAMAGE THIS TEST PREVENTS
//! ──────────────────────────────────────────────────────────────────────
//! When the CLI renames the TodoWrite tool (e.g. `Todowrite` →
//! `TodoWriteTool` → `PlanTracker`), our `activity_for_tool` and
//! `todos_for_tool` arms no longer hit. The Rust side returns
//! `kind = "tool"` (the fallback `_` arm) and `todos = None`. The
//! renderer, expecting the structured list, has nothing to render, so
//! the cartão do checklist (the checklist card) SUMPLY DISAPPEARS —
//! sem erro, sem log, e a suite continua VERDE porque nossos fixtures
//! usam o nome velho: eles testam a nossa cópia da verdade, NÃO a
//! realidade do bundle. Discovery only happens when the user
//! notices the missing card. Falha silenciosa é o pior tipo —
//! this test is the canary that catches it at the bump.
//!
//! Medido pelo Maestro (2026-07-31) no bundle atual:
//!   - `TodoWrite` 28 vezes
//!   - `todoFeatureEnabled` 2 vezes
//!   - `todo_reminder` 5 vezes
//! All three are load-bearing: `TodoWrite` is the tool name we match,
//! `todoFeatureEnabled` is the feature gate, `todo_reminder` is the
//! reminder type. If any of the three disappears, the feature is
//! gone (or renamed) and the cartao will follow.
//!
//! ──────────────────────────────────────────────────────────────────────
//! METHOD (read the artifact, not our copy of the truth)
//! ──────────────────────────────────────────────────────────────────────
//! Same pattern as `src/renderer/features/composer/reservedSlashCommands
//! .contract.test.ts`: read the bundled artifact as text, assert the
//! markers are present. We do NOT test our Rust code's claim about the
//! tool name — we test the bundle's reality. If the bundle changes,
//! the test fails; if the bundle stays put, the test stays green.
//!
//! ──────────────────────────────────────────────────────────────────────
//! COST (zero in production)
//! ──────────────────────────────────────────────────────────────────────
//! This file is `#[cfg(test)]` only — compiled into the test binary
//! and linked away from `cargo build --release`. Zero runtime cost in
//! the shipped app. The disk walk is: open `cli.mjs` (20MB), read it
//! line by line via `BufReader::read_until(b'\n')`, scan each chunk
//! for the three markers. Never materializes the whole file in a
//! `String` — peak memory is ~8KB (the default buffer) plus the
//! per-line scratch buffer.
//!
//! ──────────────────────────────────────────────────────────────────────
//! RESTRAINT (skip-don't-fail when the bundle is missing)
//! ──────────────────────────────────────────────────────────────────────
//! CI runners without the bundled resource (e.g. an isolated unit-test
//! container that only runs `cargo test --lib` with `src-tauri/`
//! mounted but `resources/` stripped) must NOT see a red here. A
//! false red trains the team to ignore real reds. The test prints
//! a clear skip message and exits with `eprintln` — `cargo test`
//! reports it as "ok" with a notice. The Maestro's discipline is
//! "fail-by-default for the bug we are catching, fail-by-skip for
//! the preconditions we cannot guarantee."

#[cfg(test)]
mod tests {
    use std::fs::File;
    use std::io::{BufRead, BufReader};
    use std::path::PathBuf;

    /// The three load-bearing markers Maestro measured in the bundle
    /// (2026-07-31). Each one is a single identifier substring — no
    /// regex, no anchoring; a plain `bytes/windows` scan. None of them
    /// can contain `\n`, so they cannot straddle the `read_until` chunk
    /// boundary, so we cannot miss them by reading line-by-line.
    ///
    /// The minimum-count asserts are so a wild rename that leaves
    /// behind a single orphan reference (e.g. in a doc comment) still
    /// triggers the failure. We need the tool to LIVE in the bundle,
    /// not to be mentioned once in passing.
    const MARKER_TODO_WRITE: &str = "TodoWrite";
    const MARKER_FEATURE_ENABLED: &str = "todoFeatureEnabled";
    const MARKER_TODO_REMINDER: &str = "todo_reminder";

    /// Minimum occurrences required for each marker. Maestro's
    /// measurements: 28 / 2 / 5. We don't pin those exact counts —
    /// the CLI may add or remove internal users of the names — but
    /// a single hit is dangerously fragile (a code comment can
    /// leave one behind after a rename). Demanding ≥ 2 catches
    /// the orphan-reference case without pinning the bundle's
    /// internal usage pattern.
    const MIN_TODO_WRITE_OCCURRENCES: usize = 2;
    const MIN_FEATURE_ENABLED_OCCURRENCES: usize = 1;
    const MIN_TODO_REMINDER_OCCURRENCES: usize = 2;

    /// Locate the bundled CLI artifact. Lives at
    /// `<src-tauri>/resources/cli-package/dist/cli.mjs` per the
    /// `tauri.conf.json` resources directive. Anchored on
    /// `CARGO_MANIFEST_DIR` so the test works regardless of where
    /// `cargo test` is invoked from.
    fn bundled_cli_mjs_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("cli-package")
            .join("dist")
            .join("cli.mjs")
    }

    /// Stream the file chunk-by-chunk and count hits for each marker.
    /// Returns `None` if the file is missing (caller turns that into a
    /// skip, not a fail). Never builds a full `String` of the file —
    /// each chunk is bounded by the default 8KB `BufReader` buffer.
    ///
    /// Algorithm: `BufReader::read_until(b'\n', &mut buf)` reads one
    /// line at a time (the delimiter is included, but we don't care —
    /// we scan the whole bytes for the marker). Substring search uses
    /// `windows` because the markers are pure ASCII identifiers with
    /// no `\n` and no interior zero bytes, so naive scanning is safe.
    fn count_markers_in_bundled_cli(
        path: &std::path::Path,
    ) -> std::io::Result<Option<(usize, usize, usize)>> {
        let file = match File::open(path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let mut reader = BufReader::new(file);
        let mut buf = Vec::with_capacity(64 * 1024);
        let mut todo_write = 0usize;
        let mut feature_enabled = 0usize;
        let mut todo_reminder = 0usize;

        loop {
            buf.clear();
            let n = reader.read_until(b'\n', &mut buf)?;
            if n == 0 {
                break;
            }
            // Count each marker. We use `windows` (not `memchr`) so
            // the test has zero external dependencies — `memchr`
            // would be faster, but the bundle is ~20MB and a single
            // marked pass takes well under a second on a developer
            // laptop. The point is to be correct, not to be fast.
            todo_write += count_substring(&buf, MARKER_TODO_WRITE.as_bytes());
            feature_enabled += count_substring(&buf, MARKER_FEATURE_ENABLED.as_bytes());
            todo_reminder += count_substring(&buf, MARKER_TODO_REMINDER.as_bytes());
        }

        Ok(Some((todo_write, feature_enabled, todo_reminder)))
    }

    fn count_substring(haystack: &[u8], needle: &[u8]) -> usize {
        if needle.is_empty() || needle.len() > haystack.len() {
            return 0;
        }
        haystack
            .windows(needle.len())
            .filter(|w| *w == needle)
            .count()
    }

    #[test]
    fn bundled_cli_still_exposes_the_todo_feature_markers() {
        // ──────────────────────────────────────────────────────────────────
        // WHAT THIS TEST CATCHES (the line above is the test's reason)
        // ──────────────────────────────────────────────────────────────────
        // When the CLI renames the TodoWrite tool, the cartão do
        // checklist desaparece sem erro e a suite continua verde
        // because our fixtures only validate our Rust code's
        // expectation, not the bundle's reality. This test pins the
        // bundle's reality. If the bundle renames the tool, this
        // test goes red at the bump, not at the user's screen.
        //
        // If this test fails: do NOT weaken the marker list. The
        // feature was renamed or removed. Investigate the bundle
        // diff, decide with the Maestro whether to (a) update the
        // Rust extractor to the new name (and update this canary to
        // the new marker), or (b) confirm the feature is gone and
        // remove the cartao work entirely.
        let path = bundled_cli_mjs_path();
        let counts = match count_markers_in_bundled_cli(&path) {
            Ok(Some(c)) => c,
            Ok(None) => {
                // ── SKIP — file not present in this environment ──
                // CI containers without the bundled resource skip
                // rather than fail. A false red trains the team to
                // ignore real reds — see module-level comment.
                eprintln!(
                    "[cli_todo_canary] SKIP: bundled cli.mjs not found at {} — \
                     this is expected on CI runners without the bundled resource. \
                     On a developer machine with the bundle mounted, this test \
                     asserts the TodoWrite feature markers are present.",
                    path.display()
                );
                return;
            }
            Err(e) => {
                panic!(
                    "cli_todo_canary: failed to read bundled cli.mjs at {}: {}. \
                     If the file is genuinely missing, the test should skip — \
                     investigate why the NotFound branch did not fire.",
                    path.display(),
                    e
                );
            }
        };

        let (todo_write, feature_enabled, todo_reminder) = counts;
        assert!(
            todo_write >= MIN_TODO_WRITE_OCCURRENCES,
            "cli_todo_canary: marker `{MARKER_TODO_WRITE}` found {todo_write} times in bundled cli.mjs, \
             expected ≥ {MIN_TODO_WRITE_OCCURRENCES}. The TodoWrite tool was renamed or removed in the CLI \
             bundle. The Rust extractor (activity_for_tool label \"todowrite\" + todos_for_tool) no longer \
             matches, and the cartao do checklist will silently disappear. Investigate the bundle diff and \
             either: (a) update the Rust extractor to the new tool name AND update this canary to the new \
             marker, or (b) confirm the feature is gone and remove the cartao work."
        );
        assert!(
            feature_enabled >= MIN_FEATURE_ENABLED_OCCURRENCES,
            "cli_todo_canary: marker `{MARKER_FEATURE_ENABLED}` found {feature_enabled} times, \
             expected ≥ {MIN_FEATURE_ENABLED_OCCURRENCES}. The todo feature gate was removed from the CLI. \
             The cartao may still render but the TodoWrite tool will no longer be available."
        );
        assert!(
            todo_reminder >= MIN_TODO_REMINDER_OCCURRENCES,
            "cli_todo_canary: marker `{MARKER_TODO_REMINDER}` found {todo_reminder} times, \
             expected ≥ {MIN_TODO_REMINDER_OCCURRENCES}. The todo reminder type was renamed or removed. \
             This is the marker that proves the agent's mid-task todo nudges still flow through."
        );
    }
}
