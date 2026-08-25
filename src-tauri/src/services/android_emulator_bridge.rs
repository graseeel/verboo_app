use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use super::android_emulator::a11y::AndroidAccessibilityNode;
use super::android_emulator::input::InputOrigin;
use super::android_emulator::preview::FirstPreviewState;
use super::android_emulator::requirements::{self, AndroidDevice};
use super::android_emulator::sdk;
use super::android_emulator::{
    AndroidAccessibilitySnapshot, AndroidEmulatorService, AndroidEmulatorSystemAction,
};

const PROTOCOL_VERSION: u32 = 1;
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const DEFAULT_STREAM_FPS: u16 = 30;
const DEFAULT_FALLBACK_FPS: f64 = 2.0;
const DEFAULT_DRAG_DURATION_MS: u64 = 180;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidEmulatorDiscoveryRecord {
    pub protocol_version: u32,
    pub pid: u32,
    pub endpoint: String,
    pub secret: String,
    pub app_version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthEnvelope {
    secret: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeRequest {
    protocol_version: u32,
    #[serde(rename = "type")]
    kind: String,
    id: Option<String>,
    secret: Option<String>,
    tool: Option<String>,
    #[serde(default)]
    arguments: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeResponse {
    protocol_version: u32,
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Debug)]
struct DispatchError {
    code: &'static str,
    message: String,
}

impl DispatchError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum TapLocator {
    Point {
        x: f64,
        y: f64,
    },
    Target {
        target: String,
        hint: Option<(f64, f64)>,
    },
}

pub struct AndroidEmulatorBridge {
    stop: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
    endpoint: String,
    record_path: PathBuf,
}

fn run_accept_loop(
    listener: TcpListener,
    stop: Arc<AtomicBool>,
    mut on_connection: impl FnMut(TcpStream),
) {
    while !stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                if stop.load(Ordering::Acquire) {
                    break;
                }
                on_connection(stream);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

impl AndroidEmulatorBridge {
    pub fn start(
        cache_dir: PathBuf,
        app_version: String,
        app: AppHandle,
        service: AndroidEmulatorService,
    ) -> Result<Self, String> {
        service.bind_app(app.clone());
        let root = cache_dir.join("verboo-android-emulator");
        secure_directory(&root)?;
        cleanup_stale_records(&root);

        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
            format!("não foi possível iniciar o relay do emulador Android: {error}")
        })?;
        let endpoint = listener
            .local_addr()
            .map_err(|error| format!("não foi possível ler o relay do emulador Android: {error}"))?
            .to_string();
        let record = AndroidEmulatorDiscoveryRecord {
            protocol_version: PROTOCOL_VERSION,
            pid: std::process::id(),
            endpoint: endpoint.clone(),
            secret: Uuid::new_v4().simple().to_string(),
            app_version,
        };
        let record_path = root.join(format!("{}.json", record.pid));
        publish_record(&record_path, &record)?;

        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let worker_service = service.clone();
        let secret = Arc::new(record.secret.clone());
        let worker = thread::Builder::new()
            .name("verboo-android-emulator-bridge".into())
            .spawn(move || {
                run_accept_loop(listener, worker_stop, move |stream| {
                    let connection_secret = secret.clone();
                    let connection_service = worker_service.clone();
                    let connection_app = app.clone();
                    let _ = thread::Builder::new()
                        .name("verboo-android-emulator-request".into())
                        .spawn(move || {
                            handle_connection(
                                stream,
                                connection_secret.as_str(),
                                &connection_service,
                                &connection_app,
                            )
                        });
                });
            })
            .map_err(|error| {
                format!("não foi possível iniciar o relay do emulador Android: {error}")
            })?;

        Ok(Self {
            stop,
            worker: Mutex::new(Some(worker)),
            endpoint,
            record_path,
        })
    }

    pub fn stop(&self) {
        if self.stop.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = TcpStream::connect_timeout(
            &self
                .endpoint
                .parse()
                .unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], 9))),
            Duration::from_millis(50),
        );
        if let Some(worker) = self
            .worker
            .lock()
            .expect("android emulator bridge poisoned")
            .take()
        {
            let _ = worker.join();
        }
        let _ = std::fs::remove_file(&self.record_path);
    }
}

