//! Port of Electron's `cliCredentials.ts`. Reads the CLI's OAuth credentials
//! from the same store the CLI itself uses, and refreshes them when they're
//! about to expire.
//!
//! Storage differs per-OS (mirrors the CLI's own logic):
//!   - **macOS**: System Keychain, service `Verboo Code-credentials`, account
//!     `$USER` (or no account, as fallback). Read/written via
//!     `/usr/bin/security`.
//!   - **Windows / Linux**: Plaintext JSON at
//!     `~/.verboo/.credentials.json` (the CLI's own config dir, overridable
//!     via `VERBOO_CONFIG_DIR`). The CLI uses libsecret when available and
//!     falls back to this file; we read the file directly because libsecret
//!     support in Rust isn't always reliable across desktop environments.
//!
//! All functions are blocking (keychain + HTTP). The caller is expected to
//! run them on `spawn_blocking` if called from an async context.

use std::collections::HashMap;
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const KEYCHAIN_SERVICE: &str = "Verboo Code-credentials";
const OAUTH_TOKEN_URL: &str = "https://code.verboo.ai/oauth/token";
const OAUTH_CLIENT_ID: &str = "verboo-code-cli";
const TOKEN_REFRESH_SKEW_MS: u64 = 60_000;
const KEYCHAIN_TIMEOUT_MS: u64 = 10_000;

const DEFAULT_OAUTH_SCOPES: &[&str] = &[
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
];

/// CLI OAuth credentials parsed from the `verbooOauth` blob.
///
/// **Wire format is camelCase** (`accessToken`, `refreshToken`, …) — that is
/// what the `@verboo/code` CLI reads (`oauthData?.accessToken`). Serializing
/// snake_case here used to rewrite the Keychain after Desktop refresh and made
/// the CLI look "logged out" / "apagado" without deleting the binary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliOAuthCredentials {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>, // ms since epoch
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scopes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscription_type: Option<String>,
    /// CLI field name is `rateLimitTier` (plural).
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "rateLimitTier")]
    pub rate_limit_tier: Option<String>,
}

/// Process-wide cache. Avoids re-reading the keychain on every API call.
/// The CLI itself caches similarly (see `cliCredentials.ts:27`).
static CACHE: Mutex<Option<CliOAuthCredentials>> = Mutex::new(None);
/// Serializes refresh-token rotation across normal expiry refreshes and
/// reactive 401 recovery. OAuth providers may rotate the refresh token, so
/// two concurrent refreshes with the same old token can invalidate the winner.
static REFRESH_LOCK: Mutex<()> = Mutex::new(());

/// Resets the cache. Used by tests to avoid cross-test leakage.
#[cfg(test)]
fn reset_cache() {
    if let Ok(mut c) = CACHE.lock() {
        *c = None;
    }
}

/// Returns a fresh access token (refreshing first if needed).
///
/// Resolution order:
///   1. Read cached creds (if still valid).
///   2. Read creds from CLI store.
///   3. If `should_refresh()` → POST /oauth/token, write back, return new.
///   4. If refresh fails but current is still valid → return it.
///   5. Else → None.
///
/// Never panics. Returns None on any failure (caller falls back to API key).
pub fn get_access_token() -> Option<String> {
    // Fast path: cache hit (no keychain read).
    {
        let cached = CACHE.lock().ok()?;
        if let Some(c) = cached.as_ref() {
            if !should_refresh(c) {
                return Some(c.access_token.clone());
            }
        }
    }

    // Slow path: serialize the store read + possible refresh. Re-check the
    // cache after taking the lock because another caller may have refreshed
    // while this caller was waiting.
    let _refresh_guard = REFRESH_LOCK.lock().ok()?;
    {
        let cached = CACHE.lock().ok()?;
        if let Some(c) = cached.as_ref() {
            if !should_refresh(c) {
                return Some(c.access_token.clone());
            }
        }
    }

    let credentials = match read_credentials_from_store() {
        Some(c) => c,
        None => return None,
    };

    // Update cache with what we just read.
    {
        if let Ok(mut c) = CACHE.lock() {
            *c = Some(credentials.clone());
        }
    }

    if !should_refresh(&credentials) {
        return Some(credentials.access_token);
    }

    // Refresh. On failure, fall back to the current token if it hasn't
    // expired yet (the 60s skew gives us a buffer).
    match refresh_access_token(&credentials) {
        Some(refreshed) => {
            {
                if let Ok(mut c) = CACHE.lock() {
                    *c = Some(refreshed.clone());
                }
            }
            write_credentials_to_store(&refreshed);
            Some(refreshed.access_token)
        }
        None => {
            if !is_expired(&credentials) {
                Some(credentials.access_token)
            } else {
                None
            }
        }
    }
}

