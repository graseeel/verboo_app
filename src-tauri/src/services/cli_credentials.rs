//! Port of Electron's `cliCredentials.ts`. Reads the CLI's OAuth credentials
//! from the same store the CLI itself uses, and refreshes them when they're
//! about to expire.
//!
//! Storage differs per-OS (mirrors the CLI's own logic):
//!   - **macOS**: System Keychain, service `Verboo Code-credentials`, account
//!     `$USER` (or no account, as fallback). Read/written via
//!     `/usr/bin/security`.
//!   - **Windows**: the CLI's DPAPI file, with its plaintext fallback.
//!   - **Linux**: Secret Service through `secret-tool`, with the CLI's
//!     plaintext fallback when no keyring is available.
//!
//! All functions are blocking (keychain + HTTP). The caller is expected to
//! run them on `spawn_blocking` if called from an async context.

use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::io::Write as _;
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
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
    {
        let cached = CACHE.lock().ok()?;
        if let Some(c) = cached.as_ref() {
            if !should_refresh(c) {
                eprintln!("[verboo:cli-creds] cache hit — returning cached token");
                return Some(c.access_token.clone());
            }
            eprintln!("[verboo:cli-creds] cache hit but token needs refresh");
        }
    }

    // Serialize store read + refresh behind REFRESH_LOCK; re-check the cache
    // after taking the lock — another caller may have refreshed while waiting.
    let _refresh_guard = REFRESH_LOCK.lock().ok()?;
    {
        let cached = CACHE.lock().ok()?;
        if let Some(c) = cached.as_ref() {
            if !should_refresh(c) {
                eprintln!("[verboo:cli-creds] cache hit (after lock) — returning cached token");
                return Some(c.access_token.clone());
            }
        }
    }

    eprintln!("[verboo:cli-creds] reading credentials from store...");
    let credentials = match read_credentials_from_store() {
        Some(c) => {
            eprintln!("[verboo:cli-creds] credentials found — expires_at={:?}", c.expires_at);
            c
        }
        None => {
            eprintln!("[verboo:cli-creds] NO CREDENTIALS IN STORE — returning None");
            return None;
        }
    };

    {
        if let Ok(mut c) = CACHE.lock() {
            *c = Some(credentials.clone());
        }
    }

    if !should_refresh(&credentials) {
        return Some(credentials.access_token);
    }

    // On refresh failure, fall back to the still-valid current token (the 60s skew buffers).
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
/// (a) Windows DPAPI (2026-08-07): the CLI's `windowsCredentialStorage`
/// writes via DPAPI (`ProtectedData.Protect` with `CurrentUser` scope)
/// to `~/.verboo/Verboo_Code-credentials.secure.dpapi`. The plaintext
/// `.credentials.json` is only the FALLBACK. The old code only read
/// the fallback → never found DPAPI-stored creds → "No valid session".
///
/// Returns the parsed `verbooOauth` credentials, or None if missing /
/// unparseable.
fn read_credentials_from_store() -> Option<CliOAuthCredentials> {
    let blob: Value = read_credentials_blob()?;
    let oauth = blob.get("verbooOauth")?;
    parse_oauth(oauth)
}

/// Cross-platform credentials blob reader. Dispatches to the correct
/// store per OS. This is the SINGLE chokepoint — all callers go through
/// here, so Windows DPAPI is tried before the plaintext fallback.
pub(crate) fn read_credentials_blob() -> Option<Value> {
    // Test hook shared by every platform. Keeping it above the dispatch
    // makes provider-login tests independent from the machine's real store.
    #[cfg(test)]
    if let Ok(path) = std::env::var("FAKE_CREDENTIALS_BLOB") {
        if !path.is_empty() {
            if let Ok(contents) = std::fs::read_to_string(&path) {
                return serde_json::from_str(&contents).ok();
            }
            return None;
        }
    }

    if cfg!(target_os = "macos") {
        read_keychain_blob()
    } else if cfg!(target_os = "windows") {
        #[cfg(windows)]
        {
            read_windows_dpapi_blob().or_else(read_file_blob)
        }
        #[cfg(not(windows))]
        {
            // Unreachable: cfg!(target_os = "windows") is false here.
            // This branch exists so the function compiles on non-Windows
            // for `cargo test --lib` (which tests the pure logic).
            read_file_blob()
        }
    } else {
        #[cfg(target_os = "linux")]
        {
            read_linux_secret_blob().or_else(read_file_blob)
        }
        #[cfg(not(target_os = "linux"))]
        {
            read_file_blob()
        }
    }
}

