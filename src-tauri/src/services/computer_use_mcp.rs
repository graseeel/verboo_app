use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::models::computer_use::{
    ActionScope, ApprovedApp, ComputerUseError, ComputerUseResult, ConsentGrant, Session,
};
use crate::models::computer_use_action::{ActionRequest, ComputerAction, KeyModifier};
use crate::models::types::ComputerUseSettings;
use crate::services::computer_use_confirmation::{
    ConfirmationConsumption, ConfirmationStore, ConfirmationWaitOutcome,
};
use crate::services::computer_use_engine::{ComputerUseEngine, VerifiedScreenshot};
use crate::services::computer_use_policy::{
    classify_keyboard_target, classify_pointer_target, classify_type_target, ActionPolicyDecision,
};
use crate::services::computer_use_service::{CanonicalActionAuditTicket, ComputerUseService};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capability {
    pub session_id: String,
    pub conversation_id: String,
    pub executor_model_id: String,
    pub token: String,
    /// Bound bundle id, or `""` / `"*"` for goal-directed (unbound) sessions.
    pub app: String,
    #[serde(default)]
    pub approved_apps: Vec<ApprovedApp>,
    #[serde(default)]
    pub self_test_enabled: bool,
    pub goal: String,
    pub expires_at: u64,
    #[serde(default)]
    pub idle_timeout_secs: u64,
    pub paused: bool,
    #[serde(default)]
    pub screenshot_attach_to_llm: bool,
    #[serde(default = "default_isolate_other_apps")]
    pub isolate_other_apps: bool,
    #[serde(default)]
    pub controller_pid: u32,
    #[serde(default)]
    pub compact_layout: bool,
    #[serde(default)]
    pub compact_panel_width: u32,
    #[serde(default)]
    pub focus_request_generation: u64,
}

#[derive(Debug)]
pub struct ActivationReceipt {
    pub focus: Option<crate::services::computer_use_focus::FocusStartReceipt>,
}

fn default_isolate_other_apps() -> bool {
    true
}

/// `""` or `"*"` means bootstrap / goal-directed — no single target yet.
pub fn capability_app_is_unbound(app: &str) -> bool {
    let trimmed = app.trim();
    trimmed.is_empty() || trimmed == "*"
}

/// Normalize an optional app into the capability wire form.
/// `None` / empty / `"*"` → unbound (`""`).
fn capability_app_value(app: Option<&str>) -> String {
    match app.map(str::trim).filter(|s| !s.is_empty() && *s != "*") {
        Some(s) => s.to_string(),
        None => String::new(),
    }
}

fn runtime_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or("no application data directory")?;
    Ok(base
        .join("ai.verboo.code.desktop")
        .join("computer-use-runtime"))
}

fn capability_path() -> Result<PathBuf, String> {
    Ok(runtime_dir()?.join("capability.json"))
}
pub fn config_path() -> Result<PathBuf, String> {
    Ok(runtime_dir()?.join("mcp.json"))
}
fn capability_lock_path() -> Result<PathBuf, String> {
    Ok(runtime_dir()?.join("capability.lock"))
}
fn owner_lock_path() -> Result<PathBuf, String> {
    Ok(runtime_dir()?.join("owner.lock"))
}

#[derive(Debug)]
struct AdvisoryFileLock {
    file: File,
}

impl AdvisoryFileLock {
    fn acquire(path: &std::path::Path, nonblocking: bool) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(path).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let operation = libc::LOCK_EX | if nonblocking { libc::LOCK_NB } else { 0 };
            if unsafe { libc::flock(file.as_raw_fd(), operation) } != 0 {
                let error = std::io::Error::last_os_error();
                return Err(if matches!(error.kind(), io::ErrorKind::WouldBlock) {
                    "another Computer Use session already owns this machine".into()
                } else {
                    format!("lock Computer Use runtime: {error}")
                });
            }
        }
        Ok(Self { file })
    }
}

impl Drop for AdvisoryFileLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let _ = unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
        }
    }
}

fn clear_recovered_owner_metadata(lock: &mut AdvisoryFileLock) -> Result<(), String> {
    lock.file
        .set_len(0)
        .map_err(|error| format!("clear recovered Computer Use owner metadata: {error}"))?;
    lock.file
        .sync_all()
        .map_err(|error| format!("sync recovered Computer Use owner metadata: {error}"))
}

#[derive(Debug)]
struct MachineOwner {
    session_id: String,
    _lock: AdvisoryFileLock,
}

struct EmergencyMonitor {
    session_id: String,
    generation: String,
    child: Arc<Mutex<Child>>,
    expected_stop: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SafetyIncidentKind {
    EmergencyStop,
    RuntimeFailure,
}

type SafetyIncidentCallback = Arc<dyn Fn(SafetyIncidentKind, bool) + Send + Sync + 'static>;

struct SafetyIncidentHandler {
    session_id: String,
    callback: SafetyIncidentCallback,
}

fn emergency_monitor_slot() -> &'static Mutex<Option<EmergencyMonitor>> {
    static MONITOR: OnceLock<Mutex<Option<EmergencyMonitor>>> = OnceLock::new();
    MONITOR.get_or_init(|| Mutex::new(None))
}

fn safety_incident_handler_slot() -> &'static Mutex<Option<SafetyIncidentHandler>> {
    static HANDLER: OnceLock<Mutex<Option<SafetyIncidentHandler>>> = OnceLock::new();
    HANDLER.get_or_init(|| Mutex::new(None))
}

fn register_safety_incident_handler(
    session_id: &str,
    callback: SafetyIncidentCallback,
) -> Result<(), String> {
    let mut slot = safety_incident_handler_slot()
        .lock()
        .map_err(|_| "Computer Use safety incident handler lock poisoned".to_string())?;
    if slot.is_some() {
        return Err("another Computer Use safety incident handler is active".into());
    }
    *slot = Some(SafetyIncidentHandler {
        session_id: session_id.to_string(),
        callback,
    });
    Ok(())
}

#[cfg(test)]
fn take_safety_incident_handler(session_id: &str) -> Option<SafetyIncidentCallback> {
    let mut slot = safety_incident_handler_slot().lock().ok()?;
    if slot
        .as_ref()
        .is_none_or(|handler| handler.session_id != session_id)
    {
        return None;
    }
    slot.take().map(|handler| handler.callback)
}

fn safety_incident_callback(session_id: &str) -> Option<SafetyIncidentCallback> {
    let slot = safety_incident_handler_slot().lock().ok()?;
    slot.as_ref()
        .filter(|handler| handler.session_id == session_id)
        .map(|handler| Arc::clone(&handler.callback))
}

fn clear_safety_incident_handler_if_callback(
    session_id: &str,
    expected_callback: &SafetyIncidentCallback,
) {
    if let Ok(mut slot) = safety_incident_handler_slot().lock() {
        let matches = slot.as_ref().is_some_and(|handler| {
            handler.session_id == session_id && Arc::ptr_eq(&handler.callback, expected_callback)
        });
        if matches {
            *slot = None;
        }
    }
}

fn clear_safety_incident_handler(expected_session_id: Option<&str>) {
    if let Ok(mut slot) = safety_incident_handler_slot().lock() {
        let matches = expected_session_id.is_none_or(|expected| {
            slot.as_ref()
                .is_some_and(|handler| handler.session_id == expected)
        });
        if matches {
            *slot = None;
        }
    }
}

/// Return the session whose native action helper is currently safety-critical.
/// The desktop process owns an in-memory callback; the MCP subprocess recovers
/// the same identity from its live capability token.
pub(crate) fn active_action_helper_session_id() -> Option<String> {
    let local = safety_incident_handler_slot()
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|handler| handler.session_id.clone()));
    local.or_else(|| {
        read_capability()
            .ok()
            .map(|capability| capability.session_id)
    })
}

fn machine_owner_slot() -> &'static Mutex<Option<MachineOwner>> {
    static OWNER: OnceLock<Mutex<Option<MachineOwner>>> = OnceLock::new();
    OWNER.get_or_init(|| Mutex::new(None))
}

fn acquire_machine_owner(session_id: &str) -> Result<(), String> {
    let mut owner = machine_owner_slot()
        .lock()
        .map_err(|_| "Computer Use owner lock poisoned")?;
    if owner
        .as_ref()
        .is_some_and(|current| current.session_id == session_id)
    {
        return Ok(());
    }
    if owner.is_some() {
        return Err("another Computer Use session already owns this process".into());
    }
    let mut lock = AdvisoryFileLock::acquire(&owner_lock_path()?, true)?;
    lock.file.set_len(0).map_err(|error| error.to_string())?;
    lock.file
        .seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    lock.file
        .write_all(
            serde_json::to_string(&json!({
                "session_id": session_id,
                "pid": std::process::id(),
                "started_at": now(),
            }))
            .map_err(|error| error.to_string())?
            .as_bytes(),
        )
        .map_err(|error| error.to_string())?;
    lock.file.sync_all().map_err(|error| error.to_string())?;
    *owner = Some(MachineOwner {
        session_id: session_id.to_string(),
        _lock: lock,
    });
    Ok(())
}

fn release_machine_owner(expected_session_id: Option<&str>) {
    if let Ok(mut owner) = machine_owner_slot().lock() {
        let matches = expected_session_id.is_none_or(|expected| {
            owner
                .as_ref()
                .is_some_and(|current| current.session_id == expected)
        });
        if matches {
            *owner = None;
        }
    }
}

fn current_machine_owner_session() -> Option<String> {
    machine_owner_slot()
        .lock()
        .ok()
        .and_then(|owner| owner.as_ref().map(|current| current.session_id.clone()))
}

fn with_capability_lock<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _lock = AdvisoryFileLock::acquire(&capability_lock_path()?, false)?;
    operation()
}

