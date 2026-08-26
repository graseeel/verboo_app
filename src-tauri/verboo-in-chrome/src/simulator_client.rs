use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};

use directories::BaseDirs;
use serde_json::{json, Value};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use uuid::Uuid;

use crate::simulator_protocol::{
    SimulatorBridgeRequest, SimulatorBridgeResponse, SimulatorDiscoveryRecord,
    MAX_SIMULATOR_MESSAGE_BYTES, SIMULATOR_DISCOVERY_DIRECTORY, SIMULATOR_PROTOCOL_VERSION,
    VERBOO_APP_IDENTIFIER,
};

#[derive(Debug, Error)]
pub enum SimulatorClientError {
    #[error("Verboo desktop is not running with an iOS Simulator bridge")]
    NotConnected,
    #[error("invalid simulator discovery record: {0}")]
    InvalidDiscovery(String),
    #[error("simulator bridge protocol version mismatch")]
    ProtocolVersionMismatch,
    #[error("simulator bridge endpoint must be a 127.0.0.1 socket")]
    InvalidEndpoint,
    #[error("simulator bridge connection failed: {0}")]
    ConnectionLost(String),
    #[error("invalid simulator bridge response: {0}")]
    InvalidResponse(String),
    #[error("simulator bridge rejected the request ({code}): {message}")]
    Remote { code: String, message: String },
}

#[derive(Debug, Clone)]
pub struct SimulatorDiscoveryStore {
    root: PathBuf,
}

impl SimulatorDiscoveryStore {
    /// Trusted-process override: tests and developers may set
    /// `VERBOO_IOS_SIMULATOR_DISCOVERY_DIR` to an absolute path without
    /// `..`. Relative values are rejected. The helper still forces `0o700`
    /// on Unix when the directory exists (same as the desktop bridge).
    pub fn for_current_user() -> Result<Self, SimulatorClientError> {
        if let Some(root) = std::env::var_os("VERBOO_IOS_SIMULATOR_DISCOVERY_DIR") {
            let root = crate::mcp_discovery::parse_override_root(root).map_err(|error| {
                SimulatorClientError::InvalidDiscovery(format!(
                    "VERBOO_IOS_SIMULATOR_DISCOVERY_DIR: {error}"
                ))
            })?;
            crate::mcp_discovery::ensure_private_root(&root)
                .map_err(|error| SimulatorClientError::InvalidDiscovery(error.to_string()))?;
            return Ok(Self::at(root));
        }
        let base = BaseDirs::new().ok_or_else(|| {
            SimulatorClientError::InvalidDiscovery("user cache directory unavailable".into())
        })?;
        let root = base
            .cache_dir()
            .join(VERBOO_APP_IDENTIFIER)
            .join(SIMULATOR_DISCOVERY_DIRECTORY);
        crate::mcp_discovery::ensure_private_root(&root)
            .map_err(|error| SimulatorClientError::InvalidDiscovery(error.to_string()))?;
        Ok(Self::at(root))
    }

    pub fn at(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn write_record_for_test(
        &self,
        record: &SimulatorDiscoveryRecord,
    ) -> Result<PathBuf, SimulatorClientError> {
        crate::mcp_discovery::create_private_root(&self.root)
            .map_err(|error| SimulatorClientError::InvalidDiscovery(error.to_string()))?;
        let path = self.root.join(format!("{}.json", record.pid));
        fs::write(
            &path,
            serde_json::to_vec(record)
                .map_err(|error| SimulatorClientError::InvalidDiscovery(error.to_string()))?,
        )
        .map_err(|error| SimulatorClientError::InvalidDiscovery(error.to_string()))?;
        Ok(path)
    }

    fn discover(
        &self,
    ) -> Result<Option<(PathBuf, SimulatorDiscoveryRecord)>, SimulatorClientError> {
        crate::mcp_discovery::ensure_private_root(&self.root)
            .map_err(|error| SimulatorClientError::InvalidDiscovery(error.to_string()))?;
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(SimulatorClientError::InvalidDiscovery(error.to_string())),
        };
        let mut records = entries
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str()) == Some("json")
            })
            .filter_map(|entry| {
                let modified = entry.metadata().ok()?.modified().ok()?;
                Some((modified, entry.path()))
            })
            .collect::<Vec<_>>();
        records.sort_by(|left, right| right.0.cmp(&left.0));

        for (_, path) in records {
            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            let record: SimulatorDiscoveryRecord = match serde_json::from_slice(&bytes) {
                Ok(record) => record,
                Err(_) => continue,
            };
            if record.protocol_version != SIMULATOR_PROTOCOL_VERSION {
                return Err(SimulatorClientError::ProtocolVersionMismatch);
            }
            if record.secret.is_empty() {
                return Err(SimulatorClientError::InvalidDiscovery(
                    "empty simulator bridge secret".into(),
                ));
            }
            parse_loopback_endpoint(&record.endpoint)?;
            return Ok(Some((path, record)));
        }
        Ok(None)
    }

    fn remove_record(&self, path: &Path) {
        let _ = fs::remove_file(path);
    }
}

#[derive(Debug, Clone)]
pub struct SimulatorSessionClient {
    store: SimulatorDiscoveryStore,
}

impl SimulatorSessionClient {
    pub fn for_current_user() -> Result<Self, SimulatorClientError> {
        Ok(Self::with_store(
            SimulatorDiscoveryStore::for_current_user()?
        ))
    }

    pub fn with_store(store: SimulatorDiscoveryStore) -> Self {
        Self { store }
    }

