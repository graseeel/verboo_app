pub mod catalog;
pub mod discovery;
pub mod error;
pub mod framing;
pub mod local_transport;
pub mod mcp_server;
pub mod native_host;
pub mod protocol;
pub mod simulator_catalog;
pub mod simulator_client;
pub mod simulator_mcp;
pub mod simulator_protocol;

use error::{BridgeError, Result};
use mcp_server::{BrowserMcpServer, BrowserSessionClient};
use rmcp::ServiceExt;
use std::{
    future::Future,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::oneshot;

// Derived from the CLI 0.15.2 `StdioClientTransport.close()` sequence:
// Normal close is stdin.end() -> 2,000 ms -> SIGTERM -> 2,000 ms -> SIGKILL.
// Registered MCP cleanup is stricter: SIGINT -> 100 ms -> SIGTERM -> 400 ms
// -> SIGKILL. Keep the one-way browser cleanup inside that final window.
const CLI_SIGNAL_KILL_GRACE_MS: u64 = 400;
const TURN_CLEANUP_TIMEOUT: Duration = Duration::from_millis(CLI_SIGNAL_KILL_GRACE_MS / 2);

struct EofSignalReader<R> {
    inner: R,
    eof_signal: Option<oneshot::Sender<()>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShutdownPath {
    Waiting,
    Eof,
    TerminationSignal,
}

impl<R> EofSignalReader<R> {
    fn new(inner: R, eof_signal: oneshot::Sender<()>) -> Self {
        Self {
            inner,
            eof_signal: Some(eof_signal),
        }
    }
}

impl<R> AsyncRead for EofSignalReader<R>
where
    R: AsyncRead + Unpin,
{
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buf);
        if matches!(&result, Poll::Ready(Ok(())))
            && buf.filled().len() == before
            && buf.remaining() > 0
        {
            if let Some(signal) = self.eof_signal.take() {
                let _ = signal.send(());
            }
        }
        result
    }
}

async fn run_mcp_with_transport<R, W, T>(
    client: Arc<BrowserSessionClient>,
    server: BrowserMcpServer,
    reader: R,
    writer: W,
    mut eof_signal: oneshot::Receiver<()>,
    termination_signal: T,
) -> Result<ShutdownPath>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
    T: Future<Output = ()> + Send,
{
    let service = match server.serve((reader, writer)).await {
        Ok(service) => service,
        Err(error) => {
            attempt_turn_cleanup(&client).await;
            return Err(BridgeError::Mcp(error.to_string()));
        }
    };
    let cancellation = service.cancellation_token();
    let waiting = service.waiting();
    tokio::pin!(waiting);
    tokio::pin!(termination_signal);
    let (waiting_result, cleanup_sent, shutdown_path) = tokio::select! {
        biased;
        _ = &mut eof_signal => {
            cancellation.cancel();
            attempt_turn_cleanup(&client).await;
            (waiting
                .await
                .map(|_| ())
                .map_err(|error| BridgeError::Mcp(error.to_string())), true, ShutdownPath::Eof)
        }
        _ = &mut termination_signal => {
            cancellation.cancel();
            attempt_turn_cleanup(&client).await;
            (Ok(()), true, ShutdownPath::TerminationSignal)
        }
        result = &mut waiting => (
            result
                .map(|_| ())
                .map_err(|error| BridgeError::Mcp(error.to_string())),
            false,
            ShutdownPath::Waiting,
        ),
    };
    if !cleanup_sent {
        attempt_turn_cleanup(&client).await;
    }
    waiting_result.map(|_| shutdown_path)
}

async fn attempt_turn_cleanup_with<F, Fut, E>(cleanup: F)
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = std::result::Result<(), E>>,
    E: std::fmt::Display,
{
    match tokio::time::timeout(TURN_CLEANUP_TIMEOUT, cleanup()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            eprintln!("verboo-in-chrome: could not clear Chrome presence: {error}");
        }
        Err(_) => {
            eprintln!(
                "verboo-in-chrome: clearing Chrome presence timed out after {} ms",
                TURN_CLEANUP_TIMEOUT.as_millis()
            );
        }
    }
}

async fn attempt_turn_cleanup(client: &BrowserSessionClient) {
    attempt_turn_cleanup_with(|| client.complete_turn()).await;
}

#[cfg(unix)]
async fn wait_for_termination_signal() {
    use tokio::signal::unix::{signal, SignalKind};

    let interrupt = signal(SignalKind::interrupt());
    let terminate = signal(SignalKind::terminate());
    match (interrupt, terminate) {
        (Ok(mut interrupt), Ok(mut terminate)) => {
            tokio::select! {
                _ = interrupt.recv() => {}
                _ = terminate.recv() => {}
            }
        }
        (Ok(mut interrupt), Err(error)) => {
            eprintln!("verboo-in-chrome: could not register SIGTERM cleanup: {error}");
            let _ = interrupt.recv().await;
        }
        (Err(error), Ok(mut terminate)) => {
            eprintln!("verboo-in-chrome: could not register SIGINT cleanup: {error}");
            let _ = terminate.recv().await;
        }
        (Err(interrupt_error), Err(terminate_error)) => {
            eprintln!(
                "verboo-in-chrome: could not register termination cleanup: \
                 SIGINT={interrupt_error}; SIGTERM={terminate_error}"
            );
            std::future::pending::<()>().await;
        }
    }
}

