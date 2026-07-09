use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentKind {
    Image,
    File,
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
    Complete,
    Continue,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProfileStatus {
    Ready,
    Unauthenticated,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ResearchSubagentStatus {
    Queued,
    Running,
    Reading,
    Searching,
    Complete,
    Failed,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum EventType {
    Started,
    Stdout,
    Stderr,
    Json,
    Result,
    SubagentProgress,
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
    pub raw: serde_json::Value,
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
pub struct UpdateSettings {
    pub channel: UpdateChannel,
    pub auto_check: bool,
    pub auto_download: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalModeSettings {
    pub enabled: bool,
    pub max_turns: u32,
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
    pub memories_enabled: bool,
    pub chronicle_preview: bool,
    pub ignore_tool_chats_for_memory: bool,
    pub goal_mode: GoalModeSettings,
    pub updates: UpdateSettings,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnRequest {
    pub turn_id: Option<String>,
    pub conversation_id: String,
    pub message: String,
    pub model: Option<String>,
    pub model_supports_vision: Option<bool>,
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
    pub latest_result: Option<AgentResultSnapshot>,
    pub context_usage: Option<ContextUsageSnapshot>,
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
    pub confidence: f64,
    pub reason: String,
    pub evidence: Vec<String>,
    pub missing: Vec<String>,
    pub next_message: Option<String>,
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
    pub topic: String,
    pub base_request: AgentTurnRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSubagentsRunRequest {
    pub run_id: Option<String>,
    pub count: u32,
    pub requested_count: Option<u32>,
    pub base_request: AgentTurnRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchSubagentProgress {
    pub id: String,
    pub index: u32,
    pub total: Option<u32>,
    pub run_id: Option<String>,
    pub status: ResearchSubagentStatus,
    pub summary: String,
    pub activity: Option<String>,
    pub detail: Option<String>,
    pub mission: Option<String>,
    pub label: Option<String>,
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
    pub progress: Option<ResearchSubagentProgress>,
    pub message: Option<String>,
    pub exit_code: Option<i32>,
    pub runtime_status: Option<RuntimeStatus>,
    pub runtime_activity: Option<RuntimeActivity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReviewCapabilities {
    pub can_diff: bool,
    pub can_revert: bool,
    pub can_open_external: bool,
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
            memories_enabled: false,
            chronicle_preview: false,
            ignore_tool_chats_for_memory: true,
            goal_mode: GoalModeSettings {
                enabled: true,
                max_turns: 3,
                max_elapsed_minutes: 30,
                allow_auto_access: true,
            },
            updates: UpdateSettings {
                channel: UpdateChannel::Beta,
                auto_check: true,
                auto_download: false,
            },
        }
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            working_directory: std::env::current_dir()
                .unwrap_or_else(|_| {
                    dirs::home_dir().unwrap_or_default()
                })
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
        assert_eq!(d.completion_notifications, CompletionNotificationMode::Background);
        assert!(d.permission_notifications);
        assert!(d.question_notifications);
        assert!(!d.response_enhancements_enabled);
        assert_eq!(d.personality, PersonalityMode::Pragmatic);
        assert!(!d.memories_enabled);
        assert!(!d.chronicle_preview);
        assert!(d.ignore_tool_chats_for_memory);
        assert!(d.goal_mode.enabled);
        assert_eq!(d.goal_mode.max_turns, 3);
        assert_eq!(d.goal_mode.max_elapsed_minutes, 30);
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
        assert_eq!(
            serde_json::to_string(&ThemeMode::Dark).unwrap(),
            "\"dark\""
        );
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
    fn agent_event_type_field_renamed() {
        // The `event_type` field must serialize as `type` to match the TS type.
        let event = AgentEvent {
            event_type: EventType::Started,
            turn_id: Some("t1".into()),
            conversation_id: Some("c1".into()),
            text: None,
            payload: None,
            result: None,
            progress: None,
            message: None,
            exit_code: None,
            runtime_status: None,
            runtime_activity: None,
        };
        let json = serde_json::to_string(&event).expect("serialize");
        assert!(json.contains("\"type\":\"started\""));
        assert!(!json.contains("eventType"));
    }
}
