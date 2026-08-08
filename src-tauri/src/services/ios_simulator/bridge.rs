use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;
use uuid::Uuid;

use super::{
    detect_requirements, image_data_url, IosSimulatorKey, IosSimulatorPresenceAction,
    IosSimulatorService, NormalizedPoint, PreviewGate, StreamProfile, DEFAULT_FALLBACK_FPS,
};

const PROTOCOL_VERSION: u32 = 1;
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const ACCEPT_POLL: Duration = Duration::from_millis(25);
const AGENT_PRESENCE_PRELUDE: Duration = Duration::from_millis(840);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulatorDiscoveryRecord {
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

pub struct IosSimulatorBridge {
    stop: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
    endpoint: String,
    record_path: PathBuf,
    service: IosSimulatorService,
}

impl IosSimulatorBridge {
    pub fn start(
        cache_dir: PathBuf,
        app_version: String,
        app: AppHandle,
        service: IosSimulatorService,
    ) -> Result<Self, String> {
        service.bind_app(app.clone());
        let root = cache_dir.join("verboo-ios-simulator");
        secure_directory(&root)?;
        cleanup_stale_records(&root);

        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("não foi possível iniciar o relay do simulador: {error}"))?;
        listener.set_nonblocking(true).map_err(|error| {
            format!("não foi possível configurar o relay do simulador: {error}")
        })?;
        let endpoint = listener
            .local_addr()
            .map_err(|error| format!("não foi possível ler o relay do simulador: {error}"))?
            .to_string();
        let record = SimulatorDiscoveryRecord {
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
            .name("verboo-ios-simulator-bridge".into())
            .spawn(move || {
                while !worker_stop.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let connection_secret = secret.clone();
                            let connection_service = worker_service.clone();
                            let connection_app = app.clone();
                            let _ = thread::Builder::new()
                                .name("verboo-ios-simulator-request".into())
                                .spawn(move || {
                                    handle_connection(
                                        stream,
                                        connection_secret.as_str(),
                                        &connection_service,
                                        &connection_app,
                                    )
                                });
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(ACCEPT_POLL)
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|error| format!("não foi possível iniciar o relay do simulador: {error}"))?;

        Ok(Self {
            stop,
            worker: Mutex::new(Some(worker)),
            endpoint,
            record_path,
            service,
        })
    }

    pub fn stop(&self) {
        if self.stop.swap(true, Ordering::AcqRel) {
            return;
        }
        self.service.clear_agent_presence();
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
            .expect("simulator bridge poisoned")
            .take()
        {
            let _ = worker.join();
        }
        let _ = std::fs::remove_file(&self.record_path);
    }
}

impl Drop for IosSimulatorBridge {
    fn drop(&mut self) {
        self.stop();
    }
}

fn handle_connection(
    mut stream: TcpStream,
    secret: &str,
    service: &IosSimulatorService,
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
    service: &IosSimulatorService,
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
        service.clear_agent_presence();
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
    service: &IosSimulatorService,
    app: Option<&AppHandle>,
) -> Result<Value, DispatchError> {
    match tool {
        "ios_simulator_list" => {
            let requirements = detect_requirements(service.runner.as_ref());
            serde_json::to_value(requirements).map_err(internal_error)
        }
        "ios_simulator_attach" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                udid: String,
                stream_fps: Option<u16>,
                fallback_fps: Option<f64>,
            }
            let args: Args = parse_args(arguments)?;
            ensure_attach_compatible(service, &args.udid)?;
            if let Some(session) = service
                .current_session_summary()
                .filter(|session| session.device.udid == args.udid)
            {
                let generation = service.begin_agent_action(
                    IosSimulatorPresenceAction::Attach,
                    None,
                    None,
                    None,
                );
                service.complete_agent_action(generation);
                return serde_json::to_value(session).map_err(internal_error);
            }
            let generation =
                service.begin_agent_action(IosSimulatorPresenceAction::Attach, None, None, None);
            let result = service.attach_sync(
                app.cloned().ok_or_else(|| {
                    DispatchError::new("internal_error", "app handle unavailable")
                })?,
                args.udid,
                args.stream_fps.unwrap_or(StreamProfile::DEFAULT.fps()),
                args.fallback_fps.unwrap_or(DEFAULT_FALLBACK_FPS),
            );
            service.complete_agent_action(generation);
            if result.is_ok() {
                // The first open request is intentionally pre-action so the
                // panel appears before control. A second request refreshes the
                // renderer after a slow device boot has published its session.
                service.request_agent_panel_open();
            }
            serde_json::to_value(result.map_err(tool_error)?).map_err(internal_error)
        }
        "ios_simulator_inspect" => {
            ensure_requested_device(service, &arguments)?;
            let result = with_presence(
                service,
                IosSimulatorPresenceAction::Inspect,
                None,
                None,
                None,
                || service.accessibility_snapshot_sync(),
            )
            .map_err(tool_error)?;
            serde_json::to_value(result).map_err(internal_error)
        }
        "ios_simulator_screenshot" => {
            ensure_requested_device(service, &arguments)?;
            with_presence(
                service,
                IosSimulatorPresenceAction::Screenshot,
                None,
                None,
                None,
                || {
                    let state = service.state.lock().expect("iOS simulator state poisoned");
                    let session = state
                        .session
                        .as_ref()
                        .ok_or_else(|| "Nenhum simulador está anexado.".to_string())?;
                    let frame = session
                        .latest_frame
                        .lock()
                        .expect("latest frame poisoned")
                        .clone()
                        .ok_or_else(|| "Aguardando a primeira captura do simulador.".to_string())?;
                    Ok(json!({
                        "udid": session.device.udid,
                        "deviceGeneration": frame.device_generation,
                        "frameGeneration": frame.frame_generation,
                        "mediaType": frame.media_type,
                        "dataUrl": image_data_url(&frame.bytes, frame.media_type),
                    }))
                },
            )
            .map_err(tool_error)
        }
        "ios_simulator_tap" => {
            #[derive(Deserialize)]
            struct Args {
                udid: Option<String>,
                x: f64,
                y: f64,
            }
            let args: Args = parse_args(arguments)?;
            ensure_device(service, args.udid.as_deref())?;
            let target = NormalizedPoint {
                x: args.x,
                y: args.y,
            };
            with_presence(
                service,
                IosSimulatorPresenceAction::Tap,
                Some(target),
                None,
                None,
                || service.tap_sync(target),
            )
            .map(|_| json!({ "ok": true }))
            .map_err(tool_error)
        }
        "ios_simulator_drag" => {
            #[derive(Deserialize, Clone, Copy)]
            struct Point {
                x: f64,
                y: f64,
            }
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                udid: Option<String>,
                from: Point,
                to: Point,
                duration_ms: Option<u64>,
            }
            let args: Args = parse_args(arguments)?;
            ensure_device(service, args.udid.as_deref())?;
            let start = NormalizedPoint {
                x: args.from.x,
                y: args.from.y,
            };
            let end = NormalizedPoint {
                x: args.to.x,
                y: args.to.y,
            };
            with_presence(
                service,
                IosSimulatorPresenceAction::Drag,
                None,
                Some(start),
                Some(end),
                || service.drag_sync(start, end, args.duration_ms.unwrap_or(180)),
            )
            .map(|_| json!({ "ok": true }))
            .map_err(tool_error)
        }
        "ios_simulator_type_text" => {
            #[derive(Deserialize)]
            struct Args {
                udid: Option<String>,
                text: String,
            }
            let args: Args = parse_args(arguments)?;
            ensure_device(service, args.udid.as_deref())?;
            with_presence(
                service,
                IosSimulatorPresenceAction::TypeText,
                None,
                None,
                None,
                || service.type_text_sync(&args.text),
            )
            .map(|_| json!({ "ok": true }))
            .map_err(tool_error)
        }
        "ios_simulator_press_key" => {
            #[derive(Deserialize)]
            struct Args {
                udid: Option<String>,
                key: IosSimulatorKey,
            }
            let args: Args = parse_args(arguments)?;
            ensure_device(service, args.udid.as_deref())?;
            with_presence(
                service,
                IosSimulatorPresenceAction::PressKey,
                None,
                None,
                None,
                || service.press_key_sync(args.key),
            )
            .map(|_| json!({ "ok": true }))
            .map_err(tool_error)
        }
        "ios_simulator_detach" => {
            ensure_requested_device(service, &arguments)?;
            let generation =
                service.begin_agent_action(IosSimulatorPresenceAction::Detach, None, None, None);
            service.detach_sync().map_err(tool_error)?;
            service.complete_agent_action(generation);
            Ok(json!({ "ok": true }))
        }
        _ => Err(DispatchError::new(
            "unknown_tool",
            format!("unknown simulator tool: {tool}"),
        )),
    }
}

