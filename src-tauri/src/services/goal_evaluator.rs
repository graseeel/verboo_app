use std::fmt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::models::types::{
    AgentResultSnapshot, GoalDecision, GoalEvaluationInput, GoalEvaluationResult, GoalReasonId,
    GoalState, GoalStatus, TranscriptItem,
};
use crate::services::auth_token::inject_api_key;

/// Result of a single goal evaluation call. Mirrors the Electron type and the
/// local `EvaluationResult` in `lib.rs` (camelCase serialized).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationResult {
    pub evaluation: GoalEvaluationResult,
}

/// Errors from the goal evaluator — infrastructure failures only.
/// When the evaluator returns Err, the caller (lib.rs Tauri command) maps
/// it to a Pause+InfraError for the FE to circuit-break. This is NEVER
/// silently swallowed.
#[derive(Debug, Clone)]
pub enum GoalEvaluationError {
    CliTimeout,
    CliSpawn(String),
    CliExit { exit_code: Option<i32>, stderr: String },
    ParseFailure(String),
}

impl fmt::Display for GoalEvaluationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CliTimeout => write!(f, "Goal evaluator CLI timed out"),
            Self::CliSpawn(msg) => write!(f, "Goal evaluator CLI spawn failed: {msg}"),
            Self::CliExit { exit_code, stderr } => {
                write!(
                    f,
                    "Goal evaluator CLI exited with code {:?}: {}",
                    exit_code, stderr,
                )
            }
            Self::ParseFailure(msg) => write!(f, "Goal evaluator parse failure: {msg}"),
        }
    }
}

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const RECENT_ITEMS_WINDOW: usize = 30;

/// Runs the bundled `verboo` CLI in `--print --output-format json` mode with a
/// constructed evaluation prompt, then parses the JSON envelope for the
/// model's decision. Mirrors Electron's `evaluateGoal`
/// (src/main/services/goalEvaluator.ts:19).
pub struct GoalEvaluator;

impl GoalEvaluator {
    /// Builds the evaluation prompt and runs the CLI. Returns `Err` ONLY on
    /// infrastructure failures (timeout, spawn failure, unparseable output).
    /// On ANY LLM-level decision (continue/pause/complete) returns `Ok`.
    /// NEVER silently returns `Continue` on infra failure — the caller maps
    /// `Err` to `Pause + InfraError` for FE circuit-breaking.
    pub fn evaluate(
        input: GoalEvaluationInput,
        api_key: Option<&str>,
    ) -> Result<EvaluationResult, GoalEvaluationError> {
        let recent_items: Vec<TranscriptItem> = input
            .conversation_items
            .iter()
            .rev()
            .take(RECENT_ITEMS_WINDOW)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let prompt = build_evaluation_prompt(&input.goal, &recent_items, input.latest_result.as_ref());
        let stdout = run_evaluation_cli(&prompt, api_key)?;
        let json = extract_evaluation_json(&stdout)?;
        Ok(EvaluationResult {
            evaluation: normalize_evaluation(json),
        })
    }

    /// Unit-test helper: build the prompt and run the LLM in one call.
    fn evaluate_internal(
        input: GoalEvaluationInput,
        api_key: Option<&str>,
    ) -> Result<EvaluationResult, GoalEvaluationError> {
        Self::evaluate(input, api_key)
    }
}

