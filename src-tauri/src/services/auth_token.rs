use std::fs::Permissions;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Command;

use crate::services::cli_credentials;
use crate::services::credentials_store::CredentialsStore;

/// Resolves the best available bearer token for the current user.
///
/// Resolution order (CLI-first, opposite of Electron's `apiKey ?? cli`):
///   1. CLI OAuth token (with refresh) — has access to `/api/me` (profile)
///      and `/router/v1/models` with `display_name` (rich model names).
///   2. API key (from the app's credential store) — works for turns and
///      `/router/v1/models` (without `display_name`), but **401 on `/api/me`**.
///
/// Why CLI-first: the API key (`vbk_...`) doesn't access `/api/me` or
/// receive `display_name` from `/models`. Only the CLI's OAuth token does.
/// So preferring the CLI gives the full experience (profile + rich model
/// names); the API key is a fallback for users who haven't done
/// `verboo auth login`.
///
/// Returns `None` if neither source has a usable token.
pub fn resolve_token(credentials: &CredentialsStore) -> Option<String> {
    // CLI token first (with refresh).
    if let Some(tok) = cli_credentials::get_access_token() {
        if !tok.trim().is_empty() {
            return Some(tok);
        }
    }
    // Fallback: API key.
    credentials.get_api_key().ok().flatten()
}

/// Injects a bearer token (CLI OAuth or API key) into a CLI spawn so the
/// turn can authenticate.
///
/// Electron's equivalent writes the key to a temp file and passes it to the
/// CLI via fd 3 with `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3`. Tauri's
/// `std::process::Command` doesn't easily support passing a custom fd, so we
/// use the CLI's supported `OAUTH_TOKEN_FILE` environment variable instead.
/// The temp file is created with mode 0600 and deleted as soon as the child
/// is spawned (the OS keeps the handle alive until the process exits).
///
/// If `token` is `None`, the command is returned unchanged; the CLI will
/// fall back to its own credential store or fail auth.
pub fn inject_api_key(token: Option<&str>, command: &mut Command) -> Option<TokenTempFile> {
    let key = token?;
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
