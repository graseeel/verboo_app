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
//!   4. On response, writes `success|denied|error` audit row. Canonical MCP
//!      actions defer `success` until a fresh screenshot has been validated.
//!
//! Failure-safe: any audit write error refuses the action.
//!
//! P0.1b: long-lived helper process with id-correlated stdin/stdout.
//! One helper is reused under a mutex; crashed helpers are respawned on demand.

use std::io::{BufRead, BufReader, Write};
use std::process::Stdio;
#[cfg(not(target_os = "macos"))]
use std::process::{Child, ChildStdin, ChildStdout};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "macos")]
use std::os::unix::net::UnixStream;

use serde_json::{json, Value};

use crate::models::computer_use::{
    ActionScope, AuditActor, AuditOutcome, AuditRow, ComputerUseError, ComputerUseResult,
    ComputerUseTurnBinding, ConsentGrant, ConsentRequest, DenyCode, DenyReason, Session,
    StopReason,
};
use crate::models::computer_use_action::{ActionRequest, ComputerAction};
use crate::models::types::ComputerUseSettings;
use crate::services::audit_writer::AuditWriter;
use crate::services::computer_use_engine::VerifiedScreenshot;
use crate::services::computer_use_spawn::ComputerUseSpawn;
use crate::services::computer_use_tcc::{self, TccStatus};
use crate::services::session_manager::{ActionKind, SessionManager};

/// Poll interval for OS TCC (Accessibility + Screen Recording).
const OS_PERM_POLL_SECS: u64 = 5;

pub struct ComputerUseService {
    pub sessions: SessionManager,
    pub audit: Option<Arc<AuditWriter>>,
    poller_shutdown: Arc<AtomicBool>,
    poller_handle: Mutex<Option<JoinHandle<()>>>,
}

/// Internal proof that a helper action was accepted by the OS but has not yet
/// been verified by a fresh visual observation. The fields are deliberately
/// private: only the MCP orchestration seam may complete this audit lifecycle.
#[derive(Debug, Clone)]
pub(crate) struct CanonicalActionAuditTicket {
    session_id: String,
    app_bundle_id: String,
    action_type: String,
}

pub(crate) struct CanonicalActionInvocation {
    pub result: ComputerUseResult,
    pub ticket: Option<CanonicalActionAuditTicket>,
}

