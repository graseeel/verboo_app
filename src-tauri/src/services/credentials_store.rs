use keyring::Entry;

use crate::models::types::CredentialStatus;

/// Stores the API key in the OS-native credential store:
///   - macOS: Keychain (apple-native)
///   - Windows: Credential Manager (windows-native)
///   - Linux: libsecret (sync-secret-service)
///
/// Service name matches the Electron app's keychain service for CLI OAuth
/// (`Verboo Code-credentials`), but uses a distinct account (`api-key`) so
/// both can coexist without collision.
///
/// On Linux, `keyring` v3 requires the `sync-secret-service` feature to be
/// enabled at build time. The Cargo.toml conditionally enables the right
/// platform backend.
const SERVICE_NAME: &str = "Verboo Code-credentials";
const ACCOUNT_NAME: &str = "api-key";

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
        let entry = Entry::new(SERVICE_NAME, ACCOUNT_NAME)
            .map_err(|e| format!("Falha ao acessar credential store: {e}"))?;
        entry
            .set_password(clean)
            .map_err(|e| format!("Falha ao salvar API key: {e}"))?;
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
            Ok(s) if !s.is_empty() => Ok(Some(s)),
            Ok(_) => Ok(None),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Falha ao ler API key: {e}")),
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
}
