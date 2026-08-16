use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use directories::BaseDirs;
use serde::Deserialize;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;
use tokio::task::JoinSet;

use crate::discovery::{DiscoveryError, DiscoveryRecord, DiscoveryStore};
use crate::error::BridgeError;
use crate::framing::{write_native_message, Direction, FrameReader};
use crate::local_transport;
use crate::protocol::{Envelope, MessageKind, PROTOCOL_VERSION};

const HOST_NAME: &str = "com.verboo.code.browser_extension";

type PendingResponses = Arc<Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>>;

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
    let record = store.prepare(std::process::id(), origin)?;
    let guard = SessionGuard::new(store, &record);
    let listener = local_transport::bind(&record)?;
    guard.store.write_record(&record)?;
    let chrome_reader = std::io::stdin();
    let chrome_writer = Arc::new(Mutex::new(std::io::stdout()));

    run_relay_loop(listener, record, chrome_reader, chrome_writer).await
}

async fn run_relay_loop<R, W>(
    listener: local_transport::LocalListener,
    record: DiscoveryRecord,
    chrome_reader: R,
    chrome_writer: Arc<Mutex<W>>,
) -> Result<(), NativeHostError>
where
    R: Read + Send + 'static,
    W: Write + Send + 'static,
{
    let tool_transaction = Arc::new(tokio::sync::Mutex::new(()));
    let completion_ids = Arc::new(Mutex::new(HashSet::new()));
    let pending_responses: PendingResponses = Arc::new(Mutex::new(HashMap::new()));
    let mut relays = JoinSet::new();
    let mut chrome_reader_task = tokio::spawn(read_chrome_messages(
        chrome_reader,
        Arc::clone(&pending_responses),
        Arc::clone(&completion_ids),
    ));

    loop {
        tokio::select! {
            accepted = local_transport::accept(&listener) => {
                let stream = match accepted {
                    Ok(stream) => stream,
                    Err(error) => {
                        chrome_reader_task.abort();
                        relays.abort_all();
                        return Err(error.into());
                    }
                };
                let relay_record = record.clone();
                let relay_writer = Arc::clone(&chrome_writer);
                let relay_transaction = Arc::clone(&tool_transaction);
                let relay_completion_ids = Arc::clone(&completion_ids);
                let relay_pending_responses = Arc::clone(&pending_responses);
                relays.spawn(async move {
                    relay_one(
                        stream,
                        &relay_record,
                        relay_writer,
                        relay_transaction,
                        relay_completion_ids,
                        relay_pending_responses,
                    )
                    .await
                });
            }
            result = &mut chrome_reader_task => {
                relays.abort_all();
                while relays.join_next().await.is_some() {}
                return match result {
                    Ok(result) => result,
                    Err(error) => Err(NativeHostError::Worker(error.to_string())),
                };
            }
            result = relays.join_next(), if !relays.is_empty() => {
                let Some(result) = result else {
                    continue;
                };
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        eprintln!("verboo-in-chrome native relay: {error}");
                        if matches!(error, NativeHostError::ChromeDisconnected) {
                            relays.abort_all();
                            return Err(error);
                        }
                    }
                    Err(error) => {
                        eprintln!("verboo-in-chrome native relay task failed: {error}");
                    }
                }
            }
        }
    }
}

async fn relay_one<W>(
    stream: local_transport::AcceptedStream,
    record: &DiscoveryRecord,
    chrome_writer: Arc<Mutex<W>>,
    tool_transaction: Arc<tokio::sync::Mutex<()>>,
    completion_ids: Arc<Mutex<HashSet<String>>>,
    pending_responses: PendingResponses,
) -> Result<(), NativeHostError>
where
    W: Write + Send + 'static,
{
    let mut local_reader = BufReader::new(stream);
    let mut encoded_request = String::new();
    if local_reader.read_line(&mut encoded_request).await? == 0 {
        return Ok(());
    }
    let request = prepare_browser_request(record, serde_json::from_str(&encoded_request)?)?;

    if request.kind == MessageKind::TurnComplete {
        // The MCP side intentionally does not wait for this ACK. Forward the
        // cleanup while a previous tool relay may still own the Chrome reader.
        completion_ids
            .lock()
            .map_err(|_| NativeHostError::Worker("completion id lock poisoned".into()))?
            .insert(request.id.clone());
        if let Err(error) = write_browser_request(&request, &chrome_writer).await {
            completion_ids
                .lock()
                .map_err(|_| NativeHostError::Worker("completion id lock poisoned".into()))?
                .remove(&request.id);
            return Err(error);
        }
        drop(local_reader.into_inner());
        return Ok(());
    }

    let _tool_transaction = tool_transaction.lock().await;
    let (response_sender, response_receiver) = oneshot::channel();
    pending_responses
        .lock()
        .map_err(|_| NativeHostError::Worker("pending response lock poisoned".into()))?
        .insert(request.id.clone(), response_sender);
    if let Err(error) = write_browser_request(&request, &chrome_writer).await {
        pending_responses
            .lock()
            .map_err(|_| NativeHostError::Worker("pending response lock poisoned".into()))?
            .remove(&request.id);
        return Err(error);
    }

    let response = response_receiver
        .await
        .map_err(|_| NativeHostError::ChromeDisconnected)?;
    let response: Envelope = serde_json::from_value(response)?;
    if response.id != request.id {
        return Err(NativeHostError::ResponseIdMismatch);
    }
    validate_browser_response(&request, &response)?;

    let mut stream = local_reader.into_inner();
    stream.write_all(&serde_json::to_vec(&response)?).await?;
    stream.write_all(b"\n").await?;
    stream.shutdown().await?;
    Ok(())
}

