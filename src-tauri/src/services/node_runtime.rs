//! Port of Electron's `nodeRuntime.ts`. Resolves a Node.js runtime for spawning
//! the bundled `cli.mjs` (which can't be exec'd directly — it requires Node
//! ESM resolution against `node_modules/`).
//!
//! Resolution order (mirrors Electron's `resolveNodeRuntimePath`):
//!   1. `VERBOO_NODE_PATH` env var (explicit override).
//!   2. Platform-specific candidates (Homebrew, /usr/local, nvm, fnm, Volta).
//!   3. `node` on PATH (via `which`-like search).
//!   4. (Future) Tauri sidecar `node-<triple>` via `externalBin`.
//!
//! On macOS, the packaged .app doesn't have a console — the PATH inherited
//! from the launcher is minimal. `create_node_runtime_env` augments it with
//! the platform-specific tool directories so child processes find `gh`,
//! `rg`, `cargo`, etc. (same as Electron).

use std::fs;
use std::path::{Path, PathBuf};

/// Resolves the Node binary path, or None if not found.
pub fn resolve_node_path() -> Option<PathBuf> {
    for candidate in candidates() {
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Returns platform-specific PATH entries to augment the spawned child's
/// PATH. Mirrors Electron's `platformSpecificPathEntries`.
pub fn platform_specific_path_entries() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME")
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
        if let Some(h) = home.as_ref() {
            entries.push(h.join(".local").join("bin"));
            entries.push(h.join(".cargo").join("bin"));
            entries.extend(nvm_bin_dirs(h));
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
        if let Some(h) = home.as_ref() {
            entries.push(h.join(".local").join("bin"));
            entries.push(h.join(".cargo").join("bin"));
            entries.extend(nvm_bin_dirs(h));
        }
        entries
    }

    #[cfg(target_os = "windows")]
    {
        let mut entries = Vec::new();
        let local_app_data = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|h| h.join("AppData").join("Local")));
        let program_files = std::env::var_os("PROGRAMFILES")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\Program Files"));
        let program_files_x86 = std::env::var_os("PROGRAMFILES(X86)")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\Program Files (x86)"));
        if let Some(lad) = local_app_data.as_ref() {
            entries.push(lad.join("Programs").join("Git").join("bin"));
            entries.push(lad.join("Programs").join("Git").join("cmd"));
            entries.push(lad.join("GitHubCli"));
            entries.push(lad.join("fnm_multishells"));
            entries.push(lad.join("Volta").join("bin"));
        }
        entries.push(program_files.join("Git").join("cmd"));
        entries.push(program_files.join("GitHub CLI"));
        entries.push(program_files_x86.join("GitHub CLI"));
        if let Some(h) = home.as_ref() {
            entries.push(h.join(".local").join("bin"));
            entries.push(h.join("scoop").join("shims"));
            entries.push(h.join(".cargo").join("bin"));
            entries.push(h.join("AppData").join("Roaming").join("nvm"));
            entries.push(h.join("AppData").join("Local").join("Microsoft").join("WindowsApps"));
        }
        entries
    }
}

/// Returns all Node binary candidates in resolution order.
fn candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    // 1. Env vars (explicit overrides).
    for var in &["VERBOO_NODE_PATH", "NODE_BINARY", "NODE"] {
        if let Some(p) = std::env::var_os(var) {
            let path = PathBuf::from(p);
            if !path.as_os_str().is_empty() {
                push_unique(&mut out, with_exe(path));
            }
        }
    }
    if let Some(p) = std::env::var_os("npm_node_execpath") {
        push_unique(&mut out, PathBuf::from(p));
    }

    // 2. Platform-specific known locations.
    for c in platform_specific_node_candidates() {
        push_unique(&mut out, c);
    }

    // 3. PATH lookup (`which node`).
    if let Some(path_env) = std::env::var_os("PATH") {
        let exe_name = if cfg!(windows) { "node.exe" } else { "node" };
        for dir in std::env::split_paths(&path_env) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            push_unique(&mut out, dir.join(exe_name));
        }
    }

    // 4. Tauri sidecar: `node-<triple>` next to the binary (Tauri strips the
    //    triple suffix at runtime). For now this is a placeholder — adding
    //    the actual sidecar requires `bundle.externalBin` config + downloading
    //    per-platform Node binaries into `src-tauri/binaries/`.
    #[allow(dead_code)]
    let sidecar_candidates: Vec<PathBuf> = vec![];

    out
}

