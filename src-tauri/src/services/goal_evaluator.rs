use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::models::types::{
    AgentResultSnapshot, GoalDecision, GoalEvaluationInput, GoalEvaluationResult, GoalState,
    TranscriptItem,
};
use crate::services::auth_token::inject_api_key;

/// Result of a single goal evaluation call. Mirrors the Electron type and the
/// local `EvaluationResult` in `lib.rs` (camelCase serialized).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationResult {
    pub evaluation: GoalEvaluationResult,
    pub user_message: Option<String>,
}

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const RECENT_ITEMS_WINDOW: usize = 30;

/// Runs the bundled `verboo` CLI in `--print --output-format json` mode with a
/// constructed evaluation prompt, then parses the JSON envelope for the
/// model's decision. Mirrors Electron's `evaluateGoal`
/// (src/main/services/goalEvaluator.ts:19).
pub struct GoalEvaluator;

impl GoalEvaluator {
    /// Builds the evaluation prompt and runs the CLI. Defaults to `continue`
    /// on any error or unparseable output so the agent keeps going instead of
    /// silently halting.
    ///
    /// `api_key` is the user's stored Verboo API key (if any). When present,
    /// it's injected via `OAUTH_TOKEN_FILE` so the evaluator subprocess
    /// authenticates without a separate `verboo auth login`.
    pub fn evaluate(input: GoalEvaluationInput, api_key: Option<&str>) -> EvaluationResult {
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
        let stdout = match run_evaluation_cli(
            &prompt,
            &input.goal.working_directory,
            Duration::from_secs(DEFAULT_TIMEOUT_SECS),
            api_key,
        ) {
            Ok(s) => s,
            Err(_) => return Self::fallback_continue("CLI falhou ao responder."),
        };
        match extract_evaluation_json(&stdout) {
            Some(parsed) => normalize_evaluation(parsed),
            None => Self::fallback_continue("Evaluator could not parse response, defaulting to continue."),
        }
    }

    pub(crate) fn fallback_continue(reason: &str) -> EvaluationResult {
        EvaluationResult {
            evaluation: GoalEvaluationResult {
                decision: GoalDecision::Continue,
                confidence: 0.0,
                reason: reason.into(),
                evidence: Vec::new(),
                missing: vec!["Evaluator output was unparseable".into()],
                next_message: None,
            },
            user_message: None,
        }
    }
}

/// Builds the markdown evaluation prompt. Mirrors `buildEvaluationPrompt`
/// (goalEvaluator.ts:29).
fn build_evaluation_prompt(
    goal: &GoalState,
    items: &[TranscriptItem],
    latest_result: Option<&AgentResultSnapshot>,
) -> String {
    let transcript: String = items
        .iter()
        .filter(|item| item.role != "system" || item.id.starts_with("goal-system:"))
        .map(|item| format!("[{}] {}", item.role, item.text))
        .collect::<Vec<_>>()
        .join("\n\n");

    let now_secs = chrono::Utc::now().timestamp_millis();
    let started_secs = goal.started_at.unwrap_or(now_secs);
    let elapsed_secs = ((now_secs - started_secs).max(0) / 1000) as u64;
    let max_elapsed_secs = goal.max_elapsed_ms / 1000;

    let budget = format!(
        "Turns used: {used}/{max}\nElapsed: {elapsed}s / {max_elapsed}s\nInput tokens: {in_tok}\nOutput tokens: {out_tok}",
        used = goal.turns_run,
        max = goal.max_turns,
        elapsed = elapsed_secs,
        max_elapsed = max_elapsed_secs,
        in_tok = goal.used_input_tokens,
        out_tok = goal.used_output_tokens,
    );

    let latest = if let Some(result) = latest_result {
        let exit_str = result
            .exit_code
            .map(|c| c.to_string())
            .unwrap_or_else(|| "unknown".into());
        let mut lines = vec![format!("Exit code: {exit_str}")];
        if let Some(reason) = result.stop_reason.as_deref() {
            if !reason.is_empty() {
                lines.push(format!("Stop reason: {reason}"));
            }
        }
        if result.is_error.unwrap_or(false) {
            lines.push("ERROR: The last turn ended with an error.".into());
        }
        format!(
            "\n## Latest Result\n{}",
            lines.join("\n")
        )
    } else {
        String::new()
    };

    let transcript_or_empty = if transcript.is_empty() {
        "(empty conversation)".to_string()
    } else {
        transcript
    };

    format!(
        "# Goal Evaluation\n\n\
         ## Objective: {objective}\n\n\
         ## Budget Status\n{budget}\n\n\
         {latest}\n\n\
         ## Conversation Transcript (last {window} messages)\n{transcript}\n\n\
         ## Evaluation Task\n\n\
         Assess whether the objective has been met. Output a JSON object with this structure:\n\
         {{\n\
         \x20 \"decision\": \"complete\" | \"continue\" | \"blocked\",\n\
         \x20 \"confidence\": 0.0-1.0,\n\
         \x20 \"reason\": \"brief justification\",\n\
         \x20 \"evidence\": [\"list of evidence items\"],\n\
         \x20 \"missing\": [\"what is still needed if not complete\"],\n\
         \x20 \"nextMessage\": \"optional suggested next instruction if continuing\"\n\
         }}\n\n\
         Rules:\n\
         - COMPLETE only when you see clear evidence the objective is met.\n\
         - CONTINUE when progress is being made but not done yet.\n\
         - BLOCKED when the agent is stuck, looping, or needs user input.\n\
         - Budget exhaustion is NOT completion.\n\
         - Be strict: the goal is only complete when the evidence is unambiguous.",
        objective = goal.objective,
        budget = budget,
        latest = latest,
        window = RECENT_ITEMS_WINDOW,
        transcript = transcript_or_empty,
    )
}

