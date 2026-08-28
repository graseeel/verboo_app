use std::process::Command;

use crate::services::cli_credentials;
use crate::services::credentials_store::CredentialsStore;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountCredential {
    OAuth(String),
    ApiKeyOnly,
    Unauthenticated,
}

pub(crate) fn account_credential_from_sources(
    oauth_token: Option<&str>,
    api_key: Option<&str>,
) -> AccountCredential {
    if let Some(token) = oauth_token.map(str::trim).filter(|token| !token.is_empty()) {
        return AccountCredential::OAuth(token.to_string());
    }
    if let Some(key) = api_key.map(str::trim).filter(|key| key.starts_with("vbk_")) {
        eprintln!(
            "[verboo:auth-token] resolved API key for inference ({} chars)",
            key.len()
        );
        return AccountCredential::ApiKeyOnly;
    }
    AccountCredential::Unauthenticated
}

/// Resolves credentials specifically for OAuth-only account endpoints.
/// Unlike `resolve_token`, this keeps an inference API key as a typed state
/// instead of returning it as an HTTP bearer.
pub fn resolve_account_credential(credentials: &CredentialsStore) -> AccountCredential {
    let oauth_token = cli_credentials::get_access_token();
    if let AccountCredential::OAuth(token) =
        account_credential_from_sources(oauth_token.as_deref(), None)
    {
        eprintln!(
            "[verboo:auth-token] resolved CLI OAuth token for account ({} chars)",
            token.len()
        );
        return AccountCredential::OAuth(token);
    }

    match credentials.get_api_key() {
        Ok(api_key) => account_credential_from_sources(None, api_key.as_deref()),
        Err(error) => {
            eprintln!(
                "[verboo:auth-token] failed to read API key while resolving account credential: {error}"
            );
            AccountCredential::Unauthenticated
        }
    }
}

/// Resolves the best available bearer token for the current user.
///
/// Resolution order (CLI-first):
///   1. CLI OAuth token (with refresh) from the CLI keychain/store.
///   2. API key (`vbk_…`) from the app credential store.
pub fn resolve_token(credentials: &CredentialsStore) -> Option<String> {
    match cli_credentials::get_access_token() {
        Some(tok) if !tok.trim().is_empty() => {
            eprintln!("[verboo:auth-token] resolved CLI OAuth token ({} chars)", tok.len());
            return Some(tok);
        }
        Some(_) => {
            eprintln!("[verboo:auth-token] CLI token is empty — falling back to API key");
        }
        None => {
            eprintln!("[verboo:auth-token] no CLI token found — falling back to API key");
        }
    }
    match credentials.get_api_key() {
        Ok(Some(key)) if !key.trim().is_empty() => {
            eprintln!("[verboo:auth-token] resolved API key ({} chars)", key.len());
            return Some(key);
        }
        Ok(_) => {
            eprintln!("[verboo:auth-token] no API key found in credential store");
        }
        Err(e) => {
            eprintln!("[verboo:auth-token] failed to read API key from credential store: {e}");
        }
    }
    eprintln!("[verboo:auth-token] NO TOKEN RESOLVED — models will not load, chat will be blocked");
    None
}

/// Configures auth env for a headless CLI spawn.
///
/// ## Why the parent must inject OAuth
/// When the CLI is spawned as a child of the packaged Tauri app, the child
/// process often **cannot** read the macOS Keychain the same way an interactive
/// Terminal can (ACL / parent identity). The parent *can* read the keychain via
/// `/usr/bin/security` and refresh via HTTP — so we inject a **fresh** OAuth
/// access token into `CLAUDE_CODE_OAUTH_TOKEN`.
///
/// ## What we must never inject
/// - **Stale/invalid JWTs** → CLI exits 1 with "Não autenticado" and overrides
///   any residual keychain path.
/// - **API keys `vbk_…` as OAuth** → same failure. API keys go to
///   `ANTHROPIC_API_KEY` only.
///
/// `get_access_token()` already refreshes when near expiry and returns `None`
/// when expired and refresh fails — so a `Some` token here is the freshest
/// the app can offer.
pub fn inject_api_key(token: Option<&str>, command: &mut Command) -> Option<TokenGuard> {
    let key = token?;
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("vbk_") {
        // App-stored API key — inject as ANTHROPIC_API_KEY only.
        // API keys must NOT go into CLAUDE_CODE_OAUTH_TOKEN: the CLI
        // expects an OAuth JWT there and will fail with "Não autenticado".
        command.env("ANTHROPIC_API_KEY", trimmed);
        return Some(TokenGuard);
    }
    // Fresh OAuth access token from CLI store (parent-refreshed).
    command.env("CLAUDE_CODE_OAUTH_TOKEN", trimmed);
    Some(TokenGuard)
}

