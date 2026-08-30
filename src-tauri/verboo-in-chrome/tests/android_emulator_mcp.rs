use std::sync::Arc;

use rmcp::model::RawContent;
use rmcp::ServerHandler;
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use verboo_in_chrome::android_emulator_client::{
    AndroidEmulatorDiscoveryStore, AndroidEmulatorSessionClient,
};
use verboo_in_chrome::android_emulator_mcp::{
    AndroidEmulatorMcpServer, AndroidEmulatorToolRelayResult,
};
use verboo_in_chrome::android_emulator_protocol::{
    AndroidEmulatorBridgeRequest, AndroidEmulatorDiscoveryRecord, ANDROID_EMULATOR_PROTOCOL_VERSION,
};

async fn connected_server() -> (
    AndroidEmulatorMcpServer,
    tokio::task::JoinHandle<AndroidEmulatorBridgeRequest>,
    TempDir,
) {
    let temp = TempDir::new().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = listener.local_addr().unwrap().to_string();
    let store = AndroidEmulatorDiscoveryStore::at(temp.path().join("discovery"));
    let secret = "test-secret".to_string();
    store
        .write_record_for_test(&AndroidEmulatorDiscoveryRecord {
            protocol_version: ANDROID_EMULATOR_PROTOCOL_VERSION,
            pid: std::process::id(),
            endpoint,
            secret: secret.clone(),
            app_version: "test".into(),
        })
        .unwrap();

    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (reader, mut writer) = stream.into_split();
        let mut lines = BufReader::new(reader).lines();
        let request: AndroidEmulatorBridgeRequest =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(request.secret, secret);
        writer
            .write_all(
                format!(
                    "{}\n",
                    json!({
                        "protocolVersion": ANDROID_EMULATOR_PROTOCOL_VERSION,
                        "type": "toolResponse",
                        "id": request.id,
                        "result": { "ok": true, "target": { "x": 0.25, "y": 0.75 } }
                    })
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        request
    });

    let client = Arc::new(AndroidEmulatorSessionClient::with_store(store));
    (AndroidEmulatorMcpServer::new(client).unwrap(), task, temp)
}

#[tokio::test]
async fn android_emulator_mcp_relays_a_valid_tap_to_the_authenticated_desktop_bridge() {
    let (server, request_task, _temp) = connected_server().await;

    let result = server
        .call_android_emulator_tool(
            "request-42",
            "android_emulator_tap",
            json!({"target": "Chrome"}),
        )
        .await
        .unwrap();

    assert_eq!(
        result,
        AndroidEmulatorToolRelayResult::Success(
            json!({"ok": true, "target": {"x": 0.25, "y": 0.75}})
        ),
    );
    let structured = AndroidEmulatorMcpServer::relay_result(Ok(result));
    assert_eq!(structured.is_error, Some(false));
    assert_eq!(structured.structured_content.unwrap()["ok"], true);

    let request = request_task.await.unwrap();
    assert_eq!(request.kind, "toolRequest");
    assert_eq!(request.tool.as_deref(), Some("android_emulator_tap"));
    assert_eq!(request.arguments, json!({"target": "Chrome"}));
}

#[tokio::test]
async fn android_emulator_mcp_rejects_origin_without_contacting_the_desktop() {
    let temp = TempDir::new().unwrap();
    let server = AndroidEmulatorMcpServer::new(Arc::new(AndroidEmulatorSessionClient::with_store(
        AndroidEmulatorDiscoveryStore::at(temp.path().join("missing")),
    )))
    .unwrap();

    let error = server
        .call_android_emulator_tool(
            "bad-origin",
            "android_emulator_tap",
            json!({"x": 0.5, "y": 0.5, "origin": "manual"}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), "invalid_arguments");
}

#[tokio::test]
async fn android_emulator_mcp_invalid_arguments_are_structured_without_contacting_the_desktop() {
    let temp = TempDir::new().unwrap();
    let server = AndroidEmulatorMcpServer::new(Arc::new(AndroidEmulatorSessionClient::with_store(
        AndroidEmulatorDiscoveryStore::at(temp.path().join("missing")),
    )))
    .unwrap();

    let error = server
        .call_android_emulator_tool(
            "bad-point",
            "android_emulator_tap",
            json!({"x": 1.5, "y": "0.5"}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), "invalid_arguments");

    let structured = AndroidEmulatorMcpServer::relay_result(Err(error));
    assert_eq!(structured.is_error, Some(true));
    assert_eq!(
        structured
            .structured_content
            .as_ref()
            .and_then(|value| value.pointer("/error/code"))
            .and_then(Value::as_str),
        Some("invalid_arguments"),
    );
}

#[test]
fn android_emulator_screenshot_uses_content_blocks_so_the_cli_cannot_hide_the_image() {
    let result = AndroidEmulatorMcpServer::relay_result(Ok(
        AndroidEmulatorToolRelayResult::Success(json!({
            "avdName": "Pixel_8_API_35",
            "generation": 4,
            "mediaType": "image/png",
            "dataUrl": "data:image/png;base64,aGVsbG8=",
        })),
    ));

    assert_eq!(result.is_error, Some(false));
    assert!(matches!(
        result.content.first().map(|content| &content.raw),
        Some(RawContent::Image(image))
            if image.mime_type == "image/png" && image.data == "aGVsbG8="
    ));
    assert!(result.structured_content.is_none());
    assert!(matches!(
        result.content.get(1).map(|content| &content.raw),
        Some(RawContent::Text(text))
            if text.text.contains("Pixel_8_API_35")
                && !text.text.contains("aGVsbG8=")
    ));
}

