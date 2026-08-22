// Helpers in this module are reserved for the runtime integration that lands
// in a later phase (Fase 6+). They are tested now so the wiring is a drop-in.
#![allow(dead_code)]

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::models::types::{
    AccessMode, AgentResultStatus, LanguageCode, ResearchSubagentRequest, ResearchSubagentResult,
    ResearchSubagentsRunRequest,
};

const MAX_RESEARCH_SUBAGENTS: u32 = 2;
const RESEARCH_SUBAGENT_TIMEOUT_MS: u64 = 90_000;
const DISALLOWED_RESEARCH_TOOLS: &[&str] =
    &["edit", "write", "multiedit", "multi_edit", "notebookedit"];

/// Service that runs up to N research subagents in parallel. Mirrors
/// Electron's `ResearchSubagentService`
/// (src/main/services/researchSubagentService.ts:20).
///
/// Each subagent is a CLI turn with `accessMode = Approval` (read-only) and
/// a prompt that forbids edits. The actual CLI execution is delegated to a
/// caller-provided callback (in `lib.rs` this is wired to `TurnService`).
/// This keeps the service pure and testable; the runtime integration lives
/// one layer up.
pub struct ResearchSubagentService;

impl ResearchSubagentService {
    /// Builds the queue of N research requests for a single run.
    /// Mirrors `runMany` minus the actual CLI calls — caller iterates and
    /// dispatches each request, then collects results.
    pub fn build_requests(payload: &ResearchSubagentsRunRequest) -> Vec<ResearchSubagentRequest> {
        let count = clamp_u32(payload.count.max(1), 1, MAX_RESEARCH_SUBAGENTS);
        let run_id = payload.run_id.clone().unwrap_or_else(|| uuid_v4());
        let language = payload
            .base_request
            .response_language
            .clone()
            .unwrap_or(LanguageCode::EnUs);
        let base_request = payload.base_request.clone();
        (0..count)
            .map(|i| {
                let index = i + 1;
                ResearchSubagentRequest {
                    id: format!("{run_id}:{index}"),
                    index,
                    total: count,
                    label: payload
                        .labels
                        .as_ref()
                        .and_then(|labels| labels.get(i as usize))
                        .cloned(),
                    topic: research_topic_for(index, count, &base_request.message, &language),
                    base_request: base_request.clone(),
                }
            })
            .collect()
    }

    /// Returns the access mode every research subagent must use. Mirrors
    /// `researchAccessMode`. Always `Approval` so the CLI gates every tool.
    pub fn research_access_mode() -> AccessMode {
        AccessMode::Approval
    }

    /// Returns the per-subagent timeout. Mirrors `RESEARCH_SUBAGENT_TIMEOUT_MS`.
    pub fn timeout_ms() -> u64 {
        RESEARCH_SUBAGENT_TIMEOUT_MS
    }

    /// Returns the max parallel subagents. Mirrors `MAX_RESEARCH_SUBAGENTS`.
    pub fn max_subagents() -> u32 {
        MAX_RESEARCH_SUBAGENTS
    }

    /// Builds the read-only research prompt for a single subagent. Mirrors
    /// `buildResearchPrompt` (researchSubagentService.ts:221).
    pub fn build_prompt(request: &ResearchSubagentRequest) -> String {
        build_research_prompt(request)
    }

    /// Returns the language for a subagent request. Mirrors `requestLanguage`
    /// (researchSubagentService.ts:276). Exposed as an associated method so the
    /// runner can call `ResearchSubagentService::request_language(&req)`.
    pub fn request_language(request: &ResearchSubagentRequest) -> LanguageCode {
        request_language(request)
    }

    /// Inspects an event payload for a tool-call that violates the read-only
    /// constraint. Returns a human-readable reason if violated, else None.
    /// Mirrors `detectReadOnlyViolation` (researchSubagentService.ts:297).
    pub fn detect_read_only_violation(
        payload: &serde_json::Value,
        language: &LanguageCode,
    ) -> Option<String> {
        detect_read_only_violation(payload, language)
    }

    /// Extracts a source string (file path, URL, command, etc.) from a
    /// tool-call event payload. Mirrors `sourceFromToolPayload`
    /// (researchSubagentService.ts:349).
    pub fn source_from_tool_payload(payload: &serde_json::Value) -> Option<String> {
        source_from_tool_payload(payload)
    }

    /// Builds a failed result for a subagent. Mirrors `failedResult`
    /// (researchSubagentService.ts:365).
    pub fn failed_result(
        request: &ResearchSubagentRequest,
        reason: &str,
        sources: &HashSet<String>,
    ) -> ResearchSubagentResult {
        let language = request_language(request);
        let cleaned = cleanup_output(reason);
        let summary = if cleaned.is_empty() {
            if language == LanguageCode::PtBr {
                "Subagente falhou sem mensagem detalhada.".into()
            } else {
                "Subagent failed without a detailed message.".into()
            }
        } else {
            snippet(&cleaned, 360)
        };
        let mut sources_vec: Vec<String> = sources.iter().cloned().collect();
        sources_vec.truncate(8);
        ResearchSubagentResult {
            id: request.id.clone(),
            index: request.index,
            status: AgentResultStatus::Failed,
            summary,
            findings: Vec::new(),
            sources: sources_vec,
        }
    }

