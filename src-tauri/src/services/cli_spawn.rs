//! Builds every Verboo CLI command from one immutable runtime authority.
//!
//! Production has no system Node or global `verboo` fallback. A packaged
//! process uses the CLI and managed Node runtime selected under app data.
//! Debug builds may use an explicit Node/CLI path pair.

use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::services::cli_update::runtime;
use crate::services::node_runtime;

pub struct CliSpawn {
    pub command: Command,
    pub runtime: CliRuntime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliRuntime {
    InstalledNode {
        node_path: PathBuf,
        cli_mjs_path: PathBuf,
        version: String,
    },
    DevelopmentOverride {
        node_path: PathBuf,
        cli_mjs_path: PathBuf,
    },
    Missing,
}

impl fmt::Display for CliRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InstalledNode {
                node_path,
                cli_mjs_path,
                version,
            } => write!(
                formatter,
                "installed-node(version={version}, node={}, cli={})",
                node_path.display(),
                cli_mjs_path.display()
            ),
            Self::DevelopmentOverride {
                node_path,
                cli_mjs_path,
            } => write!(
                formatter,
                "development-override(node={}, cli={})",
                node_path.display(),
                cli_mjs_path.display()
            ),
            Self::Missing => formatter.write_str("missing(cli bootstrap required)"),
        }
    }
}

impl CliSpawn {
    pub fn new<I, S>(args: I) -> CliSpawn
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let arguments: Vec<std::ffi::OsString> = args
            .into_iter()
            .map(|argument| argument.as_ref().to_os_string())
            .collect();

        #[cfg(test)]
        if std::env::var_os("VERBOO_TEST_NO_NODE").is_some() {
            return missing_spawn(&arguments);
        }

        match development_override_pair() {
            Ok(Some((node_path, cli_mjs_path))) => {
                return command_spawn(
                    &arguments,
                    CliRuntime::DevelopmentOverride {
                        node_path,
                        cli_mjs_path,
                    },
                );
            }
            Err(_) => return missing_spawn(&arguments),
            Ok(None) => {}
        }

        match runtime::acquire() {
            Ok(resolved) => command_spawn(
                &arguments,
                CliRuntime::InstalledNode {
                    node_path: resolved.node_path,
                    cli_mjs_path: resolved.cli_mjs_path,
                    version: resolved.version,
                },
            ),
            Err(_) => missing_spawn(&arguments),
        }
    }

    pub fn cli_env_entries() -> Vec<(String, String)> {
        cli_spawn_env_entries()
    }
}

fn command_spawn(arguments: &[std::ffi::OsString], runtime: CliRuntime) -> CliSpawn {
    let (node_path, cli_mjs_path) = match &runtime {
        CliRuntime::InstalledNode {
            node_path,
            cli_mjs_path,
            ..
        }
        | CliRuntime::DevelopmentOverride {
            node_path,
            cli_mjs_path,
        } => (node_path, cli_mjs_path),
        CliRuntime::Missing => return missing_spawn(arguments),
    };
    let mut command = Command::new(node_path);
    command.arg(cli_mjs_path).args(arguments);
    augment_path_env(&mut command);
    protect_user_cli_env(&mut command);
    apply_creation_flags(&mut command);
    CliSpawn { command, runtime }
}

fn missing_spawn(arguments: &[std::ffi::OsString]) -> CliSpawn {
    let mut command = Command::new("verboo-cli-runtime-unavailable");
    command.args(arguments);
    apply_creation_flags(&mut command);
    CliSpawn {
        command,
        runtime: CliRuntime::Missing,
    }
}

#[cfg(debug_assertions)]
fn development_override_pair() -> Result<Option<(PathBuf, PathBuf)>, String> {
    let cli = nonempty_env_path("VERBOO_CLI_PATH");
    let node = nonempty_env_path("VERBOO_NODE_PATH");
    #[cfg(test)]
    let node = node.or_else(|| {
        cli.as_ref()
            .and_then(|_| node_runtime::resolve_test_node_on_path())
    });
    match (node, cli) {
        (None, None) => Ok(None),
        (Some(node), Some(cli)) => {
            if !node_runtime::is_executable(&node) {
                return Err(format!(
                    "VERBOO_NODE_PATH is not executable: {}",
                    node.display()
                ));
            }
            if !cli.is_file() {
                return Err(format!("VERBOO_CLI_PATH is not a file: {}", cli.display()));
            }
            Ok(Some((node, cli)))
        }
        _ => Err("VERBOO_NODE_PATH and VERBOO_CLI_PATH must be configured together".to_string()),
    }
}

#[cfg(not(debug_assertions))]
fn development_override_pair() -> Result<Option<(PathBuf, PathBuf)>, String> {
    Ok(None)
}

fn nonempty_env_path(name: &str) -> Option<PathBuf> {
    let value = std::env::var_os(name)?;
    let path = PathBuf::from(value);
    (!path.as_os_str().is_empty()).then_some(path)
}

fn cli_spawn_env_entries() -> Vec<(String, String)> {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut entries = node_runtime::platform_specific_path_entries();
    entries.extend(std::env::split_paths(&existing).filter(|path| !path.as_os_str().is_empty()));
    let mut seen = std::collections::HashSet::new();
    entries.retain(|path| seen.insert(path.clone()));
    let path = std::env::join_paths(entries).unwrap_or(existing);
    vec![
        ("PATH".to_string(), path.to_string_lossy().to_string()),
        ("DISABLE_AUTOUPDATER".to_string(), "1".to_string()),
    ]
}

fn augment_path_env(command: &mut Command) {
    for (key, value) in cli_spawn_env_entries() {
        if key == "PATH" {
            command.env(key, value);
        }
    }
}

