//! Runtime runner for research subagents.
//!
//! Mirrors Electron's `ResearchSubagentService.runMany`
//! (src/main/services/researchSubagentService.ts:25). Each subagent is a
//! headless CLI turn with read-only constraints. This module handles the
//! actual spawn, stdout parsing, read-only violation detection, source
//! collection, timeout, progress events, and cancellation.

use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

use tauri::{AppHandle, Emitter};

use crate::models::types::{
    AgentEvent, AgentResultStatus, AgentTurnRequest, EventType, LanguageCode,
    ResearchSubagentProgress, ResearchSubagentRequest, ResearchSubagentResult,
    ResearchSubagentStatus, ResearchSubagentsRunRequest,
};
use crate::services::auth_token::{inject_api_key, resolve_token};
use crate::services::credentials_store::CredentialsStore;
use crate::services::research_subagent_service::ResearchSubagentService;
use crate::services::turn_service::{clean_terminal_text, parse_json_line};

const RESEARCH_SUBAGENT_TIMEOUT_MS: u64 = 90_000;
const AGENT_EVENT_CHANNEL: &str = "agent:event";

/// Opaque handle to a running subagent process.
struct RunningSubagent {
    child: Arc<Mutex<Child>>,
    cancelled: Arc<Mutex<bool>>,
}

/// State shared across all active research runs.
type ActiveRuns = Arc<Mutex<std::collections::HashMap<String, Vec<RunningSubagent>>>>;

/// Runner that executes research subagents by spawning CLI turns.
pub struct ResearchSubagentRunner {
    credentials: Arc<CredentialsStore>,
    active_runs: ActiveRuns,
}

