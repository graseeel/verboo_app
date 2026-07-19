#[cfg(unix)]
mod unix_tests {
    use std::sync::Arc;

    use serde_json::{json, Value};
    use tempfile::TempDir;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use verboo_in_chrome::discovery::DiscoveryStore;
    use verboo_in_chrome::mcp_server::{
        BrowserMcpServer, BrowserSessionClient, RelayErrorCode, ToolRelayResult,
    };
    use verboo_in_chrome::protocol::{Envelope, MessageKind, PROTOCOL_VERSION};

    async fn connected_server() -> (BrowserMcpServer, tokio::task::JoinHandle<Envelope>, TempDir) {
        let temp = TempDir::new().unwrap();
        let store = DiscoveryStore::at(temp.path().join("runtime"));
        let record = store
            .register(std::process::id(), "chrome-extension://test".into())
            .unwrap();
        let listener = verboo_in_chrome::local_transport::bind(&record).unwrap();
        let expected_secret = record.secret.clone();

        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let mut lines = BufReader::new(reader).lines();
            let request: Envelope =
                serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
            assert_eq!(request.secret.as_deref(), Some(expected_secret.as_str()));
            let response = Envelope {
                version: PROTOCOL_VERSION,
                id: request.id.clone(),
                kind: MessageKind::ToolResponse,
                secret: None,
                payload: json!({"content": [{"type": "text", "text": "Verboo"}]}),
            };
            writer
                .write_all(format!("{}\n", serde_json::to_string(&response).unwrap()).as_bytes())
                .await
                .unwrap();
            request
        });

        let client = BrowserSessionClient::with_store(store);
        (BrowserMcpServer::new(Arc::new(client)).unwrap(), task, temp)
    }

    #[tokio::test]
    async fn lists_tools_and_relays_a_read_only_call_exactly() {
        let (server, request_task, _temp) = connected_server().await;
        assert!(server
            .list_browser_tools()
            .iter()
            .any(|tool| tool.name == "read_page"));

        let result = server
            .call_browser_tool("request-42", "read_page", json!({"selector": "main"}))
            .await
            .unwrap();
        assert_eq!(
            result,
            ToolRelayResult::Success(json!({"content": [{"type": "text", "text": "Verboo"}]}))
        );

        let request = request_task.await.unwrap();
        assert_eq!(request.id, "request-42");
        assert_eq!(request.kind, MessageKind::ToolRequest);
        assert_eq!(
            request.payload,
            json!({"name": "read_page", "arguments": {"selector": "main"}})
        );
    }

    #[tokio::test]
    async fn rejects_unknown_tools_before_opening_local_transport() {
        let temp = TempDir::new().unwrap();
        let server = BrowserMcpServer::new(Arc::new(BrowserSessionClient::with_store(
            DiscoveryStore::at(temp.path().join("runtime")),
        )))
        .unwrap();

        let error = server
            .call_browser_tool("request-1", "terminal", Value::Object(Default::default()))
            .await
            .unwrap_err();
        assert_eq!(error.code(), RelayErrorCode::UnknownTool);
    }

    #[tokio::test]
    async fn reports_when_chrome_is_not_connected() {
        let temp = TempDir::new().unwrap();
        let server = BrowserMcpServer::new(Arc::new(BrowserSessionClient::with_store(
            DiscoveryStore::at(temp.path().join("runtime")),
        )))
        .unwrap();

        let error = server
            .call_browser_tool("request-1", "read_page", json!({}))
            .await
            .unwrap_err();
        assert_eq!(error.code(), RelayErrorCode::ChromeNotConnected);
    }
}
