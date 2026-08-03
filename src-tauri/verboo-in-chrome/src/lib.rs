pub mod catalog;
pub mod discovery;
pub mod error;
pub mod framing;
pub mod local_transport;
pub mod mcp_server;
pub mod native_host;
pub mod protocol;

use error::{BridgeError, Result};
use mcp_server::{BrowserMcpServer, BrowserSessionClient};
use rmcp::ServiceExt;
use std::sync::Arc;

pub async fn run_mcp() -> Result<()> {
    let client = BrowserSessionClient::for_current_user()
        .map_err(|error| BridgeError::Mcp(error.to_string()))?;
    let client = Arc::new(client);
    let server = BrowserMcpServer::new(Arc::clone(&client))?;
    let service = server
        .serve((tokio::io::stdin(), tokio::io::stdout()))
        .await
        .map_err(|error| BridgeError::Mcp(error.to_string()))?;
    let waiting_result = service
        .waiting()
        .await
        .map(|_| ())
        .map_err(|error| BridgeError::Mcp(error.to_string()));
    if let Err(error) = client.complete_turn().await {
        eprintln!("verboo-in-chrome: could not clear Chrome presence: {error}");
    }
    waiting_result
}

pub async fn run_native_host(_extension_origin: String) -> Result<()> {
    native_host::run(_extension_origin)
        .await
        .map_err(|error| BridgeError::NativeHost(error.to_string()))
}

pub fn run_ping() -> Result<()> {
    println!(
        "{{\"ok\":true,\"version\":\"{}\"}}",
        env!("CARGO_PKG_VERSION")
    );
    Ok(())
}
