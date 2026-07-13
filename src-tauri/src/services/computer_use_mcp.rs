use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::models::computer_use::{ActionScope, ComputerUseResult, ConsentGrant};
use crate::models::types::{ComputerUseAllowlistEntry, ComputerUseScope, ComputerUseSettings};
use crate::services::computer_use_service::ComputerUseService;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capability {
    pub session_id: String,
    pub token: String,
    pub app: String,
    pub goal: String,
    pub expires_at: u64,
    pub paused: bool,
    #[serde(default)]
    pub screenshot_attach_to_llm: bool,
}

fn runtime_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or("no application data directory")?;
    Ok(base.join("ai.verboo.code.desktop").join("computer-use-runtime"))
}

fn capability_path() -> Result<PathBuf, String> { Ok(runtime_dir()?.join("capability.json")) }
pub fn config_path() -> Result<PathBuf, String> { Ok(runtime_dir()?.join("mcp.json")) }
fn monitor_pid_path() -> Result<PathBuf, String> { Ok(runtime_dir()?.join("monitor.pid")) }

pub fn activate<F>(session_id: &str, app: &str, goal: &str, idle_timeout_secs: u64, screenshot_attach_to_llm: bool, on_emergency: F) -> Result<PathBuf, String>
where F: FnOnce() + Send + 'static {
    let dir = runtime_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let cap = Capability {
        session_id: session_id.into(),
        token: Uuid::new_v4().to_string(),
        app: app.into(),
        goal: goal.into(),
        expires_at: now().saturating_add(idle_timeout_secs),
        paused: false,
        screenshot_attach_to_llm,
    };
    let cap_path = capability_path()?;
    fs::write(&cap_path, serde_json::to_vec(&cap).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let config = json!({"mcpServers":{"verboo-computer-use":{
        "command": exe,
        "args": ["--computer-use-mcp"],
        "env": {"VERBOO_CU_TOKEN": cap.token, "VERBOO_CU_CAPABILITY_FILE": cap_path}
    }}});
    let path = config_path()?;
    fs::write(&path, serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&cap_path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    start_emergency_monitor(on_emergency)?;
    if let Err(error) = crate::services::computer_use_focus::start(session_id, app, &cap_path) {
        let _ = revoke();
        return Err(error);
    }
    Ok(path)
}

pub fn revoke() -> Result<(), String> {
    if let Ok(pid) = monitor_pid_path().and_then(|p| fs::read_to_string(p).map_err(|e| e.to_string())).and_then(|s| s.trim().parse::<i32>().map_err(|e| e.to_string())) {
        #[cfg(unix)] unsafe { libc::kill(pid, libc::SIGTERM); }
    }
    if let Ok(path) = monitor_pid_path() { let _ = fs::remove_file(path); }
    crate::services::computer_use_focus::stop_any()?;
    revoke_files()?;
    Ok(())
}

pub fn revoke_session(expected_session_id: &str) -> Result<bool, String> {
    let path = capability_path()?;
    match fs::read(&path) {
        Ok(bytes) => {
            let cap: Capability = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if cap.session_id != expected_session_id { return Ok(false); }
            if !crate::services::computer_use_focus::stop(expected_session_id)? { return Ok(false); }
            revoke()?;
            Ok(true)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}

fn revoke_files() -> Result<(), String> {
    let _ = crate::services::computer_use_focus::stop_any();
    for path in [capability_path()?, config_path()?] {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("revoke computer-use capability: {e}")),
        }
    }
    Ok(())
}

fn start_emergency_monitor<F>(on_emergency: F) -> Result<(), String>
where F: FnOnce() + Send + 'static {
    let mut spawn = crate::services::computer_use_spawn::ComputerUseSpawn::new();
    spawn.command.arg("--monitor-emergency").stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = spawn.command.spawn().map_err(|e| format!("start emergency monitor: {e}"))?;
    fs::write(monitor_pid_path()?, child.id().to_string()).map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("emergency monitor has no stdout")?;
    let mut reader = BufReader::new(stdout);
    let mut ready = String::new();
    reader.read_line(&mut ready).map_err(|e| e.to_string())?;
    if !ready.contains("monitor-ready") {
        let _ = child.kill();
        return Err("global emergency hotkey monitor did not become ready".into());
    }
    std::thread::spawn(move || {
        for line in reader.lines().map_while(Result::ok) {
            if line.contains("emergency-stop") {
                if revoke_files().is_ok() { on_emergency(); }
                break;
            }
        }
        let _ = child.wait();
    });
    Ok(())
}

