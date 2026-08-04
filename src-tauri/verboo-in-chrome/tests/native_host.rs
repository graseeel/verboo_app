use std::fs;
use std::path::PathBuf;
use std::process::Stdio;

use serde_json::json;
use tempfile::TempDir;
use tokio::process::Command;
use tokio::time::{sleep, timeout, Duration};
use verboo_in_chrome::discovery::{DiscoveryRecord, DiscoveryStore};
use verboo_in_chrome::native_host::{
    load_allowed_origins, prepare_browser_request, validate_browser_response,
    validate_extension_origin, NativeHostError,
};
use verboo_in_chrome::protocol::{Envelope, MessageKind, PROTOCOL_VERSION};

// Derived from the bundled cli.mjs StdioClientTransport.close() budget
// documented in src-tauri/verboo-in-chrome/src/lib.rs:
// stdin.end() -> 2,000 ms before SIGTERM. Keep the test deadline at half of
// that declared grace so a stuck mutated host fails before the CLI would kill it.
const NATIVE_HOST_EOF_TIMEOUT: Duration = Duration::from_millis(2_000 / 2);

fn request(secret: Option<&str>) -> Envelope {
    Envelope {
        version: PROTOCOL_VERSION,
        id: "request-1".into(),
        kind: MessageKind::ToolRequest,
        secret: secret.map(str::to_string),
        payload: json!({"name": "read_page", "arguments": {}}),
    }
}

fn turn_complete(secret: Option<&str>) -> Envelope {
    Envelope {
        version: PROTOCOL_VERSION,
        id: "turn-complete-1".into(),
        kind: MessageKind::TurnComplete,
        secret: secret.map(str::to_string),
        payload: json!({}),
    }
}

#[test]
fn browser_bridge_protocol_stays_pinned_at_version_one() {
    assert_eq!(PROTOCOL_VERSION, 1);
}

#[test]
fn loads_and_validates_only_origins_from_the_installed_manifest() {
    let temp = TempDir::new().unwrap();
    let manifest = temp.path().join("host.json");
    fs::write(
        &manifest,
        serde_json::to_vec(&json!({
            "name": "com.verboo.code.browser_extension",
            "type": "stdio",
            "allowed_origins": ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]
        }))
        .unwrap(),
    )
    .unwrap();

    let allowed = load_allowed_origins(&manifest).unwrap();
    validate_extension_origin(
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
        &allowed,
    )
    .unwrap();
    assert!(matches!(
        validate_extension_origin(
            "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/",
            &allowed,
        ),
        Err(NativeHostError::OriginNotAllowed)
    ));
}

#[test]
fn authenticated_local_requests_are_forwarded_without_the_secret() {
    let temp = TempDir::new().unwrap();
    let store = DiscoveryStore::at(temp.path().join("runtime"));
    let record = store
        .register(std::process::id(), "chrome-extension://test/".into())
        .unwrap();

    let forwarded = prepare_browser_request(&record, request(Some(&record.secret))).unwrap();
    assert_eq!(forwarded.id, "request-1");
    assert_eq!(forwarded.kind, MessageKind::ToolRequest);
    assert_eq!(forwarded.secret, None);
}

#[test]
fn authenticated_turn_completion_is_forwarded_without_the_secret() {
    let temp = TempDir::new().unwrap();
    let store = DiscoveryStore::at(temp.path().join("runtime"));
    let record = store
        .register(std::process::id(), "chrome-extension://test/".into())
        .unwrap();

    let forwarded = prepare_browser_request(&record, turn_complete(Some(&record.secret))).unwrap();
    assert_eq!(forwarded.id, "turn-complete-1");
    assert_eq!(forwarded.kind, MessageKind::TurnComplete);
    assert_eq!(forwarded.secret, None);
}

#[test]
fn unauthenticated_local_requests_are_rejected() {
    let temp = TempDir::new().unwrap();
    let store = DiscoveryStore::at(temp.path().join("runtime"));
    let record = store
        .register(std::process::id(), "chrome-extension://test/".into())
        .unwrap();

    assert!(matches!(
        prepare_browser_request(&record, request(Some("wrong-secret"))),
        Err(NativeHostError::AuthenticationFailed)
    ));
}