/// Builds the markdown prompt that asks the model to evaluate goal progress.
///
/// The prompt instructs the model to output JSON with the expected fields.
/// Important mapping rules (enforced):
///   - incomplete / task_failure → continue (never pause for task failure)
///   - unsafe / needs_user → pause with explicit reason
///   - done → complete with mandatory completionSummary
fn build_evaluation_prompt(
    goal: &GoalState,
    recent_items: &[TranscriptItem],
    latest_result: Option<&AgentResultSnapshot>,
) -> String {
    let mut prompt = String::new();
    prompt.push_str("# Goal Evaluation\n\n");
    prompt.push_str("You are evaluating progress on an AI coding agent's goal.\n\n");
    prompt.push_str("## Goal\n\n");
    prompt.push_str(&goal.objective);
    prompt.push_str("\n\n## Context\n\n");
    prompt.push_str(&format!("Status: {:?} | Turns run: {}", goal.status, goal.turns_run));
    prompt.push_str("\n\n");

    if let Some(r) = latest_result {
        if r.exit_code.is_some() {
            prompt.push_str(&format!("Last exit code: {:?}\n", r.exit_code));
        }
        if let Some(ref errs) = r.errors {
            if !errs.is_empty() {
                prompt.push_str("Last errors:\n");
                for e in errs {
                    prompt.push_str(&format!("- {e}\n"));
                }
            }
        }
        prompt.push('\n');
    }

    prompt.push_str("## Recent transcript items\n\n");
    for item in recent_items {
        // Skip system messages that are synthetic (goal-system: prefix is
        // informational, not user/system authored).
        if item.role == "system" && !item.id.starts_with("goal-system:") {
            continue;
        }
        prompt.push_str(&format!("---\n### {} {}\n{}\n", item.role, item.id, item.text));
        if let Some(ref cmd) = item.command {
            prompt.push_str(&format!("\n**Command:** `{}`\n", cmd.input));
            if !cmd.output.is_empty() {
                let max_output = 500;
                let output = if cmd.output.len() > max_output {
                    format!("{}... [truncated {} chars]", &cmd.output[..max_output], cmd.output.len())
                } else {
                    cmd.output.clone()
                };
                prompt.push_str(&format!("**Output:**\n```\n{}\n```\n", output));
            }
        }
    }

    prompt.push_str("\n## Evaluation\n\n");
    prompt.push_str(
        "Analyze the transcript above. Has the agent made sufficient progress toward the goal ",
    );
    prompt.push_str("that the objective is complete? Be strict — only mark as complete if there ");
    prompt.push_str("is concrete evidence the goal is achieved.\n\n");
    prompt.push_str("Output a JSON object with these fields:\n\n");
    prompt.push_str("| Field | Type | Required | Description |\n");
    prompt.push_str("|-------|------|----------|-------------|\n");
    prompt.push_str("| `decision` | `\"continue\"` \\| `\"pause\"` \\| `\"complete\"` | yes | The evaluation decision |\n");
    prompt.push_str("| `reasonId` | see below | yes | Stable reason identifier |\n");
    prompt.push_str("| `reason` | string | yes | Human-readable justification |\n");
    prompt.push_str("| `sessionSummary` | string | for `continue` | What was accomplished this turn |\n");
    prompt.push_str("| `gaps` | string[] | for `continue` | What remains to be done |\n");
    prompt.push_str("| `nextAction` | string | for `pause` | What user input or action is needed |\n");
    prompt.push_str("| `completionSummary` | string | for `complete` | Proof that objective is met and why it should be considered complete |\n");
    prompt.push_str("| `confidence` | number (0-1) | yes | How confident you are in this decision |\n\n");

    prompt.push_str("**Valid `reasonId` values:**\n");
    prompt.push_str("- `taskIncomplete` — agent is still working, next objective steps are clear\n");
    prompt.push_str("- `taskFailure` — agent hit a task error (test fails, compile error) but can retry\n");
    prompt.push_str("- `unsafe` — operation is potentially destructive and needs human review\n");
    prompt.push_str("- `needsUser` — agent needs user input (credentials, architectural decision)\n");
    prompt.push_str("- `done` — objective is clearly met with concrete evidence\n");
    prompt.push_str("- `safetyLimit` — goal safety limit reached (not a token limit — Verboo has unlimited tokens)\n\n");

    prompt.push_str("### Decision rules (STRICT — follow these exactly):\n\n");
    prompt.push_str("1. **Incomplete task or task failure** → `decision: \"continue\"` with `reasonId: \"taskIncomplete\"` or `\"taskFailure\"`.\n");
    prompt.push_str("   Do NOT pause for task errors — the agent should continue to fix them.\n");
    prompt.push_str("2. **Unsafe operation or needs user input** → `decision: \"pause\"` with `reasonId: \"unsafe\"` or `\"needsUser\"`.\n");
    prompt.push_str("   Provide a clear `nextAction` explaining what the user needs to do.\n");
    prompt.push_str("3. **Objective met** → `decision: \"complete\"` with `reasonId: \"done\"`.\n");
    prompt.push_str("   REQUIRED: populate `completionSummary` with concrete evidence of completion.\n");
    prompt.push_str("   Do NOT mark as complete for partial progress.\n\n");

    prompt.push_str("For `continue`, always include `sessionSummary` (what was done) and `gaps` (what's left).\n");
    prompt.push_str("For `pause`, always include `nextAction` explaining what the user should do.\n");
    prompt.push_str("For `complete`, always include `completionSummary` with proof.\n\n");

    prompt.push_str("Return ONLY the JSON object. No markdown wrapping, no explanation.\n");

    prompt
}