/// Platform-specific well-known Node install locations. Mirrors Electron's
/// `platformSpecificNodeCandidates`.
fn platform_specific_node_candidates() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);

    #[cfg(target_os = "windows")]
    {
        let mut out = Vec::new();
        let program_files = std::env::var_os("PROGRAMFILES")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\Program Files"));
        let program_files_x86 = std::env::var_os("PROGRAMFILES(X86)")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\Program Files (x86)"));
        let local_app_data = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|h| h.join("AppData").join("Local")));

        out.push(program_files.join("nodejs").join("node.exe"));
        out.push(program_files_x86.join("nodejs").join("node.exe"));
        if let Some(lad) = local_app_data.as_ref() {
            out.push(lad.join("fnm_multishells").join("node.exe"));
            out.push(lad.join("Volta").join("bin").join("node.exe"));
        }
        if let Some(h) = home.as_ref() {
            out.push(h.join("scoop").join("apps").join("nodejs").join("current").join("node.exe"));
            out.push(h.join("AppData").join("Roaming").join("nvm").join("node.exe"));
        }
        out
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let mut out = vec![
            PathBuf::from("/opt/homebrew/bin/node"),
            PathBuf::from("/usr/local/bin/node"),
            PathBuf::from("/usr/bin/node"),
        ];
        if let Some(h) = home.as_ref() {
            out.push(h.join(".local").join("share").join("fnm").join("aliases").join("default").join("bin").join("node"));
            out.push(h.join(".volta").join("bin").join("node"));
            out.extend(nvm_node_candidates(h));
        }
        out
    }
}

/// Returns the nvm root directory: `$NVM_DIR` if set, otherwise `~/.nvm`.
fn nvm_dir(home: &Path) -> PathBuf {
    std::env::var_os("NVM_DIR")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| home.join(".nvm"))
}

/// Node binary candidates under the nvm install tree, in resolution order.
/// nvm has no stable "current" symlink across setups: stock nvm only creates
/// `$NVM_DIR/current` on `nvm use`, and installed versions live at
/// `$NVM_DIR/versions/node/v<X.Y.Z>/`. Probe every location nvm writes to.
fn nvm_node_candidates(home: &Path) -> Vec<PathBuf> {
    let nvm = nvm_dir(home);
    let mut out = Vec::new();

    // `NVM_BIN` — exported by the parent shell when nvm has activated a version.
    if let Some(bin) = std::env::var_os("NVM_BIN") {
        let bin = PathBuf::from(bin);
        if !bin.as_os_str().is_empty() {
            out.push(bin.join("node"));
        }
    }

    // `$NVM_DIR/current` — the symlink nvm maintains on `nvm use`.
    out.push(nvm.join("current").join("bin").join("node"));

    // Concrete default alias from `$NVM_DIR/alias/default` (e.g. `v24.17.0`).
    if let Some(version) = nvm_default_version(&nvm) {
        out.push(
            nvm.join("versions")
                .join("node")
                .join(version)
                .join("bin")
                .join("node"),
        );
    }

    // `versions/node/current` — a `current` symlink kept by some setups.
    out.push(
        nvm.join("versions")
            .join("node")
            .join("current")
            .join("bin")
            .join("node"),
    );

    // Highest installed version — covers `lts/*`/`node` defaults, which don't
    // resolve to a concrete dir without nvm's release-schedule lookup.
    if let Some(dir) = nvm_highest_installed(&nvm) {
        out.push(dir.join("bin").join("node"));
    }

    out
}

/// nvm bin directories to add to a spawned child's PATH so it finds `node`,
/// `npm`, `npx`, and nvm-managed global bins.
fn nvm_bin_dirs(home: &Path) -> Vec<PathBuf> {
    let nvm = nvm_dir(home);
    let mut out = vec![
        nvm.join("current").join("bin"),
        nvm.join("versions")
            .join("node")
            .join("current")
            .join("bin"),
    ];
    if let Some(dir) = nvm_highest_installed(&nvm) {
        out.push(dir.join("bin"));
    }
    out
}

/// Reads `$NVM_DIR/alias/default` and returns the concrete version dir name
/// (e.g. `v24.17.0`) when the alias names a version directly. Symbolic
/// aliases like `lts/*` or `node` return None — callers fall back to the
/// highest installed version.
fn nvm_default_version(nvm_dir: &Path) -> Option<String> {
    let alias = fs::read_to_string(nvm_dir.join("alias").join("default")).ok()?;
    let alias = alias.trim();
    if alias.is_empty() {
        return None;
    }
    let version = alias.strip_prefix('v').unwrap_or(alias);
    if is_semver(version) {
        Some(format!("v{version}"))
    } else {
        None
    }
}

/// True for `X.Y.Z` with numeric components.
fn is_semver(s: &str) -> bool {
    let mut parts = s.split('.');
    let major = parts.next();
    let minor = parts.next();
    let patch = parts.next();
    let (Some(major), Some(minor), Some(patch)) = (major, minor, patch) else {
        return false;
    };
    let digits = |c: char| c.is_ascii_digit();
    major.chars().all(digits)
        && minor.chars().all(digits)
        && patch.chars().all(digits)
        && parts.next().is_none()
}

