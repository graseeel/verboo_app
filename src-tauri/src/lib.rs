mod models;
mod services;

pub fn run_computer_use_mcp() -> Result<(), String> {
    services::computer_use_mcp::run_stdio()
}

use std::sync::Mutex;

use models::types::*;
use services::cli_service::CliService;
use services::credentials_store::CredentialsStore;
use services::model_service::ModelService;
use services::profile_service::ProfileService;
use services::settings_store::SettingsStore;
use services::terminal_service::TerminalService;
use services::turn_service::TurnService;
use tauri::{Emitter, Manager};

// ════════════════════════════════════════════════════════════════════
// AppState — will be fleshed out in later phases
// ════════════════════════════════════════════════════════════════════

struct AppState {
    config: Mutex<AppConfig>,
    // Settings are managed separately via SettingsStore (persistent).
}

impl AppState {
    fn new() -> Self {
        Self {
            config: Mutex::new(AppConfig::default()),
        }
    }
}

// ── Helper wrapper for evaluate_goal return type ────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvaluationResult {
    evaluation: GoalEvaluationResult,
    /// Legacy bridge field populated from evaluation.nextAction.
    /// FE should migrate to reading evaluation.nextAction directly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    user_message: Option<String>,
}

impl From<crate::services::goal_evaluator::EvaluationResult> for EvaluationResult {
    fn from(value: crate::services::goal_evaluator::EvaluationResult) -> Self {
        let user_message = value.evaluation.next_action.clone();
        Self {
            evaluation: value.evaluation,
            user_message,
        }
    }
}

// ════════════════════════════════════════════════════════════════════
// Config
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
fn get_config(
    state: tauri::State<'_, AppState>,
    settings_store: tauri::State<'_, SettingsStore>,
) -> Result<AppConfig, String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    // Refresh access_mode from persisted settings (matches Electron's
    // `accessMode: (await userSettings.getSettings()).defaultAccessMode`).
    let settings = settings_store.get()?;
    config.access_mode = settings.default_access_mode.clone();
    Ok(config.clone())
}

// ════════════════════════════════════════════════════════════════════
// Auth
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
fn start_cli_login(cli: tauri::State<'_, CliService>) -> Result<LoginResult, String> {
    cli.start_cli_login()
}

#[tauri::command]
fn get_cli_auth_status(cli: tauri::State<'_, CliService>) -> Result<CliAuthStatus, String> {
    cli.get_auth_status()
}

#[tauri::command]
fn logout(
    cli: tauri::State<'_, CliService>,
    credentials: tauri::State<'_, CredentialsStore>,
    model_service: tauri::State<'_, ModelService>,
) -> Result<LoginResult, String> {
    // Logout must clear BOTH credentials — the CLI's OAuth session AND the
    // app's stored API key. Otherwise the user "comes back logged in" after
    // logout because the API key persists in the keychain. Mirrors
    // Electron's `logout()` + `clearApiKey()` (cliCredentials.ts + auth.ts).
    let result = cli.logout();
    // Always attempt to clear the API key, even if CLI logout failed — the
    // user's intent is to log out, so we shouldn't leave half a session.
    let _ = credentials.clear_api_key();
    // Also drop the model cache (B3): otherwise a follow-up "I already
    // authenticated" re-unlocks the app from stale cached models even though
    // there are no credentials left.
    model_service.clear_cache();
    result
}

#[tauri::command]
fn open_dashboard(app: tauri::AppHandle) -> Result<bool, String> {
    open_external_url(&app, "https://code.verboo.ai/pt/dashboard")
}

#[tauri::command]
fn open_subscriptions(app: tauri::AppHandle) -> Result<bool, String> {
    open_external_url(&app, "https://code.verboo.ai/pt/subscriptions")
}

#[tauri::command]
fn open_signup(app: tauri::AppHandle) -> Result<bool, String> {
    // Mirrors Electron's VERBOO_SIGNUP_URL (src/main/index.ts:62).
    open_external_url(
        &app,
        "https://code.verboo.ai/pt?ref=32d0ad85-a132-47cd-ae6d-b1f9c5e92228&utm_source=referral&utm_medium=whatsapp&utm_campaign=referral_program&utm_content=32d0ad85-a132-47cd-ae6d-b1f9c5e92228",
    )
}

/// Opens `url` in the user's default browser. Mirrors Electron's
/// `shell.openExternal` (src/main/index.ts:181-194). Returns true on success.
fn open_external_url(app: &tauri::AppHandle, url: &str) -> Result<bool, String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map(|()| true)
        .map_err(|e| format!("Falha ao abrir URL: {e}"))
}

// ════════════════════════════════════════════════════════════════════
// Credentials
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
fn get_credential_status(
    credentials: tauri::State<'_, CredentialsStore>,
) -> Result<CredentialStatus, String> {
    credentials.get_status()
}

#[tauri::command]
fn set_api_key(
    api_key: String,
    credentials: tauri::State<'_, CredentialsStore>,
) -> Result<CredentialStatus, String> {
    credentials.set_api_key(api_key)
}

#[tauri::command]
fn clear_api_key(
    credentials: tauri::State<'_, CredentialsStore>,
) -> Result<CredentialStatus, String> {
    credentials.clear_api_key()
}

// ════════════════════════════════════════════════════════════════════
// Models
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
fn list_models(
    force_refresh: bool,
    model_service: tauri::State<'_, ModelService>,
    _credentials: tauri::State<'_, CredentialsStore>,
) -> Result<ModelDiscoveryResult, String> {
    // Resolve CLI OAuth token first (with refresh), fall back to API key.
    // The CLI token gives models with `display_name` (rich names); the API
    // key gives models without `display_name` (raw ids like "glm-5.2").
    let credentials_fresh = CredentialsStore::new();
    let token = crate::services::auth_token::resolve_token(&credentials_fresh);
    model_service.list_models(token.as_deref(), force_refresh)
}

// ════════════════════════════════════════════════════════════════════
// Profile
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
async fn get_profile(
    _credentials: tauri::State<'_, CredentialsStore>,
) -> Result<ProfileResult, String> {
    // Resolve the bearer token (CLI OAuth first, API key fallback) on a
    // blocking thread — the CLI token read may hit the keychain, and the
    // refresh may POST to /oauth/token. The `_credentials` parameter
    // is unused at runtime (we instantiate a fresh `CredentialsStore`
    // inside the spawned task so it can cross the await boundary), but
    // we still declare it so Tauri's command resolver continues to find
    // the dependency in the state graph.
    let credentials_clone = CredentialsStore::new();
    let token = tokio::task::spawn_blocking(move || {
        crate::services::auth_token::resolve_token(&credentials_clone)
    })
    .await
    .map_err(|e| format!("Falha ao resolver token: {e}"))?;
    let svc = ProfileService::new();
    // Run the HTTP fetches on a blocking thread — reqwest::blocking panics
    // if called from an async runtime.
    let result = tokio::task::spawn_blocking(move || svc.get_profile(token.as_deref()))
        .await
        .map_err(|e| format!("Falha ao carregar perfil: {e}"))?;
    Ok(result)
}

// ════════════════════════════════════════════════════════════════════
// Feedback
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
fn send_feedback(
    request: FeedbackRequest,
    app: tauri::AppHandle,
) -> Result<FeedbackResult, String> {
    use tauri_plugin_opener::OpenerExt;
    let app_version = app.package_info().version.to_string();
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    };
    let app_for_url = app.clone();
    Ok(
        crate::services::feedback_service::FeedbackService::send_feedback(
            request,
            &app_version,
            platform,
            |url| match app_for_url.opener().open_url(url, None::<&str>) {
                Ok(_) => Ok(()),
                Err(e) => Err(format!("Falha ao abrir URL: {e}")),
            },
        ),
    )
}

// ════════════════════════════════════════════════════════════════════
// Settings
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
fn get_user_settings(store: tauri::State<'_, SettingsStore>) -> Result<UserSettings, String> {
    store.get()
}

#[tauri::command]
fn update_user_settings(
    patch: serde_json::Value,
    store: tauri::State<'_, SettingsStore>,
    tray: tauri::State<'_, crate::services::tray_service::TrayService>,
    updates: tauri::State<'_, crate::services::update_service::UpdateService>,
    cu: tauri::State<'_, crate::services::computer_use_service::ComputerUseService>,
    app: tauri::AppHandle,
) -> Result<UserSettings, String> {
    let next = store.update(patch)?;
    apply_runtime_settings(&next, &tray, &updates, &cu, &app);
    Ok(next)
}

#[tauri::command]
fn reset_user_settings(
    store: tauri::State<'_, SettingsStore>,
    tray: tauri::State<'_, crate::services::tray_service::TrayService>,
    updates: tauri::State<'_, crate::services::update_service::UpdateService>,
    cu: tauri::State<'_, crate::services::computer_use_service::ComputerUseService>,
    app: tauri::AppHandle,
) -> Result<UserSettings, String> {
    let next = store.reset()?;
    // Reset must also re-apply side effects (tray visible again, update flags).
    apply_runtime_settings(&next, &tray, &updates, &cu, &app);
    Ok(next)
}

// ════════════════════════════════════════════════════════════════════
// Computer Use (P0, Geralt)
// ════════════════════════════════════════════════════════════════════

fn emit_computer_use_state(app: &tauri::AppHandle, session: &crate::models::computer_use::Session) {
    use tauri::Emitter;
    let _ = app.emit("computer-use:state-change", session);
}

fn computer_use_lifecycle_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

fn acquire_computer_use_lifecycle() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    computer_use_lifecycle_lock()
        .lock()
        .map_err(|_| "Computer Use lifecycle lock is unavailable".to_string())
}

fn show_computer_use_notification(app: &tauri::AppHandle, settings: &UserSettings, started: bool) {
    use crate::models::types::{CompletionNotificationMode, LanguageCode};
    use tauri_plugin_notification::NotificationExt;

    if settings.completion_notifications == CompletionNotificationMode::Never {
        return;
    }
    let (title, body) = match (settings.language, started) {
        (LanguageCode::PtBr, true) => ("Computer Use ativo", "Pressione Esc para parar."),
        (LanguageCode::PtBr, false) => ("Computer Use concluído", "O controle da tela terminou."),
        (LanguageCode::EnUs, true) => ("Computer Use active", "Press Esc to stop."),
        (LanguageCode::EnUs, false) => ("Computer Use finished", "Screen control has ended."),
    };
    if let Err(error) = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .auto_cancel()
        .show()
    {
        eprintln!("[computer-use] notification failed: {error}");
    }
}

fn visual_executor_lease_store(
    app: &tauri::AppHandle,
) -> Result<crate::services::computer_use_executor::VisualExecutorLeaseStore, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(
        crate::services::computer_use_executor::VisualExecutorLeaseStore::new(
            app_data.join("computer-use-runtime"),
        ),
    )
}

#[tauri::command]
fn select_computer_use_executor(
    current_model_id: String,
    preferred_visual_model_id: Option<String>,
    model_service: tauri::State<'_, ModelService>,
) -> Result<serde_json::Value, String> {
    use crate::services::computer_use_executor::{select_executor, ExecutorChoice};
    let catalog = model_service.cached_catalog()?;
    let choice = select_executor(
        &current_model_id,
        &catalog,
        preferred_visual_model_id.as_deref(),
    )
    .map_err(|error| error.to_string())?;
    Ok(match choice {
        ExecutorChoice::Current { model_id } => {
            serde_json::json!({ "modelId": model_id, "temporary": false })
        }
        ExecutorChoice::TemporaryVision {
            vision_model_id, ..
        } => serde_json::json!({ "modelId": vision_model_id, "temporary": true }),
    })
}

