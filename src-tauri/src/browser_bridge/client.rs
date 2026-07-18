//! Desktop → Extension client (stub).
//!
//! P4 scope: contract + stub. The real implementation will spawn the Chrome
//! extension's Native Messaging port via `chrome.runtime.connectNative` from
//! the extension side; Desktop is the host process that reads/writes stdio
//! frames. This stub is the Desktop-side entry point for sending a tool call
//! and awaiting the result.
//!
//! Multi-user: zero hardcoded paths/users/tokens. The client does not own a
//! session; the extension owns `verbooSession` in `chrome.storage.local`.

use serde_json::Value;
use crate::browser_bridge::native_messaging::{decode_message, encode_message, FrameError};

/// Errors from the client layer.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("framing error: {0}")]
    Frame(#[from] FrameError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("extension did not return a tool_result for toolCallId={0}")]
    MissingResult(String),
    #[error("extension returned an error: {0}")]
    ExtensionError(String),
}

/// A `ToolResult` matching `extensions/verboo-chrome/src/controller/protocol.js`.
///
/// Fields are intentionally permissive (`serde_json::Value`) because the
/// extension is the source of truth for tool result shapes; Desktop is a
/// transport, not a validator.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct ToolResult {
    pub toolCallId: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub durationMs: u64,
}

/// Send a tool call to the extension and await the result.
///
/// P4 STUB: this is the contract surface. The real implementation will:
///   1. Encode `tool_call` as a Native Messaging frame.
///   2. Write it to the NM pipe connected to the extension's service worker.
///   3. Read frames back until a `tool_result` with matching `toolCallId`
///      arrives (or an `agent:turn_error` for the owning turn).
///   4. Decode and return.
///
/// For now this returns `Err(ClientError::MissingResult)` so callers can wire
/// the type contract without a live Chrome instance.
pub fn send_tool_call(tool_call: &Value) -> Result<ToolResult, ClientError> {
    // Sanity: encode + decode round-trip works (exercises the framing layer).
    let _frame = encode_message(tool_call)?;
    let (_echo, _consumed) = decode_message(&_frame)?;

    // P4 stub: no live NM pipe yet.
    let tool_call_id = tool_call
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    Err(ClientError::MissingResult(tool_call_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn send_tool_call_stub_returns_missing_result() {
        let tool_call = json!({
            "id": "test-id",
            "name": "navigate",
            "risk": "mutate",
            "input": "navigate https://example.com",
            "params": { "url": "https://example.com" }
        });
        let err = send_tool_call(&tool_call).unwrap_err();
        assert!(matches!(err, ClientError::MissingResult(id) if id == "test-id"));
    }

    #[test]
    fn tool_result_deserializes_success() {
        let raw = json!({
            "toolCallId": "abc",
            "success": true,
            "data": { "url": "https://example.com" },
            "durationMs": 42
        });
        let result: ToolResult = serde_json::from_value(raw).unwrap();
        assert!(result.success);
        assert_eq!(result.tool_call_id, "abc");
        assert_eq!(result.duration_ms, 42);
    }

    #[test]
    fn tool_result_deserializes_error() {
        let raw = json!({
            "toolCallId": "abc",
            "success": false,
            "error": "hard_block:purchase"
        });
        let result: ToolResult = serde_json::from_value(raw).unwrap();
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some("hard_block:purchase"));
    }
}
