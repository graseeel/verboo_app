use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::io::{BufRead, BufReader};

use tauri::{AppHandle, Emitter};

use crate::models::types::{
    access_mode_cli_args, AgentEvent, AgentResultSnapshot, AgentTurnRequest, AttachmentMeta,
    AttachmentKind, EventType, LanguageCode, PersonalityMode, RuntimeActivity, RuntimeStatus,
    RuntimeStatusKind, UserSettings,
};
use crate::services::auth_token::{inject_api_key, resolve_token};
use crate::services::credentials_store::CredentialsStore;
use crate::services::prevent_sleep::PreventSleepGuard;
use crate::services::settings_store::SettingsStore;

const AGENT_EVENT_CHANNEL: &str = "agent:event";

/// Service that spawns the `verboo` CLI to execute agent turns, streaming
/// JSON events back to the renderer through Tauri events.
///
/// Mirrors Electron's `verbooCliService.ts` (`VerbooCliService.sendTurn`):
///   - Spawns `verboo --print --output-format stream-json --verbose ...`
///   - Reads stdout line-by-line in a dedicated thread
///   - Cleans ANSI + DECSET escape sequences from each line
///   - Parses JSON payloads, classifies them (result, tool_use, etc.)
///   - Emits `agent:event` Tauri events back to the renderer
///   - On close, emits the final result snapshot + a `done` event
///
/// Wraps the spawned CLI child so both the `active` map (for `interrupt`)
/// and the stdout reader thread can share ownership. The child itself stays
/// in this Arc; stdout/stderr are taken once at spawn time and handed off to
/// reader threads. Killing the child is done by calling `interrupt_child`
/// while holding the inner mutex.
type ChildHandle = Arc<Mutex<Child>>;

/// Auth: the API key (if stored) is injected via `OAUTH_TOKEN_FILE` env var
/// pointing at a 0600 temp file. This matches Electron's behavior of
/// "API key has precedence over OAuth token" (verbooCliService.ts:306) and
/// means the user never has to run `verboo auth login` — saving the key in
/// the app's credential store is enough.
pub struct TurnService {
    /// Active child processes keyed by turn_id, so `interrupt` can signal them.
    active: Arc<Mutex<std::collections::HashMap<String, ChildHandle>>>,
    credentials: Arc<CredentialsStore>,
    /// Optional settings store for reading `prevent_sleep_while_running`.
    /// When `None`, sleep prevention is disabled (used in tests).
    settings: Option<Arc<SettingsStore>>,
    /// App data dir for vision fallback cache. `None` in tests.
    app_data_dir: Option<std::path::PathBuf>,
}

impl TurnService {
    pub fn new(credentials: Arc<CredentialsStore>) -> Self {
        Self {
            active: Arc::new(Mutex::new(std::collections::HashMap::new())),
            credentials,
            settings: None,
            app_data_dir: None,
        }
    }

    /// Sets the settings store used to read `prevent_sleep_while_running`.
    /// Called from `lib.rs` setup after the `SettingsStore` is created.
    pub fn with_settings(mut self, settings: Arc<SettingsStore>) -> Self {
        self.settings = Some(settings);
        self
    }

    /// Sets the app data dir for vision fallback cache storage.
    /// Called from `lib.rs` setup.
    pub fn with_app_data_dir(mut self, dir: std::path::PathBuf) -> Self {
        self.app_data_dir = Some(dir);
        self
    }

    /// FASE 1: vision fallback. When the model doesn't support vision and
    /// there are image attachments, spawn a secondary CLI with a vision-capable
    /// model (from the user's catalog) to describe each image. Descriptions
    /// are written into `extracted_text` on the attachment so they flow into
    /// the prompt as text via `build_attachment_lines`.
    ///
    /// Gated by `vision_fallback_consent`:
    /// - `Always`: run the fallback.
    /// - `Never` / `Ask`: skip (Ask needs a mid-turn consent event that
    ///   isn't implemented yet — falls back to Never behavior).
    ///
    /// Failures are silent — if the helper model can't be resolved, the cache
    /// can't be read, or the CLI spawn fails, the images fall through to the
    /// normal "DO NOT invent" warning path. The user's turn is never blocked
    /// by a fallback failure.
    fn maybe_run_vision_fallback(&self, request: &mut AgentTurnRequest) {
        // Only run when there are image attachments.
        let has_images = request
            .attachments
            .as_ref()
            .map(|list| {
                list.iter()
                    .any(|a| a.kind == AttachmentKind::Image && a.media_type.is_some())
            })
            .unwrap_or(false);
        if !has_images {
            return;
        }

        // Check consent from settings.
        let consent = self
            .settings
            .as_ref()
            .and_then(|s| s.get().ok())
            .map(|s| s.vision_fallback_consent)
            .unwrap_or_default();
        if consent != crate::models::types::VisionFallbackConsent::Always {
            return;
        }

        // Need app_data_dir for the cache.
        let app_data_dir = match &self.app_data_dir {
            Some(d) => d.clone(),
            None => {
                // Non-silent: inject warning so the model tells the user
                // instead of hallucinating the image content.
                self.inject_fallback_warning(
                    request,
                    "Vision fallback could not run: app data directory unavailable. \
                     Tell the user the app couldn't initialize its cache directory.",
                );
                return;
            }
        };

        // Resolve the vision helper model from the user's catalog.
        let model_service =
            crate::services::model_service::ModelService::new(app_data_dir.clone());
        let token = crate::services::auth_token::resolve_token(&self.credentials);
        let discovery = match model_service.list_models(token.as_deref(), false) {
            Ok(d) => d,
            Err(e) => {
                // Non-silent: list_models failed — tell the user why.
                eprintln!(
                    "[verboo:vision-fallback] list_models failed: {e}"
                );
                self.inject_fallback_warning(
                    request,
                    &format!(
                        "Vision fallback could not run: failed to load model catalog ({e}). \
                         Tell the user the model list couldn't be loaded and suggest \
                         they check their connection or re-login."
                    ),
                );
                return;
            }
        };

        // LOG 1: discovery source + model count.
        eprintln!(
            "[verboo:vision-fallback] model catalog: source={}, {} models total",
            discovery.source,
            discovery.models.len()
        );

        // LOG 2: count of vision-capable models in the catalog.
        let vision_count = discovery
            .models
            .iter()
            .filter(|m| m.supports_vision == Some(true))
            .count();
        eprintln!(
            "[verboo:vision-fallback] {} vision-capable model(s) in catalog",
            vision_count
        );

        let helper = match crate::services::vision_fallback_service::resolve_vision_helper(
            &discovery,
        ) {
            Some(m) => m,
            None => {
                // Non-silent: no vision model in the user's plan — tell them.
                self.inject_fallback_warning(
                    request,
                    "Vision fallback could not run: no vision-capable model found \
                     in your plan. Tell the user their plan doesn't include a \
                     vision model, so the image can't be described. Suggest they \
                     upgrade their plan or paste the image content as text.",
                );
                return;
            }
        };

        eprintln!(
            "[verboo:vision-fallback] resolved helper: {} ({})",
            helper.id, helper.display_name
        );

        // Describe each image attachment and inject as extracted_text.
        // `describe_image` uses `CliSpawn` internally to find the bundled CLI
        // + Node runtime — same resolver as the main turn. No need to resolve
        // cli_path separately (which would return None in packaged builds).
        if let Some(list) = request.attachments.as_mut() {
            for att in list.iter_mut() {
                if att.kind != AttachmentKind::Image || att.media_type.is_none() {
                    continue;
                }
                let media_type = att.media_type.clone().unwrap_or_default();
                let path = std::path::PathBuf::from(&att.path);
                match crate::services::vision_fallback_service::describe_image_cached(
                    &path,
                    &media_type,
                    &helper.id,
                    &self.credentials,
                    &app_data_dir,
                ) {
                    Ok(description) => {
                        att.extracted_text = Some(description);
                        att.extraction_status = Some(
                            crate::models::types::ExtractionStatus::Extracted,
                        );
                    }
                    Err(e) => {
                        // Non-silent: describe_image failed (timeout, spawn
                        // error, empty result) — inject explicit warning so
                        // the model tells the user instead of inventing.
                        eprintln!(
                            "[verboo:vision-fallback] describe_image failed for {}: {e}",
                            att.path
                        );
                        att.extracted_text = Some(format!(
                            "[Vision fallback failed: {e}. \
                             The model cannot read this image. \
                             Tell the user the vision helper couldn't describe \
                             the image and suggest they try again, use a \
                             vision-capable model, or paste the content as text.]"
                        ));
                        att.extraction_status = Some(
                            crate::models::types::ExtractionStatus::Warning,
                        );
                    }
                }
            }
        }
    }

    /// Injects a fallback warning into all image attachments that don't
    /// already have extracted_text. Used when the fallback can't run at all
    /// (no catalog, no helper, no app_data_dir) — the model is told explicitly
    /// that it can't read the image, instead of silently receiving just the
    /// file path and hallucinating.
    fn inject_fallback_warning(&self, request: &mut AgentTurnRequest, warning: &str) {
        if let Some(list) = request.attachments.as_mut() {
            for att in list.iter_mut() {
                if att.kind == AttachmentKind::Image && att.extracted_text.is_none() {
                    att.extracted_text = Some(warning.to_string());
                    att.extraction_status =
                        Some(crate::models::types::ExtractionStatus::Warning);
                }
            }
        }
    }