#[tauri::command]
fn persist_computer_use_executor_lease(
    app: tauri::AppHandle,
    model_service: tauri::State<'_, ModelService>,
    conversation_id: String,
    original_model_id: String,
    executor_model_id: String,
    expires_at_ms: u64,
) -> Result<crate::services::computer_use_executor::VisualExecutorLease, String> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    if conversation_id.trim().is_empty()
        || original_model_id.trim().is_empty()
        || executor_model_id.trim().is_empty()
        || original_model_id == executor_model_id
        || expires_at_ms <= now_ms
        || expires_at_ms > now_ms.saturating_add(3_600_000)
    {
        return Err("invalid temporary visual executor lease".into());
    }
    model_service.require_computer_use_executor(&executor_model_id)?;
    let lease = crate::services::computer_use_executor::VisualExecutorLease {
        conversation_id,
        original_model_id,
        executor_model_id,
        started_at_ms: now_ms,
        expires_at_ms,
    };
    visual_executor_lease_store(&app)?.persist(&lease)?;
    Ok(lease)
}

#[tauri::command]
fn get_computer_use_executor_lease(
    app: tauri::AppHandle,
) -> Result<Option<crate::services::computer_use_executor::VisualExecutorLease>, String> {
    visual_executor_lease_store(&app)?.load()
}

fn computer_use_session_matches_executor_lease(
    session: Option<&crate::models::computer_use::Session>,
    lease: &crate::services::computer_use_executor::VisualExecutorLease,
) -> bool {
    session.is_some_and(|session| {
        matches!(
            session.state,
            crate::models::computer_use::SessionState::Active
                | crate::models::computer_use::SessionState::Paused
        ) && session.conversation_id == lease.conversation_id
            && session.executor_model_id == lease.executor_model_id
    })
}

#[tauri::command]
fn recover_computer_use_executor_lease(
    app: tauri::AppHandle,
    model_service: tauri::State<'_, ModelService>,
    turns: tauri::State<'_, crate::services::turn_service::TurnService>,
    cu: tauri::State<'_, crate::services::computer_use_service::ComputerUseService>,
) -> Result<serde_json::Value, String> {
    use crate::services::computer_use_executor::LeaseRecoveryDecision;

    let store = visual_executor_lease_store(&app)?;
    let existing = store.load().ok().flatten();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let catalog = model_service.cached_catalog()?;
    match store.recover_decision(now_ms, &catalog)? {
        LeaseRecoveryDecision::NoLease => Ok(serde_json::json!({ "kind": "none" })),
        LeaseRecoveryDecision::OfferRestoreOrResume { lease } => {
            let session = cu.sessions.current_any();
            let resumable = turns.is_conversation_active(&lease.conversation_id)
                && computer_use_session_matches_executor_lease(session.as_ref(), &lease);
            if resumable {
                Ok(serde_json::json!({
                    "kind": "offer",
                    "lease": lease,
                    "session": session,
                }))
            } else {
                store.clear()?;
                Ok(serde_json::json!({
                    "kind": "restored",
                    "originalModelId": lease.original_model_id,
                    "executorModelId": lease.executor_model_id,
                    "reason": "runtime_unavailable",
                }))
            }
        }
        LeaseRecoveryDecision::RestoreOriginal {
            original_model_id,
            reason,
        } => Ok(serde_json::json!({
            "kind": "restored",
            "originalModelId": original_model_id,
            "executorModelId": existing.as_ref().map(|lease| lease.executor_model_id.as_str()),
            "reason": format!("{reason:?}"),
        })),
        LeaseRecoveryDecision::ClearInconsistent { reason } => Ok(serde_json::json!({
            "kind": "cleared",
            "reason": format!("{reason:?}"),
        })),
    }
}

#[cfg(test)]
mod computer_use_recovery_binding_tests {
    use super::computer_use_session_matches_executor_lease;

    fn session() -> crate::models::computer_use::Session {
        crate::models::computer_use::Session {
            id: "session-recovery".into(),
            state: crate::models::computer_use::SessionState::Active,
            conversation_id: "conversation-recovery".into(),
            executor_model_id: "vision-executor".into(),
            goal: "Continue the approved task".into(),
            target_app: Some("com.example.app".into()),
            approved_apps: Vec::new(),
            active_app: Some("com.example.app".into()),
            scope: crate::models::types::ComputerUseScope::Full,
            allowlist_version: 1,
            self_test_enabled: false,
            screenshot_attach_to_llm: true,
            isolate_other_apps: true,
            pid_lock: 1,
            started_at_mono: 1,
            started_at_wall: 1,
            last_activity_mono: 1,
            idle_timeout_secs: 900,
        }
    }

    fn lease() -> crate::services::computer_use_executor::VisualExecutorLease {
        crate::services::computer_use_executor::VisualExecutorLease {
            conversation_id: "conversation-recovery".into(),
            original_model_id: "text-model".into(),
            executor_model_id: "vision-executor".into(),
            started_at_ms: 1,
            expires_at_ms: 2,
        }
    }

    #[test]
    fn recovery_requires_the_exact_session_conversation_and_executor() {
        let expected = session();
        let lease = lease();
        assert!(computer_use_session_matches_executor_lease(
            Some(&expected),
            &lease,
        ));

        let mut wrong_conversation = expected.clone();
        wrong_conversation.conversation_id = "another-conversation".into();
        assert!(!computer_use_session_matches_executor_lease(
            Some(&wrong_conversation),
            &lease,
        ));

        let mut wrong_executor = expected.clone();
        wrong_executor.executor_model_id = "another-executor".into();
        assert!(!computer_use_session_matches_executor_lease(
            Some(&wrong_executor),
            &lease,
        ));
        assert!(!computer_use_session_matches_executor_lease(None, &lease));
    }
}

#[tauri::command]
fn clear_computer_use_executor_lease(
    app: tauri::AppHandle,
    conversation_id: Option<String>,
) -> Result<bool, String> {
    let store = visual_executor_lease_store(&app)?;
    match conversation_id {
        Some(conversation_id) => store.clear_if_conversation(&conversation_id),
        None => {
            let existed = store.load()?.is_some();
            store.clear()?;
            Ok(existed)
        }
    }
}

/// Returns the current allowlist. Capability-gated by computer-use.json.
#[tauri::command]
fn get_computer_use_allowlist(
    store: tauri::State<'_, SettingsStore>,
) -> Result<Vec<crate::models::types::ComputerUseAllowlistEntry>, String> {
    Ok(store.get()?.computer_use.allowlist)
}

/// Upsert an allowlist entry by bundle_id (case-insensitive). Returns the
/// resulting full settings.
#[tauri::command]
fn update_computer_use_allowlist(
    entry: crate::models::types::ComputerUseAllowlistEntry,
    store: tauri::State<'_, SettingsStore>,
) -> Result<UserSettings, String> {
    let current = store.get()?;
    let mut cu = current.computer_use;
    // Remove existing entry with same bundle_id (case-insensitive).
    let lower = entry.bundle_id.to_lowercase();
    cu.allowlist.retain(|e| e.bundle_id.to_lowercase() != lower);
    cu.allowlist.push(entry);
    let patch = serde_json::json!({ "computerUse": cu });
    store.update(patch)
}

/// Remove an allowlist entry by bundle_id (case-insensitive).
#[tauri::command]
fn remove_computer_use_allowlist(
    bundle_id: String,
    store: tauri::State<'_, SettingsStore>,
) -> Result<UserSettings, String> {
    let current = store.get()?;
    let mut cu = current.computer_use;
    let lower = bundle_id.to_lowercase();
    cu.allowlist.retain(|e| e.bundle_id.to_lowercase() != lower);
    let patch = serde_json::json!({ "computerUse": cu });
    store.update(patch)
}

/// Step 1 of consent flow: create a pending Computer Use session request.
/// Returns the request ID. Session is NOT active yet — user must call
/// `grant_computer_use_session` explicitly.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn request_computer_use_session(
    cu: tauri::State<'_, crate::services::computer_use_service::ComputerUseService>,
    store: tauri::State<'_, SettingsStore>,
    model_service: tauri::State<'_, ModelService>,
    goal: String,
    app: Option<String>,
    scope: crate::models::types::ComputerUseScope,
    conversation_id: String,
    executor_model_id: String,
) -> Result<crate::models::computer_use::ConsentRequest, String> {
    let _lifecycle = acquire_computer_use_lifecycle()?;
    if conversation_id.trim().is_empty() || executor_model_id.trim().is_empty() {
        return Err("Computer Use requires a conversation and visual executor binding.".into());
    }
    model_service.require_computer_use_executor(&executor_model_id)?;
    let settings = store.get()?;
    cu.sessions.disarm_emergency();
    cu.request_bound_session(
        &settings.computer_use,
        goal,
        app,
        scope,
        conversation_id,
        executor_model_id,
    )
    .map_err(|e| format!("session request denied: {:?}", e))
}

fn clear_computer_use_action_sequence(app: &tauri::AppHandle, session_id: &str) {
    if let Some(turns) = app.try_state::<TurnService>() {
        turns.clear_computer_use_action_sequence(session_id);
    }
}

fn start_computer_use_action_sequence(app: &tauri::AppHandle, session_id: &str) {
    if let Some(turns) = app.try_state::<TurnService>() {
        turns.start_computer_use_action_sequence(session_id);
    }
}

fn restore_computer_use_layout(app: &tauri::AppHandle, session_id: &str) -> Result<bool, String> {
    let layout = app
        .try_state::<crate::services::computer_use_layout::ComputerUseLayoutService>()
        .ok_or("computer-use layout service is unavailable")?;
    layout.restore(app, session_id)
}

fn apply_computer_use_focus_layout(
    app: &tauri::AppHandle,
    session_id: &str,
    receipt: crate::services::computer_use_focus::FocusStartReceipt,
) -> Result<(), String> {
    if !receipt.target_observed {
        return Ok(());
    }
    let Some(layout) =
        app.try_state::<crate::services::computer_use_layout::ComputerUseLayoutService>()
    else {
        return Ok(());
    };
    let state = layout.state()?;
    if state.session_id.as_deref() != Some(session_id)
        || matches!(
            state.mode,
            crate::services::computer_use_layout::ComputerUseLayoutMode::Idle
                | crate::services::computer_use_layout::ComputerUseLayoutMode::Restoring
        )
    {
        return Ok(());
    }
    layout
        .mark_focus_result(app, session_id, receipt.compact_layout_applied)
        .map(|_| ())
}

#[tauri::command]
fn get_computer_use_layout_state(
    layout: tauri::State<'_, crate::services::computer_use_layout::ComputerUseLayoutService>,
) -> Result<crate::services::computer_use_layout::ComputerUseLayoutState, String> {
    layout.state()
}

fn persist_computer_use_handoff_or_emit(
    cu: &crate::services::computer_use_service::ComputerUseService,
    app: &tauri::AppHandle,
    session_id: &str,
    stopped_reason: &str,
) {
    if let Err(error) = cu.persist_trusted_handoff(session_id, stopped_reason) {
        use tauri::Emitter;
        let _ = app.emit("computer-use:handoff-failed", error);
    }
}

fn launch_approved_target_with_live_capability<F>(
    target_bundle_id: Option<&str>,
    mut launch: F,
) -> Result<(), String>
where
    F: FnMut(&str) -> crate::models::computer_use::ComputerUseResult,
{
    let Some(target_bundle_id) = target_bundle_id else {
        return Ok(());
    };
    let result = launch(target_bundle_id);
    if let Some(error) = result.error {
        return Err(format!(
            "launch approved Computer Use target failed: {}",
            error.message
        ));
    }
    if result.result.is_none() {
        return Err("launch approved Computer Use target returned no result".into());
    }
    Ok(())
}

fn activate_then_launch_approved_target<A, F, T>(
    target_bundle_id: Option<&str>,
    activate: A,
    launch: F,
) -> Result<T, String>
where
    A: FnOnce() -> Result<T, String>,
    F: FnMut(&str) -> crate::models::computer_use::ComputerUseResult,
{
    let activation = activate()?;
    launch_approved_target_with_live_capability(target_bundle_id, launch)?;
    Ok(activation)
}

#[cfg(test)]
mod computer_use_target_launch_tests {
    use super::activate_then_launch_approved_target;
    use crate::models::computer_use::{ComputerUseError, ComputerUseResult};
    use serde_json::json;
    use std::cell::RefCell;

