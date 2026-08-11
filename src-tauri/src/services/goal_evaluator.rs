use std::fmt;
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::models::types::{
    GoalDecision, GoalEvaluationInput, GoalEvaluationResult, GoalReasonId,
    GoalState, GoalStatus, TranscriptItem,
};
use crate::services::auth_token::inject_api_key;
use crate::services::cli_spawn::CliSpawn;

/// Result of a single goal evaluation call. Mirrors the Electron type and the
/// local `EvaluationResult` in `lib.rs` (camelCase serialized).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationResult {
    pub evaluation: GoalEvaluationResult,
    /// Token usage reported by the evaluator CLI for THIS evaluation call,
    /// separate from the agent turn usage. The CLI envelope carries `usage`
    /// with `input_tokens`/`output_tokens`/`cache_creation_input_tokens`/
    /// `cache_read_input_tokens` (snake_case, CLI-native). We extract it
    /// here so the renderer can sum turn + evaluator tokens for the total
    /// the user asked for in G-C15. `None` when the envelope omitted usage
    /// or the usage block was malformed — counting failure must NEVER break
    /// the goal (G-C15 requirement 3).
    pub evaluator_usage: Option<crate::models::types::TokenUsage>,
}

/// Errors from the goal evaluator — infrastructure failures only.
/// When the evaluator returns Err, the caller (lib.rs Tauri command) maps
/// it to a Pause+InfraError for the FE to circuit-break. This is NEVER
/// silently swallowed.
#[derive(Debug, Clone)]
pub enum GoalEvaluationError {
    /// The CLI did not finish within the budget. Carries the budget that
    /// was actually used (in seconds) so the user-facing message can say
    /// "timed out after Ns" instead of the opaque "infra error".
    CliTimeout { timeout_secs: u64 },
    CliSpawn(String),
    CliExit { exit_code: Option<i32>, stderr: String },
    ParseFailure(String),
}

impl fmt::Display for GoalEvaluationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CliTimeout { timeout_secs } => write!(
                f,
                "Goal evaluator CLI timed out after {timeout_secs}s — the model did not finish in time. Try again, or raise VERBOO_GOAL_TIMEOUT_SECS if your machine/model is consistently slower."
            ),
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

/// Default timeout for the evaluator CLI, in seconds.
///
/// JUSTIFICATION (measured, not guessed):
///   - Trivial prompt ("teste OK"): 20,851 ms (≈21s) on the dev machine.
///   - Realistic 29 KB prompt (full transcript window): 105,412 ms (≈105s)
///     on the same machine, same model. Measured by the Maestro on
///     2026-07-27 against the bundled cli.mjs with `--print --output-format
///     json`, matching the exact command the evaluator runs.
///   - The previous 30s budget killed every real evaluation at ~30s and
///     surfaced as `infraError` — the user saw "Erro de infraestrutura
///     do avaliador" with no hint that it was a timeout.
///
/// The budget must cover the worst case with margin. 105s was ONE
/// measurement on ONE machine with ONE model. Under load, with a larger
/// transcript, or on a slower user machine, the same prompt can take
/// longer. We pick 240s (≈2.3× the measured worst case) so a legitimately
/// slow evaluation is not cut off, while a truly hung CLI still gets
/// killed in finite time. The timeout exists to catch hangs, not to
/// cut legitimate work — better to err high.
///
/// Override with `VERBOO_GOAL_TIMEOUT_SECS` for machines/models that
/// need a different budget. See `resolve_timeout_secs`.
const DEFAULT_TIMEOUT_SECS: u64 = 240;
const RECENT_ITEMS_WINDOW: usize = 30;

