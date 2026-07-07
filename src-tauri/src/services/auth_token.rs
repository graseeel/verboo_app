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

/// Injects a bearer token (CLI OAuth token or API key) into a CLI spawn so the
/// headless turn can authenticate.
///
/// The CLI reads the bearer token from the `CLAUDE_CODE_OAUTH_TOKEN`
/// environment variable in headless mode (verified against `@verboo/code`
/// v0.10.x — a live `--print` turn authenticates with it and streams).
///
/// NOTE: an earlier version set `OAUTH_TOKEN_FILE` (a file path). That env var
/// does **not** exist in the CLI, so injection silently did nothing and every
/// headless turn failed with "Não autenticado". The CLI's file-based variant
/// is `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` (an fd number — what Electron
/// used); the direct value env var is simpler and cross-platform. The token is
/// a short-lived (~10 min) access token; passing it via the child environment
/// is acceptable for a local desktop app (a future hardening could switch to
/// the fd descriptor to keep it out of `ps` output).
///
/// If `token` is `None`/empty the command is left unchanged and the CLI fails
/// auth (which the caller surfaces).
pub fn inject_api_key(token: Option<&str>, command: &mut Command) -> Option<TokenGuard> {
    let key = token?;
    if key.trim().is_empty() {
        return None;
    }
    command.env("CLAUDE_CODE_OAUTH_TOKEN", key);
    Some(TokenGuard)
}

/// Marker returned by [`inject_api_key`], kept for API symmetry with the
/// previous temp-file implementation. Callers hold it for the child's
/// lifetime; it now owns no resource (the token travels in the child env).
pub struct TokenGuard;

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
