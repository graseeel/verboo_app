use crate::discovery::DiscoveryRecord;
use crate::error::{BridgeError, Result};

#[cfg(unix)]
pub type LocalStream = tokio::net::UnixStream;

#[cfg(unix)]
pub type LocalListener = tokio::net::UnixListener;

#[cfg(unix)]
pub type AcceptedStream = tokio::net::UnixStream;

#[cfg(unix)]
pub async fn connect(record: &DiscoveryRecord) -> Result<LocalStream> {
    Ok(tokio::net::UnixStream::connect(&record.endpoint).await?)
}

#[cfg(unix)]
pub fn bind(record: &DiscoveryRecord) -> Result<LocalListener> {
    let path = std::path::Path::new(&record.endpoint);
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(tokio::net::UnixListener::bind(path)?)
}

#[cfg(unix)]
pub async fn accept(listener: &LocalListener) -> Result<AcceptedStream> {
    Ok(listener.accept().await?.0)
}

#[cfg(windows)]
pub type LocalStream = tokio::net::windows::named_pipe::NamedPipeClient;

#[cfg(windows)]
pub struct LocalListener {
    endpoint: String,
}

#[cfg(windows)]
pub type AcceptedStream = tokio::net::windows::named_pipe::NamedPipeServer;

#[cfg(windows)]
impl LocalListener {
    async fn accept(&self) -> Result<AcceptedStream> {
        use tokio::net::windows::named_pipe::ServerOptions;

        let server = ServerOptions::new().create(&self.endpoint)?;
        server.connect().await?;
        Ok(server)
    }
}

#[cfg(windows)]
pub async fn accept(listener: &LocalListener) -> Result<AcceptedStream> {
    listener.accept().await
}

#[cfg(windows)]
pub async fn connect(record: &DiscoveryRecord) -> Result<LocalStream> {
    use tokio::net::windows::named_pipe::ClientOptions;

    Ok(ClientOptions::new().open(&record.endpoint)?)
}

#[cfg(windows)]
pub fn bind(record: &DiscoveryRecord) -> Result<LocalListener> {
    if record.endpoint.is_empty() {
        return Err(BridgeError::BrowserNotConnected);
    }
    Ok(LocalListener {
        endpoint: record.endpoint.clone(),
    })
}

pub fn validate_secret(record: &DiscoveryRecord, secret: Option<&str>) -> Result<()> {
    if secret == Some(record.secret.as_str()) {
        Ok(())
    } else {
        Err(BridgeError::BrowserNotConnected)
    }
}