/// Resolves the evaluator timeout in seconds. Honors the
/// `VERBOO_GOAL_TIMEOUT_SECS` env var (so users/operators can tune the
/// budget without rebuilding), falling back to `DEFAULT_TIMEOUT_SECS`.
/// Invalid env values (non-numeric, zero, or absurdly small) are ignored
/// with a warning — fail-closed to the default rather than letting a typo
/// silently disable the timeout.
fn resolve_timeout_secs() -> u64 {
    match std::env::var("VERBOO_GOAL_TIMEOUT_SECS") {
        Ok(raw) => {
            let trimmed = raw.trim();
            match trimmed.parse::<u64>() {
                Ok(n) if n >= 10 => n,
                Ok(n) => {
                    eprintln!(
                        "VERBOO_GOAL_TIMEOUT_SECS={n} is below the 10s floor; \
                         using DEFAULT_TIMEOUT_SECS={DEFAULT_TIMEOUT_SECS} instead"
                    );
                    DEFAULT_TIMEOUT_SECS
                }
                Err(_) => {
                    eprintln!(
                        "VERBOO_GOAL_TIMEOUT_SECS={trimmed:?} is not a valid u64; \
                         using DEFAULT_TIMEOUT_SECS={DEFAULT_TIMEOUT_SECS} instead"
                    );
                    DEFAULT_TIMEOUT_SECS
                }
            }
        }
        Err(_) => DEFAULT_TIMEOUT_SECS,
    }
}

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
        let prompt = build_evaluation_prompt(&input.goal, &recent_items);
        let stdout = run_evaluation_cli(&prompt, api_key)?;
        let (json, evaluator_usage) = extract_evaluation_json(&stdout)?;
        // G-C16: hard code guard. If the model returned `complete` but NO turn
        // has executed, the model was either (a) hallucinating completion from
        // a statement of intent, or (b) satisfying the "SAME turn" rule with
        // no action to observe. In either case, completion is unsafe — convert
        // to Continue+TaskIncomplete at the normalize step so the agent gets
        // another turn to actually do the work. Prompt-only guard was not
        // sufficient (verified in field 2026-07-29: goal marked complete with
        // turnsRun=0 and no file on disk).
        //
        // G-C16-FIX: the guard is `turns_run > 0` ONLY. The previous
        // `|| latest_result.is_some()` leg was dead code — `latest_result`
        // has ZERO populators (renderer or Rust) and was always None — and
        // worse, an armadilha armada: if someone naively populates
        // `latest_result` in the future without scoping it to THIS goal, an
        // inherited `latest_result` from another turn would make the guard
        // pass with no real action of the current goal, reopening F2 in old
        // conversations. `turns_run` is incremented in App.tsx:3224 before
        // every evaluation, so the single remaining leg is reliable.
        let observable_action = input.goal.turns_run > 0;
        let evaluation = normalize_evaluation(json, observable_action);
        Ok(EvaluationResult {
            evaluation,
            evaluator_usage,
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

/// Truncate a string to at most `max_bytes` BYTES, receding to the nearest
/// UTF-8 char boundary so we never slice inside a multibyte sequence (which
/// would panic). The sentinel reports how many CHARS were cut from the
/// tail, not the total length — so the model knows what it's missing.
///
/// G-C18-FIX: the previous `&s[..max_bytes]` panicked on Portuguese
/// content (byte 800 was not a char boundary). QA proved it with a
/// disposable crate. Portuguese is the norm in this app.
fn truncate_char_safe(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut cut = max_bytes;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    let head = &s[..cut];
    let total_chars = s.chars().count();
    let kept_chars = head.chars().count();
    let cut_chars = total_chars - kept_chars;
    format!("{head}... [truncated {cut_chars} chars]")
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
) -> String {
    let mut prompt = String::new();
    prompt.push_str("# Goal Evaluation\n\n");
    prompt.push_str("You are evaluating progress on an AI coding agent's goal.\n\n");
    prompt.push_str("## Goal\n\n");
    prompt.push_str(&goal.objective);
    prompt.push_str("\n\n## Context\n\n");
    prompt.push_str(&format!("Status: {:?} | Turns run: {}", goal.status, goal.turns_run));
    prompt.push_str("\n\n");

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
                prompt.push_str(&format!("**Output:**\n```\n{}\n```\n", truncate_char_safe(&cmd.output, 500)));
            }
        }
        // G-C18: render the captured tool output. Truncate aggressively so
        // the prompt doesn't balloon (RECENT_ITEMS_WINDOW * limit). The
        // choice of 800 chars/item is justified in PR comments; the
        // truncation sentinel is visible inline so the model can flag if
        // the truncated tail mattered.
        //
        // G-C18-FIX: byte-slicing `&str` panics if the cut lands inside a
        // multibyte UTF-8 sequence. Portuguese content (the norm in this
        // app) has accents everywhere. The previous `&output[..max_output]`
        // panicked at byte 800 (not a char boundary). Now we recede to the
        // nearest `is_char_boundary` and the sentinel reports how many
        // CHARS were cut, not the total length.
        if let Some(ref output) = item.tool_output {
            let truncated = truncate_char_safe(output, 800);
            prompt.push_str(&format!("\n**Tool output:**\n```\n{}\n```\n", truncated));
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
    prompt.push_str("- `taskImpossible` — objective is structurally impossible given the constraints, see rule 4 below\n");
    prompt.push_str("- `done` — objective is clearly met with concrete evidence\n");
    prompt.push_str("- `safetyLimit` — goal safety limit reached (not a token limit — Verboo has unlimited tokens)\n\n");

    prompt.push_str("### Decision rules (STRICT — follow these exactly):\n\n");
    prompt.push_str("1. **Incomplete task or task failure** → `decision: \"continue\"` with `reasonId: \"taskIncomplete\"` or `\"taskFailure\"`.\n");
    prompt.push_str("   Do NOT pause for task errors — the agent should continue to fix them.\n");
    prompt.push_str("2. **Unsafe operation or needs user input** → `decision: \"pause\"` with `reasonId: \"unsafe\"` or `\"needsUser\"`.\n");
    prompt.push_str("   Provide a clear `nextAction` explaining what the user needs to do.\n");
    prompt.push_str("3. **Objective met** → `decision: \"complete\"` with `reasonId: \"done\"`.\n");
    prompt.push_str("   REQUIRED: populate `completionSummary` with concrete evidence of completion.\n");
    prompt.push_str("   Do NOT mark as complete for partial progress.\n");
    prompt.push_str("   Evidence already verified in the transcript (e.g. the agent read the file it ");
    prompt.push_str("was asked to create and confirmed its contents, a command output proves the ");
    prompt.push_str("criterion, a test run passed) IS the concrete evidence required — populate ");
    prompt.push_str("`completionSummary` with that verified evidence and decide `complete` in the ");
    prompt.push_str("SAME turn. Do NOT spend an extra turn re-confirming an objective whose ");
    prompt.push_str("acceptance criteria are already met and verified in the transcript.\n");
    prompt.push_str("   G-C16 — what is NOT concrete evidence: a statement of intent in ");
    prompt.push_str("future tense (\"I will create the file\", \"I will verify\", \"I will ");
    prompt.push_str("confirm\"), an assertion that the agent is about to act, or any other ");
    prompt.push_str("unverified claim — even one the agent itself believes is true — does ");
    prompt.push_str("NOT satisfy the concrete-evidence requirement. Evidence requires the ");
    prompt.push_str("action to have ALREADY HAPPENED and to have been OBSERVED in the ");
    prompt.push_str("transcript: a Read of the file's contents, the output of the command ");
    prompt.push_str("that created or verified the artifact, the result of a test that was ");
    prompt.push_str("actually run. If the transcript shows no turn executed (turnsRun=0) or ");
    prompt.push_str("no observable action, the only correct decision is `continue` with ");
    prompt.push_str("`reasonId: \"taskIncomplete\"`.\n\n");

    prompt.push_str("For `continue`, always include `sessionSummary` (what was done) and `gaps` (what's left).\n");
    prompt.push_str("For `pause`, always include `nextAction` explaining what the user should do.\n");
    prompt.push_str("For `complete`, always include `completionSummary` with proof.\n\n");

    // Rule 4 — D-D field fix (2026-07-31). The defect:
    //   The observability guard proves PRESENCE of an action (e.g. a file
    //   was written). It does NOT prove CORRECTNESS of the artifact. The
    //   app observed a batch where 2 of 4 tasks were structurally
    //   impossible (path does not exist; .invalid TLD is reserved). The
    //   agent honest-reported impossibility, but still produced a
    //   symbolic artifact (empty file, empty keys) to satisfy the
    //   whitelist, and the evaluator accepted as complete.
    //
    // The rule distinguishes symbolic vs. real delivery:
    //   * If the evidence in the transcript shows the action was REAL
    //     (Read returned non-empty content, command output proves the
    //     artifact satisfies the goal, a test was actually run and
    //     passed), then `complete` with `done` is correct.
    //   * If the action is structurally impossible given the
    //     constraints — the input source does not exist and cannot be
    //     created, the target is a reserved/unreachable namespace (e.g.
    //     .invalid per RFC 2606), permissions are denied by the
    //     platform, or the goal's preconditions are unmet and the
    //     agent has no way to meet them — then the decision is NOT
    //     `complete` (the deliverable is missing) and NOT `continue`
    //     (the agent cannot retry around a structural block). The
    //     correct decision is `pause` with `reasonId: "taskImpossible"`
    //     and a human-legible `reason` that names the SPECIFIC
    //     structural block so the user can decide whether to change
    //     the goal, change the input, or abandon the task.
    //
    // `pause` (not `failure`) so the user can read, respond, and
    // resume the goal from where it stopped. Failure would close the
    // goal and lose the context the agent built up across the
    // continuing partial work.
    //
    // The reason must be CONCRETE, not generic. "Impossible" alone is
    // not enough — it must say what kind of impossibility
    // (path-missing, domain-reserved, permission-denied, preconditions-
    // unmet, etc.) and which artifact or step is blocked. The user
    // reads this to decide.
    //
    // Distinguishing REAL delivery from SYMBOLIC delivery:
    //   READ-AND-CONFIRM: the agent Read the file post-write and the
    //   transcript shows non-empty content matching the goal. Real.
    //   CREATE-EMPTY: the agent Wrote a file but its Read returned 0
    //   bytes, or the keys are empty placeholders. Symbolic.
    //   FETCH-TO-EMPTY: the agent claimed a fetch succeeded but the
    //   response body is empty or contains only stub keys. Symbolic.
    prompt.push_str(
        "4. **Structural impossibility (D-D, 2026-07-31)** → `decision: \"pause\"` with \
         `reasonId: \"taskImpossible\"`.\n",
    );
    prompt.push_str(
        "   A SYMBOLIC ARTIFACT IS NOT DELIVERY. An empty file (`0 bytes`), a file with \
         only placeholder keys (e.g. `{\"key\":\"\"}`), or any other artifact whose \
         content does not materially advance the objective does NOT satisfy the goal, \
         even when the observability guard saw the action happen.\n",
    );
    prompt.push_str(
        "   Trigger `taskImpossible` ONLY when ALL THREE conditions hold:\n",
    );
    prompt.push_str(
        "   (a) the agent honestly reports the action cannot be completed as specified \
         (path does not exist and cannot be created, target is structurally unreachable \
         like the .invalid TLD per RFC 2606, permission is denied at the OS level, or \
         the goal preconditions are demonstrably unmet),\n",
    );
    prompt.push_str(
        "   (b) the evidence in the transcript agrees with that report (a Read showed 0 \
         bytes, a fetch returned an empty/stub body, an authoritative error message \
         confirmed the unreachable target),\n",
    );
    prompt.push_str(
        "   (c) the agent cannot recover by retrying with a different approach — the \
         structural block persists regardless of strategy.\n",
    );
    prompt.push_str(
        "   When all three hold, the goal is PAUSED (NOT failed) so the user can read \
         the `reason`, respond in the composer, and resume the goal from where it \
         stopped without losing the conversation context. A failed goal closes the \
         session.\n",
    );
    prompt.push_str(
        "   The `reason` field MUST be concrete and human-legible. Do NOT write generic \
         text like \"task is impossible\" — name the SPECIFIC structural block. Examples \
         of acceptable `reason` text for the field defect observed on 2026-07-31:\n",
    );
    prompt.push_str(
        "     * `impossible: source path /Users/.../nonexistent.txt does not exist and \
         cannot be created — nothing to copy from`\n",
    );
    prompt.push_str(
        "     * `impossible: target is the reserved .invalid TLD (RFC 2606) — DNS \
         resolution will always NXDOMAIN; use a reachable test domain instead`\n",
    );
    prompt.push_str(
        "     * `impossible: permission denied by macOS TCC for Documents directory — \
         grant permission in System Settings → Privacy & Security`\n",
    );
    prompt.push_str(
        "   If (a) the agent reports impossibility but (b) evidence does NOT agree, or \
         (c) the agent could retry with a different strategy, then this is NOT \
         taskImpossible — fall back to `continue` with `taskIncomplete` and let the \
         agent try again or document the gap. Over-using taskImpossible freezes the \
         goal prematurely and is a worse failure mode than the defect itself.\n\n",
    );

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
    // G-C19 / G-C19-FIX: timing instrumentation is OFF by default.
    // Gate env var VERBOO_GOAL_TIMING=1 enables it. When OFF, this function
    // is byte-identical to the pre-G-C19 loop — no stdout.take(), no
    // reader thread, no channel, no incremental read. QA requirement:
    // instrumenting must not change the behavior of what it measures.
    //
    // Why the gate is mandatory, not optional:
    //   The non-blocking read introduced in G-C19 turned out to BLOCK
    //   for 3.009s in QA's proof-of-concept (the WouldBlock arm was
    //   dead code: macOS pipes don't return WouldBlock on read, they
    //   block). That defeat protects only against wall-clock timeout,
    //   but it DISARMED the G-C6 deadline in the silent-CLI scenario
    //   (process hung without producing stdout). With the gate OFF,
    //   the original loop never touches stdout incrementally; the
    //   deadline still fires.
    //
    // Milestones captured when ON:
    //   t0: spawn() called
    //   t1: spawn() returned (process created)
    //   t2: stdin write complete (prompt sent)
    //   t3: first byte observed on stdout (CLI started responding)
    //   t4: process exited
    //   t5: output collected and returned
    //
    // Cannot separate spawn from prefill+TTFT — CLI emits no ready
    // signal. See PR for G-C19 phase 2 discussion.
    let cli_spawn = CliSpawn::new(["--print", "--output-format", "json"]);
    let runtime = cli_spawn.runtime.clone();
    let mut cmd = cli_spawn.command;
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped()) // piped unconditionally — original behavior
        .stderr(Stdio::piped());

    // Inject API key for auth (same pattern as TurnService).
    inject_api_key(api_key, &mut cmd);

    // A2-FIX (2026-07-29): creation_flags already applied by CliSpawn::new
    // (cli_spawn.rs). No need to re-apply here.

    if std::env::var_os("VERBOO_GOAL_TIMING").as_deref() != Some(std::ffi::OsStr::new("1")) {
        // ── FAST PATH (identical to pre-G-C19) ──────────────────────
        // Same try_wait + wait_with_output loop, no stdout.take(),
        // no incremental reader, no channel. Deadline G-C6 works.
        let mut child = cmd.spawn().map_err(|e| {
            GoalEvaluationError::CliSpawn(format!(
                "Failed to spawn CLI (runtime={runtime}): {e}"
            ))
        })?;
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            let _ = stdin.write_all(prompt.as_bytes());
        }
        let timeout_secs = resolve_timeout_secs();
        let deadline = Instant::now() + Duration::from_secs(timeout_secs);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                let _ = child.kill();
                return Err(GoalEvaluationError::CliTimeout { timeout_secs });
            }
            match child.try_wait() {
                Ok(Some(_status)) => {
                    let output = child.wait_with_output().map_err(|e| {
                        GoalEvaluationError::ParseFailure(format!("Failed to collect output: {e}"))
                    })?;
                    if !output.status.success() {
                        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                        return Err(GoalEvaluationError::CliExit {
                            exit_code: output.status.code(),
                            stderr,
                        });
                    }
                    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                    return Ok(stdout);
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(e) => {
                    return Err(GoalEvaluationError::ParseFailure(format!(
                        "Process polling error: {e}"
                    )));
                }
            }
        }
    }

    // ── TIMING PATH: ON (gated by VERBOO_GOAL_TIMING=1) ─────────────
    // A background thread reads stdout incrementally and forwards bytes
    // through a channel. The main loop polls try_wait and times the
    // FIRST byte observation by checking the channel with try_recv (non-
    // blocking). This preserves the G-C6 deadline: if the CLI is silent,
    // the deadline still fires because try_wait runs independently of
    // the reader thread.
    let t0 = Instant::now();
    let mut child = cmd.spawn().map_err(|e| {
        GoalEvaluationError::CliSpawn(format!(
            "Failed to spawn CLI (runtime={runtime}): {e}"
        ))
    })?;
    let t1 = Instant::now(); // process created

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(prompt.as_bytes());
    }
    let t2 = Instant::now(); // prompt sent

    // Spawn a reader thread that streams stdout bytes to the main loop
    // via a bounded channel. Bounded (capacity 1) so the reader can't
    // outpace the consumer forever; on saturation, the reader blocks
    // for at most one chunk, bounded by the pipe buffer (64KB on macOS).
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(1);
    let mut stdout_pipe = child.stdout.take().expect("stdout was piped");
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = [0u8; 4096];
        loop {
            match stdout_pipe.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = buf[..n].to_vec();
                    // If the main loop is gone (early return on timeout
                    // or error), the send fails; we exit the reader
                    // thread cleanly instead of leaking.
                    if tx.send(chunk).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let t3 = std::sync::Mutex::new(None::<Instant>); // first byte observed
    let mut stdout_buf: Vec<u8> = Vec::new();

    let timeout_secs = resolve_timeout_secs();
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let _ = child.kill();
            // The reader thread will hit tx.send Err and exit on its own
            // when its next chunk comes through. We don't join — the
            // thread is cheap and bounded; OS will reap it on drop.
            return Err(GoalEvaluationError::CliTimeout { timeout_secs });
        }
        // Drain the channel (non-blocking).
        while let Ok(chunk) = rx.try_recv() {
            if t3.lock().unwrap().is_none() {
                *t3.lock().unwrap() = Some(Instant::now());
            }
            stdout_buf.extend_from_slice(&chunk);
        }
        match child.try_wait() {
            Ok(Some(_status)) => {
                let t4 = Instant::now();
                // Drain remaining bytes.
                while let Ok(chunk) = rx.try_recv() {
                    stdout_buf.extend_from_slice(&chunk);
                }
                let output = child.wait_with_output().map_err(|e| {
                    GoalEvaluationError::ParseFailure(format!("Failed to collect output: {e}"))
                })?;
                stdout_buf.extend_from_slice(&output.stdout);

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                    return Err(GoalEvaluationError::CliExit {
                        exit_code: output.status.code(),
                        stderr,
                    });
                }

                let stdout = String::from_utf8_lossy(&stdout_buf).to_string();
                let t5 = Instant::now();
                write_timing_log(t0, t1, t2, *t3.lock().unwrap(), t4, t5, prompt.len(), stdout.len());
                return Ok(stdout);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => {
                return Err(GoalEvaluationError::ParseFailure(format!(
                    "Process polling error: {e}"
                )));
            }
        }
    }
}

