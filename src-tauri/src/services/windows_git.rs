//! Windows Git onboarding (issue #71, contract `contrato-71-gitbash`).
//!
//! Two Tauri commands back the login-screen Git gate:
//! - `check_windows_login_prereqs` — detects whether Git is available so
//!   the CLI (which needs git-bash) can run. NEVER installs anything and
//!   returns in <1s with no network I/O.
//! - `install_git_windows` — installs Git via winget, ONLY when the user
//!   explicitly asks ("Install automatically"). Off-Windows both commands
//!   return a neutral answer.
//!
//! Nothing here is owner-hardcoded: the Git install dir derives from the
//! system `ProgramFiles` env var. UI-facing strings are English (the
//! login-screen standard).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
#[cfg(windows)]
use std::process::Command;

/// Response of `check_windows_login_prereqs` (camelCase over the fence).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsLoginPrereqs {
    pub git_available: bool,
    pub platform: String,
}

/// Response of `install_git_windows` (camelCase over the fence).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWindowsInstallResult {
    pub success: bool,
    pub exit_code: i32,
    pub log: String,
}

/// Pure: decides Git availability from a `where git` probe result and the
/// standard Git-for-Windows bash candidates. Testable without Windows.
fn is_git_available(where_git_found: bool, bash_candidates: &[PathBuf]) -> bool {
    where_git_found || bash_candidates.iter().any(|p| p.is_file())
}

/// Pure: the standard Git-for-Windows `bash.exe` locations, derived from
/// the system `ProgramFiles` env var (never owner-hardcoded). Contract:
/// `Program Files\Git\bin`.
fn default_git_bash_candidates(program_files: Option<&str>) -> Vec<PathBuf> {
    let root = program_files.unwrap_or("C:\\Program Files");
    vec![PathBuf::from(root).join("Git").join("bin").join("bash.exe")]
}

/// Detects whether Git is available for the CLI. Windows: `where git` on
/// PATH, or `bash.exe` in the standard Git install dir. Other platforms:
/// always available (the CLI does not need git-bash there). Never
/// installs anything; fast (<1s), no network.
pub fn check_windows_login_prereqs() -> WindowsLoginPrereqs {
    let platform = std::env::consts::OS.to_string();
    #[cfg(windows)]
    {
        let mut where_cmd = Command::new("where");
        where_cmd
            .arg("git")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        crate::services::cli_spawn::apply_creation_flags(&mut where_cmd);
        let where_git_found = where_cmd
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        let candidates = default_git_bash_candidates(std::env::var("ProgramFiles").ok().as_deref());
        WindowsLoginPrereqs {
            git_available: is_git_available(where_git_found, &candidates),
            platform,
        }
    }
    #[cfg(not(windows))]
    {
        WindowsLoginPrereqs {
            git_available: true,
            platform,
        }
    }
}

/// Installs Git for Windows via winget. Only called from the explicit
/// "Install automatically" action. Off-Windows: neutral failure with a
/// clear log (the renderer never reaches it there).
pub fn install_git_windows() -> GitWindowsInstallResult {
    #[cfg(windows)]
    {
        run_winget_install()
    }
    #[cfg(not(windows))]
    {
        GitWindowsInstallResult {
            success: false,
            exit_code: -1,
            log: "Git installation is only supported on Windows.".to_string(),
        }
    }
}

/// Runs `winget install --id Git.Git` with the contract flags. Uses
/// `--source winget` (the msstore source fails with a certificate error —
/// seen in the field). Generous 10-minute timeout; captures stdout+stderr;
/// no visible window (creation flags). If winget is absent (old Win10),
/// returns success=false with a clear log so the UI falls back to the
/// manual-install path.
#[cfg(windows)]
fn run_winget_install() -> GitWindowsInstallResult {
    let mut cmd = Command::new("winget");
    cmd.args([
        "install",
        "--id",
        "Git.Git",
        "-e",
        "--source",
        "winget",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--silent",
    ])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());
    crate::services::cli_spawn::apply_creation_flags(&mut cmd);

    let Ok(mut child) = cmd.spawn() else {
        return GitWindowsInstallResult {
            success: false,
            exit_code: -1,
            log: "winget is not available on this system (Windows 10 1809+ required). \
                  Install Git manually from https://git-scm.com/downloads/win and reopen the app."
                .to_string(),
        };
    };

    // Drain stdout/stderr on threads so a full pipe can't deadlock the
    // child while we wait with a timeout.
    let out_thread = std::thread::spawn({
        let mut out = child.stdout.take();
        move || {
            use std::io::Read;
            let mut buf = Vec::new();
            if let Some(r) = out.as_mut() {
                let _ = r.read_to_end(&mut buf);
            }
            buf
        }
    });
    let err_thread = std::thread::spawn({
        let mut err = child.stderr.take();
        move || {
            use std::io::Read;
            let mut buf = Vec::new();
            if let Some(r) = err.as_mut() {
                let _ = r.read_to_end(&mut buf);
            }
            buf
        }
    });

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);
    let status = loop {
        if let Some(s) = child.try_wait().ok().flatten() {
            break Some(s);
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };

    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    let log = [String::from_utf8_lossy(&stdout), String::from_utf8_lossy(&stderr)]
        .join("\n")
        .trim()
        .to_string();

    match status {
        Some(s) => GitWindowsInstallResult {
            success: s.success(),
            exit_code: s.code().unwrap_or(-1),
            log,
        },
        None => GitWindowsInstallResult {
            success: false,
            exit_code: -1,
            log: format!("winget install timed out after 10 minutes.\n{log}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prereqs_off_windows_are_neutral_and_never_install() {
        // On mac/linux the command must compile and answer neutrally.
        let prereqs = check_windows_login_prereqs();
        assert!(prereqs.git_available, "off-Windows git is always available");
        assert!(!prereqs.platform.is_empty());
    }

    #[test]
    fn install_off_windows_is_neutral_failure() {
        let result = install_git_windows();
        assert!(!result.success, "off-Windows install must not run");
        assert!(result.exit_code == -1);
        assert!(!result.log.is_empty());
    }

    #[test]
    fn git_available_when_where_git_found() {
        assert!(is_git_available(true, &[]));
    }

    #[test]
    fn git_available_when_bash_candidate_exists() {
        let candidates = vec![PathBuf::from("/opt/git/bin/bash.exe")];
        // The candidate path does not exist on this machine, so this only
        // proves the OR logic: a real file would flip it to true.
        assert!(!is_git_available(false, &candidates));
        // where-git alone is enough.
        assert!(is_git_available(true, &candidates));
    }

    #[test]
    fn default_bash_candidates_derive_from_program_files() {
        // Assert the tail components (Git/bin/bash.exe) independent of the
        // host path separator, so the test holds on mac and Windows.
        let tail = |c: &PathBuf| -> Vec<String> {
            c.components()
                .rev()
                .take(3)
                .map(|p| p.as_os_str().to_string_lossy().into_owned())
                .collect()
        };
        let candidates = default_git_bash_candidates(Some("C:\\Program Files"));
        assert_eq!(candidates.len(), 1);
        assert_eq!(
            tail(&candidates[0]),
            vec!["bash.exe".to_string(), "bin".to_string(), "Git".to_string()]
        );
        // Fallback when ProgramFiles is unset.
        let fallback = default_git_bash_candidates(None);
        assert_eq!(fallback.len(), 1);
        assert_eq!(
            tail(&fallback[0]),
            vec!["bash.exe".to_string(), "bin".to_string(), "Git".to_string()]
        );
    }
}