async fn read_chrome_messages<R>(
    reader: R,
    pending_responses: PendingResponses,
    completion_ids: Arc<Mutex<HashSet<String>>>,
) -> Result<(), NativeHostError>
where
    R: Read + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let mut reader = FrameReader::new(reader, Direction::FromChrome);
        loop {
            let value = reader.read()?.ok_or(NativeHostError::ChromeDisconnected)?;
            let response: Envelope = serde_json::from_value(value.clone())?;
            let was_completion = completion_ids
                .lock()
                .map_err(|_| NativeHostError::Worker("completion id lock poisoned".into()))?
                .remove(&response.id);
            if was_completion {
                continue;
            }
            let sender = pending_responses
                .lock()
                .map_err(|_| NativeHostError::Worker("pending response lock poisoned".into()))?
                .remove(&response.id)
                .ok_or(NativeHostError::ResponseIdMismatch)?;
            let _ = sender.send(value);
        }
    })
    .await
    .map_err(|error| NativeHostError::Worker(error.to_string()))?
}

async fn write_browser_request<W>(
    request: &Envelope,
    chrome_writer: &Arc<Mutex<W>>,
) -> Result<(), NativeHostError>
where
    W: Write + Send + 'static,
{
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
        let mut candidates = Vec::new();
        // On Windows, the manifest path is registered in the Windows Registry.
        // Check both Chrome and Edge registry keys.
        let registry_keys = [
            r"Software\Google\Chrome\NativeMessagingHosts\com.verboo.code.browser_extension",
            r"Software\Microsoft\Edge\NativeMessagingHosts\com.verboo.code.browser_extension",
        ];
        if let Ok(current_user) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .open_subkey_with_flags(
                &registry_keys[0],
                winreg::enums::KEY_READ,
            )
        {
            if let Ok(manifest_path) = current_user.get_value::<String, _>("") {
                candidates.push(PathBuf::from(manifest_path));
            }
        }
        if let Ok(current_user) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .open_subkey_with_flags(
                &registry_keys[1],
                winreg::enums::KEY_READ,
            )
        {
            if let Ok(manifest_path) = current_user.get_value::<String, _>("") {
                candidates.push(PathBuf::from(manifest_path));
            }
        }
        candidates
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::{
        discovery::DiscoveryStore,
        framing::Direction,
        mcp_server::BrowserSessionClient,
        protocol::{Envelope, MessageKind, PROTOCOL_VERSION},
    };
    use serde_json::json;
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;
    use tempfile::TempDir;
    use tokio::{
        io::AsyncWriteExt,
        sync::oneshot,
        time::{timeout, Duration},
    };

    async fn write_local_request(
        stream: &mut tokio::net::UnixStream,
        record: &crate::discovery::DiscoveryRecord,
        id: &str,
        kind: MessageKind,
    ) {
        let request = Envelope {
            version: PROTOCOL_VERSION,
            id: id.into(),
            kind,
            secret: Some(record.secret.clone()),
            payload: json!({}),
        };
        stream
            .write_all(format!("{}\n", serde_json::to_string(&request).unwrap()).as_bytes())
            .await
            .unwrap();
        stream.flush().await.unwrap();
    }

    #[tokio::test]
    async fn turn_completion_bypasses_a_pending_tool_relay() {
        let temp = TempDir::new().unwrap();
        let store = DiscoveryStore::at(temp.path().join("runtime"));
        let record = store
            .register(std::process::id(), "chrome-extension://test".into())
            .unwrap();
        let listener = crate::local_transport::bind(&record).unwrap();
        let (chrome_host, chrome_peer) = UnixStream::pair().unwrap();
        let chrome_reader = chrome_host.try_clone().unwrap();
        let chrome_writer = Arc::new(Mutex::new(chrome_host));

        let (first_seen, first_seen_receiver) = oneshot::channel();
        let peer_reader = chrome_peer.try_clone().unwrap();
        let chrome_frames = tokio::task::spawn_blocking(move || {
            let mut reader = FrameReader::new(peer_reader, Direction::FromHost);
            let first = reader.read().unwrap().unwrap();
            first_seen.send(first).unwrap();
            reader.read().unwrap().unwrap()
        });

        let run_task = tokio::spawn(run_relay_loop(
            listener,
            record.clone(),
            chrome_reader,
            chrome_writer,
        ));

        let mut pending_tool = crate::local_transport::connect(&record).await.unwrap();
        write_local_request(
            &mut pending_tool,
            &record,
            "pending-tool",
            MessageKind::ToolRequest,
        )
        .await;
        let first = timeout(Duration::from_secs(1), first_seen_receiver)
            .await
            .unwrap()
            .unwrap();
        let first: Envelope = serde_json::from_value(first).unwrap();
        assert_eq!(first.kind, MessageKind::ToolRequest);

        let client = BrowserSessionClient::with_store(store);
        client.complete_turn().await.unwrap();
        let second = timeout(Duration::from_secs(1), chrome_frames)
            .await
            .unwrap()
            .unwrap();
        let second: Envelope = serde_json::from_value(second).unwrap();
        assert_eq!(second.kind, MessageKind::TurnComplete);

        chrome_peer.shutdown(Shutdown::Write).unwrap();
        let run_result = timeout(Duration::from_secs(1), run_task).await.unwrap();
        assert!(matches!(
            run_result.unwrap(),
            Err(NativeHostError::ChromeDisconnected)
        ));
    }
}
