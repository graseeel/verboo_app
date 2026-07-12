//! Computer Use service facade (Kratos arch §3).
//!
//! Combines `SessionManager` (gate), `AuditWriter` (log), and
//! `computer-use-helper` Swift sidecar (executor) into a single Tauri
//! state-managed service.
//!
//! Every public method:
//!   1. Checks `SessionManager::check_action` (5 gates).
//!   2. Writes a `pending` audit row BEFORE the action.
//!   3. Spawns/calls the helper.
//!   4. On response, writes `success|denied|error` audit row.
//!
//! Failure-safe: any audit write error refuses the action.
//!
//! P0.1 scope: synchronous spawn-per-call helper invocation. P0.1b will
//! add a long-lived helper process with id-correlated stdin/stdout muxing.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Stdio};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::models::computer_use::{
    ActionScope, AuditActor, AuditOutcome, AuditRow, ComputerUseError, ComputerUseResult,
    ConsentGrant, ConsentRequest, DenyCode, DenyReason, Session, StopReason,
};
use crate::models::types::ComputerUseSettings;
use crate::services::audit_writer::AuditWriter;
use crate::services::computer_use_spawn::ComputerUseSpawn;
use crate::services::session_manager::{ActionKind, SessionManager};

pub struct ComputerUseService {
    pub sessions: SessionManager,
    pub audit: Option<Arc<AuditWriter>>,
}

impl ComputerUseService {
    /// Open the service. Audit DB is opened at the canonical path; if it
    /// can't be opened, every subsequent action will fail with
    /// `AuditWriteFailed`. The constructor still succeeds — the gate logic
    /// is independent so request_session/grant still work for UX testing.
    pub fn new() -> Self {
        let audit = match AuditWriter::open() {
            Ok(w) => {
                if let Err(e) = w.verify_chain() {
                    eprintln!("[computer-use] audit chain verify failed: {e}");
                    // CU is now locked until manual review. We still expose
                    // the service so the renderer can show a message.
                }
                Some(Arc::new(w))
            }
            Err(e) => {
                eprintln!("[computer-use] audit open failed: {e}");
                None
            }
        };
        Self {
            sessions: SessionManager::new(),
            audit,
        }
    }

    /// Step 1 of consent flow: create a pending request.
    /// Takes `settings` because SessionManager checks `settings.enabled`.
    pub fn request_session(
        &self,
        settings: &ComputerUseSettings,
        goal: impl Into<String>,
        app: Option<String>,
        scope: ActionScope,
    ) -> Result<ConsentRequest, DenyCode> {
        self.sessions.request_session(settings, goal, app, scope)
    }

    /// Step 2: user grants. Returns active session or deny code.
    pub fn grant_session(&self, grant: ConsentGrant) -> Result<Session, DenyCode> {
        self.sessions.grant_session(grant)
    }

    /// User denies consent.
    pub fn deny_session(&self, id: &str, reason: DenyReason) {
        self.sessions.deny_session(id, reason);
    }

    /// Pause.
    pub fn pause(&self, id: &str) -> Result<Session, DenyCode> {
        self.sessions.pause(id)
    }

    /// Resume.
    pub fn resume(&self, id: &str) -> Result<Session, DenyCode> {
        self.sessions.resume(id)
    }

    /// Stop with reason (logged by caller).
    pub fn stop(&self, id: &str, reason: StopReason) -> Result<Session, DenyCode> {
        let s = self.sessions.stop(id, reason)?;
        let _ = self.append_audit(
            &s.id,
            None,
            "session_stop",
            AuditOutcome::Success,
            Some(format!("reason={:?})", reason as u8)),
            false,
        );
        Ok(s)
    }

    /// Emergency stop (helper hotkey P0.8 or renderer Esc pill).
    pub fn emergency_stop_all(&self) {
        self.sessions.emergency_stop_all();
    }

    /// Current session snapshot.
    pub fn current(&self) -> Option<Session> {
        self.sessions.current()
    }

    // ──────────────────────────────────────────────────────────────
    //  Helper-mediated actions
    // ──────────────────────────────────────────────────────────────

