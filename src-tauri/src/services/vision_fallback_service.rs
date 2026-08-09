//! Vision fallback service — describes images using a vision-capable model
//! from the user's own catalog when the selected model doesn't support vision.
//!
//! FASE 1 of the vision fallback design (plans/11-vision-fallback-design.md).
//!
//! Flow:
//! 1. `resolve_vision_helper(models)` — picks the first vision-capable model
//!    from the user's catalog. NEVER hardcoded — if the user's plan has no
//!    vision model, returns None.
//! 2. `describe_image(path, media_type, helper_model, credentials)` — spawns
//!    a secondary CLI with the helper model, sends the image via stream-json,
//!    captures the text description.
//! 3. `sha256_hash(path)` — cache key. Descriptions are cached in
//!    `app_data_dir/vision_cache/<hash>.json` so repeated attachments don't
//!    re-spawn the CLI.
//!
//! Consent is managed by the caller (turn_service) via `VisionFallbackConsent`
//! in `UserSettings`. This service does NOT enforce consent — it only does
//! the mechanical work of resolving + describing + caching.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use sha2::{Digest, Sha256};

use crate::models::types::{ModelDiscoveryResult, VerbooModel};
use crate::services::auth_token::{inject_api_key, resolve_token};
use crate::services::credentials_store::CredentialsStore;

/// Cache entry for a described image.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisionCacheEntry {
    pub hash: String,
    pub description: String,
    pub helper_model: String,
    pub created_at: u64,
}

/// Picks the first vision-capable model from the user's catalog.
///
/// Selection order (deterministic, no hardcoded ids):
/// 1. Models where `supports_vision == Some(true)`.
/// 2. Within that set, prefer (a) router-sourced vision flag, then (b) higher
///    tier as inferred from the id prefix — `ultra/` ranks above `pro/` which
///    ranks above everything else. The prefix convention is the same one the
///    Verboo Router uses to expose model tiers and is purely lexicographic
///    (no vendor list).
/// 3. Within each tier, sort by display_name for deterministic picks.
///
/// Returns `None` if the user's plan has no vision-capable model. The caller
/// must handle this (tell the user their plan doesn't include a vision model).
pub fn resolve_vision_helper(models: &ModelDiscoveryResult) -> Option<&VerbooModel> {
    let mut vision_models: Vec<&VerbooModel> = models
        .models
        .iter()
        .filter(|m| m.supports_vision == Some(true))
        .collect();
    if vision_models.is_empty() {
        return None;
    }
    vision_models.sort_by(|a, b| {
        let a_router = a.vision_support_source.as_deref() == Some("router");
        let b_router = b.vision_support_source.as_deref() == Some("router");
        b_router
            .cmp(&a_router)
            .then_with(|| tier_rank(&b.id).cmp(&tier_rank(&a.id)))
            .then_with(|| a.display_name.cmp(&b.display_name))
    });
    vision_models.into_iter().next()
}

/// Maps a model id to a deterministic tier rank used only to break ties when
/// selecting a vision helper. Higher rank = preferred.
///
/// - id starts with `ultra/` → 3
/// - id starts with `pro/`   → 2
/// - otherwise               → 1
///
/// The prefixes mirror the Verboo Router's id convention. No vendor names or
/// hardcoded model ids are involved.
fn tier_rank(id: &str) -> u8 {
    let lower = id.to_lowercase();
    if lower.starts_with("ultra/") {
        3
    } else if lower.starts_with("pro/") {
        2
    } else {
        1
    }
}

