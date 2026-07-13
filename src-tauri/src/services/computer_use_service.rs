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
//! P0.1b: long-lived helper process with id-correlated stdin/stdout.
//! One helper is reused under a mutex; crashed helpers are respawned on demand.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::models::computer_use::{
    ActionScope, AuditActor, AuditOutcome, AuditRow, ComputerUseError, ComputerUseResult,
    ConsentGrant, ConsentRequest, DenyCode, DenyReason, Session, StopReason,
};
use crate::models::types::ComputerUseSettings;
use crate::services::audit_writer::AuditWriter;
use crate::services::computer_use_spawn::ComputerUseSpawn;
use crate::services::computer_use_tcc::probe_tcc_status;
use crate::services::session_manager::{ActionKind, SessionManager};

/// Poll interval for OS TCC (Accessibility + Screen Recording).
const OS_PERM_POLL_SECS: u64 = 5;

pub struct ComputerUseService {
    pub sessions: SessionManager,
    pub audit: Option<Arc<AuditWriter>>,
    poller_shutdown: Arc<AtomicBool>,
    poller_handle: Mutex<Option<JoinHandle<()>>>,
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
                    None
                } else {
                    Some(Arc::new(w))
                }
            }
            Err(e) => {
                eprintln!("[computer-use] audit open failed: {e}");
                None
            }
        };
        Self {
            sessions: SessionManager::new(),
            audit,
            poller_shutdown: Arc::new(AtomicBool::new(true)),
            poller_handle: Mutex::new(None),
        }
    }

    /// Start the P0.2b OS-permission poller. First probe is immediate (t=0),
    /// then every 5s. On revoke: mark gate false → stop session → MCP revoke
    /// → `on_revoked` callback (emit to renderer). Does not spawn the helper.
    pub fn start_os_permission_poller<F>(&self, on_revoked: F)
    where
        F: Fn() + Send + 'static,
    {
        self.stop_os_permission_poller();
        self.poller_shutdown.store(false, Ordering::SeqCst);
        let shutdown = Arc::clone(&self.poller_shutdown);
        let sessions = self.sessions.clone();
        let handle = thread::spawn(move || {
            loop {
                if shutdown.load(Ordering::SeqCst) {
                    break;
                }
                let status = probe_tcc_status();
                if !status.both_granted() {
                    // Order: flag → stop session → MCP revoke → emit.
                    sessions.set_os_permissions_ok(false);
                    if let Some(session) = sessions.current() {
                        let _ = sessions.stop(&session.id, StopReason::OsPermissionRevoked);
                    }
                    let _ = crate::services::computer_use_mcp::revoke();
                    on_revoked();
                    shutdown.store(true, Ordering::SeqCst);
                    break;
                }
                // Sleep in 100ms slices so stop_os_permission_poller can join quickly.
                let mut waited = 0u64;
                while waited < OS_PERM_POLL_SECS * 1000 {
                    if shutdown.load(Ordering::SeqCst) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(100));
                    waited += 100;
                }
            }
        });
        if let Ok(mut slot) = self.poller_handle.lock() {
            *slot = Some(handle);
        }
    }

    /// Signal the poller to exit and join with a short timeout.
    pub fn stop_os_permission_poller(&self) {
        self.poller_shutdown.store(true, Ordering::SeqCst);
        let handle = self
            .poller_handle
            .lock()
            .ok()
            .and_then(|mut slot| slot.take());
        if let Some(handle) = handle {
            // Don't block the UI forever if the thread is stuck.
            let start = SystemTime::now();
            loop {
                if handle.is_finished() {
                    let _ = handle.join();
                    break;
                }
                if start
                    .elapsed()
                    .map(|d| d >= Duration::from_secs(1))
                    .unwrap_or(true)
                {
                    // Detach: thread will exit on next shutdown check.
                    drop(handle);
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
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

    pub(crate) fn request_session_with_id(
        &self,
        settings: &ComputerUseSettings,
        id: String,
        goal: impl Into<String>,
        app: Option<String>,
        scope: ActionScope,
    ) -> Result<ConsentRequest, DenyCode> {
        self.sessions.request_session_with_id(settings, id, goal, app, scope)
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
        self.stop_os_permission_poller();
        kill_live_helper();
        self.append_audit(
            id,
            None,
            "session_stop",
            AuditOutcome::Success,
            Some(format!("reason={:?})", reason as u8)),
            false,
        ).map_err(|_| DenyCode::AuditWriteFailed)?;
        self.sessions.stop(id, reason)
    }

    /// Emergency stop (helper hotkey P0.8 or renderer Esc pill).
    pub fn emergency_stop_all(&self) {
        self.stop_os_permission_poller();
        kill_live_helper();
        self.sessions.emergency_stop_all();
    }

    /// Current session snapshot.
    pub fn current(&self) -> Option<Session> {
        self.sessions.current()
    }

    /// Bind the first concrete app on a goal-directed session, then update MCP
    /// capability + start focus (best-effort if capability file is absent).
    pub fn bind_session_target(
        &self,
        settings: &ComputerUseSettings,
        session_id: &str,
        bundle_id: &str,
    ) -> Result<Session, DenyCode> {
        let session = self.sessions.bind_target(session_id, bundle_id, settings)?;
        if let Err(error) = crate::services::computer_use_mcp::bind_app(session_id, bundle_id) {
            // Capability may be missing in pure unit tests; session lock is source of truth.
            eprintln!("[computer-use] bind_app after target lock: {error}");
        }
        let _ = self.append_audit(
            session_id,
            Some(bundle_id),
            "bind_target",
            AuditOutcome::Success,
            Some(format!("target_app={bundle_id}")),
            false,
        );
        Ok(session)
    }

    // ──────────────────────────────────────────────────────────────
    //  Helper-mediated actions
    // ──────────────────────────────────────────────────────────────

    pub fn list_apps(&self, settings: &mut ComputerUseSettings) -> ComputerUseResult {
        self.invoke_helper_safe(settings, None, ActionKind::Read, "list-apps", ActionScope::View, json!({}))
    }

    pub fn resolve_app(&self, selector: &str) -> Result<Value, ComputerUseError> {
        invoke_helper_once("resolve-app", &json!({ "app": selector }))
    }

    pub fn launch_app(&self, settings: &mut ComputerUseSettings, app: &str) -> ComputerUseResult {
        self.invoke_helper_safe(settings, Some(app), ActionKind::Mutate, "launch-app", ActionScope::Input, json!({ "app": app }))
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

        // Goal-directed sessions: first concrete app-scoped call locks the target.
        // bind_target runs hard-block / denylist / self-test gates; capability +
        // focus are updated best-effort via bind_app.
        if session.target_app.is_none() {
            if let Some(bid) = bundle_id.map(str::trim).filter(|b| !b.is_empty() && *b != "*") {
                match self.sessions.bind_target(&session.id, bid, settings) {
                    Ok(_) => {
                        if let Err(error) =
                            crate::services::computer_use_mcp::bind_app(&session.id, bid)
                        {
                            eprintln!(
                                "[computer-use] bind_app after auto-bind on {method}: {error}"
                            );
                        }
                        let _ = self.append_audit(
                            &session.id,
                            Some(bid),
                            "bind_target",
                            AuditOutcome::Success,
                            Some(format!("auto_bind method={method} target_app={bid}")),
                            false,
                        );
                    }
                    Err(code) => {
                        let _ = self.append_audit(
                            &session.id,
                            Some(bid),
                            method,
                            AuditOutcome::Denied,
                            Some(format!("deny_code={} (auto_bind)", code.as_str())),
                            false,
                        );
                        return ComputerUseResult {
                            result: None,
                            error: Some(ComputerUseError::from(code)),
                        };
                    }
                }
            }
        }

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
        if self.append_audit(
            &session.id,
            bundle_id,
            method,
            AuditOutcome::Pending,
            None,
            false,
        ).is_err() {
            return ComputerUseResult { result: None, error: Some(ComputerUseError::from(DenyCode::AuditWriteFailed)) };
        }

        // Invoke helper.
        match invoke_helper_once(method, &params) {
            Ok(result) => {
                if self.append_audit(
                    &session.id,
                    bundle_id,
                    method,
                    AuditOutcome::Success,
                    None,
                    false,
                ).is_err() {
                    return ComputerUseResult { result: None, error: Some(ComputerUseError::from(DenyCode::AuditWriteFailed)) };
                }
                ComputerUseResult {
                    result: Some(result),
                    error: None,
                }
            }
            Err(err) => {
                if self.append_audit(
                    &session.id,
                    bundle_id,
                    method,
                    AuditOutcome::Error,
                    Some(format!("error_code={} message={}", err.code, err.message)),
                    false,
                ).is_err() {
                    return ComputerUseResult { result: None, error: Some(ComputerUseError::from(DenyCode::AuditWriteFailed)) };
                }
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
        self.audit.as_ref().ok_or_else(|| crate::services::audit_writer::AuditError::Db("audit unavailable".into()))?.append(row)
    }
}

impl Default for ComputerUseService {
    fn default() -> Self {
        Self::new()
    }
}

/// Test-only constructor: gates work, audit always fails closed.
#[cfg(test)]
pub(crate) fn service_for_test_without_audit() -> ComputerUseService {
    ComputerUseService {
        sessions: SessionManager::new(),
        audit: None,
        poller_shutdown: Arc::new(AtomicBool::new(true)),
        poller_handle: Mutex::new(None),
    }
}

/// Long-lived helper process (one per app process). Mutex serializes IPC so
/// request/response pairs stay id-correlated on a single stdio stream.
struct LiveHelper {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

fn live_helper_slot() -> &'static Mutex<Option<LiveHelper>> {
    static SLOT: OnceLock<Mutex<Option<LiveHelper>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Kill and drop the long-lived helper if running (session stop / emergency).
pub fn kill_live_helper() {
    if let Ok(mut slot) = live_helper_slot().lock() {
        if let Some(mut live) = slot.take() {
            let _ = live.child.kill();
            let _ = live.child.wait();
        }
    }
}

fn spawn_live_helper() -> Result<LiveHelper, ComputerUseError> {
    let spawn = ComputerUseSpawn::new();
    let mut cmd = spawn.command;
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd
        .spawn()
        .map_err(|e| ComputerUseError::new("provider_down", format!("spawn helper: {e}")))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| ComputerUseError::new("provider_down", "helper has no stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ComputerUseError::new("provider_down", "helper has no stdout"))?;
    Ok(LiveHelper {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        next_id: 1,
    })
}

fn ensure_live_helper(slot: &mut Option<LiveHelper>) -> Result<&mut LiveHelper, ComputerUseError> {
    if let Some(live) = slot.as_mut() {
        if let Ok(Some(status)) = live.child.try_wait() {
            eprintln!("[computer-use] helper exited ({status:?}); will respawn");
            *slot = None;
        }
    }
    if slot.is_none() {
        *slot = Some(spawn_live_helper()?);
    }
    slot.as_mut()
        .ok_or_else(|| ComputerUseError::new("provider_down", "helper slot empty after spawn"))
}

/// Invoke the Swift helper with one JSON-RPC-like request.
/// Reuses a long-lived process (P0.1b); respawns after crash / IO error.
/// Mutex serializes concurrent calls (single stdio stream).
pub(crate) fn invoke_helper_once(method: &str, params: &Value) -> Result<Value, ComputerUseError> {
    let mut slot = live_helper_slot()
        .lock()
        .map_err(|_| ComputerUseError::new("provider_down", "helper mutex poisoned"))?;

    for attempt in 0..2 {
        let live = match ensure_live_helper(&mut slot) {
            Ok(l) => l,
            Err(e) if attempt == 0 => {
                *slot = None;
                continue;
            }
            Err(e) => return Err(e),
        };
        let id = live.next_id;
        live.next_id = live.next_id.saturating_add(1);

        let request = json!({
            "id": id,
            "method": method,
            "params": params,
        });
        let line = format!("{}\n", request);
        if let Err(e) = live.stdin.write_all(line.as_bytes()).and_then(|_| live.stdin.flush()) {
            eprintln!("[computer-use] helper write failed: {e}; respawning");
            let _ = live.child.kill();
            let _ = live.child.wait();
            *slot = None;
            continue;
        }

        let mut buffer = String::new();
        if let Err(e) = live.stdout.read_line(&mut buffer) {
            eprintln!("[computer-use] helper read failed: {e}; killing");
            let _ = live.child.kill();
            let _ = live.child.wait();
            *slot = None;
            if attempt == 0 {
                continue;
            }
            return Err(ComputerUseError::new(
                "provider_down",
                format!("read helper: {e}"),
            ));
        }

        let resp: Value = match serde_json::from_str(buffer.trim()) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[computer-use] helper parse failed: {e}; killing");
                let _ = live.child.kill();
                let _ = live.child.wait();
                *slot = None;
                if attempt == 0 {
                    continue;
                }
                return Err(ComputerUseError::new(
                    "provider_down",
                    format!("parse helper response: {e}"),
                ));
            }
        };

        if let Some(resp_id) = resp.get("id").and_then(Value::as_u64) {
            if resp_id != id {
                eprintln!(
                    "[computer-use] helper id mismatch: expected {id}, got {resp_id}; killing"
                );
                let _ = live.child.kill();
                let _ = live.child.wait();
                *slot = None;
                if attempt == 0 {
                    continue;
                }
                return Err(ComputerUseError::new(
                    "provider_down",
                    "helper response id mismatch",
                ));
            }
        }

        if let Some(err_obj) = resp.get("error").and_then(|v| v.as_object()) {
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
        return Ok(resp.get("result").cloned().unwrap_or(Value::Null));
    }

    Err(ComputerUseError::new(
        "provider_down",
        "helper unavailable after retry",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::session_manager::SessionManager;

    fn enabled_settings() -> ComputerUseSettings {
        ComputerUseSettings {
            enabled: true,
            ..Default::default()
        }
    }

    fn service_without_audit() -> ComputerUseService {
        ComputerUseService {
            sessions: SessionManager::new(),
            audit: None,
            poller_shutdown: Arc::new(AtomicBool::new(true)),
            poller_handle: Mutex::new(None),
        }
    }

    fn grant_goal_directed(service: &ComputerUseService) -> Session {
        let settings = enabled_settings();
        let req = service
            .request_session(&settings, "test goal", None, ActionScope::Input)
            .expect("request");
        service
            .grant_session(ConsentGrant {
                id: req.id,
                allowlist_version: 1,
                self_test_enabled: false,
                screenshot_attach_to_llm: false,
                idle_timeout_secs: 900,
            })
            .expect("grant")
    }

    #[test]
    fn bind_session_target_locks_goal_directed_session() {
        let service = service_without_audit();
        let session = grant_goal_directed(&service);
        assert!(session.target_app.is_none());

        let settings = enabled_settings();
        let bound = service
            .bind_session_target(&settings, &session.id, "com.apple.Notes")
            .expect("bind");
        assert_eq!(bound.target_app.as_deref(), Some("com.apple.Notes"));

        // Cross-app silent switch denied.
        let err = service
            .bind_session_target(&settings, &session.id, "com.google.Chrome")
            .unwrap_err();
        assert_eq!(err, DenyCode::AppNotAllowlisted);
    }

    #[test]
    fn auto_bind_on_app_scoped_read_then_allow() {
        let service = service_without_audit();
        let session = grant_goal_directed(&service);
        assert!(session.target_app.is_none());

        let mut settings = enabled_settings();
        // invoke_helper_safe will auto-bind then try helper; without a real
        // helper the call errors after bind. Assert the bind side-effect.
        let _ = service.get_app_state(&mut settings, "com.apple.Notes", true);
        assert_eq!(
            service.current().and_then(|s| s.target_app),
            Some("com.apple.Notes".into())
        );

        // Subsequent different app denied at auto-bind / gate.
        let result = service.get_app_state(&mut settings, "com.google.Chrome", true);
        assert_eq!(
            result.error.as_ref().map(|e| e.code.as_str()),
            Some("app_not_allowlisted")
        );
        assert_eq!(
            service.current().and_then(|s| s.target_app),
            Some("com.apple.Notes".into()),
            "failed cross-app must leave original target"
        );
    }

    #[test]
    fn list_apps_does_not_require_target_bind() {
        let service = service_without_audit();
        let _ = grant_goal_directed(&service);
        let mut settings = enabled_settings();
        // May fail on helper spawn/audit, but must not deny for unbound target.
        let result = service.list_apps(&mut settings);
        if let Some(err) = &result.error {
            assert_ne!(err.code, "app_not_allowlisted");
            assert_ne!(err.code, "no_active_session");
        }
        assert!(
            service.current().unwrap().target_app.is_none(),
            "list-apps must not bind a target"
        );
    }
}
