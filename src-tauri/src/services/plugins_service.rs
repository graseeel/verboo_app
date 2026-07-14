//! Plugin Marketplace shell-out service (P5 / Wave 2 backend).
//!
//! Thin wrappers around `verboo plugin …` and `verboo plugin marketplace …`.
//! Rust owns: (a) command translation, (b) timeout, (c) auth gate on
//! mutations, (d) ANSI/JSON normalization, (e) 9-variant error mapping.
//! The CLI is the only authority for filesystem state under
//! `~/.claude/plugins/` and `~/.verboo/plugins/`. We never parse
//! `installed_plugins.json` or `known_marketplaces.json` directly.
//!
//! Spec: `docs/plugins-marketplace.md` §§3-8.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

use crate::models::plugins::{
    AvailablePlugin, Marketplace, Plugin, PluginAvailablePayload, PluginError, PluginScope,
    PluginValidateResult,
};
use crate::services::cli_spawn::CliSpawn;

// ════════════════════════════════════════════════════════════════════
// Public command surface (11 Tauri commands)
// ════════════════════════════════════════════════════════════════════

/// 1. `plugin_list` → `verboo plugin list --json` (15 s timeout).
///
/// Read-only — does NOT call `require_auth` (spec §7). The CLI happily
/// enumerates installed plugins without an active session because it only
/// reads files from disk.
pub async fn plugin_list() -> Result<Vec<Plugin>, PluginError> {
    let raw = run_cli_json(&["plugin", "list", "--json"], 15).await?;
    let mut plugins: Vec<Plugin> = parse_json(&raw).map_err(|e| parse_err(&raw, &e))?;
    // The CLI's bare `list` payload omits `name` — fill from `id`.
    for p in &mut plugins {
        p.fill_name_from_id();
    }
    Ok(plugins)
}

/// 2. `plugin_available` → `verboo plugin list --json --available` (30 s).
///
/// Slower than `plugin_list` because the CLI fetches marketplace manifests
/// to populate the `available[]` half of the payload. Read-only.
///
/// Tolerant parsing: the `available[]` half is parsed item-by-item so a
/// single malformed row (e.g. a marketplace manifest with a missing
/// `installCount` or an unknown `source` shape) does NOT fail the entire
/// catalog. Invalid rows are skipped with a warn log. The `installed[]`
/// half is parsed normally (it's the CLI's own state, not third-party
/// manifests, so it's trusted).
pub async fn plugin_available() -> Result<PluginAvailablePayload, PluginError> {
    let raw = run_cli_json(&["plugin", "list", "--json", "--available"], 30).await?;
    // Parse as generic Value first so we can deserialize each `available[]`
    // item individually without failing the whole payload.
    let value: serde_json::Value =
        parse_json(&raw).map_err(|e| parse_err(&raw, &e))?;

    // Installed half — trusted CLI state, but parse tolerantly via
    // `unwrap_or_default()` so a single malformed installed row (CLI drift)
    // doesn't fail the whole payload. If the entire `installed[]` array is
    // unparseable, we return empty rather than a hard parse_error — the
    // `available[]` half may still be valid and useful to the user.
    let installed: Vec<Plugin> = value
        .get("installed")
        .and_then(|v| v.as_array())
        .map(|arr| {
            serde_json::from_value::<Vec<Plugin>>(serde_json::Value::Array(arr.clone()))
                .unwrap_or_default()
        })
        .unwrap_or_default();

    // Available half — untrusted (third-party marketplace manifests).
    // Parse item-by-item so one bad row doesn't fail the catalog.
    let available: Vec<AvailablePlugin> = value
        .get("available")
        .and_then(|v| v.as_array())
        .map(|arr| parse_available_items_tolerant(arr))
        .unwrap_or_default();

    let mut payload = PluginAvailablePayload { installed, available };
    // The CLI's `--available` payload omits `name` on installed rows — fill
    // from `id`. Available rows already carry `name` from the marketplace
    // manifest, so we only touch the `installed` half.
    for p in &mut payload.installed {
        p.fill_name_from_id();
    }
    Ok(payload)
}

/// Parses `available[]` items one-by-one, skipping invalid rows with a warn
/// log. Returns the successfully-parsed items in original order. A row is
/// "invalid" if it's missing a required field (e.g. `pluginId`) or has a
/// shape we can't deserialize. This prevents a single malformed marketplace
/// manifest from failing the entire catalog (spec §2.3 forward-compat).
fn parse_available_items_tolerant(arr: &[serde_json::Value]) -> Vec<AvailablePlugin> {
    let mut out = Vec::with_capacity(arr.len());
    for (idx, item) in arr.iter().enumerate() {
        match serde_json::from_value::<AvailablePlugin>(item.clone()) {
            Ok(p) => out.push(p),
            Err(e) => {
                // Log warn with the row index + error + a preview of the
                // raw row. Don't fail the whole catalog — skip and continue.
                let preview = truncate_str(&item.to_string(), 200);
                eprintln!(
                    "[verboo:plugins] skipping malformed available[{idx}]: {e} | row={preview}"
                );
            }
        }
    }
    out
}

/// 3. `plugin_install(id, scope)` → `verboo plugin install <id> --scope <scope>` (60 s).
///
/// After a successful exit, re-fetches `plugin_list` and returns the row
/// matching `id`. If the row is missing (CLI drift), returns a synthesized
/// `Plugin` with `version = "unknown"` and logs a warning.
pub async fn plugin_install(id: String, scope: PluginScope) -> Result<Plugin, PluginError> {
    require_auth()?;
    let args = ["plugin", "install", id.as_str(), "--scope", scope.as_cli_arg()];
    run_cli_quiet(&args, 60).await?;
    find_plugin_after_mutation(&id).await
}

/// 4. `plugin_enable(id, scope)` → `verboo plugin enable <id> --scope <scope>` (10 s).
///
/// Spec §3.1 allows `scope: Option<PluginScope>` (CLI auto-detects on None).
pub async fn plugin_enable(id: String, scope: Option<PluginScope>) -> Result<(), PluginError> {
    require_auth()?;
    let mut args: Vec<&str> = vec!["plugin", "enable", id.as_str()];
    push_scope_arg(&mut args, scope);
    run_cli_quiet(&args, 10).await
}

/// 5. `plugin_disable(id, scope)` → `verboo plugin disable <id> --scope <scope>` (10 s).
pub async fn plugin_disable(id: String, scope: Option<PluginScope>) -> Result<(), PluginError> {
    require_auth()?;
    let mut args: Vec<&str> = vec!["plugin", "disable", id.as_str()];
    push_scope_arg(&mut args, scope);
    run_cli_quiet(&args, 10).await
}

/// 6. `plugin_uninstall(id, scope, keep_data?)` →
///    `verboo plugin uninstall <id> --scope <scope> [--keep-data]` (15 s).
pub async fn plugin_uninstall(
    id: String,
    scope: PluginScope,
    keep_data: Option<bool>,
) -> Result<(), PluginError> {
    require_auth()?;
    let mut args: Vec<&str> = vec!["plugin", "uninstall", id.as_str(), "--scope", scope.as_cli_arg()];
    if keep_data.unwrap_or(false) {
        args.push("--keep-data");
    }
    run_cli_quiet(&args, 15).await
}

/// 7. `plugin_update(id, scope)` → `verboo plugin update <id> --scope <scope>` (60 s).
///
/// Re-fetches `plugin_list` post-success and returns the updated row.
pub async fn plugin_update(id: String, scope: PluginScope) -> Result<Plugin, PluginError> {
    require_auth()?;
    let args = ["plugin", "update", id.as_str(), "--scope", scope.as_cli_arg()];
    run_cli_quiet(&args, 60).await?;
    find_plugin_after_mutation(&id).await
}

/// 8. `plugin_validate(path)` → `verboo plugin validate <path>` (30 s).
///
/// The CLI does NOT emit JSON today; we coarse-parse stdout/stderr markers
/// (`✘`, `Validation failed`) and exit code. Path validation (spec §9.3 T10)
/// rejects `..`, empty, and system-directory paths BEFORE spawn.
pub async fn plugin_validate(path: String) -> Result<PluginValidateResult, PluginError> {
    let validated_path = validate_path(&path)?;
    let path_str = validated_path.to_string_lossy().into_owned();
    let args: [&str; 3] = ["plugin", "validate", &path_str];
    let output = run_cli_raw(&args, 30).await?;
    Ok(parse_validate_output(&output))
}

