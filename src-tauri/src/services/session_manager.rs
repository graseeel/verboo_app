//! Computer Use SessionManager (Kratos arch §2, P0.5 store contract).
//!
//! State machine: IDLE → CONSENT → ACTIVE → PAUSED → STOPPED.
//! Single-writer PID lock (Q9 — single session in P0).
//!
//! Gates per arch §2.2:
//!   1. Feature gate — `settings.enabled`
//!   2. OS-permission gate — polled every 5s (TODO P0.2b)
//!   3. Session gate — `current()` returns ACTIVE
//!   4. Allowlist gate — bundle ID + scope match (full entries from settings)
//!   5. Denylist gate — Tier 2 (user-configured)
//!   6. Scope gate — action scope ≤ entry scope
//!   7. Rate-limit gate — 60 mutating/min, 600 read/min
//!
//! Settings read from `ComputerUseSettings` passed at each `check_action` call.
//! The caller (ComputerUseService → Tauri command handler) fetches settings
//! from `SettingsStore`.

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;

use crate::models::computer_use::{
    ActionVerdict, ConsentGrant, ConsentRequest, DenyCode, DenyReason,
    Session, SessionState, StopReason,
};
use crate::models::types::{
    ComputerUseAllowlistEntry, ComputerUseScope, ComputerUseSettings,
};

/// Hard-blocked bundle IDs (Tier 1, universal — Kratos arch §6.5).
/// Helper re-checks these as defense-in-depth; Rust also refuses here.
pub const HARD_BLOCKED_BUNDLE_IDS: &[&str] = &[
    "com.apple.systempreferences",
    "com.apple.loginwindow",
];

