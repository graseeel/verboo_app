//! Computer Use types — request/response shapes for the CU subsystem.
//!
//! Mirrors Kratos arch §2 (session state machine) and §7 (skill CLI surface).
//! Wire shape is Orca-compatible so the existing `~/.verboo/skills/computer-use/SKILL.md`
//! agent skill works unchanged.

use serde::{Deserialize, Serialize};

/// Re-export Kratos's authoritative type so SessionManager/ComputerUseService
/// use the same enum without a second source of truth.
pub use crate::models::types::ComputerUseScope;

/// Session state machine (Kratos arch §2.1).
///
/// Transitions:
///   IDLE → CONSENT (user invokes /computer-use or agent requests)
///   CONSENT → ACTIVE (grant) | IDLE (deny or 30s timeout)
///   ACTIVE → PAUSED (pause) | STOPPED (stop/Esc/app_quit/os_revoke/audit_full)
///   PAUSED → ACTIVE (resume) | STOPPED (stop)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Idle,
    Consent,
    Active,
    Paused,
    Stopped,
}

/// Reason a session transitioned to STOPPED. Drives audit row + renderer toast.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    UserCancelled,
    EmergencyStop,
    SessionExpired,
    OsPermissionRevoked,
    TargetGone,
    AuditStorageFull,
    AppQuit,
    IdleExpired,
    SelfTestScopeViolation,
    Error,
}

/// Reason consent was denied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DenyReason {
    UserDenied,
    Timeout,
    PolicyBlock,
}

/// Scope of permitted actions for a session (Kratos arch §2.2 Layer 4).
/// Re-exported from `types::ComputerUseScope` for convenience.
pub type ActionScope = ComputerUseScope;

/// A consent request awaiting user decision. Created by `request_session`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsentRequest {
    pub id: String,
    pub goal: String,
    pub app: Option<String>,
    pub scope: ActionScope,
    pub created_at_mono: u64,
    pub created_at_wall: u64,
}

/// User's grant of consent. Carries the allowlist snapshot the user agreed to.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsentGrant {
    pub id: String,
    pub allowlist_version: u64,
    pub self_test_enabled: bool,
    pub screenshot_attach_to_llm: bool,
    pub idle_timeout_secs: u64,
}

/// Active session — gates every CU action (Kratos arch §2.2).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub state: SessionState,
    pub goal: String,
    pub target_app: Option<String>,
    pub scope: ActionScope,
    pub allowlist_version: u64,
    pub self_test_enabled: bool,
    pub screenshot_attach_to_llm: bool,
    pub pid_lock: u32,
    pub started_at_mono: u64,
    pub started_at_wall: u64,
    pub last_activity_mono: u64,
    pub idle_timeout_secs: u64,
}

/// Verdict returned by `SessionManager::check_action`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionVerdict {
    Allow,
    Deny(DenyCode),
}

/// Action-level deny codes (Kratos arch §7.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DenyCode {
    NoActiveSession,
    SessionPaused,
    ScopeDenied,
    AppNotAllowlisted,
    AppHardBlocked,
    SelfTestScopeViolation,
    SecureTextField,
    RateLimited,
    AuditWriteFailed,
    EmergencyStop,
    ConsentExpired,
    ProviderDown,
    TamperDetected,
    OsPermissionRevoked,
}

impl DenyCode {
    pub fn as_str(self) -> &'static str {
        match self {
            DenyCode::NoActiveSession => "no_active_session",
            DenyCode::SessionPaused => "session_paused",
            DenyCode::ScopeDenied => "scope_denied",
            DenyCode::AppNotAllowlisted => "app_not_allowlisted",
            DenyCode::AppHardBlocked => "app_hard_blocked",
            DenyCode::SelfTestScopeViolation => "self_test_scope_violation",
            DenyCode::SecureTextField => "secure_text_field",
            DenyCode::RateLimited => "rate_limited",
            DenyCode::AuditWriteFailed => "audit_write_failed",
            DenyCode::EmergencyStop => "emergency_stop",
            DenyCode::ConsentExpired => "consent_expired",
            DenyCode::ProviderDown => "provider_down",
            DenyCode::TamperDetected => "tamper_detected",
            DenyCode::OsPermissionRevoked => "os_permission_revoked",
        }
    }
}