    #[test]
    fn activates_capability_before_launching_the_exact_approved_target() {
        let order = RefCell::new(Vec::new());

        let activation = activate_then_launch_approved_target(
            Some("com.apple.calculator"),
            || {
                order.borrow_mut().push("activate".to_string());
                Ok("capability-live")
            },
            |bundle_id| {
                order.borrow_mut().push(format!("launch:{bundle_id}"));
                ComputerUseResult {
                    result: Some(json!({ "bundleId": bundle_id, "running": true })),
                    error: None,
                }
            },
        )
        .expect("approved target should launch");

        assert_eq!(activation, "capability-live");
        assert_eq!(
            order.into_inner(),
            vec!["activate", "launch:com.apple.calculator"]
        );
    }

    #[test]
    fn launch_failure_blocks_executor_activation() {
        let error = activate_then_launch_approved_target(
            Some("com.apple.calculator"),
            || Ok("capability-live"),
            |_| ComputerUseResult {
                result: None,
                error: Some(ComputerUseError::new(
                    "provider_down",
                    "Calculator did not launch",
                )),
            },
        )
        .expect_err("activation must stop when the approved app cannot launch");

        assert!(error.contains("Calculator did not launch"));
    }
}

/// Step 2: user grants consent. Returns the active session or an error.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn grant_computer_use_session(
    cu: tauri::State<'_, crate::services::computer_use_service::ComputerUseService>,
    store: tauri::State<'_, SettingsStore>,
    model_service: tauri::State<'_, ModelService>,
    app_handle: tauri::AppHandle,
    request_id: String,
    screenshot_attach_to_llm: bool,
    app_display_name: Option<String>,
    requested_tier: Option<crate::models::computer_use::AppControlTier>,
    sentinel_confirmed: bool,
) -> Result<crate::models::computer_use::Session, String> {
    let _lifecycle = acquire_computer_use_lifecycle()?;
    let mut settings = store.get()?;
    let grant = crate::models::computer_use::ConsentGrant {
        id: request_id,
        allowlist_version: 1,
        self_test_enabled: settings.computer_use.self_test_enabled,
        screenshot_attach_to_llm,
        idle_timeout_secs: settings.computer_use.idle_timeout_seconds as u64,
    };
    let mut session = cu
        .sessions
        .grant_session(grant)
        .map_err(|e| format!("grant denied: {:?}", e))?;
    if let Err(error) = model_service.require_computer_use_executor(&session.executor_model_id) {
        let _ = cu
            .sessions
            .stop(&session.id, crate::models::computer_use::StopReason::Error);
        return Err(error);
    }
    if let Some(bundle_id) = session.target_app.clone() {
        let fallback_tier = match session.scope {
            crate::models::types::ComputerUseScope::View
            | crate::models::types::ComputerUseScope::Ask => {
                crate::models::computer_use::AppControlTier::ViewOnly
            }
            crate::models::types::ComputerUseScope::Input
            | crate::models::types::ComputerUseScope::Full => {
                crate::models::computer_use::AppControlTier::FullControl
            }
        };
        if let Err(error) = cu.sessions.pause(&session.id) {
            let _ = cu
                .sessions
                .stop(&session.id, crate::models::computer_use::StopReason::Error);
            return Err(format!("grant denied: {error:?}"));
        }
        session = match cu.sessions.approve_app(
            &session.id,
            &bundle_id,
            app_display_name.as_deref().unwrap_or(&bundle_id),
            requested_tier.unwrap_or(fallback_tier),
            sentinel_confirmed,
            &settings.computer_use,
        ) {
            Ok(session) => session,
            Err(error) => {
                let _ = cu
                    .sessions
                    .stop(&session.id, crate::models::computer_use::StopReason::Error);
                return Err(format!("grant denied: {error:?}"));
            }
        };
        session = match cu.sessions.resume(&session.id) {
            Ok(session) => session,
            Err(error) => {
                let _ = cu
                    .sessions
                    .stop(&session.id, crate::models::computer_use::StopReason::Error);
                return Err(format!("grant denied: {error:?}"));
            }
        };
    }
    let target_bundle_id = session
        .active_app
        .as_deref()
        .or(session.target_app.as_deref())
        .map(str::to_string);
    if let Some(target_bundle_id) = session
        .active_app
        .as_deref()
        .or(session.target_app.as_deref())
    {
        let layout =
            app_handle.state::<crate::services::computer_use_layout::ComputerUseLayoutService>();
        if let Err(error) = layout.enter(&app_handle, &session.id, target_bundle_id) {
            use tauri::Emitter;
            let _ = app_handle.emit(
                "computer-use:cleanup-failed",
                format!("compact layout unavailable; using fallback: {error}"),
            );
        }
    }
    start_computer_use_action_sequence(&app_handle, &session.id);
    let sessions = cu.sessions.clone();
    let app_handle_emergency = app_handle.clone();
    let emergency_session_id = session.id.clone();
    let app_handle_layout = app_handle.clone();
    let layout_session_id = session.id.clone();
    let activation = match activate_then_launch_approved_target(
        target_bundle_id.as_deref(),
        || {
            crate::services::computer_use_mcp::activate(
                &session,
                move |incident_kind, authority_revoked| {
                    use tauri::Emitter;
                    if let Some(service) = app_handle_emergency
                        .try_state::<crate::services::computer_use_service::ComputerUseService>(
                    ) {
                        let stopped_reason = match incident_kind {
                    crate::services::computer_use_mcp::SafetyIncidentKind::EmergencyStop => {
                        "emergency_stop"
                    }
                    crate::services::computer_use_mcp::SafetyIncidentKind::RuntimeFailure => {
                        "executor_error"
                    }
                };
                        if authority_revoked {
                            persist_computer_use_handoff_or_emit(
                                &service,
                                &app_handle_emergency,
                                &emergency_session_id,
                                stopped_reason,
                            );
                        } else {
                            let _ = app_handle_emergency.emit(
                        "computer-use:handoff-failed",
                        "Computer Use handoff omitted because runtime authority revocation could not be confirmed.",
                    );
                        }
                        match incident_kind {
                    crate::services::computer_use_mcp::SafetyIncidentKind::EmergencyStop => {
                        service.emergency_stop_all();
                    }
                    crate::services::computer_use_mcp::SafetyIncidentKind::RuntimeFailure => {
                        match service.stop(
                            &emergency_session_id,
                            crate::models::computer_use::StopReason::Error,
                        ) {
                            Ok(stopped) => emit_computer_use_state(&app_handle_emergency, &stopped),
                            Err(error) => {
                                let _ = app_handle_emergency.emit(
                                    "computer-use:cleanup-failed",
                                    format!("stop failed Computer Use runtime: {error:?}"),
                                );
                            }
                        }
                    }
                }
                    } else {
                        match incident_kind {
                    crate::services::computer_use_mcp::SafetyIncidentKind::EmergencyStop => {
                        sessions.emergency_stop_all();
                    }
                    crate::services::computer_use_mcp::SafetyIncidentKind::RuntimeFailure => {
                        let _ = sessions.stop(
                            &emergency_session_id,
                            crate::models::computer_use::StopReason::Error,
                        );
                    }
                }
                    }
                    clear_computer_use_action_sequence(
                        &app_handle_emergency,
                        &emergency_session_id,
                    );
                    if let Err(error) =
                        restore_computer_use_layout(&app_handle_emergency, &emergency_session_id)
                    {
                        let _ = app_handle_emergency.emit("computer-use:cleanup-failed", error);
                    }
                    if let Some(store) = app_handle_emergency.try_state::<SettingsStore>() {
                        if let Ok(settings) = store.get() {
                            show_computer_use_notification(&app_handle_emergency, &settings, false);
                        }
                    }
                    if incident_kind
                        == crate::services::computer_use_mcp::SafetyIncidentKind::EmergencyStop
                    {
                        let _ = app_handle_emergency.emit("computer-use:emergency-stop", ());
                    }
                },
                move |receipt| {
                    if let Err(error) = apply_computer_use_focus_layout(
                        &app_handle_layout,
                        &layout_session_id,
                        receipt,
                    ) {
                        use tauri::Emitter;
                        let _ = app_handle_layout.emit("computer-use:cleanup-failed", error);
                    }
                },
            )
        },
        |bundle_id| cu.launch_app(&mut settings.computer_use, bundle_id),
    ) {
        Ok(receipt) => receipt,
        Err(error) => {
            clear_computer_use_action_sequence(&app_handle, &session.id);
            let _ = restore_computer_use_layout(&app_handle, &session.id);
            let _ = cu
                .sessions
                .stop(&session.id, crate::models::computer_use::StopReason::Error);
            let _ = crate::services::computer_use_mcp::revoke();
            return Err(error);
        }
    };
    if session.active_app.is_some() || session.target_app.is_some() {
        let layout_result = activation.focus.map_or(Ok(()), |receipt| {
            apply_computer_use_focus_layout(&app_handle, &session.id, receipt)
        });
        if let Err(error) = layout_result {
            let _ = crate::services::computer_use_mcp::revoke_session(&session.id);
            let _ = restore_computer_use_layout(&app_handle, &session.id);
            clear_computer_use_action_sequence(&app_handle, &session.id);
            let _ = cu
                .sessions
                .stop(&session.id, crate::models::computer_use::StopReason::Error);
            return Err(format!("apply compact layout receipt: {error}"));
        }
    }
    // P0.2b: poll OS TCC every 5s (first check immediate). On revoke, stop session.
    let app_handle_poll = app_handle.clone();
    let poll_session_id = session.id.clone();
    cu.start_os_permission_poller(move |handoff_result| {
        use tauri::Emitter;
        if let Err(error) = handoff_result {
            let _ = app_handle_poll.emit("computer-use:handoff-failed", error);
        }
        clear_computer_use_action_sequence(&app_handle_poll, &poll_session_id);
        if let Err(error) = restore_computer_use_layout(&app_handle_poll, &poll_session_id) {
            let _ = app_handle_poll.emit("computer-use:cleanup-failed", error);
        }
        if let Some(store) = app_handle_poll.try_state::<SettingsStore>() {
            if let Ok(settings) = store.get() {
                show_computer_use_notification(&app_handle_poll, &settings, false);
            }
        }
        let _ = app_handle_poll.emit("computer-use:os-permission-revoked", ());
    });
    emit_computer_use_state(&app_handle, &session);
    show_computer_use_notification(&app_handle, &settings, true);
    Ok(session)
}

