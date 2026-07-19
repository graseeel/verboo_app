use std::borrow::Cow;
use std::sync::Arc;

use rmcp::model::{
    CallToolRequestParams, CallToolResult, Content, Implementation, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool, ToolAnnotations,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::catalog::{browser_catalog, BrowserCatalog, BrowserTool};
use crate::discovery::{DiscoveryError, DiscoveryStore};
use crate::local_transport;
use crate::protocol::{Envelope, MessageKind, PROTOCOL_VERSION};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelayErrorCode {
    UnknownTool,
    InvalidArguments,
    ChromeNotConnected,
    MultipleBrowserSessions,
    ApprovalRejected,
    ApprovalTimeout,
    ApprovalUiUnavailable,
    ProtocolVersionMismatch,
    ConnectionLost,
    InvalidResponse,
}

impl RelayErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnknownTool => "unknown_tool",
            Self::InvalidArguments => "invalid_arguments",
            Self::ChromeNotConnected => "chrome_not_connected",
            Self::MultipleBrowserSessions => "multiple_browser_sessions",
            Self::ApprovalRejected => "approval_rejected",
            Self::ApprovalTimeout => "approval_timeout",
            Self::ApprovalUiUnavailable => "approval_ui_unavailable",
            Self::ProtocolVersionMismatch => "protocol_version_mismatch",
            Self::ConnectionLost => "connection_lost",
            Self::InvalidResponse => "invalid_response",
        }
    }

    fn from_wire(value: &str) -> Self {
        match value {
            "approval_rejected" => Self::ApprovalRejected,
            "approval_timeout" => Self::ApprovalTimeout,
            "approval_ui_unavailable" => Self::ApprovalUiUnavailable,
            "protocol_version_mismatch" => Self::ProtocolVersionMismatch,
            "multiple_browser_sessions" => Self::MultipleBrowserSessions,
            "chrome_not_connected" => Self::ChromeNotConnected,
            "invalid_arguments" => Self::InvalidArguments,
            "unknown_tool" => Self::UnknownTool,
            "connection_lost" => Self::ConnectionLost,
            _ => Self::InvalidResponse,
        }
    }
}

#[derive(Debug, Error)]
#[error("{message}")]
pub struct RelayError {
    code: RelayErrorCode,
    message: String,
}