impl ResearchSubagentRunner {
    pub fn new(credentials: Arc<CredentialsStore>) -> Self {
        Self {
            credentials,
            active_runs: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }

    /// Runs up to `MAX_RESEARCH_SUBAGENTS` subagents in parallel and returns
    /// their collected results. Emits progress events on `agent:event` so the
    /// renderer can render the subagent panel.
    pub async fn run_many(
        &self,
        app: AppHandle,
        request: ResearchSubagentsRunRequest,
    ) -> Result<Vec<ResearchSubagentResult>, String> {
        let run_id = request
            .run_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let requests = ResearchSubagentService::build_requests(&request);
        let run_id_for_cancel = run_id.clone();

        {
            let mut active = self
                .active_runs
                .lock()
                .map_err(|e| format!("Lock error: {e}"))?;
            active.insert(run_id.clone(), Vec::new());
        }

        // Build child-request descriptions (conversation id + prompt) in the
        // main thread before spawning workers.
        let workers: Vec<_> = requests
            .into_iter()
            .map(|req| {
                let child_req = build_child_turn_request(&req);
                (req, child_req)
            })
            .collect();

        // Spawn one worker thread per subagent and collect their JoinHandles.
        let mut handles = Vec::with_capacity(workers.len());
        for (req, child_req) in workers {
            let app = app.clone();
            let credentials = self.credentials.clone();
            let active_runs = self.active_runs.clone();
            let run_id = run_id.clone();

            let handle = thread::spawn(move || {
                run_one(app, credentials, active_runs, &run_id, req, child_req)
            });
            handles.push(handle);
        }

        // Await all workers. Use tokio::task::spawn_blocking so this is async.
        let results = tokio::task::spawn_blocking(move || {
            let mut results = Vec::with_capacity(handles.len());
            for handle in handles {
                match handle.join() {
                    Ok(result) => results.push(result),
                    Err(_) => {
                        // Thread panicked. Return a generic failure result in
                        // the same order without aborting the whole run.
                        results.push(ResearchSubagentResult {
                            id: format!("{run_id_for_cancel}:?"),
                            index: results.len() as u32 + 1,
                            status: AgentResultStatus::Failed,
                            summary: "Subagent thread panicked.".into(),
                            findings: Vec::new(),
                            sources: Vec::new(),
                        });
                    }
                }
            }
            results
        })
        .await
        .map_err(|e| format!("Failed to join subagents: {e}"))?;

        // Remove the run from the active map regardless of outcome.
        if let Ok(mut active) = self.active_runs.lock() {
            active.remove(&run_id);
        }

        Ok(results)
    }

    /// Cancel all subagents belonging to `run_id`. Returns true if any active
    /// process was found and interrupted.
    pub fn cancel_run(&self, run_id: &str) -> Result<bool, String> {
        let mut active = self.active_runs.lock().map_err(|e| e.to_string())?;
        let Some(children) = active.get_mut(run_id) else {
            return Ok(false);
        };

        let mut any = false;
        for child in children.iter_mut() {
            if let Ok(mut c) = child.child.lock() {
                let _ = crate::services::child_signal::interrupt_child(&mut c);
                any = true;
            }
            if let Ok(mut c) = child.cancelled.lock() {
                *c = true;
            }
        }
        Ok(any)
    }
}

impl Default for ResearchSubagentRunner {
    fn default() -> Self {
        Self::new(std::sync::Arc::new(CredentialsStore::new()))
    }
}

/// Runs a single subagent CLI turn to completion.
fn run_one(
    app: AppHandle,
    credentials: Arc<CredentialsStore>,
    active_runs: ActiveRuns,
    run_id: &str,
    request: ResearchSubagentRequest,
    child_turn: AgentTurnRequest,
) -> ResearchSubagentResult {
    let request_id = request.id.clone();
    let language = ResearchSubagentService::request_language(&request);

    // Emit "queued" and immediately "running" progress so the UI shows the
    // subagent starting.
    emit_progress(
        &app,
        ResearchSubagentService::build_progress(
            run_id,
            &request,
            ResearchSubagentStatus::Queued,
            &request.topic,
            None,
        ),
    );
    emit_progress(
        &app,
        ResearchSubagentService::build_progress(
            run_id,
            &request,
            ResearchSubagentStatus::Running,
            &request.topic,
            Some(&request.topic),
        ),
    );

    // Build CLI spawn.
    let prompt = build_prompt(&child_turn, false);
    let args = vec![
        "--print".to_string(),
        prompt,
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
    ];
    let cli_spawn = crate::services::cli_spawn::CliSpawn::new(&args);
    let mut cmd = cli_spawn.command;
    let working_directory = safe_runtime_working_directory(&child_turn.working_directory);
    cmd.current_dir(&working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::services::child_signal::process_creation_flags());
    }