/// Runs the CLI with the evaluation prompt. Returns Err on infra failures
/// (timeout, spawn failure, non-zero exit). NEVER returns Continue on
/// failure — that's the caller's circuit-breaker responsibility.
fn run_evaluation_cli(
    prompt: &str,
    api_key: Option<&str>,
) -> Result<String, GoalEvaluationError> {
    let cli_path = resolve_cli_path();
    let mut cmd = Command::new(&cli_path);
    cmd.args(["--print", "--output-format", "json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Inject API key for auth (same pattern as TurnService).
    inject_api_key(api_key, &mut cmd);

    let mut child = cmd.spawn().map_err(|e| {
        GoalEvaluationError::CliSpawn(format!("Failed to spawn CLI at {cli_path}: {e}"))
    })?;

    // Write prompt via stdin and close it.
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(prompt.as_bytes());
        // Drop closes stdin — the CLI sees EOF.
    }

    let deadline = Instant::now() + Duration::from_secs(DEFAULT_TIMEOUT_SECS);

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            // Kill the process so it doesn't orphan.
            let _ = child.kill();
            return Err(GoalEvaluationError::CliTimeout);
        }
        match child.try_wait() {
            Ok(Some(_status)) => {
                // Process exited — collect output.
                let output = child.wait_with_output().map_err(|e| {
                    GoalEvaluationError::ParseFailure(format!("Failed to collect output: {e}"))
                })?;

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                    // Non-zero exit from the evaluator CLI is an infra failure
                    // (e.g., auth expired, CLI crashed). Return as error — the
                    // caller maps to Pause+InfraError.
                    return Err(GoalEvaluationError::CliExit {
                        exit_code: output.status.code(),
                        stderr,
                    });
                }

                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                return Ok(stdout);
            }
            Ok(None) => {
                // Still running — sleep a bit and retry.
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                return Err(GoalEvaluationError::ParseFailure(format!(
                    "Process polling error: {e}"
                )));
            }
        }
    }
}

/// Extracts the evaluation JSON from CLI output.
/// Uses a depth-aware brace scanner (not greedy `rfind('}')`) to correctly
/// handle output that contains trailing text after the JSON object.
/// Accepts two shapes:
///   1. Envelope: `{result:"<json>"}` — the model wraps its output in a
///      structured envelope
///   2. Bare: the JSON object is the first `{...}` in the output
fn extract_evaluation_json(stdout: &str) -> Result<serde_json::Value, GoalEvaluationError> {
    // First try envelope format: `{result:"<json>"}` where the value
    // is a string-encoded JSON object.
    if let Ok(envelope) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        if let Some(obj) = envelope.as_object() {
            if let Some(result_val) = obj.get("result") {
                if let Some(result_str) = result_val.as_str() {
                    // The result value is a string — it may itself be JSON.
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(result_str) {
                        if parsed.is_object() {
                            return Ok(parsed);
                        }
                    }
                    // String but not JSON — it may be a plain text result.
                    // Wrap it into a generic object.
                    return Ok(serde_json::json!({
                        "decision": "continue",
                        "reasonId": "taskIncomplete",
                        "reason": result_str,
                        "sessionSummary": null,
                        "gaps": [],
                        "nextAction": null,
                        "completionSummary": null,
                        "confidence": 0.5,
                    }));
                }
                // Result is not a string — might be a nested object directly.
                if result_val.is_object() {
                    return Ok(result_val.clone());
                }
            }
            // No "result" key — might be a bare evaluation object directly.
            return Ok(serde_json::Value::Object(obj.clone()));
        }
    }

    // Try depth-aware first-object extraction (handles trailing text).
    if let Some(obj) = parse_first_json_object(stdout) {
        return Ok(obj);
    }

    Err(GoalEvaluationError::ParseFailure(
        "No valid JSON object found in CLI output".into(),
    ))
}

/// Depth-aware JSON object parser. Scans for the first `{` and tracks
/// brace depth while respecting string literals and escape sequences.
/// Returns the first complete top-level object, or None if no valid
/// object is found.
fn parse_first_json_object(text: &str) -> Option<serde_json::Value> {
    let start = text.find('{')?;
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escaped = false;

    for (i, c) in text[start..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' if in_string => {
                escaped = true;
            }
            '"' => {
                in_string = !in_string;
            }
            '{' if !in_string => {
                depth += 1;
            }
            '}' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    let end = start + i;
                    let slice = &text[start..=end];
                    return serde_json::from_str(slice).ok().filter(|v: &serde_json::Value| v.is_object());
                }
            }
            _ => {}
        }
    }

    None
}

