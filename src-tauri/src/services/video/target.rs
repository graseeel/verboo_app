//! Maps the current host's Rust target triple to the string used in
//! bundled sidecar filenames (e.g. `verboo-ffprobe-aarch64-apple-darwin`).
//!
//! A1c (2026-07-30): previously this function was duplicated verbatim in
//! `probe.rs`, `prepare.rs`, and `router.rs`. The duplication had already
//! diverged in spirit (one had `"unsupported"`, another had `"unknown"`)
//! and would have diverged in practice the moment someone fixed only one
//! side. Centralized here as the single source of truth.
//!
//! Returns `None` for platforms without a published sidecar. Callers
//! propagate the `None` as their own explicit error (which platform is
//! unsupported) rather than fabricating an invalid filename like
//! `verboo-ffprobe-unsupported` that fails later with a confusing
//! "file not found" far from the root cause.

/// Returns the host's Rust target triple as it appears in the sidecar
/// filename, or `None` if the host has no published sidecar.
///
/// Keep this list in sync with the release matrix in PRENSA's
/// `tauri.conf.json` bundling config — each published target needs a
/// matching entry here. CI does not currently enforce this coupling;
/// a future hardening would grep the release matrix and assert coverage.
pub fn host_target() -> Option<&'static str> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return Some("aarch64-apple-darwin");
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return Some("x86_64-apple-darwin");
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return Some("x86_64-pc-windows-msvc");
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    return Some("aarch64-pc-windows-msvc");
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return Some("x86_64-unknown-linux-gnu");
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return Some("aarch64-unknown-linux-gnu");
    // No published sidecar for this host. Do NOT fabricate a string
    // here — the previous `&'static str` return with `"unsupported"`
    // fallback produced filenames like `verboo-ffprobe-unsupported`
    // that failed later with a confusing "file not found" far from the
    // actual cause (platform not supported). Returning `None` forces
    // callers to surface the platform identity to the user.
    #[allow(unreachable_code)]
    {
        let _ = "unsupported";
        None
    }
}