pub fn set_paused(expected_session_id: &str, paused: bool) -> Result<(), String> {
    let path = capability_path()?;
    let mut cap: Capability = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if cap.session_id != expected_session_id { return Err("computer-use session mismatch".into()); }
    cap.paused = paused;
    fs::write(path, serde_json::to_vec(&cap).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

pub fn active_config_path(expected_session_id: Option<&str>) -> Option<PathBuf> {
    let expected = expected_session_id?;
    let cap: Capability = serde_json::from_slice(&fs::read(capability_path().ok()?).ok()?).ok()?;
    if !capability_is_active(&cap, expected, now()) { return None; }
    let path = config_path().ok()?;
    path.exists().then_some(path)
}

fn capability_is_active(cap: &Capability, expected_session_id: &str, at: u64) -> bool {
    cap.session_id == expected_session_id && !cap.paused && cap.expires_at > at
}

fn read_capability() -> Result<Capability, String> {
    let token = std::env::var("VERBOO_CU_TOKEN").map_err(|_| "missing capability token")?;
    let path = std::env::var("VERBOO_CU_CAPABILITY_FILE").map_err(|_| "missing capability path")?;
    let cap: Capability = serde_json::from_slice(&fs::read(path).map_err(|_| "computer-use session revoked")?).map_err(|e| e.to_string())?;
    if cap.token != token || cap.paused || cap.expires_at <= now() { return Err("computer-use session is not active".into()); }
    Ok(cap)
}

#[derive(Debug, Default)]
struct McpRuntime {
    screenshot_origin: Option<(f64, f64)>,
    screenshot_scale: f64,
}

impl McpRuntime {
    fn remember_state(&mut self, result: &ComputerUseResult) {
        let Some(state) = result.result.as_ref() else { return };
        let Some(frame) = state.get("window_frame") else { return };
        let Some(x) = frame.get("x").and_then(Value::as_f64) else { return };
        let Some(y) = frame.get("y").and_then(Value::as_f64) else { return };
        let scale = state
            .get("screenshot_scale")
            .and_then(Value::as_f64)
            .filter(|value| *value > 0.0)
            .unwrap_or(1.0);
        self.screenshot_origin = Some((x, y));
        self.screenshot_scale = scale;
    }

    fn coordinates(&self, args: &Value) -> Result<(i32, i32), Value> {
        let x = args.get("x").and_then(Value::as_f64).ok_or_else(|| {
            json!({"error":{"code":"invalid_argument","message":"x coordinate is required"}})
        })?;
        let y = args.get("y").and_then(Value::as_f64).ok_or_else(|| {
            json!({"error":{"code":"invalid_argument","message":"y coordinate is required"}})
        })?;
        if args.get("coordinate_space").and_then(Value::as_str) == Some("screen") {
            return Ok((x.round() as i32, y.round() as i32));
        }
        let (origin_x, origin_y) = self.screenshot_origin.ok_or_else(|| {
            json!({"error":{"code":"stale_state","message":"Read fresh app state before using screenshot coordinates"}})
        })?;
        let scale = if self.screenshot_scale > 0.0 { self.screenshot_scale } else { 1.0 };
        Ok(((origin_x + x / scale).round() as i32, (origin_y + y / scale).round() as i32))
    }
}

fn tool_content(result: &Value) -> Value {
    let mut sanitized = result.clone();
    let screenshot = sanitized
        .pointer_mut("/result")
        .and_then(Value::as_object_mut)
        .and_then(|state| state.remove("screenshot_base64"));
    let mime_type = sanitized
        .pointer("/result/screenshot_mime_type")
        .and_then(Value::as_str)
        .unwrap_or("image/png")
        .to_string();
    let mut content = vec![json!({
        "type":"text",
        "text":serde_json::to_string(&sanitized).unwrap_or_default()
    })];
    if let Some(data) = screenshot.and_then(|value| value.as_str().map(ToOwned::to_owned)) {
        content.push(json!({"type":"image","data":data,"mimeType":mime_type}));
    }
    Value::Array(content)
}

pub fn run_stdio() -> Result<(), String> {
    let cap = read_capability()?;
    let service = ComputerUseService::new();
    let mut settings = ComputerUseSettings {
        enabled: true,
        allowlist: vec![ComputerUseAllowlistEntry {
            bundle_id: cap.app.clone(), display_name: cap.app.clone(), scope: ComputerUseScope::Input, ..Default::default()
        }],
        ..Default::default()
    };
    let req = service.request_session_with_id(&settings, cap.session_id.clone(), cap.goal.clone(), Some(cap.app.clone()), ActionScope::Input).map_err(|e| format!("{e:?}"))?;
    service.grant_session(ConsentGrant { id: req.id, allowlist_version: 1, self_test_enabled: false, screenshot_attach_to_llm: cap.screenshot_attach_to_llm, idle_timeout_secs: 900 }).map_err(|e| format!("{e:?}"))?;

    let mut runtime = McpRuntime::default();
    for line in io::stdin().lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        let request: Value = match serde_json::from_str(&line) { Ok(v) => v, Err(_) => continue };
        let Some(id) = request.get("id").cloned() else { continue };
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let response = match method {
            "initialize" => json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"verboo-computer-use","version":"1"}}}),
            "tools/list" => json!({"jsonrpc":"2.0","id":id,"result":{"tools": tools()}}),
            "tools/call" => {
                let result = call_tool(&service, &mut settings, &mut runtime, &request);
                let is_error = result.get("error").is_some_and(|value| !value.is_null());
                json!({"jsonrpc":"2.0","id":id,"result":{"content":tool_content(&result),"isError":is_error}})
            }
            _ => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"method not found"}}),
        };
        println!("{}", response);
        io::stdout().flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn tools() -> Value {
    json!([
      {"name":"computer_launch_app","description":"Open the application authorized for this session.","inputSchema":{"type":"object","properties":{}}},
      {"name":"computer_get_app_state","description":"Read fresh accessibility state and capture only the authorized app window. Element indexes and screenshot coordinates are short-lived.","inputSchema":{"type":"object","properties":{}}},
      {"name":"computer_click","description":"Click an element index or coordinates from the latest screenshot. Coordinates default to screenshot-local; use coordinate_space=screen only for absolute AX frames.","inputSchema":{"type":"object","properties":{"element_index":{"type":"integer"},"x":{"type":"number"},"y":{"type":"number"},"coordinate_space":{"enum":["screenshot","screen"]}}}},
      {"name":"computer_type_text","description":"Type text into the focused control of the authorized app.","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}
      ,{"name":"computer_press_key","description":"Press one navigation or editing key in the authorized app.","inputSchema":{"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}}
      ,{"name":"computer_hotkey","description":"Send a safe keyboard shortcut to the authorized app. Quit, close, and force-quit shortcuts are blocked.","inputSchema":{"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}}
      ,{"name":"computer_scroll","description":"Scroll up or down at verified coordinates from the latest authorized-app screenshot.","inputSchema":{"type":"object","properties":{"x":{"type":"number"},"y":{"type":"number"},"coordinate_space":{"enum":["screenshot","screen"]},"direction":{"enum":["up","down"]}},"required":["x","y","direction"]}}
    ])
}

fn call_tool(service: &ComputerUseService, settings: &mut ComputerUseSettings, runtime: &mut McpRuntime, request: &Value) -> Value {
    let cap = match read_capability() { Ok(c) => c, Err(e) => return json!({"error":{"code":"session_revoked","message":e}}) };
    let name = request.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
    let args = request.pointer("/params/arguments").cloned().unwrap_or_else(|| json!({}));
    let result = match name {
        "computer_launch_app" => service.launch_app(settings, &cap.app),
        "computer_get_app_state" => service.get_app_state(settings, &cap.app, !cap.screenshot_attach_to_llm),
        "computer_click" => {
            let element_index = args.get("element_index").and_then(Value::as_u64).map(|v| v as u32);
            if element_index.is_some() {
                service.click(settings, Some(&cap.app), element_index, None, None)
            } else {
                let (x, y) = match runtime.coordinates(&args) { Ok(value) => value, Err(error) => return error };
                service.click(settings, Some(&cap.app), None, Some(x), Some(y))
            }
        }
        "computer_type_text" => service.type_text(settings, Some(&cap.app), args.get("text").and_then(Value::as_str).unwrap_or("").to_string()),
        "computer_press_key" => service.press_key(settings, Some(&cap.app), args.get("key").and_then(Value::as_str).unwrap_or("").to_string()),
        "computer_hotkey" => service.hotkey(settings, Some(&cap.app), args.get("key").and_then(Value::as_str).unwrap_or("").to_string()),
        "computer_scroll" => {
            let (x, y) = match runtime.coordinates(&args) { Ok(value) => value, Err(error) => return error };
            service.scroll(settings, Some(&cap.app), args.get("direction").and_then(Value::as_str).unwrap_or(""), None, Some(x), Some(y))
        }
        _ => return json!({"error":{"code":"unknown_tool","message":"unknown computer-use tool"}}),
    };
    if result.error.as_ref().is_some_and(|error| error.code == "audit_write_failed") {
        if revoke().is_err() {
            std::process::exit(70);
        }
    }
    if name == "computer_get_app_state" {
        runtime.remember_state(&result);
    }
    serde_json::to_value(result).unwrap_or_else(|e| json!({"error":{"code":"serialization","message":e.to_string()}}))
}

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exposes_only_the_p0_tools() {
        let tool_list = tools();
        let names: Vec<&str> = tool_list.as_array().unwrap().iter().filter_map(|v| v.get("name")?.as_str()).collect();
        assert_eq!(names, vec!["computer_launch_app", "computer_get_app_state", "computer_click", "computer_type_text", "computer_press_key", "computer_hotkey", "computer_scroll"]);
    }

    #[test]
    fn capability_is_bound_to_one_session_and_expiry() {
        let cap = Capability { session_id: "authorized".into(), token: "token".into(), app: "com.apple.Notes".into(), goal: "goal".into(), expires_at: 20, paused: false, screenshot_attach_to_llm: true };
        assert!(capability_is_active(&cap, "authorized", 19));
        assert!(!capability_is_active(&cap, "another-turn", 19));
        assert!(!capability_is_active(&cap, "authorized", 20));
    }

    #[test]
    #[ignore = "operates the real macOS Notes app"]
    #[cfg(target_os = "macos")]
    fn notes_read_smoke_runs_through_mcp_and_writes_audit() {
        let cap_file = tempfile::NamedTempFile::new().unwrap();
        let cap = Capability { session_id: "smoke".into(), token: "smoke-token".into(), app: "com.apple.Notes".into(), goal: "read Notes".into(), expires_at: now() + 60, paused: false, screenshot_attach_to_llm: true };
        fs::write(cap_file.path(), serde_json::to_vec(&cap).unwrap()).unwrap();
        std::env::set_var("VERBOO_CU_TOKEN", "smoke-token");
        std::env::set_var("VERBOO_CU_CAPABILITY_FILE", cap_file.path());

        let service = ComputerUseService::new();
        let mut settings = ComputerUseSettings { enabled: true, allowlist: vec![ComputerUseAllowlistEntry { bundle_id: cap.app.clone(), display_name: "Notes".into(), scope: ComputerUseScope::Input, ..Default::default() }], ..Default::default() };
        let request = service.request_session(&settings, "read Notes", Some(cap.app.clone()), ActionScope::Input).unwrap();
        let session = service.grant_session(ConsentGrant { id: request.id, allowlist_version: 1, self_test_enabled: false, screenshot_attach_to_llm: false, idle_timeout_secs: 60 }).unwrap();
        let response = call_tool(&service, &mut settings, &mut McpRuntime::default(), &json!({"params":{"name":"computer_get_app_state","arguments":{}}}));
        assert!(response.get("error").is_none_or(Value::is_null), "{response}");
        assert!(response.pointer("/result/tree").and_then(Value::as_str).unwrap_or("").contains("AXTextArea"));
        assert!(service.audit.as_ref().unwrap().count_for_session(&session.id).unwrap() >= 2);
    }

    #[test]
    fn screenshot_coordinates_map_back_to_absolute_window_space() {
        let runtime = McpRuntime {
            screenshot_origin: Some((100.0, 200.0)),
            screenshot_scale: 0.5,
        };
        assert_eq!(runtime.coordinates(&json!({"x":25,"y":50})).unwrap(), (150, 300));
        assert_eq!(runtime.coordinates(&json!({"x":25,"y":50,"coordinate_space":"screen"})).unwrap(), (25, 50));
    }

    #[test]
    fn tool_content_keeps_screenshot_out_of_text_and_emits_image() {
        let content = tool_content(&json!({
            "result": {
                "tree": "[0] AXWindow",
                "screenshot_base64": "aGVsbG8=",
                "screenshot_mime_type": "image/png"
            },
            "error": null
        }));
        let list = content.as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert!(!list[0].get("text").and_then(Value::as_str).unwrap().contains("aGVsbG8="));
        assert_eq!(list[1], json!({"type":"image","data":"aGVsbG8=","mimeType":"image/png"}));
    }
}