fn write_private_atomic(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("capability path has no parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".computer-use-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_capability_atomic(path: &std::path::Path, cap: &Capability) -> Result<(), String> {
    write_private_atomic(
        path,
        &serde_json::to_vec(cap).map_err(|error| error.to_string())?,
    )
}

fn advance_target_focus_generation(
    cap: &mut Capability,
    expected_session_id: &str,
) -> Result<u64, String> {
    if cap.session_id != expected_session_id {
        return Err("computer-use session mismatch".into());
    }
    cap.focus_request_generation = cap
        .focus_request_generation
        .checked_add(1)
        .ok_or("computer-use focus request generation exhausted")?;
    Ok(cap.focus_request_generation)
}

fn request_target_focus_at(path: &Path, expected_session_id: &str) -> Result<u64, String> {
    with_capability_lock(|| {
        let mut cap: Capability =
            serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
        let generation = advance_target_focus_generation(&mut cap, expected_session_id)?;
        write_capability_atomic(path, &cap)?;
        Ok(generation)
    })
}

/// Ask the focus helper to activate the exact approved target once. The
/// capability lock and atomic rewrite make the generation the only signal;
/// no second IPC channel or polling command is introduced.
pub fn request_target_focus(expected_session_id: &str) -> Result<(), String> {
    request_target_focus_at(&capability_path()?, expected_session_id).map(|_| ())
}

/// Activate MCP capability for a session.
///
/// `app: None` (or empty/`*`) starts a goal-directed session: capability is
/// written with unbound app and focus HUD is deferred until `bind_app`.
pub fn activate<F, L>(
    session: &Session,
    on_safety_incident: F,
    on_layout_status: L,
) -> Result<ActivationReceipt, String>
where
    F: Fn(SafetyIncidentKind, bool) + Send + Sync + 'static,
    L: Fn(crate::services::computer_use_focus::FocusStartReceipt) + Send + Sync + 'static,
{
    let dir = runtime_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    acquire_machine_owner(&session.id)?;
    let app_value = capability_app_value(
        session
            .active_app
            .as_deref()
            .or(session.target_app.as_deref()),
    );
    let cap = Capability {
        session_id: session.id.clone(),
        conversation_id: session.conversation_id.clone(),
        executor_model_id: session.executor_model_id.clone(),
        token: Uuid::new_v4().to_string(),
        app: app_value.clone(),
        approved_apps: session.approved_apps.clone(),
        self_test_enabled: session.self_test_enabled,
        goal: session.goal.clone(),
        expires_at: now().saturating_add(session.idle_timeout_secs),
        idle_timeout_secs: session.idle_timeout_secs,
        paused: false,
        screenshot_attach_to_llm: session.screenshot_attach_to_llm,
        isolate_other_apps: session.isolate_other_apps,
        controller_pid: std::process::id(),
        compact_layout: true,
        compact_panel_width: 420,
        focus_request_generation: 1,
    };
    let cap_path = capability_path()?;
    let path = config_path()?;
    let safety_callback: SafetyIncidentCallback = Arc::new(on_safety_incident);
    let activation_result = (|| {
        // Owning the OS lock proves an earlier desktop owner is gone. Remove
        // any crash-left capability before publishing the new token.
        with_capability_lock(|| {
            let _ = fs::remove_file(&cap_path);
            let _ = fs::remove_file(&path);
            write_capability_atomic(&cap_path, &cap)?;
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let config = json!({"mcpServers":{"verboo-computer-use":{
                "command": exe,
                "args": ["--computer-use-mcp"],
                "env": {"VERBOO_CU_TOKEN": cap.token, "VERBOO_CU_CAPABILITY_FILE": cap_path}
            }}});
            write_private_atomic(
                &path,
                &serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?,
            )
        })?;
        register_safety_incident_handler(&session.id, safety_callback)?;
        start_emergency_monitor(&session.id, &cap_path)?;
        Ok::<(), String>(())
    })();
    if let Err(error) = activation_result {
        let _ = revoke_session(&session.id);
        release_machine_owner(Some(&session.id));
        return Err(error);
    }
    // Focus / isolation HUD only when a concrete app is already known.
    let focus = if !capability_app_is_unbound(&app_value) {
        match crate::services::computer_use_focus::start(
            &session.id,
            &app_value,
            &cap_path,
            &cap.token,
            on_layout_status,
        ) {
            Ok(receipt) => Some(receipt),
            Err(error) => {
                let _ = revoke_session(&session.id);
                return Err(error);
            }
        }
    } else {
        None
    };
    Ok(ActivationReceipt { focus })
}

fn select_capability_app_value(cap: &mut Capability, app: &str) -> Result<(), String> {
    let app = app.trim();
    if capability_app_is_unbound(app) {
        return Err("cannot select empty or wildcard app".into());
    }
    if !cap
        .approved_apps
        .iter()
        .any(|approved| approved.bundle_id.eq_ignore_ascii_case(app))
    {
        return Err("computer-use app has not been explicitly approved".into());
    }
    cap.app = app.to_string();
    Ok(())
}

fn approve_capability_app(
    cap: &mut Capability,
    session_id: &str,
    approved_app: ApprovedApp,
) -> Result<(), String> {
    if cap.session_id != session_id {
        return Err("computer-use session mismatch".into());
    }
    if !cap.paused {
        return Err("computer-use session must remain paused while changing apps".into());
    }
    if let Some(existing) = cap
        .approved_apps
        .iter_mut()
        .find(|app| app.bundle_id.eq_ignore_ascii_case(&approved_app.bundle_id))
    {
        *existing = approved_app.clone();
    } else {
        cap.approved_apps.push(approved_app.clone());
    }
    select_capability_app_value(cap, &approved_app.bundle_id)
}

pub fn approve_and_select_app<L>(
    session_id: &str,
    approved_app: ApprovedApp,
    on_layout_status: L,
) -> Result<crate::services::computer_use_focus::FocusStartReceipt, String>
where
    L: Fn(crate::services::computer_use_focus::FocusStartReceipt) + Send + Sync + 'static,
{
    let path = capability_path()?;
    let activation_result = with_capability_lock(|| {
        let mut cap: Capability =
            serde_json::from_slice(&fs::read(&path).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
        approve_capability_app(&mut cap, session_id, approved_app.clone())?;
        advance_target_focus_generation(&mut cap, session_id)?;
        write_capability_atomic(&path, &cap)?;
        crate::services::computer_use_focus::start(
            session_id,
            &approved_app.bundle_id,
            &path,
            &cap.token,
            on_layout_status,
        )
    });
    match activation_result {
        Ok(receipt) => Ok(receipt),
        Err(error) => {
            let _ = revoke_session(session_id);
            Err(error)
        }
    }
}

pub fn revoke() -> Result<(), String> {
    // Remove authority first. Cleanup failures must never leave the token live.
    let _ = revoke_files_for(None)?;
    stop_local_emergency_monitor(None)?;
    Ok(())
}

/// Cold-start recovery. The machine-owner lock is the authority to decide
/// whether persisted capability/focus files are stale. A live owner is left
/// completely untouched; otherwise authority is removed before any window
/// restoration is attempted.
pub fn recover_stale_runtime() -> Result<bool, String> {
    let mut owner_guard = match AdvisoryFileLock::acquire(&owner_lock_path()?, true) {
        Ok(lock) => lock,
        Err(error) if error == "another Computer Use session already owns this machine" => {
            return Ok(false)
        }
        Err(error) => return Err(error),
    };
    mark_local_emergency_monitor_expected(None);
    clear_safety_incident_handler(None);
    with_capability_lock(|| {
        for path in [capability_path()?, config_path()?] {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("remove stale Computer Use authority: {error}")),
            }
        }
        // Legacy builds persisted a bare monitor PID. Never signal it: PID
        // reuse could target an unrelated process. New monitors use a pipe
        // lifeline and capability-file watcher instead.
        let _ = fs::remove_file(runtime_dir()?.join("monitor.pid"));
        Ok(())
    })?;
    stop_local_emergency_monitor(None)?;
    let mut attempt = 0u8;
    let restored = loop {
        match crate::services::computer_use_focus::restore_stale_state() {
            Ok(restored) => break Ok(restored),
            Err(error) if error.contains(" is live") && attempt < 20 => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => break Err(error),
        }
    };
    let metadata_result = clear_recovered_owner_metadata(&mut owner_guard);
    drop(owner_guard);
    match (restored, metadata_result) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(restored), Ok(())) => Ok(restored),
    }
}

/// Clean process shutdown affects only the session whose advisory owner lock
/// is held by this process. It never broadens into an unscoped machine kill.
pub fn shutdown_owned_runtime() -> Result<(), String> {
    let Some(session_id) = current_machine_owner_session() else {
        return Ok(());
    };
    let _ = revoke_session(&session_id)?;
    Ok(())
}

pub fn revoke_session(expected_session_id: &str) -> Result<bool, String> {
    let revoked = revoke_files_for(Some(expected_session_id))?;
    if !revoked {
        return Ok(false);
    }
    stop_local_emergency_monitor(Some(expected_session_id))?;
    Ok(true)
}

fn revoke_files_for(expected_session_id: Option<&str>) -> Result<bool, String> {
    let capability = capability_path()?;
    let config = config_path()?;
    let owner_session_id = current_machine_owner_session();
    let (matched, session_id, authority_cleanup_errors) = with_capability_lock(|| {
        let existing = match fs::read(&capability) {
            Ok(bytes) => Some(
                serde_json::from_slice::<Capability>(&bytes)
                    .map_err(|error| format!("read computer-use capability: {error}"))?,
            ),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        if let (Some(expected), Some(existing)) = (expected_session_id, existing.as_ref()) {
            if existing.session_id != expected {
                return Ok((false, None, Vec::new()));
            }
        }

        let session_id = existing
            .map(|capability| capability.session_id)
            .or_else(|| expected_session_id.map(ToOwned::to_owned))
            .or_else(|| owner_session_id.clone());

        let cleanup_errors = revoke_authority_files(
            &config,
            &capability,
            |path| fs::remove_file(path),
            |expected| {
                set_local_emergency_monitor_expected(expected_session_id, expected);
                crate::services::computer_use_focus::set_expected_stop(
                    expected_session_id,
                    expected,
                );
            },
            || clear_safety_incident_handler(expected_session_id),
        )?;
        Ok((true, session_id, cleanup_errors))
    })?;

    if !matched {
        return Ok(false);
    }

    let Some(session_id) = session_id else {
        crate::services::computer_use_service::kill_live_helper();
        let _ = crate::services::computer_use_focus::stop_any();
        release_machine_owner(None);
        if authority_cleanup_errors.is_empty() {
            return Ok(expected_session_id.is_none());
        }
        return Err(authority_cleanup_errors.join("; "));
    };
    let mut errors = authority_cleanup_errors;
    errors.extend(finish_revocation_cleanup(
        crate::services::computer_use_service::kill_live_helper,
        || {
            if expected_session_id.is_some() {
                crate::services::computer_use_focus::stop(&session_id).map(|_| ())
            } else {
                crate::services::computer_use_focus::stop_any()
            }
        },
        || ConfirmationStore::runtime().and_then(|store| store.clear_session(&session_id)),
        || release_machine_owner(Some(&session_id)),
    ));
    if errors.is_empty() {
        Ok(true)
    } else {
        Err(errors.join("; "))
    }
}

fn finish_revocation_cleanup<K, F, C, R>(
    kill_action_helper: K,
    stop_focus_helper: F,
    clear_confirmation: C,
    release_owner: R,
) -> Vec<String>
where
    K: FnOnce(),
    F: FnOnce() -> Result<(), String>,
    C: FnOnce() -> Result<(), String>,
    R: FnOnce(),
{
    kill_action_helper();
    let focus_result = stop_focus_helper();
    let confirmation_result = clear_confirmation();
    release_owner();

    let mut errors = Vec::new();
    if let Err(error) = focus_result {
        errors.push(format!("restore isolated apps: {error}"));
    }
    if let Err(error) = confirmation_result {
        errors.push(format!("clear confirmation: {error}"));
    }
    errors
}

fn revoke_authority_files<R, M, C>(
    config: &Path,
    capability: &Path,
    mut remove_file: R,
    mut mark_expected_stop: M,
    clear_incident_handler: C,
) -> Result<Vec<String>, String>
where
    R: FnMut(&Path) -> io::Result<()>,
    M: FnMut(bool),
    C: FnOnce(),
{
    // The MCP config is only a launch descriptor, not action authority. Record
    // its cleanup failure but always attempt to invalidate the capability.
    let mut cleanup_errors = Vec::new();
    match remove_file(config) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => cleanup_errors.push(format!("revoke computer-use config: {error}")),
    }

    // Mark expected shutdown immediately before invalidating the capability.
    // If the authority unlink fails, roll the markers back and preserve the
    // incident handler so Esc/crash protection remains armed.
    mark_expected_stop(true);
    match remove_file(capability) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            mark_expected_stop(false);
            return Err(format!("revoke computer-use authority: {error}"));
        }
    }
    clear_incident_handler();
    Ok(cleanup_errors)
}

fn stop_local_emergency_monitor(expected_session_id: Option<&str>) -> Result<(), String> {
    let monitor = {
        let mut slot = emergency_monitor_slot()
            .lock()
            .map_err(|_| "emergency monitor lock poisoned".to_string())?;
        if expected_session_id.is_some_and(|expected| {
            slot.as_ref()
                .is_some_and(|monitor| monitor.session_id != expected)
        }) {
            return Ok(());
        }
        slot.take()
    };
    let Some(monitor) = monitor else {
        return Ok(());
    };
    monitor.expected_stop.store(true, Ordering::SeqCst);
    let mut child = monitor
        .child
        .lock()
        .map_err(|_| "emergency monitor child lock poisoned".to_string())?;
    if child
        .try_wait()
        .map_err(|error| format!("inspect emergency monitor: {error}"))?
        .is_none()
    {
        child
            .kill()
            .map_err(|error| format!("stop emergency monitor: {error}"))?;
    }
    child
        .wait()
        .map_err(|error| format!("reap emergency monitor: {error}"))?;
    Ok(())
}

fn mark_local_emergency_monitor_expected(expected_session_id: Option<&str>) {
    set_local_emergency_monitor_expected(expected_session_id, true);
}

fn set_local_emergency_monitor_expected(expected_session_id: Option<&str>, expected: bool) {
    if let Ok(slot) = emergency_monitor_slot().lock() {
        if let Some(monitor) = slot.as_ref().filter(|monitor| {
            expected_session_id.is_none_or(|expected| monitor.session_id == expected)
        }) {
            monitor.expected_stop.store(expected, Ordering::SeqCst);
        }
    }
}

fn clear_emergency_monitor_if_generation(generation: &str) {
    if let Ok(mut slot) = emergency_monitor_slot().lock() {
        if slot
            .as_ref()
            .is_some_and(|monitor| monitor.generation == generation)
        {
            *slot = None;
        }
    }
}

