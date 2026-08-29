//! Local diagnostic JSON Lines + CLI stderr. Nothing is sent over the network.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use tauri::Manager;

pub const JSONL_FILE: &str = "verboo.jsonl";
pub const STDERR_FILE: &str = "cli-stderr.log";
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
pub const KEEP_FILES: usize = 5;
pub const DEFAULT_PACKAGE_LINES: usize = 80;

const LAST_VERSIONS_FILE: &str = "last-versions.json";
const TOP_LEVEL_KEYS: &[&str] = &[
    "ts",
    "level",
    "code",
    "component",
    "message",
    "context",
    "correlation_id",
];
const CONTEXT_STRING_KEYS: &[&str] = &[
    "os",
    "arch",
    "app_version",
    "cli_version",
    "node_version",
    "provider",
    "model",
    "previous_app_version",
    "previous_cli_version",
];
const CONTEXT_COUNT_KEYS: &[&str] = &[
    "account_count",
    "item_count",
    "tokens_in_total",
    "tokens_out_total",
    "total_tokens",
];
const CONTEXT_BOOL_KEYS: &[&str] = &[
    "degraded",
    "empty_user",
    "empty_plan",
    "empty_summary",
    "empty_activity",
    "empty_tokens_out",
];
const MAX_MESSAGE_CHARS: usize = 512;
const MAX_PACKAGE_LINES: usize = 500;

static LOGGER: Mutex<Option<Arc<DiagnosticLog>>> = Mutex::new(None);
static BASE_CONTEXT: Mutex<Option<Value>> = Mutex::new(None);
static SESSION_ID: Mutex<Option<String>> = Mutex::new(None);
static ACTIVE: AtomicBool = AtomicBool::new(false);
static DEGRADED: AtomicBool = AtomicBool::new(false);

struct RotatingFile {
    path: PathBuf,
    file: Option<File>,
    size: u64,
}

impl RotatingFile {
    fn open(path: PathBuf) -> io::Result<Self> {
        let file = open_log_file(&path)?;
        let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
        Ok(Self {
            path,
            file: Some(file),
            size,
        })
    }

    fn write_line(&mut self, line: &str) -> io::Result<()> {
        let incoming = (line.len() as u64).saturating_add(1);
        if self.size > 0 && self.size.saturating_add(incoming) > MAX_FILE_BYTES {
            self.rotate()?;
        }
        let file = self.ensure_open()?;
        writeln!(file, "{line}")?;
        file.flush()?;
        self.size = self.size.saturating_add(incoming);
        Ok(())
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file = None;
        rotate_file(&self.path, KEEP_FILES)?;
        self.file = Some(open_log_file(&self.path)?);
        self.size = 0;
        Ok(())
    }

    fn ensure_open(&mut self) -> io::Result<&mut File> {
        if self.file.is_none() {
            let file = open_log_file(&self.path)?;
            self.size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
            self.file = Some(file);
        }
        self.file
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::Other, "log file missing"))
    }

    #[cfg(test)]
    fn seed_at_max(&mut self) -> io::Result<()> {
        if self.size >= MAX_FILE_BYTES {
            return Ok(());
        }
        let pad = (MAX_FILE_BYTES - self.size) as usize;
        let file = self.ensure_open()?;
        file.write_all(&vec![b'x'; pad])?;
        file.flush()?;
        self.size = MAX_FILE_BYTES;
        Ok(())
    }
}

fn open_log_file(path: &Path) -> io::Result<File> {
    let mut opts = OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
}

pub struct DiagnosticLog {
    dir: PathBuf,
    jsonl: Mutex<RotatingFile>,
    stderr: Mutex<RotatingFile>,
}

impl DiagnosticLog {
    pub fn open(dir: impl AsRef<Path>) -> io::Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        fs::create_dir_all(&dir)?;
        Ok(Self {
            jsonl: Mutex::new(RotatingFile::open(dir.join(JSONL_FILE))?),
            stderr: Mutex::new(RotatingFile::open(dir.join(STDERR_FILE))?),
            dir,
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn write_error(
        &self,
        component: &str,
        code: &str,
        message: &str,
        correlation_id: &str,
        context: Value,
    ) -> io::Result<()> {
        self.write_event(json!({
            "level": "error",
            "code": code,
            "component": component,
            "message": message,
            "correlation_id": correlation_id,
            "context": context,
        }))
    }

    pub fn write_event(&self, event: Value) -> io::Result<()> {
        let finalized = finalize_event(event);
        let line = serde_json::to_string(&finalized).unwrap_or_else(|_| "{}".to_string());
        write_rotating_line(&self.jsonl, "jsonl", &line)
    }

    pub fn append_cli_stderr(&self, line: &str) -> io::Result<()> {
        let mut sanitized = line.to_string();
        sanitize_text(&mut sanitized);
        let sanitized = sanitized.trim();
        if sanitized.is_empty() {
            return Ok(());
        }
        write_rotating_line(&self.stderr, "cli-stderr", sanitized)
    }
}

fn write_rotating_line(mutex: &Mutex<RotatingFile>, label: &str, line: &str) -> io::Result<()> {
    let mut file = match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            mark_degraded(&format!("{label} mutex poisoned"));
            poisoned.into_inner()
        }
    };
    if let Err(error) = file.write_line(line) {
        mark_degraded(&format!("{label} write failed: {error}"));
        return Err(error);
    }
    Ok(())
}

