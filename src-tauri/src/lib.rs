pub mod models;
pub mod services;

use std::sync::Mutex;
use std::time::{Duration, Instant};

use models::types::*;
use services::chrome_integration::{
    ChromeIntegrationRequest, ChromeIntegrationService, ChromeIntegrationStatus,
};
use services::cli_service::CliService;
use services::credentials_store::CredentialsStore;
use services::model_service::ModelService;
use services::profile_service::ProfileService;
use services::settings_store::SettingsStore;
use services::terminal_service::TerminalService;
use services::turn_service::{TurnService, UpdateInstallAdmission};
use tauri::{Emitter, Manager};

// Derivation from current timing bounds: finalizing one recording is bounded by
// RECORDING_STOP_TIMEOUT (8 s); WDA graceful escalation is bounded by
// WDA_SIGINT_GRACE_PERIOD (5 s) plus WDA_SIGTERM_GRACE_PERIOD (2 s), leaving
// 1 s of margin when no recording consumes it.
// Recording and the cumulative shutdown pass over N ledger-owned UDIDs share
// this same absolute deadline, so their worst-case maxima are not additive. N
// is runtime ledger data, never a hardcoded owner/device count; remeasure the
// end-to-end envelope before changing this value.
const IOS_SIMULATOR_CLEANUP_BUDGET: Duration = Duration::from_secs(8);

fn stop_ios_simulator_for_app_exit(app_handle: &tauri::AppHandle) {
    let deadline = Instant::now() + IOS_SIMULATOR_CLEANUP_BUDGET;
    let service = app_handle.state::<services::ios_simulator::IosSimulatorService>();
    service.begin_exit();
    app_handle
        .state::<services::ios_simulator::IosSimulatorBridge>()
        .stop();
    let _ = service.stop_for_app_exit(deadline);
}

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
    /// G-C15: evaluator token usage for THIS evaluation call, separate from
    /// agent turn usage. The renderer sums turn + evaluator tokens for the
    /// total the user asked for. `None` when the CLI envelope omitted usage
    /// or the usage block was malformed — counting failure must NEVER break
    /// the goal. Serialized as `evaluatorUsage` (camelCase) to TS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    evaluator_usage: Option<crate::models::types::TokenUsage>,
}

