use serde::{Deserialize, Serialize};

// ════════════════════════════════════════════════════════════════════
// Serde helpers — diagnostic overflow rejection
// ════════════════════════════════════════════════════════════════════

/// Diagnostic deserializer for `u32` fields that may receive values from
/// JavaScript's `Number.MAX_SAFE_INTEGER` (9_007_199_254_740_991).
///
/// When the renderer sends a value exceeding `u32::MAX`, the error message
/// names the overflow and suggests the correct sentinel — so the user sees
/// *what* went wrong and *how* to fix it, instead of a generic serde error.
///
/// Usage: `#[serde(deserialize_with = "u32_bounds::deserialize")]`
pub(crate) mod u32_bounds {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D>(deserializer: D) -> Result<u32, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = serde_json::Value::deserialize(deserializer)?;
        match &raw {
            serde_json::Value::Number(n) => {
                if let Some(v) = n.as_u64() {
                    u32::try_from(v).map_err(|_| {
                        serde::de::Error::custom(format!(
                            "value {v} overflows u32 (max 4294967295). \
                             For unlimited, send 4294967295 (u32::MAX)"
                        ))
                    })
                } else if let Some(f) = n.as_f64() {
                    Err(serde::de::Error::custom(format!(
                        "value {f} is not a valid u32 (max 4294967295). \
                         For unlimited, send 4294967295 (u32::MAX)"
                    )))
                } else {
                    Err(serde::de::Error::custom(
                        "invalid numeric value in JSON",
                    ))
                }
            }
            other => Err(serde::de::Error::custom(format!(
                "expected a number for u32 field, got {other}"
            ))),
        }
    }
}

// ════════════════════════════════════════════════════════════════════
// Enums
// ════════════════════════════════════════════════════════════════════

/// NodeJS.Platform values that the CSS depends on:
///   darwin → :root[data-platform="darwin"]
///   win32  → :root[data-platform="win32"]
///   linux  → :root[data-platform="linux"]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Darwin,
    Win32,
    Linux,
}

