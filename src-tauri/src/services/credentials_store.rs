use keyring::Entry;

use crate::models::types::CredentialStatus;

#[cfg(any(target_os = "linux", test))]
use std::path::{Path, PathBuf};

/// Stores the API key in the OS-native credential store:
///   - macOS: Keychain (apple-native)
///   - Windows: Credential Manager (windows-native)
///   - Linux: libsecret (sync-secret-service)
///
/// Uses a **Desktop-specific** service name so we never share a Keychain
/// service with the CLI OAuth blob (`Verboo Code-credentials` / account
/// `$USER`). A previous shared-service design let no-account lookups return
/// the plain `vbk_…` key instead of OAuth JSON.
///
/// Legacy reads still fall back to the old service+account so existing users
/// keep their API key without re-entry.
///
/// On Linux, `keyring` v3 requires the `sync-secret-service` feature to be
/// enabled at build time. The Cargo.toml conditionally enables the right
/// platform backend. If Secret Service is unavailable (e.g. AppImage
/// bundled libdbus vs system dbus-launch), the API key is stored in a
/// 0600 file under `~/.verboo/desktop-api-key` and migrated back to the
/// keyring on the next successful Secret Service read/write. macOS and
/// Windows are unchanged (keyring only).
const SERVICE_NAME: &str = "Verboo Code Desktop-api-key";
const ACCOUNT_NAME: &str = "api-key";
/// Pre-migration location (shared service with CLI OAuth — do not write here).
const LEGACY_SERVICE_NAME: &str = "Verboo Code-credentials";
const LEGACY_ACCOUNT_NAME: &str = "api-key";

pub struct CredentialsStore;

impl CredentialsStore {
    pub fn new() -> Self {
        Self
    }

    pub fn get_status(&self) -> Result<CredentialStatus, String> {
        match self.get_api_key()? {
            Some(key) => Ok(CredentialStatus {
                has_api_key: true,
                api_key_hint: Some(Self::create_hint(&key)),
            }),
            None => Ok(CredentialStatus {
                has_api_key: false,
                api_key_hint: None,
            }),
        }
    }

    pub fn set_api_key(&self, api_key: String) -> Result<CredentialStatus, String> {
        let clean = api_key.trim();
        if clean.is_empty() {
            return Err("A chave API está vazia.".into());
        }
        // Reject obviously invalid inputs that aren't API keys at all — e.g.
        // a URL the user pasted by mistake, or an OAuth token. This avoids
        // saving a "key" that then blocks the CLI OAuth fallback (the CLI
        // sees `OAUTH_TOKEN_FILE` set, tries to use it, fails auth, and
        // never falls back to its own credential store).
        if let Err(msg) = validate_api_key_format(clean) {
            return Err(msg);
        }
        let entry = Entry::new(SERVICE_NAME, ACCOUNT_NAME)
            .map_err(|e| format!("Falha ao acessar credential store: {e}"))?;
        #[cfg(target_os = "linux")]
        {
            if let Some(path) = linux_api_key_fallback_path() {
                set_api_key_linux_with(
                    |k| {
                        entry
                            .set_password(k)
                            .map_err(|e| format!("Falha ao salvar API key: {e}"))
                    },
                    &path,
                    clean,
                )?;
                Self::delete_legacy_entry();
                return Ok(CredentialStatus {
                    has_api_key: true,
                    api_key_hint: Some(Self::create_hint(clean)),
                });
            }
        }
        entry
            .set_password(clean)
            .map_err(|e| format!("Falha ao salvar API key: {e}"))?;
        // Drop legacy shared-service item so CLI OAuth service stays clean.
        Self::delete_legacy_entry();
        Ok(CredentialStatus {
            has_api_key: true,
            api_key_hint: Some(Self::create_hint(clean)),
        })
    }

    pub fn clear_api_key(&self) -> Result<CredentialStatus, String> {
        let entry = Entry::new(SERVICE_NAME, ACCOUNT_NAME)
            .map_err(|e| format!("Falha ao acessar credential store: {e}"))?;
        // `delete_credential` returns Ok(()) even if the entry doesn't exist.
        let _ = entry.delete_credential();
        Self::delete_legacy_entry();
        #[cfg(target_os = "linux")]
        if let Some(path) = linux_api_key_fallback_path() {
            delete_linux_api_key_file(&path);
        }
        Ok(CredentialStatus {
            has_api_key: false,
            api_key_hint: None,
        })
    }