    /// Summarizes a completed subagent's stdout. Mirrors `summarizeOutput`
    /// (researchSubagentService.ts:379).
    pub fn summarize_output(text: &str, language: &LanguageCode) -> String {
        summarize_output(text, language)
    }

    /// Extracts finding bullets from a completed subagent's stdout. Mirrors
    /// `extractFindings` (researchSubagentService.ts:392).
    pub fn extract_findings(text: &str) -> Vec<String> {
        extract_findings(text)
    }

    /// Cleans ANSI escape sequences + DECSET 2026 markers from CLI output.
    /// Mirrors `cleanupOutput` (researchSubagentService.ts:405).
    pub fn cleanup_output(text: &str) -> String {
        cleanup_output(text)
    }

    /// Snips a string to `max_len` chars, replacing runs of whitespace with
    /// single spaces. Mirrors `snippet` (researchSubagentService.ts:453).
    pub fn snippet(value: &str, max_len: usize) -> String {
        snippet(value, max_len)
    }

    /// Returns true if the given shell command is on the read-only allowlist.
    /// Mirrors `isReadOnlyShellCommand` (researchSubagentService.ts:321).
    pub fn is_read_only_shell_command(command: &str) -> bool {
        is_read_only_shell_command(command)
    }

}


fn research_topic_for(index: u32, total: u32, message: &str, language: &LanguageCode) -> String {
    if *language == LanguageCode::PtBr {
        if total == 1 {
            return format!(
                "Pesquisar o pedido completo do usuário: {}",
                snippet(message, 240)
            );
        }
        if index == 1 {
            return "Pesquisar o código local, arquivos relevantes, contratos e riscos de implementação.".into();
        }
        return "Pesquisar contexto complementar, documentação, comportamento esperado e pontos de validação.".into();
    }

    if total == 1 {
        return format!("Research the full user request: {}", snippet(message, 240));
    }
    if index == 1 {
        return "Research local code, relevant files, contracts, and implementation risks.".into();
    }
    "Research complementary context, documentation, expected behavior, and validation points."
        .into()
}

pub fn request_language(request: &ResearchSubagentRequest) -> LanguageCode {
    request
        .base_request
        .response_language
        .clone()
        .unwrap_or(LanguageCode::EnUs)
}

fn build_research_prompt(request: &ResearchSubagentRequest) -> String {
    let language = request_language(request);
    if language == LanguageCode::PtBr {
        return [
            "Você é um subagente de pesquisa do Verboo Code.",
            "Sua função é somente investigar e resumir informações para o agente principal.",
            "",
            "Regras obrigatórias:",
            "- Não edite arquivos.",
            "- Não crie arquivos.",
            "- Não apague arquivos.",
            "- Não rode comandos que alterem o filesystem.",
            "- Use somente leitura, busca, listagem, pesquisa e resumo.",
            "- Responda com achados objetivos, fontes e riscos.",
            "",
            &format!("Subagente: {} de {}", request.index, request.total),
            &format!("Foco desta pesquisa: {}", request.topic),
            "",
            "Mensagem original do usuário:",
            &request.base_request.message,
        ]
        .join("\n");
    }

    [
        "You are a Verboo Code research subagent.",
        "Your role is only to investigate and summarize information for the main agent.",
        "",
        "Mandatory rules:",
        "- Do not edit files.",
        "- Do not create files.",
        "- Do not delete files.",
        "- Do not run commands that change the filesystem.",
        "- Use only reading, search, listing, research, and summary.",
        "- Answer with objective findings, sources, and risks.",
        "",
        &format!("Subagent: {} of {}", request.index, request.total),
        &format!("Research focus: {}", request.topic),
        "",
        "Original user message:",
        &request.base_request.message,
    ]
    .join("\n")
}

fn detect_read_only_violation(
    payload: &serde_json::Value,
    language: &LanguageCode,
) -> Option<String> {
    let block = extract_tool_block(payload)?;
    let mut tool_name = text_value(block.get("name"));
    if tool_name.is_empty() {
        tool_name = text_value(block.get("tool_name"));
    }
    let tool_name = tool_name.to_lowercase();
    if DISALLOWED_RESEARCH_TOOLS.iter().any(|d| *d == tool_name) {
        return Some(if *language == LanguageCode::PtBr {
            format!("Subagente tentou usar ferramenta de escrita: {tool_name}.")
        } else {
            format!("Subagent tried to use a write tool: {tool_name}.")
        });
    }
    if tool_name != "bash" && tool_name != "shell" && tool_name != "exec_command" {
        return None;
    }
    let input = tool_input(&block)?;
    let mut command = text_value(input.get("command"));
    if command.is_empty() {
        command = text_value(input.get("cmd"));
    }
    if command.is_empty() || is_read_only_shell_command(&command) {
        return None;
    }
    Some(if *language == LanguageCode::PtBr {
        format!("Subagente tentou executar comando fora da lista somente leitura: {command}.")
    } else {
        format!("Subagent tried to run a command outside the read-only allowlist: {command}.")
    })
}