/// Explicitly approve an additional app for the current session and make it
/// the active isolated target. The MCP capability is widened only after the
/// SessionManager accepts the per-app tier and sentinel confirmation.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn approve_computer_use_app(
    cu: tauri::State<'_, crate::services::computer_use_service::ComputerUseService>,
    store: tauri::State<'_, SettingsStore>,
    session_id: String,
    bundle_id: String,
    display_name: String,
    requested_tier: crate::models::computer_use::AppControlTier,
    sentinel_confirmed: bool,
    app: tauri::AppHandle,
) -> Result<crate::models::computer_use::Session, String> {
    let _lifecycle = acquire_computer_use_lifecycle()?;
    let settings = store.get()?.computer_use;
    let session = cu
        .sessions
        .approve_app(
            &session_id,
            &bundle_id,
            &display_name,
            requested_tier,
            sentinel_confirmed,
            &settings,
        )
        .map_err(|error| format!("app approval denied: {error:?}"))?;
    let approved = session
        .approved_apps
        .iter()
        .find(|app| app.bundle_id.eq_ignore_ascii_case(&bundle_id))
        .cloned()
        .ok_or("approved app missing from session")?;
    if let Err(error) = app
        .state::<crate::services::computer_use_layout::ComputerUseLayoutService>()
        .enter(&app, &session_id, &bundle_id)
    {
        use tauri::Emitter;
        let _ = app.emit(
            "computer-use:cleanup-failed",
            format!("compact layout unavailable; using fallback: {error}"),
        );
    }
    let layout_app = app.clone();
    let layout_session_id = session_id.clone();
    let focus_receipt = match crate::services::computer_use_mcp::approve_and_select_app(
        &session_id,
        approved,
        move |receipt| {
            if let Err(error) =
                apply_computer_use_focus_layout(&layout_app, &layout_session_id, receipt)
            {
                use tauri::Emitter;
                let _ = layout_app.emit("computer-use:cleanup-failed", error);
            }
        },
    ) {
        Ok(receipt) => receipt,
        Err(error) => {
            let (revoke_result, _) = revoke_before_computer_use_handoff(
                || crate::services::computer_use_mcp::revoke_session(&session_id),
                || {
                    persist_computer_use_handoff_or_emit(
                        &cu,
                        &app,
                        &session_id,
                        "app_approval_failed",
                    )
                },
            );
            let _ = restore_computer_use_layout(&app, &session_id);
            clear_computer_use_action_sequence(&app, &session_id);
            let stopped = cu.stop(&session_id, crate::models::computer_use::StopReason::Error);
            if let Ok(stopped) = stopped {
                emit_computer_use_state(&app, &stopped);
            }
            match revoke_result {
                Err(revoke_error) => {
                    use tauri::Emitter;
                    let _ = app.emit("computer-use:cleanup-failed", revoke_error);
                }
                Ok(false) => {
                    use tauri::Emitter;
                    let _ = app.emit(
                        "computer-use:cleanup-failed",
                        "Computer Use authority belonged to another session.",
                    );
                }
                Ok(true) => {}
            }
            return Err(format!("activate approved app: {error}"));
        }
    };
    if let Err(error) = apply_computer_use_focus_layout(&app, &session_id, focus_receipt) {
        let _ = crate::services::computer_use_mcp::revoke_session(&session_id);
        let _ = restore_computer_use_layout(&app, &session_id);
        clear_computer_use_action_sequence(&app, &session_id);
        let _ = cu.stop(&session_id, crate::models::computer_use::StopReason::Error);
        return Err(format!("apply compact layout receipt: {error}"));
    }
    emit_computer_use_state(&app, &session);
    Ok(session)
}

#[tauri::command]
fn get_pending_computer_use_confirmation(
    cu: tauri::State<'_, crate::services::computer_use_service::ComputerUseService>,
    session_id: String,
) -> Result<Option<crate::services::computer_use_confirmation::PendingConfirmationView>, String> {
    let current = cu
        .sessions
        .current()
        .ok_or("computer-use session is not active")?;
    if current.id != session_id
        || !matches!(
            current.state,
            crate::models::computer_use::SessionState::Active
                | crate::models::computer_use::SessionState::Paused
        )
    {
        return Err("computer-use session mismatch".into());
    }
    crate::services::computer_use_confirmation::ConfirmationStore::runtime()?
        .pending(&session_id)
        .map(|pending| pending.map(|confirmation| confirmation.renderer_view()))
}

#[tauri::command]
fn decide_computer_use_confirmation(
    cu: tauri::State<'_, crate::services::computer_use_service::ComputerUseService>,
    app: tauri::AppHandle,
    session_id: String,
    confirmation_id: String,
    allow: bool,
) -> Result<(), String> {
    let _lifecycle = acquire_computer_use_lifecycle()?;
    let current = cu
        .sessions
        .current()
        .ok_or("computer-use session is not active")?;
    if current.id != session_id
        || !matches!(
            current.state,
            crate::models::computer_use::SessionState::Active
                | crate::models::computer_use::SessionState::Paused
        )
    {
        return Err("computer-use session mismatch".into());
    }
    let store = crate::services::computer_use_confirmation::ConfirmationStore::runtime()?;
    let pending = store
        .pending(&session_id)?
        .ok_or("confirmation is missing or expired")?;
    if pending.id != confirmation_id {
        return Err("confirmation id does not match the pending action".into());
    }
    if let Err(error) = cu.record_confirmation_decision(
        &session_id,
        &pending.app_bundle_id,
        &pending.summary,
        allow,
    ) {
        let _ = crate::services::computer_use_mcp::revoke_session(&session_id);
        let _ = restore_computer_use_layout(&app, &session_id);
        clear_computer_use_action_sequence(&app, &session_id);
        if let Some(stopped) = cu.sessions.current_any() {
            emit_computer_use_state(&app, &stopped);
        }
        return Err(error);
    }
    store.decide(&session_id, &confirmation_id, allow)?;
    crate::services::computer_use_mcp::request_target_focus(&session_id)
}

/// Deny a pending consent request.
#[tauri::command]
fn deny_computer_use_session(
    cu: tauri::State<'_, crate::services::computer_use_service::ComputerUseService>,
    request_id: String,
) -> Result<(), String> {
    let _lifecycle = acquire_computer_use_lifecycle()?;
    cu.sessions.deny_session(
        &request_id,
        crate::models::computer_use::DenyReason::UserDenied,
    );
    Ok(())
}

/// Stop an active session.
fn revoke_before_computer_use_handoff<R, H, T>(
    revoke: R,
    read_and_persist_handoff: H,
) -> (Result<bool, String>, Option<T>)
where
    R: FnOnce() -> Result<bool, String>,
    H: FnOnce() -> T,
{
    let revoke_result = revoke();
    let handoff_result = matches!(revoke_result, Ok(true)).then(read_and_persist_handoff);
    (revoke_result, handoff_result)
}

#[tauri::command]
fn stop_computer_use_session(
    cu: tauri::State<'_, crate::services::computer_use_service::ComputerUseService>,
    store: tauri::State<'_, SettingsStore>,
    app: tauri::AppHandle,
    session_id: String,
    reason: Option<String>,
) -> Result<(), String> {
    let _lifecycle = acquire_computer_use_lifecycle()?;
    let r = match reason.as_deref() {
        Some("user_cancelled") => crate::models::computer_use::StopReason::UserCancelled,
        Some("emergency") => crate::models::computer_use::StopReason::EmergencyStop,
        _ => crate::models::computer_use::StopReason::UserCancelled,
    };
    let stopped_reason = if matches!(r, crate::models::computer_use::StopReason::EmergencyStop) {
        "emergency_stop"
    } else {
        "cancelled"
    };
    cu.signal_os_permission_poller_stop();
    let (revoke_result, _) = revoke_before_computer_use_handoff(
        || crate::services::computer_use_mcp::revoke_session(&session_id),
        || persist_computer_use_handoff_or_emit(&cu, &app, &session_id, stopped_reason),
    );
    let layout_result = restore_computer_use_layout(&app, &session_id);
    cu.stop_os_permission_poller();
    clear_computer_use_action_sequence(&app, &session_id);
    let stopped = cu
        .stop(&session_id, r)
        .map_err(|e| format!("stop denied: {:?}", e))?;
    emit_computer_use_state(&app, &stopped);
    if let Ok(settings) = store.get() {
        show_computer_use_notification(&app, &settings, false);
    }
    match (revoke_result, layout_result) {
        (Ok(true), Ok(_)) => Ok(()),
        (Ok(true), Err(error)) => Err(error),
        (Ok(false), _) => Err("Computer Use authority belonged to another session.".into()),
        (Err(error), _) => Err(error),
    }
}

#[tauri::command]
fn pause_computer_use_session(
    cu: tauri::State<'_, crate::services::computer_use_service::ComputerUseService>,
    app: tauri::AppHandle,
    session_id: String,
) -> Result<crate::models::computer_use::Session, String> {
    let _lifecycle = acquire_computer_use_lifecycle()?;
    crate::services::computer_use_mcp::set_paused(&session_id, true)?;
    match cu.pause(&session_id) {
        Ok(session) => {
            emit_computer_use_state(&app, &session);
            Ok(session)
        }
        // Fail closed: once the capability has been paused, an inconsistent
        // session state must never reactivate native authority as a rollback.
        Err(error) => Err(format!("pause denied: {error:?}")),
    }
}

#[tauri::command]
fn resume_computer_use_session(
    cu: tauri::State<'_, crate::services::computer_use_service::ComputerUseService>,
    model_service: tauri::State<'_, ModelService>,
    app: tauri::AppHandle,
    session_id: String,
) -> Result<crate::models::computer_use::Session, String> {
    let _lifecycle = acquire_computer_use_lifecycle()?;
    let paused = cu
        .sessions
        .current_any()
        .filter(|session| session.id == session_id)
        .ok_or("computer-use session is not resumable")?;
    model_service.require_computer_use_executor(&paused.executor_model_id)?;
    let session = cu
        .resume(&session_id)
        .map_err(|e| format!("resume denied: {e:?}"))?;
    if let Err(error) = crate::services::computer_use_mcp::set_paused(&session_id, false) {
        let _ = cu.pause(&session_id);
        return Err(error);
    }
    if let Err(error) = crate::services::computer_use_mcp::request_target_focus(&session_id) {
        let _ = crate::services::computer_use_mcp::set_paused(&session_id, true);
        let _ = cu.pause(&session_id);
        return Err(error);
    }
    emit_computer_use_state(&app, &session);
    Ok(session)
}

/// List running apps for the pre-consent target picker. This exposes metadata
/// only and does not create or widen a Computer Use capability.
fn computer_use_app_is_visible(
    app: &serde_json::Value,
    blocked: &std::collections::HashSet<String>,
) -> bool {
    let Some(bundle_id) = app.get("bundleId").and_then(serde_json::Value::as_str) else {
        return false;
    };
    let normalized_bundle_id = bundle_id.to_lowercase();
    let display_name = app
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();

    !blocked.contains(&normalized_bundle_id)
        && !crate::services::session_manager::is_hard_blocked_app(
            &normalized_bundle_id,
            display_name,
        )
}

#[cfg(test)]
mod computer_use_app_filter_tests {
    use super::computer_use_app_is_visible;
    use std::collections::HashSet;

    #[test]
    fn preconsent_picker_hides_hard_blocked_display_names() {
        let blocked = HashSet::new();

        assert!(!computer_use_app_is_visible(
            &serde_json::json!({
                "bundleId": "com.example.ordinary",
                "name": "Acme Bank"
            }),
            &blocked,
        ));
        assert!(computer_use_app_is_visible(
            &serde_json::json!({
                "bundleId": "com.apple.TextEdit",
                "name": "TextEdit"
            }),
            &blocked,
        ));
    }
}

#[cfg(test)]
mod computer_use_stop_order_tests {
    use std::cell::RefCell;

    use super::revoke_before_computer_use_handoff;

    #[test]
    fn stop_removes_action_authority_before_reading_handoff_audit() {
        let events = RefCell::new(Vec::new());

        let (revoke_result, handoff_result) = revoke_before_computer_use_handoff(
            || {
                events.borrow_mut().push("authority_revoked");
                Ok(true)
            },
            || {
                events.borrow_mut().push("handoff_read");
            },
        );

        assert!(revoke_result.unwrap());
        assert_eq!(handoff_result, Some(()));
        assert_eq!(*events.borrow(), vec!["authority_revoked", "handoff_read"]);
    }

    #[test]
    fn stop_never_reads_a_potentially_stale_handoff_when_revocation_fails() {
        let events = RefCell::new(Vec::new());

        let (revoke_result, handoff_result) = revoke_before_computer_use_handoff(
            || {
                events.borrow_mut().push("revocation_failed");
                Err("could not remove authority".into())
            },
            || {
                events.borrow_mut().push("handoff_read");
            },
        );

        assert!(revoke_result.is_err());
        assert_eq!(handoff_result, None);
        assert_eq!(*events.borrow(), vec!["revocation_failed"]);
    }
}

#[cfg(test)]
mod computer_use_lifecycle_lock_tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::acquire_computer_use_lifecycle;

    #[test]
    fn pause_resume_and_stop_transitions_cannot_interleave() {
        let first_transition = acquire_computer_use_lifecycle().unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let second = std::thread::spawn(move || {
            let _second_transition = acquire_computer_use_lifecycle().unwrap();
            entered_tx.send(()).unwrap();
        });

        assert!(entered_rx.recv_timeout(Duration::from_millis(50)).is_err());
        drop(first_transition);
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        second.join().unwrap();
    }
}