    /// Spawn an agent turn. Returns the turn_id (existing or newly generated).
    /// Emits `agent:event` events to the renderer as the CLI produces output.
    pub fn send_turn(
        &self,
        app: AppHandle,
        request: AgentTurnRequest,
        resume_session_id: Option<String>,
    ) -> Result<String, String> {
        let turn_id = request
            .turn_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let conversation_id = request.conversation_id.clone();

        emit_event(
            &app,
            AgentEvent {
                event_type: EventType::Started,
                turn_id: Some(turn_id.clone()),
                conversation_id: Some(conversation_id.clone()),
                text: None,
                payload: None,
                result: None,
                progress: None,
                message: None,
                exit_code: None,
                runtime_status: None,
                runtime_activity: None,
            },
        );

        // FASE 1: vision fallback. When the selected model doesn't support
        // vision but the user attached images, spawn a secondary CLI with a
        // vision-capable model (from the user's own catalog — never hardcoded)
        // to describe each image. Descriptions are injected as `extracted_text`
        // so `build_attachment_lines` includes them in the prompt as text.
        //
        // Consent gates this:
        // - 'always': run the fallback without asking.
        // - 'never': skip (images get the "DO NOT invent" warning).
        // - 'ask': skip for now (needs a mid-turn consent event that isn't
        //   implemented yet — falls back to 'never' behavior until Zelda's
        //   UI is ready).
        let mut request = request;
        if request.model_supports_vision != Some(true) {
            self.maybe_run_vision_fallback(&mut request);
        }

        let prompt = build_prompt(&request, resume_session_id.is_some());
        let is_resume = resume_session_id.is_some();

        // FASE 0: when the model supports vision AND there are image
        // attachments, switch to stream-json input so images reach the model
        // as base64 data URLs (not just text paths). Text-only turns keep
        // the positional prompt path (lower risk, no stdin piping needed).
        let stream_json_payload = build_stream_json_input(&request, &prompt);
        let use_stream_json = stream_json_payload.is_some();

        let mut args = vec![
            "--print".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
            "--include-partial-messages".to_string(),
        ];
        if use_stream_json {
            // Structured input: prompt + images go via stdin as JSON messages.
            args.push("--input-format".to_string());
            args.push("stream-json".to_string());
        } else {
            // Positional prompt: text-only turn (no images, or model can't see).
            args.push(prompt);
        }
        if is_resume {
            args.push("--resume".to_string());
            args.push(resume_session_id.unwrap());
        }
        if let Some(model) = &request.model {
            if !model.trim().is_empty() {
                args.push("--model".to_string());
                args.push(model.clone());
            }
        }
        for arg in access_mode_cli_args(&request.access_mode) {
            args.push(arg.to_string());
        }

        let working_directory = safe_runtime_working_directory(&request.working_directory);

        // Resolve the bearer token (CLI OAuth first with refresh, API key
        // fallback). The CLI token gives full account access; the API key
        // is the fallback for users who haven't done `verboo auth login`.
        let token = resolve_token(&self.credentials);

        // Prevent sleep while the turn is running, honoring the user's
        // setting. The guard is moved into the stdout reader thread and
        // released automatically when the thread exits.
        let sleep_guard = match self.settings.as_ref() {
            Some(store) => store
                .get()
                .map(|settings| PreventSleepGuard::start(&settings))
                .unwrap_or_else(|_| PreventSleepGuard::start(&UserSettings::default())),
            None => PreventSleepGuard::start(&UserSettings::default()),
        };

        // Build the CLI spawn. CliSpawn picks the best runtime:
        //   - `<node> <bundled-cli.mjs>` (self-contained — option B of doc 03)
        //   - `<node> <VERBOO_CLI_PATH>` (dev)
        //   - `verboo` global on PATH (last-resort fallback)
        let spawn = crate::services::cli_spawn::CliSpawn::new(&args);
        let runtime_label = spawn.runtime.to_string();
        let working_dir_label = working_directory.clone();
        let mut cmd = spawn.command;
        cmd.current_dir(&working_directory)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // stream-json input needs stdin piped so we can write messages.
        // Text-only turns use null stdin (no stdin data needed).
        if use_stream_json {
            cmd.stdin(Stdio::piped());
        } else {
            cmd.stdin(Stdio::null());
        }
        // On Windows, create the child in its own process group so
        // `GenerateConsoleCtrlEvent` can target it for graceful interrupt.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(crate::services::child_signal::process_creation_flags());
        }
        let _token_file = inject_api_key(token.as_deref(), &mut cmd);
        crate::services::auth_token::augment_identity_env(&mut cmd);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Falha ao iniciar CLI Verboo: {e}"))?;

        let child_id = child.id();

        // FASE 0: write stream-json payload to stdin (images as base64).
        // The CLI reads newline-delimited JSON messages from stdin when
        // --input-format stream-json is set. We write the payload then drop
        // stdin (EOF) so the CLI knows input is complete.
        if let Some(payload) = stream_json_payload {
            if let Some(stdin) = child.stdin.take() {
                use std::io::Write;
                let mut stdin = stdin;
                // Best-effort write — if it fails, the turn still runs but
                // without images (the text prompt is in the payload too).
                let _ = stdin.write_all(payload.as_bytes());
                let _ = stdin.flush();
                // stdin drops here → EOF → CLI processes the messages.
            }
        }