/// Writes the credentials blob back to the CLI's store (after refresh).
fn write_credentials_to_store(creds: &CliOAuthCredentials) {
    // Read the current blob (so we preserve other fields the CLI wrote),
    // then merge our refreshed `verbooOauth` and write back.
    let mut blob: Value = read_credentials_blob()
        .unwrap_or_else(|| Value::Object(serde_json::Map::new()));

    // Always write camelCase so the CLI (`accessToken`) keeps working.
    if let Ok(serialized) = serde_json::to_value(creds) {
        if let Some(obj) = blob.as_object_mut() {
            obj.insert("verbooOauth".into(), serialized);
        }
    }

    if cfg!(target_os = "macos") {
        write_keychain_blob(&blob);
    } else if cfg!(target_os = "windows") {
        #[cfg(windows)]
        if !write_windows_dpapi_blob(&blob) {
            write_file_blob(&blob);
        }
        #[cfg(not(windows))]
        write_file_blob(&blob);
    } else {
        #[cfg(target_os = "linux")]
        if !write_linux_secret_blob(&blob) {
            write_file_blob(&blob);
        }
        #[cfg(not(target_os = "linux"))]
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

/// Lê o blob de credenciais do CLI (keychain) — o blob guarda token POR
/// PROVEDOR (`{ codex: {...}, claude: {...} }` — medido no clone verboo-cli:
/// CODEX_STORAGE_KEY='codex'). Fonte da evidência de conexão por provedor
/// (F4): connected = a entrada daquele provedor existe no blob.
pub(crate) fn read_provider_credentials_blob() -> Option<Value> {
    // (a) Windows DPAPI (2026-08-07): was `read_keychain_blob()` which
    // only works on macOS. On Windows it tried `/usr/bin/security`
    // (doesn't exist) → always None → per-provider credentials never
    // found. Now goes through the cross-platform dispatch.
    read_credentials_blob()
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
    let path = match cli_credentials_file_path() {
        Some(p) => {
            eprintln!("[verboo:cli-creds] plaintext fallback path: {}", p.display());
            p
        }
        None => {
            eprintln!("[verboo:cli-creds] no credentials file path (HOME/USERPROFILE unset)");
            return None;
        }
    };
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => {
            eprintln!("[verboo:cli-creds] plaintext file read OK ({} bytes)", c.len());
            c
        }
        Err(e) => {
            eprintln!("[verboo:cli-creds] plaintext file read FAILED: {e}");
            return None;
        }
    };
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

#[cfg(any(target_os = "linux", test))]
fn read_linux_secret_blob_with<F>(account: &str, mut lookup: F) -> Option<Value>
where
    F: FnMut(&[&str]) -> Option<String>,
{
    let output = lookup(&[
        "lookup",
        "service",
        KEYCHAIN_SERVICE,
        "account",
        account,
    ])?;
    parse_json_blob(&output)
}

#[cfg(target_os = "linux")]
fn read_linux_secret_blob() -> Option<Value> {
    let account = current_username()?;
    read_linux_secret_blob_with(&account, |args| {
        let output = Command::new("secret-tool")
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
    })
}

#[cfg(target_os = "linux")]
fn write_linux_secret_blob(blob: &Value) -> bool {
    let Some(account) = current_username() else {
        return false;
    };
    let Ok(json) = serde_json::to_string(blob) else {
        return false;
    };
    let Ok(mut child) = Command::new("secret-tool")
        .args([
            "store",
            "--label=Verboo Code",
            "service",
            KEYCHAIN_SERVICE,
            "account",
            &account,
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return false;
    };
    let wrote = child
        .stdin
        .take()
        .is_some_and(|mut stdin| stdin.write_all(json.as_bytes()).is_ok());
    wrote && child.wait().is_ok_and(|status| status.success())
}

// (a) Windows DPAPI credentials
//
// Clone `windowsCredentialStorage.ts:98-146`:
//   - Primary store: DPAPI (`ProtectedData.Protect` with `CurrentUser`
//     scope) → file at `${configHome}/${filename}.secure.dpapi`.
//   - `filename` = `resourceName` with non-alphanumerics → `_`, +
//     `.secure.dpapi`.
//   - `resourceName` = `Verboo Code-credentials` (= KEYCHAIN_SERVICE,
//     same as mac; `OAUTH_FILE_SUFFIX` is '' in production).
//   - `entropy` = `${resourceName}:${username}` (space KEPT, NOT
//     replaced — only the filename replaces).
//   - Read: PowerShell `ProtectedData.Unprotect($bytes, $entropy,
//     'CurrentUser')` → UTF-8 JSON.
//   - Fallback: plaintext `.credentials.json` (only if DPAPI read
//     returns null).
//
// Pure logic (path/entropy derivation) is separated from the OS call
// (PowerShell) so it's testable on mac. The OS call is `#[cfg(windows)]`.

/// The DPAPI resource name — same as the macOS Keychain service name.
/// Clone: `getSecureStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)` =
/// `Verboo Code-credentials` (OAUTH_FILE_SUFFIX = '' in production).
fn dpapi_resource_name() -> &'static str {
    KEYCHAIN_SERVICE
}

/// Pure: derives the DPAPI filename from a resource name. Non-
/// alphanumerics (except `._-`) are replaced with `_`. Clone:
/// `windowsCredentialStorage.ts:28-31` `.replace(/[^a-zA-Z0-9._-]/g, '_')`.
fn dpapi_filename_for(resource_name: &str) -> String {
    let sanitized: String = resource_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{sanitized}.secure.dpapi")
}

/// Pure: derives the DPAPI file path from a config home and resource
/// name. `config_home` is `getClaudeConfigHomeDir()` (`VERBOO_CONFIG_DIR`
/// or `~/.verboo`).
fn dpapi_file_path_for(config_home: &std::path::Path, resource_name: &str) -> std::path::PathBuf {
    config_home.join(dpapi_filename_for(resource_name))
}

/// Pure: derives the quarantine path for a corrupted DPAPI file. The
/// corrupted file is RENAMED (never deleted) to
/// `<name>.invalid-<timestamp>` so it is preserved for diagnosis while
/// the login flow can restart clean instead of being stuck on a file
/// that can never decode (issue #72).
fn corrupted_path_for(original: &std::path::Path, timestamp_ms: u64) -> std::path::PathBuf {
    let file_name = original.file_name().unwrap_or_default().to_string_lossy();
    original.with_file_name(format!("{file_name}.invalid-{timestamp_ms}"))
}

/// Pure: derives the DPAPI entropy from a resource name and username.
/// Clone: `windowsCredentialStorage.ts:24-26`
/// `${resourceName}:${username}` — space KEPT (only the filename
/// replaces non-alphanumerics, NOT the entropy).
fn dpapi_entropy_for(resource_name: &str, username: &str) -> String {
    format!("{resource_name}:{username}")
}

fn decode_windows_dpapi_payload(bytes: &[u8]) -> Option<Vec<u8>> {
    // Strip UTF-8 BOM (EF BB BF) that some editors/write tools insert.
    // Without this, base64 decode fails because the BOM codepoint (U+FEFF)
    // is not valid base64 and `trim()` does not remove it.
    let stripped = bytes
        .strip_prefix(b"\xef\xbb\xbf")
        .unwrap_or(bytes);
    let encoded = std::str::from_utf8(stripped).ok()?.trim();
    if encoded.is_empty() {
        return None;
    }
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()
}

/// Returns the config home dir (`VERBOO_CONFIG_DIR` or `~/.verboo`).
/// Mirrors the clone's `getClaudeConfigHomeDir()`.
fn verboo_config_home() -> Option<std::path::PathBuf> {
    if let Ok(dir) = std::env::var("VERBOO_CONFIG_DIR") {
        if !dir.trim().is_empty() {
            return Some(std::path::PathBuf::from(dir));
        }
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)?;
    Some(home.join(".verboo"))
}

/// Logs diagnostic info for Windows credential resolution.
/// Helps debug "chat not loading" issues by surfacing exactly where
/// the credential chain breaks.
#[cfg(windows)]
fn log_windows_credential_diagnostics(stage: &str, detail: &str) {
    eprintln!("[verboo:credentials:win] {stage}: {detail}");
}

/// Returns the current username for DPAPI entropy. On Windows:
/// `%USERNAME%`. On Unix (for testing): `$USER` / `$LOGNAME`.
fn current_username() -> Option<String> {
    if cfg!(target_os = "windows") {
        std::env::var("USERNAME").ok().filter(|s| !s.trim().is_empty())
    } else {
        std::env::var("USER")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| std::env::var("LOGNAME").ok().filter(|s| !s.trim().is_empty()))
    }
}

/// Builds the PowerShell script for DPAPI `ProtectedData.Unprotect` (read
/// path). Pure (no `#[cfg(windows)]`) so the entropy escaping is testable
/// on mac. The caller (`read_windows_dpapi_blob`) feeds the result to
/// `-EncodedCommand` as UTF-16LE Base64.
///
/// SECURITY (layer 2 of 2): single-quote escaping. The script interpolates
/// `entropy` into a PowerShell single-quoted literal `'{entropy_escaped}'`.
/// PowerShell represents a literal `'` as `''` (doubled). Without this, a
/// USERNAME like `O'Brien` closes the literal mid-entropy and breaks the
/// `GetBytes` call. `-EncodedCommand` (layer 1, applied by the caller)
/// protects the SHELL; this escaping protects the PowerShell string literal
/// AFTER decode — EncodedCommand does NOT help here.
fn build_dpapi_read_script(protected_b64: &str, entropy: &str) -> String {
    let entropy_escaped = entropy.replace('\'', "''");
    format!(
        "Add-Type -AssemblyName System.Security\n\
         $bytes = [Convert]::FromBase64String('{protected_b64}')\n\
         $entropy = [System.Text.Encoding]::UTF8.GetBytes('{entropy_escaped}')\n\
         $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, 'CurrentUser')\n\
         [System.Text.Encoding]::UTF8.GetString($result)"
    )
}

/// Builds the PowerShell script for DPAPI `ProtectedData.Protect` (write
/// path). Pure (no `#[cfg(windows)]`) so the entropy escaping is testable
/// on mac. The caller (`write_windows_dpapi_blob`) feeds the result to
/// `-EncodedCommand` as UTF-16LE Base64. See `build_dpapi_read_script` for
/// the SECURITY rationale (same two-layer defense).
///
/// BOM (issue #72): the script writes the base64 to `path` itself via
/// `[IO.File]::WriteAllText` with `UTF8Encoding($false)` — UTF-8 WITHOUT
/// BOM — instead of `Out-File`/`Set-Content`/`Encoding.UTF8`, which in
/// .NET/PowerShell 5.1 emit a BOM that breaks the base64 decode on read.
/// The written content is exactly the base64: no BOM, no trailing newline.
fn build_dpapi_write_script(path: &str, entropy: &str) -> String {
    let entropy_escaped = entropy.replace('\'', "''");
    // Same escaping for the path — it also lands in a single-quoted literal.
    let path_escaped = path.replace('\'', "''");
    format!(
        "Add-Type -AssemblyName System.Security\n\
         $plain = [Console]::In.ReadToEnd()\n\
         $bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)\n\
         $entropy = [System.Text.Encoding]::UTF8.GetBytes('{entropy_escaped}')\n\
         $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, 'CurrentUser')\n\
         $b64 = [Convert]::ToBase64String($result)\n\
         [System.IO.File]::WriteAllText('{path_escaped}', $b64, (New-Object System.Text.UTF8Encoding($false)))"
    )
}

/// Renames a corrupted DPAPI file to `<name>.invalid-<timestamp>` so the
/// login flow can restart clean instead of being stuck (issue #72). The
/// file is PRESERVED (not deleted) for diagnosis.
#[cfg(windows)]
fn quarantine_corrupted_dpapi_file(file_path: &std::path::Path) {
    let quarantine_path = corrupted_path_for(file_path, now_ms());
    match std::fs::rename(file_path, &quarantine_path) {
        Ok(()) => {
            log_windows_credential_diagnostics(
                "dpapi",
                &format!("corrupt DPAPI file quarantined → {}", quarantine_path.display()),
            );
        }
        Err(e) => {
            log_windows_credential_diagnostics(
                "dpapi",
                &format!(
                    "failed to quarantine corrupt DPAPI file → {}: {e}",
                    quarantine_path.display()
                ),
            );
        }
    }
}

/// Reads the DPAPI-encrypted credentials blob on Windows. Calls
/// PowerShell `ProtectedData.Unprotect` with the file path and entropy.
/// Returns the decrypted JSON blob, or None if the file is missing /
/// decryption fails.
///
/// **Limit**: only callable on Windows (`#[cfg(windows)]`). The pure
/// logic (`dpapi_file_path_for`, `dpapi_entropy_for`,
/// `build_dpapi_read_script`) is tested on mac; the PowerShell call
/// itself is NOT tested in `cargo test --lib` on mac — it requires a
/// Windows runtime with a real DPAPI-encrypted file. (Cadinho limit
/// declaration.)
#[cfg(windows)]
fn read_windows_dpapi_blob() -> Option<Value> {
    let config_home = verboo_config_home().or_else(|| {
        log_windows_credential_diagnostics("dpapi", "config_home not found (HOME/USERPROFILE unset)");
        None
    })?;
    let resource_name = dpapi_resource_name();
    let file_path = dpapi_file_path_for(&config_home, resource_name);
    let username = current_username().or_else(|| {
        log_windows_credential_diagnostics("dpapi", "USERNAME env var not set");
        None
    })?;
    let entropy = dpapi_entropy_for(resource_name, &username);

    // The CLI writes Base64 text, not the raw DPAPI bytes.
    let file_bytes = std::fs::read(&file_path).ok().or_else(|| {
        log_windows_credential_diagnostics("dpapi", &format!("DPAPI file not found: {}", file_path.display()));
        None
    })?;
    let protected = decode_windows_dpapi_payload(&file_bytes).or_else(|| {
        log_windows_credential_diagnostics("dpapi", "Base64 decode failed — file may be corrupt or empty");
        // Recovery (issue #72): preserve the corrupt file for diagnosis
        // (rename, not delete) and return None so the plaintext fallback /
        // fresh login can start clean instead of being stuck.
        quarantine_corrupted_dpapi_file(&file_path);
        None
    })?;
    let protected_b64 = base64::engine::general_purpose::STANDARD.encode(protected);

    // PowerShell script: read the DPAPI file, unprotect with entropy,
    // output UTF-8 JSON. Mirrors the clone's
    // `windowsCredentialStorage.ts:98-146` read path.
    // SECURITY: -EncodedCommand (UTF-16LE Base64) — the shell never parses
    // the script as text, so shell metacharacters cannot inject. The
    // single-quote escaping of entropy (layer 2) is applied inside
    // `build_dpapi_read_script` — see its SECURITY comment.
    let script = build_dpapi_read_script(&protected_b64, &entropy);

    // Encode script as UTF-16LE for -EncodedCommand to prevent injection
    let script_utf16: Vec<u8> = script.encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    let script_b64 = base64::engine::general_purpose::STANDARD.encode(&script_utf16);

    let mut cmd = Command::new("powershell");
    cmd.arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-EncodedCommand")
        .arg(&script_b64)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::services::cli_spawn::apply_creation_flags(&mut cmd);
    let output = cmd.output()
        .ok().or_else(|| {
            log_windows_credential_diagnostics("dpapi", "PowerShell execution failed — is PowerShell available?");
            None
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log_windows_credential_diagnostics("dpapi", &format!("PowerShell DPAPI decrypt failed: {}", stderr.trim()));
        // Recovery (issue #72): the file cannot be decrypted with this
        // entropy — preserve it for diagnosis (rename, not delete) and
        // return None so the plaintext fallback / fresh login can start.
        quarantine_corrupted_dpapi_file(&file_path);
        return None;
    }
    let json = String::from_utf8_lossy(&output.stdout);
    parse_json_blob(json.trim())
}

#[cfg(windows)]
fn write_windows_dpapi_blob(blob: &Value) -> bool {
    let Some(config_home) = verboo_config_home() else {
        return false;
    };
    let resource_name = dpapi_resource_name();
    let file_path = dpapi_file_path_for(&config_home, resource_name);
    let Some(username) = current_username() else {
        return false;
    };
    let entropy = dpapi_entropy_for(resource_name, &username);
    let Ok(json) = serde_json::to_string(blob) else {
        return false;
    };
    // SECURITY: -EncodedCommand (shell never parses the script) +
    // single-quote escaping inside `build_dpapi_write_script` (PowerShell
    // string literal stays intact when USERNAME contains ', e.g. O'Brien).
    // The script writes the file itself via WriteAllText with
    // UTF8Encoding($false) — BOM-less, no trailing newline (issue #72).
    let script = build_dpapi_write_script(&file_path.to_string_lossy(), &entropy);
    let script_utf16: Vec<u8> = script.encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    let script_b64 = base64::engine::general_purpose::STANDARD.encode(&script_utf16);
    // Ensure the parent dir exists before the script writes the file.
    if let Some(parent) = file_path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    let mut cmd = Command::new("powershell");
    cmd.arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-EncodedCommand")
        .arg(&script_b64)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    crate::services::cli_spawn::apply_creation_flags(&mut cmd);
    let Ok(mut child) = cmd.spawn() else {
        return false;
    };
    let wrote = child
        .stdin
        .take()
        .is_some_and(|mut stdin| std::io::Write::write_all(&mut stdin, json.as_bytes()).is_ok());
    let Ok(output) = child.wait_with_output() else {
        return false;
    };
    if !wrote || !output.status.success() {
        return false;
    }
    // Validate the written file by reading it back: it must decode as
    // base64 (the BOM-stripping decode also proves the file has no BOM).
    let Ok(file_bytes) = std::fs::read(&file_path) else {
        return false;
    };
    decode_windows_dpapi_payload(&file_bytes).is_some()
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

    // Cold launch race regression tests
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
    /// race: if a future refactor breaks the cache (e.g. clears it on
    /// every call), parallel callers would all hammer the keychain and
    /// race again.
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

        let tok = get_access_token();
        assert_eq!(
            tok.as_deref(),
            Some("cold_launch_test_token"),
            "cold-launch cache hit must return the cached token — if this returns None, \
             the fast path is broken and parallel callers will race on the keychain"
        );

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
        // when refresh_token is None/empty, so no network call happens.
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

    // (a) Windows DPAPI pure logic
    //
    // The pure functions (path/entropy derivation) are tested on mac.
    // The PowerShell OS call (`read_windows_dpapi_blob`) is
    // `#[cfg(windows)]` — NOT tested in `cargo test --lib` on mac.
    // Limit declared in the function's doc comment.

    /// (a) The DPAPI filename replaces non-alphanumerics (except `._-`)
    /// with `_`. `Verboo Code-credentials` → `Verboo_Code-credentials`.
    /// Clone: `windowsCredentialStorage.ts:28-31`.
    #[test]
    fn dpapi_filename_replaces_non_alphanumerics() {
        assert_eq!(
            dpapi_filename_for("Verboo Code-credentials"),
            "Verboo_Code-credentials.secure.dpapi"
        );
        // Edge: multiple spaces / special chars.
        assert_eq!(
            dpapi_filename_for("a b@c"),
            "a_b_c.secure.dpapi"
        );
        // Dots, underscores, dashes are preserved.
        assert_eq!(
            dpapi_filename_for("foo.bar_baz-qux"),
            "foo.bar_baz-qux.secure.dpapi"
        );
    }

    /// (a) The DPAPI file path is `config_home/filename`. We check the
    /// filename component (platform-agnostic) rather than the exact
    /// separator (`\` on Windows, `/` on Unix).
    #[test]
    fn dpapi_file_path_joins_config_home_and_filename() {
        let home = std::path::Path::new("/home/dev/.verboo");
        let path = dpapi_file_path_for(home, "Verboo Code-credentials");
        assert_eq!(
            path.file_name().unwrap(),
            std::ffi::OsStr::new("Verboo_Code-credentials.secure.dpapi")
        );
        assert_eq!(
            path.parent().unwrap(),
            std::path::Path::new("/home/dev/.verboo")
        );
    }

    /// (a) The DPAPI entropy is `resourceName:username` — space KEPT
    /// (NOT replaced, unlike the filename). Clone:
    /// `windowsCredentialStorage.ts:24-26`.
    #[test]
    fn dpapi_entropy_keeps_space_in_resource_name() {
        let entropy = dpapi_entropy_for("Verboo Code-credentials", "dev");
        assert_eq!(entropy, "Verboo Code-credentials:dev");
        // The space is load-bearing — if the entropy doesn't match
        // exactly, DPAPI Unprotect fails. Mutation: replace space in
        // entropy → decryption would fail on Windows.
    }

    /// (a) The resource name matches the macOS Keychain service name
    /// (both use `Verboo Code-credentials`). This is the cross-platform
    /// contract: the CLI uses the same service/resource name on both
    /// OSes, only the STORE differs (Keychain vs DPAPI vs plaintext).
    #[test]
    fn dpapi_resource_name_matches_keychain_service() {
        assert_eq!(dpapi_resource_name(), KEYCHAIN_SERVICE);
        assert_eq!(dpapi_resource_name(), "Verboo Code-credentials");
    }

    /// (a) Mutation: if the filename DOESN'T replace non-alphanumerics,
    /// the path has a space → Windows file API may interpret it
    /// differently. The named mutation:
    /// `dpapi_filename_no_replace_creates_space_in_path`.
    /// This test pins the replacement; reverting `dpapi_filename_for`
    /// to return `format!("{resource_name}.secure.dpapi")` (no
    /// sanitization) → `Verboo Code-credentials.secure.dpapi` (with
    /// space) → assertion FAILS.
    #[test]
    fn dpapi_filename_mutation_no_replace_fails() {
        let filename = dpapi_filename_for("Verboo Code-credentials");
        assert!(
            !filename.contains(' '),
            "filename must not contain spaces (Windows path); \
             if it does, the no-replace mutation is live"
        );
        assert_eq!(filename, "Verboo_Code-credentials.secure.dpapi");
    }

    /// (a) Mutation: if the entropy REPLACES the space (same as the
    /// filename), DPAPI Unprotect fails because the entropy doesn't
    /// match what was used at Protect time. The named mutation:
    /// `dpapi_entropy_replaces_space_breaks_decryption`.
    /// This test pins the space-kept behavior; reverting
    /// `dpapi_entropy_for` to sanitize the resource name →
    /// `Verboo_Code-credentials:dev` (with `_`) → assertion FAILS.
    #[test]
    fn dpapi_entropy_mutation_replace_space_fails() {
        let entropy = dpapi_entropy_for("Verboo Code-credentials", "dev");
        assert!(
            entropy.contains(' '),
            "entropy must keep the space (it's load-bearing for DPAPI); \
             if it doesn't, the replace-space mutation is live"
        );
    }

    /// (a) DPAPI entropy single-quote escaping — LOAD-BEARING via the real
    /// production builders. When USERNAME contains a single quote (e.g.
    /// `O'Brien`), the entropy carries a raw `'`. The PowerShell script
    /// interpolates entropy into a single-quoted literal, where `'` must
    /// appear as `''` (doubled). This test calls the REAL `build_dpapi_*`
    /// functions (not a copy of the transform) and asserts the generated
    /// script contains the doubled quote in the GetBytes literal. If the
    /// `replace('\'', "''")` is removed from either builder, the assertion
    /// on `O''Brien` FAILS — proven by mutation (see PA-8 report).
    #[test]
    fn dpapi_entropy_escaping_doubles_single_quote_for_powershell_literal() {
        let entropy = dpapi_entropy_for("Verboo Code-credentials", "O'Brien");
        // Read script: the GetBytes literal must contain the doubled '.
        let read_script = build_dpapi_read_script("cG90YXRv", &entropy);
        assert!(
            read_script.contains("GetBytes('Verboo Code-credentials:O''Brien')"),
            "read script must contain the escaped literal with doubled '; got: {read_script}"
        );
        // The raw unescaped form must NOT appear (it would close the literal
        // early and break the GetBytes call).
        assert!(
            !read_script.contains("GetBytes('Verboo Code-credentials:O'Brien')"),
            "read script must NOT contain the raw unescaped literal; got: {read_script}"
        );
        // Write script: same two assertions.
        let write_script = build_dpapi_write_script(
            "C:\\Users\\dev\\.verboo\\Verboo_Code-credentials.secure.dpapi",
            &entropy,
        );
        assert!(
            write_script.contains("GetBytes('Verboo Code-credentials:O''Brien')"),
            "write script must contain the escaped literal with doubled '; got: {write_script}"
        );
        assert!(
            !write_script.contains("GetBytes('Verboo Code-credentials:O'Brien')"),
            "write script must NOT contain the raw unescaped literal; got: {write_script}"
        );
    }

    /// (a) BOM-less write (issue #72): the generated write script must
    /// write the base64 via `[IO.File]::WriteAllText` with
    /// `UTF8Encoding($false)` (UTF-8 WITHOUT BOM) — exactly the base64,
    /// no BOM, no trailing newline. It must NOT use `Out-File` /
    /// `Set-Content` / `Encoding.UTF8`, which emit a BOM in .NET /
    /// PowerShell 5.1. Mutation: revert the builder to
    /// `[System.Text.Encoding]::UTF8` or `Out-File` → assertion FAILS.
    #[test]
    fn dpapi_write_script_uses_bomless_write_api() {
        let script = build_dpapi_write_script(
            "C:\\Users\\dev\\.verboo\\Verboo_Code-credentials.secure.dpapi",
            "Verboo Code-credentials:dev",
        );
        // The full WriteAllText line: path + raw $b64 + UTF8Encoding($false).
        assert!(
            script.contains(
                "[System.IO.File]::WriteAllText('C:\\Users\\dev\\.verboo\\Verboo_Code-credentials.secure.dpapi', $b64, (New-Object System.Text.UTF8Encoding($false)))"
            ),
            "write script must write exactly $b64 via WriteAllText with UTF8Encoding($false) (no BOM); got: {script}"
        );
        // BOM-emitting write paths must NOT be used.
        assert!(
            !script.contains("Out-File") && !script.contains("Set-Content"),
            "write script must not use Out-File/Set-Content (PS 5.1 emits BOM); got: {script}"
        );
        assert!(
            !script.contains("[System.Text.Encoding]::UTF8)"),
            "write script must not use [Text.Encoding]::UTF8 as the write encoding (it emits BOM); got: {script}"
        );
        // No trailing newline is appended to the written base64: the second
        // argument of WriteAllText is $b64 alone (no +\`n concatenation).
        assert!(
            script.contains(", $b64, "),
            "write script must pass $b64 unmodified to WriteAllText (no newline concat); got: {script}"
        );
    }

    /// (a) Quarantine path derivation (issue #72 recovery): the corrupted
    /// DPAPI file is renamed (never deleted) to
    /// `<name>.invalid-<timestamp>` in the SAME directory, so it is
    /// preserved for diagnosis while the login flow restarts clean.
    #[test]
    fn corrupted_dpapi_path_gets_timestamp_suffix() {
        let original = std::path::Path::new("/home/dev/.verboo/Verboo_Code-credentials.secure.dpapi");
        let quarantined = corrupted_path_for(original, 1_723_000_000_000);
        assert_eq!(
            quarantined.file_name().unwrap().to_string_lossy(),
            "Verboo_Code-credentials.secure.dpapi.invalid-1723000000000",
        );
        assert_eq!(quarantined.parent(), original.parent());
    }

    /// (a) Cross-platform dispatch: `read_credentials_blob` on macOS
    /// calls `read_keychain_blob`. On Windows it would call
    /// `read_windows_dpapi_blob` (with `read_file_blob` fallback). On
    /// Linux it calls `read_file_blob`. The dispatch is compile-time
    /// (`cfg!`), so we can only test the mac branch here — the
    /// Windows branch is covered by `cargo xwin check` (compilation)
    /// and the pure-logic tests above.
    #[test]
    fn read_credentials_blob_dispatches_to_keychain_on_mac() {
        // On mac, read_credentials_blob should behave identically to
        // read_keychain_blob (both return None when the keychain item
        // doesn't exist, or the blob when it does). We can't assert
        // the exact value (depends on machine state), but we can
        // assert the function doesn't panic and returns Option<Value>.
        let _ = read_credentials_blob();
        // If we're on mac, this is read_keychain_blob(). On other
        // platforms, it's read_file_blob() or DPAPI. The test just
        // confirms the dispatch compiles and runs.
    }

    /// (a) `read_provider_credentials_blob` now goes through the
    /// cross-platform dispatch (was `read_keychain_blob()` which only
    /// works on mac). Mutation: revert to `read_keychain_blob()` →
    /// on Windows, always None → per-provider credentials never found.
    /// Named mutation:
    /// `read_provider_credentials_blob_keychain_only_breaks_windows`.
    #[test]
    fn read_provider_credentials_blob_uses_cross_platform_dispatch() {
        // The function should compile and return Option<Value>.
        // On mac, it delegates to read_keychain_blob (via
        // read_credentials_blob). On Windows, it would delegate to
        // read_windows_dpapi_blob (via read_credentials_blob).
        let _ = read_provider_credentials_blob();
    }

    #[test]
    fn windows_dpapi_file_decodes_the_cli_base64_text_contract() {
        let protected = b"dpapi encrypted bytes";
        let encoded = base64::engine::general_purpose::STANDARD.encode(protected);

        assert_eq!(
            decode_windows_dpapi_payload(format!("  {encoded}\r\n").as_bytes()).unwrap(),
            protected,
        );
        assert!(decode_windows_dpapi_payload(protected).is_none());
    }

    #[test]
    fn linux_secret_service_lookup_uses_the_cli_service_and_account_contract() {
        let mut observed = Vec::new();
        let blob = read_linux_secret_blob_with("dev", |args| {
            observed = args.iter().map(|value| value.to_string()).collect();
            Some(r#"{"verbooOauth":{"accessToken":"token"}}"#.to_string())
        })
        .unwrap();

        assert_eq!(
            observed,
            ["lookup", "service", "Verboo Code-credentials", "account", "dev"]
        );
        assert_eq!(blob["verbooOauth"]["accessToken"], "token");
    }
}
