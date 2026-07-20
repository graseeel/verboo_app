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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeIntegrationStatus {
    pub extension: ChromeComponentState,
    pub bridge: ChromeComponentState,
    pub mcp: ChromeComponentState,
    pub connection: ChromeConnectionState,
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