impl From<crate::services::goal_evaluator::EvaluationResult> for EvaluationResult {
    fn from(value: crate::services::goal_evaluator::EvaluationResult) -> Self {
        let user_message = value.evaluation.next_action.clone();
        Self {
            evaluation: value.evaluation,
            user_message,
            evaluator_usage: value.evaluator_usage,
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
async fn start_cli_login(
    app: tauri::AppHandle,
    cli: tauri::State<'_, CliService>,
) -> Result<LoginResult, String> {
    cli.start_cli_login_nonblocking(app)
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
// Verboo in Chrome
// ════════════════════════════════════════════════════════════════════

// These operations read manifests and spawn helper/CLI processes; on the
// Tauri main thread they beachball the whole UI, so every command hops to
// the blocking pool and the webview stays responsive.
async fn with_chrome_service<T, F>(
    service: tauri::State<'_, std::sync::Arc<ChromeIntegrationService>>,
    operation: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&ChromeIntegrationService) -> Result<T, String> + Send + 'static,
{
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || operation(&service))
        .await
        .map_err(|error| format!("chrome integration task failed: {error}"))?
}

#[tauri::command]
async fn chrome_integration_status(
    service: tauri::State<'_, std::sync::Arc<ChromeIntegrationService>>,
) -> Result<ChromeIntegrationStatus, String> {
    with_chrome_service(service, |service| service.status()).await
}

#[tauri::command]
async fn chrome_integration_configure(
    request: ChromeIntegrationRequest,
    service: tauri::State<'_, std::sync::Arc<ChromeIntegrationService>>,
) -> Result<ChromeIntegrationStatus, String> {
    with_chrome_service(service, move |service| service.configure(request)).await
}

#[tauri::command]
async fn chrome_integration_repair(
    request: ChromeIntegrationRequest,
    service: tauri::State<'_, std::sync::Arc<ChromeIntegrationService>>,
) -> Result<ChromeIntegrationStatus, String> {
    with_chrome_service(service, move |service| service.repair(request)).await
}

#[tauri::command]
async fn chrome_integration_test(
    service: tauri::State<'_, std::sync::Arc<ChromeIntegrationService>>,
) -> Result<bool, String> {
    with_chrome_service(service, |service| service.test_connection()).await
}

#[tauri::command]
async fn chrome_integration_remove(
    service: tauri::State<'_, std::sync::Arc<ChromeIntegrationService>>,
) -> Result<ChromeIntegrationStatus, String> {
    with_chrome_service(service, |service| service.remove()).await
}

#[tauri::command]
fn open_chrome_extension_store(
    app: tauri::AppHandle,
    service: tauri::State<'_, std::sync::Arc<ChromeIntegrationService>>,
) -> Result<bool, String> {
    let url = service.store_url().ok_or("chrome_store_url_missing")?;
    open_external_url(&app, url)
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
    app: tauri::AppHandle,
) -> Result<UserSettings, String> {
    let next = store.update(patch)?;
    apply_runtime_settings(&next, &tray, &updates, &app);
    Ok(next)
}

#[tauri::command]
fn reset_user_settings(
    store: tauri::State<'_, SettingsStore>,
    tray: tauri::State<'_, crate::services::tray_service::TrayService>,
    updates: tauri::State<'_, crate::services::update_service::UpdateService>,
    app: tauri::AppHandle,
) -> Result<UserSettings, String> {
    let next = store.reset()?;
    // Reset must also re-apply side effects (tray visible again, update flags).
    apply_runtime_settings(&next, &tray, &updates, &app);
    Ok(next)
}

/// Returns the current vision fallback consent + a preview of which model
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

/// Returns the active signed CLI version managed under the app-data directory.
/// The command name is retained for renderer API compatibility.
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
        // 2026-07-31 field fix: propagate the Err to the FE instead of
        // fabricating a Pause+InfraError envelope. The previous behavior
        // bypassed the scheduler's retry mesh (1s/2s/4s/8s backoff in
        // goalScheduler.ts) by returning Ok — the FE caught the
        // reasonId=infraError and paused IMMEDIATELY on the first parse
        // failure, never giving the unwrap retry a chance. The contract
        // documented at goalScheduler.ts:111-117 ("Callers must NOT
        // swallow errors into a fake continue decision") was already
        // explicit on the FE side; this side was the violator.
        //
        // Propagating Err lets the scheduler count consecutive failures
        // (catch at line 557), retry with backoff, and pause at the 3rd
        // consecutive failure with the message visible in the panel.
        // The Err message includes the first 500 chars of the raw CLI
        // output (truncated at extract_evaluation_json) so operators can
        // diagnose intermittent fence-wrapped outputs.
        Err(e) => Err(e.to_string()),
    }
}

// ════════════════════════════════════════════════════════════════════
// Files
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
async fn pick_files(
    app: tauri::AppHandle,
) -> Result<Vec<AttachmentMeta>, services::file_service::FileInspectionError> {
    use tauri_plugin_dialog::DialogExt;
    let paths = app
        .dialog()
        .file()
        .add_filter(
            "Images",
            &["png", "jpg", "jpeg", "gif", "webp", "heic", "heif"],
        )
        .add_filter("Videos", &["mp4", "mov", "webm", "mkv", "avi", "m4v"])
        .add_filter("All files", &["*"])
        .blocking_pick_files();
    let paths = paths.unwrap_or_default();
    let path_strings: Vec<String> = paths
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    services::file_service::inspect_files_result(&path_strings)
}

#[tauri::command]
fn inspect_files(
    paths: Vec<String>,
) -> Result<Vec<AttachmentMeta>, services::file_service::FileInspectionError> {
    services::file_service::inspect_files_result(&paths)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BeginPastedFileUploadResult {
    upload_id: String,
}

#[tauri::command]
fn begin_pasted_file_upload(
    name: String,
    size: u64,
    media_type: String,
    uploads: tauri::State<'_, services::pasted_file_upload::PastedFileUploadService>,
) -> Result<BeginPastedFileUploadResult, String> {
    uploads
        .begin(&name, size, &media_type)
        .map(|upload_id| BeginPastedFileUploadResult { upload_id })
}

#[tauri::command]
fn append_pasted_file_chunk(
    upload_id: String,
    offset: u64,
    bytes: Vec<u8>,
    uploads: tauri::State<'_, services::pasted_file_upload::PastedFileUploadService>,
) -> Result<(), String> {
    uploads.append(&upload_id, offset, &bytes)
}

#[tauri::command]
fn finish_pasted_file_upload(
    upload_id: String,
    uploads: tauri::State<'_, services::pasted_file_upload::PastedFileUploadService>,
) -> Result<AttachmentMeta, String> {
    uploads.finish(&upload_id)
}

#[tauri::command]
fn abort_pasted_file_upload(
    upload_id: String,
    uploads: tauri::State<'_, services::pasted_file_upload::PastedFileUploadService>,
) -> Result<(), String> {
    uploads.abort(&upload_id)
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
    coordinator: tauri::State<'_, crate::services::update_coordinator::UpdateCoordinator>,
) -> Result<UpdateSnapshot, String> {
    Ok(coordinator.snapshot())
}

#[tauri::command]
async fn bootstrap_cli(
    app: tauri::AppHandle,
    coordinator: tauri::State<'_, crate::services::update_coordinator::UpdateCoordinator>,
) -> Result<UpdateSnapshot, String> {
    let coordinator = coordinator.inner().clone();
    let _operation = coordinator.begin_operation().await;
    let service = coordinator
        .cli()
        .ok_or_else(|| "Verboo CLI bootstrap is unavailable in this build".to_string())?;

    if service.snapshot().current_version.is_some() {
        return Ok(emit_update_snapshot(&app, &coordinator));
    }

    let mut task = tauri::async_runtime::spawn_blocking(move || service.bootstrap_if_missing());
    loop {
        tokio::select! {
            result = &mut task => {
                match result {
                    Ok(Ok(_)) => return Ok(emit_update_snapshot(&app, &coordinator)),
                    Ok(Err(error)) => {
                        eprintln!("[verboo:cli-update] bootstrap failed: {error}");
                        return Ok(emit_update_snapshot(&app, &coordinator));
                    }
                    Err(error) => {
                        return Err(format!("Falha interna ao instalar o CLI: {error}"));
                    }
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                emit_update_snapshot(&app, &coordinator);
            }
        }
    }
}

fn emit_update_snapshot(
    app: &tauri::AppHandle,
    coordinator: &crate::services::update_coordinator::UpdateCoordinator,
) -> UpdateSnapshot {
    let snapshot = coordinator.snapshot();
    let _ = app.emit("update:snapshot", snapshot.clone());
    snapshot
}

#[tauri::command]
async fn check_for_updates(
    user_initiated: bool,
    app: tauri::AppHandle,
    coordinator: tauri::State<'_, crate::services::update_coordinator::UpdateCoordinator>,
) -> Result<UpdateSnapshot, String> {
    let coordinator = coordinator.inner().clone();
    let _operation = coordinator.begin_operation().await;
    let app_updates = coordinator.app();
    if !user_initiated && !app_updates.should_auto_check() {
        return Ok(coordinator.snapshot());
    }

    let check_app = !app_updates.can_install();
    let cli_updates = coordinator.cli().filter(|service| {
        !matches!(
            service.snapshot().status,
            services::cli_update::service::CliUpdateStatus::Ready
        )
    });

    if check_app {
        app_updates.mark_checking();
    }
    emit_update_snapshot(&app, &coordinator);

    let app_check = check_app_update(&app, &coordinator, &app_updates, check_app);
    let cli_check = async move {
        let Some(service) = cli_updates else {
            return Ok::<(), String>(());
        };
        tauri::async_runtime::spawn_blocking(move || service.check())
            .await
            .map_err(|error| format!("Falha interna ao verificar o CLI: {error}"))?
            .map(|_| ())
    };
    let (_, cli_result) = tokio::join!(app_check, cli_check);
    if let Err(error) = cli_result {
        eprintln!("[verboo:cli-update] {error}");
    }
    let snapshot = emit_update_snapshot(&app, &coordinator);
    Ok(snapshot)
}

async fn check_app_update(
    app: &tauri::AppHandle,
    coordinator: &crate::services::update_coordinator::UpdateCoordinator,
    service: &crate::services::update_service::UpdateService,
    should_check: bool,
) {
    use tauri_plugin_updater::UpdaterExt;
    if !should_check {
        return;
    }
    let endpoint: tauri::Url = match service.endpoint().parse() {
        Ok(endpoint) => endpoint,
        Err(e) => {
            service.mark_error(format!("Endpoint de atualização inválido: {e}"));
            emit_update_snapshot(app, coordinator);
            return;
        }
    };
    let updater = match app
        .updater_builder()
        .endpoints(vec![endpoint])
        .and_then(|builder| builder.build())
    {
        Ok(u) => u,
        Err(e) => {
            service.mark_error(format!("Falha ao configurar updater: {e}"));
            emit_update_snapshot(app, coordinator);
            return;
        }
    };
    let active_result = updater.check().await;
    // `active_check_ok` is true when the active-channel probe returned
    // Ok(Some) or Ok(None) — i.e. the manifest was served and parsed.
    // Used by `run_stable_probe` to short-circuit a second probe when
    // the user is already on the Stable channel.
    let active_check_ok = matches!(&active_result, Ok(_));
    match active_result {
        Ok(Some(update)) => {
            service.mark_available(update.version.clone(), None, None, update.body.clone())
        }
        Ok(None) => service.mark_not_available(),
        Err(e) => service.mark_error(format!("Falha ao verificar atualizações: {e}")),
    };
    emit_update_snapshot(app, coordinator);

    // Probe the Stable channel availability (silent — does NOT call
    // mark_error). When the user is on Beta, this is an independent
    // probe of STABLE_UPDATE_ENDPOINT. When the user is on Stable,
    // `run_stable_probe` reuses `active_check_ok` and skips the probe.
    // 404 / network error / malformed manifest → false (fail-closed).
    let app_for_probe = app.clone();
    let stable_snap = service
        .run_stable_probe(active_check_ok, |endpoint| async move {
            probe_endpoint_serves_manifest(&app_for_probe, endpoint).await
        })
        .await;
    let _ = stable_snap;
    emit_update_snapshot(app, coordinator);
}

/// Probes a single updater endpoint and returns `true` when it serves a
/// valid manifest (HTTP 200 + parseable JSON, regardless of whether a
/// newer version is available). Returns `false` for HTTP 404, network
/// error, or malformed manifest — fail-closed.
///
/// Used by `check_for_updates` to populate `stable_channel_available`
/// without surfacing errors to the user. A missing stable channel is a
/// normal state (the app is beta-only today), not an error.
async fn probe_endpoint_serves_manifest(app: &tauri::AppHandle, endpoint: &'static str) -> bool {
    use tauri_plugin_updater::UpdaterExt;
    let url: tauri::Url = match endpoint.parse() {
        Ok(u) => u,
        Err(_) => return false,
    };
    let updater = match app
        .updater_builder()
        .endpoints(vec![url])
        .and_then(|b| b.build())
    {
        Ok(u) => u,
        Err(_) => return false,
    };
    // Ok(Some) = manifest valid + newer version available
    // Ok(None) = manifest valid + no newer version (channel exists)
    // Err      = 404 / network error / malformed manifest (no channel)
    matches!(updater.check().await, Ok(_))
}

#[tauri::command]
async fn download_update(
    user_initiated: bool,
    app: tauri::AppHandle,
    coordinator: tauri::State<'_, crate::services::update_coordinator::UpdateCoordinator>,
) -> Result<UpdateSnapshot, String> {
    let coordinator = coordinator.inner().clone();
    let _operation = coordinator.begin_operation().await;
    let app_updates = coordinator.app();
    let download_app = matches!(app_updates.snapshot().status, UpdateStatus::Available);
    let cli_updates = coordinator.cli().filter(|service| {
        user_initiated
            && matches!(
                service.snapshot().status,
                services::cli_update::service::CliUpdateStatus::Available
            )
    });

    if !download_app && cli_updates.is_none() {
        return Ok(coordinator.snapshot());
    }

    let app_download = download_app_update(
        &app,
        &coordinator,
        &app_updates,
        download_app,
    );
    let cli_download = prepare_cli_update(app.clone(), coordinator.clone(), cli_updates);
    let (app_result, cli_result) = tokio::join!(app_download, cli_download);
    app_result?;
    cli_result?;
    Ok(emit_update_snapshot(&app, &coordinator))
}

async fn download_app_update(
    app: &tauri::AppHandle,
    coordinator: &crate::services::update_coordinator::UpdateCoordinator,
    service: &crate::services::update_service::UpdateService,
    should_download: bool,
) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    if !should_download {
        return Ok(());
    }
    let ticket = match service.begin_download()? {
        Some(ticket) => ticket,
        None => return Ok(()),
    };
    emit_update_snapshot(app, coordinator);
    let endpoint: tauri::Url =
        match crate::services::update_service::UpdateService::endpoint_for(&ticket).parse() {
            Ok(endpoint) => endpoint,
            Err(e) => {
                service.finish_download_error(
                    &ticket,
                    format!("Endpoint de atualização inválido: {e}"),
                );
                emit_update_snapshot(app, coordinator);
                return Ok(());
            }
        };
    let updater = match app
        .updater_builder()
        .endpoints(vec![endpoint])
        .and_then(|builder| builder.build())
    {
        Ok(updater) => updater,
        Err(e) => {
            service.finish_download_error(&ticket, format!("Falha ao configurar updater: {e}"));
            emit_update_snapshot(app, coordinator);
            return Ok(());
        }
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            service.finish_download_error(&ticket, "Nenhuma atualização disponível".into());
            emit_update_snapshot(app, coordinator);
            return Ok(());
        }
        Err(e) => {
            service.finish_download_error(&ticket, format!("Falha ao verificar: {e}"));
            emit_update_snapshot(app, coordinator);
            return Ok(());
        }
    };
    if !service.bind_download_version(&ticket, &update.version)? {
        return Ok(());
    }
    let app_for_chunk = app.clone();
    let coordinator_for_chunk = coordinator.clone();
    let service_handle = service.clone_handle();
    let ticket_for_chunk = ticket.clone();
    let mut transferred = 0_u64;
    let started = std::time::Instant::now();
    let result = update
        .download(
            move |chunk_len, total| {
                transferred = transferred.saturating_add(chunk_len as u64);
                if let Some(total) = total {
                    let seconds = started.elapsed().as_secs_f64().max(0.001);
                    let changed = service_handle.mark_download_progress_for(
                        &ticket_for_chunk,
                        transferred,
                        total,
                        transferred as f64 / seconds,
                    );
                    if changed.is_some() {
                        emit_update_snapshot(&app_for_chunk, &coordinator_for_chunk);
                    }
                }
            },
            || {},
        )
        .await;
    let bytes = match result {
        Ok(bytes) => bytes,
        Err(e) => {
            service.finish_download_error(&ticket, format!("Falha ao baixar: {e}"));
            emit_update_snapshot(app, coordinator);
            return Ok(());
        }
    };
    if let Err(error) = service.stage_downloaded(&ticket, update, bytes) {
        service.finish_download_error(&ticket, format!("Falha ao preparar atualização: {error}"));
    }
    emit_update_snapshot(app, coordinator);
    Ok(())
}

async fn prepare_cli_update(
    app: tauri::AppHandle,
    coordinator: crate::services::update_coordinator::UpdateCoordinator,
    service: Option<services::cli_update::CliUpdateService>,
) -> Result<(), String> {
    let Some(service) = service else {
        return Ok(());
    };
    let mut task = tauri::async_runtime::spawn_blocking(move || service.prepare());
    loop {
        tokio::select! {
            result = &mut task => {
                match result {
                    Ok(Ok(_)) | Ok(Err(_)) => {
                        emit_update_snapshot(&app, &coordinator);
                        return Ok(());
                    }
                    Err(error) => {
                        return Err(format!("Falha interna ao preparar o CLI: {error}"));
                    }
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                emit_update_snapshot(&app, &coordinator);
            }
        }
    }
}

#[tauri::command]
async fn install_update(
    app: tauri::AppHandle,
    coordinator: tauri::State<'_, crate::services::update_coordinator::UpdateCoordinator>,
    turns: tauri::State<'_, TurnService>,
) -> Result<InstallUpdateResult, String> {
    let coordinator = coordinator.inner().clone();
    let _operation = coordinator.begin_operation().await;
    let app_updates = coordinator.app();
    let cli_updates = coordinator.cli();
    let app_ready = app_updates.can_install();
    let cli_ready = cli_updates.as_ref().is_some_and(|service| {
        matches!(
            service.snapshot().status,
            services::cli_update::service::CliUpdateStatus::Ready
        )
    });
    let app_still_available = matches!(app_updates.snapshot().status, UpdateStatus::Available);
    let cli_still_available = cli_updates.as_ref().is_some_and(|service| {
        matches!(
            service.snapshot().status,
            services::cli_update::service::CliUpdateStatus::Available
        )
    });
    if (!app_ready && !cli_ready) || app_still_available || cli_still_available {
        return Err("Atualização ainda não foi baixada".into());
    }
    let _install_lease = match turns.begin_update_install()? {
        UpdateInstallAdmission::Ready(lease) => lease,
        UpdateInstallAdmission::Busy { active_turns } => {
            return Ok(InstallUpdateResult {
                status: InstallUpdateStatus::Busy,
                active_turns,
            });
        }
    };
    let staged_app = if app_ready {
        Some(
            app_updates
                .take_staged_update()?
                .ok_or_else(|| "Atualização do app baixada não está mais disponível".to_string())?,
        )
    } else {
        None
    };
    let app_bytes = match staged_app.as_ref() {
        Some(staged) => match staged.read_verified() {
            Ok(bytes) => Some(bytes),
            Err(error) => {
                app_updates.mark_error(error.clone());
                emit_update_snapshot(&app, &coordinator);
                return Err(error);
            }
        },
        None => None,
    };
    #[cfg(target_os = "macos")]
    let macos_bundle = if app_ready {
        match tauri::process::current_binary(&app.env())
            .map_err(|e| format!("Falha ao localizar o app instalado: {e}"))
            .and_then(|executable| {
                crate::services::update_service::macos_bundle_path(&executable).ok_or_else(|| {
                    "O executável não está dentro de um bundle macOS válido".to_string()
                })
            }) {
            Ok(bundle) => Some(bundle),
            Err(error) => {
                app_updates.restore_staged_update(staged_app.expect("staged app"))?;
                return Err(error);
            }
        }
    } else {
        None
    };

    let mut app_payload = match (staged_app, app_bytes) {
        (Some(staged), Some(bytes)) => {
            if let Err(error) = std::fs::remove_file(&staged.artifact) {
                app_updates.restore_staged_update(staged)?;
                return Err(format!("Falha ao preparar instalação: {error}"));
            }
            Some((staged.update, bytes))
        }
        (None, None) => None,
        _ => return Err("Estado interno inconsistente da atualização do app".to_string()),
    };

    let cli_activation = if cli_ready {
        let service = cli_updates.as_ref().expect("CLI service must exist");
        match service.activate_prepared_for_restart() {
            Ok(activation) => Some(activation),
            Err(error) => {
                if let Some((update, bytes)) = app_payload.take() {
                    app_updates.restore_failed_install(update, bytes)?;
                }
                return Err(format!("Falha ao ativar atualização do CLI: {error}"));
            }
        }
    } else {
        None
    };

    let installed_app = app_payload.is_some();
    if let Some((update, bytes)) = app_payload.take() {
        if let Err(error) = update.install(&bytes) {
            let mut failures = vec![format!("Falha ao instalar atualização do app: {error}")];
            if let Err(restore_error) = app_updates.restore_failed_install(update, bytes) {
                failures.push(format!("falha ao restaurar download do app: {restore_error}"));
            }
            if let (Some(service), Some(activation)) =
                (cli_updates.as_ref(), cli_activation.as_ref())
            {
                if let Err(rollback_error) = service.rollback_prepared_activation(activation) {
                    failures.push(format!("falha ao restaurar o CLI anterior: {rollback_error}"));
                }
            }
            emit_update_snapshot(&app, &coordinator);
            return Err(failures.join("; "));
        }
    }

    if let (Some(service), Some(activation)) = (cli_updates.as_ref(), cli_activation.as_ref()) {
        if let Err(error) = service.commit_prepared_activation(activation) {
            if installed_app {
                eprintln!(
                    "[verboo:cli-update] app installed but CLI activation bookkeeping failed: {error}"
                );
            } else {
                let rollback = service.rollback_prepared_activation(activation);
                emit_update_snapshot(&app, &coordinator);
                return match rollback {
                    Ok(_) => Err(format!("Falha ao concluir atualização do CLI: {error}")),
                    Err(rollback_error) => Err(format!(
                        "Falha ao concluir atualização do CLI: {error}; falha no rollback: {rollback_error}"
                    )),
                };
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        _install_lease.keep_until_process_exit();
        if let Some(macos_bundle) = macos_bundle {
            let relaunch = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(crate::services::update_service::macos_relaunch_script())
                .arg("verboo-update-relaunch")
                .arg(std::process::id().to_string())
                .arg(macos_bundle)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
            if let Err(error) = relaunch {
                eprintln!("[verboo:update] relaunch helper failed, using native restart: {error}");
                app.restart();
            }
            app.exit(0);
            return Ok(InstallUpdateResult {
                status: InstallUpdateStatus::Restarting,
                active_turns: 0,
            });
        } else {
            app.restart();
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Tauri's native restart remains the correct relaunch path on Windows/Linux.
        _install_lease.keep_until_process_exit();
        app.restart();
    }
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
// Provider login (F4) — ponte por pseudo-terminal.

/// Inicia o login interativo do provedor (ex.: codex/claude) num PTY.
/// Gate: exige sessão Verboo ativa — o próprio CLI exige; propagamos o erro
/// claro quando não há.
#[tauri::command]
fn provider_login_start(
    provider: String,
    provider_login_service: tauri::State<'_, services::provider_login_pty::ProviderLoginService>,
) -> Result<String, String> {
    let has_session = match services::provider_catalog::read_provider_auth_state() {
        Ok(state) if state.logged_in => true,
        Ok(_) => {
            return Err(
                "Não há sessão Verboo ativa. Entre no Verboo pelo app ou pelo CLI antes de conectar um provedor."
                    .to_string(),
            );
        }
        Err(e) => {
            return Err(format!(
                "Não foi possível verificar a sessão Verboo: {e}"
            ));
        }
    };
    provider_login_service.start(&provider, has_session, Default::default())
}

/// Cancela o login de provedor em andamento (mata o PTY inteiro).
#[tauri::command]
fn provider_login_cancel(
    provider_login_service: tauri::State<'_, services::provider_login_pty::ProviderLoginService>,
) -> Result<(), String> {
    provider_login_service.cancel()
}

/// Confirma o aceite de risco da tela (o usuário leu e decidiu): a ponte
/// navega para a opção 1 (o padrão do menu é a 2) e Enter — o CLI segue ao
/// navegador. A ponte NUNCA aceita risco sozinha.
#[tauri::command]
fn provider_login_confirm_risk(
    provider: String,
    provider_login_service: tauri::State<'_, services::provider_login_pty::ProviderLoginService>,
) -> Result<(), String> {
    provider_login_service.confirm_risk(&provider)
}

/// Estado de autenticação por provedor — uma entrada por provedor que a
/// ponte suporta, shape `{ provider, connected, account? }`. O universo e a
/// leitura moram na ponte (módulo descartável); quando o CLI entregar o
/// auth status por provedor, a troca é só no backend — o renderer não muda
/// (ver CONTRATO DE REMOÇÃO em provider_login_pty.rs).
#[tauri::command]
fn provider_auth_status(
) -> Result<Vec<services::provider_login_pty::ProviderAuthStatus>, String> {
    services::provider_login_pty::provider_auth_status()
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
// Plugins (P5 / Wave 2 — spec docs/plugins-marketplace.md)
// ════════════════════════════════════════════════════════════════════
//
// Thin shell-out wrappers around `verboo plugin …` and
// `verboo plugin marketplace …`. Rust owns: command translation, timeout,
// auth gate on mutations, ANSI/JSON normalization, and 9-variant error
// mapping. The CLI is the only authority for filesystem state under
// `~/.claude/plugins/` and `~/.verboo/plugins/`.
//
// Wrappers translate from the free-function shape in
// `services::plugins_service` to `#[tauri::command]` async fns that Tauri
// resolves via `invoke_handler`. The bridge converts PluginError → a
// renderer-friendly error string automatically (via serde).

#[tauri::command]
async fn plugin_list() -> Result<Vec<models::plugins::Plugin>, models::plugins::PluginError> {
    services::plugins_service::plugin_list().await
}

#[tauri::command]
async fn plugin_available(
) -> Result<models::plugins::PluginAvailablePayload, models::plugins::PluginError> {
    services::plugins_service::plugin_available().await
}

#[tauri::command]
async fn plugin_install(
    id: String,
    scope: models::plugins::PluginScope,
    app: tauri::AppHandle,
) -> Result<models::plugins::MutationResult, models::plugins::PluginError> {
    let result = services::plugins_service::plugin_install(id, scope).await?;
    if result.success {
        let _ = tauri::Emitter::emit(&app, "plugin-mutation", &result);
    }
    Ok(result)
}

#[tauri::command]
async fn plugin_enable(
    id: String,
    scope: Option<models::plugins::PluginScope>,
    app: tauri::AppHandle,
) -> Result<models::plugins::MutationResult, models::plugins::PluginError> {
    let result = services::plugins_service::plugin_enable(id, scope).await?;
    if result.success {
        let _ = tauri::Emitter::emit(&app, "plugin-mutation", &result);
    }
    Ok(result)
}

#[tauri::command]
async fn plugin_disable(
    id: String,
    scope: Option<models::plugins::PluginScope>,
    app: tauri::AppHandle,
) -> Result<models::plugins::MutationResult, models::plugins::PluginError> {
    let result = services::plugins_service::plugin_disable(id, scope).await?;
    if result.success {
        let _ = tauri::Emitter::emit(&app, "plugin-mutation", &result);
    }
    Ok(result)
}

#[tauri::command]
async fn plugin_uninstall(
    id: String,
    scope: models::plugins::PluginScope,
    keep_data: Option<bool>,
    app: tauri::AppHandle,
) -> Result<models::plugins::MutationResult, models::plugins::PluginError> {
    let result = services::plugins_service::plugin_uninstall(id, scope, keep_data).await?;
    if result.success {
        let _ = tauri::Emitter::emit(&app, "plugin-mutation", &result);
    }
    Ok(result)
}

#[tauri::command]
async fn plugin_update(
    id: String,
    scope: models::plugins::PluginScope,
    app: tauri::AppHandle,
) -> Result<models::plugins::MutationResult, models::plugins::PluginError> {
    let result = services::plugins_service::plugin_update(id, scope).await?;
    if result.success {
        let _ = tauri::Emitter::emit(&app, "plugin-mutation", &result);
    }
    Ok(result)
}

#[tauri::command]
async fn plugin_validate(
    path: String,
) -> Result<models::plugins::PluginValidateResult, models::plugins::PluginError> {
    services::plugins_service::plugin_validate(path).await
}

#[tauri::command]
async fn marketplace_list(
) -> Result<Vec<models::plugins::Marketplace>, models::plugins::PluginError> {
    services::plugins_service::marketplace_list().await
}

#[tauri::command]
async fn marketplace_add(
    source: String,
    scope: Option<String>,
    app: tauri::AppHandle,
) -> Result<models::plugins::MutationResult, models::plugins::PluginError> {
    let result = services::plugins_service::marketplace_add(source, scope).await?;
    if result.success {
        let _ = tauri::Emitter::emit(&app, "plugin-mutation", &result);
    }
    Ok(result)
}

#[tauri::command]
async fn marketplace_remove(
    name: String,
    app: tauri::AppHandle,
) -> Result<models::plugins::MutationResult, models::plugins::PluginError> {
    let result = services::plugins_service::marketplace_remove(name).await?;
    if result.success {
        let _ = tauri::Emitter::emit(&app, "plugin-mutation", &result);
    }
    Ok(result)
}

/// 12. `plugin_detail(id)` — rich detail for an installed plugin.
/// Reads `.claude-plugin/plugin.json` (author, homepage, version, license,
/// keywords) and walks `skills/*/SKILL.md` (name + description per skill).
/// The CLI's `plugin list --json` omits these fields; this command fills
/// the gap for Codex parity.
#[tauri::command]
async fn plugin_detail(
    id: String,
) -> Result<services::plugin_detail_service::PluginDetail, models::plugins::PluginError> {
    // Fetch the installed plugin row from the CLI, then enrich it.
    let plugins = services::plugins_service::plugin_list().await?;
    let plugin = plugins
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| models::plugins::PluginError::NotInstalled { plugin: id.clone() })?;
    services::plugin_detail_service::build_plugin_detail(plugin)
}

/// 13. `plugin_skills(id)` — list of skills for an installed plugin.
/// Walks `skills/*/SKILL.md` and parses frontmatter (name + description).
/// Plugin without skills = empty list.
#[tauri::command]
async fn plugin_skills(
    id: String,
) -> Result<Vec<services::plugin_detail_service::PluginSkill>, models::plugins::PluginError> {
    let plugins = services::plugins_service::plugin_list().await?;
    let plugin = plugins
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| models::plugins::PluginError::NotInstalled { plugin: id.clone() })?;
    let detail = services::plugin_detail_service::build_plugin_detail(plugin)?;
    Ok(detail.skills)
}

/// 14. `marketplace_manifests()` — rich per-plugin metadata from all
/// marketplaces' `.claude-plugin/marketplace.json` files. Returns a map
/// keyed by `pluginId` (`name@marketplaceName`) with category, author,
/// homepage, description, version, keywords, tags. The FE merges this
/// with the CLI's `--available` JSON to reach Codex parity.
#[tauri::command]
async fn marketplace_manifests() -> Result<
    std::collections::HashMap<
        String,
        services::marketplace_manifest_service::MarketplacePluginEntry,
    >,
    models::plugins::PluginError,
> {
    let marketplaces = services::plugins_service::marketplace_list().await?;
    Ok(services::marketplace_manifest_service::read_all_manifests(
        &marketplaces,
    ))
}

/// 15. `plugin_icon(pluginId)` — fetches the plugin's icon from its homepage
/// domain (apple-touch-icon.png → favicon.ico). HTTPS only, on-demand only
/// (never preemptive). Cached at `<app_data_dir>/cache/plugin-icons/` with
/// 7-day TTL, 50 MB LRU cap, dedupe by domain. Returns a local file path
/// (FE uses `convertFileSrc`) or `None` (FE renders monogram).
///
/// Respects the `loadWebIcons` user setting — if false, returns `None`
/// without any network request (privacy toggle).
#[tauri::command]
async fn plugin_icon(
    app: tauri::AppHandle,
    settings_store: tauri::State<'_, services::settings_store::SettingsStore>,
    plugin_id: String,
) -> Result<services::plugin_icon_service::PluginIconResult, models::plugins::PluginError> {
    // Read the loadWebIcons toggle. If false, return None without network.
    let load_web_icons = settings_store
        .get()
        .map(|s| s.load_web_icons)
        .unwrap_or(true);

    // Resolve cache dir: <app_data_dir>/cache/plugin-icons/
    let app_data_dir =
        app.path()
            .app_data_dir()
            .map_err(|e| models::plugins::PluginError::Unknown {
                message: format!("failed to resolve app_data_dir: {e}"),
                exit_code: None,
            })?;
    let cache_dir = app_data_dir.join("cache").join("plugin-icons");

    // Fetch marketplace manifests via the in-memory cache (TTL 60s +
    // single-flight). This avoids spawning the CLI on every request —
    // 83 concurrent requests share 1 fetch.
    let manifests = services::manifest_cache::get_or_fetch_manifests().await?;

    services::plugin_icon_service::resolve_plugin_icon(
        &plugin_id,
        &manifests,
        cache_dir,
        load_web_icons,
    )
    .await
}

// ════════════════════════════════════════════════════════════════════
// Video understanding components
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
async fn get_video_component_state(
    store: tauri::State<'_, services::video::transcribe::VideoTranscriberStore>,
) -> Result<services::video::transcribe::VideoComponentState, String> {
    store.inner().clone().state().await
}

#[tauri::command]
async fn download_video_transcriber(
    app: tauri::AppHandle,
    store: tauri::State<'_, services::video::transcribe::VideoTranscriberStore>,
) -> Result<(), String> {
    use services::video::transcribe::{VideoTranscriberProgress, WHISPER_BASE_BYTES};

    let app_for_progress = app.clone();
    let store = store.inner().clone();
    let _ = app.emit(
        "video-transcriber-progress",
        VideoTranscriberProgress {
            state: "downloading",
            bytes_downloaded: 0,
            total_bytes: WHISPER_BASE_BYTES,
            error: None,
        },
    );
    match store
        .download(move |progress| {
            let _ = app_for_progress.emit("video-transcriber-progress", progress);
        })
        .await
    {
        Ok(()) => {
            let _ = app.emit(
                "video-transcriber-progress",
                VideoTranscriberProgress {
                    state: "ready",
                    bytes_downloaded: WHISPER_BASE_BYTES,
                    total_bytes: WHISPER_BASE_BYTES,
                    error: None,
                },
            );
            Ok(())
        }
        Err(error) => {
            let _ = app.emit(
                "video-transcriber-progress",
                VideoTranscriberProgress {
                    state: "error",
                    bytes_downloaded: 0,
                    total_bytes: WHISPER_BASE_BYTES,
                    error: Some(error.clone()),
                },
            );
            Err(error)
        }
    }
}

#[tauri::command]
async fn remove_video_transcriber(
    store: tauri::State<'_, services::video::transcribe::VideoTranscriberStore>,
) -> Result<(), String> {
    store.inner().clone().remove().await
}

/// Streams one prepared video frame to the renderer for OCR. The webview's
/// asset protocol does not reach Web Worker fetches, so the frame travels as
/// raw bytes over IPC instead. Only files inside the app-private
/// `video_jobs` tree are readable — never arbitrary paths.
#[tauri::command]
fn read_video_frame(app: tauri::AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    use tauri::Manager;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("resolve app data dir: {error}"))?;
    let allowed_root = app_data_dir
        .join("video_jobs")
        .canonicalize()
        .map_err(|error| format!("resolve video jobs dir: {error}"))?;
    let requested = std::path::Path::new(&path)
        .canonicalize()
        .map_err(|error| format!("resolve frame path: {error}"))?;
    if !requested.starts_with(&allowed_root) {
        return Err("frame path outside the video jobs directory".to_string());
    }
    let bytes = std::fs::read(&requested).map_err(|error| format!("read frame: {error}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Renderer returns one OCR batch for a pending video job. Ownership is
/// enforced by the waiter registry: only the job that registered a pending
/// batch can be completed, exactly once.
#[tauri::command]
fn complete_video_ocr_batch(
    waiters: tauri::State<'_, services::video::job::VideoOcrWaiters>,
    job_id: String,
    results: Vec<services::video::job::VideoOcrText>,
) -> Result<(), String> {
    waiters.complete(&job_id, results)
}

// ════════════════════════════════════════════════════════════════════
// App entry point
// ════════════════════════════════════════════════════════════════════

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
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
        .manage(services::browser_panel::BrowserPanelState::default())
        .setup(|app| {
            // Initialize persistent settings store at {app_data_dir}/settings.json
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("app data dir must be available");
            let _ = std::fs::create_dir_all(&app_data_dir);

            // CLI and Node have independent owners: Node is an app sidecar;
            // CLI versions live only under app-data/cli. Configure the single
            // runtime authority before any service can spawn a CLI process.
            let cli_update_service = if let Some(node_path) = services::node_runtime::resolve_node_path() {
                let cli_store = services::cli_update::CliStore::open(&app_data_dir)
                    .map_err(std::io::Error::other)?;
                services::cli_update::runtime::configure(cli_store, node_path.clone())
                    .map_err(std::io::Error::other)?;

                match services::cli_update::CliUpdateService::production(
                    &app_data_dir,
                    node_path,
                ) {
                    Ok(cli_update_service) => {
                        let startup_service = cli_update_service.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            let result = match startup_service.validate_startup() {
                                Ok(services::cli_update::service::StartupValidation::Missing) => {
                                    // The renderer starts first installation through
                                    // `bootstrap_cli`, which emits progress and owns the
                                    // retry UX. Startup validation remains responsible
                                    // for existing installs and rollback only.
                                    Ok(())
                                }
                                Ok(services::cli_update::service::StartupValidation::Valid {
                                    ..
                                }) => Ok(()),
                                Ok(services::cli_update::service::StartupValidation::RolledBack {
                                    rejected,
                                    restored,
                                }) => {
                                    eprintln!(
                                        "[verboo:cli-update] rolled back {rejected} to {restored}; restart required"
                                    );
                                    Ok(())
                                }
                                Err(error) => Err(error),
                            };
                            if let Err(error) = result {
                                eprintln!("[verboo:cli-update] startup preparation failed: {error}");
                            }
                        });
                        Some(cli_update_service)
                    }
                    Err(error) => {
                        eprintln!("[verboo:cli-update] updater unavailable: {error}");
                        None
                    }
                }
            } else {
                eprintln!(
                    "[verboo:cli-update] embedded Node sidecar is unavailable; CLI bootstrap deferred"
                );
                None
            };
            app.manage(
                services::browser_panel::BrowserCaptureStore::new(app_data_dir.clone())
                    .map_err(std::io::Error::other)?,
            );
            app.manage(
                services::ios_simulator::IosSimulatorCaptureStore::new(app_data_dir.clone())
                    .map_err(std::io::Error::other)?,
            );
            let simulator_service =
                services::ios_simulator::IosSimulatorService::new(app_data_dir.clone())
                    .map_err(std::io::Error::other)?;
            simulator_service
                .reconcile_owned_devices()
                .map_err(std::io::Error::other)?;
            app.manage(simulator_service.clone());
            let simulator_cache_dir = app.path().app_cache_dir().map_err(std::io::Error::other)?;
            let simulator_bridge = services::ios_simulator::IosSimulatorBridge::start(
                simulator_cache_dir,
                app.package_info().version.to_string(),
                app.handle().clone(),
                simulator_service,
            )
            .map_err(std::io::Error::other)?;
            app.manage(simulator_bridge);
            let simulator_mcp_app_data = app_data_dir.clone();
            let simulator_mcp_version = app.package_info().version.to_string();
            tauri::async_runtime::spawn_blocking(move || {
                let result = services::ios_simulator_mcp::IosSimulatorMcpService::new(
                    simulator_mcp_app_data,
                    simulator_mcp_version,
                )
                .and_then(|service| service.ensure_registered());
                if let Err(error) = result {
                    eprintln!("[verboo:ios-simulator-mcp] setup skipped: {error}");
                }
            });
            let settings_store = SettingsStore::new(app_data_dir.clone());
            app.manage(
                services::pasted_file_upload::PastedFileUploadService::new(app_data_dir.clone())
                    .map_err(std::io::Error::other)?,
            );

            // Request macOS notification permission. On macOS, notifications
            // are blocked by default until the app requests permission. This
            // is a no-op on Windows/Linux (permission is granted at install).
            // Must happen before any notification is shown, otherwise the OS
            // silently drops them.
            if std::env::var_os("VERBOO_BROWSER_SMOKE_REPORT").is_none() {
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
            // Verboo in Chrome — configuration and diagnostics only. The
            // helper and Chrome extension communicate without the app open.
            app.manage(std::sync::Arc::new(
                ChromeIntegrationService::new(env!("CARGO_PKG_VERSION"))
                    .map_err(std::io::Error::other)?,
            ));
            // ModelService — fetches models from Verboo Router API with disk cache
            app.manage(ModelService::new(app_data_dir.clone()));
            app.manage(services::video::transcribe::VideoTranscriberStore::new(
                app_data_dir.clone(),
            ));
            app.manage(services::video::job::VideoOcrWaiters::default());
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
            // ProviderLoginService — F4: ponte de login de provedor por PTY.
            // Canal CONFIRMADO com o Mosaico: "provider-login:event", payload
            // { provider, state, message? } (state: awaiting_browser |
            // connected | error).
            {
                let app_for_login = app.handle().clone();
                // cwd NEUTRO e fora de file provider para o CLI interativo:
                // o CLI ao subir VARRE o cwd procurando projeto — herdado do
                // app (Documents/iCloud) a leitura coordenada PENDURA e o
                // prompt nunca aparece (defeito de campo). O workdir é um
                // diretório próprio vazio sob o app-data, criado na hora.
                let login_workdir = app
                    .path()
                    .app_data_dir()
                    .map(|dir| dir.join("provider-login-workdir"))
                    .unwrap_or_else(|_| std::env::temp_dir().join("verboo-provider-login"));
                let _ = std::fs::create_dir_all(&login_workdir);
                app.manage(services::provider_login_pty::ProviderLoginService::new(
                    move |event| {
                        let _ = app_for_login.emit("provider-login:event", event);
                    },
                    login_workdir,
                ));
            }
            // TrayService — owns the menubar state machine (icon/title animation)
            app.manage(crate::services::tray_service::TrayService::new());
            // The app and CLI updaters keep independent storage owners. The
            // coordinator only combines their snapshots and serializes user
            // operations into one card/restart flow.
            let app_update_service = crate::services::update_service::UpdateService::new(
                app.package_info().version.to_string(),
                cfg!(debug_assertions) == false,
            );
            app.manage(app_update_service.clone());
            app.manage(crate::services::update_coordinator::UpdateCoordinator::new(
                app_update_service,
                cli_update_service,
            ));
            // LifecycleService — owns the first-launch requirements flag
            app.manage(crate::services::lifecycle_service::LifecycleService::new(
                app_data_dir.clone(),
            ));
            // StaleFileDetector — tracks file snapshots per conversation
            app.manage(crate::services::stale_file_detector::StaleFileDetector::new());

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

            // ── Close always requests an app exit ───────────────────
            if let Some(window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = app_handle.exit(0);
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
            // Browser panel
            services::browser_panel::browser_set_bounds,
            services::browser_panel::browser_drain_messages,
            services::browser_panel::browser_snapshot,
            services::browser_panel::browser_capture_annotation,
            services::browser_panel::browser_delete_temp_files,
            services::browser_panel::browser_promote_temp_files,
            services::browser_panel::browser_delete_capture_owner,
            services::browser_panel::browser_cleanup_capture_owners,
            services::browser_panel::browser_evaluate_script,
            services::browser_panel::browser_healthcheck,
            // Browser panel (Task 4 — multi-tab atomic runtime commands)
            services::browser_panel::browser_session_open,
            services::browser_panel::browser_session_snapshot,
            services::browser_panel::browser_session_set_visible,
            services::browser_panel::browser_session_destroy,
            services::browser_panel::browser_tab_create,
            services::browser_panel::browser_tab_activate,
            services::browser_panel::browser_tab_close,
            services::browser_panel::browser_tab_navigate,
            services::browser_panel::browser_tab_back,
            services::browser_panel::browser_tab_forward,
            services::browser_panel::browser_tab_reload,
            services::browser_panel::browser_tab_set_media_suspended,
            services::browser_panel::browser_tab_evict,
            services::browser_panel::browser_tab_reactivate,
            // iOS Simulator visual panel
            services::ios_simulator::ios_simulator_requirements,
            services::ios_simulator::ios_simulator_attach,
            services::ios_simulator::ios_simulator_detach,
            services::ios_simulator::ios_simulator_set_visible,
            services::ios_simulator::ios_simulator_end,
            services::ios_simulator::ios_simulator_retry_interaction,
            services::ios_simulator::ios_simulator_system_action,
            services::ios_simulator::ios_simulator_capture_screen,
            services::ios_simulator::ios_simulator_recording_start,
            services::ios_simulator::ios_simulator_recording_stop,
            services::ios_simulator::ios_simulator_reveal_output,
            services::ios_simulator::ios_simulator_set_stream_rate,
            services::ios_simulator::ios_simulator_set_fallback_rate,
            services::ios_simulator::ios_simulator_tap,
            services::ios_simulator::ios_simulator_drag,
            services::ios_simulator::ios_simulator_type_text,
            services::ios_simulator::ios_simulator_press_key,
            services::ios_simulator::ios_simulator_accessibility_snapshot,
            services::ios_simulator::ios_simulator_capture_annotation,
            services::ios_simulator::ios_simulator_delete_temp_files,
            services::ios_simulator::ios_simulator_promote_temp_files,
            services::ios_simulator::ios_simulator_delete_capture_owner,
            services::ios_simulator::ios_simulator_cleanup_capture_owners,
            // Auth
            start_cli_login,
            get_cli_auth_status,
            logout,
            open_dashboard,
            open_subscriptions,
            open_signup,
            // Verboo in Chrome
            chrome_integration_status,
            chrome_integration_configure,
            chrome_integration_repair,
            chrome_integration_test,
            chrome_integration_remove,
            open_chrome_extension_store,
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
            // Video understanding components
            get_video_component_state,
            download_video_transcriber,
            remove_video_transcriber,
            complete_video_ocr_batch,
            read_video_frame,
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
            begin_pasted_file_upload,
            append_pasted_file_chunk,
            finish_pasted_file_upload,
            abort_pasted_file_upload,
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
            bootstrap_cli,
            check_for_updates,
            download_update,
            install_update,
            // Terminal
            terminal_start,
            terminal_write,
            terminal_resize,
            terminal_stop,
            terminal_get_state,
            provider_login_start,
            provider_login_cancel,
            provider_login_confirm_risk,
            provider_auth_status,
            // Clipboard
            clipboard_read_text,
            clipboard_write_text,
            // Plugins (P5 / Wave 2)
            plugin_list,
            plugin_available,
            plugin_install,
            plugin_enable,
            plugin_disable,
            plugin_uninstall,
            plugin_update,
            plugin_validate,
            marketplace_list,
            marketplace_add,
            marketplace_remove,
            // Plugins — rich detail (Wave 2 P5+)
            plugin_detail,
            plugin_skills,
            marketplace_manifests,
            plugin_icon,
        ])
        .build(tauri::generate_context!())
        .expect("error while building verboo-desktop");

    let mut runtime_smoke_report =
        std::env::var_os("VERBOO_BROWSER_SMOKE_REPORT").map(std::path::PathBuf::from);

    app.run(move |app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            stop_ios_simulator_for_app_exit(app_handle);
        }
        tauri::RunEvent::MainEventsCleared => {
            if let Some(report_path) = runtime_smoke_report.take() {
                services::browser_panel::start_runtime_smoke(app_handle.clone(), report_path);
            }
        }
        _ => {}
    });
}
