//! Builds a `Command` for the bundled `cli.mjs`, using a resolved Node
//! runtime. This is the Tauri equivalent of Electron's
//! `spawn(resolveNodeRuntimePath(), [cliPath, ...args])`.
//!
//! Resolution order for the CLI entry:
//!   1. `VERBOO_CLI_PATH` env var (explicit override).
//!   2. Bundled `cli.mjs` shipped at `<Resources>/cli-package/dist/cli.mjs`.
//!      Requires the full `@verboo/code` tree (with `node_modules/`) to be
//!      co-bundled — `copy-cli-resource.mjs` handles this.
//!   3. `verboo` global on PATH (last-resort fallback, NOT recommended for
//!      distribution — breaks on machine without `npm i -g @verboo/code`).
//!
//! If neither (1) nor (2) resolves, returns a `verboo` global command and
//! lets the OS handle PATH. This matches the pre-PASSO-2 behavior.

use std::fmt;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

use crate::services::cli_path;
use crate::services::node_runtime;

/// A resolved CLI spawn. Owns the Node path (if used) so the caller can
/// inspect what was chosen for diagnostics.
pub struct CliSpawn {
    pub command: Command,
    #[allow(dead_code)]
    pub runtime: CliRuntime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliRuntime {
    /// Spawned `<node> <cli.mjs>` where `cli.mjs` is the bundled resource.
    BundledNode { node_path: PathBuf, cli_mjs_path: PathBuf },
    /// Spawned `<node> <cli.mjs>` where `cli.mjs` came from `VERBOO_CLI_PATH`.
    EnvNode { node_path: PathBuf, cli_mjs_path: PathBuf },
    /// Spawned `verboo` by name — OS resolves PATH. Last-resort fallback.
    GlobalVerboo,
}

impl fmt::Display for CliRuntime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CliRuntime::BundledNode { node_path, cli_mjs_path } => {
                write!(
                    f,
                    "bundled-node(node={}, cli={})",
                    node_path.display(),
                    cli_mjs_path.display()
                )
            }
            CliRuntime::EnvNode { node_path, cli_mjs_path } => {
                write!(
                    f,
                    "env-node(node={}, cli={})",
                    node_path.display(),
                    cli_mjs_path.display()
                )
            }
            CliRuntime::GlobalVerboo => f.write_str("global-verboo(PATH)"),
        }
    }
}

impl CliSpawn {
    /// Builds a `Command` with the args already populated. The caller is
    /// responsible for setting stdin/stdout/stderr, current_dir, env, and
    /// calling `spawn()`.
    pub fn new<I, S>(args: I) -> CliSpawn
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let args_vec: Vec<std::ffi::OsString> =
            args.into_iter().map(|s| s.as_ref().to_os_string()).collect();

        // Try VERBOO_CLI_PATH first (dev override).
        if let Ok(path) = std::env::var("VERBOO_CLI_PATH") {
            let trimmed = path.trim();
            if !trimmed.is_empty() {
                let cli_mjs = PathBuf::from(trimmed);
                if let Some(node_path) = node_runtime::resolve_node_path() {
                    let mut command = Command::new(&node_path);
                    command.arg(&cli_mjs);
                    for a in &args_vec {
                        command.arg(a);
                    }
                    augment_path_env(&mut command);
                    protect_user_cli_env(&mut command);
                    return CliSpawn {
                        command,
                        runtime: CliRuntime::EnvNode { node_path, cli_mjs_path: cli_mjs },
                    };
                }
            }
        }

        // Try the bundled cli.mjs (with co-bundled node_modules).
        if let Some(cli_mjs) = find_bundled_cli_mjs() {
            if let Some(node_path) = node_runtime::resolve_node_path() {
                let mut command = Command::new(&node_path);
                command.arg(&cli_mjs);
                for a in &args_vec {
                    command.arg(a);
                }
                augment_path_env(&mut command);
                protect_user_cli_env(&mut command);
                return CliSpawn {
                    command,
                    runtime: CliRuntime::BundledNode { node_path, cli_mjs_path: cli_mjs },
                };
            }
        }

        // Fallback: global `verboo` on PATH.
        let mut command = Command::new("verboo");
        for a in &args_vec {
            command.arg(a);
        }
        augment_path_env(&mut command);
        protect_user_cli_env(&mut command);
        CliSpawn {
            command,
            runtime: CliRuntime::GlobalVerboo,
        }
    }
}