fn is_read_only_shell_command(command: &str) -> bool {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return false;
    }
    // Disallow shell metacharacters (pipes, redirects, sequencing).
    if trimmed
        .chars()
        .any(|c| c == '>' || c == '<' || c == '|' || c == ';' || c == '&')
    {
        return false;
    }
    // Disallowed substrings — word-boundary check.
    let disallowed_substrings = [
        "rm",
        "mv",
        "cp",
        "mkdir",
        "touch",
        "chmod",
        "chown",
        "npm",
        "pnpm",
        "yarn",
        "bun",
        "node",
        "python",
        "python3",
        "pip",
        "uv",
        "make",
        "cargo",
        "go",
        "swift",
        "xcodebuild",
        "electron-builder",
    ];
    for word in disallowed_substrings.iter() {
        if contains_word(trimmed, word) {
            return false;
        }
    }
    // Disallowed git subcommands.
    let git_disallowed = [
        "commit", "push", "checkout", "reset", "clean", "merge", "rebase", "apply", "am", "pull",
        "fetch",
    ];
    if trimmed.starts_with("git ") {
        for sub in git_disallowed.iter() {
            // git <sub> as a token after "git "
            let after_git = &trimmed[4..];
            if let Some(rest) = after_git.strip_prefix(sub) {
                // Word boundary: rest must be empty or start with whitespace.
                if rest.is_empty() || rest.starts_with(char::is_whitespace) {
                    return false;
                }
            }
        }
    }
    let allowed_prefixes = [
        "ls",
        "pwd",
        "cat",
        "sed -n",
        "rg",
        "grep",
        "find",
        "git status",
        "git diff",
        "git grep",
        "git show",
        "wc",
        "head",
        "tail",
    ];
    allowed_prefixes
        .iter()
        .any(|prefix| trimmed == *prefix || trimmed.starts_with(&format!("{prefix} ")))
}

/// Returns true if `text` contains `word` as a whole word (word boundary
/// = non-alphanumeric on both sides, mirroring `\b<word>\b`).
fn contains_word(text: &str, word: &str) -> bool {
    text.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .any(|tok| tok.eq_ignore_ascii_case(word))
}

fn source_from_tool_payload(payload: &serde_json::Value) -> Option<String> {
    let block = extract_tool_block(payload)?;
    let mut tool_name = text_value(block.get("name"));
    if tool_name.is_empty() {
        tool_name = text_value(block.get("tool_name"));
    }
    let tool_name = tool_name.to_lowercase();
    let input = tool_input(&block)?;
    if tool_name.is_empty() {
        return None;
    }
    let candidate = if tool_name == "bash" || tool_name == "shell" || tool_name == "exec_command" {
        let cmd = text_value(input.get("command"));
        if cmd.is_empty() {
            text_value(input.get("cmd"))
        } else {
            cmd
        }
    } else if tool_name == "webfetch" {
        text_value(input.get("url"))
    } else if tool_name == "websearch" {
        text_value(input.get("query"))
    } else {
        let mut picked = text_value(input.get("file_path"));
        if picked.is_empty() {
            picked = text_value(input.get("filePath"));
        }
        if picked.is_empty() {
            picked = text_value(input.get("path"));
        }
        if picked.is_empty() {
            picked = text_value(input.get("pattern"));
        }
        picked
    };
    Some(snippet(&candidate, 180))
}

fn failed_result_template(
    request: &ResearchSubagentRequest,
    reason: &str,
    sources: &HashSet<String>,
) -> ResearchSubagentResult {
    ResearchSubagentService::failed_result(request, reason, sources)
}

fn summarize_output(text: &str, language: &LanguageCode) -> String {
    if text.is_empty() {
        return if *language == LanguageCode::PtBr {
            "Pesquisa concluída sem resumo textual.".into()
        } else {
            "Research completed without a text summary.".into()
        };
    }
    let paragraphs: Vec<&str> = text
        .split(|c: char| c == '\n')
        .collect::<Vec<_>>()
        .iter()
        .map(|s| s.trim())
        .collect::<Vec<_>>();
    let mut paragraphs_joined: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut last_was_blank = true;
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() {
            if !current.is_empty() {
                paragraphs_joined.push(std::mem::take(&mut current));
            }
            last_was_blank = true;
        } else {
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(t);
            last_was_blank = false;
        }
    }
    if !current.is_empty() {
        paragraphs_joined.push(current);
    }
    let _ = (paragraphs, last_was_blank);
    let first = paragraphs_joined
        .first()
        .map(|s| s.as_str())
        .unwrap_or(text);
    snippet(first, 420)
}