    let token = resolve_token(&credentials);
    let _token_guard = inject_api_key(token.as_deref(), &mut cmd);

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return finish_failed(
                &app,
                run_id,
                &request,
                &format!("Falha ao iniciar subagente: {e}"),
                HashSet::new(),
            );
        }
    };

    let child_handle = Arc::new(Mutex::new(child));
    let cancelled = Arc::new(Mutex::new(false));

    // Register this subagent for cancellation under the run.
    {
        if let Ok(mut active) = active_runs.lock() {
            if let Some(children) = active.get_mut(run_id) {
                children.push(RunningSubagent {
                    child: child_handle.clone(),
                    cancelled: cancelled.clone(),
                });
            }
        }
    }

    // Take stdout/stderr before wrapping in threads.
    let stdout = match child_handle
        .lock()
        .ok()
        .and_then(|mut c| c.stdout.take())
    {
        Some(s) => s,
        None => {
            return finish_failed(
                &app,
                run_id,
                &request,
                "Subagent stdout unavailable.",
                HashSet::new(),
            );
        }
    };
    let stderr = child_handle
        .lock()
        .ok()
        .and_then(|mut c| c.stderr.take());

    let cancelled_for_thread = cancelled.clone();
    let request_id_for_thread = request_id.clone();
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    let stderr_buf_for_thread = stderr_buf.clone();

    // Drain stderr in a background thread.
    if let Some(stderr) = stderr {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[verboo-subagent-stderr {}] {}", request_id_for_thread, line);
                if let Ok(mut b) = stderr_buf_for_thread.lock() {
                    b.push_str(&line);
                    b.push('\n');
                }
            }
        });
    }

    // Read stdout line-by-line, parse events, detect violations, collect
    // sources, and enforce the 90s timeout.
    let reader = BufReader::new(stdout);
    let start = Instant::now();
    let mut output: Vec<String> = Vec::new();
    let mut sources: HashSet<String> = HashSet::new();
    let mut violation: Option<String> = None;
    let mut last_progress_at = Instant::now();

    for line in reader.lines().map_while(Result::ok) {
        // Timeout check.
        if start.elapsed().as_millis() as u64 >= RESEARCH_SUBAGENT_TIMEOUT_MS {
            if let Ok(mut c) = child_handle.lock() {
                let _ = crate::services::child_signal::interrupt_child(&mut c);
            }
            return finish_failed(
                &app,
                run_id,
                &request,
                &timeout_message(&language),
                sources,
            );
        }

        // External cancellation check (from cancel_research_subagents).
        if *cancelled_for_thread.lock().unwrap_or_else(|p| p.into_inner()) {
            return finish_failed(
                &app,
                run_id,
                &request,
                "Subagent cancelled by user.",
                sources,
            );
        }

        let clean = clean_terminal_text(&line);
        if clean.trim().is_empty() {
            continue;
        }

        if let Some(payload) = parse_json_line(&clean) {
            if let Some(source) = ResearchSubagentService::source_from_tool_payload(&payload) {
                sources.insert(source);
            }

            if let Some(runtime) = runtime_activity_for_progress(&payload) {
                let now = Instant::now();
                if now.duration_since(last_progress_at).as_millis() >= 700 {
                    last_progress_at = now;
                    emit_progress(
                        &app,
                        ResearchSubagentService::build_progress(
                            run_id,
                            &request,
                            runtime.status,
                            &request.topic,
                            Some(runtime.detail.as_str()),
                        ),
                    );
                }
            }

            if violation.is_none() {
                if let Some(v) = ResearchSubagentService::detect_read_only_violation(&payload, &language) {
                    violation = Some(v.clone());
                    if let Ok(mut c) = child_handle.lock() {
                        let _ = crate::services::child_signal::interrupt_child(&mut c);
                    }
                }
            }
        } else {
            // Plain stdout text.
            output.push(clean.clone());
            let snippet_text = ResearchSubagentService::snippet(&clean, 180);
            if !snippet_text.is_empty() {
                let now = Instant::now();
                if now.duration_since(last_progress_at).as_millis() >= 700 {
                    last_progress_at = now;
                    emit_progress(
                        &app,
                        ResearchSubagentService::build_progress(
                            run_id,
                            &request,
                            ResearchSubagentStatus::Running,
                            &request.topic,
                            Some(&snippet_text),
                        ),
                    );
                }
            }
        }
    }

    // Wait for exit code.
    let exit_code = child_handle
        .lock()
        .ok()
        .and_then(|mut c| c.wait().ok())
        .and_then(|s| s.code());

    if let Some(v) = violation {
        return finish_failed(&app, run_id, &request, &v, sources);
    }

    if exit_code != Some(0) {
        let err = stderr_buf
            .lock()
            .ok()
            .map(|b| b.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| exit_code_message(&language, exit_code));
        return finish_failed(&app, run_id, &request, &err, sources);
    }

    let text = ResearchSubagentService::cleanup_output(&output.join(""));
    let summary = ResearchSubagentService::summarize_output(&text, &language);
    let findings = ResearchSubagentService::extract_findings(&text);
    let mut sources_vec: Vec<String> = sources.iter().cloned().collect();
    sources_vec.truncate(8);

    let result = ResearchSubagentResult {
        id: request.id.clone(),
        index: request.index,
        status: AgentResultStatus::Complete,
        summary,
        findings,
        sources: sources_vec,
    };

    emit_progress(
        &app,
        ResearchSubagentService::build_progress(
            run_id,
            &request,
            ResearchSubagentStatus::Complete,
            &result.summary,
            Some(&result.summary),
        ),
    );

    // Remove from active runs.
    if let Ok(mut active) = active_runs.lock() {
        if let Some(children) = active.get_mut(run_id) {
            children.retain(|c| {
                if let Ok(cancelled) = c.cancelled.lock() {
                    !*cancelled
                } else {
                    true
                }
            });
        }
    }

    result
}