    /// Returns the raw API key if stored. Used by the API client (Fase 2+).
    pub fn get_api_key(&self) -> Result<Option<String>, String> {
        let entry = Entry::new(SERVICE_NAME, ACCOUNT_NAME)
            .map_err(|e| format!("Falha ao acessar credential store: {e}"))?;
        #[cfg(target_os = "linux")]
        {
            if let Some(path) = linux_api_key_fallback_path() {
                match get_api_key_linux_with(
                    || match entry.get_password() {
                        Ok(s) if !s.is_empty() => Ok(Some(s)),
                        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
                        Err(e) => Err(format!("Falha ao ler API key: {e}")),
                    },
                    |k| {
                        entry
                            .set_password(k)
                            .map_err(|e| format!("Falha ao salvar API key: {e}"))
                    },
                    &path,
                ) {
                    Ok(Some(s)) => return Ok(Some(s)),
                    Ok(None) => {}
                    Err(e) => return Err(e),
                }
            } else {
                match entry.get_password() {
                    Ok(s) if !s.is_empty() => return Ok(Some(s)),
                    Ok(_) | Err(keyring::Error::NoEntry) => {}
                    Err(e) => return Err(format!("Falha ao ler API key: {e}")),
                }
            }
        }
        #[cfg(not(target_os = "linux"))]
        match entry.get_password() {
            Ok(s) if !s.is_empty() => return Ok(Some(s)),
            Ok(_) => {}
            Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(format!("Falha ao ler API key: {e}")),
        }

        // Migrate once from the old shared Keychain service.
        // Only delete the legacy entry after confirming the write succeeded,
        // to avoid permanent credential loss on write failure.
        if let Some(legacy) = Self::read_legacy_api_key() {
            match entry.set_password(&legacy) {
                Ok(()) => {
                    Self::delete_legacy_entry();
                    return Ok(Some(legacy));
                }
                Err(e) => {
                    eprintln!("[credentials_store] failed to migrate API key to new keychain: {e}. Legacy key preserved.");
                    return Ok(Some(legacy));
                }
            }
        }
        Ok(None)
    }

    fn read_legacy_api_key() -> Option<String> {
        let entry = Entry::new(LEGACY_SERVICE_NAME, LEGACY_ACCOUNT_NAME).ok()?;
        match entry.get_password() {
            Ok(s) if !s.is_empty() && s.starts_with("vbk_") => Some(s),
            _ => None,
        }
    }

    fn delete_legacy_entry() {
        if let Ok(entry) = Entry::new(LEGACY_SERVICE_NAME, LEGACY_ACCOUNT_NAME) {
            let _ = entry.delete_credential();
        }
    }

    fn create_hint(api_key: &str) -> String {
        if api_key.len() <= 10 {
            "configurada".to_string()
        } else {
            format!("{}...{}", &api_key[..4], &api_key[api_key.len() - 4..])
        }
    }
}

impl Default for CredentialsStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Desktop-only plaintext fallback file. Must not share the CLI OAuth blob
/// (`~/.verboo/.credentials.json`).
#[cfg(any(target_os = "linux", test))]
const LINUX_API_KEY_FALLBACK_FILENAME: &str = "desktop-api-key";

/// `config_home/desktop-api-key` — `config_home` is `$VERBOO_CONFIG_DIR` or
/// `~/.verboo`.
#[cfg(any(target_os = "linux", test))]
fn linux_api_key_fallback_path_in(config_home: &Path) -> PathBuf {
    config_home.join(LINUX_API_KEY_FALLBACK_FILENAME)
}

#[cfg(target_os = "linux")]
fn linux_api_key_fallback_path() -> Option<PathBuf> {
    let config_home = if let Ok(dir) = std::env::var("VERBOO_CONFIG_DIR") {
        if !dir.trim().is_empty() {
            PathBuf::from(dir)
        } else {
            let home = std::env::var_os("HOME").map(PathBuf::from)?;
            home.join(".verboo")
        }
    } else {
        let home = std::env::var_os("HOME").map(PathBuf::from)?;
        home.join(".verboo")
    };
    Some(linux_api_key_fallback_path_in(&config_home))
}

#[cfg(any(target_os = "linux", test))]
fn write_linux_api_key_file(path: &Path, key: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Falha ao criar diretório da API key: {e}"))?;
    }
    std::fs::write(path, key.as_bytes())
        .map_err(|e| format!("Falha ao salvar API key no arquivo: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Falha ao ajustar permissões da API key: {e}"))?;
    }
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
fn read_linux_api_key_file(path: &Path) -> Option<String> {
    let contents = std::fs::read_to_string(path).ok()?;
    let trimmed = contents.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(any(target_os = "linux", test))]