#[tauri::command]
fn list_computer_use_apps(
    store: tauri::State<'_, SettingsStore>,
) -> Result<Vec<serde_json::Value>, String> {
    let settings = store.get()?;
    let mut blocked: std::collections::HashSet<String> = settings
        .computer_use
        .denylist
        .iter()
        .map(|bundle| bundle.to_lowercase())
        .collect();
    blocked.insert("com.apple.loginwindow".to_string());
    if !settings.computer_use.self_test_enabled {
        blocked.insert("ai.verboo.code.desktop".to_string());
    }
    let result = crate::services::computer_use_service::invoke_helper_once(
        "list-apps",
        &serde_json::json!({}),
    )
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let apps = result
        .get("apps")
        .and_then(serde_json::Value::as_array)
        .ok_or("computer-use helper returned an invalid app list")?;
    Ok(apps
        .iter()
        .filter(|app| computer_use_app_is_visible(app, &blocked))
        .cloned()
        .collect())
}

/// List running apps (requires active session). The helper's `list-apps`
/// is proxied through SessionManager's gate — returns `no_active_session`
/// error if no consent granted.
#[tauri::command]
fn list_apps(
    cu: tauri::State<'_, crate::services::computer_use_service::ComputerUseService>,
    store: tauri::State<'_, SettingsStore>,
) -> Result<serde_json::Value, String> {
    let mut settings = store.get()?.computer_use;
    let result = cu.list_apps(&mut settings);
    if let Some(err) = &result.error {
        return Err(format!("{}: {}", err.code, err.message));
    }
    Ok(result.result.unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
fn resolve_computer_use_app(
    cu: tauri::State<'_, crate::services::computer_use_service::ComputerUseService>,
    selector: String,
) -> Result<serde_json::Value, String> {
    cu.resolve_app(&selector)
        .map_err(|error| format!("{}: {}", error.code, error.message))
}

#[tauri::command]
fn get_computer_use_permissions() -> Result<serde_json::Value, String> {
    crate::services::computer_use_service::computer_use_permission_status(false)
        .map_err(|error| format!("{}: {}", error.code, error.message))
}

#[tauri::command]
async fn request_computer_use_permissions() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::services::computer_use_service::computer_use_permission_status(true)
            .map_err(|error| format!("{}: {}", error.code, error.message))
    })
    .await
    .map_err(|error| format!("Computer Use permission request failed: {error}"))?
}

#[tauri::command]
fn open_computer_use_permission_settings(kind: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let url = match kind.as_str() {
            "accessibility" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            "screenRecording" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            _ => return Err("Unknown Computer Use permission kind.".into()),
        };
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|error| format!("Could not open System Settings: {error}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        Ok(())
    }
}

/// Returns the absolute path to the computer-use-helper binary, or an error
/// if it could not be resolved (neither bundled, env override, nor dev build).
#[tauri::command]
fn get_computer_use_helper_path() -> Result<String, String> {
    crate::services::computer_use_spawn::resolved_agent_path()
        .or_else(crate::services::computer_use_spawn::resolved_helper_path)
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| {
            "Verboo Computer Use agent not found — rebuild the native dependencies".to_string()
        })
}

/// Reveals the computer-use-helper binary in Finder (macOS only).
/// On other platforms this is a no-op.
#[tauri::command]
fn reveal_computer_use_helper() -> Result<(), String> {
    let path = crate::services::computer_use_spawn::resolved_agent_path()
        .or_else(crate::services::computer_use_spawn::resolved_helper_path)
        .ok_or_else(|| {
            "Verboo Computer Use agent not found — rebuild the native dependencies".to_string()
        })?;
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Could not reveal helper in Finder: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("Reveal in Finder is only supported on macOS".to_string())
    }
}

// ════════════════════════════════════════════════════════════════════
// Vision fallback (FASE 1)
// ════════════════════════════════════════════════════════════════════
/// would be picked as the helper. Zelda's UI calls this to render the
/// settings panel (consent toggle + "will use: <model>" label).
///
/// Async + uses `spawn_blocking` for the model list fetch (which does a
/// blocking HTTP call). This prevents the command from blocking the main
/// thread on cold start when the cache is empty.
///
/// If the catalog can't be loaded (no token, network error), `helperModel`
/// is `null` — the renderer shows a fallback label. The user can still
/// proceed; the fallback will try again at turn time.
#[tauri::command]
async fn get_vision_fallback_state(
    store: tauri::State<'_, SettingsStore>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let settings = store.get()?;
    let consent =
        serde_json::to_value(&settings.vision_fallback_consent).map_err(|e| e.to_string())?;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    // Run the blocking model list fetch on a background thread.
    let app_data_dir_clone = app_data_dir.clone();
    let helper_preview = tauri::async_runtime::spawn_blocking(move || {
        let model_service = crate::services::model_service::ModelService::new(app_data_dir_clone);
        let credentials_fresh = CredentialsStore::new();
        let token = crate::services::auth_token::resolve_token(&credentials_fresh);
        // force_refresh=false: try cache first (fast), fall back to API.
        // If cache is empty and API fails, returns empty vec — helperModel
        // will be null, which is fine (the modal shows a fallback label).
        model_service
            .list_models(token.as_deref(), false)
            .ok()
            .and_then(|discovery| {
                crate::services::vision_fallback_service::resolve_vision_helper(&discovery).map(
                    |m| {
                        serde_json::json!({
                            "id": m.id,
                            "displayName": m.display_name,
                        })
                    },
                )
            })
    })
    .await
    .map_err(|e| format!("join: {e}"))?;

    Ok(serde_json::json!({
        "consent": consent,
        "helperModel": helper_preview,
    }))
}

/// Sets the vision fallback consent (always/ask/never). Zelda's UI calls
/// this when the user toggles the consent setting.
#[tauri::command]
fn set_vision_fallback_consent(
    consent: crate::models::types::VisionFallbackConsent,
    store: tauri::State<'_, SettingsStore>,
) -> Result<UserSettings, String> {
    let patch = serde_json::json!({ "visionFallbackConsent": consent });
    store.update(patch)
}

/// Push settings into live runtime services (tray visibility/title + updater).
fn apply_runtime_settings(
    next: &UserSettings,
    tray: &crate::services::tray_service::TrayService,
    updates: &crate::services::update_service::UpdateService,
    cu: &crate::services::computer_use_service::ComputerUseService,
    app: &tauri::AppHandle,
) {
    tray.configure(next);
    let _ = updates.configure(next.updates.clone());
    if let Some(icon) = app.tray_by_id("verboo-main") {
        let _ = icon.set_visible(next.show_in_menu_bar);
        #[cfg(target_os = "macos")]
        {
            if next.show_in_menu_bar && next.show_menu_bar_text {
                let title = tray.title();
                let _ = icon.set_title(Some(title.as_str()));
            } else {
                let _ = icon.set_title(Some(""));
            }
        }
    }

    let _lifecycle = match acquire_computer_use_lifecycle() {
        Ok(guard) => guard,
        Err(error) => {
            eprintln!("[computer-use] settings kill switch could not lock lifecycle: {error}");
            return;
        }
    };
    let Some(session) = cu.sessions.current_any() else {
        return;
    };
    let denied_approved_app = session.approved_apps.iter().any(|approved| {
        crate::services::session_manager::is_hard_blocked_bundle(&approved.bundle_id)
            || next
                .computer_use
                .denylist
                .iter()
                .any(|denied| denied.eq_ignore_ascii_case(&approved.bundle_id))
            || (approved
                .bundle_id
                .eq_ignore_ascii_case("ai.verboo.code.desktop")
                && !next.computer_use.self_test_enabled)
    });
    if next.computer_use.enabled && !denied_approved_app {
        return;
    }

    cu.stop_os_permission_poller();
    let (revoke_result, _) = revoke_before_computer_use_handoff(
        || crate::services::computer_use_mcp::revoke_session(&session.id),
        || persist_computer_use_handoff_or_emit(cu, app, &session.id, "settings_revoked"),
    );
    if let Err(error) = restore_computer_use_layout(app, &session.id) {
        eprintln!("[computer-use] settings layout restore failed: {error}");
    }
    clear_computer_use_action_sequence(app, &session.id);
    let _ = cu
        .sessions
        .stop(&session.id, crate::models::computer_use::StopReason::Error);
    use tauri::Emitter;
    let reason = if next.computer_use.enabled {
        "app_denied"
    } else {
        "feature_disabled"
    };
    let _ = app.emit(
        "computer-use:settings-revoked",
        serde_json::json!({
            "sessionId": session.id,
            "reason": reason,
        }),
    );
    show_computer_use_notification(app, next, false);
    match revoke_result {
        Err(error) => eprintln!(
            "[computer-use] settings kill switch removed local session; cleanup error: {error}"
        ),
        Ok(false) => {
            eprintln!("[computer-use] settings kill switch found authority for another session")
        }
        Ok(true) => {}
    }
}

// ════════════════════════════════════════════════════════════════════
// Menu bar
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
fn update_menu_bar(
    state: MenuBarState,
    tray: tauri::State<'_, crate::services::tray_service::TrayService>,
) -> Result<bool, String> {
    let (_exec, _label) = tray.update_menu_bar(state);
    Ok(true)
}

/// Force the tray to Idle. Called by the renderer on turn `done` / `error` /
/// abort so a lagging `thinking` event (or the 2.5s heartbeat re-pushing a
/// stale `menuBarStateRef`) can never resurrect a completed turn's timer.
#[tauri::command]
fn force_idle_menu_bar(
    tray: tauri::State<'_, crate::services::tray_service::TrayService>,
) -> Result<bool, String> {
    tray.force_idle();
    Ok(true)
}

/// Heartbeat query: returns the current execution state so the renderer can
/// stop re-pushing a stale `menuBarStateRef` every 2.5s (which was the root
/// cause of the "timer never stops" bug). If the state has been active for
/// more than 5 minutes without a renderer push, the Rust side auto-resets
/// to Idle. Returns the (possibly freshly-reset) execution string.
#[tauri::command]
fn heartbeat_menu_bar(
    tray: tauri::State<'_, crate::services::tray_service::TrayService>,
) -> Result<String, String> {
    Ok(match tray.heartbeat() {
        crate::services::tray_service::TrayExecution::Idle => "idle",
        crate::services::tray_service::TrayExecution::Thinking => "thinking",
        crate::services::tray_service::TrayExecution::Tool => "tool",
        crate::services::tray_service::TrayExecution::Permission => "permission",
        crate::services::tray_service::TrayExecution::Done => "done",
        crate::services::tray_service::TrayExecution::Error => "error",
    }
    .to_string())
}

/// Pre-renders the Verboo mascot into the tray "breathing" frames, mirroring
/// Electron's `trayStatusService`. The mascot PNG is embedded via
/// `include_bytes!` so it always resolves — a relative `std::fs::read` fails
/// in the packaged `.app` (CWD is `/`).
///
/// **Every frame is the SAME pixel size** (44×44); the "breathing" is done by
/// pulsing the mascot's *opacity*, not its size. This is the fix for the
/// menu-bar "shaking": macOS trims the transparent padding of a status-item
/// image, so a size-based breathe changed the icon's *visible* width every
/// frame and the title text jittered (worst on external non-Retina monitors).
/// A constant-size, constant-shape icon has a constant trimmed width → the
/// text never moves, while the mascot still visibly "breathes" via a fade.
///
/// Returns 3 frames indexed [0]=neutral/idle (opaque), [1], [2]=faintest.
/// Empty vec on decode failure (caller falls back to no tray).
fn render_mascot_frames() -> Vec<tauri::image::Image<'static>> {
    const MASCOT_PNG: &[u8] = include_bytes!("../icons/verboo-mascot.png");
    const SIZE: u32 = 44; // constant size (22pt @2×) → constant width → no jitter
    const ALPHAS: [f32; 3] = [1.0, 0.80, 0.62]; // opacity pulse = the breathing
    let Ok(source) = image::load_from_memory(MASCOT_PNG) else {
        return Vec::new();
    };
    let base = source
        .resize_exact(SIZE, SIZE, image::imageops::FilterType::Lanczos3)
        .to_rgba8();
    ALPHAS
        .iter()
        .map(|&alpha| {
            let mut frame = base.clone();
            if alpha < 1.0 {
                for pixel in frame.pixels_mut() {
                    pixel[3] = (pixel[3] as f32 * alpha).round() as u8;
                }
            }
            tauri::image::Image::new_owned(frame.into_raw(), SIZE, SIZE)
        })
        .collect()
}