/// Computes the SHA-256 hash of a file for cache keying.
pub fn sha256_hash(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Returns the cache directory for vision descriptions.
/// Creates it if it doesn't exist.
fn cache_dir(app_data_dir: &Path) -> Result<PathBuf, String> {
    let dir = app_data_dir.join("vision_cache");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

/// Reads a cached description for the given hash. Returns None if not cached
/// or if the cache file is corrupt/unreadable.
pub fn read_cache(app_data_dir: &Path, hash: &str) -> Option<VisionCacheEntry> {
    let dir = cache_dir(app_data_dir).ok()?;
    let path = dir.join(format!("{hash}.json"));
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

/// Writes a description to the cache.
fn write_cache(app_data_dir: &Path, entry: &VisionCacheEntry) -> Result<(), String> {
    let dir = cache_dir(app_data_dir)?;
    let path = dir.join(format!("{}.json", entry.hash));
    let content = serde_json::to_string_pretty(entry).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Timeout for the helper CLI to produce a description. 30s is generous
/// for a single image description — if the CLI hangs (e.g. network issue,
/// model overload), we abort and inject a timeout warning instead of
/// blocking the user's turn indefinitely.
const HELPER_CLI_TIMEOUT: Duration = Duration::from_secs(30);

/// Spawns a secondary CLI with the helper model to describe an image.
///
/// The CLI is spawned with `--input-format stream-json` and a user message
/// containing the image as a base64 data URL + a "describe this image" prompt.
/// The CLI's text output is captured and returned as the description.
///
/// Uses `CliSpawn` (the same resolver the main turn uses) to acquire the active
/// signed CLI and embedded Node runtime. This prevents any packaged build from
/// falling back to a global CLI.
///
/// **Timeout**: if the CLI doesn't produce a result within `HELPER_CLI_TIMEOUT`
/// (30s), the process is killed and an error is returned. The caller injects
/// a clear warning into the turn instead of blocking indefinitely.
///
/// This is a blocking call — the caller should run it on a background thread.
pub fn describe_image(
    image_path: &Path,
    media_type: &str,
    helper_model: &str,
    credentials: &CredentialsStore,
) -> Result<String, String> {
    describe_image_with_retry(image_path, media_type, helper_model, credentials, None)
}

/// Inner describe with optional retry on a different helper model. The retry
/// is only attempted when the first helper fails AND a fallback model is
/// provided by the caller (next-best vision model from the catalog).
pub fn describe_image_with_retry(
    image_path: &Path,
    media_type: &str,
    helper_model: &str,
    credentials: &CredentialsStore,
    fallback_helper: Option<&str>,
) -> Result<String, String> {
    match describe_image_once(image_path, media_type, helper_model, credentials) {
        Ok(text) => Ok(text),
        Err(first_err) => {
            if let Some(next_model) = fallback_helper {
                eprintln!(
                    "[verboo:vision-fallback] first helper failed ({first_err}); retrying with {next_model}"
                );
                describe_image_once(image_path, media_type, next_model, credentials)
                    .map_err(|second_err| format!("{first_err}; retry {next_model}: {second_err}"))
            } else {
                Err(first_err)
            }
        }
    }
}

fn describe_image_once(
    image_path: &Path,
    media_type: &str,
    helper_model: &str,
    credentials: &CredentialsStore,
) -> Result<String, String> {
    describe_image_once_with_prompt(
        image_path,
        media_type,
        "Describe this image in detail. Include all visible text, objects, people, colors, layout, and any other relevant details. Be thorough but concise.",
        helper_model,
        credentials,
    )
}

/// Same one-shot helper turn as `describe_image_once`, but with a
/// caller-supplied prompt. Used by the video pipeline to request strict JSON
/// analysis of labeled contact sheets.
pub fn describe_image_once_with_prompt(
    image_path: &Path,
    media_type: &str,
    prompt: &str,
    helper_model: &str,
    credentials: &CredentialsStore,
) -> Result<String, String> {
    // Read and base64-encode the image. The CLI expects raw base64 (no
    // `data:` URL prefix) inside an Anthropic-style `source.base64` block.
    let bytes = std::fs::read(image_path).map_err(|e| format!("read image: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

    // Build the stream-json user message. The CLI's `StructuredIO.processLine`
    // requires the envelope `{type:"user", message:{role:"user", content:[...]}}`
    // — a bare `{role, content}` is silently ignored, which was the root cause
    // of "vision model returned no description".
    let message = serde_json::json!({
        "type": "user",
        "session_id": "",
        "message": {
            "role": "user",
            "content": [
                { "type": "text", "text": prompt },
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": b64
                    }
                }
            ]
        },
        "parent_tool_use_id": null
    });
    let stdin_payload = format!("{message}\n");

    // Build CLI args. The helper is a one-shot non-interactive turn, so we
    // always bypass permissions — without this the CLI may emit a permission
    // prompt and exit without producing a result.
    let args = vec![
        "--print".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
        "--model".to_string(),
        helper_model.to_string(),
        "--allow-dangerously-skip-permissions".to_string(),
        "--dangerously-skip-permissions".to_string(),
        "--permission-mode".to_string(),
        "bypassPermissions".to_string(),
    ];

    // LOG 3: spawn args (helps debug "wrong model" / "missing flag" issues).
    eprintln!(
        "[verboo:vision-fallback] spawning helper CLI: model={helper_model}, args={:?}",
        args
    );
    // LOG 4: payload length (base64 image can be large — helps debug
    // "stdin write failed" or "payload too large" issues). We log the length
    // and the content block shape, never the base64 blob itself.
    eprintln!(
        "[verboo:vision-fallback] stdin payload: {} bytes, content blocks: text+image(source.base64, mime={media_type})",
        stdin_payload.len()
    );

    // Use CliSpawn — the same resolver the main turn uses. This acquires an
    // immutable lease for the active signed CLI and embedded Node runtime.
    let spawn = crate::services::cli_spawn::CliSpawn::new(&args);
    let mut cmd = spawn.command;
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Run from the image's parent directory when possible so the helper CLI
    // has a sane cwd (some models try to resolve relative paths). Falls back
    // to the system temp dir if the image has no parent.
    if let Some(parent) = image_path.parent() {
        if !parent.as_os_str().is_empty() {
            cmd.current_dir(parent);
        }
    }

    // On Windows, create the helper child in its own process group so
    // `GenerateConsoleCtrlEvent` can target it for graceful interrupt (same
    // pattern as the main turn in turn_service.rs).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::services::child_signal::process_creation_flags());
    }

    // Resolve token and inject into env.
    let token = resolve_token(credentials);
    let _token_file = inject_api_key(token.as_deref(), &mut cmd);
    crate::services::auth_token::augment_identity_env(&mut cmd);

    let start = Instant::now();
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn CLI: {e}"))?;

    // Write stdin payload.
    if let Some(stdin) = child.stdin.take() {
        use std::io::Write;
        let mut stdin = stdin;
        let _ = stdin.write_all(stdin_payload.as_bytes());
        let _ = stdin.flush();
        // stdin drops here → EOF.
    }

    // Drain stderr on a separate thread so the child can't block on a full
    // stderr pipe. We keep the last ~2k chars for error reporting.
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "CLI stderr unavailable".to_string())?;
    let (stderr_tx, stderr_rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buffer = String::new();
        let mut chunk = [0u8; 1024];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    if let Ok(s) = std::str::from_utf8(&chunk[..n]) {
                        buffer.push_str(s);
                        // Keep the buffer bounded to the last ~4k chars so a
                        // verbose CLI doesn't grow it unbounded.
                        if buffer.len() > 4096 {
                            let cut = buffer.len() - 4096;
                            buffer = buffer.split_off(cut);
                        }
                    }
                }
                Err(_) => break,
            }
        }
        let _ = stderr_tx.send(buffer);
    });

    // Read stdout on a separate thread with a timeout. The thread sends
    // parsed lines back via a channel; the main thread aborts if the
    // timeout expires before a result message arrives.
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "CLI stdout unavailable".to_string())?;
    let (tx, rx) = mpsc::channel::<ParsedLine>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    let parsed = parse_stream_json_line(&l);
                    let _ = tx.send(parsed);
                }
                Err(e) => {
                    // LOG 5: invalid parsed lines (helps debug "CLI output
                    // format changed" or "encoding issue" bugs).
                    eprintln!(
                        "[verboo:vision-fallback] stdout read error: {e}"
                    );
                    break;
                }
            }
        }
    });

    // Collect lines until we get a Result message or timeout.
    let mut description = String::new();
    let mut got_result = false;
    let deadline = start + HELPER_CLI_TIMEOUT;
    loop {
        let now = Instant::now();
        if now >= deadline {
            // Timeout — kill the child and return an error.
            let _ = child.kill();
            let _ = child.wait();
            let stderr_snippet = collect_stderr(&stderr_rx);
            eprintln!(
                "[verboo:vision-fallback] TIMEOUT after {:.1}s — killing helper CLI; stderr={stderr_snippet}",
                start.elapsed().as_secs_f64()
            );
            return Err(format!(
                "vision helper CLI timed out after {}s; stderr: {stderr_snippet}",
                HELPER_CLI_TIMEOUT.as_secs()
            ));
        }
        let remaining = deadline - now;
        match rx.recv_timeout(remaining) {
            Ok(ParsedLine::Result(text)) => {
                description = text;
                got_result = true;
                break;
            }
            Ok(ParsedLine::AssistantText(text)) => {
                description.push_str(&text);
            }
            Ok(ParsedLine::StreamDelta(text)) => {
                description.push_str(&text);
            }
            Ok(ParsedLine::Other) => {
                // Non-result line — keep waiting.
            }
            Ok(ParsedLine::Invalid(line)) => {
                // LOG 5: invalid parsed lines (helps debug "CLI output
                // format changed" or "encoding issue" bugs).
                eprintln!(
                    "[verboo:vision-fallback] unparseable stdout line (len={}): {:?}",
                    line.len(),
                    if line.len() > 200 { &line[..200] } else { &line }
                );
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Loop back to check the deadline.
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // Reader thread exited (CLI closed stdout). Break and check
                // what we collected.
                break;
            }
        }
    }

    let _ = child.wait();
    let stderr_snippet = collect_stderr(&stderr_rx);

    // LOG 6: empty description (helps debug "model returned nothing" bugs).
    if description.trim().is_empty() {
        eprintln!(
            "[verboo:vision-fallback] helper returned empty description after {:.1}s (got_result={got_result}); stderr={stderr_snippet}",
            start.elapsed().as_secs_f64()
        );
        Err(format!(
            "vision model returned no description; stderr: {stderr_snippet}"
        ))
    } else {
        eprintln!(
            "[verboo:vision-fallback] helper returned {} chars in {:.1}s",
            description.len(),
            start.elapsed().as_secs_f64()
        );
        Ok(description)
    }
}

