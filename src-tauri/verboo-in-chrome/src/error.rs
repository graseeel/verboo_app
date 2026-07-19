use thiserror::Error;

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("native message exceeds the {limit} limit ({actual} bytes)")]
    FrameTooLarge { limit: &'static str, actual: usize },
    #[error("native message ended before its frame was complete")]
    IncompleteFrame,
    #[error("no writable per-user runtime directory is available")]
    RuntimeDirectoryUnavailable,
    #[error("no Chrome browser session is connected")]
    BrowserNotConnected,
    #[error("the requested helper mode is not available yet")]
    ModeUnavailable,
    #[error("MCP server error: {0}")]
    Mcp(String),
    #[error("Native Messaging host error: {0}")]
    NativeHost(String),
}

pub type Result<T> = std::result::Result<T, BridgeError>;