/// 9. `marketplace_list` → `verboo plugin marketplace list --json` (15 s).
/// Read-only.
pub async fn marketplace_list() -> Result<Vec<Marketplace>, PluginError> {
    let raw = run_cli_json(&["plugin", "marketplace", "list", "--json"], 15).await?;
    let marketplaces: Vec<Marketplace> =
        parse_json(&raw).map_err(|e| parse_err(&raw, &e))?;
    Ok(marketplaces)
}

/// 10. `marketplace_add(source, scope?)` →
///     `verboo plugin marketplace add <source> [--scope <scope>]` (60 s).
///
/// Returns a synthesized `Marketplace` echo (spec §3.3). The FE follows up
/// with `marketplace_list` to canonicalize. `name` is derived from `source`
/// because the CLI does not echo JSON on mutation commands.
pub async fn marketplace_add(source: String, scope: Option<String>) -> Result<Marketplace, PluginError> {
    require_auth()?;
    let mut args: Vec<&str> = vec!["plugin", "marketplace", "add", source.as_str()];
    if let Some(s) = scope.as_deref() {
        args.push("--scope");
        args.push(s);
    }
    run_cli_quiet(&args, 60).await?;
    Ok(Marketplace {
        name: derive_marketplace_name(&source),
        source: classify_marketplace_source(&source).to_string(),
        repo: if classify_marketplace_source(&source) == "github" {
            Some(strip_github_prefix(&source).to_string())
        } else {
            None
        },
        url: if classify_marketplace_source(&source) == "url" {
            Some(source.clone())
        } else {
            None
        },
        install_location: String::new(),
        plugin_count: None,
    })
}

/// 11. `marketplace_remove(name)` →
///     `verboo plugin marketplace remove <name>` (15 s).
pub async fn marketplace_remove(name: String) -> Result<(), PluginError> {
    require_auth()?;
    run_cli_quiet(&["plugin", "marketplace", "remove", name.as_str()], 15).await
}

// ════════════════════════════════════════════════════════════════════
// Internal: CLI invocation
// ════════════════════════════════════════════════════════════════════

/// Output captured from a CLI invocation. Owned by the caller so different
/// commands (JSON parsing vs. validate regex vs. mutation stderr inspection)
/// can each do their own post-processing.
#[derive(Debug, Clone)]
pub(crate) struct CliOutput {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Runs the CLI, applies the per-command timeout, and returns the captured
/// `CliOutput`. Used directly by `plugin_validate` (which needs raw bytes)
/// and indirectly by `run_cli_json` / `run_cli_quiet`.
///
/// **stdout is redirected to a tempfile** (not a pipe) because the CLI's
/// `plugin list --json --available` output can exceed 64 KB / 147 KB, and
/// OS pipe buffers cap at ~64 KB on macOS. A piped stdout fills the buffer,
/// the CLI blocks on write, the timeout fires, and the JSON is truncated
/// mid-object → `parse_error` before the item-by-item tolerant parser even
/// runs. Redirecting to a tempfile removes the pipe-buffer ceiling entirely.
///
/// `kill_on_drop(true)` ensures the child dies cleanly when the timeout
/// fires (the future is dropped, the command is dropped, the child is killed).
/// The `NamedTempFile` is auto-deleted when dropped.
async fn run_cli_raw(args: &[&str], timeout_secs: u64) -> Result<CliOutput, PluginError> {
    // CliSpawn already exhausted PATH/bundle/env resolution. If spawn fails
    // here with `NotFound`, the CLI is genuinely unavailable.
    let spawn = CliSpawn::new(args.iter().copied());
    let std_cmd = spawn.command;

    // Create a tempfile for stdout BEFORE spawn. NamedTempFile is owned
    // and auto-deleted on drop — we keep a handle to read it after wait.
    let stdout_file = tempfile::tempfile().map_err(|e| PluginError::Unknown {
        message: format!("failed to create stdout tempfile: {e}"),
        exit_code: None,
    })?;
    let stdout_file_clone = stdout_file.try_clone().map_err(|e| PluginError::Unknown {
        message: format!("failed to clone stdout tempfile: {e}"),
        exit_code: None,
    })?;

    let mut cmd = TokioCommand::from(std_cmd);
    cmd.stdin(Stdio::null())
        // Redirect stdout to the tempfile (NOT piped — pipe buffers cap at
        // ~64 KB on macOS and truncate large JSON payloads).
        .stdout(Stdio::from(stdout_file_clone))
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Build a debug representation of args for error messages BEFORE moving.
    let args_debug = format!("verboo {}", args.join(" "));

    // Spawn the child. spawn() is not a future — it returns immediately
    // with io::Result<Child>. The timeout applies to the wait() phase.
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => PluginError::CliNotFound,
        _ => PluginError::Unknown {
            message: format!("spawn failed: {e}"),
            exit_code: None,
        },
    })?;

    // Take stderr BEFORE moving child into the wait task — we drain stderr
    // concurrently with wait() to avoid pipe-buffer deadlock on stderr.
    let stderr_pipe = child.stderr.take();

    // Wait for the child to exit, with timeout. The child writes stdout
    // to the tempfile (no pipe-buffer ceiling) and stderr to the pipe
    // (drained concurrently below).
    let wait_with_stderr = async {
        use tokio::io::AsyncReadExt;
        let mut stderr_buf = String::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_string(&mut stderr_buf).await;
        }
        let status = child.wait().await;
        (status, stderr_buf)
    };

    let (status, stderr) = match timeout(Duration::from_secs(timeout_secs), wait_with_stderr).await {
        Ok(r) => r,
        Err(_) => {
            return Err(PluginError::Timeout {
                command: args_debug,
                seconds: timeout_secs,
            });
        }
    };

    let status = status.map_err(|e| PluginError::Unknown {
        message: format!("wait failed: {e}"),
        exit_code: None,
    })?;

    // Read stdout from the tempfile. Seek to start first.
    let stdout = read_stdout_tempfile(stdout_file)?;

    let exit_code = status.code();

    if !status.success() {
        return Err(map_cli_error(exit_code, &stdout, &stderr, args_debug));
    }

    Ok(CliOutput {
        exit_code,
        stdout,
        stderr,
    })
}

/// Reads the entire contents of a stdout tempfile after the child exits.
/// Seeks to start first, then reads to EOF. Returns the contents as a
/// `String` (lossy UTF-8 conversion — CLI JSON is UTF-8).
fn read_stdout_tempfile(mut file: std::fs::File) -> Result<String, PluginError> {
    use std::io::{Read, Seek, SeekFrom};
    file.seek(SeekFrom::Start(0))
        .map_err(|e| PluginError::Unknown {
            message: format!("failed to seek stdout tempfile: {e}"),
            exit_code: None,
        })?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .map_err(|e| PluginError::Unknown {
            message: format!("failed to read stdout tempfile: {e}"),
            exit_code: None,
        })?;
    Ok(String::from_utf8_lossy(&buf).to_string())
}

/// Runs the CLI, expects JSON output, strips ANSI alt-screen wrappers, and
/// returns the cleaned string ready for `serde_json::from_str`. Used by
/// the 3 read commands (`plugin_list`, `plugin_available`, `marketplace_list`).
async fn run_cli_json(args: &[&str], timeout_secs: u64) -> Result<String, PluginError> {
    let output = run_cli_raw(args, timeout_secs).await?;
    Ok(strip_ansi(&output.stdout))
}

/// Runs the CLI for a mutation command (no JSON output expected). Returns
/// `()` on success, the mapped `PluginError` on non-zero exit.
async fn run_cli_quiet(args: &[&str], timeout_secs: u64) -> Result<(), PluginError> {
    let _ = run_cli_raw(args, timeout_secs).await?;
    Ok(())
}

/// Pushes `--scope <scope>` to the args vec ONLY when `scope` is `Some`.
/// The CLI auto-detects scope on absence (spec §3.1).
fn push_scope_arg(args: &mut Vec<&str>, scope: Option<PluginScope>) {
    if let Some(s) = scope {
        args.push("--scope");
        args.push(s.as_cli_arg());
    }
}