/// Spawns the CLI with the prompt, waits up to `timeout`, returns stdout.
/// Mirrors `runEvaluationCli` (goalEvaluator.ts:135).
fn run_evaluation_cli(
    prompt: &str,
    working_directory: &str,
    timeout: Duration,
    api_key: Option<&str>,
) -> Result<String, String> {
    let _ = resolve_cli_path()?; // ensures CLI is findable (used for error messages)
    let started = Instant::now();
    let spawn = crate::services::cli_spawn::CliSpawn::new([
        "--print",
        prompt,
        "--output-format",
        "json",
    ]);
    let mut cmd = spawn.command;
    cmd.current_dir(working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let _token_file = inject_api_key(api_key, &mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Falha ao spawn CLI: {e}"))?;

    // Poll for exit until timeout, then kill.
    while started.elapsed() < timeout {
        match child.try_wait() {
            Ok(Some(_status)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|e| format!("Falha ao ler saída: {e}"))?;
                return Ok(String::from_utf8_lossy(&output.stdout).to_string());
            }
            Ok(None) => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("Falha ao esperar CLI: {e}")),
        }
    }
    // Timeout — kill and read whatever we have.
    let _ = child.kill();
    let _ = child.wait();
    Err("Timeout ao esperar pelo CLI".into())
}

/// Resolves the CLI path. Mirrors `resolveCliPath`. Order:
///   1. `VERBOO_CLI_PATH` env var
///   2. `verboo` on PATH (OS resolves)
fn resolve_cli_path() -> Result<String, String> {
    Ok(crate::services::cli_path::resolve().unwrap_or_else(|| "verboo".to_string()))
}

/// Pulls the evaluation JSON out of the CLI's stdout. The CLI wraps the
/// model's reply in an envelope `{"type":"result", ..., "result":"<json>"}`.
/// The evaluation JSON may live inside `.result` (stringified) or at the top
/// level. Mirrors `extractEvaluationJson` (goalEvaluator.ts:169).
fn extract_evaluation_json(stdout: &str) -> Option<serde_json::Value> {
    let envelope = parse_first_json_object(stdout)?;
    if let Some(result_str) = envelope.get("result").and_then(|v| v.as_str()) {
        if let Some(inner) = parse_first_json_object(result_str) {
            if inner.get("decision").and_then(|v| v.as_str()).is_some() {
                return Some(inner);
            }
        }
    }
    if envelope.get("decision").and_then(|v| v.as_str()).is_some() {
        return Some(envelope);
    }
    None
}

/// Finds and parses the first `{...}` substring in `text`. Mirrors
/// `parseFirstJsonObject` (goalEvaluator.ts:192).
fn parse_first_json_object(text: &str) -> Option<serde_json::Value> {
    let start = text.find('{')?;
    // Find the matching closing brace by counting nesting depth. The regex
    // `\{[\s\S]*\}` in Electron is greedy and would over-match when several
    // JSON objects appear, so we mirror its behavior by taking the *last* `}`
    // — but only after verifying the slice is valid JSON. To stay closer to
    // Electron's greedy semantics, we use the last `}` in the text.
    let end = text.rfind('}')?;
    if end < start {
        return None;
    }
    let slice = &text[start..=end];
    let parsed: serde_json::Value = serde_json::from_str(slice).ok()?;
    if parsed.is_object() {
        Some(parsed)
    } else {
        None
    }
}