impl std::fmt::Display for Platform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Platform::Darwin => write!(f, "darwin"),
            Platform::Win32 => write!(f, "win32"),
            Platform::Linux => write!(f, "linux"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AccessMode {
    Approval,
    Auto,
    Full,
}

/// Returns the CLI args to pass for the given access mode. Mirrors
/// Electron's `accessModeConfig[mode].cliArgs` (src/main/security/accessModes.ts).
/// `approval` → `--permission-mode default`
/// `auto` → `--permission-mode acceptEdits`
/// `full` → `--allow-dangerously-skip-permissions --dangerously-skip-permissions --permission-mode bypassPermissions`
pub fn access_mode_cli_args(mode: &AccessMode) -> &'static [&'static str] {
    match mode {
        AccessMode::Approval => &["--permission-mode", "default"],
        AccessMode::Auto => &["--permission-mode", "acceptEdits"],
        AccessMode::Full => &[
            "--allow-dangerously-skip-permissions",
            "--dangerously-skip-permissions",
            "--permission-mode",
            "bypassPermissions",
        ],
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeMode {
    Dark,
    Light,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum LanguageCode {
    #[serde(rename = "en-US")]
    EnUs,
    #[serde(rename = "pt-BR")]
    PtBr,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum SettingsTab {
    Permissions,
    TrustedCommands,
    App,
    Notifications,
    Personalization,
    Memory,
    Updates,
    Archived,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PersonalityMode {
    Pragmatic,
    Concise,
    Explanatory,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CompletionNotificationMode {
    Always,
    Background,
    Never,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SkillSource {
    Project,
    User,
    Legacy,
    Managed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum GoalStatus {
    Active,
    Paused,
    Evaluating,
    Continuing,
    Blocked,
    Completed,
    Cancelled,
    BudgetLimited,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum AttachmentKind {
    Image,
    Video,
    File,
    BrowserAnnotation,
}

/// Outcome of attempting text extraction on an attachment.
///
/// - `Extracted`: real text was extracted and is in `extracted_text`.
/// - `Warning`: extraction was attempted but produced no usable text
///   (scanned PDF, corrupt file, too large). `extracted_text` holds a
///   human-readable warning string that is still injected into the prompt
///   so the model is told explicitly not to hallucinate.
/// - `None`: no extraction was attempted (non-PDF file, or image —
///   vision path handles these separately).
///
/// Frontend uses this to distinguish "model has real content" from
/// "model received a warning" without parsing the warning string.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ExtractionStatus {
    Extracted,
    Warning,
}

/// User consent for the vision fallback feature. When the user's selected
/// model doesn't support vision but they attach an image, the app can
/// spawn a secondary CLI with a vision-capable model (from the user's own
/// catalog) to describe the image and inject the description as text.
///
/// - `Ask`: prompt the user before each fallback (default — safest).
/// - `Always`: always run the fallback without asking.
/// - `Never`: never run the fallback; images are ignored with a warning.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum VisionFallbackConsent {
    Ask,
    Always,
    Never,
}

impl Default for VisionFallbackConsent {
    fn default() -> Self {
        Self::Ask
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum VideoFallbackConsent {
    Ask,
    Always,
    Never,
}

impl Default for VideoFallbackConsent {
    fn default() -> Self {
        Self::Ask
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum VideoHdrKind {
    Sdr,
    Hlg,
    Pq,
    DolbyVision,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum VideoProgressStage {
    Validating,
    Preparing,
    Transcribing,
    Analyzing,
    Consolidating,
}

/// Avatar configuration: how the user's profile picture is rendered.
/// Mirrors the TS `AvatarSettings` type (src/shared/types.ts:245).
///
/// - `Initials` → show the user's initials (default, no storage needed).
/// - `Preset` → render one of the built-in SVG icons (preset_id + preset_color).
/// - `Upload` → show a user-uploaded photo (upload_path saved by `save_avatar_blob`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AvatarKind {
    Initials,
    Preset,
    Upload,
}

impl Default for AvatarKind {
    fn default() -> Self {
        Self::Initials
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AvatarSettings {
    #[serde(default)]
    pub kind: AvatarKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upload_path: Option<String>,
    /// Monotonic version bumped on each upload. The backend uses a fixed
    /// filename (avatar.ext) so the path never changes — `upload_version`
    /// busts the cache and ensures retry after a previous load failure.
    /// Mirrors the TS `uploadVersion` field (src/shared/types.ts:253).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upload_version: Option<u64>,
}

impl Default for AvatarSettings {
    fn default() -> Self {
        Self {
            kind: AvatarKind::Initials,
            preset_id: None,
            preset_color: None,
            upload_path: None,
            upload_version: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FeedbackCategory {
    Bug,
    Feedback,
    Question,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FeedbackChannel {
    Supabase,
    Mailto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceReviewScope {
    GithubRepo,
    GitRepo,
    LocalFolder,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FileDiffStatus {
    Added,
    Modified,
    Deleted,
    Untracked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DiffLineKind {
    Context,
    Add,
    Del,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    #[default]
    Stable,
    Beta,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateStatus {
    #[default]
    Idle,
    Checking,
    #[serde(rename = "not-available")]
    NotAvailable,
    Available,
    Downloading,
    Downloaded,
    Error,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum InstallUpdateStatus {
    Busy,
    Restarting,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallUpdateResult {
    pub status: InstallUpdateStatus,
    pub active_turns: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TurnActionKind {
    Read,
    Search,
    Edit,
    Create,
    Delete,
    Command,
    Image,
    Terminal,
    Permission,
    AgentOpen,
    AgentClose,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CommandStatus {
    Success,
    Failure,
    Running,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum GoalDecision {
    Continue,
    Pause,
    Complete,
}

/// Stable reason identifiers for goal evaluation decisions.
/// These are designed to be programmatically consumed by the FE for
/// circuit-breaking, UX, and analytics. The values are serialized as
/// camelCase (e.g. `infraError`, `needsUser`) so they flow cleanly
/// to the renderer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum GoalReasonId {
    /// Agent is still working on the task — not done yet.
    TaskIncomplete,
    /// Agent hit a task-level failure (test fails, compile error) —
    /// should continue to fix.
    TaskFailure,
    /// Operation detected as unsafe — needs human review.
    Unsafe,
    /// Agent needs user input (credentials, architectural decision).
    NeedsUser,
    /// Objective met.
    Done,
    /// Goal hit safety limits (max turns, max elapsed, etc.).
    /// NOT a budget limitation — Verboo has unlimited tokens.
    /// FE maps this to budget_limited/paused status.
    SafetyLimit,
    /// Infrastructure failure (CLI timeout, parse error, crash).
    /// Triggers circuit-breaker in the FE.
    InfraError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProfileStatus {
    Ready,
    Unauthenticated,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SubagentThreadStatus {
    Queued,
    Thinking,
    Reading,
    Searching,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SubagentThreadEventKind {
    Mission,
    AgentMessage,
    ToolCall,
    ToolResult,
    Status,
    Final,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubagentThreadEvent {
    pub id: String,
    pub kind: SubagentThreadEventKind,
    pub text: String,
    pub timestamp: u64,
    pub tool_name: Option<String>,
    pub tool_use_id: Option<String>,
    pub is_error: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubagentThreadUpdate {
    pub thread_id: String,
    pub runtime_agent_id: Option<String>,
    pub tool_use_id: Option<String>,
    pub label: Option<String>,
    pub mission: Option<String>,
    pub status: Option<SubagentThreadStatus>,
    pub event: Option<SubagentThreadEvent>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum EventType {
    Started,
    Stdout,
    Stderr,
    Json,
    Result,
    #[serde(rename = "subagent-thread")]
    SubagentThread,
    #[serde(rename = "video-progress")]
    VideoProgress,
    Error,
    #[default]
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AgentResultStatus {
    Complete,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeStatusKind {
    Permission,
    Question,
    Tool,
}

// ════════════════════════════════════════════════════════════════════
// Structs
// ════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub working_directory: String,
    pub access_mode: AccessMode,
    pub platform: Platform,
    pub selected_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub has_api_key: bool,
    pub api_key_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliAuthStatus {
    pub logged_in: bool,
    pub auth_method: Option<String>,
    pub api_provider: Option<String>,
    pub email: Option<String>,
    pub org_id: Option<String>,
    pub org_name: Option<String>,
    pub subscription_type: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub ok: bool,
    pub message: String,
    pub status: Option<CliAuthStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerbooModel {
    pub id: String,
    pub display_name: String,
    pub context_window: Option<u32>,
    pub max_output_tokens: Option<u32>,
    pub supports_vision: Option<bool>,
    pub vision_support_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ModelReasoning>,
    pub raw: serde_json::Value,
}

/// Reasoning/effort metadata for a model, promoted from the Router's raw
/// JSON (`reasoning.effort_levels` / `reasoning.default_effort`).
/// Accepts any string[] the Router sends — no hardcoded level list — so
/// future levels (e.g. "xhigh") flow through without code changes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelReasoning {
    pub effort_levels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDiscoveryResult {
    pub models: Vec<VerbooModel>,
    pub source: String,
    pub stale: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileUsageSummary {
    pub tokens_in_total: Option<u64>,
    pub tokens_out_total: Option<u64>,
    pub total_tokens: Option<u64>,
    pub req_total: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileActivityDay {
    pub date: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePlan {
    pub id: Option<String>,
    pub name: Option<String>,
    pub status: Option<String>,
    pub price_label: Option<String>,
    pub models: Option<Vec<String>>,
    /// Concurrent-request limit for the plan (from `/me/subscriptions`
    /// `group.concurrentRequests`). The service now limits by concurrency
    /// rather than requests-per-minute. Real value, refreshed with the profile.
    pub concurrent_requests: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileUser {
    pub id: Option<String>,
    pub name: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileResult {
    pub status: ProfileStatus,
    pub fetched_at: Option<i64>,
    pub user: Option<ProfileUser>,
    pub plan: Option<ProfilePlan>,
    pub summary: Option<ProfileUsageSummary>,
    pub activity: Option<Vec<ProfileActivityDay>>,
    pub active_days: Option<u32>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedCommandRule {
    pub id: String,
    pub command: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
    pub use_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomSlashCommand {
    pub id: String,
    pub name: String,
    pub description: String,
    pub body: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettings {
    pub channel: UpdateChannel,
    pub auto_check: bool,
    pub auto_download: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalModeSettings {
    /// Whether goal mode is enabled for new conversations. Default: true.
    pub enabled: bool,
    /// DEPRECATED — safety guard only. Verboo has unlimited tokens.
    /// Kept for FE backward compat. Max turns before auto-pause.
    /// Default: 3. Clamped [1, 20].
    #[serde(deserialize_with = "u32_bounds::deserialize")]
    pub max_turns: u32,
    /// DEPRECATED — safety guard only. Verboo has unlimited tokens.
    /// Kept for FE backward compat. Max elapsed minutes before auto-pause.
    /// Default: 30. Clamped [1, 240].
    #[serde(deserialize_with = "u32_bounds::deserialize")]
    pub max_elapsed_minutes: u32,
    pub allow_auto_access: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSettings {
    pub language: LanguageCode,
    pub default_access_mode: AccessMode,
    pub full_access_enabled: bool,
    pub last_selected_model_id: Option<String>,
    pub show_in_menu_bar: bool,
    pub show_menu_bar_text: bool,
    pub stay_signed_in: bool,
    pub prevent_sleep_while_running: bool,
    pub completion_notifications: CompletionNotificationMode,
    pub permission_notifications: bool,
    pub question_notifications: bool,
    pub response_enhancements_enabled: bool,
    pub personality: PersonalityMode,
    pub custom_instructions: String,
    pub trusted_commands: Vec<TrustedCommandRule>,
    #[serde(default)]
    pub custom_slash_commands: Vec<CustomSlashCommand>,
    pub memories_enabled: bool,
    pub chronicle_preview: bool,
    pub ignore_tool_chats_for_memory: bool,
    pub goal_mode: GoalModeSettings,
    pub updates: UpdateSettings,
    /// Consent for vision fallback (spawn a vision-capable model to
    /// describe images when the selected model can't see). Default: Ask.
    #[serde(default)]
    pub vision_fallback_consent: VisionFallbackConsent,
    #[serde(default)]
    pub video_fallback_consent: VideoFallbackConsent,
    /// Paths of untrusted skills (project-root skills) the user has approved
    /// with "Always Allow". Trusted skills (user/legacy roots) don't need
    /// approval — they pass through directly. This list persists the user's
    /// decision so they're only prompted once per untrusted skill.
    #[serde(default)]
    pub trusted_skills: Vec<String>,
    /// Avatar configuration: how the user's profile picture is rendered.
    /// `None` (absent in settings.json) → defaults to initials. The renderer
    /// also mirrors this to localStorage as a redundancy, but this is the
    /// source of truth — `update_user_settings` returns settings WITH this
    /// field so the avatar doesn't reset on reload.
    #[serde(default)]
    pub avatar: Option<AvatarSettings>,
    /// When true, Review-panel commits append a Co-Authored-By trailer for
    /// Verboo Code. Default false (opt-in). Missing field deserializes as false.
    #[serde(default)]
    pub include_verboo_co_author: bool,
    /// Per-model persisted effort level (e.g. {"ultra/glm-5.2": "high"}).
    /// Keyed by model id; value is the effort level string. Empty by default.
    #[serde(default)]
    pub effort_by_model: std::collections::HashMap<String, String>,
    /// When true (default), the backend fetches plugin icons from the
    /// plugin's homepage domain on-demand (never preemptive). When false,
    /// `plugin_icon` returns `None` without any network request — the FE
    /// renders a monogram fallback. Privacy toggle: users who don't want
    /// any outbound requests to third-party plugin sites can disable it.
    #[serde(default = "default_true")]
    pub load_web_icons: bool,
}

/// Default function for `load_web_icons`. Used by `#[serde(default = ...)]`
/// so existing settings.json files without the field parse as `true`.
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuBarState {
    pub execution: String,
    pub label: Option<String>,
    pub started_at: Option<i64>,
    pub model_id: Option<String>,
    pub model_display_name: Option<String>,
    pub context_window: Option<u32>,
    pub context_usage: Option<u32>,
    pub working_directory: Option<String>,
    pub logged_in: Option<bool>,
    pub email: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: SkillSource,
    pub trusted: bool,
    /// `true` when the skill is actually a plugin mention (no path, just a
    /// name + description referencing a plugin's MCP tools/skills).
    /// Frontend sends `isPluginMention`; defaults to `false` for normal skills.
    #[serde(default)]
    pub is_plugin_mention: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMeta {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub kind: AttachmentKind,
    pub media_type: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Text extracted from the file at attach time (e.g. PDF text layer).
    /// When present, this is injected into the prompt so any model — vision
    /// or not — can reason about the content. Absence means no extraction
    /// was attempted or the file is only usable via vision (image/PDF-as-image).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extracted_text: Option<String>,
    /// Whether `extracted_text` holds real content (`Extracted`) or a
    /// warning string (`Warning` — scanned/corrupt/too-large). Absent
    /// when no extraction was attempted (non-PDF, image).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extraction_status: Option<ExtractionStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<VideoStreamMetadata>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStreamMetadata {
    pub duration_ms: u64,
    pub container: String,
    pub video_codec: String,
    pub audio_codec: Option<String>,
    pub width: u32,
    pub height: u32,
    pub avg_fps: f64,
    pub has_audio: bool,
    pub hdr: VideoHdrKind,
    pub color_primaries: Option<String>,
    pub color_transfer: Option<String>,
    pub bit_depth: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMediaCapabilities {
    pub image: bool,
    pub video: bool,
    pub audio: bool,
    pub video_containers: Vec<String>,
    pub video_codecs: Vec<String>,
    pub accepts_hdr_video: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliMediaCapabilities {
    pub image_blocks: bool,
    pub video_blocks: bool,
    pub audio_blocks: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoProgress {
    pub job_id: String,
    pub turn_id: String,
    pub stage: VideoProgressStage,
    pub completed_units: Option<u32>,
    pub total_units: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnRequest {
    pub turn_id: Option<String>,
    pub conversation_id: String,
    pub message: String,
    pub model: Option<String>,
    pub model_supports_vision: Option<bool>,
    #[serde(default)]
    pub run_vision_fallback: Option<bool>,
    #[serde(default)]
    pub media_capabilities: Option<ModelMediaCapabilities>,
    #[serde(default)]
    pub cli_media_capabilities: Option<CliMediaCapabilities>,
    #[serde(default)]
    pub run_video_analysis: Option<bool>,
    /// Reasoning effort level for this turn (e.g. "low", "medium", "high",
    /// "max", "none"). Sent to the CLI as `--effort <level>` only when it is
    /// a valid override — i.e. present, non-empty, and listed in the model's
    /// `reasoning.effort_levels`. Absent or invalid → `--effort` is omitted
    /// and the CLI applies the model's `default_effort`. See
    /// `resolve_effort_arg` in turn_service.
    #[serde(default)]
    pub effort: Option<String>,
    /// Reasoning capability for the resolved model, promoted from the
    /// Router's raw JSON. Used to validate `effort` against
    /// `effort_levels` before sending `--effort` to the CLI. Absent when
    /// the model has no reasoning metadata (no `--effort` sent).
    #[serde(default)]
    pub reasoning: Option<ModelReasoning>,
    pub context_window: Option<u32>,
    pub response_language: Option<LanguageCode>,
    pub access_mode: AccessMode,
    pub working_directory: String,
    pub skills: Vec<SkillSummary>,
    pub attachments: Option<Vec<AttachmentMeta>>,
    pub response_enhancements_enabled: Option<bool>,
    pub personality: Option<PersonalityMode>,
    pub custom_instructions: Option<String>,
    pub memory_context: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResultSnapshot {
    pub turn_id: String,
    pub exit_code: Option<i32>,
    pub session_id: Option<String>,
    pub stop_reason: Option<String>,
    pub is_error: Option<bool>,
    pub usage: Option<TokenUsage>,
    pub permission_denials: Option<Vec<serde_json::Value>>,
    pub errors: Option<Vec<String>>,
    pub raw_result: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    pub cache_creation_input_tokens: Option<u32>,
    pub cache_read_input_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsageSnapshot {
    pub used_tokens: u64,
    pub max_tokens: Option<u64>,
    pub percentage: Option<f64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub source: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChangeEntry {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChangeSummary {
    pub files: Vec<WorkspaceChangeEntry>,
    pub total_files: u32,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalState {
    pub id: String,
    pub objective: String,
    pub status: GoalStatus,
    pub created_at: i64,
    pub updated_at: i64,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub paused_at: Option<i64>,
    pub pause_reason: Option<String>,
    pub last_evaluation: Option<GoalEvaluationResult>,
    pub last_session_id: Option<String>,
    pub last_turn_id: Option<String>,
    pub turns_run: u32,
    #[serde(deserialize_with = "u32_bounds::deserialize")]
    pub max_turns: u32,
    pub max_elapsed_ms: u64,
    pub max_input_tokens: Option<u64>,
    pub used_input_tokens: u64,
    pub used_output_tokens: u64,
    pub access_mode: AccessMode,
    pub model_id: Option<String>,
    pub model_display_name: Option<String>,
    pub working_directory: String,
    pub skills: Vec<SkillSummary>,
    pub no_progress_count: u32,
    pub recent_fingerprints: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalEvaluationInput {
    pub goal: GoalState,
    pub conversation_items: Vec<TranscriptItem>,
    pub context_usage: Option<ContextUsageSnapshot>,
    // G-C16-FIX2 (2026-07-29): `latest_result` was REMOVED deliberately.
    // The field had zero populators in renderer or Rust and contributed
    // nothing to the evaluator. Worse: it acted as a dead leg of the
    // G-C16 completion guard, and any future populator WITHOUT goal-scoped
    // uniqueness (e.g. via lastTurnId) would have reopened the F2 bypass
    // in old conversations — an inherited latest_result from another turn
    // would make the guard pass with no real action of the current goal.
    // If reintroducing this field is ever desired to enrich the evaluator
    // (e.g. last turn exit code, last turn errors), it MUST be goal-scoped
    // via lastTurnId AND come with a regression test proving no cross-goal
    // leak. See git history for the removed branch and field.
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptItem {
    pub id: String,
    pub role: String,
    pub text: String,
    pub timestamp: i64,
    pub kind: Option<String>,
    pub activity_kind: Option<String>,
    pub activity_detail: Option<String>,
    pub command: Option<CommandRun>,
    pub change_summary: Option<WorkspaceChangeSummary>,
    pub model_id: Option<String>,
    pub model_display_name: Option<String>,
    pub streaming: Option<bool>,
    pub skills: Option<Vec<SkillSummary>>,
    /// G-C18: captured output of a tool call (e.g. the literal content the
    /// agent read back via the Read tool). Optional because not every item
    /// has a tool call, and even those that do may not carry captured
    /// output. Renamed to `toolOutput` on the wire by `rename_all =
    /// "camelCase"` so the renderer can send it as-is.
    pub tool_output: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRun {
    pub input: String,
    pub output: String,
    pub status: CommandStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalEvaluationResult {
    pub decision: GoalDecision,
    pub reason_id: GoalReasonId,
    pub reason: String,
    pub session_summary: Option<String>,
    pub gaps: Vec<String>,
    pub next_action: Option<String>,
    pub completion_summary: Option<String>,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredConversation {
    pub id: String,
    pub title: String,
    pub cli_session_id: Option<String>,
    pub project_id: Option<String>,
    pub items: Vec<TranscriptItem>,
    pub goal: Option<GoalState>,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatProject {
    pub id: String,
    pub name: String,
    pub path: Option<String>,
    pub collapsed: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStore {
    pub version: u32,
    pub projects: Vec<ChatProject>,
    pub conversations: Vec<StoredConversation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSubagentRequest {
    pub id: String,
    pub index: u32,
    pub total: u32,
    pub label: Option<String>,
    pub topic: String,
    pub base_request: AgentTurnRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSubagentsRunRequest {
    pub run_id: Option<String>,
    pub count: u32,
    pub requested_count: Option<u32>,
    pub labels: Option<Vec<String>>,
    pub base_request: AgentTurnRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSubagentResult {
    pub id: String,
    pub index: u32,
    pub status: AgentResultStatus,
    pub summary: String,
    pub findings: Vec<String>,
    pub sources: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackDiagnostics {
    pub app_version: String,
    pub platform: String,
    pub app_source: String,
    pub project_name: Option<String>,
    pub active_view: Option<String>,
    pub model_id: Option<String>,
    pub model_display_name: Option<String>,
    pub model_source: Option<String>,
    pub access_mode: Option<AccessMode>,
    pub context_window: Option<u32>,
    pub context_usage: Option<ContextUsageSnapshot>,
    pub auth_method: Option<String>,
    pub cli_logged_in: Option<bool>,
    pub has_api_key: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackRequest {
    pub category: FeedbackCategory,
    pub title: String,
    pub description: String,
    pub contact: Option<String>,
    pub include_diagnostics: bool,
    pub diagnostics: Option<FeedbackDiagnostics>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackResult {
    pub ok: bool,
    pub channel: FeedbackChannel,
    pub message: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub kind: RuntimeStatusKind,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeActivity {
    pub key: String,
    pub label: String,
    pub detail: Option<String>,
    pub kind: String,
    pub tool_use_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additions: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletions: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_preview: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    #[serde(rename = "type")]
    pub event_type: EventType,
    pub turn_id: Option<String>,
    pub conversation_id: Option<String>,
    pub text: Option<String>,
    pub payload: Option<serde_json::Value>,
    pub result: Option<AgentResultSnapshot>,
    pub subagent_thread: Option<SubagentThreadUpdate>,
    pub message: Option<String>,
    pub exit_code: Option<i32>,
    pub runtime_status: Option<RuntimeStatus>,
    pub runtime_activity: Option<RuntimeActivity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_progress: Option<VideoProgress>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReviewCapabilities {
    pub can_diff: bool,
    pub can_revert: bool,
    pub can_open_external: bool,
    pub can_commit: bool,
    pub can_create_pr: bool,
    pub can_push: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCommitResult {
    pub ok: bool,
    pub commit_hash: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePullRequestResult {
    pub ok: bool,
    pub url: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReviewMetadata {
    pub scope: WorkspaceReviewScope,
    pub title: String,
    pub subtitle: String,
    pub is_git_repository: bool,
    pub is_github_repository: bool,
    pub repository_root: Option<String>,
    pub current_branch: Option<String>,
    pub upstream_branch: Option<String>,
    pub capabilities: WorkspaceReviewCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ahead_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behind_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_upstream: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_remote: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_commit_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_commit_subject: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePushResult {
    pub ok: bool,
    pub remote: Option<String>,
    pub branch: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBranch {
    pub name: String,
    pub current: bool,
    pub remote: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBranchInfo {
    pub current_branch: Option<String>,
    pub upstream_branch: Option<String>,
    pub branches: Vec<WorkspaceBranch>,
    pub can_switch: bool,
    pub dirty: bool,
    pub dirty_files: Vec<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBranchSwitchResult {
    pub ok: bool,
    pub message: Option<String>,
    pub branch_info: Option<WorkspaceBranchInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffLine {
    pub kind: DiffLineKind,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffHunk {
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<FileDiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub status: FileDiffStatus,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
    pub truncated: bool,
    pub hunks: Vec<FileDiffHunk>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffResponse {
    pub ok: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnapshot {
    pub status: UpdateStatus,
    pub channel: UpdateChannel,
    pub current_version: String,
    pub available_version: Option<String>,
    pub release_name: Option<String>,
    pub release_date: Option<String>,
    pub release_notes: Option<String>,
    pub percent: Option<f64>,
    pub transferred_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub bytes_per_second: Option<f64>,
    pub last_checked_at: Option<i64>,
    pub downloaded_at: Option<i64>,
    pub error: Option<String>,
    /// `true` when the Stable channel endpoint responded with a valid
    /// manifest (so a stable build exists). `false` when the channel is
    /// missing (404), network error, or manifest was malformed.
    ///
    /// Fail-closed: any doubt yields `false`. The renderer uses this to
    /// enable the "Stable" channel button in Settings; while the stable
    /// release channel does not exist, the button must stay disabled so
    /// users cannot accidentally select a channel with no manifest.
    ///
    /// Populated by `UpdateService::run_stable_probe` (see
    /// `src-tauri/src/services/update_service.rs`), which is called from
    /// `check_for_updates` in `src-tauri/src/lib.rs` after the active
    /// channel probe completes. No extra timer is needed — the probe
    /// rides along the existing periodic check.
    #[serde(default)]
    pub stable_channel_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalSession {
    pub id: String,
    pub cwd: String,
    pub shell: String,
    pub created_at: i64,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalStartRequest {
    pub cwd: String,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDataEvent {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEvent {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalErrorEvent {
    pub session_id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnAction {
    pub kind: TurnActionKind,
    pub label: String,
    pub detail: Option<String>,
    pub command: Option<CommandRun>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenRateSnapshot {
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub tokens_per_second: Option<f64>,
    pub requests_per_minute: Option<f64>,
    pub source: String,
    pub updated_at: i64,
}

// ── Settings defaults (must match Electron's defaultUserSettings exactly) ─

impl Default for UserSettings {
    fn default() -> Self {
        Self {
            language: LanguageCode::EnUs,
            default_access_mode: AccessMode::Approval,
            full_access_enabled: false,
            last_selected_model_id: None,
            show_in_menu_bar: true,
            show_menu_bar_text: true,
            stay_signed_in: true,
            prevent_sleep_while_running: true,
            completion_notifications: CompletionNotificationMode::Background,
            permission_notifications: true,
            question_notifications: true,
            response_enhancements_enabled: false,
            personality: PersonalityMode::Pragmatic,
            custom_instructions: String::new(),
            trusted_commands: Vec::new(),
            custom_slash_commands: Vec::new(),
            memories_enabled: false,
            chronicle_preview: false,
            ignore_tool_chats_for_memory: true,
            goal_mode: GoalModeSettings {
                enabled: true,
                max_turns: 999,
                max_elapsed_minutes: 99999,
                allow_auto_access: true,
            },
            updates: UpdateSettings {
                channel: UpdateChannel::Beta,
                auto_check: true,
                auto_download: false,
            },
            vision_fallback_consent: VisionFallbackConsent::Ask,
            video_fallback_consent: VideoFallbackConsent::Ask,
            trusted_skills: Vec::new(),
            avatar: None,
            include_verboo_co_author: false,
            effort_by_model: std::collections::HashMap::new(),
            load_web_icons: true,
        }
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            working_directory: std::env::current_dir()
                .unwrap_or_else(|_| dirs::home_dir().unwrap_or_default())
                .to_string_lossy()
                .to_string(),
            access_mode: AccessMode::Approval,
            platform: if cfg!(target_os = "macos") {
                Platform::Darwin
            } else if cfg!(target_os = "windows") {
                Platform::Win32
            } else {
                Platform::Linux
            },
            selected_model: None,
        }
    }
}

// ════════════════════════════════════════════════════════════════════
// Tests — round-trip serde for camelCase/kebab-case contracts
// ════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_settings_round_trip_camel_case() {
        let settings = UserSettings::default();
        let json = serde_json::to_string(&settings).expect("serialize");
        // Spot-check camelCase field names
        assert!(json.contains("\"defaultAccessMode\""));
        assert!(json.contains("\"fullAccessEnabled\""));
        assert!(json.contains("\"lastSelectedModelId\""));
        assert!(json.contains("\"showInMenuBar\""));
        assert!(json.contains("\"goalMode\""));
        assert!(json.contains("\"maxTurns\""));
        assert!(json.contains("\"maxElapsedMinutes\""));
        assert!(json.contains("\"allowAutoAccess\""));
        let back: UserSettings = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.language, settings.language);
        assert_eq!(back.default_access_mode, settings.default_access_mode);
        assert_eq!(back.goal_mode.max_turns, settings.goal_mode.max_turns);
        assert_eq!(back.updates.channel, settings.updates.channel);
    }

    #[test]
    fn load_web_icons_defaults_true_when_absent() {
        // Backwards-compat: existing settings.json files without the
        // `loadWebIcons` field must deserialize as `true` (privacy toggle
        // defaults on — icons fetched on-demand). This is the
        // `#[serde(default = "default_true")]` contract.
        let raw = r#"{
            "language": "en-US",
            "defaultAccessMode": "approval",
            "fullAccessEnabled": false,
            "showInMenuBar": true,
            "showMenuBarText": true,
            "staySignedIn": true,
            "preventSleepWhileRunning": true,
            "completionNotifications": "background",
            "permissionNotifications": true,
            "questionNotifications": true,
            "responseEnhancementsEnabled": false,
            "personality": "pragmatic",
            "customInstructions": "",
            "trustedCommands": [],
            "memoriesEnabled": false,
            "chroniclePreview": false,
            "ignoreToolChatsForMemory": true,
            "goalMode": { "enabled": true, "maxTurns": 999, "maxElapsedMinutes": 99999, "allowAutoAccess": true },
            "updates": { "channel": "beta", "autoCheck": true, "autoDownload": false }
        }"#;
        let s: UserSettings = serde_json::from_str(raw).expect("parse");
        assert!(
            s.load_web_icons,
            "loadWebIcons must default to true when absent"
        );
    }

    #[test]
    fn user_settings_defaults_match_electron() {
        // Mirror of Electron's defaultUserSettings (settingsService.ts).
        let d = UserSettings::default();
        assert_eq!(d.language, LanguageCode::EnUs);
        assert_eq!(d.default_access_mode, AccessMode::Approval);
        assert!(!d.full_access_enabled);
        assert!(d.show_in_menu_bar);
        assert!(d.show_menu_bar_text);
        assert!(d.stay_signed_in);
        assert!(d.prevent_sleep_while_running);
        assert!(!d.include_verboo_co_author);
        assert_eq!(
            d.completion_notifications,
            CompletionNotificationMode::Background
        );
        assert!(d.permission_notifications);
        assert!(d.question_notifications);
        assert!(!d.response_enhancements_enabled);
        assert_eq!(d.personality, PersonalityMode::Pragmatic);
        assert!(d.custom_slash_commands.is_empty());
        assert!(!d.memories_enabled);
        assert!(!d.chronicle_preview);
        assert!(d.ignore_tool_chats_for_memory);
        assert!(d.goal_mode.enabled);
        assert_eq!(d.goal_mode.max_turns, 999);
        assert_eq!(d.goal_mode.max_elapsed_minutes, 99999);
        assert!(d.goal_mode.allow_auto_access);
        assert_eq!(d.updates.channel, UpdateChannel::Beta);
        assert!(d.updates.auto_check);
        // Electron default is `false` (auto_download); `normalize()` forces
        // it to `true` on read, but `reset_user_settings` returns the raw
        // default, so we match Electron's literal default here.
        assert!(!d.updates.auto_download);
    }

    #[test]
    fn app_config_serializes_camel_case() {
        let config = AppConfig::default();
        let json = serde_json::to_string(&config).expect("serialize");
        assert!(json.contains("\"workingDirectory\""));
        assert!(json.contains("\"accessMode\""));
        assert!(json.contains("\"platform\""));
        assert!(json.contains("\"selectedModel\""));
    }

    #[test]
    fn enums_serialize_as_expected() {
        // kebab-case
        assert_eq!(serde_json::to_string(&ThemeMode::Dark).unwrap(), "\"dark\"");
        assert_eq!(
            serde_json::to_string(&SettingsTab::TrustedCommands).unwrap(),
            "\"trusted-commands\""
        );
        // lowercase
        assert_eq!(
            serde_json::to_string(&AccessMode::Full).unwrap(),
            "\"full\""
        );
        assert_eq!(
            serde_json::to_string(&Platform::Win32).unwrap(),
            "\"win32\""
        );
        // renamed
        assert_eq!(
            serde_json::to_string(&LanguageCode::PtBr).unwrap(),
            "\"pt-BR\""
        );
        assert_eq!(
            serde_json::to_string(&UpdateStatus::NotAvailable).unwrap(),
            "\"not-available\""
        );
    }

    #[test]
    fn install_update_result_serializes_for_renderer() {
        let result = InstallUpdateResult {
            status: InstallUpdateStatus::Busy,
            active_turns: 2,
        };
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({ "status": "busy", "activeTurns": 2 })
        );
    }

    #[test]
    fn agent_event_type_field_renamed() {
        // The `event_type` field must serialize as `type` to match the TS type.
        let event = AgentEvent {
            event_type: EventType::Started,
            turn_id: Some("t1".into()),
            conversation_id: Some("c1".into()),
            text: None,
            payload: None,
            result: None,
            message: None,
            exit_code: None,
            runtime_status: None,
            runtime_activity: None,
            subagent_thread: None,
            video_progress: None,
        };
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"started\""));
        assert!(!json.contains("eventType"));
    }

    #[test]
    fn video_contract_round_trips_with_camel_case_wire_names() {
        let attachment = AttachmentMeta {
            path: "/tmp/clip.mov".into(),
            name: "clip.mov".into(),
            size: 42,
            kind: AttachmentKind::Video,
            media_type: Some("video/quicktime".into()),
            width: Some(1920),
            height: Some(1080),
            extracted_text: None,
            extraction_status: None,
            video: Some(VideoStreamMetadata {
                duration_ms: 1_000,
                container: "mov".into(),
                video_codec: "h264".into(),
                audio_codec: Some("aac".into()),
                width: 1920,
                height: 1080,
                avg_fps: 29.97,
                has_audio: true,
                hdr: VideoHdrKind::DolbyVision,
                color_primaries: Some("bt2020".into()),
                color_transfer: Some("smpte2084".into()),
                bit_depth: Some(10),
            }),
        };
        let attachment_json = serde_json::to_value(&attachment).expect("serialize attachment");
        assert_eq!(attachment_json["kind"], "video");
        assert_eq!(attachment_json["video"]["durationMs"], 1_000);
        assert_eq!(attachment_json["video"]["videoCodec"], "h264");
        assert_eq!(attachment_json["video"]["hdr"], "dolbyVision");
        let attachment_back: AttachmentMeta =
            serde_json::from_value(attachment_json).expect("deserialize attachment");
        assert_eq!(attachment_back.video.expect("video metadata").bit_depth, Some(10));

        let event = AgentEvent {
            event_type: EventType::VideoProgress,
            turn_id: Some("turn-1".into()),
            conversation_id: None,
            text: None,
            payload: None,
            result: None,
            subagent_thread: None,
            message: None,
            exit_code: None,
            runtime_status: None,
            runtime_activity: None,
            video_progress: Some(VideoProgress {
                job_id: "job-1".into(),
                turn_id: "turn-1".into(),
                stage: VideoProgressStage::Analyzing,
                completed_units: Some(2),
                total_units: Some(4),
            }),
        };
        let event_json = serde_json::to_value(&event).expect("serialize event");
        assert_eq!(event_json["type"], "video-progress");
        assert_eq!(event_json["videoProgress"]["completedUnits"], 2);
    }

    // ── AvatarSettings round-trip tests ──────────────────────────────

    #[test]
    fn avatar_settings_upload_version_round_trip() {
        // Prove that uploadVersion survives a serialize → deserialize cycle.
        // Before the fix, the Rust struct had no upload_version field, so the
        // TS uploadVersion was silently discarded during settings round-trip.
        let avatar = AvatarSettings {
            kind: AvatarKind::Upload,
            preset_id: None,
            preset_color: None,
            upload_path: Some("/appdata/avatar.png".into()),
            upload_version: Some(1234567890),
        };
        let json = serde_json::to_string(&avatar).expect("serialize");
        // Wire format must be camelCase (uploadVersion, not upload_version).
        assert!(
            json.contains("\"uploadVersion\":1234567890"),
            "expected camelCase uploadVersion in JSON, got: {json}"
        );
        let back: AvatarSettings = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, avatar, "round-trip must be lossless");
        assert_eq!(back.upload_version, Some(1234567890));
    }

    #[test]
    fn avatar_settings_upload_version_absent_defaults_to_none() {
        // Old JSON (without uploadVersion) must deserialize to None —
        // backward compatible with settings.json from previous versions.
        let json = r#"{"kind":"upload","uploadPath":"/appdata/avatar.png"}"#;
        let avatar: AvatarSettings = serde_json::from_str(json).expect("deserialize");
        assert_eq!(avatar.kind, AvatarKind::Upload);
        assert_eq!(avatar.upload_path.as_deref(), Some("/appdata/avatar.png"));
        assert_eq!(
            avatar.upload_version, None,
            "absent field must default to None"
        );
    }

    #[test]
    fn avatar_settings_upload_version_skipped_when_none() {
        // When upload_version is None, it must NOT appear in the serialized
        // JSON (skip_serializing_if = Option::is_none). This keeps the wire
        // format clean and matches the TS optional field.
        let avatar = AvatarSettings {
            kind: AvatarKind::Initials,
            preset_id: None,
            preset_color: None,
            upload_path: None,
            upload_version: None,
        };
        let json = serde_json::to_string(&avatar).expect("serialize");
        assert!(
            !json.contains("uploadVersion"),
            "None upload_version must be skipped, got: {json}"
        );
        assert!(
            !json.contains("uploadPath"),
            "None upload_path must be skipped, got: {json}"
        );
    }

    #[test]
    fn avatar_settings_in_user_settings_round_trip() {
        // Full UserSettings round-trip with avatar.uploadVersion set —
        // proves the version survives the settings store cycle.
        let mut settings = UserSettings::default();
        settings.avatar = Some(AvatarSettings {
            kind: AvatarKind::Upload,
            preset_id: None,
            preset_color: None,
            upload_path: Some("/appdata/avatar.webp".into()),
            upload_version: Some(99),
        });
        let json = serde_json::to_string(&settings).expect("serialize");
        assert!(
            json.contains("\"uploadVersion\":99"),
            "uploadVersion must be in the serialized UserSettings, got: {json}"
        );
        let back: UserSettings = serde_json::from_str(&json).expect("deserialize");
        // UserSettings doesn't derive PartialEq, so check the avatar fields.
        let back_avatar = back.avatar.expect("avatar must survive round-trip");
        assert_eq!(back_avatar.kind, AvatarKind::Upload);
        assert_eq!(
            back_avatar.upload_path.as_deref(),
            Some("/appdata/avatar.webp")
        );
        assert_eq!(
            back_avatar.upload_version,
            Some(99),
            "uploadVersion must survive round-trip"
        );
    }

    // ── u32_bounds diagnostic deserializer tests ────────────────────

    #[test]
    fn goal_state_max_turns_rejects_overflow_with_diagnostic_message() {
        // G-C7: the root cause — renderer sends Number.MAX_SAFE_INTEGER.
        // The error must be DIAGNOSTIC, not generic serde noise.
        let json = r#"{
            "id": "g1", "objective": "test", "status": "active",
            "createdAt": 0, "updatedAt": 0,
            "turnsRun": 0, "maxTurns": 9007199254740991,
            "maxElapsedMs": 0, "usedInputTokens": 0, "usedOutputTokens": 0,
            "accessMode": "approval", "workingDirectory": "/tmp",
            "skills": [], "recentFingerprints": []
        }"#;
        let err = serde_json::from_str::<GoalState>(json)
            .expect_err("must reject Number.MAX_SAFE_INTEGER");
        let msg = err.to_string();
        assert!(
            msg.contains("9007199254740991"),
            "error must name the offending value, got: {msg}"
        );
        assert!(
            msg.contains("overflows u32"),
            "error must say 'overflows u32', got: {msg}"
        );
        assert!(
            msg.contains("4294967295"),
            "error must suggest the u32::MAX sentinel, got: {msg}"
        );
    }

    #[test]
    fn goal_state_max_turns_accepts_u32_max() {
        // G-C7: 4294967295 (u32::MAX) is the "no limit" sentinel.
        let json = r#"{
            "id": "g1", "objective": "test", "status": "active",
            "createdAt": 0, "updatedAt": 0,
            "turnsRun": 0, "maxTurns": 4294967295,
            "maxElapsedMs": 0, "usedInputTokens": 0, "usedOutputTokens": 0,
            "accessMode": "approval", "workingDirectory": "/tmp",
            "skills": [], "noProgressCount": 0, "recentFingerprints": []
        }"#;
        let goal: GoalState = serde_json::from_str(json).expect("u32::MAX must be accepted");
        assert_eq!(goal.max_turns, u32::MAX);
    }

    #[test]
    fn goal_state_max_turns_accepts_normal_values() {
        let json = r#"{
            "id": "g1", "objective": "test", "status": "active",
            "createdAt": 0, "updatedAt": 0,
            "turnsRun": 3, "maxTurns": 999,
            "maxElapsedMs": 0, "usedInputTokens": 0, "usedOutputTokens": 0,
            "accessMode": "approval", "workingDirectory": "/tmp",
            "skills": [], "noProgressCount": 0, "recentFingerprints": []
        }"#;
        let goal: GoalState = serde_json::from_str(json).expect("normal u32 must be accepted");
        assert_eq!(goal.max_turns, 999);
    }

    #[test]
    fn goal_mode_settings_max_turns_rejects_overflow() {
        let json = r#"{"enabled": true, "maxTurns": 9007199254740991, "maxElapsedMinutes": 99999, "allowAutoAccess": true}"#;
        let err = serde_json::from_str::<GoalModeSettings>(json)
            .expect_err("must reject overflow in GoalModeSettings.max_turns");
        let msg = err.to_string();
        assert!(msg.contains("overflows u32"), "got: {msg}");
    }

    #[test]
    fn goal_mode_settings_max_elapsed_minutes_rejects_overflow() {
        let json = r#"{"enabled": true, "maxTurns": 999, "maxElapsedMinutes": 9007199254740991, "allowAutoAccess": true}"#;
        let err = serde_json::from_str::<GoalModeSettings>(json)
            .expect_err("must reject overflow in GoalModeSettings.max_elapsed_minutes");
        let msg = err.to_string();
        assert!(msg.contains("overflows u32"), "got: {msg}");
    }

    #[test]
    fn u32_bounds_rejects_negative_float() {
        // Negative floats should not panic — they should produce a diagnostic error.
        let json = r#"{"enabled": true, "maxTurns": -1.5, "maxElapsedMinutes": 30, "allowAutoAccess": true}"#;
        let err = serde_json::from_str::<GoalModeSettings>(json)
            .expect_err("must reject negative float");
        let msg = err.to_string();
        assert!(
            msg.contains("not a valid u32") || msg.contains("overflows u32"),
            "got: {msg}"
        );
    }

    #[test]
    fn u32_bounds_rejects_string_for_u32_field() {
        let json = r#"{"enabled": true, "maxTurns": "unlimited", "maxElapsedMinutes": 30, "allowAutoAccess": true}"#;
        let err = serde_json::from_str::<GoalModeSettings>(json)
            .expect_err("must reject string for u32 field");
        let msg = err.to_string();
        assert!(
            msg.contains("expected a number"),
            "got: {msg}"
        );
    }

    #[test]
    fn goal_state_max_turns_rejects_i64_min() {
        // i64::MIN as JSON — negative, should not panic.
        let json = r#"{
            "id": "g1", "objective": "test", "status": "active",
            "createdAt": 0, "updatedAt": 0,
            "turnsRun": 0, "maxTurns": -9223372036854775808,
            "maxElapsedMs": 0, "usedInputTokens": 0, "usedOutputTokens": 0,
            "accessMode": "approval", "workingDirectory": "/tmp",
            "skills": [], "recentFingerprints": []
        }"#;
        let err = serde_json::from_str::<GoalState>(json)
            .expect_err("must reject i64::MIN");
        let msg = err.to_string();
        assert!(
            msg.contains("not a valid u32") || msg.contains("overflows u32"),
            "got: {msg}"
        );
    }
}