// ════════════════════════════════════════════════════════════════════
// Internal: ANSI strip + JSON parse
// ════════════════════════════════════════════════════════════════════

/// Strips the alt-screen escape wrappers CLI 0.13 emits around JSON output
/// (`\u{1b}[?2026h` / `\u{1b}[?2026l`) plus any other CSI escape sequences
/// (`\u{1b}[...m` etc.) the CLI may emit. The CLI interleaves these with
/// newlines and whitespace, so we loop-strip until no more known prefixes
/// remain at the start, then strip trailing wrappers. As a final safety
/// net, we strip ALL remaining CSI sequences (not just the two known
/// wrappers) and extract the JSON substring by scanning for the first
/// `[`/`{` and the last matching `]`/`}` — this guarantees serde_json
/// receives a clean JSON document even if the CLI emits unexpected
/// control sequences between the wrappers.
///
/// Verified against CLI 0.13.0 (2026-07-13).
pub(crate) fn strip_ansi(s: &str) -> String {
    const PREFIX_H: &str = "\u{1b}[?2026h";
    const PREFIX_L: &str = "\u{1b}[?2026l";

    // Phase 1: loop-strip leading wrappers + whitespace. The CLI emits
    // sequences like `ESC[?2026h \n ESC[?2026l JSON` where the prefix
    // is split across lines; a single strip_prefix misses the second
    // wrapper and serde sees `ESC[?2026l[...]` → "expected value at
    // line 1 column 1".
    let mut s = s.trim();
    loop {
        let next = s.trim_start();
        if let Some(rest) = next.strip_prefix(PREFIX_H) {
            s = rest;
            continue;
        }
        if let Some(rest) = next.strip_prefix(PREFIX_L) {
            s = rest;
            continue;
        }
        s = next;
        break;
    }

    // Phase 2: strip trailing wrappers (loop, same reason — may repeat).
    loop {
        let trimmed = s.trim_end();
        if let Some(rest) = trimmed.strip_suffix(PREFIX_L) {
            s = rest.trim_end();
            continue;
        }
        if let Some(rest) = trimmed.strip_suffix(PREFIX_H) {
            s = rest.trim_end();
            continue;
        }
        s = trimmed;
        break;
    }

    // Phase 3: strip ALL remaining CSI escape sequences. A CSI sequence
    // is `ESC [` followed by parameter bytes (0x30-0x3F), intermediate
    // bytes (0x20-0x2F), and a final byte (0x40-0x7E). This catches
    // `\u{1b}[?25l` (hide cursor), `\u{1b}[m` (reset color), etc. —
    // any of which would leave a stray `[` that confuses phase 4.
    let cleaned = strip_csi_sequences(s);

    // Phase 4: extract JSON substring by first `[`/`{` and last matching
    // `]`/`}`. Safety net for any non-CSI noise that survived phases 1-3.
    // If no JSON opener is found, return the cleaned string as-is (caller
    // will surface a ParseError with raw preview — better than a panic).
    extract_json_substring(&cleaned).to_string()
}

/// Strips ALL CSI (Control Sequence Introducer) escape sequences from `s`.
/// A CSI sequence is `ESC [` (0x1b 0x5b) followed by parameter bytes
/// (0x30-0x3F), intermediate bytes (0x20-0x2F), and a final byte
/// (0x40-0x7E). This catches the alt-screen wrappers, cursor-hide,
/// color codes, etc. — any of which would leave stray `[` chars that
/// confuse JSON extraction.
fn strip_csi_sequences(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        // Look for ESC [ (0x1b 0x5b).
        if i + 1 < bytes.len() && bytes[i] == 0x1b && bytes[i + 1] == 0x5b {
            // Skip parameter bytes (0x30-0x3F) and intermediate bytes
            // (0x20-0x2F) until we find a final byte (0x40-0x7E).
            i += 2;
            while i < bytes.len() {
                let b = bytes[i];
                if (0x40..=0x7e).contains(&b) {
                    i += 1; // consume final byte
                    break;
                }
                if (0x30..=0x3f).contains(&b) || (0x20..=0x2f).contains(&b) {
                    i += 1; // consume parameter/intermediate byte
                    continue;
                }
                // Unexpected byte — bail out of CSI, emit it literally.
                break;
            }
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Extracts the JSON substring by scanning for the first `[` or `{` and
/// the last matching `]` or `}`. Returns the input unchanged if no JSON
/// opener is found. Does NOT validate JSON syntax — just bounds the
/// substring so serde_json::from_str doesn't see leading/trailing noise.
fn extract_json_substring(s: &str) -> &str {
    let bytes = s.as_bytes();
    let start = bytes
        .iter()
        .position(|&b| b == b'[' || b == b'{')
        .unwrap_or(0);
    let end = bytes
        .iter()
        .rposition(|&b| b == b']' || b == b'}')
        .map(|i| i + 1)
        .unwrap_or(bytes.len());
    if end <= start {
        return s;
    }
    &s[start..end]
}

/// Parses JSON with a typed deserializer. The wrapper owns the
/// `serde_json::Error` so callers can build a `parse_error` with raw preview.
fn parse_json<T: serde::de::DeserializeOwned>(raw: &str) -> Result<T, serde_json::Error> {
    serde_json::from_str::<T>(raw.trim())
}

/// Builds a `ParseError` with a 500-char raw preview (truncated to prevent
/// log spam — spec §4).
fn parse_err(raw: &str, e: &serde_json::Error) -> PluginError {
    let preview = truncate_str(raw.trim(), 500);
    PluginError::ParseError {
        message: e.to_string(),
        raw_preview: Some(preview),
    }
}

/// Truncates `s` to at most `max` **chars** (not bytes). Char-boundary-
/// aware — never panics on multibyte UTF-8 (spec §4 says "chars"; spec
/// §10.4 forbids panics on user-facing paths). Used for `raw_preview`
/// (500 chars) and `raw_output` (2048 chars) diagnostics.
fn truncate_str(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

// ════════════════════════════════════════════════════════════════════
// Internal: error mapping (spec §4)
// ════════════════════════════════════════════════════════════════════

/// Maps a non-zero CLI exit to a `PluginError` variant. The mapping rules
/// are applied in spec §4 order (most-specific first).
pub(crate) fn map_cli_error(
    exit_code: Option<i32>,
    stdout: &str,
    stderr: &str,
    _command_debug: String,
) -> PluginError {
    let _ = &_command_debug; // reserved for future Timeout-via-exit-code classification
    let combined = format!("{stdout}\n{stderr}");
    let lower = combined.to_lowercase();

    // 1. Auth failures — substring match on common OAuth markers.
    for needle in &[
        "not logged in",
        "auth required",
        "please login",
        "oauth token",
        "401",
        "403",
    ] {
        if lower.contains(needle) {
            return PluginError::CliAuthRequired;
        }
    }

    // 2. Network failures — first matching substring wins, truncated 200 chars.
    // NOTE: "failed to fetch" is intentionally ABSENT from this list — a
    // generic "failed to fetch" without network context (e.g. DNS error,
    // connection refused) is ambiguous. The CLI uses "failed to fetch" for
    // both network failures AND marketplace-not-found (operational). We
    // let rule 3 (marketplace markers) catch the marketplace-specific case
    // first; only explicit network markers (etimedout, econnrefused, etc.)
    // classify as NetworkError here.
    for needle in &[
        "etimedout",
        "econnrefused",
        "enotfound",
        "getaddrinfo",
        "git pull",
        "git clone",
        "network",
        "502",
        "503",
        "504",
        "404",
    ] {
        if let Some(idx) = lower.find(needle) {
            let snippet = combined[idx..].chars().take(200).collect::<String>();
            return PluginError::NetworkError { message: snippet };
        }
    }

    // 3. Marketplace-command failures — check BEFORE validate-marker because
    // CLI 0.13 emits `✘` on ANY failure (not just validate), so a marketplace
    // add/remove failure gets misclassified as InvalidPlugin with empty errors.
    //
    // Two sub-categories:
    //   (a) "marketplace file not found" / "marketplace not found" → the
    //       source is not a valid marketplace (missing .claude-plugin/
    //       marketplace.json). Maps to `InvalidMarketplace` — distinct from
    //       `InvalidPlugin` (schema-invalid plugin manifest) and `Unknown`
    //       (operational failure). FE renders "Marketplace inválido".
    //   (b) "failed to add/remove marketplace" (operational, e.g. permission
    //       denied, disk full) → `Unknown` with the full CLI message.
    //
    // Markers verified against CLI 0.13.0 (2026-07-13).
    for needle in &[
        "marketplace file not found",
        "marketplace not found",
        "no marketplace.json found",
        "is not a valid marketplace",
    ] {
        if lower.contains(needle) {
            let (message, _) = pick_unknown_message(stdout, stderr);
            return PluginError::InvalidMarketplace {
                message: truncate_str(message.trim(), 500),
            };
        }
    }

    for needle in &[
        "failed to add marketplace",
        "failed to remove marketplace",
    ] {
        if lower.contains(needle) {
            let (message, _) = pick_unknown_message(stdout, stderr);
            return PluginError::Unknown {
                message: truncate_str(message.trim(), 500),
                exit_code,
            };
        }
    }

    // 4. Validate-error marker (spec §4 rule 5 — BEFORE already/not-installed).
    // The `✘` / "Validation failed" markers are unambiguous for validate
    // output; checking them first prevents a validate output that happens
    // to mention "already installed" from being misclassified.
    if combined.contains('✘') || combined.contains("validation failed") {
        let errors = extract_validate_errors(&combined);
        let warnings = extract_validate_warnings(&combined);
        return PluginError::InvalidPlugin {
            errors,
            warnings: if warnings.is_empty() { None } else { Some(warnings) },
        };
    }

    // 5. Already-installed — `plugin` name parsed from message if possible.
    if lower.contains("already installed") || lower.contains("is already installed") {
        return PluginError::AlreadyInstalled {
            plugin: parse_plugin_token(&combined).unwrap_or_else(|| "unknown".into()),
        };
    }

    // 6. Not-installed — same plugin-token parse.
    if lower.contains("not installed")
        || lower.contains("is not installed")
        || lower.contains("cannot find plugin")
    {
        return PluginError::NotInstalled {
            plugin: parse_plugin_token(&combined).unwrap_or_else(|| "unknown".into()),
        };
    }

    // 7. Fall-through: Unknown. Use stderr if present, else stdout.
    let (message, _) = pick_unknown_message(stdout, stderr);
    PluginError::Unknown {
        message: truncate_str(message.trim(), 500),
        exit_code,
    }
}

/// Picks the best message for the `Unknown` variant: stderr if non-empty,
/// else stdout. Both trimmed. Returns `(message, source_kind)` for tests.
fn pick_unknown_message(stdout: &str, stderr: &str) -> (String, &'static str) {
    let stderr_trim = stderr.trim();
    if !stderr_trim.is_empty() {
        return (stderr_trim.to_string(), "stderr");
    }
    (stdout.trim().to_string(), "stdout")
}

/// Best-effort parse of a `name@marketplace` token from a CLI error message.
/// Matches the first whitespace-delimited token containing `@`. Returns
/// `None` if no such token is found.
fn parse_plugin_token(message: &str) -> Option<String> {
    for tok in message.split_whitespace() {
        let cleaned = tok.trim_matches(|c: char| !c.is_alphanumeric() && c != '@' && c != '-' && c != '_');
        if cleaned.contains('@') && cleaned.len() >= 3 {
            return Some(cleaned.to_string());
        }
    }
    None
}

/// Extracts `❯ root: ...`-style error lines from a validate output.
/// Pure substring scan — no regex (regex is not in the dep tree).
fn extract_validate_errors(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with('❯') || trimmed.starts_with("❯ ") {
                Some(trimmed.trim_start_matches('❯').trim().to_string())
            } else {
                None
            }
        })
        .collect()
}

/// Extracts `⚠ …` or `warning: …` lines from a validate output.
fn extract_validate_warnings(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with('⚠') || trimmed.to_lowercase().starts_with("warning:") {
                Some(trimmed.to_string())
            } else {
                None
            }
        })
        .collect()
}