/// Normalizes a parsed JSON object into a typed `GoalEvaluationResult`.
/// Mirrors the validation in `runGoalEvaluation` (goalEvaluator.ts:113).
fn normalize_evaluation(value: serde_json::Value) -> EvaluationResult {
    let obj = match value.as_object() {
        Some(o) => o,
        None => return GoalEvaluator::fallback_continue("Evaluation payload was not an object"),
    };
    let decision = match obj.get("decision").and_then(|v| v.as_str()) {
        Some("complete") => GoalDecision::Complete,
        Some("continue") => GoalDecision::Continue,
        Some("blocked") => GoalDecision::Blocked,
        _ => return GoalEvaluator::fallback_continue("Unknown decision"),
    };
    let confidence = obj
        .get("confidence")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let reason = obj
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let evidence = collect_string_array(obj, "evidence");
    let missing = collect_string_array(obj, "missing");
    let next_message = obj
        .get("nextMessage")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let user_message = if decision == GoalDecision::Complete {
        None
    } else {
        next_message.clone()
    };
    EvaluationResult {
        evaluation: GoalEvaluationResult {
            decision,
            confidence,
            reason,
            evidence,
            missing,
            next_message,
        },
        user_message,
    }
}

fn collect_string_array(
    obj: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Vec<String> {
    obj.get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{AccessMode, GoalStatus};
    use serde_json::json;

    fn sample_goal() -> GoalState {
        GoalState {
            id: "g1".into(),
            objective: "Build feature X".into(),
            status: GoalStatus::Active,
            created_at: 0,
            updated_at: 0,
            started_at: Some(0),
            completed_at: None,
            paused_at: None,
            pause_reason: None,
            last_evaluation: None,
            last_session_id: None,
            last_turn_id: None,
            turns_run: 3,
            max_turns: 10,
            max_elapsed_ms: 600_000,
            max_input_tokens: None,
            used_input_tokens: 1000,
            used_output_tokens: 500,
            access_mode: AccessMode::Auto,
            model_id: None,
            model_display_name: None,
            working_directory: "/tmp".into(),
            skills: Vec::new(),
            no_progress_count: 0,
            recent_fingerprints: Vec::new(),
        }
    }

    #[test]
    fn parse_first_json_object_handles_envelope() {
        let text = "noise before\n{\"type\":\"result\",\"result\":\"{}\"}\nafter";
        let parsed = parse_first_json_object(text).expect("should parse");
        assert_eq!(parsed["type"], "result");
    }

    #[test]
    fn parse_first_json_object_returns_none_without_braces() {
        assert!(parse_first_json_object("plain text").is_none());
        assert!(parse_first_json_object("").is_none());
    }

    #[test]
    fn extract_evaluation_json_unwraps_envelope_result() {
        let inner = json!({
            "decision": "complete",
            "confidence": 0.9,
            "reason": "done",
        })
        .to_string();
        let envelope = json!({
            "type": "result",
            "result": inner,
        })
        .to_string();
        let parsed = extract_evaluation_json(&envelope).expect("should parse");
        assert_eq!(parsed["decision"], "complete");
        assert_eq!(parsed["confidence"], 0.9);
    }

    #[test]
    fn extract_evaluation_json_handles_top_level_decision() {
        let envelope = json!({
            "decision": "continue",
            "confidence": 0.2,
        })
        .to_string();
        let parsed = extract_evaluation_json(&envelope).expect("should parse");
        assert_eq!(parsed["decision"], "continue");
    }

    #[test]
    fn extract_evaluation_json_returns_none_for_unknown_shape() {
        let text = json!({"type": "result", "result": "not json"}).to_string();
        assert!(extract_evaluation_json(&text).is_none());
        assert!(extract_evaluation_json("no json at all").is_none());
    }

    #[test]
    fn normalize_complete_decision() {
        let value = json!({
            "decision": "complete",
            "confidence": 0.95,
            "reason": "all tests pass",
            "evidence": ["test_a", "test_b"],
            "missing": [],
            "nextMessage": "ship it",
        });
        let result = normalize_evaluation(value);
        assert_eq!(result.evaluation.decision, GoalDecision::Complete);
        assert_eq!(result.evaluation.confidence, 0.95);
        assert_eq!(result.evaluation.reason, "all tests pass");
        assert_eq!(result.evaluation.evidence.len(), 2);
        // user_message is None when complete (even if nextMessage present).
        assert!(result.user_message.is_none());
    }

    #[test]
    fn normalize_continue_decision_carries_next_message() {
        let value = json!({
            "decision": "continue",
            "confidence": 0.4,
            "reason": "progress",
            "nextMessage": "try X next",
        });
        let result = normalize_evaluation(value);
        assert_eq!(result.evaluation.decision, GoalDecision::Continue);
        assert_eq!(result.user_message.as_deref(), Some("try X next"));
    }

    #[test]
    fn normalize_blocked_decision_carries_next_message() {
        let value = json!({
            "decision": "blocked",
            "nextMessage": "need user input",
        });
        let result = normalize_evaluation(value);
        assert_eq!(result.evaluation.decision, GoalDecision::Blocked);
        assert_eq!(result.user_message.as_deref(), Some("need user input"));
    }

    #[test]
    fn normalize_unknown_decision_falls_back_to_continue() {
        let value = json!({"decision": "unknown"});
        let result = normalize_evaluation(value);
        assert_eq!(result.evaluation.decision, GoalDecision::Continue);
        assert!(result.evaluation.reason.contains("Unknown"));
    }

    #[test]
    fn normalize_non_object_falls_back() {
        let result = normalize_evaluation(json!(["not an object"]));
        assert_eq!(result.evaluation.decision, GoalDecision::Continue);
    }

    #[test]
    fn normalize_handles_missing_optional_fields() {
        let value = json!({"decision": "continue"});
        let result = normalize_evaluation(value);
        assert_eq!(result.evaluation.confidence, 0.0);
        assert_eq!(result.evaluation.reason, "");
        assert!(result.evaluation.evidence.is_empty());
        assert!(result.evaluation.missing.is_empty());
        assert!(result.evaluation.next_message.is_none());
        assert!(result.user_message.is_none());
    }

    #[test]
    fn normalize_filters_non_string_evidence() {
        let value = json!({
            "decision": "complete",
            "evidence": ["valid", 42, {"nested": "v"}, "also-valid"],
        });
        let result = normalize_evaluation(value);
        assert_eq!(result.evaluation.evidence.len(), 2);
        assert!(result.evaluation.evidence.contains(&"valid".into()));
        assert!(result.evaluation.evidence.contains(&"also-valid".into()));
    }

    #[test]
    fn build_prompt_includes_objective_budget_and_transcript() {
        let goal = sample_goal();
        let items = vec![TranscriptItem {
            id: "i1".into(),
            role: "user".into(),
            text: "Hello world".into(),
            timestamp: 0,
            kind: None,
            activity_kind: None,
            activity_detail: None,
            command: None,
            change_summary: None,
            model_id: None,
            model_display_name: None,
            streaming: None,
            skills: None,
        }];
        let prompt = build_evaluation_prompt(&goal, &items, None);
        assert!(prompt.contains("# Goal Evaluation"));
        assert!(prompt.contains("Build feature X"));
        assert!(prompt.contains("Turns used: 3/10"));
        assert!(prompt.contains("Input tokens: 1000"));
        assert!(prompt.contains("[user] Hello world"));
        assert!(prompt.contains("\"decision\": \"complete\""));
    }

    #[test]
    fn build_prompt_filters_system_items_except_goal_system() {
        let goal = sample_goal();
        let items = vec![
            TranscriptItem {
                id: "system:1".into(),
                role: "system".into(),
                text: "should be filtered".into(),
                timestamp: 0,
                kind: None,
                activity_kind: None,
                activity_detail: None,
                command: None,
                change_summary: None,
                model_id: None,
                model_display_name: None,
                streaming: None,
                skills: None,
            },
            TranscriptItem {
                id: "goal-system:1".into(),
                role: "system".into(),
                text: "should be kept".into(),
                timestamp: 0,
                kind: None,
                activity_kind: None,
                activity_detail: None,
                command: None,
                change_summary: None,
                model_id: None,
                model_display_name: None,
                streaming: None,
                skills: None,
            },
        ];
        let prompt = build_evaluation_prompt(&goal, &items, None);
        assert!(!prompt.contains("should be filtered"));
        assert!(prompt.contains("should be kept"));
    }

    #[test]
    fn build_prompt_shows_latest_result_section_when_present() {
        let goal = sample_goal();
        let latest = AgentResultSnapshot {
            turn_id: "t1".into(),
            exit_code: Some(0),
            session_id: Some("s1".into()),
            stop_reason: Some("end_turn".into()),
            is_error: Some(false),
            usage: None,
            permission_denials: None,
            errors: None,
            raw_result: None,
        };
        let prompt = build_evaluation_prompt(&goal, &[], Some(&latest));
        assert!(prompt.contains("## Latest Result"));
        assert!(prompt.contains("Exit code: 0"));
        assert!(prompt.contains("Stop reason: end_turn"));
        assert!(!prompt.contains("ERROR"));
    }

    #[test]
    fn build_prompt_marks_error_in_latest_result() {
        let goal = sample_goal();
        let latest = AgentResultSnapshot {
            turn_id: "t1".into(),
            exit_code: Some(1),
            session_id: Some("s1".into()),
            stop_reason: None,
            is_error: Some(true),
            usage: None,
            permission_denials: None,
            errors: None,
            raw_result: None,
        };
        let prompt = build_evaluation_prompt(&goal, &[], Some(&latest));
        assert!(prompt.contains("ERROR: The last turn ended with an error."));
    }

    #[test]
    fn build_prompt_uses_empty_marker_when_no_transcript() {
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[], None);
        assert!(prompt.contains("(empty conversation)"));
    }
}