fn start_emergency_monitor(
    session_id: &str,
    capability_path: &std::path::Path,
) -> Result<(), String> {
    stop_local_emergency_monitor(None)?;
    let mut spawn = crate::services::computer_use_spawn::ComputerUseSpawn::new();
    spawn
        .command
        .arg("--monitor-emergency")
        .arg("--monitor-capability")
        .arg(capability_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = spawn
        .command
        .spawn()
        .map_err(|e| format!("start emergency monitor: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("emergency monitor has no stdout")?;
    let mut reader = BufReader::new(stdout);
    let mut ready = String::new();
    reader.read_line(&mut ready).map_err(|e| e.to_string())?;
    if !ready.contains("monitor-ready") {
        let _ = child.kill();
        return Err("global emergency hotkey monitor did not become ready".into());
    }
    let generation = Uuid::new_v4().to_string();
    let child = Arc::new(Mutex::new(child));
    let expected_stop = Arc::new(AtomicBool::new(false));
    {
        let mut slot = emergency_monitor_slot()
            .lock()
            .map_err(|_| "emergency monitor lock poisoned".to_string())?;
        *slot = Some(EmergencyMonitor {
            session_id: session_id.to_string(),
            generation: generation.clone(),
            child: Arc::clone(&child),
            expected_stop: Arc::clone(&expected_stop),
        });
    }
    let incident_session_id = session_id.to_string();
    std::thread::spawn(move || {
        if let Some(kind) = monitor_stream_requires_fail_closed(&mut reader, &expected_stop) {
            let source = match kind {
                SafetyIncidentKind::EmergencyStop => "global Esc emergency stop",
                SafetyIncidentKind::RuntimeFailure => "global Esc monitor exited unexpectedly",
            };
            handle_safety_incident(&incident_session_id, source, kind);
        }
        if let Ok(mut child) = child.lock() {
            let _ = child.wait();
        }
        clear_emergency_monitor_if_generation(&generation);
    });
    Ok(())
}

fn monitor_stream_requires_fail_closed(
    reader: &mut impl BufRead,
    expected_stop: &AtomicBool,
) -> Option<SafetyIncidentKind> {
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => {
                return (!expected_stop.load(Ordering::SeqCst))
                    .then_some(SafetyIncidentKind::RuntimeFailure)
            }
            Ok(_) if line.contains("emergency-stop") => {
                return (!expected_stop.load(Ordering::SeqCst))
                    .then_some(SafetyIncidentKind::EmergencyStop)
            }
            Ok(_) => {}
            Err(error) => {
                eprintln!("[computer-use-mcp] emergency monitor stream failed: {error}");
                return (!expected_stop.load(Ordering::SeqCst))
                    .then_some(SafetyIncidentKind::RuntimeFailure);
            }
        }
    }
}

fn handle_safety_incident_with_cleanup<F>(
    session_id: &str,
    source: &str,
    kind: SafetyIncidentKind,
    cleanup: F,
) where
    F: FnOnce() -> Result<bool, String>,
{
    let callback = safety_incident_callback(session_id);
    let authority_revoked = match cleanup() {
        Ok(revoked) => revoked,
        Err(error) => {
            eprintln!("[computer-use-mcp] {source}; fail-closed cleanup failed: {error}");
            false
        }
    };
    if authority_revoked {
        if let Some(callback) = callback.as_ref() {
            clear_safety_incident_handler_if_callback(session_id, callback);
        }
    }
    if let Some(callback) = callback {
        callback(kind, authority_revoked);
    }
}

fn handle_safety_incident(session_id: &str, source: &str, kind: SafetyIncidentKind) {
    handle_safety_incident_with_cleanup(session_id, source, kind, || {
        revoke_files_for(Some(session_id))
    });
}

pub(crate) fn handle_unexpected_focus_exit(session_id: &str) {
    handle_safety_incident(
        session_id,
        "focus HUD exited unexpectedly",
        SafetyIncidentKind::RuntimeFailure,
    );
}

pub(crate) fn handle_unexpected_action_helper_exit(session_id: &str) {
    handle_safety_incident(
        session_id,
        "native action helper exited unexpectedly",
        SafetyIncidentKind::RuntimeFailure,
    );
}

pub fn set_paused(expected_session_id: &str, paused: bool) -> Result<(), String> {
    let path = capability_path()?;
    with_capability_lock(|| {
        let mut cap: Capability =
            serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if cap.session_id != expected_session_id {
            return Err("computer-use session mismatch".into());
        }
        cap.paused = paused;
        write_capability_atomic(&path, &cap)
    })
}

pub fn active_config_path(expected_session_id: Option<&str>) -> Option<PathBuf> {
    let expected = expected_session_id?;
    let cap: Capability = serde_json::from_slice(&fs::read(capability_path().ok()?).ok()?).ok()?;
    if !capability_is_active(&cap, expected, now()) {
        return None;
    }
    let path = config_path().ok()?;
    path.exists().then_some(path)
}

fn capability_is_active(cap: &Capability, expected_session_id: &str, at: u64) -> bool {
    cap.session_id == expected_session_id && !cap.paused && cap.expires_at > at
}

fn read_capability() -> Result<Capability, String> {
    let token = std::env::var("VERBOO_CU_TOKEN").map_err(|_| "missing capability token")?;
    let path = std::env::var("VERBOO_CU_CAPABILITY_FILE").map_err(|_| "missing capability path")?;
    let cap: Capability =
        serde_json::from_slice(&fs::read(path).map_err(|_| "computer-use session revoked")?)
            .map_err(|e| e.to_string())?;
    if cap.token != token || cap.paused || cap.expires_at <= now() {
        return Err("computer-use session is not active".into());
    }
    Ok(cap)
}

fn renew_capability_activity(expected: &Capability) -> Result<(), String> {
    let path = capability_path()?;
    with_capability_lock(|| {
        let mut current: Capability = serde_json::from_slice(
            &fs::read(&path).map_err(|_| "computer-use session revoked".to_string())?,
        )
        .map_err(|error| error.to_string())?;
        if current.session_id != expected.session_id
            || current.token != expected.token
            || current.paused
        {
            return Err("computer-use session is not active".into());
        }
        let idle_timeout = current.idle_timeout_secs;
        if idle_timeout == 0 {
            return Err("computer-use capability has no idle timeout".into());
        }
        current.expires_at = now().saturating_add(idle_timeout);
        write_capability_atomic(&path, &current)
    })
}

fn start_capability_revocation_watcher(
    capability: &Capability,
) -> Result<(Arc<AtomicBool>, thread::JoinHandle<()>), String> {
    let path = PathBuf::from(
        std::env::var("VERBOO_CU_CAPABILITY_FILE").map_err(|_| "missing capability path")?,
    );
    let expected_session = capability.session_id.clone();
    let expected_token = capability.token.clone();
    let stopped = Arc::new(AtomicBool::new(false));
    let stopped_for_thread = Arc::clone(&stopped);
    let handle = thread::spawn(move || {
        let mut helper_stopped_for_pause = false;
        while !stopped_for_thread.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(20));
            let current = fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Capability>(&bytes).ok());
            let same_live_capability = current.as_ref().is_some_and(|current| {
                current.session_id == expected_session
                    && current.token == expected_token
                    && current.expires_at > now()
            });
            if same_live_capability && !current.as_ref().is_some_and(|current| current.paused) {
                helper_stopped_for_pause = false;
                continue;
            }
            if same_live_capability && helper_stopped_for_pause {
                continue;
            }
            crate::services::computer_use_service::signal_live_helper_stop();
            thread::sleep(Duration::from_millis(250));
            crate::services::computer_use_service::force_kill_live_helper_process();
            if same_live_capability {
                helper_stopped_for_pause = true;
            } else {
                break;
            }
        }
    });
    Ok((stopped, handle))
}

type McpRuntime = ComputerUseEngine;

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
    let (watcher_stop, watcher_handle) = start_capability_revocation_watcher(&cap)?;
    let (service, mut settings) = bootstrap_runtime(&cap)?;
    let mut runtime = McpRuntime::default();
    for line in io::stdin().lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let Some(id) = request.get("id").cloned() else {
            continue;
        };
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let response = match method {
            "initialize" => {
                json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"verboo-computer-use","version":"1"}}})
            }
            "tools/list" => json!({"jsonrpc":"2.0","id":id,"result":{"tools": tools()}}),
            "tools/call" => {
                let result = call_tool(&service, &mut settings, &mut runtime, &request);
                let is_error = result.get("error").is_some_and(|value| !value.is_null());
                json!({"jsonrpc":"2.0","id":id,"result":{"content":tool_content(&result),"isError":is_error}})
            }
            _ => {
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"method not found"}})
            }
        };
        println!("{}", response);
        io::stdout().flush().map_err(|e| e.to_string())?;
    }
    watcher_stop.store(true, Ordering::SeqCst);
    let _ = watcher_handle.join();
    Ok(())
}

fn bootstrap_runtime(
    cap: &Capability,
) -> Result<(ComputerUseService, ComputerUseSettings), String> {
    let service = ComputerUseService::new();
    let bound_app = if capability_app_is_unbound(&cap.app) {
        None
    } else {
        Some(cap.app.clone())
    };
    let settings = ComputerUseSettings {
        enabled: true,
        ..Default::default()
    };
    let req = service
        .request_session_with_id(
            &settings,
            cap.session_id.clone(),
            cap.goal.clone(),
            bound_app,
            ActionScope::Full,
            crate::models::computer_use::ComputerUseTurnBinding {
                conversation_id: cap.conversation_id.clone(),
                executor_model_id: cap.executor_model_id.clone(),
            },
        )
        .map_err(|e| format!("{e:?}"))?;
    service
        .grant_session(ConsentGrant {
            id: req.id,
            allowlist_version: 1,
            self_test_enabled: cap.self_test_enabled,
            screenshot_attach_to_llm: cap.screenshot_attach_to_llm,
            idle_timeout_secs: cap.idle_timeout_secs,
        })
        .map_err(|e| format!("{e:?}"))?;
    sync_runtime_approvals(&service, &settings, cap)?;
    Ok((service, settings))
}

fn sync_runtime_approvals(
    service: &ComputerUseService,
    settings: &ComputerUseSettings,
    cap: &Capability,
) -> Result<(), String> {
    service
        .sessions
        .pause(&cap.session_id)
        .map_err(|error| format!("pause approval sync denied: {error:?}"))?;
    for app in &cap.approved_apps {
        service
            .sessions
            .approve_app(
                &cap.session_id,
                &app.bundle_id,
                &app.display_name,
                app.tier,
                app.sentinel_confirmed,
                settings,
            )
            .map_err(|error| format!("sync approved app denied: {error:?}"))?;
    }
    if !cap.paused {
        service
            .sessions
            .resume(&cap.session_id)
            .map_err(|error| format!("resume approval sync denied: {error:?}"))?;
    }
    Ok(())
}

fn tools() -> Value {
    json!([
      {
        "name":"computer",
        "description":"Inspect and control the approved macOS apps. A fresh screenshot follows each successful action. Coordinates use the pixel grid of the latest screenshot.",
        "inputSchema":{
          "type":"object",
          "additionalProperties":false,
          "properties":{
            "action":{"type":"string","enum":["screenshot","left_click","right_click","middle_click","double_click","triple_click","type","key","hold_key","mouse_move","scroll","left_click_drag","left_mouse_down","left_mouse_up","wait","zoom"]},
            "coordinate":{"type":"array","items":{"type":"integer","minimum":0},"minItems":2,"maxItems":2},
            "start_coordinate":{"type":"array","items":{"type":"integer","minimum":0},"minItems":2,"maxItems":2},
            "text":{"type":"string"},
            "duration":{"type":"number","minimum":0.1,"maximum":60},
            "scroll_amount":{"type":"integer","minimum":1,"maximum":100},
            "scroll_direction":{"enum":["up","down","left","right"]},
            "region":{"type":"array","items":{"type":"integer","minimum":0},"minItems":4,"maxItems":4},
            "modifiers":{"type":"array","items":{"enum":["cmd","ctrl","alt","shift"]},"uniqueItems":true}
          },
          "required":["action"]
        }
      }
    ])
}

fn parse_tool_action(name: &str, args: Value) -> Result<ActionRequest, Value> {
    if name != "computer" {
        return Err(json!({"error":{"code":"unknown_tool","message":"unknown computer-use tool"}}));
    }
    let request: ActionRequest = serde_json::from_value(args).map_err(
        |error| json!({"error":{"code":"invalid_argument","message":error.to_string()}}),
    )?;
    request.validate().map_err(
        |error| json!({"error":{"code":"invalid_argument","message":error.to_string()}}),
    )?;
    Ok(request)
}

/// Resolve the concrete app for an MCP tool call. App approval is a desktop UI
/// operation; the model tool cannot bind or widen an unbound capability.
fn resolve_tool_app(cap: &Capability, args: &Value) -> Result<String, Value> {
    let arg_app = args
        .get("app")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "*")
        .map(ToOwned::to_owned);
    if capability_app_is_unbound(&cap.app) {
        return Err(json!({
            "error": {
                "code": "app_not_selected",
                "message": "No app is approved for this session. Pause Computer Use and approve an app in the desktop UI."
            }
        }));
    }
    if let Some(arg) = arg_app {
        if !arg.eq_ignore_ascii_case(&cap.app) {
            return Err(json!({
                "error": {
                    "code": "app_not_allowlisted",
                    "message": format!("Session is bound to {}; cannot switch to {}", cap.app, arg)
                }
            }));
        }
    }
    Ok(cap.app.clone())
}

