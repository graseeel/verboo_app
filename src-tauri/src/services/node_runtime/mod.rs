//! Resolves and manages only the Node runtime owned by Verboo Desktop.
//!
//! Packaged builds accept the target-qualified Tauri sidecar beside the app
//! executable. Debug builds may use the explicit `VERBOO_NODE_PATH` override.
//! System Node locations, npm, nvm, Homebrew, and PATH are deliberately not
//! runtime fallbacks; the desktop app must work on a clean machine.

use std::path::{Path, PathBuf};

pub mod contract;

pub fn resolve_node_path() -> Option<PathBuf> {
    development_override().or_else(resolve_embedded_node_path)
}

pub fn resolve_embedded_node_path() -> Option<PathBuf> {
    for candidate in embedded_node_candidates() {
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(debug_assertions)]
fn development_override() -> Option<PathBuf> {
    let value = std::env::var_os("VERBOO_NODE_PATH")?;
    let path = PathBuf::from(value);
    if path.as_os_str().is_empty() || !is_executable(&path) {
        return None;
    }
    Some(path)
}

#[cfg(not(debug_assertions))]
fn development_override() -> Option<PathBuf> {
    None
}

fn embedded_node_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            push_unique(&mut candidates, directory.join(sidecar_runtime_name()));
        }
    }

    // `cargo test` and direct debug binaries do not copy externalBin beside
    // the Rust test executable. The build script has already produced the
    // exact target-qualified source under src-tauri/binaries, so debug builds
    // may use it without consulting a system installation.
    #[cfg(debug_assertions)]
    if let Some(target) = crate::services::cli_update::contract::DesktopTarget::host() {
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        push_unique(
            &mut candidates,
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join(format!("verboo-node-{target}{suffix}")),
        );
    }
    candidates
}

fn sidecar_runtime_name() -> &'static str {
    if cfg!(windows) {
        "verboo-node.exe"
    } else {
        "verboo-node"
    }
}

/// PATH entries for tools launched *by* the CLI (`git`, `gh`, `rg`, etc.).
/// These entries do not participate in selecting the Node runtime.
pub fn platform_specific_path_entries() -> Vec<PathBuf> {
    let user_home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);

    #[cfg(target_os = "macos")]
    {
        let mut entries = vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/opt/homebrew/sbin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/local/sbin"),
        ];
        if let Some(home) = user_home.as_ref() {
            entries.push(home.join(".local/bin"));
            entries.push(home.join(".cargo/bin"));
        }
        entries
    }

    #[cfg(target_os = "linux")]
    {
        let mut entries = vec![
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/local/sbin"),
            PathBuf::from("/snap/bin"),
        ];
        if let Some(home) = user_home.as_ref() {
            entries.push(home.join(".local/bin"));
            entries.push(home.join(".cargo/bin"));
        }
        entries
    }

    #[cfg(target_os = "windows")]
    {
        let mut entries = Vec::new();
        let local_app_data = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| user_home.as_ref().map(|home| home.join("AppData/Local")));
        let program_files = std::env::var_os("PROGRAMFILES")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\Program Files"));
        if let Some(local) = local_app_data.as_ref() {
            entries.push(local.join("Programs/Git/bin"));
            entries.push(local.join("Programs/Git/cmd"));
            entries.push(local.join("GitHubCli"));
        }
        entries.push(program_files.join("Git/cmd"));
        entries.push(program_files.join("GitHub CLI"));
        if let Some(home) = user_home.as_ref() {
            entries.push(home.join(".local/bin"));
            entries.push(home.join("scoop/shims"));
            entries.push(home.join(".cargo/bin"));
            entries.push(home.join("AppData/Local/Microsoft/WindowsApps"));
        }
        entries
    }
}

fn push_unique(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.contains(&path) {
        paths.push(path);
    }
}

pub fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o100 != 0)
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        std::fs::metadata(path)
            .map(|metadata| metadata.is_file())
            .unwrap_or(false)
    }
}

#[cfg(test)]
pub(crate) fn resolve_test_node_on_path() -> Option<PathBuf> {
    if std::env::var_os("VERBOO_TEST_NO_NODE").is_some() {
        return None;
    }
    let filename = if cfg!(windows) { "node.exe" } else { "node" };
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .map(|directory| directory.join(filename))
        .find(|candidate| is_executable(candidate))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_candidates_are_only_app_owned_locations() {
        let rendered = embedded_node_candidates()
            .iter()
            .map(|path| path.to_string_lossy())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(rendered.contains("verboo-node"));
        assert!(!rendered.contains("/usr/local/bin/node"));
        assert!(!rendered.contains("nodejs\\node.exe"));
        assert!(!rendered.contains(".nvm"));
    }

    #[test]
    fn sidecar_runtime_name_matches_tauri_external_bin() {
        assert_eq!(
            sidecar_runtime_name(),
            if cfg!(windows) {
                "verboo-node.exe"
            } else {
                "verboo-node"
            }
        );
    }

    #[test]
    fn missing_path_is_not_executable() {
        assert!(!is_executable(Path::new(
            "/nonexistent/verboo-node-that-does-not-exist"
        )));
    }

    #[test]
    fn child_tool_path_entries_remain_available() {
        assert!(!platform_specific_path_entries().is_empty());
    }
}