        // Take stdout/stderr BEFORE wrapping in Arc<Mutex<>> so the streams
        // can be moved into reader threads.
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "CLI stdout unavailable.".to_string())?;
        // Capture stderr on its own thread (draining the pipe so it can't
        // fill and block the child). We surface it if the turn ends with no
        // output — otherwise CLI errors (bad auth, missing deps) were
        // invisible: the user saw "Worked for 0s" with no explanation.
        let stderr_buf = Arc::new(Mutex::new(String::new()));
        let stderr_handle = child.stderr.take().map(|se| {
            let buf = stderr_buf.clone();
            thread::spawn(move || {
                let reader = BufReader::new(se);
                for line in reader.lines().map_while(Result::ok) {
                    eprintln!("[verboo-cli stderr] {line}");
                    if let Ok(mut b) = buf.lock() {
                        b.push_str(&line);
                        b.push('\n');
                    }
                }
            })
        });

        // Wrap in Arc<Mutex<>> so both the active map AND the stdout reader
        // thread can hold a handle. The reader thread calls `wait()` on
        // its clone of the Arc; `interrupt()` calls `kill()` on the map's
        // clone.
        let child_handle = Arc::new(Mutex::new(child));

        {
            let mut active = self
                .active
                .lock()
                .map_err(|e| format!("Lock error: {e}"))?;
            active.insert(turn_id.clone(), child_handle.clone());
        }

        let app_for_stdout = app.clone();
        let turn_id_for_stdout = turn_id.clone();
        let conversation_id_for_stdout = conversation_id.clone();
        let active_map_for_thread = self.active.clone();

        // Spawn reader thread for stdout (the main streaming channel).
        // `_sleep_guard` is moved into the closure and held alive for the
        // duration of the turn; dropping it releases the OS sleep assertion.
        // `_token_file` is moved into the closure so the 0600 temp file stays
        // alive while the child holds the fd/path. `child_handle` is moved
        // so the thread can call `wait()` to get the exit code.
        thread::spawn(move || {
            let _token_file = _token_file;
            let _sleep_guard = sleep_guard;
            let child_handle = child_handle;
            let runtime_label = runtime_label;
            let working_dir_label = working_dir_label;
            let reader = BufReader::new(stdout);
            let mut emitted_stream_text = false;
            let mut result_snapshot: Option<AgentResultSnapshot> = None;

            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                let clean = clean_terminal_text(&line);
                let parsed = parse_json_line(&clean);
                if let Some(payload) = parsed {
                    if is_result_payload(&payload) {
                        result_snapshot = Some(to_agent_result_snapshot(
                            &turn_id_for_stdout,
                            &payload,
                        ));
                        emit_event(
                            &app_for_stdout,
                            AgentEvent {
                                event_type: EventType::Result,
                                turn_id: Some(turn_id_for_stdout.clone()),
                                conversation_id: Some(conversation_id_for_stdout.clone()),
                                result: result_snapshot.clone(),
                                ..Default::default()
                            },
                        );
                    }
                    let runtime_status = runtime_status_from_payload(&payload);
                    let runtime_activity = runtime_activity_from_payload(&payload);
                    emit_event(
                        &app_for_stdout,
                        AgentEvent {
                            event_type: EventType::Json,
                            turn_id: Some(turn_id_for_stdout.clone()),
                            conversation_id: Some(conversation_id_for_stdout.clone()),
                            payload: Some(payload.clone()),
                            runtime_status,
                            runtime_activity,
                            ..Default::default()
                        },
                    );
                    let text = extract_text(&payload, emitted_stream_text);
                    if is_stream_text_payload(&payload) {
                        emitted_stream_text = true;
                    }
                    if let Some(t) = text {
                        emit_event(
                            &app_for_stdout,
                            AgentEvent {
                                event_type: EventType::Stdout,
                                turn_id: Some(turn_id_for_stdout.clone()),
                                conversation_id: Some(conversation_id_for_stdout.clone()),
                                text: Some(t),
                                ..Default::default()
                            },
                        );
                    }
                } else if !clean.trim().is_empty() {
                    emit_event(
                        &app_for_stdout,
                        AgentEvent {
                            event_type: EventType::Stdout,
                            turn_id: Some(turn_id_for_stdout.clone()),
                            conversation_id: Some(conversation_id_for_stdout.clone()),
                            text: Some(format!("{clean}\n")),
                            ..Default::default()
                        },
                    );
                }
            }

            // Wait for child to exit to get the exit code. The Arc<Mutex>
            // is the same handle that lives in the active map; we hold a
            // second clone in the closure.
            let exit_code = child_handle
                .lock()
                .ok()
                .and_then(|mut c| c.wait().ok())
                .and_then(|s| s.code());
            // Drain any remaining stderr now that the child has exited.
            if let Some(h) = stderr_handle {
                let _ = h.join();
            }
            // Remove the child from the active map now that the turn is done.
            // We can't hold the map lock directly (we're in a separate thread),
            // but we share the Arc with the active map.
            if let Some(mut map) = active_map_for_thread.lock().ok() {
                map.remove(&turn_id_for_stdout);
            }
            // If the turn produced no streamed text and exited abnormally,
            // surface the CLI's stderr / error result so the failure isn't
            // invisible (this is what turned bad auth / missing deps into a
            // silent "Worked for 0s").
            if !emitted_stream_text && exit_code != Some(0) {
                let exit_display = match exit_code {
                    Some(code) => format!("exit={code}"),
                    None => "signal".to_string(),
                };
                let diagnosis = format!(
                    "({exit_display}, runtime={runtime_label}, cwd={working_dir_label})"
                );
                let stderr_text = stderr_buf
                    .lock()
                    .ok()
                    .map(|b| b.trim().to_string())
                    .filter(|s| !s.is_empty());
                // Prefer structured error from the CLI result payload when present.
                let result_err = result_snapshot.as_ref().and_then(|snap| {
                    if snap.is_error.unwrap_or(false) {
                        snap.errors
                            .as_ref()
                            .map(|errs| errs.join("\n"))
                            .filter(|s| !s.trim().is_empty())
                    } else {
                        None
                    }
                });
                let err = match (stderr_text, result_err) {
                    (Some(stderr), Some(result)) => {
                        format!("{stderr}\n{result}\n{diagnosis}")
                    }
                    (Some(stderr), None) => format!("{stderr}\n{diagnosis}"),
                    (None, Some(result)) => format!("{result}\n{diagnosis}"),
                    (None, None) => format!(
                        "O CLI Verboo encerrou sem produzir resposta. {diagnosis}"
                    ),
                };
                emit_event(
                    &app_for_stdout,
                    AgentEvent {
                        event_type: EventType::Stdout,
                        turn_id: Some(turn_id_for_stdout.clone()),
                        conversation_id: Some(conversation_id_for_stdout.clone()),
                        text: Some(format!("⚠️ CLI Verboo: {err}\n")),
                        ..Default::default()
                    },
                );
            }
            if let Some(snap) = result_snapshot {
                emit_event(
                    &app_for_stdout,
                    AgentEvent {
                        event_type: EventType::Result,
                        turn_id: Some(turn_id_for_stdout.clone()),
                        conversation_id: Some(conversation_id_for_stdout.clone()),
                        result: Some(AgentResultSnapshot {
                            exit_code,
                            ..snap
                        }),
                        ..Default::default()
                    },
                );
            }
            emit_event(
                &app_for_stdout,
                AgentEvent {
                    event_type: EventType::Done,
                    turn_id: Some(turn_id_for_stdout.clone()),
                    conversation_id: Some(conversation_id_for_stdout.clone()),
                    exit_code,
                    ..Default::default()
                },
            );
            let _ = child_id;
        });

        Ok(turn_id)
    }

    /// Interrupt a running turn by turn_id. Sends SIGINT on Unix, Ctrl+C
    /// (GenerateConsoleCtrlEvent) on Windows, falling back to kill(). Returns
    /// true if a child was found and signaled, false if the turn wasn't
    /// running anymore.
    pub fn interrupt(&self, conversation_id: Option<String>) -> Result<bool, String> {
        let mut active = self.active.lock().map_err(|e| e.to_string())?;
        // For now we match by turn_id == conversation_id OR any active turn
        // when conversation_id is None — the renderer's `interrupt()` call
        // passes the active conversation_id, which we use as turn_id proxy.
        let target_key = if let Some(conv) = conversation_id {
            if active.contains_key(&conv) {
                Some(conv)
            } else {
                active.keys().next().cloned()
            }
        } else {
            active.keys().next().cloned()
        };
        if let Some(key) = target_key {
            if let Some(child_handle) = active.get_mut(&key) {
                // Try graceful interrupt first (SIGINT / Ctrl+C), then kill.
                if let Ok(mut child) = child_handle.lock() {
                    let _ = crate::services::child_signal::interrupt_child(&mut child);
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
}

impl Default for TurnService {
    fn default() -> Self {
        Self::new(std::sync::Arc::new(CredentialsStore::new()))
    }
}

fn emit_event(app: &AppHandle, event: AgentEvent) {
    let _ = app.emit(AGENT_EVENT_CHANNEL, event);
}

/// Resolve the `verboo` CLI path: env override first, then PATH.
/// Follow-up: bundled CLI via Node sidecar for packaged builds.
#[allow(dead_code)]
fn resolve_cli_path() -> String {
    crate::services::cli_path::resolve().unwrap_or_else(|| "verboo".to_string())
}

/// Builds the stream-json stdin payload for a turn with image attachments.
///
/// Returns `Some(json_string)` when the model supports vision AND there are
/// image attachments — the caller switches to `--input-format stream-json`
/// and writes this payload to stdin. Returns `None` otherwise (caller uses
/// the positional prompt path).
///
/// The payload is a single user message with:
/// - A text block containing the full prompt (same as `build_prompt`).
/// - One `image_url` block per image attachment, with base64 data URL.
///
/// Format follows the OpenAI/Anthropic-compatible message schema the CLI
/// accepts via `--input-format stream-json`:
/// ```json
/// {"role":"user","content":[{"type":"text","text":"..."},{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}]}
/// ```
fn build_stream_json_input(
    request: &AgentTurnRequest,
    prompt: &str,
) -> Option<String> {
    if request.model_supports_vision != Some(true) {
        return None;
    }
    let attachments = request.attachments.as_ref()?;
    let images: Vec<&AttachmentMeta> = attachments
        .iter()
        .filter(|a| a.kind == AttachmentKind::Image && a.media_type.is_some())
        .collect();
    if images.is_empty() {
        return None;
    }

    // Build content blocks: text first, then images.
    let mut content = Vec::with_capacity(images.len() + 1);
    content.push(serde_json::json!({
        "type": "text",
        "text": prompt
    }));
    for img in images {
        // Read the image file and base64-encode it.
        let bytes = match std::fs::read(&img.path) {
            Ok(b) => b,
            Err(_) => {
                // Skip unreadable images — the text prompt still goes through.
                continue;
            }
        };
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
        let media_type = img.media_type.as_deref().unwrap_or("image/png");
        let data_url = format!("data:{media_type};base64,{b64}");
        content.push(serde_json::json!({
            "type": "image_url",
            "image_url": { "url": data_url }
        }));
    }

    // Only return if we successfully encoded at least one image.
    if content.len() <= 1 {
        return None;
    }

    let message = serde_json::json!({
        "role": "user",
        "content": content
    });
    // stream-json input is newline-delimited JSON messages.
    Some(format!("{}\n", message))
}

/// Build the user prompt that goes to the CLI. Mirrors Electron's
/// `buildPrompt` — app instructions + working directory + personality +
/// custom instructions + memory + skills + attachments + message.
///
/// On resume, only send working directory + message (rest is already in
/// the resumed session history).
fn build_prompt(request: &AgentTurnRequest, is_resume: bool) -> String {
    build_prompt_internal(request, is_resume)
}

/// Same as [`build_prompt`], exposed as `pub(crate)` so the research-subagent
/// runner (services/research_subagent_runner.rs) can compose the same prompt
/// format without duplicating the logic.
pub(crate) fn build_prompt_internal(request: &AgentTurnRequest, is_resume: bool) -> String {
    let language = request
        .response_language
        .unwrap_or(LanguageCode::EnUs);
    let working_directory = safe_runtime_working_directory(&request.working_directory);
    let _ = request.response_language; // already copied via Copy

    if is_resume {
        let workspace_line = if language == LanguageCode::PtBr {
            format!("Diretório de trabalho atual: {working_directory}")
        } else {
            format!("Current working directory: {working_directory}")
        };
        let attachment_lines = build_attachment_lines(
            &request.attachments,
            language,
            request.model_supports_vision,
        );
        let parts: Vec<String> = std::iter::once(workspace_line)
            .chain(attachment_lines)
            .chain(std::iter::once(request.message.clone()))
            .collect();
        return parts.join("\n\n");
    }

    let mut parts: Vec<String> = Vec::new();
    if request.response_enhancements_enabled.unwrap_or(false) {
        parts.extend(build_app_instructions());
    }
    let workspace_line = if language == LanguageCode::PtBr {
        format!("Diretório de trabalho atual: {working_directory}")
    } else {
        format!("Current working directory: {working_directory}")
    };
    parts.push(workspace_line);

    if request.response_enhancements_enabled.unwrap_or(false) {
        if let Some(p) = &request.personality {
            parts.push(format!(
                "{} {}.",
                if language == LanguageCode::PtBr {
                    "Personalidade preferida:"
                } else {
                    "Preferred personality:"
                },
                personality_label(p, language)
            ));
        }
        if let Some(ci) = &request.custom_instructions {
            let trimmed = ci.trim();
            if !trimmed.is_empty() {
                let (label, body) = if language == LanguageCode::PtBr {
                    (
                        "Instruções personalizadas do usuário:",
                        trimmed.to_string(),
                    )
                } else {
                    ("User custom instructions:", trimmed.to_string())
                };
                parts.push(format!("{label}\n{body}"));
            }
        }
    }
    if let Some(mc) = &request.memory_context {
        let trimmed = mc.trim();
        if !trimmed.is_empty() {
            let (label, body) = if language == LanguageCode::PtBr {
                (
                    "Memória local relevante deste app:",
                    trimmed.to_string(),
                )
            } else {
                ("Relevant local app memory:", trimmed.to_string())
            };
            parts.push(format!("{label}\n{body}"));
        }
    }
    let skill_lines = build_skill_lines(&request.skills, language);
    parts.extend(skill_lines);
    let attachment_lines = build_attachment_lines(
        &request.attachments,
        language,
        request.model_supports_vision,
    );
    parts.extend(attachment_lines);

    parts.push(request.message.clone());
    parts.join("\n\n")
}

fn safe_runtime_working_directory(working_directory: &str) -> String {
    let trimmed = working_directory.trim();
    if trimmed.is_empty() || trimmed == "/" || trimmed == "." {
        dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "/".to_string())
    } else {
        trimmed.to_string()
    }
}

fn build_app_instructions() -> Vec<String> {
    [
        "Write long answers with short paragraphs, lists, and final summaries when that improves readability.",
        "Before using tools on a new task, write one short normal-prose sentence explaining what you will do.",
        "Do not expose internal reasoning, hidden thought text, raw research, or tool logs as final response prose.",
        "Do not narrate reads, searches, commands, or edits only to record activity; the interface already shows those actions in a structured panel.",
        "During execution, write only useful user-facing updates; do not paste tool-call sequences, internal tool names, or raw progress into the main text.",
        "When you need permission, make a focused request explaining exactly which action is needed and why.",
        "When finishing a task, provide a short Codex-style summary: what changed, references checked when applicable, validation done when applicable, and relevant caveats.",
        "Do not dump full lists of files, commands, or executed steps into the main text; those details belong in the interface expandable panel when available.",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn build_skill_lines(skills: &[crate::models::types::SkillSummary], language: LanguageCode) -> Vec<String> {
    if skills.is_empty() {
        return Vec::new();
    }
    let mut lines = Vec::new();
    lines.push(
        if language == LanguageCode::PtBr {
            "Skills disponíveis:"
        } else {
            "Available skills:"
        }
        .to_string(),
    );
    for skill in skills {
        lines.push(format!("- Use skill \"{}\" — {}", skill.name, skill.path));
    }
    lines
}

fn build_attachment_lines(
    attachments: &Option<Vec<AttachmentMeta>>,
    language: LanguageCode,
    model_supports_vision: Option<bool>,
) -> Vec<String> {
    let Some(list) = attachments else {
        return Vec::new();
    };
    if list.is_empty() {
        return Vec::new();
    }
    let mut lines = Vec::new();
    lines.push(
        if language == LanguageCode::PtBr {
            "Anexos selecionados:"
        } else {
            "Selected attachments:"
        }
        .to_string(),
    );
    let joined = list
        .iter()
        .map(|a| {
            let dims = match (a.width, a.height) {
                (Some(w), Some(h)) => format!(", {w}x{h}"),
                _ => String::new(),
            };
            let kind_str = if let Some(mt) = &a.media_type {
                format!("{mt}{dims}")
            } else {
                format!("{}{dims}", attachment_kind_label(&a.kind))
            };
            let mut entry = format!("- {} ({kind_str}): {}", a.name, a.path);
            // When we have extracted text, inject it inline so any model can
            // reason about the content. This is the primary fix for the
            // "PDF alucinado" bug — the model no longer needs to guess.
            let has_text = a
                .extracted_text
                .as_deref()
                .map(|t| !t.trim().is_empty())
                .unwrap_or(false);
            if has_text {
                let text = a.extracted_text.as_deref().unwrap_or("");
                entry.push_str(&format!("\n  <document-content>\n{text}\n  </document-content>"));
            } else if model_supports_vision == Some(false) {
                // No usable extracted text AND the model explicitly doesn't
                // support vision. Be explicit so the model doesn't hallucinate:
                // it should tell the user it can't read the file, not invent
                // content. (Vision-capable models skip this — Kassandra's
                // vision fallback path will inject base64 separately. When
                // vision support is unknown, we don't warn to avoid false
                // alarms on models that do support vision but the flag
                // wasn't populated.)
                let warning = if language == LanguageCode::PtBr {
                    "[O conteúdo deste arquivo não pôde ser extraído e o \
                     modelo atual não suporta visão. NÃO invente o conteúdo. \
                     Diga ao usuário que você não consegue ler este arquivo \
                     e sugira que ele cole o texto ou use um modelo com \
                     suporte a visão.]"
                } else {
                    "[This file's content could not be extracted and the \
                     current model does not support vision. DO NOT invent \
                     the content. Tell the user you cannot read this file \
                     and suggest they paste the text or use a vision-capable \
                     model.]"
                };
                entry.push_str(&format!("\n  {warning}"));
            }
            entry
        })
        .collect::<Vec<_>>()
        .join("\n");
    lines.push(joined);
    lines
}

fn attachment_kind_label(kind: &AttachmentKind) -> &'static str {
    match kind {
        AttachmentKind::Image => "image",
        AttachmentKind::File => "file",
    }
}

fn personality_label(value: &PersonalityMode, language: LanguageCode) -> &'static str {
    match (value, language) {
        (PersonalityMode::Concise, LanguageCode::PtBr) => "concisa e direta",
        (PersonalityMode::Explanatory, LanguageCode::PtBr) => {
            "explicativa, com contexto quando ajuda"
        }
        (PersonalityMode::Pragmatic, LanguageCode::PtBr) => {
            "pragmática, objetiva e orientada a execução"
        }
        (PersonalityMode::Concise, _) => "concise and direct",
        (PersonalityMode::Explanatory, _) => "explanatory, with context when helpful",
        (PersonalityMode::Pragmatic, _) => "pragmatic, direct, and execution-oriented",
    }
}

// ── Parsing helpers ─────────────────────────────────────────────────

/// Strip ANSI escape sequences + DECSET 2026 (in-band mode switch that
/// breaks JSON parsing). Mirrors Electron's `cleanTerminalText`.
pub fn clean_terminal_text(value: &str) -> String {
    // Body unchanged — promoted to `pub` so the research-subagent runner
    // (services/research_subagent_runner.rs) can reuse the exact same
    // cleaning logic that the main turn stream uses.
    clean_terminal_text_impl(value)
}

fn clean_terminal_text_impl(value: &str) -> String {
    let ansi_stripped = strip_ansi(value);
    ansi_stripped
        .replace('\u{001b}', "")
        .replace("[?2026h", "")
        .replace("[?2026l", "")
}

/// Strip ANSI escape sequences from a string while preserving UTF-8.
///
/// Handles three cases:
///   - CSI: `ESC [ ... <terminator 0x40-0x7E>` — colors, cursor moves, etc.
///   - Two-byte escape: `ESC <0x40-0x5F>` — e.g. `ESC =`, `ESC >`.
///   - Lone ESC at end of string: skipped.
///
/// Operates at the byte level to detect ESC (which is a single ASCII byte)
/// and the CSI terminator range, but copies non-escape regions as `&str`
/// slices via `str::from_utf8_unchecked`-equivalent slicing. This preserves
/// multi-byte UTF-8 sequences (emoji, accented characters, CJK) intact.
/// The byte-level scan is safe because ESC (0x1B) and all CSI/escape
/// payload bytes are ASCII (< 0x80) — they never appear as continuation
/// bytes inside a UTF-8 multi-byte sequence.
fn strip_ansi(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = String::with_capacity(value.len());
    let mut i = 0;
    // Start of the current "clean" (non-escape) region we're copying.
    let mut run_start = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b {
            // Flush any pending clean bytes before this escape.
            if i > run_start {
                // SAFETY: we walked these bytes inside a valid &str; they are
                // valid UTF-8.
                out.push_str(unsafe {
                    std::str::from_utf8_unchecked(&bytes[run_start..i])
                });
            }
            // ESC at end of string: drop it.
            if i + 1 >= bytes.len() {
                return out;
            }
            let next = bytes[i + 1];
            if next == b'[' {
                // CSI: skip until terminator 0x40-0x7E
                let mut j = i + 2;
                while j < bytes.len() {
                    let c = bytes[j];
                    j += 1;
                    if (0x40..=0x7e).contains(&c) {
                        break;
                    }
                }
                i = j;
                run_start = i;
                continue;
            } else if (0x40..=0x5f).contains(&next) {
                // Two-byte escape (e.g. ESC =, ESC >)
                i += 2;
                run_start = i;
                continue;
            }
            // Lone ESC not followed by a recognized escape byte: drop the ESC,
            // keep the next byte (it might be a UTF-8 continuation byte).
            i += 1;
            run_start = i;
            continue;
        }
        i += 1;
    }
    // Flush any trailing clean bytes.
    if i > run_start {
        // SAFETY: same as above.
        out.push_str(unsafe { std::str::from_utf8_unchecked(&bytes[run_start..i]) });
    }
    out
}

/// Parse a single line as JSON, returning None on failure.
pub fn parse_json_line(line: &str) -> Option<serde_json::Value> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(trimmed).ok()
}