#[test]
fn android_emulator_mcp_instructions_prefer_the_official_verboo_session() {
    let temp = TempDir::new().unwrap();
    let server = AndroidEmulatorMcpServer::new(Arc::new(AndroidEmulatorSessionClient::with_store(
        AndroidEmulatorDiscoveryStore::at(temp.path().join("missing")),
    )))
    .unwrap();
    let info = server.get_info();
    let instructions = info.instructions.unwrap().to_ascii_lowercase();

    assert_eq!(info.server_info.name, "verboo-android-emulator");
    assert!(instructions.contains("official verboo"));
    assert!(instructions.contains("android_emulator_wait_until_ready"));
    assert!(instructions.contains("android_emulator_screenshot"));
    assert!(instructions.contains("never launches a second device session"));
    assert!(instructions.contains("do not report an item as saved, created, submitted, or sent"));
    assert!(!instructions.contains("Reminders"));
}

#[cfg(unix)]
mod shutdown_harness {
    use std::io::{BufRead, BufReader as StdBufReader, Write};
    use std::process::{Child, Command, Stdio};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use super::*;

    enum Trigger {
        Eof,
        Signal(i32),
    }

    fn assert_provider_compatible_tool_schemas(response: &str) {
        let payload: Value = serde_json::from_str(response).unwrap();
        let tools = payload
            .pointer("/result/tools")
            .and_then(Value::as_array)
            .expect("tools/list must return a tool array");
        let unsupported = [
            "oneOf",
            "allOf",
            "anyOf",
            "dependentRequired",
            "if",
            "then",
            "else",
            "not",
        ];

        for tool in tools {
            let name = tool.get("name").and_then(Value::as_str).unwrap();
            assert!(
                name.starts_with("android_emulator_"),
                "unexpected tool {name}"
            );
            let schema = tool
                .get("inputSchema")
                .and_then(Value::as_object)
                .expect("every MCP tool must expose an inputSchema object");
            for keyword in unsupported {
                assert!(
                    !schema.contains_key(keyword),
                    "{name} serialized unsupported top-level schema keyword {keyword}",
                );
            }
        }
    }

    fn spawn_initialized_helper(
        discovery_root: &std::path::Path,
    ) -> (
        Child,
        std::process::ChildStdin,
        StdBufReader<std::process::ChildStdout>,
    ) {
        let mut child = Command::new(env!("CARGO_BIN_EXE_verboo-android-emulator"))
            .arg("mcp")
            .env("VERBOO_ANDROID_EMULATOR_DISCOVERY_DIR", discovery_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = StdBufReader::new(child.stdout.take().unwrap());
        writeln!(
            stdin,
            "{}",
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "android-emulator-shutdown-test", "version": "1"}
                }
            })
        )
        .unwrap();
        stdin.flush().unwrap();
        let mut response = String::new();
        stdout.read_line(&mut response).unwrap();
        assert!(
            response.contains("\"result\""),
            "initialize failed: {response}"
        );
        writeln!(
            stdin,
            "{}",
            json!({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
        )
        .unwrap();
        writeln!(
            stdin,
            "{}",
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        )
        .unwrap();
        stdin.flush().unwrap();
        response.clear();
        stdout.read_line(&mut response).unwrap();
        assert!(
            response.contains("\"id\":2"),
            "tool-list readiness failed: {response}"
        );
        assert_provider_compatible_tool_schemas(&response);
        (child, stdin, stdout)
    }

    fn run_harness(trigger: Trigger) {
        let temp = TempDir::new().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = listener.local_addr().unwrap().to_string();
        let store = AndroidEmulatorDiscoveryStore::at(temp.path().join("discovery"));
        let secret = "shutdown-secret".to_string();
        store
            .write_record_for_test(&AndroidEmulatorDiscoveryRecord {
                protocol_version: ANDROID_EMULATOR_PROTOCOL_VERSION,
                pid: std::process::id(),
                endpoint,
                secret: secret.clone(),
                app_version: "test".into(),
            })
            .unwrap();
        let (completion_tx, completion_rx) = mpsc::channel();
        let bridge = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut line = String::new();
            StdBufReader::new(stream.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["secret"], secret);
            assert_eq!(request["type"], "turnComplete");
            completion_tx.send(request.clone()).unwrap();
            writeln!(
                stream,
                "{}",
                json!({
                    "protocolVersion": ANDROID_EMULATOR_PROTOCOL_VERSION,
                    "type": "toolResponse",
                    "id": request["id"],
                    "result": {"cleared": true}
                })
            )
            .unwrap();
        });

        let (mut child, stdin, _stdout) = spawn_initialized_helper(store.root());
        let mut stdin_guard = Some(stdin);
        let started = Instant::now();
        match trigger {
            Trigger::Eof => drop(stdin_guard.take()),
            Trigger::Signal(signal) => {
                let result = unsafe { libc::kill(child.id() as i32, signal) };
                assert_eq!(result, 0);
            }
        }
        let completion = completion_rx
            .recv_timeout(Duration::from_millis(200))
            .expect("turnComplete must reach the desktop bridge within 200 ms");
        assert_eq!(completion["type"], "turnComplete");
        assert!(started.elapsed() <= Duration::from_millis(200));

        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                panic!("android emulator MCP helper did not exit after cleanup");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        bridge.join().unwrap();
    }

    #[test]
    fn android_emulator_mcp_eof_sends_turn_complete_within_cleanup_budget() {
        run_harness(Trigger::Eof);
    }

    #[test]
    fn android_emulator_mcp_sigint_sends_turn_complete_within_cleanup_budget() {
        run_harness(Trigger::Signal(libc::SIGINT));
    }

    #[test]
    fn android_emulator_mcp_sigterm_sends_turn_complete_within_cleanup_budget() {
        run_harness(Trigger::Signal(libc::SIGTERM));
    }
}