fn mark_degraded(reason: &str) {
    DEGRADED.store(true, Ordering::SeqCst);
    eprintln!("[verboo:diagnostic-log] degraded: {reason}");
}

/// OS-standard log directory resolved by Tauri. No path constructed here.
pub fn resolve_log_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_log_dir().map_err(|error| error.to_string())
}

/// Initialize the logger if the OS log dir is available. Never fails the caller:
/// a diagnostic tool must not abort application boot.
pub fn try_init(dir: Result<PathBuf, String>, context: Value) {
    match dir {
        Ok(dir) => {
            if let Err(error) = init(dir, context) {
                mark_degraded(&format!("failed to initialize: {error}"));
            }
        }
        Err(error) => {
            mark_degraded(&format!("log directory unavailable: {error}"));
        }
    }
}

pub fn init(dir: PathBuf, context: Value) -> io::Result<String> {
    let log = Arc::new(DiagnosticLog::open(&dir)?);
    let session_id = uuid::Uuid::new_v4().to_string();
    *LOGGER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&log));
    *BASE_CONTEXT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(context.clone());
    *SESSION_ID
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(session_id.clone());
    ACTIVE.store(true, Ordering::SeqCst);
    DEGRADED.store(false, Ordering::SeqCst);
    if let Err(error) = log.write_event(json!({
        "level": "info",
        "code": "session_start",
        "component": "session",
        "message": "session started",
        "correlation_id": session_id,
        "context": context,
    })) {
        mark_degraded(&format!("session_start write failed: {error}"));
    }
    maybe_emit_version_changed(&log, &context, &session_id);
    Ok(session_id)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLogStatus {
    pub active: bool,
    pub degraded: bool,
    pub dir: Option<String>,
}

pub fn status() -> DiagnosticLogStatus {
    DiagnosticLogStatus {
        active: ACTIVE.load(Ordering::Relaxed),
        degraded: DEGRADED.load(Ordering::Relaxed),
        dir: global_log().map(|log| log.dir.to_string_lossy().into_owned()),
    }
}

pub fn emit_error(
    component: &str,
    code: &str,
    message: &str,
    correlation_id: Option<&str>,
    extra_context: Value,
) {
    let Some(log) = global_log() else {
        return;
    };
    let context = merge_context(extra_context);
    let fallback = session_id();
    let correlation_id = correlation_id
        .filter(|id| !id.is_empty())
        .unwrap_or(&fallback);
    if let Err(error) = log.write_error(component, code, message, correlation_id, context) {
        eprintln!("[verboo:diagnostic-log] write failed: {error}");
    }
}

pub fn emit_state(component: &str, code: &str, extra_context: Value) {
    let Some(log) = global_log() else {
        return;
    };
    let context = merge_context(extra_context);
    let correlation_id = session_id();
    if let Err(error) = log.write_event(json!({
        "level": "info",
        "code": code,
        "component": component,
        "message": code,
        "correlation_id": correlation_id,
        "context": context,
    })) {
        eprintln!("[verboo:diagnostic-log] write failed: {error}");
    }
}

pub fn note_cli_version(version: &str) {
    let version = version.trim();
    if version.is_empty() || version == "unknown" {
        return;
    }
    {
        let mut base = BASE_CONTEXT
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(object) = base.as_mut().and_then(Value::as_object_mut) {
            if object.get("cli_version").and_then(Value::as_str) == Some(version) {
                return;
            }
            object.insert("cli_version".into(), json!(version));
        }
    }
    emit_state(
        "session",
        "session_cli_resolved",
        json!({ "cli_version": version }),
    );
}

pub fn diagnostic_package(max_lines: usize) -> Result<String, String> {
    let log = global_log().ok_or_else(|| "diagnostic log unavailable".to_string())?;
    let max_lines = max_lines.clamp(1, MAX_PACKAGE_LINES);
    let context = BASE_CONTEXT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
        .unwrap_or_else(|| json!({}));
    let raw = fs::read_to_string(log.dir.join(JSONL_FILE)).unwrap_or_default();
    let lines: Vec<&str> = raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let start = lines.len().saturating_sub(max_lines);
    let reported = status();
    let mut body = String::from("=== Verboo diagnostic package ===\n");
    for key in [
        "app_version",
        "cli_version",
        "os",
        "arch",
        "node_version",
    ] {
        if let Some(value) = context.get(key).and_then(Value::as_str) {
            body.push_str(&format!("{key}: {value}\n"));
        }
    }
    body.push_str(&format!("log_active: {}\n", reported.active));
    body.push_str(&format!("log_degraded: {}\n", reported.degraded));
    body.push_str("--- jsonl ---\n");
    for line in &lines[start..] {
        body.push_str(line);
        body.push('\n');
    }
    sanitize_text(&mut body);
    Ok(body)
}

