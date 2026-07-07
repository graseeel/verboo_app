mod models;
mod services;

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
    user_message: Option<String>,
}

impl From<crate::services::goal_evaluator::EvaluationResult> for EvaluationResult {
    fn from(value: crate::services::goal_evaluator::EvaluationResult) -> Self {
        Self {
            evaluation: value.evaluation,
            user_message: value.user_message,
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
fn open_dashboard(_app: tauri::AppHandle) -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
fn open_subscriptions() -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
fn open_signup() -> Result<bool, String> {
    Ok(false)
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
    Ok(crate::services::feedback_service::FeedbackService::send_feedback(
        request,
        &app_version,
        platform,
        |url| match app_for_url.opener().open_url(url, None::<&str>) {
            Ok(_) => Ok(()),
            Err(e) => Err(format!("Falha ao abrir URL: {e}")),
        },
    ))
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
) -> Result<UserSettings, String> {
    store.update(patch)
}

#[tauri::command]
fn reset_user_settings(
    store: tauri::State<'_, SettingsStore>,
) -> Result<UserSettings, String> {
    store.reset()
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

// ════════════════════════════════════════════════════════════════════
// Window
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
fn toggle_window_zoom(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window
            .set_fullscreen(!window.is_fullscreen().unwrap_or(false));
    }
    Ok(true)
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

// ════════════════════════════════════════════════════════════════════
// Workspace
// ════════════════════════════════════════════════════════════════════

#[tauri::command]
fn get_workspace_changes(working_directory: String) -> Result<WorkspaceChangeSummary, String> {
    Ok(services::git_service::read_workspace_change_summary(&working_directory))
}

#[tauri::command]
fn get_workspace_branches(working_directory: String) -> Result<WorkspaceBranchInfo, String> {
    Ok(services::git_service::read_workspace_branch_info(&working_directory))
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
fn revert_file(
    working_directory: String,
    file_path: String,
) -> Result<FileDiffResponse, String> {
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
    _credentials: tauri::State<'_, CredentialsStore>,
) -> Result<EvaluationResult, String> {
    // CLI token first (with refresh), API key fallback — same resolver as
    // turns/profile/models.
    let credentials_fresh = CredentialsStore::new();
    let token = crate::services::auth_token::resolve_token(&credentials_fresh);
    Ok(
        crate::services::goal_evaluator::GoalEvaluator::evaluate(input, token.as_deref())
            .into(),
    )
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
        .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp", "heic", "heif"])
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

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let folder = app
        .dialog()
        .file()
        .set_title("Selecionar pasta")
        .blocking_pick_folder();
    Ok(folder.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().to_string()))
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
fn run_research_subagents(
    request: ResearchSubagentsRunRequest,
) -> Result<Vec<ResearchSubagentResult>, String> {
    // Build the per-subagent requests; the actual CLI dispatch is wired in a
    // later phase when the runtime port lands. For now we return one empty
    // result per requested subagent so the renderer can render the queue.
    let requests = crate::services::research_subagent_service::ResearchSubagentService::build_requests(&request);
    Ok(requests
        .iter()
        .map(|r| crate::services::research_subagent_service::ResearchSubagentService::failed_result(
            r,
            "Runtime integration pending — subagent execution lands in a later phase.",
            &std::collections::HashSet::new(),
        ))
        .collect())
}

#[tauri::command]
fn cancel_research_subagents(_run_id: String) -> Result<bool, String> {
    // No active runs to cancel until runtime lands.
    Ok(false)
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
            let snap = service.mark_available(
                update.version.clone(),
                None,
                None,
                update.body.clone(),
            );
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
                        total as u64,
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
            app.manage(TurnService::new(std::sync::Arc::new(CredentialsStore::new())));
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

            // ── System tray (macOS menubar / Win+Linux notification area) ──────
            // The tray icon shows the Verboo logo on Win/Linux and the animated
            // title on macOS (which puts a text title next to the icon). Matches
            // Electron's trayStatusService.
            let tray_icon_bytes = std::fs::read("icons/32x32.png").ok();
            let tray = if let Some(bytes) = tray_icon_bytes {
                let image = tauri::image::Image::from_bytes(&bytes)
                    .expect("32x32.png must be valid PNG");
                tauri::tray::TrayIconBuilder::with_id("verboo-main")
                    .icon(image)
                    .icon_as_template(true)
                    .tooltip("Verboo Code")
                    .build(app)
                    .ok()
            } else {
                None
            };
            // Drive the tray tick loop (~250ms) so spinner animation + 3.5s
            // auto-reset happen automatically. Runs on a background thread so
            // it doesn't compete with the UI.
            if let Some(tray_icon) = tray.clone() {
                let tray_service = app
                    .state::<crate::services::tray_service::TrayService>()
                    .inner()
                    .handle();
                std::thread::spawn(move || {
                    let mut last_tick = std::time::Instant::now();
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        let now = std::time::Instant::now();
                        // Auto-reset on Done/Error after 3.5s.
                        if tray_service.should_reset() {
                            tray_service.reset_to_idle();
                        }
                        // Tick the spinner frame.
                        if tray_service.tick() || last_tick.elapsed() >= std::time::Duration::from_millis(1000) {
                            last_tick = now;
                            let title = tray_service.title();
                            // macOS-only: shows text next to the icon. No-op elsewhere.
                            #[cfg(target_os = "macos")]
                            {
                                let _ = tray_icon.set_title(Some(title.as_str()));
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
                            let _ = app_handle.exit(0);
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
            // Menu bar
            update_menu_bar,
            // Window
            toggle_window_zoom,
            // Skills
            list_skills,
            open_user_skills_folder,
            // Workspace
            get_workspace_changes,
            get_workspace_branches,
            switch_workspace_branch,
            get_workspace_review_metadata,
            get_file_diff,
            revert_file,
            open_external_file,
            // Goal
            evaluate_goal,
            // Files
            pick_files,
            inspect_files,
            pick_folder,
            create_project_folder,
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
        .run(tauri::generate_context!())
        .expect("error while running verboo-desktop");
}