// ════════════════════════════════════════════════════════════════════
// Skills
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
fn list_skills(working_directory: String) -> Result<Vec<SkillSummary>, String> {
    Ok(crate::services::skills_service::SkillsService::list_skills(
        &working_directory,
    ))
}

#[tauri::command]
fn open_user_skills_folder() -> Result<String, String> {
    let path = crate::services::skills_service::SkillsService::open_user_skills_folder()?;
    Ok(path.to_string_lossy().to_string())
}

/// Returns the untrusted skills (from a list) that need approval before
/// injection into the prompt. The renderer calls this before sending a turn
/// with skills — if the result is non-empty, it shows the permission panel
/// for each unapproved skill.
///
/// Reuses the existing `PermissionApprovalPanel` mechanism — the renderer
/// shows the same panel it uses for command permissions, with the skill
/// name + path as the detail.
#[tauri::command]
fn check_skill_approval(
    skills: Vec<SkillSummary>,
    store: tauri::State<'_, SettingsStore>,
) -> Result<Vec<SkillSummary>, String> {
    let settings = store.get()?;
    Ok(
        crate::services::skills_service::SkillsService::pending_approval_skills(
            &skills,
            &settings.trusted_skills,
        ),
    )
}

/// Persists a "Always Allow" decision for an untrusted skill. After this,
/// the skill passes `filter_approved_skills` without prompting.
#[tauri::command]
fn approve_skill(
    path: String,
    store: tauri::State<'_, SettingsStore>,
) -> Result<UserSettings, String> {
    let mut current = store.get()?;
    if !current.trusted_skills.contains(&path) {
        current.trusted_skills.push(path);
    }
    store.update(serde_json::to_value(&current).map_err(|e| e.to_string())?)
}

/// Fires an OS notification when a background turn completes.
///
/// The renderer calls this in the `done`/`error` handler when:
/// - The conversation that finished is NOT the active conversation (user
///   switched away or is in another chat), OR
/// - The app window is not focused (minimized or in background).
///
/// The backend checks the user's `completion_notifications` setting:
/// - `never` → no notification
/// - `background` → fire only when window is NOT focused
/// - `always` → fire unconditionally
///
/// Uses `notification_service::fire_notification()` for the decision + i18n
/// text, and `tauri_plugin_notification::NotificationExt` for the OS toast.
#[tauri::command]
fn fire_completion_notification(
    exit_code: i32,
    conversation_id: String,
    is_active_conversation: bool,
    store: tauri::State<'_, SettingsStore>,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    use tauri_plugin_notification::NotificationExt;

    let settings = store.get()?;
    // Check if the main window is focused.
    let window_focused = app
        .get_webview_window("main")
        .map(|w| w.is_focused().unwrap_or(false))
        .unwrap_or(false);

    eprintln!(
        "[verboo:notification] fire_completion_notification: exit_code={exit_code}, conv={conversation_id}, is_active={is_active_conversation}, window_focused={window_focused}, mode={:?}",
        settings.completion_notifications
    );

    // If the conversation is active AND the window is focused, don't notify
    // — the user is already looking at it.
    if is_active_conversation && window_focused {
        eprintln!("[verboo:notification] skipping: user is looking at this conversation");
        return Ok(false);
    }

    let kind = if exit_code == 0 {
        crate::services::notification_service::NotificationKind::Done
    } else {
        crate::services::notification_service::NotificationKind::DoneError
    };

    let notification = crate::services::notification_service::fire_notification(
        &settings,
        kind,
        window_focused,
        is_active_conversation,
    );

    if let Some(text) = notification {
        eprintln!(
            "[verboo:notification] firing OS notification: title={:?}, body={:?}",
            text.title, text.body
        );
        // Tauri v2 notification plugin (2.3.3) does not support click
        // callbacks on desktop. As a workaround, we emit `notification-clicked`
        // immediately after showing the toast. Ciri's FE listener
        // `listenForNotificationClick` can use this to navigate to the
        // conversation when the user returns to the app (the event fires
        // on notification show, not on click — but it's the best we can do
        // without a custom macOS notification delegate).
        //
        // TODO: when tauri-plugin-notification adds desktop click support,
        // move this emit into the click callback.
        use tauri::Emitter;
        let _ = app.emit("notification-clicked", &conversation_id);
        app.notification()
            .builder()
            .title(&text.title)
            .body(&text.body)
            .auto_cancel()
            .show()
            .map_err(|e| {
                eprintln!("[verboo:notification] show() failed: {e}");
                format!("show notification: {e}")
            })?;
        Ok(true)
    } else {
        eprintln!(
            "[verboo:notification] suppressed by settings (mode={:?})",
            settings.completion_notifications
        );
        Ok(false)
    }
}

#[tauri::command]
fn get_default_working_directory() -> String {
    // Falls back to $HOME. Used by the renderer when no project is open
    // (workingDirectoryForConversation returns ''). Multi-user safe — no
    // dev-machine paths.
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "/".to_string())
}

// ════════════════════════════════════════════════════════════════════
// @-mention file listing (quick-win #1)
// ════════════════════════════════════════════════════════════════════

/// Lists files in `working_directory` for `@`-mention autocomplete.
///
/// Strategy: `git ls-files --cached --others --exclude-standard -z` when
/// the directory is inside a git repo (respects `.gitignore`); bounded
/// directory walk otherwise (depth 6, cap MAX_ENTRIES, skips noisy build
/// dirs). Output is RELATIVE paths (POSIX-style, sorted, capped at 5000).
///
/// The renderer always receives relative paths; absolute paths outside the
/// workspace are never exposed.
///
/// Async + `spawn_blocking` because the service does filesystem I/O and may
/// spawn `git` (must not block the Tauri async runtime).
#[tauri::command]
async fn list_workspace_files(working_directory: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        services::workspace_files_service::list_workspace_files(&working_directory)
    })
    .await
    .map_err(|e| format!("Falha ao listar arquivos do workspace: {e}"))?
}

// ════════════════════════════════════════════════════════════════════
// Project instruction files (QW2)
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
async fn list_project_instruction_files(
    working_directory: String,
) -> Result<Vec<services::project_instructions_service::ProjectInstructionFile>, String> {
    tokio::task::spawn_blocking(move || {
        services::project_instructions_service::list_project_instruction_files(&working_directory)
    })
    .await
    .map_err(|e| format!("Falha ao listar instruções do projeto: {e}"))?
}

#[tauri::command]
async fn read_project_instruction_file(
    working_directory: String,
    name: String,
) -> Result<services::project_instructions_service::ProjectInstructionReadResult, String> {
    tokio::task::spawn_blocking(move || {
        services::project_instructions_service::read_project_instruction_file(
            &working_directory,
            &name,
        )
    })
    .await
    .map_err(|e| format!("Falha ao ler instrução do projeto: {e}"))?
}

#[tauri::command]
async fn write_project_instruction_file(
    working_directory: String,
    name: String,
    content: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        services::project_instructions_service::write_project_instruction_file(
            &working_directory,
            &name,
            &content,
        )
    })
    .await
    .map_err(|e| format!("Falha ao salvar instrução do projeto: {e}"))?
}

/// Returns the version of the bundled `@verboo/code` package (cli-package).
/// Returns `"unknown"` if the package.json can't be read (e.g., in dev
/// without a full bundle, or after a broken install).
#[tauri::command]
fn get_bundled_cli_version() -> String {
    crate::services::cli_spawn::bundled_cli_version().unwrap_or_else(|| "unknown".to_string())
}

// ════════════════════════════════════════════════════════════════════
// Workspace
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
fn get_workspace_changes(working_directory: String) -> Result<WorkspaceChangeSummary, String> {
    Ok(services::git_service::read_workspace_change_summary(
        &working_directory,
    ))
}

#[tauri::command]
fn get_workspace_branches(working_directory: String) -> Result<WorkspaceBranchInfo, String> {
    Ok(services::git_service::read_workspace_branch_info(
        &working_directory,
    ))
}

#[tauri::command]
fn switch_workspace_branch(
    working_directory: String,
    branch_name: String,
) -> Result<WorkspaceBranchSwitchResult, String> {
    Ok(services::git_service::switch_workspace_branch(
        &working_directory,
        &branch_name,
    ))
}

#[tauri::command]
fn get_workspace_review_metadata(
    working_directory: String,
) -> Result<WorkspaceReviewMetadata, String> {
    Ok(services::git_service::read_workspace_review_metadata(
        &working_directory,
    ))
}

#[tauri::command]
async fn commit_workspace_changes(
    working_directory: String,
    message: String,
) -> Result<WorkspaceCommitResult, String> {
    tokio::task::spawn_blocking(move || {
        services::git_service::commit_workspace_changes(&working_directory, &message)
    })
    .await
    .map_err(|e| format!("Falha ao criar commit: {e}"))
}