pub fn append_cli_stderr(line: &str) {
    let Some(log) = global_log() else {
        return;
    };
    if let Err(error) = log.append_cli_stderr(line) {
        eprintln!("[verboo:diagnostic-log] write failed: {error}");
    }
}

fn global_log() -> Option<Arc<DiagnosticLog>> {
    LOGGER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn session_id() -> String {
    SESSION_ID
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
        .unwrap_or_else(|| "unknown".to_string())
}

fn merge_context(extra: Value) -> Value {
    let mut base = BASE_CONTEXT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
        .unwrap_or_else(|| json!({}));
    if !base.is_object() {
        base = json!({});
    }
    if let (Some(base_obj), Some(extra_obj)) = (base.as_object_mut(), extra.as_object()) {
        for (key, value) in extra_obj {
            base_obj.insert(key.clone(), value.clone());
        }
    }
    base
}

fn finalize_event(event: Value) -> Value {
    let mut out = Map::new();
    out.insert("ts".into(), json!(now_iso()));
    out.insert(
        "level".into(),
        json!(allow_level(event.get("level").and_then(Value::as_str))),
    );
    out.insert(
        "code".into(),
        json!(sanitize_owned(
            event.get("code").and_then(Value::as_str).unwrap_or("")
        )),
    );
    out.insert(
        "component".into(),
        json!(sanitize_owned(
            event
                .get("component")
                .and_then(Value::as_str)
                .unwrap_or("app")
        )),
    );
    let mut message = event
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    sanitize_text(&mut message);
    if message.chars().count() > MAX_MESSAGE_CHARS {
        message = message.chars().take(MAX_MESSAGE_CHARS).collect();
    }
    out.insert("message".into(), json!(message));
    out.insert(
        "context".into(),
        allowlist_context(event.get("context").unwrap_or(&Value::Null)),
    );
    out.insert(
        "correlation_id".into(),
        json!(sanitize_owned(
            event
                .get("correlation_id")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        )),
    );
    debug_assert!(out.keys().all(|key| TOP_LEVEL_KEYS.contains(&key.as_str())));
    Value::Object(out)
}

fn allow_level(level: Option<&str>) -> &'static str {
    match level {
        Some("info") => "info",
        Some("warn") => "warn",
        _ => "error",
    }
}

fn allowlist_context(value: &Value) -> Value {
    let Some(object) = value.as_object() else {
        return json!({});
    };
    let mut out = Map::new();
    for key in CONTEXT_STRING_KEYS {
        let Some(raw) = object.get(*key).and_then(Value::as_str) else {
            continue;
        };
        let sanitized = sanitize_owned(raw);
        if !sanitized.is_empty() {
            out.insert((*key).to_string(), json!(sanitized));
        }
    }
    if let Some(raw) = object.get("origin").and_then(Value::as_str) {
        if let Some(origin) = allow_origin(&sanitize_owned(raw)) {
            out.insert("origin".into(), json!(origin));
        }
    }
    if let Some(raw) = object.get("profile_status").and_then(Value::as_str) {
        if let Some(status) = allow_profile_status(&sanitize_owned(raw)) {
            out.insert("profile_status".into(), json!(status));
        }
    }
    for key in CONTEXT_COUNT_KEYS {
        if let Some(count) = object.get(*key).and_then(allow_count) {
            out.insert((*key).to_string(), json!(count));
        }
    }
    for key in CONTEXT_BOOL_KEYS {
        if let Some(flag) = object.get(*key).and_then(Value::as_bool) {
            out.insert((*key).to_string(), json!(flag));
        }
    }
    if let Some(items) = object.get("usage_window_counts").and_then(Value::as_array) {
        let counts: Vec<u64> = items.iter().filter_map(allow_count).collect();
        if counts.len() == items.len() {
            out.insert("usage_window_counts".into(), json!(counts));
        }
    }
    Value::Object(out)
}

fn allow_count(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|n| u64::try_from(n).ok()))
}

fn allow_origin(value: &str) -> Option<&'static str> {
    match value {
        "network" => Some("network"),
        "cache" => Some("cache"),
        "api-key" => Some("api-key"),
        "cli" => Some("cli"),
        "none" => Some("none"),
        _ => None,
    }
}

fn allow_profile_status(value: &str) -> Option<&'static str> {
    match value {
        "ready" => Some("ready"),
        "unauthenticated" => Some("unauthenticated"),
        "api-key-only" => Some("api-key-only"),
        "error" => Some("error"),
        _ => None,
    }
}

