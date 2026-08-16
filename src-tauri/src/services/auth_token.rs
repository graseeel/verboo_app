use std::process::Command;

use crate::services::cli_credentials;
use crate::services::credentials_store::CredentialsStore;

/// Resolves the best available bearer token for the current user.
///
/// Resolution order (CLI-first):
///   1. CLI OAuth token (with refresh) from the CLI keychain/store.
///   2. API key (`vbk_…`) from the app credential store.
pub fn resolve_token(credentials: &CredentialsStore) -> Option<String> {
    // Try CLI OAuth token first
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
    // Fallback to API key from credential store
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
}