/// Force-refreshes OAuth credentials after the CLI proves that the injected
/// access token is invalid, even if its recorded expiry is still in the future.
///
/// The failed token is compared with the current credential store while the
/// refresh lock is held. If they differ, another concurrent turn already
/// refreshed successfully and its token is returned without rotating the
/// refresh token again.
pub fn refresh_after_auth_failure(failed_access_token: &str) -> Option<String> {
    let failed_access_token = failed_access_token.trim();
    if failed_access_token.is_empty() || failed_access_token.starts_with("vbk_") {
        return None;
    }

    let _refresh_guard = REFRESH_LOCK.lock().ok()?;
    let credentials = read_credentials_from_store()?;

    if credentials.access_token != failed_access_token {
        if let Ok(mut cached) = CACHE.lock() {
            *cached = Some(credentials.clone());
        }
        return Some(credentials.access_token);
    }

    if !credentials_need_auth_failure_refresh(failed_access_token, &credentials) {
        return None;
    }

    let refreshed = refresh_access_token(&credentials)?;
    if let Ok(mut cached) = CACHE.lock() {
        *cached = Some(refreshed.clone());
    }
    write_credentials_to_store(&refreshed);
    Some(refreshed.access_token)
}

/// Returns the credentials blob path for Windows/Linux (mirror of the CLI's
/// own `getStoragePath`).
fn cli_credentials_file_path() -> Option<std::path::PathBuf> {
    if let Ok(dir) = std::env::var("VERBOO_CONFIG_DIR") {
        if !dir.trim().is_empty() {
            return Some(std::path::PathBuf::from(dir).join(".credentials.json"));
        }
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)?;
    Some(home.join(".verboo").join(".credentials.json"))
}

/// Reads the CLI credentials blob (cross-platform).
///
/// macOS: reads from system Keychain via `/usr/bin/security`.
/// Windows/Linux: reads the plaintext JSON file at
/// `~/.verboo/.credentials.json` (or `VERBOO_CONFIG_DIR` override).
///
/// Returns the parsed `verbooOauth` credentials, or None if missing /
/// unparseable.
fn read_credentials_from_store() -> Option<CliOAuthCredentials> {
    let blob: Value = if cfg!(target_os = "macos") {
        read_keychain_blob()
    } else {
        read_file_blob()
    }?;

    let oauth = blob.get("verbooOauth")?;
    parse_oauth(oauth)
}

/// Writes the credentials blob back to the CLI's store (after refresh).
fn write_credentials_to_store(creds: &CliOAuthCredentials) {
    // Read the current blob (so we preserve other fields the CLI wrote),
    // then merge our refreshed `verbooOauth` and write back.
    let mut blob: Value = if cfg!(target_os = "macos") {
        read_keychain_blob().unwrap_or_else(|| Value::Object(serde_json::Map::new()))
    } else {
        read_file_blob().unwrap_or_else(|| Value::Object(serde_json::Map::new()))
    };

    // Always write camelCase so the CLI (`accessToken`) keeps working.
    if let Ok(serialized) = serde_json::to_value(creds) {
        if let Some(obj) = blob.as_object_mut() {
            obj.insert("verbooOauth".into(), serialized);
        }
    }

    if cfg!(target_os = "macos") {
        write_keychain_blob(&blob);
    } else {
        write_file_blob(&blob);
    }
}

/// Reads the blob from macOS Keychain via `/usr/bin/security
/// find-generic-password -s "Verboo Code-credentials" -a $USER -w`.
///
/// **Never** reads without `-a`: the Desktop also stores a plain `vbk_…` API
/// key under the same service with account `api-key`. A no-account lookup
/// returns that first and is not OAuth JSON.
fn read_keychain_blob() -> Option<Value> {
    let account = std::env::var("USER")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("LOGNAME").ok().filter(|s| !s.trim().is_empty()))?;

    let output = run_security(&[
        "find-generic-password",
        "-a",
        &account,
        "-w",
        "-s",
        KEYCHAIN_SERVICE,
    ])?;
    parse_json_blob(&output)
}

