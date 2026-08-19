use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;

use tauri::{AppHandle, Emitter};

use crate::models::types::{
    access_mode_cli_args, AgentEvent, AgentResultSnapshot, AgentTurnRequest, AttachmentKind,
    AttachmentMeta, CliMediaCapabilities, EventType, LanguageCode, ModelReasoning, PersonalityMode,
    RuntimeActivity, RuntimeStatus, RuntimeStatusKind, UserSettings,
};
use crate::services::auth_token::{inject_api_key, resolve_token};
use crate::services::cli_subagent_transcript::CliSubagentTranscriptFollower;
use crate::services::credentials_store::CredentialsStore;
use crate::services::prevent_sleep::PreventSleepGuard;
use crate::services::settings_store::SettingsStore;
use crate::services::subagent_events::{
    child_updates_from_payload, native_parent_results, native_parent_signal, native_thread_id,
};

const AGENT_EVENT_CHANNEL: &str = "agent:event";

/// Transport contract for the bundled CLI 0.13.0. Image blocks are explicit;
/// video and audio must stay on the derived-media fallback until a versioned
/// adapter proves that those block types are supported.
pub(crate) fn bundled_cli_0_13_0_media_capabilities() -> CliMediaCapabilities {
    CliMediaCapabilities {
        image_blocks: true,
        video_blocks: false,
        audio_blocks: false,
    }
}

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

#[derive(Clone, Default)]
struct UpdateInstallGate {
    installing: Arc<Mutex<bool>>,
}

struct TurnRegistrationGuard<'a> {
    _guard: MutexGuard<'a, bool>,
}

pub(crate) struct UpdateInstallLease {
    gate: UpdateInstallGate,
}

pub(crate) enum UpdateInstallAdmission {
    Ready(UpdateInstallLease),
    Busy { active_turns: usize },
}

impl UpdateInstallLease {
    /// A successful updater install must keep rejecting new turns after the
    /// exit request is queued and until the operating system ends the process.
    pub(crate) fn keep_until_process_exit(self) {
        std::mem::forget(self);
    }
}

impl UpdateInstallGate {
    fn begin_turn_registration(&self) -> Result<TurnRegistrationGuard<'_>, String> {
        let guard = self
            .installing
            .lock()
            .map_err(|_| "update install gate is unavailable".to_string())?;
        if *guard {
            return Err("Uma atualização está sendo instalada; aguarde o app reiniciar".into());
        }
        Ok(TurnRegistrationGuard { _guard: guard })
    }

    fn begin_install(
        &self,
        active_count: impl FnOnce() -> Result<usize, String>,
    ) -> Result<UpdateInstallAdmission, String> {
        let mut installing = self
            .installing
            .lock()
            .map_err(|_| "update install gate is unavailable".to_string())?;
        if *installing {
            return Err("Uma atualização já está sendo instalada".into());
        }
        let active_turns = active_count()?;
        if active_turns > 0 {
            return Ok(UpdateInstallAdmission::Busy { active_turns });
        }
        *installing = true;
        Ok(UpdateInstallAdmission::Ready(UpdateInstallLease {
            gate: self.clone(),
        }))
    }
}

impl Drop for UpdateInstallLease {
    fn drop(&mut self) {
        if let Ok(mut installing) = self.gate.installing.lock() {
            *installing = false;
        }
    }
}

/// Auth: the API key (if stored) is injected via `OAUTH_TOKEN_FILE` env var
/// pointing at a 0600 temp file. This matches Electron's behavior of
/// "API key has precedence over OAuth token" (verbooCliService.ts:306) and
/// means the user never has to run `verboo auth login` — saving the key in
/// the app's credential store is enough.
pub struct TurnService {
    /// Active child processes keyed by turn_id, so `interrupt` can signal them.
    active: Arc<Mutex<std::collections::HashMap<String, ChildHandle>>>,
    /// Maps conversation_id → turn_id for precise interrupt. Without this,
    /// `interrupt(conversation_id)` had to guess which turn to kill (frágil
    /// fallback to "any active turn" could kill the wrong chat in multichat).
    /// Registered on `send_turn`, cleared on `Done`/`Error` in the reader
    /// thread.
    active_by_conversation: Arc<Mutex<std::collections::HashMap<String, String>>>,
    /// Serializes turn registration with the updater's final install/restart
    /// window so a healthy turn can never begin after the busy check.
    update_install_gate: UpdateInstallGate,
    credentials: Arc<CredentialsStore>,
    /// Optional settings store for reading `prevent_sleep_while_running`.
    /// When `None`, sleep prevention is disabled (used in tests).
    settings: Option<Arc<SettingsStore>>,
    /// App data dir for vision fallback cache. `None` in tests.
    app_data_dir: Option<std::path::PathBuf>,
    /// Cancellable media preparation jobs, keyed by conversation. `None` in
    /// focused service tests that do not configure an app-data directory.
    video_jobs: Option<crate::services::video::job::VideoJobRegistry>,
}