/// Configures auth env for a TURN spawn carrying BOTH credentials when both
/// exist (issue #104, field macOS, CLI 0.15.18).
///
/// `token` is the `resolve_token` winner and is injected exactly as
/// `inject_api_key` does — OAuth keeps precedence via `CLAUDE_CODE_OAUTH_TOKEN`.
/// When OAuth won, the app-stored `vbk_` API key rides along as
/// `ANTHROPIC_API_KEY`: if the server rejects the OAuth session, the CLI's
/// post-401 fallback (PR #43) reads that env and the turn survives without a
/// second spawn. Without OAuth the behavior is unchanged (key only, already
/// handled by `inject_api_key`). `resolve_token`/`resolve_account_credential`
/// are untouched — their #102 contracts stay intact.
pub fn inject_turn_credentials(
    token: Option<&str>,
    api_key: Option<&str>,
    command: &mut Command,
) -> Option<TokenGuard> {
    let guard = inject_api_key(token, command);
    let oauth_won = token
        .map(str::trim)
        .map(|value| !value.is_empty() && !value.starts_with("vbk_"))
        .unwrap_or(false);
    if oauth_won {
        if let Some(key) = api_key
            .map(str::trim)
            .filter(|key| !key.is_empty() && key.starts_with("vbk_"))
        {
            eprintln!(
                "[verboo:auth-token] also injecting saved API key for CLI fallback ({} chars)",
                key.len()
            );
            command.env("ANTHROPIC_API_KEY", key);
        }
    }
    guard
}

/// Ensures the child inherits identity vars the CLI/keychain expect when the
/// parent is a GUI app (Dock launches often strip a full login shell env).
pub fn augment_identity_env(command: &mut Command) {
    if let Ok(home) = std::env::var("HOME") {
        command.env("HOME", home);
    }
    if let Ok(user) = std::env::var("USER") {
        command.env("USER", &user);
        command.env("LOGNAME", &user);
    } else if let Ok(logname) = std::env::var("LOGNAME") {
        command.env("LOGNAME", &logname);
        command.env("USER", &logname);
    }
}

pub struct TokenGuard;

#[cfg(test)]
mod tests {

    use super::*;

    #[test]
    fn none_key_leaves_unchanged() {
        let mut cmd = Command::new("echo");
        crate::services::cli_spawn::apply_creation_flags(&mut cmd);
        assert!(inject_api_key(None, &mut cmd).is_none());
    }

    #[test]
    fn empty_key_leaves_unchanged() {
        let mut cmd = Command::new("echo");
        crate::services::cli_spawn::apply_creation_flags(&mut cmd);
        assert!(inject_api_key(Some("  "), &mut cmd).is_none());
    }

    #[test]
    fn vbk_returns_guard() {
        let mut cmd = Command::new("echo");
        crate::services::cli_spawn::apply_creation_flags(&mut cmd);
        assert!(inject_api_key(Some("vbk_test_key_12345"), &mut cmd).is_some());
    }

    #[test]
    fn jwt_returns_guard() {
        let mut cmd = Command::new("echo");
        crate::services::cli_spawn::apply_creation_flags(&mut cmd);
        assert!(inject_api_key(Some("eyJhbGciOiJIUzI1NiJ9.real_jwt_token"), &mut cmd).is_some());
    }

