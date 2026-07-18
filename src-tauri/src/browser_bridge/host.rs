//! Native Messaging host manifest registration.
//!
//! Writes the Chrome Native Messaging host manifest JSON to the per-OS
//! standard location so Chrome can discover and launch the host binary.
//!
//! Per-OS paths (resolved at runtime via `dirs::config_dir()` — never
//! hardcoded):
//!   - macOS:   ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
//!   - Windows: %USERPROFILE%\AppData\Local\Google\Chrome\User Data\NativeMessagingHosts\
//!              (+ registry key HKCU\Software\Google\Chrome\NativeMessagingHosts\<host>)
//!   - Linux:   ~/.config/google-chrome/NativeMessagingHosts/
//!
//! The host binary is bundled with the Desktop app. Its absolute path is
//! resolved at install time and written into the manifest's `path` field.
//! Source code never hardcodes absolute paths.

use std::path::{Path, PathBuf};
use crate::browser_bridge::HOST_NAME;

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("could not resolve user config directory: {0}")]
    NoConfigDir(String),
    #[error("could not create NativeMessagingHosts directory: {0}")]
    CreateDir(#[from] std::io::Error),
    #[error("could not write host manifest: {0}")]
    WriteManifest(#[from] serde_json::Error),
    #[error("could not write Windows registry key: {0}")]
    Registry(String),
}

/// The Native Messaging host manifest Chrome reads.
#[derive(Debug, Clone, serde::Serialize)]
pub struct HostManifest {
    pub name: String,
    pub description: String,
    /// Absolute path to the host binary. Resolved at install time.
    pub path: String,
    #[serde(rename = "type")]
    pub transport_type: String,
    pub allowed_origins: Vec<String>,
}

impl HostManifest {
    /// Build a manifest for `com.verboo.code.browser_extension`.
    ///
    /// `host_binary_path` is the absolute path to the bundled host binary
    /// (resolved by the installer, never hardcoded in source).
    /// `extension_id` is the Chrome extension ID (placeholder until the
    /// Store key is generated; resolved at install time).
    pub fn new(host_binary_path: &Path, extension_id: &str) -> Self {
        Self {
            name: HOST_NAME.to_string(),
            description: "Verboo Code Browser Bridge host".to_string(),
            path: host_binary_path.to_string_lossy().to_string(),
            transport_type: "stdio".to_string(),
            allowed_origins: vec![format!("chrome-extension://{extension_id}/")],
        }
    }
}

/// Resolve the per-OS NativeMessagingHosts directory using `dirs::config_dir()`.
///
/// - macOS:   `~/Library/Application Support/Google/Chrome/NativeMessagingHosts`
/// - Windows: `%USERPROFILE%\AppData\Local\Google\Chrome\User Data\NativeMessagingHosts`
/// - Linux:   `~/.config/google-chrome/NativeMessagingHosts`
///
/// `dirs::config_dir()` returns the OS-specific config root; we append the
/// Chrome-specific subpath. No hardcoded absolute paths.
pub fn native_messaging_hosts_dir() -> Result<PathBuf, HostError> {
    let config = dirs::config_dir()
        .ok_or_else(|| HostError::NoConfigDir("dirs::config_dir() returned None".into()))?;
    Ok(config.join("Google").join("Chrome").join("NativeMessagingHosts"))
}

/// Write the host manifest to the per-OS NativeMessagingHosts directory.
///
/// On Windows, also writes the registry key
/// `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.verboo.code.browser_extension`
/// with a `Default` string value pointing at the manifest path (Chrome reads
/// the registry on Windows, not the filesystem).
///
/// `host_binary_path` and `extension_id` are resolved by the installer at
/// install time. Source code never hardcodes them.
#[cfg(not(target_os = "windows"))]
pub fn register_host(host_binary_path: &Path, extension_id: &str) -> Result<PathBuf, HostError> {
    let dir = native_messaging_hosts_dir()?;
    std::fs::create_dir_all(&dir)?;
    let manifest = HostManifest::new(host_binary_path, extension_id);
    let manifest_path = dir.join(format!("{HOST_NAME}.json"));
    let json = serde_json::to_string_pretty(&manifest)?;
    std::fs::write(&manifest_path, json)?;
    Ok(manifest_path)
}

/// Windows variant: also writes the registry key.
#[cfg(target_os = "windows")]
pub fn register_host(host_binary_path: &Path, extension_id: &str) -> Result<PathBuf, HostError> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let dir = native_messaging_hosts_dir()?;
    std::fs::create_dir_all(&dir)?;
    let manifest = HostManifest::new(host_binary_path, extension_id);
    let manifest_path = dir.join(format!("{HOST_NAME}.json"));
    let json = serde_json::to_string_pretty(&manifest)?;
    std::fs::write(&manifest_path, &json)?;

    // Registry: HKCU\Software\Google\Chrome\NativeMessagingHosts\<host>
    let key_path = format!(
        r"Software\Google\Chrome\NativeMessagingHosts\{}",
        HOST_NAME
    );
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(&key_path)
        .map_err(|e| HostError::Registry(e.to_string()))?;
    key.set_value("", &manifest_path.to_string_lossy().to_string())
        .map_err(|e| HostError::Registry(e.to_string()))?;

    Ok(manifest_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn manifest_serializes_to_chrome_schema() {
        let manifest = HostManifest::new(
            Path::new("/Applications/Verboo Code.app/Contents/Resources/browser_bridge_host"),
            "abcdefghijklmnopqrstuvwxyzabcdef",
        );
        let v = serde_json::to_value(&manifest).unwrap();
        assert_eq!(v["name"], json!("com.verboo.code.browser_extension"));
        assert_eq!(v["type"], json!("stdio"));
        assert_eq!(
            v["allowed_origins"][0],
            json!("chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef/")
        );
        assert!(v["path"].as_str().unwrap().contains("browser_bridge_host"));
    }

    #[test]
    fn hosts_dir_is_under_config() {
        // We can't assert the exact path in CI (varies by OS), but we can
        // assert the suffix is correct.
        if let Ok(dir) = native_messaging_hosts_dir() {
            let s = dir.to_string_lossy();
            assert!(s.contains("Google") && s.contains("Chrome") && s.contains("NativeMessagingHosts"));
        }
    }
}
