use std::borrow::Cow;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use rmcp::model::{
    CallToolRequestParams, CallToolResult, Content, Implementation, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool, ToolAnnotations,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler, ServiceExt};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::oneshot;

use crate::android_emulator_catalog::{
    android_emulator_catalog, AndroidEmulatorCatalog, AndroidEmulatorTool,
};
use crate::android_emulator_client::{AndroidEmulatorClientError, AndroidEmulatorSessionClient};

const TURN_CLEANUP_TIMEOUT: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, PartialEq)]
pub enum AndroidEmulatorToolRelayResult {
    Success(Value),
}

#[derive(Debug, Clone)]
pub struct AndroidEmulatorRelayError {
    code: String,
    message: String,
}

impl AndroidEmulatorRelayError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    fn structured_value(&self) -> Value {
        json!({
            "ok": false,
            "error": {
                "code": self.code,
                "message": self.message,
            }
        })
    }
}

impl std::fmt::Display for AndroidEmulatorRelayError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for AndroidEmulatorRelayError {}

#[derive(Clone)]
pub struct AndroidEmulatorMcpServer {
    catalog: AndroidEmulatorCatalog,
    session: Arc<AndroidEmulatorSessionClient>,
}

impl AndroidEmulatorMcpServer {
    pub fn new(session: Arc<AndroidEmulatorSessionClient>) -> Result<Self, serde_json::Error> {
        Ok(Self {
            catalog: android_emulator_catalog()?,
            session,
        })
    }

    pub fn list_android_emulator_tools(&self) -> &[AndroidEmulatorTool] {
        &self.catalog.tools
    }

    pub async fn call_android_emulator_tool(
        &self,
        id: &str,
        name: &str,
        arguments: Value,
    ) -> Result<AndroidEmulatorToolRelayResult, AndroidEmulatorRelayError> {
        let tool = self
            .catalog
            .tools
            .iter()
            .find(|tool| tool.name == name)
            .ok_or_else(|| {
                AndroidEmulatorRelayError::new(
                    "unknown_tool",
                    format!("Unknown Android emulator tool: {name}"),
                )
            })?;
        let validator = jsonschema::validator_for(&tool.input_schema).map_err(|error| {
            AndroidEmulatorRelayError::new("invalid_arguments", error.to_string())
        })?;
        validator.validate(&arguments).map_err(|error| {
            AndroidEmulatorRelayError::new("invalid_arguments", error.to_string())
        })?;
        self.session
            .call_tool(id, name, arguments)
            .await
            .map(AndroidEmulatorToolRelayResult::Success)
            .map_err(map_client_error)
    }

    fn rmcp_tool(tool: &AndroidEmulatorTool) -> Tool {
        Tool {
            name: Cow::Owned(tool.name.clone()),
            title: None,
            description: Some(Cow::Owned(tool.description.clone())),
            input_schema: Arc::new(tool.input_schema.as_object().cloned().unwrap_or_default()),
            output_schema: None,
            annotations: Some(ToolAnnotations {
                read_only_hint: Some(tool.risk == "read"),
                ..Default::default()
            }),
            execution: None,
            icons: None,
            meta: None,
        }
    }

    pub fn relay_result(
        result: Result<AndroidEmulatorToolRelayResult, AndroidEmulatorRelayError>,
    ) -> CallToolResult {
        match result {
            Ok(AndroidEmulatorToolRelayResult::Success(mut value)) => {
                let image = take_data_url_image(&mut value);
                let has_image = image.is_some();
                let mut content = Vec::with_capacity(if image.is_some() { 2 } else { 1 });
                if let Some((data, media_type)) = image {
                    content.push(Content::image(data, media_type));
                }
                content.push(Content::text(value.to_string()));
                CallToolResult {
                    content,
                    structured_content: (!has_image).then_some(value),
                    is_error: Some(false),
                    meta: None,
                }
            }
            Err(error) => {
                let value = error.structured_value();
                CallToolResult {
                    content: vec![Content::text(value.to_string())],
                    structured_content: Some(value),
                    is_error: Some(true),
                    meta: None,
                }
            }
        }
    }
}