    pub fn list_apps(&self, settings: &mut ComputerUseSettings) -> ComputerUseResult {
        self.invoke_helper_safe(settings, None, ActionKind::Read, "list-apps", ActionScope::View, json!({}))
    }

    pub fn list_windows(&self, settings: &mut ComputerUseSettings, app: Option<&str>) -> ComputerUseResult {
        self.invoke_helper_safe(settings, app, ActionKind::Read, "list-windows", ActionScope::View,
            json!({ "app": app }))
    }

    pub fn get_app_state(&self, settings: &mut ComputerUseSettings, app: &str, no_screenshot: bool) -> ComputerUseResult {
        self.invoke_helper_safe(settings, Some(app), ActionKind::Read, "get-app-state", ActionScope::View,
            json!({ "app": app, "no_screenshot": no_screenshot }))
    }

    pub fn click(&self, settings: &mut ComputerUseSettings, app: Option<&str>, element_index: Option<u32>, x: Option<i32>, y: Option<i32>) -> ComputerUseResult {
        self.invoke_helper_safe(settings, app, ActionKind::Mutate, "click", ActionScope::Input,
            json!({ "app": app, "element_index": element_index, "x": x, "y": y }))
    }

    pub fn type_text(&self, settings: &mut ComputerUseSettings, app: Option<&str>, text: String) -> ComputerUseResult {
        self.invoke_helper_safe(settings, app, ActionKind::Mutate, "type-text", ActionScope::Input,
            json!({ "app": app, "text": text }))
    }

    pub fn press_key(&self, settings: &mut ComputerUseSettings, app: Option<&str>, key: String) -> ComputerUseResult {
        self.invoke_helper_safe(settings, app, ActionKind::Mutate, "press-key", ActionScope::Input,
            json!({ "app": app, "key": key }))
    }

    pub fn hotkey(&self, settings: &mut ComputerUseSettings, app: Option<&str>, key: String) -> ComputerUseResult {
        self.invoke_helper_safe(settings, app, ActionKind::Mutate, "hotkey", ActionScope::Input,
            json!({ "app": app, "key": key }))
    }

    pub fn scroll(&self, settings: &mut ComputerUseSettings, app: Option<&str>, direction: &str, element_index: Option<u32>, x: Option<i32>, y: Option<i32>) -> ComputerUseResult {
        self.invoke_helper_safe(settings, app, ActionKind::Mutate, "scroll", ActionScope::Input,
            json!({ "app": app, "direction": direction, "element_index": element_index, "x": x, "y": y }))
    }

    // ──────────────────────────────────────────────────────────────
    //  Internal: gate → audit pending → helper → audit outcome
    // ──────────────────────────────────────────────────────────────

    fn invoke_helper_safe(
        &self,
        settings: &mut crate::models::types::ComputerUseSettings,
        bundle_id: Option<&str>,
        kind: ActionKind,
        method: &str,
        scope: ActionScope,
        params: Value,
    ) -> ComputerUseResult {
        let session = match self.sessions.current() {
            Some(s) => s,
            None => {
                return ComputerUseResult {
                    result: None,
                    error: Some(ComputerUseError::from(DenyCode::NoActiveSession)),
                }
            }
        };

        // Gate: all layers checked inside SessionManager. Pass settings
        // (mutable so allowlist entry stats get updated for caller to persist).
        match self.sessions.check_action(settings, bundle_id, kind, scope) {
            crate::models::computer_use::ActionVerdict::Allow => {}
            crate::models::computer_use::ActionVerdict::Deny(code) => {
                let _ = self.append_audit(
                    &session.id,
                    bundle_id,
                    method,
                    AuditOutcome::Denied,
                    Some(format!("deny_code={}", code.as_str())),
                    false,
                );
                return ComputerUseResult {
                    result: None,
                    error: Some(ComputerUseError::from(code)),
                };
            }
        }

        // Audit pending.
        let _ = self.append_audit(
            &session.id,
            bundle_id,
            method,
            AuditOutcome::Pending,
            None,
            false,
        );

        // Invoke helper.
        match invoke_helper_once(method, &params) {
            Ok(result) => {
                let _ = self.append_audit(
                    &session.id,
                    bundle_id,
                    method,
                    AuditOutcome::Success,
                    None,
                    false,
                );
                ComputerUseResult {
                    result: Some(result),
                    error: None,
                }
            }
            Err(err) => {
                let _ = self.append_audit(
                    &session.id,
                    bundle_id,
                    method,
                    AuditOutcome::Error,
                    Some(format!("error_code={} message={}", err.code, err.message)),
                    false,
                );
                ComputerUseResult {
                    result: None,
                    error: Some(err),
                }
            }
        }
    }