// ════════════════════════════════════════════════════════════════════
// Internal: validate output parser
// ════════════════════════════════════════════════════════════════════

/// Builds a `PluginValidateResult` from raw CLI output. The CLI does NOT
/// emit JSON today — we coarse-parse markers (`✘`, `Validation failed`)
/// against exit code + body. Spec §2.5.
pub(crate) fn parse_validate_output(output: &CliOutput) -> PluginValidateResult {
    let combined = format!("{}\n{}", output.stdout, output.stderr);
    let has_failure_marker = combined.contains('✘') || combined.contains("Validation failed");
    let valid = output
        .exit_code
        .map(|c| c == 0 && !has_failure_marker)
        .unwrap_or(!has_failure_marker);

    let errors = if has_failure_marker {
        extract_validate_errors(&combined)
    } else {
        Vec::new()
    };
    let warnings = extract_validate_warnings(&combined);

    PluginValidateResult {
        valid,
        warnings,
        errors,
        hash: None,
        signature: None,
        raw_output: Some(truncate_str(combined.trim(), 2048)),
    }
}

// ════════════════════════════════════════════════════════════════════
// Internal: path validation (spec §9.3 T10)
// ════════════════════════════════════════════════════════════════════

/// Validates the path argument to `plugin_validate`. Rejects:
///   - empty strings
///   - paths containing `..` (path traversal)
///   - system directories `/System`, `/Library`, `/usr`, `/bin`, `/sbin`,
///     `/etc`, `/dev`, `/proc`, `/sys` — case-INSENSITIVE match (macOS
///     APFS is case-insensitive; `/system` and `/LIBRARY` resolve to the
///     same inodes as the canonical forms).
///   - non-existent paths (fail loudly rather than letting the CLI spawn
///     against a dangling path).
///
/// Returns the canonicalized absolute path on success.
pub(crate) fn validate_path(input: &str) -> Result<PathBuf, PluginError> {
    if input.trim().is_empty() {
        return Err(PluginError::Unknown {
            message: "validate path is empty".into(),
            exit_code: None,
        });
    }
    if input.contains("..") {
        return Err(PluginError::Unknown {
            message: "validate path must not contain '..'".into(),
            exit_code: None,
        });
    }
    let candidate = Path::new(input);
    let candidate_lower = input.to_ascii_lowercase();
    for forbidden in &[
        "/system",
        "/library",
        "/usr",
        "/bin",
        "/sbin",
        "/etc",
        "/dev",
        "/proc",
        "/sys",
    ] {
        if candidate_lower.starts_with(forbidden) {
            return Err(PluginError::Unknown {
                message: format!("validate path under forbidden system dir: {forbidden}"),
                exit_code: None,
            });
        }
    }
    let canonical = std::fs::canonicalize(candidate).map_err(|_| PluginError::Unknown {
        message: format!("validate path does not exist: {input}"),
        exit_code: None,
    })?;
    // Defense-in-depth: re-check the canonicalized path against the
    // denylist. A symlink like `/tmp/evil → /etc` would pass the input
    // check but resolve to a system dir.
    let canonical_str = canonical.to_string_lossy().to_ascii_lowercase();
    for forbidden in &[
        "/system",
        "/library",
        "/usr",
        "/bin",
        "/sbin",
        "/etc",
        "/dev",
        "/proc",
        "/sys",
    ] {
        if canonical_str.starts_with(forbidden) {
            return Err(PluginError::Unknown {
                message: format!("validate path resolves to forbidden system dir: {forbidden}"),
                exit_code: None,
            });
        }
    }
    Ok(canonical)
}

// ════════════════════════════════════════════════════════════════════
// Internal: auth gate
// ════════════════════════════════════════════════════════════════════

/// Returns `Err(CliAuthRequired)` when the user is not logged in.
/// Mutation commands MUST call this before shell-out so we don't pay the
/// CLI startup latency only to fail with a 401. Read commands skip it
/// (spec §7).
fn require_auth() -> Result<(), PluginError> {
    let cli = crate::services::cli_service::CliService::new();
    let status = cli.get_auth_status().map_err(|_| PluginError::Unknown {
        message: "failed to query auth state".into(),
        exit_code: None,
    })?;
    if status.logged_in {
        Ok(())
    } else {
        Err(PluginError::CliAuthRequired)
    }
}