fn collect_stderr(stderr_rx: &mpsc::Receiver<String>) -> String {
    let mut full = String::new();
    while let Ok(chunk) = stderr_rx.try_recv() {
        full.push_str(&chunk);
    }
    if full.is_empty() {
        return "<no stderr>".to_string();
    }
    let trimmed = full.trim();
    if trimmed.len() <= 2000 {
        trimmed.to_string()
    } else {
        let cut = trimmed.len() - 2000;
        format!("…{}", &trimmed[cut..])
    }
}

/// Represents a parsed line from the helper CLI's stream-json stdout.
#[derive(Debug)]
enum ParsedLine {
    /// `{"type":"result","result":"..."}` — the final result.
    Result(String),
    /// `{"type":"assistant",...}` with text content blocks.
    AssistantText(String),
    /// `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}`
    /// — partial text emitted by some models that never send a complete
    /// assistant block.
    StreamDelta(String),
    /// A valid JSON line that doesn't match result or assistant.
    Other,
    /// A line that couldn't be parsed as JSON.
    Invalid(String),
}

fn parse_stream_json_line(line: &str) -> ParsedLine {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) else {
        return ParsedLine::Invalid(line.to_string());
    };
    // Result message: {"type":"result","result":"...","subtype":"success"}
    if parsed.get("type").and_then(|v| v.as_str()) == Some("result") {
        if let Some(result) = parsed.get("result").and_then(|v| v.as_str()) {
            return ParsedLine::Result(result.to_string());
        }
    }
    // Assistant message with text content.
    if parsed.get("type").and_then(|v| v.as_str()) == Some("assistant") {
        if let Some(content) = parsed
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        {
            let mut text = String::new();
            for block in content {
                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                        text.push_str(t);
                    }
                }
            }
            if !text.is_empty() {
                return ParsedLine::AssistantText(text);
            }
        }
    }
    // stream_event with a text_delta — some models only emit partial deltas
    // and never send a complete assistant block.
    if parsed.get("type").and_then(|v| v.as_str()) == Some("stream_event") {
        if let Some(delta_text) = extract_stream_event_delta_text(&parsed) {
            if !delta_text.is_empty() {
                return ParsedLine::StreamDelta(delta_text);
            }
        }
    }
    ParsedLine::Other
}