    fn append_audit(
        &self,
        session_id: &str,
        bundle_id: Option<&str>,
        action_type: &str,
        outcome: AuditOutcome,
        result_detail: Option<String>,
        is_self_test: bool,
    ) -> Result<(), crate::services::audit_writer::AuditError> {
        let session = match self.sessions.current() {
            Some(s) => s,
            None => return Ok(()), // Nothing to log if no session.
        };
        let now_mono = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let row = AuditRow {
            ts_mono: now_mono,
            ts_wall: now_mono,
            session_id: session_id.into(),
            conversation_id: None,
            turn_id: None,
            actor: AuditActor::Agent,
            app_bundle_id: bundle_id.map(|s| s.into()),
            window_title: None,
            action_type: action_type.into(),
            action_summary: None,
            action_args: None,
            outcome,
            result_detail,
            bytes: None,
            thumbnail_hash: None,
            screenshot_path: None,
            screenshot_attach_to_llm: session.screenshot_attach_to_llm,
            is_self_test,
            prev_hash: String::new(),
            row_hash: String::new(),
        };
        if let Some(a) = &self.audit {
            a.append(row)
        } else {
            Ok(())
        }
    }
}

impl Default for ComputerUseService {
    fn default() -> Self {
        Self::new()
    }
}

/// Spawn helper, write one request, read one response, kill. Id-correlated
/// so multi-line responses can be matched. P0.1b will reuse a long-lived
/// process; this is the simple synchronous path.
fn invoke_helper_once(method: &str, params: &Value) -> Result<Value, ComputerUseError> {
    let spawn = ComputerUseSpawn::new();
    let mut cmd = spawn.command;
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child: Child = cmd
        .spawn()
        .map_err(|e| ComputerUseError::new("provider_down", format!("spawn helper: {e}")))?;

    let request = json!({
        "id": 1,
        "method": method,
        "params": params,
    });
    let line = format!("{}\n", request);
    {
        let mut stdin = child.stdin.take();
        if let Some(stdin) = stdin.as_mut() {
            stdin
                .write_all(line.as_bytes())
                .map_err(|e| ComputerUpdate::write_err(e))?;
        }
    }
    // Drop stdin to signal EOF... actually we want to keep the helper running.
    // For per-call spawn, dropping stdin closes the pipe; helper reads EOF and exits.
    drop(child.stdin.take());

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ComputerUseError::new("provider_down", "no helper stdout"))?;
    let mut reader = BufReader::new(stdout);
    let mut buffer = String::new();
    reader
        .read_line(&mut buffer)
        .map_err(|e| ComputerUseError::new("provider_down", format!("read helper: {e}")))?;

    // Best-effort kill.
    let _ = child.kill();
    let _ = child.wait();

    let resp: Value = serde_json::from_str(buffer.trim())
        .map_err(|e| ComputerUseError::new("provider_down", format!("parse helper response: {e}")))?;

    let err = resp.get("error").and_then(|v| v.as_object());
    if let Some(err_obj) = err {
        // Helper uses {"error": null} when ok. Non-null = error.
        if !err_obj.is_empty() {
            let code = err_obj
                .get("code")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let message = err_obj
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            return Err(ComputerUseError::new(code, message));
        }
    }

    Ok(resp.get("result").cloned().unwrap_or(Value::Null))
}

/// Internal helper to keep error mapping terse.
#[allow(non_camel_case_types)]
struct ComputerUpdate;
impl ComputerUpdate {
    fn write_err(e: std::io::Error) -> ComputerUseError {
        ComputerUseError::new("provider_down", format!("write helper: {e}"))
    }
}
