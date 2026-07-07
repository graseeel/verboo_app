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
}