fn delete_linux_api_key_file(path: &Path) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            eprintln!(
                "[credentials_store] failed to delete 0600 fallback {}: {e}",
                path.display()
            );
        }
    }
}

/// Keyring is primary. On Secret Service failure, read the 0600 file.
/// When keyring has the key, or a miss can be written back, delete the file
/// (migrate back). Injected keyring ops so macOS `cargo test --lib` can
/// cover the Linux policy without compiling `target_os = "linux"` branches.
#[cfg(any(target_os = "linux", test))]
fn get_api_key_linux_with<G, S>(
    keyring_get: G,
    keyring_set: S,
    fallback_path: &Path,
) -> Result<Option<String>, String>
where
    G: FnOnce() -> Result<Option<String>, String>,
    S: FnOnce(&str) -> Result<(), String>,
{
    match keyring_get() {
        Ok(Some(s)) if !s.is_empty() => {
            delete_linux_api_key_file(fallback_path);
            Ok(Some(s))
        }
        Ok(_) => {
            let Some(file_key) = read_linux_api_key_file(fallback_path) else {
                return Ok(None);
            };
            match keyring_set(&file_key) {
                Ok(()) => delete_linux_api_key_file(fallback_path),
                Err(e) => {
                    eprintln!(
                        "[credentials_store] keyring restore from file failed: {e}. Keeping 0600 fallback."
                    );
                }
            }
            Ok(Some(file_key))
        }
        Err(e) => {
            if let Some(file_key) = read_linux_api_key_file(fallback_path) {
                eprintln!(
                    "[credentials_store] keyring read failed ({e}); using 0600 file fallback"
                );
                Ok(Some(file_key))
            } else {
                eprintln!(
                    "[credentials_store] keyring read failed ({e}); no file fallback"
                );
                Ok(None)
            }
        }
    }
}

#[cfg(any(target_os = "linux", test))]
fn set_api_key_linux_with<S>(
    keyring_set: S,
    fallback_path: &Path,
    key: &str,
) -> Result<(), String>
where
    S: FnOnce(&str) -> Result<(), String>,
{
    match keyring_set(key) {
        Ok(()) => {
            delete_linux_api_key_file(fallback_path);
            Ok(())
        }
        Err(e) => {
            eprintln!(
                "[credentials_store] keyring write failed ({e}); writing 0600 file fallback"
            );
            write_linux_api_key_file(fallback_path, key)
        }
    }
}