#[allow(dead_code)]
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
                } else if let Err(e) = w.sweep_orphan_screenshots() {
                    eprintln!("[computer-use] audit screenshot recovery failed: {e}");
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
    /// then every 5s. Both the desktop process and the actual sidecar identity
    /// are checked. On revoke: mark gate false → revoke capability → stop
    /// session → `on_revoked` callback (emit to renderer).
    pub fn start_os_permission_poller<F>(&self, on_revoked: F)
    where
        F: Fn(Result<(), String>) + Send + 'static,
    {
        self.stop_os_permission_poller();
        self.poller_shutdown.store(false, Ordering::SeqCst);
        let shutdown = Arc::clone(&self.poller_shutdown);
        let sessions = self.sessions.clone();
        let audit = self.audit.clone();
        let handle = thread::spawn(move || {
            loop {
                if shutdown.load(Ordering::SeqCst) {
                    break;
                }
                let agent_status = invoke_helper_once("permissions", &json!({}))
                    .ok()
                    .and_then(|value| tcc_status_from_helper(&value));
                let controller_status = computer_use_tcc::probe_tcc_status();
                let authority =
                    agent_status.map(|agent| computer_use_tcc::combine(controller_status, agent));
                if !helper_tcc_authority_is_usable(authority) {
                    let session = sessions.current_any();
                    // Close the in-process gate and remove the capability
                    // before reading the final audit trajectory. This prevents
                    // a late action from landing after the handoff snapshot.
                    sessions.set_os_permissions_ok(false);
                    let revoke_result = session
                        .as_ref()
                        .map(|session| {
                            crate::services::computer_use_mcp::revoke_session(&session.id)
                        })
                        .unwrap_or_else(|| {
                            crate::services::computer_use_mcp::revoke().map(|_| true)
                        });
                    let handoff_result = match &revoke_result {
                        Ok(true) => session.as_ref().map_or(Ok(()), |session| {
                            build_trusted_handoff_for_session(
                                audit.as_ref(),
                                session,
                                "os_permission_revoked",
                            )
                            .and_then(|handoff| {
                                crate::services::computer_use_handoff::put_pending(
                                    &session.conversation_id,
                                    &session.id,
                                    handoff,
                                )
                            })
                        }),
                        Ok(false) => Err(
                            "Computer Use authority belonged to another session; handoff omitted."
                                .to_string(),
                        ),
                        Err(error) => Err(format!(
                            "Computer Use authority could not be revoked; handoff omitted: {error}"
                        )),
                    };
                    if let Some(session) = session {
                        let _ = sessions.stop(&session.id, StopReason::OsPermissionRevoked);
                    }
                    if let Err(error) = revoke_result {
                        eprintln!("[computer-use] TCC revocation cleanup failed after authority removal: {error}");
                    }
                    on_revoked(handoff_result);
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
    pub fn signal_os_permission_poller_stop(&self) {
        self.poller_shutdown.store(true, Ordering::SeqCst);
    }

    /// Signal the poller to exit and join with a short timeout.
    pub fn stop_os_permission_poller(&self) {
        self.signal_os_permission_poller_stop();
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
    #[cfg(test)]
    pub fn request_session(
        &self,
        settings: &ComputerUseSettings,
        goal: impl Into<String>,
        app: Option<String>,
        scope: ActionScope,
    ) -> Result<ConsentRequest, DenyCode> {
        self.configure_audit_policy(settings)?;
        self.sessions.request_session(settings, goal, app, scope)
    }

    pub fn request_bound_session(
        &self,
        settings: &ComputerUseSettings,
        goal: impl Into<String>,
        app: Option<String>,
        scope: ActionScope,
        conversation_id: String,
        executor_model_id: String,
    ) -> Result<ConsentRequest, DenyCode> {
        self.configure_audit_policy(settings)?;
        self.sessions.request_bound_session(
            settings,
            goal,
            app,
            scope,
            conversation_id,
            executor_model_id,
        )
    }

    pub(crate) fn request_session_with_id(
        &self,
        settings: &ComputerUseSettings,
        id: String,
        goal: impl Into<String>,
        app: Option<String>,
        scope: ActionScope,
        binding: ComputerUseTurnBinding,
    ) -> Result<ConsentRequest, DenyCode> {
        // The desktop process configured the shared audit DB before publishing
        // this capability. The MCP subprocess must not overwrite the user's
        // retention/cap settings with its bootstrap defaults.
        self.sessions
            .request_session_with_id(settings, id, goal, app, scope, binding)
    }

    fn configure_audit_policy(&self, settings: &ComputerUseSettings) -> Result<(), DenyCode> {
        let audit = self.audit.as_ref().ok_or(DenyCode::AuditWriteFailed)?;
        let storage_cap_bytes =
            u64::from(settings.audit_storage_cap_mb.clamp(10, 10_000)).saturating_mul(1024 * 1024);
        audit
            .configure_policy(
                settings.audit_retention_days.clamp(7, 365),
                storage_cap_bytes,
            )
            .map_err(audit_error_deny_code)?;
        audit
            .ensure_capacity(4 * 1024)
            .map_err(audit_error_deny_code)
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
        let audit_result = self.append_audit(
            id,
            None,
            "session_stop",
            AuditOutcome::Success,
            Some(format!("reason={:?})", reason as u8)),
            false,
        );
        let stopped = self.sessions.stop(id, reason);
        audit_result.map_err(audit_error_deny_code)?;
        stopped
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

    pub fn record_confirmation_decision(
        &self,
        session_id: &str,
        app_bundle_id: &str,
        _summary: &str,
        allow: bool,
    ) -> Result<(), String> {
        let controlled_summary = if allow {
            "User approved one consequential Computer Use action"
        } else {
            "User denied one consequential Computer Use action"
        };
        if let Err(error) = self.append_audit_as(
            session_id,
            Some(app_bundle_id),
            if allow {
                "confirmation_approved"
            } else {
                "confirmation_denied"
            },
            AuditOutcome::Success,
            Some(controlled_summary.to_string()),
            None,
            false,
            AuditActor::User,
        ) {
            let deny = audit_error_deny_code(error);
            let reason = if deny == DenyCode::AuditStorageFull {
                StopReason::AuditStorageFull
            } else {
                StopReason::Error
            };
            let _ = self.sessions.stop(session_id, reason);
            return Err(format!(
                "{}: {}",
                deny.as_str(),
                ComputerUseError::from(deny).message
            ));
        }
        Ok(())
    }

    pub fn build_trusted_handoff(
        &self,
        session_id: &str,
        executor_model_id: &str,
        stopped_reason: &str,
    ) -> Result<crate::services::computer_use_handoff::ComputerUseHandoff, String> {
        let session = self
            .sessions
            .current_any()
            .filter(|session| session.id == session_id)
            .ok_or("computer-use session is no longer available for handoff")?;
        if executor_model_id != session.executor_model_id {
            return Err(
                "computer-use handoff executor does not match the authorized session".into(),
            );
        }
        build_trusted_handoff_for_session(self.audit.as_ref(), &session, stopped_reason)
    }

    pub fn persist_trusted_handoff(
        &self,
        session_id: &str,
        stopped_reason: &str,
    ) -> Result<crate::services::computer_use_handoff::ComputerUseHandoff, String> {
        let session = self
            .sessions
            .current_any()
            .filter(|session| session.id == session_id)
            .ok_or("computer-use session is no longer available for handoff")?;
        let handoff =
            build_trusted_handoff_for_session(self.audit.as_ref(), &session, stopped_reason)?;
        crate::services::computer_use_handoff::put_pending(
            &session.conversation_id,
            &session.id,
            handoff.clone(),
        )?;
        Ok(handoff)
    }

    // ──────────────────────────────────────────────────────────────
    //  Helper-mediated actions
    // ──────────────────────────────────────────────────────────────

    pub fn list_apps(&self, settings: &mut ComputerUseSettings) -> ComputerUseResult {
        self.invoke_helper_safe(
            settings,
            None,
            ActionKind::Read,
            "list-apps",
            ActionScope::View,
            json!({}),
        )
    }

    pub fn resolve_app(&self, selector: &str) -> Result<Value, ComputerUseError> {
        invoke_helper_once("resolve-app", &json!({ "app": selector }))
    }

    pub fn launch_app(&self, settings: &mut ComputerUseSettings, app: &str) -> ComputerUseResult {
        self.invoke_helper_safe(
            settings,
            Some(app),
            ActionKind::Mutate,
            "launch-app",
            ActionScope::Input,
            json!({ "app": app }),
        )
    }

    pub fn list_windows(
        &self,
        settings: &mut ComputerUseSettings,
        app: Option<&str>,
    ) -> ComputerUseResult {
        self.invoke_helper_safe(
            settings,
            app,
            ActionKind::Read,
            "list-windows",
            ActionScope::View,
            json!({ "app": app }),
        )
    }

    pub fn get_app_state(
        &self,
        settings: &mut ComputerUseSettings,
        app: &str,
        no_screenshot: bool,
    ) -> ComputerUseResult {
        self.invoke_helper_safe(
            settings,
            Some(app),
            ActionKind::Read,
            "get-app-state",
            ActionScope::View,
            json!({ "app": app, "no_screenshot": no_screenshot }),
        )
    }

    pub fn inspect_pointer(
        &self,
        settings: &mut ComputerUseSettings,
        app: &str,
        params: Value,
    ) -> ComputerUseResult {
        self.invoke_helper_safe(
            settings,
            Some(app),
            ActionKind::Read,
            "inspect-pointer",
            ActionScope::View,
            params,
        )
    }

    pub fn inspect_keyboard_target(
        &self,
        settings: &mut ComputerUseSettings,
        app: &str,
        params: Value,
    ) -> ComputerUseResult {
        self.invoke_helper_safe(
            settings,
            Some(app),
            ActionKind::Read,
            "inspect-keyboard-target",
            ActionScope::View,
            params,
        )
    }

    pub fn click(
        &self,
        settings: &mut ComputerUseSettings,
        app: Option<&str>,
        element_index: Option<u32>,
        x: Option<i32>,
        y: Option<i32>,
    ) -> ComputerUseResult {
        self.invoke_helper_safe(
            settings,
            app,
            ActionKind::Mutate,
            "click",
            ActionScope::Input,
            json!({ "app": app, "element_index": element_index, "x": x, "y": y }),
        )
    }

    pub fn type_text(
        &self,
        settings: &mut ComputerUseSettings,
        app: Option<&str>,
        text: String,
    ) -> ComputerUseResult {
        self.invoke_helper_safe(
            settings,
            app,
            ActionKind::Mutate,
            "type-text",
            ActionScope::Input,
            json!({ "app": app, "text": text }),
        )
    }

    pub fn press_key(
        &self,
        settings: &mut ComputerUseSettings,
        app: Option<&str>,
        key: String,
    ) -> ComputerUseResult {
        self.invoke_helper_safe(
            settings,
            app,
            ActionKind::Mutate,
            "press-key",
            ActionScope::Input,
            json!({ "app": app, "key": key }),
        )
    }

    pub fn hotkey(
        &self,
        settings: &mut ComputerUseSettings,
        app: Option<&str>,
        key: String,
    ) -> ComputerUseResult {
        self.invoke_helper_safe(
            settings,
            app,
            ActionKind::Mutate,
            "hotkey",
            ActionScope::Input,
            json!({ "app": app, "key": key }),
        )
    }

    pub fn scroll(
        &self,
        settings: &mut ComputerUseSettings,
        app: Option<&str>,
        direction: &str,
        element_index: Option<u32>,
        x: Option<i32>,
        y: Option<i32>,
    ) -> ComputerUseResult {
        self.invoke_helper_safe(settings, app, ActionKind::Mutate, "scroll", ActionScope::Input,
            json!({ "app": app, "direction": direction, "element_index": element_index, "x": x, "y": y }))
    }

    pub fn invoke_canonical_action(
        &self,
        settings: &mut ComputerUseSettings,
        app: &str,
        request: &ActionRequest,
        helper_method: &str,
        helper_params: Value,
    ) -> CanonicalActionInvocation {
        let (kind, scope) = match request.action {
            ComputerAction::Screenshot | ComputerAction::Zoom | ComputerAction::Wait => {
                (ActionKind::Read, ActionScope::View)
            }
            ComputerAction::Type | ComputerAction::Key | ComputerAction::HoldKey => {
                (ActionKind::Mutate, ActionScope::Full)
            }
            _ => (ActionKind::Mutate, ActionScope::Input),
        };
        self.invoke_helper_with_completion(
            settings,
            Some(app),
            kind,
            helper_method,
            scope,
            helper_params,
            true,
        )
    }

    /// Capture the post-action observation through the same deferred audit
    /// lifecycle as effectful canonical actions. A syntactically valid helper
    /// response alone is not a successful screenshot; the engine must accept
    /// its PNG and target identity before finalization.
    pub(crate) fn capture_canonical_screenshot(
        &self,
        settings: &mut ComputerUseSettings,
        app: &str,
    ) -> CanonicalActionInvocation {
        self.invoke_helper_with_completion(
            settings,
            Some(app),
            ActionKind::Read,
            "get-app-state",
            ActionScope::View,
            json!({ "app": app, "no_screenshot": false }),
            true,
        )
    }

    pub(crate) fn finalize_canonical_action(
        &self,
        ticket: CanonicalActionAuditTicket,
        screenshot: Option<&VerifiedScreenshot>,
    ) -> Result<(), ComputerUseError> {
        self.complete_canonical_action(
            ticket,
            AuditOutcome::Success,
            screenshot.map(|screenshot| {
                format!(
                    "fresh_observation_validated screenshot_id={}",
                    sanitize_audit_detail(screenshot.screenshot_id())
                )
            }),
            screenshot,
        )
    }

    pub(crate) fn mark_canonical_action_uncertain(
        &self,
        ticket: CanonicalActionAuditTicket,
        reason: &str,
    ) -> Result<(), ComputerUseError> {
        self.complete_canonical_action(
            ticket,
            AuditOutcome::Error,
            Some(format!(
                "effect_uncertain reason={}",
                sanitize_audit_detail(reason)
            )),
            None,
        )
    }

    fn complete_canonical_action(
        &self,
        ticket: CanonicalActionAuditTicket,
        outcome: AuditOutcome,
        detail: Option<String>,
        screenshot: Option<&VerifiedScreenshot>,
    ) -> Result<(), ComputerUseError> {
        let current_matches = self
            .sessions
            .current()
            .is_some_and(|session| session.id == ticket.session_id);
        if !current_matches {
            return Err(ComputerUseError::new(
                "effect_uncertain",
                "Computer Use session changed before the action could be visually verified.",
            ));
        }
        match self.append_audit_with_screenshot(
            &ticket.session_id,
            Some(&ticket.app_bundle_id),
            &ticket.action_type,
            outcome,
            detail,
            false,
            screenshot,
        ) {
            Ok(()) => Ok(()),
            Err(error) => {
                let deny = audit_error_deny_code(error);
                let reason = if deny == DenyCode::AuditStorageFull {
                    StopReason::AuditStorageFull
                } else {
                    StopReason::Error
                };
                let _ = self.sessions.stop(&ticket.session_id, reason);
                Err(ComputerUseError::from(deny))
            }
        }
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
        self.invoke_helper_with_completion(settings, bundle_id, kind, method, scope, params, false)
            .result
    }

    #[allow(clippy::too_many_arguments)]
    fn invoke_helper_with_completion(
        &self,
        settings: &mut crate::models::types::ComputerUseSettings,
        bundle_id: Option<&str>,
        kind: ActionKind,
        method: &str,
        scope: ActionScope,
        params: Value,
        defer_success_until_observation: bool,
    ) -> CanonicalActionInvocation {
        let session = match self.sessions.current() {
            Some(s) => s,
            None => {
                return CanonicalActionInvocation {
                    result: ComputerUseResult {
                        result: None,
                        error: Some(ComputerUseError::from(DenyCode::NoActiveSession)),
                    },
                    ticket: None,
                };
            }
        };

        // Gate: all layers checked inside SessionManager. Pass settings
        // (mutable so allowlist entry stats get updated for caller to persist).
        match self.sessions.check_action(settings, bundle_id, kind, scope) {
            crate::models::computer_use::ActionVerdict::Allow => {}
            crate::models::computer_use::ActionVerdict::Deny(code) => {
                if let Err(error) = self.append_audit(
                    &session.id,
                    bundle_id,
                    method,
                    AuditOutcome::Denied,
                    Some(format!("deny_code={}", code.as_str())),
                    false,
                ) {
                    return self.audit_failure_invocation(&session.id, error);
                }
                return CanonicalActionInvocation {
                    result: ComputerUseResult {
                        result: None,
                        error: Some(ComputerUseError::from(code)),
                    },
                    ticket: None,
                };
            }
        }

        // Audit pending.
        if let Err(error) = self.append_audit(
            &session.id,
            bundle_id,
            method,
            AuditOutcome::Pending,
            None,
            false,
        ) {
            return self.audit_failure_invocation(&session.id, error);
        }

        // Invoke helper.
        match invoke_helper_once(method, &params) {
            Ok(result) => {
                let ticket = defer_success_until_observation.then(|| CanonicalActionAuditTicket {
                    session_id: session.id.clone(),
                    app_bundle_id: bundle_id.unwrap_or_default().to_string(),
                    action_type: method.to_string(),
                });
                if !defer_success_until_observation {
                    if let Err(error) = self.append_audit(
                        &session.id,
                        bundle_id,
                        method,
                        AuditOutcome::Success,
                        None,
                        false,
                    ) {
                        return self.audit_failure_invocation(&session.id, error);
                    }
                }
                CanonicalActionInvocation {
                    result: ComputerUseResult {
                        result: Some(result),
                        error: None,
                    },
                    ticket,
                }
            }
            Err(err) => {
                if let Err(error) = self.append_audit(
                    &session.id,
                    bundle_id,
                    method,
                    AuditOutcome::Error,
                    Some(format!("error_code={} message={}", err.code, err.message)),
                    false,
                ) {
                    return self.audit_failure_invocation(&session.id, error);
                }
                CanonicalActionInvocation {
                    result: ComputerUseResult {
                        result: None,
                        error: Some(err),
                    },
                    ticket: None,
                }
            }
        }
    }

    fn audit_failure_invocation(
        &self,
        session_id: &str,
        error: crate::services::audit_writer::AuditError,
    ) -> CanonicalActionInvocation {
        let deny = audit_error_deny_code(error);
        let reason = if deny == DenyCode::AuditStorageFull {
            StopReason::AuditStorageFull
        } else {
            StopReason::Error
        };
        let _ = self.sessions.stop(session_id, reason);
        CanonicalActionInvocation {
            result: ComputerUseResult {
                result: None,
                error: Some(ComputerUseError::from(deny)),
            },
            ticket: None,
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
        self.append_audit_with_screenshot(
            session_id,
            bundle_id,
            action_type,
            outcome,
            result_detail,
            is_self_test,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn append_audit_with_screenshot(
        &self,
        session_id: &str,
        bundle_id: Option<&str>,
        action_type: &str,
        outcome: AuditOutcome,
        result_detail: Option<String>,
        is_self_test: bool,
        screenshot: Option<&VerifiedScreenshot>,
    ) -> Result<(), crate::services::audit_writer::AuditError> {
        self.append_audit_as_with_screenshot(
            session_id,
            bundle_id,
            action_type,
            outcome,
            None,
            result_detail,
            is_self_test,
            AuditActor::Agent,
            screenshot,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn append_audit_as(
        &self,
        session_id: &str,
        bundle_id: Option<&str>,
        action_type: &str,
        outcome: AuditOutcome,
        action_summary: Option<String>,
        result_detail: Option<String>,
        is_self_test: bool,
        actor: AuditActor,
    ) -> Result<(), crate::services::audit_writer::AuditError> {
        self.append_audit_as_with_screenshot(
            session_id,
            bundle_id,
            action_type,
            outcome,
            action_summary,
            result_detail,
            is_self_test,
            actor,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn append_audit_as_with_screenshot(
        &self,
        session_id: &str,
        bundle_id: Option<&str>,
        action_type: &str,
        outcome: AuditOutcome,
        action_summary: Option<String>,
        result_detail: Option<String>,
        is_self_test: bool,
        actor: AuditActor,
        screenshot: Option<&VerifiedScreenshot>,
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
            conversation_id: Some(session.conversation_id.clone()),
            turn_id: None,
            actor,
            app_bundle_id: bundle_id.map(|s| s.into()),
            window_title: None,
            action_type: action_type.into(),
            action_summary,
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
        let audit = self.audit.as_ref().ok_or_else(|| {
            crate::services::audit_writer::AuditError::Db("audit unavailable".into())
        })?;
        match screenshot {
            Some(screenshot) => audit.append_verified_screenshot(
                row,
                screenshot.screenshot_id(),
                screenshot.pruned_screenshot_ids(),
                screenshot.png(),
            ),
            None => audit.append(row),
        }
    }
}

fn tcc_status_from_helper(value: &Value) -> Option<TccStatus> {
    Some(TccStatus {
        accessibility: value.get("accessibility")?.as_str()? == "granted",
        screen_recording: value.get("screenRecording")?.as_str()? == "granted",
    })
}

fn helper_tcc_authority_is_usable(status: Option<TccStatus>) -> bool {
    status.is_some_and(TccStatus::both_granted)
}

fn audit_error_deny_code(error: crate::services::audit_writer::AuditError) -> DenyCode {
    match error {
        crate::services::audit_writer::AuditError::StorageFull { .. } => DenyCode::AuditStorageFull,
        crate::services::audit_writer::AuditError::HashChainBroken { .. } => {
            DenyCode::TamperDetected
        }
        crate::services::audit_writer::AuditError::Db(_) => DenyCode::AuditWriteFailed,
    }
}

fn sanitize_audit_detail(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | ':' | ' ')
        })
        .take(160)
        .collect()
}

fn build_trusted_handoff_for_session(
    audit: Option<&Arc<AuditWriter>>,
    session: &Session,
    stopped_reason: &str,
) -> Result<crate::services::computer_use_handoff::ComputerUseHandoff, String> {
    use crate::services::computer_use_handoff::build_handoff_from_verified_audit;

    let evidence = audit
        .ok_or("computer-use audit is unavailable for handoff")?
        .verified_handoff_evidence_for_session(&session.id, 100)
        .map_err(|error| error.to_string())?;
    let approved_apps = session
        .approved_apps
        .iter()
        .map(|app| app.bundle_id.clone())
        .collect::<Vec<_>>();
    Ok(build_handoff_from_verified_audit(
        &session.goal,
        &session.executor_model_id,
        &approved_apps,
        &evidence,
        stopped_reason,
    ))
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

/// Long-lived helper process (one per app process). On macOS the process is
/// launched as the independent LSUIElement `Verboo Computer Use.app` and IPC
/// runs over a private Unix socket. Other targets retain the stdio fallback so
/// the crate keeps compiling across existing platform boundaries.
struct LiveHelper {
    #[cfg(not(target_os = "macos"))]
    child: Arc<Mutex<Child>>,
    #[cfg(not(target_os = "macos"))]
    stdin: ChildStdin,
    #[cfg(target_os = "macos")]
    stdin: UnixStream,
    #[cfg(not(target_os = "macos"))]
    stdout: BufReader<ChildStdout>,
    #[cfg(target_os = "macos")]
    stdout: BufReader<UnixStream>,
    #[cfg(target_os = "macos")]
    executable_path: std::path::PathBuf,
    next_id: u64,
    pid: u32,
    generation: u64,
    fail_closed_exit: Arc<AtomicBool>,
}

fn live_helper_slot() -> &'static Mutex<Option<LiveHelper>> {
    static SLOT: OnceLock<Mutex<Option<LiveHelper>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn live_helper_pid() -> &'static AtomicU32 {
    static PID: AtomicU32 = AtomicU32::new(0);
    &PID
}

fn live_helper_generation() -> &'static AtomicU64 {
    static GENERATION: AtomicU64 = AtomicU64::new(0);
    &GENERATION
}

fn expected_live_helper_stop_generation() -> &'static AtomicU64 {
    static EXPECTED: AtomicU64 = AtomicU64::new(0);
    &EXPECTED
}

fn mark_live_helper_stop_expected() {
    let generation = live_helper_generation().load(Ordering::SeqCst);
    if generation != 0 {
        expected_live_helper_stop_generation().store(generation, Ordering::SeqCst);
    }
}

/// Ask the helper to cancel its current operation without waiting on the IPC
/// mutex. The helper handles SIGTERM cooperatively and releases held input.
pub fn signal_live_helper_stop() {
    let pid = live_helper_pid().load(Ordering::SeqCst);
    if pid == 0 {
        return;
    }
    mark_live_helper_stop_expected();
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
}

pub fn force_kill_live_helper_process() {
    let pid = live_helper_pid().load(Ordering::SeqCst);
    if pid == 0 {
        return;
    }
    mark_live_helper_stop_expected();
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

/// Kill and drop the long-lived helper if running (session stop / emergency).
pub fn kill_live_helper() {
    signal_live_helper_stop();
    if let Ok(mut slot) = live_helper_slot().lock() {
        if let Some(live) = slot.take() {
            #[cfg(target_os = "macos")]
            terminate_agent_transport(&live);
            #[cfg(not(target_os = "macos"))]
            if let Ok(mut child) = live.child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
            live_helper_pid()
                .compare_exchange(live.pid, 0, Ordering::SeqCst, Ordering::SeqCst)
                .ok();
        }
    }
}

fn report_unexpected_helper_exit(live: &LiveHelper) -> bool {
    if live.fail_closed_exit.load(Ordering::SeqCst) {
        return true;
    }
    if expected_live_helper_stop_generation().load(Ordering::SeqCst) == live.generation {
        return false;
    }
    let fail_closed = route_unexpected_helper_exit(
        &live.fail_closed_exit,
        crate::services::computer_use_mcp::active_action_helper_session_id(),
        |session_id| {
            thread::spawn(move || {
                crate::services::computer_use_mcp::handle_unexpected_action_helper_exit(
                    &session_id,
                );
            });
        },
    );
    if !fail_closed {
        // No Computer Use authority depends on this process. Mark disposal as
        // expected so a later session cannot inherit a delayed crash report.
        expected_live_helper_stop_generation().store(live.generation, Ordering::SeqCst);
    }
    fail_closed
}

fn route_unexpected_helper_exit<F>(
    fail_closed_exit: &AtomicBool,
    active_session_id: Option<String>,
    on_incident: F,
) -> bool
where
    F: FnOnce(String),
{
    if fail_closed_exit.load(Ordering::SeqCst) {
        return true;
    }
    let Some(session_id) = active_session_id else {
        return false;
    };
    if !fail_closed_exit.swap(true, Ordering::SeqCst) {
        on_incident(session_id);
    }
    true
}

#[cfg(not(target_os = "macos"))]
fn start_live_helper_exit_watcher(
    child: Arc<Mutex<Child>>,
    pid: u32,
    generation: u64,
    fail_closed_exit: Arc<AtomicBool>,
) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(20));
        let exited = match child.lock() {
            Ok(mut child) => match child.try_wait() {
                Ok(Some(_)) => true,
                Ok(None) => false,
                Err(error) => {
                    eprintln!("[computer-use] inspect helper process failed: {error}");
                    true
                }
            },
            Err(_) => true,
        };
        if !exited {
            continue;
        }

        live_helper_pid()
            .compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst)
            .ok();
        let expected = expected_live_helper_stop_generation().load(Ordering::SeqCst) == generation;
        if !expected {
            route_unexpected_helper_exit(
                &fail_closed_exit,
                crate::services::computer_use_mcp::active_action_helper_session_id(),
                |session_id| {
                    crate::services::computer_use_mcp::handle_unexpected_action_helper_exit(
                        &session_id,
                    );
                },
            );
        }
        expected_live_helper_stop_generation()
            .compare_exchange(generation, 0, Ordering::SeqCst, Ordering::SeqCst)
            .ok();
        break;
    });
}

#[cfg(target_os = "macos")]
fn start_live_helper_exit_watcher(
    pid: u32,
    executable_path: std::path::PathBuf,
    generation: u64,
    fail_closed_exit: Arc<AtomicBool>,
) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(100));
        if crate::services::computer_use_spawn::agent_process_matches(pid, &executable_path) {
            continue;
        }

        live_helper_pid()
            .compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst)
            .ok();
        let expected = expected_live_helper_stop_generation().load(Ordering::SeqCst) == generation;
        if !expected {
            route_unexpected_helper_exit(
                &fail_closed_exit,
                crate::services::computer_use_mcp::active_action_helper_session_id(),
                |session_id| {
                    crate::services::computer_use_mcp::handle_unexpected_action_helper_exit(
                        &session_id,
                    );
                },
            );
        }
        expected_live_helper_stop_generation()
            .compare_exchange(generation, 0, Ordering::SeqCst, Ordering::SeqCst)
            .ok();
        break;
    });
}