fn extract_findings(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = text
        .lines()
        .map(|l| {
            let trimmed = l.trim();
            trimmed
                .strip_prefix("- ")
                .or_else(|| trimmed.strip_prefix("* "))
                .unwrap_or(trimmed)
                .trim()
                .to_string()
        })
        .filter(|l| !l.is_empty())
        .filter(|l| !l.starts_with("```"))
        .collect();
    let keyword_test = |l: &str| {
        let lower = l.to_lowercase();
        [
            "arquivo", "file", "risco", "risk", "encontr", "found", "precisa", "should", "deve",
            "source", "fonte", "valid",
        ]
        .iter()
        .any(|k| lower.contains(k))
    };
    let preferred: Vec<String> = lines.iter().filter(|l| keyword_test(l)).cloned().collect();
    if !preferred.is_empty() {
        lines = preferred;
    }
    lines.truncate(8);
    lines.into_iter().map(|l| snippet(&l, 280)).collect()
}

fn cleanup_output(text: &str) -> String {
    // Strip ANSI CSI: ESC [ ... <0x40-0x7E>
    // Strip ESC @-Z\_ (two-byte)
    // Strip lone ESC
    // Strip DECSET 2026 markers: [?2026h / [?2026l (covered by CSI regex)
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    let mut run_start = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b {
            if i > run_start {
                out.push_str(std::str::from_utf8(&bytes[run_start..i]).unwrap_or(""));
            }
            if i + 1 >= bytes.len() {
                // Lone ESC at end — drop.
                i = bytes.len();
                run_start = i;
                break;
            }
            let next = bytes[i + 1];
            if next == b'[' {
                // CSI: skip until 0x40..=0x7E
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
                // Two-byte escape (ESC @ A B ... _)
                i += 2;
                run_start = i;
                continue;
            } else {
                // Unknown — drop the ESC and continue from the next byte.
                i += 1;
                run_start = i;
                continue;
            }
        }
        // Strip literal "[?2026h" / "[?2026l" in case ESC was already gone.
        // (Defensive — should be covered by CSI above.)
        i += 1;
    }
    if i > run_start {
        out.push_str(std::str::from_utf8(&bytes[run_start..i]).unwrap_or(""));
    }
    out.trim().to_string()
}

/// Snips a string to `max_len` chars. Replaces runs of whitespace with a
/// single space. Appends `...` if truncated.
fn snippet(value: &str, max_len: usize) -> String {
    let compact: String = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = compact.trim();
    if trimmed.chars().count() <= max_len {
        return trimmed.to_string();
    }
    let take = max_len.saturating_sub(3);
    let snip: String = trimmed.chars().take(take.max(1)).collect();
    format!("{snip}...")
}

fn extract_tool_block(
    payload: &serde_json::Value,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let obj = payload.as_object()?;
    if has_tool_shape(obj) {
        return Some(obj.clone());
    }
    if let Some(event) = obj.get("event").and_then(|v| v.as_object()) {
        if let Some(content_block) = event.get("content_block").and_then(|v| v.as_object()) {
            if has_tool_shape(content_block) {
                return Some(content_block.clone());
            }
        }
    }
    if let Some(message) = obj.get("message").and_then(|v| v.as_object()) {
        if let Some(content) = message.get("content").and_then(|v| v.as_array()) {
            for block in content {
                if let Some(block_obj) = block.as_object() {
                    if has_tool_shape(block_obj) {
                        return Some(block_obj.clone());
                    }
                }
            }
        }
    }
    None
}

fn has_tool_shape(obj: &serde_json::Map<String, serde_json::Value>) -> bool {
    let type_str = text_value(obj.get("type")).to_lowercase();
    if type_str.contains("tool_use") {
        return true;
    }
    let has_name = !text_value(obj.get("name")).is_empty();
    let has_tool_name = !text_value(obj.get("tool_name")).is_empty();
    has_name || has_tool_name
}

fn tool_input(
    block: &serde_json::Map<String, serde_json::Value>,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    if let Some(input) = block.get("input").and_then(|v| v.as_object()) {
        return Some(input.clone());
    }
    if let Some(arguments) = block.get("arguments").and_then(|v| v.as_object()) {
        return Some(arguments.clone());
    }
    let mut input_json = text_value(block.get("input_json"));
    if input_json.is_empty() {
        input_json = text_value(block.get("arguments_json"));
    }
    if input_json.is_empty() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(&input_json).ok()?;
    parsed.as_object().cloned()
}

