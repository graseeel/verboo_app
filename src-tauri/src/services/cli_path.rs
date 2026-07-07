use std::path::PathBuf;

/// Resolves the path to the `verboo` CLI executable.
///
/// Resolution order:
///   1. `VERBOO_CLI_PATH` env var (explicit override — used in dev)
///   2. `verboo` on PATH (system install — `npm i -g @verboo/code`)
///      — the safe default. The bundled CLI is intentionally not used
///      because Node ESM resolution requires a co-bundled `node_modules/`,
///      which isn't shipped with the .app. Direct execution of the bundled
///      file fails with `ERR_MODULE_NOT_FOUND` for `@aws-sdk/client-bedrock-*`
///      and similar transitive deps.
///
/// Returns `None` only if (1) is unset. The caller falls back to spawning
/// `verboo` by name and letting the OS resolve PATH.
///
/// To use a bundled CLI for development, set `VERBOO_CLI_PATH` to its
/// absolute path.
pub fn resolve() -> Option<String> {
    if let Ok(path) = std::env::var("VERBOO_CLI_PATH") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// Searches for a bundled `cli.mjs` resource next to the app binary.
/// Returns the path if found. Currently unused by `resolve()` (see the
/// docstring above) but kept exported for tools / future implementations.
#[allow(dead_code)]
pub fn find_bundled_cli() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;

    // macOS: <app>.app/Contents/MacOS/<binary> → resources at ../Resources
    #[cfg(target_os = "macos")]
    {
        if let Some(resources) = exe_dir.parent().map(|p| p.join("Resources")) {
            // Direct: <Resources>/cli.mjs
            let candidate = resources.join("cli.mjs");
            if candidate.exists() {
                return Some(candidate);
            }
            // Tauri places "resources" entries under <Resources>/resources/.
            let candidate = resources.join("resources").join("cli.mjs");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    // Generic: same directory as exe.
    let candidate = exe_dir.join("cli.mjs");
    if candidate.exists() {
        return Some(candidate);
    }
    // Generic: ./resources subdirectory.
    let candidate = exe_dir.join("resources").join("cli.mjs");
    if candidate.exists() {
        return Some(candidate);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_returns_none_when_no_env_and_no_bundled() {
        // In the test environment, VERBOO_CLI_PATH is unset and there's no
        // bundled cli.mjs next to the test binary. This should return None.
        // (If the env var happens to be set in the test runner, we skip.)
        if std::env::var("VERBOO_CLI_PATH").is_ok() {
            return;
        }
        assert!(resolve().is_none() || find_bundled_cli().is_some());
    }
}