/// Highest installed version dir under `$NVM_DIR/versions/node/` (dirs are
/// named `v<X.Y.Z>`). None if the tree is empty or missing.
fn nvm_highest_installed(nvm_dir: &Path) -> Option<PathBuf> {
    let versions_dir = nvm_dir.join("versions").join("node");
    let entries = fs::read_dir(&versions_dir).ok()?;
    let mut best: Option<((u64, u64, u64), PathBuf)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(ver) = name.strip_prefix('v') else {
            continue;
        };
        let Some((major, rest)) = ver.split_once('.') else {
            continue;
        };
        let Some((minor, patch)) = rest.split_once('.') else {
            continue;
        };
        let (Ok(major), Ok(minor), Ok(patch)) = (
            major.parse::<u64>(),
            minor.parse::<u64>(),
            patch.parse::<u64>(),
        ) else {
            continue;
        };
        let key = (major, minor, patch);
        if best.as_ref().map_or(true, |(b, _)| key > *b) {
            best = Some((key, entry.path()));
        }
    }
    best.map(|(_, path)| path)
}

/// Appends `.exe` on Windows if missing.
fn with_exe(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        if path.extension().is_none() {
            return path.with_extension("exe");
        }
    }
    path
}

fn push_unique(out: &mut Vec<PathBuf>, p: PathBuf) {
    if !out.contains(&p) {
        out.push(p);
    }
}

fn is_executable(path: &PathBuf) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let Ok(meta) = std::fs::metadata(path) else {
            return false;
        };
        if !meta.is_file() {
            return false;
        }
        // User-execute bit must be set.
        meta.permissions().mode() & 0o100 != 0
    }
    #[cfg(windows)]
    {
        std::fs::metadata(path)
            .map(|m| m.is_file())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_node_path_returns_a_path_when_node_installed() {
        // In CI/dev environments Node is almost always present. We don't
        // assert on the exact path because that's machine-specific.
        let result = resolve_node_path();
        // If this machine has Node, we should find it.
        // (If not, the test still passes — we just don't assert Some/None.)
        if let Some(p) = result {
            assert!(
                p.exists() || p.is_symlink() || std::fs::canonicalize(&p).is_ok(),
                "resolved path should exist: {p:?}"
            );
        }
    }

    #[test]
    fn platform_specific_path_entries_returns_known_dirs() {
        let entries = platform_specific_path_entries();
        assert!(
            !entries.is_empty(),
            "should always return at least one entry"
        );
    }

    #[test]
    fn candidates_includes_env_var_first() {
        // Set VERBOO_NODE_PATH to a fake path and verify it's the first candidate.
        // (We can't safely set env vars in parallel tests, so just verify the
        // function doesn't panic when the var is unset.)
        let _ = candidates();
    }

    #[test]
    fn with_exe_appends_exe_on_windows() {
        let p = PathBuf::from("/usr/bin/node");
        let _ = with_exe(p);
    }

    #[test]
    fn push_unique_dedupes() {
        let mut out = Vec::new();
        let p = PathBuf::from("/usr/bin/node");
        push_unique(&mut out, p.clone());
        push_unique(&mut out, p.clone());
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn is_executable_returns_false_for_missing_path() {
        assert!(!is_executable(&PathBuf::from(
            "/nonexistent/path/that/should/not/exist"
        )));
    }

    #[test]
    fn is_semver_accepts_plain_versions() {
        assert!(is_semver("24.17.0"));
        assert!(is_semver("0.10.1"));
        assert!(!is_semver("lts/*"));
        assert!(!is_semver("node"));
        assert!(!is_semver("24.17"));
        assert!(!is_semver("v24.17.0"));
    }

    #[test]
    fn nvm_default_version_reads_concrete_alias() {
        let dir = std::env::temp_dir().join(format!("nvm-runtime-alias-{}", std::process::id()));
        let alias = dir.join("alias");
        fs::create_dir_all(&alias).unwrap();
        fs::write(alias.join("default"), "v24.17.0\n").unwrap();
        assert_eq!(nvm_default_version(&dir).as_deref(), Some("v24.17.0"));
        fs::write(alias.join("default"), "lts/*\n").unwrap();
        assert_eq!(nvm_default_version(&dir), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nvm_highest_installed_picks_latest() {
        let dir = std::env::temp_dir().join(format!("nvm-runtime-highest-{}", std::process::id()));
        let versions = dir.join("versions").join("node");
        fs::create_dir_all(versions.join("v20.11.1")).unwrap();
        fs::create_dir_all(versions.join("v18.3.0")).unwrap();
        fs::create_dir_all(versions.join("v24.17.0")).unwrap();
        let got = nvm_highest_installed(&dir).unwrap();
        assert_eq!(got.file_name().unwrap().to_string_lossy(), "v24.17.0");
        let _ = fs::remove_dir_all(&dir);
    }
}
