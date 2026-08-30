use serde::{Deserialize, Serialize};
use serde_json::Value;

const ANDROID_EMULATOR_TOOLS_JSON: &str = include_str!("androidEmulatorTools.json");

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidEmulatorCatalog {
    pub version: String,
    pub tools: Vec<AndroidEmulatorTool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidEmulatorTool {
    pub name: String,
    pub description: String,
    pub risk: String,
    pub input_schema: Value,
}

pub fn android_emulator_catalog() -> Result<AndroidEmulatorCatalog, serde_json::Error> {
    serde_json::from_str(ANDROID_EMULATOR_TOOLS_JSON)
}
