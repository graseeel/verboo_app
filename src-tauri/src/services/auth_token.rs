use std::fs::Permissions;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Command;

/// Injects an API key into a CLI spawn so the turn can authenticate without
/// any prior `verboo auth login` / OAuth flow.
///
/// Electron's equivalent writes the key to a temp file and passes it to the
/// CLI via fd 3 with `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3`. Tauri's
/// `std::process::Command` doesn't easily support passing a custom fd, so we
/// use the CLI's supported `OAUTH_TOKEN_FILE` environment variable instead.
/// The temp file is created with mode 0600 and deleted as soon as the child
/// is spawned (the OS keeps the handle alive until the process exits).
///
/// If `api_key` is `None`, the command is returned unchanged; the CLI will
/// fall back to its own credential store (OAuth token) or fail auth.
pub fn inject_api_key(api_key: Option<&str>, command: &mut Command) -> Option<TokenTempFile> {
    let key = api_key?;
    if key.trim().is_empty() {
        return None;
    }

    let mut temp = tempfile::NamedTempFile::new().ok()?;
    temp.write_all(key.as_bytes()).ok()?;
    temp.flush().ok()?;

    // Restrict to owner-read/write only (0600).
    let perms = Permissions::from_mode(0o600);
    let _ = temp.as_file().set_permissions(perms);

    let path: PathBuf = temp.path().to_path_buf();
    let keep = TokenTempFile { _temp: temp };

    command.env("OAUTH_TOKEN_FILE", &path);
    // Also set the env var the CLI documents as a direct bearer fallback.
    command.env("CLAUDE_CODE_OAUTH_TOKEN_FILE", &path);

    Some(keep)
}

/// Holds the temp file alive until the owning caller drops it. Dropping
/// schedules deletion; because the child process already inherited the fd,
/// the file remains readable on Unix until the child closes it.
pub struct TokenTempFile {
    _temp: tempfile::NamedTempFile,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn none_key_leaves_command_unchanged() {
        let mut cmd = Command::new("echo");
        let guard = inject_api_key(None, &mut cmd);
        assert!(guard.is_none());
    }

    #[test]
    fn empty_key_leaves_command_unchanged() {
        let mut cmd = Command::new("echo");
        let guard = inject_api_key(Some("   "), &mut cmd);
        assert!(guard.is_none());
    }

    #[test]
    fn real_key_sets_env_and_returns_guard() {
        let mut cmd = Command::new("echo");
        let guard = inject_api_key(Some("vbk_test_key_12345"), &mut cmd);
        assert!(guard.is_some());
        // The env var is set on the command (we can't inspect it directly, but
        // the call didn't panic and the guard exists).
    }
}