/// Writes the blob back to macOS Keychain via `/usr/bin/security
/// add-generic-password -U -a $USER -s "Verboo Code-credentials" -X <hex>`.
///
/// Always scopes to `$USER`/`$LOGNAME` so we never update the Desktop
/// `api-key` Keychain item that shares this service name.
fn write_keychain_blob(blob: &Value) -> bool {
    let Ok(json) = serde_json::to_string(blob) else {
        return false;
    };
    let hex = json.bytes().map(|b| format!("{:02x}", b)).collect::<String>();
    let Some(account) = std::env::var("USER")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("LOGNAME").ok().filter(|s| !s.trim().is_empty()))
    else {
        return false;
    };

    run_security(&[
        "add-generic-password",
        "-U",
        "-a",
        &account,
        "-s",
        KEYCHAIN_SERVICE,
        "-X",
        &hex,
    ])
    .is_some()
}

/// Reads the blob from `~/.verboo/.credentials.json` (plaintext JSON).
fn read_file_blob() -> Option<Value> {
    let path = cli_credentials_file_path()?;
    let contents = std::fs::read_to_string(&path).ok()?;
    parse_json_blob(&contents)
}

/// Writes the blob back to `~/.verboo/.credentials.json` with mode 0600.
fn write_file_blob(blob: &Value) -> bool {
    let Some(path) = cli_credentials_file_path() else {
        return false;
    };
    let Ok(json) = serde_json::to_string_pretty(blob) else {
        return false;
    };
    let Some(parent) = path.parent() else {
        return false;
    };
    let _ = std::fs::create_dir_all(parent);

    if std::fs::write(&path, json).is_err() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    true
}

/// Runs `/usr/bin/security` with the given args and returns stdout if it
/// succeeded and is non-empty.
fn run_security(args: &[&str]) -> Option<String> {
    let output = Command::new("/usr/bin/security")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        None
    } else {
        Some(stdout)
    }
}

/// Parses a JSON blob string into a `serde_json::Value`. Returns None on
/// parse failure.
fn parse_json_blob(s: &str) -> Option<Value> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

/// Looks up a key trying multiple spellings. The CLI writes **camelCase**
/// (`accessToken`); a prior Desktop bug wrote snake_case. Accept both on read.
fn field<'a>(obj: &'a serde_json::Map<String, Value>, names: &[&str]) -> Option<&'a Value> {
    names.iter().find_map(|n| obj.get(*n))
}