impl RelayError {
    pub fn new(code: RelayErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> RelayErrorCode {
        self.code
    }

    fn structured_value(&self) -> Value {
        json!({
            "ok": false,
            "error": {
                "code": self.code.as_str(),
                "message": self.message,
            }
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ToolRelayResult {
    Success(Value),
}

#[derive(Debug, Clone)]
pub struct BrowserSessionClient {
    store: DiscoveryStore,
}

impl BrowserSessionClient {
    pub fn for_current_user() -> Result<Self, RelayError> {
        let store = DiscoveryStore::for_current_user().map_err(map_discovery_error)?;
        Ok(Self { store })
    }

    pub fn with_store(store: DiscoveryStore) -> Self {
        Self { store }
    }

    pub async fn call_tool(
        &self,
        id: &str,
        name: &str,
        arguments: Value,
    ) -> Result<ToolRelayResult, RelayError> {
        let record = self
            .store
            .discover_session()
            .map_err(map_discovery_error)?
            .ok_or_else(|| {
                RelayError::new(
                    RelayErrorCode::ChromeNotConnected,
                    "Open Google Chrome with the Verboo extension enabled.",
                )
            })?;
        let stream = local_transport::connect(&record)
            .await
            .map_err(|error| RelayError::new(RelayErrorCode::ConnectionLost, error.to_string()))?;
        let (reader, mut writer) = tokio::io::split(stream);
        let request = Envelope {
            version: PROTOCOL_VERSION,
            id: id.to_string(),
            kind: MessageKind::ToolRequest,
            secret: Some(record.secret),
            payload: json!({ "name": name, "arguments": arguments }),
        };
        let encoded = serde_json::to_vec(&request).map_err(invalid_response)?;
        writer.write_all(&encoded).await.map_err(connection_lost)?;
        writer.write_all(b"\n").await.map_err(connection_lost)?;
        writer.flush().await.map_err(connection_lost)?;

        let mut lines = BufReader::new(reader).lines();
        let line = lines
            .next_line()
            .await
            .map_err(connection_lost)?
            .ok_or_else(|| {
                RelayError::new(
                    RelayErrorCode::ConnectionLost,
                    "Chrome disconnected before returning a tool result.",
                )
            })?;
        let response: Envelope = serde_json::from_str(&line).map_err(invalid_response)?;
        if response.version != PROTOCOL_VERSION {
            return Err(RelayError::new(
                RelayErrorCode::ProtocolVersionMismatch,
                "The Chrome extension and helper use different protocol versions.",
            ));
        }
        if response.id != id {
            return Err(RelayError::new(
                RelayErrorCode::InvalidResponse,
                "Chrome returned a response for a different request.",
            ));
        }

        match response.kind {
            MessageKind::ToolResponse => Ok(ToolRelayResult::Success(response.payload)),
            MessageKind::Error => {
                let code = response
                    .payload
                    .get("code")
                    .and_then(Value::as_str)
                    .map(RelayErrorCode::from_wire)
                    .unwrap_or(RelayErrorCode::InvalidResponse);
                let message = response
                    .payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Chrome rejected the browser tool request.");
                Err(RelayError::new(code, message))
            }
            _ => Err(RelayError::new(
                RelayErrorCode::InvalidResponse,
                "Chrome returned an unexpected bridge message.",
            )),
        }
    }
}

fn map_discovery_error(error: DiscoveryError) -> RelayError {
    match error {
        DiscoveryError::MultipleBrowserSessions => RelayError::new(
            RelayErrorCode::MultipleBrowserSessions,
            "More than one Chrome extension session is connected.",
        ),
        other => RelayError::new(RelayErrorCode::ConnectionLost, other.to_string()),
    }
}

fn connection_lost(error: std::io::Error) -> RelayError {
    RelayError::new(RelayErrorCode::ConnectionLost, error.to_string())
}

fn invalid_response(error: serde_json::Error) -> RelayError {
    RelayError::new(RelayErrorCode::InvalidResponse, error.to_string())
}

#[derive(Clone)]
pub struct BrowserMcpServer {
    catalog: BrowserCatalog,
    session: Arc<BrowserSessionClient>,
}

impl BrowserMcpServer {
    pub fn new(session: Arc<BrowserSessionClient>) -> Result<Self, serde_json::Error> {
        Ok(Self {
            catalog: browser_catalog()?,
            session,
        })
    }

    pub fn list_browser_tools(&self) -> &[BrowserTool] {
        &self.catalog.tools
    }

    pub async fn call_browser_tool(
        &self,
        id: &str,
        name: &str,
        arguments: Value,
    ) -> Result<ToolRelayResult, RelayError> {
        let tool = self
            .catalog
            .tools
            .iter()
            .find(|tool| tool.name == name)
            .ok_or_else(|| {
                RelayError::new(
                    RelayErrorCode::UnknownTool,
                    format!("Unknown browser tool: {name}"),
                )
            })?;
        let validator = jsonschema::validator_for(&tool.input_schema).map_err(|error| {
            RelayError::new(RelayErrorCode::InvalidArguments, error.to_string())
        })?;
        validator.validate(&arguments).map_err(|error| {
            RelayError::new(RelayErrorCode::InvalidArguments, error.to_string())
        })?;
        self.session.call_tool(id, name, arguments).await
    }

    fn rmcp_tool(tool: &BrowserTool) -> Tool {
        let input_schema = tool.input_schema.as_object().cloned().unwrap_or_default();
        Tool {
            name: Cow::Owned(tool.name.clone()),
            title: None,
            description: Some(Cow::Owned(tool.description.clone())),
            input_schema: Arc::new(input_schema),
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

    fn relay_result(result: Result<ToolRelayResult, RelayError>) -> CallToolResult {
        match result {
            Ok(ToolRelayResult::Success(value)) => CallToolResult {
                content: vec![Content::text(value.to_string())],
                structured_content: Some(value),
                is_error: Some(false),
                meta: None,
            },
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

impl ServerHandler for BrowserMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            server_info: Implementation {
                name: "verboo-in-chrome".to_string(),
                title: Some("Verboo in Chrome".to_string()),
                version: env!("CARGO_PKG_VERSION").to_string(),
                description: Some("Official browser-only Chrome tools from Verboo".to_string()),
                icons: None,
                website_url: None,
            },
            instructions: Some(
                "Controls Google Chrome through the Verboo extension. Approvals are shown in Chrome."
                    .to_string(),
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
        Ok(Self::relay_result(
            self.call_browser_tool(&context.id.to_string(), request.name.as_ref(), arguments)
                .await,
        ))
    }
}