impl Drop for AndroidEmulatorBridge {
    fn drop(&mut self) {
        self.stop();
    }
}

fn handle_connection(
    mut stream: TcpStream,
    secret: &str,
    service: &AndroidEmulatorService,
    app: &AppHandle,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    let mut line = Vec::new();
    let read = BufReader::new(&mut stream)
        .take((MAX_REQUEST_BYTES + 2) as u64)
        .read_until(b'\n', &mut line);
    let response = match read {
        Ok(_) if line.len() > MAX_REQUEST_BYTES => {
            error_response(None, "request_too_large", "request exceeds 1 MiB")
        }
        Ok(0) => error_response(None, "invalid_request", "empty request"),
        Ok(_) => handle_request_line(&line, secret, service, Some(app)),
        Err(error) => error_response(None, "invalid_request", error.to_string()),
    };
    if let Ok(mut encoded) = serde_json::to_vec(&response) {
        encoded.push(b'\n');
        let _ = stream.write_all(&encoded);
    }
}

fn handle_request_line(
    line: &[u8],
    expected_secret: &str,
    service: &AndroidEmulatorService,
    app: Option<&AppHandle>,
) -> BridgeResponse {
    let auth = match serde_json::from_slice::<AuthEnvelope>(line) {
        Ok(auth) => auth,
        Err(error) => return error_response(None, "invalid_request", error.to_string()),
    };
    if auth.secret.as_deref() != Some(expected_secret) {
        return error_response(None, "unauthorized", "missing or invalid bridge secret");
    }
    let request = match serde_json::from_slice::<BridgeRequest>(line) {
        Ok(request) => request,
        Err(error) => return error_response(None, "invalid_request", error.to_string()),
    };
    if request.protocol_version != PROTOCOL_VERSION {
        return error_response(
            request.id,
            "protocol_version_mismatch",
            "unsupported protocol version",
        );
    }
    if request.secret.as_deref() != Some(expected_secret) {
        return error_response(
            request.id,
            "unauthorized",
            "missing or invalid bridge secret",
        );
    }
    if request.kind == "turnComplete" {
        return success_response(request.id, json!({ "cleared": true }));
    }
    if request.kind != "toolRequest" {
        return error_response(
            request.id,
            "invalid_request",
            "expected toolRequest or turnComplete",
        );
    }
    let Some(tool) = request.tool.as_deref() else {
        return error_response(request.id, "unknown_tool", "tool name is required");
    };
    match dispatch_tool(tool, request.arguments, service, app) {
        Ok(result) => success_response(request.id, result),
        Err(error) => error_response(request.id, error.code, error.message),
    }
}

fn dispatch_tool(
    tool: &str,
    arguments: Value,
    service: &AndroidEmulatorService,
    app: Option<&AppHandle>,
) -> Result<Value, DispatchError> {
    match tool {
        "android_emulator_list" => list_devices(service),
        "android_emulator_attach" => attach_device(arguments, service, app),
        "android_emulator_wait_until_ready" => wait_until_ready(arguments, service),
        "android_emulator_screenshot" => capture_screenshot(arguments, service, app),
        "android_emulator_tap" => tap(arguments, service),
        "android_emulator_drag" => drag(arguments, service),
        "android_emulator_type_text" => type_text(arguments, service),
        "android_emulator_press_key" => press_key(arguments, service),
        "android_emulator_system_action" => system_action(arguments, service),
        "android_emulator_detach" => {
            ensure_requested_device(service, &arguments)?;
            service.detach_sync().map_err(tool_error)?;
            Ok(json!({ "ok": true }))
        }
        "android_emulator_shutdown" => {
            ensure_requested_device(service, &arguments)?;
            service.end_sync().map_err(tool_error)?;
            Ok(json!({ "ok": true }))
        }
        _ => Err(DispatchError::new(
            "unknown_tool",
            format!("unknown android emulator tool: {tool}"),
        )),
    }
}

