use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use directories::BaseDirs;
use serde::Deserialize;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::discovery::{DiscoveryError, DiscoveryRecord, DiscoveryStore};
use crate::error::BridgeError;
use crate::framing::{write_native_message, Direction, FrameReader};
use crate::local_transport;
use crate::protocol::{Envelope, MessageKind, PROTOCOL_VERSION};

const HOST_NAME: &str = "com.verboo.code.browser_extension";

#[derive(Debug, Error)]
pub enum NativeHostError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid native host manifest: {0}")]
    Json(#[from] serde_json::Error),
    #[error("discovery error: {0}")]
    Discovery(#[from] DiscoveryError),
    #[error("bridge framing error: {0}")]
    Framing(#[from] BridgeError),
    #[error("the Chrome extension origin is not allowed by the installed host manifest")]
    OriginNotAllowed,
    #[error("no installed Chrome Native Messaging manifest was found")]
    ManifestNotFound,
    #[error("the local browser request could not be authenticated")]
    AuthenticationFailed,
    #[error("the browser bridge protocol version is incompatible")]
    ProtocolVersionMismatch,
    #[error("the browser response does not match the in-flight request")]
    ResponseIdMismatch,
    #[error("the browser returned an unexpected message kind")]
    UnexpectedMessageKind,
    #[error("Chrome disconnected from the native host")]
    ChromeDisconnected,
    #[error("native relay worker failed: {0}")]
    Worker(String),
}

#[derive(Debug, Deserialize)]
struct NativeManifest {
    name: String,
    #[serde(rename = "type")]
    transport_type: String,
    allowed_origins: Vec<String>,
}

pub fn load_allowed_origins(path: &Path) -> Result<Vec<String>, NativeHostError> {
    let manifest: NativeManifest = serde_json::from_slice(&fs::read(path)?)?;
    if manifest.name != HOST_NAME || manifest.transport_type != "stdio" {
        return Err(NativeHostError::OriginNotAllowed);
    }
    if manifest
        .allowed_origins
        .iter()
        .any(|origin| !valid_extension_origin(origin))
    {
        return Err(NativeHostError::OriginNotAllowed);
    }
    Ok(manifest.allowed_origins)
}

pub fn validate_extension_origin(
    origin: &str,
    allowed_origins: &[String],
) -> Result<(), NativeHostError> {
    if valid_extension_origin(origin) && allowed_origins.iter().any(|allowed| allowed == origin) {
        Ok(())
    } else {
        Err(NativeHostError::OriginNotAllowed)
    }
}

fn valid_extension_origin(origin: &str) -> bool {
    let Some(id) = origin
        .strip_prefix("chrome-extension://")
        .and_then(|value| value.strip_suffix('/'))
    else {
        return false;
    };
    id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}

pub fn prepare_browser_request(
    record: &DiscoveryRecord,
    mut request: Envelope,
) -> Result<Envelope, NativeHostError> {
    if request.version != PROTOCOL_VERSION {
        return Err(NativeHostError::ProtocolVersionMismatch);
    }
    if !matches!(
        request.kind,
        MessageKind::ToolRequest | MessageKind::TurnComplete
    ) {
        return Err(NativeHostError::UnexpectedMessageKind);
    }
    if request.secret.as_deref() != Some(record.secret.as_str()) {
        return Err(NativeHostError::AuthenticationFailed);
    }
    request.secret = None;
    Ok(request)
}

pub fn validate_browser_response(
    request: &Envelope,
    response: &Envelope,
) -> Result<(), NativeHostError> {
    if response.version != PROTOCOL_VERSION {
        return Err(NativeHostError::ProtocolVersionMismatch);
    }
    if response.id != request.id {
        return Err(NativeHostError::ResponseIdMismatch);
    }
    let valid_response = match request.kind {
        MessageKind::ToolRequest => {
            matches!(
                response.kind,
                MessageKind::ToolResponse | MessageKind::Error
            )
        }
        MessageKind::TurnComplete => {
            matches!(
                response.kind,
                MessageKind::TurnCompleteAck | MessageKind::Error
            )
        }
        _ => false,
    };
    if !valid_response {
        return Err(NativeHostError::UnexpectedMessageKind);
    }
    Ok(())
}

pub async fn run(origin: String) -> Result<(), NativeHostError> {
    let allowed_origins = installed_allowed_origins()?;
    validate_extension_origin(&origin, &allowed_origins)?;

    let store = DiscoveryStore::for_current_user()?;
    let record = store.register(std::process::id(), origin)?;
    let listener = local_transport::bind(&record)?;
    let _guard = SessionGuard::new(store, &record);
    let chrome_reader = Arc::new(Mutex::new(FrameReader::new(
        std::io::stdin(),
        Direction::FromChrome,
    )));
    let chrome_writer = Arc::new(Mutex::new(std::io::stdout()));

    loop {
        let stream = local_transport::accept(&listener).await?;
        if let Err(error) = relay_one(stream, &record, &chrome_reader, &chrome_writer).await {
            eprintln!("verboo-in-chrome native relay: {error}");
            if matches!(error, NativeHostError::ChromeDisconnected) {
                return Err(error);
            }
        }
    }
}

async fn relay_one(
    stream: local_transport::AcceptedStream,
    record: &DiscoveryRecord,
    chrome_reader: &Arc<Mutex<FrameReader<std::io::Stdin>>>,
    chrome_writer: &Arc<Mutex<std::io::Stdout>>,
) -> Result<(), NativeHostError> {
    let mut local_reader = BufReader::new(stream);
    let mut encoded_request = String::new();
    if local_reader.read_line(&mut encoded_request).await? == 0 {
        return Ok(());
    }
    let request = prepare_browser_request(record, serde_json::from_str(&encoded_request)?)?;

    let browser_request = request.clone();
    let writer = Arc::clone(chrome_writer);
    tokio::task::spawn_blocking(move || {
        let mut output = writer
            .lock()
            .map_err(|_| NativeHostError::Worker("stdout lock poisoned".into()))?;
        write_native_message(&mut *output, &browser_request)?;
        Ok::<(), NativeHostError>(())
    })
    .await
    .map_err(|error| NativeHostError::Worker(error.to_string()))??;

    let reader = Arc::clone(chrome_reader);
    let response = tokio::task::spawn_blocking(move || {
        let mut input = reader
            .lock()
            .map_err(|_| NativeHostError::Worker("stdin lock poisoned".into()))?;
        Ok::<_, NativeHostError>(input.read()?)
    })
    .await
    .map_err(|error| NativeHostError::Worker(error.to_string()))??
    .ok_or(NativeHostError::ChromeDisconnected)?;
    let response: Envelope = serde_json::from_value(response)?;
    validate_browser_response(&request, &response)?;

    let mut stream = local_reader.into_inner();
    stream.write_all(&serde_json::to_vec(&response)?).await?;
    stream.write_all(b"\n").await?;
    stream.shutdown().await?;
    Ok(())
}

fn installed_allowed_origins() -> Result<Vec<String>, NativeHostError> {
    let mut allowed = Vec::new();
    for candidate in installed_manifest_candidates() {
        if candidate.is_file() {
            allowed.extend(load_allowed_origins(&candidate)?);
        }
    }
    if let Some(extension_id) = option_env!("VERBOO_CHROME_EXTENSION_ID") {
        let origin = format!("chrome-extension://{extension_id}/");
        if valid_extension_origin(&origin) {
            allowed.push(origin);
        }
    }
    allowed.sort();
    allowed.dedup();
    if allowed.is_empty() {
        Err(NativeHostError::ManifestNotFound)
    } else {
        Ok(allowed)
    }
}

fn installed_manifest_candidates() -> Vec<PathBuf> {
    let Some(base) = BaseDirs::new() else {
        return Vec::new();
    };
    #[cfg(target_os = "macos")]
    return vec![base
        .data_dir()
        .join("Google/Chrome/NativeMessagingHosts")
        .join(format!("{HOST_NAME}.json"))];
    #[cfg(target_os = "linux")]
    return vec![base
        .config_dir()
        .join("google-chrome/NativeMessagingHosts")
        .join(format!("{HOST_NAME}.json"))];
    #[cfg(windows)]
    {
        let _ = base;
        Vec::new()
    }
}

struct SessionGuard {
    store: DiscoveryStore,
    pid: u32,
    #[cfg(unix)]
    endpoint: PathBuf,
}

impl SessionGuard {
    fn new(store: DiscoveryStore, record: &DiscoveryRecord) -> Self {
        Self {
            store,
            pid: record.pid,
            #[cfg(unix)]
            endpoint: PathBuf::from(&record.endpoint),
        }
    }
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        let _ = self.store.remove(self.pid);
        #[cfg(unix)]
        let _ = fs::remove_file(&self.endpoint);
    }
}