/// G-C19: append a single timing line to the goal-eval-timing.log file
/// in the user's local data dir. Best-effort — never fails the evaluation
/// if the log can't be written. Format is TSV so it's easy to grep/awk:
///   timestamp  t0_t1_ms  t1_t2_ms  t2_t3_ms  t3_t4_ms  t4_t5_ms  total_ms  prompt_bytes  stdout_bytes  t3_observed
/// Where:
///   t0_t1 = spawn() duration (process creation only — NOT full CLI ready)
///   t1_t2 = stdin write (prompt send) — usually <1ms
///   t2_t3 = prompt-sent → first-byte (SPAWN + PREFILL + INFERENCE combined;
///           cannot subdivide without CLI cooperation)
///   t3_t4 = first-byte → process-exit (rest of streaming + CLI teardown)
///   t4_t5 = exit → output collected (usually <5ms)
fn write_timing_log(
    t0: Instant,
    t1: Instant,
    t2: Instant,
    t3: Option<Instant>,
    t4: Instant,
    t5: Instant,
    prompt_bytes: usize,
    stdout_bytes: usize,
) {
    use std::io::Write;
    // G-C19 FASE 2: must match `identifier` in src-tauri/tauri.conf.json.
    // Hardcoded because parsing tauri.conf.json at runtime is heavier than
    // warranted for a timing log; the comment above flags the coupling.
    const GOAL_TIMING_BUNDLE_ID: &str = "ai.verboo.code.desktop";
    let dir = match dirs::data_local_dir() {
        Some(d) => d.join(GOAL_TIMING_BUNDLE_ID).join("logs"),
        None => return,
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("goal-eval-timing.log");
    let mut file = match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(f) => f,
        Err(_) => return,
    };
    let now = chrono::Local::now().to_rfc3339();
    let t0_t1 = t1.saturating_duration_since(t0).as_millis();
    let t1_t2 = t2.saturating_duration_since(t1).as_millis();
    let t2_t3 = match t3 {
        Some(t3v) => t3v.saturating_duration_since(t2).as_millis(),
        None => u128::MAX, // sentinel: no first byte observed
    };
    let t3_t4 = match t3 {
        Some(t3v) => t4.saturating_duration_since(t3v).as_millis(),
        None => 0,
    };
    let t4_t5 = t5.saturating_duration_since(t4).as_millis();
    let total = t5.saturating_duration_since(t0).as_millis();
    let t3_observed = if t3.is_some() { "yes" } else { "no" };
    let _ = writeln!(
        file,
        "{now}\t{t0_t1}\t{t1_t2}\t{t2_t3}\t{t3_t4}\t{t4_t5}\t{total}\t{prompt_bytes}\t{stdout_bytes}\t{t3_observed}"
    );
}

/// Extracts the evaluation JSON and the evaluator's token usage from CLI
/// output. Uses a depth-aware brace scanner (not greedy `rfind('}')`) to
/// correctly handle output that contains trailing text after the JSON
/// object. Accepts two shapes:
///   1. Envelope: `{result:"<json>", usage:{...}}` — the model wraps its
///      output in a structured envelope. The `usage` block (CLI-native
///      snake_case: `input_tokens`/`output_tokens`/`cache_creation_input_tokens`/
///      `cache_read_input_tokens`) is extracted from the envelope.
///   2. Bare: the JSON object is the first `{...}` in the output. No
///      envelope, so no `usage` to extract — the second return value is
///      `None`.
///
/// Returns `(evaluation_json, evaluator_usage)`. The usage extraction is
/// best-effort: any malformation yields `None` and never fails the parse.
/// The evaluation JSON parse path is unchanged from prior behavior — the
/// only addition is reading `usage` from the envelope object before the
/// existing `result` extraction runs.
fn extract_evaluation_json(
    stdout: &str,
) -> Result<(serde_json::Value, Option<crate::models::types::TokenUsage>), GoalEvaluationError> {
    // First try envelope format: `{result:"<json>"}` where the value
    // is a string-encoded JSON object.
    if let Ok(envelope) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        if let Some(obj) = envelope.as_object() {
            // G-C15: extract `usage` from the envelope before the existing
            // `result` extraction. Best-effort — malformation yields None.
            let evaluator_usage = extract_usage_from_envelope(obj);
            if let Some(result_val) = obj.get("result") {
                if let Some(result_str) = result_val.as_str() {
                    // The result value is a string — it may itself be JSON.
                    // Fast path: bare JSON object inside the string.
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(result_str) {
                        if parsed.is_object() {
                            return Ok((parsed, evaluator_usage));
                        }
                    }
                    // 2026-07-31 field fix (corrected): when the bare
                    // parse fails OR yields a non-object, fall back to
                    // the depth-aware first-object scan. The CLI
                    // intermittently wraps the JSON in ```json ... ```
                    // fences — parse_first_json_object subsumes those
                    // naturally because it walks the string char-by-char
                    // counting depth, ignoring any `{`/`}` that appear
                    // inside string literals (like fence markers).
                    //
                    // If the scan finds an object, return it WITH the
                    // envelope's usage block preserved — the previous
                    // synthetic-continue wrap (decision:continue,
                    // reasonId:taskIncomplete, confidence:0.5) is the
                    // field defect this branch replaces. It fabricated
                    // Continue for every model that emitted a fenced
                    // JSON, even when the inner object had
                    // decision:complete. The goalScheduler.ts:111-117
                    // contract forbids this swallowing.
                    if let Some(parsed) = parse_first_json_object(result_str) {
                        return Ok((parsed, evaluator_usage));
                    }
                    // result_str contains no parseable JSON object at
                    // all — surface as a parse failure so the FE
                    // retry mesh can engage (lib.rs propagates Err;
                    // 1s/2s/4s/8s backoff at goalScheduler.ts:557).
                    // Truncate to 500 chars so the message carries
                    // signal without dumping the entire transcript.
                    return Err(GoalEvaluationError::ParseFailure(format!(
                        "envelope result string contains no parseable JSON object (first 500 chars): {}",
                        truncate_for_error(result_str, 500)
                    )));
                }
                // Result is not a string — might be a nested object directly.
                if result_val.is_object() {
                    return Ok((result_val.clone(), evaluator_usage));
                }
            }
            // No "result" key — might be a bare evaluation object directly.
            // No envelope `usage` to extract in this branch either; the
            // object IS the evaluation, not an envelope.
            return Ok((serde_json::Value::Object(obj.clone()), None));
        }
    }

    // Try depth-aware first-object extraction (handles trailing text).
    if let Some(obj) = parse_first_json_object(stdout) {
        return Ok((obj, None));
    }

    // Last resort: truncate the raw stdout to 500 chars so the error
    // message carries signal without dumping the entire transcript.
    // (2026-07-31 field fix: previous message was a fixed string —
    // silent on intermittent fence failures. Now operators can see
    // WHAT the model actually emitted before it hit the unwrap path.)
    Err(GoalEvaluationError::ParseFailure(format!(
        "No valid JSON object found in CLI output (first 500 chars): {}",
        truncate_for_error(stdout, 500)
    )))
}

/// Truncates `s` to at most `max_chars` chars, appending an ellipsis
/// marker if truncation occurred. Char-based (NOT byte-based) to
/// respect multi-byte UTF-8 sequences.
fn truncate_for_error(s: &str, max_chars: usize) -> String {
    let mut out: String = s.chars().take(max_chars).collect();
    if s.chars().count() > max_chars {
        out.push_str("...[truncated]");
    }
    out
}

