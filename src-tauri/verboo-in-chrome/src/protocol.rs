use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MessageKind {
    Hello,
    ToolRequest,
    TurnComplete,
    ToolResponse,
    TurnCompleteAck,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub version: u32,
    pub id: String,
    pub kind: MessageKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    pub payload: Value,
}