#[test]
fn chrome_responses_must_match_the_request_id_and_protocol() {
    let sent = request(None);
    let valid = Envelope {
        version: PROTOCOL_VERSION,
        id: sent.id.clone(),
        kind: MessageKind::ToolResponse,
        secret: None,
        payload: json!({"ok": true}),
    };
    validate_browser_response(&sent, &valid).unwrap();

    let completion = turn_complete(None);
    let completion_ack = Envelope {
        version: PROTOCOL_VERSION,
        id: completion.id.clone(),
        kind: MessageKind::TurnCompleteAck,
        secret: None,
        payload: json!({"ok": true}),
    };
    validate_browser_response(&completion, &completion_ack).unwrap();

    let legacy_extension_error = Envelope {
        version: PROTOCOL_VERSION,
        id: completion.id.clone(),
        kind: MessageKind::Error,
        secret: None,
        payload: json!({"code": "malformed_envelope"}),
    };
    validate_browser_response(&completion, &legacy_extension_error).unwrap();

    let wrong_id = Envelope {
        id: "different".into(),
        ..valid.clone()
    };
    assert!(matches!(
        validate_browser_response(&sent, &wrong_id),
        Err(NativeHostError::ResponseIdMismatch)
    ));

    let wrong_version = Envelope {
        version: 99,
        ..valid
    };
    assert!(matches!(
        validate_browser_response(&sent, &wrong_version),
        Err(NativeHostError::ProtocolVersionMismatch)
    ));
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tokio::test]
async fn native_host_exits_on_stdin_eof_and_removes_its_discovery_record() {
    let temp = TempDir::new().unwrap();
    let home = temp.path();
    let origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
    let manifest_path = {
        #[cfg(target_os = "macos")]
        {
            home.join("Library/Application Support/Google/Chrome/NativeMessagingHosts")
                .join("com.verboo.code.browser_extension.json")
        }
        #[cfg(target_os = "linux")]
        {
            home.join(".config/google-chrome/NativeMessagingHosts")
                .join("com.verboo.code.browser_extension.json")
        }
    };
    fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
    fs::write(
        &manifest_path,
        serde_json::to_vec(&json!({
            "name": "com.verboo.code.browser_extension",
            "type": "stdio",
            "allowed_origins": [origin]
        }))
        .unwrap(),
    )
    .unwrap();

    #[cfg(target_os = "linux")]
    let runtime_dir = home.join("runtime");
    #[cfg(target_os = "macos")]
    let runtime_dir = home.join("Library/Caches");
    let store = DiscoveryStore::at(runtime_dir.join("verboo-in-chrome"));

    let mut command = Command::new(env!("CARGO_BIN_EXE_verboo-in-chrome"));
    command
        .args(["native-host", origin])
        .env("HOME", home)
        .env_remove("XDG_CACHE_HOME")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "linux")]
    command.env("XDG_RUNTIME_DIR", home.join("runtime"));
    #[cfg(target_os = "macos")]
    command.env_remove("XDG_RUNTIME_DIR");

    let mut child = command.spawn().unwrap();
    let record_path = store.record_path(child.id().unwrap());
    if timeout(NATIVE_HOST_EOF_TIMEOUT, async {
        while !record_path.exists() {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_err()
    {
        let _ = child.kill().await;
        let _ = child.wait().await;
        panic!(
            "native host did not publish discovery within {} ms",
            NATIVE_HOST_EOF_TIMEOUT.as_millis()
        );
    }
    let record: DiscoveryRecord = serde_json::from_slice(&fs::read(&record_path).unwrap()).unwrap();
    let endpoint = PathBuf::from(record.endpoint);

    drop(child.stdin.take());
    let status = match timeout(NATIVE_HOST_EOF_TIMEOUT, child.wait()).await {
        Ok(result) => result.unwrap(),
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            panic!(
                "native host did not exit within {} ms after Chrome stdin EOF",
                NATIVE_HOST_EOF_TIMEOUT.as_millis()
            );
        }
    };
    assert!(!status.success());
    assert!(
        !record_path.exists(),
        "SessionGuard must remove the JSON record"
    );
    assert!(
        !endpoint.exists(),
        "SessionGuard must remove the Unix socket"
    );
}