    pub async fn call_tool(
        &self,
        id: &str,
        tool: &str,
        arguments: Value,
    ) -> Result<Value, SimulatorClientError> {
        self.send_request(SimulatorBridgeRequest {
            protocol_version: SIMULATOR_PROTOCOL_VERSION,
            kind: "toolRequest".into(),
            id: id.to_string(),
            secret: String::new(),
            tool: Some(tool.to_string()),
            arguments,
        })
        .await
    }

    pub async fn complete_turn(&self) -> Result<(), SimulatorClientError> {
        self.send_request(SimulatorBridgeRequest {
            protocol_version: SIMULATOR_PROTOCOL_VERSION,
            kind: "turnComplete".into(),
            id: Uuid::new_v4().to_string(),
            secret: String::new(),
            tool: None,
            arguments: json!({}),
        })
        .await
        .map(|_| ())
    }

    async fn send_request(
        &self,
        mut request: SimulatorBridgeRequest,
    ) -> Result<Value, SimulatorClientError> {
        let (record_path, record) = self
            .store
            .discover()?
            .ok_or(SimulatorClientError::NotConnected)?;
        let endpoint = parse_loopback_endpoint(&record.endpoint)?;
        request.secret = record.secret;
        let mut stream = match TcpStream::connect(endpoint).await {
            Ok(stream) => stream,
            Err(error) => {
                self.store.remove_record(&record_path);
                return Err(SimulatorClientError::ConnectionLost(error.to_string()));
            }
        };
        let mut encoded = serde_json::to_vec(&request)
            .map_err(|error| SimulatorClientError::InvalidResponse(error.to_string()))?;
        encoded.push(b'\n');
        stream
            .write_all(&encoded)
            .await
            .map_err(|error| SimulatorClientError::ConnectionLost(error.to_string()))?;
        stream
            .flush()
            .await
            .map_err(|error| SimulatorClientError::ConnectionLost(error.to_string()))?;

        let mut line = Vec::new();
        BufReader::new(stream)
            .take((MAX_SIMULATOR_MESSAGE_BYTES + 2) as u64)
            .read_until(b'\n', &mut line)
            .await
            .map_err(|error| SimulatorClientError::ConnectionLost(error.to_string()))?;
        if line.is_empty() || line.len() > MAX_SIMULATOR_MESSAGE_BYTES {
            return Err(SimulatorClientError::InvalidResponse(
                "empty or oversized simulator response".into(),
            ));
        }
        let response: SimulatorBridgeResponse = serde_json::from_slice(&line)
            .map_err(|error| SimulatorClientError::InvalidResponse(error.to_string()))?;
        if response.protocol_version != SIMULATOR_PROTOCOL_VERSION {
            return Err(SimulatorClientError::ProtocolVersionMismatch);
        }
        if response.id.as_deref() != Some(request.id.as_str()) {
            return Err(SimulatorClientError::InvalidResponse(
                "response request id mismatch".into(),
            ));
        }
        match response.kind.as_str() {
            "toolResponse" => response.result.ok_or_else(|| {
                SimulatorClientError::InvalidResponse("success response omitted result".into())
            }),
            "error" => Err(SimulatorClientError::Remote {
                code: response.code.unwrap_or_else(|| "invalid_response".into()),
                message: response
                    .message
                    .unwrap_or_else(|| "simulator bridge rejected the request".into()),
            }),
            _ => Err(SimulatorClientError::InvalidResponse(format!(
                "unexpected response type: {}",
                response.kind
            ))),
        }
    }
}

fn parse_loopback_endpoint(value: &str) -> Result<SocketAddr, SimulatorClientError> {
    let endpoint = value
        .parse::<SocketAddr>()
        .map_err(|_| SimulatorClientError::InvalidEndpoint)?;
    if endpoint.ip() != IpAddr::V4(Ipv4Addr::LOCALHOST) {
        return Err(SimulatorClientError::InvalidEndpoint);
    }
    Ok(endpoint)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::simulator_protocol::{SimulatorDiscoveryRecord, SIMULATOR_PROTOCOL_VERSION};

    #[test]
    fn accepts_only_explicit_ipv4_loopback() {
        assert!(parse_loopback_endpoint("127.0.0.1:1234").is_ok());
        assert!(parse_loopback_endpoint("0.0.0.0:1234").is_err());
        assert!(parse_loopback_endpoint("[::1]:1234").is_err());
        assert!(parse_loopback_endpoint("localhost:1234").is_err());
    }

    #[test]
    fn discovery_store_uses_the_shared_hardening_helpers() {
        let source = include_str!("simulator_client.rs");
        assert!(source.contains("mcp_discovery::parse_override_root"));
        assert!(source.contains("mcp_discovery::ensure_private_root"));
        assert!(source.contains("mcp_discovery::create_private_root"));
        assert!(source.contains("VERBOO_IOS_SIMULATOR_DISCOVERY_DIR"));
        let legacy_create = format!("{}{}", "fs::create_dir_all(", "&self.root)");
        assert!(!source.contains(&legacy_create));
    }

    #[cfg(unix)]
    #[test]
    fn write_record_for_test_hardens_the_discovery_directory() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path().join("discovery");
        let store = SimulatorDiscoveryStore::at(root.clone());
        store
            .write_record_for_test(&SimulatorDiscoveryRecord {
                protocol_version: SIMULATOR_PROTOCOL_VERSION,
                pid: std::process::id(),
                endpoint: "127.0.0.1:9".into(),
                secret: "secret".into(),
                app_version: "test".into(),
            })
            .unwrap();
        assert_eq!(root.metadata().unwrap().permissions().mode() & 0o777, 0o700);
    }
}
