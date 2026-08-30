use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const ANDROID_EMULATOR_PROTOCOL_VERSION: u32 = 1;
pub const MAX_ANDROID_EMULATOR_MESSAGE_BYTES: usize = 1024 * 1024;
pub const ANDROID_EMULATOR_DISCOVERY_DIRECTORY: &str = "verboo-android-emulator";
pub const VERBOO_APP_IDENTIFIER: &str = "ai.verboo.code.desktop";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidEmulatorDiscoveryRecord {
    pub protocol_version: u32,
    pub pid: u32,
    pub endpoint: String,
    pub secret: String,
    pub app_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidEmulatorBridgeRequest {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
    pub secret: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    pub arguments: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidEmulatorBridgeResponse {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub kind: String,
    pub id: Option<String>,
    pub result: Option<Value>,
    pub code: Option<String>,
    pub message: Option<String>,
}