/// Normalizes the parsed JSON into a structured GoalEvaluationResult.
/// Validates and defaults fields — NEVER returns Continue for infra
/// failures (infra errors are caught before this point).
/// Unknown/missing fields default to Continue+TaskIncomplete safe mode.
fn normalize_evaluation(json: serde_json::Value) -> GoalEvaluationResult {
    let obj = match json.as_object() {
        Some(o) => o,
        None => return default_continue("Evaluation payload was not an object"),
    };

    let decision = parse_decision(obj.get("decision"));
    let reason_id = parse_reason_id(obj.get("reasonId"));
    let reason = obj
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("No reason provided")
        .to_string();

    let session_summary = obj
        .get("sessionSummary")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let gaps = obj
        .get("gaps")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let next_action = obj
        .get("nextAction")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let completion_summary = obj
        .get("completionSummary")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let confidence = obj
        .get("confidence")
        .and_then(|v| v.as_f64())
        .map(|c| c.clamp(0.0, 1.0))
        .unwrap_or(0.5);

    // Enforce prompt rules:
    // - Continue must have sessionSummary + gaps filled
    // - Complete must have completionSummary filled
    // - Pause must have nextAction filled
    let (decision, reason_id, session_summary, gaps, next_action, completion_summary) = match
        &decision
    {
        GoalDecision::Complete => {
            let summary = completion_summary.unwrap_or_else(|| "Objective met".to_string());
            (decision, reason_id, session_summary, gaps, next_action, Some(summary))
        }
        GoalDecision::Continue => {
            let summary = session_summary.unwrap_or_else(|| {
                if reason_id == GoalReasonId::TaskFailure {
                    "Agent encountered an error and is retrying".to_string()
                } else {
                    "Agent is continuing work on the objective".to_string()
                }
            });
            let g = if gaps.is_empty() {
                vec!["Objective not yet achieved".to_string()]
            } else {
                gaps
            };
            (decision, reason_id, Some(summary), g, next_action, completion_summary)
        }
        GoalDecision::Pause => {
            let action = next_action.unwrap_or_else(|| {
                "User intervention required — see reason details".to_string()
            });
            (decision, reason_id, session_summary, gaps, Some(action), completion_summary)
        }
    };

    GoalEvaluationResult {
        decision,
        reason_id,
        reason,
        session_summary,
        gaps,
        next_action,
        completion_summary,
        confidence,
    }
}

/// Parses the decision from JSON value. Unknown values default to Continue.
fn parse_decision(value: Option<&serde_json::Value>) -> GoalDecision {
    let s = match value.and_then(|v| v.as_str()) {
        Some(s) => s.trim().to_lowercase(),
        None => return GoalDecision::Continue,
    };
    match s.as_str() {
        "continue" => GoalDecision::Continue,
        "pause" => GoalDecision::Pause,
        "complete" => GoalDecision::Complete,
        _ => GoalDecision::Continue,
    }
}

/// Parses the reasonId from JSON value. Unknown values default to
/// TaskIncomplete. Case-insensitive matching.
fn parse_reason_id(value: Option<&serde_json::Value>) -> GoalReasonId {
    let s = match value.and_then(|v| v.as_str()) {
        Some(s) => s.trim().to_lowercase(),
        None => return GoalReasonId::TaskIncomplete,
    };
    match s.as_str() {
        "taskincomplete" | "task_incomplete" => GoalReasonId::TaskIncomplete,
        "taskfailure" | "task_failure" => GoalReasonId::TaskFailure,
        "unsafe" => GoalReasonId::Unsafe,
        "needsuser" | "needs_user" => GoalReasonId::NeedsUser,
        "done" => GoalReasonId::Done,
        "safetylimit" | "safety_limit" => GoalReasonId::SafetyLimit,
        "infraerror" | "infra_error" => GoalReasonId::InfraError,
        _ => GoalReasonId::TaskIncomplete,
    }
}

/// Safe default: return Continue+TaskIncomplete.
fn default_continue(reason: &str) -> GoalEvaluationResult {
    GoalEvaluationResult {
        decision: GoalDecision::Continue,
        reason_id: GoalReasonId::TaskIncomplete,
        reason: reason.to_string(),
        session_summary: None,
        gaps: vec!["Objective not yet achieved".to_string()],
        next_action: None,
        completion_summary: None,
        confidence: 0.0,
    }
}

