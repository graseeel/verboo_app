use keyring::Entry;

use crate::models::types::CredentialStatus;

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
/// platform backend.
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
        Ok(CredentialStatus {
            has_api_key: false,
            api_key_hint: None,
        })
    }

    /// Returns the raw API key if stored. Used by the API client (Fase 2+).
    pub fn get_api_key(&self) -> Result<Option<String>, String> {
        let entry = Entry::new(SERVICE_NAME, ACCOUNT_NAME)
            .map_err(|e| format!("Falha ao acessar credential store: {e}"))?;
        match entry.get_password() {
            Ok(s) if !s.is_empty() => return Ok(Some(s)),
            Ok(_) => {}
            Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(format!("Falha ao ler API key: {e}")),
        }

        // Migrate once from the old shared Keychain service.
        if let Some(legacy) = Self::read_legacy_api_key() {
            let _ = entry.set_password(&legacy);
            Self::delete_legacy_entry();
            return Ok(Some(legacy));
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
}