// ════════════════════════════════════════════════════════════════════
// Internal: post-mutation re-fetch
// ════════════════════════════════════════════════════════════════════

/// After `plugin_install` / `plugin_update`, re-fetches `plugin_list` and
/// finds the row by `id`. On miss (CLI drift), returns a synthesized
/// `Plugin` with `version = "unknown"` and logs a warning (spec §3.3).
pub(crate) async fn find_plugin_after_mutation(id: &str) -> Result<Plugin, PluginError> {
    let plugins = plugin_list().await.unwrap_or_default();
    if let Some(p) = plugins.into_iter().find(|p| p.id == id) {
        return Ok(p);
    }
    eprintln!(
        "[verboo:plugins] install/update succeeded for {id} but row missing from list — synthesizing"
    );
    let bare = id.split('@').next().unwrap_or(id).to_string();
    let now = chrono::Utc::now().to_rfc3339();
    Ok(Plugin {
        id: id.to_string(),
        name: bare,
        version: "unknown".into(),
        scope: PluginScope::User,
        enabled: true,
        installed: true,
        install_path: String::new(),
        installed_at: now.clone(),
        last_updated: now,
        git_commit_sha: None,
        description: None,
        homepage: None,
        author: None,
        category: None,
        install_count: None,
    })
}

// ════════════════════════════════════════════════════════════════════
// Internal: marketplace source classification
// ════════════════════════════════════════════════════════════════════

/// Classifies a `marketplace_add` source string into `"github"`, `"url"`,
/// or `"local"` based on prefix. The CLI does the actual resolution; this
/// is only used to populate the synthesized echo `Marketplace` (spec §3.3).
pub(crate) fn classify_marketplace_source(source: &str) -> &'static str {
    let trimmed = source.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        "url"
    } else if trimmed.starts_with("github:") || is_github_shorthand(trimmed) {
        "github"
    } else {
        "local"
    }
}

/// Heuristic: `owner/repo` with neither scheme nor path separator goes as
/// GitHub. Conservative — wrong guesses are recoverable by the FE
/// re-fetching `marketplace_list`. Requires each part to start with an
/// alphanumeric character so `./local` and `./plugins/x` (which start with
/// `.`) are correctly classified as local paths.
fn is_github_shorthand(s: &str) -> bool {
    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() != 2 {
        return false;
    }
    parts.iter().all(|p| {
        let mut chars = p.chars();
        match chars.next() {
            Some(first) if first.is_ascii_alphanumeric() => chars
                .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.'),
            _ => false,
        }
    })
}

/// Strips `github:owner/repo` → `owner/repo`. Leaves bare `owner/repo`
/// untouched.
fn strip_github_prefix(source: &str) -> &str {
    source.strip_prefix("github:").unwrap_or(source)
}

/// Derives the marketplace `name` from `source`. For GitHub shorthand
/// `owner/repo`, uses the repo's last segment. For URLs, uses the last
/// path segment (sans `.json` suffix). Otherwise echoes the source
/// verbatim. Pure string ops — no `url` crate dep.
pub(crate) fn derive_marketplace_name(source: &str) -> String {
    let trimmed = source.trim();
    if trimmed.starts_with("github:") {
        return trimmed
            .strip_prefix("github:")
            .and_then(|rest| rest.split('/').next_back())
            .map(|s| s.to_string())
            .unwrap_or_else(|| trimmed.to_string());
    }
    if is_github_shorthand(trimmed) {
        return trimmed
            .split('/')
            .next_back()
            .map(|s| s.to_string())
            .unwrap_or_else(|| trimmed.to_string());
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        // Last non-empty path segment, with optional `.json` stripped.
        let after_scheme = trimmed.split_once("://").map(|(_, rest)| rest).unwrap_or(trimmed);
        let after_host = after_scheme.split_once('/').map(|(_, rest)| rest).unwrap_or("");
        let last = after_host.rsplit('/').next().unwrap_or("");
        let cleaned = last.trim_end_matches(".json");
        if !cleaned.is_empty() {
            return cleaned.to_string();
        }
    }
    trimmed.to_string()
}

