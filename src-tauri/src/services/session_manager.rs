//! Computer Use SessionManager (Kratos arch §2).
//!
//! State machine: IDLE → CONSENT → ACTIVE → PAUSED → STOPPED.
//! Single-writer PID lock (Q9 — single session in P0).
//!
//! Gates (arch §2.2): every action MUST pass `check_action` first.
//!   1. OS-permission gate — polled every 5s (TODO P0.2b).
//!   2. Session gate — current() returns ACTIVE.
//!   3. Allowlist gate — bundle ID in user-approved list.
//!   4. Scope gate — action category ≤ current scope.
//!   5. Audit gate — pending row INSERT succeeds BEFORE action.

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;

use crate::models::computer_use::{
    ActionScope, ActionVerdict, ConsentGrant, ConsentRequest, DenyCode, DenyReason,
    Session, SessionState, StopReason,
};

/// Hard-blocked bundle IDs (Tier 1, universal — Kratos arch §6.5).
/// Helper re-checks these as defense-in-depth; Rust also refuses here.
pub const HARD_BLOCKED_BUNDLE_IDS: &[&str] = &[
    "com.apple.systempreferences",
    "com.apple.loginwindow",
];

/// Consent request timeout (arch §2.1: 30s).
const CONSENT_TIMEOUT_SECS: u64 = 30;

/// Default idle timeout (Q7: 15 min, configurable 5-60).
const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 15 * 60;

/// Rate limits (arch §6.5 Layer 3).
const MAX_MUTATING_PER_MIN: u32 = 60;
const MAX_READ_PER_MIN: u32 = 600;

#[derive(Debug)]
struct RateBucket {
    mutating_count: u32,
    read_count: u32,
    window_start_mono: u64,
}

impl Default for RateBucket {
    fn default() -> Self {
        Self {
            mutating_count: 0,
            read_count: 0,
            window_start_mono: now_mono(),
        }
    }
}

/// Inner state guarded by Mutex.
#[derive(Debug, Default)]
struct Inner {
    /// Current session. None or Stopped means no actions allowed.
    current: Option<Session>,
    /// Pending consent request (created by request_session, consumed by grant/deny).
    pending_consent: Option<ConsentRequest>,
    /// User-approved allowlist (bundle_id → entry). Empty by default = default deny.
    allowlist: Vec<String>,
    /// Rate limiter bucket (1-min sliding window).
    rate: RateBucket,
    /// Emergency-stop flag — set by helper hotkey or `emergency_stop_all`.
    /// When true, all actions return EmergencyStop until next session.
    emergency_armed: bool,
}