/// Consent request timeout (arch §2.1: 30s).
const CONSENT_TIMEOUT_SECS: u64 = 30;

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
    current: Option<Session>,
    pending_consent: Option<ConsentRequest>,
    rate: RateBucket,
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

    /// Step 1 of consent flow: create a pending request.
    /// Returns `feature_disabled` if `settings.enabled` is false.
    pub fn request_session(
        &self,
        settings: &ComputerUseSettings,
        goal: impl Into<String>,
        app: Option<String>,
        scope: ComputerUseScope,
    ) -> Result<ConsentRequest, DenyCode> {
        if !settings.enabled {
            return Err(DenyCode::NoActiveSession);
        }
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
        Ok(req)
    }

    /// Step 2: user grants consent → session becomes ACTIVE.
    pub fn grant_session(&self, grant: ConsentGrant) -> Result<Session, DenyCode> {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");

        if g.emergency_armed {
            return Err(DenyCode::EmergencyStop);
        }

        let pending = g.pending_consent.take().ok_or(DenyCode::NoActiveSession)?;

        let now = now_mono();
        if now.saturating_sub(pending.created_at_mono) > CONSENT_TIMEOUT_SECS {
            return Err(DenyCode::ConsentExpired);
        }

        let pid_lock = std::process::id();
        if let Some(existing) = &g.current {
            if existing.state == SessionState::Active && existing.pid_lock != pid_lock {
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
            idle_timeout_secs: grant.idle_timeout_secs,
        };
        g.current = Some(session.clone());
        Ok(session)
    }

    /// User denies consent.
    pub fn deny_session(&self, _id: &str, _reason: DenyReason) {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        g.pending_consent = None;
    }

    pub fn pause(&self, id: &str) -> Result<Session, DenyCode> {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        let s = g.current.as_mut().ok_or(DenyCode::NoActiveSession)?;
        if s.id != id { return Err(DenyCode::NoActiveSession); }
        if s.state != SessionState::Active { return Err(DenyCode::SessionPaused); }
        s.state = SessionState::Paused;
        Ok(s.clone())
    }

    pub fn resume(&self, id: &str) -> Result<Session, DenyCode> {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        let s = g.current.as_mut().ok_or(DenyCode::NoActiveSession)?;
        if s.id != id { return Err(DenyCode::NoActiveSession); }
        if s.state != SessionState::Paused { return Err(DenyCode::NoActiveSession); }
        s.state = SessionState::Active;
        s.last_activity_mono = now_mono();
        Ok(s.clone())
    }

    pub fn stop(&self, id: &str, _reason: StopReason) -> Result<Session, DenyCode> {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        let s = g.current.as_mut().ok_or(DenyCode::NoActiveSession)?;
        if s.id != id { return Err(DenyCode::NoActiveSession); }
        s.state = SessionState::Stopped;
        let final_session = s.clone();
        g.current = None;
        g.pending_consent = None;
        Ok(final_session)
    }

    /// Emergency stop — kills ALL sessions, arms the flag.
    pub fn emergency_stop_all(&self) {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        if let Some(s) = g.current.as_mut() {
            s.state = SessionState::Stopped;
        }
        g.current = None;
        g.pending_consent = None;
        g.emergency_armed = true;
    }

    pub fn disarm_emergency(&self) {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        g.emergency_armed = false;
    }

    pub fn current(&self) -> Option<Session> {
        let g = self.inner.lock().expect("SessionManager mutex poisoned");
        g.current.clone().filter(|s| s.state == SessionState::Active)
    }

    /// Check action against ALL gates (arch §2.2). Reads settings from the
    /// passed-in `ComputerUseSettings`, NOT from a cached copy.
    ///
    /// Returns `Allow` + updates `settings` in-place (action_count, last_used)
    /// on the matching allowlist entry. The caller MUST persist the updated
    /// settings via SettingsStore.
    pub fn check_action(
        &self,
        settings: &mut ComputerUseSettings,
        bundle_id: Option<&str>,
        action_kind: ActionKind,
        requested_scope: ComputerUseScope,
    ) -> ActionVerdict {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");

        // Gate 0: emergency flag.
        if g.emergency_armed {
            return ActionVerdict::Deny(DenyCode::EmergencyStop);
        }

        // Gate 1: feature enabled.
        if !settings.enabled {
            return ActionVerdict::Deny(DenyCode::NoActiveSession);
        }

        // Session gate.
        let session = match g.current.as_ref() {
            Some(s) if s.state == SessionState::Active => s,
            Some(_) => return ActionVerdict::Deny(DenyCode::SessionPaused),
            None => return ActionVerdict::Deny(DenyCode::NoActiveSession),
        };

        // Idle expiry (reads `idle_timeout_seconds` from settings, set at grant).
        let now = now_mono();
        let idle_secs = now.saturating_sub(session.last_activity_mono);
        if idle_secs > u64::from(settings.idle_timeout_seconds) {
            return ActionVerdict::Deny(DenyCode::ConsentExpired);
        }

        // Scope gate: session scope must permit requested scope.
        if !scope_permits(session.scope, requested_scope) {
            return ActionVerdict::Deny(DenyCode::ScopeDenied);
        }

        let Some(bid) = bundle_id else {
            // No bundle ID = allow (system-level actions like capabilities).
            return ActionVerdict::Allow;
        };
        let lower = bid.to_lowercase();

        // Tier 1 hard blocks.
        if HARD_BLOCKED_BUNDLE_IDS.iter().any(|b| **b == lower) {
            return ActionVerdict::Deny(DenyCode::AppHardBlocked);
        }

        // Verboo self-test gate: only allowed when self_test_enabled + is_self_test entry.
        if lower == "ai.verboo.code.desktop" && !session.self_test_enabled {
            return ActionVerdict::Deny(DenyCode::SelfTestScopeViolation);
        }

        // Tier 2 denylist (user-configured).
        if settings.denylist.iter().any(|d| d.to_lowercase() == lower) {
            return ActionVerdict::Deny(DenyCode::AppHardBlocked);
        }

        // Layer 2 allowlist — must match bundle_id + scope.
        match settings.allowlist.iter_mut().find(|e| e.bundle_id.to_lowercase() == lower) {
            None => return ActionVerdict::Deny(DenyCode::AppNotAllowlisted),
            Some(e) => {
                // Check self-test entry validity.
                if e.is_self_test && !matches!(session.self_test_enabled, true) {
                    return ActionVerdict::Deny(DenyCode::SelfTestScopeViolation);
                }
                // Check entry scope permits action scope.
                if !scope_permits(e.scope, requested_scope) {
                    return ActionVerdict::Deny(DenyCode::ScopeDenied);
                }
                // Rate-limit gate.
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
                        // Ask scope: never auto-allow mutate (Maestro Flag 2).
                        if e.scope == ComputerUseScope::Ask {
                            return ActionVerdict::Deny(DenyCode::ScopeDenied);
                        }
                        g.rate.mutating_count += 1;
                        if g.rate.mutating_count > MAX_MUTATING_PER_MIN {
                            return ActionVerdict::Deny(DenyCode::RateLimited);
                        }
                    }
                }
                // Update entry stats for caller to persist.
                e.action_count = e.action_count.saturating_add(1);
                e.last_used = now_wall() as i64;

                ActionVerdict::Allow
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionKind {
    Read,
    Mutate,
}

/// Scope hierarchy: Ask ≡ View (read-only unless user upgrades), View < Input < Full.
fn scope_permits(session_or_entry: ComputerUseScope, requested: ComputerUseScope) -> bool {
    use ComputerUseScope::*;
    let effective = match session_or_entry {
        Ask => View,      // Ask treats as View for scope checks
        other => other,
    };
    match (effective, requested) {
        (Full, _) => true,
        (Input, Full) => false,
        (Input, Input | View | Ask) => true,   // Ask is ≡ View at entry scope, handled upstream for mutate
        (View | Ask, View) => true,
        (View | Ask, _) => false,
    }
}

fn now_mono() -> u64 {
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

    fn test_settings() -> ComputerUseSettings {
        ComputerUseSettings {
            enabled: true,
            allowlist: vec![
                ComputerUseAllowlistEntry {
                    bundle_id: "com.apple.finder".into(),
                    display_name: "Finder".into(),
                    scope: ComputerUseScope::View,
                    ..Default::default()
                },
                ComputerUseAllowlistEntry {
                    bundle_id: "com.apple.Notes".into(),
                    display_name: "Notes".into(),
                    scope: ComputerUseScope::Input,
                    ..Default::default()
                },
            ],
            ..ComputerUseSettings::default()
        }
    }

    fn grant_default(manager: &SessionManager) -> Session {
        let settings = test_settings();
        let req = manager.request_session(&settings, "test", None, ComputerUseScope::View).expect("request");
        let grant = ConsentGrant {
            id: req.id.clone(),
            allowlist_version: 1,
            self_test_enabled: false,
            screenshot_attach_to_llm: false,
            idle_timeout_secs: 900,
        };
        manager.grant_session(grant).expect("grant")
    }

    #[test]
    fn denies_when_no_session() {
        let m = SessionManager::new();
        let mut s = test_settings();
        let v = m.check_action(&mut s, None, ActionKind::Read, ComputerUseScope::View);
        assert_eq!(v, ActionVerdict::Deny(DenyCode::NoActiveSession));
    }

    #[test]
    fn allows_read_when_active_view_scope() {
        let m = SessionManager::new();
        grant_default(&m);
        let mut s = test_settings();
        let v = m.check_action(&mut s, None, ActionKind::Read, ComputerUseScope::View);
        assert_eq!(v, ActionVerdict::Allow);
    }

    #[test]
    fn denies_mutate_when_view_scope() {
        let m = SessionManager::new();
        grant_default(&m);
        let mut s = test_settings();
        let v = m.check_action(&mut s, Some("com.apple.finder"), ActionKind::Mutate, ComputerUseScope::Input);
        assert_eq!(v, ActionVerdict::Deny(DenyCode::ScopeDenied));
    }

    #[test]
    fn allows_mutate_when_input_scope() {
        let m = SessionManager::new();
        // Grant with Input scope.
        let settings = test_settings();
        let req = m.request_session(&settings, "test", None, ComputerUseScope::Input).expect("request");
        let grant = ConsentGrant {
            id: req.id.clone(),
            allowlist_version: 1,
            self_test_enabled: false,
            screenshot_attach_to_llm: false,
            idle_timeout_secs: 900,
        };
        let session = m.grant_session(grant).expect("grant");
        assert_eq!(session.scope, ComputerUseScope::Input);
        let mut s = test_settings();
        let v = m.check_action(&mut s, Some("com.apple.Notes"), ActionKind::Mutate, ComputerUseScope::Input);
        assert_eq!(v, ActionVerdict::Allow);
    }

    #[test]
    fn denies_when_paused() {
        let m = SessionManager::new();
        let s = grant_default(&m);
        m.pause(&s.id).unwrap();
        let mut settings = test_settings();
        let v = m.check_action(&mut settings, None, ActionKind::Read, ComputerUseScope::View);
        assert_eq!(v, ActionVerdict::Deny(DenyCode::SessionPaused));
    }

    #[test]
    fn emergency_stop_blocks_all() {
        let m = SessionManager::new();
        grant_default(&m);
        m.emergency_stop_all();
        let mut s = test_settings();
        let v = m.check_action(&mut s, None, ActionKind::Read, ComputerUseScope::View);
        assert_eq!(v, ActionVerdict::Deny(DenyCode::EmergencyStop));
    }

    #[test]
    fn denies_system_settings_hard_block() {
        let m = SessionManager::new();
        grant_default(&m);
        let mut s = test_settings();
        s.allowlist.push(ComputerUseAllowlistEntry {
            bundle_id: "com.apple.systempreferences".into(),
            display_name: "System Settings".into(),
            scope: ComputerUseScope::Full,
            ..Default::default()
        });
        let v = m.check_action(&mut s, Some("com.apple.systempreferences"), ActionKind::Read, ComputerUseScope::View);
        assert_eq!(v, ActionVerdict::Deny(DenyCode::AppHardBlocked));
    }

    #[test]
    fn deny_self_test_when_off() {
        let m = SessionManager::new();
        let req = m.request_session(&test_settings(), "test", None, ComputerUseScope::Full).expect("request");
        let grant = ConsentGrant {
            id: req.id.clone(), allowlist_version: 1,
            self_test_enabled: false, screenshot_attach_to_llm: false,
            idle_timeout_secs: 900,
        };
        m.grant_session(grant).expect("grant");
        let mut s = test_settings();
        s.allowlist.push(ComputerUseAllowlistEntry {
            bundle_id: "ai.verboo.code.desktop".into(),
            display_name: "Verboo".into(),
            scope: ComputerUseScope::View,
            is_self_test: true,
            ..Default::default()
        });
        let v = m.check_action(&mut s, Some("ai.verboo.code.desktop"), ActionKind::Read, ComputerUseScope::View);
        assert_eq!(v, ActionVerdict::Deny(DenyCode::SelfTestScopeViolation));
    }

    #[test]
    fn consent_expires_after_30s() {
        let m = SessionManager::new();
        let mut req = m.request_session(&test_settings(), "test", None, ComputerUseScope::View).expect("request");
        req.created_at_mono = now_mono().saturating_sub(60);
        {
            let mut g = m.inner.lock().unwrap();
            g.pending_consent = Some(req.clone());
        }
        let grant = ConsentGrant {
            id: req.id.clone(), allowlist_version: 1,
            self_test_enabled: false, screenshot_attach_to_llm: false,
            idle_timeout_secs: 900,
        };
        let result = m.grant_session(grant);
        assert!(matches!(result, Err(DenyCode::ConsentExpired)));
    }

    #[test]
    fn scope_hierarchy_correct() {
        use ComputerUseScope::*;
        assert!(scope_permits(Full, View));
        assert!(scope_permits(Full, Input));
        assert!(scope_permits(Full, Full));
        assert!(scope_permits(Input, View));
        assert!(scope_permits(Input, Input));
        assert!(!scope_permits(Input, Full));
        assert!(scope_permits(View, View));
        assert!(!scope_permits(View, Input));
        assert!(!scope_permits(View, Full));
        // Ask ≡ View
        assert!(scope_permits(Ask, View));
        assert!(!scope_permits(Ask, Input));
        assert!(!scope_permits(Ask, Full));
    }

    #[test]
    fn ask_mutate_denied() {
        let m = SessionManager::new();
        let settings = test_settings();
        // Grant with Input scope, but entry scope = Ask
        let req = m.request_session(&settings, "test", None, ComputerUseScope::Input).expect("request");
        let grant = ConsentGrant {
            id: req.id.clone(), allowlist_version: 1,
            self_test_enabled: false, screenshot_attach_to_llm: false,
            idle_timeout_secs: 900,
        };
        m.grant_session(grant).expect("grant");
        let mut s = test_settings();
        s.allowlist.clear();
        s.allowlist.push(ComputerUseAllowlistEntry {
            bundle_id: "com.apple.Notes".into(),
            display_name: "Notes".into(),
            scope: ComputerUseScope::Ask,  // always prompt!
            ..Default::default()
        });
        let v = m.check_action(&mut s, Some("com.apple.Notes"), ActionKind::Mutate, ComputerUseScope::Input);
        assert_eq!(v, ActionVerdict::Deny(DenyCode::ScopeDenied));
    }

    #[test]
    fn action_count_increments_on_allow() {
        let m = SessionManager::new();
        grant_default(&m);
        let mut s = test_settings();
        assert_eq!(s.allowlist[0].action_count, 0);
        let v = m.check_action(&mut s, Some("com.apple.finder"), ActionKind::Read, ComputerUseScope::View);
        assert_eq!(v, ActionVerdict::Allow);
        assert_eq!(s.allowlist[0].action_count, 1);
    }

    #[test]
    fn refuses_when_enabled_is_false() {
        let m = SessionManager::new();
        let s = ComputerUseSettings {
            enabled: false,
            ..test_settings()
        };
        let result = m.request_session(&s, "test", None, ComputerUseScope::View);
        assert!(matches!(result, Err(DenyCode::NoActiveSession)));
    }

    #[test]
    fn refuses_denylist_app() {
        let m = SessionManager::new();
        grant_default(&m);
        let mut s = test_settings();
        s.denylist.push("com.apple.Mail".into());
        // Add to allowlist too — denylist should still win.
        s.allowlist.push(ComputerUseAllowlistEntry {
            bundle_id: "com.apple.Mail".into(),
            display_name: "Mail".into(),
            scope: ComputerUseScope::View,
            ..Default::default()
        });
        let v = m.check_action(&mut s, Some("com.apple.Mail"), ActionKind::Read, ComputerUseScope::View);
        assert_eq!(v, ActionVerdict::Deny(DenyCode::AppHardBlocked));
    }

    #[test]
    fn refuses_not_allowlisted() {
        let m = SessionManager::new();
        grant_default(&m);
        let mut s = test_settings();
        s.allowlist.clear();
        let v = m.check_action(&mut s, Some("com.apple.finder"), ActionKind::Read, ComputerUseScope::View);
        assert_eq!(v, ActionVerdict::Deny(DenyCode::AppNotAllowlisted));
    }
}