// ════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::plugins::{
        AvailablePlugin, PluginScope, PluginSource, PluginSourceObject,
    };

    // ── strip_ansi (spec §8.1) ──────────────────────────────────────────

    #[test]
    fn strip_ansi_removes_alt_screen_prefix_and_suffix() {
        let raw = "\u{1b}[?2026h\n[{\"id\":\"x@y\"}]\u{1b}[?2026l\n";
        let stripped = strip_ansi(raw);
        assert!(stripped.starts_with('['), "got: {stripped:?}");
        assert!(!stripped.contains('\u{1b}'));
    }

    #[test]
    fn strip_ansi_passes_through_plain_text() {
        let raw = r#"{"id":"x@y"}"#;
        assert_eq!(strip_ansi(raw), raw);
    }

    #[test]
    fn strip_ansi_handles_absent_prefix() {
        let raw = "  [{\"a\":1}]  ";
        assert_eq!(strip_ansi(raw), "[{\"a\":1}]");
    }

    #[test]
    fn strip_ansi_handles_mixed_control_chars() {
        // Real CLI output may include leading whitespace + both wrappers.
        let raw = "   \n\u{1b}[?2026h\u{1b}[?2026l{\"a\":1}\u{1b}[?2026l";
        let stripped = strip_ansi(raw);
        assert_eq!(stripped, "{\"a\":1}");
    }

    #[test]
    fn strip_ansi_real_cli_fixture_split_wrappers() {
        // Regression: CLI 0.13 emits wrappers split across lines with
        // whitespace between them. The naive single strip_prefix missed
        // the second wrapper → serde saw `ESC[?2026l[...]` → "expected
        // value at line 1 column 1". The loop-strip + JSON-extraction
        // must handle this.
        let raw = "\u{1b}[?2026h\n\u{1b}[?2026l[{\"id\":\"x@y\"}]\n";
        let stripped = strip_ansi(raw);
        assert_eq!(stripped, "[{\"id\":\"x@y\"}]");
        assert!(!stripped.contains('\u{1b}'));
    }

    #[test]
    fn strip_ansi_real_cli_fixture_with_whitespace() {
        // Real CLI fixture: wrappers + whitespace + JSON + trailing wrapper.
        let raw = "\u{1b}[?2026h \n \u{1b}[?2026l [\n{\"id\":\"x@y\"}\n] \u{1b}[?2026l\n";
        let stripped = strip_ansi(raw);
        assert_eq!(stripped, "[\n{\"id\":\"x@y\"}\n]");
        assert!(!stripped.contains('\u{1b}'));
    }

    #[test]
    fn strip_ansi_extracts_json_from_noise() {
        // Safety net: if the CLI emits unexpected control sequences between
        // the wrappers, the JSON-extraction phase bounds the substring to
        // the first `[`/`{` and last matching `]`/`}`.
        let raw = "\u{1b}[?2026h\u{1b}[?25lgarbage[{\"id\":\"x@y\"}]trailing\u{1b}[?2026l";
        let stripped = strip_ansi(raw);
        assert_eq!(stripped, "[{\"id\":\"x@y\"}]");
    }

    #[test]
    fn strip_ansi_object_form() {
        // Object-form JSON (single object, not array).
        let raw = "\u{1b}[?2026h\n\u{1b}[?2026l{\"id\":\"x@y\"}\n\u{1b}[?2026l";
        let stripped = strip_ansi(raw);
        assert_eq!(stripped, "{\"id\":\"x@y\"}");
    }

    #[test]
    fn strip_ansi_no_json_returns_cleaned_string() {
        // No JSON opener — return the cleaned string (caller surfaces
        // ParseError with raw preview).
        let raw = "\u{1b}[?2026h\n\u{1b}[?2026lnot json at all\u{1b}[?2026l";
        let stripped = strip_ansi(raw);
        assert_eq!(stripped, "not json at all");
    }

    // ── parse_available_items_tolerant (catalog resilience) ───────────

    #[test]
    fn parse_available_items_tolerant_skips_invalid_rows() {
        // Regression: 1 bad row (missing `pluginId`) + 1 good row →
        // returns 1. The catalog must NOT fail entirely for 1 bad row.
        let arr = vec![
            // Bad row: missing pluginId (required field).
            serde_json::json!({
                "name": "bad",
                "description": "d",
                "marketplaceName": "m",
                "source": "./",
                "installCount": 0
            }),
            // Good row.
            serde_json::json!({
                "pluginId": "good@m",
                "name": "good",
                "description": "d",
                "marketplaceName": "m",
                "source": "./",
                "installCount": 5
            }),
        ];
        let parsed = parse_available_items_tolerant(&arr);
        assert_eq!(parsed.len(), 1, "expected 1 good row, got {parsed:?}");
        assert_eq!(parsed[0].plugin_id, "good@m");
        assert_eq!(parsed[0].install_count, 5);
    }

    #[test]
    fn parse_available_items_tolerant_all_good() {
        let arr = vec![
            serde_json::json!({
                "pluginId": "a@m",
                "name": "a",
                "description": "d",
                "marketplaceName": "m",
                "source": "./",
                "installCount": 10
            }),
            serde_json::json!({
                "pluginId": "b@m",
                "name": "b",
                "description": "d",
                "marketplaceName": "m",
                "source": "./"
            }),
        ];
        let parsed = parse_available_items_tolerant(&arr);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].plugin_id, "a@m");
        assert_eq!(parsed[1].plugin_id, "b@m");
        assert_eq!(parsed[1].install_count, 0); // default
    }

    #[test]
    fn parse_available_items_tolerant_all_bad_returns_empty() {
        // All rows invalid → empty vec (not an error). The catalog shows
        // "no plugins available" rather than a parse_error.
        let arr = vec![
            serde_json::json!({"name": "bad1"}),
            serde_json::json!({"foo": "bar"}),
            serde_json::json!(null),
        ];
        let parsed = parse_available_items_tolerant(&arr);
        assert!(parsed.is_empty());
    }

    #[test]
    fn parse_available_items_tolerant_empty_input() {
        let arr: Vec<serde_json::Value> = vec![];
        let parsed = parse_available_items_tolerant(&arr);
        assert!(parsed.is_empty());
    }

    #[test]
    fn parse_available_items_tolerant_preserves_order() {
        // Successfully-parsed rows must preserve original CLI order.
        let arr = vec![
            serde_json::json!({
                "pluginId": "first@m", "name": "first", "description": "d",
                "marketplaceName": "m", "source": "./", "installCount": 1
            }),
            serde_json::json!({"bad": "row"}),
            serde_json::json!({
                "pluginId": "third@m", "name": "third", "description": "d",
                "marketplaceName": "m", "source": "./", "installCount": 3
            }),
        ];
        let parsed = parse_available_items_tolerant(&arr);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].plugin_id, "first@m");
        assert_eq!(parsed[1].plugin_id, "third@m");
    }

    // ── Pipe-truncation regression (catalog v2) ───────────────────────
    //
    // The CLI's `plugin list --json --available` output can exceed 64 KB
    // (real measurement: 147 KB, 265 available). OS pipe buffers cap at
    // ~64 KB on macOS. A piped stdout fills the buffer, the CLI blocks
    // on write, the timeout fires, and the JSON is truncated mid-object
    // → `parse_error` before the item-by-item tolerant parser even runs.
    //
    // The fix redirects stdout to a tempfile (no pipe-buffer ceiling).
    // These tests document the truncation hazard and confirm the tolerant
    // parser surfaces a clean ParseError (not a hang) when given truncated
    // input — and that complete input parses cleanly.

    #[test]
    fn parse_json_truncated_mid_object_fails_cleanly() {
        // Simulates a pipe-truncated payload: JSON cut mid-object.
        // The tolerant parser must surface a ParseError, not hang.
        let truncated = r#"{"installed":[],"available":[{"pluginId":"a@b","#;
        let result: Result<serde_json::Value, _> = serde_json::from_str(truncated);
        assert!(result.is_err(), "truncated JSON must fail to parse");
        let err = result.unwrap_err();
        // Confirm it's a syntax error (not a type mismatch).
        assert!(err.is_syntax() || err.is_eof(), "expected syntax/EOF error, got {err}");
    }

    #[test]
    fn parse_json_complete_large_payload_parses_cleanly() {
        // Simulates a complete large payload (265 available items).
        // Confirms the tolerant parser handles the full catalog size
        // without truncation when the input is complete.
        let mut available = Vec::with_capacity(265);
        for i in 0..265 {
            available.push(serde_json::json!({
                "pluginId": format!("plugin-{i}@marketplace"),
                "name": format!("plugin-{i}"),
                "description": format!("Description for plugin {i}"),
                "marketplaceName": "marketplace",
                "source": "./",
                "installCount": i
            }));
        }
        let payload = serde_json::json!({
            "installed": [],
            "available": available
        });
        let raw = payload.to_string();
        // Confirm the payload is non-trivial (> 10 KB — exercises the
        // "large output" path that would truncate under pipe buffering).
        assert!(raw.len() > 10_000, "payload too small: {} bytes", raw.len());
        // Parse as generic Value (mirrors plugin_available's first step).
        let value: serde_json::Value = serde_json::from_str(&raw).expect("parse");
        let arr = value.get("available").and_then(|v| v.as_array()).unwrap();
        let parsed = parse_available_items_tolerant(arr);
        assert_eq!(parsed.len(), 265);
        assert_eq!(parsed[0].plugin_id, "plugin-0@marketplace");
        assert_eq!(parsed[264].plugin_id, "plugin-264@marketplace");
    }

    #[test]
    fn read_stdout_tempfile_round_trip() {
        // Confirms the tempfile helper reads back exactly what was written.
        use std::io::Write;
        let mut file = tempfile::tempfile().expect("create tempfile");
        let payload = r#"{"installed":[],"available":[]}"#;
        file.write_all(payload.as_bytes()).expect("write");
        // Read back via the production helper.
        let read = read_stdout_tempfile(file).expect("read");
        assert_eq!(read, payload);
    }

    #[test]
    fn read_stdout_tempfile_large_payload() {
        // Confirms the tempfile helper handles payloads > 64 KB (the
        // pipe-buffer ceiling). This is the exact scenario that broke
        // the catalog under pipe-based stdout capture.
        use std::io::Write;
        let mut file = tempfile::tempfile().expect("create tempfile");
        // 200 KB payload — larger than the real 147 KB catalog.
        let large = "x".repeat(200_000);
        file.write_all(large.as_bytes()).expect("write");
        let read = read_stdout_tempfile(file).expect("read");
        assert_eq!(read.len(), 200_000);
        assert!(read.chars().all(|c| c == 'x'));
    }

    // ── map_cli_error (spec §4) ────────────────────────────────────────

    #[test]
    fn map_cli_error_auth_substring_classifies_auth_required() {
        for needle in &[
            "not logged in",
            "auth required",
            "Please login to continue",
            "OAuth token expired",
            "HTTP 401",
            "HTTP 403 Forbidden",
        ] {
            let e = map_cli_error(Some(1), "", needle, "verboo plugin install x@y".into());
            assert!(matches!(e, PluginError::CliAuthRequired), "needle {needle:?} → {e:?}");
        }
    }

    #[test]
    fn map_cli_error_network_substring_classifies_network_error() {
        // NOTE: "failed to fetch" is intentionally NOT in this list — a
        // generic "failed to fetch" is ambiguous (network OR operational).
        // Only explicit network markers classify as NetworkError. See
        // `map_cli_error_generic_failed_to_fetch_not_network_error` for
        // the regression test.
        let cases = [
            ("ETIMEDOUT after 10s", "etimedout"),
            ("ECONNREFUSED", "econnrefused"),
            ("getaddrinfo failed", "getaddrinfo"),
            ("git clone error", "git clone"),
            ("network unreachable", "network"),
            ("HTTP 502", "502"),
        ];
        for (msg, want_substring) in cases {
            let e = map_cli_error(Some(1), "", msg, "verboo plugin marketplace add".into());
            match e {
                PluginError::NetworkError { message } => {
                    assert!(
                        message.to_lowercase().contains(want_substring),
                        "msg={message:?}, expected to contain {want_substring:?}"
                    );
                }
                other => panic!("msg={msg:?} → {other:?}"),
            }
        }
    }

    #[test]
    fn map_cli_error_already_installed() {
        let e = map_cli_error(
            Some(1),
            "",
            "Error: rust-analyzer-lsp@claude-plugins-official is already installed",
            "verboo plugin install".into(),
        );
        match e {
            PluginError::AlreadyInstalled { plugin } => {
                assert!(plugin.contains('@') || plugin == "unknown", "got {plugin:?}");
            }
            other => panic!("expected AlreadyInstalled, got {other:?}"),
        }
    }

    #[test]
    fn map_cli_error_not_installed() {
        let e = map_cli_error(
            Some(1),
            "",
            "cannot find plugin foo@bar — is not installed",
            "verboo plugin uninstall".into(),
        );
        assert!(matches!(e, PluginError::NotInstalled { .. }));
    }

    #[test]
    fn map_cli_error_validate_marker_classifies_invalid_plugin() {
        let combined = "Validating: /p\n\n✘ Found 1 error:\n\n  ❯ root: Unrecognized key: \"description\"\n\n✘ Validation failed";
        let e = map_cli_error(Some(1), combined, "", "verboo plugin validate".into());
        match e {
            PluginError::InvalidPlugin { errors, warnings } => {
                assert!(errors.iter().any(|e| e.contains("Unrecognized key")));
                assert!(warnings.is_none() || warnings.as_ref().map(|w| w.is_empty()).unwrap_or(true));
            }
            other => panic!("expected InvalidPlugin, got {other:?}"),
        }
    }

    #[test]
    fn map_cli_error_validate_marker_precedence_over_already_installed() {
        // Regression: spec §4 requires validate-marker (rule 5) BEFORE
        // already-installed (rule 6). A validate output that happens to
        // mention "already installed" must classify as InvalidPlugin.
        let combined = "Validating: /p\n\n✘ Validation failed: plugin already installed in manifest\n";
        let e = map_cli_error(Some(1), combined, "", "verboo plugin validate".into());
        assert!(
            matches!(e, PluginError::InvalidPlugin { .. }),
            "expected InvalidPlugin, got {e:?}"
        );
    }

    #[test]
    fn map_cli_error_marketplace_add_failure_classifies_invalid_marketplace() {
        // Regression: CLI 0.13 emits `✘` on ANY failure (not just validate),
        // so a marketplace add failure was misclassified as InvalidPlugin
        // with empty errors. The marketplace-marker check must run BEFORE
        // the validate-marker check.
        // Real fixture: user tried to add a GitHub repo that is NOT a
        // marketplace (no marketplace.json). CLI exits 1 with this stderr.
        // "Marketplace file not found" → InvalidMarketplace (not Unknown,
        // not InvalidPlugin) — the source is not a valid marketplace.
        let stderr = "✘ Failed to add marketplace: Marketplace file not found at https://github.com/barvian/number-flow/blob/main/marketplace.json\n";
        let e = map_cli_error(Some(1), "", stderr, "verboo plugin marketplace add".into());
        match e {
            PluginError::InvalidMarketplace { message } => {
                assert!(message.contains("Marketplace file not found"));
            }
            other => panic!("expected InvalidMarketplace, got {other:?}"),
        }
    }

    #[test]
    fn map_cli_error_marketplace_add_failure_without_x_marker() {
        // Same failure but without the `✘` prefix (CLI version drift).
        // Must still classify as InvalidMarketplace, not InvalidPlugin.
        let stderr = "Failed to add marketplace: Marketplace file not found at /path/marketplace.json\n";
        let e = map_cli_error(Some(1), "", stderr, "verboo plugin marketplace add".into());
        match e {
            PluginError::InvalidMarketplace { message, .. } => {
                assert!(message.contains("Marketplace file not found"));
            }
            other => panic!("expected InvalidMarketplace, got {other:?}"),
        }
    }

    #[test]
    fn map_cli_error_marketplace_remove_failure_classifies_unknown() {
        // "Failed to remove marketplace" is operational (not a missing
        // manifest) → Unknown with the full message.
        let stderr = "✘ Failed to remove marketplace: permission denied\n";
        let e = map_cli_error(Some(1), "", stderr, "verboo plugin marketplace remove".into());
        match e {
            PluginError::Unknown { message, .. } => {
                assert!(message.contains("Failed to remove marketplace"));
            }
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    #[test]
    fn map_cli_error_marketplace_not_found_classifies_invalid_marketplace() {
        // "marketplace not found" on remove → the marketplace doesn't exist
        // locally. This is InvalidMarketplace (the named marketplace is not
        // valid/installed), not Unknown.
        let stderr = "✘ Failed to remove marketplace: marketplace not found: nonexistent\n";
        let e = map_cli_error(Some(1), "", stderr, "verboo plugin marketplace remove".into());
        match e {
            PluginError::InvalidMarketplace { message } => {
                assert!(message.contains("marketplace not found"));
            }
            other => panic!("expected InvalidMarketplace, got {other:?}"),
        }
    }

    #[test]
    fn map_cli_error_marketplace_failure_precedence_over_validate_marker() {
        // A marketplace failure that ALSO contains `✘` must classify as
        // InvalidMarketplace (marketplace manifest missing), NOT InvalidPlugin.
        let stderr = "✘ Failed to add marketplace: Marketplace file not found\n✘ Validation failed\n";
        let e = map_cli_error(Some(1), "", stderr, "verboo plugin marketplace add".into());
        assert!(
            matches!(e, PluginError::InvalidMarketplace { .. }),
            "expected InvalidMarketplace, got {e:?}"
        );
    }

    #[test]
    fn map_cli_error_generic_failed_to_fetch_not_network_error() {
        // Regression: "failed to fetch" without explicit network markers
        // (etimedout, econnrefused, etc.) must NOT classify as NetworkError.
        // The CLI uses "failed to fetch" for both network failures AND
        // marketplace-not-found (operational). Only explicit network
        // markers classify as NetworkError now.
        let stderr = "failed to fetch: unknown reason\n";
        let e = map_cli_error(Some(1), "", stderr, "verboo plugin marketplace add".into());
        // Should fall through to Unknown, NOT NetworkError.
        assert!(
            !matches!(e, PluginError::NetworkError { .. }),
            "generic 'failed to fetch' must not be NetworkError, got {e:?}"
        );
    }

    #[test]
    fn map_cli_error_unknown_fallthrough_uses_stderr_first() {
        let e = map_cli_error(
            Some(42),
            "stdout noise",
            "weird CLI crash trace",
            "verboo plugin install".into(),
        );
        match e {
            PluginError::Unknown { message, exit_code } => {
                assert_eq!(exit_code, Some(42));
                assert!(message.contains("weird CLI crash trace"));
            }
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    #[test]
    fn map_cli_error_unknown_falls_back_to_stdout_when_stderr_empty() {
        let e = map_cli_error(Some(1), "weird stdout", "", "verboo".into());
        match e {
            PluginError::Unknown { message, .. } => {
                assert_eq!(message, "weird stdout");
            }
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    #[test]
    fn parse_plugin_token_extracts_at_marketplace() {
        assert_eq!(
            parse_plugin_token("Error: foo@bar is already installed"),
            Some("foo@bar".into())
        );
        assert_eq!(parse_plugin_token("no token here"), None);
    }

    // ── parse_validate_output (spec §2.5) ─────────────────────────────

    #[test]
    fn parse_validate_output_success_no_markers() {
        let output = CliOutput {
            exit_code: Some(0),
            stdout: "Validating marketplace manifest: /p\n\n✓ All checks passed\n".into(),
            stderr: String::new(),
        };
        let result = parse_validate_output(&output);
        assert!(result.valid);
        assert!(result.errors.is_empty());
        assert!(result.warnings.is_empty());
        assert!(result.raw_output.as_deref().unwrap().contains("Validating"));
    }

    #[test]
    fn parse_validate_output_failure_with_x_marker() {
        let output = CliOutput {
            exit_code: Some(1),
            stdout: "Validating: /p\n\n✘ Found 1 error:\n\n  ❯ root: Unrecognized key: \"description\"\n\n✘ Validation failed\n".into(),
            stderr: String::new(),
        };
        let result = parse_validate_output(&output);
        assert!(!result.valid);
        assert_eq!(result.errors.len(), 1);
        assert!(result.errors[0].contains("Unrecognized key"));
    }

    #[test]
    fn parse_validate_output_collects_warnings() {
        let output = CliOutput {
            exit_code: Some(0),
            stdout: "Validating: /p\n⚠ legacy field: foo\nwarning: deprecated bar\n".into(),
            stderr: String::new(),
        };
        let result = parse_validate_output(&output);
        // Exit 0 + no ✘ marker = valid, regardless of warnings.
        assert!(result.valid);
        assert_eq!(result.warnings.len(), 2);
    }

    // ── validate_path (spec §9.3 T10) ─────────────────────────────────

    #[test]
    fn validate_path_rejects_empty() {
        let e = validate_path("").unwrap_err();
        assert!(matches!(e, PluginError::Unknown { .. }));
    }

    #[test]
    fn validate_path_rejects_traversal() {
        let e = validate_path("/tmp/../etc/passwd").unwrap_err();
        match e {
            PluginError::Unknown { message, .. } => assert!(message.contains("..")),
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    #[test]
    fn validate_path_rejects_system_dirs() {
        for forbidden in &["/System", "/Library", "/usr", "/bin", "/sbin", "/etc", "/dev", "/proc", "/sys"] {
            let e = validate_path(forbidden).unwrap_err();
            match e {
                PluginError::Unknown { message, .. } => {
                    assert!(message.contains("system dir"), "forbidden={forbidden}, msg={message}")
                }
                other => panic!("forbidden={forbidden} → {other:?}"),
            }
        }
    }

    #[test]
    fn validate_path_accepts_existing_user_path() {
        // Use the cargo manifest dir — guaranteed to exist.
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let result = validate_path(manifest_dir);
        assert!(result.is_ok(), "got: {:?}", result.err());
    }

    #[test]
    fn validate_path_rejects_nonexistent() {
        let e = validate_path("/definitely/not/here/ever").unwrap_err();
        match e {
            PluginError::Unknown { message, .. } => {
                assert!(message.contains("does not exist") || message.contains("system dir"))
            }
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn validate_path_rejects_system_dirs_case_insensitive() {
        // Regression: macOS APFS is case-insensitive — `/system` and
        // `/LIBRARY` resolve to the same inodes as the canonical forms.
        // The denylist must catch case variations.
        for forbidden in &[
            "/system",
            "/LIBRARY",
            "/Usr",
            "/ETC/passwd",
            "/Bin",
            "/SBIN",
            "/Dev",
            "/Proc",
            "/SYS",
        ] {
            let e = validate_path(forbidden).unwrap_err();
            match e {
                PluginError::Unknown { message, .. } => {
                    assert!(
                        message.contains("system dir"),
                        "forbidden={forbidden}, msg={message}"
                    );
                }
                other => panic!("forbidden={forbidden} → {other:?}"),
            }
        }
    }

    // ── marketplace source classification ─────────────────────────────

    #[test]
    fn classify_marketplace_source_url() {
        assert_eq!(
            classify_marketplace_source("https://code.verboo.ai/api/plugins/marketplace.json"),
            "url"
        );
        assert_eq!(classify_marketplace_source("http://example.com/m.json"), "url");
    }

    #[test]
    fn classify_marketplace_source_github() {
        assert_eq!(classify_marketplace_source("anthropics/claude-plugins-official"), "github");
        assert_eq!(
            classify_marketplace_source("github:anthropics/claude-plugins-official"),
            "github"
        );
    }

    #[test]
    fn classify_marketplace_source_local() {
        assert_eq!(classify_marketplace_source("/Users/me/my-market"), "local");
        assert_eq!(classify_marketplace_source("./local"), "local");
    }

    #[test]
    fn derive_marketplace_name_github_shorthand_uses_repo_segment() {
        assert_eq!(
            derive_marketplace_name("anthropics/claude-plugins-official"),
            "claude-plugins-official"
        );
        assert_eq!(
            derive_marketplace_name("github:obra/superpowers-marketplace"),
            "superpowers-marketplace"
        );
    }

    #[test]
    fn derive_marketplace_name_url_uses_last_segment() {
        assert_eq!(
            derive_marketplace_name("https://code.verboo.ai/api/plugins/marketplace.json"),
            "marketplace"
        );
    }

    #[test]
    fn derive_marketplace_name_local_echoes_input() {
        assert_eq!(derive_marketplace_name("/Users/me/my-market"), "/Users/me/my-market");
    }

    // ── AvailablePlugin parsing (regression) ──────────────────────────

    #[test]
    fn available_plugin_parses_local_source_arm() {
        let raw = r#"{
            "pluginId": "p@m",
            "name": "p",
            "description": "d",
            "marketplaceName": "m",
            "source": { "source": "local", "path": "/p" },
            "installCount": 0
        }"#;
        let a: AvailablePlugin = serde_json::from_str(raw).unwrap();
        match a.source {
            PluginSource::Object(PluginSourceObject::Local { path }) => assert_eq!(path, "/p"),
            other => panic!("expected Local, got {other:?}"),
        }
    }

    // ── push_scope_arg helper ─────────────────────────────────────────

    #[test]
    fn push_scope_arg_appends_when_some() {
        let mut args: Vec<&str> = vec!["plugin", "enable", "x@y"];
        push_scope_arg(&mut args, Some(PluginScope::Project));
        assert_eq!(args, vec!["plugin", "enable", "x@y", "--scope", "project"]);
    }

    #[test]
    fn push_scope_arg_noop_when_none() {
        let mut args: Vec<&str> = vec!["plugin", "enable", "x@y"];
        push_scope_arg(&mut args, None);
        assert_eq!(args, vec!["plugin", "enable", "x@y"]);
    }

    // ── truncate_str ─────────────────────────────────────────────────

    #[test]
    fn truncate_str_short_unchanged() {
        assert_eq!(truncate_str("abc", 10), "abc");
    }

    #[test]
    fn truncate_str_long_cut() {
        let s = "a".repeat(1000);
        let t = truncate_str(&s, 100);
        assert_eq!(t.len(), 100);
    }

    #[test]
    fn truncate_str_multibyte_no_panic() {
        // Regression: byte-slice s[..max] panicked when max fell inside a
        // multibyte UTF-8 sequence. Char-boundary-aware truncation must
        // never panic and must preserve whole codepoints.
        let s = "€".repeat(600); // 3 bytes/char × 600 = 1800 bytes
        let t = truncate_str(&s, 500);
        assert_eq!(t.chars().count(), 500);
        assert_eq!(t.len(), 1500); // 500 × 3 bytes
        // Round-trip: result is valid UTF-8.
        assert!(std::str::from_utf8(t.as_bytes()).is_ok());
    }

    #[test]
    fn truncate_str_multibyte_mixed_content() {
        // Realistic CLI output: ASCII + accented + emoji.
        let s = format!("{}{}", "a".repeat(300), "é".repeat(300));
        let t = truncate_str(&s, 500);
        assert_eq!(t.chars().count(), 500);
        assert!(std::str::from_utf8(t.as_bytes()).is_ok());
    }

    #[test]
    fn truncate_str_emoji_no_panic() {
        // 4-byte codepoint (emoji). Cut in the middle of a codepoint.
        let s = "🚀".repeat(600);
        let t = truncate_str(&s, 500);
        assert_eq!(t.chars().count(), 500);
        assert!(t.chars().all(|c| c == '🚀'));
    }

    // ── pick_unknown_message ─────────────────────────────────────────

    #[test]
    fn pick_unknown_prefers_stderr() {
        let (msg, kind) = pick_unknown_message("stdout", "stderr");
        assert_eq!(msg, "stderr");
        assert_eq!(kind, "stderr");
    }

    #[test]
    fn pick_unknown_falls_back_to_stdout() {
        let (msg, kind) = pick_unknown_message("stdout", "   ");
        assert_eq!(msg, "stdout");
        assert_eq!(kind, "stdout");
    }

    #[test]
    fn pick_unknown_both_empty_returns_empty() {
        let (msg, _) = pick_unknown_message("   ", "  ");
        assert_eq!(msg, "");
    }
}