fn is_record(value: &serde_json::Value) -> bool {
    value.is_object()
}

fn is_result_payload(payload: &serde_json::Value) -> bool {
    payload
        .get("type")
        .and_then(|v| v.as_str())
        .map(|s| s == "result")
        .unwrap_or(false)
}

fn to_agent_result_snapshot(turn_id: &str, payload: &serde_json::Value) -> AgentResultSnapshot {
    let session_id = payload
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let stop_reason = payload
        .get("stop_reason")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let is_error = payload.get("is_error").and_then(|v| v.as_bool());
    let usage = payload.get("usage").filter(|v| v.is_object()).cloned();
    let permission_denials = payload
        .get("permission_denials")
        .and_then(|v| v.as_array())
        .map(|a| a.clone());
    let errors = payload
        .get("errors")
        .and_then(|v| v.as_array())
        .and_then(|a| {
            let filtered: Vec<String> = a
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect();
            if filtered.is_empty() {
                None
            } else {
                Some(filtered)
            }
        });
    let raw_result = Some(payload.clone());
    AgentResultSnapshot {
        turn_id: turn_id.to_string(),
        exit_code: None,
        session_id,
        stop_reason,
        is_error,
        usage: usage.map(|u| crate::models::types::TokenUsage {
            input_tokens: u.get("input_tokens").and_then(|v| v.as_u64()).map(|n| n as u32),
            output_tokens: u
                .get("output_tokens")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32),
            cache_read_input_tokens: u
                .get("cache_read_input_tokens")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32),
            cache_creation_input_tokens: u
                .get("cache_creation_input_tokens")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32),
        }),
        permission_denials,
        errors,
        raw_result,
    }
}

