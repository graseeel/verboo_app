pub mod discovery;
pub mod error;
pub mod framing;
pub mod local_transport;
pub mod protocol;

use error::{BridgeError, Result};

pub async fn run_mcp() -> Result<()> {
    Err(BridgeError::ModeUnavailable)
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