/// Build the `AgentTurnRequest` that will be sent to the CLI for this
/// subagent. Mirrors `createResearchTurnRequest` in Electron
/// (researchSubagentService.ts:203).
fn build_child_turn_request(request: &ResearchSubagentRequest) -> AgentTurnRequest {
    let mut child = request.base_request.clone();
    child.turn_id = Some(format!("research:{}", request.id));
    child.message = ResearchSubagentService::build_prompt(request);
    child.access_mode = ResearchSubagentService::research_access_mode();
    child.skills = Vec::new();
    child.attachments = None;
    child.personality = Some(crate::models::types::PersonalityMode::Concise);
    child.custom_instructions = None;
    child.memory_context = None;
    child
}

/// Builds the user prompt that goes to the CLI. Reuses `build_prompt` from
/// `turn_service` so research subagents get the same preamble as regular
/// turns (workspace, language, access-mode args, etc.).
fn build_prompt(request: &AgentTurnRequest, is_resume: bool) -> String {
    crate::services::turn_service::build_prompt_internal(request, is_resume)
}

/// Build helper exposed from `turn_service` so this runner can compose the
/// same prompt format without duplicating the prompt logic.
/// We keep this private; callers go through `build_prompt` above.
fn safe_runtime_working_directory(working_directory: &str) -> String {
    if working_directory.trim().is_empty()
        || working_directory.trim() == "/"
        || working_directory.trim() == "."
    {
        dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "/".to_string())
    } else {
        working_directory.to_string()
    }
}

/// Convenience: emit a failed result and a final progress event.
fn finish_failed(
    app: &AppHandle,
    run_id: &str,
    request: &ResearchSubagentRequest,
    reason: &str,
    sources: HashSet<String>,
) -> ResearchSubagentResult {
    let result = ResearchSubagentService::failed_result(request, reason, &sources);
    emit_progress(
        app,
        ResearchSubagentService::build_progress(
            run_id,
            request,
            ResearchSubagentStatus::Failed,
            &result.summary,
            Some(reason),
        ),
    );
    result
}

/// Maps a parsed CLI event payload to a progress status/detail. This is the
/// Tauri equivalent of Electron's `progressStatusForActivityKind` +
/// `progressDetailForEvent`.
fn runtime_activity_for_progress(payload: &serde_json::Value) -> Option<ProgressActivity> {
    let block = crate::services::turn_service::extract_tool_block(payload)?;
    let name = block
        .get("name")
        .and_then(|v| v.as_str())
        .or_else(|| block.get("tool_name").and_then(|v| v.as_str()))?;
    let input_obj = block
        .get("input")
        .and_then(|v| v.as_object())
        .or_else(|| block.get("arguments").and_then(|v| v.as_object()));

    let n = name.to_lowercase();
    let status = if n == "bash" || n == "shell" || n == "exec_command" {
        if let Some(input) = input_obj {
            let cmd = input
                .get("command")
                .and_then(|v| v.as_str())
                .or_else(|| input.get("cmd").and_then(|v| v.as_str()))
                .unwrap_or("");
            if ResearchSubagentService::is_read_only_shell_command(cmd) {
                ResearchSubagentStatus::Running
            } else {
                ResearchSubagentStatus::Reading
            }
        } else {
            ResearchSubagentStatus::Running
        }
    } else if n == "websearch" || n == "webfetch" {
        ResearchSubagentStatus::Searching
    } else if n == "read" || n == "ls" || n == "glob" || n == "grep" {
        ResearchSubagentStatus::Reading
    } else {
        ResearchSubagentStatus::Running
    };

    let detail = detail_for_tool(&n, input_obj).unwrap_or_else(|| name.to_string());
    Some(ProgressActivity { status, detail })
}