fn resolve_cli_path() -> String {
    if let Ok(path) = std::env::var("VERBOO_CLI_PATH") {
        let trimmed = path.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    crate::services::cli_path::resolve().unwrap_or_else(|| "verboo".to_string())
}

// ════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════
//
// IMPORTANT: these tests NEVER spawn a CLI. They test prompt building,
// JSON extraction, decision normalization, and the prompt rules.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{AccessMode, GoalStatus, SkillSummary};
    use serde_json::json;

    fn sample_goal() -> GoalState {
        GoalState {
            id: "test-goal".into(),
            objective: "Fix the login bug".into(),
            status: GoalStatus::Active,
            created_at: 1_000_000,
            updated_at: 1_000_000,
            started_at: Some(1_000_000),
            completed_at: None,
            paused_at: None,
            pause_reason: None,
            last_evaluation: None,
            last_session_id: None,
            last_turn_id: None,
            turns_run: 2,
            max_turns: 5,
            max_elapsed_ms: 1_800_000,
            max_input_tokens: Some(100_000),
            used_input_tokens: 45_000,
            used_output_tokens: 8_000,
            access_mode: AccessMode::Approval,
            model_id: Some("ultra/glm-5.2".into()),
            model_display_name: Some("GLM-5.2".into()),
            working_directory: "/tmp".into(),
            skills: Vec::new(),
            no_progress_count: 0,
            recent_fingerprints: Vec::new(),
        }
    }

    // ── parse_first_json_object ───────────────────────────────────────

    #[test]
    fn parse_simple_json() {
        let text = r#"Some prefix text {"decision":"continue","reason":"testing"}"#;
        let result = parse_first_json_object(text).unwrap();
        assert_eq!(result["decision"], "continue");
    }

    #[test]
    fn parse_trailing_text_after_json() {
        // The old rfind('}') approach would fail here because the
        // trailing text contains no braces — this tests the depth-aware
        // scanner.
        let text = r#"{"decision":"complete","reason":"done"}  and some stuff after"#;
        let result = parse_first_json_object(text).unwrap();
        assert_eq!(result["decision"], "complete");
    }

    #[test]
    fn parse_trailing_json_after_json() {
        // Multiple JSON objects in output — should only extract the first.
        let text = r#"{"decision":"continue","reason":"first"}{"decision":"complete","reason":"should be ignored"}"#;
        let result = parse_first_json_object(text).unwrap();
        assert_eq!(result["reason"], "first");
        assert_eq!(result["decision"], "continue");
    }

    #[test]
    fn parse_nested_braces_in_string() {
        let text = r#"{"decision":"pause","reason":"found { and } in string"}"#;
        let result = parse_first_json_object(text).unwrap();
        assert_eq!(result["decision"], "pause");
    }

    #[test]
    fn parse_no_json_returns_none() {
        assert!(parse_first_json_object("just some text").is_none());
        assert!(parse_first_json_object("").is_none());
    }

    #[test]
    fn parse_escaped_quotes_in_string() {
        let text = r#"{"decision":"continue","reason":"said \"hello\""}"#;
        let result = parse_first_json_object(text).unwrap();
        assert_eq!(result["reason"], r#"said "hello""#);
    }

    // ── normalize_evaluation: decision resolution ─────────────────────

    #[test]
    fn normalize_complete_with_summary() {
        let json = json!({
            "decision": "complete",
            "reasonId": "done",
            "reason": "Bug is fixed",
            "completionSummary": "All login tests pass",
            "confidence": 0.95
        });
        let result = normalize_evaluation(json);
        assert_eq!(result.decision, GoalDecision::Complete);
        assert_eq!(result.reason_id, GoalReasonId::Done);
        assert_eq!(result.completion_summary, Some("All login tests pass".into()));
        assert!((result.confidence - 0.95).abs() < 0.01);
    }

    #[test]
    fn normalize_complete_missing_summary_gets_default() {
        let json = json!({
            "decision": "complete",
            "reasonId": "done",
            "reason": "Bug is fixed",
            "confidence": 0.9
        });
        let result = normalize_evaluation(json);
        assert_eq!(result.decision, GoalDecision::Complete);
        // Missing completionSummary gets a default.
        assert!(result.completion_summary.is_some());
    }

    #[test]
    fn normalize_continue_with_session_and_gaps() {
        let json = json!({
            "decision": "continue",
            "reasonId": "taskIncomplete",
            "reason": "Still debugging",
            "sessionSummary": "Found the crash location",
            "gaps": ["Need to apply the fix"],
            "confidence": 0.7
        });
        let result = normalize_evaluation(json);
        assert_eq!(result.decision, GoalDecision::Continue);
        assert_eq!(result.reason_id, GoalReasonId::TaskIncomplete);
        assert_eq!(
            result.session_summary,
            Some("Found the crash location".into())
        );
        assert_eq!(result.gaps, vec!["Need to apply the fix"]);
    }

    #[test]
    fn normalize_continue_missing_session_gets_default() {
        let json = json!({
            "decision": "continue",
            "reasonId": "taskFailure",
            "reason": "Test failed",
            "confidence": 0.6
        });
        let result = normalize_evaluation(json);
        assert_eq!(result.decision, GoalDecision::Continue);
        assert_eq!(result.reason_id, GoalReasonId::TaskFailure);
        // Missing sessionSummary gets a default.
        assert_eq!(
            result.session_summary,
            Some("Agent encountered an error and is retrying".into())
        );
        // Missing gaps gets a default.
        assert_eq!(result.gaps, vec!["Objective not yet achieved"]);
    }

    #[test]
    fn normalize_continue_empty_gaps_gets_default() {
        let json = json!({
            "decision": "continue",
            "reasonId": "taskIncomplete",
            "reason": "Still working",
            "sessionSummary": "Made progress",
            "gaps": [],
            "confidence": 0.5
        });
        let result = normalize_evaluation(json);
        assert_eq!(result.gaps, vec!["Objective not yet achieved"]);
    }

    #[test]
    fn normalize_pause_unsafe() {
        let json = json!({
            "decision": "pause",
            "reasonId": "unsafe",
            "reason": "Agent wants to delete production DB",
            "nextAction": "Confirm or deny the DELETE",
            "confidence": 0.99
        });
        let result = normalize_evaluation(json);
        assert_eq!(result.decision, GoalDecision::Pause);
        assert_eq!(result.reason_id, GoalReasonId::Unsafe);
        assert_eq!(
            result.next_action,
            Some("Confirm or deny the DELETE".into())
        );
    }

    #[test]
    fn normalize_pause_needs_user() {
        let json = json!({
            "decision": "pause",
            "reasonId": "needsUser",
            "reason": "Need API key",
            "nextAction": "Provide the API key",
            "confidence": 0.8
        });
        let result = normalize_evaluation(json);
        assert_eq!(result.decision, GoalDecision::Pause);
        assert_eq!(result.reason_id, GoalReasonId::NeedsUser);
        assert_eq!(result.next_action, Some("Provide the API key".into()));
    }

    #[test]
    fn normalize_pause_missing_next_action_gets_default() {
        let json = json!({
            "decision": "pause",
            "reasonId": "unsafe",
            "reason": "Unsafe operation",
            "confidence": 0.95
        });
        let result = normalize_evaluation(json);
        assert_eq!(result.decision, GoalDecision::Pause);
        // Missing nextAction gets a default.
        assert!(result.next_action.is_some());
    }

    #[test]
    fn normalize_unknown_decision_defaults_continue() {
        let json = json!({
            "decision": "something_else",
            "reason": "Unknown decision",
            "confidence": 0.0
        });
        let result = normalize_evaluation(json);
        assert_eq!(result.decision, GoalDecision::Continue);
        assert_eq!(result.reason_id, GoalReasonId::TaskIncomplete);
    }

    #[test]
    fn normalize_unknown_reason_id_defaults_task_incomplete() {
        let json = json!({
            "decision": "continue",
            "reasonId": "unknown_reason",
            "reason": "Some reason",
            "confidence": 0.5
        });
        let result = normalize_evaluation(json);
        assert_eq!(result.decision, GoalDecision::Continue);
        assert_eq!(result.reason_id, GoalReasonId::TaskIncomplete);
    }

    #[test]
    fn normalize_non_object_falls_back_safe() {
        let json = json!("not an object");
        let result = normalize_evaluation(json);
        assert_eq!(result.decision, GoalDecision::Continue);
        assert_eq!(result.reason_id, GoalReasonId::TaskIncomplete);
    }

    #[test]
    fn normalize_empty_json_defaults_safe() {
        let json = json!({});
        let result = normalize_evaluation(json);
        assert_eq!(result.decision, GoalDecision::Continue);
        assert_eq!(result.reason, "No reason provided");
    }

    #[test]
    fn normalize_case_insensitive_reason_id() {
        let json = json!({
            "decision": "continue",
            "reasonId": "TASK_FAILURE",
            "reason": "Something failed",
            "confidence": 0.5
        });
        let result = normalize_evaluation(json);
        assert_eq!(result.reason_id, GoalReasonId::TaskFailure);
    }

    #[test]
    fn normalize_case_insensitive_reason_id_snake_case() {
        let json = json!({
            "decision": "pause",
            "reasonId": "needs_user",
            "reason": "User input needed",
            "nextAction": "Provide input",
            "confidence": 0.8
        });
        let result = normalize_evaluation(json);
        assert_eq!(result.reason_id, GoalReasonId::NeedsUser);
    }

    // ── parse_decision ────────────────────────────────────────────────

    #[test]
    fn parse_decision_values() {
        assert_eq!(parse_decision(Some(&json!("continue"))), GoalDecision::Continue);
        assert_eq!(parse_decision(Some(&json!("pause"))), GoalDecision::Pause);
        assert_eq!(parse_decision(Some(&json!("complete"))), GoalDecision::Complete);
    }

    #[test]
    fn parse_decision_unknown_defaults_continue() {
        assert_eq!(parse_decision(Some(&json!("blocked"))), GoalDecision::Continue);
        assert_eq!(parse_decision(Some(&json!("unknown"))), GoalDecision::Continue);
        assert_eq!(parse_decision(None), GoalDecision::Continue);
    }

    #[test]
    fn parse_decision_case_insensitive() {
        assert_eq!(parse_decision(Some(&json!("CONTINUE"))), GoalDecision::Continue);
        assert_eq!(parse_decision(Some(&json!("PAUSE"))), GoalDecision::Pause);
        assert_eq!(parse_decision(Some(&json!("Complete"))), GoalDecision::Complete);
    }

    // ── parse_reason_id ───────────────────────────────────────────────

    #[test]
    fn parse_reason_id_values() {
        assert_eq!(parse_reason_id(Some(&json!("taskIncomplete"))), GoalReasonId::TaskIncomplete);
        assert_eq!(parse_reason_id(Some(&json!("taskFailure"))), GoalReasonId::TaskFailure);
        assert_eq!(parse_reason_id(Some(&json!("unsafe"))), GoalReasonId::Unsafe);
        assert_eq!(parse_reason_id(Some(&json!("needsUser"))), GoalReasonId::NeedsUser);
        assert_eq!(parse_reason_id(Some(&json!("done"))), GoalReasonId::Done);
        assert_eq!(parse_reason_id(Some(&json!("safetyLimit"))), GoalReasonId::SafetyLimit);
        assert_eq!(parse_reason_id(Some(&json!("infraError"))), GoalReasonId::InfraError);
    }

    #[test]
    fn parse_reason_id_case_insensitive() {
        assert_eq!(parse_reason_id(Some(&json!("TASKINCOMPLETE"))), GoalReasonId::TaskIncomplete);
        assert_eq!(parse_reason_id(Some(&json!("UNSAFE"))), GoalReasonId::Unsafe);
        assert_eq!(parse_reason_id(Some(&json!("NEEDSUSER"))), GoalReasonId::NeedsUser);
    }

    #[test]
    fn parse_reason_id_snake_case_fallback() {
        // The LLM might output snake_case even though we ask for camelCase.
        assert_eq!(
            parse_reason_id(Some(&json!("task_incomplete"))),
            GoalReasonId::TaskIncomplete,
        );
        assert_eq!(
            parse_reason_id(Some(&json!("safety_limit"))),
            GoalReasonId::SafetyLimit,
        );
        assert_eq!(
            parse_reason_id(Some(&json!("infra_error"))),
            GoalReasonId::InfraError,
        );
    }

    #[test]
    fn parse_reason_id_unknown_defaults_task_incomplete() {
        assert_eq!(
            parse_reason_id(Some(&json!("unknown_id"))),
            GoalReasonId::TaskIncomplete,
        );
        assert_eq!(parse_reason_id(None), GoalReasonId::TaskIncomplete);
    }

    // ── extract_evaluation_json ───────────────────────────────────────

    #[test]
    fn extract_envelope_format() {
        let stdout = r#"{"type":"result","result":"{\"decision\":\"continue\",\"reasonId\":\"taskIncomplete\",\"reason\":\"Working on it\",\"confidence\":0.7}"}"#;
        let result = extract_evaluation_json(stdout).unwrap();
        assert_eq!(result["decision"], "continue");
        assert_eq!(result["reason"], "Working on it");
    }

    #[test]
    fn extract_bare_json() {
        let stdout = r#"{"decision":"complete","reasonId":"done","reason":"Done","completionSummary":"All done","confidence":0.95}"#;
        let result = extract_evaluation_json(stdout).unwrap();
        assert_eq!(result["decision"], "complete");
    }

    #[test]
    fn extract_envelope_with_nested_object() {
        let stdout = r#"{"type":"result","result":{"decision":"pause","reasonId":"unsafe","reason":"Danger","nextAction":"Check it","confidence":0.99}}"#;
        let result = extract_evaluation_json(stdout).unwrap();
        assert_eq!(result["decision"], "pause");
        assert_eq!(result["nextAction"], "Check it");
    }

    #[test]
    fn extract_envelope_result_is_plain_text() {
        let stdout = r#"{"type":"result","result":"Still working on the login fix"}"#;
        let result = extract_evaluation_json(stdout).unwrap();
        // Plain text result maps to a generic continue object.
        assert_eq!(result["decision"], "continue");
    }

    #[test]
    fn extract_no_json_returns_error() {
        let result = extract_evaluation_json("just some text");
        assert!(result.is_err());
        match result {
            Err(GoalEvaluationError::ParseFailure(_)) => {}
            _ => panic!("Expected ParseFailure error"),
        }
    }

    #[test]
    fn extract_empty_string_returns_error() {
        let result = extract_evaluation_json("");
        assert!(result.is_err());
    }

    // ── build_evaluation_prompt ──────────────────────────────────────
    //
    // These tests verify the prompt structure contains the expected
    // sections and instructions. They do NOT test the LLM's output.

    #[test]
    fn prompt_contains_goal_objective() {
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[], None);
        assert!(prompt.contains("Fix the login bug"));
    }

    #[test]
    fn prompt_shows_turns_and_status() {
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[], None);
        assert!(prompt.contains("Turns run"));
        assert!(prompt.contains("Active"));
    }

    #[test]
    fn prompt_does_not_use_tokens_as_criteria() {
        // Verboo has unlimited tokens. The evaluator must NOT use
        // token usage or budget windows as completion criteria.
        // The explanatory "Verboo has unlimited tokens" is fine.
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[], None);
        // Allow the explanatory note, but forbid treating tokens as limits.
        assert!(
            !prompt.contains("token budget"),
            "prompt must not reference token budget"
        );
        assert!(
            !prompt.contains("budget limit"),
            "prompt must not reference budget limit"
        );
        assert!(
            !prompt.contains("budget windows"),
            "prompt must not reference budget windows"
        );
    }

    #[test]
    fn prompt_contains_decision_rules() {
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[], None);
        // The prompt should explain the 3 decision rules.
        assert!(prompt.contains("1."));
        assert!(prompt.contains("2."));
        assert!(prompt.contains("3."));
        // Should explain task failure mapping.
        assert!(prompt.contains("task failure"));
    }

    #[test]
    fn prompt_does_not_mention_old_blocked_decision() {
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[], None);
        // The old "blocked" decision no longer exists.
        assert!(!prompt.contains(r#""blocked""#));
    }

    #[test]
    fn prompt_includes_complete_rule() {
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[], None);
        assert!(prompt.contains("complete"));
        assert!(prompt.contains("completionSummary"));
    }

    #[test]
    fn prompt_includes_continue_rule() {
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[], None);
        assert!(prompt.contains("sessionSummary"));
        assert!(prompt.contains("gaps"));
    }

    #[test]
    fn prompt_includes_pause_rule() {
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[], None);
        assert!(prompt.contains("nextAction"));
    }

    #[test]
    fn prompt_includes_reason_id_list() {
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[], None);
        assert!(prompt.contains("taskIncomplete"));
        assert!(prompt.contains("taskFailure"));
        assert!(prompt.contains("unsafe"));
        assert!(prompt.contains("needsUser"));
        assert!(prompt.contains("done"));
        assert!(prompt.contains("safetyLimit"));
    }

    #[test]
    fn prompt_hardcodes_return_only_json() {
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[], None);
        assert!(prompt.contains("Return ONLY the JSON object"));
    }

    // ── Integration: prompt + normalization (no CLI) ──────────────────

    #[test]
    fn complete_decision_roundtrip() {
        // Simulate what the model would output: finish the goal.
        let json = json!({
            "decision": "complete",
            "reasonId": "done",
            "reason": "The login bug has been fixed — all tests pass and the commit is ready.",
            "completionSummary": "Found the infinite loop in auth.rs:42. Applied fix, wrote regression test, confirmed all 14 existing tests pass. PR branch pushed.",
            "confidence": 0.97
        });
        let result = normalize_evaluation(json);
        assert_eq!(result.decision, GoalDecision::Complete);
        assert_eq!(result.reason_id, GoalReasonId::Done);
        assert!(result.completion_summary.as_ref().unwrap().contains("auth.rs"));
        assert!(result.confidence > 0.9);
    }

    #[test]
    fn continue_decision_roundtrip() {
        // Simulate continue with full fields.
        let json = json!({
            "decision": "continue",
            "reasonId": "taskIncomplete",
            "reason": "Found the issue but fix not applied yet",
            "sessionSummary": "Identified the infinite loop in auth.rs:42",
            "gaps": ["Apply the fix", "Run tests"],
            "confidence": 0.8
        });
        let result = normalize_evaluation(json);
        assert_eq!(result.decision, GoalDecision::Continue);
        assert_eq!(result.session_summary.as_ref().unwrap(), "Identified the infinite loop in auth.rs:42");
        assert_eq!(result.gaps.len(), 2);
    }

    #[test]
    fn task_failure_maps_to_continue() {
        // Task failure must NEVER map to Pause.
        let json = json!({
            "decision": "continue",
            "reasonId": "taskFailure",
            "reason": "Test failed — assertion mismatch",
            "sessionSummary": "Attempted fix but test still failing",
            "gaps": ["Debug the assertion"],
            "confidence": 0.6
        });
        let result = normalize_evaluation(json);
        assert_eq!(result.decision, GoalDecision::Continue);
        assert_eq!(result.reason_id, GoalReasonId::TaskFailure);
        assert_eq!(
            result.session_summary,
            Some("Attempted fix but test still failing".into())
        );
    }

    #[test]
    fn unsafe_maps_to_pause() {
        let json = json!({
            "decision": "pause",
            "reasonId": "unsafe",
            "reason": "Attempted to run DROP TABLE in production",
            "nextAction": "Approve or deny the DDL operation",
            "confidence": 0.99
        });
        let result = normalize_evaluation(json);
        assert_eq!(result.decision, GoalDecision::Pause);
        assert_eq!(result.reason_id, GoalReasonId::Unsafe);
    }

    #[test]
    fn confidence_clamped() {
        let json = json!({
            "decision": "continue",
            "reasonId": "taskIncomplete",
            "reason": "Working",
            "confidence": 1.5
        });
        let result = normalize_evaluation(json);
        assert!(result.confidence <= 1.0);
    }

}