#[derive(Clone)]
pub struct SessionManager {
    inner: Arc<Mutex<Inner>>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
        }
    }
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Step 1 of consent flow: create a pending request. Returns its ID.
    /// Does NOT activate — user must call grant_session(id, ...).
    /// If a previous pending request exists, it's overwritten (last-wins).
    pub fn request_session(
        &self,
        goal: impl Into<String>,
        app: Option<String>,
        scope: ActionScope,
    ) -> ConsentRequest {
        let now = now_mono();
        let wall = now_wall();
        let req = ConsentRequest {
            id: Uuid::new_v4().to_string(),
            goal: goal.into(),
            app,
            scope,
            created_at_mono: now,
            created_at_wall: wall,
        };
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        g.pending_consent = Some(req.clone());
        req
    }

    /// Step 2: user grants consent → session becomes ACTIVE.
    /// Returns the active session or error if no pending request or expired.
    pub fn grant_session(&self, grant: ConsentGrant) -> Result<Session, DenyCode> {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");

        // Check emergency-stop arming — can't start a new session while armed.
        if g.emergency_armed {
            return Err(DenyCode::EmergencyStop);
        }

        let pending = g.pending_consent.take().ok_or(DenyCode::NoActiveSession)?;

        // 30s timeout on consent.
        let now = now_mono();
        if now.saturating_sub(pending.created_at_mono) > CONSENT_TIMEOUT_SECS {
            return Err(DenyCode::ConsentExpired);
        }

        // PID single-writer lock (Q9): if a session already ACTIVE for a
        // different PID, refuse. In P0 we don't actually fork worker PIDs,
        // so this is the desktop process itself.
        let pid_lock = std::process::id();
        if let Some(existing) = &g.current {
            if existing.state == SessionState::Active && existing.pid_lock != pid_lock {
                // Single-writer violation. P0 invariant.
                return Err(DenyCode::NoActiveSession);
            }
        }

        let session = Session {
            id: pending.id,
            state: SessionState::Active,
            goal: pending.goal,
            scope: pending.scope,
            allowlist_version: grant.allowlist_version,
            self_test_enabled: grant.self_test_enabled,
            screenshot_attach_to_llm: grant.screenshot_attach_to_llm,
            pid_lock,
            started_at_mono: now,
            started_at_wall: now_wall(),
            last_activity_mono: now,
            idle_timeout_secs: DEFAULT_IDLE_TIMEOUT_SECS,
        };
        g.current = Some(session.clone());
        Ok(session)
    }

    /// User denies consent. Clears pending request, returns to IDLE.
    pub fn deny_session(&self, _id: &str, _reason: DenyReason) {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        g.pending_consent = None;
    }

    /// Pause an active session.
    pub fn pause(&self, id: &str) -> Result<Session, DenyCode> {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        let s = g.current.as_mut().ok_or(DenyCode::NoActiveSession)?;
        if s.id != id {
            return Err(DenyCode::NoActiveSession);
        }
        if s.state != SessionState::Active {
            return Err(DenyCode::SessionPaused);
        }
        s.state = SessionState::Paused;
        Ok(s.clone())
    }

    /// Resume a paused session.
    pub fn resume(&self, id: &str) -> Result<Session, DenyCode> {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        let s = g.current.as_mut().ok_or(DenyCode::NoActiveSession)?;
        if s.id != id {
            return Err(DenyCode::NoActiveSession);
        }
        if s.state != SessionState::Paused {
            return Err(DenyCode::NoActiveSession);
        }
        s.state = SessionState::Active;
        s.last_activity_mono = now_mono();
        Ok(s.clone())
    }

    /// Stop a session. Returns final state.
    pub fn stop(&self, id: &str, reason: StopReason) -> Result<Session, DenyCode> {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        let s = g.current.as_mut().ok_or(DenyCode::NoActiveSession)?;
        if s.id != id {
            return Err(DenyCode::NoActiveSession);
        }
        s.state = SessionState::Stopped;
        let final_session = s.clone();
        g.current = None;
        g.pending_consent = None;
        // Note: `reason` is logged via AuditWriter at the call site.
        let _ = reason;
        Ok(final_session)
    }

    /// Emergency stop — kills ALL sessions, arms the flag until next consent.
    /// Idempotent. Called by helper hotkey (P0.8) or renderer Esc pill.
    pub fn emergency_stop_all(&self) {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        if let Some(s) = g.current.as_mut() {
            s.state = SessionState::Stopped;
        }
        g.current = None;
        g.pending_consent = None;
        g.emergency_armed = true;
    }

    /// Clear the emergency flag (called when user starts a new consent flow).
    pub fn disarm_emergency(&self) {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        g.emergency_armed = false;
    }

    /// Peek at current session without modifying state.
    pub fn current(&self) -> Option<Session> {
        let g = self.inner.lock().expect("SessionManager mutex poisoned");
        g.current.clone().filter(|s| s.state == SessionState::Active)
    }

    /// Replace the entire allowlist (Layer 2). Bumps version outside this fn.
    pub fn set_allowlist(&self, bundle_ids: Vec<String>) {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        g.allowlist = bundle_ids;
    }

    /// Check whether an action should proceed. The 5 gates collapse to:
    /// session gate + allowlist gate + scope gate + Tier 1 hard-block check
    /// + rate-limit check. OS-permission gate and audit gate are enforced
    /// by separate subsystems (helper + AuditWriter).
    pub fn check_action(
        &self,
        bundle_id: Option<&str>,
        action_kind: ActionKind,
        requested_scope: ActionScope,
    ) -> ActionVerdict {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");

        if g.emergency_armed {
            return ActionVerdict::Deny(DenyCode::EmergencyStop);
        }

        let session = match g.current.as_ref() {
            Some(s) if s.state == SessionState::Active => s,
            Some(s) if s.state == SessionState::Paused => {
                return ActionVerdict::Deny(DenyCode::SessionPaused)
            }
            _ => return ActionVerdict::Deny(DenyCode::NoActiveSession),
        };

        // Idle expiry (Q7).
        let now = now_mono();
        let idle_secs = now.saturating_sub(session.last_activity_mono);
        if idle_secs > session.idle_timeout_secs {
            return ActionVerdict::Deny(DenyCode::ConsentExpired);
        }

        // Scope gate.
        if !scope_permits(session.scope, requested_scope) {
            return ActionVerdict::Deny(DenyCode::ScopeDenied);
        }

        // Tier 1 hard blocks.
        if let Some(bid) = bundle_id {
            let lower = bid.to_lowercase();
            if HARD_BLOCKED_BUNDLE_IDS.iter().any(|b| **b == lower) {
                return ActionVerdict::Deny(DenyCode::AppHardBlocked);
            }
            // Self-test check: Verboo's own bundle ID is gated by Self-Test Scope (Kratos §4).
            // Without self_test_enabled, ai.verboo.code.desktop is hard-blocked.
            if lower == "ai.verboo.code.desktop" && !session.self_test_enabled {
                return ActionVerdict::Deny(DenyCode::SelfTestScopeViolation);
            }
            // Layer 2 allowlist (default deny).
            if !g.allowlist.iter().any(|a| a.to_lowercase() == lower) {
                return ActionVerdict::Deny(DenyCode::AppNotAllowlisted);
            }
        }

        // Rate-limit gate (arch §6.5 Layer 3). 1-min sliding window.
        let elapsed = now.saturating_sub(g.rate.window_start_mono);
        if elapsed >= 60 {
            g.rate.mutating_count = 0;
            g.rate.read_count = 0;
            g.rate.window_start_mono = now;
        }
        match action_kind {
            ActionKind::Read => {
                g.rate.read_count += 1;
                if g.rate.read_count > MAX_READ_PER_MIN {
                    return ActionVerdict::Deny(DenyCode::RateLimited);
                }
            }
            ActionKind::Mutate => {
                g.rate.mutating_count += 1;
                if g.rate.mutating_count > MAX_MUTATING_PER_MIN {
                    return ActionVerdict::Deny(DenyCode::RateLimited);
                }
            }
        }

        ActionVerdict::Allow
    }
}