fn protect_user_cli_env(command: &mut Command) {
    command.env("DISABLE_AUTOUPDATER", "1");
}

pub fn runtime_available() -> bool {
    development_override_pair().ok().flatten().is_some() || runtime::acquire().is_ok()
}

pub fn runtime_missing_error() -> String {
    "O CLI do Verboo ainda não está pronto. O app baixa e verifica o CLI oficial na primeira inicialização; confira sua conexão e tente novamente. O restante do app continua disponível."
        .to_string()
}

pub fn check_runtime_available() -> Result<(), String> {
    runtime_available()
        .then_some(())
        .ok_or_else(runtime_missing_error)
}

pub fn bundled_cli_version() -> Option<String> {
    if let Ok(Some((_node, cli))) = development_override_pair() {
        return package_version_for_cli(&cli);
    }
    runtime::current_version()
}

fn package_version_for_cli(cli_mjs: &Path) -> Option<String> {
    let package = cli_mjs.parent()?.parent()?.join("package.json");
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(package).ok()?).ok()?;
    value.get("version")?.as_str().map(str::to_string)
}

#[cfg(windows)]
pub fn apply_creation_flags(command: &mut Command) {
    use crate::services::child_signal::process_creation_flags;
    use std::os::windows::process::CommandExt;
    command.creation_flags(process_creation_flags());
}

#[cfg(not(windows))]
pub fn apply_creation_flags(command: &mut Command) {
    crate::services::child_signal::configure_process_group(command);
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::services::cli_update::contract::DesktopTarget;
    use crate::services::cli_update::store::{CliPointer, CliStore};

    #[cfg(unix)]
    fn executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        fs::write(path, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(windows)]
    fn executable(path: &Path) {
        fs::write(path, b"MZ").unwrap();
    }

    fn clear_environment() {
        for name in [
            "VERBOO_CLI_PATH",
            "VERBOO_NODE_PATH",
            "VERBOO_TEST_NO_NODE",
            "VERBOO_TEST_NO_VERBOO",
        ] {
            std::env::remove_var(name);
        }
        runtime::reset();
    }

    #[test]
    fn explicit_development_pair_is_used_together() {
        let _guard = fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        clear_environment();
        let directory = tempfile::tempdir().unwrap();
        let node = directory
            .path()
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        let cli = directory.path().join("dist/cli.mjs");
        executable(&node);
        fs::create_dir_all(cli.parent().unwrap()).unwrap();
        fs::write(&cli, b"entry").unwrap();
        std::env::set_var("VERBOO_NODE_PATH", &node);
        std::env::set_var("VERBOO_CLI_PATH", &cli);

        let spawn = CliSpawn::new(["--version"]);
        assert_eq!(
            spawn.runtime,
            CliRuntime::DevelopmentOverride {
                node_path: node,
                cli_mjs_path: cli,
            }
        );
        clear_environment();
    }

    #[test]
    fn partial_development_override_fails_closed() {
        let _guard = fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        clear_environment();
        let directory = tempfile::tempdir().unwrap();
        let cli = directory.path().join("cli.mjs");
        fs::write(&cli, b"entry").unwrap();
        std::env::set_var("VERBOO_CLI_PATH", &cli);
        std::env::set_var("VERBOO_TEST_NO_NODE", "1");
        assert_eq!(CliSpawn::new(["--version"]).runtime, CliRuntime::Missing);
        clear_environment();
    }

    #[test]
    fn installed_runtime_uses_app_data_cli_and_embedded_node() {
        let _guard = fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        clear_environment();
        let app_data = tempfile::tempdir().unwrap();
        let store = CliStore::open(app_data.path()).unwrap();
        let root = store.version_dir("0.15.6").unwrap();
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(root.join("dist/cli.mjs"), b"entry").unwrap();
        let node = app_data
            .path()
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        executable(&node);
        store
            .activate(
                &CliPointer::new("0.15.6", DesktopTarget::host().unwrap(), "a".repeat(64)).unwrap(),
            )
            .unwrap();
        runtime::configure(store, node.clone()).unwrap();

        let spawn = CliSpawn::new(["--version"]);
        assert!(matches!(
            spawn.runtime,
            CliRuntime::InstalledNode { ref version, .. } if version == "0.15.6"
        ));
        assert_eq!(spawn.command.get_program(), node.as_os_str());
        clear_environment();
    }

    #[test]
    fn system_path_never_becomes_a_production_runtime() {
        let _guard = fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        clear_environment();
        let saved_path = std::env::var_os("PATH");
        let directory = tempfile::tempdir().unwrap();
        executable(
            &directory
                .path()
                .join(if cfg!(windows) { "node.exe" } else { "node" }),
        );
        executable(&directory.path().join(if cfg!(windows) {
            "verboo.exe"
        } else {
            "verboo"
        }));
        std::env::set_var("PATH", directory.path());
        assert_eq!(CliSpawn::new(["--version"]).runtime, CliRuntime::Missing);
        match saved_path {
            Some(path) => std::env::set_var("PATH", path),
            None => std::env::remove_var("PATH"),
        }
        clear_environment();
    }

    #[test]
    fn missing_error_is_typed_and_does_not_request_a_system_node_install() {
        let message = runtime_missing_error();
        assert!(!message.contains("os error"));
        assert!(!message.contains("npm i -g"));
        assert!(!message.contains("Instale o Node"));
        assert!(message.contains("primeira inicialização"));
    }

    #[test]
    fn cli_env_disables_the_upstream_autoupdater() {
        assert!(CliSpawn::cli_env_entries()
            .contains(&("DISABLE_AUTOUPDATER".to_string(), "1".to_string())));
    }
}

#[cfg(test)]
pub(crate) mod fake_cli_env {
    pub(crate) static FAKE_CLI_ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());
}