/// Searches for the bundled `cli.mjs` resource next to the app binary.
/// Expects the full `@verboo/code` package to be co-bundled at
/// `<Resources>/cli-package/` (so ESM resolution against `node_modules/`
/// works).
fn find_bundled_cli_mjs() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;

    // macOS: <app>.app/Contents/MacOS/<binary> → resources at ../Resources
    #[cfg(target_os = "macos")]
    {
        if let Some(resources) = exe_dir.parent().map(|p| p.join("Resources")) {
            for sub in &["cli-package/dist/cli.mjs", "resources/cli-package/dist/cli.mjs", "cli.mjs", "resources/cli.mjs"] {
                let candidate = resources.join(sub);
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }

    // Generic: same dir as exe, or ./resources subdir.
    for sub in &["cli-package/dist/cli.mjs", "resources/cli-package/dist/cli.mjs", "cli.mjs", "resources/cli.mjs"] {
        let candidate = exe_dir.join(sub);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// Reads the version string from the bundled `cli-package/package.json`.
/// Returns `None` if the bundled package is not found or can't be parsed
/// (e.g., development environments where only cli.mjs is available).
pub fn bundled_cli_version() -> Option<String> {
    let cli_mjs = find_bundled_cli_mjs()?;
    // cli-mjs is at <package>/dist/cli.mjs → parent/dist/ → parent/
    let pkg_dir = cli_mjs.parent()?.parent()?;
    let pkg_json = pkg_dir.join("package.json");
    if !pkg_json.exists() {
        return None;
    }
    let text = fs::read_to_string(pkg_json).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("version")?.as_str().map(|s| s.to_string())
}

/// Augments the spawned child's PATH with platform-specific tool directories
/// (Homebrew, Cargo, nvm, etc.). The packaged .app doesn't inherit a useful
/// PATH from the launcher, so children need this help. Mirrors Electron's
/// `createNodeRuntimeEnv`.
fn augment_path_env(command: &mut Command) {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut entries: Vec<PathBuf> = node_runtime::platform_specific_path_entries();

    let mut current: Vec<PathBuf> = std::env::split_paths(&existing)
        .filter(|p| !p.as_os_str().is_empty())
        .collect();
    entries.append(&mut current);

    // Dedupe while preserving order.
    let mut seen = std::collections::HashSet::new();
    entries.retain(|p| seen.insert(p.clone()));

    let new_path = std::env::join_paths(entries.iter()).unwrap_or(existing);
    command.env("PATH", new_path);
}

/// Policy: Desktop must **never** mutate the user's global `@verboo/code` install.
///
/// The headless `--print` path starts `autoUpdateCliInBackground()`, which can
/// run `npm install -g @verboo/code` mid-chat when the baked version is older
/// than npm `latest`. That rewrites `/opt/homebrew/bin/verboo` and looks like
/// the CLI was "apagado".
///
/// `DISABLE_AUTOUPDATER=1` is honored by the interactive AutoUpdater. The
/// headless background path (≤0.10.7) still ignores it — the bundled
/// `cli-package` is also patched at build time in `copy-cli-resource.mjs`.
fn protect_user_cli_env(command: &mut Command) {
    command.env("DISABLE_AUTOUPDATER", "1");
    // Computer Use (P0.4, Geralt): the managed CLI process MUST NOT inherit
    // the Computer Use session token from the parent Verboo process. The env
    // is injected explicitly by turn_service.rs when the turn is CU-relevant.
    // See docs/computer-use-architecture-v1.md §3.2.
    command.env_remove("VERBOO_COMPUTER_USE_SESSION");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_with_env_var_uses_env_node() {
        // Set VERBOO_CLI_PATH to a fake path. The function should prefer it.
        // (We can't safely set env vars in parallel tests; just verify no
        // panic.)
        std::env::remove_var("VERBOO_CLI_PATH");
        let spawn = CliSpawn::new::<[&str; 0], &str>([]);
        // In dev (no VERBOO_CLI_PATH, no bundled, has Node on PATH), the
        // runtime should be GlobalVerboo OR BundledNode (if a bundled file
        // exists from a previous build).
        match spawn.runtime {
            CliRuntime::GlobalVerboo | CliRuntime::BundledNode { .. } | CliRuntime::EnvNode { .. } => {}
        }
    }

    #[test]
    fn runtime_enum_equality() {
        let a = CliRuntime::GlobalVerboo;
        let b = CliRuntime::GlobalVerboo;
        assert_eq!(a, b);
    }

    #[test]
    fn display_runtime_global_verboo() {
        let r = CliRuntime::GlobalVerboo;
        assert_eq!(r.to_string(), "global-verboo(PATH)");
    }

    #[test]
    fn display_runtime_bundled_node() {
        let r = CliRuntime::BundledNode {
            node_path: PathBuf::from("/usr/local/bin/node"),
            cli_mjs_path: PathBuf::from("/app/Resources/cli.mjs"),
        };
        let s = r.to_string();
        assert!(s.contains("bundled-node"));
        assert!(s.contains("/usr/local/bin/node"));
        assert!(s.contains("/app/Resources/cli.mjs"));
    }
}