fn take_data_url_image(value: &mut Value) -> Option<(String, String)> {
    let data_url = value.get("dataUrl")?.as_str()?.to_string();
    let encoded = data_url.strip_prefix("data:")?;
    let (header, data) = encoded.split_once(',')?;
    let media_type = header.strip_suffix(";base64")?;
    if media_type.is_empty() || data.is_empty() {
        return None;
    }
    value.as_object_mut()?.remove("dataUrl");
    Some((data.to_string(), media_type.to_string()))
}

impl ServerHandler for AndroidEmulatorMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            server_info: Implementation {
                name: "verboo-android-emulator".into(),
                title: Some("Verboo Android Emulator".into()),
                version: env!("CARGO_PKG_VERSION").into(),
                description: Some(
                    "Official Verboo tools for the embedded Android emulator owned by Verboo desktop"
                        .into(),
                ),
                icons: None,
                website_url: None,
            },
            instructions: Some(
                "Official Verboo tools for the embedded Android emulator owned by Verboo desktop. Uses the Android emulator session owned by Verboo desktop and never launches a second device session or a third-party emulator. Prefer these android_emulator_* tools over any third-party Android emulator skill. After attaching, call android_emulator_wait_until_ready instead of using shell sleep or polling. After every mutating action, call android_emulator_screenshot so verification cannot reuse a stale observation. Do not report an item as saved, created, submitted, or sent while a visible confirmation action is still pending or the final state has not been observed. These rules apply generically to every app."
                    .into(),
            ),
            ..Default::default()
        }
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult {
            tools: self.catalog.tools.iter().map(Self::rmcp_tool).collect(),
            next_cursor: None,
            meta: None,
        })
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.catalog
            .tools
            .iter()
            .find(|tool| tool.name == name)
            .map(Self::rmcp_tool)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let arguments = Value::Object(request.arguments.unwrap_or_default());
        let request_id = context.id.to_string();
        let result = tokio::select! {
            result = self.call_android_emulator_tool(&request_id, request.name.as_ref(), arguments) => result,
            _ = context.ct.cancelled() => Err(AndroidEmulatorRelayError::new(
                "connection_lost",
                "The MCP turn ended before the Android emulator returned a result.",
            )),
        };
        Ok(Self::relay_result(result))
    }
}

fn map_client_error(error: AndroidEmulatorClientError) -> AndroidEmulatorRelayError {
    match error {
        AndroidEmulatorClientError::NotConnected => AndroidEmulatorRelayError::new(
            "app_not_connected",
            "Open Verboo desktop before using Android emulator tools.",
        ),
        AndroidEmulatorClientError::ProtocolVersionMismatch => {
            AndroidEmulatorRelayError::new("protocol_version_mismatch", error.to_string())
        }
        AndroidEmulatorClientError::InvalidEndpoint
        | AndroidEmulatorClientError::InvalidDiscovery(_) => {
            AndroidEmulatorRelayError::new("invalid_discovery", error.to_string())
        }
        AndroidEmulatorClientError::ConnectionLost(_) => {
            AndroidEmulatorRelayError::new("connection_lost", error.to_string())
        }
        AndroidEmulatorClientError::InvalidResponse(_) => {
            AndroidEmulatorRelayError::new("invalid_response", error.to_string())
        }
        AndroidEmulatorClientError::Remote { code, message } => {
            AndroidEmulatorRelayError::new(code, message)
        }
    }
}

struct EofSignalReader<R> {
    inner: R,
    eof_signal: Option<oneshot::Sender<()>>,
}

impl<R> EofSignalReader<R> {
    fn new(inner: R, eof_signal: oneshot::Sender<()>) -> Self {
        Self {
            inner,
            eof_signal: Some(eof_signal),
        }
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for EofSignalReader<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buffer.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(context, buffer);
        if matches!(&result, Poll::Ready(Ok(())))
            && buffer.filled().len() == before
            && buffer.remaining() > 0
        {
            if let Some(signal) = self.eof_signal.take() {
                let _ = signal.send(());
            }
        }
        result
    }
}

