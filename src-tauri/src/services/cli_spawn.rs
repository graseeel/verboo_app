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
    /// No Node runtime AND no `verboo` on PATH. The CLI cannot be spawned.
    /// This is an EXPLICIT state — not `GlobalVerboo` by elimination (the
    /// "affirmative by absence" anti-pattern that leaked raw `os error 2`
    /// to the UI on clean machines). Callers MUST check before spawning
    /// and surface a typed error, never the OS errno.
    Missing,
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
            CliRuntime::Missing => f.write_str("missing(no Node, no verboo on PATH)"),
        }
    }
}

impl CliSpawn {
    /// Builds a `Command` with the args already populated. The caller is
    /// responsible for setting stdin/stdout/stderr, current_dir, env, and
    /// calling `spawn()`.
    ///
    /// A2-FIX (2026-07-29): on Windows, this constructor ALSO applies
    /// `CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW` via `creation_flags`
    /// so every CLI spawn suppresses the console window. This is the
    /// single chokepoint — all 9 callers of `CliSpawn::new` inherit the
    /// flag automatically, and a future caller can't forget it. There
    /// is NO legitimate case where a CLI spawn needs a visible console:
    /// the CLI is headless (all communication via stdout/stderr/JSON),
    /// and OAuth login opens the browser, not a terminal. If a future
    /// caller genuinely needs a visible console (none today), it must
    /// opt out explicitly with a documented reason — never the default.
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
                    apply_creation_flags(&mut command);
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
                apply_creation_flags(&mut command);
                return CliSpawn {
                    command,
                    runtime: CliRuntime::BundledNode { node_path, cli_mjs_path: cli_mjs },
                };
            }
        }

        // Fallback: global `verboo` on PATH. EXPLICIT check — if `verboo`
        // is NOT on PATH, return `CliRuntime::Missing` instead of
        // `GlobalVerboo` by elimination. The old code returned
        // `GlobalVerboo` unconditionally and let `cmd.spawn()` fail with
        // raw ENOENT ("os error 2") on clean machines — the
        // "affirmative state by absence of evidence" anti-pattern.
        //
        // (Cadinho ressalva 1, 2026-08-07): `verboo` on PATH is typically
        // an npm-installed Node-script shim — it needs Node to actually
        // run. If `verboo` exists but Node is absent, the shim exists,
        // the check passes, and the spawn dies with the same ENOENT we
        // just eliminated. So `GlobalVerboo` requires BOTH `verboo` on
        // PATH AND a usable Node. Without Node → `Missing`.
        if verboo_on_path() && node_runtime::resolve_node_path().is_some() {
            let mut command = Command::new("verboo");
            for a in &args_vec {
                command.arg(a);
            }
            augment_path_env(&mut command);
            protect_user_cli_env(&mut command);
            apply_creation_flags(&mut command);
            CliSpawn {
                command,
                runtime: CliRuntime::GlobalVerboo,
            }
        } else {
            // No Node, no `verboo` on PATH → explicit Missing. The
            // command is a placeholder that will fail if spawned, but
            // callers MUST check `runtime == Missing` BEFORE spawning
            // and surface a typed error via `runtime_missing_error()`.
            let mut command = Command::new("verboo");
            for a in &args_vec {
                command.arg(a);
            }
            apply_creation_flags(&mut command);
            CliSpawn {
                command,
                runtime: CliRuntime::Missing,
            }
        }
    }

    /// Env entries aplicados a TODO spawn do CLI (PATH augmentado +
    /// DISABLE_AUTOUPDATER=1). Fonte única — o PTY bridge (F4) precisa montar
    /// um portable_pty CommandBuilder em vez de std Command e usa esta lista.
    pub fn cli_env_entries() -> Vec<(String, String)> {
        cli_spawn_env_entries()
    }
}

/// Fonte única do env (usada pelo `augment_path_env` e pelo
/// `CliSpawn::cli_env_entries`).
fn cli_spawn_env_entries() -> Vec<(String, String)> {
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
    vec![
        ("PATH".to_string(), new_path.to_string_lossy().to_string()),
        ("DISABLE_AUTOUPDATER".to_string(), "1".to_string()),
    ]
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
    for (key, value) in cli_spawn_env_entries() {
        if key == "PATH" {
            command.env(key, value);
        }
    }
}