fn should_revoke_after_error(code: &str) -> bool {
    matches!(
        code,
        "audit_write_failed"
            | "audit_storage_full"
            | "screen_capture_failed"
            | "os_permission_revoked"
            | "effect_uncertain"
            | "session_revoked"
    )
}

fn call_tool(
    service: &ComputerUseService,
    settings: &mut ComputerUseSettings,
    runtime: &mut McpRuntime,
    request: &Value,
) -> Value {
    let cap = match read_capability() {
        Ok(c) => c,
        Err(e) => return json!({"error":{"code":"session_revoked","message":e}}),
    };
    if let Err(error) = sync_runtime_approvals(service, settings, &cap) {
        return json!({"error":{"code":"app_not_allowlisted","message":error}});
    }
    let name = request
        .pointer("/params/name")
        .and_then(Value::as_str)
        .unwrap_or("");
    let args = request
        .pointer("/params/arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let action = match parse_tool_action(name, args) {
        Ok(action) => action,
        Err(error) => return error,
    };
    let app = match resolve_tool_app(&cap, &json!({})) {
        Ok(a) => a,
        Err(error) => return error,
    };
    let result = dispatch_compat_action(service, settings, runtime, &app, &action);
    // Audit fail-closed: refuse further CU authority for this MCP process by
    // revoking capability files. Never hard-exit — a silent exit(70) left
    // orphan capability/MCP state with no JSON error for the agent loop.
    if let Some(error) = result
        .error
        .as_ref()
        .filter(|error| should_revoke_after_error(&error.code))
    {
        eprintln!(
            "[computer-use-mcp] {} — revoking capability (fail-closed)",
            error.code
        );
        if let Err(error) = revoke() {
            eprintln!("[computer-use-mcp] capability revoke after fatal runtime failure: {error}");
        }
        if error.code == "audit_write_failed" {
            // Force a clear wire error even if serde of the full result fails later.
            return json!({
                "error": {
                    "code": "audit_write_failed",
                    "message": "Audit write failed; Computer Use capability revoked for this session (fail-closed)."
                }
            });
        }
    }
    if result.error.is_none() {
        if let Err(error) = renew_capability_activity(&cap) {
            let _ = revoke();
            return json!({
                "error": {
                    "code": "session_revoked",
                    "message": format!("Computer Use authority could not be renewed: {error}")
                }
            });
        }
    }
    serde_json::to_value(result)
        .unwrap_or_else(|e| json!({"error":{"code":"serialization","message":e.to_string()}}))
}

fn dispatch_compat_action(
    service: &ComputerUseService,
    settings: &mut ComputerUseSettings,
    runtime: &mut McpRuntime,
    app: &str,
    request: &ActionRequest,
) -> ComputerUseResult {
    if request.action == ComputerAction::Screenshot {
        runtime.begin_observation();
        let invocation = service.capture_canonical_screenshot(settings, app);
        return verify_observation_and_finalize(
            service,
            runtime,
            invocation.result,
            invocation.ticket,
        );
    }
    let mut operation = match canonical_helper_request(runtime, app, request) {
        Ok(operation) => operation,
        Err(error) => return json_result_error(error),
    };
    if request.action == ComputerAction::Zoom {
        runtime.begin_observation();
        let invocation = service.invoke_canonical_action(
            settings,
            app,
            request,
            operation.method,
            operation.params,
        );
        return verify_observation_and_finalize(
            service,
            runtime,
            invocation.result,
            invocation.ticket,
        );
    }
    if pointer_confirmation_candidate(request.action) {
        if let Err(result) =
            prepare_pointer_confirmation(service, settings, app, request, &mut operation)
        {
            return result;
        }
    }
    if keyboard_confirmation_candidate(request) {
        if let Err(result) =
            prepare_keyboard_confirmation(service, settings, app, request, &mut operation)
        {
            return result;
        }
    }
    let action_invocation =
        service.invoke_canonical_action(settings, app, request, operation.method, operation.params);
    let mut action_result = action_invocation.result;
    let Some(action_value) = action_result.result.take() else {
        return action_result;
    };
    let Some(action_ticket) = action_invocation.ticket else {
        return ComputerUseResult {
            result: None,
            error: Some(ComputerUseError::new(
                "audit_write_failed",
                "Canonical action completed without an audit verification ticket.",
            )),
        };
    };
    runtime.begin_observation();
    let screenshot_invocation = service.capture_canonical_screenshot(settings, app);
    let mut screenshot_result = screenshot_invocation.result;
    let Some(screenshot_value) = screenshot_result.result.take() else {
        return action_effect_uncertain(
            service,
            action_ticket,
            screenshot_result
                .error
                .as_ref()
                .map(|error| error.code.as_str())
                .unwrap_or("screen_capture_failed"),
        );
    };
    let merged = merge_action_and_screenshot(action_value, screenshot_value);
    let observed = ComputerUseResult {
        result: Some(merged),
        error: None,
    };
    let (observed, verified_screenshot) = remember_or_fail(runtime, observed);
    if let Some(error) = observed.error.as_ref() {
        if let Some(ticket) = screenshot_invocation.ticket {
            if let Err(audit_error) = service.mark_canonical_action_uncertain(ticket, &error.code) {
                return ComputerUseResult {
                    result: None,
                    error: Some(audit_error),
                };
            }
        }
        return action_effect_uncertain(service, action_ticket, &error.code);
    }
    let Some(screenshot_ticket) = screenshot_invocation.ticket else {
        return action_effect_uncertain(service, action_ticket, "missing_screenshot_audit_ticket");
    };
    let Some(verified_screenshot) = verified_screenshot else {
        return action_effect_uncertain(service, action_ticket, "missing_verified_screenshot");
    };
    if let Err(error) =
        service.finalize_canonical_action(screenshot_ticket, Some(&verified_screenshot))
    {
        return ComputerUseResult {
            result: None,
            error: Some(error),
        };
    }
    if let Err(error) = service.finalize_canonical_action(action_ticket, None) {
        return ComputerUseResult {
            result: None,
            error: Some(error),
        };
    }
    observed
}

fn verify_observation_and_finalize(
    service: &ComputerUseService,
    runtime: &mut McpRuntime,
    result: ComputerUseResult,
    ticket: Option<CanonicalActionAuditTicket>,
) -> ComputerUseResult {
    if result.error.is_some() {
        return result;
    }
    let (verified, verified_screenshot) = remember_or_fail(runtime, result);
    let Some(ticket) = ticket else {
        return ComputerUseResult {
            result: None,
            error: Some(ComputerUseError::new(
                "audit_write_failed",
                "Visual observation completed without an audit verification ticket.",
            )),
        };
    };
    if let Some(error) = verified.error.as_ref() {
        return match service.mark_canonical_action_uncertain(ticket, &error.code) {
            Ok(()) => verified,
            Err(audit_error) => ComputerUseResult {
                result: None,
                error: Some(audit_error),
            },
        };
    }
    let Some(verified_screenshot) = verified_screenshot else {
        return match service.mark_canonical_action_uncertain(ticket, "missing_verified_screenshot")
        {
            Ok(()) => ComputerUseResult {
                result: None,
                error: Some(ComputerUseError::new(
                    "effect_uncertain",
                    "A fresh screenshot was not available for audit finalization.",
                )),
            },
            Err(error) => ComputerUseResult {
                result: None,
                error: Some(error),
            },
        };
    };
    if let Err(error) = service.finalize_canonical_action(ticket, Some(&verified_screenshot)) {
        return ComputerUseResult {
            result: None,
            error: Some(error),
        };
    }
    verified
}

fn action_effect_uncertain(
    service: &ComputerUseService,
    ticket: CanonicalActionAuditTicket,
    reason: &str,
) -> ComputerUseResult {
    match service.mark_canonical_action_uncertain(ticket, reason) {
        Ok(()) => ComputerUseResult {
            result: None,
            error: Some(ComputerUseError::new(
                "effect_uncertain",
                "The action may have taken effect, but no fresh verified screenshot was received. It will not be retried automatically.",
            )),
        },
        Err(error) => ComputerUseResult { result: None, error: Some(error) },
    }
}

fn remember_or_fail(
    runtime: &mut McpRuntime,
    result: ComputerUseResult,
) -> (ComputerUseResult, Option<VerifiedScreenshot>) {
    runtime.begin_observation();
    if result.error.is_some() {
        return (result, None);
    }
    match runtime.accept_observation(&result) {
        Ok(verified) => (result, Some(verified)),
        Err(error) => (
            ComputerUseResult {
                result: None,
                error: Some(error),
            },
            None,
        ),
    }
}

fn confirmation_fingerprint(session_id: &str, app: &str, params: &Value, target: &Value) -> String {
    let bytes = serde_json::to_vec(&json!({
        "session_id": session_id,
        "app": app,
        "params": params,
        "target": target,
    }))
    .unwrap_or_default();
    format!("{:x}", Sha256::digest(bytes))
}

fn pointer_confirmation_candidate(action: ComputerAction) -> bool {
    matches!(
        action,
        ComputerAction::LeftClick
            | ComputerAction::RightClick
            | ComputerAction::MiddleClick
            | ComputerAction::DoubleClick
            | ComputerAction::TripleClick
            | ComputerAction::LeftClickDrag
            | ComputerAction::LeftMouseDown
            | ComputerAction::LeftMouseUp
    )
}

fn keyboard_confirmation_candidate(request: &ActionRequest) -> bool {
    matches!(
        request.action,
        ComputerAction::Type | ComputerAction::Key | ComputerAction::HoldKey
    )
}

fn keyboard_inspection_params(operation: &HelperOperation) -> Value {
    let mut params = operation.params.as_object().cloned().unwrap_or_default();
    // Preflight needs target identity only. Never send typed text or key data
    // through the inspection path, where it could accidentally become metadata.
    params.remove("text");
    params.remove("key");
    params.remove("duration");
    Value::Object(params)
}

fn pointer_policy_from_inspection(target: &Value) -> ActionPolicyDecision {
    classify_pointer_target(
        target
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("AXUnknown"),
        target.get("label").and_then(Value::as_str).unwrap_or(""),
        target
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or(""),
        target
            .get("verifiedActionable")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )
}

fn prepare_pointer_confirmation(
    service: &ComputerUseService,
    settings: &mut ComputerUseSettings,
    app: &str,
    request: &ActionRequest,
    operation: &mut HelperOperation,
) -> Result<(), ComputerUseResult> {
    let inspection = service.inspect_pointer(settings, app, operation.params.clone());
    let Some(target) = inspection.result else {
        return Err(inspection);
    };
    let role = target
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("AXUnknown");
    let label = target.get("label").and_then(Value::as_str).unwrap_or("");
    if let Some(params) = operation.params.as_object_mut() {
        params.insert("expected_role".into(), Value::String(role.to_string()));
        params.insert("expected_label".into(), Value::String(label.to_string()));
    }
    let ActionPolicyDecision::Confirm { summary } = pointer_policy_from_inspection(&target) else {
        return Ok(());
    };
    enforce_one_shot_confirmation(service, app, request, &operation.params, &target, &summary)
}

fn prepare_keyboard_confirmation(
    service: &ComputerUseService,
    settings: &mut ComputerUseSettings,
    app: &str,
    request: &ActionRequest,
    operation: &mut HelperOperation,
) -> Result<(), ComputerUseResult> {
    let inspection =
        service.inspect_keyboard_target(settings, app, keyboard_inspection_params(operation));
    let Some(target) = inspection.result else {
        return Err(inspection);
    };
    let role = target
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("AXUnknown");
    let label = target.get("label").and_then(Value::as_str).unwrap_or("");
    let description = target
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("");
    let default_button_label = target
        .get("defaultButtonLabel")
        .and_then(Value::as_str)
        .unwrap_or("");
    let content_state = target
        .get("contentState")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let selection_state = target
        .get("selectionState")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    if let Some(params) = operation.params.as_object_mut() {
        params.insert("expected_role".into(), Value::String(role.to_string()));
        params.insert("expected_label".into(), Value::String(label.to_string()));
        params.insert(
            "expected_content_state".into(),
            Value::String(content_state.to_string()),
        );
        params.insert(
            "expected_selection_state".into(),
            Value::String(selection_state.to_string()),
        );
        params.insert(
            "expected_default_button_label".into(),
            Value::String(default_button_label.to_string()),
        );
    }
    let decision = if request.action == ComputerAction::Type {
        classify_type_target(content_state, selection_state)
    } else {
        classify_keyboard_target(
            request.text.as_deref().unwrap_or_default(),
            request.modifiers.contains(&KeyModifier::Cmd),
            role,
            label,
            description,
            default_button_label,
        )
    };
    let ActionPolicyDecision::Confirm { summary } = decision else {
        return Ok(());
    };
    enforce_one_shot_confirmation(service, app, request, &operation.params, &target, &summary)
}