fn text_value(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

fn clamp_u32(value: u32, min: u32, max: u32) -> u32 {
    value.max(min).min(max)
}

/// Process-wide counter mixed into every generated ID so two calls in the
/// same nanosecond on the same thread still produce different values.
static UUID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Pure: mixes the entropy sources into the id string. Shape is frozen:
/// 8-4-4-4-12 hex with a literal `4` as the version nibble.
fn mix_uuid(nanos: u128, tid_hash: u64, counter: u64) -> String {
    let combined = (nanos as u64) ^ tid_hash.rotate_left(17) ^ counter.rotate_left(31);
    let hi = (nanos >> 64) as u64 ^ tid_hash ^ counter;
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (combined & 0xffff_ffff) as u32,
        ((combined >> 32) & 0xffff) as u16,
        ((combined >> 48) & 0xfff) as u16,
        ((hi >> 16) & 0xffff) as u16,
        hi & 0xffff_ffff_ffff
    )
}

/// Minimal uuid v4 generator (avoids pulling a new crate dependency just for
/// research subagent IDs).
fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // Entropy: wall-clock nanos mixed with a hash of the thread id and a
    // process-wide counter.
    let thread_id = std::thread::current().id();
    let tid_hash = format!("{:?}", thread_id)
        .bytes()
        .fold(0u64, |acc, b| acc.wrapping_mul(31).wrapping_add(b as u64));
    let counter = UUID_COUNTER.fetch_add(1, Ordering::Relaxed);
    mix_uuid(nanos, tid_hash, counter)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{AgentTurnRequest, LanguageCode, PersonalityMode};
    use serde_json::json;

    fn base_request() -> AgentTurnRequest {
        AgentTurnRequest {
            turn_id: None,
            conversation_id: "c1".into(),
            message: "build a feature".into(),
            provider_account: None,
            model: None,
            model_supports_vision: None,
            run_vision_fallback: None,
            media_capabilities: None,
            cli_media_capabilities: None,
            run_video_analysis: None,
            effort: None,
            reasoning: None,
            context_window: None,
            response_language: Some(LanguageCode::EnUs),
            access_mode: AccessMode::Approval,
            working_directory: "/tmp".into(),
            skills: vec![],
            attachments: None,
            response_enhancements_enabled: None,
            personality: Some(PersonalityMode::Concise),
            custom_instructions: None,
            memory_context: None,
            annotations: None,
        }
    }

    fn subagent_request(index: u32, total: u32, language: LanguageCode) -> ResearchSubagentRequest {
        let mut req = base_request();
        req.response_language = Some(language);
        ResearchSubagentRequest {
            id: format!("run:{index}"),
            index,
            total,
            label: None,
            topic: research_topic_for(index, total, "build a feature", &language),
            base_request: req,
        }
    }


    #[test]
    fn snippet_truncates_long_strings() {
        let s = snippet("hello world this is a long string", 10);
        assert!(s.ends_with("..."));
        assert!(s.chars().count() <= 10);
        assert!(s.starts_with("hello"));
    }

    #[test]
    fn snippet_preserves_short_strings() {
        assert_eq!(snippet("hello", 50), "hello");
        assert_eq!(snippet("", 50), "");
    }

    #[test]
    fn snippet_collapses_whitespace() {
        assert_eq!(snippet("hello   world\n\tfoo", 50), "hello world foo");
    }

    #[test]
    fn snippet_handles_unicode() {
        // 4-byte emoji as one char.
        let s = snippet("café 🦀 test", 50);
        assert_eq!(s, "café 🦀 test");
    }


    #[test]
    fn cleanup_output_strips_ansi_csi() {
        let input = "\x1b[31mred\x1b[0m text";
        assert_eq!(cleanup_output(input), "red text");
    }

    #[test]
    fn cleanup_output_strips_decset_2026() {
        let input = "\x1b[?2026hhello\x1b[?2026l world";
        assert_eq!(cleanup_output(input), "hello world");
    }

    #[test]
    fn cleanup_output_strips_two_byte_escapes() {
        let input = "\x1bMfoo";
        assert_eq!(cleanup_output(input), "foo");
    }

    #[test]
    fn cleanup_output_handles_truncated_escapes() {
        assert_eq!(cleanup_output("\x1b"), "");
        assert_eq!(cleanup_output("\x1b["), "");
        assert_eq!(cleanup_output("text\x1b"), "text");
    }

    #[test]
    fn cleanup_output_preserves_unicode() {
        assert_eq!(cleanup_output("\x1b[31mcafé 🦀\x1b[0m"), "café 🦀");
    }


    #[test]
    fn read_only_allows_ls_cat_grep() {
        assert!(is_read_only_shell_command("ls"));
        assert!(is_read_only_shell_command("ls -la"));
        assert!(is_read_only_shell_command("cat foo.txt"));
        assert!(is_read_only_shell_command("rg pattern"));
        assert!(is_read_only_shell_command("grep foo bar.txt"));
        assert!(is_read_only_shell_command("git status"));
        assert!(is_read_only_shell_command("git diff"));
        assert!(is_read_only_shell_command("git show abc123"));
        assert!(is_read_only_shell_command("git grep foo"));
        assert!(is_read_only_shell_command("head -n 5 file"));
        assert!(is_read_only_shell_command("tail -n 5 file"));
        assert!(is_read_only_shell_command("wc -l file"));
        assert!(is_read_only_shell_command("find . -name foo"));
        assert!(is_read_only_shell_command("sed -n '1,5p' file"));
    }

    #[test]
    fn read_only_rejects_destructive_commands() {
        assert!(!is_read_only_shell_command("rm foo"));
        assert!(!is_read_only_shell_command("mv a b"));
        assert!(!is_read_only_shell_command("mkdir newdir"));
        assert!(!is_read_only_shell_command("touch newfile"));
        assert!(!is_read_only_shell_command("npm install"));
        assert!(!is_read_only_shell_command("cargo build"));
        assert!(!is_read_only_shell_command("node script.js"));
        assert!(!is_read_only_shell_command("python main.py"));
    }

    #[test]
    fn read_only_rejects_git_write_subcommands() {
        assert!(!is_read_only_shell_command("git commit -m x"));
        assert!(!is_read_only_shell_command("git push"));
        assert!(!is_read_only_shell_command("git reset --hard"));
        assert!(!is_read_only_shell_command("git checkout other-branch"));
        assert!(!is_read_only_shell_command("git clean -fd"));
    }

    #[test]
    fn read_only_rejects_pipes_and_redirects() {
        assert!(!is_read_only_shell_command("cat foo | grep bar"));
        assert!(!is_read_only_shell_command("echo x > foo"));
        assert!(!is_read_only_shell_command("ls ; rm bar"));
        assert!(!is_read_only_shell_command("grep a && grep b"));
    }

    #[test]
    fn read_only_rejects_empty_and_whitespace() {
        assert!(!is_read_only_shell_command(""));
        assert!(!is_read_only_shell_command("   "));
    }


    #[test]
    fn violation_detects_edit_tool() {
        let payload = json!({
            "type": "tool_use",
            "name": "Edit",
            "input": {"file_path": "foo.txt"}
        });
        let result = detect_read_only_violation(&payload, &LanguageCode::EnUs);
        assert!(result.is_some());
        assert!(result.unwrap().contains("edit"));
    }

    #[test]
    fn violation_detects_write_tool() {
        let payload = json!({
            "type": "tool_use",
            "name": "write",
            "input": {"file_path": "foo.txt"}
        });
        assert!(detect_read_only_violation(&payload, &LanguageCode::EnUs).is_some());
    }

    #[test]
    fn violation_detects_unsafe_bash() {
        let payload = json!({
            "type": "tool_use",
            "name": "bash",
            "input": {"command": "rm -rf /"}
        });
        let result = detect_read_only_violation(&payload, &LanguageCode::EnUs);
        assert!(result.is_some());
        assert!(result.unwrap().contains("rm"));
    }

    #[test]
    fn violation_allows_safe_bash() {
        let payload = json!({
            "type": "tool_use",
            "name": "bash",
            "input": {"command": "ls -la"}
        });
        assert!(detect_read_only_violation(&payload, &LanguageCode::EnUs).is_none());
    }

    #[test]
    fn violation_localized_in_portuguese() {
        let payload = json!({
            "type": "tool_use",
            "name": "Edit",
            "input": {"file_path": "foo.txt"}
        });
        let result = detect_read_only_violation(&payload, &LanguageCode::PtBr);
        assert!(result.unwrap().contains("Subagente tentou"));
    }

    #[test]
    fn violation_returns_none_for_non_tool_payloads() {
        assert!(detect_read_only_violation(&json!({}), &LanguageCode::EnUs).is_none());
        assert!(detect_read_only_violation(&json!("text"), &LanguageCode::EnUs).is_none());
        assert!(detect_read_only_violation(&json!([1, 2]), &LanguageCode::EnUs).is_none());
    }

    #[test]
    fn violation_extracts_from_nested_content_block() {
        let payload = json!({
            "event": {
                "content_block": {
                    "type": "tool_use",
                    "name": "Write",
                    "input": {"file_path": "x"}
                }
            }
        });
        assert!(detect_read_only_violation(&payload, &LanguageCode::EnUs).is_some());
    }

    #[test]
    fn violation_extracts_from_message_content_array() {
        let payload = json!({
            "message": {
                "content": [
                    {"type": "text", "text": "hi"},
                    {"type": "tool_use", "name": "MultiEdit", "input": {}}
                ]
            }
        });
        assert!(detect_read_only_violation(&payload, &LanguageCode::EnUs).is_some());
    }


    #[test]
    fn source_extracts_file_path_from_read() {
        let payload = json!({
            "type": "tool_use",
            "name": "Read",
            "input": {"file_path": "/repo/src/main.rs"}
        });
        let src = source_from_tool_payload(&payload).unwrap();
        assert!(src.contains("main.rs"));
    }

    #[test]
    fn source_extracts_command_from_bash() {
        let payload = json!({
            "type": "tool_use",
            "name": "bash",
            "input": {"command": "ls -la"}
        });
        let src = source_from_tool_payload(&payload).unwrap();
        assert_eq!(src, "ls -la");
    }

    #[test]
    fn source_extracts_url_from_webfetch() {
        let payload = json!({
            "type": "tool_use",
            "name": "WebFetch",
            "input": {"url": "https://example.com"}
        });
        let src = source_from_tool_payload(&payload).unwrap();
        assert_eq!(src, "https://example.com");
    }

    #[test]
    fn source_extracts_query_from_websearch() {
        let payload = json!({
            "type": "tool_use",
            "name": "WebSearch",
            "input": {"query": "rust async patterns"}
        });
        let src = source_from_tool_payload(&payload).unwrap();
        assert_eq!(src, "rust async patterns");
    }

    #[test]
    fn source_returns_none_for_non_tool_payloads() {
        assert!(source_from_tool_payload(&json!({})).is_none());
        assert!(source_from_tool_payload(&json!("x")).is_none());
    }


    #[test]
    fn summarize_returns_default_for_empty() {
        let en = summarize_output("", &LanguageCode::EnUs);
        let pt = summarize_output("", &LanguageCode::PtBr);
        assert_eq!(en, "Research completed without a text summary.");
        assert_eq!(pt, "Pesquisa concluída sem resumo textual.");
    }

    #[test]
    fn summarize_takes_first_paragraph() {
        let text = "First paragraph here.\n\nSecond paragraph.";
        assert_eq!(
            summarize_output(text, &LanguageCode::EnUs),
            "First paragraph here."
        );
    }

    #[test]
    fn summarize_snips_long_text() {
        let text = "a".repeat(500);
        let s = summarize_output(&text, &LanguageCode::EnUs);
        assert!(s.ends_with("..."));
        assert!(s.chars().count() <= 420);
    }


    #[test]
    fn extract_findings_strips_bullets() {
        let text = "- file: foo.rs is relevant\n- found a bug in bar.rs";
        let findings = extract_findings(text);
        assert_eq!(findings.len(), 2);
        assert!(!findings[0].starts_with("- "));
    }

    #[test]
    fn extract_findings_prefers_keyword_lines() {
        let text = "just chatter\nthis is a risk to consider\nanother line\nfile: x.rs is needed";
        let findings = extract_findings(text);
        assert!(findings.iter().any(|f| f.contains("risk")));
        assert!(findings.iter().any(|f| f.contains("file: x.rs")));
        // Should not contain "just chatter" or "another line".
        assert!(!findings.iter().any(|f| f.contains("just chatter")));
    }

    #[test]
    fn extract_findings_drops_code_fences() {
        let text = "```\ncode\n```\nfound relevant file";
        let findings = extract_findings(text);
        assert!(findings.iter().any(|f| f.contains("relevant file")));
        assert!(!findings.iter().any(|f| f.starts_with("```")));
    }

    #[test]
    fn extract_findings_limits_to_eight() {
        let mut text = String::new();
        for i in 0..20 {
            text.push_str(&format!("file {i} is relevant\n"));
        }
        let findings = extract_findings(&text);
        assert_eq!(findings.len(), 8);
    }


    #[test]
    fn topic_for_single_subagent_includes_message() {
        let en = research_topic_for(1, 1, "build feature X", &LanguageCode::EnUs);
        assert!(en.contains("build feature X"));
        assert!(en.starts_with("Research the full user request"));

        let pt = research_topic_for(1, 1, "construir X", &LanguageCode::PtBr);
        assert!(pt.contains("construir X"));
    }

    #[test]
    fn topic_for_first_of_two_in_english() {
        let topic = research_topic_for(1, 2, "msg", &LanguageCode::EnUs);
        assert!(topic.contains("local code"));
        assert!(topic.contains("implementation risks"));
    }

    #[test]
    fn topic_for_second_of_two_in_english() {
        let topic = research_topic_for(2, 2, "msg", &LanguageCode::EnUs);
        assert!(topic.contains("complementary context"));
    }

    #[test]
    fn topic_for_portuguese_first_and_second() {
        let first = research_topic_for(1, 2, "msg", &LanguageCode::PtBr);
        let second = research_topic_for(2, 2, "msg", &LanguageCode::PtBr);
        assert!(first.contains("código local"));
        assert!(second.contains("contexto complementar"));
    }


    #[test]
    fn prompt_english_includes_rules_and_topic() {
        let request = subagent_request(1, 1, LanguageCode::EnUs);
        let prompt = build_research_prompt(&request);
        assert!(prompt.contains("Verboo Code research subagent"));
        assert!(prompt.contains("Do not edit files."));
        assert!(prompt.contains("Subagent: 1 of 1"));
        assert!(prompt.contains("Original user message:"));
        assert!(prompt.contains("build a feature"));
    }

    #[test]
    fn prompt_portuguese_uses_ptbr_copy() {
        let request = subagent_request(2, 2, LanguageCode::PtBr);
        let prompt = build_research_prompt(&request);
        assert!(prompt.contains("subagente de pesquisa"));
        assert!(prompt.contains("Não edite arquivos."));
        assert!(prompt.contains("Subagente: 2 de 2"));
    }


    #[test]
    fn build_requests_clamps_count_to_max() {
        let payload = ResearchSubagentsRunRequest {
            run_id: Some("r1".into()),
            count: 10,
            requested_count: Some(10),
            labels: Some(vec!["Code scout".into(), "Docs scout".into()]),
            base_request: base_request(),
        };
        let requests = ResearchSubagentService::build_requests(&payload);
        assert_eq!(requests.len(), 2); // MAX_RESEARCH_SUBAGENTS
        assert_eq!(requests[0].index, 1);
        assert_eq!(requests[1].index, 2);
        assert_eq!(requests[0].id, "r1:1");
        assert_eq!(requests[1].id, "r1:2");
        assert_eq!(requests[0].label.as_deref(), Some("Code scout"));
        assert_eq!(requests[1].label.as_deref(), Some("Docs scout"));
    }

    #[test]
    fn build_requests_generates_run_id_if_missing() {
        let payload = ResearchSubagentsRunRequest {
            run_id: None,
            count: 1,
            requested_count: None,
            labels: None,
            base_request: base_request(),
        };
        let requests = ResearchSubagentService::build_requests(&payload);
        assert_eq!(requests.len(), 1);
        // Generated ID is non-empty and contains a colon.
        assert!(!requests[0].id.is_empty());
        assert!(requests[0].id.contains(':'));
    }


    #[test]
    fn failed_result_constructs_failure_shape() {
        let request = subagent_request(1, 1, LanguageCode::EnUs);
        let mut sources = HashSet::new();
        sources.insert("/repo/file.rs".to_string());
        let result = ResearchSubagentService::failed_result(&request, "CLI error", &sources);
        assert_eq!(result.status, AgentResultStatus::Failed);
        assert_eq!(result.id, "run:1");
        assert_eq!(result.index, 1);
        assert_eq!(result.summary, "CLI error");
        assert!(result.findings.is_empty());
        assert_eq!(result.sources.len(), 1);
    }

    #[test]
    fn failed_result_falls_back_when_reason_empty() {
        let request = subagent_request(1, 1, LanguageCode::EnUs);
        let sources = HashSet::new();
        let result = ResearchSubagentService::failed_result(&request, "", &sources);
        assert!(result.summary.contains("without a detailed message"));
    }

    #[test]
    fn failed_result_falls_back_in_portuguese() {
        let request = subagent_request(1, 1, LanguageCode::PtBr);
        let sources = HashSet::new();
        let result = ResearchSubagentService::failed_result(&request, "", &sources);
        assert!(result.summary.contains("sem mensagem detalhada"));
    }

    #[test]
    fn failed_result_truncates_sources_to_eight() {
        let request = subagent_request(1, 1, LanguageCode::EnUs);
        let mut sources = HashSet::new();
        for i in 0..20 {
            sources.insert(format!("src{i}"));
        }
        let result = ResearchSubagentService::failed_result(&request, "err", &sources);
        assert_eq!(result.sources.len(), 8);
    }


    #[test]
    fn research_access_mode_is_approval() {
        assert_eq!(
            ResearchSubagentService::research_access_mode(),
            AccessMode::Approval
        );
    }

    #[test]
    fn research_timeout_matches_electron() {
        assert_eq!(ResearchSubagentService::timeout_ms(), 90_000);
    }

    #[test]
    fn research_max_subagents_matches_electron() {
        assert_eq!(ResearchSubagentService::max_subagents(), 2);
    }

    // Canário do counter: com nanos e tid FIXOS, só o counter varia — as duas
    // chamadas têm que produzir IDs diferentes. Se o counter sair da mistura,
    // ambas retornam a mesma string e este teste fica vermelho.
    #[test]
    fn mix_uuid_counter_distinguishes_same_nanos_same_thread() {
        let a = super::mix_uuid(1_700_000_000_000_000_000, 0xdead_beef, 0);
        let b = super::mix_uuid(1_700_000_000_000_000_000, 0xdead_beef, 1);
        assert_ne!(a, b, "same nanos+tid, different counters must differ");
        // Formato congelado: 8-4-4-4-12 hex com '4' na posição de versão.
        for id in [&a, &b] {
            let parts: Vec<&str> = id.split('-').collect();
            let lens: Vec<usize> = parts.iter().map(|p| p.len()).collect();
            assert_eq!(lens, vec![8, 4, 4, 4, 12], "id shape must stay 8-4-4-4-12 hex: {id}");
            assert!(id.chars().all(|c| c == '-' || c.is_ascii_hexdigit()));
            assert_eq!(&id[14..15], "4", "version nibble must be '4': {id}");
        }
    }
}