impl TurnService {
    pub fn new(credentials: Arc<CredentialsStore>) -> Self {
        Self {
            active: Arc::new(Mutex::new(std::collections::HashMap::new())),
            active_by_conversation: Arc::new(Mutex::new(std::collections::HashMap::new())),
            update_install_gate: UpdateInstallGate::default(),
            credentials,
            settings: None,
            app_data_dir: None,
            video_jobs: None,
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
        self.video_jobs = match crate::services::video::job::VideoJobRegistry::new(&dir) {
            Ok(registry) => Some(registry),
            Err(error) => {
                eprintln!("[verboo:video] unable to initialize job registry: {error}");
                None
            }
        };
        self.app_data_dir = Some(dir);
        self
    }

    /// Injects a registry in focused tests and is also available to the
    /// pipeline coordinator when it needs to share one registry explicitly.
    pub fn with_video_job_registry(
        mut self,
        registry: crate::services::video::job::VideoJobRegistry,
    ) -> Self {
        self.video_jobs = Some(registry);
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
    fn maybe_run_vision_fallback(
        &self,
        app: Option<&AppHandle>,
        turn_id: &str,
        request: &mut AgentTurnRequest,
    ) {
        // Only run when there are image attachments.
        let has_images = request
            .attachments
            .as_ref()
            .map(|list| {
                list.iter()
                    .any(|a| is_visual_attachment(a) && a.media_type.is_some())
            })
            .unwrap_or(false);
        if !has_images {
            return;
        }

        // Check consent from settings.
        //
        // Gate semantics (the FE pre-screens Ask consent and only attaches the
        // image once the user accepts `allowOnce` or `alwaysProceed`):
        //   - `Never`  → skip fallback. Image still reaches the model as a path
        //                and gets the "do not invent" warning if the model
        //                can't see it.
        //   - `Always` → run fallback unconditionally (user opted in globally).
        //   - `Ask`    → run fallback too. By the time we get here with image
        //                attachments still on the request, the FE has already
        //                shown the consent UI and the user accepted; otherwise
        //                the attach would have been stripped before send_turn.
        //
        // `request.run_vision_fallback` (optional FE override) takes priority
        // over consent when set: `Some(true)` always runs, `Some(false)`
        // always skips. Useful for one-off turns where the FE knows better
        // than the global setting (e.g. user clicked "describe once" on a
        // turn started under `Never`).
        let consent = self
            .settings
            .as_ref()
            .and_then(|s| s.get().ok())
            .map(|s| s.vision_fallback_consent)
            .unwrap_or_default();
        let should_run = match request.run_vision_fallback {
            Some(explicit) => explicit,
            None => consent != crate::models::types::VisionFallbackConsent::Never,
        };
        eprintln!(
            "[verboo:vision-fallback] consent={consent:?}, override={:?}, should_run={should_run}",
            request.run_vision_fallback
        );
        if !should_run {
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
        let model_service = crate::services::model_service::ModelService::new(app_data_dir.clone());
        let token = crate::services::auth_token::resolve_token(&self.credentials);
        let discovery = match model_service.list_models(token.as_deref(), false) {
            Ok(d) => d,
            Err(e) => {
                // Non-silent: list_models failed — tell the user why.
                eprintln!("[verboo:vision-fallback] list_models failed: {e}");
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

        let helper =
            match crate::services::vision_fallback_service::resolve_vision_helper(&discovery) {
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

        // Emit a single vision-relay activity so the FE shows ONE row like
        // "glm-5.2 → kimi-k2.7" while the helper describes the image.
        // The detail encodes primary+helper model ids/display names with a
        // pipe delimiter (ids never contain pipes). The FE parses this to
        // render the relay label. The image description text is NEVER put in
        // label/detail — it goes only into `extracted_text` for the prompt.
        // `app` is None in unit tests (no AppHandle available); the emit is
        // skipped there since tests check consent gating, not event emission.
        if let Some(app) = app {
            let primary_id = request.model.clone().unwrap_or_default();
            let primary_display = primary_id.clone();
            emit_event(
                app,
                AgentEvent {
                    event_type: EventType::Json,
                    turn_id: Some(turn_id.to_string()),
                    conversation_id: Some(request.conversation_id.clone()),
                    runtime_activity: Some(RuntimeActivity {
                        key: format!("{turn_id}:vision-relay"),
                        label: "vision-relay".to_string(),
                        detail: Some(format!(
                            "vision-relay|{primary_id}|{primary_display}|{}|{}",
                            helper.id, helper.display_name
                        )),
                        kind: "image".to_string(),
                        tool_use_id: None,
                        additions: None,
                        deletions: None,
                        diff_preview: None,
                        todos: None,
                    }),
                    ..Default::default()
                },
            );
        }

        // Pick a fallback helper (next-best vision model) so the per-image
        // describe call can retry once on a different model if the primary
        // helper fails. Deterministic: same sort criteria as
        // `resolve_vision_helper`, minus the primary.
        let fallback_helper = crate::services::vision_fallback_service::resolve_fallback_helper(
            &discovery, &helper.id,
        );
        if let Some(fb) = &fallback_helper {
            eprintln!(
                "[verboo:vision-fallback] fallback helper: {} ({})",
                fb.id, fb.display_name
            );
        }

        // Describe each image attachment and inject as extracted_text.
        // `describe_image` uses `CliSpawn` internally to acquire the active
        // signed CLI + app-managed Node runtime — same resolver as the main turn.
        //
        // Contract for the FE: once an attachment reaches this loop and
        // succeeds, its `extracted_text` is the authoritative image
        // description and `extraction_status == Extracted`. The renderer MUST
        // NOT overwrite it with OCR or any secondary text source — that would
        // discard the vision model's output and replace it with a noisier
        // signal. OCR is only a last-resort FE path when no vision helper was
        // available (`ExtractionStatus::Warning` from `inject_fallback_warning`
        // or a `None` `extracted_text`).
        if let Some(list) = request.attachments.as_mut() {
            for att in list.iter_mut() {
                if !is_visual_attachment(att) || att.media_type.is_none() {
                    continue;
                }
                let media_type = att.media_type.clone().unwrap_or_default();
                let path = std::path::PathBuf::from(&att.path);
                match crate::services::vision_fallback_service::describe_image_cached_with_retry(
                    &path,
                    &media_type,
                    &helper.id,
                    fallback_helper.as_ref().map(|m| m.id.as_str()),
                    &self.credentials,
                    &app_data_dir,
                ) {
                    Ok(description) => {
                        merge_vision_description(att, description);
                        att.extraction_status =
                            Some(crate::models::types::ExtractionStatus::Extracted);
                    }
                    Err(e) => {
                        // Non-silent: describe_image failed (timeout, spawn
                        // error, empty result) — inject explicit warning so
                        // the model tells the user instead of inventing.
                        eprintln!(
                            "[verboo:vision-fallback] describe_image failed for {}: {e}",
                            att.path
                        );
                        merge_vision_description(att, format!(
                            "[Vision fallback failed: {e}. \
                             The model cannot read this image. \
                             Tell the user the vision helper couldn't describe \
                             the image and suggest they try again, use a \
                             vision-capable model, or paste the content as text.]"
                        ));
                        att.extraction_status =
                            Some(crate::models::types::ExtractionStatus::Warning);
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
                if is_visual_attachment(att) && att.extracted_text.is_none() {
                    att.extracted_text = Some(warning.to_string());
                    att.extraction_status = Some(crate::models::types::ExtractionStatus::Warning);
                }
            }
        }
    }

    /// Runs the full video-understanding pipeline for the (single) video
    /// attachment before prompt construction: consent → route → cache →
    /// preparation → local ASR → renderer OCR → helper vision → one bounded
    /// consolidated `<video_context>` injected as `extracted_text`.
    ///
    /// Failures never invent content: any unrecoverable path injects an
    /// explicit warning so the model tells the user instead of hallucinating.
    #[allow(clippy::too_many_arguments)]
    fn maybe_run_video_pipeline(
        app: &AppHandle,
        turn_id: &str,
        request: &mut crate::models::types::AgentTurnRequest,
        settings: &Option<Arc<SettingsStore>>,
        credentials: &Arc<CredentialsStore>,
        app_data_dir: &Option<std::path::PathBuf>,
        video_jobs: &Option<crate::services::video::job::VideoJobRegistry>,
    ) -> bool {
        use crate::models::types::{
            ExtractionStatus, ModelMediaCapabilities, VideoFallbackConsent,
            VideoProgress, VideoProgressStage,
        };
        use crate::services::video::analyze::{
            consolidate_context, parse_sheet_response, sheet_prompt, ChannelResult,
            ConsolidationInput, PIPELINE_VERSION,
        };
        use crate::services::video::cache::{VideoCache, VideoCacheEntry, VideoCacheKeyInput};
        use crate::services::video::job::VideoOcrWaiters;
        use crate::services::video::router::{choose_video_route, VideoRoute};
        use crate::services::video::VideoWarning;
        use tauri::Manager;

        let Some(attachment_index) = request.attachments.as_ref().and_then(|list| {
            list.iter()
                .position(|a| a.kind == AttachmentKind::Video && a.video.is_some())
        }) else {
            return true;
        };

        let conversation_id = request.conversation_id.clone();
        let fail_attachment = |request: &mut crate::models::types::AgentTurnRequest,
                               message: String| {
            if let Some(att) = request
                .attachments
                .as_mut()
                .and_then(|list| list.get_mut(attachment_index))
            {
                att.extracted_text = Some(format!(
                    "[Video analysis unavailable: {message}. DO NOT invent the video's \
                     content. Tell the user the video could not be analyzed.]"
                ));
                att.extraction_status = Some(ExtractionStatus::Warning);
            }
        };

        // Consent: independent from image fallback. The FE pre-screens Ask;
        // reaching here with the attachment intact means consent was granted
        // unless the stored decision (or explicit override) says never.
        let consent = settings
            .as_ref()
            .and_then(|s| s.get().ok())
            .map(|s| s.video_fallback_consent)
            .unwrap_or_default();
        let should_run = match request.run_video_analysis {
            Some(explicit) => explicit,
            None => consent != VideoFallbackConsent::Never,
        };
        if !should_run {
            fail_attachment(
                request,
                "video analysis is disabled in Settings (consent: never)".to_string(),
            );
            return true;
        }

        let Some(app_data_dir) = app_data_dir.clone() else {
            fail_attachment(request, "app data directory unavailable".to_string());
            return true;
        };

        let (original_path, file_name, metadata) = {
            let Some(att) = request.attachments.as_ref().and_then(|a| a.get(attachment_index))
            else {
                fail_attachment(request, "attachment index out of range".to_string());
                return true;
            };
            let Some(video_meta) = att.video.clone() else {
                fail_attachment(request, "attachment has no video metadata".to_string());
                return true;
            };
            (
                std::path::PathBuf::from(&att.path),
                att.name.clone(),
                video_meta,
            )
        };

        let model_caps = request
            .media_capabilities
            .clone()
            .unwrap_or(ModelMediaCapabilities {
                image: false,
                video: false,
                audio: false,
                video_containers: Vec::new(),
                video_codecs: Vec::new(),
                accepts_hdr_video: false,
            });
        let cli_caps = request
            .cli_media_capabilities
            .clone()
            .unwrap_or_else(bundled_cli_0_13_0_media_capabilities);
        let toolchain = crate::services::video::router::detected_media_toolchain_capabilities();
        let route = choose_video_route(&model_caps, &cli_caps, &toolchain, &metadata);
        let route_label = match &route {
            VideoRoute::NativeOriginal => "native_original",
            VideoRoute::NativeSdrProxy { .. } => "native_sdr_proxy",
            VideoRoute::SampledFrames { .. } => "sampled_frames",
        };
        // When the selected model can see images, the sampled contact sheets
        // are attached directly to the main turn (the model looks at the
        // frames itself) instead of being narrated by a helper model. Models
        // without vision keep the helper-description fallback.
        let deliver_frames_directly = request.model_supports_vision == Some(true);
        let cache_route = if deliver_frames_directly {
            "sampled_frames_direct"
        } else {
            route_label
        };

        // The current bundled CLI has no video content-block serializer. The
        // native branches stay behind the capability gate as typed invariant
        // errors until a compatible transport adapter exists.
        if !matches!(route, VideoRoute::SampledFrames { .. }) {
            fail_attachment(
                request,
                "a native video route was selected but no CLI content-block \
                 serializer supports it yet"
                    .to_string(),
            );
            return true;
        }

        let asr_model_path =
            crate::services::video::transcribe::VideoTranscriberStore::new(&app_data_dir)
                .model_path();
        let asr_installed = asr_model_path
            .metadata()
            .map(|m| m.len() == crate::services::video::transcribe::WHISPER_BASE_BYTES)
            .unwrap_or(false);

        let job_id_placeholder = turn_id.to_string();
        let emit_stage = |job_id: &str, stage: VideoProgressStage| {
            emit_event(
                app,
                AgentEvent {
                    event_type: EventType::VideoProgress,
                    turn_id: Some(turn_id.to_string()),
                    conversation_id: Some(conversation_id.clone()),
                    video_progress: Some(VideoProgress {
                        job_id: job_id.to_string(),
                        turn_id: turn_id.to_string(),
                        stage,
                        completed_units: None,
                        total_units: None,
                    }),
                    ..Default::default()
                },
            );
        };
        emit_stage(&job_id_placeholder, VideoProgressStage::Validating);

        // Cache lookup covers every derived artifact for this exact
        // bytes/route/capabilities/ASR combination.
        let model_fingerprint = serde_json::to_string(&model_caps).unwrap_or_default();
        let cli_fingerprint = serde_json::to_string(&cli_caps).unwrap_or_default();
        let asr_hash = if asr_installed {
            crate::services::video::transcribe::WHISPER_BASE_SHA256
        } else {
            "absent"
        };
        let cache = VideoCache::new(&app_data_dir).ok();
        let cache_key = cache.as_ref().and_then(|_| {
            VideoCache::key_for_file(VideoCacheKeyInput {
                original: &original_path,
                pipeline_version: PIPELINE_VERSION,
                route: cache_route,
                model_capability_fingerprint: &model_fingerprint,
                cli_capability_fingerprint: &cli_fingerprint,
                asr_model_hash: asr_hash,
            })
            .ok()
        });
        if let (Some(cache), Some(key)) = (cache.as_ref(), cache_key.as_ref()) {
            if let Some(entry) = cache.read(key) {
                if deliver_frames_directly {
                    let sheet_paths = cache.cached_sheet_paths(key, &entry);
                    Self::attach_frame_images(request, attachment_index, &sheet_paths);
                }
                if let Some(att) = request
                    .attachments
                    .as_mut()
                    .and_then(|list| list.get_mut(attachment_index))
                {
                    att.extracted_text = Some(entry.description);
                    att.extraction_status = Some(ExtractionStatus::Extracted);
                }
                Self::emit_video_activity(
                    app,
                    turn_id,
                    &conversation_id,
                    route_label,
                    &metadata,
                    "cache",
                    &[],
                );
                return true;
            }
        }

        let Some(registry) = video_jobs.as_ref() else {
            fail_attachment(request, "video job registry unavailable".to_string());
            return true;
        };
        let job = match registry.start(&conversation_id) {
            Ok(job) => job,
            Err(error) => {
                fail_attachment(request, error);
                return true;
            }
        };
        let job_id = job.id().to_string();
        emit_stage(&job_id, VideoProgressStage::Preparing);

        let ffmpeg = match crate::services::video::prepare::bundled_ffmpeg_path() {
            Ok(path) => path,
            Err(error) => {
                fail_attachment(request, error);
                return true;
            }
        };
        let prepared = match crate::services::video::prepare::prepare_video(
            &job,
            &ffmpeg,
            &original_path,
            &metadata,
            &route,
            None,
        ) {
            Ok(prepared) => prepared,
            Err(error) => {
                fail_attachment(request, error);
                return true;
            }
        };
        let mut warnings: Vec<VideoWarning> = prepared.warnings.clone();

        // Local ASR — never downloads; a missing model is a recoverable
        // channel failure with an explicit warning.
        emit_stage(&job_id, VideoProgressStage::Transcribing);
        let speech: ChannelResult<crate::services::video::transcribe::AudioTranscript> =
            match (&prepared.audio_wav, asr_installed) {
                (None, _) => ChannelResult::Absent,
                (Some(_), false) => {
                    ChannelResult::Failed("local transcription model is not installed".to_string())
                }
                (Some(wav), true) => {
                    match crate::services::video::transcribe::bundled_whisper_path().and_then(
                        |whisper| {
                            crate::services::video::transcribe::transcribe_wav(
                                &job,
                                &whisper,
                                &asr_model_path,
                                wav,
                            )
                        },
                    ) {
                        Ok(transcript) => ChannelResult::Ready(transcript),
                        Err(error) => ChannelResult::Failed(error),
                    }
                }
            };
        if job.is_cancelled() {
            return false;
        }

        emit_stage(&job_id, VideoProgressStage::Analyzing);

        // OCR and helper vision are independent channels; run them in
        // parallel so wall-clock cost is max(ocr, vision), not the sum.
        let ocr_channel = || -> ChannelResult<Vec<crate::services::video::job::VideoOcrText>> {
            if prepared.ocr_frames.is_empty() {
                return ChannelResult::Absent;
            }
            let waiters = app.state::<VideoOcrWaiters>();
            let receiver = match waiters.register(&job_id) {
                Ok(receiver) => receiver,
                Err(error) => return ChannelResult::Failed(error),
            };
            let frames: Vec<serde_json::Value> = prepared
                .ocr_frames
                .iter()
                .map(|frame| {
                    serde_json::json!({
                        "timestampMs": frame.timestamp_ms,
                        "url": frame.path.to_string_lossy(),
                    })
                })
                .collect();
            use tauri::Emitter;
            if app
                .emit(
                    "video:ocr-request",
                    serde_json::json!({ "jobId": job_id, "frames": frames }),
                )
                .is_err()
            {
                waiters.release(&job_id);
                return ChannelResult::Failed("could not reach the renderer".to_string());
            }
            let mut receiver = receiver;
            // Scale the wait to the batch size so a broken OCR channel degrades
                // in seconds, not minutes: ~10s fixed + 3s per frame, capped at 180s.
                let ocr_wait_secs = (10 + 3 * prepared.ocr_frames.len() as u64).min(180);
                let deadline =
                    std::time::Instant::now() + std::time::Duration::from_secs(ocr_wait_secs);
            loop {
                if job.is_cancelled() {
                    waiters.release(&job_id);
                    return ChannelResult::Failed("cancelled".to_string());
                }
                match receiver.try_recv() {
                    Ok(results) => return ChannelResult::Ready(results),
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {
                        if std::time::Instant::now() >= deadline {
                            waiters.release(&job_id);
                            return ChannelResult::Failed("OCR timed out".to_string());
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                        waiters.release(&job_id);
                        return ChannelResult::Failed("OCR channel closed".to_string());
                    }
                }
            }
        };

        // Helper vision over labeled contact sheets — one call per sheet,
        // never per frame, reusing the image-fallback helper policy. Returns
        // the channel plus how many sheets failed (warned after the join).
        let vision_channel = || -> (
            ChannelResult<Vec<crate::services::video::analyze::VisionEntry>>,
            usize,
        ) {
            if prepared.contact_sheets.is_empty() {
                return (ChannelResult::Absent, 0);
            }
            let model_service =
                crate::services::model_service::ModelService::new(app_data_dir.clone());
            let token = crate::services::auth_token::resolve_token(credentials);
            let discovery = match model_service.list_models(token.as_deref(), false) {
                Ok(discovery) => discovery,
                Err(error) => return (ChannelResult::Failed(error), 0),
            };
            let Some(helper) =
                crate::services::vision_fallback_service::resolve_vision_helper(&discovery)
            else {
                return (
                    ChannelResult::Failed("no vision-capable helper model in the plan".to_string()),
                    0,
                );
            };
            let fallback = crate::services::vision_fallback_service::resolve_fallback_helper(
                &discovery, &helper.id,
            );
            let mut entries = Vec::new();
            let mut sheet_failures = 0usize;
            for sheet in &prepared.contact_sheets {
                if job.is_cancelled() {
                    return (ChannelResult::Failed("cancelled".to_string()), sheet_failures);
                }
                let prompt = sheet_prompt(&sheet.timestamps_ms);
                let response =
                    crate::services::vision_fallback_service::describe_image_once_with_prompt(
                        &sheet.path,
                        "image/png",
                        &prompt,
                        &helper.id,
                        credentials,
                    )
                    .or_else(|first_error| {
                        fallback
                            .as_ref()
                            .ok_or(first_error.clone())
                            .and_then(|fallback| {
                                crate::services::vision_fallback_service::describe_image_once_with_prompt(
                                    &sheet.path,
                                    "image/png",
                                    &prompt,
                                    &fallback.id,
                                    credentials,
                                )
                                .map_err(|second| format!("{first_error}; retry: {second}"))
                            })
                    });
                match response.and_then(|raw| parse_sheet_response(&raw)) {
                    Ok(mut sheet_entries) => entries.append(&mut sheet_entries),
                    Err(_) => sheet_failures += 1,
                }
            }
            if entries.is_empty() {
                return (
                    ChannelResult::Failed(format!(
                        "vision analysis failed on all {sheet_failures} contact sheets"
                    )),
                    sheet_failures,
                );
            }
            (ChannelResult::Ready(entries), sheet_failures)
        };

        let (ocr, (vision, failed_sheets)) = if deliver_frames_directly {
            // The main model will look at the attached frames itself; no
            // helper narration is needed. OCR still runs for exact text.
            (ocr_channel(), (ChannelResult::Absent, 0))
        } else {
            std::thread::scope(|scope| {
                let vision_handle = scope.spawn(vision_channel);
                let ocr = ocr_channel();
                let vision = vision_handle.join().unwrap_or((
                    ChannelResult::Failed("vision analysis thread panicked".to_string()),
                    0,
                ));
                (ocr, vision)
            })
        };
        // The OCR channel is best-effort redundancy on top of the vision
        // channel; when it fails (e.g. the bundled worker cannot start) the
        // failure is recorded in the Worked for diagnostics only — the model
        // must not narrate "OCR timed out" to the user.
        let ocr_failed = matches!(ocr, ChannelResult::Failed(_));
        let ocr = if ocr_failed { ChannelResult::Absent } else { ocr };
        if failed_sheets > 0 && matches!(vision, ChannelResult::Ready(_)) {
            warnings.push(VideoWarning::new(
                "vision_sheets_partial",
                format!("{failed_sheets} contact sheet(s) could not be analyzed"),
            ));
        }

        if job.is_cancelled() {
            return false;
        }
        emit_stage(&job_id, VideoProgressStage::Consolidating);

        let transcript_text = speech
            .ready()
            .map(|transcript| {
                transcript
                    .segments
                    .iter()
                    .map(|segment| segment.text.clone())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        let ocr_texts: Vec<String> = ocr
            .ready()
            .map(|items| items.iter().map(|item| item.text.clone()).collect())
            .unwrap_or_default();
        let asr_language = speech
            .ready()
            .and_then(|transcript| transcript.language.clone());
        let frame_count = prepared.visual_frames.len();
        let ocr_frame_count = prepared.ocr_frames.len();

        let consolidated = consolidate_context(ConsolidationInput {
            file_name: &file_name,
            duration_ms: metadata.duration_ms,
            route: route_label,
            vision,
            ocr,
            speech,
            warnings: warnings.clone(),
        });
        // With direct frame delivery an empty audio/OCR result is not a
        // failure — the attached images are the primary channel.
        let consolidated = match consolidated {
            Ok(context) if deliver_frames_directly => Ok(context.replacen(
                "</video_context>",
                "Frames: labeled contact-sheet images from this video are \
                 attached to this message; read timestamps from the labels.\n</video_context>",
                1,
            )),
            Err(_) if deliver_frames_directly => Ok(format!(
                "<video_context name=\"{}\" duration_ms=\"{}\" route=\"sampled_frames\">\n\
                 Frames: labeled contact-sheet images from this video are \
                 attached to this message; read timestamps from the labels.\n\
                 </video_context>",
                crate::services::video::analyze::sanitize(&file_name).replace('"', "&quot;"),
                metadata.duration_ms,
            )),
            other => other,
        };
        match consolidated {
            Ok(context) => {
                let sheet_sources: Vec<std::path::PathBuf> = prepared
                    .contact_sheets
                    .iter()
                    .map(|sheet| sheet.path.clone())
                    .collect();
                let mut cached_sheet_paths: Vec<std::path::PathBuf> = Vec::new();
                if let (Some(cache), Some(key)) = (cache.as_ref(), cache_key.as_ref()) {
                    let mut entry =
                        VideoCacheEntry::new(context.clone(), transcript_text, ocr_texts);
                    if deliver_frames_directly {
                        entry.contact_sheets = prepared
                            .contact_sheets
                            .iter()
                            .map(|sheet| crate::services::video::cache::CachedContactSheet {
                                timestamps_ms: sheet.timestamps_ms.clone(),
                                file_name: String::new(),
                            })
                            .collect();
                        if cache.write(key, &entry, &sheet_sources).is_ok() {
                            cached_sheet_paths = (0..sheet_sources.len())
                                .map(|index| cache.sheet_dir(key).join(format!("sheet-{index}.png")))
                                .filter(|path| path.is_file())
                                .collect();
                        }
                    } else {
                        let _ = cache.write(key, &entry, &[]);
                    }
                }
                if deliver_frames_directly {
                    // Fall back to a prunable scratch copy when the cache is
                    // unavailable — the job directory dies with the job.
                    if cached_sheet_paths.is_empty() && !sheet_sources.is_empty() {
                        let scratch = app_data_dir
                            .join("video_jobs")
                            .join(uuid::Uuid::new_v4().to_string());
                        if std::fs::create_dir_all(&scratch).is_ok() {
                            for (index, source) in sheet_sources.iter().enumerate() {
                                let destination = scratch.join(format!("sheet-{index}.png"));
                                if std::fs::copy(source, &destination).is_ok() {
                                    cached_sheet_paths.push(destination);
                                }
                            }
                        }
                    }
                    Self::attach_frame_images(request, attachment_index, &cached_sheet_paths);
                }
                if let Some(att) = request
                    .attachments
                    .as_mut()
                    .and_then(|list| list.get_mut(attachment_index))
                {
                    att.extracted_text = Some(context);
                    att.extraction_status = Some(ExtractionStatus::Extracted);
                }
                let delivery = if deliver_frames_directly {
                    "frames"
                } else {
                    "description"
                };
                let ocr_state = if ocr_failed { "failed-silenced" } else { "ok" };
                let detail = format!(
                    "route={route_label} delivery={delivery} ocr={ocr_state} duration_ms={} frames={frame_count} \
                     ocr_frames={ocr_frame_count} language={} warnings={}",
                    metadata.duration_ms,
                    asr_language.as_deref().unwrap_or("-"),
                    warnings.len(),
                );
                Self::emit_video_activity(
                    app,
                    turn_id,
                    &conversation_id,
                    route_label,
                    &metadata,
                    &detail,
                    &warnings,
                );
            }
            Err(error) => fail_attachment(request, error),
        }
        let _ = job.finish();
        true
    }

    /// Appends contact-sheet PNGs as image attachments right after the video
    /// attachment so a vision-capable main model sees the frames directly.
    fn attach_frame_images(
        request: &mut crate::models::types::AgentTurnRequest,
        attachment_index: usize,
        sheet_paths: &[std::path::PathBuf],
    ) {
        let Some(list) = request.attachments.as_mut() else {
            return;
        };
        for (offset, path) in sheet_paths.iter().enumerate() {
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            let attachment = crate::models::types::AttachmentMeta {
                path: path.to_string_lossy().to_string(),
                name: format!("video-frames-{}.png", offset + 1),
                size,
                kind: AttachmentKind::Image,
                media_type: Some("image/png".to_string()),
                width: None,
                height: None,
                extracted_text: None,
                extraction_status: None,
                video: None,
            };
            let insert_at = (attachment_index + 1 + offset).min(list.len());
            list.insert(insert_at, attachment);
        }
    }

    /// One ordinary RuntimeActivity (kind `video`) rendered only inside
    /// Worked for.
    fn emit_video_activity(
        app: &AppHandle,
        turn_id: &str,
        conversation_id: &str,
        route_label: &str,
        metadata: &crate::models::types::VideoStreamMetadata,
        detail: &str,
        warnings: &[crate::services::video::VideoWarning],
    ) {
        let warning_suffix = if warnings.is_empty() {
            String::new()
        } else {
            format!(
                " | warnings: {}",
                warnings
                    .iter()
                    .map(|warning| warning.code.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        emit_event(
            app,
            AgentEvent {
                event_type: EventType::Json,
                turn_id: Some(turn_id.to_string()),
                conversation_id: Some(conversation_id.to_string()),
                runtime_activity: Some(RuntimeActivity {
                    key: format!("{turn_id}:video-analysis"),
                    label: "video-analysis".to_string(),
                    detail: Some(format!(
                        "{detail} | container={} codec={}{warning_suffix}",
                        metadata.container, metadata.video_codec
                    )),
                    kind: "video".to_string(),
                    tool_use_id: None,
                    additions: None,
                    deletions: None,
                    diff_preview: None,
                    todos: None,
                }),
                ..Default::default()
            },
        );
        let _ = route_label;
    }

    /// Spawn an agent turn. Returns the turn_id (existing or newly generated).
    /// Emits `agent:event` events to the renderer as the CLI produces output.
    ///
    /// CRITICAL: This method must return IMMEDIATELY after emitting `Started`.
    /// All heavy work (vision fallback, prompt building, base64 encoding, CLI
    /// spawn, stdout reading) runs on a background `std::thread`. The Tauri
    /// command thread is synchronous — blocking it for 30s during
    /// `describe_image` freezes the macOS UI (rainbow beachball).
    pub fn send_turn(
        &self,
        app: AppHandle,
        request: AgentTurnRequest,
        resume_session_id: Option<String>,
    ) -> Result<String, String> {
        let registration = self.update_install_gate.begin_turn_registration()?;
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
                message: None,
                exit_code: None,
                runtime_status: None,
                runtime_activity: None,
                subagent_thread: None,
                video_progress: None,
            },
        );

        // Clone all Arc fields so the background thread owns them without
        // borrowing `&self`. AppHandle is Clone. request is moved.
        let active = self.active.clone();
        let active_by_conversation = self.active_by_conversation.clone();
        let credentials = self.credentials.clone();
        let settings = self.settings.clone();
        let app_data_dir = self.app_data_dir.clone();
        let video_jobs = self.video_jobs.clone();
        let app_for_thread = app.clone();
        let turn_id_for_thread = turn_id.clone();
        let conversation_id_for_thread = conversation_id.clone();

        // Register conversation_id → turn_id for precise interrupt. This
        // replaces the old fragile fallback ("any active turn") that could
        // kill the wrong chat in multichat. Cleared on Done/Error in the
        // reader thread.
        active_by_conversation
            .lock()
            .map_err(|_| "active conversation registry is unavailable".to_string())?
            .insert(conversation_id.clone(), turn_id.clone());

        // Spawn a background thread for ALL heavy work. This is the structural
        // fix for the beachball freeze: the Tauri command thread returns
        // immediately, and vision fallback / CLI spawn / base64 encoding /
        // stdout reading all happen off the main thread.
        //
        // Cross-platform: std::thread + std::process::Command work on macOS,
        // Windows, and Linux without any platform-specific code here. The
        // Windows process group is set inside the CLI spawn via
        // `creation_flags` (see below). Interrupt via `child_signal` works
        // on all three (SIGINT on Unix, GenerateConsoleCtrlEvent on Windows).
        let builder = std::thread::Builder::new().name(format!("verboo-turn-{turn_id}"));
        let active_by_conversation_for_thread = active_by_conversation.clone();
        let spawn_result = builder
            .spawn(move || {
                Self::run_turn_background(
                    app_for_thread,
                    request,
                    resume_session_id,
                    turn_id_for_thread,
                    conversation_id_for_thread,
                    active,
                    active_by_conversation_for_thread,
                    credentials,
                    settings,
                    app_data_dir,
                    video_jobs,
                );
            });
        drop(registration);
        if let Err(error) = spawn_result {
            if let Ok(mut map) = active_by_conversation.lock() {
                if map.get(&conversation_id) == Some(&turn_id) {
                    map.remove(&conversation_id);
                }
            }
            return Err(format!("Falha ao iniciar thread do turn: {error}"));
        }

        Ok(turn_id)
    }

    /// Background worker for a single turn. Runs on a dedicated
    /// `std::thread` (never the Tauri command thread) so blocking I/O
    /// (vision fallback, CLI spawn, base64 encoding) can't freeze the UI.
    fn run_turn_background(
        app: AppHandle,
        mut request: AgentTurnRequest,
        resume_session_id: Option<String>,
        turn_id: String,
        conversation_id: String,
        active: Arc<Mutex<std::collections::HashMap<String, ChildHandle>>>,
        active_by_conversation: Arc<Mutex<std::collections::HashMap<String, String>>>,
        credentials: Arc<CredentialsStore>,
        settings: Option<Arc<SettingsStore>>,
        app_data_dir: Option<std::path::PathBuf>,
        video_jobs: Option<crate::services::video::job::VideoJobRegistry>,
    ) {
        // Set the turn_id on the request so downstream code can reference it.
        request.turn_id = Some(turn_id.clone());

        // Video understanding runs before any prompt construction so the
        // consolidated `<video_context>` reaches build_attachment_lines like
        // any other extracted text. Runs on this background thread only.
        let video_pipeline_continues = Self::maybe_run_video_pipeline(
            &app,
            &turn_id,
            &mut request,
            &settings,
            &credentials,
            &app_data_dir,
            &video_jobs,
        );
        if !video_pipeline_continues {
            // The user cancelled during media preparation: end the whole turn
            // before any CLI is spawned, mirroring an interrupted CLI turn.
            if let Ok(mut map) = active_by_conversation.lock() {
                if map.get(&conversation_id) == Some(&turn_id) {
                    map.remove(&conversation_id);
                }
            }
            emit_event(
                &app,
                AgentEvent {
                    event_type: EventType::Done,
                    turn_id: Some(turn_id.clone()),
                    conversation_id: Some(conversation_id.clone()),
                    exit_code: Some(130),
                    ..Default::default()
                },
            );
            return;
        }

        // FASE 1: vision fallback. When the selected model doesn't support
        // vision but the user attached images, spawn a secondary CLI with a
        // vision-capable model (from the user's own catalog — never hardcoded)
        // to describe each image. Descriptions are injected as `extracted_text`
        // so `build_attachment_lines` includes them in the prompt as text.
        //
        // Consent gates this (see `maybe_run_vision_fallback` for full rules):
        // - 'always': run the fallback without asking.
        // - 'never': skip (images get the "DO NOT invent" warning).
        // - 'ask': run too. The FE pre-screens Ask consent and only keeps
        //   image attachments on the request after the user accepts
        //   `allowOnce` or `alwaysProceed`, so reaching here with images
        //   means consent was granted for this turn.
        // - `request.run_vision_fallback` (when present) overrides consent.
        //
        // This runs on the background thread, NOT the Tauri command thread,
        // so the 30s timeout (x2 with retry) doesn't freeze the UI.
        if request.model_supports_vision != Some(true) {
            // Build a temporary TurnService view for the fallback — it only
            // needs credentials, settings, app_data_dir, and active (for
            // registering the helper child so interrupt can kill it).
            let fallback_svc = TurnService {
                active: active.clone(),
                active_by_conversation: active_by_conversation.clone(),
                update_install_gate: UpdateInstallGate::default(),
                credentials: credentials.clone(),
                settings: settings.clone(),
                app_data_dir: app_data_dir.clone(),
                video_jobs: None,
            };
            fallback_svc.maybe_run_vision_fallback(Some(&app), &turn_id, &mut request);
        }

        let prompt = build_prompt(&request, resume_session_id.is_some());

        // FASE 0: when the model supports vision AND there are image
        // attachments, switch to stream-json input so images reach the model
        // as base64 (not just text paths). Text-only turns keep the
        // positional prompt path (lower risk, no stdin piping needed).
        let stream_json_payload = build_stream_json_input(&request, &prompt);
        let use_stream_json = stream_json_payload.is_some();

        let resume_id = resume_session_id.clone();
        let args = build_cli_args(&request, &prompt, resume_id.as_deref(), use_stream_json);

        let working_directory = safe_runtime_working_directory(
            &request.working_directory,
            app_data_dir.as_deref(),
        );
        let token = resolve_token(&credentials);
        let injected_oauth_token = token
            .as_deref()
            .filter(|value| !value.trim().is_empty() && !value.trim().starts_with("vbk_"))
            .map(str::to_string);

        let sleep_guard = match settings.as_ref() {
            Some(store) => store
                .get()
                .map(|settings| PreventSleepGuard::start(&settings))
                .unwrap_or_else(|_| PreventSleepGuard::start(&UserSettings::default())),
            None => PreventSleepGuard::start(&UserSettings::default()),
        };

        let spawn = crate::services::cli_spawn::CliSpawn::new(&args);
        let runtime_label = spawn.runtime.to_string();
        let working_dir_label = working_directory.clone();
        let mut cmd = spawn.command;
        cmd.current_dir(&working_directory)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if use_stream_json {
            cmd.stdin(Stdio::piped());
        } else {
            cmd.stdin(Stdio::null());
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(crate::services::child_signal::process_creation_flags());
        }
        let _token_file = inject_api_key(token.as_deref(), &mut cmd);
        crate::services::auth_token::augment_identity_env(&mut cmd);

        // Effort transport: inject `CLAUDE_CODE_EFFORT_LEVEL=<level>` for
        // valid overrides only. The CLI 0.12 validates this env value
        // dynamically against the model's `reasoning.effortLevels`, so any
        // router level (including "none" and future levels) flows through.
        // We never pass `--effort` because its static allowlist rejects
        // "none" and unknown levels. Absent/stale override → env not set →
        // CLI applies the model's `default_effort`.
        if let Some(level) =
            resolve_effort_arg(request.effort.as_deref(), request.reasoning.as_ref())
        {
            cmd.env("CLAUDE_CODE_EFFORT_LEVEL", level);
        }

        // Wire the user's context window setting into the CLI's auto-compact
        // logic. The CLI honors `CLAUDE_CODE_AUTO_COMPACT_WINDOW` as the
        // effective context window size (min of model window and this value).
        //
        // We do NOT set `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` anymore. The CLI's
        // default threshold is `effectiveWindow - 13000 (AUTOCOMPACT_BUFFER)`,
        // which is more conservative than a fixed 90%. With small user windows
        // (e.g. 20k), 90% of effective = ~10.8k, but the meter divides by the
        // raw window (20k) → compact fires at ~55% visual, confusing the user.
        // The default threshold avoids this visual mismatch.
        //
        // We only set the window when the user's value is reasonably large
        // (>= 40000). Below that, the CLI's own model default is safer —
        // setting a tiny window makes the effective window go negative after
        // the 13k buffer, causing double-compacts every turn.
        if let Some(context_window) = request.context_window {
            if context_window >= 40_000 {
                cmd.env(
                    "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
                    context_window.to_string(),
                );
            }
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                emit_event(
                    &app,
                    AgentEvent {
                        event_type: EventType::Error,
                        turn_id: Some(turn_id.clone()),
                        conversation_id: Some(conversation_id.clone()),
                        message: Some(format!("Falha ao iniciar CLI Verboo: {e}")),
                        ..Default::default()
                    },
                );
                return;
            }
        };

        let child_id = child.id();

        if let Some(payload) = stream_json_payload {
            if let Some(stdin) = child.stdin.take() {
                use std::io::Write;
                let mut stdin = stdin;
                if let Err(e) = stdin.write_all(payload.as_bytes()) {
                    emit_event(
                        &app,
                        AgentEvent {
                            event_type: EventType::Error,
                            turn_id: Some(turn_id.clone()),
                            conversation_id: Some(conversation_id.clone()),
                            message: Some(format!("Falha ao enviar prompt via stdin: {e}")),
                            ..Default::default()
                        },
                    );
                    return;
                }
                if let Err(e) = stdin.flush() {
                    emit_event(
                        &app,
                        AgentEvent {
                            event_type: EventType::Error,
                            turn_id: Some(turn_id.clone()),
                            conversation_id: Some(conversation_id.clone()),
                            message: Some(format!("Falha ao finalizar envio via stdin: {e}")),
                            ..Default::default()
                        },
                    );
                    return;
                }
            }
        }

        let stdout = match child.stdout.take() {
            Some(s) => s,
            None => {
                emit_event(
                    &app,
                    AgentEvent {
                        event_type: EventType::Error,
                        turn_id: Some(turn_id.clone()),
                        conversation_id: Some(conversation_id.clone()),
                        message: Some("CLI stdout unavailable.".to_string()),
                        ..Default::default()
                    },
                );
                return;
            }
        };
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

        let child_handle = Arc::new(Mutex::new(child));

        {
            if let Ok(mut active_map) = active.lock() {
                active_map.insert(turn_id.clone(), child_handle.clone());
            }
        }

        let app_for_stdout = app.clone();
        let turn_id_for_stdout = turn_id.clone();
        let conversation_id_for_stdout = conversation_id.clone();
        let active_map_for_thread = active.clone();
        let conv_map_for_thread = active_by_conversation.clone();

        // Spawn reader thread for stdout (the main streaming channel).
        thread::spawn(move || {
            let _token_file = _token_file;
            let _sleep_guard = sleep_guard;
            let child_handle = child_handle;
            let runtime_label = runtime_label;
            let working_dir_label = working_dir_label;
            let reader = BufReader::new(stdout);
            let mut emitted_stream_text = false;
            let mut result_snapshot: Option<AgentResultSnapshot> = None;
            let mut assistant_error: Option<serde_json::Value> = None;
            let mut subagent_followers: std::collections::HashMap<
                String,
                CliSubagentTranscriptFollower,
            > = std::collections::HashMap::new();
            let mut subagent_tool_use_ids = std::collections::HashSet::new();

            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                let clean = clean_terminal_text(&line);
                let parsed = parse_json_line(&clean);
                if let Some(payload) = parsed {
                    let received_at = timestamp_ms();
                    if let Some(signal) =
                        native_parent_signal(&turn_id_for_stdout, &payload, received_at)
                    {
                        subagent_tool_use_ids.insert(signal.tool_use_id.clone());
                        let follower_key = signal.tool_use_id.clone();
                        let follower_thread_id = signal.update.thread_id.clone();
                        let start_follower = signal.start_watcher;
                        let stop_follower = signal.stop_watcher;
                        let runtime_agent_id = signal.runtime_agent_id.clone();
                        let session_id = signal.session_id.clone();
                        emit_event(
                            &app_for_stdout,
                            AgentEvent {
                                event_type: EventType::SubagentThread,
                                turn_id: Some(turn_id_for_stdout.clone()),
                                conversation_id: Some(conversation_id_for_stdout.clone()),
                                subagent_thread: Some(signal.update),
                                ..Default::default()
                            },
                        );
                        if start_follower && !subagent_followers.contains_key(&follower_key) {
                            if let (Some(runtime_agent_id), Some(session_id)) =
                                (runtime_agent_id, session_id)
                            {
                                let follower_app = app_for_stdout.clone();
                                let follower_turn_id = turn_id_for_stdout.clone();
                                let follower_conversation_id = conversation_id_for_stdout.clone();
                                let callback_agent_id = runtime_agent_id.clone();
                                let callback_tool_use_id = follower_key.clone();
                                let follower = CliSubagentTranscriptFollower::spawn(
                                    &working_dir_label,
                                    &session_id,
                                    &runtime_agent_id,
                                    follower_thread_id,
                                    move |mut update| {
                                        update.runtime_agent_id = Some(callback_agent_id.clone());
                                        update.tool_use_id = Some(callback_tool_use_id.clone());
                                        emit_event(
                                            &follower_app,
                                            AgentEvent {
                                                event_type: EventType::SubagentThread,
                                                turn_id: Some(follower_turn_id.clone()),
                                                conversation_id: Some(
                                                    follower_conversation_id.clone(),
                                                ),
                                                subagent_thread: Some(update),
                                                ..Default::default()
                                            },
                                        );
                                    },
                                );
                                subagent_followers.insert(signal.tool_use_id, follower);
                            }
                        } else if stop_follower {
                            if let Some(follower) = subagent_followers.remove(&follower_key) {
                                follower.stop();
                            }
                        }
                    }
                    for update in native_parent_results(
                        &turn_id_for_stdout,
                        &payload,
                        &subagent_tool_use_ids,
                        received_at,
                    ) {
                        emit_event(
                            &app_for_stdout,
                            AgentEvent {
                                event_type: EventType::SubagentThread,
                                turn_id: Some(turn_id_for_stdout.clone()),
                                conversation_id: Some(conversation_id_for_stdout.clone()),
                                subagent_thread: Some(update),
                                ..Default::default()
                            },
                        );
                    }
                    if let Some(parent_tool_use_id) = payload
                        .get("parent_tool_use_id")
                        .and_then(serde_json::Value::as_str)
                        .filter(|value| !value.is_empty())
                    {
                        let thread_id = native_thread_id(&turn_id_for_stdout, parent_tool_use_id);
                        let runtime_agent_id = payload
                            .get("agent_id")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string);
                        for mut update in
                            child_updates_from_payload(&thread_id, &payload, received_at)
                        {
                            update.runtime_agent_id = runtime_agent_id.clone();
                            update.tool_use_id = Some(parent_tool_use_id.to_string());
                            emit_event(
                                &app_for_stdout,
                                AgentEvent {
                                    event_type: EventType::SubagentThread,
                                    turn_id: Some(turn_id_for_stdout.clone()),
                                    conversation_id: Some(conversation_id_for_stdout.clone()),
                                    subagent_thread: Some(update),
                                    ..Default::default()
                                },
                            );
                        }
                    }
                    if is_assistant_error_payload(&payload) {
                        assistant_error = Some(payload.clone());
                    }
                    if is_result_payload(&payload) {
                        result_snapshot =
                            Some(to_agent_result_snapshot(&turn_id_for_stdout, &payload));
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

            for (_, follower) in subagent_followers.drain() {
                follower.stop();
            }

            let exit_code = child_handle
                .lock()
                .ok()
                .and_then(|mut c| c.wait().ok())
                .and_then(|s| s.code());
            if let Some(h) = stderr_handle {
                let _ = h.join();
            }
            let stderr_text = stderr_buf
                .lock()
                .ok()
                .map(|buffer| buffer.trim().to_string())
                .filter(|text| !text.is_empty());
            if let Some(mut map) = active_map_for_thread.lock().ok() {
                map.remove(&turn_id_for_stdout);
            }
            // Clear the conversation→turn mapping so a future turn for the
            // same conversation can register cleanly. This is the cleanup
            // side of the precise interrupt mapping (A1).
            if let Ok(mut conv_map) = conv_map_for_thread.lock() {
                // Only remove if it still points to OUR turn_id — if the
                // user already started a new turn for this conversation,
                // that new mapping must survive.
                if conv_map.get(&conversation_id_for_stdout) == Some(&turn_id_for_stdout) {
                    conv_map.remove(&conversation_id_for_stdout);
                }
            }
            if let Some(stderr) = stderr_text.as_ref() {
                emit_event(
                    &app_for_stdout,
                    AgentEvent {
                        event_type: EventType::Stderr,
                        turn_id: Some(turn_id_for_stdout.clone()),
                        conversation_id: Some(conversation_id_for_stdout.clone()),
                        text: Some(stderr.clone()),
                        ..Default::default()
                    },
                );
            }
            if let Some(snap) = result_snapshot.as_ref() {
                emit_event(
                    &app_for_stdout,
                    AgentEvent {
                        event_type: EventType::Result,
                        turn_id: Some(turn_id_for_stdout.clone()),
                        conversation_id: Some(conversation_id_for_stdout.clone()),
                        result: Some(AgentResultSnapshot {
                            exit_code,
                            ..snap.clone()
                        }),
                        ..Default::default()
                    },
                );
            }

            let exit_display = match exit_code {
                Some(code) => format!("exit={code}"),
                None => "signal".to_string(),
            };
            let diagnosis =
                format!("({exit_display}, runtime={runtime_label}, cwd={working_dir_label})");
            if let Some(mut failure) = terminal_failure_from_outcome(
                assistant_error.as_ref(),
                result_snapshot.as_ref(),
                exit_code,
                stderr_text.as_deref(),
                &diagnosis,
            ) {
                if failure.category == "authentication_failed" {
                    failure.recovery_ready = injected_oauth_token
                        .as_deref()
                        .and_then(crate::services::cli_credentials::refresh_after_auth_failure)
                        .is_some();
                }
                let message = failure.message.clone();
                emit_event(
                    &app_for_stdout,
                    AgentEvent {
                        event_type: EventType::Error,
                        turn_id: Some(turn_id_for_stdout.clone()),
                        conversation_id: Some(conversation_id_for_stdout.clone()),
                        message: Some(message),
                        payload: serde_json::to_value(failure).ok(),
                        exit_code,
                        ..Default::default()
                    },
                );
                return;
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
    }

    pub fn active_count(&self) -> Result<usize, String> {
        let active_children = self
            .active
            .lock()
            .map(|active| active.len())
            .map_err(|_| "active turn registry is unavailable".to_string())?;
        let active_turns = self
            .active_by_conversation
            .lock()
            .map(|active| active.len())
            .map_err(|_| "active conversation registry is unavailable".to_string())?;
        Ok(active_children.max(active_turns))
    }

    pub(crate) fn begin_update_install(&self) -> Result<UpdateInstallAdmission, String> {
        self.update_install_gate
            .begin_install(|| self.active_count())
    }

    /// Interrupt a running turn by turn_id. Sends SIGINT on Unix, Ctrl+C
    /// (GenerateConsoleCtrlEvent) on Windows, falling back to kill(). Returns
    /// true if a child was found and signaled, false if the turn wasn't
    /// running anymore.
    pub fn interrupt(&self, conversation_id: Option<String>) -> Result<bool, String> {
        // Media preparation is owned by the same conversation identity as the
        // CLI turn. Cancel it first so any ffmpeg/ffprobe/ASR descendants stop
        // before the existing CLI interruption proceeds.
        let video_interrupted = match (conversation_id.as_deref(), self.video_jobs.as_ref()) {
            (Some(conversation_id), Some(video_jobs)) => video_jobs.interrupt(conversation_id)?,
            _ => false,
        };

        // Precise interrupt: look up the turn_id registered for this
        // conversation_id. If found, signal that specific child. If not
        // found, return false (no-op) — we do NOT fall back to "any active
        // turn" because that could kill the wrong chat in multichat.
        //
        // `conversation_id = None` is a legacy escape hatch (interrupt
        // whatever is running). It's kept for backward compatibility but
        // should not be used in multichat mode.
        let target_turn_id = match conversation_id {
            Some(conv_id) => {
                let conv_map = self
                    .active_by_conversation
                    .lock()
                    .map_err(|e| e.to_string())?;
                conv_map.get(&conv_id).cloned()
            }
            None => {
                // Legacy: no conversation_id → interrupt any active turn.
                // Only used by old callers that don't track conversation_id.
                let active = self.active.lock().map_err(|e| e.to_string())?;
                active.keys().next().cloned()
            }
        };

        let Some(turn_id) = target_turn_id else {
            // No turn registered for this conversation — safe no-op.
            return Ok(video_interrupted);
        };

        let child_handle = self
            .active
            .lock()
            .map_err(|e| e.to_string())?
            .get(&turn_id)
            .cloned();
        let Some(child_handle) = child_handle else {
            return Ok(video_interrupted);
        };

        {
            let mut child = child_handle.lock().map_err(|e| e.to_string())?;
            crate::services::child_signal::interrupt_child(&mut child)?;
        }

        // Some CLI states (notably a completed subagent that left a
        // background dev server behind) consume SIGINT without exiting. Give
        // the process a short graceful window, then guarantee that the turn
        // closes so the renderer can receive Done/Error and leave busy state.
        // `terminate_process_group` kills the WHOLE group (CLI + subagents),
        // not just the direct child — matches the `interrupt_child` group
        // signal above so a subagent that survived SIGINT doesn't survive
        // the hard-kill either.
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(750));
            let Ok(mut child) = child_handle.lock() else {
                return;
            };
            if matches!(child.try_wait(), Ok(None)) {
                let _ = crate::services::child_signal::terminate_process_group(&mut child);
            }
        });
        Ok(true)
    }
}

impl Default for TurnService {
    fn default() -> Self {
        Self::new(std::sync::Arc::new(CredentialsStore::new()))
    }
}

fn emit_event(app: &AppHandle, event: AgentEvent) {
    if let Err(e) = app.emit(AGENT_EVENT_CHANNEL, event) {
        eprintln!("[turn_service] failed to emit agent event: {e}");
    }
}

fn timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CliTerminalFailure {
    category: String,
    message: String,
    details: Vec<String>,
    exit_code: Option<i32>,
    session_id: Option<String>,
    recovery_ready: bool,
}

fn is_assistant_error_payload(payload: &serde_json::Value) -> bool {
    payload.get("type").and_then(|value| value.as_str()) == Some("assistant")
        && (payload
            .get("error")
            .and_then(|value| value.as_str())
            .is_some_and(|value| !value.trim().is_empty())
            || payload
                .get("isApiErrorMessage")
                .and_then(|value| value.as_bool())
                .unwrap_or(false))
}

fn terminal_failure_from_outcome(
    assistant_error: Option<&serde_json::Value>,
    result_snapshot: Option<&AgentResultSnapshot>,
    exit_code: Option<i32>,
    stderr: Option<&str>,
    diagnosis: &str,
) -> Option<CliTerminalFailure> {
    let result_is_error = result_snapshot
        .and_then(|snapshot| snapshot.is_error)
        .unwrap_or(false);
    let empty_success_after_tool_use = result_snapshot.is_some_and(|snapshot| {
        snapshot.stop_reason.as_deref() == Some("tool_use")
            && snapshot
                .raw_result
                .as_ref()
                .and_then(|raw| raw.get("result"))
                .and_then(|value| value.as_str())
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
    });
    let incomplete_turn = assistant_error.is_none()
        && !result_is_error
        && exit_code == Some(0)
        && (result_snapshot.is_none() || empty_success_after_tool_use);
    if assistant_error.is_none() && !result_is_error && exit_code == Some(0) && !incomplete_turn {
        return None;
    }

    fn push_detail(details: &mut Vec<String>, value: Option<&str>) {
        let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
            return;
        };
        if !details.iter().any(|existing| existing == value) {
            details.push(value.to_string());
        }
    }

    let mut details = Vec::<String>::new();

    if let Some(payload) = assistant_error {
        let assistant_text = extract_text(payload, false);
        push_detail(&mut details, assistant_text.as_deref());
    }
    if let Some(errors) = result_snapshot.and_then(|snapshot| snapshot.errors.as_ref()) {
        for error in errors {
            push_detail(&mut details, Some(error));
        }
    }
    push_detail(&mut details, stderr);
    if exit_code != Some(0) {
        push_detail(&mut details, Some(diagnosis));
    }
    if details.is_empty() {
        push_detail(
            &mut details,
            Some("O CLI Verboo encerrou sem produzir resposta."),
        );
    }

    let combined = details.join("\n");
    let normalized = combined.to_lowercase();
    let category = if incomplete_turn {
        "incomplete_turn".to_string()
    } else {
        assistant_error
            .and_then(|payload| payload.get("error"))
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .or_else(|| {
                result_snapshot
                    .filter(|snapshot| snapshot.is_error.unwrap_or(false))
                    .and_then(|snapshot| snapshot.raw_result.as_ref())
                    .and_then(|raw| raw.get("subtype"))
                    .and_then(|value| value.as_str())
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| infer_terminal_failure_category(&normalized).to_string())
    };
    let session_id = assistant_error
        .and_then(|payload| payload.get("session_id"))
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .or_else(|| result_snapshot.and_then(|snapshot| snapshot.session_id.clone()));

    Some(CliTerminalFailure {
        category,
        message: combined,
        details,
        exit_code,
        session_id,
        recovery_ready: false,
    })
}

fn infer_terminal_failure_category(normalized: &str) -> &'static str {
    if normalized.contains("authentication_failed")
        || normalized.contains("failed to authenticate")
        || normalized.contains("invalid or expired token")
        || normalized.contains("oauth session expired")
        || normalized.contains("api error: 401")
    {
        "authentication_failed"
    } else if normalized.contains("too many tokens")
        || normalized.contains("prompt is too long")
        || normalized.contains("context overflow")
        || normalized.contains("context window") && normalized.contains("exceed")
    {
        "context_overflow"
    } else if normalized.contains("rate limit") || normalized.contains("api error: 429") {
        "rate_limit"
    } else if normalized.contains("billing") || normalized.contains("insufficient credit") {
        "billing_error"
    } else if normalized.contains("model not found") {
        "model_not_found"
    } else if normalized.contains("permission denied") || normalized.contains("eacces") {
        "permission_denied"
    } else if normalized.contains("network")
        || normalized.contains("connection refused")
        || normalized.contains("timed out")
        || normalized.contains("dns")
    {
        "network_error"
    } else {
        "process_error"
    }
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
/// - One `image` block per image attachment, with raw base64 in an
///   Anthropic-style `source.base64` block (the CLI converts this internally).
///
/// Format follows the envelope the CLI's `StructuredIO.processLine` requires
/// via `--input-format stream-json`:
/// ```json
/// {"type":"user","session_id":"","message":{"role":"user","content":[{"type":"text","text":"..."},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"<b64>"}}]},"parent_tool_use_id":null}
/// ```
fn build_stream_json_input(request: &AgentTurnRequest, prompt: &str) -> Option<String> {
    if request.model_supports_vision != Some(true) {
        return None;
    }
    let attachments = request.attachments.as_ref()?;
    let images: Vec<&AttachmentMeta> = attachments
        .iter()
        .filter(|a| is_visual_attachment(a) && a.media_type.is_some())
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
        // Read the image file and base64-encode it. The CLI expects raw
        // base64 (no `data:` URL prefix) inside an Anthropic-style
        // `source.base64` block — a bare `image_url` with a data URL is
        // silently ignored by the CLI's StructuredIO processor.
        let bytes = match std::fs::read(&img.path) {
            Ok(b) => b,
            Err(_) => {
                // Skip unreadable images — the text prompt still goes through.
                continue;
            }
        };
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
        let media_type = img.media_type.as_deref().unwrap_or("image/png");
        content.push(serde_json::json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type,
                "data": b64
            }
        }));
    }

    // Only return if we successfully encoded at least one image.
    if content.len() <= 1 {
        return None;
    }

    // The CLI's StructuredIO.processLine requires the envelope
    // `{type:"user", message:{role:"user", content:[...]}}` — a bare
    // `{role, content}` is silently ignored, which was the root cause of
    // vision turns producing no output.
    let message = serde_json::json!({
        "type": "user",
        "session_id": "",
        "message": {
            "role": "user",
            "content": content
        },
        "parent_tool_use_id": null
    });
    // stream-json input is newline-delimited JSON messages.
    Some(format!("{message}\n"))
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

/// Slash commands reserved by the CLI's native command interceptor.
///
/// The CLI's interception layer fires only when the user message
/// STARTS with a `/` followed by a known command — see MEDICAO
/// (2026-07-30) where /compact produced `status:"compacting"` and
/// /nonexistent returned `Unknown skill` in 9ms with no API call.
/// (MEDICAO ran the bundled cli.mjs DIRECTLY against node, NOT
/// through the app's prompt path — it proved the CLI side, not the
/// app side.)
///
/// Our `build_prompt_internal` normally PREFIXES the message with
/// the workspace header (`Current working directory: ...`) and, on
/// the non-resume path, with app instructions/personality/skills/
/// memory/etc. That prefix breaks the CLI interceptor because the
/// resulting prompt no longer starts with `/`.
///
/// The reserved commands below are passed through RAW (no prefix,
/// no envelope) when they appear at the head of `request.message`.
/// Adding a new reserved command: append it here AND add a
/// regression test that proves the bypass fires AND update the
/// cross-fence test at
/// `src/renderer/features/composer/reservedSlashCommands.contract.test.ts`
/// so the renderer side and the Rust side stay in sync.
///
/// Field defect reference: commit 7fdd56c added /compact on
/// origin/dev; commit c5dae57 (Tauri migration) introduced the
/// prompt wrapping; no subsequent commit touched either side.
/// The bypass was missing from the day /compact shipped.
const RESERVED_SLASH_COMMANDS: &[&str] = &[
    // Native CLI compaction command. Fires `status:"compacting"` and
    // returns `compact_boundary` metadata.
    //
    // PROVEN end-to-end on the CLI side by MEDICAO 2026-07-30:
    //   node cli.mjs --print --output-format stream-json --verbose \
    //     --resume <session_id> "/compact"
    //   → first event: {"type":"system","subtype":"status",
    //                    "status":"compacting",...}
    //   → later event: {"type":"system","subtype":"compact_boundary",
    //                    "compact_metadata":{"trigger":"manual",
    //                                        "pre_tokens":2}}
    //
    // NOT PROVEN on the app side. This Rust bypass makes the message
    // arrive raw at the CLI, but PROVING the CLI executes compaction
    // by the app path requires rebuilding the app, opening it in a
    // real session, and observing `compact_boundary` in the
    // runtimeActivity stream AND `contextUsage` dropping in the UI.
    // Exit-zero alone is NOT acceptance — many error paths also
    // return exit zero. The field-acceptance criterion, registered
    // 2026-07-31, is:
    //   `compact_boundary` present in the stream-json emission AND
    //   `contextUsage` value falling afterwards. Never exit zero.
    //
    // Do not state "verified end-to-end" or "fully proven" in any
    // comment or commit message about this bypass until the app-side
    // criterion is observed in a packaged build.
    "/compact",
];

/// Returns `true` when `message` is a reserved slash command that
/// must reach the CLI interceptor unprefixed. Matching is by
/// whitespace-delimited head: `/compact preserve old memory` matches
/// because the head token is `/compact`. Comparison is
/// case-insensitive — declared as DEFENSIVE CONSERVATISM. We did
/// NOT verify that the CLI normalizes case before intercepting, so
/// the lowercase here is "if the CLI is case-sensitive we want to
/// still match" rather than a documented contract. If the CLI is in
/// fact case-sensitive and the user types `/Compact`, this bypass
/// fails — that failure mode is still better than the silent wrap
/// it replaces (the user sees the message go to the model, not a
/// silent compact miss).
fn is_reserved_slash_command(message: &str) -> bool {
    let trimmed = message.trim_start();
    let head = trimmed
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    !head.is_empty()
        && head.starts_with('/')
        && RESERVED_SLASH_COMMANDS
            .iter()
            .any(|reserved| head == *reserved)
}

/// Same as [`build_prompt`], exposed as `pub(crate)` so the research-subagent
/// runner (services/research_subagent_runner.rs) can compose the same prompt
/// format without duplicating the logic.
pub(crate) fn build_prompt_internal(request: &AgentTurnRequest, is_resume: bool) -> String {
    // Reserved slash commands bypass the prompt wrapper. The CLI's
    // command interceptor fires only on messages that START with a
    // recognized `/` token — any prefix (workspace header, app
    // instructions, attachments, etc.) breaks the intercept and the
    // command is silently routed to the model as text. See
    // `RESERVED_SLASH_COMMANDS` for the field defect background.
    //
    // Field evidence (D-D, 2026-07-31): /compact sent through the
    // app's normal flow never reached the CLI's `status:"compacting"`
    // branch because the prompt started with "Current working
    // directory: ..." and the `/compact` token was nowhere near the
    // head. The bypass returns the message as the entire prompt —
    // no envelope, no language header, no workspace context. The CLI
    // accepts the bare slash command in --print mode.
    //
    // T2-TodoWrite-i18n (2026-07-31): this bypass is a D-D field fix
    // and is intentionally UNTOUCHED. A reserved slash command
    // continues to leave the prompt wrapper untouched — no envelope,
    // no language header, no TodoWrite instruction. /compact
    // intercept must not regress.
    //
    // F0-Annotate (2026-07-31) — DECISÃO: DECLARAR, NÃO BLOQUEAR.
    //
    // When a reserved slash command arrives WITH pending annotations,
    // the bypass returns the raw message and the annotations would be
    // dropped in silence. Silence is the worst desfecho — the user
    // selected a passage, wrote a comment, hit send, and the next
    // turn has no idea any of that happened. We considered two
    // options:
    //
    //   (A) BLOQUEAR — return Err / panic and refuse to dispatch.
    //       Rejected: the slash command bypass is the D-D field fix
    //       and the user said "não mexa no atalho em si". Changing
    //       the return type to Result would ripple into 7+ callers
    //       for a corner case. Worse, blocking /compact because the
    //       user happened to have a draft annotation would be a
    //       regression in the /compact UX.
    //
    //   (B) DECLARAR — log loud via eprintln with full context
    //       (which reserved command, how many annotations dropped,
    //       what the user comment was), then proceed with the bypass
    //       as today. The annotations are dropped, but the drop is
    //       VISIBLE in stderr / Tauri panic handler logs. The
    //       renderer can also guard against this combination at the
    //       dispatch site (MOSAICO's fence), but the Rust side is
    //       the last line of defense and must not be silent.
    //
    // We choose (B). The eprintln is the declaration. The bypass
    // itself is untouched — same `return request.message.clone()`
    // as before, just preceded by a log line when annotations are
    // non-empty. A test pins the log via a thread-local counter
    // (see `RESERVED_WITH_ANNOTATIONS_WARN_COUNT`).
    if is_reserved_slash_command(&request.message) {
        if let Some(anns) = request.annotations.as_ref() {
            if !anns.is_empty() {
                warn_reserved_with_annotations_dropped(
                    &request.message,
                    anns.len(),
                    anns
                        .iter()
                        .find_map(|a| a.comment.as_ref().map(|c| c.as_str()))
                        .unwrap_or("<no comment>"),
                );
            }
        }
        return request.message.clone();
    }

    let language = request.response_language.unwrap_or(LanguageCode::EnUs);
    let working_directory = safe_runtime_working_directory(&request.working_directory, None);
    let _ = request.response_language; // already copied via Copy

    // T2-TodoWrite-i18n (2026-07-31): the TodoWrite language instruction
    // is added to BOTH the first-turn envelope AND the resume branch.
    //
    // Why include it on resume: the conversation can resume many times
    // in batch and /goal flows — only the first turn sets the model
    // expectation, and a fresh model invocation on resume does NOT
    // carry the first-turn's system header. If the instruction lived
    // only here, the agent's TodoWrite steps on every subsequent
    // resumed task would revert to English. The cost is small (~30–40
    // tokens per turn) and constant, which is acceptable for a
    // behavioral guarantee.
    let language_instruction = todowrite_language_instruction(language);
    // F0-Annotate (2026-07-31): annotation block, when present, is
    // placed AFTER skills/language-instruction and BEFORE attachments.
    // Empty string when there are no annotations — so a request
    // without annotations produces a byte-identical prompt to today.
    // See `build_annotation_block` for the safety labeling contract.
    let annotation_block = build_annotation_block(request.annotations.as_ref(), language);

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
            .chain(std::iter::once(language_instruction))
            .chain(std::iter::once(annotation_block).filter(|s| !s.is_empty()))
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
                    ("Instruções personalizadas do usuário:", trimmed.to_string())
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
                ("Memória local relevante deste app:", trimmed.to_string())
            } else {
                ("Relevant local app memory:", trimmed.to_string())
            };
            parts.push(format!("{label}\n{body}"));
        }
    }
    let skill_lines = build_skill_lines(&request.skills, language);
    parts.extend(skill_lines);
    // T2-TodoWrite-i18n (2026-07-31): instruction placed in the first-turn
    // envelope, AFTER skills/attachments and BEFORE the user message, so
    // it lands in the same structural position as a system-level rule.
    parts.push(language_instruction);
    // F0-Annotate (2026-07-31): annotation block placed BEFORE
    // attachments and BEFORE the user message. Empty string is
    // filtered out so it does not introduce a blank section when
    // there are no annotations — preserving byte-identical prompt
    // for the no-annotations case.
    if !annotation_block.is_empty() {
        parts.push(annotation_block);
    }
    let attachment_lines = build_attachment_lines(
        &request.attachments,
        language,
        request.model_supports_vision,
    );
    parts.extend(attachment_lines);

    parts.push(request.message.clone());
    parts.join("\n\n")
}

/// T2-TodoWrite-i18n (2026-07-31): instructs the model to write the
/// TodoWrite item text in the conversation's language, while keeping
/// technical identifiers (filenames, paths, commands, flags, code
/// snippets) intact. Why a rule at the source, not translation at
/// display: the user picked the source-fix because displaying would
/// destroy filenames, paths, and commands — translating `p1.txt` to
/// `p1.txt` is fine, but translating a Cyrillic path or a CLI flag
/// would be a data-loss bug.
///
/// Token cost: ~30 tokens (EN) / ~40 tokens (PT). The PT version is a
/// hair longer because "Escreva os passos do TodoWrite" + "Preserve
/// intactos" carries more inflection than English. Both are
/// single-sentence instructions — no preamble, no explanation, just
/// the rule. The instruction is one of several `parts` in the prompt;
/// adding it does not change the routing envelope.
fn todowrite_language_instruction(language: LanguageCode) -> String {
    if language == LanguageCode::PtBr {
        // PT: write steps in the conversation language; keep
        // identifiers intact. Names of files, paths, commands, flags,
        // identifiers, and code snippets MUST stay as-is.
        "Escreva os passos do TodoWrite (campos content e activeForm) \
         no idioma da conversa. Preserve intactos: nomes de arquivo, \
         caminhos, comandos, flags, identificadores e trechos de código."
            .to_string()
    } else {
        // EN: write steps in the conversation language; keep
        // identifiers intact. Filenames, paths, commands, flags,
        // identifiers, and code snippets MUST stay as-is.
        "Write TodoWrite steps (content and activeForm fields) in the \
         conversation's language. Keep intact: filenames, paths, \
         commands, flags, identifiers, and code snippets."
            .to_string()
    }
}

/// F0-Annotate (2026-07-31) — renders the user's annotations as a
/// labeled block in the prompt. Returns empty string when there are
/// no annotations, so the caller can `.filter(|s| !s.is_empty())` and
/// the no-annotations case produces a byte-identical prompt to today.
///
/// SAFETY CONTRACT — ORIGIN LABELING (load-bearing, non-negotiable):
/// the `quote` field is a slice of the ASSISTANT's prior response
/// returning to the prompt. The `comment` field is USER-authored. If
/// the two ever collapse into a single bucket, we create an injection
/// surface — model text returning as if it were user instruction. So
/// each annotation is rendered with TWO distinct labels:
///
///   PT:
///     "Trecho citado da resposta anterior DO ASSISTENTE:"
///     "Comentário DO USUÁRIO:"
///   EN:
///     "Quoted passage from the prior ASSISTANT response:"
///     "USER comment:"
///
/// The labels are uppercase-emphasized ("DO ASSISTENTE", "DO USUÁRIO",
/// "ASSISTANT", "USER") so the model cannot misread them as soft
/// hints. The order within each annotation is: quote first (the
/// context), comment second (the user's intent on that context).
/// Comment is OPTIONAL — when `comment` is None or empty, the comment
/// line is OMITTED entirely. We do NOT emit an orphan label like
/// "Comentário DO USUÁRIO:" with nothing after it — that would be
/// both confusing and a prompt-bloat leak.
///
/// TRUNCATION POLICY — UNIT CONVERSION (do not mix units):
///
///   TS side (renderer gate, MOSAICO fence): 2000 UTF-16 CODE UNITS.
///   A UTF-16 code unit is NOT a byte and NOT a code point:
///     - a BMP char (U+0800..U+FFFF, e.g. CJK) is 1 UTF-16 unit but
///       3 UTF-8 bytes;
///     - an emoji (non-BMP) is 2 UTF-16 units but 4 UTF-8 bytes.
///
///   Worst-case UTF-8 expansion of 2000 UTF-16 units:
///     all BMP 3-byte chars → 2000 × 3 = 6000 bytes
///     (non-BMP: 1000 chars × 4 bytes = 4000 bytes — smaller)
///   → 6000 bytes is the largest a TS-passed selection can reach.
///
///   The Rust ceiling is therefore 6144 bytes (6 KiB = 6000 + 144
///   slack): the smallest value that NEVER fires on a selection the
///   TS gate let through. If it fires anyway, a renderer bug
///   bypassed the TS gate — the prompt still does not bloat to the
///   size of the entire response.
///
///   Truncation is CHAR-SAFE (never cuts inside a UTF-8 char — that
///   PANICS in Rust; see `truncate_quote_char_safe`). The 'ç'
///   boundary test in this file guards the panic path.
const ANNOTATION_QUOTE_CEILING_BYTES: usize = 6144;

/// F0-Annotate (2026-07-31) — truncates a quote at a UTF-8 CHAR
/// boundary near the byte ceiling. `&str[..N]` PANICS when N lands
/// inside a multi-byte character (a user pasting 4 KiB of accented
/// text would crash the app at the exact wrong offset). Walking back
/// to the last char boundary is the panic-free form; worst-case
/// walk-back is 3 bytes (max UTF-8 char width is 4). The "[…]" marker
/// signals the cut to the model. Returns the original when it fits.
fn truncate_quote_char_safe(quote: &str) -> String {
    if quote.len() <= ANNOTATION_QUOTE_CEILING_BYTES {
        return quote.to_string();
    }
    let mut end = ANNOTATION_QUOTE_CEILING_BYTES;
    while !quote.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = String::with_capacity(end + 4);
    out.push_str(&quote[..end]);
    out.push_str("[…]");
    out
}

fn build_annotation_block(
    annotations: Option<&Vec<crate::models::types::Annotation>>,
    language: LanguageCode,
) -> String {
    let anns = match annotations {
        Some(a) if !a.is_empty() => a,
        _ => return String::new(),
    };
    let (header, quote_label, comment_label) = if language == LanguageCode::PtBr {
        (
            "Anotações do usuário para este turno:",
            "Trecho citado da resposta anterior DO ASSISTENTE:",
            "Comentário DO USUÁRIO:",
        )
    } else {
        (
            "User annotations for this turn:",
            "Quoted passage from the prior ASSISTANT response:",
            "USER comment:",
        )
    };
    let mut sections: Vec<String> = Vec::with_capacity(anns.len() + 1);
    sections.push(header.to_string());
    for (i, ann) in anns.iter().enumerate() {
        let mut block = String::new();
        block.push_str(&format!("{}. ", i + 1));
        block.push_str(quote_label);
        block.push('\n');
        let quote = truncate_quote_char_safe(&ann.quote);
        block.push_str(&quote);
        if let Some(c) = ann.comment.as_ref() {
            let trimmed = c.trim();
            if !trimmed.is_empty() {
                block.push('\n');
                block.push_str(comment_label);
                block.push('\n');
                block.push_str(trimmed);
            }
        }
        sections.push(block);
    }
    sections.join("\n\n")
}

/// F0-Annotate (2026-07-31) — DECLARAR (not BLOQUEAR) when a reserved
/// slash command arrives with pending annotations. Logs to stderr
/// with full context so the drop is visible, not silent. See the
/// decision comment in `build_prompt_internal` for the rationale.
///
/// Test hook: `RESERVED_WITH_ANNOTATIONS_WARN_COUNT` is a thread-local
/// counter incremented on each warning. Tests reset it, run the call,
/// and assert the counter — without having to capture stderr. The
/// counter is `#[cfg(test)]` only, zero cost in release builds.
#[cfg(test)]
thread_local! {
    static RESERVED_WITH_ANNOTATIONS_WARN_COUNT: std::cell::Cell<usize> = std::cell::Cell::new(0);
}

#[cfg(test)]
fn reserved_with_annotations_warn_count() -> usize {
    RESERVED_WITH_ANNOTATIONS_WARN_COUNT.with(|c| c.get())
}

#[cfg(test)]
fn reset_reserved_with_annotations_warn_count() {
    RESERVED_WITH_ANNOTATIONS_WARN_COUNT.with(|c| c.set(0));
}

fn warn_reserved_with_annotations_dropped(
    message: &str,
    count: usize,
    first_comment: &str,
) {
    eprintln!(
        "[F0-Annotate] WARN: reserved slash command `{}` arrived with {} pending annotation(s); \
         the bypass returns the raw message and the annotations are DROPPED (not attached to the \
         next model turn). First comment: `{}`. This is a DECLARAR decision — the drop is logged, \
         not silent. See build_prompt_internal decision comment for rationale.",
        message, count, first_comment
    );
    #[cfg(test)]
    RESERVED_WITH_ANNOTATIONS_WARN_COUNT.with(|c| c.set(c.get() + 1));
}

/// Resolves the `--effort <level>` argument to send to the CLI, given the
/// user's saved override and the model's reasoning capability.
///
/// Three-contract model (no ambiguity):
///   - **Saved valid override**: present, non-empty, and ∈
///     `reasoning.effort_levels` → returned as-is.
///   - **Displayed effort** (FE concern, not here): override when valid,
///     else `reasoning.default_effort`. The FE reads `default_effort` from
///     the capability to show a default chip.
///   - **Sent effort** (this function): only a valid override is sent.
///     Absent/invalid → `None` → `--effort` omitted → CLI applies
///     `default_effort` on its own.
///
/// "none" is a real level (not a sentinel): if the model offers it
/// (`effort_levels` contains "none"), an explicit "none" override is sent
/// as `--effort none`. If the model does NOT offer "none", "none" is
/// treated as an invalid override and dropped (no `--effort`).
///
/// No hardcoded level list — any string the Router sends in
/// `effort_levels` is accepted. Models without `reasoning` (kimi/minimax)
/// get `None` regardless of the override.
/// Builds the full CLI argument vector for a turn, given the request, the
/// pre-rendered prompt, the optional resume session id, and whether to use
/// stream-json input. Extracted from `run_turn_background` so the arg set
/// can be asserted in integration tests without spawning a process.
///
/// Effort contract (see `resolve_effort_arg`): `--effort <level>` is pushed
/// only when the request carries a valid override for the model's current
/// `reasoning.effort_levels`. Absent/invalid → omitted.
pub(crate) fn build_cli_args(
    request: &AgentTurnRequest,
    prompt: &str,
    resume_session_id: Option<&str>,
    use_stream_json: bool,
) -> Vec<String> {
    let mut args = vec![
        "--print".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
    ];
    if use_stream_json {
        args.push("--input-format".to_string());
        args.push("stream-json".to_string());
    } else {
        args.push(prompt.to_string());
    }
    if let Some(sid) = resume_session_id {
        args.push("--resume".to_string());
        args.push(sid.to_string());
    }
    if let Some(selection) = &request.provider_account {
        if !selection.account_id.trim().is_empty() {
            args.push("--provider-account".to_string());
            args.push(selection.account_id.clone());
            if resume_session_id.is_some() && selection.fork_session {
                args.push("--fork-session".to_string());
            }
        }
    }
    if let Some(model) = &request.model {
        if !model.trim().is_empty() {
            args.push("--model".to_string());
            args.push(model.clone());
        }
    }
    // Effort is NOT passed as `--effort` — the CLI 0.12 has a static
    // allowlist that rejects "none" and future router levels. Instead, a
    // valid override is injected as `CLAUDE_CODE_EFFORT_LEVEL=<level>` env
    // var on the spawned process (see `run_turn_background`). The CLI
    // validates the env value against the model's `reasoning.effortLevels`
    // dynamically. Absent/invalid → env not set → CLI applies default_effort.
    for arg in access_mode_cli_args(&request.access_mode) {
        args.push(arg.to_string());
    }
    args
}

pub(crate) fn resolve_effort_arg(
    effort_override: Option<&str>,
    reasoning: Option<&ModelReasoning>,
) -> Option<String> {
    let raw = effort_override?.trim();
    if raw.is_empty() {
        return None;
    }
    let levels = reasoning.map(|r| r.effort_levels.as_slice()).unwrap_or(&[]);
    if levels.is_empty() {
        // Model has no reasoning capability — no effort UI, no --effort.
        return None;
    }
    // Case-insensitive membership against the capability's levels.
    let lower = raw.to_lowercase();
    let matched = levels.iter().find(|l| l.to_lowercase() == lower);
    matched.map(|s| s.clone())
}

/// Returns the `CLAUDE_CODE_EFFORT_LEVEL` value to inject on the spawned
/// CLI process, or `None` when the override is absent/invalid. Mirrors the
/// env injection in `run_turn_background` so tests can assert the transport
/// without spawning a process. Same validation as `resolve_effort_arg` —
/// a valid override is one present, non-empty, and ∈ the model's
/// `reasoning.effort_levels`.
#[cfg(test)]
pub(crate) fn resolve_effort_env(
    effort_override: Option<&str>,
    reasoning: Option<&ModelReasoning>,
) -> Option<String> {
    resolve_effort_arg(effort_override, reasoning)
}

/// Resolves the working directory for a CLI chat spawn.
///
/// (b) Chat novo cwd neutro (2026-08-07): when the cwd is empty/"/"/"."
/// OR equals the app's own data dir, redirect to a NEUTRAL empty workdir
/// under app_data_dir. The old code returned `dirs::home_dir()` for empty
/// cwd — on Windows the renderer passes `app_data_dir` for new chats, and
/// the CLI scans it (listing resources/, etc.) instead of starting the
/// chat. The neutral workdir is empty → the CLI finds nothing to scan →
/// the prompt appears immediately. Mirrors the provider-login pattern
/// (lib.rs:2085-2096).
fn safe_runtime_working_directory(
    working_directory: &str,
    app_data_dir: Option<&std::path::Path>,
) -> String {
    let trimmed = working_directory.trim();
    let is_neutral_placeholder = trimmed.is_empty()
        || trimmed == "/"
        || trimmed == ".";
    // Also redirect when the cwd IS the app's own data dir (the renderer
    // passes it for new chats). Compare canonically to handle trailing
    // slashes / symlinks.
    let is_app_data_dir = app_data_dir
        .map(|d| {
            let cwd_path = std::path::Path::new(trimmed);
            cwd_path == d
        })
        .unwrap_or(false);
    // Redirect when the path does not exist on disk (stale project
    // references from a previous session). Without this the CLI would
    // fail with a confusing "cwd does not exist" error.
    let path_exists = !is_neutral_placeholder && std::path::Path::new(trimmed).is_dir();
    if is_neutral_placeholder || is_app_data_dir || !path_exists {
        // Neutral empty workdir under app_data_dir (created on demand).
        // Fallback to temp_dir when app_data_dir is None (tests/CI).
        let neutral = app_data_dir
            .map(|d| d.join("chat-workdir"))
            .unwrap_or_else(|| std::env::temp_dir().join("verboo-chat"));
        let _ = std::fs::create_dir_all(&neutral);
        neutral.to_string_lossy().to_string()
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

fn build_skill_lines(
    skills: &[crate::models::types::SkillSummary],
    language: LanguageCode,
) -> Vec<String> {
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
        if skill.is_plugin_mention {
            let line = if language == LanguageCode::PtBr {
                format!("- Use o plugin \"{}\" — as ferramentas MCP/skills dele estão disponíveis nativamente", skill.name)
            } else {
                format!(
                    "- Use the \"{}\" plugin — its MCP tools/skills are available natively",
                    skill.name
                )
            };
            lines.push(line);
        } else {
            lines.push(format!("- Use skill \"{}\" — {}", skill.name, skill.path));
        }
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
                entry.push_str(&format!(
                    "\n  <document-content>\n{text}\n  </document-content>"
                ));
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
        AttachmentKind::Video => "video",
        AttachmentKind::File => "file",
        AttachmentKind::BrowserAnnotation => "browser annotation",
        AttachmentKind::SimulatorAnnotation => "simulator annotation",
    }
}

fn is_visual_attachment(attachment: &AttachmentMeta) -> bool {
    matches!(
        attachment.kind,
        AttachmentKind::Image
            | AttachmentKind::BrowserAnnotation
            | AttachmentKind::SimulatorAnnotation
    )
}

fn merge_vision_description(attachment: &mut AttachmentMeta, description: String) {
    if matches!(
        attachment.kind,
        AttachmentKind::BrowserAnnotation | AttachmentKind::SimulatorAnnotation
    ) {
        if let Some(structured_context) = attachment
            .extracted_text
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            attachment.extracted_text = Some(format!(
                "{structured_context}\n\n<visual-description>\n{}\n</visual-description>",
                description.trim(),
            ));
            return;
        }
    }
    attachment.extracted_text = Some(description);
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
                // These bytes are valid UTF-8 — we walked them inside a valid
                // &str and ESC (0x1B) / CSI terminators are ASCII (< 0x80),
                // so they never split a multi-byte sequence. Use safe
                // from_utf8 to avoid UB risk from future refactoring.
                out.push_str(std::str::from_utf8(&bytes[run_start..i]).unwrap_or_default());
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
        // Same safety argument as above — safe bytes from valid &str.
        out.push_str(std::str::from_utf8(&bytes[run_start..i]).unwrap_or_default());
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
            input_tokens: u
                .get("input_tokens")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32),
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

/// Returns true when the payload represents a compaction event from the CLI.
/// Handles three shapes:
/// 1. Anthropic raw stream-json: `{"type":"stream_event","event":{"delta":{"type":"compaction_delta"|"compaction"}}}`
/// 2. CLI system informational: `{"type":"system","subtype":"informational","content":"Compacting conversation…"}`
/// 3. CLI compact boundary: `{"type":"system","subtype":"compact_boundary","content":"Conversation compacted"}`
///
/// Defensive: case-insensitive, handles unicode ellipsis `…` vs `...`.
fn is_compaction_payload(payload: &serde_json::Value) -> bool {
    // Shape 1: Anthropic raw stream_event with compaction_delta/compaction.
    if payload.get("type").and_then(|v| v.as_str()) == Some("stream_event") {
        if let Some(event) = payload.get("event") {
            if let Some(delta) = event.get("delta") {
                let dtype = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if dtype == "compaction_delta" || dtype == "compaction" {
                    return true;
                }
            }
        }
    }

    // Shape 2 & 3: CLI system messages with subtype or content matching compact.
    if payload.get("type").and_then(|v| v.as_str()) == Some("system") {
        // Check subtype for compact_boundary or any subtype containing "compact".
        let subtype = payload
            .get("subtype")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if subtype.to_lowercase().contains("compact") {
            return true;
        }
        // Check content for "Compacting conversation" (case-insensitive, handles …).
        let content = payload
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if content.to_lowercase().contains("compacting") {
            return true;
        }
        // Check status field (some CLI versions put status:"compacting" on system msgs).
        let status = payload.get("status").and_then(|v| v.as_str()).unwrap_or("");
        if status.to_lowercase().contains("compact") {
            return true;
        }
    }

    false
}

fn runtime_activity_from_payload(payload: &serde_json::Value) -> Option<RuntimeActivity> {
    // Compaction detection — handles both Anthropic raw stream-json and the
    // bundled CLI's `system` message format (cli.mjs convertStatusMessage).
    //
    // CLI shapes (real, from cli.mjs):
    //   1. While compacting:
    //      {"type":"system","subtype":"informational","content":"Compacting conversation…"}
    //   2. After compact:
    //      {"type":"system","subtype":"compact_boundary","content":"Conversation compacted","compactMetadata":{...}}
    //   3. Anthropic raw (rare in bundled CLI):
    //      {"type":"stream_event","event":{"delta":{"type":"compaction_delta"}}}
    if is_compaction_payload(payload) {
        let is_boundary = payload
            .get("subtype")
            .and_then(|v| v.as_str())
            .map(|s| s.contains("compact_boundary"))
            .unwrap_or(false);
        let label = if is_boundary {
            "Context compacted"
        } else {
            "Compacting context…"
        };
        let detail = if is_boundary {
            Some("done".to_string())
        } else {
            None
        };
        return Some(RuntimeActivity {
            key: "compaction".to_string(),
            label: label.to_string(),
            detail,
            kind: "compacting".to_string(),
            tool_use_id: None,
            additions: None,
            deletions: None,
            diff_preview: None,
            todos: None,
        });
    }
    let block = extract_tool_block(payload)?;
    let name = block
        .get("name")
        .and_then(|v| v.as_str())
        .or_else(|| block.get("tool_name").and_then(|v| v.as_str()))?
        .to_string();
    let input = tool_input(&block);
    let id = block
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let detail = detail_for_tool(&name, input.as_ref());
    let stats = edit_stats_for_tool(&name, input.as_ref());
    let diff_preview = diff_preview_for_tool(&name, input.as_ref());
    let activity = activity_for_tool(&name);
    // T1-TodoWrite SUBAGENT FILTER: `parent_tool_use_id` presente e
    // não-vazio marca que este evento veio de uma thread de subagente.
    // O TodoWrite de subagente é interno a ele — a lista que chega à
    // tela do usuário tem que ser a do turno PRINCIPAL, senão o
    // usuário vê a lista interna de um subagente sobrescrevendo a dele.
    // Por isso só populamos `todos` quando `parent_tool_use_id` é
    // ausente ou vazio. O filtro é no PRODUTOR (aqui), não no
    // consumidor (renderer): o dado nem atravessa a ponte.
    let is_subagent_event = payload
        .get("parent_tool_use_id")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    let todos = if is_subagent_event {
        None
    } else {
        todos_for_tool(&name, input.as_ref())
    };
    Some(RuntimeActivity {
        key: format!(
            "{}:{}",
            id.as_deref().unwrap_or(&name),
            detail.as_deref().unwrap_or("")
        ),
        label: activity.0.to_string(),
        detail,
        kind: activity.1.to_string(),
        tool_use_id: id,
        additions: stats.as_ref().map(|s| s.additions),
        deletions: stats.as_ref().map(|s| s.deletions),
        diff_preview,
        todos,
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
    content.iter().find_map(|item| {
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

pub(crate) fn extract_tool_block(
    payload: &serde_json::Value,
) -> Option<serde_json::Map<String, serde_json::Value>> {
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

/// FRENTE-A (2026-08-02): the exact tool set of the bundled
/// Verboo-in-Chrome extension, pinned bidirectionally by
/// `services::chrome_tools_canary` against the REAL manifest
/// (`extensions/verboo-chrome/src/controller/browserTools.json`). A rename
/// on the extension side goes RED there instead of silently degrading the
/// transcript step to the generic fallback. Each tool has its own label
/// (the specific action); all share the single "browser" kind and icon.
pub(crate) const CHROME_BROWSER_TOOLS: &[(&str, &str)] = &[
    ("navigate", "Navegou no Chrome"),
    ("read_page", "Leu página no Chrome"),
    ("find", "Procurou elementos no Chrome"),
    ("extract_page_content", "Extraiu página completa no Chrome"),
    ("structured_extract", "Extraiu dados no Chrome"),
    ("click", "Clicou no Chrome"),
    ("type", "Digitou no Chrome"),
    ("screenshot", "Capturou tela no Chrome"),
    ("tabs", "Gerenciou abas no Chrome"),
    ("tab_group", "Organizou grupos de abas no Chrome"),
];

/// Generic fallback for verboo-in-chrome tools not (yet) in the manifest.
/// Keeps the browser kind and the brand even for future tools.
pub(crate) const CHROME_FALLBACK_LABEL: &str = "Usou o Chrome";

/// MCP namespace prefix used by the bundled Chrome extension sidecar
/// (MCP tool names arrive as `mcp__<server>__<tool>`).
pub(crate) const CHROME_MCP_PREFIX: &str = "mcp__verboo-in-chrome__";

pub(crate) fn activity_for_tool(tool_name: &str) -> (&'static str, &'static str) {
    let n = tool_name.to_lowercase();
    if is_subagent_tool_name(&n) {
        return ("Subagente ativo", "subagent");
    }
    // FRENTE-A (2026-08-02): the bundled Chrome extension's MCP tools arrive
    // prefixed `mcp__verboo-in-chrome__<tool>`. They all share the single
    // "browser" kind (one icon family — the generic globe; the brand lives
    // in the label, not the icon). Only THIS server gets the browser
    // presentation: other MCP servers' tool sets are not knowable at compile
    // time, so they stay on the generic fallback below. Matching the prefix
    // structure generally (any `mcp__<server>__<tool>`) would either mislabel
    // (a generic server's "read" → "Leu arquivo" with no Chrome context) or
    // force server-aware labels we cannot know statically. The canary pins
    // this exact server's manifest in both directions.
    if let Some(tool) = n.strip_prefix(CHROME_MCP_PREFIX) {
        let label = CHROME_BROWSER_TOOLS
            .iter()
            .find(|(t, _)| *t == tool)
            .map(|(_, l)| *l)
            .unwrap_or(CHROME_FALLBACK_LABEL);
        return (label, "browser");
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
        // T1-TodoWrite (2026-07-31) — DECISÃO EXPLÍCITA DO MAESTRO:
        // PLANEJAR NÃO CONTA COMO AGIR.
        //
        // A guarda de ação observável (renderer goalState.ts
        // ACTION_ACTIVITY_KINDS) existe para provar que algo FOI FEITO
        // — um edit, um comando, uma busca. Escrever a lista do que se
        // pretende fazer é o oposto disso: é declarar intenção, não
        // executar. Se todowrite fosse kind="tool", entraria na
        // whitelist e um agente poderia satisfazer a guarda só
        // escrevendo a lista de tarefas, sem fazer nenhuma. Isso é
        // exatamente o defeito que a guarda existe para pegar, só que
        // disfarçado de atividade legítima.
        //
        // kind="planning" cai FORA da whitelist por design. O label
        // continua "Atualizou tarefas" para o usuário ver que o agente
        // planejou, mas o avaliador não conta isso como ação. Quem ler
        // este código daqui a seis meses precisa entender que foi
        // deliberado: a simetria entre "exibiu uma atividade" e "contou
        // como ação" foi quebrada aqui de propósito, porque planejar é
        // o caso onde a simetria mente.
        "todowrite" => ("Atualizou tarefas", "planning"),
        _ => ("Usou ferramenta", "tool"),
    }
}

/// T1-TodoWrite (2026-07-31): extracts the structured todo list from a
/// todowrite tool input. Mirrors the CLI's TodoItemSchema —
/// `todos: [{ content, status, activeForm }]` with status ∈
/// {"pending","in_progress","completed"}. Returns None for non-todowrite
/// tools or malformed inputs (defensive: a missing/empty `todos` array
/// yields None, not an empty vec, so the renderer's `skip_serializing_if`
/// keeps the payload small).
///
/// SUBAGENT FILTER: this helper does NOT know whether the event came
/// from a subagent. The filter is applied by the caller
/// (`runtime_activity_from_payload`), which checks `parent_tool_use_id`
/// before calling this — subagent TodoWrites never reach this helper.
fn todos_for_tool(
    tool_name: &str,
    input: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<Vec<crate::models::types::TodoItem>> {
    let input = input?;
    let n = tool_name.to_lowercase();
    if n != "todowrite" {
        return None;
    }
    let arr = input.get("todos")?.as_array()?;
    if arr.is_empty() {
        return None;
    }
    let mut items = Vec::with_capacity(arr.len());
    for v in arr {
        let content = v.get("content").and_then(|v| v.as_str())?.to_string();
        let status = v.get("status").and_then(|v| v.as_str())?.to_string();
        let active_form = v.get("activeForm").and_then(|v| v.as_str())?.to_string();
        items.push(crate::models::types::TodoItem {
            content,
            status,
            active_form,
        });
    }
    if items.is_empty() {
        None
    } else {
        Some(items)
    }
}

fn detail_for_tool(
    tool_name: &str,
    input: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<String> {
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
    // T1-TodoWrite: todowrite não tem detail em string — o dado vive no
    // campo estruturado `todos` (ver todos_for_tool). Retornar None
    // aqui evita duplicar a lista em string e em struct.
    if n == "todowrite" {
        return None;
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

fn tool_input(
    block: &serde_json::Map<String, serde_json::Value>,
) -> Option<serde_json::Map<String, serde_json::Value>> {
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

struct EditStats {
    additions: u32,
    deletions: u32,
}

const DIFF_PREVIEW_MAX_LINES: usize = 40;
const DIFF_PREVIEW_MAX_CHARS: usize = 2_500;
const DIFF_PREVIEW_PER_EDIT_LINES: usize = 12;

/// Counts non-empty lines using git's convention: trailing newline does not
/// add a new line, so "a\n" and "a" both count as 1, "" counts as 0.
fn count_lines(s: &str) -> u32 {
    s.lines().count() as u32
}

/// Computes (+additions, -deletions) for write/edit/multiedit tool inputs.
/// Returns None for tools that don't represent a textual edit.
fn edit_stats_for_tool(
    tool_name: &str,
    input: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<EditStats> {
    let input = input?;
    let n = tool_name.to_lowercase();
    let text_for = |keys: &[&str]| -> Option<&str> {
        keys.iter()
            .find_map(|k| input.get(*k).and_then(|v| v.as_str()))
    };

    if matches!(
        n.as_str(),
        "write" | "write_file" | "create_file" | "new_file" | "notebookedit" | "notebook_edit"
    ) {
        let content = text_for(&["content", "file_text", "fileText", "newContent"]).unwrap_or("");
        // Empty write still counts as one line written (mirrors git's "new file"
        // semantics for create operations).
        let additions = if content.is_empty() {
            1
        } else {
            count_lines(content)
        };
        return Some(EditStats {
            additions,
            deletions: 0,
        });
    }

    if matches!(
        n.as_str(),
        "edit" | "str_replace" | "strreplace" | "replace" | "patch" | "update"
    ) {
        let old_text = text_for(&[
            "old_string",
            "oldString",
            "find",
            "search",
            "match",
            "matchStr",
        ])
        .unwrap_or("");
        let new_text = text_for(&[
            "new_string",
            "newString",
            "replace",
            "replacement",
            "replaceText",
            "replace_with",
        ])
        .unwrap_or("");
        return Some(EditStats {
            additions: count_lines(new_text),
            deletions: count_lines(old_text),
        });
    }

    if matches!(
        n.as_str(),
        "multiedit" | "multi_edit" | "multi_edit_file" | "batch_edit"
    ) {
        let edits = input
            .get("edits")
            .or_else(|| input.get("edit"))
            .or_else(|| input.get("operations"))
            .and_then(|v| v.as_array());
        let mut additions = 0u32;
        let mut deletions = 0u32;
        if let Some(edits) = edits {
            for edit in edits {
                let edit_obj = match edit.as_object() {
                    Some(obj) => obj,
                    None => continue,
                };
                let old_text = edit_obj
                    .get("old_string")
                    .or_else(|| edit_obj.get("oldString"))
                    .or_else(|| edit_obj.get("find"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let new_text = edit_obj
                    .get("new_string")
                    .or_else(|| edit_obj.get("newString"))
                    .or_else(|| edit_obj.get("replace"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                deletions = deletions.saturating_add(count_lines(old_text));
                additions = additions.saturating_add(count_lines(new_text));
            }
        }
        return Some(EditStats {
            additions,
            deletions,
        });
    }

    None
}

/// Generates a CLI-style diff preview (+/-) for Write/Edit/MultiEdit inputs.
/// Returns None for tools that don't represent a textual edit. Truncated to
/// ~DIFF_PREVIEW_MAX_LINES lines / DIFF_PREVIEW_MAX_CHARS chars so the preview
/// is cheap to surface in the transcript and store on disk.
fn diff_preview_for_tool(
    tool_name: &str,
    input: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<String> {
    let input = input?;
    let n = tool_name.to_lowercase();
    let text_for = |keys: &[&str]| -> Option<&str> {
        keys.iter()
            .find_map(|k| input.get(*k).and_then(|v| v.as_str()))
    };

    let mut lines: Vec<String> = Vec::new();

    if matches!(
        n.as_str(),
        "write" | "write_file" | "create_file" | "new_file" | "notebookedit" | "notebook_edit"
    ) {
        let content = text_for(&["content", "file_text", "fileText", "newContent"]).unwrap_or("");
        for line in content.lines() {
            lines.push(format!("+{line}"));
        }
    } else if matches!(
        n.as_str(),
        "edit" | "str_replace" | "strreplace" | "replace" | "patch" | "update"
    ) {
        let old_text = text_for(&[
            "old_string",
            "oldString",
            "find",
            "search",
            "match",
            "matchStr",
        ])
        .unwrap_or("");
        let new_text = text_for(&[
            "new_string",
            "newString",
            "replace",
            "replacement",
            "replaceText",
            "replace_with",
        ])
        .unwrap_or("");
        for line in old_text.lines() {
            lines.push(format!("-{line}"));
        }
        for line in new_text.lines() {
            lines.push(format!("+{line}"));
        }
    } else if matches!(
        n.as_str(),
        "multiedit" | "multi_edit" | "multi_edit_file" | "batch_edit"
    ) {
        let edits = input
            .get("edits")
            .or_else(|| input.get("edit"))
            .or_else(|| input.get("operations"))
            .and_then(|v| v.as_array());
        if let Some(edits) = edits {
            for (idx, edit) in edits.iter().enumerate() {
                let edit_obj = match edit.as_object() {
                    Some(obj) => obj,
                    None => continue,
                };
                let old_text = edit_obj
                    .get("old_string")
                    .or_else(|| edit_obj.get("oldString"))
                    .or_else(|| edit_obj.get("find"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let new_text = edit_obj
                    .get("new_string")
                    .or_else(|| edit_obj.get("newString"))
                    .or_else(|| edit_obj.get("replace"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let header = edits.len() > 1;
                if header {
                    lines.push(format!("@@ edit #{} @@@", idx + 1));
                }
                let mut edit_lines: Vec<String> = Vec::new();
                for line in old_text.lines() {
                    edit_lines.push(format!("-{line}"));
                }
                for line in new_text.lines() {
                    edit_lines.push(format!("+{line}"));
                }
                if edit_lines.len() > DIFF_PREVIEW_PER_EDIT_LINES {
                    edit_lines.truncate(DIFF_PREVIEW_PER_EDIT_LINES);
                    edit_lines.push("...".to_string());
                }
                lines.extend(edit_lines);
            }
        }
    } else {
        return None;
    }

    if lines.is_empty() {
        return None;
    }

    truncate_diff_lines(&lines, DIFF_PREVIEW_MAX_LINES, DIFF_PREVIEW_MAX_CHARS)
}

fn truncate_diff_lines(lines: &[String], max_lines: usize, max_chars: usize) -> Option<String> {
    let mut truncated: Vec<&String> = lines.iter().collect();
    if truncated.len() > max_lines {
        truncated.truncate(max_lines);
        let overflow = lines.len() - max_lines;
        // Build with an explicit trailing "... (N more lines)" marker.
        let mut out = truncated
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        out.push_str(&format!("\n... ({overflow} more lines)"));
        if out.len() > max_chars {
            let mut cut: String = out.chars().take(max_chars.saturating_sub(1)).collect();
            cut.push('…');
            return Some(cut);
        }
        return Some(out);
    }
    let joined = truncated
        .iter()
        .map(|s| s.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if joined.len() > max_chars {
        let mut cut: String = joined.chars().take(max_chars.saturating_sub(1)).collect();
        cut.push('…');
        return Some(cut);
    }
    Some(joined)
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
    use std::process::Command;

    #[test]
    fn edit_stats_line_count_handles_trailing_newline() {
        assert_eq!(count_lines(""), 0);
        assert_eq!(count_lines("one"), 1);
        assert_eq!(count_lines("one\n"), 1);
        assert_eq!(count_lines("one\ntwo"), 2);
        assert_eq!(count_lines("one\ntwo\n"), 2);
    }

    #[test]
    fn edit_stats_for_write_counts_content_lines() {
        let input = json!({"content": "one\ntwo\n"});
        let stats = edit_stats_for_tool("write", input.as_object()).unwrap();
        assert_eq!(stats.additions, 2);
        assert_eq!(stats.deletions, 0);

        let input = json!({"content": ""});
        let stats = edit_stats_for_tool("write_file", input.as_object()).unwrap();
        assert_eq!(stats.additions, 1);
        assert_eq!(stats.deletions, 0);
    }

    #[test]
    fn edit_stats_for_edit_counts_old_and_new_strings() {
        let input = json!({
            "old_string": "old one\nold two\n",
            "new_string": "new one\nnew two\nnew three"
        });
        let stats = edit_stats_for_tool("edit", input.as_object()).unwrap();
        assert_eq!(stats.deletions, 2);
        assert_eq!(stats.additions, 3);

        let input = json!({
            "oldString": "old",
            "newString": "new\n"
        });
        let stats = edit_stats_for_tool("str_replace", input.as_object()).unwrap();
        assert_eq!(stats.deletions, 1);
        assert_eq!(stats.additions, 1);
    }

    #[test]
    fn edit_stats_for_multiedit_sums_edits() {
        let input = json!({
            "edits": [
                {"old_string": "a\nb", "new_string": "c"},
                {"oldString": "d\n", "newString": "e\nf\n"}
            ]
        });
        let stats = edit_stats_for_tool("multiedit", input.as_object()).unwrap();
        assert_eq!(stats.deletions, 3);
        assert_eq!(stats.additions, 3);
    }

    #[test]
    fn edit_stats_ignores_non_edit_tools() {
        let input = json!({"path": "src/main.rs"});
        assert!(edit_stats_for_tool("read", input.as_object()).is_none());
    }

    #[test]
    fn diff_preview_for_write_marks_each_content_line() {
        let input = json!({"content": "one\ntwo\nthree\n"});
        let preview = diff_preview_for_tool("write", input.as_object()).unwrap();
        assert_eq!(preview, "+one\n+two\n+three");

        let input = json!({"content": ""});
        // Empty write yields no diff lines (consistent with edit_stats which
        // still counts it as 1 line written for stat purposes, but the preview
        // has nothing to render).
        assert!(diff_preview_for_tool("write", input.as_object()).is_none());
    }

    #[test]
    fn diff_preview_for_edit_marks_old_and_new_lines() {
        let input = json!({
            "old_string": "old one\nold two\n",
            "new_string": "new one\nnew two\nnew three"
        });
        let preview = diff_preview_for_tool("edit", input.as_object()).unwrap();
        assert_eq!(
            preview,
            "-old one\n-old two\n+new one\n+new two\n+new three"
        );
    }

    #[test]
    fn diff_preview_for_multiedit_joins_edits_with_headers() {
        let input = json!({
            "edits": [
                {"old_string": "a\n", "new_string": "b\nc"},
                {"oldString": "d", "newString": "e"}
            ]
        });
        let preview = diff_preview_for_tool("multiedit", input.as_object()).unwrap();
        assert_eq!(
            preview,
            "@@ edit #1 @@@\n-a\n+b\n+c\n@@ edit #2 @@@\n-d\n+e"
        );
    }

    #[test]
    fn diff_preview_truncates_long_content() {
        let big = (0..100)
            .map(|i| format!("line{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let input = json!({"content": big});
        let preview = diff_preview_for_tool("write", input.as_object()).unwrap();
        // 40 line cap + overflow marker line
        assert!(preview.lines().count() <= DIFF_PREVIEW_MAX_LINES + 1);
        assert!(preview.contains("more lines)"));
        assert!(preview.len() <= DIFF_PREVIEW_MAX_CHARS + 1);
    }

    #[test]
    fn diff_preview_ignores_non_edit_tools() {
        let input = json!({"path": "src/main.rs"});
        assert!(diff_preview_for_tool("read", input.as_object()).is_none());
    }

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
        assert_eq!(clean_terminal_text(input), "{\"result\":\"Hi! 👋\"}");
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
        assert_eq!(
            extract_text(&payload, false),
            Some("hello world".to_string())
        );
    }

    #[test]
    fn extract_text_from_result() {
        let payload = json!({
            "type": "result",
            "result": "Final answer"
        });
        assert_eq!(
            extract_text(&payload, false),
            Some("Final answer".to_string())
        );
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
        assert_eq!(
            extract_text(&payload, false),
            Some("first second".to_string())
        );
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
    fn activity_for_tool_maps_chrome_tools_to_browser() {
        // FRENTE-A (2026-08-02): the Verboo-in-Chrome MCP tools arrive
        // prefixed `mcp__verboo-in-chrome__<tool>` (tool set pinned
        // bidirectionally by services::chrome_tools_canary against
        // extensions/verboo-chrome/src/controller/browserTools.json).
        // Every one must map to kind "browser" with its specific action label.
        for (name, expected_label) in [
            ("navigate", "Navegou no Chrome"),
            ("read_page", "Leu página no Chrome"),
            ("find", "Procurou elementos no Chrome"),
            ("extract_page_content", "Extraiu página completa no Chrome"),
            ("structured_extract", "Extraiu dados no Chrome"),
            ("click", "Clicou no Chrome"),
            ("type", "Digitou no Chrome"),
            ("screenshot", "Capturou tela no Chrome"),
            ("tabs", "Gerenciou abas no Chrome"),
            ("tab_group", "Organizou grupos de abas no Chrome"),
        ] {
            let full = format!("mcp__verboo-in-chrome__{name}");
            let (label, kind) = activity_for_tool(&full);
            assert_eq!(kind, "browser", "tool `{name}` must map to kind browser");
            assert_eq!(
                label, expected_label,
                "tool `{name}` must keep its specific Chrome action label"
            );
        }
    }

    #[test]
    fn activity_for_tool_unknown_chrome_tool_falls_back_to_browser_label() {
        // A verboo-in-chrome tool not (yet) in the manifest must NOT fall
        // through to the generic tool arm: it keeps the browser kind and the
        // branded fallback label.
        let (label, kind) = activity_for_tool("mcp__verboo-in-chrome__future_tool");
        assert_eq!(kind, "browser");
        assert_eq!(label, "Usou o Chrome");
    }

    #[test]
    fn activity_for_tool_other_mcp_server_stays_generic() {
        // Only the verboo-in-chrome server gets the browser presentation. A
        // different MCP server's tool keeps the generic fallback — its tool
        // set is not knowable at compile time.
        let (label, kind) = activity_for_tool("mcp__another_server__navigate");
        assert_eq!(kind, "tool");
        assert_eq!(label, "Usou ferramenta");
    }

    #[test]
    fn activity_for_tool_keeps_existing_arms() {
        // Regression guard — the new chrome branch must not disturb existing arms.
        assert_eq!(activity_for_tool("bash"), ("Executou comando", "command"));
        assert_eq!(activity_for_tool("read"), ("Leu arquivo", "read"));
        assert_eq!(
            activity_for_tool("todowrite"),
            ("Atualizou tarefas", "planning")
        );
    }

    #[test]
    fn runtime_activity_detects_compaction() {
        let payload = json!({
            "type": "stream_event",
            "event": {"delta": {"type": "compaction_delta"}}
        });
        let activity = runtime_activity_from_payload(&payload).unwrap();
        assert_eq!(activity.kind, "compacting");
        assert_eq!(activity.label, "Compacting context…");
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
    fn terminal_failure_captures_auth_error_after_partial_output() {
        let assistant_error = json!({
            "type": "assistant",
            "error": "authentication_failed",
            "session_id": "session-auth-1",
            "message": {
                "content": [{
                    "type": "text",
                    "text": "API Error: 401 {\"error\":\"invalid or expired token\"} · Failed to authenticate."
                }]
            }
        });

        let failure = terminal_failure_from_outcome(
            Some(&assistant_error),
            None,
            Some(1),
            None,
            "(exit=1, runtime=node, cwd=/tmp)",
        )
        .expect("structured auth errors must remain terminal even after text streamed");

        assert_eq!(failure.category, "authentication_failed");
        assert_eq!(failure.session_id.as_deref(), Some("session-auth-1"));
        assert!(failure.message.contains("invalid or expired token"));
        assert_eq!(failure.exit_code, Some(1));
    }

    #[test]
    fn terminal_failure_uses_result_error_even_with_zero_exit_code() {
        let payload = json!({
            "type": "result",
            "subtype": "error_max_turns",
            "session_id": "session-result-1",
            "is_error": true,
            "errors": ["Reached maximum number of turns (3)"]
        });
        let snapshot = to_agent_result_snapshot("turn-result-1", &payload);

        let failure = terminal_failure_from_outcome(
            None,
            Some(&snapshot),
            Some(0),
            None,
            "(exit=0, runtime=node, cwd=/tmp)",
        )
        .expect("result.is_error is authoritative even when the process exits zero");

        assert_eq!(failure.category, "error_max_turns");
        assert!(failure.message.contains("Reached maximum number of turns"));
        assert_eq!(failure.session_id.as_deref(), Some("session-result-1"));
    }

    #[test]
    fn terminal_failure_rejects_zero_exit_without_result_payload() {
        let failure = terminal_failure_from_outcome(
            None,
            None,
            Some(0),
            None,
            "(exit=0, runtime=node, cwd=/tmp)",
        )
        .expect("exit zero without a terminal result is an incomplete turn");

        assert_eq!(failure.category, "incomplete_turn");
        assert!(failure.message.contains("encerrou sem produzir resposta"));
        assert_eq!(failure.exit_code, Some(0));
    }

    #[test]
    fn terminal_failure_rejects_empty_success_after_tool_use() {
        let payload = json!({
            "type": "result",
            "subtype": "success",
            "session_id": "session-incomplete-1",
            "is_error": false,
            "result": "",
            "stop_reason": "tool_use"
        });
        let snapshot = to_agent_result_snapshot("turn-incomplete-1", &payload);

        let failure = terminal_failure_from_outcome(
            None,
            Some(&snapshot),
            Some(0),
            None,
            "(exit=0, runtime=node, cwd=/tmp)",
        )
        .expect("a tool-only success without a final answer is incomplete");

        assert_eq!(failure.category, "incomplete_turn");
        assert_eq!(failure.session_id.as_deref(), Some("session-incomplete-1"));
    }

    #[test]
    fn terminal_failure_reports_unknown_nonzero_exit_after_partial_output() {
        let failure = terminal_failure_from_outcome(
            None,
            None,
            Some(2),
            Some("provider process crashed"),
            "(exit=2, runtime=node, cwd=/tmp)",
        )
        .expect("a nonzero exit must never be hidden by previously streamed text");

        assert_eq!(failure.category, "process_error");
        assert!(failure.message.contains("provider process crashed"));
        assert!(failure.message.contains("exit=2"));
    }

    #[test]
    fn terminal_failure_ignores_stderr_warning_on_success() {
        let payload = json!({
            "type": "result",
            "subtype": "success",
            "session_id": "session-success-1",
            "is_error": false
        });
        let snapshot = to_agent_result_snapshot("turn-success-1", &payload);
        let failure = terminal_failure_from_outcome(
            None,
            Some(&snapshot),
            Some(0),
            Some("configuration warning"),
            "(exit=0, runtime=node, cwd=/tmp)",
        );

        assert!(
            failure.is_none(),
            "stderr alone must not turn a successful turn into an error"
        );
    }

    #[test]
    fn safe_runtime_working_directory_handles_empty() {
        // Without app_data_dir, empty/slash/dot fall back to a neutral
        // temp dir (not home_dir — that was the old behavior that made
        // the CLI scan the user's home on Windows).
        let neutral = std::env::temp_dir().join("verboo-chat");
        let neutral_str = neutral.to_string_lossy().to_string();
        // Empty/slash/dot → neutral workdir
        assert_eq!(safe_runtime_working_directory("", None), neutral_str);
        assert_eq!(safe_runtime_working_directory("/", None), neutral_str);
        assert_eq!(safe_runtime_working_directory(".", None), neutral_str);
        // Existing directories are kept as-is
        let temp_dir = std::env::temp_dir().to_string_lossy().to_string();
        assert_eq!(safe_runtime_working_directory(&temp_dir, None), temp_dir);
        // Non-existent paths fall back to neutral (stale project refs)
        assert_eq!(
            safe_runtime_working_directory("/Users/test/nonexistent-project-xyz", None),
            neutral_str,
            "non-existent directory must fall back to neutral workdir"
        );
    }

    /// (b) Chat novo cwd neutro: when app_data_dir is provided, empty
    /// cwd redirects to `app_data_dir/chat-workdir` (NOT home_dir).
    /// The old code returned `home_dir()` → the CLI scanned the user's
    /// home (or app_data_dir passed by the renderer) and listed
    /// resources/ instead of starting the chat.
    #[test]
    fn safe_runtime_working_directory_neutral_when_app_data_dir_set() {
        let app_data = std::env::temp_dir().join("verboo_test_appdata");
        let expected = app_data.join("chat-workdir");
        let expected_str = expected.to_string_lossy().to_string();

        // Empty cwd → neutral workdir under app_data_dir.
        assert_eq!(
            safe_runtime_working_directory("", Some(&app_data)),
            expected_str
        );
        // "/" and "." → same neutral workdir.
        assert_eq!(
            safe_runtime_working_directory("/", Some(&app_data)),
            expected_str
        );
        assert_eq!(
            safe_runtime_working_directory(".", Some(&app_data)),
            expected_str
        );

        // The neutral workdir is created on demand.
        assert!(
            expected.exists(),
            "neutral workdir should be created on demand"
        );
        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// (b) When the cwd IS the app's own data dir (the renderer passes
    /// it for new chats), redirect to the neutral workdir. This is the
    /// specific field-report scenario: "cwd = AppData\Local\Verboo Code,
    /// modelo listando resources/".
    #[test]
    fn safe_runtime_working_directory_redirects_app_data_dir_to_neutral() {
        let app_data = std::env::temp_dir().join("verboo_test_appdata2");
        let expected = app_data.join("chat-workdir");
        let expected_str = expected.to_string_lossy().to_string();
        let app_data_str = app_data.to_string_lossy().to_string();

        // cwd == app_data_dir → redirect to neutral.
        assert_eq!(
            safe_runtime_working_directory(&app_data_str, Some(&app_data)),
            expected_str,
            "cwd == app_data_dir must redirect to neutral workdir, not be used as-is"
        );

        // A real existing directory is kept as-is.
        let temp_dir = std::env::temp_dir().to_string_lossy().to_string();
        assert_eq!(
            safe_runtime_working_directory(&temp_dir, Some(&app_data)),
            temp_dir
        );
        // A non-existent path falls back to neutral (stale project).
        assert_eq!(
            safe_runtime_working_directory("/Users/test/nonexistent-project-xyz", Some(&app_data)),
            expected_str,
            "non-existent directory must fall back to neutral workdir"
        );

        let _ = std::fs::remove_dir_all(&app_data);
    }

    /// (b) Mutation: revert to ignore app_data_dir (always return
    /// home_dir for empty cwd) → the neutral workdir assertion FAILS.
    /// Named mutation:
    /// `safe_runtime_working_directory_ignores_app_data_dir_uses_home`.
    #[test]
    fn safe_runtime_working_directory_mutation_ignore_app_data_dir_fails() {
        let app_data = std::env::temp_dir().join("verboo_test_appdata3");
        let neutral = app_data.join("chat-workdir");
        let neutral_str = neutral.to_string_lossy().to_string();
        // With app_data_dir set, empty cwd must return the neutral
        // workdir, NOT home_dir. If the mutation reverts to home_dir,
        // this assertion fails (home_dir != neutral).
        let result = safe_runtime_working_directory("", Some(&app_data));
        assert_eq!(
            result, neutral_str,
            "empty cwd with app_data_dir must return neutral workdir; \
             if it returns home_dir, the ignore-app_data_dir mutation is live"
        );
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn build_prompt_first_turn_includes_workspace_and_message() {
        let request = AgentTurnRequest {
            turn_id: None,
            conversation_id: "c1".into(),
            message: "Hello".into(),
            provider_account: None,
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
            run_vision_fallback: None,
            media_capabilities: None,
            cli_media_capabilities: None,
            run_video_analysis: None,
            effort: None,
            reasoning: None,
            annotations: None,
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
            provider_account: None,
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
            run_vision_fallback: None,
            media_capabilities: None,
            cli_media_capabilities: None,
            run_video_analysis: None,
            effort: None,
            annotations: None,
            reasoning: None,
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
            video: None,
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
            video: None,
        }
    }

    #[test]
    fn vision_description_preserves_browser_annotation_instructions() {
        let mut annotation = attachment_with_text(
            "User note (authoritative instruction): Use a cyan border.\nSelector: #hero-cta.",
        );
        annotation.kind = AttachmentKind::BrowserAnnotation;

        merge_vision_description(&mut annotation, "A violet outlined button is visible.".into());

        let text = annotation.extracted_text.unwrap();
        assert!(text.contains("authoritative instruction"));
        assert!(text.contains("Selector: #hero-cta"));
        assert!(text.contains("<visual-description>"));
        assert!(text.contains("violet outlined button"));
    }

    #[test]
    fn vision_description_preserves_simulator_annotation_instructions() {
        let mut annotation = attachment_with_text(
            "User note (authoritative instruction): Increase the spacing.\nSelected component: Button “Save”.",
        );
        annotation.kind = AttachmentKind::SimulatorAnnotation;

        merge_vision_description(&mut annotation, "A native Save button is visible.".into());

        let text = annotation.extracted_text.unwrap();
        assert!(text.contains("authoritative instruction"));
        assert!(text.contains("Button “Save”"));
        assert!(text.contains("<visual-description>"));
        assert!(text.contains("native Save button"));
    }

    #[test]
    fn vision_description_remains_authoritative_for_plain_images() {
        let mut image = attachment_with_text("noisy OCR");
        image.kind = AttachmentKind::Image;

        merge_vision_description(&mut image, "Authoritative visual description".into());

        assert_eq!(
            image.extracted_text.as_deref(),
            Some("Authoritative visual description"),
        );
    }

    #[test]
    fn attachment_lines_inject_extracted_text() {
        let attachments = Some(vec![attachment_with_text("Joao da Silva\nRua X, 123")]);
        let lines = build_attachment_lines(&attachments, LanguageCode::EnUs, None);
        let joined = lines.join("\n");
        assert!(
            joined.contains("Joao da Silva"),
            "should contain extracted text"
        );
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
            video: None,
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
            video: None,
        }
    }

    #[test]
    fn stream_json_input_returns_none_for_non_vision_model() {
        // Even with image attachments, non-vision model → None (positional prompt).
        let request = AgentTurnRequest {
            turn_id: None,
            conversation_id: "c1".into(),
            message: "describe this".into(),
            provider_account: None,
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
            run_vision_fallback: None,
            media_capabilities: None,
            cli_media_capabilities: None,
            run_video_analysis: None,
            effort: None,
            reasoning: None,
            annotations: None,
        };
        let payload = build_stream_json_input(&request, "prompt text");
        assert!(
            payload.is_none(),
            "non-vision model should not get stream-json"
        );
    }

    #[test]
    fn stream_json_input_returns_none_for_text_only_turn() {
        // Vision model but no image attachments → None (positional prompt).
        let request = AgentTurnRequest {
            turn_id: None,
            conversation_id: "c1".into(),
            message: "hello".into(),
            provider_account: None,
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
            run_vision_fallback: None,
            media_capabilities: None,
            cli_media_capabilities: None,
            run_video_analysis: None,
            effort: None,
            reasoning: None,
            annotations: None,
        };
        let payload = build_stream_json_input(&request, "prompt text");
        assert!(
            payload.is_none(),
            "text-only turn should not get stream-json"
        );
    }

    #[test]
    fn stream_json_input_returns_none_when_vision_unknown() {
        // model_supports_vision == None (unknown) → don't risk stream-json.
        let request = AgentTurnRequest {
            turn_id: None,
            conversation_id: "c1".into(),
            message: "hello".into(),
            provider_account: None,
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
            run_vision_fallback: None,
            media_capabilities: None,
            cli_media_capabilities: None,
            run_video_analysis: None,
            effort: None,
            reasoning: None,
            annotations: None,
        };
        let payload = build_stream_json_input(&request, "prompt text");
        assert!(
            payload.is_none(),
            "unknown vision should not get stream-json"
        );
    }

    #[test]
    fn stream_json_input_builds_payload_with_visual_attachments_for_vision_model() {
        // Vision model + image/browser annotation → one image block per visual.
        // Use a real temp file so base64 encoding has data to read.
        let temp = std::env::temp_dir().join(format!(
            "verboo-test-stream-{}.png",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&temp, b"fake-png-bytes").unwrap();
        let mut annotation = image_attachment(temp.to_str().unwrap(), "image/png");
        annotation.kind = AttachmentKind::BrowserAnnotation;
        annotation.name = "browser-annotation.png".into();
        let request = AgentTurnRequest {
            turn_id: None,
            conversation_id: "c1".into(),
            message: "describe this image".into(),
            provider_account: None,
            model: Some("claude-sonnet-4-6".into()),
            model_supports_vision: Some(true),
            context_window: None,
            response_language: Some(LanguageCode::EnUs),
            access_mode: crate::models::types::AccessMode::Approval,
            working_directory: "/tmp".into(),
            skills: Vec::new(),
            attachments: Some(vec![
                image_attachment(temp.to_str().unwrap(), "image/png"),
                annotation,
            ]),
            response_enhancements_enabled: None,
            personality: None,
            custom_instructions: None,
            memory_context: None,
            run_vision_fallback: None,
            media_capabilities: None,
            cli_media_capabilities: None,
            run_video_analysis: None,
            effort: None,
            reasoning: None,
            annotations: None,
        };
        let payload = build_stream_json_input(&request, "prompt text here");
        assert!(
            payload.is_some(),
            "vision model + image should get stream-json"
        );
        let payload = payload.unwrap();
        // The CLI's StructuredIO.processLine requires the envelope:
        // {type:"user", message:{role:"user", content:[...]}, parent_tool_use_id:null}
        let parsed: serde_json::Value = serde_json::from_str(payload.trim()).unwrap();
        assert_eq!(parsed["type"], "user", "envelope type must be user");
        assert_eq!(parsed["session_id"], "", "session_id must be empty string");
        assert_eq!(parsed["parent_tool_use_id"], serde_json::Value::Null);
        let message = &parsed["message"];
        assert_eq!(message["role"], "user");
        let content = message["content"].as_array().unwrap();
        assert_eq!(content.len(), 3, "should have text + two visual blocks");
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "prompt text here");
        // Image block uses Anthropic-style source.base64 (raw b64, no data: URL).
        let img_block = content
            .iter()
            .find(|b| b["type"] == "image")
            .expect("should have image block");
        assert_eq!(img_block["source"]["type"], "base64");
        assert_eq!(img_block["source"]["media_type"], "image/png");
        let data = img_block["source"]["data"].as_str().unwrap();
        assert!(!data.is_empty(), "base64 data must not be empty");
        assert!(
            !data.starts_with("data:"),
            "base64 data must NOT be a data: URL — CLI expects raw base64"
        );
        assert_eq!(
            content.iter().filter(|block| block["type"] == "image").count(),
            2,
            "browser annotation must use the same capability-based vision route",
        );
        let _ = std::fs::remove_file(&temp);
    }

    #[test]
    fn stream_json_input_skips_unreadable_images() {
        // Image path doesn't exist → skip that image, still send text.
        let request = AgentTurnRequest {
            turn_id: None,
            conversation_id: "c1".into(),
            message: "describe".into(),
            provider_account: None,
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
            run_vision_fallback: None,
            media_capabilities: None,
            cli_media_capabilities: None,
            run_video_analysis: None,
            effort: None,
            reasoning: None,
            annotations: None,
        };
        let payload = build_stream_json_input(&request, "prompt text");
        // No readable images → None (falls back to positional prompt).
        assert!(
            payload.is_none(),
            "unreadable images should fall back to positional"
        );
    }

    // ── FASE 1: vision fallback wiring tests ─────────────────────────
    //
    // These test the consent gating + early-return logic of
    // `maybe_run_vision_fallback`. The full flow (spawn secondary CLI,
    // describe image, cache) is covered by vision_fallback_service tests.

    fn make_turn_service() -> TurnService {
        TurnService::new(std::sync::Arc::new(CredentialsStore::new()))
    }

    // ── resolve_effort_arg: CLI argument resolution contract ──────────
    //
    // Four scenarios required by the effort contract:
    //   1. Override absent → no --effort (CLI applies default_effort).
    //   2. Override valid (∈ effort_levels) → --effort <level>.
    //   3. Override "none" AND "none" ∈ effort_levels → --effort none.
    //   4. Override "none" but "none" ∉ effort_levels → no --effort.
    // Plus: stale/invalid override (not in effort_levels) → no --effort.
    // Plus: model without reasoning → no --effort regardless of override.

    fn reasoning(levels: &[&str], default: Option<&str>) -> ModelReasoning {
        ModelReasoning {
            effort_levels: levels.iter().map(|s| s.to_string()).collect(),
            default_effort: default.map(|s| s.to_string()),
        }
    }

    #[test]
    fn resolve_effort_arg_missing_override_returns_none() {
        // Scenario 1: no saved override → omit --effort.
        let r = reasoning(&["low", "medium", "high"], Some("high"));
        assert_eq!(resolve_effort_arg(None, Some(&r)), None);
        // Empty/whitespace override is also "absent".
        assert_eq!(resolve_effort_arg(Some(""), Some(&r)), None);
        assert_eq!(resolve_effort_arg(Some("   "), Some(&r)), None);
    }

    #[test]
    fn resolve_effort_arg_valid_override_returns_level() {
        // Scenario 2: override ∈ effort_levels → send --effort <level>.
        let r = reasoning(&["low", "medium", "high", "max"], Some("high"));
        assert_eq!(
            resolve_effort_arg(Some("high"), Some(&r)),
            Some("high".into())
        );
        assert_eq!(
            resolve_effort_arg(Some("max"), Some(&r)),
            Some("max".into())
        );
        assert_eq!(
            resolve_effort_arg(Some("low"), Some(&r)),
            Some("low".into())
        );
        // Case-insensitive: user override "HIGH" matches level "high".
        assert_eq!(
            resolve_effort_arg(Some("HIGH"), Some(&r)),
            Some("high".into())
        );
    }

    #[test]
    fn resolve_effort_arg_explicit_none_when_offered_is_sent() {
        // Scenario 3: "none" is a real level (offered by the model) →
        // send --effort none (do NOT discard as empty).
        let r = reasoning(&["none", "low", "medium", "high"], Some("none"));
        assert_eq!(
            resolve_effort_arg(Some("none"), Some(&r)),
            Some("none".into())
        );
        // Case-insensitive.
        assert_eq!(
            resolve_effort_arg(Some("None"), Some(&r)),
            Some("none".into())
        );
    }

    #[test]
    fn resolve_effort_arg_none_not_offered_is_dropped() {
        // Scenario 4: "none" NOT in effort_levels → invalid override →
        // no --effort (CLI applies default_effort).
        let r = reasoning(&["low", "medium", "high"], Some("high"));
        assert_eq!(resolve_effort_arg(Some("none"), Some(&r)), None);
    }

    #[test]
    fn resolve_effort_arg_stale_override_dropped() {
        // Override saved for an older model that no longer offers "max" →
        // invalid against current capability → no --effort.
        let r = reasoning(&["low", "medium", "high"], Some("medium"));
        assert_eq!(resolve_effort_arg(Some("max"), Some(&r)), None);
        // Unknown level string entirely.
        assert_eq!(resolve_effort_arg(Some("xhigh"), Some(&r)), None);
    }

    #[test]
    fn resolve_effort_arg_no_reasoning_returns_none() {
        // Model without reasoning capability (kimi/minimax) → no --effort
        // regardless of override.
        assert_eq!(resolve_effort_arg(Some("high"), None), None);
        assert_eq!(resolve_effort_arg(Some("none"), None), None);
        assert_eq!(resolve_effort_arg(None, None), None);
    }

    // ── build_cli_args: integration test for the final CLI arg vector ──
    //
    // Proves the effort contract end-to-end at the arg-building layer
    // (the real spawn path calls `build_cli_args` then hands the vec to
    // `CliSpawn::new(&args)`). No process is spawned — we assert the
    // presence/absence of `--effort` in the final vector.

    fn base_turn_request(
        effort: Option<&str>,
        reasoning: Option<ModelReasoning>,
    ) -> AgentTurnRequest {
        AgentTurnRequest {
            turn_id: None,
            conversation_id: "c1".into(),
            message: "hello".into(),
            provider_account: None,
            model: Some("ultra/glm-5.2".into()),
            model_supports_vision: None,
            run_vision_fallback: None,
            media_capabilities: None,
            cli_media_capabilities: None,
            run_video_analysis: None,
            effort: effort.map(|s| s.to_string()),
            reasoning,
            context_window: None,
            response_language: Some(LanguageCode::EnUs),
            access_mode: crate::models::types::AccessMode::Approval,
            working_directory: "/tmp".into(),
            skills: Vec::new(),
            attachments: None,
            response_enhancements_enabled: None,
            personality: None,
            custom_instructions: None,
            memory_context: None,
            annotations: None,
        }
    }

    fn assert_no_effort_flag(args: &[String]) {
        // The CLI 0.12 has a static allowlist on `--effort` that rejects
        // "none" and future router levels. We transport effort exclusively
        // via `CLAUDE_CODE_EFFORT_LEVEL` env var, so `--effort` must NEVER
        // appear in the arg vector.
        assert!(
            !args.iter().any(|a| a == "--effort"),
            "--effort flag must NOT be in args (transport is env-only), but was: {:?}",
            args
        );
    }

    #[test]
    fn build_cli_args_default_no_effort_no_env() {
        // Scenario 1: no override → no --effort flag, no env var.
        let r = reasoning(&["low", "medium", "high"], Some("high"));
        let req = base_turn_request(None, Some(r));
        let args = build_cli_args(&req, "hello", None, false);
        assert_no_effort_flag(&args);
        assert_eq!(
            resolve_effort_env(req.effort.as_deref(), req.reasoning.as_ref()),
            None,
            "no override → no env var"
        );
        // Sanity: core args still present.
        assert!(args.contains(&"--print".to_string()));
        assert!(args.contains(&"--model".to_string()));
    }

    #[test]
    fn build_cli_args_valid_high_env_only_no_flag() {
        // Scenario 2: valid override "high" → env=high, no --effort flag.
        let r = reasoning(&["low", "medium", "high", "max"], Some("high"));
        let req = base_turn_request(Some("high"), Some(r));
        let args = build_cli_args(&req, "hello", None, false);
        assert_no_effort_flag(&args);
        assert_eq!(
            resolve_effort_env(req.effort.as_deref(), req.reasoning.as_ref()),
            Some("high".to_string()),
            "valid override → env var set"
        );
    }

    #[test]
    fn build_cli_args_valid_none_env_only_no_flag() {
        // Scenario 3: "none" ∈ effort_levels → env=none, no --effort flag.
        // The CLI 0.12 would reject `--effort none` (static allowlist), but
        // accepts `CLAUDE_CODE_EFFORT_LEVEL=none` (dynamic validation).
        let r = reasoning(&["none", "low", "medium", "high"], Some("none"));
        let req = base_turn_request(Some("none"), Some(r));
        let args = build_cli_args(&req, "hello", None, false);
        assert_no_effort_flag(&args);
        assert_eq!(
            resolve_effort_env(req.effort.as_deref(), req.reasoning.as_ref()),
            Some("none".to_string()),
            "valid 'none' → env var set (not discarded)"
        );
    }

    #[test]
    fn build_cli_args_stale_override_no_env_no_flag() {
        // Scenario 4: override "max" but model no longer offers it → no env, no flag.
        let r = reasoning(&["low", "medium", "high"], Some("medium"));
        let req = base_turn_request(Some("max"), Some(r));
        let args = build_cli_args(&req, "hello", None, false);
        assert_no_effort_flag(&args);
        assert_eq!(
            resolve_effort_env(req.effort.as_deref(), req.reasoning.as_ref()),
            None,
            "stale override → no env var"
        );
    }

    #[test]
    fn build_cli_args_include_explicit_account_and_fork_only_on_resume() {
        let mut request = request_with_message("hello");
        request.provider_account = Some(crate::models::types::ProviderTurnAccount {
            provider: "codex".into(),
            account_id: "local-b".into(),
            fork_session: true,
        });
        let args = build_cli_args(&request, "hello", Some("session-a"), false);
        assert!(args.windows(2).any(|pair| {
            pair[0] == "--provider-account" && pair[1] == "local-b"
        }));
        assert!(args.iter().any(|arg| arg == "--fork-session"));

        let fresh = build_cli_args(&request, "hello", None, false);
        assert!(!fresh.iter().any(|arg| arg == "--fork-session"));
    }

    fn request_with_image(vision: Option<bool>) -> AgentTurnRequest {
        AgentTurnRequest {
            turn_id: None,
            conversation_id: "c1".into(),
            message: "describe this".into(),
            provider_account: None,
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
            run_vision_fallback: None,
            media_capabilities: None,
            cli_media_capabilities: None,
            run_video_analysis: None,
            effort: None,
            reasoning: None,
            annotations: None,
        }
    }

    #[test]
    fn vision_fallback_skips_when_model_supports_vision() {
        // Vision-capable model → fallback should NOT run (images go via
        // stream-json FASE 0 path instead).
        let svc = make_turn_service();
        let mut req = request_with_image(Some(true));
        // The attachment starts with no extracted_text.
        assert!(req.attachments.as_ref().unwrap()[0]
            .extracted_text
            .is_none());
        // maybe_run_vision_fallback is only called when vision != Some(true),
        // so we simulate that check here.
        if req.model_supports_vision != Some(true) {
            svc.maybe_run_vision_fallback(None, "test-turn", &mut req);
        }
        // Vision model → fallback not called → extracted_text still None.
        assert!(
            req.attachments.as_ref().unwrap()[0]
                .extracted_text
                .is_none(),
            "vision model should not trigger fallback"
        );
    }

    #[test]
    fn vision_fallback_skips_when_no_image_attachments() {
        // No images → fallback should not run even for non-vision model.
        let svc = make_turn_service();
        let mut req = request_with_image(Some(false));
        req.attachments = Some(vec![file_attachment("/tmp/doc.md")]);
        svc.maybe_run_vision_fallback(None, "test-turn", &mut req);
        // File attachment unchanged (no image to describe).
        assert!(
            req.attachments.as_ref().unwrap()[0]
                .extracted_text
                .as_deref()
                == Some("text content"),
            "file attachment should be unchanged"
        );
    }

    #[test]
    fn vision_fallback_skips_when_override_disables_it() {
        // The FE can pass `run_vision_fallback: Some(false)` to skip the
        // fallback regardless of consent (e.g. one-off turn under Always
        // where the user explicitly chose not to describe). The override
        // takes priority over the consent setting.
        let svc = make_turn_service(); // app_data_dir = None, settings = None
        let mut req = request_with_image(Some(false));
        req.run_vision_fallback = Some(false);
        svc.maybe_run_vision_fallback(None, "test-turn", &mut req);
        assert!(
            req.attachments.as_ref().unwrap()[0]
                .extracted_text
                .is_none(),
            "run_vision_fallback=Some(false) → fallback must skip and leave extracted_text empty"
        );
    }

    #[test]
    fn vision_fallback_runs_under_ask_when_override_allows() {
        // Override Some(true) forces the fallback even when consent would
        // otherwise skip. Without app_data_dir the runner bails early, but
        // the consent gate itself is bypassed — we observe that by checking
        // the function injected a warning (it would not have under Never).
        let svc = make_turn_service(); // app_data_dir = None
        let mut req = request_with_image(Some(false));
        req.run_vision_fallback = Some(true);
        svc.maybe_run_vision_fallback(None, "test-turn", &mut req);
        let att = &req.attachments.as_ref().unwrap()[0];
        assert!(
            att.extracted_text.is_some(),
            "run_vision_fallback=Some(true) should bypass consent and reach the app_data_dir check, which then injects a warning"
        );
        assert_eq!(
            att.extraction_status,
            Some(crate::models::types::ExtractionStatus::Warning)
        );
    }

    #[test]
    fn vision_fallback_does_not_require_cli_path_env_var() {
        // Regression test for the critical bug where `maybe_run_vision_fallback`
        // used `cli_path::resolve()` which returns None in the packaged app
        // (no VERBOO_CLI_PATH env var). The fix removed that check — the
        // fallback now uses `CliSpawn` internally (same as the main turn).
        //
        // We set app_data_dir and force the override on so the function
        // proceeds past consent + app_data_dir. It will reach the catalog
        // load and either succeed (dev machine with token) or inject a
        // "couldn't be loaded" warning. Either way, it must NOT panic and
        // must NOT early-return because of cli_path. Compile-time guarantee
        // is also enforced: `describe_image` no longer takes a cli_path arg.
        let svc = TurnService::new(std::sync::Arc::new(CredentialsStore::new()))
            .with_app_data_dir(std::env::temp_dir());
        let mut req = request_with_image(Some(false));
        req.run_vision_fallback = Some(true);
        svc.maybe_run_vision_fallback(None, "test-turn", &mut req);
        // The function must have proceeded past the consent check and reached
        // the model catalog load. Whether it injected a description (token
        // available) or a warning (no token), extracted_text must be Some.
        assert!(
            req.attachments.as_ref().unwrap()[0].extracted_text.is_some(),
            "override=true + app_data_dir set → fallback must reach catalog load (not early-return on cli_path)"
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
        svc.maybe_run_vision_fallback(None, "test-turn", &mut req);

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
    fn interrupt_returns_false_for_unknown_conversation() {
        // Precise interrupt: unknown conversation_id → no-op (no fallback
        // to any active turn). This is the core safety guarantee of A1.
        let svc = make_turn_service();
        let result = svc.interrupt(Some("unknown-conv".into())).unwrap();
        assert!(
            !result,
            "interrupt for unknown conversation must be a no-op"
        );
    }

    #[test]
    fn interrupt_cancels_the_matching_video_job_before_cli_lookup() {
        let temp = tempfile::TempDir::new().unwrap();
        let registry = crate::services::video::job::VideoJobRegistry::new(temp.path()).unwrap();
        let job = registry.start("video-conversation").unwrap();
        let directory = job.directory().to_path_buf();
        let service =
            TurnService::new(Arc::new(CredentialsStore::new())).with_video_job_registry(registry);

        assert!(service
            .interrupt(Some("video-conversation".to_string()))
            .unwrap());
        assert!(job.is_cancelled());
        assert!(!directory.exists());
    }

    #[test]
    fn active_by_conversation_map_registers_and_clears() {
        // Verify the map is populated on send_turn and cleared on Done.
        // We can't call send_turn in a unit test (it spawns a real CLI),
        // but we can test the map directly.
        let svc = make_turn_service();
        {
            let mut map = svc.active_by_conversation.lock().unwrap();
            map.insert("conv-a".into(), "turn-1".into());
            map.insert("conv-b".into(), "turn-2".into());
        }
        // interrupt conv-a should look up turn-1 (not turn-2).
        // Since no child is registered in `active`, interrupt returns false
        // but the lookup itself proves the map is correct.
        let result = svc.interrupt(Some("conv-a".into())).unwrap();
        assert!(
            !result,
            "no child registered → false, but lookup was correct"
        );

        // Clear conv-a's mapping (simulating Done).
        {
            let mut map = svc.active_by_conversation.lock().unwrap();
            map.remove("conv-a");
        }
        // Now interrupt conv-a → false (no mapping).
        let result = svc.interrupt(Some("conv-a".into())).unwrap();
        assert!(!result, "cleared mapping → false");
    }

    fn spawn_sleeping_test_child() -> std::process::Child {
        #[cfg(unix)]
        return Command::new("sh")
            .args(["-c", "sleep 5"])
            .spawn()
            .unwrap();

        #[cfg(windows)]
        return Command::new("cmd")
            .args(["/C", "ping -n 6 127.0.0.1 >NUL"])
            .spawn()
            .unwrap();
    }

    #[test]
    fn active_count_reports_all_cli_children() {
        let service = make_turn_service();
        assert_eq!(service.active_count().unwrap(), 0);

        let child = Arc::new(Mutex::new(spawn_sleeping_test_child()));
        service
            .active
            .lock()
            .unwrap()
            .insert("turn-a".into(), child.clone());
        assert_eq!(service.active_count().unwrap(), 1);

        let mut child = child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn active_count_includes_a_turn_before_its_cli_child_spawns() {
        let service = make_turn_service();
        service
            .active_by_conversation
            .lock()
            .unwrap()
            .insert("conversation-preparing".into(), "turn-preparing".into());

        assert_eq!(service.active_count().unwrap(), 1);
    }

    #[test]
    fn active_count_fails_closed_when_registry_is_poisoned() {
        let service = make_turn_service();
        let active = service.active.clone();
        let _ = std::thread::spawn(move || {
            let _guard = active.lock().unwrap();
            panic!("poison active turn registry");
        })
        .join();

        assert!(service.active_count().is_err());
    }

    #[test]
    fn update_install_admission_observes_a_turn_registered_in_parallel() {
        use std::sync::Barrier;

        let service = Arc::new(make_turn_service());
        let registered = Arc::new(Barrier::new(2));
        let release_registration = Arc::new(Barrier::new(2));

        let turn_service = service.clone();
        let turn_registered = registered.clone();
        let turn_release = release_registration.clone();
        let turn = std::thread::spawn(move || {
            let _registration = turn_service
                .update_install_gate
                .begin_turn_registration()
                .unwrap();
            turn_service
                .active_by_conversation
                .lock()
                .unwrap()
                .insert("conversation".into(), "turn".into());
            turn_registered.wait();
            turn_release.wait();
        });

        registered.wait();
        let install_service = service.clone();
        let install =
            std::thread::spawn(move || install_service.begin_update_install());

        release_registration.wait();
        turn.join().unwrap();
        match install.join().unwrap().unwrap() {
            UpdateInstallAdmission::Busy { active_turns } => assert_eq!(active_turns, 1),
            UpdateInstallAdmission::Ready(_) => panic!("install bypassed turn registration"),
        }
    }

    #[test]
    fn active_update_install_blocks_new_turn_registration_until_lease_drops() {
        let service = make_turn_service();
        let lease = match service
            .update_install_gate
            .begin_install(|| Ok(0))
            .unwrap()
        {
            UpdateInstallAdmission::Ready(lease) => lease,
            UpdateInstallAdmission::Busy { .. } => panic!("unexpected active turn"),
        };

        assert!(service
            .update_install_gate
            .begin_turn_registration()
            .is_err());
        drop(lease);
        assert!(service
            .update_install_gate
            .begin_turn_registration()
            .is_ok());
    }

    #[test]
    fn committed_update_install_keeps_turn_gate_closed_until_process_exit() {
        let service = make_turn_service();
        let lease = match service.begin_update_install().unwrap() {
            UpdateInstallAdmission::Ready(lease) => lease,
            UpdateInstallAdmission::Busy { .. } => panic!("unexpected active turn"),
        };

        lease.keep_until_process_exit();

        assert!(service
            .update_install_gate
            .begin_turn_registration()
            .is_err());
    }

    #[test]
    fn interrupt_does_not_fallback_to_any_active_turn() {
        // CRITICAL: even if there IS an active turn for conv-b, interrupting
        // conv-a (which has no mapping) must NOT kill conv-b's turn.
        let svc = make_turn_service();
        {
            let mut map = svc.active_by_conversation.lock().unwrap();
            map.insert("conv-b".into(), "turn-2".into());
        }
        // interrupt conv-a (unknown) → false, NOT conv-b's turn.
        let result = svc.interrupt(Some("conv-a".into())).unwrap();
        assert!(!result, "must NOT fall back to conv-b's turn");
    }

    #[cfg(unix)]
    #[test]
    fn interrupt_escalates_when_cli_ignores_sigint() {
        let service = make_turn_service();
        let child = std::process::Command::new("sh")
            .args(["-c", "trap '' INT; while :; do sleep 1; done"])
            .spawn()
            .unwrap();
        let child_handle = Arc::new(Mutex::new(child));
        service
            .active
            .lock()
            .unwrap()
            .insert("turn-stuck".into(), child_handle.clone());
        service
            .active_by_conversation
            .lock()
            .unwrap()
            .insert("conversation-stuck".into(), "turn-stuck".into());
        std::thread::sleep(std::time::Duration::from_millis(100));

        assert!(service
            .interrupt(Some("conversation-stuck".into()))
            .unwrap());
        std::thread::sleep(std::time::Duration::from_millis(1_200));

        let status = child_handle.lock().unwrap().try_wait().unwrap();
        assert!(status.is_some(), "stubborn CLI must be force-killed after the grace period");
    }

    #[test]
    fn compaction_detection_cli_informational() {
        // Real shape from cli.mjs convertStatusMessage when status === "compacting":
        // {"type":"system","subtype":"informational","content":"Compacting conversation…"}
        let payload = json!({
            "type": "system",
            "subtype": "informational",
            "content": "Compacting conversation…"
        });
        assert!(is_compaction_payload(&payload));
        let activity = runtime_activity_from_payload(&payload).unwrap();
        assert_eq!(activity.kind, "compacting");
        assert_eq!(activity.label, "Compacting context…");
        assert!(
            activity.detail.is_none(),
            "informational phase has no detail"
        );
    }

    #[test]
    fn compaction_detection_cli_compact_boundary() {
        // Real shape from cli.mjs after compact:
        // {"type":"system","subtype":"compact_boundary","content":"Conversation compacted","compactMetadata":{...}}
        let payload = json!({
            "type": "system",
            "subtype": "compact_boundary",
            "content": "Conversation compacted",
            "compactMetadata": {
                "trigger": "auto",
                "preTokens": 150000,
                "postTokens": 80000
            }
        });
        assert!(is_compaction_payload(&payload));
        let activity = runtime_activity_from_payload(&payload).unwrap();
        assert_eq!(activity.kind, "compacting");
        assert_eq!(activity.label, "Context compacted");
        assert_eq!(activity.detail.as_deref(), Some("done"));
    }

    #[test]
    fn compaction_detection_anthropic_stream_event() {
        // Anthropic raw stream-json (rare in bundled CLI but kept for compat):
        // {"type":"stream_event","event":{"delta":{"type":"compaction_delta"}}}
        let payload = json!({
            "type": "stream_event",
            "event": {
                "delta": { "type": "compaction_delta" }
            }
        });
        assert!(is_compaction_payload(&payload));
        let activity = runtime_activity_from_payload(&payload).unwrap();
        assert_eq!(activity.kind, "compacting");
    }

    #[test]
    fn compaction_detection_case_insensitive_and_ellipsis_variants() {
        // Defensive: case-insensitive, handles … vs ...
        let lower = json!({"type":"system","subtype":"informational","content":"compacting conversation..."});
        assert!(is_compaction_payload(&lower));

        let upper =
            json!({"type":"system","subtype":"INFORMATIONAL","content":"COMPACTING CONVERSATION…"});
        assert!(is_compaction_payload(&upper));
    }

    #[test]
    fn compaction_detection_rejects_non_compact_system_messages() {
        // System messages that aren't about compaction must not trigger.
        let payload = json!({
            "type": "system",
            "subtype": "informational",
            "content": "Session started"
        });
        assert!(!is_compaction_payload(&payload));
        assert!(runtime_activity_from_payload(&payload).is_none());
    }

    #[test]
    fn compaction_detection_status_field() {
        // Some CLI versions put status:"compacting" on system messages.
        let payload = json!({
            "type": "system",
            "subtype": "status",
            "status": "compacting"
        });
        assert!(is_compaction_payload(&payload));
    }

    #[test]
    fn vision_relay_detail_format_is_pipe_delimited() {
        // The FE parses `detail` as `vision-relay|<primary_id>|<primary_display>|<helper_id>|<helper_display>`.
        // Pipe is safe because model ids never contain `|`. This test pins
        // the format so a refactor can't silently break the FE parser.
        let primary_id = "glm-5.2";
        let primary_display = "glm-5.2";
        let helper_id = "ultra/kimi-k2.7";
        let helper_display = "Kimi K2.7";
        let detail =
            format!("vision-relay|{primary_id}|{primary_display}|{helper_id}|{helper_display}");
        let parts: Vec<&str> = detail.split('|').collect();
        assert_eq!(parts.len(), 5, "must have exactly 5 pipe-delimited parts");
        assert_eq!(parts[0], "vision-relay");
        assert_eq!(parts[1], primary_id);
        assert_eq!(parts[2], primary_display);
        assert_eq!(parts[3], helper_id);
        assert_eq!(parts[4], helper_display);
        // No image description text in the detail.
        assert!(!detail.contains("description"));
        assert!(!detail.contains("base64"));
    }

    #[test]
    fn vision_relay_key_is_stable_per_turn() {
        // The FE dedupes by key — the relay key must be deterministic per turn
        // so re-emitting (e.g. after helper success) doesn't create a second row.
        let turn_id = "turn-abc-123";
        let key = format!("{turn_id}:vision-relay");
        assert_eq!(key, "turn-abc-123:vision-relay");
        // Same turn_id always produces the same key.
        assert_eq!(format!("{turn_id}:vision-relay"), key);
    }

    #[test]
    fn vision_fallback_warning_is_anti_hallucination() {
        // On machines without a CLI token, the fallback injects a warning
        // that must tell the model NOT to invent content. On machines WITH
        // a token and vision models in the plan, a description is injected
        // (Extracted) — the anti-hallucination check only applies to warnings.
        let svc = make_turn_service_with_always_consent();
        let mut req = request_with_image(Some(false));
        svc.maybe_run_vision_fallback(None, "test-turn", &mut req);

        let att = &req.attachments.as_ref().unwrap()[0];
        let text = att.extracted_text.as_ref().unwrap();
        // If it's a warning (not a real description), it must contain
        // anti-hallucination language. If it's a real description (Extracted),
        // the check doesn't apply.
        if att.extraction_status == Some(crate::models::types::ExtractionStatus::Warning) {
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
        assert_eq!(
            att.extracted_text.as_deref(),
            Some("Test warning: no catalog.")
        );
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
        req.attachments.as_mut().unwrap()[0].extracted_text = Some("Already described.".into());
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
        req.attachments
            .as_mut()
            .unwrap()
            .push(file_attachment("/tmp/doc.md"));
        svc.inject_fallback_warning(&mut req, "Test warning.");

        // Image (index 0) gets the warning.
        assert_eq!(
            req.attachments.as_ref().unwrap()[0]
                .extracted_text
                .as_deref(),
            Some("Test warning.")
        );
        // File (index 1) keeps its original text.
        assert_eq!(
            req.attachments.as_ref().unwrap()[1]
                .extracted_text
                .as_deref(),
            Some("text content")
        );
    }

    // ── D-D (2026-07-31) field fix: slash commands bypass prompt prefix ──
    //
    // The CLI's native command interceptor fires only when the user
    // message STARTS with a recognized slash token (MEDICAO 2026-07-30:
    // /compact → status:"compacting"; /nonexistent → "Unknown skill"
    // in 9ms with no API call). `build_prompt_internal` normally
    // prefixes with the workspace header (`Current working
    // directory: ...`) and, on the first-turn path, with the full
    // app instructions block — that prefix breaks the intercept.
    //
    // The fix returns the raw message as the entire prompt when the
    // head token is one of `RESERVED_SLASH_COMMANDS`. These tests pin
    // both sides of the contract:

    fn request_with_message(message: &str) -> AgentTurnRequest {
        AgentTurnRequest {
            turn_id: None,
            conversation_id: "c1".into(),
            message: message.into(),
            provider_account: None,
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
            run_vision_fallback: None,
            media_capabilities: None,
            cli_media_capabilities: None,
            run_video_analysis: None,
            effort: None,
            reasoning: None,
            annotations: None,
        }
    }

    #[test]
    fn build_prompt_reserved_slash_compact_bypasses_prefix_on_resume() {
        // CONTRAFACTUAL EVIDENCE: a reserved slash command on the
        // resume path (where the bug surfaced) must arrive at the CLI
        // starting with `/compact` and WITHOUT the workspace header.
        // Before the fix, the prompt started with "Current working
        // directory: /tmp" and the CLI's interceptor never fired.
        let req = request_with_message("/compact preserve old memory");
        let prompt = build_prompt(&req, /* is_resume = */ true);
        assert!(
            prompt.starts_with("/compact"),
            "reserved slash command must be at prompt head — got: {prompt:?}"
        );
        assert!(
            !prompt.contains("Current working directory:"),
            "workspace header must NOT prefix reserved slash commands — got: {prompt:?}"
        );
        assert!(
            !prompt.contains("Diretório de trabalho atual:"),
            "PT-BR workspace header must NOT prefix reserved slash commands — got: {prompt:?}"
        );
        // Whole-prompt equality: the bypass returns the message RAW.
        assert_eq!(prompt, "/compact preserve old memory");
    }

    #[test]
    fn build_prompt_reserved_slash_compact_bypasses_prefix_on_first_turn() {
        // The non-resume path prefixes with the full app instructions
        // block — even worse for intercept. The bypass must apply on
        // BOTH paths or /compact still won't fire from the user's
        // first message of a session.
        let req = request_with_message("/compact");
        let prompt = build_prompt(&req, /* is_resume = */ false);
        assert!(
            prompt.starts_with("/compact"),
            "reserved slash command must be at prompt head — got: {prompt:?}"
        );
        assert_eq!(prompt, "/compact");
    }

    #[test]
    fn build_prompt_normal_message_still_gets_workspace_prefix_on_resume() {
        // Counterfactual: the bypass is reserved-command-only. A
        // normal message MUST still get the prefix or the existing
        // workspace-context guarantee (test
        // `build_prompt_resume_omits_app_instructions` at line 3845)
        // silently regresses. This test is the load-bearing one for
        // "don't break the normal case".
        let req = request_with_message("Hello");
        let prompt = build_prompt(&req, /* is_resume = */ true);
        assert!(
            prompt.contains("Current working directory: /tmp"),
            "normal message on resume path MUST keep workspace header — got: {prompt:?}"
        );
        assert!(
            !prompt.starts_with("Hello"),
            "normal message MUST NOT bypass the prefix — got: {prompt:?}"
        );
    }

    #[test]
    fn reserved_slash_commands_list_does_not_shrink_or_vanish() {
        // Fail-by-default regression guard: the reserved set must
        // remain non-empty and contain the documented /compact entry.
        // If a future refactor empties the list or removes /compact,
        // /compact stops reaching the CLI's interceptor and the
        // MEDICAO evidence (status:"compacting" emitted by the CLI)
        // becomes a dead letter.
        //
        // The guard does NOT pin the exact size — additions are
        // expected as the CLI ships new reserved commands. It pins:
        //   1. The list is non-empty.
        //   2. `/compact` is present (the one MEDICAO verified).
        assert!(!RESERVED_SLASH_COMMANDS.is_empty(),
            "RESERVED_SLASH_COMMANDS is empty — no slash command can reach the CLI interceptor. \
             This is a regression: see D-D 2026-07-31 field fix.");
        assert!(
            RESERVED_SLASH_COMMANDS.contains(&"/compact"),
            "RESERVED_SLASH_COMMANDS must contain \"/compact\" (verified by MEDICAO 2026-07-30)"
        );
    }

    // ── T1-TodoWrite (2026-07-31) — 4 regression tests ────────────────
    //
    // The pre-existing defect: todowrite was mapped to
    // ("Atualizou tarefas", "tool") and `input.todos` was DISCARDED in
    // `detail_for_tool` (no branch for it). The renderer only ever
    // saw the label "Atualizou tarefas" — items and statuses were lost
    // at the Rust boundary.
    //
    // The fix introduces:
    //   1. kind="planning" (not "tool") — out of the renderer
    //      whitelist `['edit','command','terminal','read','search','tool','subagent']`,
    //      so planning does NOT count as observable action.
    //   2. Structured `todos: Option<Vec<TodoItem>>` field on
    //      RuntimeActivity — items + statuses cross the bridge.
    //   3. Subagent filter: `parent_tool_use_id` present and non-empty
    //      → todos=None (the subagent's list must not overwrite the
    //      main turn's list).
    //
    // Fixture format mirrors the CLI's actual TodoListSchema
    // (cli.mjs: `TodoListSchema = z.array(z.object({ content, status,
    // activeForm }))`, status ∈ {"pending","in_progress","completed"}).
    // Captured from the bundled CLI — not invented.

    #[test]
    fn todowrite_extracts_items_and_statuses_to_structured_field() {
        // Fixture: real CLI TodoWrite shape — tool_use with input.todos
        // carrying 3 items in distinct statuses.
        let payload = json!({
            "type": "tool_use",
            "id": "tool_todo_01",
            "name": "todowrite",
            "input": {
                "todos": [
                    {
                        "content": "Read the manifest_cache source",
                        "status": "completed",
                        "activeForm": "Reading the manifest_cache source"
                    },
                    {
                        "content": "Add stampede-inventory comments",
                        "status": "in_progress",
                        "activeForm": "Adding stampede-inventory comments"
                    },
                    {
                        "content": "Report to Maestro",
                        "status": "pending",
                        "activeForm": "Reporting to Maestro"
                    }
                ]
            }
        });
        let activity = runtime_activity_from_payload(&payload)
            .expect("todowrite payload must produce a RuntimeActivity");
        let todos = activity
            .todos
            .as_ref()
            .expect("todowrite activity must carry todos");
        assert_eq!(todos.len(), 3, "all 3 todos must cross the bridge");
        // Item 0: completed
        assert_eq!(todos[0].content, "Read the manifest_cache source");
        assert_eq!(todos[0].status, "completed");
        assert_eq!(todos[0].active_form, "Reading the manifest_cache source");
        // Item 1: in_progress — the load-bearing one (status mid-flight)
        assert_eq!(todos[1].content, "Add stampede-inventory comments");
        assert_eq!(todos[1].status, "in_progress");
        // Item 2: pending
        assert_eq!(todos[2].content, "Report to Maestro");
        assert_eq!(todos[2].status, "pending");
        // detail must be None for todowrite — the data is structured,
        // not a string. No duplication.
        assert!(
            activity.detail.is_none(),
            "todowrite must not duplicate the list in `detail`; the structured `todos` field is the source of truth"
        );
    }

    #[test]
    fn todowrite_kind_is_planning_not_tool() {
        // DECISÃO EXPLÍCITA DO MAESTRO (2026-07-31): PLANEJAR NÃO CONTA
        // COMO AGIR. O kind="planning" cai fora da whitelist de ação
        // observável do renderer. Se kind fosse "tool", um agente
        // poderia satisfazer a guarda escrevendo a lista sem fazer
        // nada — exatamente o defeito que a guarda existe para pegar.
        let payload = json!({
            "type": "tool_use",
            "id": "tool_todo_02",
            "name": "todowrite",
            "input": {
                "todos": [{"content": "anything", "status": "pending", "activeForm": "anything"}]
            }
        });
        let activity = runtime_activity_from_payload(&payload).unwrap();
        assert_eq!(
            activity.kind, "planning",
            "todowrite must be kind='planning' to fall out of ACTION_ACTIVITY_KINDS whitelist"
        );
        assert_ne!(
            activity.kind, "tool",
            "kind='tool' would satisfy the observable-action guard without action — forbidden"
        );
        assert_eq!(activity.label, "Atualizou tarefas");
    }

    #[test]
    fn real_todowrite_stream_blocks_share_one_activity_and_result_is_not_one() {
        // Exact relevant shapes captured from /tmp/stream.jsonl: the CLI
        // emits an empty stream-start block, then the full assistant block,
        // then a user tool_result with the same tool_use_id.
        let tool_use_id = "call_fa685df1555f47879c165be8";
        let stream_start = json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 1,
                "content_block": {
                    "type": "tool_use",
                    "id": tool_use_id,
                    "name": "TodoWrite",
                    "input": {}
                }
            }
        });
        let assistant = json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": tool_use_id,
                    "name": "TodoWrite",
                    "input": {
                        "todos": [
                            {"content": "tarefa A", "status": "pending", "activeForm": "Executando tarefa A"},
                            {"content": "tarefa B", "status": "pending", "activeForm": "Executando tarefa B"}
                        ]
                    }
                }]
            }
        });
        let tool_result = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "tool_use_id": tool_use_id,
                    "type": "tool_result",
                    "content": "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable"
                }]
            }
        });

        let first = runtime_activity_from_payload(&stream_start)
            .expect("stream-start tool_use must produce an activity");
        let second = runtime_activity_from_payload(&assistant)
            .expect("assistant tool_use must produce an activity");

        assert_eq!(first.label, "Atualizou tarefas");
        assert_eq!(first.kind, "planning");
        assert_eq!(first.tool_use_id.as_deref(), Some(tool_use_id));
        assert_eq!(second.tool_use_id, first.tool_use_id);
        assert_eq!(second.key, first.key);
        assert!(first.todos.is_none());
        assert_eq!(second.todos.as_ref().map(Vec::len), Some(2));
        assert!(runtime_activity_from_payload(&tool_result).is_none());
    }

    #[test]
    fn todowrite_does_not_count_as_observable_action_with_counterfactual() {
        // Indirect proof via kind: todowrite kind is NOT in the renderer's
        // ACTION_ACTIVITY_KINDS whitelist; a real action (Bash) IS. This
        // is the counterfactual that proves the fix didn't just shift
        // the boundary — planning is uniquely excluded.
        //
        // The whitelist values come from the renderer fence
        // (goalState.ts ACTION_ACTIVITY_KINDS). They are duplicated
        // here ONLY for the assertion — the source of truth lives in
        // the renderer. If the renderer ever adds "planning" to its
        // whitelist, this test fails and forces the discussion:
        // "should planning count as action again?" (the answer per
        // T1-TodoWrite decision is NO).
        const OBSERVABLE_ACTION_KINDS: &[&str] = &[
            "edit", "command", "terminal", "read", "search", "tool", "subagent",
        ];
        // todowrite: kind="planning" → NOT in whitelist → does not count
        let todo_payload = json!({
            "type": "tool_use",
            "id": "tool_todo_03",
            "name": "todowrite",
            "input": {
                "todos": [{"content": "plan only", "status": "pending", "activeForm": "plan only"}]
            }
        });
        let todo_activity = runtime_activity_from_payload(&todo_payload).unwrap();
        assert!(
            !OBSERVABLE_ACTION_KINDS.contains(&todo_activity.kind.as_str()),
            "todowrite kind '{}' must NOT be in ACTION_ACTIVITY_KINDS \
             (T1-TodoWrite decision: planning is not acting)",
            todo_activity.kind
        );
        // Counterfactual: a real action (Bash) STILL counts.
        let bash_payload = json!({
            "type": "tool_use",
            "id": "tool_bash_03",
            "name": "bash",
            "input": {"command": "echo hi"}
        });
        let bash_activity = runtime_activity_from_payload(&bash_payload).unwrap();
        assert!(
            OBSERVABLE_ACTION_KINDS.contains(&bash_activity.kind.as_str()),
            "counterfactual: bash kind '{}' must remain observable — the \
             fix only excludes planning, not real actions",
            bash_activity.kind
        );
    }

    #[test]
    fn subagent_todowrite_does_not_populate_main_turn_todos() {
        // CADINHO LEVANTOU: subagentes emitem TodoWrite PRÓPRIO. A
        // lista que chega à tela tem que ser a do turno PRINCIPAL.
        // O filtro é no PRODUTOR (aqui): quando payload.parent_tool_use_id
        // está presente e não-vazio, o evento veio de uma thread de
        // subagente e `todos` deve ser None — o dado nem atravessa a
        // ponte, então o renderer não tem como exibir a lista errada.
        let main_payload = json!({
            "type": "tool_use",
            "id": "tool_todo_main",
            "name": "todowrite",
            "input": {
                "todos": [
                    {"content": "main: investigate", "status": "in_progress", "activeForm": "main investigating"}
                ]
            }
        });
        let sub_payload = json!({
            "type": "tool_use",
            "id": "tool_todo_sub",
            "name": "todowrite",
            "parent_tool_use_id": "toolu_subagent_root",
            "input": {
                "todos": [
                    {"content": "sub: internal step", "status": "pending", "activeForm": "sub working"}
                ]
            }
        });
        // Main turn: todos populated.
        let main_activity = runtime_activity_from_payload(&main_payload).unwrap();
        assert!(
            main_activity.todos.is_some(),
            "main turn todowrite must populate todos"
        );
        assert_eq!(main_activity.todos.as_ref().unwrap().len(), 1);
        assert_eq!(main_activity.todos.as_ref().unwrap()[0].content, "main: investigate");

        // Subagent turn: todos is None — the subagent's internal list
        // does NOT cross the bridge. The renderer never sees it.
        let sub_activity = runtime_activity_from_payload(&sub_payload).unwrap();
        assert!(
            sub_activity.todos.is_none(),
            "subagent todowrite must NOT populate todos — the subagent's \
             internal list would overwrite the main turn's user-facing list. \
             Filter is at the producer, not the consumer."
        );
        // But the activity itself is still emitted (label/kind/thread
        // identification matter for the subagent thread UI). It's just
        // the todos field that is filtered.
        assert_eq!(sub_activity.label, "Atualizou tarefas");
        assert_eq!(sub_activity.kind, "planning");
        assert_eq!(sub_activity.tool_use_id.as_deref(), Some("tool_todo_sub"));

        // Edge case: empty parent_tool_use_id is treated as main turn
        // (defensive — empty string is not a valid marker).
        let empty_parent_payload = json!({
            "type": "tool_use",
            "id": "tool_todo_empty",
            "name": "todowrite",
            "parent_tool_use_id": "",
            "input": {
                "todos": [{"content": "main with empty parent", "status": "pending", "activeForm": "main"}]
            }
        });
        let empty_activity = runtime_activity_from_payload(&empty_parent_payload).unwrap();
        assert!(
            empty_activity.todos.is_some(),
            "empty parent_tool_use_id must be treated as main turn (defensive)"
        );
    }

    // ── T2-TodoWrite-i18n (2026-07-31) — 3 form-only tests ────────────
    //
    // LIMIT OF THIS TEST BLOCK: these tests prove that the prompt
    // CONTAINS the language instruction (in PT and EN) and that the
    // reserved slash-command bypass is preserved. They do NOT prove
    // that the model obeys the instruction — obedience is a
    // behavioral property, only verifiable by feeding a real agent a
    // real request and inspecting the TodoWrite payload. Past cycles
    // (see D-D) we were bitten by form-only tests being read as proof
    // of behavior. These tests are witnesses of the prompt text, not
    // of model behavior. The compliance test lives in the field.
    //
    // If a future review reads these tests as "the model now writes
    // steps in the user's language", that reader is wrong. The model
    // MAY still write English steps. What this block guarantees is
    // the shadow we cast — we shipped the instruction; whether the
    // agent walks in it is the user's call to verify on first use.

    fn sample_request_with_language(message: &str, language: LanguageCode) -> AgentTurnRequest {
        // Ensure /tmp/probe exists so safe_runtime_working_directory doesn't
        // redirect to the neutral temp dir (which breaks golden-string tests).
        let _ = std::fs::create_dir_all("/tmp/probe");
        AgentTurnRequest {
            turn_id: None,
            conversation_id: "c1".into(),
            message: message.into(),
            provider_account: None,
            model: None,
            model_supports_vision: None,
            context_window: None,
            response_language: Some(language),
            access_mode: crate::models::types::AccessMode::Approval,
            working_directory: "/tmp/probe".into(),
            skills: Vec::new(),
            attachments: None,
            response_enhancements_enabled: Some(false),
            personality: None,
            custom_instructions: None,
            memory_context: None,
            run_vision_fallback: None,
            media_capabilities: None,
            cli_media_capabilities: None,
            run_video_analysis: None,
            effort: None,
            reasoning: None,
            annotations: None,
        }
    }

    #[test]
    fn todowrite_language_instruction_present_in_pt_br_prompt() {
        // FORM-ONLY: proves the PT instruction text is in the rendered
        // prompt when the user is in PT-BR. Does NOT prove the model
        // respects it.
        let request = sample_request_with_language(
            "crie um arquivo p1.txt com 'p1'",
            LanguageCode::PtBr,
        );
        let prompt = build_prompt_internal(&request, /*is_resume=*/ false);
        assert!(
            prompt.contains("Escreva os passos do TodoWrite"),
            "PT must carry the PT instruction text. Form-only check, model behavior not proven."
        );
        assert!(
            prompt.contains("Preserve intactos"),
            "PT instruction must declare the identifier-preservation rule explicitly (not leave it implicit)"
        );
        // Resume path also carries it.
        let prompt_resume = build_prompt_internal(&request, /*is_resume=*/ true);
        assert!(
            prompt_resume.contains("Escreva os passos do TodoWrite"),
            "resume path must also carry the PT instruction — see comment \
             in build_prompt_internal: omitted-on-resume would revert \
             subsequent resumed tasks to English"
        );
    }

    #[test]
    fn todowrite_language_instruction_present_in_en_us_prompt() {
        // FORM-ONLY: proves the EN instruction text is in the rendered
        // prompt when the user is in EN-US. Does NOT prove the model
        // respects it.
        let request = sample_request_with_language(
            "create p1.txt with 'p1'",
            LanguageCode::EnUs,
        );
        let prompt = build_prompt_internal(&request, false);
        assert!(
            prompt.contains("Write TodoWrite steps"),
            "EN must carry the EN instruction text. Form-only check, model behavior not proven."
        );
        assert!(
            prompt.contains("Keep intact"),
            "EN instruction must declare the identifier-preservation rule explicitly (not leave it implicit)"
        );
        // The PT version must NOT show up in EN mode — only one
        // language per turn. If the PT text leaks, the model gets
        // conflicting instructions and is more likely to default to
        // English (the model's bias). Off-mode absence is the
        // contract.
        assert!(
            !prompt.contains("Escreva os passos do TodoWrite"),
            "EN-mode prompt must not contain the PT instruction — language mismatch is a contract violation"
        );
        // Resume path also carries it.
        let prompt_resume = build_prompt_internal(&request, true);
        assert!(
            prompt_resume.contains("Write TodoWrite steps"),
            "resume path must also carry the EN instruction"
        );
    }

    #[test]
    fn reserved_slash_command_bypass_remains_bare_no_envelope_no_instruction() {
        // D-D 2026-07-31 field fix: any prefix before the `/token`
        // breaks the CLI's slash-command interceptor. /compact (and
        // other reserved commands) MUST leave the prompt wrapper
        // untouched — no envelope, no language header, no
        // TodoWrite instruction, no workspace line. This test pins
        // that contract after T2-TodoWrite-i18n so we know the
        // language fix did not regress the D-D bypass.
        let mut request = sample_request_with_language("/compact", LanguageCode::PtBr);
        request.message = "/compact".to_string();
        let prompt = build_prompt_internal(&request, false);
        assert_eq!(
            prompt, "/compact",
            "/compact must exit the wrapper as the bare message — no \
             prefix, no envelope, no instruction. Regressing this is \
             the D-D field defect returning."
        );
        assert!(
            !prompt.contains("Escreva os passos do TodoWrite"),
            "reserved slash command must not include the language instruction"
        );
        assert!(
            !prompt.contains("Diretório de trabalho"),
            "reserved slash command must not include the PT workspace header"
        );
        // Also: EN mode, also resume — bypass must hold across the
        // matrix.
        let mut en = sample_request_with_language("/compact", LanguageCode::EnUs);
        en.message = "/compact".to_string();
        let prompt_en = build_prompt_internal(&en, true);
        assert_eq!(
            prompt_en, "/compact",
            "reserved bypass must hold for EN mode and resume path too"
        );
    }

    // ── F0-Annotate (2026-07-31) — annotation block in prompt ─────────
    //
    // CONTRACT (fixed by Maestro + MOSAICO):
    //   Annotation {
    //     id: String
    //     segmentId: String          // turnId:text:N
    //     quote: String              // VERBATIM
    //     prefix: String             // up to 40 chars before
    //     suffix: String             // up to 40 chars after
    //     occurrenceIndex: u32       // base ZERO
    //     comment: Option<String>    // OPTIONAL
    //     createdAt: i64
    //   }
    //
    // SAFETY LABELING (load-bearing):
    //   - quote is from the ASSISTANT's prior response
    //   - comment is from the USER
    //   Both are rendered with distinct labels so the model can
    //   never confuse them. If labels collapse, model text returns
    //   to the prompt as if it were user instruction — injection
    //   surface. The labels are not optional decoration; they are
    //   the fence.
    //
    // BACKWARD COMPATIBILITY (load-bearing):
    //   A request serialized by an older build (no `annotations`
    //   key) MUST still deserialize with `annotations = None`. The
    //   `#[serde(default)]` on the field plus the absence-of-label
    //   byte-identical test below are the witnesses.

    fn sample_annotation() -> crate::models::types::Annotation {
        crate::models::types::Annotation {
            id: "ann_1".into(),
            segment_id: "turn_42:text:0".into(),
            quote: "the manifest_cache stampede is the bug".into(),
            prefix: "…we discovered that ".into(),
            suffix: " — fix at the producer, not consumer.".into(),
            occurrence_index: 0,
            comment: Some("prioritize the waiters-elect-leader path".into()),
            created_at: 1_700_000_000_000,
        }
    }

    // ── CONTRAFACTUAL QUE MANDA EM TUDO (GOLDEN ANCHOR) ───────────────
    // A request sem annotations tem que produzir prompt BYTE-IDENTICO
    // ao de hoje. Sem isso, F0 não passa. Este teste é o PRIMEIRO
    // que deve rodar; vem antes dos testes de anotacao, não depois.
    //
    // GOLDEN ANCHOR (QA 2026-07-31): a primeira versão deste teste
    // reconstruía o esperado chamando build_prompt_internal no próprio
    // request — um teste que se recalcula concorda com qualquer bug.
    // O QA mutou de propósito o caminho sem-anotações e o teste
    // continuou VERDE: tanto o "esperado" quanto o "atual" mudavam
    // juntos. Esta versão assere contra um valor LITERAL colado aqui,
    // que não se recalcula. Qualquer mudança no prompt sem-anotações
    // (intencional ou não) deixa o teste VERMELHO. Quando o formato
    // do prompt mudar INTENCIONALMENTE, este literal é atualizado no
    // MESMO commit da mudança — nunca antes, nunca depois.
    #[test]
    fn build_prompt_is_byte_identical_when_no_annotations() {
        // Golden literals — não reconstruir a partir de código. Cada
        // um é o prompt montado por build_prompt_internal para o
        // fixture abaixo. Se o código produzir qualquer byte diferente,
        // este teste falha (e DEVE falhar — é a rede).
        //
        // Fixture (sample_request_with_language): enhancements=false
        // (sem app instructions/personality/custom), memory=None,
        // skills=[], attachments=None, working_directory=/tmp/probe.
        // Com essas configurações o ramo first-turn e o resume
        // produzem as mesmas partes (bloco de anotações filtrado
        // como vazio) — por isso cada idioma tem UM literal válido
        // para os dois caminhos.
        const GOLDEN_PT: &str = "\
Diretório de trabalho atual: /tmp/probe\n\
\n\
Escreva os passos do TodoWrite (campos content e activeForm) no idioma da conversa. Preserve intactos: nomes de arquivo, caminhos, comandos, flags, identificadores e trechos de código.\n\
\n\
crie p1.txt";
        const GOLDEN_EN: &str = "\
Current working directory: /tmp/probe\n\
\n\
Write TodoWrite steps (content and activeForm fields) in the conversation's language. Keep intact: filenames, paths, commands, flags, identifiers, and code snippets.\n\
\n\
create p1.txt";

        // PT — baseline (annotations=None por construção).
        let baseline = sample_request_with_language("crie p1.txt", LanguageCode::PtBr);
        assert_eq!(
            build_prompt_internal(&baseline, false),
            GOLDEN_PT,
            "PT first-turn no-annotations must match the golden literal EXACTLY (byte for byte)"
        );
        // PT — Some(empty): não pode introduzir seção nova.
        let with_empty = {
            let mut r = sample_request_with_language("crie p1.txt", LanguageCode::PtBr);
            r.annotations = Some(vec![]);
            r
        };
        assert_eq!(
            build_prompt_internal(&with_empty, false),
            GOLDEN_PT,
            "PT Some(empty) must also match the golden literal"
        );
        // PT — resume path (mesmo literal, ver comentário acima).
        assert_eq!(
            build_prompt_internal(&baseline, true),
            GOLDEN_PT,
            "PT resume no-annotations must also match the golden literal"
        );

        // EN — mesmo conjunto de caminhos.
        let en = sample_request_with_language("create p1.txt", LanguageCode::EnUs);
        assert_eq!(
            build_prompt_internal(&en, false),
            GOLDEN_EN,
            "EN first-turn no-annotations must match the golden literal EXACTLY"
        );
        assert_eq!(
            build_prompt_internal(&en, true),
            GOLDEN_EN,
            "EN resume no-annotations must also match the golden literal"
        );
    }

    #[test]
    fn quote_truncation_is_char_safe_at_byte_boundary() {
        // QA 2026-07-31: a primeira implementação cortava o quote por
        // FATIA DE BYTE (`&str[..CEILING]`). Em Rust, fatiar String
        // UTF-8 fora da fronteira de caractere PANICA — um usuário
        // colando 4 KiB de texto com acento na posição errada derrubaria
        // o app. A regra permanente do Maestro: nada pode quebrar o app.
        //
        // CENÁRIO: 6143 'a' (1 byte cada) + 'ç' (2 bytes: 0xC3 0xA7).
        // len = 6145 > 6144 (teto). O corte em 6144 cai NO MEIO do 'ç'
        // (segundo byte). `&str[..6144]` panica. `truncate_quote_char_safe`
        // volta para a fronteira 6143 e corta antes do 'ç'.
        let mut quote = "a".repeat(6143);
        quote.push('ç');
        assert!(quote.len() == 6145, "fixture: 6143 ASCII + ç = 6145 bytes");
        // Prova que o OFFSET 6144 cai no meio do 'ç' (o cenário que
        // panica no corte por byte):
        assert!(
            !quote.is_char_boundary(6144),
            "byte 6144 must NOT be a char boundary (it is the 2nd byte of ç) — \
             this is the exact panic position the fix targets"
        );
        let truncated = truncate_quote_char_safe(&quote);
        // Sem panic é o primeiro requisito; mas também o resultado
        // precisa ser UTF-8 VÁLIDO (não pode ter ficado meio caractere).
        assert!(
            std::str::from_utf8(truncated.as_bytes()).is_ok(),
            "truncated quote must be valid UTF-8 — no dangling half-character"
        );
        assert!(
            truncated.ends_with("[…]"),
            "truncated quote must carry the cut marker"
        );
        assert!(
            !truncated.contains('ç'),
            "the ç sitting exactly at the cut boundary must be dropped, not half-sliced"
        );
        assert_eq!(
            truncated.chars().count(),
            6143 + 3,
            "6143 ASCII chars + '…' marker (3 chars) = 6146 chars, all valid"
        );
        // O caminho INTEIRO (via build_annotation_block/prompt) também
        // não pode panica com um quote gigante.
        let mut req = sample_request_with_language("ok", LanguageCode::PtBr);
        req.annotations = Some(vec![crate::models::types::Annotation {
            quote: quote.clone(),
            ..sample_annotation()
        }]);
        let prompt = build_prompt_internal(&req, false);
        assert!(
            std::str::from_utf8(prompt.as_bytes()).is_ok(),
            "full prompt must remain valid UTF-8 with a boundary-adjacent multi-byte char"
        );
        assert!(
            prompt.contains("[…]"),
            "prompt must contain the truncation marker for an oversized quote"
        );
    }

    #[test]
    fn annotation_without_comment_does_not_emit_orphan_label() {
        // CONTRAFACTUAL: comment is optional. If it's None OR empty
        // string, the prompt must NOT contain "Comentário DO USUÁRIO:"
        // with nothing after it (orphan label). It must contain the
        // quote label and the quote text. Otherwise the prompt has
        // a confusing dangling header — bloat + misleading layout.
        let mut req = sample_request_with_language("ok", LanguageCode::PtBr);
        req.annotations = Some(vec![crate::models::types::Annotation {
            comment: None,
            ..sample_annotation()
        }]);
        let prompt = build_prompt_internal(&req, false);
        assert!(
            prompt.contains("Trecho citado da resposta anterior DO ASSISTENTE"),
            "quote label must be present"
        );
        assert!(
            prompt.contains("the manifest_cache stampede is the bug"),
            "quote text must be present"
        );
        assert!(
            !prompt.contains("Comentário DO USUÁRIO:"),
            "orphan comment label forbidden — comment was None"
        );
        // Also: empty-string comment is treated as no comment.
        let mut req_empty_comment = sample_request_with_language("ok", LanguageCode::PtBr);
        req_empty_comment.annotations = Some(vec![crate::models::types::Annotation {
            comment: Some("   ".into()),
            ..sample_annotation()
        }]);
        let prompt_empty = build_prompt_internal(&req_empty_comment, false);
        assert!(
            !prompt_empty.contains("Comentário DO USUÁRIO:"),
            "whitespace-only comment must not emit the label either"
        );
    }

    #[test]
    fn two_annotations_preserve_order_and_label_each_origin() {
        // Order preservation: stack order in the Vec is the prompt
        // order. The renderer attaches annotations in selection
        // order; the Rust side does NOT re-sort. If a future refactor
        // sorts them, this test catches it.
        let mut req = sample_request_with_language("ok", LanguageCode::EnUs);
        let mut a1 = sample_annotation();
        a1.id = "ann_first".into();
        a1.quote = "first quoted passage".into();
        a1.comment = Some("first user comment".into());
        let mut a2 = sample_annotation();
        a2.id = "ann_second".into();
        a2.quote = "second quoted passage".into();
        a2.comment = Some("second user comment".into());
        req.annotations = Some(vec![a1, a2]);
        let prompt = build_prompt_internal(&req, false);
        // First annotation's quote appears BEFORE second annotation's
        // quote. Without ordering we'd still pass on count — but
        // wrong on which is first.
        let pos_first_quote = prompt.find("first quoted passage").unwrap();
        let pos_second_quote = prompt.find("second quoted passage").unwrap();
        assert!(
            pos_first_quote < pos_second_quote,
            "annotation order must match Vec order: first ({pos_first_quote}) < second ({pos_second_quote})"
        );
        // Both labels present (origin labeling — quote = ASSISTANT,
        // comment = USER). Both must appear for both annotations.
        let assistant_label_count = prompt.matches("Quoted passage from the prior ASSISTANT response").count();
        let user_label_count = prompt.matches("USER comment").count();
        assert_eq!(
            assistant_label_count, 2,
            "each annotation must carry its ASSISTANT quote label"
        );
        assert_eq!(
            user_label_count, 2,
            "each annotation must carry its USER comment label"
        );
    }

    #[test]
    fn agent_turn_request_without_annotations_field_deserializes_to_none() {
        // Backward compatibility: a request serialized by an older
        // build (no `annotations` key) must still deserialize with
        // `annotations = None`. The struct relies on `#[serde(default)]`
        // on the field. This test pins that — if a future refactor
        // removes `default`, existing persisted requests break.
        let json = r#"{
            "turnId": null,
            "conversationId": "c1",
            "message": "hi",
            "model": null,
            "modelSupportsVision": null,
            "contextWindow": null,
            "responseLanguage": "en-US",
            "accessMode": "approval",
            "workingDirectory": "/tmp",
            "skills": [],
            "attachments": null,
            "responseEnhancementsEnabled": false,
            "personality": null,
            "customInstructions": null,
            "memoryContext": null,
            "runVisionFallback": null,
            "mediaCapabilities": null,
            "cliMediaCapabilities": null,
            "runVideoAnalysis": null,
            "effort": null,
            "reasoning": null
        }"#;
        let req: AgentTurnRequest = serde_json::from_str(json)
            .expect("legacy request without annotations must still deserialize");
        assert!(
            req.annotations.is_none(),
            "annotations field must default to None when absent on the wire"
        );
        // And the prompt is built without error.
        let prompt = build_prompt_internal(&req, false);
        assert!(prompt.contains("hi"));
    }

    #[test]
    fn reserved_slash_command_with_pending_annotations_logs_warning_and_drops() {
        // DECISÃO (see build_prompt_internal comment): DECLARAR, not
        // BLOQUEAR. Reserved slash command + pending annotations =
        // bypass returns raw message, annotations dropped, but the
        // drop is VISIBLE via eprintln. Test pins: the bypass still
        // returns the bare message (D-D regression guard), AND the
        // warn counter is incremented (visibility guard).
        reset_reserved_with_annotations_warn_count();
        let mut req = sample_request_with_language("/compact", LanguageCode::EnUs);
        req.annotations = Some(vec![sample_annotation()]);
        // Resume path also surfaces the warning.
        let prompt = build_prompt_internal(&req, true);
        assert_eq!(
            prompt, "/compact",
            "D-D regression guard: reserved slash command bypass must return bare message \
             even with pending annotations"
        );
        assert_eq!(
            reserved_with_annotations_warn_count(),
            1,
            "warn counter must fire exactly once when reserved command + non-empty annotations"
        );
        // Second call with same request — counter ticks again.
        let _ = build_prompt_internal(&req, false);
        assert_eq!(
            reserved_with_annotations_warn_count(),
            2,
            "warn counter must fire on every such call (no dedup, no rate limit — the drop is \
             user intent lost and the log is the only signal)"
        );
        // No annotations → no warn.
        req.annotations = None;
        let _ = build_prompt_internal(&req, false);
        assert_eq!(
            reserved_with_annotations_warn_count(),
            2,
            "no annotations → no warn (counter unchanged)"
        );
        // Empty annotations vec → no warn.
        req.annotations = Some(vec![]);
        let _ = build_prompt_internal(&req, false);
        assert_eq!(
            reserved_with_annotations_warn_count(),
            2,
            "empty annotations vec → no warn (counter unchanged)"
        );
    }
}
