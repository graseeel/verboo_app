use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::io::{BufRead, BufReader};

use tauri::{AppHandle, Emitter};

use crate::models::types::{
    access_mode_cli_args, AgentEvent, AgentResultSnapshot, AgentTurnRequest, AttachmentMeta,
    AttachmentKind, EventType, LanguageCode, PersonalityMode, RuntimeActivity, RuntimeStatus,
    RuntimeStatusKind,
};
use crate::services::auth_token::{inject_api_key, resolve_token};
use crate::services::credentials_store::CredentialsStore;

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
}

impl TurnService {
    pub fn new(credentials: Arc<CredentialsStore>) -> Self {
        Self {
            active: Arc::new(Mutex::new(std::collections::HashMap::new())),
            credentials,
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

        let prompt = build_prompt(&request, resume_session_id.is_some());
        let is_resume = resume_session_id.is_some();

        let mut args = vec![
            "--print".to_string(),
            // prompt passed as first positional when not using structured input
            // (we always pass it positionally for now; structured input with
            // images is a follow-up after attachment handling is fleshed out).
            prompt,
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
            "--include-partial-messages".to_string(),
        ];
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

        // Build the CLI spawn. CliSpawn picks the best runtime:
        //   - `<node> <bundled-cli.mjs>` (self-contained — option B of doc 03)
        //   - `<node> <VERBOO_CLI_PATH>` (dev)
        //   - `verboo` global on PATH (last-resort fallback)
        let spawn = crate::services::cli_spawn::CliSpawn::new(&args);
        let mut cmd = spawn.command;
        cmd.current_dir(&working_directory)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // On Windows, create the child in its own process group so
        // `GenerateConsoleCtrlEvent` can target it for graceful interrupt.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(crate::services::child_signal::process_creation_flags());
        }
        let _token_file = inject_api_key(token.as_deref(), &mut cmd);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Falha ao iniciar CLI Verboo: {e}"))?;

        let child_id = child.id();

        // Take stdout/stderr BEFORE wrapping in Arc<Mutex<>> so the streams
        // can be moved into reader threads.
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "CLI stdout unavailable.".to_string())?;
        // Stderr is best-effort debug — we drop the handle to avoid the
        // pipe buffer filling up if the CLI logs heavily. Stderr text isn't
        // surfaced to the renderer in this Tauri version (Electron did).
        drop(child.stderr.take());

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
        // `_token_file` is moved into the closure so the 0600 temp file stays
        // alive while the child holds the fd/path. `child_handle` is moved
        // so the thread can call `wait()` to get the exit code.
        thread::spawn(move || {
            let _token_file = _token_file;
            let child_handle = child_handle;
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
            // Remove the child from the active map now that the turn is done.
            // We can't hold the map lock directly (we're in a separate thread),
            // but we share the Arc with the active map.
            if let Some(mut map) = active_map_for_thread.lock().ok() {
                map.remove(&turn_id_for_stdout);
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

/// Build the user prompt that goes to the CLI. Mirrors Electron's
/// `buildPrompt` — app instructions + working directory + personality +
/// custom instructions + memory + skills + attachments + message.
///
/// On resume, only send working directory + message (rest is already in
/// the resumed session history).
fn build_prompt(request: &AgentTurnRequest, is_resume: bool) -> String {
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
        let attachment_lines = build_attachment_lines(&request.attachments, language);
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
    let attachment_lines = build_attachment_lines(&request.attachments, language);
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
            format!("- {} ({kind_str}): {}", a.name, a.path)
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

fn extract_tool_block(payload: &serde_json::Value) -> Option<serde_json::Map<String, serde_json::Value>> {
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
}