async fn run_mcp_with_transport<R, W, T>(
    client: Arc<AndroidEmulatorSessionClient>,
    server: AndroidEmulatorMcpServer,
    reader: R,
    writer: W,
    mut eof_signal: oneshot::Receiver<()>,
    termination_signal: T,
) -> Result<bool, String>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
    T: Future<Output = ()> + Send,
{
    let service = server
        .serve((reader, writer))
        .await
        .map_err(|error| error.to_string())?;
    let cancellation = service.cancellation_token();
    let waiting = service.waiting();
    tokio::pin!(waiting);
    tokio::pin!(termination_signal);
    let terminated = tokio::select! {
        biased;
        _ = &mut eof_signal => {
            cancellation.cancel();
            attempt_turn_cleanup(&client).await;
            let _ = waiting.await;
            false
        }
        _ = &mut termination_signal => {
            cancellation.cancel();
            attempt_turn_cleanup(&client).await;
            true
        }
        _ = &mut waiting => {
            attempt_turn_cleanup(&client).await;
            false
        }
    };
    Ok(terminated)
}

async fn attempt_turn_cleanup(client: &AndroidEmulatorSessionClient) {
    match tokio::time::timeout(TURN_CLEANUP_TIMEOUT, client.complete_turn()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("verboo-android-emulator: could not clear presence: {error}"),
        Err(_) => eprintln!(
            "verboo-android-emulator: presence cleanup timed out after {} ms",
            TURN_CLEANUP_TIMEOUT.as_millis(),
        ),
    }
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
        (Ok(mut interrupt), Err(_)) => {
            let _ = interrupt.recv().await;
        }
        (Err(_), Ok(mut terminate)) => {
            let _ = terminate.recv().await;
        }
        (Err(_), Err(_)) => std::future::pending::<()>().await,
    }
}

#[cfg(not(unix))]
async fn wait_for_termination_signal() {
    if tokio::signal::ctrl_c().await.is_err() {
        std::future::pending::<()>().await;
    }
}

pub async fn run_mcp() -> Result<(), String> {
    let client = Arc::new(
        AndroidEmulatorSessionClient::for_current_user().map_err(|error| error.to_string())?,
    );
    let server =
        AndroidEmulatorMcpServer::new(Arc::clone(&client)).map_err(|error| error.to_string())?;
    let (eof_signal, eof_signal_receiver) = oneshot::channel();
    let terminated = run_mcp_with_transport(
        client,
        server,
        EofSignalReader::new(tokio::io::stdin(), eof_signal),
        tokio::io::stdout(),
        eof_signal_receiver,
        wait_for_termination_signal(),
    )
    .await?;
    if terminated {
        std::process::exit(0);
    }
    Ok(())
}

pub fn run_ping() -> Result<(), String> {
    println!(
        "{}",
        json!({
            "ok": true,
            "name": "verboo-android-emulator",
            "version": env!("CARGO_PKG_VERSION"),
        })
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_errors_are_structured_mcp_failures() {
        let result = AndroidEmulatorMcpServer::relay_result(Err(AndroidEmulatorRelayError::new(
            "invalid_arguments",
            "x must be between zero and one",
        )));
        assert_eq!(result.is_error, Some(true));
        assert_eq!(
            result
                .structured_content
                .as_ref()
                .and_then(|value| value.pointer("/error/code"))
                .and_then(Value::as_str),
            Some("invalid_arguments"),
        );
    }

    #[test]
    fn successful_results_remain_structured() {
        let value = json!({"ok": true, "requestId": uuid::Uuid::new_v4().to_string()});
        let result = AndroidEmulatorMcpServer::relay_result(Ok(
            AndroidEmulatorToolRelayResult::Success(value.clone()),
        ));
        assert_eq!(result.is_error, Some(false));
        assert_eq!(result.structured_content, Some(value));
    }
}