fn enforce_one_shot_confirmation(
    service: &ComputerUseService,
    app: &str,
    request: &ActionRequest,
    params: &Value,
    target: &Value,
    summary: &str,
) -> Result<(), ComputerUseResult> {
    let store = ConfirmationStore::runtime().map_err(|error| {
        json_result_error(json!({
            "error":{"code":"confirmation_state_failed","message":error}
        }))
    })?;
    let confirmation = OneShotConfirmation {
        app,
        request,
        params,
        target,
        summary,
    };
    enforce_one_shot_confirmation_with_store(service, &store, &confirmation, || {
        read_capability().is_ok()
    })
}

struct OneShotConfirmation<'a> {
    app: &'a str,
    request: &'a ActionRequest,
    params: &'a Value,
    target: &'a Value,
    summary: &'a str,
}

fn enforce_one_shot_confirmation_with_store<F>(
    service: &ComputerUseService,
    store: &ConfirmationStore,
    confirmation: &OneShotConfirmation<'_>,
    mut authority_is_active: F,
) -> Result<(), ComputerUseResult>
where
    F: FnMut() -> bool,
{
    let Some(session) = service.current() else {
        return Err(json_result_error(json!({
            "error":{"code":"no_active_session","message":"Computer Use session is no longer active"}
        })));
    };
    let fingerprint = confirmation_fingerprint(
        &session.id,
        confirmation.app,
        confirmation.params,
        confirmation.target,
    );
    match store.consume(&session.id, &fingerprint).map_err(|error| {
        json_result_error(json!({
            "error":{"code":"confirmation_state_failed","message":error}
        }))
    })? {
        ConfirmationConsumption::Approved if authority_is_active() => Ok(()),
        ConfirmationConsumption::Approved => Err(ComputerUseResult {
            result: None,
            error: Some(ComputerUseError::new(
                "session_revoked",
                "Computer Use authority was revoked before the approved action could run.",
            )),
        }),
        ConfirmationConsumption::Denied => Err(ComputerUseResult {
            result: None,
            error: Some(ComputerUseError::new(
                "confirmation_denied",
                "The user denied this consequential Computer Use action.",
            )),
        }),
        ConfirmationConsumption::Missing => {
            let pending = store
                .request(
                    &session.id,
                    confirmation.app,
                    &serde_json::to_value(confirmation.request.action)
                        .ok()
                        .and_then(|value| value.as_str().map(str::to_string))
                        .unwrap_or_else(|| "pointer_action".into()),
                    confirmation.summary,
                    &fingerprint,
                )
                .map_err(|error| {
                    json_result_error(json!({
                        "error":{"code":"confirmation_state_failed","message":error}
                    }))
                })?;
            match store
                .wait_for_decision(&pending, &mut authority_is_active)
                .map_err(|error| {
                    json_result_error(json!({
                        "error":{"code":"confirmation_state_failed","message":error}
                    }))
                })? {
                ConfirmationWaitOutcome::Approved => Ok(()),
                ConfirmationWaitOutcome::Denied => Err(ComputerUseResult {
                    result: None,
                    error: Some(ComputerUseError::new(
                        "confirmation_denied",
                        "The user denied this consequential Computer Use action.",
                    )),
                }),
                ConfirmationWaitOutcome::Expired => Err(ComputerUseResult {
                    result: None,
                    error: Some(ComputerUseError::new(
                        "confirmation_timeout",
                        "The Computer Use confirmation expired before the user decided.",
                    )),
                }),
                ConfirmationWaitOutcome::AuthorityRevoked => Err(ComputerUseResult {
                    result: None,
                    error: Some(ComputerUseError::new(
                        "session_revoked",
                        "Computer Use authority was revoked while the action was awaiting confirmation.",
                    )),
                }),
            }
        }
    }
}

#[derive(Debug)]
struct HelperOperation {
    method: &'static str,
    params: Value,
}

fn canonical_helper_request(
    runtime: &McpRuntime,
    app: &str,
    request: &ActionRequest,
) -> Result<HelperOperation, Value> {
    let map_coordinate = |coordinate: [u32; 2]| {
        runtime
            .map_latest_coordinate(coordinate)
            .map_err(computer_use_error_value)
    };
    let pointer = |method, coordinate: [u32; 2]| -> Result<HelperOperation, Value> {
        let (x, y) = map_coordinate(coordinate)?;
        target_operation(runtime, method, json!({"app":app,"x":x,"y":y}))
    };
    let modifier_prefix = request
        .modifiers
        .iter()
        .map(|modifier| match modifier {
            KeyModifier::Cmd => "cmd",
            KeyModifier::Ctrl => "ctrl",
            KeyModifier::Alt => "alt",
            KeyModifier::Shift => "shift",
        })
        .collect::<Vec<_>>()
        .join("+");
    match request.action {
        ComputerAction::LeftClick => pointer("left-click", request.coordinate.unwrap()),
        ComputerAction::RightClick => pointer("right-click", request.coordinate.unwrap()),
        ComputerAction::MiddleClick => pointer("middle-click", request.coordinate.unwrap()),
        ComputerAction::DoubleClick => pointer("double-click", request.coordinate.unwrap()),
        ComputerAction::TripleClick => pointer("triple-click", request.coordinate.unwrap()),
        ComputerAction::MouseMove => pointer("mouse-move", request.coordinate.unwrap()),
        ComputerAction::LeftMouseDown => pointer("left-mouse-down", request.coordinate.unwrap()),
        ComputerAction::LeftMouseUp => pointer("left-mouse-up", request.coordinate.unwrap()),
        ComputerAction::LeftClickDrag => {
            let (start_x, start_y) = map_coordinate(request.start_coordinate.unwrap())?;
            let (x, y) = map_coordinate(request.coordinate.unwrap())?;
            target_operation(
                runtime,
                "left-click-drag",
                json!({"app":app,"start_x":start_x,"start_y":start_y,"x":x,"y":y}),
            )
        }
        ComputerAction::Type => target_operation(
            runtime,
            "type-text",
            json!({"app":app,"text":request.text.as_deref().unwrap()}),
        ),
        ComputerAction::Key => {
            let key = request.text.as_deref().unwrap();
            if modifier_prefix.is_empty() {
                target_operation(runtime, "press-key", json!({"app":app,"key":key}))
            } else {
                target_operation(
                    runtime,
                    "hotkey",
                    json!({"app":app,"key":format!("{modifier_prefix}+{key}")}),
                )
            }
        }
        ComputerAction::HoldKey => target_operation(
            runtime,
            "hold-key",
            json!({"app":app,"key":request.text.as_deref().unwrap(),"duration":request.duration.unwrap()}),
        ),
        ComputerAction::Scroll => {
            let (x, y) = map_coordinate(request.coordinate.unwrap())?;
            target_operation(
                runtime,
                "scroll",
                json!({
                    "app":app,
                    "x":x,
                    "y":y,
                    "amount":request.scroll_amount.unwrap(),
                    "direction":request.scroll_direction.unwrap(),
                }),
            )
        }
        ComputerAction::Wait => Ok(HelperOperation {
            method: "wait",
            params: json!({"duration":request.duration.unwrap()}),
        }),
        ComputerAction::Zoom => {
            let [x, y, width, height] = runtime
                .map_latest_region(request.region.unwrap())
                .map_err(computer_use_error_value)?;
            target_operation(
                runtime,
                "zoom",
                json!({
                    "app": app,
                    "capture_frame": {
                        "x": x,
                        "y": y,
                        "width": width,
                        "height": height,
                    },
                    "no_screenshot": false,
                }),
            )
        }
        ComputerAction::Screenshot => Err(json!({
            "error":{"code":"invalid_argument","message":"Screenshot actions do not use a helper operation."}
        })),
    }
}

fn target_operation(
    runtime: &McpRuntime,
    method: &'static str,
    mut params: Value,
) -> Result<HelperOperation, Value> {
    let target = runtime.target_params().map_err(computer_use_error_value)?;
    let Some(params_object) = params.as_object_mut() else {
        return Err(
            json!({"error":{"code":"invalid_argument","message":"Helper parameters must be an object"}}),
        );
    };
    let Some(target_object) = target.as_object() else {
        return Err(
            json!({"error":{"code":"stale_state","message":"Screenshot target metadata is invalid"}}),
        );
    };
    params_object.extend(target_object.clone());
    Ok(HelperOperation { method, params })
}

fn computer_use_error_value(error: ComputerUseError) -> Value {
    json!({"error":{"code":error.code,"message":error.message}})
}