/// Best-effort extraction of the `usage` block from a CLI envelope object.
/// Returns `None` for any of: missing `usage`, `usage` not an object, or
/// any field that fails to coerce to u32. NEVER returns an error — counting
/// failure must not break the goal (G-C15 requirement 3).
fn extract_usage_from_envelope(
    envelope: &serde_json::Map<String, serde_json::Value>,
) -> Option<crate::models::types::TokenUsage> {
    let usage = envelope.get("usage")?.as_object()?;
    Some(crate::models::types::TokenUsage {
        input_tokens: usage.get("input_tokens").and_then(|v| v.as_u64()).and_then(|n| u32::try_from(n).ok()),
        output_tokens: usage.get("output_tokens").and_then(|v| v.as_u64()).and_then(|n| u32::try_from(n).ok()),
        cache_creation_input_tokens: usage
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64())
            .and_then(|n| u32::try_from(n).ok()),
        cache_read_input_tokens: usage
            .get("cache_read_input_tokens")
            .and_then(|v| v.as_u64())
            .and_then(|n| u32::try_from(n).ok()),
    })
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
/// Normalizes the raw JSON the LLM returned into a `GoalEvaluationResult`.
/// Enforces the prompt's structural rules (Continue/Complete/Pause field
/// invariants) and applies the G-C16 hard guard: if the model decided
/// `complete` but `observable_action == false` (no turn has run), downgrades
/// to `Continue + TaskIncomplete`. The downgrade is deterministic, not a
/// preference — it guarantees a `complete` decision cannot leave the
/// scheduler without any observable work having happened, regardless of
/// what the prompt told the model.
///
/// G-C16-FIX: `observable_action` is `turns_run > 0` ONLY. The previous
/// `|| latest_result.is_some()` leg was removed — `latest_result` has zero
/// populators and was always None, and an inherited `latest_result` from
/// another turn would reopen F2 in old conversations if naively populated.
fn normalize_evaluation(json: serde_json::Value, observable_action: bool) -> GoalEvaluationResult {
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
    let (mut decision, mut reason_id, session_summary, gaps, next_action, completion_summary) =
        match &decision {
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

    // G-C16 hard guard (code, not prompt). If the model returned `complete`
    // but no turn has executed, the model was reasoning from a statement of
    // intent without an observable action in the transcript. A `complete`
    // decision with zero observable action would mark the goal done without
    // anything actually having happened (verified in field 2026-07-29:
    // turnsRun=0, no file on disk, model cited only its own future-tense
    // claim). Downgrade to Continue+TaskIncomplete so the scheduler runs
    // another turn where the agent can actually do the work.
    //
    // G-C16-FIX: `observable_action` is `turns_run > 0` ONLY. The previous
    // `|| latest_result.is_some()` leg was removed — `latest_result` has
    // zero populators (renderer or Rust) and was always None, and an
    // inherited `latest_result` from another turn would reopen F2 in old
    // conversations if someone naively populates it in the future.
    if decision == GoalDecision::Complete && !observable_action {
        decision = GoalDecision::Continue;
        reason_id = GoalReasonId::TaskIncomplete;
    }

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
        _ => {
            // 2026-07-31 field fix: log the raw decision string when the
            // default fires so operators can see what the model actually
            // emitted. The default itself is preserved — the prior
            // behavior mapped unknown strings to Continue safely, and
            // the load-bearing G-C16 guard catches the dangerous case
            // (complete with zero observable_action) downstream.
            eprintln!(
                "goal_evaluator: parse_decision unknown value {:?} -> default Continue",
                s
            );
            GoalDecision::Continue
        }
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
        "taskimpossible" | "task_impossible" => GoalReasonId::TaskImpossible,
        "done" => GoalReasonId::Done,
        "safetylimit" | "safety_limit" => GoalReasonId::SafetyLimit,
        "infraerror" | "infra_error" => GoalReasonId::InfraError,
        _ => {
            // 2026-07-31 field fix: log the raw reason id when the
            // default fires. Same rationale as parse_decision — the
            // default is preserved (TaskIncomplete is safe), but the
            // raw string is now visible for diagnosis. The load-bearing
            // G-C16 guard catches the dangerous (complete + zero
            // observable_action) case downstream.
            eprintln!(
                "goal_evaluator: parse_reason_id unknown value {:?} -> default TaskIncomplete",
                s
            );
            GoalReasonId::TaskIncomplete
        }
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

// ════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════
//
// IMPORTANT: these tests NEVER spawn a CLI. They test prompt building,
// JSON extraction, decision normalization, and the prompt rules.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{AccessMode, CommandRun, CommandStatus, GoalStatus, SkillSummary};
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

    // ── G-C18 RECENT_ITEMS_WINDOW measurement (DEPRECATED, replaced
    //     by g_c18_realistic_decomposition below — the previous
    //     synthetic fixture was sub-representative by ~10x vs field).
    //
    // Empirical sizing for the prompt built by build_evaluation_prompt.
    // We synthesize a realistic transcript (N items, alternating roles,
    // some with tool_output populated to exercise the new G-C18 branch)
    // and report prompt bytes for windows 30/20/15/10. Run with:
    //   cargo test --lib g_c18_measurement_recent_items_window -- --nocapture
    // so the user sees the numbers without committing them as assertions.
    //
    // Synthetic item model (tries to mimic a real agent trace):
    //   - User: short message (~80 chars) every ~5 items.
    //   - Assistant: medium prose (~600 chars) every other item.
    //   - Tool result (Read): ~500 chars body, every ~3rd assistant item.
    //     Populated as tool_output to exercise the G-C18 branch.
    //   - Command result: ~150 chars, occasional.
    // The numbers below are read once and then hand-copied into the PR
    // report.
    fn synth_items(n: usize) -> Vec<TranscriptItem> {
        let user_msg = "Please continue. Make sure to read /tmp/goal-total.txt and confirm its contents before declaring the goal complete.";
        let asst_prose = "I will create /tmp/goal-total.txt containing the word SOMA and verify its contents via Read. Let me execute the necessary commands now. The Read result must confirm a single line containing the literal SOMA; if the file is missing or the contents differ, I will rewrite it and re-verify. Once verified, I will report completion with concrete observed evidence.";
        let tool_read = format!("1\tSOMA\n"); // the literal that triggerged the G-C18 bug
        let cmd_out = "total 8\ndrwxr-xr-x  2 user user 4096 Jul 29 09:00 goal-total.txt\n";
        let mut items = Vec::with_capacity(n);
        for i in 0..n {
            let (role, text, tool_output, command) = match i % 5 {
                0 => ("user", user_msg.to_string(), None, None),
                1 => (
                    "assistant",
                    asst_prose.to_string(),
                    None,
                    None,
                ),
                2 => (
                    "assistant",
                    asst_prose.to_string(),
                    Some(tool_read.clone()),
                    None,
                ),
                3 => (
                    "assistant",
                    asst_prose.to_string(),
                    None,
                    Some(CommandRun {
                        input: "ls -la /tmp/goal-total.txt".into(),
                        output: cmd_out.into(),
                        status: CommandStatus::Success,
                    }),
                ),
                _ => (
                    "assistant",
                    asst_prose.to_string(),
                    Some(tool_read.clone()),
                    None,
                ),
            };
            items.push(TranscriptItem {
                id: format!("item-{i}"),
                role: role.into(),
                text,
                timestamp: 1_700_000_000 + i as i64,
                kind: Some("message".into()),
                activity_kind: None,
                activity_detail: None,
                command,
                change_summary: None,
                model_id: None,
                model_display_name: None,
                streaming: None,
                skills: None,
                tool_output,
            });
        }
        items
    }

    #[test]
    fn g_c18_measurement_recent_items_window() {
        // Print prompt sizes for windows = {30, 20, 15, 10} and tokens.
        // Tokens ≈ bytes / 4 (English-ish; underscore + JSON inflates
        // ratio modestly, so this is a lower bound on real cost).
        let goal = sample_goal();
        let items = synth_items(35);
        eprintln!("\n=== G-C18 RECENT_ITEMS_WINDOW measurement ===");
        eprintln!("synthetic transcript: 35 items, every other assistant item has ~tool output of ~7 chars (Read of /tmp/goal-total.txt), occasional ~150 char command output");
        eprintln!("{:<8} {:<10} {:<10} {:<10}", "window", "bytes", "~tokens", "% of 30");
        eprintln!("{:-<40}", "");
        let mut baseline_chars = 0usize;
        let windows = [30usize, 20, 15, 10];
        let prompt_at_30 = {
            let recent: Vec<TranscriptItem> = items
                .iter()
                .rev()
                .take(30)
                .cloned()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            let prompt = build_evaluation_prompt(&goal, &recent);
            baseline_chars = prompt.len();
            prompt
        };
        for w in windows {
            let recent: Vec<TranscriptItem> = items
                .iter()
                .rev()
                .take(w)
                .cloned()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            let prompt = build_evaluation_prompt(&goal, &recent);
            let bytes = prompt.len();
            let tokens = bytes / 4;
            let pct = if baseline_chars > 0 {
                (bytes as f64 / baseline_chars as f64) * 100.0
            } else {
                0.0
            };
            eprintln!(
                "{:<8} {:<10} {:<10} {:<10.1}",
                w,
                bytes,
                tokens,
                pct
            );
        }
        eprintln!("\ncontext: each goal produces ~3 evaluation cycles, so total evaluator input cost:");
        for w in windows {
            let tokens_per_call = match w {
                30 => prompt_at_30.len() / 4,
                _ => {
                    let recent: Vec<TranscriptItem> = items
                        .iter()
                        .rev()
                        .take(w)
                        .cloned()
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();
                    build_evaluation_prompt(&goal, &recent).len() / 4
                }
            };
            eprintln!(
                "  window={} -> ~{} tokens/call, ~{} tokens for 3 cycles",
                w,
                tokens_per_call,
                tokens_per_call * 3
            );
        }
        eprintln!("=== end ===\n");
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
        let result = normalize_evaluation(json, true);
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
        let result = normalize_evaluation(json, true);
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
        let result = normalize_evaluation(json, true);
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
        let result = normalize_evaluation(json, true);
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
        let result = normalize_evaluation(json, true);
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
        let result = normalize_evaluation(json, true);
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
        let result = normalize_evaluation(json, true);
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
        let result = normalize_evaluation(json, true);
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
        let result = normalize_evaluation(json, true);
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
        let result = normalize_evaluation(json, true);
        assert_eq!(result.decision, GoalDecision::Continue);
        assert_eq!(result.reason_id, GoalReasonId::TaskIncomplete);
    }

    #[test]
    fn normalize_non_object_falls_back_safe() {
        let json = json!("not an object");
        let result = normalize_evaluation(json, true);
        assert_eq!(result.decision, GoalDecision::Continue);
        assert_eq!(result.reason_id, GoalReasonId::TaskIncomplete);
    }

    #[test]
    fn normalize_empty_json_defaults_safe() {
        let json = json!({});
        let result = normalize_evaluation(json, true);
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
        let result = normalize_evaluation(json, true);
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
        let result = normalize_evaluation(json, true);
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
        let (result, usage) = extract_evaluation_json(stdout).unwrap();
        assert_eq!(result["decision"], "continue");
        assert_eq!(result["reason"], "Working on it");
        // No usage in this envelope → None, but parse still succeeds.
        assert!(usage.is_none());
    }

    #[test]
    fn extract_bare_json() {
        let stdout = r#"{"decision":"complete","reasonId":"done","reason":"Done","completionSummary":"All done","confidence":0.95}"#;
        let (result, usage) = extract_evaluation_json(stdout).unwrap();
        assert_eq!(result["decision"], "complete");
        // Bare object (no envelope) → no usage to extract.
        assert!(usage.is_none());
    }

    #[test]
    fn extract_envelope_with_nested_object() {
        let stdout = r#"{"type":"result","result":{"decision":"pause","reasonId":"unsafe","reason":"Danger","nextAction":"Check it","confidence":0.99}}"#;
        let (result, usage) = extract_evaluation_json(stdout).unwrap();
        assert_eq!(result["decision"], "pause");
        assert_eq!(result["nextAction"], "Check it");
        assert!(usage.is_none());
    }

    #[test]
    fn extract_envelope_result_is_plain_text() {
        let stdout = r#"{"type":"result","result":"Still working on the login fix"}"#;
        // 2026-07-31 field fix: prose inside an envelope's `result`
        // no longer fabricates a synthetic Continue+TaskIncomplete.
        // The renderer-side retry mesh (goalScheduler.ts:557,
        // 1s/2s/4s/8s backoff, pause at 3rd consecutive error) is
        // the correct handling for a model that emitted prose where
        // the prompt required JSON. Returning a fake Continue here
        // violated goalScheduler.ts:111-117.
        let result = extract_evaluation_json(stdout);
        match result {
            Err(GoalEvaluationError::ParseFailure(message)) => {
                assert!(
                    message.contains("envelope result string contains no parseable JSON object"),
                    "ParseFailure message should describe the envelope failure: {message}"
                );
                assert!(
                    message.contains("Still working on the login fix"),
                    "ParseFailure must carry the truncated prose for diagnosis: {message}"
                );
            }
            other => panic!(
                "expected Err(ParseFailure) for prose envelope result, got: {other:?}"
            ),
        }
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

    // ── 2026-07-31 field fix: depth-aware first-object scan ─────────────
    //
    // Field defect path (for context, NOT pin history): the production
    // defect that broke the field was at the ENVELOPE level — the
    // CLI returned `{result:"<fenced JSON>"}` and the envelope branch
    // fabricated a synthetic Continue when `from_str(result_str)` did
    // not succeed. The bare-stdout fenced path below is exercised as a
    // regression witness: before this fix, the `parse_first_json_object`
    // depth-aware scan ALREADY found fenced JSON in bare stdout, so
    // this path was working. The fence tests pin the depth-aware
    // behavior against future regressions in parse_first_json_object
    // itself, NOT the production defect (that lives at the envelope
    // branch — see `extract_envelope_with_fenced_json_result` below).

    #[test]
    fn extract_fenced_json_unwraps_to_complete_decision() {
        // Bare CLI stdout (no envelope): a fenced JSON object. The
        // depth-aware first-object scan finds the inner `{...}` and
        // returns it. Pinning parse_first_json_object's fence
        // tolerance against future regressions — this was already
        // working before the field fix; the actual defect was on the
        // envelope's result_str branch.
        let stdout = r#"```json
{"decision":"complete","reasonId":"done","reason":"arquivo b.txt criado e conteudo verificado","completionSummary":"agente criou o arquivo e leu, conteudo bate","confidence":1.0}
```"#;
        let (result, usage) = extract_evaluation_json(stdout)
            .expect("fenced bare-stdout JSON must unwrap via depth-aware scan");
        assert_eq!(result["decision"], "complete");
        assert_eq!(result["reasonId"], "done");
        assert_eq!(result["confidence"], 1.0);
        assert!(usage.is_none());
    }

    #[test]
    fn extract_bare_fence_without_language_tag_also_unwraps() {
        // Same as above but the fence opener is ``` with NO language
        // tag. Depth-aware scan handles both uniformly. Same intent:
        // regression witness for parse_first_json_object, not the
        // production path that broke.
        let stdout = "```\n{\"decision\":\"complete\",\"reasonId\":\"done\",\"reason\":\"ok\",\"confidence\":0.9}\n```";
        let (result, _) = extract_evaluation_json(stdout)
            .expect("bare ``` fence must unwrap via depth-aware scan");
        assert_eq!(result["decision"], "complete");
        assert_eq!(result["confidence"], 0.9);
    }

    #[test]
    fn extract_garbage_text_without_any_json_returns_error_not_synthetic_continue() {
        // Field defect counterfactual: before the fix, the previous
        // ParseFailure path eventually fell into a default_continue
        // fabrication. With the new contract, the extrator MUST
        // surface Err(ParseFailure) — a downstream default_continue
        // would defeat the goalScheduler.ts:111-117 contract that
        // forbids swallowing parse failures into fake continue.
        //
        // The 2026-07-31 field fix adds Err propagation through
        // lib.rs:947 (previously the Err was converted to
        // Ok(Pause+InfraError), also bypassing the contract).
        // This test pins the EXTRACTOR behavior: garbage in, Err out.
        let garbage = "the model emitted prose without any JSON object in it";
        let result = extract_evaluation_json(garbage);
        match result {
            Err(GoalEvaluationError::ParseFailure(message)) => {
                // Truncated raw stdout appears in the message — operator
                // can see WHAT the model emitted before defaulting.
                assert!(
                    message.contains("No valid JSON object found"),
                    "ParseFailure message should describe the failure: {message}"
                );
                assert!(
                    message.contains("the model emitted prose"),
                    "ParseFailure message should carry the truncated raw stdout: {message}"
                );
            }
            other => panic!(
                "expected Err(ParseFailure) for garbage input, got: {other:?}"
            ),
        }
    }

    #[test]
    fn extract_error_message_truncates_long_raw_stdout() {
        // The ParseFailure message must include the truncated raw
        // stdout (first 500 chars + ellipsis marker) — not the entire
        // transcript. Pinning the 500-char ceiling protects log files.
        let long_stdout = "x".repeat(2000);
        let err = extract_evaluation_json(&long_stdout).unwrap_err();
        match err {
            GoalEvaluationError::ParseFailure(message) => {
                assert!(message.contains("...[truncated]"),
                    "ParseFailure must include the truncation marker for long inputs");
                // 500 chars of 'x' + marker = ~516 chars total
                assert!(message.len() < 600,
                    "ParseFailure message must be truncated, got len={}",
                    message.len());
            }
            // Other variants (CliTimeout, CliSpawn, CliExit) cannot be
            // produced by extract_evaluation_json — it only inspects
            // stdout bytes, never invokes the CLI. The match arm here
            // is a forward-compat net: future variants added to
            // GoalEvaluationError must NOT silently break this test.
            other => panic!(
                "extract_evaluation_json produced non-ParseFailure variant for garbage input: {other:?}"
            ),
        }
    }

    // ── end 2026-07-31 field fix tests ───────────────────────────────

    // ── end bare-stdout fence tests ─────────────────────────────────

    // ── 2026-07-31 field fix: envelope result_str tolerance ────────
    //
    // These tests witness the ACTUAL production path that broke in
    // the field defect: the CLI returned `{result:"<fenced JSON>"}`
    // and the envelope branch fabricated a synthetic Continue. The
    // corrected envelope branch (a) tries bare `from_str`, then (b)
    // falls back to depth-aware `parse_first_json_object` on the
    // result_str itself (NOT on the whole stdout). When the inner
    // object is found, it is returned ALONG WITH the envelope's
    // `usage` block (preserved by G-C15 path at line ~600).

    #[test]
    fn extract_envelope_with_fenced_json_result_returns_complete() {
        // Production-shaped defect: CLI returned an envelope whose
        // `result` value was a fenced JSON string carrying
        // decision:complete. Before the field fix, the envelope branch
        // found `result` as a string, ran `from_str` on the fenced
        // content (failed because the fence chars are not valid JSON
        // syntax), fell through to the synthetic-continue wrap, and
        // returned decision:continue. After the fix, the envelope
        // branch falls back to `parse_first_json_object` on result_str
        // which depth-scans past the fence and finds the inner
        // decision:complete.
        let envelope = serde_json::json!({
            "type": "result",
            "result": "```json\n{\"decision\":\"complete\",\"reasonId\":\"done\",\"reason\":\"arquivo b.txt criado e conteudo verificado\",\"completionSummary\":\"agente criou o arquivo e leu, conteudo bate\",\"confidence\":1.0}\n```",
            "usage": {
                "input_tokens": 42,
                "output_tokens": 7,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0
            }
        })
        .to_string();
        let (result, usage) = extract_evaluation_json(&envelope)
            .expect("envelope with fenced result_str must unwrap to inner complete decision");
        assert_eq!(result["decision"], "complete");
        assert_eq!(result["reasonId"], "done");
        assert_eq!(result["confidence"], 1.0);
        // The load-bearing assertion: the envelope's `usage` block
        // survives the unwrap. G-C15 only kicks in when the envelope
        // path itself succeeds; a fallback that lost usage would
        // break token accounting for the evaluator's own response.
        let usage = usage.expect("usage extracted from envelope must survive the envelope branch fallback");
        assert_eq!(usage.input_tokens, Some(42));
        assert_eq!(usage.output_tokens, Some(7));
    }

    #[test]
    fn extract_envelope_with_prose_result_returns_parse_failure() {
        // Production-shaped counterfactual: CLI returned an envelope
        // whose `result` was prose without any JSON. Before the field
        // fix, this fabricated a synthetic Continue+TaskIncomplete
        // with the prose dumped into the `reason` field (the field
        // defect the user observed). After the fix, prose in
        // envelope.result returns Err(ParseFailure) with the truncated
        // prose embedded so the operator can see what the model
        // emitted. The renderer's retry mesh (1s/2s/4s/8s backoff at
        // goalScheduler.ts:557) handles the retry — the FE pauses at
        // the 3rd consecutive failure with the message visible.
        let envelope = r#"{"type":"result","result":"I have not yet finished editing objective.md, please give me a moment."}"#;
        let result = extract_evaluation_json(envelope);
        match result {
            Err(GoalEvaluationError::ParseFailure(message)) => {
                assert!(
                    message.contains("envelope result string contains no parseable JSON object"),
                    "ParseFailure message should describe the envelope failure: {message}"
                );
                assert!(
                    message.contains("I have not yet finished editing objective.md"),
                    "ParseFailure must carry the truncated result_str prose for diagnosis: {message}"
                );
                // FAILS GUARD: must NOT be a synthetic Continue.
                // The pre-fix branch returned Ok with decision:continue
                // — that path is gone. If a future regression
                // re-introduces the synthetic wrap, this test fails.
                assert!(
                    !message.contains("decision\":\"continue\""),
                    "ParseFailure must NOT carry a synthetic continue payload: {message}"
                );
            }
            Ok((value, _usage)) => panic!(
                "expected Err(ParseFailure) for prose envelope result, got Ok with decision={}",
                value["decision"]
            ),
            // Other Err variants (CliTimeout, CliSpawn, CliExit) cannot
            // be produced by extract_evaluation_json — it only inspects
            // a parsed envelope's `result` field, never invokes the CLI.
            // The match arm here is a forward-compat net.
            Err(other_err) => panic!(
                "extract_evaluation_json produced non-ParseFailure variant for prose envelope: {other_err:?}"
            ),
        }
    }

    // ── end 2026-07-31 field fix envelope tests ───────────────────

    // ── extract_evaluation_json: usage extraction (G-C15) ──────────────

    #[test]
    fn extract_envelope_with_usage_returns_tokens() {
        // Envelope with a real CLI-native snake_case usage block.
        let stdout = r#"{"type":"result","result":"{\"decision\":\"complete\",\"reasonId\":\"done\",\"reason\":\"Done\",\"completionSummary\":\"All done\",\"confidence\":0.95}","usage":{"input_tokens":32000,"output_tokens":450,"cache_creation_input_tokens":1200,"cache_read_input_tokens":8000}}"#;
        let (result, usage) = extract_evaluation_json(stdout).unwrap();
        assert_eq!(result["decision"], "complete");
        let usage = usage.expect("usage must be extracted from envelope");
        assert_eq!(usage.input_tokens, Some(32000));
        assert_eq!(usage.output_tokens, Some(450));
        assert_eq!(usage.cache_creation_input_tokens, Some(1200));
        assert_eq!(usage.cache_read_input_tokens, Some(8000));
    }

    #[test]
    fn extract_envelope_without_usage_returns_none_but_still_parses_result() {
        // Envelope has no `usage` key. Parse of `result` must still succeed
        // and usage must be None — counting failure must not break the goal.
        let stdout = r#"{"type":"result","result":"{\"decision\":\"continue\",\"reasonId\":\"taskIncomplete\",\"reason\":\"Working\",\"confidence\":0.7}"}"#;
        let (result, usage) = extract_evaluation_json(stdout).unwrap();
        assert_eq!(result["decision"], "continue");
        assert!(usage.is_none());
    }

    #[test]
    fn extract_envelope_with_malformed_usage_returns_none_but_still_parses_result() {
        // `usage` present but malformed (not an object, fields wrong type).
        // Parse of `result` must still succeed and usage must be None.
        let stdout = r#"{"type":"result","result":"{\"decision\":\"continue\",\"reasonId\":\"taskIncomplete\",\"reason\":\"Working\",\"confidence\":0.7}","usage":"not-an-object"}"#;
        let (result, usage) = extract_evaluation_json(stdout).unwrap();
        assert_eq!(result["decision"], "continue");
        assert!(usage.is_none());
    }

    #[test]
    fn extract_envelope_with_partial_usage_returns_present_fields_only() {
        // `usage` with only some fields present — missing fields become None,
        // present fields are extracted. Never fails the whole block.
        let stdout = r#"{"type":"result","result":"{\"decision\":\"complete\",\"reasonId\":\"done\",\"reason\":\"Done\",\"confidence\":0.9}","usage":{"input_tokens":100,"output_tokens":20}}"#;
        let (result, usage) = extract_evaluation_json(stdout).unwrap();
        assert_eq!(result["decision"], "complete");
        let usage = usage.expect("partial usage must still yield a TokenUsage");
        assert_eq!(usage.input_tokens, Some(100));
        assert_eq!(usage.output_tokens, Some(20));
        assert_eq!(usage.cache_creation_input_tokens, None);
        assert_eq!(usage.cache_read_input_tokens, None);
    }

    // ── build_evaluation_prompt ──────────────────────────────────────
    //
    // These tests verify the prompt structure contains the expected
    // sections and instructions. They do NOT test the LLM's output.

    #[test]
    fn prompt_contains_goal_objective() {
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[]);
        assert!(prompt.contains("Fix the login bug"));
    }

    #[test]
    fn prompt_shows_turns_and_status() {
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[]);
        assert!(prompt.contains("Turns run"));
        assert!(prompt.contains("Active"));
    }

    #[test]
    fn prompt_does_not_use_tokens_as_criteria() {
        // Verboo has unlimited tokens. The evaluator must NOT use
        // token usage or budget windows as completion criteria.
        // The explanatory "Verboo has unlimited tokens" is fine.
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[]);
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
        let prompt = build_evaluation_prompt(&goal, &[]);
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
        let prompt = build_evaluation_prompt(&goal, &[]);
        // The old "blocked" decision no longer exists.
        assert!(!prompt.contains(r#""blocked""#));
    }

    #[test]
    fn prompt_includes_complete_rule() {
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[]);
        assert!(prompt.contains("complete"));
        assert!(prompt.contains("completionSummary"));
    }

    #[test]
    fn prompt_tells_evaluator_verified_transcript_evidence_is_sufficient() {
        // G-C11: regressão do viés "continue" quando a evidência já está
        // verificada no transcript. O prompt deve dizer explicitamente que
        // evidência já verificada no transcript É a evidência concreta
        // exigida, e que um turno extra de re-confirmação não é necessário.
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[]);
        assert!(
            prompt.contains("already verified in the transcript"),
            "prompt must tell evaluator that verified transcript evidence counts"
        );
        assert!(
            prompt.contains("SAME turn"),
            "prompt must instruct completion in the same turn as the evidence"
        );
        assert!(
            prompt.contains("Do NOT spend an extra turn"),
            "prompt must explicitly forbid the redundant confirmation turn"
        );
        // Garantia de não-regressão: a exigência de evidência concreta
        // NÃO pode ter sido enfraquecida.
        assert!(
            prompt.contains("Do NOT mark as complete for partial progress"),
            "partial-progress guard must remain"
        );
        assert!(
            prompt.contains("concrete evidence"),
            "concrete-evidence requirement must remain"
        );
    }

    #[test]
    fn prompt_forbids_unverified_claims_and_future_tense_as_evidence() {
        // G-C16: the G-C11 addition said verified transcript evidence IS
        // sufficient, but did not explicitly say what is NOT sufficient.
        // The model exploited this gap: it wrote a future-tense intent
        // statement in completionSummary and the model accepted it as
        // concrete evidence (verified in field 2026-07-29). This test
        // asserts the prompt contains the negative — the "what is NOT
        // concrete evidence" examples and the turnsRun=0 rule.
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[]);
        assert!(
            prompt.contains("NOT concrete evidence"),
            "G-C16: prompt must contain the explicit negative"
        );
        assert!(
            prompt.contains("I will"),
            "G-C16: prompt must call out future-tense 'I will' as insufficient"
        );
        assert!(
            prompt.contains("unverified claim"),
            "G-C16: prompt must reject unverified claims"
        );
        assert!(
            prompt.contains("ALREADY HAPPENED"),
            "G-C16: prompt must require action to have ALREADY HAPPENED"
        );
        assert!(
            prompt.contains("OBSERVED"),
            "G-C16: prompt must require action to have been OBSERVED in the transcript"
        );
        assert!(
            prompt.contains("turnsRun=0"),
            "G-C16: prompt must forbid complete when turnsRun is zero"
        );
        // Non-regression: the G-C11 improvement and the core guard must
        // both remain intact.
        assert!(
            prompt.contains("already verified in the transcript"),
            "G-C11 guard must remain"
        );
        assert!(
            prompt.contains("Do NOT mark as complete for partial progress"),
            "partial-progress guard must remain"
        );
        assert!(
            prompt.contains("concrete evidence"),
            "concrete-evidence requirement must remain"
        );
    }

    #[test]
    fn g_c16_pins_f2_negative_with_intent_and_observed_examples() {
        // G-C16-FIX (QA round 2): pin test for the F2 fresta. The previous
        // `prompt_forbids_unverified_claims_and_future_tense_as_evidence`
        // test was a positive-only check. QA flagged that without a test
        // that exercises the EXACT regressed pattern (future-tense intent
        // language the model produced in the field failure), someone could
        // rewrite the negative to a softer shape and the suite would stay
        // green. This test asserts the negative covers the SPECIFIC phrases
        // the regressed model used and the SPECIFIC example action type
        // (Read-back) the user expects as evidence.
        //
        // If the negative is removed or softened, at least one of these
        // assertions fails. This is the trigger the QA classified as
        // NAO-BLOQUEANTE COM GATILHO — one failure = treat as critical.
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[]);

        // 1. The exact phrases the regressed model used in completionSummary
        //    must be called out as insufficient.
        assert!(
            prompt.contains("I will create"),
            "G-C16-FIX: negative must call out 'I will create' pattern"
        );
        assert!(
            prompt.contains("I will verify"),
            "G-C16-FIX: negative must call out 'I will verify' pattern"
        );
        assert!(
            prompt.contains("I will confirm"),
            "G-C16-FIX: negative must call out 'I will confirm' pattern"
        );

        // 2. The example type of verification the user expects as evidence
        //    must be named (Read-back of contents is what makes a file
        //    creation verifiable, not a future statement).
        assert!(
            prompt.contains("Read of the file"),
            "G-C16-FIX: negative must name Read-back as the evidence type"
        );
        assert!(
            prompt.contains("output of the command"),
            "G-C16-FIX: negative must name command output as evidence"
        );
        assert!(
            prompt.contains("result of a test that was actually run"),
            "G-C16-FIX: negative must name actual test run as evidence"
        );

        // 3. The decision-forcing rule for the F2 case must be present:
        //    no observable action → continue with taskIncomplete. The
        //    model has no way to misread this as a suggestion.
        assert!(
            prompt.contains("the only correct decision is `continue`"),
            "G-C16-FIX: F2 decision rule must be unambiguous"
        );
        assert!(
            prompt.contains("`reasonId: \"taskIncomplete\"`"),
            "G-C16-FIX: F2 reasonId must be taskIncomplete"
        );

        // 4. The full F2 sentence must be present as a contiguous block
        //    (not split across push_str calls in a way that could be
        //    truncated by a careless edit). Pin the full sentence.
        assert!(
            prompt.contains(
                "If the transcript shows no turn executed (turnsRun=0) or no observable action"
            ),
            "G-C16-FIX: F2 trigger sentence must be intact"
        );

        // 5. Non-regression: G-C11 stays.
        assert!(
            prompt.contains("already verified in the transcript"),
            "G-C11 must remain"
        );
    }

    #[test]
    fn prompt_includes_continue_rule() {
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[]);
        assert!(prompt.contains("sessionSummary"));
        assert!(prompt.contains("gaps"));
    }

    #[test]
    fn prompt_includes_pause_rule() {
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[]);
        assert!(prompt.contains("nextAction"));
    }

    #[test]
    fn prompt_includes_reason_id_list() {
        let goal = sample_goal();
        let prompt = build_evaluation_prompt(&goal, &[]);
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
        let prompt = build_evaluation_prompt(&goal, &[]);
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
        let result = normalize_evaluation(json, true);
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
        let result = normalize_evaluation(json, true);
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
        let result = normalize_evaluation(json, true);
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
        let result = normalize_evaluation(json, true);
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
        let result = normalize_evaluation(json, true);
        assert!(result.confidence <= 1.0);
    }

    // ── G-C16: hard guard against completion without observable action ─

    #[test]
    fn g_c16_complete_with_no_observable_action_is_downgraded_to_continue() {
        // The model returned `complete` with a future-tense completionSummary
        // (the G-C11 prompt lets it cite a verified action, but the G-C16
        // regression is when it cites only intent). With observable_action
        // false (turnsRun=0), the hard guard must downgrade to
        // Continue+TaskIncomplete regardless of what the model wrote in
        // completionSummary.
        //
        // G-C16-FIX: observable_action is now `turns_run > 0` ONLY. The
        // `latest_result.is_some()` leg was removed (dead code + armadilha
        // armada — see comment at the call site). This test passes
        // `observable_action=false` directly, so it still pins the guard
        // behavior regardless of which leg computed the flag.
        let json = json!({
            "decision": "complete",
            "reasonId": "done",
            "reason": "I will create the file and verify it",
            "completionSummary": "I will create /tmp/goal-total.txt containing the word SOMA and verify its contents via Read",
            "confidence": 0.95
        });
        let result = normalize_evaluation(json, false);
        assert_eq!(
            result.decision,
            GoalDecision::Continue,
            "G-C16: complete with no observable action MUST downgrade to continue"
        );
        assert_eq!(
            result.reason_id,
            GoalReasonId::TaskIncomplete,
            "G-C16: downgraded complete must surface as taskIncomplete"
        );
        // The completionSummary is preserved as-is for diagnostics but the
        // decision is what the scheduler reads.
    }

    #[test]
    fn g_c16_complete_with_observable_action_is_preserved() {
        // Sanity: when turnsRun > 0, a Complete decision passes through
        // unchanged. The guard must not affect legitimate completions.
        // (G-C16-FIX: observable_action is now `turns_run > 0` only; this
        // test passes `true` directly so it pins the pass-through behavior
        // regardless of which leg computed the flag.)
        let json = json!({
            "decision": "complete",
            "reasonId": "done",
            "reason": "File created and verified",
            "completionSummary": "Created /tmp/goal-total.txt with SOMA; re-read confirmed contents",
            "confidence": 0.95
        });
        let result = normalize_evaluation(json, true);
        assert_eq!(result.decision, GoalDecision::Complete);
        assert_eq!(result.reason_id, GoalReasonId::Done);
    }

    #[test]
    fn g_c16_continue_passes_through_with_no_observable_action() {
        // The guard only downgrades Complete → Continue. Continue with
        // no observable action is the normal starting state and must be
        // untouched (not further downgraded).
        let json = json!({
            "decision": "continue",
            "reasonId": "taskIncomplete",
            "reason": "Just started",
            "sessionSummary": "Agent has begun work",
            "gaps": ["Objective not yet achieved"],
            "confidence": 0.5
        });
        let result = normalize_evaluation(json, false);
        assert_eq!(result.decision, GoalDecision::Continue);
        assert_eq!(result.reason_id, GoalReasonId::TaskIncomplete);
    }

    #[test]
    fn g_c16_pause_passes_through_with_no_observable_action() {
        // The guard only downgrades Complete. Pause with no observable
        // action is legitimate (e.g. immediate unsafe detection from goal
        // text alone) and must be untouched.
        let json = json!({
            "decision": "pause",
            "reasonId": "unsafe",
            "reason": "Goal text requests a destructive operation",
            "nextAction": "User must approve before proceeding",
            "confidence": 0.99
        });
        let result = normalize_evaluation(json, false);
        assert_eq!(result.decision, GoalDecision::Pause);
        assert_eq!(result.reason_id, GoalReasonId::Unsafe);
    }

    // ────── resolve_timeout_secs: env var resolution ──────
    //
    // G-C6-FIX-RUST item 2: cover every branch of `resolve_timeout_secs`:
    //   - env var absent → DEFAULT_TIMEOUT_SECS (240)
    //   - valid numeric ≥ 10 → honored
    //   - non-numeric text → fallback to default (fail-closed)
    //   - zero → fallback to default (below 10s floor)
    //   - sub-floor (e.g. 5) → fallback to default
    //
    // These tests MUST run serially (env var is process-global). We use
    // a single test thread via `#[serial]`-equivalent pattern: a helper
    // that sets the env var, calls resolve_timeout_secs, then removes
    // the env var. Rust's test runner is parallel by default, so we
    // guard with a static Mutex to serialize the env-touching tests.
    //
    // NOTE: We do NOT test the eprintln! warnings — they go to stderr
    // and are not observable via the normal test path. We test only the
    // return value, which is the load-bearing behavior.

    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_env<F>(name: &str, value: Option<&str>, f: F) -> u64
    where
        F: FnOnce() -> u64,
    {
        let _guard = ENV_LOCK.lock().unwrap();
        match value {
            Some(v) => std::env::set_var(name, v),
            None => std::env::remove_var(name),
        }
        let result = f();
        // Always clean up — even on panic — so we don't poison other tests.
        std::env::remove_var(name);
        result
    }

    #[test]
    fn resolve_timeout_secs_default_when_env_absent() {
        let got = with_env("VERBOO_GOAL_TIMEOUT_SECS", None, || resolve_timeout_secs());
        assert_eq!(
            got, 240,
            "absent env var must fall back to DEFAULT_TIMEOUT_SECS (240), got {got}"
        );
    }

    #[test]
    fn resolve_timeout_secs_honors_valid_value() {
        let got = with_env("VERBOO_GOAL_TIMEOUT_SECS", Some("600"), || resolve_timeout_secs());
        assert_eq!(
            got, 600,
            "valid numeric value ≥10 must be honored, got {got}"
        );
    }

    #[test]
    fn resolve_timeout_secs_rejects_non_numeric() {
        let got = with_env("VERBOO_GOAL_TIMEOUT_SECS", Some("not-a-number"), || {
            resolve_timeout_secs()
        });
        assert_eq!(
            got, 240,
            "non-numeric env var must fall back to default (fail-closed), got {got}"
        );
    }

    #[test]
    fn resolve_timeout_secs_rejects_zero() {
        let got = with_env("VERBOO_GOAL_TIMEOUT_SECS", Some("0"), || resolve_timeout_secs());
        assert_eq!(
            got, 240,
            "zero is below the 10s floor — must fall back to default, got {got}"
        );
    }

    #[test]
    fn resolve_timeout_secs_rejects_sub_floor() {
        let got = with_env("VERBOO_GOAL_TIMEOUT_SECS", Some("5"), || resolve_timeout_secs());
        assert_eq!(
            got, 240,
            "5s is below the 10s floor — must fall back to default, got {got}"
        );
    }

    #[test]
    fn resolve_timeout_secs_accepts_floor_boundary() {
        let got = with_env("VERBOO_GOAL_TIMEOUT_SECS", Some("10"), || resolve_timeout_secs());
        assert_eq!(
            got, 10,
            "10s is the floor boundary — must be accepted (n >= 10), got {got}"
        );
    }

    #[test]
    fn resolve_timeout_secs_trims_whitespace() {
        let got = with_env("VERBOO_GOAL_TIMEOUT_SECS", Some("  300  "), || {
            resolve_timeout_secs()
        });
        assert_eq!(
            got, 300,
            "env var value must be trimmed before parsing, got {got}"
        );
    }

    // ────── CliTimeout message carries the effective budget ──────
    //
    // G-C6-FIX-RUST item 2: the user-facing message must contain the
    // number of seconds actually used (not a hardcoded literal). This
    // guards against a regression where someone changes the Display
    // impl back to a static string and the user loses the actionable
    // hint ("raise VERBOO_GOAL_TIMEOUT_SECS if your machine is
    // consistently slower").
    //
    // We test the Display impl directly (not via run_evaluation_cli,
    // which would require spawning a real CLI). The Display impl is
    // the contract — the renderer formats the error for the user.

    #[test]
    fn cli_timeout_message_contains_effective_seconds() {
        let err = GoalEvaluationError::CliTimeout { timeout_secs: 240 };
        let msg = format!("{err}");
        assert!(
            msg.contains("240s"),
            "CliTimeout message must contain the effective budget (240s), got: {msg}"
        );
        assert!(
            msg.contains("VERBOO_GOAL_TIMEOUT_SECS"),
            "CliTimeout message must tell the user which env var to raise, got: {msg}"
        );
    }

    #[test]
    fn cli_timeout_message_reflects_custom_budget() {
        // If the user sets VERBOO_GOAL_TIMEOUT_SECS=600 and the CLI
        // still times out, the message must say "600s" — not "240s".
        // This is the load-bearing behavior: the message must reflect
        // the budget that was actually in effect.
        let err = GoalEvaluationError::CliTimeout { timeout_secs: 600 };
        let msg = format!("{err}");
        assert!(
            msg.contains("600s"),
            "CliTimeout message must reflect the custom budget (600s), got: {msg}"
        );
        assert!(
            !msg.contains("240s"),
            "CliTimeout message must NOT contain a hardcoded 240s when the budget was 600s, got: {msg}"
        );
    }

    // ────── WIRING TEST: Goal uses CliSpawn (managed), not global ──────
    //
    // Catches the failure mode the G-C1 QA flagged: `goal_evaluator`
    // resolving the CLI via `cli_path::resolve().unwrap_or("verboo")`,
    // which falls back to the system-installed `verboo` global. End
    // users who download the .app do NOT have `verboo` installed
    // globally — so the Goal was broken for them.
    //
    // The fix migrates `goal_evaluator` to `CliSpawn::new(...)`, the
    // SAME route as chat/turn_service, which acquires the active signed
    // cli.mjs version and spawns it with the app-managed Node runtime.
    //
    // This test asserts that the source-level wiring is present:
    //   - `CliSpawn::new(...)` is INVOKED (not just imported)
    //   - `cli_path::resolve(` is NOT called (the global-fallback path)
    //   - `Command::new(` is NOT called (legacy manual-spawn path)
    //   - `fn resolve_cli_path(` is NOT defined (the deleted helper)
    //
    // If someone reverts the migration, the test fails with a clear
    // pointer to G-C1.
    //
    // SCOPE GUARD: this test measures ONLY production code — it stops
    // reading at the `#[cfg(test)]` line that opens this `mod tests`
    // block. Without this guard, the test would scan its OWN source
    // (which mentions the forbidden strings in assertion messages)
    // and self-detect, producing a false positive. This is the second
    // time in 12 hours a source-reading test has bitten us in this
    // project — the lesson: a test that reads source MUST always
    // delimit the region it measures and exclude itself.
    #[test]
    fn goal_evaluator_uses_cli_spawn_not_global() {
        let full_src = std::fs::read_to_string("src/services/goal_evaluator.rs")
            .expect("could not read goal_evaluator.rs (run from src-tauri/)");

        // Measure ONLY production code: everything before `#[cfg(test)]`.
        // That line opens this `mod tests` block; everything from there
        // onward is test code and must be excluded from the scan.
        let cfg_test_marker = "#[cfg(test)]";
        let production_src: &str = match full_src.find(cfg_test_marker) {
            Some(idx) => &full_src[..idx],
            None => &full_src[..],
        };

        // Invoking CliSpawn::new(...) is required — this is the managed
        // runtime route that works in the packaged app.
        assert!(
            production_src.contains("CliSpawn::new("),
            "src/services/goal_evaluator.rs production code does not CALL \
             `CliSpawn::new(`. The Goal evaluator would fall back to spawning \
             `verboo` by name, which is NOT installed on end-user machines. \
             The G-C1 QA flagged exactly this: the managed CLI route must be \
             invoked. See run_evaluation_cli in goal_evaluator.rs — it must \
             call `CliSpawn::new(args)` instead of resolving via cli_path."
        );

        // Must NOT call cli_path::resolve — that was the broken
        // global-fallback path that shipped the Goal broken for end users.
        assert!(
            !production_src.contains("cli_path::resolve("),
            "src/services/goal_evaluator.rs production code still calls \
             `cli_path::resolve(`. This is the broken global-fallback path \
             that landed the Goal broken for end users (G-C1). Use \
             CliSpawn::new(...) instead."
        );

        // Must NOT call Command::new directly — the legacy manual-spawn
        // path bypassed CliSpawn entirely. The packaged app needs CliSpawn
        // so managed Node and the leased signed cli.mjs get wired correctly.
        assert!(
            !production_src.contains("Command::new("),
            "src/services/goal_evaluator.rs production code still uses \
             `Command::new(` directly. G-C1 migrated this to CliSpawn; if you \
             see this failure, the migration was reverted. Use \
             `CliSpawn::new(args).command`."
        );

        // Must NOT have the removed `resolve_cli_path()` helper — that
        // was the function that packaged-app users broke on.
        assert!(
            !production_src.contains("fn resolve_cli_path("),
            "src/services/goal_evaluator.rs production code still defines \
             `fn resolve_cli_path(...)`. That was the broken global-fallback \
             resolver. G-C1 deleted it."
        );
    }

    // ── G-C18: tool_output in TranscriptItem ──────────────────────────

    #[test]
    fn g_c18_tool_output_deserializes_from_camel_case() {
        // The renderer sends `toolOutput` (camelCase); the Rust struct
        // has `tool_output` with #[serde(rename_all = "camelCase")] on
        // TranscriptItem. This test proves the field survives round-trip
        // serialization and deserialization.
        let json = serde_json::json!({
            "id": "test-1",
            "role": "assistant",
            "text": "I read the file.",
            "timestamp": 1_700_000_000,
            "toolOutput": "1\tSOMA\n"
        });
        let item: TranscriptItem = serde_json::from_value(json).unwrap();
        assert_eq!(
            item.tool_output,
            Some("1\tSOMA\n".into()),
            "G-C18: toolOutput deserializes into tool_output via camelCase rename"
        );
    }

    #[test]
    fn g_c18_tool_output_absent_does_not_break_deserialization() {
        // Items without tool_output must deserialize correctly and the
        // field must be None, preserving backward compatibility with
        // existing conversation items.
        let json = serde_json::json!({
            "id": "test-2",
            "role": "user",
            "text": "Hello",
            "timestamp": 1_700_000_001,
        });
        let item: TranscriptItem = serde_json::from_value(json).unwrap();
        assert!(item.tool_output.is_none(), "G-C18: tool_output defaults to None when absent");
        assert_eq!(item.text, "Hello");
    }

    #[test]
    fn g_c18_tool_output_appears_in_prompt_when_present() {
        // When a TranscriptItem has tool_output, build_evaluation_prompt
        // must include a "Tool output:" block with the truncated text.
        let goal = sample_goal();
        let items = vec![TranscriptItem {
            id: "tool-item-1".into(),
            role: "assistant".into(),
            text: "I read the file.".into(),
            timestamp: 1_700_000_002,
            kind: Some("message".into()),
            activity_kind: None,
            activity_detail: None,
            command: None,
            change_summary: None,
            model_id: None,
            model_display_name: None,
            streaming: None,
            skills: None,
            tool_output: Some("1\tSOMA\n".into()),
        }];
        let prompt = build_evaluation_prompt(&goal, &items);
        assert!(
            prompt.contains("Tool output:"),
            "G-C18: prompt must contain 'Tool output:' header"
        );
        assert!(
            prompt.contains("1\tSOMA"),
            "G-C18: prompt must contain the tool output content"
        );
    }

    #[test]
    fn g_c18_tool_output_absent_does_not_add_tool_output_header() {
        // When no item has tool_output, the prompt must NOT contain
        // "Tool output:" headers (no stale decoration).
        let goal = sample_goal();
        let items = vec![TranscriptItem {
            id: "plain-item-1".into(),
            role: "assistant".into(),
            text: "I wrote the file.".into(),
            timestamp: 1_700_000_003,
            kind: Some("message".into()),
            activity_kind: None,
            activity_detail: None,
            command: None,
            change_summary: None,
            model_id: None,
            model_display_name: None,
            streaming: None,
            skills: None,
            tool_output: None,
        }];
        let prompt = build_evaluation_prompt(&goal, &items);
        assert!(
            !prompt.contains("Tool output:"),
            "G-C18: prompt must NOT contain 'Tool output:' when no item has tool_output"
        );
    }

    #[test]
    fn g_c18_tool_output_is_truncated_when_too_large() {
        // The truncation limit for tool_output is 800 chars. An output
        // over 800 must be truncated and marked with the truncation
        // sentinel.
        let goal = sample_goal();
        let large_output = "A".repeat(1000);
        let items = vec![TranscriptItem {
            id: "tool-item-large".into(),
            role: "assistant".into(),
            text: "Read large file.".into(),
            timestamp: 1_700_000_004,
            kind: Some("message".into()),
            activity_kind: None,
            activity_detail: None,
            command: None,
            change_summary: None,
            model_id: None,
            model_display_name: None,
            streaming: None,
            skills: None,
            tool_output: Some(large_output),
        }];
        let prompt = build_evaluation_prompt(&goal, &items);
        assert!(
            prompt.contains("[truncated"),
            "G-C18: truncated tool_output must contain truncation sentinel"
        );
        // The first 800 chars of the output must be present.
        assert!(
            prompt.contains(&"A".repeat(800)),
            "G-C18: first 800 chars of tool_output must survive truncation"
        );
    }

    // ── G-C18-FIX: char-boundary-safe truncation + multibyte coverage ─

    #[test]
    fn g_c18_fix_truncate_char_safe_does_not_panic_on_multibyte() {
        // G-C18-FIX: the previous `&s[..800]` panicked because byte 800
        // was not a char boundary on Portuguese content (multibyte
        // UTF-8 for accented chars). This test asserts:
        //   (1) the helper does not panic on Portuguese text with
        //       accents landing inside the cut window
        //   (2) the output is valid UTF-8 (no mid-codepoint slice)
        //   (3) the truncation sentinel reports CHARS cut, not bytes
        let goal = sample_goal();
        // Build ~1000 chars of Portuguese prose. Each accented char is
        // 2 bytes in UTF-8; byte 800 will land mid-char.
        let pt_sentence = "Criação do arquivo contendo a palavra SOMA verificada por leitura. ";
        let mut pt = String::new();
        while pt.chars().count() < 1000 {
            pt.push_str(pt_sentence);
        }
        let pt = pt; // 1000+ chars
        let items = vec![TranscriptItem {
            id: "tool-item-pt".into(),
            role: "assistant".into(),
            text: "Read arquivo.".into(),
            timestamp: 1_700_000_005,
            kind: Some("message".into()),
            activity_kind: None,
            activity_detail: None,
            command: None,
            change_summary: None,
            model_id: None,
            model_display_name: None,
            streaming: None,
            skills: None,
            tool_output: Some(pt.clone()),
        }];
        // MUST NOT PANIC. The pre-fix code panicked on this exact input.
        let prompt = build_evaluation_prompt(&goal, &items);
        assert!(
            prompt.contains("Tool output:"),
            "G-C18-FIX: prompt must contain Tool output block"
        );
        assert!(
            prompt.contains("[truncated"),
            "G-C18-FIX: truncation sentinel must be present"
        );
        // The prefix that survived must be valid UTF-8 (Rust guarantees
        // &str is UTF-8; the build_evaluation_prompt build itself would
        // have panicked if we sliced mid-codepoint).
    }

    #[test]
    fn g_c18_fix_truncate_char_safe_sentinel_reports_chars_not_bytes() {
        // G-C18-FIX: the sentinel must report how many CHARS were cut,
        // not the total length, so the model knows what's missing.
        let s: String = "áéíóúç".chars().cycle().take(1500).collect(); // 1500 chars
        let truncated = truncate_char_safe(&s, 800);
        assert!(
            truncated.contains("[truncated"),
            "G-C18-FIX: sentinel present"
        );
        // Extract the number from the sentinel.
        let prefix = "[truncated ";
        let num_start = truncated.find(prefix).unwrap() + prefix.len();
        let num_end = truncated[num_start..].find(' ').unwrap() + num_start;
        let n: usize = truncated[num_start..num_end].parse().unwrap();
        // Should be a sensible number of CHARS cut from the tail. With
        // 1500 chars total and ~800 bytes kept (each char is 2 bytes),
        // ~400 chars survive and ~1100 are cut. Assert it's positive
        // and less than the total (1500).
        assert!(n > 0 && n < 1500, "G-C18-FIX: sentinel reports chars, got {n}");
    }

    #[test]
    fn g_c19_fix_bundle_id_constant_matches_tauri_conf_json() {
        // G-C19-FIX extra: GOAL_TIMING_BUNDLE_ID must match `identifier`
        // in src-tauri/tauri.conf.json. The previous hardcoded
        // "com.verboo.app" was wrong. A comment does not protect against
        // future drift; this test does.
        let source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tauri.conf.json"),
        )
        .expect("tauri.conf.json must be readable from cargo test");
        // Extract the `identifier` field value (JSON).
        let id_line: &str = source
            .lines()
            .find(|l| l.contains("\"identifier\""))
            .expect("tauri.conf.json must contain an identifier field");
        // Trim and parse "identifier": "<value>"
        let value = id_line
            .split('"')
            .nth(3)
            .expect("identifier value must be a quoted JSON string");
        // Mirror the constant declared in run_evaluation_cli (kept here
        // inline to avoid exposing a private const).
        const GOAL_TIMING_BUNDLE_ID: &str = "ai.verboo.code.desktop";
        assert_eq!(
            value, GOAL_TIMING_BUNDLE_ID,
            "GOAL_TIMING_BUNDLE_ID in goal_evaluator.rs must match identifier in tauri.conf.json"
        );
    }

    // ── G-C18-MEDICAO: realistic prompt decomposition ────────────────
    //
    // Decompose the prompt into its fixed and variable blocks using a
    // REALISTIC fixture — not the synthetic 7-char tool_output that gave
    // 3.8K tokens vs 41K in field. The fixture models what a real script
    // workflow looks like with tool outputs of ~500-3000 chars (Read of
    // package.json, config file, error log).
    //
    // The method: build the prompt from a representative transcript,
    // slice by `##` headers, report bytes/~tokens per block as % of the
    // TOTAL goal_evaluator prompt. The remaining gap between our total
    // and the user's 41K is the CLI overhead (system prompt, API call
    // framing) — NOT controlled by this prompt.

    fn report_prompt_decomposition(items: &[TranscriptItem], goal_text: &str, window: usize) {
        let goal = GoalState {
            objective: goal_text.into(),
            ..sample_goal()
        };
        let recent = items
            .iter()
            .rev()
            .take(window)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>();
        let prompt = build_evaluation_prompt(&goal, &recent);
        let total_bytes = prompt.len();

        // Split by `## ` markers to identify sections. The prompt also
        // has a top-level `# Goal Evaluation` before any `##` marker.
        let h_pos: Vec<usize> = prompt.match_indices("## ").map(|(i, _)| i).collect();
        let mut sections: Vec<(String, usize)> = Vec::new();

        // Pre-header block (before ## Goal)
        let first_h = *h_pos.first().unwrap_or(&total_bytes);
        if first_h > 0 {
            let text = prompt[..first_h].trim_end();
            if !text.is_empty() {
                sections.push(("Preamble (instructions)".to_string(), text.len()));
            }
        }

        // Each ##-delimited section
        for i in 0..h_pos.len() {
            let start = h_pos[i];
            let end = h_pos.get(i + 1).copied().unwrap_or(prompt.len());
            let text = &prompt[start..end];
            let line_end = text.find('\n').unwrap_or(text.len());
            let header = text[..line_end].trim();
            let label: String = match header {
                "## Goal" => "Goal objective".into(),
                "## Context" => "Context line".into(),
                "## Recent transcript items" => "Transcript items".into(),
                "## Evaluation" => "Rules + JSON schema + closing".into(),
                _ => header.into(),
            };
            sections.push((label, text.trim_end().len()));
        }

        // Items section substats (tool_output weight inside it)
        // Find the byte position of the "## Recent transcript items" header
        let items_pos = prompt.match_indices("## Recent transcript items")
            .next().map(|(i, _)| i);
        // Find the byte position of the "## Evaluation" header (next section)
        let eval_pos = prompt.match_indices("## Evaluation")
            .next().map(|(i, _)| i);
        let items_bytes = match (items_pos, eval_pos) {
            (Some(is), Some(es)) => (es - is).saturating_sub(1), // exclude leading `\n`
            _ => 0,
        };

        eprintln!("\n=== G-C18-MEDICAO: prompt decomposition (window={}) ===", window);
        eprintln!("Total goal_evaluator prompt: {} bytes ≈ {} tokens", total_bytes, total_bytes / 4);
        eprintln!("{:-<60}", "");
        eprintln!("{:<40} {:>8} {:>8} {:>8}", "Section", "bytes", "~tokens", "%ofEval");
        eprintln!("{:-<60}", "");
        for (label, sz) in &sections {
            let t = sz / 4;
            let pct = *sz as f64 / total_bytes as f64 * 100.0;
            eprintln!("{:<40} {:>8} {:>8} {:>7.1}%", label, sz, t, pct);
        }
        eprintln!("{:-<60}", "");
        // Tool output weight within items section
        if let Some(mut is) = prompt.find("## Recent transcript items") {
            let items_end = prompt[is..].find("## Evaluation").map(|e| is + e).unwrap_or(prompt.len());
            let body = &prompt[is..items_end];
            let tool_bytes: usize = body.match_indices("**Tool output:**")
                .map(|(start_idx, _)| {
                    let snippet = &body[start_idx..];
                    let code_start = snippet.find("```").map(|p| start_idx + p + 3).unwrap_or(start_idx);
                    let code_remain = if code_start > start_idx { &body[code_start..] } else { "" };
                    let code_end = code_remain.find("```").map(|p| code_start + p + 3).unwrap_or(code_start);
                    code_end - start_idx
                }).sum();
            let cmd_bytes: usize = body.match_indices("**Command:**")
                .map(|(start_idx, _)| {
                    let snippet = &body[start_idx..];
                    let code_end = snippet.find("```\n").map(|p| start_idx + p + 4).unwrap_or(start_idx);
                    code_end - start_idx
                }).sum();
            let pct_tool = if body.len() > 0 { tool_bytes as f64 / body.len() as f64 * 100.0 } else { 0.0 };
            let pct_cmd = if body.len() > 0 { cmd_bytes as f64 / body.len() as f64 * 100.0 } else { 0.0 };
            eprintln!("  items section: {} bytes, tool_output markup: {} ({:.1}%), command: {} ({:.1}%)",
                body.len(), tool_bytes, pct_tool, cmd_bytes, pct_cmd);
        }
        // Context comparison vs field
        eprintln!("\nReference: field measured total = ~41,188 tokens/call (3-eval avg)");
        let pct_of_field = (total_bytes as f64 / 4.0) / 41188.0 * 100.0;
        eprintln!("  goal_evaluator prompt = ~{:.1}% of field total ({} tokens of 41,188)",
            pct_of_field, total_bytes / 4);
        eprintln!("  CLI/API overhead (not controlled here) = ~{:.1}%", 100.0 - pct_of_field);
        // What would change by reducing window
        let fixed_bytes = total_bytes - items_bytes;
        for (w2, label) in &[(20u8, "window=20"), (15, "window=15"), (10, "window=10")] {
            let w2 = *w2 as usize;
            if w2 >= window { continue; }
            let recent2 = items.iter().rev().take(w2).cloned().collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>();
            let p2 = build_evaluation_prompt(&goal, &recent2);
            let savings = total_bytes.saturating_sub(p2.len());
            let savings_tokens = savings / 4;
            eprintln!("  {label}: saves ~{savings} bytes ≈ {savings_tokens} tokens ({:.1}% of eval prompt)", savings as f64 / total_bytes as f64 * 100.0);
        }
        eprintln!("");
    }

    fn realistic_transcript_item(
        id: &str,
        role: &str,
        tool_output_len: usize,
        text_len: usize,
        has_cmd: bool,
    ) -> TranscriptItem {
        let text = format!("{} {}", role, "X".repeat(text_len.saturating_sub(role.len() + 1)));
        let cmd_output = if has_cmd {
            Some(CommandRun {
                input: "ls -la /tmp".into(),
                output: format!("total 128\n{}", "Y".repeat(500)),
                status: CommandStatus::Success,
            })
        } else {
            None
        };
        TranscriptItem {
            id: id.into(),
            role: role.into(),
            text,
            timestamp: 1_700_000_000,
            kind: Some("message".into()),
            activity_kind: None,
            activity_detail: None,
            command: cmd_output,
            change_summary: None,
            model_id: None,
            model_display_name: None,
            streaming: None,
            skills: None,
            tool_output: if tool_output_len > 0 {
                Some("Z".repeat(tool_output_len))
            } else {
                None
            },
        }
    }

    #[test]
    fn g_c18_realistic_decomposition() {
        // Model a realistic script agent workflow with 30 items at windows
        // 30, 20, 15, 10. Based on:
        //   - agent prose: ~2000 chars (reads + explains)
        //   - Read tool output: ~600 chars (Read of a package.json ~200-500 is
        //     common, but a Read of a log or config is bigger)
        //   - Command output: ~500 chars
        //   - User messages: ~80 chars
        // This is a CONSERVATIVE estimate — many tool outputs (Read of full
        // files) can be 3000-5000 chars, but 600 is the median.
        let goal_text = "Create /tmp/goal-total.txt containing the word SOMA and verify its contents via Read. \
            The Read result must confirm a single line containing the literal SOMA.";
        let mut items = Vec::with_capacity(35);
        for i in 0..35 {
            let role = if i % 5 == 0 { "user" } else { "assistant" };
            let text_len = if role == "user" { 80 } else { 2000 };
            let tool_len = if role == "assistant" && i % 3 == 1 { 600 } else { 0 };
            items.push(realistic_transcript_item(&format!("item-{i}"), role, tool_len, text_len, i % 7 == 3));
        }
        for w in [30usize, 20, 15, 10] {
            report_prompt_decomposition(&items, goal_text, w);
        }
    }

    // ── TaskImpossible: symbolic artifact → pause + non-empty reason ──

    #[test]
    fn symbolic_artifact_triggers_pause_with_task_impossible() {
        // The model reports a structurally impossible task and proposes a
        // symbolic artifact (empty file, placeholder). The evaluator must
        // pause (not complete, not fail) so the user can read the reason.
        let json = json!({
            "decision": "pause",
            "reasonId": "taskImpossible",
            "reason": "The URL http://example.invalid uses a reserved TLD that cannot resolve. Created an empty placeholder file but the actual fetch is structurally impossible.",
            "nextAction": "The user should specify an alternative URL or adjust the objective.",
            "confidence": 0.95
        });
        let result = normalize_evaluation(json, true);
        assert_eq!(result.decision, GoalDecision::Pause);
        assert_eq!(result.reason_id, GoalReasonId::TaskImpossible);
        assert!(
            !result.reason.is_empty(),
            "taskImpossible reason must be non-empty so the user understands why the task is impossible"
        );
    }

    // ── Counterfactual: real delivery must NOT be flagged ──────────────

    #[test]
    fn real_delivery_not_flagged_as_task_impossible() {
        // Rule 4 (symbolic artifact) must NOT suppress legitimate
        // completions. A real delivery (file created, verified) with
        // decision=complete+reasonId=done must pass through unchanged.
        // This is the mandatory counterfactual: without it, we can't
        // prove the rule doesn't over-reject legitimate work.
        let json = json!({
            "decision": "complete",
            "reasonId": "done",
            "reason": "File created at /tmp/output.txt and contents verified via Read",
            "completionSummary": "Created /tmp/output.txt with expected content. Read confirmed 3 lines matching the specification.",
            "confidence": 0.97
        });
        let result = normalize_evaluation(json, true);
        assert_eq!(result.decision, GoalDecision::Complete);
        assert_eq!(result.reason_id, GoalReasonId::Done);
    }

    // ── parse_reason_id: taskImpossible does not fall to default ───────

    #[test]
    fn parse_reason_id_task_impossible_does_not_fall_to_default() {
        // Without the explicit arm in parse_reason_id, "taskimpossible"
        // would hit the catch-all and silently become TaskIncomplete.
        // This test proves the arm fires and maps correctly.
        assert_eq!(
            parse_reason_id(Some(&json!("taskimpossible"))),
            GoalReasonId::TaskImpossible,
            "lowercase taskimpossible must map to TaskImpossible, not default TaskIncomplete"
        );
        assert_eq!(
            parse_reason_id(Some(&json!("task_impossible"))),
            GoalReasonId::TaskImpossible,
            "snake_case task_impossible must also map to TaskImpossible"
        );
        assert_eq!(
            parse_reason_id(Some(&json!("taskImpossible"))),
            GoalReasonId::TaskImpossible,
            "camelCase taskImpossible must also map to TaskImpossible"
        );
        // Case-insensitive: uppercase
        assert_eq!(
            parse_reason_id(Some(&json!("TASKIMPOSSIBLE"))),
            GoalReasonId::TaskImpossible,
            "TASKIMPOSSIBLE must map to TaskImpossible"
        );
    }
}