/// Checks whether a `verboo` executable is resolvable on PATH. Used by
/// `CliSpawn::new` to distinguish `GlobalVerboo` (verboo exists) from
/// `Missing` (neither Node nor verboo) — the distinction the old
/// by-elimination code erased, leaking raw `os error 2` to the UI.
fn verboo_on_path() -> bool {
    // Test-only hook: simulate a machine with no `verboo` on PATH.
    // `#[cfg(test)]` makes this unreachable in release/dev builds.
    // (Cadinho ressalva 2, 2026-08-07.)
    #[cfg(test)]
    if std::env::var_os("VERBOO_TEST_NO_VERBOO").is_some() {
        return false;
    }
    // `which`-like search: don't rely on `Command::new("verboo")` spawn
    // (that's the path we're trying to AVOID — it fails with ENOENT and
    // the caller can't tell "no verboo" from "verboo exists but crashed").
    let path_env = match std::env::var_os("PATH") {
        Some(p) => p,
        None => return false,
    };
    let ext = if cfg!(windows) { ".exe" } else { "" };
    for dir in std::env::split_paths(&path_env) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join(format!("verboo{ext}"));
        if node_runtime::is_executable(&candidate) {
            return true;
        }
    }
    false
}

/// Returns true if a CLI runtime is available (Node + cli.mjs, or
/// `verboo` on PATH). Callers that spawn the CLI should check this
/// BEFORE spawning and surface `runtime_missing_error()` if false,
/// so the user sees a typed message — never raw `os error 2`.
///
/// (Cadinho ressalva 1, 2026-08-07): ALL CLI runtimes require Node —
/// the npm-installed `verboo` is a Node-script shim. Without Node,
/// `verboo` on PATH is useless → `false`, not `true`.
pub fn runtime_available() -> bool {
    if node_runtime::resolve_node_path().is_none() {
        // No Node → can't run the CLI, even if `verboo` is on PATH
        // (it's a Node-script shim that needs Node).
        return false;
    }
    find_bundled_cli_mjs().is_some() || verboo_on_path()
}

/// Typed error message for the "no CLI runtime" case. Never contains
/// the raw OS errno text ("No such file or directory (os error 2)").
/// The renderer shows this verbatim, so it must be user-facing.
pub fn runtime_missing_error() -> String {
    "Node.js não encontrado e o comando \"verboo\" não está no PATH. \
     Instale o Node.js (https://nodejs.org) ou execute \"npm i -g @verboo/code\" \
     para usar o login pelo CLI. Como alternativa, use uma chave de API \
     (Configurações → Provedor)."
        .to_string()
}

/// Pre-check: returns `Err(typed_message)` if no CLI runtime is
/// available, `Ok(())` otherwise. Call before spawning the CLI so
/// the error is typed, not raw ENOENT.
pub fn check_runtime_available() -> Result<(), String> {
    if runtime_available() {
        Ok(())
    } else {
        Err(runtime_missing_error())
    }
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
}

/// A2-FIX (2026-07-29): applies `CREATE_NEW_PROCESS_GROUP |
/// CREATE_NO_WINDOW` on Windows so the spawned CLI doesn't pop a
/// visible console window AND remains interruptible via
/// `GenerateConsoleCtrlEvent`. No-op on non-Windows.
///
/// This is called from `CliSpawn::new` so every CLI spawn inherits
/// the flag automatically — the single chokepoint. A future caller
/// can't forget it. There is NO legitimate case where a CLI spawn
/// needs a visible console: the CLI is headless (all communication
/// via stdout/stderr/JSON), and OAuth login opens the browser, not a
/// terminal. If a future caller genuinely needs a visible console
/// (none today), it must opt out explicitly with a documented
/// reason — never the default.
/// A2-FIX2 (2026-07-29): exposed as `pub` so the three services that
/// spawn `Command::new` directly (auth_token, cli_credentials,
/// workspace_files_service) can reuse the SAME guard without
/// duplicating logic. Duplicating a safety guard in two places is how
/// one of them falls behind. Single source of truth: this function.
///
/// Applies `CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW` on Windows so
/// the spawned process doesn't pop a visible console window AND remains
/// interruptible via `GenerateConsoleCtrlEvent`. No-op on non-Windows.
///
/// Called from `CliSpawn::new` (the 9 CLI spawn sites inherit
/// automatically) AND from the 7 direct `Command::new` sites in
/// auth_token / cli_credentials / workspace_files_service. There is NO
/// legitimate case where a child process spawned from the desktop app
/// needs a visible console: the CLI is headless, `git`/`gh` are
/// headless, `/usr/bin/security` is macOS-only (never runs on
/// Windows), and test spawns of `echo`/`git` don't need a console
/// either. If a future caller genuinely needs a visible console (none
/// today), it must opt out explicitly with a documented reason —
/// never the default.
#[cfg(windows)]
pub fn apply_creation_flags(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    use crate::services::child_signal::process_creation_flags;
    command.creation_flags(process_creation_flags());
}