fn maybe_emit_version_changed(log: &DiagnosticLog, context: &Value, session_id: &str) {
    let app = context
        .get("app_version")
        .and_then(Value::as_str)
        .unwrap_or("");
    let cli = context
        .get("cli_version")
        .and_then(Value::as_str)
        .unwrap_or("");
    let previous = load_last_versions(&log.dir);
    if let Some(previous) = previous {
        let prev_app = previous.app_version.as_deref().unwrap_or("");
        let prev_cli = previous.cli_version.as_deref().unwrap_or("");
        let app_changed = is_real_version(prev_app) && is_real_version(app) && prev_app != app;
        let cli_changed = is_real_version(prev_cli) && is_real_version(cli) && prev_cli != cli;
        if app_changed || cli_changed {
            if let Err(error) = log.write_event(json!({
                "level": "info",
                "code": "version_changed",
                "component": "session",
                "message": "version changed",
                "correlation_id": session_id,
                "context": {
                    "app_version": app,
                    "cli_version": cli,
                    "previous_app_version": prev_app,
                    "previous_cli_version": prev_cli,
                },
            })) {
                mark_degraded(&format!("version_changed write failed: {error}"));
            }
        }
    }
    store_last_versions(&log.dir, app, cli);
}

fn is_real_version(value: &str) -> bool {
    !value.is_empty() && value != "unknown"
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
struct LastSeenVersions {
    #[serde(default)]
    app_version: Option<String>,
    #[serde(default)]
    cli_version: Option<String>,
}

fn load_last_versions(dir: &Path) -> Option<LastSeenVersions> {
    let bytes = fs::read(dir.join(LAST_VERSIONS_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn store_last_versions(dir: &Path, app: &str, cli: &str) {
    let payload = LastSeenVersions {
        app_version: nonempty_version(app),
        cli_version: nonempty_version(cli),
    };
    if let Ok(bytes) = serde_json::to_vec(&payload) {
        let _ = fs::write(dir.join(LAST_VERSIONS_FILE), bytes);
    }
}

fn nonempty_version(value: &str) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn sanitize_owned(input: &str) -> String {
    let mut text = input.to_string();
    sanitize_text(&mut text);
    text
}

fn sanitize_text(text: &mut String) {
    *text = crate::services::bootstrap_diag::sanitize(text);
    redact_prefixed_secret(text, "vbk_");
    redact_prefixed_secret(text, "sk-");
    redact_jwt(text);
    redact_dpapi_blob(text);
    redact_user_paths(text);
    redact_path_basenames(text);
}

fn redact_prefixed_secret(text: &mut String, prefix: &str) {
    loop {
        let Some(idx) = find_ignore_ascii_case(text, prefix) else {
            return;
        };
        let end = text[idx + prefix.len()..]
            .find(|ch: char| ch.is_whitespace() || ch == '"' || ch == '\'' || ch == ',')
            .map(|offset| idx + prefix.len() + offset)
            .unwrap_or(text.len());
        if end <= idx {
            return;
        }
        text.replace_range(idx..end, "[redacted]");
    }
}

fn redact_jwt(text: &mut String) {
    let mut search_from = 0;
    while search_from < text.len() {
        let Some(rel) = text[search_from..].find("eyJ") else {
            return;
        };
        let idx = search_from + rel;
        let rest = &text[idx..];
        let end = rest
            .find(|ch: char| ch.is_whitespace() || ch == '"' || ch == '\'' || ch == ',')
            .unwrap_or(rest.len());
        let token = &rest[..end];
        if token.bytes().filter(|b| *b == b'.').count() >= 2 {
            text.replace_range(idx..idx + end, "[redacted]");
            search_from = idx + "[redacted]".len();
        } else {
            search_from = idx + 3;
        }
    }
}

fn redact_dpapi_blob(text: &mut String) {
    const MARKER: &str = "AQAAANCM";
    loop {
        let Some(idx) = text.find(MARKER) else {
            break;
        };
        let end = text[idx..]
            .find(|ch: char| ch.is_whitespace() || ch == '"' || ch == '\'' || ch == ',')
            .map(|offset| idx + offset)
            .unwrap_or(text.len());
        if end <= idx {
            break;
        }
        text.replace_range(idx..end, "[redacted]");
    }
    const BLOB: &str = "{blob-dpapi";
    if let Some(idx) = find_ignore_ascii_case(text, BLOB) {
        let end = text[idx..]
            .find(|ch: char| ch.is_whitespace())
            .map(|offset| idx + offset)
            .unwrap_or(text.len());
        text.replace_range(idx..end, "[redacted]");
    }
}

fn redact_user_paths(text: &mut String) {
    if let Some(home) = dirs::home_dir() {
        let home = home.to_string_lossy().into_owned();
        if home.len() > 1 {
            while text.contains(&home) {
                *text = text.replace(&home, "~");
            }
        }
    }
    redact_named_home_prefix(text, &unix_users_marker());
    redact_named_home_prefix(text, &unix_home_marker());
    redact_named_home_prefix(text, &windows_users_marker_backslash());
    redact_named_home_prefix(text, &windows_users_marker_slash());
}

fn unix_users_marker() -> String {
    let mut marker = String::from("/");
    marker.push_str("Users");
    marker.push('/');
    marker
}

fn unix_home_marker() -> String {
    let mut marker = String::from("/");
    marker.push_str("home");
    marker.push('/');
    marker
}

fn windows_users_marker_backslash() -> String {
    let mut rest = String::from("Users");
    rest.push('\\');
    format!("{}{}{}", "C:", "\\", rest)
}

fn windows_users_marker_slash() -> String {
    let mut marker = String::from("C:");
    marker.push('/');
    marker.push_str("Users");
    marker.push('/');
    marker
}

fn redact_named_home_prefix(text: &mut String, prefix: &str) {
    loop {
        let Some(idx) = find_ignore_ascii_case(text, prefix) else {
            return;
        };
        let rest_start = idx + prefix.len();
        if rest_start > text.len() {
            return;
        }
        let rest = &text[rest_start..];
        let user_len = rest
            .find(|ch: char| ch == '/' || ch == '\\' || ch.is_whitespace() || ch == '"' || ch == '\'')
            .unwrap_or(rest.len());
        if user_len == 0 {
            text.replace_range(idx..rest_start, "~");
            continue;
        }
        text.replace_range(idx..rest_start + user_len, "~");
    }
}

fn redact_path_basenames(text: &mut String) {
    let mut output = String::with_capacity(text.len());
    let mut rest = text.as_str();
    while !rest.is_empty() {
        let Some(start) = rest.find("~/").or_else(|| rest.find("~\\")) else {
            output.push_str(rest);
            break;
        };
        output.push_str(&rest[..start]);
        let path_and_after = &rest[start..];
        let path_len = path_and_after
            .find(|ch: char| ch.is_whitespace() || ch == '"' || ch == '\'' || ch == ',')
            .unwrap_or(path_and_after.len());
        let path = &path_and_after[..path_len];
        output.push_str(&replace_file_basename(path));
        rest = &path_and_after[path_len..];
    }
    *text = output;
}

fn replace_file_basename(path: &str) -> String {
    let sep = if path.contains('\\') { '\\' } else { '/' };
    match path.rfind(sep) {
        Some(index) => {
            let base = &path[index + 1..];
            if base.contains('.') && !base.starts_with('.') {
                format!("{}<file>", &path[..=index])
            } else {
                path.to_string()
            }
        }
        None => path.to_string(),
    }
}

fn find_ignore_ascii_case(haystack: &str, needle: &str) -> Option<usize> {
    haystack
        .to_ascii_lowercase()
        .find(&needle.to_ascii_lowercase())
}

fn rotate_file(path: &Path, keep: usize) -> io::Result<()> {
    let Some(name) = path.file_name().map(|name| name.to_string_lossy().into_owned()) else {
        return Ok(());
    };
    let Some(dir) = path.parent() else {
        return Ok(());
    };
    if keep < 2 {
        let _ = fs::remove_file(path);
        return Ok(());
    }
    let _ = fs::remove_file(dir.join(format!("{name}.{}", keep - 1)));
    for index in (1..keep - 1).rev() {
        let from = dir.join(format!("{name}.{index}"));
        let to = dir.join(format!("{name}.{}", index + 1));
        if from.exists() {
            fs::rename(from, to)?;
        }
    }
    if path.exists() {
        fs::rename(path, dir.join(format!("{name}.1")))?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn serial_test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
pub(crate) fn reset_for_test() {
    *LOGGER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    *BASE_CONTEXT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    *SESSION_ID
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    ACTIVE.store(false, Ordering::SeqCst);
    DEGRADED.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn read_jsonl(dir: &Path) -> Vec<Value> {
        let raw = fs::read_to_string(dir.join(JSONL_FILE)).unwrap();
        raw.lines()
            .filter(|line| !line.trim().is_empty() && line.starts_with('{'))
            .map(|line| serde_json::from_str(line).expect(line))
            .collect()
    }

    fn production_source() -> String {
        let src = include_str!("diagnostic_log.rs").replace("\r\n", "\n");
        src.split("\n#[cfg(test)]\nmod tests {")
            .next()
            .unwrap()
            .to_string()
    }

    #[test]
    fn redacts_secrets_from_context_and_keeps_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let log = DiagnosticLog::open(dir.path()).unwrap();
        let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.secret-sig";
        let dpapi = "AQAAANCMnd8BFdERjHoAWMC/vMqQYabcdefghijklmnopqrstuvwxyz0123456789+/==";
        log.write_error(
            "turn",
            "process_error",
            &format!("spawn failed with vbk_liveSecret99 and Bearer super-secret-bearer and sk-proj-ABCDEFGHIJKLMNOP at /Users/alice/Documents/secret-project/auth.rs jwt={jwt} dpapi={dpapi}"),
            "turn-keep-me",
            json!({
                "os": "macos",
                "arch": "aarch64",
                "app_version": "0.8.0-beta",
                "cli_version": "0.15.18",
                "node_version": "24.19.0",
                "provider": "codex",
                "model": "gpt-5",
                "api_key": "vbk_liveSecret99",
                "token": "sk-proj-ABCDEFGHIJKLMNOP",
                "authorization": "Bearer super-secret-bearer",
                "jwt": jwt,
                "blob": dpapi,
                "prompt": "delete all my files now",
                "path": "/Users/alice/Documents/secret-project/auth.rs",
            }),
        )
        .unwrap();

        let line = fs::read_to_string(dir.path().join(JSONL_FILE)).unwrap();
        assert!(!line.contains("vbk_liveSecret99"), "secret must be absent: {line}");
        assert!(!line.contains("sk-proj-ABCDEFGHIJKLMNOP"), "secret must be absent: {line}");
        assert!(!line.contains("super-secret-bearer"), "secret must be absent: {line}");
        assert!(!line.contains("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), "jwt must be absent: {line}");
        assert!(!line.contains("AQAAANCMnd8BFdERjHo"), "dpapi blob must be absent: {line}");
        assert!(!line.contains("/Users/alice"), "user path must be reduced: {line}");
        assert!(!line.contains("auth.rs"), "user filename must be absent: {line}");
        assert!(!line.contains("delete all my files now"), "user prompt must be absent: {line}");
        assert!(!line.contains("api_key"), "non-allowlisted key must be dropped: {line}");
        assert!(!line.contains("prompt"), "non-allowlisted key must be dropped: {line}");

        let parsed = &read_jsonl(dir.path())[0];
        assert_eq!(parsed["context"]["os"], "macos");
        assert_eq!(parsed["context"]["arch"], "aarch64");
        assert_eq!(parsed["context"]["app_version"], "0.8.0-beta");
        assert_eq!(parsed["context"]["cli_version"], "0.15.18");
        assert_eq!(parsed["context"]["node_version"], "24.19.0");
        assert_eq!(parsed["context"]["provider"], "codex");
        assert_eq!(parsed["context"]["model"], "gpt-5");
        assert_eq!(parsed["code"], "process_error");
        assert_eq!(parsed["component"], "turn");
        assert!(
            parsed["message"].as_str().unwrap().contains("spawn failed"),
            "non-secret message remainder must remain: {parsed}"
        );
    }

    #[test]
    fn rotation_cuts_at_limit_and_keeps_five_files() {
        let dir = tempfile::tempdir().unwrap();
        let log = DiagnosticLog::open(dir.path()).unwrap();
        for i in 0..KEEP_FILES + 1 {
            log.jsonl
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .seed_at_max()
                .unwrap();
            log.write_error(
                "turn",
                "process_error",
                &format!("overflow-{i}"),
                &format!("cid-{i}"),
                json!({ "os": "macos" }),
            )
            .unwrap();
        }

        let mut jsonl: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(JSONL_FILE))
            .collect();
        jsonl.sort();
        assert_eq!(jsonl.len(), KEEP_FILES, "files={jsonl:?}");
        assert!(jsonl.contains(&JSONL_FILE.to_string()));
        assert!(dir.path().join(format!("{JSONL_FILE}.4")).exists());
        assert!(!dir.path().join(format!("{JSONL_FILE}.5")).exists());
        let current_len = fs::metadata(dir.path().join(JSONL_FILE)).unwrap().len();
        assert!(
            current_len < MAX_FILE_BYTES,
            "current file must be under the limit, got {current_len}"
        );
    }

    #[test]
    fn turn_error_writes_stable_code_and_correlation_id() {
        let dir = tempfile::tempdir().unwrap();
        let log = DiagnosticLog::open(dir.path()).unwrap();
        log.write_error(
            "turn",
            "authentication_failed",
            "invalid or expired token",
            "turn-abc-123",
            json!({ "os": "macos", "provider": "codex" }),
        )
        .unwrap();
        let parsed = &read_jsonl(dir.path())[0];
        assert_eq!(parsed["code"], "authentication_failed");
        assert_eq!(parsed["correlation_id"], "turn-abc-123");
        assert_eq!(parsed["component"], "turn");
        assert_eq!(parsed["level"], "error");
        let ts = parsed["ts"].as_str().unwrap();
        assert!(ts.contains('T'), "ts must be ISO-8601, got {ts}");
    }

    #[test]
    fn redacts_real_home_after_a_trailing_users_prefix() {
        let prefix = unix_users_marker();
        let mut text = format!("noise {prefix} then {prefix}alice/Documents/secret.rs");
        redact_named_home_prefix(&mut text, &prefix);
        assert!(
            !text.contains("alice"),
            "later real home must still be redacted after a trailing prefix: {text}"
        );
        assert!(text.contains('~'), "redacted path must use tilde: {text}");
    }

    #[test]
    fn try_init_with_unresolvable_dir_does_not_panic() {
        let _guard = serial_test_lock();
        reset_for_test();
        let panicked = std::panic::catch_unwind(|| {
            try_init(Err("app_log_dir unavailable".into()), json!({ "os": "macos" }));
        });
        assert!(
            panicked.is_ok(),
            "an unresolvable log dir must not abort process/boot"
        );
        let dir = tempfile::tempdir().unwrap();
        let session = init(dir.path().to_path_buf(), json!({ "os": "macos" })).unwrap();
        assert!(!session.is_empty());
        reset_for_test();
    }

    #[test]
    fn production_log_dir_resolves_via_tauri_app_log_dir_without_path_literals() {
        let src = production_source();
        assert!(
            src.contains("app_log_dir()"),
            "production logger must resolve the OS log dir through Tauri app_log_dir()"
        );
        assert!(
            src.contains("mode(0o600)"),
            "log files must set 0o600 only at OpenOptions create"
        );
        assert!(
            src.contains(".flush()"),
            "retained writer must flush after writeln"
        );
        assert!(
            !src.contains("set_permissions"),
            "must not chmod on every write"
        );
        for forbidden in [
            "/Users/",
            "/home/",
            "Library/Logs",
            "AppData",
            "C:\\\\Users",
            "com.verboo",
        ] {
            assert!(
                !src.contains(forbidden),
                "production logger must not hardcode path fragment {forbidden}"
            );
        }
    }

    #[test]
    fn provider_accounts_refresh_logs_counts_without_content() {
        let dir = tempfile::tempdir().unwrap();
        let log = DiagnosticLog::open(dir.path()).unwrap();
        log.write_event(json!({
            "level": "info",
            "code": "provider_accounts_refresh",
            "component": "provider",
            "message": "accounts refreshed",
            "correlation_id": "sess-1",
            "context": {
                "account_count": 2,
                "usage_window_counts": [3, 1],
                "origin": "network",
                "degraded": false,
                "display_label": "Codex Secret Corp",
                "account_id": "acct-secret-99",
                "plan_display_name": "Pro Secret Plan",
            },
        }))
        .unwrap();
        let parsed = &read_jsonl(dir.path())[0];
        assert_eq!(parsed["level"], "info");
        assert_eq!(parsed["code"], "provider_accounts_refresh");
        assert_eq!(parsed["context"]["account_count"], 2);
        assert_eq!(parsed["context"]["usage_window_counts"], json!([3, 1]));
        assert_eq!(parsed["context"]["origin"], "network");
        assert_eq!(parsed["context"]["degraded"], false);
        let line = fs::read_to_string(dir.path().join(JSONL_FILE)).unwrap();
        assert!(!line.contains("Codex Secret Corp"), "account label leaked: {line}");
        assert!(!line.contains("acct-secret-99"), "account id leaked: {line}");
        assert!(!line.contains("Pro Secret Plan"), "plan name leaked: {line}");
        assert!(!line.contains("display_label"), "identity key leaked: {line}");
        assert!(!line.contains("account_id"), "identity key leaked: {line}");
    }

    #[test]
    fn session_start_with_resolvable_cli_does_not_write_unknown() {
        let _guard = serial_test_lock();
        reset_for_test();
        let dir = tempfile::tempdir().unwrap();
        init(
            dir.path().to_path_buf(),
            json!({
                "os": "macos",
                "app_version": "0.8.0-beta",
                "cli_version": "0.15.18",
            }),
        )
        .unwrap();
        let parsed = &read_jsonl(dir.path())[0];
        assert_eq!(parsed["code"], "session_start");
        assert_eq!(parsed["context"]["cli_version"], "0.15.18");
        let line = fs::read_to_string(dir.path().join(JSONL_FILE)).unwrap();
        assert!(
            !line.contains("unknown"),
            "resolvable CLI must not be recorded as unknown: {line}"
        );
        reset_for_test();
    }

    #[test]
    fn note_cli_version_completes_session_that_started_unknown() {
        let _guard = serial_test_lock();
        reset_for_test();
        let dir = tempfile::tempdir().unwrap();
        let session = init(
            dir.path().to_path_buf(),
            json!({
                "os": "macos",
                "app_version": "0.8.0-beta",
                "cli_version": "unknown",
            }),
        )
        .unwrap();
        note_cli_version("0.15.18");
        let events = read_jsonl(dir.path());
        let resolved = events
            .iter()
            .find(|event| event["code"] == "session_cli_resolved")
            .expect("session_cli_resolved must be emitted when CLI becomes known");
        assert_eq!(resolved["correlation_id"], session);
        assert_eq!(resolved["context"]["cli_version"], "0.15.18");
        assert_eq!(resolved["level"], "info");
        reset_for_test();
    }

    #[test]
    fn version_change_between_runs_emits_event() {
        let _guard = serial_test_lock();
        reset_for_test();
        let dir = tempfile::tempdir().unwrap();
        init(
            dir.path().to_path_buf(),
            json!({
                "os": "macos",
                "app_version": "0.8.0-beta",
                "cli_version": "0.15.17",
            }),
        )
        .unwrap();
        reset_for_test();
        init(
            dir.path().to_path_buf(),
            json!({
                "os": "macos",
                "app_version": "0.8.1-beta",
                "cli_version": "0.15.18",
            }),
        )
        .unwrap();
        let events = read_jsonl(dir.path());
        let changed = events
            .iter()
            .find(|event| event["code"] == "version_changed")
            .expect("version_changed must be emitted across runs");
        assert_eq!(changed["level"], "info");
        assert_eq!(changed["context"]["previous_app_version"], "0.8.0-beta");
        assert_eq!(changed["context"]["previous_cli_version"], "0.15.17");
        assert_eq!(changed["context"]["app_version"], "0.8.1-beta");
        assert_eq!(changed["context"]["cli_version"], "0.15.18");
        reset_for_test();
    }

    #[test]
    fn unknown_to_resolved_cli_is_not_a_version_change() {
        let _guard = serial_test_lock();
        reset_for_test();
        let dir = tempfile::tempdir().unwrap();
        init(
            dir.path().to_path_buf(),
            json!({
                "os": "macos",
                "app_version": "0.8.0-beta",
                "cli_version": "unknown",
            }),
        )
        .unwrap();
        reset_for_test();
        init(
            dir.path().to_path_buf(),
            json!({
                "os": "macos",
                "app_version": "0.8.0-beta",
                "cli_version": "0.15.18",
            }),
        )
        .unwrap();
        let events = read_jsonl(dir.path());
        assert!(
            events.iter().all(|event| event["code"] != "version_changed"),
            "resolving CLI from unknown must not look like a regression: {events:?}"
        );
        reset_for_test();
    }

    #[test]
    fn poisoned_writer_is_reported_by_status() {
        let _guard = serial_test_lock();
        reset_for_test();
        let dir = tempfile::tempdir().unwrap();
        init(dir.path().to_path_buf(), json!({ "os": "macos" })).unwrap();
        let log = global_log().expect("logger");
        let poison = std::thread::spawn({
            let log = Arc::clone(&log);
            move || {
                let _hold = log.jsonl.lock().unwrap();
                panic!("poison diagnostic jsonl");
            }
        })
        .join();
        assert!(poison.is_err(), "thread must poison the mutex");
        emit_state(
            "provider",
            "provider_accounts_refresh",
            json!({ "account_count": 0, "origin": "none" }),
        );
        let reported = status();
        assert!(reported.active, "logger must stay active after poison recovery");
        assert!(
            reported.degraded,
            "poison must be queryable so the UI can warn"
        );
        let expected = dir.path().to_string_lossy().into_owned();
        assert_eq!(reported.dir.as_deref(), Some(expected.as_str()));
        reset_for_test();
    }

    #[test]
    fn try_init_failure_is_reported_as_degraded() {
        let _guard = serial_test_lock();
        reset_for_test();
        try_init(Err("app_log_dir unavailable".into()), json!({ "os": "macos" }));
        let reported = status();
        assert!(!reported.active);
        assert!(
            reported.degraded,
            "init failure must not stay silent to the renderer"
        );
        reset_for_test();
    }

    #[test]
    fn diagnostic_package_redacts_injected_secrets() {
        let _guard = serial_test_lock();
        reset_for_test();
        let dir = tempfile::tempdir().unwrap();
        init(
            dir.path().to_path_buf(),
            json!({
                "os": "macos",
                "arch": "aarch64",
                "app_version": "0.8.0-beta",
                "cli_version": "0.15.18",
            }),
        )
        .unwrap();
        let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.secret-sig";
        let mut jsonl = OpenOptions::new()
            .append(true)
            .open(dir.path().join(JSONL_FILE))
            .unwrap();
        writeln!(
            jsonl,
            r#"{{"level":"error","code":"leak","message":"vbk_liveSecret99 Bearer super-secret-bearer jwt={jwt}"}}"#
        )
        .unwrap();
        drop(jsonl);
        let package = diagnostic_package(80).expect("package");
        assert!(
            !package.contains("vbk_liveSecret99"),
            "vbk_ secret leaked: {package}"
        );
        assert!(
            !package.contains("super-secret-bearer"),
            "Bearer secret leaked: {package}"
        );
        assert!(
            !package.contains("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"),
            "JWT leaked: {package}"
        );
        assert!(package.contains("0.8.0-beta"), "package must include app_version");
        assert!(package.contains("0.15.18"), "package must include cli_version");
        reset_for_test();
    }
}