    /// Reads an env var EXPLICITLY set on the command. `get_envs` only reports
    /// vars set via `env()` — an inherited parent `ANTHROPIC_API_KEY` never
    /// shows up here, which isolates the app-injected env in these tests.
    fn explicit_env(command: &Command, name: &str) -> Option<String> {
        command
            .get_envs()
            .find(|(key, _)| key.to_string_lossy() == name)
            .and_then(|(_, value)| value.map(|v| v.to_string_lossy().into_owned()))
    }

    // Issue #104 (field, macOS, CLI 0.15.18): with a saved vbk_ AND a stored
    // OAuth session, the turn spawn injected ONLY CLAUDE_CODE_OAUTH_TOKEN; when
    // the server rejects that OAuth the CLI's post-401 fallback reads
    // ANTHROPIC_API_KEY, finds nothing, and the turn dies as unauthenticated.
    #[test]
    fn oauth_and_vbk_inject_both_envs() {
        let mut cmd = Command::new("echo");
        crate::services::cli_spawn::apply_creation_flags(&mut cmd);
        let guard = inject_turn_credentials(
            Some("eyJhbGciOiJIUzI1NiJ9.real_jwt_token"),
            Some("vbk_test_key_12345"),
            &mut cmd,
        );
        assert!(guard.is_some());
        // OAuth keeps precedence…
        assert_eq!(
            explicit_env(&cmd, "CLAUDE_CODE_OAUTH_TOKEN").as_deref(),
            Some("eyJhbGciOiJIUzI1NiJ9.real_jwt_token"),
        );
        // …and the vbk_ rides along for the CLI fallback.
        assert_eq!(
            explicit_env(&cmd, "ANTHROPIC_API_KEY").as_deref(),
            Some("vbk_test_key_12345"),
        );
    }

    #[test]
    fn oauth_only_does_not_inject_app_api_key() {
        let mut cmd = Command::new("echo");
        crate::services::cli_spawn::apply_creation_flags(&mut cmd);
        let guard = inject_turn_credentials(
            Some("eyJhbGciOiJIUzI1NiJ9.real_jwt_token"),
            None,
            &mut cmd,
        );
        assert!(guard.is_some());
        assert_eq!(
            explicit_env(&cmd, "CLAUDE_CODE_OAUTH_TOKEN").as_deref(),
            Some("eyJhbGciOiJIUzI1NiJ9.real_jwt_token"),
        );
        assert_eq!(explicit_env(&cmd, "ANTHROPIC_API_KEY"), None);
    }

    #[test]
    fn oauth_only_ignores_non_vbk_api_key() {
        let mut cmd = Command::new("echo");
        crate::services::cli_spawn::apply_creation_flags(&mut cmd);
        let guard = inject_turn_credentials(
            Some("eyJhbGciOiJIUzI1NiJ9.real_jwt_token"),
            Some("sk-ant-something-else"),
            &mut cmd,
        );
        assert!(guard.is_some());
        assert_eq!(explicit_env(&cmd, "ANTHROPIC_API_KEY"), None);
    }

    #[test]
    fn vbk_only_keeps_current_behavior() {
        let mut cmd = Command::new("echo");
        crate::services::cli_spawn::apply_creation_flags(&mut cmd);
        let guard = inject_turn_credentials(
            Some("vbk_test_key_12345"),
            Some("vbk_test_key_12345"),
            &mut cmd,
        );
        assert!(guard.is_some());
        assert_eq!(
            explicit_env(&cmd, "ANTHROPIC_API_KEY").as_deref(),
            Some("vbk_test_key_12345"),
        );
        assert_eq!(explicit_env(&cmd, "CLAUDE_CODE_OAUTH_TOKEN"), None);
    }

    #[test]
    fn no_credentials_inject_nothing() {
        let mut cmd = Command::new("echo");
        crate::services::cli_spawn::apply_creation_flags(&mut cmd);
        assert!(inject_turn_credentials(None, None, &mut cmd).is_none());
        assert_eq!(explicit_env(&cmd, "CLAUDE_CODE_OAUTH_TOKEN"), None);
        assert_eq!(explicit_env(&cmd, "ANTHROPIC_API_KEY"), None);
    }
}