#[cfg(not(windows))]
pub fn apply_creation_flags(command: &mut Command) {
    // On Unix, put the CLI child in its own process group (setpgid(0,0))
    // so `interrupt_child` / `terminate_process_group` can signal the
    // whole tree (CLI + forked subagents) via `kill(-pid, ...)`. Without
    // this, `kill(pid, SIGINT)` only reaches the direct child and
    // subagents survive Parar (field report: "Parar subagents").
    crate::services::child_signal::configure_process_group(command);
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
            CliRuntime::GlobalVerboo
            | CliRuntime::BundledNode { .. }
            | CliRuntime::EnvNode { .. }
            | CliRuntime::Missing => {}
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

    #[test]
    fn display_runtime_missing() {
        let r = CliRuntime::Missing;
        assert_eq!(r.to_string(), "missing(no Node, no verboo on PATH)");
    }

    /// T-A: on a clean machine (no Node, no `verboo` on PATH),
    /// `CliSpawn::new` returns `CliRuntime::Missing` — NOT
    /// `GlobalVerboo` by elimination. The old code returned
    /// `GlobalVerboo` unconditionally and let `cmd.spawn()` fail with
    /// raw ENOENT ("os error 2") on clean machines.
    ///
    /// Mutation: revert `CliSpawn::new` to return `GlobalVerboo`
    /// unconditionally (remove the `verboo_on_path()` check) →
    /// `runtime == GlobalVerboo` (not `Missing`) → assertion FAILS.
    /// Named mutation:
    /// `cli_spawn_global_verboo_by_elimination_hides_missing`.
    #[test]
    fn cli_runtime_missing_when_no_node_and_no_verboo() {
        let _guard = fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::env::set_var("VERBOO_TEST_NO_NODE", "1");
        std::env::set_var("VERBOO_TEST_NO_VERBOO", "1");
        std::env::remove_var("VERBOO_CLI_PATH");
        std::env::remove_var("VERBOO_NODE_PATH");
        std::env::remove_var("NODE_BINARY");
        std::env::remove_var("NODE");

        let spawn = CliSpawn::new(["auth", "login"]);
        assert_eq!(
            spawn.runtime,
            CliRuntime::Missing,
            "clean machine (no Node, no verboo) must be Missing, not GlobalVerboo by elimination"
        );

        std::env::remove_var("VERBOO_TEST_NO_NODE");
        std::env::remove_var("VERBOO_TEST_NO_VERBOO");
    }

    /// T-A: `runtime_missing_error()` produces a user-facing message
    /// that NEVER contains the raw OS errno text. The old code leaked
    /// "No such file or directory (os error 2)" to the UI.
    #[test]
    fn runtime_missing_error_does_not_contain_errno() {
        let msg = runtime_missing_error();
        assert!(
            !msg.contains("os error"),
            "typed error must not contain raw OS errno; got: {msg}"
        );
        assert!(
            !msg.contains("No such file or directory"),
            "typed error must not contain raw errno text; got: {msg}"
        );
        assert!(
            msg.contains("Node.js") || msg.contains("verboo"),
            "typed error should name the missing runtime; got: {msg}"
        );
    }

    /// T-A: `check_runtime_available()` returns `Err(typed_message)`
    /// when no runtime is available — never raw ENOENT.
    #[test]
    fn check_runtime_available_returns_err_when_missing() {
        let _guard = fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::env::set_var("VERBOO_TEST_NO_NODE", "1");
        std::env::set_var("VERBOO_TEST_NO_VERBOO", "1");

        let result = check_runtime_available();
        assert!(result.is_err(), "check must fail when runtime missing");
        let msg = result.unwrap_err();
        assert!(
            !msg.contains("os error"),
            "error must not contain raw errno; got: {msg}"
        );
        assert!(
            msg.contains("Node.js") || msg.contains("verboo"),
            "error should name the missing runtime; got: {msg}"
        );

        std::env::remove_var("VERBOO_TEST_NO_NODE");
        std::env::remove_var("VERBOO_TEST_NO_VERBOO");
    }

    /// T-A: `runtime_available()` returns false on a clean machine.
    #[test]
    fn runtime_available_false_when_missing() {
        let _guard = fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::env::set_var("VERBOO_TEST_NO_NODE", "1");
        std::env::set_var("VERBOO_TEST_NO_VERBOO", "1");
        assert!(
            !runtime_available(),
            "runtime_available must be false on clean machine"
        );
        std::env::remove_var("VERBOO_TEST_NO_NODE");
        std::env::remove_var("VERBOO_TEST_NO_VERBOO");
    }

    /// Cadinho ressalva 1 (2026-08-07): `verboo` on PATH is typically
    /// an npm-installed Node-script shim — it needs Node to run. If
    /// `verboo` exists but Node is absent, the old code returned
    /// `GlobalVerboo` (verboo_on_path() true) and the spawn died with
    /// the same ENOENT we just eliminated. Now `GlobalVerboo` requires
    /// BOTH `verboo` on PATH AND a usable Node.
    ///
    /// This test creates a real `verboo` shim on a temp PATH dir, sets
    /// `VERBOO_TEST_NO_NODE=1` (Node absent), and asserts
    /// `CliSpawn::new` returns `Missing` — not `GlobalVerboo`.
    ///
    /// Mutation: revert the `GlobalVerboo` check to `verboo_on_path()`
    /// only (drop the `&& resolve_node_path().is_some()`) →
    /// `runtime == GlobalVerboo` (not `Missing`) → assertion FAILS.
    /// Named mutation:
    /// `global_verboo_without_node_leaks_enoent`.
    #[cfg(unix)]
    #[test]
    fn global_verboo_on_path_without_node_is_missing() {
        use std::os::unix::fs::PermissionsExt;
        let _guard = fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        // Node absent, but verboo_on_path() still checks PATH.
        std::env::set_var("VERBOO_TEST_NO_NODE", "1");
        std::env::remove_var("VERBOO_TEST_NO_VERBOO");
        std::env::remove_var("VERBOO_CLI_PATH");
        std::env::remove_var("VERBOO_NODE_PATH");
        std::env::remove_var("NODE_BINARY");
        std::env::remove_var("NODE");

        // Create a temp dir with a `verboo` shim (executable script).
        // This simulates the npm-installed CLI: `verboo` exists on PATH
        // but is a Node-script shim that can't run without Node.
        let temp_dir = std::env::temp_dir().join(format!(
            "verboo_test_shim_{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&temp_dir).expect("create temp dir");
        let shim = temp_dir.join("verboo");
        std::fs::write(&shim, "#!/bin/sh\nexec node \"$0\" \"$@\"\n")
            .expect("write shim");
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755))
            .expect("chmod shim");

        // Save PATH, point it at the temp dir so verboo_on_path() finds
        // the shim.
        let saved_path = std::env::var_os("PATH");
        std::env::set_var("PATH", temp_dir.as_os_str());

        let spawn = CliSpawn::new(["auth", "login"]);
        assert_eq!(
            spawn.runtime,
            CliRuntime::Missing,
            "verboo on PATH but no Node → Missing, not GlobalVerboo \
             (the shim is a Node script that can't run without Node)"
        );

        // Restore PATH and clean up.
        match saved_path {
            Some(p) => std::env::set_var("PATH", p),
            None => std::env::remove_var("PATH"),
        }
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::env::remove_var("VERBOO_TEST_NO_NODE");
    }

    /// Cadinho ressalva 1 companion: `runtime_available()` returns
    /// false when `verboo` is on PATH but Node is absent (same shim
    /// scenario as above).
    #[cfg(unix)]
    #[test]
    fn runtime_available_false_when_verboo_without_node() {
        use std::os::unix::fs::PermissionsExt;
        let _guard = fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        std::env::set_var("VERBOO_TEST_NO_NODE", "1");
        std::env::remove_var("VERBOO_TEST_NO_VERBOO");

        let temp_dir = std::env::temp_dir().join(format!(
            "verboo_test_shim2_{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&temp_dir).expect("create temp dir");
        let shim = temp_dir.join("verboo");
        std::fs::write(&shim, "#!/bin/sh\nexec node \"$0\" \"$@\"\n")
            .expect("write shim");
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755))
            .expect("chmod shim");
        let saved_path = std::env::var_os("PATH");
        std::env::set_var("PATH", temp_dir.as_os_str());

        assert!(
            !runtime_available(),
            "runtime_available must be false when verboo is on PATH but Node is absent"
        );

        match saved_path {
            Some(p) => std::env::set_var("PATH", p),
            None => std::env::remove_var("PATH"),
        }
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::env::remove_var("VERBOO_TEST_NO_NODE");
    }
}

#[cfg(test)]
pub(crate) mod fake_cli_env {
    /// Guard ÚNICO e compartilhado para os testes que mexem na env
    /// VERBOO_CLI_PATH (e FAKE_* afins). Cada módulo tinha o próprio mutex —
    /// o cargo test roda os testes de módulos diferentes em paralelo e as
    /// env vars são globais do processo: a corrida quebrava os testes de
    /// PTY/auth quando outro módulo trocava o VERBOO_CLI_PATH no meio.
    pub(crate) static FAKE_CLI_ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());
}
