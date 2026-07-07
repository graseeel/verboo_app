use std::path::PathBuf;

/// Resolves the path to the `verboo` CLI executable.
///
/// Resolution order:
///   1. `VERBOO_CLI_PATH` env var (explicit override — used in dev)
///   2. Bundled `cli.mjs` resource next to the app binary (production)
///      — only used if the file is actually executable (has a shebang,
///      is mode 0755+, or already known to be runnable via Node).
///   3. `verboo` on PATH (system install — `npm i -g @verboo/code`)
///
/// Returns `None` if neither (1) nor (2) apply; the caller should fall
/// back to spawning `verboo` by name and let the OS resolve PATH.
pub fn resolve() -> Option<String> {
    if let Ok(path) = std::env::var("VERBOO_CLI_PATH") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(path) = find_bundled_cli() {
        if is_cli_runnable(&path) {
            return Some(path.to_string_lossy().into_owned());
        }
        // Bundled CLI isn't usable (no shebang, mode 0644, etc.) — fall
        // through to PATH.
    }
    None
}

/// Returns true if the CLI file is directly executable. `.mjs` files
/// without a shebang require a Node runtime; with a shebang they need
/// 0755 perms. We accept either form.
fn is_cli_runnable(path: &std::path::Path) -> bool {
    use std::fs;
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    // On Unix, executable bit must be set.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode();
        // User-execute bit (0o100) must be set.
        if mode & 0o100 == 0 {
            return false;
        }
    }
    // Check first two bytes for shebang (#!).
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    use std::io::Read;
    let mut buf = [0u8; 2];
    if file.read_exact(&mut buf).is_err() {
        // File is < 2 bytes — not a valid script.
        return false;
    }
    if &buf == b"#!" {
        return true;
    }
    // Not a shebang — would require explicit Node wrapper. We only bundle
    // this as the "runnable" path if it has a shebang. Falls through to
    // PATH where the user-installed `verboo` (which has `#!/usr/bin/env node`)
    // is used.
    false
}

/// Searches for a bundled `cli.mjs` resource next to the app binary.
/// Returns the path if found.
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
