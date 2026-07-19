pub mod catalog;
pub mod discovery;
pub mod error;
pub mod framing;
pub mod local_transport;
pub mod mcp_server;
pub mod protocol;

use error::{BridgeError, Result};
use mcp_server::{BrowserMcpServer, BrowserSessionClient};
use rmcp::ServiceExt;
use std::sync::Arc;

pub async fn run_mcp() -> Result<()> {
    let client = BrowserSessionClient::for_current_user()
        .map_err(|error| BridgeError::Mcp(error.to_string()))?;
    let server = BrowserMcpServer::new(Arc::new(client))?;
    let service = server
        .serve((tokio::io::stdin(), tokio::io::stdout()))
        .await
        .map_err(|error| BridgeError::Mcp(error.to_string()))?;
    service
        .waiting()
        .await
        .map_err(|error| BridgeError::Mcp(error.to_string()))?;
    Ok(())
}

pub async fn run_native_host(_extension_origin: String) -> Result<()> {
    Err(BridgeError::ModeUnavailable)
}

pub fn run_ping() -> Result<()> {
    println!(
        "{{\"ok\":true,\"version\":\"{}\"}}",
        env!("CARGO_PKG_VERSION")
    );
    Ok(())
}
