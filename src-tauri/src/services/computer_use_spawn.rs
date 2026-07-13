//! Builds a `Command` for the bundled Swift `computer-use-helper` sidecar.
//!
//! Mirrors `cli_spawn.rs` pattern but for the Swift binary at
//! `<Resources>/computer-use-helper-<triple>` (Tauri `externalBin`).
//!
//! Resolution order:
//!   1. `VERBOO_COMPUTER_USE_HELPER` env var (explicit override, dev only).
//!   2. Bundled sidecar at `<Resources>/computer-use-helper-<triple>`.
//!   3. Local dev build at `<src-tauri>/binaries/computer-use-helper-<triple>`.
//!   4. `computer-use-helper-<triple>` on PATH (last resort).

use std::path::PathBuf;
use std::process::Command;

/// Target triple for the current platform. Mirrors Tauri's `externalBin`
/// naming so the same binary works in dev and bundled modes.
fn target_triple() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    { "aarch64-apple-darwin" }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    { "x86_64-apple-darwin" }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    { "x86_64-pc-windows-msvc" }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    { "x86_64-unknown-linux-gnu" }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
    )))]
    { compile_error!("computer-use-helper: unsupported target triple") }
}

pub struct ComputerUseSpawn {
    pub command: Command,
    pub runtime: ComputerUseRuntime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComputerUseRuntime {
    /// Bundled sidecar at `<Resources>/computer-use-helper-<triple>`.
    Bundled { path: PathBuf },
    /// Env override via `VERBOO_COMPUTER_USE_HELPER`.
    Env { path: PathBuf },
    /// Local dev build at `<src-tauri>/binaries/computer-use-helper-<triple>`.
    Dev { path: PathBuf },
    /// Resolved via PATH lookup.
    Path,
}

impl std::fmt::Display for ComputerUseRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ComputerUseRuntime::Bundled { path } => write!(f, "bundled({})", path.display()),
            ComputerUseRuntime::Env { path } => write!(f, "env({})", path.display()),
            ComputerUseRuntime::Dev { path } => write!(f, "dev({})", path.display()),
            ComputerUseRuntime::Path => write!(f, "path"),
        }
    }
}

impl ComputerUseSpawn {
    /// Resolve the helper binary and build a Command ready to spawn.
    /// Stdio MUST be set by the caller (piped for IPC).
    pub fn new() -> Self {
        let triple = target_triple();

        // 1. Env override.
        if let Ok(p) = std::env::var("VERBOO_COMPUTER_USE_HELPER") {
            let path = PathBuf::from(p);
            if path.exists() {
                return Self {
                    command: Command::new(&path),
                    runtime: ComputerUseRuntime::Env { path },
                };
            }
        }

        // 2. Bundled sidecar (release builds).
        if let Some(path) = find_bundled_helper(triple) {
            return Self {
                command: Command::new(&path),
                runtime: ComputerUseRuntime::Bundled { path },
            };
        }

        // 3. Local dev build.
        if let Some(path) = find_dev_helper(triple) {
            return Self {
                command: Command::new(&path),
                runtime: ComputerUseRuntime::Dev { path },
            };
        }

        // 4. PATH lookup.
        let exe_name = format!("computer-use-helper-{triple}");
        Self {
            command: Command::new(&exe_name),
            runtime: ComputerUseRuntime::Path,
        }
    }
}

fn find_bundled_helper(triple: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;

    #[cfg(target_os = "macos")]
    {
        if let Some(resources) = exe_dir.parent().map(|p| p.join("Resources")) {
            for name in ["computer-use-helper".to_string(), format!("computer-use-helper-{triple}")] {
                let candidate = resources.join(name);
                if candidate.exists() { return Some(candidate); }
            }
        }
        let sidecar = exe_dir.join("computer-use-helper");
        if sidecar.exists() { return Some(sidecar); }
    }

    let candidate = exe_dir.join(format!("computer-use-helper-{triple}"));
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

fn find_dev_helper(triple: &str) -> Option<PathBuf> {
    // CARGO_MANIFEST_DIR = src-tauri/ at build time.
    let manifest = option_env!("CARGO_MANIFEST_DIR")?;
    let dev_path = PathBuf::from(manifest)
        .join("binaries")
        .join(format!("computer-use-helper-{triple}"));
    if dev_path.exists() {
        Some(dev_path)
    } else {
        None
    }
}

/// Resolve the absolute path to the computer-use-helper binary, or None if
/// only a PATH-based (unresolvable) fallback exists.
///
/// Resolution order (same as `ComputerUseSpawn::new()`):
///   1. `VERBOO_COMPUTER_USE_HELPER` env var.
///   2. Bundled sidecar at `<Resources>/computer-use-helper[-<triple>]`.
///   3. Local dev build at `<src-tauri>/binaries/computer-use-helper-<triple>`.
///
/// PATH-only resolution returns None (cannot verify it resolves at runtime).
pub fn resolved_helper_path() -> Option<PathBuf> {
    let triple = target_triple();

    // 1. Env override.
    if let Ok(p) = std::env::var("VERBOO_COMPUTER_USE_HELPER") {
        let path = PathBuf::from(p);
        if path.exists() && path.is_file() {
            return Some(path);
        }
    }

    // 2. Bundled sidecar.
    if let Some(path) = find_bundled_helper(triple) {
        return Some(path);
    }

    // 3. Local dev build.
    if let Some(path) = find_dev_helper(triple) {
        return Some(path);
    }

    // 4. PATH — no proof it resolves.
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_triple_matches_host() {
        let t = target_triple();
        // Smoke: contains "apple-darwin", "pc-windows", or "unknown-linux".
        assert!(t.contains("apple-darwin") || t.contains("pc-windows") || t.contains("unknown-linux"));
    }

    #[test]
    fn new_returns_some_runtime() {
        let spawn = ComputerUseSpawn::new();
        // We can't assert which runtime without machine-specific paths,
        // but the Display impl must not panic.
        let _ = spawn.runtime.to_string();
    }

    #[test]
    fn resolved_helper_path_returns_some_in_dev_mode() {
        // On this dev machine the helper should exist at
        // <src-tauri>/binaries/computer-use-helper-<triple>.
        let path = resolved_helper_path();
        assert!(path.is_some(), "expected dev build to exist on this machine");
        assert!(path.as_ref().map_or(false, |p| p.is_file()), "resolved path is not a file");
    }
}