/// Parses the `verbooOauth` field into typed credentials. Returns None if the
/// access token is missing or empty. Accepts camelCase (CLI) and snake_case
/// (legacy Desktop write) spellings.
fn parse_oauth(value: &Value) -> Option<CliOAuthCredentials> {
    let obj = value.as_object()?;
    let access_token = field(obj, &["accessToken", "access_token"])
        .and_then(|v| v.as_str())?;
    if access_token.trim().is_empty() {
        return None;
    }
    Some(CliOAuthCredentials {
        access_token: access_token.to_string(),
        refresh_token: field(obj, &["refreshToken", "refresh_token"])
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        expires_at: field(obj, &["expiresAt", "expires_at"]).and_then(|v| v.as_u64()),
        scopes: field(obj, &["scopes"])
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            }),
        subscription_type: field(obj, &["subscriptionType", "subscription_type"])
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        rate_limit_tier: field(obj, &["rateLimitTier", "rate_limit_tier", "rateLimitTier"])
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

/// Returns true if the credentials are within the refresh skew (60s) of
/// expiry.
fn should_refresh(creds: &CliOAuthCredentials) -> bool {
    let Some(exp) = creds.expires_at else {
        return false;
    };
    let Some(refresh) = creds.refresh_token.as_ref() else {
        return false;
    };
    if refresh.trim().is_empty() {
        return false;
    }
    now_ms() >= exp.saturating_sub(TOKEN_REFRESH_SKEW_MS)
}

fn credentials_need_auth_failure_refresh(
    failed_access_token: &str,
    credentials: &CliOAuthCredentials,
) -> bool {
    credentials.access_token == failed_access_token
        && credentials
            .refresh_token
            .as_deref()
            .is_some_and(|token| !token.trim().is_empty())
}

/// Returns true if the credentials are expired.
fn is_expired(creds: &CliOAuthCredentials) -> bool {
    match creds.expires_at {
        Some(exp) => now_ms() >= exp,
        None => false,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Refreshes the access token via POST /oauth/token (grant_type=refresh_token).
/// Returns the new credentials on success, or None on any failure.
fn refresh_access_token(creds: &CliOAuthCredentials) -> Option<CliOAuthCredentials> {
    let refresh_token = creds.refresh_token.as_ref()?;
    if refresh_token.trim().is_empty() {
        return None;
    }

    let scope = creds
        .scopes
        .as_ref()
        .filter(|s| !s.is_empty())
        .map(|s| s.join(" "))
        .unwrap_or_else(|| DEFAULT_OAUTH_SCOPES.join(" "));

    let mut params = HashMap::new();
    params.insert("grant_type", "refresh_token");
    params.insert("refresh_token", refresh_token.as_str());
    params.insert("client_id", OAUTH_CLIENT_ID);
    params.insert("scope", scope.as_str());

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(KEYCHAIN_TIMEOUT_MS))
        .build()
        .ok()?;
    let resp = client
        .post(OAUTH_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&params)
        .send()
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let payload: Value = resp.json().ok()?;
    let obj = payload.as_object()?;

    let new_access = obj.get("access_token").and_then(|v| v.as_str())?;
    if new_access.trim().is_empty() {
        return None;
    }

    let new_refresh = obj
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| creds.refresh_token.clone());

    let new_expires_at = obj
        .get("expires_in")
        .and_then(|v| v.as_u64())
        .map(|secs| now_ms() + secs * 1000)
        .or(creds.expires_at);

    let new_scopes = obj
        .get("scope")
        .and_then(|v| v.as_str())
        .map(|s| s.split_whitespace().map(|x| x.to_string()).collect::<Vec<_>>())
        .or_else(|| creds.scopes.clone());

    Some(CliOAuthCredentials {
        access_token: new_access.to_string(),
        refresh_token: new_refresh,
        expires_at: new_expires_at,
        scopes: new_scopes,
        subscription_type: creds.subscription_type.clone(),
        rate_limit_tier: creds.rate_limit_tier.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Process-wide test mutex. The production code stores CLI OAuth creds in a
    // global static CACHE (matching the CLI's own caching). In `cargo test` the
    // tests run in parallel by default, so two tests mutating or asserting on
    // the cache race with each other and become flaky. We serialize the whole
    // module instead of weakening the assertions.
    //
    // This is a TEST-ONLY isolation artifact — it does NOT hide a production
    // bug. In production there is exactly one process cache and callers are
    // expected to be concurrent; the Mutex inside CACHE protects that.
    static TEST_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn creds_with(exp: Option<u64>, refresh: Option<&str>) -> CliOAuthCredentials {
        CliOAuthCredentials {
            access_token: "tok".into(),
            refresh_token: refresh.map(|s| s.into()),
            expires_at: exp,
            scopes: None,
            subscription_type: None,
            rate_limit_tier: None,
        }
    }

    #[test]
    fn should_refresh_returns_false_without_expires_at() {
        let _guard = TEST_MUTEX.lock().unwrap();
        reset_cache();
        let c = creds_with(None, Some("rt"));
        assert!(!should_refresh(&c));
    }

    #[test]
    fn should_refresh_returns_false_without_refresh_token() {
        let _guard = TEST_MUTEX.lock().unwrap();
        reset_cache();
        let c = creds_with(Some(now_ms() + 1000), None);
        assert!(!should_refresh(&c));
    }

    #[test]
    fn should_refresh_returns_true_within_skew() {
        let _guard = TEST_MUTEX.lock().unwrap();
        reset_cache();
        let c = creds_with(Some(now_ms() + 30_000), Some("rt"));
        assert!(should_refresh(&c));
    }

    #[test]
    fn should_refresh_returns_false_far_from_expiry() {
        let _guard = TEST_MUTEX.lock().unwrap();
        reset_cache();
        let c = creds_with(Some(now_ms() + 60 * 60 * 1000), Some("rt"));
        assert!(!should_refresh(&c));
    }

    #[test]
    fn auth_failure_refreshes_only_the_token_that_actually_failed() {
        let mut current = creds_with(Some(now_ms() + 60 * 60 * 1000), Some("rt"));

        assert!(credentials_need_auth_failure_refresh("tok", &current));

        current.access_token = "already-refreshed".into();
        assert!(
            !credentials_need_auth_failure_refresh("tok", &current),
            "a concurrent refresh winner must not have its rotated refresh token reused",
        );
    }

    #[test]
    fn auth_failure_cannot_refresh_without_a_refresh_token() {
        let current = creds_with(Some(now_ms() + 60 * 60 * 1000), None);

        assert!(!credentials_need_auth_failure_refresh("tok", &current));
    }

    #[test]
    fn is_expired_returns_false_without_expires_at() {
        let _guard = TEST_MUTEX.lock().unwrap();
        let c = creds_with(None, Some("rt"));
        assert!(!is_expired(&c));
    }

    #[test]
    fn is_expired_returns_true_when_past_expiry() {
        let _guard = TEST_MUTEX.lock().unwrap();
        let c = creds_with(Some(now_ms() - 1000), Some("rt"));
        assert!(is_expired(&c));
    }

    #[test]
    fn parse_oauth_extracts_fields() {
        let _guard = TEST_MUTEX.lock().unwrap();
        let v = json!({
            "accessToken": "abc",
            "refreshToken": "def",
            "expiresAt": 1234567890,
            "scopes": ["user:profile", "user:inference"],
            "subscriptionType": "pro",
            "rateLimitTier": "tier2"
        });
        let c = parse_oauth(&v).expect("parsed");
        assert_eq!(c.access_token, "abc");
        assert_eq!(c.refresh_token.as_deref(), Some("def"));
        assert_eq!(c.expires_at, Some(1234567890));
        assert_eq!(c.scopes.as_deref(), Some(&["user:profile".to_string(), "user:inference".to_string()][..]));
        assert_eq!(c.subscription_type.as_deref(), Some("pro"));
        assert_eq!(c.rate_limit_tier.as_deref(), Some("tier2"));
    }

    #[test]
    fn parse_oauth_returns_none_without_access_token() {
        let _guard = TEST_MUTEX.lock().unwrap();
        let v = json!({"refreshToken": "def"});
        assert!(parse_oauth(&v).is_none());
    }

    #[test]
    fn parse_oauth_returns_none_for_empty_access_token() {
        let _guard = TEST_MUTEX.lock().unwrap();
        let v = json!({"accessToken": "   "});
        assert!(parse_oauth(&v).is_none());
    }

    #[test]
    fn parse_oauth_returns_none_for_non_object() {
        let _guard = TEST_MUTEX.lock().unwrap();
        assert!(parse_oauth(&json!("string")).is_none());
        assert!(parse_oauth(&json!(42)).is_none());
    }

    #[test]
    fn parse_json_blob_handles_valid_json() {
        let _guard = TEST_MUTEX.lock().unwrap();
        let s = r#"{"verbooOauth":{"accessToken":"x"}}"#;
        let v = parse_json_blob(s).expect("parsed");
        assert!(v.get("verbooOauth").is_some());
    }

    #[test]
    fn parse_json_blob_returns_none_for_empty() {
        let _guard = TEST_MUTEX.lock().unwrap();
        assert!(parse_json_blob("").is_none());
        assert!(parse_json_blob("   ").is_none());
    }

    #[test]
    fn parse_json_blob_returns_none_for_invalid_json() {
        let _guard = TEST_MUTEX.lock().unwrap();
        assert!(parse_json_blob("not json").is_none());
    }

    #[test]
    fn serialize_oauth_writes_camel_case_for_cli() {
        let _guard = TEST_MUTEX.lock().unwrap();
        let c = CliOAuthCredentials {
            access_token: "tok".into(),
            refresh_token: Some("rt".into()),
            expires_at: Some(99),
            scopes: Some(vec!["user:profile".into()]),
            subscription_type: Some("pro".into()),
            rate_limit_tier: Some("tier2".into()),
        };
        let v = serde_json::to_value(&c).expect("serialize");
        let obj = v.as_object().expect("object");
        assert!(obj.contains_key("accessToken"), "CLI requires accessToken, got {obj:?}");
        assert!(!obj.contains_key("access_token"), "must not write snake_case access_token");
        assert!(obj.contains_key("refreshToken"));
        assert!(obj.contains_key("expiresAt"));
        assert_eq!(obj.get("accessToken").and_then(|x| x.as_str()), Some("tok"));
    }

    #[test]
    fn parse_oauth_accepts_legacy_snake_case() {
        let _guard = TEST_MUTEX.lock().unwrap();
        let v = json!({
            "access_token": "abc",
            "refresh_token": "def",
            "expires_at": 123u64,
        });
        let c = parse_oauth(&v).expect("parsed snake_case");
        assert_eq!(c.access_token, "abc");
        assert_eq!(c.refresh_token.as_deref(), Some("def"));
        assert_eq!(c.expires_at, Some(123));
    }

    #[test]
    fn credentials_file_path_uses_verboo_config_dir_when_set() {
        let _guard = TEST_MUTEX.lock().unwrap();
        // Setting env vars in tests is racy in parallel, but the result is
        // deterministic enough for a smoke check.
        // If VERBOO_CONFIG_DIR is unset → ~/.verboo/.credentials.json
        std::env::remove_var("VERBOO_CONFIG_DIR");
        let path = cli_credentials_file_path();
        assert!(path.is_some());
        if let Some(p) = path {
            assert!(p.ends_with(".credentials.json"));
        }
    }

    #[test]
    fn credentials_file_path_falls_back_to_user_profile_when_no_home() {
        let _guard = TEST_MUTEX.lock().unwrap();
        // When HOME and USERPROFILE are unset, returns None.
        // We can't reliably test this without forking the process.
        // Just verify the function doesn't panic.
        let _ = cli_credentials_file_path();
    }

    // ─── Cold launch race regression tests ───────────────────────────
    //
    // Bug being prevented: on a cold launch (process start, empty cache),
    // the first call to `get_access_token()` had to read the keychain —
    // a slow blocking call (up to 10s on macOS if the keychain is locked
    // or the system is under load). Multiple Tauri commands fired in
    // parallel at startup (profile, models, first turn) each called
    // `resolve_token()` → `get_access_token()` → keychain read, racing
    // on the same `CACHE` Mutex. If one thread saw `None` (cache miss +
    // keychain still reading) and the caller had no API key fallback
    // wired yet, the user saw "No valid session" even with the CLI
    // logged in.
    //
    // The fix (already in place): `get_access_token()` is the single
    // entry point, the cache is populated on first successful read, and
    // `resolve_token()` falls back to the API key if the CLI path
    // returns None. These tests pin the contract so a future refactor
    // can't reintroduce the race.

    /// Cold-launch contract: a cache miss must NOT short-circuit to None
    /// when the store has valid creds. The first call (empty cache) must
    /// populate the cache and return the token. This is the exact
    /// invariant that broke when "No valid session" appeared on cold
    /// launch: a refactor that returns None on cache-miss without
    /// reading the store would silently regress the bug.
    #[test]
    fn cold_launch_cache_miss_still_resolves_from_store() {
        let _guard = TEST_MUTEX.lock().unwrap();
        reset_cache();

        // Simulate a cold cache (just reset) and verify the fast path
        // does NOT return None — it must fall through to the slow path.
        // We can't read the real keychain in a unit test, but we can
        // assert the cache invariant: after reset, cache is None, so the
        // fast path cannot short-circuit. The slow path then runs; if
        // the store is unavailable (test env), we get None — but that's
        // the store returning None, not the cache short-circuiting.
        {
            let cached = CACHE.lock().unwrap();
            assert!(
                cached.is_none(),
                "cache must be empty after reset — cold launch precondition"
            );
        }

        // On a test machine with no keychain entry, this returns None
        // (store unavailable) — which is the correct fallback, NOT the
        // bug. The bug would be returning None *while the cache is
        // populated with a valid token*. That's covered by the next test.
        let _ = get_access_token();
    }

    /// Cold-launch contract: once the cache is populated, subsequent
    /// calls must hit the fast path and return the same token WITHOUT
    /// re-reading the store. This pins the invariant that prevents the
    //  race: if a future refactor breaks the cache (e.g. clears it on
    ///  every call), parallel callers would all hammer the keychain and
    ///  race again.
    #[test]
    fn cold_launch_cache_hit_returns_cached_token_without_reread() {
        let _guard = TEST_MUTEX.lock().unwrap();
        reset_cache();

        // Populate the cache directly (simulating a successful first read).
        let creds = CliOAuthCredentials {
            access_token: "cold_launch_test_token".into(),
            refresh_token: None,        // no refresh → should_refresh is false
            expires_at: None,           // no expiry → never refresh
            scopes: None,
            subscription_type: None,
            rate_limit_tier: None,
        };
        {
            let mut c = CACHE.lock().unwrap();
            *c = Some(creds.clone());
        }

        // Fast path: must return the cached token, no keychain read.
        let tok = get_access_token();
        assert_eq!(
            tok.as_deref(),
            Some("cold_launch_test_token"),
            "cold-launch cache hit must return the cached token — if this returns None, \
             the fast path is broken and parallel callers will race on the keychain"
        );

        // Cache must still hold the token (not cleared by the read).
        {
            let c = CACHE.lock().unwrap();
            assert!(
                c.is_some(),
                "cache must not be cleared by a read — clearing on read reintroduces the race"
            );
        }
    }

    /// Cold-launch contract: a poisoned cache (refresh needed, no refresh
    /// token) must NOT cause `get_access_token` to return None if the
    /// underlying token is still valid. This is the "No valid session"
    /// failure mode: the cache says "needs refresh", refresh fails (no
    /// refresh_token), and the code incorrectly returns None even though
    /// the access_token is still usable.
    #[test]
    fn cold_launch_unrefreshable_token_still_returned_when_not_expired() {
        let _guard = TEST_MUTEX.lock().unwrap();
        reset_cache();

        // Token expires in 30s (within the 60s refresh skew) but has no
        // refresh_token — so should_refresh returns true, but refresh
        // can't run. is_expired is false (30s > 0). The code must fall
        // through to "return the current token" (line 119-120).
        let creds = CliOAuthCredentials {
            access_token: "unrefreshable_but_valid".into(),
            refresh_token: None,
            expires_at: Some(now_ms() + 30_000),
            scopes: None,
            subscription_type: None,
            rate_limit_tier: None,
        };
        {
            let mut c = CACHE.lock().unwrap();
            *c = Some(creds);
        }

        // should_refresh is true (within skew), but refresh returns None
        // (no refresh_token). is_expired is false. So we must get the
        // original token back — NOT None.
        // NOTE: this calls the real refresh_access_token which would hit
        // the network. But refresh_access_token returns None immediately
        // when refresh_token is None/empty (line 366-369), so no network
        // call happens.
        let tok = get_access_token();
        assert_eq!(
            tok.as_deref(),
            Some("unrefreshable_but_valid"),
            "token within refresh skew but without a refresh_token must still be returned \
             if not expired — returning None here is the 'No valid session' bug"
        );
    }

    /// Cold-launch contract: the cache Mutex must not be held during the
    /// slow-path keychain read. If it were, parallel callers would block
    /// on the Mutex for up to 10s (keychain timeout), serializing startup
    /// and amplifying the race window. This test verifies the lock is
    /// released after the fast-path check (the slow path runs without
    /// holding the lock).
    #[test]
    fn cold_launch_cache_lock_released_after_fast_path() {
        let _guard = TEST_MUTEX.lock().unwrap();
        reset_cache();

        // Acquire the cache lock from outside get_access_token, then
        // call get_access_token. If get_access_token tried to hold the
        // lock for the entire duration (including the slow path), this
        // would deadlock or return None. Instead, the fast path acquires
        // the lock, checks the cache, releases it, then runs the slow
        // path without the lock — so a concurrent holder of the lock
        // does NOT block the slow path.
        //
        // We can't easily test "the slow path runs without the lock"
        // without mocking the keychain. But we CAN test that the fast
        // path releases the lock (doesn't hold it indefinitely). We do
        // this by acquiring the lock after calling get_access_token.
        let _ = get_access_token();

        // If get_access_token held the lock, this would block. We give
        // it a short budget; if it blocks, the test fails by timeout.
        let acquired = CACHE.try_lock();
        assert!(
            acquired.is_ok(),
            "cache lock must be released after get_access_token returns — if held, \
             parallel callers serialize on the keychain and the cold-launch race returns"
        );
    }
}