fn list_devices(service: &AndroidEmulatorService) -> Result<Value, DispatchError> {
    let sdk_path = sdk::resolve_sdk_path(&service.app_data_dir);
    let requirements = requirements::detect_requirements(service.runner.as_ref(), &sdk_path);
    let mut value = serde_json::to_value(requirements).map_err(internal_error)?;
    if let Some(session) = attached_session(service) {
        let summary = session.summary();
        let root = value.as_object_mut().ok_or_else(|| {
            DispatchError::new("internal_error", "requirements must be an object")
        })?;
        root.insert("attachedAvdName".into(), json!(summary.device.avd_name));
        root.insert("serial".into(), json!(summary.serial));
        root.insert("generation".into(), json!(summary.generation));
        root.insert("streamFps".into(), json!(summary.stream_fps));
        root.insert("fallbackFps".into(), json!(summary.fallback_fps));
    }
    Ok(value)
}

fn attach_device(
    arguments: Value,
    service: &AndroidEmulatorService,
    app: Option<&AppHandle>,
) -> Result<Value, DispatchError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        avd_name: Option<String>,
        stream_fps: Option<u16>,
        fallback_fps: Option<f64>,
    }
    let args: Args = parse_args(arguments)?;
    let sdk_path = sdk::resolve_sdk_path(&service.app_data_dir);
    let devices = requirements::detect_requirements(service.runner.as_ref(), &sdk_path).devices;
    let avd_name = resolve_attach_avd_name(&devices, args.avd_name.as_deref())?;
    ensure_attach_compatible(service, &avd_name)?;
    if let Some(session) = attached_session(service).filter(|session| session.avd_name == avd_name)
    {
        return serde_json::to_value(session.summary()).map_err(internal_error);
    }
    let app = app
        .cloned()
        .ok_or_else(|| DispatchError::new("internal_error", "app handle unavailable"))?;
    let session = service
        .attach_sync(
            app,
            avd_name,
            args.stream_fps.unwrap_or(DEFAULT_STREAM_FPS),
            args.fallback_fps.unwrap_or(DEFAULT_FALLBACK_FPS),
            None,
        )
        .map_err(tool_error)?;
    let _ = service.set_visible_sync(true);
    serde_json::to_value(session).map_err(internal_error)
}

fn wait_until_ready(
    arguments: Value,
    service: &AndroidEmulatorService,
) -> Result<Value, DispatchError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        avd_name: Option<String>,
        timeout_ms: Option<u64>,
    }
    let args: Args = parse_args(arguments)?;
    ensure_device(service, args.avd_name.as_deref())?;
    let timeout = Duration::from_millis(args.timeout_ms.unwrap_or(90_000).clamp(100, 90_000));
    let deadline = Instant::now() + timeout;
    loop {
        let session = attached_session(service)
            .ok_or_else(|| DispatchError::new("not_attached", "no Android emulator is attached"))?;
        match session.first_preview.status() {
            FirstPreviewState::Ready => {
                return serde_json::to_value(session.summary()).map_err(internal_error);
            }
            FirstPreviewState::Failed(error) => {
                return Err(DispatchError::new(
                    "tool_error",
                    format!("Android emulator preview failed: {error:?}"),
                ));
            }
            FirstPreviewState::Pending if Instant::now() >= deadline => {
                return Err(DispatchError::new(
                    "tool_error",
                    "timed out waiting for the Android emulator to become ready",
                ));
            }
            FirstPreviewState::Pending => thread::sleep(Duration::from_millis(10)),
        }
    }
}

