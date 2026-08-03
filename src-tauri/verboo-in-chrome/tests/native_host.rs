use std::fs;

use serde_json::json;
use tempfile::TempDir;
use verboo_in_chrome::discovery::DiscoveryStore;
use verboo_in_chrome::native_host::{
    load_allowed_origins, prepare_browser_request, validate_browser_response,
    validate_extension_origin, NativeHostError,
};
use verboo_in_chrome::protocol::{Envelope, MessageKind, PROTOCOL_VERSION};

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