/// Platform-specific binary suffix (`.exe` on Windows, empty elsewhere).
/// Kept here next to `host_target` because both pieces are used to
/// construct the same sidecar filename.
pub fn executable_suffix() -> &'static str {
    if cfg!(windows) {
        ".exe"
    } else {
        ""
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The function MUST return `Some` on every platform the release
    /// matrix publishes. This is a canary: if a new published target is
    /// added to PRENSA's bundling config without a matching `#[cfg]`
    /// arm here, CI on that platform will panic with a clear message
    /// rather than silently falling back to a fabricated filename.
    ///
    /// A1c (2026-07-30): added `aarch64-unknown-linux-gnu` because the
    /// PRENSA Linux Docker container (Mac Apple Silicon) runs on this
    /// triple. The previous function returned "unsupported" here,
    /// which produced `verboo-ffprobe-unsupported` and failed with
    /// "file not found" — the symptom that hid the real cause.
    #[test]
    fn host_target_returns_some_on_published_platforms() {
        // On CI we can only test the CURRENT host. This test is a
        // canary for whatever platform cargo test runs on. The full
        // matrix coverage comes from PRENSA's release matrix run.
        let target = host_target();
        assert!(
            target.is_some(),
            "host_target() returned None on host {}. This means the \
             current host has no published sidecar. If this host is in \
             the release matrix, add the matching #[cfg] arm. If it's \
             NOT in the release matrix, this test running on it is the \
             real problem (CI is on an unsupported platform).",
            std::env::consts::OS,
        );
    }

    /// Divergence guard: all callers (currently probe, prepare, router)
    /// MUST import from `super::target` — not define their own copy.
    /// If someone adds a fourth `host_target` definition in a sibling
    /// module (or OUTSIDE video/), this test catches it before the
    /// duplication silently diverges.
    ///
    /// A1c (2026-07-30): REWRITTEN from a hardcoded 7-file list to a
    /// recursive auto-scan of `src-tauri/src/`. The previous manual
    /// list had the exact defect CADINHO flagged: a `host_target`
    /// defined in a file NOT in the list (e.g., the next developer
    /// creating a fourth copy somewhere unexpected) would be invisible
    /// to the guard. Now any `.rs` file under `src-tauri/src/` is
    /// scanned.
    ///
    /// Reuses the recursive walk pattern from `child_signal.rs`
    /// (`collect_rs_files`) which is the established convention in
    /// this codebase for auto-scanning guards.
    ///
    /// Runs on every OS (no platform-specific dependencies). The walk
    /// starts at `src-tauri/src/`, which is the source-of-truth crate
    /// root.
    #[test]
    fn host_target_defined_only_here() {
        scan_for_duplicate_and_panic(
            "fn host_target(",
            "host_target",
            "This function must only be defined in src/services/video/target.rs \
             and consumed via `use super::target::host_target;`. The previous \
             duplication (probe.rs/prepare.rs/router.rs) was the defect class — \
             fix the new duplicate by importing from the shared module instead.",
        );
    }

    /// Divergence guard for `executable_suffix`: same rationale. Both
    /// pieces construct the same sidecar filename, so they live next
    /// to each other and must be consumed together.
    #[test]
    fn executable_suffix_defined_only_here() {
        scan_for_duplicate_and_panic(
            "fn executable_suffix(",
            "executable_suffix",
            "This function must only be defined in src/services/video/target.rs \
             and consumed via `use super::target::executable_suffix;`.",
        );
    }

    /// Shared helper for both divergence guards. Recursively scans
    /// every `.rs` file under `src-tauri/src/`, slices at the test
    /// module boundary (the `#[cfg(test)]` immediately preceding
    /// `mod tests`), and panics if `signature` appears in production
    /// code OUTSIDE of `target.rs` itself.
    ///
    /// Excluded files: `target.rs` (the single source of truth — the
    /// guard scans every file EXCEPT this one). All other `.rs` files
    /// are scanned, including ones outside the `video/` module.
    fn scan_for_duplicate_and_panic(
        signature: &str,
        fn_name: &str,
        remediation: &str,
    ) {
        fn find_test_module_boundary(src: &str) -> Option<usize> {
            let mod_idx = src.find("mod tests")?;
            let prefix = &src[..mod_idx];
            prefix.rfind("#[cfg(test)]")
        }

        fn collect_rs_files(
            dir: &std::path::Path,
            out: &mut Vec<std::path::PathBuf>,
        ) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    collect_rs_files(&path, out);
                } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                    out.push(path);
                }
            }
        }

        let crate_root = std::path::Path::new("src");
        let mut all_rs: Vec<std::path::PathBuf> = Vec::new();
        collect_rs_files(crate_root, &mut all_rs);
        all_rs.sort();

        // The file that owns the single source of truth. Excluded
        // from scanning — the guard exists to catch duplicates
        // EVERYWHERE ELSE.
        let own_path =
            std::path::Path::new("src/services/video/target.rs");

        for path in &all_rs {
            // Skip the definition site.
            if path == own_path {
                continue;
            }
            let Ok(src) = std::fs::read_to_string(path) else {
                continue;
            };
            // Slice at the test module boundary. Naive
            // `find("#[cfg(test)]")` is wrong because `#[cfg(test)]`
            // can appear inside production code for test-only
            // imports/fields. The boundary is the `#[cfg(test)]`
            // immediately preceding `mod tests`.
            let production: &str = match find_test_module_boundary(&src) {
                Some(idx) => &src[..idx],
                None => &src[..],
            };
            if production.contains(signature) {
                panic!(
                    "A1c divergence guard FAIL: {} contains its own \
                     `{signature}` definition.\n\n\
                     {remediation}\n\n\
                     Auto-scan covered the entire src-tauri/src/ tree \
                     ({} files scanned); the guard catches duplicates \
                     anywhere in the crate, not just in video/.",
                    path.display(),
                    all_rs.len()
                );
            }
            let _ = fn_name;
        }
    }
}