#[cfg(not(unix))]
async fn wait_for_termination_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        eprintln!("verboo-in-chrome: could not register interrupt cleanup: {error}");
        std::future::pending::<()>().await;
    }
}

pub async fn run_mcp() -> Result<()> {
    let client = BrowserSessionClient::for_current_user()
        .map_err(|error| BridgeError::Mcp(error.to_string()))?;
    let client = Arc::new(client);
    let server = match BrowserMcpServer::new(Arc::clone(&client)) {
        Ok(server) => server,
        Err(error) => {
            attempt_turn_cleanup(&client).await;
            return Err(error.into());
        }
    };
    let (eof_signal, eof_signal_receiver) = oneshot::channel();
    let shutdown_path = run_mcp_with_transport(
        client,
        server,
        EofSignalReader::new(tokio::io::stdin(), eof_signal),
        tokio::io::stdout(),
        eof_signal_receiver,
        wait_for_termination_signal(),
    )
    .await?;
    if shutdown_path == ShutdownPath::TerminationSignal {
        // Tokio's stdin reader owns a blocking OS read that runtime shutdown
        // cannot cancel. Cleanup is already flushed, so exit before the CLI's
        // 100 ms SIGTERM escalation instead of waiting for SIGKILL.
        std::process::exit(0);
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        discovery::DiscoveryStore,
        local_transport,
        protocol::{Envelope, MessageKind, PROTOCOL_VERSION},
    };
    use serde_json::{json, Value};
    use tempfile::TempDir;
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        time::{timeout, Duration},
    };

    async fn write_json_line<W: AsyncWrite + Unpin>(writer: &mut W, value: Value) {
        writer
            .write_all(format!("{}\n", serde_json::to_string(&value).unwrap()).as_bytes())
            .await
            .unwrap();
        writer.flush().await.unwrap();
    }

    #[tokio::test]
    async fn eof_with_pending_tool_sends_turn_completion_before_service_exit() {
        let temp = TempDir::new().unwrap();
        let store = DiscoveryStore::at(temp.path().join("runtime"));
        let record = store
            .register(std::process::id(), "chrome-extension://test".into())
            .unwrap();
        let listener = local_transport::bind(&record).unwrap();
        let (tool_seen, tool_seen_receiver) = oneshot::channel();
        let (completion_seen, completion_seen_receiver) = oneshot::channel();
        let (release_native, release_native_receiver) = oneshot::channel();

        let native_task = tokio::spawn(async move {
            let (tool_stream, _) = listener.accept().await.unwrap();
            let (tool_reader, tool_writer) = tool_stream.into_split();
            let mut tool_lines = BufReader::new(tool_reader).lines();
            let tool_request: Envelope =
                serde_json::from_str(&tool_lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(tool_request.kind, MessageKind::ToolRequest);
            tool_seen.send(()).unwrap();

            let (completion_stream, _) = listener.accept().await.unwrap();
            let (completion_reader, completion_writer) = completion_stream.into_split();
            let mut completion_lines = BufReader::new(completion_reader).lines();
            let completion_request: Envelope =
                serde_json::from_str(&completion_lines.next_line().await.unwrap().unwrap())
                    .unwrap();
            assert_eq!(completion_request.version, PROTOCOL_VERSION);
            completion_seen.send(completion_request).unwrap();
            release_native_receiver.await.unwrap();
            drop(completion_writer);

            // Keep the first browser call pending until the MCP process has
            // proved that it can finish the turn independently of its result.
            let _tool_writer = tool_writer;
        });

        let client = Arc::new(BrowserSessionClient::with_store(store));
        let server = BrowserMcpServer::new(Arc::clone(&client)).unwrap();
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let (mut client_reader, mut client_writer) = tokio::io::split(client_io);
        let (server_reader, server_writer) = tokio::io::split(server_io);
        let (eof_signal, eof_signal_receiver) = oneshot::channel();
        let run_task = tokio::spawn(run_mcp_with_transport(
            client,
            server,
            EofSignalReader::new(server_reader, eof_signal),
            server_writer,
            eof_signal_receiver,
            std::future::pending(),
        ));

        write_json_line(
            &mut client_writer,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "pending-eof-test", "version": "1.0"}
                }
            }),
        )
        .await;
        let mut client_lines = BufReader::new(&mut client_reader).lines();
        let _initialize_response = client_lines.next_line().await.unwrap().unwrap();
        write_json_line(
            &mut client_writer,
            json!({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}),
        )
        .await;
        write_json_line(
            &mut client_writer,
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "navigate",
                    "arguments": {"url": "https://example.com"}
                }
            }),
        )
        .await;
        tool_seen_receiver.await.unwrap();
        client_writer.shutdown().await.unwrap();
        drop(client_writer);

        let completion_request = timeout(Duration::from_secs(1), completion_seen_receiver)
            .await
            .expect("EOF must dispatch turn completion while the tool is pending")
            .unwrap();
        assert_eq!(completion_request.kind, MessageKind::TurnComplete);
        let run_result = timeout(Duration::from_secs(1), run_task)
            .await
            .expect("turn cleanup must not wait for the pending tool");
        release_native.send(()).unwrap();
        assert_eq!(run_result.unwrap().unwrap(), ShutdownPath::Eof);
        native_task.await.unwrap();
    }

    #[tokio::test]
    async fn termination_signal_sends_turn_completion_before_process_exit() {
        let temp = TempDir::new().unwrap();
        let store = DiscoveryStore::at(temp.path().join("runtime"));
        let record = store
            .register(std::process::id(), "chrome-extension://test".into())
            .unwrap();
        let listener = local_transport::bind(&record).unwrap();
        let (completion_seen, completion_seen_receiver) = oneshot::channel();

        let native_task = tokio::spawn(async move {
            let (completion_stream, _) = listener.accept().await.unwrap();
            let (completion_reader, _completion_writer) = completion_stream.into_split();
            let mut completion_lines = BufReader::new(completion_reader).lines();
            let completion_request: Envelope =
                serde_json::from_str(&completion_lines.next_line().await.unwrap().unwrap())
                    .unwrap();
            completion_seen.send(completion_request).unwrap();
        });

        let client = Arc::new(BrowserSessionClient::with_store(store));
        let server = BrowserMcpServer::new(Arc::clone(&client)).unwrap();
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let (mut client_reader, mut client_writer) = tokio::io::split(client_io);
        let (server_reader, server_writer) = tokio::io::split(server_io);
        let (_eof_signal, eof_signal_receiver) = oneshot::channel();
        let (termination_signal, termination_signal_receiver) = oneshot::channel();
        let run_task = tokio::spawn(run_mcp_with_transport(
            client,
            server,
            EofSignalReader::new(server_reader, _eof_signal),
            server_writer,
            eof_signal_receiver,
            async move {
                let _ = termination_signal_receiver.await;
            },
        ));

        write_json_line(
            &mut client_writer,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "termination-test", "version": "1.0"}
                }
            }),
        )
        .await;
        let mut client_lines = BufReader::new(&mut client_reader).lines();
        let _initialize_response = client_lines.next_line().await.unwrap().unwrap();
        write_json_line(
            &mut client_writer,
            json!({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}),
        )
        .await;

        termination_signal.send(()).unwrap();
        let completion_request = timeout(Duration::from_secs(1), completion_seen_receiver)
            .await
            .expect("termination must dispatch turn completion")
            .unwrap();
        assert_eq!(completion_request.kind, MessageKind::TurnComplete);
        let run_result = timeout(Duration::from_secs(1), run_task)
            .await
            .expect("termination cleanup must finish before the CLI escalates the signal");
        assert_eq!(
            run_result.unwrap().unwrap(),
            ShutdownPath::TerminationSignal
        );
        native_task.await.unwrap();
    }

    #[tokio::test]
    async fn turn_cleanup_times_out_after_host_accepts_without_a_response() {
        let temp = TempDir::new().unwrap();
        let store = DiscoveryStore::at(temp.path().join("runtime"));
        let record = store
            .register(std::process::id(), "chrome-extension://test".into())
            .unwrap();
        let listener = local_transport::bind(&record).unwrap();
        let (accepted, accepted_receiver) = oneshot::channel();

        let native_task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            accepted.send(()).unwrap();
            let _stream = stream;
            std::future::pending::<()>().await;
        });

        let cleanup = async {
            let stream = local_transport::connect(&record).await.unwrap();
            let (mut reader, mut writer) = tokio::io::split(stream);
            writer.write_all(b"turn-complete\n").await.unwrap();
            writer.flush().await.unwrap();
            accepted_receiver.await.unwrap();

            let mut response = [0_u8; 1];
            reader.read(&mut response).await.unwrap();
            Ok::<(), std::io::Error>(())
        };

        let returned = timeout(
            TURN_CLEANUP_TIMEOUT + Duration::from_millis(250),
            attempt_turn_cleanup_with(|| cleanup),
        )
        .await;
        assert!(
            returned.is_ok(),
            "cleanup must return after the bounded timeout even without a host response"
        );

        native_task.abort();
        let _ = native_task.await;
    }
}