fn with_presence<T>(
    service: &IosSimulatorService,
    action: IosSimulatorPresenceAction,
    target: Option<NormalizedPoint>,
    start: Option<NormalizedPoint>,
    end: Option<NormalizedPoint>,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let generation = service.begin_agent_action(action, target, start, end);
    // Match the Chrome presence contract: let the cursor reach its target
    // before WDA mutates the device. Connections are handled independently,
    // so turnComplete can still clear presence during this prelude.
    thread::sleep(AGENT_PRESENCE_PRELUDE);
    let result = operation();
    service.complete_agent_action(generation);
    result
}

fn ensure_attach_compatible(
    service: &IosSimulatorService,
    requested: &str,
) -> Result<(), DispatchError> {
    let state = service.state.lock().expect("iOS simulator state poisoned");
    if let Some(session) = state.session.as_ref() {
        if session.device.udid != requested {
            return Err(DispatchError::new(
                "device_mismatch",
                format!(
                    "{} is attached; refusing to replace it with {requested}",
                    session.device.udid
                ),
            ));
        }
    }
    Ok(())
}

fn ensure_requested_device(
    service: &IosSimulatorService,
    arguments: &Value,
) -> Result<(), DispatchError> {
    ensure_device(service, arguments.get("udid").and_then(Value::as_str))
}