/// Audit row (Kratos arch §6.3). INSERT-only — never UPDATE/DELETE.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditRow {
    pub ts_mono: u64,
    pub ts_wall: u64,
    pub session_id: String,
    pub conversation_id: Option<String>,
    pub turn_id: Option<String>,
    pub actor: AuditActor,
    pub app_bundle_id: Option<String>,
    pub window_title: Option<String>,
    pub action_type: String,
    pub action_summary: Option<String>,
    pub action_args: Option<String>, // JSON; secrets redacted via --text-stdin
    pub outcome: AuditOutcome,
    pub result_detail: Option<String>,
    pub bytes: Option<i64>,
    pub thumbnail_hash: Option<String>,
    pub screenshot_path: Option<String>,
    pub screenshot_attach_to_llm: bool,
    pub is_self_test: bool,
    pub prev_hash: String,
    pub row_hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuditActor {
    User,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditOutcome {
    Pending,
    Success,
    Denied,
    Blocked,
    Error,
    Aborted,
    Stale,
    Paused,
    RateLimited,
}

impl AuditOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            AuditOutcome::Pending => "pending",
            AuditOutcome::Success => "success",
            AuditOutcome::Denied => "denied",
            AuditOutcome::Blocked => "blocked",
            AuditOutcome::Error => "error",
            AuditOutcome::Aborted => "aborted",
            AuditOutcome::Stale => "stale",
            AuditOutcome::Paused => "paused",
            AuditOutcome::RateLimited => "rate_limited",
        }
    }
}

/// Allowlist entry (Layer 2 — Rust enforced, Kratos arch §6.5).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllowlistEntry {
    pub bundle_id: String,
    pub display_name: String,
    pub scope: ActionScope,
    pub added_at_wall: u64,
}

/// Result of a CU command — returned to Tauri command layer.
#[derive(Debug, Clone, Serialize)]
pub struct ComputerUseResult {
    pub result: Option<serde_json::Value>,
    pub error: Option<ComputerUseError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ComputerUseError {
    pub code: String,
    pub message: String,
}

impl ComputerUseError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl From<DenyCode> for ComputerUseError {
    fn from(code: DenyCode) -> Self {
        let msg = match code {
            DenyCode::NoActiveSession => "No active Computer Use session. Invoke request_computer_use_session first.",
            DenyCode::SessionPaused => "Session is paused. Resume before issuing actions.",
            DenyCode::ScopeDenied => "Action not permitted by current scope.",
            DenyCode::AppNotAllowlisted => "Target app is not in the user-approved allowlist.",
            DenyCode::AppHardBlocked => "Target app is Tier 1 hard-blocked (System Settings, loginwindow, secure fields, or self-test blocked surface).",
            DenyCode::SelfTestScopeViolation => "Action attempted on blocked Verboo surface (Kratos §4.2.2).",
            DenyCode::SecureTextField => "Target is AXSecureTextField — never interact.",
            DenyCode::RateLimited => "Over rate cap; back off and retry.",
            DenyCode::AuditWriteFailed => "Audit write failed; action refused (failure-safe).",
            DenyCode::EmergencyStop => "Esc hotkey fired mid-action.",
            DenyCode::ConsentExpired => "Session was valid but consent invalidated (idle/reboot/etc).",
            DenyCode::ProviderDown => "Swift helper crashed or restarting.",
            DenyCode::TamperDetected => "Audit hash chain verification failed; CU locked.",
            DenyCode::OsPermissionRevoked => "macOS Accessibility or Screen Recording permission was revoked; Computer Use stopped.",
        };
        Self::new(code.as_str(), msg)
    }
}