#[cfg(target_os = "macos")]
fn terminate_agent_transport(live: &LiveHelper) {
    use std::net::Shutdown;

    let _ = live.stdin.shutdown(Shutdown::Both);
    unsafe {
        libc::kill(live.pid as libc::pid_t, libc::SIGTERM);
    }
    for _ in 0..50 {
        if !crate::services::computer_use_spawn::agent_process_matches(
            live.pid,
            &live.executable_path,
        ) {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    unsafe {
        libc::kill(live.pid as libc::pid_t, libc::SIGKILL);
    }
}

fn spawn_live_helper() -> Result<LiveHelper, ComputerUseError> {
    #[cfg(target_os = "macos")]
    {
        let connection = crate::services::computer_use_spawn::launch_action_agent()
            .map_err(|error| ComputerUseError::new("provider_down", error))?;
        let stdin = connection.stream.try_clone().map_err(|error| {
            ComputerUseError::new("provider_down", format!("clone agent socket: {error}"))
        })?;
        let pid = connection.pid;
        let generation = live_helper_generation()
            .fetch_add(1, Ordering::SeqCst)
            .saturating_add(1);
        let fail_closed_exit = Arc::new(AtomicBool::new(false));
        live_helper_pid().store(pid, Ordering::SeqCst);
        start_live_helper_exit_watcher(
            pid,
            connection.executable_path.clone(),
            generation,
            Arc::clone(&fail_closed_exit),
        );
        return Ok(LiveHelper {
            stdin,
            stdout: BufReader::new(connection.stream),
            executable_path: connection.executable_path,
            next_id: 1,
            pid,
            generation,
            fail_closed_exit,
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
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
        let pid = child.id();
        let generation = live_helper_generation()
            .fetch_add(1, Ordering::SeqCst)
            .saturating_add(1);
        let child = Arc::new(Mutex::new(child));
        let fail_closed_exit = Arc::new(AtomicBool::new(false));
        live_helper_pid().store(pid, Ordering::SeqCst);
        start_live_helper_exit_watcher(
            Arc::clone(&child),
            pid,
            generation,
            Arc::clone(&fail_closed_exit),
        );
        Ok(LiveHelper {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
            pid,
            generation,
            fail_closed_exit,
        })
    }
}

fn helper_method_is_retryable(method: &str) -> bool {
    matches!(
        method,
        "capabilities"
            | "list-apps"
            | "resolve-app"
            | "list-windows"
            | "get-app-state"
            | "screenshot"
            | "zoom"
            | "inspect-pointer"
            | "inspect-keyboard-target"
            | "permissions"
    )
}

fn helper_transport_may_retry(method: &str, session_active: bool) -> bool {
    helper_method_is_retryable(method) && !session_active
}

fn terminate_failed_live_helper(live: &LiveHelper) -> bool {
    let fail_closed = report_unexpected_helper_exit(live);
    #[cfg(target_os = "macos")]
    terminate_agent_transport(live);
    #[cfg(not(target_os = "macos"))]
    if let Ok(mut child) = live.child.lock() {
        let _ = child.kill();
        let _ = child.wait();
    }
    live_helper_pid()
        .compare_exchange(live.pid, 0, Ordering::SeqCst, Ordering::SeqCst)
        .ok();
    fail_closed
}

fn helper_transport_error(
    method: &str,
    method_retryable: bool,
    fail_closed: bool,
    detail: impl std::fmt::Display,
) -> ComputerUseError {
    if fail_closed {
        ComputerUseError::new(
            "session_revoked",
            "The native action helper failed unexpectedly; Computer Use was stopped.",
        )
    } else if method_retryable {
        ComputerUseError::new(
            "provider_down",
            format!("helper transport failed: {detail}"),
        )
    } else {
        ambiguous_helper_error(method, detail)
    }
}

fn ambiguous_helper_error(method: &str, detail: impl std::fmt::Display) -> ComputerUseError {
    ComputerUseError::new(
        "effect_uncertain",
        format!(
            "The helper connection failed after '{method}' was submitted; the action will not be retried automatically: {detail}"
        ),
    )
}

fn helper_response_id_error(response: &Value, expected_id: u64) -> Option<&'static str> {
    match response.get("id").and_then(Value::as_u64) {
        Some(response_id) if response_id != expected_id => Some("helper response id mismatch"),
        Some(_) => None,
        None => Some("helper response id missing"),
    }
}

fn ensure_live_helper(slot: &mut Option<LiveHelper>) -> Result<&mut LiveHelper, ComputerUseError> {
    if let Some(live) = slot.as_mut() {
        #[cfg(target_os = "macos")]
        let status = if crate::services::computer_use_spawn::agent_process_matches(
            live.pid,
            &live.executable_path,
        ) {
            None
        } else {
            Some("agent exited".to_string())
        };
        #[cfg(not(target_os = "macos"))]
        let status = live
            .child
            .lock()
            .map_err(|_| ComputerUseError::new("provider_down", "helper child lock poisoned"))?
            .try_wait()
            .map_err(|error| {
                ComputerUseError::new("provider_down", format!("inspect helper: {error}"))
            })?;
        if let Some(status) = status {
            let fail_closed = report_unexpected_helper_exit(live);
            eprintln!("[computer-use] helper exited ({status:?})");
            live_helper_pid().store(0, Ordering::SeqCst);
            *slot = None;
            if fail_closed {
                return Err(ComputerUseError::new(
                    "session_revoked",
                    "The native action helper exited unexpectedly; Computer Use was stopped.",
                ));
            }
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

    let method_retryable = helper_method_is_retryable(method);
    let session_active =
        crate::services::computer_use_mcp::active_action_helper_session_id().is_some();
    let retryable = helper_transport_may_retry(method, session_active);
    for attempt in 0..2 {
        let live = match ensure_live_helper(&mut slot) {
            Ok(l) => l,
            Err(error) if attempt == 0 && error.code != "session_revoked" => {
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
        if let Err(e) = live
            .stdin
            .write_all(line.as_bytes())
            .and_then(|_| live.stdin.flush())
        {
            eprintln!("[computer-use] helper write failed: {e}");
            let fail_closed = terminate_failed_live_helper(live);
            *slot = None;
            if retryable && !fail_closed && attempt == 0 {
                continue;
            }
            return Err(helper_transport_error(
                method,
                method_retryable,
                fail_closed,
                e,
            ));
        }

        let mut buffer = String::new();
        let read_result = live.stdout.read_line(&mut buffer);
        if read_result.as_ref().is_err() || read_result.as_ref().is_ok_and(|bytes| *bytes == 0) {
            let detail = read_result
                .err()
                .map(|error| error.to_string())
                .unwrap_or_else(|| "unexpected EOF".into());
            eprintln!("[computer-use] helper read failed: {detail}; killing");
            let fail_closed = terminate_failed_live_helper(live);
            *slot = None;
            if retryable && !fail_closed && attempt == 0 {
                continue;
            }
            return Err(helper_transport_error(
                method,
                method_retryable,
                fail_closed,
                detail,
            ));
        }

        let resp: Value = match serde_json::from_str(buffer.trim()) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[computer-use] helper parse failed: {e}; killing");
                let fail_closed = terminate_failed_live_helper(live);
                *slot = None;
                if retryable && !fail_closed && attempt == 0 {
                    continue;
                }
                return Err(helper_transport_error(
                    method,
                    method_retryable,
                    fail_closed,
                    e,
                ));
            }
        };

        if let Some(id_error) = helper_response_id_error(&resp, id) {
            eprintln!("[computer-use] {id_error}: expected {id}; killing");
            let fail_closed = terminate_failed_live_helper(live);
            *slot = None;
            if retryable && !fail_closed && attempt == 0 {
                continue;
            }
            return Err(helper_transport_error(
                method,
                method_retryable,
                fail_closed,
                id_error,
            ));
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

fn invoke_controller_helper_once(method: &str, params: &Value) -> Result<Value, ComputerUseError> {
    if !matches!(method, "permissions" | "request-permissions") {
        return Err(ComputerUseError::new(
            "scope_denied",
            "controller helper is restricted to TCC probes",
        ));
    }
    let mut spawn = ComputerUseSpawn::new();
    spawn
        .command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = spawn.command.spawn().map_err(|error| {
        ComputerUseError::new("provider_down", format!("spawn controller probe: {error}"))
    })?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| ComputerUseError::new("provider_down", "controller probe has no stdin"))?;
    let request = json!({
        "id": 1,
        "method": method,
        "params": params,
    });
    stdin
        .write_all(format!("{request}\n").as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|error| {
            ComputerUseError::new("provider_down", format!("write controller probe: {error}"))
        })?;
    drop(stdin);
    let output = child.wait_with_output().map_err(|error| {
        ComputerUseError::new(
            "provider_down",
            format!("wait for controller probe: {error}"),
        )
    })?;
    if !output.status.success() {
        return Err(ComputerUseError::new(
            "provider_down",
            format!("controller probe exited with {}", output.status),
        ));
    }
    let line = String::from_utf8(output.stdout)
        .map_err(|error| ComputerUseError::new("provider_down", error.to_string()))?;
    let response: Value = serde_json::from_str(line.lines().next().unwrap_or_default())
        .map_err(|error| ComputerUseError::new("provider_down", error.to_string()))?;
    if let Some(id_error) = helper_response_id_error(&response, 1) {
        return Err(ComputerUseError::new("provider_down", id_error));
    }
    if let Some(error) = response.get("error").and_then(Value::as_object) {
        if !error.is_empty() {
            return Err(ComputerUseError::new(
                error
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown"),
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            ));
        }
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

pub(crate) fn computer_use_permission_status(request: bool) -> Result<Value, ComputerUseError> {
    let controller = if request {
        let value = invoke_controller_helper_once("request-permissions", &json!({}))?;
        let mut status = tcc_status_from_helper(&value).ok_or_else(|| {
            ComputerUseError::new("provider_down", "controller returned malformed TCC status")
        })?;
        status.screen_recording = computer_use_tcc::request_controller_screen_recording();
        status
    } else {
        computer_use_tcc::probe_tcc_status()
    };
    let agent_method = if request {
        "request-permissions"
    } else {
        "permissions"
    };
    let agent_value = invoke_helper_once(agent_method, &json!({}))?;
    let agent = tcc_status_from_helper(&agent_value).ok_or_else(|| {
        ComputerUseError::new("provider_down", "agent returned malformed TCC status")
    })?;
    Ok(computer_use_tcc::permission_payload(controller, agent))
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

    #[test]
    fn only_read_only_helper_methods_are_eligible_for_transport_retry() {
        for method in [
            "screenshot",
            "get-app-state",
            "list-apps",
            "inspect-pointer",
            "permissions",
            "zoom",
        ] {
            assert!(helper_method_is_retryable(method), "{method}");
        }
        for method in [
            "left-click",
            "left-click-drag",
            "left-mouse-down",
            "type-text",
            "press-key",
            "hold-key",
            "scroll",
            "request-permissions",
        ] {
            assert!(!helper_method_is_retryable(method), "{method}");
        }
    }

    #[test]
    fn action_helper_transport_never_retries_during_an_active_session() {
        assert!(helper_transport_may_retry("screenshot", false));
        assert!(helper_transport_may_retry("permissions", false));

        assert!(!helper_transport_may_retry("screenshot", true));
        assert!(!helper_transport_may_retry("permissions", true));
        assert!(!helper_transport_may_retry("left-click", true));
    }

    #[test]
    fn unexpected_helper_exit_routes_one_fail_closed_incident_for_the_active_session() {
        let fail_closed = AtomicBool::new(false);
        let calls = AtomicU32::new(0);

        assert!(route_unexpected_helper_exit(
            &fail_closed,
            Some("active-session".to_string()),
            |session_id| {
                assert_eq!(session_id, "active-session");
                calls.fetch_add(1, Ordering::SeqCst);
            },
        ));
        assert!(route_unexpected_helper_exit(
            &fail_closed,
            Some("active-session".to_string()),
            |_| {
                calls.fetch_add(1, Ordering::SeqCst);
            },
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let safe_probe = AtomicBool::new(false);
        assert!(!route_unexpected_helper_exit(
            &safe_probe,
            None,
            |_| panic!("a helper without an active session must not revoke one"),
        ));
    }

    #[test]
    fn helper_tcc_probe_requires_both_grants() {
        assert!(helper_tcc_authority_is_usable(tcc_status_from_helper(
            &json!({
                "accessibility": "granted",
                "screenRecording": "granted",
            })
        )));
        assert!(!helper_tcc_authority_is_usable(tcc_status_from_helper(
            &json!({
                "accessibility": "granted",
                "screenRecording": "missing",
            })
        )));
        assert!(!helper_tcc_authority_is_usable(tcc_status_from_helper(
            &json!({"accessibility":"granted"}),
        )));
    }

    #[test]
    fn helper_response_without_numeric_id_is_rejected() {
        assert_eq!(
            helper_response_id_error(&json!({"result": {"performed": true}}), 7),
            Some("helper response id missing")
        );
        assert_eq!(
            helper_response_id_error(&json!({"id": "7", "result": {}}), 7),
            Some("helper response id missing")
        );
        assert_eq!(
            helper_response_id_error(&json!({"id": 8, "result": {}}), 7),
            Some("helper response id mismatch")
        );
        assert_eq!(
            helper_response_id_error(&json!({"id": 7, "result": {}}), 7),
            None
        );
    }

    fn grant_goal_directed(service: &ComputerUseService) -> Session {
        let settings = enabled_settings();
        let req = service
            .sessions
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

    fn service_with_audit(
        label: &str,
    ) -> (ComputerUseService, Arc<AuditWriter>, std::path::PathBuf) {
        let directory = std::env::temp_dir().join(format!(
            "verboo-cu-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let writer =
            Arc::new(AuditWriter::open_for_test(&directory).expect("open isolated audit database"));
        let service = ComputerUseService {
            sessions: SessionManager::new(),
            audit: Some(Arc::clone(&writer)),
            poller_shutdown: Arc::new(AtomicBool::new(true)),
            poller_handle: Mutex::new(None),
        };
        (service, writer, directory)
    }

    fn service_with_active_audit(
        label: &str,
    ) -> (
        ComputerUseService,
        Arc<AuditWriter>,
        std::path::PathBuf,
        Session,
    ) {
        let (service, writer, directory) = service_with_audit(label);
        let settings = enabled_settings();
        let request = service
            .request_session(
                &settings,
                "test audited behavior",
                Some("com.apple.Notes".into()),
                ActionScope::Input,
            )
            .expect("request session");
        let session = service
            .grant_session(ConsentGrant {
                id: request.id,
                allowlist_version: 1,
                self_test_enabled: false,
                screenshot_attach_to_llm: false,
                idle_timeout_secs: 900,
            })
            .expect("grant session");
        (service, writer, directory, session)
    }

    #[test]
    fn goal_directed_session_never_auto_binds_from_a_tool_call() {
        let (service, _writer, directory) = service_with_audit("goal-directed-no-auto-bind");
        let session = grant_goal_directed(&service);
        assert!(session.target_app.is_none());

        let mut settings = enabled_settings();
        let result = service.get_app_state(&mut settings, "com.google.Chrome", true);
        assert_eq!(
            result.error.as_ref().map(|e| e.code.as_str()),
            Some("app_not_allowlisted")
        );
        assert!(service.current().and_then(|s| s.target_app).is_none());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn list_apps_does_not_require_target_bind() {
        let (service, _writer, directory) = service_with_audit("list-apps-no-bind");
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
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn trusted_handoff_uses_only_the_executor_bound_to_the_session() {
        let (service, _writer, directory, session) =
            service_with_active_audit("handoff-executor-binding");

        let mismatch =
            service.build_trusted_handoff(&session.id, "different-vision-model", "completed");
        assert_eq!(
            mismatch.unwrap_err(),
            "computer-use handoff executor does not match the authorized session"
        );

        let handoff = service
            .build_trusted_handoff(&session.id, &session.executor_model_id, "completed")
            .expect("matching executor produces a handoff");
        assert_eq!(handoff.executor_model_id, session.executor_model_id);
        assert_eq!(handoff.objective, session.goal);

        service.sessions.pause(&session.id).expect("pause session");
        assert!(service
            .build_trusted_handoff(&session.id, &session.executor_model_id, "cancelled")
            .is_ok());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn canonical_action_success_is_appended_only_after_visual_finalization() {
        let directory = std::env::temp_dir().join(format!(
            "verboo-cu-observation-audit-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let writer =
            Arc::new(AuditWriter::open_for_test(&directory).expect("open isolated audit database"));
        let service = ComputerUseService {
            sessions: SessionManager::new(),
            audit: Some(Arc::clone(&writer)),
            poller_shutdown: Arc::new(AtomicBool::new(true)),
            poller_handle: Mutex::new(None),
        };
        let settings = enabled_settings();
        let request = service
            .request_session(
                &settings,
                "verify a click",
                Some("com.apple.Notes".into()),
                ActionScope::Input,
            )
            .expect("request session");
        let session = service
            .grant_session(ConsentGrant {
                id: request.id,
                allowlist_version: 1,
                self_test_enabled: false,
                screenshot_attach_to_llm: false,
                idle_timeout_secs: 900,
            })
            .expect("grant session");

        service
            .append_audit(
                &session.id,
                Some("com.apple.Notes"),
                "left-click",
                AuditOutcome::Pending,
                None,
                false,
            )
            .expect("pending audit");
        assert_eq!(
            writer.outcomes_for_test(&session.id, "left-click"),
            vec!["pending"]
        );

        service
            .finalize_canonical_action(
                CanonicalActionAuditTicket {
                    session_id: session.id.clone(),
                    app_bundle_id: "com.apple.Notes".into(),
                    action_type: "left-click".into(),
                },
                None,
            )
            .expect("finalize after fresh observation");
        assert_eq!(
            writer.outcomes_for_test(&session.id, "left-click"),
            vec!["pending", "success"]
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn confirmation_audit_uses_controlled_summary_without_ax_label() {
        let (service, writer, directory, session) =
            service_with_active_audit("confirmation-redaction");
        let raw_allow = "AXButton 'Transfer R$ 900 to account 1234'";
        let raw_deny = "AXStaticText secret@example.com";

        service
            .record_confirmation_decision(&session.id, "com.apple.Notes", raw_allow, true)
            .expect("audit approval");
        service
            .record_confirmation_decision(&session.id, "com.apple.Notes", raw_deny, false)
            .expect("audit denial");

        assert_eq!(
            writer.action_summaries_for_test(&session.id, "confirmation_approved"),
            vec![Some(
                "User approved one consequential Computer Use action".into()
            )]
        );
        assert_eq!(
            writer.action_summaries_for_test(&session.id, "confirmation_denied"),
            vec![Some(
                "User denied one consequential Computer Use action".into()
            )]
        );
        let stored = ["confirmation_approved", "confirmation_denied"]
            .into_iter()
            .flat_map(|action_type| {
                writer
                    .action_summaries_for_test(&session.id, action_type)
                    .into_iter()
                    .flatten()
            })
            .collect::<Vec<_>>()
            .join(" ");
        assert!(!stored.contains(raw_allow));
        assert!(!stored.contains(raw_deny));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn canonical_visual_success_persists_only_engine_verified_png_evidence() {
        use base64::Engine as _;

        let (service, writer, directory, session) =
            service_with_active_audit("verified-screenshot-persistence");
        let image = image::DynamicImage::new_rgba8(2, 2);
        let mut encoded_png = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut encoded_png, image::ImageFormat::Png)
            .expect("encode test PNG");
        let png = encoded_png.into_inner();
        let mut engine = crate::services::computer_use_engine::ComputerUseEngine::default();
        let evidence = engine
            .accept_observation(&ComputerUseResult {
                result: Some(json!({
                    "screenshot_id": "verified-shot",
                    "screenshot_base64": base64::engine::general_purpose::STANDARD.encode(&png),
                    "screenshot_width": 2,
                    "screenshot_height": 2,
                    "display_id": 1,
                    "app_pid": 123,
                    "window_frame": {"x": 0, "y": 0, "width": 2, "height": 2}
                })),
                error: None,
            })
            .expect("engine validates screenshot evidence");
        service
            .append_audit(
                &session.id,
                Some("com.apple.Notes"),
                "get-app-state",
                AuditOutcome::Pending,
                None,
                false,
            )
            .expect("pending audit");
        service
            .finalize_canonical_action(
                CanonicalActionAuditTicket {
                    session_id: session.id.clone(),
                    app_bundle_id: "com.apple.Notes".into(),
                    action_type: "get-app-state".into(),
                },
                Some(&evidence),
            )
            .expect("finalize verified screenshot");

        assert_eq!(
            writer.outcomes_for_test(&session.id, "get-app-state"),
            vec!["pending", "success"]
        );
        let (bytes, _, path) = writer.screenshot_metadata_for_test("get-app-state");
        assert_eq!(bytes, Some(png.len() as i64));
        assert_eq!(
            std::fs::read(path.expect("stored screenshot path")).unwrap(),
            png
        );
        assert_eq!(
            writer.screenshot_retention_metadata_for_test("get-app-state"),
            (Some("verified-shot".into()), Some("[]".into()))
        );
        writer.verify_chain().expect("trajectory remains verified");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn canonical_visual_success_consumes_engine_prune_batches() {
        use base64::Engine as _;
        use image::GenericImage as _;

        let (service, writer, directory, session) =
            service_with_active_audit("verified-screenshot-prune-batch");
        let mut engine = crate::services::computer_use_engine::ComputerUseEngine::default();
        let mut first_path = None;

        for index in 0..25u8 {
            let mut image = image::DynamicImage::new_rgba8(2, 2);
            image.put_pixel(0, 0, image::Rgba([index, 0, 0, 255]));
            let mut encoded_png = std::io::Cursor::new(Vec::new());
            image
                .write_to(&mut encoded_png, image::ImageFormat::Png)
                .expect("encode distinct test PNG");
            let png = encoded_png.into_inner();
            let screenshot_id = format!("shot-{index}");
            let action_type = format!("capture-{index}");
            let evidence = engine
                .accept_observation(&ComputerUseResult {
                    result: Some(json!({
                        "screenshot_id": screenshot_id,
                        "screenshot_base64": base64::engine::general_purpose::STANDARD.encode(&png),
                        "screenshot_width": 2,
                        "screenshot_height": 2,
                        "display_id": 1,
                        "app_pid": 123,
                        "window_frame": {"x": 0, "y": 0, "width": 2, "height": 2}
                    })),
                    error: None,
                })
                .expect("engine validates screenshot evidence");
            service
                .append_audit(
                    &session.id,
                    Some("com.apple.Notes"),
                    &action_type,
                    AuditOutcome::Pending,
                    None,
                    false,
                )
                .expect("pending audit");
            service
                .finalize_canonical_action(
                    CanonicalActionAuditTicket {
                        session_id: session.id.clone(),
                        app_bundle_id: "com.apple.Notes".into(),
                        action_type: action_type.clone(),
                    },
                    Some(&evidence),
                )
                .expect("finalize verified screenshot");
            if index == 0 {
                first_path = writer
                    .screenshot_metadata_for_test(&action_type)
                    .2
                    .map(std::path::PathBuf::from);
            }
        }

        assert!(
            !first_path.expect("first screenshot path").exists(),
            "the 25th observation must consume and remove the first prune batch"
        );
        let latest_path = writer
            .screenshot_metadata_for_test("capture-24")
            .2
            .map(std::path::PathBuf::from)
            .expect("latest screenshot path");
        assert!(
            latest_path.exists(),
            "the latest observation remains retained"
        );
        writer.verify_chain().expect("prune batch remains chained");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn audit_storage_full_maps_to_distinct_error_and_stops_session() {
        let (service, writer, directory, session) =
            service_with_active_audit("storage-full-mapping");
        let current = writer
            .storage_usage_bytes_for_test()
            .expect("storage usage");
        writer
            .configure_policy_for_test(90, current.saturating_add(1), u64::MAX)
            .expect("persist tight cap");

        let error = service
            .finalize_canonical_action(
                CanonicalActionAuditTicket {
                    session_id: session.id.clone(),
                    app_bundle_id: "com.apple.Notes".into(),
                    action_type: "left-click".into(),
                },
                None,
            )
            .expect_err("storage cap must refuse the audit append");

        assert_eq!(error.code, "audit_storage_full");
        assert!(service.sessions.current_any().is_none());
        assert_eq!(writer.count_for_session(&session.id).unwrap(), 0);
        let _ = std::fs::remove_dir_all(directory);
    }
}