fn capture_screenshot(
    arguments: Value,
    service: &AndroidEmulatorService,
    app: Option<&AppHandle>,
) -> Result<Value, DispatchError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        avd_name: Option<String>,
        #[allow(dead_code)]
        after_frame_generation: Option<u64>,
        #[allow(dead_code)]
        timeout_ms: Option<u64>,
    }
    let args: Args = parse_args(arguments)?;
    ensure_device(service, args.avd_name.as_deref())?;
    let app = app.ok_or_else(|| DispatchError::new("internal_error", "app handle unavailable"))?;
    let desktop = app.path().desktop_dir().map_err(|error| {
        DispatchError::new(
            "internal_error",
            format!("não foi possível localizar a Mesa: {error}"),
        )
    })?;
    let file = service.capture_screen_sync(&desktop).map_err(tool_error)?;
    let bytes = std::fs::read(&file.path).map_err(|error| {
        DispatchError::new(
            "tool_error",
            format!("could not read Android screenshot: {error}"),
        )
    })?;
    let session = attached_session(service)
        .ok_or_else(|| DispatchError::new("not_attached", "no Android emulator is attached"))?;
    Ok(json!({
        "ok": true,
        "avdName": session.device.avd_name,
        "generation": session.generation,
        "path": file.path,
        "mediaType": "image/png",
        "freshCapture": true,
        "dataUrl": format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ),
    }))
}

fn tap(arguments: Value, service: &AndroidEmulatorService) -> Result<Value, DispatchError> {
    ensure_requested_device(service, &arguments)?;
    let locator = parse_tap_locator(&arguments)?;
    let (x, y) = match locator {
        TapLocator::Point { x, y } => (x, y),
        TapLocator::Target { target, hint } => {
            let snapshot = service.accessibility_snapshot_sync().map_err(tool_error)?;
            resolve_semantic_target(&snapshot, &target, hint)?
        }
    };
    service
        .tap_sync(x, y, InputOrigin::default())
        .map_err(tool_error)?;
    Ok(json!({ "ok": true, "target": { "x": x, "y": y } }))
}

fn drag(arguments: Value, service: &AndroidEmulatorService) -> Result<Value, DispatchError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        avd_name: Option<String>,
        from_x: f64,
        from_y: f64,
        to_x: f64,
        to_y: f64,
        duration_ms: Option<u64>,
    }
    let args: Args = parse_args(arguments)?;
    ensure_device(service, args.avd_name.as_deref())?;
    service
        .drag_sync(
            args.from_x,
            args.from_y,
            args.to_x,
            args.to_y,
            args.duration_ms.unwrap_or(DEFAULT_DRAG_DURATION_MS),
            InputOrigin::default(),
        )
        .map_err(tool_error)?;
    Ok(json!({ "ok": true }))
}

fn type_text(arguments: Value, service: &AndroidEmulatorService) -> Result<Value, DispatchError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        avd_name: Option<String>,
        text: String,
    }
    let args: Args = parse_args(arguments)?;
    ensure_device(service, args.avd_name.as_deref())?;
    service
        .type_text_sync(&args.text, InputOrigin::default())
        .map_err(tool_error)?;
    Ok(json!({ "ok": true }))
}

fn press_key(arguments: Value, service: &AndroidEmulatorService) -> Result<Value, DispatchError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        avd_name: Option<String>,
        key: String,
    }
    let args: Args = parse_args(arguments)?;
    ensure_device(service, args.avd_name.as_deref())?;
    service
        .press_key_sync(&args.key, InputOrigin::default())
        .map_err(tool_error)?;
    Ok(json!({ "ok": true }))
}

fn system_action(
    arguments: Value,
    service: &AndroidEmulatorService,
) -> Result<Value, DispatchError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        avd_name: Option<String>,
        action: AndroidEmulatorSystemAction,
    }
    let args: Args = parse_args(arguments)?;
    ensure_device(service, args.avd_name.as_deref())?;
    service
        .system_action_sync(args.action, InputOrigin::default())
        .map_err(tool_error)?;
    Ok(json!({ "ok": true }))
}