struct ProgressActivity {
    status: ResearchSubagentStatus,
    detail: String,
}

fn detail_for_tool(
    tool_name: &str,
    input: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<String> {
    let input = input?;
    let snippet = |s: Option<&str>| {
        s.map(|t| {
            let t = t.trim();
            if t.len() > 180 {
                format!("{}...", &t[..179])
            } else {
                t.to_string()
            }
        })
    };
    let n = tool_name.to_lowercase();
    if n == "bash" || n == "shell" || n == "exec_command" {
        return snippet(
            input
                .get("command")
                .and_then(|v| v.as_str())
                .or_else(|| input.get("cmd").and_then(|v| v.as_str())),
        );
    }
    if n == "websearch" {
        return snippet(input.get("query").and_then(|v| v.as_str()));
    }
    if n == "webfetch" {
        return snippet(input.get("url").and_then(|v| v.as_str()));
    }
    snippet(
        input
            .get("file_path")
            .and_then(|v| v.as_str())
            .or_else(|| input.get("filePath").and_then(|v| v.as_str()))
            .or_else(|| input.get("path").and_then(|v| v.as_str()))
            .or_else(|| input.get("pattern").and_then(|v| v.as_str())),
    )
}

fn timeout_message(language: &LanguageCode) -> String {
    if *language == LanguageCode::PtBr {
        "Tempo limite do subagente de pesquisa excedido.".into()
    } else {
        "Research subagent timed out.".into()
    }
}

fn exit_code_message(language: &LanguageCode, exit_code: Option<i32>) -> String {
    if *language == LanguageCode::PtBr {
        format!(
            "Processo terminou com código {}.",
            exit_code.map(|c| c.to_string()).unwrap_or_else(|| "desconhecido".into())
        )
    } else {
        format!(
            "Process exited with code {}.",
            exit_code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into())
        )
    }
}

fn emit_progress(app: &AppHandle, progress: ResearchSubagentProgress) {
    let _ = app.emit(
        AGENT_EVENT_CHANNEL,
        AgentEvent {
            event_type: EventType::SubagentProgress,
            progress: Some(progress),
            ..Default::default()
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{
        AccessMode, AgentTurnRequest, LanguageCode, PersonalityMode,
    };

    fn base_request() -> AgentTurnRequest {
        AgentTurnRequest {
            turn_id: None,
            conversation_id: "c1".into(),
            message: "build a feature".into(),
            computer_use_session_id: None,
            model: None,
            model_supports_vision: None,
            run_vision_fallback: None,
            effort: None,
            reasoning: None,
            context_window: None,
            response_language: Some(LanguageCode::EnUs),
            access_mode: AccessMode::Approval,
            working_directory: "/tmp".into(),
            skills: Vec::new(),
            attachments: None,
            response_enhancements_enabled: Some(false),
            personality: Some(PersonalityMode::Concise),
            custom_instructions: None,
            memory_context: None,
        }
    }

    #[test]
    fn child_request_is_read_only() {
        let req = ResearchSubagentRequest {
            id: "r:1".into(),
            index: 1,
            total: 1,
            topic: "test".into(),
            base_request: base_request(),
        };
        let child = build_child_turn_request(&req);
        assert_eq!(child.access_mode, AccessMode::Approval);
        assert!(child.message.contains("Verboo Code research subagent"));
        assert!(child.turn_id.as_deref() == Some("research:r:1"));
    }

    #[test]
    fn exit_code_message_localized() {
        assert!(exit_code_message(&LanguageCode::EnUs, Some(1)).contains("code 1"));
        assert!(exit_code_message(&LanguageCode::PtBr, Some(1)).contains("código 1"));
    }
}