fn ensure_device(
    service: &IosSimulatorService,
    requested: Option<&str>,
) -> Result<(), DispatchError> {
    let state = service.state.lock().expect("iOS simulator state poisoned");
    let session = state
        .session
        .as_ref()
        .ok_or_else(|| DispatchError::new("not_attached", "no simulator is attached"))?;
    if requested.is_some_and(|udid| udid != session.device.udid) {
        return Err(DispatchError::new(
            "device_mismatch",
            "requested simulator is not the attached device",
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
    std::fs::create_dir_all(root)
        .map_err(|error| format!("não foi possível criar discovery do simulador: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700)).map_err(
            |error| format!("não foi possível proteger discovery do simulador: {error}"),
        )?;
    }
    Ok(())
}

fn publish_record(path: &Path, record: &SimulatorDiscoveryRecord) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4().simple()));
    let bytes = serde_json::to_vec(record)
        .map_err(|error| format!("não foi possível serializar discovery do simulador: {error}"))?;
    std::fs::write(&temporary, bytes)
        .map_err(|error| format!("não foi possível escrever discovery do simulador: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600)).map_err(
            |error| format!("não foi possível proteger discovery do simulador: {error}"),
        )?;
    }
    std::fs::rename(&temporary, path)
        .map_err(|error| format!("não foi possível publicar discovery do simulador: {error}"))
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
            .and_then(|bytes| serde_json::from_slice::<SimulatorDiscoveryRecord>(&bytes).ok())
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
    use crate::services::ios_simulator::{
        IosSimulatorDevice, IosSimulatorStreamSource, PresenceAuthority, Session, StreamStats,
    };

    fn response_value(response: BridgeResponse) -> Value {
        serde_json::to_value(response).unwrap()
    }

    #[test]
    fn missing_or_wrong_secret_is_rejected_before_tool_arguments() {
        let service = IosSimulatorService::default();
        for secret in [None, Some("wrong")] {
            let request = json!({
                "protocolVersion": 1,
                "type": "toolRequest",
                "secret": secret,
                "tool": "ios_simulator_tap",
                "arguments": "not-an-object",
            });
            let response =
                handle_request_line(request.to_string().as_bytes(), "right", &service, None);
            assert_eq!(response_value(response)["code"], "unauthorized");
        }
    }

    #[test]
    fn unknown_tools_return_a_stable_error_code() {
        let service = IosSimulatorService::default();
        let request = json!({
            "protocolVersion": 1,
            "type": "toolRequest",
            "secret": "right",
            "tool": "ios_simulator_destroy_everything",
            "arguments": {},
        });
        let response = handle_request_line(request.to_string().as_bytes(), "right", &service, None);
        assert_eq!(response_value(response)["code"], "unknown_tool");
    }

    #[test]
    fn agent_open_request_resumes_preview_before_opening_the_panel() {
        let service = attached_service("phone-17-pro");
        service.set_visible_sync(false).unwrap();
        service.request_agent_panel_open();
        let state = service.state.lock().unwrap();
        assert!(state
            .session
            .as_ref()
            .expect("attached session")
            .gate
            .is_visible());
        assert!(service.desired_visibility.load(Ordering::Acquire));
    }

    fn attached_service(udid: &str) -> IosSimulatorService {
        let service = IosSimulatorService::default();
        service.state.lock().unwrap().session = Some(Session {
            device: IosSimulatorDevice {
                name: "iPhone 17 Pro".into(),
                udid: udid.into(),
                state: "Booted".into(),
                ios_version: "26.5".into(),
                family: crate::services::ios_simulator::IosSimulatorDeviceFamily::Iphone,
            },
            device_generation: 1,
            ownership: crate::services::ios_simulator::IosSimulatorOwnership::External,
            fallback_fps: Arc::new(Mutex::new(DEFAULT_FALLBACK_FPS)),
            stream_profile: Arc::new(Mutex::new(StreamProfile::DEFAULT)),
            stats: Arc::new(Mutex::new(StreamStats {
                source: IosSimulatorStreamSource::Mjpeg,
                effective_fps: Some(30.0),
            })),
            stop: Arc::new(AtomicBool::new(false)),
            input_lock: Arc::new(Mutex::new(())),
            latest_frame: Arc::new(Mutex::new(None)),
            gate: Arc::new(PreviewGate::new(true)),
            mjpeg_active: Arc::new(AtomicBool::new(false)),
            next_frame_generation: Arc::new(AtomicU64::new(0)),
            wda_control: Arc::new(Mutex::new(None)),
            wda_force_stop: Arc::new(Mutex::new(None)),
            staged_wda: None,
            sink: None,
            recording: Arc::new(Mutex::new(None)),
            workers: Mutex::new(Vec::new()),
        });
        service
    }

    #[test]
    fn attach_refuses_to_replace_a_different_active_device() {
        let service = attached_service("phone-a");
        let error = dispatch_tool(
            "ios_simulator_attach",
            json!({ "udid": "phone-b" }),
            &service,
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, "device_mismatch");
    }

    #[test]
    fn presence_is_active_before_the_agent_operation_and_clears_afterward() {
        let mut service = IosSimulatorService::default();
        service.presence = Arc::new(PresenceAuthority::default());
        let observed = with_presence(
            &service,
            IosSimulatorPresenceAction::Tap,
            Some(NormalizedPoint { x: 0.2, y: 0.3 }),
            None,
            None,
            || {
                assert!(service.presence.current_generation().is_some());
                Ok(())
            },
        );
        assert!(observed.is_ok());
        assert_eq!(service.presence.current_generation(), None);
    }
}