fn parse_tap_locator(arguments: &Value) -> Result<TapLocator, DispatchError> {
    let target = arguments
        .get("target")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let x = arguments.get("x").and_then(Value::as_f64);
    let y = arguments.get("y").and_then(Value::as_f64);
    match (target, x, y) {
        (Some(target), x, y) => Ok(TapLocator::Target {
            target,
            hint: match (x, y) {
                (Some(x), Some(y)) => Some((x, y)),
                (None, None) => None,
                _ => {
                    return Err(DispatchError::new(
                        "invalid_arguments",
                        "provide target, or provide both x and y",
                    ))
                }
            },
        }),
        (None, Some(x), Some(y)) => Ok(TapLocator::Point { x, y }),
        _ => Err(DispatchError::new(
            "invalid_arguments",
            "provide target, or provide both x and y",
        )),
    }
}

fn resolve_semantic_target(
    snapshot: &AndroidAccessibilitySnapshot,
    target: &str,
    hint: Option<(f64, f64)>,
) -> Result<(f64, f64), DispatchError> {
    let needle = target.trim();
    let mut exact = matching_nodes(&snapshot.nodes, needle, true);
    if exact.is_empty() {
        exact = matching_nodes(&snapshot.nodes, needle, false);
    }
    if exact.is_empty() {
        return Err(DispatchError::new(
            "tool_error",
            format!("no Android control matches target {target:?}"),
        ));
    }
    let chosen = if let Some((hint_x, hint_y)) = hint {
        exact.into_iter().min_by(|left, right| {
            distance(node_center(left), (hint_x, hint_y))
                .partial_cmp(&distance(node_center(right), (hint_x, hint_y)))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    } else if exact.len() == 1 {
        exact.pop()
    } else {
        return Err(DispatchError::new(
            "tool_error",
            format!("multiple Android controls match target {target:?}; provide x and y to disambiguate"),
        ));
    };
    let Some(node) = chosen else {
        return Err(DispatchError::new(
            "tool_error",
            format!("no Android control matches target {target:?}"),
        ));
    };
    Ok(node_center(&node))
}

fn matching_nodes(
    nodes: &[AndroidAccessibilityNode],
    needle: &str,
    exact: bool,
) -> Vec<AndroidAccessibilityNode> {
    nodes
        .iter()
        .filter(|node| {
            node_fields(node).any(|field| {
                if exact {
                    field.eq_ignore_ascii_case(needle)
                } else {
                    field
                        .to_ascii_lowercase()
                        .contains(&needle.to_ascii_lowercase())
                }
            })
        })
        .cloned()
        .collect()
}

fn node_fields(node: &AndroidAccessibilityNode) -> impl Iterator<Item = &str> {
    [
        Some(node.id.as_str()),
        node.label.as_deref(),
        node.value.as_deref(),
    ]
    .into_iter()
    .flatten()
}

fn node_center(node: &AndroidAccessibilityNode) -> (f64, f64) {
    (
        node.frame.x + node.frame.width / 2.0,
        node.frame.y + node.frame.height / 2.0,
    )
}

fn distance(left: (f64, f64), right: (f64, f64)) -> f64 {
    let dx = left.0 - right.0;
    let dy = left.1 - right.1;
    dx * dx + dy * dy
}

fn resolve_attach_avd_name(
    devices: &[AndroidDevice],
    avd_name: Option<&str>,
) -> Result<String, DispatchError> {
    if let Some(avd_name) = avd_name.map(str::trim).filter(|value| !value.is_empty()) {
        return Ok(avd_name.to_string());
    }
    match devices {
        [device] => Ok(device.avd_name.clone()),
        [] => Err(DispatchError::new(
            "device_not_found",
            "no Android emulator AVD is available",
        )),
        _ => Err(DispatchError::new(
            "ambiguous_device",
            "multiple Android emulator AVDs are available; provide avdName",
        )),
    }
}

fn attached_session(
    service: &AndroidEmulatorService,
) -> Option<Arc<super::android_emulator::session::AndroidSession>> {
    service
        .state
        .lock()
        .expect("Android emulator state poisoned")
        .session
        .clone()
}

fn ensure_attach_compatible(
    service: &AndroidEmulatorService,
    requested: &str,
) -> Result<(), DispatchError> {
    if let Some(session) = attached_session(service) {
        if session.avd_name != requested {
            return Err(DispatchError::new(
                "device_mismatch",
                format!(
                    "{} is attached; refusing to replace it with {requested}",
                    session.avd_name
                ),
            ));
        }
    }
    Ok(())
}

fn ensure_requested_device(
    service: &AndroidEmulatorService,
    arguments: &Value,
) -> Result<(), DispatchError> {
    ensure_device(service, arguments.get("avdName").and_then(Value::as_str))
}

fn ensure_device(
    service: &AndroidEmulatorService,
    requested: Option<&str>,
) -> Result<(), DispatchError> {
    let session = attached_session(service)
        .ok_or_else(|| DispatchError::new("not_attached", "no Android emulator is attached"))?;
    if requested.is_some_and(|avd_name| avd_name != session.avd_name) {
        return Err(DispatchError::new(
            "device_mismatch",
            "requested Android emulator is not the attached device",
        ));
    }
    Ok(())
}

fn parse_args<T: for<'de> Deserialize<'de>>(arguments: Value) -> Result<T, DispatchError> {
    serde_json::from_value(arguments)
        .map_err(|error| DispatchError::new("invalid_arguments", error.to_string()))
}

fn tool_error(error: String) -> DispatchError {
    DispatchError::new("tool_error", error)
}

fn internal_error(error: serde_json::Error) -> DispatchError {
    DispatchError::new("internal_error", error.to_string())
}

fn success_response(id: Option<String>, result: Value) -> BridgeResponse {
    BridgeResponse {
        protocol_version: PROTOCOL_VERSION,
        kind: "toolResponse",
        id,
        result: Some(result),
        code: None,
        message: None,
    }
}

fn error_response(
    id: Option<String>,
    code: &'static str,
    message: impl Into<String>,
) -> BridgeResponse {
    BridgeResponse {
        protocol_version: PROTOCOL_VERSION,
        kind: "error",
        id,
        result: None,
        code: Some(code),
        message: Some(message.into()),
    }
}

fn secure_directory(root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|error| {
        format!("não foi possível criar discovery do emulador Android: {error}")
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).map_err(
            |error| format!("não foi possível proteger discovery do emulador Android: {error}"),
        )?;
    }
    Ok(())
}

fn publish_record(path: &Path, record: &AndroidEmulatorDiscoveryRecord) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4().simple()));
    let bytes = serde_json::to_vec(record).map_err(|error| {
        format!("não foi possível serializar discovery do emulador Android: {error}")
    })?;
    std::fs::write(&temporary, bytes).map_err(|error| {
        format!("não foi possível escrever discovery do emulador Android: {error}")
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600)).map_err(
            |error| format!("não foi possível proteger discovery do emulador Android: {error}"),
        )?;
    }
    std::fs::rename(&temporary, path).map_err(|error| {
        format!("não foi possível publicar discovery do emulador Android: {error}")
    })
}

