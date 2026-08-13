use serde::{Deserialize, Serialize};
use serde_json::Value;

const SIMULATOR_TOOLS_JSON: &str = include_str!("simulatorTools.json");

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulatorCatalog {
    pub version: String,
    pub tools: Vec<SimulatorTool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulatorTool {
    pub name: String,
    pub description: String,
    pub risk: String,
    pub input_schema: Value,
}

pub fn simulator_catalog() -> Result<SimulatorCatalog, serde_json::Error> {
    serde_json::from_str(SIMULATOR_TOOLS_JSON)
}