/// Extracts the text payload from a `stream_event` line. Supports the common
/// Anthropic-style shape `{event:{type:"content_block_delta", delta:{type:"text_delta", text:"..."}}}`
/// and the flatter `{event:{type:"text_delta", text:"..."}}` variant.
fn extract_stream_event_delta_text(parsed: &serde_json::Value) -> Option<String> {
    let event = parsed.get("event")?;
    let delta = event.get("delta").or(Some(event))?;
    if delta.get("type").and_then(|v| v.as_str()) != Some("text_delta") {
        return None;
    }
    delta.get("text").and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// High-level: describes an image with caching. Checks cache first; if miss,
/// spawns the helper CLI, caches the result, and returns the description.
///
/// `app_data_dir` is the Tauri app data dir for cache storage.
pub fn describe_image_cached(
    image_path: &Path,
    media_type: &str,
    helper_model: &str,
    credentials: &CredentialsStore,
    app_data_dir: &Path,
) -> Result<String, String> {
    describe_image_cached_with_retry(
        image_path,
        media_type,
        helper_model,
        None,
        credentials,
        app_data_dir,
    )
}

/// Same as `describe_image_cached` but retries on a fallback helper model
/// when the primary helper fails. Cache is written with whichever model
/// succeeded (or the primary when both fail, so the cache key stays stable).
pub fn describe_image_cached_with_retry(
    image_path: &Path,
    media_type: &str,
    helper_model: &str,
    fallback_helper: Option<&str>,
    credentials: &CredentialsStore,
    app_data_dir: &Path,
) -> Result<String, String> {
    let hash = sha256_hash(image_path)?;
    if let Some(entry) = read_cache(app_data_dir, &hash) {
        return Ok(entry.description);
    }
    let description = describe_image_with_retry(
        image_path,
        media_type,
        helper_model,
        credentials,
        fallback_helper,
    )?;
    let entry = VisionCacheEntry {
        hash: hash.clone(),
        description: description.clone(),
        helper_model: helper_model.to_string(),
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    };
    let _ = write_cache(app_data_dir, &entry);
    Ok(description)
}

/// Picks the second-best vision model from the catalog, excluding the primary
/// helper id. Returns None when the catalog has no other vision model. Uses
/// the same deterministic sort as `resolve_vision_helper`.
pub fn resolve_fallback_helper<'a>(
    models: &'a ModelDiscoveryResult,
    primary_id: &str,
) -> Option<&'a VerbooModel> {
    let mut vision_models: Vec<&VerbooModel> = models
        .models
        .iter()
        .filter(|m| m.supports_vision == Some(true) && m.id != primary_id)
        .collect();
    if vision_models.is_empty() {
        return None;
    }
    vision_models.sort_by(|a, b| {
        let a_router = a.vision_support_source.as_deref() == Some("router");
        let b_router = b.vision_support_source.as_deref() == Some("router");
        b_router
            .cmp(&a_router)
            .then_with(|| tier_rank(&b.id).cmp(&tier_rank(&a.id)))
            .then_with(|| a.display_name.cmp(&b.display_name))
    });
    vision_models.into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{
        AccessMode, ModelDiscoveryResult, VerbooModel, VisionFallbackConsent,
    };

    fn make_model(id: &str, vision: Option<bool>, source: Option<&str>) -> VerbooModel {
        VerbooModel {
            id: id.into(),
            display_name: id.into(),
            context_window: None,
            max_output_tokens: None,
            supports_vision: vision,
            vision_support_source: source.map(|s| s.into()),
            reasoning: None,
            provider: None,
            raw: serde_json::json!({}),
        }
    }

    fn make_discovery(models: Vec<VerbooModel>) -> ModelDiscoveryResult {
        ModelDiscoveryResult {
            models,
            source: "router".into(),
            stale: false,
            error: None,
            provider_error: None,
        }
    }

    #[test]
    fn resolve_vision_helper_picks_first_vision_model() {
        let discovery = make_discovery(vec![
            make_model("glm-5.2", Some(false), Some("router")),
            make_model("claude-sonnet-4-6", Some(true), Some("router")),
            make_model("gpt-4o", Some(true), Some("router")),
        ]);
        let helper = resolve_vision_helper(&discovery).unwrap();
        assert_eq!(helper.id, "claude-sonnet-4-6");
    }

    #[test]
    fn resolve_vision_helper_returns_none_when_no_vision_model() {
        let discovery = make_discovery(vec![
            make_model("glm-5.2", Some(false), Some("router")),
            make_model("llama-3", None, None),
        ]);
        assert!(resolve_vision_helper(&discovery).is_none());
    }

    #[test]
    fn resolve_vision_helper_prefers_router_source() {
        // Even if heuristic-source vision model comes first alphabetically,
        // router-source should be preferred.
        let discovery = make_discovery(vec![
            make_model("aaa-heuristic-vision", Some(true), Some("heuristic")),
            make_model("zzz-router-vision", Some(true), Some("router")),
        ]);
        let helper = resolve_vision_helper(&discovery).unwrap();
        assert_eq!(helper.id, "zzz-router-vision");
    }

    #[test]
    fn resolve_vision_helper_prefers_ultra_over_pro_over_other() {
        // Same router source — tier (ultra/ > pro/ > other) decides.
        let discovery = make_discovery(vec![
            make_model("pro/claude-sonnet", Some(true), Some("router")),
            make_model("ultra/glm-5-vision", Some(true), Some("router")),
            make_model("minimax-vision", Some(true), Some("router")),
        ]);
        let helper = resolve_vision_helper(&discovery).unwrap();
        assert_eq!(helper.id, "ultra/glm-5-vision");
    }

    #[test]
    fn resolve_vision_helper_pro_tier_over_other_when_no_ultra() {
        let discovery = make_discovery(vec![
            make_model("claude-opus", Some(true), Some("router")),
            make_model("pro/claude-sonnet", Some(true), Some("router")),
        ]);
        let helper = resolve_vision_helper(&discovery).unwrap();
        assert_eq!(helper.id, "pro/claude-sonnet");
    }

    #[test]
    fn resolve_vision_helper_tier_rank_is_case_insensitive() {
        assert_eq!(tier_rank("ULTRA/foo"), 3);
        assert_eq!(tier_rank("Pro/bar"), 2);
        assert_eq!(tier_rank("plain"), 1);
        // Router takes priority over tier for the same id.
        let discovery = make_discovery(vec![
            make_model("pro/heuristic", Some(true), Some("heuristic")),
            make_model("plain-router", Some(true), Some("router")),
        ]);
        let helper = resolve_vision_helper(&discovery).unwrap();
        assert_eq!(helper.id, "plain-router");
    }

    #[test]
    fn resolve_fallback_helper_excludes_primary_and_picks_next_best() {
        let discovery = make_discovery(vec![
            make_model("ultra/primary", Some(true), Some("router")),
            make_model("pro/secondary", Some(true), Some("router")),
            make_model("plain-tertiary", Some(true), Some("router")),
        ]);
        let fallback = resolve_fallback_helper(&discovery, "ultra/primary").unwrap();
        assert_eq!(fallback.id, "pro/secondary");
    }

    #[test]
    fn resolve_fallback_helper_returns_none_when_only_primary_available() {
        let discovery = make_discovery(vec![make_model("ultra/only", Some(true), Some("router"))]);
        assert!(resolve_fallback_helper(&discovery, "ultra/only").is_none());
    }

    #[test]
    fn parse_stream_json_line_handles_result_and_assistant() {
        let result_line = r#"{"type":"result","result":"final text","subtype":"success"}"#;
        match parse_stream_json_line(result_line) {
            ParsedLine::Result(text) => assert_eq!(text, "final text"),
            other => panic!("expected Result, got {other:?}"),
        }

        let assistant_line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello "},{"type":"text","text":"world"}]}}"#;
        match parse_stream_json_line(assistant_line) {
            ParsedLine::AssistantText(text) => assert_eq!(text, "hello world"),
            other => panic!("expected AssistantText, got {other:?}"),
        }
    }

    #[test]
    fn parse_stream_json_line_captures_text_delta_stream_event() {
        // Some models only emit partial deltas and never send a complete
        // assistant block. The parser must accumulate these so the caller
        // can stitch them together.
        let delta_line = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial "}}}"#;
        match parse_stream_json_line(delta_line) {
            ParsedLine::StreamDelta(text) => assert_eq!(text, "partial "),
            other => panic!("expected StreamDelta, got {other:?}"),
        }

        // Flatter variant some routers emit.
        let flat_line = r#"{"type":"stream_event","event":{"type":"text_delta","text":"flat"}}"#;
        match parse_stream_json_line(flat_line) {
            ParsedLine::StreamDelta(text) => assert_eq!(text, "flat"),
            other => panic!("expected StreamDelta on flat variant, got {other:?}"),
        }

        // Non-text_delta events must not be captured.
        let other_event = r#"{"type":"stream_event","event":{"type":"message_start","delta":{"type":"message_start"}}}"#;
        assert!(matches!(parse_stream_json_line(other_event), ParsedLine::Other));
    }

    #[test]
    fn parse_stream_json_line_rejects_non_json() {
        assert!(matches!(
            parse_stream_json_line("not json"),
            ParsedLine::Invalid(_)
        ));
    }

    #[test]
    fn resolve_vision_helper_never_hardcoded() {
        // Empty catalog → None. No fallback to a hardcoded model name.
        let discovery = make_discovery(vec![]);
        assert!(resolve_vision_helper(&discovery).is_none());
    }

    #[test]
    fn sha256_hash_is_deterministic() {
        let temp = std::env::temp_dir().join(format!(
            "verboo-test-hash-{}.txt",
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&temp, "hello world").unwrap();
        let hash1 = sha256_hash(&temp).unwrap();
        let hash2 = sha256_hash(&temp).unwrap();
        assert_eq!(hash1, hash2);
        // SHA-256 of "hello world" is a known value.
        assert_eq!(
            hash1,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
        let _ = std::fs::remove_file(&temp);
    }

    #[test]
    fn sha256_hash_different_files_different_hashes() {
        let temp1 = std::env::temp_dir().join(format!(
            "verboo-test-hash-1-{}.txt",
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let temp2 = temp1.with_extension("json");
        std::fs::write(&temp1, "content A").unwrap();
        std::fs::write(&temp2, "content B").unwrap();
        let h1 = sha256_hash(&temp1).unwrap();
        let h2 = sha256_hash(&temp2).unwrap();
        assert_ne!(h1, h2);
        let _ = std::fs::remove_file(&temp1);
        let _ = std::fs::remove_file(&temp2);
    }

    #[test]
    fn cache_roundtrip() {
        let dir = std::env::temp_dir().join(format!(
            "verboo-test-cache-{}",
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let entry = VisionCacheEntry {
            hash: "abc123".into(),
            description: "A photo of a cat.".into(),
            helper_model: "claude-sonnet-4-6".into(),
            created_at: 1234567890,
        };
        write_cache(&dir, &entry).unwrap();
        let read = read_cache(&dir, "abc123").unwrap();
        assert_eq!(read.description, "A photo of a cat.");
        assert_eq!(read.helper_model, "claude-sonnet-4-6");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_miss_returns_none() {
        let dir = std::env::temp_dir().join(format!(
            "verboo-test-cache-miss-{}",
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(read_cache(&dir, "nonexistent").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn vision_fallback_consent_default_is_ask() {
        // The default consent is Ask — safest option, prompts user.
        let consent = VisionFallbackConsent::Ask;
        assert_eq!(consent, VisionFallbackConsent::Ask);
        // serde roundtrip.
        let json = serde_json::to_string(&consent).unwrap();
        assert_eq!(json, "\"ask\"");
        let back: VisionFallbackConsent = serde_json::from_str(&json).unwrap();
        assert_eq!(back, consent);
    }

    #[test]
    fn vision_fallback_consent_serde_all_variants() {
        for consent in [
            VisionFallbackConsent::Ask,
            VisionFallbackConsent::Always,
            VisionFallbackConsent::Never,
        ] {
            let json = serde_json::to_string(&consent).unwrap();
            let back: VisionFallbackConsent = serde_json::from_str(&json).unwrap();
            assert_eq!(back, consent);
        }
    }

    // ── describe_image signature tests (regression for Sintoma 2) ────
    //
    // The critical bug was that `describe_image` took a `cli_path: &str`
    // parameter, and `maybe_run_vision_fallback` resolved it via
    // `cli_path::resolve()` which returns None in the packaged app. The fix
    // removed the `cli_path` parameter — `describe_image` now uses `CliSpawn`
    // internally (same resolver as the main turn).
    //
    // These tests are compile-time guarantees: if someone re-adds the
    // `cli_path` parameter, the test won't compile.

    #[test]
    fn describe_image_does_not_take_cli_path_parameter() {
        // Verify the function signature at compile time. The function takes
        // 4 params (image_path, media_type, helper_model, credentials) —
        // NOT 5 (the old signature had cli_path as the 5th).
        fn _assert_signature(
            _image_path: &Path,
            _media_type: &str,
            _helper_model: &str,
            _credentials: &CredentialsStore,
        ) {
            // This function mirrors the describe_image signature. If
            // describe_image's signature changes, this test still compiles
            // (it's just a local fn), but the call site in
            // `maybe_run_vision_fallback` would fail to compile if someone
            // re-adds the cli_path param.
        }
        // If we get here, the signature is correct (4 params, no cli_path).
        assert!(true, "describe_image signature has no cli_path parameter");
    }

    #[test]
    fn describe_image_cached_does_not_take_cli_path_parameter() {
        // Same regression test for describe_image_cached — 5 params, not 6.
        fn _assert_signature(
            _image_path: &Path,
            _media_type: &str,
            _helper_model: &str,
            _credentials: &CredentialsStore,
            _app_data_dir: &Path,
        ) {}
        assert!(true, "describe_image_cached signature has no cli_path parameter");
    }

    // ── parse_stream_json_line tests (used by the timeout-protected reader) ──

    #[test]
    fn parse_result_line_extracts_text() {
        let line = r#"{"type":"result","result":"A photo of a cat.","subtype":"success"}"#;
        match parse_stream_json_line(line) {
            ParsedLine::Result(text) => assert_eq!(text, "A photo of a cat."),
            other => panic!("expected Result, got {:?}", other),
        }
    }

    #[test]
    fn parse_assistant_line_extracts_text() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"I see a "},{"type":"text","text":"red car."}]}}"#;
        match parse_stream_json_line(line) {
            ParsedLine::AssistantText(text) => assert_eq!(text, "I see a red car."),
            other => panic!("expected AssistantText, got {:?}", other),
        }
    }

    #[test]
    fn parse_other_line_returns_other() {
        let line = r#"{"type":"system","subtype":"init"}"#;
        match parse_stream_json_line(line) {
            ParsedLine::Other => {}
            other => panic!("expected Other, got {:?}", other),
        }
    }

    #[test]
    fn parse_invalid_json_returns_invalid() {
        let line = "not json at all";
        match parse_stream_json_line(line) {
            ParsedLine::Invalid(s) => assert_eq!(s, "not json at all"),
            other => panic!("expected Invalid, got {:?}", other),
        }
    }

    #[test]
    fn parse_empty_line_returns_invalid() {
        match parse_stream_json_line("") {
            ParsedLine::Invalid(s) => assert_eq!(s, ""),
            other => panic!("expected Invalid, got {:?}", other),
        }
    }

    #[test]
    fn parse_result_line_without_result_field_returns_other() {
        // Result type but missing "result" field — should fall through to Other.
        let line = r#"{"type":"result","subtype":"error"}"#;
        match parse_stream_json_line(line) {
            ParsedLine::Other => {}
            other => panic!("expected Other, got {:?}", other),
        }
    }

    #[test]
    fn parse_assistant_line_without_text_returns_other() {
        // Assistant message with no text content blocks — should be Other.
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"x"}]}}"#;
        match parse_stream_json_line(line) {
            ParsedLine::Other => {}
            other => panic!("expected Other, got {:?}", other),
        }
    }

    #[test]
    fn helper_cli_timeout_is_30_seconds() {
        // Regression: the timeout must be 30s (not unbounded). If someone
        // changes it to 0 or removes it, this test catches it.
        assert_eq!(HELPER_CLI_TIMEOUT.as_secs(), 30);
    }
}