fn cleanup_stale_records(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let stale = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<AndroidEmulatorDiscoveryRecord>(&bytes).ok())
            .map(|record| !process_is_alive(record.pid) || !endpoint_is_reachable(&record.endpoint))
            .unwrap_or(true);
        if stale {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn endpoint_is_reachable(endpoint: &str) -> bool {
    endpoint
        .parse::<SocketAddr>()
        .ok()
        .and_then(|address| TcpStream::connect_timeout(&address, Duration::from_millis(50)).ok())
        .is_some()
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn process_is_alive(_pid: u32) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::android_emulator::a11y::{AndroidAccessibilityNode, AndroidEmulatorRect};
    use crate::services::android_emulator::input::take_presence_log;
    use crate::services::android_emulator::preview::{FirstPreviewGate, PreviewMode};
    use crate::services::android_emulator::session::{
        AndroidEmulatorOwnership, AndroidSession, PreviewGate, PreviewRuntime,
    };
    use crate::services::android_emulator::{CommandOutput, CommandRunner};

    fn response_value(response: BridgeResponse) -> Value {
        serde_json::to_value(response).unwrap()
    }

    #[test]
    fn tap_locator_requires_target_or_both_coordinates_and_ignores_origin() {
        assert_eq!(
            parse_tap_locator(&json!({"target": "Chrome"})).unwrap(),
            TapLocator::Target {
                target: "Chrome".into(),
                hint: None
            }
        );
        assert_eq!(
            parse_tap_locator(&json!({"x": 0.5, "y": 0.9, "origin": "manual"})).unwrap(),
            TapLocator::Point { x: 0.5, y: 0.9 }
        );
        assert_eq!(
            parse_tap_locator(&json!({"x": 0.2, "y": 0.3, "target": "Login"})).unwrap(),
            TapLocator::Target {
                target: "Login".into(),
                hint: Some((0.2, 0.3))
            }
        );
        assert_eq!(
            parse_tap_locator(&json!({"x": 0.5})).unwrap_err().code,
            "invalid_arguments"
        );
    }

    #[test]
    fn semantic_target_uses_label_then_center_and_does_not_fall_back_to_unrelated_points() {
        let snapshot = AndroidAccessibilitySnapshot {
            nodes: vec![
                node("other", Some("Gmail"), 0.1, 0.1, 0.2, 0.1),
                node("login", Some("Chrome"), 0.2, 0.4, 0.4, 0.2),
            ],
        };
        assert_eq!(
            resolve_semantic_target(&snapshot, "Chrome", None).unwrap(),
            (0.4, 0.5)
        );
        assert_eq!(
            resolve_semantic_target(&snapshot, "Missing", None)
                .unwrap_err()
                .code,
            "tool_error"
        );
    }

    #[test]
    fn attach_selector_uses_avd_name_or_the_only_available_device() {
        let devices = vec![device("Pixel_8_API_35"), device("Tablet_API_35")];
        assert_eq!(
            resolve_attach_avd_name(&devices, Some("Pixel_8_API_35")).unwrap(),
            "Pixel_8_API_35"
        );
        assert_eq!(
            resolve_attach_avd_name(&devices, None).unwrap_err().code,
            "ambiguous_device"
        );
        assert_eq!(
            resolve_attach_avd_name(&[device("Pixel_8_API_35")], None).unwrap(),
            "Pixel_8_API_35"
        );
        assert_eq!(
            resolve_attach_avd_name(&[], None).unwrap_err().code,
            "device_not_found"
        );
    }

    #[test]
    fn unknown_tools_return_a_stable_error_code() {
        let root = tempfile::tempdir().unwrap();
        let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
        let request = json!({
            "protocolVersion": 1,
            "type": "toolRequest",
            "secret": "right",
            "tool": "android_emulator_launch_app",
            "arguments": {},
        });
        let response = handle_request_line(request.to_string().as_bytes(), "right", &service, None);
        assert_eq!(response_value(response)["code"], "unknown_tool");
    }

    #[test]
    fn attach_refuses_to_replace_a_different_active_device() {
        let service = attached_service("Pixel_8_API_35");
        let error = dispatch_tool(
            "android_emulator_attach",
            json!({ "avdName": "Tablet_API_35" }),
            &service,
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, "device_mismatch");
    }

    #[test]
    fn list_reports_the_live_attached_session() {
        let service = attached_service("Pixel_8_API_35");
        let result = dispatch_tool("android_emulator_list", json!({}), &service, None).unwrap();
        assert_eq!(result["attachedAvdName"], "Pixel_8_API_35");
        assert_eq!(result["serial"], "emulator-5554");
        assert_eq!(result["streamFps"], 30);
    }

    #[test]
    fn wait_until_ready_returns_the_attached_session_when_preview_is_ready() {
        let service = attached_service("Pixel_8_API_35");
        service
            .state
            .lock()
            .unwrap()
            .session
            .as_ref()
            .unwrap()
            .first_preview
            .ready();
        let result = dispatch_tool(
            "android_emulator_wait_until_ready",
            json!({"timeoutMs": 100}),
            &service,
            None,
        )
        .unwrap();
        assert_eq!(result["device"]["avdName"], "Pixel_8_API_35");
        assert_eq!(result["lifecycle"]["stage"], "ready");
    }

    #[test]
    fn mutating_tools_use_agent_origin_even_when_manual_origin_is_supplied() {
        let mut service = attached_service("Pixel_8_API_35");
        service.runner = Arc::new(SucceedingRunner);
        take_presence_log();
        dispatch_tool(
            "android_emulator_tap",
            json!({"x": 0.5, "y": 0.5, "origin": "manual"}),
            &service,
            None,
        )
        .unwrap();
        assert_eq!(take_presence_log(), ["start:tap", "clear:tap"]);
    }

    #[test]
    fn tap_without_a_locator_is_rejected_at_the_bridge_boundary() {
        let service = attached_service("Pixel_8_API_35");
        let error = dispatch_tool("android_emulator_tap", json!({}), &service, None).unwrap_err();
        assert_eq!(error.code, "invalid_arguments");
    }

    #[test]
    fn drag_maps_flat_coordinates_onto_the_existing_service_path() {
        let mut service = attached_service("Pixel_8_API_35");
        service.runner = Arc::new(SucceedingRunner);
        dispatch_tool(
            "android_emulator_drag",
            json!({
                "fromX": 0.5,
                "fromY": 0.9,
                "toX": 0.5,
                "toY": 0.2,
                "durationMs": 180
            }),
            &service,
            None,
        )
        .unwrap();
    }

    #[test]
    fn screenshot_without_an_app_handle_does_not_invent_adb() {
        let service = attached_service("Pixel_8_API_35");
        let error =
            dispatch_tool("android_emulator_screenshot", json!({}), &service, None).unwrap_err();
        assert_eq!(error.code, "internal_error");
    }

    fn attached_service(avd_name: &str) -> AndroidEmulatorService {
        let root = tempfile::tempdir().unwrap();
        let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
        std::mem::forget(root);
        service.state.lock().unwrap().session = Some(test_session(avd_name));
        service
    }

    fn test_session(avd_name: &str) -> Arc<AndroidSession> {
        Arc::new(AndroidSession {
            avd_name: avd_name.to_string(),
            device: device(avd_name),
            serial: "emulator-5554".to_string(),
            adb_path: PathBuf::from("adb"),
            ownership: AndroidEmulatorOwnership::External,
            generation: 1,
            stream_fps: Arc::new(Mutex::new(30)),
            fallback_fps: Arc::new(Mutex::new(2.0)),
            gate: Arc::new(PreviewGate::new(true)),
            stop: Arc::new(AtomicBool::new(false)),
            input_lock: Arc::new(Mutex::new(())),
            dimensions: Arc::new(Mutex::new(Some((1080, 1920)))),
            device_display_size: (1080, 1920),
            emulator_process: Arc::new(Mutex::new(None)),
            recording: Arc::new(Mutex::new(None)),
            workers: Mutex::new(Vec::new()),
            emulator_pid: None,
            gpu_software: false,
            preview: Arc::new(PreviewRuntime::new(PreviewMode::LegacyPrimary, 1)),
            first_preview: Arc::new(FirstPreviewGate::new()),
        })
    }

    fn device(avd_name: &str) -> AndroidDevice {
        AndroidDevice {
            avd_name: avd_name.to_string(),
            display_name: avd_name.to_string(),
            api_level: 35,
            family: crate::services::android_emulator::requirements::AndroidDeviceFamily::Phone,
            running: true,
        }
    }

    fn node(
        id: &str,
        label: Option<&str>,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> AndroidAccessibilityNode {
        AndroidAccessibilityNode {
            id: id.to_string(),
            role: "android.view.View".to_string(),
            label: label.map(str::to_string),
            value: None,
            frame: AndroidEmulatorRect {
                x,
                y,
                width,
                height,
            },
            enabled: true,
            visible: true,
            actionable: true,
        }
    }

    struct SucceedingRunner;

    impl CommandRunner for SucceedingRunner {
        fn run(&self, _program: &str, _args: &[String]) -> Result<CommandOutput, String> {
            Ok(CommandOutput {
                success: true,
                stdout: Vec::new(),
                stderr: Vec::new(),
            })
        }
    }
}
