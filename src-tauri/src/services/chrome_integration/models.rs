use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChromeComponentState {
    Missing,
    Managed,
    Outdated,
    Invalid,
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChromeConnectionState {
    Connected,
    WaitingForChrome,
    Ambiguous,
    Incompatible,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChromeIntegrationAggregate {
    NotConfigured,
    Incomplete,
    Ready,
    Connected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChromeExtensionIdSource {
    None,
    Release,
    Development,
}

/// Visibility the desktop app has into the extension side panel state.
///
/// `NotApplicable` — no live native host, so the panel question is moot.
/// `Unknown` — the native host is alive (the extension is connected to it),
/// but the app has no channel to observe whether the side panel is open.
/// The extension only reveals `approval_ui_unavailable` when a tool that
/// needs approval runs while the panel is closed
/// (`extensions/verboo-chrome/src/background.js:172`,
/// `extensions/verboo-chrome/native-messaging/PROTOCOL.md:17`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChromePanelState {
    NotApplicable,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeIntegrationStatus {
    pub extension: ChromeComponentState,
    pub bridge: ChromeComponentState,
    pub mcp: ChromeComponentState,
    pub connection: ChromeConnectionState,
    pub panel_state: ChromePanelState,
    pub aggregate: ChromeIntegrationAggregate,
    pub installed_version: Option<String>,
    pub available_version: String,
    pub can_configure: bool,
    pub can_repair: bool,
    pub can_remove: bool,
    pub store_url_available: bool,
    pub development_build: bool,
    pub extension_id_source: ChromeExtensionIdSource,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeConnectionTestResult {
    pub helper: bool,
    pub chrome: bool,
    pub cli_mcp: bool,
    pub connected: bool,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeIntegrationRequest {
    pub development_extension_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallationRecord {
    pub owner: String,
    pub version: String,
    pub helper_path: PathBuf,
    pub manifest_path: PathBuf,
    pub extension_id: String,
    pub extension_id_source: ChromeExtensionIdSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChromeReleaseMetadata {
    pub extension_id: Option<String>,
    pub web_store_url: Option<String>,
}

impl ChromeReleaseMetadata {
    pub fn from_build() -> Self {
        Self {
            extension_id: option_env!("VERBOO_CHROME_EXTENSION_ID")
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string),
            web_store_url: option_env!("VERBOO_CHROME_WEB_STORE_URL")
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string),
        }
    }
}