/// Verifies the API key is not a URL and starts with the Verboo key prefix.
fn validate_api_key_format(key: &str) -> Result<(), String> {
    if key.starts_with("http://") || key.starts_with("https://") {
        return Err(
            "Isso parece ser um link/endereço, não uma chave API Verboo. Copie e cole a chave que começa com 'vbk_'."
                .into(),
        );
    }
    if !key.starts_with("vbk_") {
        return Err(
            "Chave API inválida. As chaves Verboo começam com 'vbk_'."
                .into(),
        );
    }
    if key.len() < 16 {
        return Err("Chave API muito curta. Verifique se a chave foi copiada por completo.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hint_masks_short_keys() {
        assert_eq!(CredentialsStore::create_hint("abc"), "configurada");
        assert_eq!(CredentialsStore::create_hint("1234567890"), "configurada");
    }

    #[test]
    fn hint_shows_first_and_last_four() {
        assert_eq!(
            CredentialsStore::create_hint("sk-ant-api03-long-key-1234567890"),
            "sk-a...7890"
        );
    }

    #[test]
    fn validate_accepts_verboo_prefix() {
        assert!(validate_api_key_format("vbk_test_key_long_enough").is_ok());
    }

    #[test]
    fn validate_rejects_url() {
        assert!(validate_api_key_format("https://example.com/something").is_err());
        assert!(validate_api_key_format("http://localhost:3000").is_err());
    }

    #[test]
    fn validate_rejects_non_verboo_prefix() {
        assert!(validate_api_key_format("sk-ant-api03-abc123").is_err());
    }

    #[test]
    fn validate_rejects_too_short() {
        assert!(validate_api_key_format("vbk_abc").is_err());
    }

    // Linux Secret Service file fallback (issue #80). Compiled on macOS via
    // `cfg(any(target_os = "linux", test))` like `cli_credentials::read_linux_secret_blob_with`.
    // These tests inject keyring success/failure; they do not talk to Secret Service.
    // Form-only for the real dbus/AppImage path — see builder report.

    #[test]
    fn linux_fallback_path_is_desktop_api_key_under_config_home() {
        let home = std::path::Path::new("/tmp/verboo-config-home");
        assert_eq!(
            linux_api_key_fallback_path_in(home),
            home.join("desktop-api-key"),
        );
    }

    #[test]
    fn linux_file_fallback_roundtrips_the_api_key() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = linux_api_key_fallback_path_in(dir.path());
        write_linux_api_key_file(&path, "vbk_test_key_long_enough").unwrap();
        assert_eq!(
            read_linux_api_key_file(&path).as_deref(),
            Some("vbk_test_key_long_enough"),
        );
    }

    #[cfg(unix)]
    #[test]
    fn linux_file_fallback_permissions_are_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::TempDir::new().unwrap();
        let path = linux_api_key_fallback_path_in(dir.path());
        write_linux_api_key_file(&path, "vbk_test_key_long_enough").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn linux_get_prefers_keyring_over_file_and_deletes_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = linux_api_key_fallback_path_in(dir.path());
        write_linux_api_key_file(&path, "vbk_file_key_long_enough").unwrap();

        let got = get_api_key_linux_with(
            || Ok(Some("vbk_keyring_key_long_enough".into())),
            |_k| panic!("must not write to keyring when keyring already has a key"),
            &path,
        )
        .unwrap();

        assert_eq!(got.as_deref(), Some("vbk_keyring_key_long_enough"));
        assert!(
            !path.exists(),
            "file fallback must be deleted after keyring hit (migrate back)"
        );
    }

    #[test]
    fn linux_get_reads_file_when_keyring_fails() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = linux_api_key_fallback_path_in(dir.path());
        write_linux_api_key_file(&path, "vbk_file_key_long_enough").unwrap();

        let got = get_api_key_linux_with(
            || Err("Secret Service unavailable".into()),
            |_k| panic!("must not attempt migrate-back while keyring is failing"),
            &path,
        )
        .unwrap();

        assert_eq!(got.as_deref(), Some("vbk_file_key_long_enough"));
        assert!(path.exists(), "file remains while keyring is down");
    }

    #[test]
    fn linux_get_migrates_file_back_to_keyring_on_miss() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = linux_api_key_fallback_path_in(dir.path());
        write_linux_api_key_file(&path, "vbk_file_key_long_enough").unwrap();
        let mut stored = None;
        let got = get_api_key_linux_with(
            || Ok(None),
            |k| {
                stored = Some(k.to_string());
                Ok(())
            },
            &path,
        )
        .unwrap();
        assert_eq!(got.as_deref(), Some("vbk_file_key_long_enough"));
        assert_eq!(stored.as_deref(), Some("vbk_file_key_long_enough"));
        assert!(!path.exists(), "file deleted after successful migrate-back");
    }

    #[test]
    fn linux_get_keeps_file_when_migrate_back_fails() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = linux_api_key_fallback_path_in(dir.path());
        write_linux_api_key_file(&path, "vbk_file_key_long_enough").unwrap();

        let got = get_api_key_linux_with(
            || Ok(None),
            |_k| Err("Secret Service unavailable".into()),
            &path,
        )
        .unwrap();

        assert_eq!(got.as_deref(), Some("vbk_file_key_long_enough"));
        assert!(path.exists(), "file kept when migrate-back cannot write keyring");
    }

    #[test]
    fn linux_get_returns_none_when_keyring_fails_and_no_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = linux_api_key_fallback_path_in(dir.path());
        let got = get_api_key_linux_with(
            || Err("Secret Service unavailable".into()),
            |_k| panic!("no file to migrate"),
            &path,
        )
        .unwrap();
        assert_eq!(got, None);
    }

    #[test]
    fn linux_set_writes_file_when_keyring_fails() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = linux_api_key_fallback_path_in(dir.path());
        set_api_key_linux_with(
            |_k| Err("Secret Service unavailable".into()),
            &path,
            "vbk_set_key_long_enough",
        )
        .unwrap();
        assert_eq!(
            read_linux_api_key_file(&path).as_deref(),
            Some("vbk_set_key_long_enough"),
        );
    }

    #[test]
    fn linux_set_deletes_file_when_keyring_succeeds() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = linux_api_key_fallback_path_in(dir.path());
        write_linux_api_key_file(&path, "vbk_old_file_key_enough").unwrap();
        set_api_key_linux_with(|_| Ok(()), &path, "vbk_new_keyring_key_ok").unwrap();
        assert!(!path.exists(), "file deleted after successful keyring write");
    }

    #[test]
    fn linux_clear_deletes_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = linux_api_key_fallback_path_in(dir.path());
        write_linux_api_key_file(&path, "vbk_clear_key_long_enough").unwrap();
        delete_linux_api_key_file(&path);
        assert!(!path.exists());
    }
}