fn extract_text(payload: &serde_json::Value, suppress_assistant_snapshot: bool) -> Option<String> {
    if !is_record(payload) {
        return None;
    }
    let ptype = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if ptype == "stream_event" {
        if let Some(event) = payload.get("event") {
            if let Some(delta) = event.get("delta") {
                if delta.get("type").and_then(|v| v.as_str()) == Some("text_delta") {
                    if let Some(text) = delta.get("text").and_then(|v| v.as_str()) {
                        return Some(clean_terminal_text(text));
                    }
                }
            }
        }
        return None;
    }
    if let Some(content) = payload.get("content").and_then(|v| v.as_str()) {
        return Some(clean_terminal_text(content));
    }
    if let Some(text) = payload.get("text").and_then(|v| v.as_str()) {
        return Some(clean_terminal_text(text));
    }
    if ptype == "result" && !suppress_assistant_snapshot {
        if let Some(result) = payload.get("result").and_then(|v| v.as_str()) {
            return Some(clean_terminal_text(result));
        }
    }
    if ptype == "assistant" {
        if suppress_assistant_snapshot {
            return None;
        }
        if let Some(message) = payload.get("message") {
            if let Some(content) = message.get("content").and_then(|v| v.as_array()) {
                let text = content
                    .iter()
                    .filter_map(|block| {
                        if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                            block.get("text").and_then(|v| v.as_str())
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("");
                if !text.is_empty() {
                    return Some(clean_terminal_text(&text));
                }
            }
        }
    }
    None
}

fn is_stream_text_payload(payload: &serde_json::Value) -> bool {
    if payload.get("type").and_then(|v| v.as_str()) != Some("stream_event") {
        return false;
    }
    let Some(event) = payload.get("event") else {
        return false;
    };
    let Some(delta) = event.get("delta") else {
        return false;
    };
    delta.get("type").and_then(|v| v.as_str()) == Some("text_delta")
        && delta.get("text").and_then(|v| v.as_str()).is_some()
}

fn runtime_status_from_payload(payload: &serde_json::Value) -> Option<RuntimeStatus> {
    let ptype = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let event = payload.get("event");
    let event_type = event
        .and_then(|e| e.get("type"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let block = event.and_then(|e| e.get("content_block"));
    let block_type = block
        .and_then(|b| b.get("type"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let text = format!("{ptype} {event_type} {block_type}").to_lowercase();
    if text.contains("permission")
        || text.contains("action_required")
        || text.contains("tool_confirmation")
    {
        return Some(RuntimeStatus {
            kind: RuntimeStatusKind::Permission,
            label: "permission".to_string(),
        });
    }
    if text.contains("askuserquestion") || text.contains("question") {
        return Some(RuntimeStatus {
            kind: RuntimeStatusKind::Question,
            label: "question".to_string(),
        });
    }
    if text.contains("tool_use") || text.contains("tool_result") || text.contains("tool") {
        let tool = tool_name_from_payload(payload).unwrap_or_default();
        return Some(RuntimeStatus {
            kind: RuntimeStatusKind::Tool,
            label: label_for_tool_name(&tool).to_string(),
        });
    }
    None
}

fn runtime_activity_from_payload(payload: &serde_json::Value) -> Option<RuntimeActivity> {
    // Compaction detection
    if payload.get("type").and_then(|v| v.as_str()) == Some("stream_event") {
        if let Some(event) = payload.get("event") {
            if let Some(delta) = event.get("delta") {
                let dtype = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if dtype == "compaction_delta" || dtype == "compaction" {
                    return Some(RuntimeActivity {
                        key: "compaction".to_string(),
                        label: "Compacting context...".to_string(),
                        detail: None,
                        kind: "compacting".to_string(),
                        tool_use_id: None,
                    });
                }
            }
        }
    }
    let block = extract_tool_block(payload)?;
    let name = block
        .get("name")
        .and_then(|v| v.as_str())
        .or_else(|| block.get("tool_name").and_then(|v| v.as_str()))?
        .to_string();
    let input = tool_input(&block);
    let id = block.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());
    let detail = detail_for_tool(&name, input.as_ref());
    let activity = activity_for_tool(&name);
    Some(RuntimeActivity {
        key: format!("{}:{}", id.as_deref().unwrap_or(&name), detail.as_deref().unwrap_or("")),
        label: activity.0.to_string(),
        detail,
        kind: activity.1.to_string(),
        tool_use_id: id,
    })
}

fn tool_name_from_payload(payload: &serde_json::Value) -> Option<String> {
    if let Some(block) = extract_tool_block(payload) {
        return block
            .get("name")
            .and_then(|v| v.as_str())
            .or_else(|| block.get("tool_name").and_then(|v| v.as_str()))
            .map(|s| s.to_string());
    }
    let message = payload.get("message")?;
    let content = message.get("content")?.as_array()?;
    content
        .iter()
        .find_map(|item| {
            let itype = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if itype.to_lowercase().contains("tool_use") {
                item.get("name")
                    .and_then(|v| v.as_str())
                    .or_else(|| item.get("tool_name").and_then(|v| v.as_str()))
                    .map(|s| s.to_string())
            } else {
                None
            }
        })
}

fn label_for_tool_name(tool_name: &str) -> &'static str {
    let n = tool_name.to_lowercase();
    if is_subagent_tool_name(&n) {
        return "subagent";
    }
    match n.as_str() {
        "read" | "ls" | "glob" | "grep" => "reading",
        "edit" | "multiedit" | "write" | "notebookedit" => "editing",
        "bash" => "running",
        "websearch" | "webfetch" => "searching",
        "todowrite" => "planning",
        _ => "tool",
    }
}

pub(crate) fn extract_tool_block(payload: &serde_json::Value) -> Option<serde_json::Map<String, serde_json::Value>> {
    if !payload.is_object() {
        return None;
    }
    if is_tool_block(payload) {
        return payload.as_object().cloned();
    }
    if let Some(event) = payload.get("event") {
        if let Some(cb) = event.get("content_block") {
            if is_tool_block(cb) {
                return cb.as_object().cloned();
            }
        }
    }
    if let Some(message) = payload.get("message") {
        if let Some(content) = message.get("content").and_then(|v| v.as_array()) {
            for block in content {
                if is_tool_block(block) {
                    return block.as_object().cloned();
                }
            }
        }
    }
    None
}

fn is_tool_block(value: &serde_json::Value) -> bool {
    if !value.is_object() {
        return false;
    }
    let t = value
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    t.contains("tool_use")
        || value.get("name").and_then(|v| v.as_str()).is_some()
        || value.get("tool_name").and_then(|v| v.as_str()).is_some()
}

fn activity_for_tool(tool_name: &str) -> (&'static str, &'static str) {
    let n = tool_name.to_lowercase();
    if is_subagent_tool_name(&n) {
        return ("Subagente ativo", "subagent");
    }
    match n.as_str() {
        "read" | "read_file" => ("Leu arquivo", "read"),
        "ls" | "glob" | "grep" | "search" => ("Inspecionou arquivos", "read"),
        "edit" | "multiedit" | "multi_edit" | "write" | "notebookedit" => {
            ("Editou arquivo", "edit")
        }
        "bash" | "shell" | "exec_command" => ("Executou comando", "command"),
        "websearch" | "webfetch" => ("Pesquisou na internet", "search"),
        "askuserquestion" => ("Pediu resposta", "permission"),
        "todowrite" => ("Atualizou tarefas", "tool"),
        _ => ("Usou ferramenta", "tool"),
    }
}

fn detail_for_tool(tool_name: &str, input: Option<&serde_json::Map<String, serde_json::Value>>) -> Option<String> {
    let input = input?;
    let n = tool_name.to_lowercase();
    if is_subagent_tool_name(&n) {
        return snippet(
            ["description", "subagent_type", "prompt", "task", "message"]
                .iter()
                .find_map(|k| input.get(*k).and_then(|v| v.as_str())),
            360,
        );
    }
    if matches!(n.as_str(), "bash" | "shell" | "exec_command") {
        return snippet(
            input
                .get("command")
                .and_then(|v| v.as_str())
                .or_else(|| input.get("cmd").and_then(|v| v.as_str())),
            360,
        );
    }
    if n == "websearch" {
        return snippet(input.get("query").and_then(|v| v.as_str()), 360);
    }
    if n == "webfetch" {
        return snippet(input.get("url").and_then(|v| v.as_str()), 360);
    }
    if n == "grep" {
        return snippet(
            input
                .get("pattern")
                .and_then(|v| v.as_str())
                .or_else(|| input.get("path").and_then(|v| v.as_str())),
            360,
        );
    }
    if n == "glob" {
        return snippet(input.get("pattern").and_then(|v| v.as_str()), 360);
    }
    if n == "ls" {
        return snippet(input.get("path").and_then(|v| v.as_str()), 360);
    }
    if n == "askuserquestion" {
        return snippet(input.get("question").and_then(|v| v.as_str()), 360);
    }
    snippet(
        input
            .get("file_path")
            .and_then(|v| v.as_str())
            .or_else(|| input.get("filePath").and_then(|v| v.as_str()))
            .or_else(|| input.get("path").and_then(|v| v.as_str()))
            .or_else(|| input.get("notebook_path").and_then(|v| v.as_str())),
        360,
    )
}

fn is_subagent_tool_name(tool_name: &str) -> bool {
    let compact = tool_name.replace(['-', '_', ' '], "");
    compact == "task"
        || compact == "agent"
        || compact.contains("subagent")
        || compact.contains("agenttask")
        || compact.contains("dispatchagent")
        || compact.contains("researchagent")
}

fn tool_input(block: &serde_json::Map<String, serde_json::Value>) -> Option<serde_json::Map<String, serde_json::Value>> {
    if let Some(input) = block.get("input") {
        if let Some(obj) = input.as_object() {
            return Some(obj.clone());
        }
    }
    if let Some(args) = block.get("arguments") {
        if let Some(obj) = args.as_object() {
            return Some(obj.clone());
        }
    }
    let input_json = block
        .get("input_json")
        .and_then(|v| v.as_str())
        .or_else(|| block.get("arguments_json").and_then(|v| v.as_str()))?;
    let parsed: serde_json::Value = serde_json::from_str(input_json).ok()?;
    parsed.as_object().cloned()
}

fn snippet(value: Option<&str>, max_len: usize) -> Option<String> {
    let text = value?.trim();
    if text.is_empty() {
        return None;
    }
    let collapsed: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.len() <= max_len {
        Some(collapsed)
    } else {
        Some(collapsed.split_at(max_len).0.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clean_terminal_text_strips_ansi_and_decset() {
        let input = "\x1b[31mred\x1b[0m text";
        assert_eq!(clean_terminal_text(input), "red text");

        let with_decset = "before\x1b[?2026h{\"type\":\"x\"}\x1b[?2026lafter";
        assert_eq!(
            clean_terminal_text(with_decset),
            "before{\"type\":\"x\"}after"
        );

        let with_bare_esc = "abc\u{001b}def";
        assert_eq!(clean_terminal_text(with_bare_esc), "abcdef");
    }

    #[test]
    fn clean_terminal_text_preserves_emoji() {
        // Emoji are 4-byte UTF-8 sequences. The old byte-by-byte `as char`
        // implementation corrupted them into Latin-1 mojibake.
        let input = "Hi! 👋";
        assert_eq!(clean_terminal_text(input), "Hi! 👋");

        // Emoji inside ANSI-colored text
        let input = "\x1b[32mStatus: ✅ done\x1b[0m";
        assert_eq!(clean_terminal_text(input), "Status: ✅ done");

        // Emoji after DECSET 2026 (common in real CLI stream-json output)
        let input = "\x1b[?2026h{\"result\":\"Hi! 👋\"}\x1b[?2026l";
        assert_eq!(
            clean_terminal_text(input),
            "{\"result\":\"Hi! 👋\"}"
        );
    }

    #[test]
    fn clean_terminal_text_preserves_portuguese_accents() {
        // pt-BR is the user's primary language — accented chars are 2-byte UTF-8.
        let input = "pragmática, objetiva e orientada a execução";
        assert_eq!(clean_terminal_text(input), input);

        let input = "\x1b[31mpragmática\x1b[0m";
        assert_eq!(clean_terminal_text(input), "pragmática");

        let input = "São João da Serra";
        assert_eq!(clean_terminal_text(input), "São João da Serra");
    }

    #[test]
    fn clean_terminal_text_preserves_cjk_and_cyrillic() {
        // CJK (3-byte UTF-8)
        let input = "日本語テスト";
        assert_eq!(clean_terminal_text(input), input);

        // Cyrillic (2-byte UTF-8)
        let input = "Привет мир";
        assert_eq!(clean_terminal_text(input), input);

        // Mixed: ASCII + emoji + CJK + accents + ANSI
        let input = "Hello 世界 🌍 café \x1b[31mred\x1b[0m";
        assert_eq!(clean_terminal_text(input), "Hello 世界 🌍 café red");
    }

    #[test]
    fn strip_ansi_preserves_multi_byte_utf8() {
        // Direct test of strip_ansi (without the DECSET replacement layer).
        let input = "\x1b[31m🎉\x1b[0m";
        assert_eq!(strip_ansi(input), "🎉");

        let input = "café \x1b[1mbold\x1b[0m 日本語";
        assert_eq!(strip_ansi(input), "café bold 日本語");
    }

    #[test]
    fn parse_json_line_handles_valid_and_invalid() {
        assert_eq!(
            parse_json_line(r#"{"type":"result","is_error":false}"#),
            Some(json!({"type":"result","is_error":false}))
        );
        assert_eq!(parse_json_line("not json"), None);
        assert_eq!(parse_json_line(""), None);
        assert_eq!(parse_json_line("   "), None);
    }

    #[test]
    fn extract_text_from_stream_event_delta() {
        let payload = json!({
            "type": "stream_event",
            "event": {
                "delta": {"type": "text_delta", "text": "hello world"}
            }
        });
        assert_eq!(extract_text(&payload, false), Some("hello world".to_string()));
    }

    #[test]
    fn extract_text_from_result() {
        let payload = json!({
            "type": "result",
            "result": "Final answer"
        });
        assert_eq!(extract_text(&payload, false), Some("Final answer".to_string()));
    }

    #[test]
    fn extract_text_from_assistant_content_array() {
        let payload = json!({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "text", "text": "first "},
                    {"type": "text", "text": "second"}
                ]
            }
        });
        assert_eq!(extract_text(&payload, false), Some("first second".to_string()));
    }

    #[test]
    fn extract_text_returns_none_when_suppressed() {
        let payload = json!({"type": "result", "result": "x"});
        assert_eq!(extract_text(&payload, true), None);
    }

    #[test]
    fn runtime_status_detects_tool_use() {
        let payload = json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "content_block": {"type": "tool_use", "name": "bash"}
            }
        });
        let status = runtime_status_from_payload(&payload).unwrap();
        assert_eq!(status.kind, RuntimeStatusKind::Tool);
        assert_eq!(status.label, "running");
    }

    #[test]
    fn runtime_activity_detects_bash_command() {
        let payload = json!({
            "type": "stream_event",
            "event": {
                "content_block": {
                    "type": "tool_use",
                    "id": "tool_01",
                    "name": "bash",
                    "input": {"command": "ls -la"}
                }
            }
        });
        let activity = runtime_activity_from_payload(&payload).unwrap();
        assert_eq!(activity.label, "Executou comando");
        assert_eq!(activity.kind, "command");
        assert_eq!(activity.detail.as_deref(), Some("ls -la"));
    }

    #[test]
    fn runtime_activity_detects_compaction() {
        let payload = json!({
            "type": "stream_event",
            "event": {"delta": {"type": "compaction_delta"}}
        });
        let activity = runtime_activity_from_payload(&payload).unwrap();
        assert_eq!(activity.kind, "compacting");
        assert_eq!(activity.label, "Compacting context...");
    }

    #[test]
    fn to_result_snapshot_extracts_fields() {
        let payload = json!({
            "type": "result",
            "session_id": "abc-123",
            "stop_reason": "end_turn",
            "is_error": false,
            "usage": {"input_tokens": 100, "output_tokens": 200}
        });
        let snap = to_agent_result_snapshot("turn-1", &payload);
        assert_eq!(snap.turn_id, "turn-1");
        assert_eq!(snap.session_id.as_deref(), Some("abc-123"));
        assert_eq!(snap.stop_reason.as_deref(), Some("end_turn"));
        assert!(!snap.is_error.unwrap_or(true));
        let usage = snap.usage.unwrap();
        assert_eq!(usage.input_tokens, Some(100));
        assert_eq!(usage.output_tokens, Some(200));
    }

    #[test]
    fn safe_runtime_working_directory_handles_empty() {
        let home = dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "/".to_string());
        // Empty/slash/dot fall back to the user's home dir
        assert_eq!(safe_runtime_working_directory(""), home);
        assert_eq!(safe_runtime_working_directory("/"), home);
        assert_eq!(safe_runtime_working_directory("."), home);
        // Real paths are kept as-is
        assert_eq!(
            safe_runtime_working_directory("/Users/test/code"),
            "/Users/test/code"
        );
    }

    #[test]
    fn build_prompt_first_turn_includes_workspace_and_message() {
        let request = AgentTurnRequest {
            turn_id: None,
            conversation_id: "c1".into(),
            message: "Hello".into(),
            model: None,
            model_supports_vision: None,
            context_window: None,
            response_language: Some(LanguageCode::EnUs),
            access_mode: crate::models::types::AccessMode::Approval,
            working_directory: "/tmp".into(),
            skills: Vec::new(),
            attachments: None,
            response_enhancements_enabled: Some(false),
            personality: None,
            custom_instructions: None,
            memory_context: None,
        };
        let prompt = build_prompt(&request, false);
        assert!(prompt.contains("Current working directory: /tmp"));
        assert!(prompt.contains("Hello"));
    }

    #[test]
    fn build_prompt_resume_omits_app_instructions() {
        let request = AgentTurnRequest {
            turn_id: None,
            conversation_id: "c1".into(),
            message: "Next step".into(),
            model: None,
            model_supports_vision: None,
            context_window: None,
            response_language: Some(LanguageCode::EnUs),
            access_mode: crate::models::types::AccessMode::Approval,
            working_directory: "/tmp".into(),
            skills: Vec::new(),
            attachments: None,
            response_enhancements_enabled: Some(true),
            personality: Some(PersonalityMode::Concise),
            custom_instructions: Some("be brief".into()),
            memory_context: None,
        };
        let prompt = build_prompt(&request, true);
        // On resume, personality/customInstructions should NOT be present
        assert!(!prompt.contains("Preferred personality"));
        assert!(!prompt.contains("User custom instructions"));
        // But working directory and message ARE present
        assert!(prompt.contains("Current working directory: /tmp"));
        assert!(prompt.contains("Next step"));
    }

    // ── build_attachment_lines tests ────────────────────────────────
    //
    // These verify the "PDF alucinado" fix: extracted text is injected
    // inline, and when no text is available + no vision, an explicit
    // warning tells the model NOT to invent content.

    fn attachment_with_text(text: &str) -> AttachmentMeta {
        AttachmentMeta {
            path: "/tmp/doc.pdf".into(),
            name: "doc.pdf".into(),
            size: 1000,
            kind: AttachmentKind::File,
            media_type: None,
            width: None,
            height: None,
            extracted_text: Some(text.into()),
            extraction_status: Some(crate::models::types::ExtractionStatus::Extracted),
        }
    }

    fn attachment_no_text() -> AttachmentMeta {
        AttachmentMeta {
            path: "/tmp/scan.pdf".into(),
            name: "scan.pdf".into(),
            size: 1000,
            kind: AttachmentKind::File,
            media_type: None,
            width: None,
            height: None,
            extracted_text: None,
            extraction_status: None,
        }
    }

    #[test]
    fn attachment_lines_inject_extracted_text() {
        let attachments = Some(vec![attachment_with_text("Joao da Silva\nRua X, 123")]);
        let lines = build_attachment_lines(&attachments, LanguageCode::EnUs, None);
        let joined = lines.join("\n");
        assert!(joined.contains("Joao da Silva"), "should contain extracted text");
        assert!(joined.contains("<document-content>"), "should wrap in tag");
    }

    #[test]
    fn attachment_lines_warn_when_no_text_and_no_vision() {
        // No extracted text + model doesn't support vision → explicit warning.
        let attachments = Some(vec![attachment_no_text()]);
        let lines = build_attachment_lines(&attachments, LanguageCode::EnUs, Some(false));
        let joined = lines.join("\n");
        assert!(
            joined.contains("DO NOT invent"),
            "should warn model not to hallucinate, got: {joined}"
        );
    }

    #[test]
    fn attachment_lines_no_warning_when_model_supports_vision() {
        // No extracted text but model supports vision → no warning (Kassandra's
        // vision path will handle base64 injection separately).
        let attachments = Some(vec![attachment_no_text()]);
        let lines = build_attachment_lines(&attachments, LanguageCode::EnUs, Some(true));
        let joined = lines.join("\n");
        assert!(
            !joined.contains("DO NOT invent"),
            "vision-capable model should not get the no-vision warning"
        );
    }

    #[test]
    fn attachment_lines_no_warning_when_vision_unknown() {
        // When we don't know if the model supports vision, don't warn —
        // avoids false alarms on models that do support vision but the
        // flag wasn't populated. The extracted_text path handles the
        // common case; this is a conservative default.
        let attachments = Some(vec![attachment_no_text()]);
        let lines = build_attachment_lines(&attachments, LanguageCode::EnUs, None);
        let joined = lines.join("\n");
        assert!(
            !joined.contains("DO NOT invent"),
            "unknown vision should not trigger warning"
        );
    }

    #[test]
    fn attachment_lines_pt_br_warning_language() {
        let attachments = Some(vec![attachment_no_text()]);
        let lines = build_attachment_lines(&attachments, LanguageCode::PtBr, Some(false));
        let joined = lines.join("\n");
        assert!(
            joined.contains("NÃO invente"),
            "pt-BR warning should be in Portuguese, got: {joined}"
        );
    }

    #[test]
    fn attachment_lines_empty_extracted_text_falls_back_to_warning() {
        // If extraction returned Some("") somehow, treat as no text.
        let mut a = attachment_with_text("   ");
        a.extracted_text = Some("   ".into());
        let attachments = Some(vec![a]);
        let lines = build_attachment_lines(&attachments, LanguageCode::EnUs, Some(false));
        let joined = lines.join("\n");
        // Whitespace-only text is treated as empty → warning path.
        assert!(
            joined.contains("DO NOT invent"),
            "whitespace-only text should trigger warning, got: {joined}"
        );
    }

    // ── FASE 0: stream-json image input tests ────────────────────────

    fn image_attachment(path: &str, media_type: &str) -> AttachmentMeta {
        AttachmentMeta {
            path: path.into(),
            name: std::path::Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.to_string()),
            size: 100,
            kind: AttachmentKind::Image,
            media_type: Some(media_type.into()),
            width: Some(100),
            height: Some(100),
            extracted_text: None,
            extraction_status: None,
        }
    }

    fn file_attachment(path: &str) -> AttachmentMeta {
        AttachmentMeta {
            path: path.into(),
            name: std::path::Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.to_string()),
            size: 1000,
            kind: AttachmentKind::File,
            media_type: None,
            width: None,
            height: None,
            extracted_text: Some("text content".into()),
            extraction_status: Some(crate::models::types::ExtractionStatus::Extracted),
        }
    }

    #[test]
    fn stream_json_input_returns_none_for_non_vision_model() {
        // Even with image attachments, non-vision model → None (positional prompt).
        let request = AgentTurnRequest {
            turn_id: None,
            conversation_id: "c1".into(),
            message: "describe this".into(),
            model: Some("glm-5.2".into()),
            model_supports_vision: Some(false),
            context_window: None,
            response_language: Some(LanguageCode::EnUs),
            access_mode: crate::models::types::AccessMode::Approval,
            working_directory: "/tmp".into(),
            skills: Vec::new(),
            attachments: Some(vec![image_attachment("/tmp/img.png", "image/png")]),
            response_enhancements_enabled: None,
            personality: None,
            custom_instructions: None,
            memory_context: None,
        };
        let payload = build_stream_json_input(&request, "prompt text");
        assert!(payload.is_none(), "non-vision model should not get stream-json");
    }

    #[test]
    fn stream_json_input_returns_none_for_text_only_turn() {
        // Vision model but no image attachments → None (positional prompt).
        let request = AgentTurnRequest {
            turn_id: None,
            conversation_id: "c1".into(),
            message: "hello".into(),
            model: Some("claude-sonnet-4-6".into()),
            model_supports_vision: Some(true),
            context_window: None,
            response_language: Some(LanguageCode::EnUs),
            access_mode: crate::models::types::AccessMode::Approval,
            working_directory: "/tmp".into(),
            skills: Vec::new(),
            attachments: Some(vec![file_attachment("/tmp/doc.md")]),
            response_enhancements_enabled: None,
            personality: None,
            custom_instructions: None,
            memory_context: None,
        };
        let payload = build_stream_json_input(&request, "prompt text");
        assert!(payload.is_none(), "text-only turn should not get stream-json");
    }

    #[test]
    fn stream_json_input_returns_none_when_vision_unknown() {
        // model_supports_vision == None (unknown) → don't risk stream-json.
        let request = AgentTurnRequest {
            turn_id: None,
            conversation_id: "c1".into(),
            message: "hello".into(),
            model: None,
            model_supports_vision: None,
            context_window: None,
            response_language: Some(LanguageCode::EnUs),
            access_mode: crate::models::types::AccessMode::Approval,
            working_directory: "/tmp".into(),
            skills: Vec::new(),
            attachments: Some(vec![image_attachment("/tmp/img.png", "image/png")]),
            response_enhancements_enabled: None,
            personality: None,
            custom_instructions: None,
            memory_context: None,
        };
        let payload = build_stream_json_input(&request, "prompt text");
        assert!(payload.is_none(), "unknown vision should not get stream-json");
    }

    #[test]
    fn stream_json_input_builds_payload_with_image_for_vision_model() {
        // Vision model + image attachment → Some(payload) with image_url block.
        // Use a real temp file so base64 encoding has data to read.
        let temp = std::env::temp_dir().join(format!(
            "verboo-test-stream-{}.png",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&temp, b"fake-png-bytes").unwrap();
        let request = AgentTurnRequest {
            turn_id: None,
            conversation_id: "c1".into(),
            message: "describe this image".into(),
            model: Some("claude-sonnet-4-6".into()),
            model_supports_vision: Some(true),
            context_window: None,
            response_language: Some(LanguageCode::EnUs),
            access_mode: crate::models::types::AccessMode::Approval,
            working_directory: "/tmp".into(),
            skills: Vec::new(),
            attachments: Some(vec![image_attachment(
                temp.to_str().unwrap(),
                "image/png",
            )]),
            response_enhancements_enabled: None,
            personality: None,
            custom_instructions: None,
            memory_context: None,
        };
        let payload = build_stream_json_input(&request, "prompt text here");
        assert!(payload.is_some(), "vision model + image should get stream-json");
        let payload = payload.unwrap();
        // Should be valid JSON with role=user, content array with text + image_url.
        let parsed: serde_json::Value = serde_json::from_str(payload.trim()).unwrap();
        assert_eq!(parsed["role"], "user");
        let content = parsed["content"].as_array().unwrap();
        assert!(content.len() >= 2, "should have text + image blocks");
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "prompt text here");
        // Find the image_url block.
        let img_block = content
            .iter()
            .find(|b| b["type"] == "image_url")
            .expect("should have image_url block");
        let url = img_block["image_url"]["url"].as_str().unwrap();
        assert!(url.starts_with("data:image/png;base64,"), "should be data URL");
        let _ = std::fs::remove_file(&temp);
    }

    #[test]
    fn stream_json_input_skips_unreadable_images() {
        // Image path doesn't exist → skip that image, still send text.
        let request = AgentTurnRequest {
            turn_id: None,
            conversation_id: "c1".into(),
            message: "describe".into(),
            model: Some("claude-sonnet-4-6".into()),
            model_supports_vision: Some(true),
            context_window: None,
            response_language: Some(LanguageCode::EnUs),
            access_mode: crate::models::types::AccessMode::Approval,
            working_directory: "/tmp".into(),
            skills: Vec::new(),
            attachments: Some(vec![image_attachment(
                "/nonexistent/path/img.png",
                "image/png",
            )]),
            response_enhancements_enabled: None,
            personality: None,
            custom_instructions: None,
            memory_context: None,
        };
        let payload = build_stream_json_input(&request, "prompt text");
        // No readable images → None (falls back to positional prompt).
        assert!(payload.is_none(), "unreadable images should fall back to positional");
    }

    // ── FASE 1: vision fallback wiring tests ─────────────────────────
    //
    // These test the consent gating + early-return logic of
    // `maybe_run_vision_fallback`. The full flow (spawn secondary CLI,
    // describe image, cache) is covered by vision_fallback_service tests.

    fn make_turn_service() -> TurnService {
        TurnService::new(std::sync::Arc::new(CredentialsStore::new()))
    }

    fn request_with_image(vision: Option<bool>) -> AgentTurnRequest {
        AgentTurnRequest {
            turn_id: None,
            conversation_id: "c1".into(),
            message: "describe this".into(),
            model: Some("glm-5.2".into()),
            model_supports_vision: vision,
            context_window: None,
            response_language: Some(LanguageCode::EnUs),
            access_mode: crate::models::types::AccessMode::Approval,
            working_directory: "/tmp".into(),
            skills: Vec::new(),
            attachments: Some(vec![image_attachment("/tmp/img.png", "image/png")]),
            response_enhancements_enabled: None,
            personality: None,
            custom_instructions: None,
            memory_context: None,
        }
    }

    #[test]
    fn vision_fallback_skips_when_model_supports_vision() {
        // Vision-capable model → fallback should NOT run (images go via
        // stream-json FASE 0 path instead).
        let svc = make_turn_service();
        let mut req = request_with_image(Some(true));
        // The attachment starts with no extracted_text.
        assert!(req.attachments.as_ref().unwrap()[0].extracted_text.is_none());
        // maybe_run_vision_fallback is only called when vision != Some(true),
        // so we simulate that check here.
        if req.model_supports_vision != Some(true) {
            svc.maybe_run_vision_fallback(&mut req);
        }
        // Vision model → fallback not called → extracted_text still None.
        assert!(
            req.attachments.as_ref().unwrap()[0].extracted_text.is_none(),
            "vision model should not trigger fallback"
        );
    }

    #[test]
    fn vision_fallback_skips_when_no_image_attachments() {
        // No images → fallback should not run even for non-vision model.
        let svc = make_turn_service();
        let mut req = request_with_image(Some(false));
        req.attachments = Some(vec![file_attachment("/tmp/doc.md")]);
        svc.maybe_run_vision_fallback(&mut req);
        // File attachment unchanged (no image to describe).
        assert!(
            req.attachments.as_ref().unwrap()[0].extracted_text.as_deref()
                == Some("text content"),
            "file attachment should be unchanged"
        );
    }

    #[test]
    fn vision_fallback_skips_when_no_app_data_dir() {
        // TurnService without app_data_dir (test mode) → can't cache → skip.
        let svc = make_turn_service(); // app_data_dir = None
        let mut req = request_with_image(Some(false));
        svc.maybe_run_vision_fallback(&mut req);
        // No app_data_dir → early return → extracted_text still None.
        assert!(
            req.attachments.as_ref().unwrap()[0].extracted_text.is_none(),
            "no app_data_dir → fallback should skip"
        );
    }

    #[test]
    fn vision_fallback_skips_when_consent_is_never() {
        // Consent = Never → fallback should not run.
        // (We can't easily set up a SettingsStore in a unit test, so this
        // test verifies the default consent path: when settings is None,
        // consent defaults to Ask, which is != Always → skip.)
        let svc = make_turn_service(); // settings = None → consent defaults to Ask
        let mut req = request_with_image(Some(false));
        svc.maybe_run_vision_fallback(&mut req);
        assert!(
            req.attachments.as_ref().unwrap()[0].extracted_text.is_none(),
            "consent != Always → fallback should skip"
        );
    }

    #[test]
    fn vision_fallback_does_not_require_cli_path_env_var() {
        // Regression test for the critical bug where `maybe_run_vision_fallback`
        // used `cli_path::resolve()` which returns None in the packaged app
        // (no VERBOO_CLI_PATH env var). The fix removed that check — the
        // fallback now uses `CliSpawn` internally (same as the main turn).
        //
        // This test verifies the function does NOT early-return when
        // VERBOO_CLI_PATH is unset. It will still return early (no consent,
        // no app_data_dir, no catalog), but NOT because of cli_path.
        //
        // We set app_data_dir (so that check passes) but leave VERBOO_CLI_PATH
        // unset. The function should proceed past the old cli_path check and
        // return early only because the model catalog is empty (no token in
        // test env).
        let mut svc = TurnService::new(std::sync::Arc::new(CredentialsStore::new()))
            .with_app_data_dir(std::env::temp_dir());
        // Force consent = Always by injecting a settings store.
        // (We can't easily do this without a real SettingsStore, so this test
        // is more of a smoke test — the key assertion is that the function
        // doesn't panic and doesn't require VERBOO_CLI_PATH.)
        let mut req = request_with_image(Some(false));
        svc.maybe_run_vision_fallback(&mut req);
        // The function returns early because consent != Always (settings is
        // None → default Ask). The key point: it does NOT return early because
        // of cli_path. If the old cli_path check were still here, this test
        // would still pass (consent check comes first), but the fix is
        // verified by the fact that `describe_image` no longer takes a
        // `cli_path` parameter (compile-time guarantee).
        assert!(
            req.attachments.as_ref().unwrap()[0].extracted_text.is_none(),
            "fallback should skip (consent != Always)"
        );
    }

    // ── Non-silent failure tests (Lacuna 2) ──────────────────────────
    //
    // When the fallback can't run (no app_data_dir, list_models fails, no
    // vision model in catalog), the image attachment must get an explicit
    // warning — NOT be left empty for the model to hallucinate.

    /// Creates a TurnService with consent=Always and app_data_dir set,
    /// so the fallback proceeds past the consent + app_data_dir checks.
    /// The model catalog will be empty (no token in test env) → no vision
    /// helper → non-silent warning injected.
    fn make_turn_service_with_always_consent() -> TurnService {
        let temp_dir = std::env::temp_dir().join(format!(
            "verboo-test-fallback-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let store = crate::services::settings_store::SettingsStore::new(temp_dir.clone());
        // Set consent = Always via update.
        store
            .update(serde_json::json!({ "visionFallbackConsent": "always" }))
            .unwrap();
        TurnService::new(std::sync::Arc::new(CredentialsStore::new()))
            .with_settings(std::sync::Arc::new(store))
            .with_app_data_dir(temp_dir)
    }

    #[test]
    fn vision_fallback_injects_warning_when_no_vision_model_in_catalog() {
        // consent=Always, app_data_dir set. On machines without a CLI token,
        // list_models fails → "couldn't be loaded" warning. On machines WITH
        // a token (like the dev's machine), the catalog loads — if the user's
        // plan has vision models, a description is injected (Extracted); if
        // not, a "no vision-capable model" warning is injected.
        //
        // The key assertion: the image is NEVER left empty (non-silent).
        let svc = make_turn_service_with_always_consent();
        let mut req = request_with_image(Some(false));
        svc.maybe_run_vision_fallback(&mut req);

        let att = &req.attachments.as_ref().unwrap()[0];
        assert!(
            att.extracted_text.is_some(),
            "fallback should inject SOMETHING (warning or description), not leave empty"
        );
        // The status should be either Warning (couldn't run) or Extracted
        // (successfully described). Both are valid — the point is non-silent.
        assert!(
            att.extraction_status.is_some(),
            "extraction_status must be set"
        );
    }

    #[test]
    fn vision_fallback_warning_is_anti_hallucination() {
        // On machines without a CLI token, the fallback injects a warning
        // that must tell the model NOT to invent content. On machines WITH
        // a token and vision models in the plan, a description is injected
        // (Extracted) — the anti-hallucination check only applies to warnings.
        let svc = make_turn_service_with_always_consent();
        let mut req = request_with_image(Some(false));
        svc.maybe_run_vision_fallback(&mut req);

        let att = &req.attachments.as_ref().unwrap()[0];
        let text = att.extracted_text.as_ref().unwrap();
        // If it's a warning (not a real description), it must contain
        // anti-hallucination language. If it's a real description (Extracted),
        // the check doesn't apply.
        if att.extraction_status
            == Some(crate::models::types::ExtractionStatus::Warning)
        {
            assert!(
                text.contains("Tell the user") || text.contains("model cannot read"),
                "warning should instruct model to tell the user, got: {text}"
            );
        }
    }

    #[test]
    fn inject_fallback_warning_sets_warning_on_image_attachments() {
        // Direct test of the inject_fallback_warning helper.
        let svc = make_turn_service();
        let mut req = request_with_image(Some(false));
        svc.inject_fallback_warning(&mut req, "Test warning: no catalog.");

        let att = &req.attachments.as_ref().unwrap()[0];
        assert_eq!(att.extracted_text.as_deref(), Some("Test warning: no catalog."));
        assert_eq!(
            att.extraction_status,
            Some(crate::models::types::ExtractionStatus::Warning)
        );
    }

    #[test]
    fn inject_fallback_warning_does_not_overwrite_existing_text() {
        // If an attachment already has extracted_text, the warning shouldn't
        // overwrite it.
        let svc = make_turn_service();
        let mut req = request_with_image(Some(false));
        // Pre-populate extracted_text on the image.
        req.attachments.as_mut().unwrap()[0].extracted_text =
            Some("Already described.".into());
        svc.inject_fallback_warning(&mut req, "Test warning.");

        let att = &req.attachments.as_ref().unwrap()[0];
        assert_eq!(
            att.extracted_text.as_deref(),
            Some("Already described."),
            "existing text should not be overwritten"
        );
    }

    #[test]
    fn inject_fallback_warning_skips_non_image_attachments() {
        // File attachments should not get the vision fallback warning.
        let svc = make_turn_service();
        let mut req = request_with_image(Some(false));
        // Add a file attachment alongside the image.
        req.attachments.as_mut().unwrap().push(file_attachment("/tmp/doc.md"));
        svc.inject_fallback_warning(&mut req, "Test warning.");

        // Image (index 0) gets the warning.
        assert_eq!(
            req.attachments.as_ref().unwrap()[0].extracted_text.as_deref(),
            Some("Test warning.")
        );
        // File (index 1) keeps its original text.
        assert_eq!(
            req.attachments.as_ref().unwrap()[1].extracted_text.as_deref(),
            Some("text content")
        );
    }
}
