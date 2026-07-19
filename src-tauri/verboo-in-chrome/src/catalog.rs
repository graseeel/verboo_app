use serde::{Deserialize, Serialize};
use serde_json::Value;

const BROWSER_TOOLS_JSON: &str =
    include_str!("../../../extensions/verboo-chrome/src/controller/browserTools.json");

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCatalog {
    pub version: String,
    pub tools: Vec<BrowserTool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTool {
    pub name: String,
    pub description: String,
    pub risk: String,
    pub input_schema: Value,
}

pub fn browser_catalog() -> Result<BrowserCatalog, serde_json::Error> {
    serde_json::from_str(BROWSER_TOOLS_JSON)
}