fn merge_action_and_screenshot(action: Value, screenshot: Value) -> Value {
    let mut merged = screenshot.as_object().cloned().unwrap_or_default();
    if let Some(action) = action.as_object() {
        for (key, value) in action {
            if !key.starts_with("screenshot_") {
                merged.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(merged)
}

fn json_result_error(error: Value) -> ComputerUseResult {
    ComputerUseResult {
        result: None,
        error: Some(ComputerUseError::new(
            error
                .pointer("/error/code")
                .and_then(Value::as_str)
                .unwrap_or("invalid_argument"),
            error
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("invalid coordinates"),
        )),
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{ComputerUseAllowlistEntry, ComputerUseScope};
    use base64::Engine as _;

    struct FailingMonitorReader;

    impl io::Read for FailingMonitorReader {
        fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "monitor transport failed",
            ))
        }
    }

    #[test]
    fn config_cleanup_failure_cannot_prevent_authority_revocation() {
        let events = std::cell::RefCell::new(Vec::new());
        let result = revoke_authority_files(
            Path::new("config.json"),
            Path::new("capability.json"),
            |path| {
                events
                    .borrow_mut()
                    .push(format!("remove:{}", path.display()));
                if path == Path::new("config.json") {
                    Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied"))
                } else {
                    Ok(())
                }
            },
            |expected| events.borrow_mut().push(format!("expected:{expected}")),
            || events.borrow_mut().push("clear-handler".into()),
        );

        assert_eq!(result.unwrap().len(), 1);
        assert_eq!(
            *events.borrow(),
            vec![
                "remove:config.json",
                "expected:true",
                "remove:capability.json",
                "clear-handler",
            ]
        );
    }

    #[test]
    fn dual_cleanup_failure_preserves_emergency_handlers_for_live_authority() {
        let events = std::cell::RefCell::new(Vec::new());
        let result = revoke_authority_files(
            Path::new("config.json"),
            Path::new("capability.json"),
            |path| {
                events
                    .borrow_mut()
                    .push(format!("remove:{}", path.display()));
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied"))
            },
            |expected| events.borrow_mut().push(format!("expected:{expected}")),
            || events.borrow_mut().push("clear-handler".into()),
        );

        assert!(result.is_err());
        assert_eq!(
            *events.borrow(),
            vec![
                "remove:config.json",
                "expected:true",
                "remove:capability.json",
                "expected:false",
            ]
        );
    }

    #[test]
    fn capability_unlink_failure_rearms_emergency_handlers() {
        let events = std::cell::RefCell::new(Vec::new());
        let result = revoke_authority_files(
            Path::new("config.json"),
            Path::new("capability.json"),
            |path| {
                events
                    .borrow_mut()
                    .push(format!("remove:{}", path.display()));
                if path == Path::new("capability.json") {
                    Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied"))
                } else {
                    Ok(())
                }
            },
            |expected| events.borrow_mut().push(format!("expected:{expected}")),
            || events.borrow_mut().push("clear-handler".into()),
        );

        assert!(result.is_err());
        assert_eq!(
            *events.borrow(),
            vec![
                "remove:config.json",
                "expected:true",
                "remove:capability.json",
                "expected:false",
            ]
        );
    }

    #[test]
    fn terminal_cleanup_invariant_revokes_authority_before_restoring_runtime() {
        let events = std::cell::RefCell::new(Vec::new());
        let authority_errors = revoke_authority_files(
            Path::new("config.json"),
            Path::new("capability.json"),
            |path| {
                events
                    .borrow_mut()
                    .push(format!("remove:{}", path.display()));
                Ok(())
            },
            |expected| events.borrow_mut().push(format!("expected:{expected}")),
            || events.borrow_mut().push("clear-handler".into()),
        )
        .unwrap();
        let runtime_errors = finish_revocation_cleanup(
            || events.borrow_mut().push("kill-action-helper".into()),
            || {
                events.borrow_mut().push("stop-focus-and-restore".into());
                Ok(())
            },
            || {
                events.borrow_mut().push("clear-confirmation".into());
                Ok(())
            },
            || events.borrow_mut().push("release-machine-owner".into()),
        );

        assert!(authority_errors.is_empty());
        assert!(runtime_errors.is_empty());
        assert_eq!(
            *events.borrow(),
            vec![
                "remove:config.json",
                "expected:true",
                "remove:capability.json",
                "clear-handler",
                "kill-action-helper",
                "stop-focus-and-restore",
                "clear-confirmation",
                "release-machine-owner",
            ]
        );
    }

    #[test]
    fn incident_handler_is_cleared_only_after_authority_is_unlinked() {
        let events = std::cell::RefCell::new(Vec::new());
        revoke_authority_files(
            Path::new("config.json"),
            Path::new("capability.json"),
            |path| {
                events
                    .borrow_mut()
                    .push(format!("remove:{}", path.display()));
                Ok(())
            },
            |expected| events.borrow_mut().push(format!("expected:{expected}")),
            || events.borrow_mut().push("clear-handler".into()),
        )
        .unwrap();

        assert_eq!(
            *events.borrow(),
            vec![
                "remove:config.json",
                "expected:true",
                "remove:capability.json",
                "clear-handler",
            ]
        );
    }

    impl BufRead for FailingMonitorReader {
        fn fill_buf(&mut self) -> io::Result<&[u8]> {
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "monitor transport failed",
            ))
        }

        fn consume(&mut self, _amount: usize) {}
    }

    fn png_base64(dimensions: [u32; 2]) -> String {
        let image = image::DynamicImage::new_rgba8(dimensions[0], dimensions[1]);
        let mut bytes = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut bytes, image::ImageFormat::Png)
            .expect("encode test PNG");
        base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
    }

    #[test]
    fn emergency_monitor_eof_and_read_error_fail_closed() {
        let expected_stop = AtomicBool::new(false);
        let mut eof = io::Cursor::new(Vec::<u8>::new());
        let mut read_error = FailingMonitorReader;

        assert_eq!(
            monitor_stream_requires_fail_closed(&mut eof, &expected_stop),
            Some(SafetyIncidentKind::RuntimeFailure),
        );
        assert_eq!(
            monitor_stream_requires_fail_closed(&mut read_error, &expected_stop),
            Some(SafetyIncidentKind::RuntimeFailure),
        );
    }

    #[test]
    fn emergency_monitor_expected_stop_does_not_emit_an_incident() {
        let expected_stop = AtomicBool::new(true);
        let mut eof = io::Cursor::new(Vec::<u8>::new());

        assert_eq!(
            monitor_stream_requires_fail_closed(&mut eof, &expected_stop),
            None,
        );
    }

    #[test]
    fn global_escape_event_fails_closed() {
        let expected_stop = AtomicBool::new(false);
        let mut event = io::Cursor::new(b"{\"event\":\"emergency-stop\"}\n".to_vec());

        assert_eq!(
            monitor_stream_requires_fail_closed(&mut event, &expected_stop),
            Some(SafetyIncidentKind::EmergencyStop),
        );
    }

    #[test]
    fn helper_incident_callback_is_session_bound_and_one_shot() {
        clear_safety_incident_handler(None);
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls_for_callback = Arc::clone(&calls);
        register_safety_incident_handler(
            "owned-session",
            Arc::new(move |_, _| {
                calls_for_callback.fetch_add(1, Ordering::SeqCst);
            }),
        )
        .unwrap();

        assert_eq!(
            active_action_helper_session_id().as_deref(),
            Some("owned-session")
        );

        assert!(take_safety_incident_handler("foreign-session").is_none());
        let callback = take_safety_incident_handler("owned-session").unwrap();
        callback(SafetyIncidentKind::RuntimeFailure, true);
        assert!(take_safety_incident_handler("owned-session").is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let sequence = Arc::new(Mutex::new(Vec::new()));
        let callback_sequence = Arc::clone(&sequence);
        register_safety_incident_handler(
            "action-helper-session",
            Arc::new(move |_, _| {
                callback_sequence.lock().unwrap().push("callback");
            }),
        )
        .unwrap();

        let cleanup_sequence = Arc::clone(&sequence);
        handle_safety_incident_with_cleanup(
            "action-helper-session",
            "native action helper exited unexpectedly",
            SafetyIncidentKind::RuntimeFailure,
            || {
                cleanup_sequence.lock().unwrap().push("cleanup");
                Ok(true)
            },
        );

        assert_eq!(*sequence.lock().unwrap(), vec!["cleanup", "callback"]);
        assert!(take_safety_incident_handler("action-helper-session").is_none());
        clear_safety_incident_handler(None);
    }

    #[test]
    fn safety_incident_retains_its_handler_until_revocation_is_confirmed() {
        clear_safety_incident_handler(None);
        let revoked = Arc::new(Mutex::new(Vec::new()));
        let revoked_for_callback = Arc::clone(&revoked);
        register_safety_incident_handler(
            "failed-revocation-session",
            Arc::new(move |_, authority_revoked| {
                revoked_for_callback.lock().unwrap().push(authority_revoked);
            }),
        )
        .unwrap();

        handle_safety_incident_with_cleanup(
            "failed-revocation-session",
            "test revocation failure",
            SafetyIncidentKind::RuntimeFailure,
            || Err("remove capability failed".into()),
        );

        assert_eq!(*revoked.lock().unwrap(), vec![false]);
        assert!(safety_incident_callback("failed-revocation-session").is_some());

        handle_safety_incident_with_cleanup(
            "failed-revocation-session",
            "test revocation retry",
            SafetyIncidentKind::RuntimeFailure,
            || Ok(true),
        );

        assert_eq!(*revoked.lock().unwrap(), vec![false, true]);
        assert!(safety_incident_callback("failed-revocation-session").is_none());
    }

    #[test]
    fn safety_incident_reports_session_mismatch_as_failed_revocation() {
        clear_safety_incident_handler(None);
        let revoked = Arc::new(Mutex::new(Vec::new()));
        let revoked_for_callback = Arc::clone(&revoked);
        register_safety_incident_handler(
            "mismatched-revocation-session",
            Arc::new(move |_, authority_revoked| {
                revoked_for_callback.lock().unwrap().push(authority_revoked);
            }),
        )
        .unwrap();

        handle_safety_incident_with_cleanup(
            "mismatched-revocation-session",
            "test session mismatch",
            SafetyIncidentKind::RuntimeFailure,
            || Ok(false),
        );

        assert_eq!(*revoked.lock().unwrap(), vec![false]);
        assert!(safety_incident_callback("mismatched-revocation-session").is_some());
        clear_safety_incident_handler(None);
    }

    fn runtime_with_frame(api: [u32; 2], frame: [f64; 4]) -> McpRuntime {
        let mut runtime = McpRuntime::default();
        runtime
            .accept_observation(&ComputerUseResult {
                result: Some(json!({
                    "screenshot_id":"shot-1",
                    "screenshot_base64":png_base64(api),
                    "screenshot_width":api[0],
                    "screenshot_height":api[1],
                    "display_id":42,
                    "app_pid":1234,
                    "window_frame":{
                        "x":frame[0],
                        "y":frame[1],
                        "width":frame[2],
                        "height":frame[3],
                    }
                })),
                error: None,
            })
            .expect("valid screenshot fixture");
        runtime
    }

    #[test]
    fn failed_screenshot_result_invalidates_the_previous_spatial_authority() {
        let mut runtime = runtime_with_frame([100, 100], [0.0, 0.0, 100.0, 100.0]);
        assert_eq!(runtime.map_latest_coordinate([50, 50]).unwrap(), (50, 50));

        let failed_capture = ComputerUseResult {
            result: None,
            error: Some(ComputerUseError::new(
                "screen_capture_failed",
                "capture failed",
            )),
        };
        let (result, verified) = remember_or_fail(&mut runtime, failed_capture);

        assert_eq!(
            result.error.as_ref().map(|error| error.code.as_str()),
            Some("screen_capture_failed")
        );
        assert!(verified.is_none());
        assert_eq!(
            runtime.map_latest_coordinate([50, 50]).unwrap_err().code,
            "stale_state"
        );
    }

    #[test]
    fn exposes_one_strict_computer_tool() {
        let tool_list = tools();
        let names: Vec<&str> = tool_list
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.get("name")?.as_str())
            .collect();
        assert_eq!(names, vec!["computer"]);
        let schema = &tool_list[0]["inputSchema"];
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], json!(["action"]));
        assert_eq!(
            schema["properties"]["action"]["enum"]
                .as_array()
                .unwrap()
                .len(),
            16
        );
    }

    #[test]
    fn every_effectful_pointer_path_is_preflighted() {
        use ComputerAction::*;

        for action in [
            LeftClick,
            RightClick,
            MiddleClick,
            DoubleClick,
            TripleClick,
            LeftClickDrag,
            LeftMouseDown,
            LeftMouseUp,
        ] {
            assert!(pointer_confirmation_candidate(action), "{action:?}");
        }
        for action in [
            Screenshot, Type, Key, HoldKey, MouseMove, Scroll, Wait, Zoom,
        ] {
            assert!(!pointer_confirmation_candidate(action), "{action:?}");
        }
    }

    #[test]
    fn pointer_policy_uses_native_actionable_evidence() {
        assert_eq!(
            pointer_policy_from_inspection(&json!({
                "role": "AXButton",
                "label": "1",
                "description": "",
                "verifiedActionable": true,
            })),
            ActionPolicyDecision::Allow,
        );
        for target in [
            json!({"role":"AXButton","label":"1","verifiedActionable":false}),
            json!({"role":"AXButton","label":"1"}),
        ] {
            assert!(matches!(
                pointer_policy_from_inspection(&target),
                ActionPolicyDecision::Confirm { .. },
            ));
        }
    }

    #[test]
    fn every_keyboard_mutation_path_is_preflighted() {
        let request = |action: ComputerAction, text: &str| ActionRequest {
            action,
            coordinate: None,
            start_coordinate: None,
            text: Some(text.into()),
            duration: (action == ComputerAction::HoldKey).then_some(0.5),
            scroll_amount: None,
            scroll_direction: None,
            region: None,
            modifiers: Vec::new(),
        };

        assert!(keyboard_confirmation_candidate(&request(
            ComputerAction::Key,
            "space",
        )));
        assert!(keyboard_confirmation_candidate(&request(
            ComputerAction::HoldKey,
            "space",
        )));
        assert!(keyboard_confirmation_candidate(&request(
            ComputerAction::Type,
            "draft",
        )));
    }

    #[test]
    fn tool_adapter_rejects_old_names_and_malformed_actions() {
        let old = parse_tool_action(
            "computer_click",
            json!({"action":"left_click","coordinate":[1,2]}),
        );
        assert_eq!(old.unwrap_err()["error"]["code"], "unknown_tool");

        let malformed = parse_tool_action("computer", json!({"action":"left_click"}));
        assert_eq!(malformed.unwrap_err()["error"]["code"], "invalid_argument");

        let unknown =
            parse_tool_action("computer", json!({"action":"screenshot","unexpected":true}));
        assert_eq!(unknown.unwrap_err()["error"]["code"], "invalid_argument");
    }

    #[test]
    fn tool_adapter_accepts_a_valid_canonical_action() {
        let action = parse_tool_action(
            "computer",
            json!({"action":"scroll","coordinate":[10,20],"scroll_amount":3,"scroll_direction":"down"}),
        )
        .expect("valid canonical action");
        assert_eq!(
            action.action,
            crate::models::computer_use_action::ComputerAction::Scroll
        );
    }

    #[test]
    fn every_mutating_action_maps_to_one_helper_operation() {
        let runtime = runtime_with_frame([1280, 720], [100.0, 200.0, 2560.0, 1440.0]);
        let cases = [
            (
                json!({"action":"left_click","coordinate":[10,20]}),
                "left-click",
            ),
            (
                json!({"action":"right_click","coordinate":[10,20]}),
                "right-click",
            ),
            (
                json!({"action":"middle_click","coordinate":[10,20]}),
                "middle-click",
            ),
            (
                json!({"action":"double_click","coordinate":[10,20]}),
                "double-click",
            ),
            (
                json!({"action":"triple_click","coordinate":[10,20]}),
                "triple-click",
            ),
            (
                json!({"action":"mouse_move","coordinate":[10,20]}),
                "mouse-move",
            ),
            (
                json!({"action":"left_mouse_down","coordinate":[10,20]}),
                "left-mouse-down",
            ),
            (
                json!({"action":"left_mouse_up","coordinate":[10,20]}),
                "left-mouse-up",
            ),
            (
                json!({"action":"left_click_drag","start_coordinate":[1,2],"coordinate":[10,20]}),
                "left-click-drag",
            ),
            (json!({"action":"type","text":"hello"}), "type-text"),
            (json!({"action":"key","text":"enter"}), "press-key"),
            (
                json!({"action":"hold_key","text":"shift","duration":0.5}),
                "hold-key",
            ),
            (
                json!({"action":"scroll","coordinate":[10,20],"scroll_amount":3,"scroll_direction":"right"}),
                "scroll",
            ),
            (json!({"action":"wait","duration":0.5}), "wait"),
        ];
        for (wire, expected_method) in cases {
            let request = parse_tool_action("computer", wire).unwrap();
            let operation =
                canonical_helper_request(&runtime, "com.apple.Notes", &request).unwrap();
            assert_eq!(operation.method, expected_method);
        }
    }

    #[test]
    fn zoom_maps_its_requested_region_to_the_helper() {
        let request = parse_tool_action(
            "computer",
            json!({"action":"zoom","region":[10,20,300,200]}),
        )
        .unwrap();
        let operation = canonical_helper_request(
            &runtime_with_frame([1280, 720], [0.0, 0.0, 1280.0, 720.0]),
            "com.apple.Notes",
            &request,
        )
        .expect("zoom helper operation");
        assert_eq!(operation.method, "zoom");
        assert_eq!(operation.params["app"], "com.apple.Notes");
        assert_eq!(
            operation.params["capture_frame"],
            json!({"x":10.0,"y":20.0,"width":300.0,"height":200.0})
        );
        assert_eq!(operation.params["no_screenshot"], false);
    }

    #[test]
    fn fresh_screenshot_is_merged_without_embedding_png_in_text_metadata() {
        let merged = merge_action_and_screenshot(
            json!({"performed":true}),
            json!({
                "screenshot_id":"fresh",
                "screenshot_base64":"aGVsbG8=",
                "screenshot_mime_type":"image/png",
                "screenshot_width":1280,
                "screenshot_height":720
            }),
        );
        assert_eq!(merged["performed"], true);
        assert_eq!(merged["screenshot_id"], "fresh");
        let content = tool_content(&json!({"result":merged,"error":null}));
        assert_eq!(content.as_array().unwrap().len(), 2);
        assert!(!content[0]["text"].as_str().unwrap().contains("aGVsbG8="));
    }

    #[test]
    fn empty_and_star_app_mean_unbound() {
        assert!(capability_app_is_unbound(""));
        assert!(capability_app_is_unbound("  "));
        assert!(capability_app_is_unbound("*"));
        assert!(!capability_app_is_unbound("com.apple.Notes"));
    }

    #[test]
    fn capability_app_value_normalizes_optional_app() {
        assert_eq!(capability_app_value(None), "");
        assert_eq!(capability_app_value(Some("")), "");
        assert_eq!(capability_app_value(Some("*")), "");
        assert_eq!(
            capability_app_value(Some("  com.apple.Notes  ")),
            "com.apple.Notes"
        );
    }

    #[test]
    fn capability_without_conversation_or_executor_binding_is_rejected() {
        let legacy = json!({
            "session_id": "session",
            "token": "token",
            "app": "com.apple.Notes",
            "goal": "goal",
            "expires_at": now() + 60,
            "idle_timeout_secs": 60,
            "paused": false,
            "screenshot_attach_to_llm": true,
            "isolate_other_apps": true
        });

        assert!(serde_json::from_value::<Capability>(legacy).is_err());
    }

    #[test]
    fn unbound_capability_cannot_be_widened_by_tool_arguments() {
        let cap = Capability {
            session_id: "s".into(),
            conversation_id: "conversation".into(),
            executor_model_id: "vision-executor".into(),
            token: "t".into(),
            app: String::new(),
            approved_apps: Vec::new(),
            self_test_enabled: false,
            goal: "g".into(),
            expires_at: 99,
            idle_timeout_secs: 60,
            paused: false,
            screenshot_attach_to_llm: true,
            isolate_other_apps: true,
            controller_pid: 42,
            compact_layout: true,
            compact_panel_width: 420,
            focus_request_generation: 1,
        };
        let err = resolve_tool_app(&cap, &json!({})).unwrap_err();
        assert_eq!(
            err.pointer("/error/code").and_then(Value::as_str),
            Some("app_not_selected")
        );
        let err = resolve_tool_app(&cap, &json!({"app":"com.apple.Notes"})).unwrap_err();
        assert_eq!(
            err.pointer("/error/code").and_then(Value::as_str),
            Some("app_not_selected")
        );
    }

    #[test]
    fn advisory_owner_lock_excludes_a_second_process_owner() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("owner.lock");
        let first = AdvisoryFileLock::acquire(&path, true).unwrap();
        assert!(AdvisoryFileLock::acquire(&path, true).is_err());
        drop(first);
        assert!(AdvisoryFileLock::acquire(&path, true).is_ok());
    }

    #[test]
    fn advisory_owner_lock_clears_stale_metadata_without_replacing_the_locked_inode() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("owner.lock");
        fs::write(
            &path,
            r#"{"pid":999999,"session_id":"stale","started_at":1}"#,
        )
        .unwrap();
        let mut first = AdvisoryFileLock::acquire(&path, true).unwrap();

        clear_recovered_owner_metadata(&mut first).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "");
        assert!(AdvisoryFileLock::acquire(&path, true).is_err());
        drop(first);
        assert!(AdvisoryFileLock::acquire(&path, true).is_ok());
    }

    #[test]
    fn resolve_tool_app_locks_to_bound_capability() {
        let cap = Capability {
            session_id: "s".into(),
            conversation_id: "conversation".into(),
            executor_model_id: "vision-executor".into(),
            token: "t".into(),
            app: "com.apple.Notes".into(),
            approved_apps: Vec::new(),
            self_test_enabled: false,
            goal: "g".into(),
            expires_at: 99,
            idle_timeout_secs: 60,
            paused: false,
            screenshot_attach_to_llm: true,
            isolate_other_apps: true,
            controller_pid: 42,
            compact_layout: true,
            compact_panel_width: 420,
            focus_request_generation: 1,
        };
        assert_eq!(
            resolve_tool_app(&cap, &json!({})).unwrap(),
            "com.apple.Notes"
        );
        let err = resolve_tool_app(&cap, &json!({"app":"com.google.Chrome"})).unwrap_err();
        assert_eq!(
            err.pointer("/error/code").and_then(Value::as_str),
            Some("app_not_allowlisted")
        );
    }

    #[test]
    fn capability_is_bound_to_one_session_and_expiry() {
        let cap = Capability {
            session_id: "authorized".into(),
            conversation_id: "conversation".into(),
            executor_model_id: "vision-executor".into(),
            token: "token".into(),
            app: "com.apple.Notes".into(),
            approved_apps: Vec::new(),
            self_test_enabled: false,
            goal: "goal".into(),
            expires_at: 20,
            idle_timeout_secs: 60,
            paused: false,
            screenshot_attach_to_llm: true,
            isolate_other_apps: true,
            controller_pid: 42,
            compact_layout: true,
            compact_panel_width: 420,
            focus_request_generation: 1,
        };
        assert!(capability_is_active(&cap, "authorized", 19));
        assert!(!capability_is_active(&cap, "another-turn", 19));
        assert!(!capability_is_active(&cap, "authorized", 20));
        // Unbound goal-directed capability is still active for its session.
        let unbound = Capability {
            app: String::new(),
            ..cap.clone()
        };
        assert!(capability_is_active(&unbound, "authorized", 19));
    }

    #[test]
    fn mcp_runtime_reconstructs_full_session_scope_and_enforces_each_app_tier() {
        use crate::models::computer_use::{ActionVerdict, DenyCode};
        use crate::services::session_manager::ActionKind;

        let browser = Capability {
            session_id: "browser".into(),
            conversation_id: "conversation".into(),
            executor_model_id: "vision-executor".into(),
            token: "token".into(),
            app: "com.apple.Safari".into(),
            approved_apps: Vec::new(),
            self_test_enabled: false,
            goal: "inspect page".into(),
            expires_at: now() + 60,
            idle_timeout_secs: 60,
            paused: false,
            screenshot_attach_to_llm: true,
            isolate_other_apps: true,
            controller_pid: 42,
            compact_layout: true,
            compact_panel_width: 420,
            focus_request_generation: 1,
        };
        let (browser_service, mut browser_settings) = bootstrap_runtime(&browser).unwrap();
        assert_eq!(
            browser_service.sessions.check_action(
                &mut browser_settings,
                Some("com.apple.Safari"),
                ActionKind::Read,
                ComputerUseScope::View,
            ),
            ActionVerdict::Allow,
        );
        assert_eq!(
            browser_service.sessions.check_action(
                &mut browser_settings,
                Some("com.apple.Safari"),
                ActionKind::Mutate,
                ComputerUseScope::Input,
            ),
            ActionVerdict::Deny(DenyCode::ScopeDenied),
        );

        let notes = Capability {
            app: "com.apple.Notes".into(),
            ..browser
        };
        let (notes_service, mut notes_settings) = bootstrap_runtime(&notes).unwrap();
        assert_eq!(
            notes_service.sessions.check_action(
                &mut notes_settings,
                Some("com.apple.Notes"),
                ActionKind::Mutate,
                ComputerUseScope::Full,
            ),
            ActionVerdict::Allow,
        );
    }

    #[test]
    fn capability_switch_requires_an_explicitly_approved_app() {
        use crate::models::computer_use::{AppControlTier, ApprovedApp};

        let mut cap = Capability {
            session_id: "multi-app".into(),
            conversation_id: "conversation".into(),
            executor_model_id: "vision-executor".into(),
            token: "token".into(),
            app: "com.apple.Notes".into(),
            approved_apps: vec![ApprovedApp {
                bundle_id: "com.apple.Notes".into(),
                display_name: "Notes".into(),
                tier: AppControlTier::FullControl,
                approved_at_wall: 1,
                sentinel_confirmed: false,
            }],
            self_test_enabled: false,
            goal: "copy between apps".into(),
            expires_at: now() + 60,
            idle_timeout_secs: 60,
            paused: false,
            screenshot_attach_to_llm: true,
            isolate_other_apps: true,
            controller_pid: 42,
            compact_layout: true,
            compact_panel_width: 420,
            focus_request_generation: 1,
        };

        assert!(select_capability_app_value(&mut cap, "com.google.Chrome").is_err());
        cap.approved_apps.push(ApprovedApp {
            bundle_id: "com.google.Chrome".into(),
            display_name: "Google Chrome".into(),
            tier: AppControlTier::ViewOnly,
            approved_at_wall: 2,
            sentinel_confirmed: false,
        });
        select_capability_app_value(&mut cap, "com.google.Chrome").unwrap();
        assert_eq!(cap.app, "com.google.Chrome");
    }

    #[test]
    fn capability_cannot_be_widened_until_the_session_is_paused() {
        use crate::models::computer_use::{AppControlTier, ApprovedApp};

        let approved_app = ApprovedApp {
            bundle_id: "com.google.Chrome".into(),
            display_name: "Google Chrome".into(),
            tier: AppControlTier::ViewOnly,
            approved_at_wall: 2,
            sentinel_confirmed: false,
        };
        let mut cap = Capability {
            session_id: "multi-app".into(),
            conversation_id: "conversation".into(),
            executor_model_id: "vision-executor".into(),
            token: "token".into(),
            app: "com.apple.Notes".into(),
            approved_apps: Vec::new(),
            self_test_enabled: false,
            goal: "copy between apps".into(),
            expires_at: now() + 60,
            idle_timeout_secs: 60,
            paused: false,
            screenshot_attach_to_llm: true,
            isolate_other_apps: true,
            controller_pid: 42,
            compact_layout: true,
            compact_panel_width: 420,
            focus_request_generation: 1,
        };

        assert!(approve_capability_app(&mut cap, "multi-app", approved_app.clone()).is_err());
        assert!(cap.approved_apps.is_empty());
        assert_eq!(cap.app, "com.apple.Notes");

        cap.paused = true;
        approve_capability_app(&mut cap, "multi-app", approved_app).unwrap();
        assert_eq!(cap.app, "com.google.Chrome");
        assert_eq!(cap.approved_apps.len(), 1);
    }

    #[test]
    fn capability_updates_are_atomic_and_private() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("capability.json");
        let cap = Capability {
            session_id: "atomic".into(),
            conversation_id: "conversation".into(),
            executor_model_id: "vision-executor".into(),
            token: "secret".into(),
            app: "com.apple.Notes".into(),
            approved_apps: Vec::new(),
            self_test_enabled: false,
            goal: "test".into(),
            expires_at: now() + 60,
            idle_timeout_secs: 60,
            paused: false,
            screenshot_attach_to_llm: true,
            isolate_other_apps: true,
            controller_pid: 42,
            compact_layout: true,
            compact_panel_width: 420,
            focus_request_generation: 1,
        };
        write_capability_atomic(&path, &cap).unwrap();
        let stored: Capability = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored.session_id, "atomic");
        assert_eq!(stored.token, "secret");
        assert_eq!(stored.controller_pid, 42);
        assert!(stored.compact_layout);
        assert_eq!(stored.compact_panel_width, 420);
        assert_eq!(stored.focus_request_generation, 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn computer_use_confirmation_focus_request_is_session_bound_and_monotonic() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("capability.json");
        let cap = Capability {
            session_id: "confirmation-session".into(),
            conversation_id: "conversation".into(),
            executor_model_id: "vision-executor".into(),
            token: "secret".into(),
            app: "com.apple.Notes".into(),
            approved_apps: Vec::new(),
            self_test_enabled: false,
            goal: "test".into(),
            expires_at: now() + 60,
            idle_timeout_secs: 60,
            paused: false,
            screenshot_attach_to_llm: true,
            isolate_other_apps: true,
            controller_pid: 42,
            compact_layout: true,
            compact_panel_width: 420,
            focus_request_generation: 7,
        };
        write_capability_atomic(&path, &cap).unwrap();

        request_target_focus_at(&path, "confirmation-session").unwrap();
        let stored: Capability = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored.focus_request_generation, 8);

        assert!(request_target_focus_at(&path, "another-session").is_err());
        let unchanged: Capability = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(unchanged.focus_request_generation, 8);
    }

    #[test]
    #[ignore = "operates the real macOS Notes app"]
    #[cfg(target_os = "macos")]
    fn notes_read_smoke_runs_through_mcp_and_writes_audit() {
        let cap_file = tempfile::NamedTempFile::new().unwrap();
        let cap = Capability {
            session_id: "smoke".into(),
            conversation_id: "conversation".into(),
            executor_model_id: "vision-executor".into(),
            token: "smoke-token".into(),
            app: "com.apple.Notes".into(),
            approved_apps: Vec::new(),
            self_test_enabled: false,
            goal: "read Notes".into(),
            expires_at: now() + 60,
            idle_timeout_secs: 60,
            paused: false,
            screenshot_attach_to_llm: true,
            isolate_other_apps: true,
            controller_pid: 42,
            compact_layout: true,
            compact_panel_width: 420,
            focus_request_generation: 1,
        };
        fs::write(cap_file.path(), serde_json::to_vec(&cap).unwrap()).unwrap();
        std::env::set_var("VERBOO_CU_TOKEN", "smoke-token");
        std::env::set_var("VERBOO_CU_CAPABILITY_FILE", cap_file.path());

        let service = ComputerUseService::new();
        let mut settings = ComputerUseSettings {
            enabled: true,
            allowlist: vec![ComputerUseAllowlistEntry {
                bundle_id: cap.app.clone(),
                display_name: "Notes".into(),
                scope: ComputerUseScope::Input,
                ..Default::default()
            }],
            ..Default::default()
        };
        let request = service
            .request_session(
                &settings,
                "read Notes",
                Some(cap.app.clone()),
                ActionScope::Input,
            )
            .unwrap();
        let session = service
            .grant_session(ConsentGrant {
                id: request.id,
                allowlist_version: 1,
                self_test_enabled: false,
                screenshot_attach_to_llm: false,
                idle_timeout_secs: 60,
            })
            .unwrap();
        let response = call_tool(
            &service,
            &mut settings,
            &mut McpRuntime::default(),
            &json!({"params":{"name":"computer","arguments":{"action":"screenshot"}}}),
        );
        assert!(
            response.get("error").is_none_or(Value::is_null),
            "{response}"
        );
        assert!(response
            .pointer("/result/tree")
            .and_then(Value::as_str)
            .unwrap_or("")
            .contains("AXTextArea"));
        assert!(
            service
                .audit
                .as_ref()
                .unwrap()
                .count_for_session(&session.id)
                .unwrap()
                >= 2
        );
    }

    #[test]
    fn screenshot_coordinates_map_back_to_absolute_window_space() {
        let runtime = runtime_with_frame([100, 100], [100.0, 200.0, 200.0, 200.0]);
        assert_eq!(runtime.map_latest_coordinate([25, 50]).unwrap(), (150, 300));
    }

    #[test]
    fn screenshot_coordinates_use_independent_axes_and_reject_the_outer_edge() {
        let mut runtime = McpRuntime::default();
        runtime
            .accept_observation(&ComputerUseResult {
                result: Some(json!({
                    "screenshot_id":"independent-axes",
                    "screenshot_base64":png_base64([800, 700]),
                    "display_id":77,
                    "app_pid":9001,
                    "window_frame":{"x":-500,"y":100,"width":1000,"height":777},
                    "screenshot_width":800,
                    "screenshot_height":700
                })),
                error: None,
            })
            .unwrap();
        assert_eq!(runtime.map_latest_coordinate([400, 350]).unwrap(), (0, 489));
        assert!(runtime.map_latest_coordinate([800, 350]).is_err());
        assert!(runtime.map_latest_coordinate([400, 700]).is_err());
    }

    #[test]
    fn every_targeted_operation_carries_the_screenshot_pid_and_window_frame() {
        let runtime = runtime_with_frame([100, 100], [-50.0, 25.0, 200.0, 300.0]);
        let request = parse_tool_action(
            "computer",
            json!({"action":"left_click","coordinate":[10,20]}),
        )
        .unwrap();

        let operation = canonical_helper_request(&runtime, "com.apple.Notes", &request).unwrap();

        assert_eq!(operation.params["expected_screenshot_id"], "shot-1");
        assert_eq!(operation.params["expected_pid"], 1234);
        assert_eq!(operation.params["expected_window_frame"]["x"], -50.0);
        assert_eq!(operation.params["expected_window_frame"]["height"], 300.0);
    }

    #[test]
    fn targeted_actions_require_a_prior_fresh_screenshot() {
        let request =
            parse_tool_action("computer", json!({"action":"type","text":"hello"})).unwrap();

        let error = canonical_helper_request(&McpRuntime::default(), "com.apple.Notes", &request)
            .expect_err("an action without screenshot identity must fail closed");

        assert_eq!(error["error"]["code"], "stale_state");
    }

    /// When audit storage is unavailable, tools fail closed with
    /// `audit_write_failed`. MCP must never hard-exit on that path
    /// (regression guard for the removed exit(70)).
    #[test]
    fn audit_write_failed_returns_structured_error_without_process_exit() {
        let service = crate::services::computer_use_service::service_for_test_without_audit();
        let mut settings = ComputerUseSettings {
            enabled: true,
            allowlist: vec![ComputerUseAllowlistEntry {
                bundle_id: "com.apple.Notes".into(),
                display_name: "Notes".into(),
                scope: ComputerUseScope::Input,
                ..Default::default()
            }],
            ..Default::default()
        };
        let req = service
            .sessions
            .request_session(
                &settings,
                "audit fail",
                Some("com.apple.Notes".into()),
                ActionScope::Input,
            )
            .expect("request");
        let _session = service
            .grant_session(ConsentGrant {
                id: req.id,
                allowlist_version: 1,
                self_test_enabled: false,
                screenshot_attach_to_llm: false,
                idle_timeout_secs: 60,
            })
            .expect("grant");

        // Audit None → pending write fails before helper spawn.
        let response = service.get_app_state(&mut settings, "com.apple.Notes", true);
        assert_eq!(
            response.error.as_ref().map(|e| e.code.as_str()),
            Some("audit_write_failed"),
            "missing audit DB must fail closed: {response:?}"
        );
        // Reaching this assertion proves we did not process::exit(70).
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
        assert!(!list[0]
            .get("text")
            .and_then(Value::as_str)
            .unwrap()
            .contains("aGVsbG8="));
        assert_eq!(
            list[1],
            json!({"type":"image","data":"aGVsbG8=","mimeType":"image/png"})
        );
    }

    #[test]
    fn fatal_runtime_errors_revoke_the_capability() {
        assert!(should_revoke_after_error("audit_write_failed"));
        assert!(should_revoke_after_error("audit_storage_full"));
        assert!(should_revoke_after_error("screen_capture_failed"));
        assert!(should_revoke_after_error("os_permission_revoked"));
        assert!(should_revoke_after_error("session_revoked"));
        assert!(!should_revoke_after_error("invalid_argument"));
        assert!(!should_revoke_after_error("scope_denied"));
    }

    #[test]
    fn consequential_confirmation_fingerprint_is_bound_to_target_and_coordinate() {
        let first = confirmation_fingerprint(
            "session",
            "com.apple.Notes",
            &json!({"x":10,"y":20}),
            &json!({"role":"AXButton","label":"Send"}),
        );
        assert_eq!(
            first,
            confirmation_fingerprint(
                "session",
                "com.apple.Notes",
                &json!({"x":10,"y":20}),
                &json!({"role":"AXButton","label":"Send"}),
            )
        );
        assert_ne!(
            first,
            confirmation_fingerprint(
                "session",
                "com.apple.Notes",
                &json!({"x":11,"y":20}),
                &json!({"role":"AXButton","label":"Send"}),
            )
        );
        assert_ne!(
            first,
            confirmation_fingerprint(
                "session",
                "com.apple.Notes",
                &json!({"x":10,"y":20}),
                &json!({"role":"AXButton","label":"Delete"}),
            )
        );
    }

    #[test]
    fn consequential_action_waits_and_resumes_inside_the_same_mcp_invocation() {
        let cap = Capability {
            session_id: "session-confirmation".into(),
            conversation_id: "conversation-confirmation".into(),
            executor_model_id: "vision-executor".into(),
            token: "test-token".into(),
            app: "com.apple.Calculator".into(),
            approved_apps: Vec::new(),
            self_test_enabled: false,
            goal: "Calculate 1 + 1".into(),
            expires_at: now() + 60,
            idle_timeout_secs: 60,
            paused: false,
            screenshot_attach_to_llm: true,
            isolate_other_apps: true,
            controller_pid: 42,
            compact_layout: true,
            compact_panel_width: 420,
            focus_request_generation: 1,
        };
        let (service, _) = bootstrap_runtime(&cap).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let store = ConfirmationStore::at(directory.path().to_path_buf());
        let waiter_store = store.clone();
        let request = parse_tool_action(
            "computer",
            json!({"action":"left_click","coordinate":[10,20]}),
        )
        .unwrap();
        let (result_tx, result_rx) = std::sync::mpsc::channel();

        let waiter = std::thread::spawn(move || {
            let result = enforce_one_shot_confirmation_with_store(
                &service,
                &waiter_store,
                &OneShotConfirmation {
                    app: "com.apple.Calculator",
                    request: &request,
                    params: &json!({"x":10,"y":20,"expected_role":"AXButton","expected_label":"1"}),
                    target: &json!({"role":"AXButton","label":"1"}),
                    summary: "Activate AXButton control '1'",
                },
                || true,
            );
            result_tx.send(result).unwrap();
        });

        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        let pending = loop {
            if let Some(pending) = store.pending("session-confirmation").unwrap() {
                break pending;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "confirmation was not published"
            );
            std::thread::sleep(Duration::from_millis(5));
        };
        assert!(result_rx.recv_timeout(Duration::from_millis(40)).is_err());

        store
            .decide("session-confirmation", &pending.id, true)
            .unwrap();
        assert!(result_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .is_ok());
        waiter.join().unwrap();
    }

    #[test]
    fn keyboard_preflight_inspects_key_actions_and_plain_typing() {
        let parse = |value| serde_json::from_value::<ActionRequest>(value).unwrap();
        assert!(keyboard_confirmation_candidate(&parse(json!({
            "action":"key", "text":"s", "modifiers":["cmd"]
        }))));
        assert!(keyboard_confirmation_candidate(&parse(json!({
            "action":"key", "text":"ENTER"
        }))));
        assert!(keyboard_confirmation_candidate(&parse(json!({
            "action":"key", "text":"tab"
        }))));
        assert!(keyboard_confirmation_candidate(&parse(json!({
            "action":"type", "text":"save"
        }))));
    }

    #[test]
    fn keyboard_preflight_never_forwards_typed_text_as_inspection_metadata() {
        let request = serde_json::from_value::<ActionRequest>(json!({
            "action":"type", "text":"private draft contents"
        }))
        .unwrap();
        let operation = canonical_helper_request(
            &runtime_with_frame([1280, 720], [0.0, 0.0, 1280.0, 720.0]),
            "com.apple.Notes",
            &request,
        )
        .unwrap();
        let inspection = keyboard_inspection_params(&operation);

        assert_eq!(inspection["app"], "com.apple.Notes");
        assert!(inspection.get("expected_pid").is_some());
        assert!(inspection.get("text").is_none());
        assert!(!inspection.to_string().contains("private draft contents"));
    }
}