#[tauri::command]
async fn create_workspace_pull_request(
    working_directory: String,
    title: String,
    body: Option<String>,
) -> Result<WorkspacePullRequestResult, String> {
    tokio::task::spawn_blocking(move || {
        services::git_service::create_workspace_pull_request(
            &working_directory,
            &title,
            body.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Falha ao criar PR: {e}"))
}

#[tauri::command]
async fn push_workspace_changes(working_directory: String) -> Result<WorkspacePushResult, String> {
    tokio::task::spawn_blocking(move || {
        services::git_service::push_workspace_changes(&working_directory)
    })
    .await
    .map_err(|e| format!("Falha ao fazer push: {e}"))
}

// ════════════════════════════════════════════════════════════════════
// Stale file detector (Multichat Fase A)
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
fn record_file_read(
    conversation_id: String,
    file_path: String,
    detector: tauri::State<'_, crate::services::stale_file_detector::StaleFileDetector>,
) {
    detector.record_read(&conversation_id, &file_path);
}

#[tauri::command]
fn record_file_write(
    conversation_id: String,
    file_path: String,
    detector: tauri::State<'_, crate::services::stale_file_detector::StaleFileDetector>,
) {
    detector.record_write(&conversation_id, &file_path);
}

#[tauri::command]
fn list_stale_files(
    conversation_id: String,
    detector: tauri::State<'_, crate::services::stale_file_detector::StaleFileDetector>,
) -> Vec<String> {
    detector.list_stale(&conversation_id)
}

#[tauri::command]
fn clear_stale_files(
    conversation_id: String,
    detector: tauri::State<'_, crate::services::stale_file_detector::StaleFileDetector>,
) {
    detector.clear_conversation(&conversation_id);
}

#[tauri::command]
fn get_file_diff(
    working_directory: String,
    file_path: String,
    status: FileDiffStatus,
) -> Result<FileDiff, String> {
    Ok(services::git_service::read_file_diff(
        &working_directory,
        &file_path,
        status,
    ))
}

#[tauri::command]
fn revert_file(working_directory: String, file_path: String) -> Result<FileDiffResponse, String> {
    match services::git_service::revert_file(&working_directory, &file_path) {
        Ok(_) => Ok(FileDiffResponse {
            ok: true,
            message: None,
        }),
        Err(e) => Ok(FileDiffResponse {
            ok: false,
            message: Some(e),
        }),
    }
}

#[tauri::command]
fn open_external_file(
    working_directory: String,
    file_path: String,
    app: tauri::AppHandle,
) -> Result<FileDiffResponse, String> {
    use tauri_plugin_opener::OpenerExt;
    // Validate the path stays within the repo (or working_directory if not a
    // git repo). Mirrors Electron's `resolveSafePath` and prevents path
    // traversal attacks from opening arbitrary files outside the workspace.
    let root = std::path::PathBuf::from(&working_directory);
    let safe = match crate::services::git_service::resolve_safe_path_public(&root, &file_path) {
        Some(p) => p,
        None => {
            return Ok(FileDiffResponse {
                ok: false,
                message: Some("Caminho fora do workspace".into()),
            });
        }
    };
    let path_str = safe.to_string_lossy().to_string();
    match app.opener().open_path(path_str, None::<&str>) {
        Ok(_) => Ok(FileDiffResponse {
            ok: true,
            message: None,
        }),
        Err(e) => Ok(FileDiffResponse {
            ok: false,
            message: Some(format!("Falha ao abrir arquivo: {e}")),
        }),
    }
}

// ════════════════════════════════════════════════════════════════════
// Goal
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
fn evaluate_goal(
    input: GoalEvaluationInput,
    credentials: tauri::State<'_, CredentialsStore>,
) -> Result<EvaluationResult, String> {
    let token = crate::services::auth_token::resolve_token(&credentials);
    let result = crate::services::goal_evaluator::GoalEvaluator::evaluate(input, token.as_deref());
    match result {
        Ok(r) => Ok(r.into()),
        Err(e) => {
            // Infra failure → return Pause+InfraError so the FE scheduler
            // receives a predictable decision (NOT an Err throw — the scheduler
            // can't handle promise rejections in runGoalCycle). The FE checks
            // reasonId=infraError to circuit-break.
            Ok(EvaluationResult {
                evaluation: GoalEvaluationResult {
                    decision: GoalDecision::Pause,
                    reason_id: GoalReasonId::InfraError,
                    reason: e.to_string(),
                    session_summary: None,
                    gaps: Vec::new(),
                    next_action: None,
                    completion_summary: None,
                    confidence: 0.0,
                },
                user_message: None,
            })
        }
    }
}

// ════════════════════════════════════════════════════════════════════
// Files
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
async fn pick_files(app: tauri::AppHandle) -> Result<Vec<AttachmentMeta>, String> {
    use tauri_plugin_dialog::DialogExt;
    let paths = app
        .dialog()
        .file()
        .add_filter(
            "Images",
            &["png", "jpg", "jpeg", "gif", "webp", "heic", "heif"],
        )
        .add_filter("All files", &["*"])
        .blocking_pick_files();
    let paths = paths.unwrap_or_default();
    let path_strings: Vec<String> = paths
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    Ok(services::file_service::inspect_files(&path_strings))
}

#[tauri::command]
fn inspect_files(paths: Vec<String>) -> Result<Vec<AttachmentMeta>, String> {
    Ok(services::file_service::inspect_files(&paths))
}

/// Inspects a pasted image (from clipboard base64) and returns its
/// AttachmentMeta. Used by the renderer when the user pastes a screenshot
/// (Ctrl+V / Cmd+V) — the renderer has the base64 from the clipboard API,
/// and this command writes it to a safe temp file and reuses the existing
/// `inspect_attachment` pipeline.
///
/// The temp file is written to `app_data_dir/pasted_images/` with a unique
/// name (timestamp + nanos) to avoid collisions. The extension is derived
/// from the filename (e.g. "screenshot.png" → ".png").
///
/// Returns a vec (not a single AttachmentMeta) to match the `inspect_files`
/// contract so the renderer can treat both paths uniformly.
#[tauri::command]
fn inspect_pasted_image(
    base64: String,
    filename: String,
    app: tauri::AppHandle,
) -> Result<Vec<AttachmentMeta>, String> {
    use base64::Engine;

    // Decode base64. Reject if invalid.
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.trim())
        .map_err(|e| format!("invalid base64: {e}"))?;

    // Resolve app_data_dir for the temp file.
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    let pasted_dir = app_data_dir.join("pasted_images");

    // Delegate to the testable core function.
    let meta =
        services::file_service::write_pasted_image_and_inspect(&bytes, &filename, &pasted_dir)?;
    Ok(vec![meta])
}

/// Saves an avatar image (base64-encoded) to the app data directory.
///
/// The avatar is saved as `avatar.<ext>` (e.g. `avatar.png`). If a previous
/// avatar exists with a different extension, the old file is removed.
///
/// Accepted MIME types: `image/png`, `image/jpeg`, `image/webp`.
/// Maximum size: 10MB decoded.
///
/// Returns the absolute path of the saved file. The renderer stores this
/// path in `UserSettings.avatar.uploadPath`.
#[tauri::command]
fn save_avatar_blob(base64: String, mime: String, app: tauri::AppHandle) -> Result<String, String> {
    use base64::Engine;

    // Decode base64. Reject if invalid.
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.trim())
        .map_err(|e| format!("invalid base64: {e}"))?;

    // Resolve app_data_dir.
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;

    // Delegate to the testable core function.
    let path = services::file_service::save_avatar_blob_core(&bytes, &mime, &app_data_dir)?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let folder = app
        .dialog()
        .file()
        .set_title("Selecionar pasta")
        .blocking_pick_folder();
    Ok(folder
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
async fn create_project_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    // Prompt user to pick a parent directory, then create a new subfolder there.
    let parent = app
        .dialog()
        .file()
        .set_title("Selecionar pasta pai para o novo projeto")
        .blocking_pick_folder();
    let Some(parent_path) = parent.and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    // Generate a unique folder name (verboo-project-<timestamp>)
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let folder_name = format!("verboo-project-{timestamp}");
    let new_path = parent_path.join(&folder_name);
    std::fs::create_dir_all(&new_path).map_err(|e| format!("Falha ao criar pasta: {e}"))?;
    Ok(Some(new_path.to_string_lossy().to_string()))
}

// ════════════════════════════════════════════════════════════════════
// Agent
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
fn send_turn(
    request: AgentTurnRequest,
    resume_session_id: Option<String>,
    app: tauri::AppHandle,
    turn_service: tauri::State<'_, TurnService>,
) -> Result<String, String> {
    turn_service.send_turn(app, request, resume_session_id)
}

#[tauri::command]
async fn run_research_subagents(
    request: ResearchSubagentsRunRequest,
    app: tauri::AppHandle,
    runner: tauri::State<'_, crate::services::research_subagent_runner::ResearchSubagentRunner>,
) -> Result<Vec<ResearchSubagentResult>, String> {
    runner.run_many(app, request).await
}

#[tauri::command]
fn cancel_research_subagents(
    run_id: String,
    runner: tauri::State<'_, crate::services::research_subagent_runner::ResearchSubagentRunner>,
) -> Result<bool, String> {
    runner.cancel_run(&run_id)
}

#[tauri::command]
fn interrupt(
    conversation_id: Option<String>,
    turn_service: tauri::State<'_, TurnService>,
) -> Result<bool, String> {
    turn_service.interrupt(conversation_id)
}

// ════════════════════════════════════════════════════════════════════
// Updates
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
fn get_update_status(
    service: tauri::State<'_, crate::services::update_service::UpdateService>,
) -> Result<UpdateSnapshot, String> {
    Ok(service.snapshot())
}

#[tauri::command]
async fn check_for_updates(
    user_initiated: bool,
    app: tauri::AppHandle,
    service: tauri::State<'_, crate::services::update_service::UpdateService>,
) -> Result<UpdateSnapshot, String> {
    use tauri_plugin_updater::UpdaterExt;
    if !user_initiated && !service.should_auto_check() {
        return Ok(service.snapshot());
    }
    service.mark_checking();
    let _ = app.emit("update:snapshot", service.snapshot());
    let updater = match app.updater_builder().build() {
        Ok(u) => u,
        Err(e) => {
            let snap = service.mark_error(format!("Falha ao criar updater: {e}"));
            let _ = app.emit("update:snapshot", snap.clone());
            return Ok(snap);
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let snap =
                service.mark_available(update.version.clone(), None, None, update.body.clone());
            let _ = app.emit("update:snapshot", snap.clone());
            Ok(snap)
        }
        Ok(None) => {
            let snap = service.mark_not_available();
            let _ = app.emit("update:snapshot", snap.clone());
            Ok(snap)
        }
        Err(e) => {
            let snap = service.mark_error(format!("Falha ao verificar atualizações: {e}"));
            let _ = app.emit("update:snapshot", snap.clone());
            Ok(snap)
        }
    }
}

#[tauri::command]
async fn download_update(
    app: tauri::AppHandle,
    service: tauri::State<'_, crate::services::update_service::UpdateService>,
) -> Result<UpdateSnapshot, String> {
    use tauri_plugin_updater::UpdaterExt;
    service.mark_downloading();
    let _ = app.emit("update:snapshot", service.snapshot());
    let updater = app
        .updater_builder()
        .build()
        .map_err(|e| format!("Falha ao criar updater: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("Falha ao verificar: {e}"))?
        .ok_or_else(|| "Nenhuma atualização disponível".to_string())?;
    let app_for_chunk = app.clone();
    let service_handle = service.clone_handle();
    let result = update
        .download_and_install(
            move |chunk_len, total| {
                if let Some(total) = total {
                    let percent = (chunk_len as f64 / total as f64) * 100.0;
                    let snap = service_handle.mark_download_progress(
                        percent,
                        chunk_len as u64,
                        total,
                        0.0,
                    );
                    let _ = app_for_chunk.emit("update:snapshot", snap);
                }
            },
            || {},
        )
        .await;
    if let Err(e) = result {
        let snap = service.mark_error(format!("Falha ao baixar: {e}"));
        let _ = app.emit("update:snapshot", snap.clone());
        return Ok(snap);
    }
    let snap = service.mark_downloaded();
    let _ = app.emit("update:snapshot", snap.clone());
    Ok(snap)
}

#[tauri::command]
fn install_update(
    app: tauri::AppHandle,
    service: tauri::State<'_, crate::services::update_service::UpdateService>,
) -> Result<bool, String> {
    if !service.can_install() {
        return Err("Atualização ainda não foi baixada".into());
    }
    // Tauri's built-in restart spawns a new instance and exits the current one.
    // The updater plugin installs on quit, so this applies the update.
    app.restart();
}

// ════════════════════════════════════════════════════════════════════
// Terminal
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
fn terminal_start(
    request: LocalTerminalStartRequest,
    app: tauri::AppHandle,
    terminal_service: tauri::State<'_, TerminalService>,
) -> Result<LocalTerminalSession, String> {
    terminal_service.start(app, request)
}

#[tauri::command]
fn terminal_write(
    session_id: String,
    data: String,
    terminal_service: tauri::State<'_, TerminalService>,
) -> Result<bool, String> {
    terminal_service.write(&session_id, &data)
}

#[tauri::command]
fn terminal_resize(
    session_id: String,
    cols: u32,
    rows: u32,
    terminal_service: tauri::State<'_, TerminalService>,
) -> Result<bool, String> {
    terminal_service.resize(&session_id, cols, rows)
}

#[tauri::command]
fn terminal_stop(
    session_id: String,
    terminal_service: tauri::State<'_, TerminalService>,
) -> Result<bool, String> {
    terminal_service.stop(&session_id)
}

#[tauri::command]
fn terminal_get_state(
    terminal_service: tauri::State<'_, TerminalService>,
) -> Result<Option<LocalTerminalSession>, String> {
    terminal_service.get_state()
}

// ════════════════════════════════════════════════════════════════════
// Clipboard
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
fn clipboard_read_text(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .read_text()
        .map_err(|e| format!("Falha ao ler clipboard: {e}"))
}

#[tauri::command]
fn clipboard_write_text(app: tauri::AppHandle, text: String) -> Result<bool, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(&text)
        .map_err(|e| format!("Falha ao escrever clipboard: {e}"))?;
    Ok(true)
}

// ════════════════════════════════════════════════════════════════════
// App entry point
// ════════════════════════════════════════════════════════════════════

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // ── Plugins ────────────────────────────────────────────
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        // ── State ──────────────────────────────────────────────
        .manage(AppState::new())
        .setup(|app| {
            // Initialize persistent settings store at {app_data_dir}/settings.json
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("app data dir must be available");
            let _ = std::fs::create_dir_all(&app_data_dir);
            let settings_store = SettingsStore::new(app_data_dir.clone());

            // Request macOS notification permission. On macOS, notifications
            // are blocked by default until the app requests permission. This
            // is a no-op on Windows/Linux (permission is granted at install).
            // Must happen before any notification is shown, otherwise the OS
            // silently drops them.
            {
                use tauri_plugin_notification::NotificationExt;
                match app.notification().request_permission() {
                    Ok(state) => eprintln!("[verboo:notification] permission state: {:?}", state),
                    Err(e) => eprintln!("[verboo:notification] request_permission failed: {e}"),
                }
            }

            // Clone BEFORE moving into `app.manage` so the same store can be
            // shared with TurnService (which reads `prevent_sleep_while_running`
            // at turn start). Both clones read/write the same `settings.json`.
            let settings_store_for_turn = settings_store.clone();
            app.manage(settings_store);
            // CredentialsStore — OS-native keyring for API key & OAuth tokens
            // Two instances: one for tauri::State (renderer commands), one
            // Arc-shared with TurnService so it can inject the key into spawns.
            // Both see the same OS keyring, so this is safe.
            app.manage(CredentialsStore::new());
            // CliService — spawns `verboo` CLI for auth/turns/models
            app.manage(CliService::new());
            // ModelService — fetches models from Verboo Router API with disk cache
            app.manage(ModelService::new(app_data_dir.clone()));
            // TurnService — spawns `verboo` CLI for agent turns with streaming
            app.manage(
                TurnService::new(std::sync::Arc::new(CredentialsStore::new()))
                    .with_settings(std::sync::Arc::new(settings_store_for_turn))
                    .with_app_data_dir(app_data_dir.clone()),
            );
            // ResearchSubagentRunner — spawns read-only CLI turns for research
            // subagents. Shares a CredentialsStore (Arc) so it can resolve the
            // bearer token (CLI OAuth first, API key fallback) the same way
            // TurnService does.
            app.manage(
                crate::services::research_subagent_runner::ResearchSubagentRunner::new(
                    std::sync::Arc::new(CredentialsStore::new()),
                ),
            );
            // TerminalService — PTY for the local terminal panel
            app.manage(TerminalService::new());
            // TrayService — owns the menubar state machine (icon/title animation)
            app.manage(crate::services::tray_service::TrayService::new());
            // UpdateService — owns the updater snapshot + auto-check timer logic
            app.manage(crate::services::update_service::UpdateService::new(
                env!("CARGO_PKG_VERSION").into(),
                cfg!(debug_assertions) == false,
            ));
            // LifecycleService — owns the first-launch requirements flag
            app.manage(crate::services::lifecycle_service::LifecycleService::new(
                app_data_dir.clone(),
            ));
            // StaleFileDetector — tracks file snapshots per conversation
            app.manage(crate::services::stale_file_detector::StaleFileDetector::new());
            app.manage(crate::services::computer_use_service::ComputerUseService::new());
            app.manage(crate::services::computer_use_layout::ComputerUseLayoutService::new());

            // Crash recovery is authorized only while this process holds the
            // machine-owner lock. It removes stale capability first, then
            // restores only windows recorded by the focus helper.
            match crate::services::computer_use_mcp::recover_stale_runtime() {
                Ok(true) => eprintln!("[computer-use] restored stale focused windows"),
                Ok(false) => {}
                Err(error) => {
                    eprintln!("[computer-use] stale runtime preserved for safe retry: {error}")
                }
            }

            // ── System tray (macOS menubar / Win+Linux notification area) ──────
            // The tray icon shows the Verboo logo on Win/Linux and the animated
            // title on macOS (which puts a text title next to the icon). Matches
            // Electron's trayStatusService.
            // Colored mascot frames (breathing animation), embedded so they
            // resolve in the packaged app. Mirrors Electron's tray.
            let mascot_frames = render_mascot_frames();
            let tray = if !mascot_frames.is_empty() {
                tauri::tray::TrayIconBuilder::with_id("verboo-main")
                    .icon(mascot_frames[0].clone())
                    .icon_as_template(false) // colored mascot, like Electron
                    .tooltip("Verboo Code")
                    .build(app)
                    .ok()
            } else {
                None
            };
            // Drive the tray tick loop (~250ms): advances the spinner text AND
            // the "breathing" mascot icon (set_icon per frame), + 3.5s
            // auto-reset. Background thread so it doesn't compete with the UI.
            // Mirrors Electron's trayStatusService ticker.
            // Load initial settings so show_in_menu_bar + update toggles are
            // respected from first paint (not only after the user flips them).
            if let Ok(settings) = app.state::<SettingsStore>().get() {
                app.state::<crate::services::tray_service::TrayService>()
                    .configure(&settings);
                let _ = app
                    .state::<crate::services::update_service::UpdateService>()
                    .configure(settings.updates.clone());
                if let Some(ref icon) = tray {
                    let _ = icon.set_visible(settings.show_in_menu_bar);
                }
            }

            if let Some(tray_icon) = tray.clone() {
                let tray_service = app
                    .state::<crate::services::tray_service::TrayService>()
                    .inner()
                    .handle();
                let frames = mascot_frames;
                std::thread::spawn(move || {
                    let mut last_tick = std::time::Instant::now();
                    let mut last_icon_idx = 0usize;
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        // Auto-reset on Done/Error after 3.5s.
                        if tray_service.should_reset() {
                            tray_service.reset_to_idle();
                        }
                        // Honor settings: hide tray entirely when disabled.
                        let enabled = tray_service.is_enabled();
                        let _ = tray_icon.set_visible(enabled);
                        if !enabled {
                            continue;
                        }
                        // Advance breathing frame (icon only — no title thrash).
                        let _ = tray_service.tick();
                        // Refresh title at most once per second, and only when
                        // the string actually changed (elapsed unit rollover).
                        if last_tick.elapsed() >= std::time::Duration::from_millis(1000) {
                            last_tick = std::time::Instant::now();
                            #[cfg(target_os = "macos")]
                            {
                                if let Some(title) = tray_service.take_title_if_changed() {
                                    let _ = tray_icon.set_title(Some(title.as_str()));
                                }
                            }
                        }
                        // Breathing mascot: constant-size frames, swap by index.
                        if !frames.is_empty() {
                            let size = tray_service.icon_frame();
                            let idx = match size {
                                17 => 1,
                                16 => 2,
                                _ => 0,
                            };
                            if idx != last_icon_idx {
                                last_icon_idx = idx;
                                if let Some(frame) = frames.get(idx) {
                                    let _ = tray_icon.set_icon(Some(frame.clone()));
                                }
                            }
                        }
                    }
                });
            }

            // ── Close-to-tray (macOS hides, Win/Linux quits) ───────
            // Mirrors Electron's `shouldCloseToTray` (src/main/index.ts:580).
            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if crate::services::lifecycle_service::should_close_to_tray() {
                            // macOS: prevent the close, just hide. The tray icon
                            // stays alive so the user can click it to re-show.
                            api.prevent_close();
                            let _ = window_clone.hide();
                        } else {
                            // Win/Linux: actually quit (the default behavior).
                            // Allow the close so the app exits cleanly.
                            app_handle.exit(0);
                        }
                    }
                });
            }
            // macOS titlebar (Overlay/hiddenTitle/trafficLightPosition) is configured
            // in tauri.conf.json — those fields are macOS-only and ignored on Win/Linux,
            // which get the native titlebar as required by doc 04 §1.

            // Emit initial platform so the CSS selector works
            let platform = if cfg!(target_os = "macos") {
                "darwin"
            } else if cfg!(target_os = "windows") {
                "win32"
            } else {
                "linux"
            };
            let _ = app.emit("app:refresh-data", ());

            // Store platform for get_config
            let state: tauri::State<'_, AppState> = app.state();
            if let Ok(mut config) = state.config.lock() {
                config.platform = match platform {
                    "darwin" => Platform::Darwin,
                    "win32" => Platform::Win32,
                    _ => Platform::Linux,
                };
            }

            Ok(())
        })
        // ── Commands (47) ──────────────────────────────────────
        .invoke_handler(tauri::generate_handler![
            // Config
            get_config,
            // Auth
            start_cli_login,
            get_cli_auth_status,
            logout,
            open_dashboard,
            open_subscriptions,
            open_signup,
            // Credentials
            get_credential_status,
            set_api_key,
            clear_api_key,
            // Models
            list_models,
            // Profile
            get_profile,
            // Feedback
            send_feedback,
            // Settings
            get_user_settings,
            update_user_settings,
            reset_user_settings,
            // Vision fallback (FASE 1)
            get_vision_fallback_state,
            set_vision_fallback_consent,
            // Menu bar
            update_menu_bar,
            force_idle_menu_bar,
            heartbeat_menu_bar,
            // Skills
            list_skills,
            open_user_skills_folder,
            // Skill approval gating (item 1.8)
            check_skill_approval,
            approve_skill,
            // Computer Use allowlist + session + actions (P0.3, Geralt)
            get_computer_use_allowlist,
            update_computer_use_allowlist,
            remove_computer_use_allowlist,
            request_computer_use_session,
            grant_computer_use_session,
            approve_computer_use_app,
            get_pending_computer_use_confirmation,
            decide_computer_use_confirmation,
            deny_computer_use_session,
            stop_computer_use_session,
            get_computer_use_layout_state,
            pause_computer_use_session,
            resume_computer_use_session,
            select_computer_use_executor,
            persist_computer_use_executor_lease,
            get_computer_use_executor_lease,
            recover_computer_use_executor_lease,
            clear_computer_use_executor_lease,
            list_computer_use_apps,
            list_apps,
            resolve_computer_use_app,
            get_computer_use_permissions,
            request_computer_use_permissions,
            open_computer_use_permission_settings,
            get_computer_use_helper_path,
            reveal_computer_use_helper,
            // Background turn completion notification (item 1.5)
            fire_completion_notification,
            // Defaults
            get_default_working_directory,
            get_bundled_cli_version,
            // Workspace
            get_workspace_changes,
            get_workspace_branches,
            switch_workspace_branch,
            get_workspace_review_metadata,
            commit_workspace_changes,
            create_workspace_pull_request,
            push_workspace_changes,
            record_file_read,
            record_file_write,
            list_stale_files,
            clear_stale_files,
            get_file_diff,
            revert_file,
            open_external_file,
            // Goal
            evaluate_goal,
            // Files
            pick_files,
            inspect_files,
            inspect_pasted_image,
            save_avatar_blob,
            pick_folder,
            create_project_folder,
            // @-mention file listing (quick-win #1)
            list_workspace_files,
            // Project instruction files (QW2)
            list_project_instruction_files,
            read_project_instruction_file,
            write_project_instruction_file,
            // Agent
            send_turn,
            run_research_subagents,
            cancel_research_subagents,
            interrupt,
            // Updates
            get_update_status,
            check_for_updates,
            download_update,
            install_update,
            // Terminal
            terminal_start,
            terminal_write,
            terminal_resize,
            terminal_stop,
            terminal_get_state,
            // Clipboard
            clipboard_read_text,
            clipboard_write_text,
        ])
        .build(tauri::generate_context!())
        .expect("error while building verboo-desktop")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                if let Err(error) = crate::services::computer_use_mcp::shutdown_owned_runtime() {
                    eprintln!("[computer-use] shutdown cleanup failed: {error}");
                }
                if let Some(layout) = app
                    .try_state::<crate::services::computer_use_layout::ComputerUseLayoutService>(
                ) {
                    if let Ok(state) = layout.state() {
                        if let Some(session_id) = state.session_id {
                            if let Err(error) = layout.restore(app, &session_id) {
                                eprintln!("[computer-use] shutdown layout restore failed: {error}");
                            }
                        }
                    }
                }
            }
        });
}