/// Coarse classification for rate-limiting purposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionKind {
    Read,
    Mutate,
}

fn scope_permits(session_scope: ActionScope, requested: ActionScope) -> bool {
    use ActionScope::*;
    match (session_scope, requested) {
        // Full session permits everything (incl. P1 actions later).
        (Full, _) => true,
        // Input permits Input + View, NOT Full.
        (Input, Full) => false,
        (Input, Input | View) => true,
        // View only permits View.
        (View, View) => true,
        (View, _) => false,
    }
}

fn now_mono() -> u64 {
    // SystemTime since UNIX_EPOCH. Not technically monotonic but adequate
    // for our durations (idle timeout, consent timeout, rate windows).
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn now_wall() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant_default(manager: &SessionManager) -> Session {
        let req = manager.request_session("test", None, ActionScope::View);
        let grant = ConsentGrant {
            id: req.id.clone(),
            allowlist_version: 1,
            self_test_enabled: false,
            screenshot_attach_to_llm: false,
        };
        manager.grant_session(grant).expect("grant")
    }

    #[test]
    fn denies_when_no_session() {
        let m = SessionManager::new();
        let v = m.check_action(None, ActionKind::Read, ActionScope::View);
        assert_eq!(v, ActionVerdict::Deny(DenyCode::NoActiveSession));
    }

    #[test]
    fn allows_read_when_active_view_scope() {
        let m = SessionManager::new();
        grant_default(&m);
        let v = m.check_action(None, ActionKind::Read, ActionScope::View);
        assert_eq!(v, ActionVerdict::Allow);
    }

    #[test]
    fn denies_mutate_when_view_scope() {
        let m = SessionManager::new();
        grant_default(&m);
        let v = m.check_action(None, ActionKind::Mutate, ActionScope::Input);
        assert_eq!(v, ActionVerdict::Deny(DenyCode::ScopeDenied));
    }

    #[test]
    fn denies_when_paused() {
        let m = SessionManager::new();
        let s = grant_default(&m);
        m.pause(&s.id).unwrap();
        let v = m.check_action(None, ActionKind::Read, ActionScope::View);
        assert_eq!(v, ActionVerdict::Deny(DenyCode::SessionPaused));
    }

    #[test]
    fn emergency_stop_blocks_all() {
        let m = SessionManager::new();
        grant_default(&m);
        m.emergency_stop_all();
        let v = m.check_action(None, ActionKind::Read, ActionScope::View);
        assert_eq!(v, ActionVerdict::Deny(DenyCode::EmergencyStop));
    }

    #[test]
    fn denies_system_settings_hard_block() {
        let m = SessionManager::new();
        let req = m.request_session("test", None, ActionScope::Full);
        let grant = ConsentGrant {
            id: req.id.clone(),
            allowlist_version: 1,
            self_test_enabled: false,
            screenshot_attach_to_llm: false,
        };
        m.grant_session(grant).unwrap();
        // Even with allowlist containing it, hard-block wins.
        m.set_allowlist(vec!["com.apple.systempreferences".into()]);
        let v = m.check_action(Some("com.apple.systempreferences"), ActionKind::Read, ActionScope::View);
        assert_eq!(v, ActionVerdict::Deny(DenyCode::AppHardBlocked));
    }

    #[test]
    fn denies_self_test_when_off() {
        let m = SessionManager::new();
        let req = m.request_session("test", None, ActionScope::Full);
        let grant = ConsentGrant {
            id: req.id.clone(),
            allowlist_version: 1,
            self_test_enabled: false, // Q2 default
            screenshot_attach_to_llm: false,
        };
        m.grant_session(grant).unwrap();
        m.set_allowlist(vec!["ai.verboo.code.desktop".into()]);
        let v = m.check_action(Some("ai.verboo.code.desktop"), ActionKind::Read, ActionScope::View);
        assert_eq!(v, ActionVerdict::Deny(DenyCode::SelfTestScopeViolation));
    }

    #[test]
    fn consent_expires_after_30s() {
        let m = SessionManager::new();
        // Create pending request with mocked old timestamp.
        let mut req = m.request_session("test", None, ActionScope::View);
        req.created_at_mono = now_mono().saturating_sub(60); // 60s ago
        {
            let mut g = m.inner.lock().unwrap();
            g.pending_consent = Some(req.clone());
        }
        let grant = ConsentGrant {
            id: req.id.clone(),
            allowlist_version: 1,
            self_test_enabled: false,
            screenshot_attach_to_llm: false,
        };
        let result = m.grant_session(grant);
        assert!(matches!(result, Err(DenyCode::ConsentExpired)));
    }

    #[test]
    fn scope_hierarchy_correct() {
        assert!(scope_permits(ActionScope::Full, ActionScope::View));
        assert!(scope_permits(ActionScope::Full, ActionScope::Input));
        assert!(scope_permits(ActionScope::Full, ActionScope::Full));
        assert!(scope_permits(ActionScope::Input, ActionScope::View));
        assert!(scope_permits(ActionScope::Input, ActionScope::Input));
        assert!(!scope_permits(ActionScope::Input, ActionScope::Full));
        assert!(scope_permits(ActionScope::View, ActionScope::View));
        assert!(!scope_permits(ActionScope::View, ActionScope::Input));
        assert!(!scope_permits(ActionScope::View, ActionScope::Full));
    }
}
