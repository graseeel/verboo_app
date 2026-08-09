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

use crate::simulator_catalog::{simulator_catalog, SimulatorCatalog, SimulatorTool};
use crate::simulator_client::{SimulatorClientError, SimulatorSessionClient};

const TURN_CLEANUP_TIMEOUT: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, PartialEq)]
pub enum SimulatorToolRelayResult {
    Success(Value),
}

#[derive(Debug, Clone)]
pub struct SimulatorRelayError {
    code: String,
    message: String,
}

impl SimulatorRelayError {
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

impl std::fmt::Display for SimulatorRelayError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for SimulatorRelayError {}

#[derive(Clone)]
pub struct SimulatorMcpServer {
    catalog: SimulatorCatalog,
    session: Arc<SimulatorSessionClient>,
}

impl SimulatorMcpServer {
    pub fn new(session: Arc<SimulatorSessionClient>) -> Result<Self, serde_json::Error> {
        Ok(Self {
            catalog: simulator_catalog()?,
            session,
        })
    }

    pub fn list_simulator_tools(&self) -> &[SimulatorTool] {
        &self.catalog.tools
    }

    pub async fn call_simulator_tool(
        &self,
        id: &str,
        name: &str,
        arguments: Value,
    ) -> Result<SimulatorToolRelayResult, SimulatorRelayError> {
        let tool = self
            .catalog
            .tools
            .iter()
            .find(|tool| tool.name == name)
            .ok_or_else(|| {
                SimulatorRelayError::new(
                    "unknown_tool",
                    format!("Unknown iOS Simulator tool: {name}"),
                )
            })?;
        let validator = jsonschema::validator_for(&tool.input_schema)
            .map_err(|error| SimulatorRelayError::new("invalid_arguments", error.to_string()))?;
        validator
            .validate(&arguments)
            .map_err(|error| SimulatorRelayError::new("invalid_arguments", error.to_string()))?;
        self.session
            .call_tool(id, name, arguments)
            .await
            .map(SimulatorToolRelayResult::Success)
            .map_err(map_client_error)
    }

    fn rmcp_tool(tool: &SimulatorTool) -> Tool {
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
        result: Result<SimulatorToolRelayResult, SimulatorRelayError>,
    ) -> CallToolResult {
        match result {
            Ok(SimulatorToolRelayResult::Success(mut value)) => {
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
    let (header, data) = encoded.split_once(",")?;
    let media_type = header.strip_suffix(";base64")?;
    if media_type.is_empty() || data.is_empty() {
        return None;
    }
    value.as_object_mut()?.remove("dataUrl");
    Some((data.to_string(), media_type.to_string()))
}

impl ServerHandler for SimulatorMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            server_info: Implementation {
                name: "verboo-ios-simulator".into(),
                title: Some("Verboo iOS Simulator".into()),
                version: env!("CARGO_PKG_VERSION").into(),
                description: Some("Interactive iOS Simulator tools owned by Verboo desktop".into()),
                icons: None,
                website_url: None,
            },
            instructions: Some(
                "Uses the iOS Simulator session already attached in Verboo desktop. It never launches a second device session."
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
            result = self.call_simulator_tool(&request_id, request.name.as_ref(), arguments) => result,
            _ = context.ct.cancelled() => Err(SimulatorRelayError::new(
                "connection_lost",
                "The MCP turn ended before the iOS Simulator returned a result.",
            )),
        };
        Ok(Self::relay_result(result))
    }
}

fn map_client_error(error: SimulatorClientError) -> SimulatorRelayError {
    match error {
        SimulatorClientError::NotConnected => SimulatorRelayError::new(
            "app_not_connected",
            "Open Verboo desktop before using iOS Simulator tools.",
        ),
        SimulatorClientError::ProtocolVersionMismatch => {
            SimulatorRelayError::new("protocol_version_mismatch", error.to_string())
        }
        SimulatorClientError::InvalidEndpoint | SimulatorClientError::InvalidDiscovery(_) => {
            SimulatorRelayError::new("invalid_discovery", error.to_string())
        }
        SimulatorClientError::ConnectionLost(_) => {
            SimulatorRelayError::new("connection_lost", error.to_string())
        }
        SimulatorClientError::InvalidResponse(_) => {
            SimulatorRelayError::new("invalid_response", error.to_string())
        }
        SimulatorClientError::Remote { code, message } => SimulatorRelayError::new(code, message),
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
    client: Arc<SimulatorSessionClient>,
    server: SimulatorMcpServer,
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

async fn attempt_turn_cleanup(client: &SimulatorSessionClient) {
    match tokio::time::timeout(TURN_CLEANUP_TIMEOUT, client.complete_turn()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("verboo-ios-simulator: could not clear presence: {error}"),
        Err(_) => eprintln!(
            "verboo-ios-simulator: presence cleanup timed out after {} ms",
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
    let client =
        Arc::new(SimulatorSessionClient::for_current_user().map_err(|error| error.to_string())?);
    let server = SimulatorMcpServer::new(Arc::clone(&client)).map_err(|error| error.to_string())?;
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
            "name": "verboo-ios-simulator",
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
        let result = SimulatorMcpServer::relay_result(Err(SimulatorRelayError::new(
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
        let result =
            SimulatorMcpServer::relay_result(Ok(SimulatorToolRelayResult::Success(value.clone())));
        assert_eq!(result.is_error, Some(false));
        assert_eq!(result.structured_content, Some(value));
    }
}
