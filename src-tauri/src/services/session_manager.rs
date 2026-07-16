//! Computer Use SessionManager (Kratos arch §2, P0.5 store contract).
//!
//! State machine: IDLE → CONSENT → ACTIVE → PAUSED → STOPPED.
//! Single-writer PID lock (Q9 — single session in P0).
//!
//! Goal-directed sessions may become ACTIVE with `target_app: None`. System-level
//! actions (`bundle_id: None`, e.g. list-apps / capabilities) are allowed; app-scoped
//! actions require either an allowlist match or a first `bind_target` that locks the
//! session app (second different app denied — no silent cross-app switch).
//!
//! Gates per arch §2.2:
//!   1. Feature gate — `settings.enabled`
//!   2. OS-permission gate — `os_permissions_ok` (poller P0.2b every 5s)
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
    ActionVerdict, AppControlTier, ApprovedApp, ComputerUseTurnBinding, ConsentGrant,
    ConsentRequest, DenyCode, DenyReason, Session, SessionState, StopReason,
};
use crate::models::types::{ComputerUseScope, ComputerUseSettings};

/// Hard-blocked bundle IDs (Tier 1, universal — Kratos arch §6.5).
/// Helper re-checks these as defense-in-depth; Rust also refuses here.
pub const HARD_BLOCKED_BUNDLE_IDS: &[&str] = &[
    "com.apple.loginwindow",
    "com.apple.keychainaccess",
    "com.agilebits.onepassword-osx",
    "com.agilebits.onepassword8",
    "com.bitwarden.desktop",
    "com.lastpass.lastpassmacdesktop",
    "com.dashlane.dashlanephonefinal",
    "org.keepassxc.keepassxc",
    "com.ledger.live",
    "com.exodus.desktop",
    "org.electrum.electrum",
    "io.trezor.suite",
];

const HARD_BLOCKED_BUNDLE_MARKERS: &[&str] = &[
    "1password",
    "bitwarden",
    "credential",
    "dashlane",
    "keychain",
    "keepass",
    "lastpass",
    "password",
    "protonpass",
    "authenticator",
    "bank",
    "banking",
    "coinbase",
    "binance",
    "cryptocurrency",
    "electrum",
    "exodus",
    "kraken",
    "ledger",
    "metamask",
    "phantom.wallet",
    "trezor",
    "wallet",
    "health",
    "healthrecord",
    "medicalrecord",
    "patientportal",
];

pub fn is_hard_blocked_bundle(bundle_id: &str) -> bool {
    is_hard_blocked_app(bundle_id, "")
}

pub fn is_hard_blocked_app(bundle_id: &str, display_name: &str) -> bool {
    let bundle = bundle_id.trim().to_ascii_lowercase();
    let identity = format!("{bundle} {}", display_name.trim().to_ascii_lowercase());
    HARD_BLOCKED_BUNDLE_IDS.contains(&bundle.as_str())
        || HARD_BLOCKED_BUNDLE_MARKERS
            .iter()
            .any(|marker| identity.contains(marker))
}

const SENTINEL_BUNDLE_IDS: &[&str] = &["com.apple.systempreferences", "com.apple.finder"];

pub fn maximum_tier_for_bundle(bundle_id: &str) -> AppControlTier {
    maximum_tier_for_app(bundle_id, "")
}

pub fn maximum_tier_for_app(bundle_id: &str, display_name: &str) -> AppControlTier {
    let bundle = bundle_id.trim().to_ascii_lowercase();
    let identity = format!("{bundle} {}", display_name.trim().to_ascii_lowercase());
    if matches!(
        bundle.as_str(),
        "com.apple.safari"
            | "com.google.chrome"
            | "org.mozilla.firefox"
            | "com.microsoft.edgemac"
            | "com.brave.browser"
            | "com.operasoftware.opera"
            | "com.tradingview.tradingviewapp"
    ) || [
        "browser",
        "chrome",
        "chromium",
        "firefox",
        "safari",
        "opera",
        "trading",
        "broker",
        "finance",
        "invest",
        "marketwatch",
        "stock",
    ]
    .iter()
    .any(|marker| identity.contains(marker))
    {
        return AppControlTier::ViewOnly;
    }
    if matches!(
        bundle.as_str(),
        "com.apple.terminal"
            | "com.googlecode.iterm2"
            | "dev.warp.warp-stable"
            | "com.microsoft.vscode"
            | "com.todesktop.230313mzl4w4u92"
            | "com.sublimetext.4"
    ) || [
        "terminal",
        "iterm",
        "warp",
        "jetbrains",
        "intellij",
        "xcode",
        "vscode",
        "visual studio code",
        "sublime",
        "cursor",
        "windsurf",
        "zed",
        " ide",
    ]
    .iter()
    .any(|marker| identity.contains(marker))
    {
        return AppControlTier::ClickOnly;
    }
    // Public Claude Code behavior: after explicit per-session approval,
    // browsers/finance are view-only, terminals/IDEs are click-only, and all
    // other apps receive full control. Display-name markers above keep
    // unenumerated members of the restricted categories inside their cap.
    AppControlTier::FullControl
}

fn requested_tier_for_scope(scope: ComputerUseScope) -> AppControlTier {
    match scope {
        ComputerUseScope::View | ComputerUseScope::Ask => AppControlTier::ViewOnly,
        ComputerUseScope::Input | ComputerUseScope::Full => AppControlTier::FullControl,
    }
}

fn narrow_tier(requested: AppControlTier, maximum: AppControlTier) -> AppControlTier {
    use AppControlTier::*;
    match (requested, maximum) {
        (ViewOnly, _) | (_, ViewOnly) => ViewOnly,
        (ClickOnly, _) | (_, ClickOnly) => ClickOnly,
        (FullControl, FullControl) => FullControl,
    }
}

fn tier_permits_scope(tier: AppControlTier, requested: ComputerUseScope) -> bool {
    match tier {
        AppControlTier::ViewOnly => matches!(requested, ComputerUseScope::View),
        AppControlTier::ClickOnly => {
            matches!(requested, ComputerUseScope::View | ComputerUseScope::Input)
        }
        AppControlTier::FullControl => true,
    }
}

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
#[derive(Debug)]
struct Inner {
    current: Option<Session>,
    pending_consent: Option<ConsentRequest>,
    rate: RateBucket,
    emergency_armed: bool,
    /// OS Accessibility + Screen Recording still granted (P0.2b poller).
    /// When false, `check_action` fails closed with `OsPermissionRevoked`.
    os_permissions_ok: bool,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            current: None,
            pending_consent: None,
            rate: RateBucket::default(),
            emergency_armed: false,
            os_permissions_ok: true,
        }
    }
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
    #[cfg(test)]
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
        self.request_bound_session(
            settings,
            goal,
            app,
            scope,
            "test-conversation".into(),
            "test-vision-executor".into(),
        )
    }

    pub fn request_bound_session(
        &self,
        settings: &ComputerUseSettings,
        goal: impl Into<String>,
        app: Option<String>,
        scope: ComputerUseScope,
        conversation_id: String,
        executor_model_id: String,
    ) -> Result<ConsentRequest, DenyCode> {
        self.request_session_with_id(
            settings,
            Uuid::new_v4().to_string(),
            goal,
            app,
            scope,
            ComputerUseTurnBinding {
                conversation_id,
                executor_model_id,
            },
        )
    }

    pub(crate) fn request_session_with_id(
        &self,
        settings: &ComputerUseSettings,
        id: String,
        goal: impl Into<String>,
        app: Option<String>,
        scope: ComputerUseScope,
        binding: ComputerUseTurnBinding,
    ) -> Result<ConsentRequest, DenyCode> {
        if !settings.enabled {
            return Err(DenyCode::NoActiveSession);
        }
        if binding.conversation_id.trim().is_empty() || binding.executor_model_id.trim().is_empty()
        {
            return Err(DenyCode::InvalidBinding);
        }
        if let Some(bundle_id) = app.as_deref() {
            if is_hard_blocked_bundle(bundle_id)
                || settings
                    .denylist
                    .iter()
                    .any(|denied| denied.eq_ignore_ascii_case(bundle_id))
                || settings.allowlist.iter().any(|entry| {
                    entry.bundle_id.eq_ignore_ascii_case(bundle_id) && entry.pii_redact
                })
            {
                return Err(DenyCode::AppHardBlocked);
            }
            if bundle_id.eq_ignore_ascii_case("ai.verboo.code.desktop")
                && !settings.self_test_enabled
            {
                return Err(DenyCode::SelfTestScopeViolation);
            }
        }
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        if g.current.as_ref().is_some_and(|session| {
            matches!(session.state, SessionState::Active | SessionState::Paused)
        }) {
            return Err(DenyCode::NoActiveSession);
        }
        let now = now_mono();
        let wall = now_wall();
        let req = ConsentRequest {
            id,
            conversation_id: binding.conversation_id,
            executor_model_id: binding.executor_model_id,
            goal: goal.into(),
            app,
            scope,
            // Isolation is a security invariant: only explicitly approved apps
            // may remain visible while the helper owns the screen. The legacy
            // restore_hidden_apps preference controls no authority here.
            isolate_other_apps: true,
            created_at_mono: now,
            created_at_wall: wall,
        };
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
        if grant.id != pending.id {
            return Err(DenyCode::NoActiveSession);
        }

        let now = now_mono();
        if now.saturating_sub(pending.created_at_mono) > CONSENT_TIMEOUT_SECS {
            return Err(DenyCode::ConsentExpired);
        }

        let pid_lock = std::process::id();
        if g.current.as_ref().is_some_and(|session| {
            matches!(session.state, SessionState::Active | SessionState::Paused)
        }) {
            return Err(DenyCode::NoActiveSession);
        }

        let initial_app = pending.app;
        let approved_apps = initial_app
            .as_ref()
            .map(|bundle_id| ApprovedApp {
                bundle_id: bundle_id.clone(),
                display_name: bundle_id.clone(),
                tier: narrow_tier(
                    requested_tier_for_scope(pending.scope),
                    maximum_tier_for_bundle(bundle_id),
                ),
                approved_at_wall: now_wall(),
                sentinel_confirmed: false,
            })
            .into_iter()
            .collect();
        let session = Session {
            id: pending.id,
            state: SessionState::Active,
            conversation_id: pending.conversation_id,
            executor_model_id: pending.executor_model_id,
            goal: pending.goal,
            target_app: initial_app.clone(),
            approved_apps,
            active_app: initial_app,
            scope: pending.scope,
            allowlist_version: grant.allowlist_version,
            self_test_enabled: grant.self_test_enabled,
            screenshot_attach_to_llm: grant.screenshot_attach_to_llm,
            isolate_other_apps: pending.isolate_other_apps,
            pid_lock,
            started_at_mono: now,
            started_at_wall: now_wall(),
            last_activity_mono: now,
            idle_timeout_secs: grant.idle_timeout_secs,
        };
        g.os_permissions_ok = true;
        g.current = Some(session.clone());
        Ok(session)
    }

    /// Mark OS TCC permissions as still OK (or revoked). Called by the
    /// P0.2b poller and by unit tests. Fail-closed when `ok == false`.
    pub(crate) fn set_os_permissions_ok(&self, ok: bool) {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        g.os_permissions_ok = ok;
    }

    #[cfg(test)]
    pub(crate) fn os_permissions_ok(&self) -> bool {
        let g = self.inner.lock().expect("SessionManager mutex poisoned");
        g.os_permissions_ok
    }

    /// User denies consent.
    pub fn deny_session(&self, _id: &str, _reason: DenyReason) {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        g.pending_consent = None;
    }

    pub fn pause(&self, id: &str) -> Result<Session, DenyCode> {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        let s = g.current.as_mut().ok_or(DenyCode::NoActiveSession)?;
        if s.id != id {
            return Err(DenyCode::NoActiveSession);
        }
        if s.state == SessionState::Paused {
            return Ok(s.clone());
        }
        if s.state != SessionState::Active {
            return Err(DenyCode::NoActiveSession);
        }
        s.state = SessionState::Paused;
        Ok(s.clone())
    }

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

    pub fn stop(&self, id: &str, _reason: StopReason) -> Result<Session, DenyCode> {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        let s = g.current.as_mut().ok_or(DenyCode::NoActiveSession)?;
        if s.id != id {
            return Err(DenyCode::NoActiveSession);
        }
        s.state = SessionState::Stopped;
        let final_session = s.clone();
        g.current = None;
        g.pending_consent = None;
        g.os_permissions_ok = true;
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
        g.os_permissions_ok = true;
    }

    pub fn disarm_emergency(&self) {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        g.emergency_armed = false;
    }

    pub fn current(&self) -> Option<Session> {
        let g = self.inner.lock().expect("SessionManager mutex poisoned");
        g.current
            .clone()
            .filter(|s| s.state == SessionState::Active)
    }

    pub fn current_any(&self) -> Option<Session> {
        let g = self.inner.lock().expect("SessionManager mutex poisoned");
        g.current
            .clone()
            .filter(|session| matches!(session.state, SessionState::Active | SessionState::Paused))
    }

    /// Bind the first concrete app target on a goal-directed session.
    ///
    /// Goal-directed sessions start with `target_app: None`. The first successful
    /// bind locks the session to that app for the rest of its life. A second bind
    /// to a *different* app is denied (`AppNotAllowlisted`) — no silent cross-app
    /// switch. Re-binding the same app is idempotent.
    ///
    /// Gates (hard block → self-test → denylist) run before the lock is written.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn bind_target(
        &self,
        session_id: &str,
        bundle_id: &str,
        settings: &ComputerUseSettings,
    ) -> Result<Session, DenyCode> {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");

        if g.emergency_armed {
            return Err(DenyCode::EmergencyStop);
        }
        if !settings.enabled {
            return Err(DenyCode::NoActiveSession);
        }

        let session = g.current.as_mut().ok_or(DenyCode::NoActiveSession)?;
        if session.id != session_id {
            return Err(DenyCode::NoActiveSession);
        }
        if session.state == SessionState::Paused {
            return Err(DenyCode::SessionPaused);
        }
        if session.state != SessionState::Active {
            return Err(DenyCode::NoActiveSession);
        }

        let bid = bundle_id.trim();
        if bid.is_empty() {
            return Err(DenyCode::AppNotAllowlisted);
        }
        let lower = bid.to_lowercase();

        // Already bound: same app is idempotent; different app is a silent switch → deny.
        if let Some(existing) = session.target_app.as_ref() {
            if existing.eq_ignore_ascii_case(bid) {
                session.last_activity_mono = now_mono();
                return Ok(session.clone());
            }
            return Err(DenyCode::AppNotAllowlisted);
        }

        // Tier 1 hard blocks.
        if is_hard_blocked_bundle(&lower) {
            return Err(DenyCode::AppHardBlocked);
        }
        if SENTINEL_BUNDLE_IDS
            .iter()
            .any(|sentinel| **sentinel == lower)
        {
            return Err(DenyCode::ConfirmationRequired);
        }

        // Verboo self-test gate: only allow binding Verboo when the session
        // explicitly opted into self-test. The allowlist entry is checked later
        // in check_action; bind_target only validates the session flag.
        if lower == "ai.verboo.code.desktop" && !session.self_test_enabled {
            return Err(DenyCode::SelfTestScopeViolation);
        }

        // Tier 2 denylist.
        if settings.denylist.iter().any(|d| d.to_lowercase() == lower) {
            return Err(DenyCode::AppHardBlocked);
        }

        // First bind locks the session target (store the caller-provided casing).
        session.target_app = Some(bid.to_string());
        session.active_app = Some(bid.to_string());
        session.approved_apps.push(ApprovedApp {
            bundle_id: bid.to_string(),
            display_name: bid.to_string(),
            tier: narrow_tier(
                requested_tier_for_scope(session.scope),
                maximum_tier_for_bundle(bid),
            ),
            approved_at_wall: now_wall(),
            sentinel_confirmed: false,
        });
        session.last_activity_mono = now_mono();
        Ok(session.clone())
    }

    pub fn approve_app(
        &self,
        session_id: &str,
        bundle_id: &str,
        display_name: &str,
        requested_tier: AppControlTier,
        sentinel_confirmed: bool,
        settings: &ComputerUseSettings,
    ) -> Result<Session, DenyCode> {
        let mut g = self.inner.lock().expect("SessionManager mutex poisoned");
        if g.emergency_armed {
            return Err(DenyCode::EmergencyStop);
        }
        if !settings.enabled {
            return Err(DenyCode::NoActiveSession);
        }
        let session = g.current.as_mut().ok_or(DenyCode::NoActiveSession)?;
        if session.id != session_id {
            return Err(DenyCode::NoActiveSession);
        }
        if session.state != SessionState::Paused {
            return Err(DenyCode::SessionPaused);
        }

        let bundle_id = bundle_id.trim();
        if bundle_id.is_empty() {
            return Err(DenyCode::AppNotAllowlisted);
        }
        let lower = bundle_id.to_ascii_lowercase();
        if is_hard_blocked_app(&lower, display_name) {
            return Err(DenyCode::AppHardBlocked);
        }
        if SENTINEL_BUNDLE_IDS
            .iter()
            .any(|sentinel| *sentinel == lower)
            && !sentinel_confirmed
        {
            return Err(DenyCode::ConfirmationRequired);
        }
        if settings
            .denylist
            .iter()
            .any(|denied| denied.eq_ignore_ascii_case(bundle_id))
        {
            return Err(DenyCode::AppHardBlocked);
        }
        if lower == "ai.verboo.code.desktop" && !session.self_test_enabled {
            return Err(DenyCode::SelfTestScopeViolation);
        }

        let tier = narrow_tier(
            requested_tier,
            maximum_tier_for_app(bundle_id, display_name),
        );
        if let Some(existing) = session
            .approved_apps
            .iter_mut()
            .find(|app| app.bundle_id.eq_ignore_ascii_case(bundle_id))
        {
            existing.display_name = display_name.trim().to_string();
            existing.tier = tier;
            existing.sentinel_confirmed |= sentinel_confirmed;
        } else {
            session.approved_apps.push(ApprovedApp {
                bundle_id: bundle_id.to_string(),
                display_name: display_name.trim().to_string(),
                tier,
                approved_at_wall: now_wall(),
                sentinel_confirmed,
            });
        }
        if session.target_app.is_none() {
            session.target_app = Some(bundle_id.to_string());
        }
        session.active_app = Some(bundle_id.to_string());
        session.last_activity_mono = now_mono();
        Ok(session.clone())
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

        // Gate 2: OS TCC (Accessibility + Screen Recording). Poller sets false
        // when either permission is revoked mid-session.
        if !g.os_permissions_ok {
            return ActionVerdict::Deny(DenyCode::OsPermissionRevoked);
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

        macro_rules! allow_and_touch {
            () => {{
                if let Some(current) = g.current.as_mut() {
                    current.last_activity_mono = now;
                }
                return ActionVerdict::Allow;
            }};
        }

        // Scope gate: session scope must permit requested scope.
        if !scope_permits(session.scope, requested_scope) {
            return ActionVerdict::Deny(DenyCode::ScopeDenied);
        }

        let Some(bid) = bundle_id else {
            // No bundle ID = allow (system-level actions like capabilities).
            allow_and_touch!();
        };
        let lower = bid.to_lowercase();

        // Tier 1 hard blocks.
        if is_hard_blocked_bundle(&lower) {
            return ActionVerdict::Deny(DenyCode::AppHardBlocked);
        }

        // Tier 2 denylist (user-configured).
        if settings.denylist.iter().any(|d| d.to_lowercase() == lower) {
            return ActionVerdict::Deny(DenyCode::AppHardBlocked);
        }

        // Legacy allowlist entries can mark an app as pixel-sensitive. The
        // canonical Computer Use loop requires a fresh screenshot after every
        // successful action, so an AX-only fallback would violate its visual
        // authority contract. Fail closed for the whole session target rather
        // than silently capturing pixels despite `pii_redact`.
        if settings
            .allowlist
            .iter()
            .any(|entry| entry.bundle_id.eq_ignore_ascii_case(bid) && entry.pii_redact)
        {
            return ActionVerdict::Deny(DenyCode::AppHardBlocked);
        }

        if SENTINEL_BUNDLE_IDS
            .iter()
            .any(|sentinel| **sentinel == lower)
            && !session
                .approved_apps
                .iter()
                .any(|app| app.bundle_id.eq_ignore_ascii_case(bid) && app.sentinel_confirmed)
        {
            return ActionVerdict::Deny(DenyCode::ConfirmationRequired);
        }

        let approved_tier = session
            .approved_apps
            .iter()
            .find(|app| app.bundle_id.eq_ignore_ascii_case(bid))
            .map(|app| app.tier);
        if let Some(tier) = approved_tier {
            if !tier_permits_scope(tier, requested_scope) {
                return ActionVerdict::Deny(DenyCode::ScopeDenied);
            }
            if lower == "ai.verboo.code.desktop" && !session.self_test_enabled {
                return ActionVerdict::Deny(DenyCode::SelfTestScopeViolation);
            }
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
            allow_and_touch!();
        }

        // The target named in an explicitly granted session is an ephemeral
        // allowlist entry for that session only. It is never persisted and it
        // cannot authorize a different bundle.
        if session
            .target_app
            .as_ref()
            .is_some_and(|target| target.eq_ignore_ascii_case(bid))
        {
            if !scope_permits(session.scope, requested_scope) {
                return ActionVerdict::Deny(DenyCode::ScopeDenied);
            }
            if session.scope == ComputerUseScope::Ask && action_kind == ActionKind::Mutate {
                return ActionVerdict::Deny(DenyCode::ScopeDenied);
            }
            // Verboo self-test: ephemeral target on Verboo requires the session flag.
            if lower == "ai.verboo.code.desktop" && !session.self_test_enabled {
                return ActionVerdict::Deny(DenyCode::SelfTestScopeViolation);
            }
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
            allow_and_touch!();
        }

        // Layer 2 allowlist — must match bundle_id + scope.
        match settings
            .allowlist
            .iter_mut()
            .find(|e| e.bundle_id.to_lowercase() == lower)
        {
            None => ActionVerdict::Deny(DenyCode::AppNotAllowlisted),
            Some(e) => {
                // Self-test entry validity: both halves of the AND must hold.
                //   - Verboo bundle requires session.self_test_enabled AND entry.is_self_test.
                //   - is_self_test entries are only valid on the Verboo bundle.
                let is_verboo = lower == "ai.verboo.code.desktop";
                if is_verboo {
                    if !session.self_test_enabled || !e.is_self_test {
                        return ActionVerdict::Deny(DenyCode::SelfTestScopeViolation);
                    }
                } else if e.is_self_test {
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

                allow_and_touch!();
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
        Ask => View, // Ask treats as View for scope checks
        other => other,
    };
    match (effective, requested) {
        (Full, _) => true,
        (Input, Full) => false,
        (Input, Input | View | Ask) => true, // Ask is ≡ View at entry scope, handled upstream for mutate
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
    use crate::models::types::ComputerUseAllowlistEntry;

    #[test]
    fn immutable_hard_blocks_cover_credentials_finance_crypto_and_health_records() {
        for bundle in [
            "com.agilebits.onepassword8",
            "com.example.password-vault",
            "com.example.banking.mobile",
            "com.coinbase.desktop",
            "org.example.patientportal",
            "com.apple.loginwindow",
        ] {
            assert!(is_hard_blocked_bundle(bundle), "{bundle}");
        }
        for bundle in ["com.apple.Notes", "com.apple.TextEdit", "com.example.MyApp"] {
            assert!(!is_hard_blocked_bundle(bundle), "{bundle}");
        }

        for display_name in ["Acme Bank", "Health Records", "Crypto Wallet"] {
            assert!(
                is_hard_blocked_app("com.example.ordinary", display_name),
                "{display_name}"
            );
        }
        assert!(!is_hard_blocked_app(
            "com.example.ordinary",
            "Ordinary Notes"
        ));
    }

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
        let req = manager
            .request_session(&settings, "test", None, ComputerUseScope::View)
            .expect("request");
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
    fn consent_always_isolates_unapproved_apps() {
        let manager = SessionManager::new();
        let mut settings = test_settings();
        settings.restore_hidden_apps = false;
        let request = manager
            .request_session(&settings, "test", None, ComputerUseScope::View)
            .expect("request");
        assert!(request.isolate_other_apps);
    }

    #[test]
    fn rejects_a_grant_for_a_different_consent_request() {
        let m = SessionManager::new();
        let settings = test_settings();
        m.request_session(
            &settings,
            "test",
            Some("com.apple.Notes".into()),
            ComputerUseScope::Input,
        )
        .expect("request");
        let result = m.grant_session(ConsentGrant {
            id: "different-request".into(),
            allowlist_version: 1,
            self_test_enabled: false,
            screenshot_attach_to_llm: false,
            idle_timeout_secs: 900,
        });
        assert_eq!(result.unwrap_err(), DenyCode::NoActiveSession);
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
        let v = m.check_action(
            &mut s,
            Some("com.apple.finder"),
            ActionKind::Mutate,
            ComputerUseScope::Input,
        );
        assert_eq!(v, ActionVerdict::Deny(DenyCode::ScopeDenied));
    }

    #[test]
    fn allows_mutate_when_input_scope() {
        let m = SessionManager::new();
        // Grant with Input scope.
        let settings = test_settings();
        let req = m
            .request_session(&settings, "test", None, ComputerUseScope::Input)
            .expect("request");
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
        let v = m.check_action(
            &mut s,
            Some("com.apple.Notes"),
            ActionKind::Mutate,
            ComputerUseScope::Input,
        );
        assert_eq!(v, ActionVerdict::Allow);
    }

    #[test]
    fn denies_when_paused() {
        let m = SessionManager::new();
        let s = grant_default(&m);
        m.pause(&s.id).unwrap();
        let mut settings = test_settings();
        let v = m.check_action(
            &mut settings,
            None,
            ActionKind::Read,
            ComputerUseScope::View,
        );
        assert_eq!(v, ActionVerdict::Deny(DenyCode::SessionPaused));
    }

    #[test]
    fn pause_is_idempotent_and_never_reactivates_the_session() {
        let m = SessionManager::new();
        let session = grant_default(&m);

        let first = m.pause(&session.id).unwrap();
        let second = m.pause(&session.id).unwrap();

        assert_eq!(first.state, SessionState::Paused);
        assert_eq!(second.state, SessionState::Paused);
        assert_eq!(m.current_any().unwrap().state, SessionState::Paused);
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
    fn system_settings_allowlist_still_requires_sentinel_confirmation() {
        let m = SessionManager::new();
        grant_default(&m);
        let mut s = test_settings();
        s.allowlist.push(ComputerUseAllowlistEntry {
            bundle_id: "com.apple.systempreferences".into(),
            display_name: "System Settings".into(),
            scope: ComputerUseScope::Full,
            ..Default::default()
        });
        let v = m.check_action(
            &mut s,
            Some("com.apple.systempreferences"),
            ActionKind::Read,
            ComputerUseScope::View,
        );
        assert_eq!(v, ActionVerdict::Deny(DenyCode::ConfirmationRequired));
    }

    #[test]
    fn deny_self_test_when_off() {
        let m = SessionManager::new();
        let req = m
            .request_session(&test_settings(), "test", None, ComputerUseScope::Full)
            .expect("request");
        let grant = ConsentGrant {
            id: req.id.clone(),
            allowlist_version: 1,
            self_test_enabled: false,
            screenshot_attach_to_llm: false,
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
        let v = m.check_action(
            &mut s,
            Some("ai.verboo.code.desktop"),
            ActionKind::Read,
            ComputerUseScope::View,
        );
        assert_eq!(v, ActionVerdict::Deny(DenyCode::SelfTestScopeViolation));
    }

    #[test]
    fn consent_expires_after_30s() {
        let m = SessionManager::new();
        let mut req = m
            .request_session(&test_settings(), "test", None, ComputerUseScope::View)
            .expect("request");
        req.created_at_mono = now_mono().saturating_sub(60);
        {
            let mut g = m.inner.lock().unwrap();
            g.pending_consent = Some(req.clone());
        }
        let grant = ConsentGrant {
            id: req.id.clone(),
            allowlist_version: 1,
            self_test_enabled: false,
            screenshot_attach_to_llm: false,
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
        let req = m
            .request_session(&settings, "test", None, ComputerUseScope::Input)
            .expect("request");
        let grant = ConsentGrant {
            id: req.id.clone(),
            allowlist_version: 1,
            self_test_enabled: false,
            screenshot_attach_to_llm: false,
            idle_timeout_secs: 900,
        };
        m.grant_session(grant).expect("grant");
        let mut s = test_settings();
        s.allowlist.clear();
        s.allowlist.push(ComputerUseAllowlistEntry {
            bundle_id: "com.apple.Notes".into(),
            display_name: "Notes".into(),
            scope: ComputerUseScope::Ask, // always prompt!
            ..Default::default()
        });
        let v = m.check_action(
            &mut s,
            Some("com.apple.Notes"),
            ActionKind::Mutate,
            ComputerUseScope::Input,
        );
        assert_eq!(v, ActionVerdict::Deny(DenyCode::ScopeDenied));
    }

    #[test]
    fn action_count_increments_on_allow() {
        let m = SessionManager::new();
        grant_default(&m);
        let mut s = test_settings();
        assert_eq!(s.allowlist[1].action_count, 0);
        let v = m.check_action(
            &mut s,
            Some("com.apple.Notes"),
            ActionKind::Read,
            ComputerUseScope::View,
        );
        assert_eq!(v, ActionVerdict::Allow);
        assert_eq!(s.allowlist[1].action_count, 1);
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
    fn consent_request_rejects_hard_blocked_denied_and_pii_redacted_apps() {
        let manager = SessionManager::new();
        let mut settings = test_settings();
        settings.denylist.push("com.example.denied".into());
        settings.allowlist.push(ComputerUseAllowlistEntry {
            bundle_id: "com.example.private".into(),
            display_name: "Private".into(),
            pii_redact: true,
            ..Default::default()
        });

        for bundle_id in [
            "com.example.banking.mobile",
            "com.example.denied",
            "com.example.private",
        ] {
            assert!(
                matches!(
                    manager.request_session(
                        &settings,
                        "inspect",
                        Some(bundle_id.into()),
                        ComputerUseScope::View,
                    ),
                    Err(DenyCode::AppHardBlocked)
                ),
                "{bundle_id}"
            );
        }
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
        let v = m.check_action(
            &mut s,
            Some("com.apple.Mail"),
            ActionKind::Read,
            ComputerUseScope::View,
        );
        assert_eq!(v, ActionVerdict::Deny(DenyCode::AppHardBlocked));
    }

    #[test]
    fn pii_redacted_allowlist_entry_fails_closed_before_visual_capture() {
        let m = SessionManager::new();
        grant_default(&m);
        let mut settings = test_settings();
        let entry = settings
            .allowlist
            .iter_mut()
            .find(|entry| entry.bundle_id == "com.apple.Notes")
            .expect("Notes fixture");
        entry.pii_redact = true;

        let verdict = m.check_action(
            &mut settings,
            Some("com.apple.Notes"),
            ActionKind::Read,
            ComputerUseScope::View,
        );

        assert_eq!(verdict, ActionVerdict::Deny(DenyCode::AppHardBlocked));
    }

    #[test]
    fn refuses_not_allowlisted() {
        let m = SessionManager::new();
        grant_default(&m);
        let mut s = test_settings();
        s.allowlist.clear();
        let v = m.check_action(
            &mut s,
            Some("com.apple.TextEdit"),
            ActionKind::Read,
            ComputerUseScope::View,
        );
        assert_eq!(v, ActionVerdict::Deny(DenyCode::AppNotAllowlisted));
    }

    #[test]
    fn explicit_session_target_is_authorized_without_persistent_allowlist() {
        let m = SessionManager::new();
        let settings = ComputerUseSettings {
            enabled: true,
            ..ComputerUseSettings::default()
        };
        let req = m
            .request_session(
                &settings,
                "type hello",
                Some("com.apple.Notes".into()),
                ComputerUseScope::Input,
            )
            .expect("request");
        m.grant_session(ConsentGrant {
            id: req.id,
            allowlist_version: 1,
            self_test_enabled: false,
            screenshot_attach_to_llm: true,
            idle_timeout_secs: 900,
        })
        .expect("grant");

        let mut empty = settings;
        assert_eq!(
            m.check_action(
                &mut empty,
                Some("com.apple.Notes"),
                ActionKind::Mutate,
                ComputerUseScope::Input
            ),
            ActionVerdict::Allow,
        );
        assert_eq!(
            m.check_action(
                &mut empty,
                Some("com.apple.TextEdit"),
                ActionKind::Read,
                ComputerUseScope::View
            ),
            ActionVerdict::Deny(DenyCode::AppNotAllowlisted),
        );
    }

    /// Positive case for the self-test gate (complement of `deny_self_test_when_off`).
    /// When session.self_test_enabled == true AND the matching allowlist entry
    /// has is_self_test == true, an action on the Verboo bundle is ALLOWED.
    /// Proves both halves of the AND are required.
    #[test]
    fn allows_self_test_when_flag_and_entry_both_true() {
        let m = SessionManager::new();
        // Grant with self_test_enabled=true.
        let settings = test_settings();
        let req = m
            .request_session(&settings, "self-test", None, ComputerUseScope::Input)
            .expect("request");
        let grant = ConsentGrant {
            id: req.id.clone(),
            allowlist_version: 1,
            self_test_enabled: true,
            screenshot_attach_to_llm: false,
            idle_timeout_secs: 900,
        };
        let session = m.grant_session(grant).expect("grant");
        assert!(
            session.self_test_enabled,
            "session must carry self_test flag"
        );

        let mut s = test_settings();
        s.allowlist.push(ComputerUseAllowlistEntry {
            bundle_id: "ai.verboo.code.desktop".into(),
            display_name: "Verboo (self-test)".into(),
            scope: ComputerUseScope::Input,
            is_self_test: true,
            ..Default::default()
        });

        // Read on Verboo self-test surface — must allow.
        let v = m.check_action(
            &mut s,
            Some("ai.verboo.code.desktop"),
            ActionKind::Read,
            ComputerUseScope::View,
        );
        assert_eq!(
            v,
            ActionVerdict::Allow,
            "self-test action must allow when flag+entry both true"
        );
    }

    /// SEV-2 CLOSED: SessionManager now requires BOTH session.self_test_enabled
    /// AND entry.is_self_test == true for the Verboo bundle. A matching Verboo
    /// entry with is_self_test == false must be rejected even when the session
    /// flag is true.
    #[test]
    fn self_test_gate_rejects_verboo_entry_without_self_test_flag() {
        let m = SessionManager::new();
        let settings = test_settings();
        let req = m
            .request_session(&settings, "self-test", None, ComputerUseScope::Input)
            .expect("request");
        let grant = ConsentGrant {
            id: req.id.clone(),
            allowlist_version: 1,
            self_test_enabled: true,
            screenshot_attach_to_llm: false,
            idle_timeout_secs: 900,
        };
        m.grant_session(grant).expect("grant");

        let mut s = test_settings();
        s.allowlist.push(ComputerUseAllowlistEntry {
            bundle_id: "ai.verboo.code.desktop".into(),
            display_name: "fraud".into(),
            scope: ComputerUseScope::Input,
            is_self_test: false,
            ..Default::default()
        });

        let v = m.check_action(
            &mut s,
            Some("ai.verboo.code.desktop"),
            ActionKind::Read,
            ComputerUseScope::View,
        );
        assert_eq!(
            v,
            ActionVerdict::Deny(DenyCode::SelfTestScopeViolation),
            "Verboo allowlist entry must have is_self_test=true when session flag is true"
        );
    }

    /// SEV-2 CLOSED: is_self_test entries are only valid on the Verboo bundle.
    /// A non-Verboo bundle marked is_self_test=true must be rejected regardless
    /// of the session self_test flag.
    #[test]
    fn self_test_gate_rejects_non_verboo_self_test_entry() {
        let m = SessionManager::new();
        let settings = test_settings();
        let req = m
            .request_session(&settings, "self-test", None, ComputerUseScope::Input)
            .expect("request");
        let grant = ConsentGrant {
            id: req.id.clone(),
            allowlist_version: 1,
            self_test_enabled: true,
            screenshot_attach_to_llm: false,
            idle_timeout_secs: 900,
        };
        m.grant_session(grant).expect("grant");

        let mut s = test_settings();
        // Replace the default Notes entry with a poisoned self-test marker.
        s.allowlist
            .retain(|e| e.bundle_id.to_lowercase() != "com.apple.notes");
        s.allowlist.push(ComputerUseAllowlistEntry {
            bundle_id: "com.apple.Notes".into(),
            display_name: "Notes (fraud marker)".into(),
            scope: ComputerUseScope::Input,
            is_self_test: true,
            ..Default::default()
        });

        let v = m.check_action(
            &mut s,
            Some("com.apple.Notes"),
            ActionKind::Read,
            ComputerUseScope::View,
        );
        assert_eq!(
            v,
            ActionVerdict::Deny(DenyCode::SelfTestScopeViolation),
            "is_self_test entries outside the Verboo bundle are invalid"
        );
    }

    /// P0.2b: when the OS TCC poller marks permissions revoked, check_action
    /// must fail closed before allowlist evaluation.
    #[test]
    fn denies_when_os_permissions_revoked() {
        let m = SessionManager::new();
        let session = grant_default(&m);
        assert!(session.state == SessionState::Active);

        let mut s = test_settings();
        s.allowlist.push(ComputerUseAllowlistEntry {
            bundle_id: "com.apple.Notes".into(),
            display_name: "Notes".into(),
            scope: ComputerUseScope::Input,
            ..Default::default()
        });

        // Baseline: allow while OS perms OK.
        assert_eq!(
            m.check_action(
                &mut s,
                Some("com.apple.Notes"),
                ActionKind::Read,
                ComputerUseScope::View
            ),
            ActionVerdict::Allow,
        );

        m.set_os_permissions_ok(false);
        assert_eq!(
            m.check_action(
                &mut s,
                Some("com.apple.Notes"),
                ActionKind::Mutate,
                ComputerUseScope::Input
            ),
            ActionVerdict::Deny(DenyCode::OsPermissionRevoked),
        );
        // System-level read (no bundle) also blocked once OS perms are bad.
        assert_eq!(
            m.check_action(&mut s, None, ActionKind::Read, ComputerUseScope::View),
            ActionVerdict::Deny(DenyCode::OsPermissionRevoked),
        );

        // Restoring the flag re-opens the gate.
        m.set_os_permissions_ok(true);
        assert_eq!(
            m.check_action(
                &mut s,
                Some("com.apple.Notes"),
                ActionKind::Read,
                ComputerUseScope::View
            ),
            ActionVerdict::Allow,
        );
    }

    /// Grant always re-arms OS permission OK (poller starts after grant).
    #[test]
    fn grant_resets_os_permissions_ok() {
        let m = SessionManager::new();
        m.set_os_permissions_ok(false);
        assert!(!m.os_permissions_ok());
        let _ = grant_default(&m);
        assert!(m.os_permissions_ok(), "grant must reset os_permissions_ok");
    }

    /// N4 session-layer: AccessMode/fullAccess cannot create a CU session.
    /// `current()` is None until `request_session` + `grant_session` are
    /// explicitly called, regardless of any external access mode.
    /// This is the service-boundary proof of orthogonality (architecture §0).
    #[test]
    fn access_mode_full_does_not_grant_cu_session() {
        let m = SessionManager::new();

        // Fresh SessionManager has no current session.
        assert!(m.current().is_none(), "no implicit session at construction");

        // Even after we attempt check_action (which would grant if there
        // were ANY path from AccessMode to session), it must deny.
        let mut s = ComputerUseSettings {
            enabled: true,
            ..ComputerUseSettings::default()
        };
        let v = m.check_action(
            &mut s,
            Some("com.apple.Notes"),
            ActionKind::Read,
            ComputerUseScope::View,
        );
        assert_eq!(
            v,
            ActionVerdict::Deny(DenyCode::NoActiveSession),
            "no action may execute without an explicit consent grant, regardless of AccessMode"
        );

        // The ONLY way to activate a session is the consent flow.
        let req = m
            .request_session(&s, "test", None, ComputerUseScope::View)
            .expect("request");
        let grant = ConsentGrant {
            id: req.id.clone(),
            allowlist_version: 1,
            self_test_enabled: false,
            screenshot_attach_to_llm: false,
            idle_timeout_secs: 900,
        };
        let session = m.grant_session(grant).expect("grant");
        assert_eq!(session.state, SessionState::Active);
        assert!(
            m.current().is_some(),
            "session only becomes active via explicit grant"
        );
    }

    /// N1 enforcement at SessionManager layer: a freshly-constructed
    /// SessionManager with default (empty) ComputerUseSettings denies every
    /// action — there is no implicit allowlist entry, no implicit scope.
    #[test]
    fn default_deny_with_empty_allowlist() {
        let m = SessionManager::new();
        // Manually grant a session (the consent flow is the only path in).
        let req = m
            .request_session(
                &ComputerUseSettings {
                    enabled: true,
                    ..ComputerUseSettings::default()
                },
                "test",
                None,
                ComputerUseScope::View,
            )
            .expect("request");
        let grant = ConsentGrant {
            id: req.id.clone(),
            allowlist_version: 1,
            self_test_enabled: false,
            screenshot_attach_to_llm: false,
            idle_timeout_secs: 900,
        };
        m.grant_session(grant).expect("grant");

        // Action against any bundle: default-deny because allowlist is empty.
        // We need enabled=true to clear gate 1; allowlist stays empty.
        let mut empty = ComputerUseSettings {
            enabled: true,
            ..Default::default()
        };
        let v = m.check_action(
            &mut empty,
            Some("com.apple.Notes"),
            ActionKind::Read,
            ComputerUseScope::View,
        );
        assert_eq!(
            v,
            ActionVerdict::Deny(DenyCode::AppNotAllowlisted),
            "empty allowlist must default-deny every app"
        );
    }

    /// A persisted allowlist entry cannot bypass sentinel confirmation.
    #[test]
    fn system_settings_requires_confirmation_even_if_allowlisted() {
        let m = SessionManager::new();
        // Grant with Full scope so the scope gate does not short-circuit
        // before the hard-block check fires.
        let settings = test_settings();
        let req = m
            .request_session(&settings, "test", None, ComputerUseScope::Full)
            .expect("request");
        let grant = ConsentGrant {
            id: req.id.clone(),
            allowlist_version: 1,
            self_test_enabled: false,
            screenshot_attach_to_llm: false,
            idle_timeout_secs: 900,
        };
        m.grant_session(grant).expect("grant");

        let mut s = test_settings();
        // Pretend normalize() was bypassed and System Settings made it in.
        s.allowlist.push(ComputerUseAllowlistEntry {
            bundle_id: "com.apple.systempreferences".into(),
            display_name: "System Settings".into(),
            scope: ComputerUseScope::Full,
            ..Default::default()
        });
        // Both read and mutate require the explicit session sentinel.
        let v_read = m.check_action(
            &mut s,
            Some("com.apple.systempreferences"),
            ActionKind::Read,
            ComputerUseScope::View,
        );
        assert_eq!(v_read, ActionVerdict::Deny(DenyCode::ConfirmationRequired));
        let v_mutate = m.check_action(
            &mut s,
            Some("com.apple.systempreferences"),
            ActionKind::Mutate,
            ComputerUseScope::Full,
        );
        assert_eq!(
            v_mutate,
            ActionVerdict::Deny(DenyCode::ConfirmationRequired)
        );
    }

    // ── Goal-first / bind_target (Approach A NL intent, Task 1) ──────────

    /// Helper: grant an ACTIVE goal-directed session (no preselected app).
    fn grant_goal_directed(
        manager: &SessionManager,
        scope: ComputerUseScope,
        self_test: bool,
    ) -> Session {
        let settings = ComputerUseSettings {
            enabled: true,
            ..ComputerUseSettings::default()
        };
        let req = manager
            .request_session(&settings, "test goal without app", None, scope)
            .expect("request");
        manager
            .grant_session(ConsentGrant {
                id: req.id,
                allowlist_version: 1,
                self_test_enabled: self_test,
                screenshot_attach_to_llm: false,
                idle_timeout_secs: 900,
            })
            .expect("grant")
    }

    /// Goal-directed ACTIVE session + system-level action (no bundle) is allowed.
    #[test]
    fn goal_directed_session_allows_system_level_read_without_target() {
        let m = SessionManager::new();
        let session = grant_goal_directed(&m, ComputerUseScope::View, false);
        assert!(
            session.target_app.is_none(),
            "goal-directed session has no target yet"
        );

        let mut s = ComputerUseSettings {
            enabled: true,
            ..ComputerUseSettings::default()
        };
        let v = m.check_action(&mut s, None, ActionKind::Read, ComputerUseScope::View);
        assert_eq!(v, ActionVerdict::Allow);
    }

    /// Unbound session denies concrete app actions until bind (empty allowlist).
    #[test]
    fn goal_directed_session_denies_app_scoped_action_until_bind() {
        let m = SessionManager::new();
        grant_goal_directed(&m, ComputerUseScope::Input, false);

        let mut s = ComputerUseSettings {
            enabled: true,
            ..ComputerUseSettings::default()
        };
        // No allowlist, no target — concrete app action must deny.
        let v = m.check_action(
            &mut s,
            Some("com.apple.Notes"),
            ActionKind::Mutate,
            ComputerUseScope::Input,
        );
        assert_eq!(v, ActionVerdict::Deny(DenyCode::AppNotAllowlisted));
    }

    /// After bind_target, the bound app is authorized; a different app is not.
    #[test]
    fn bind_target_locks_first_app_and_denies_cross_app() {
        let m = SessionManager::new();
        let session = grant_goal_directed(&m, ComputerUseScope::Input, false);
        let settings = ComputerUseSettings {
            enabled: true,
            ..ComputerUseSettings::default()
        };

        let bound = m
            .bind_target(&session.id, "com.apple.Notes", &settings)
            .expect("bind Notes");
        assert_eq!(
            bound.target_app.as_deref(),
            Some("com.apple.Notes"),
            "first bind locks Notes as session target"
        );

        let mut empty = settings.clone();
        assert_eq!(
            m.check_action(
                &mut empty,
                Some("com.apple.Notes"),
                ActionKind::Mutate,
                ComputerUseScope::Input,
            ),
            ActionVerdict::Allow,
        );
        assert_eq!(
            m.check_action(
                &mut empty,
                Some("com.google.Chrome"),
                ActionKind::Mutate,
                ComputerUseScope::Input,
            ),
            ActionVerdict::Deny(DenyCode::AppNotAllowlisted),
        );

        // Second bind to a different app is denied (no silent switch).
        let switch = m.bind_target(&session.id, "com.google.Chrome", &settings);
        assert_eq!(switch.unwrap_err(), DenyCode::AppNotAllowlisted);

        // Same-app rebind is idempotent.
        let again = m
            .bind_target(&session.id, "com.apple.Notes", &settings)
            .expect("idempotent rebind");
        assert_eq!(again.target_app.as_deref(), Some("com.apple.Notes"));
    }

    /// Legacy bind_target cannot silently approve sentinel bundles.
    #[test]
    fn bind_target_requires_sentinel_confirmation() {
        let m = SessionManager::new();
        let session = grant_goal_directed(&m, ComputerUseScope::Full, false);
        let settings = ComputerUseSettings {
            enabled: true,
            ..ComputerUseSettings::default()
        };

        let result = m.bind_target(&session.id, "com.apple.systempreferences", &settings);
        assert_eq!(result.unwrap_err(), DenyCode::ConfirmationRequired);
        assert!(
            m.current().unwrap().target_app.is_none(),
            "failed bind must leave target unbound"
        );
    }

    /// bind_target refuses Verboo when self_test is not enabled on the session.
    #[test]
    fn bind_target_refuses_verboo_without_self_test() {
        let m = SessionManager::new();
        let session = grant_goal_directed(&m, ComputerUseScope::Input, false);
        let settings = ComputerUseSettings {
            enabled: true,
            ..ComputerUseSettings::default()
        };

        let result = m.bind_target(&session.id, "ai.verboo.code.desktop", &settings);
        assert_eq!(result.unwrap_err(), DenyCode::SelfTestScopeViolation);
        assert!(m.current().unwrap().target_app.is_none());
    }

    /// bind_target refuses denylisted bundles.
    #[test]
    fn bind_target_refuses_denylisted_bundle() {
        let m = SessionManager::new();
        let session = grant_goal_directed(&m, ComputerUseScope::Input, false);
        let settings = ComputerUseSettings {
            enabled: true,
            denylist: vec!["com.apple.Mail".into()],
            ..ComputerUseSettings::default()
        };

        let result = m.bind_target(&session.id, "com.apple.Mail", &settings);
        assert_eq!(result.unwrap_err(), DenyCode::AppHardBlocked);
    }

    /// bind_target requires an active session matching session_id.
    #[test]
    fn bind_target_requires_active_session() {
        let m = SessionManager::new();
        let settings = ComputerUseSettings {
            enabled: true,
            ..ComputerUseSettings::default()
        };
        assert_eq!(
            m.bind_target("missing", "com.apple.Notes", &settings)
                .unwrap_err(),
            DenyCode::NoActiveSession,
        );

        let session = grant_goal_directed(&m, ComputerUseScope::Input, false);
        m.pause(&session.id).unwrap();
        assert_eq!(
            m.bind_target(&session.id, "com.apple.Notes", &settings)
                .unwrap_err(),
            DenyCode::SessionPaused,
        );
    }

    #[test]
    fn explicit_approval_supports_multiple_apps_and_tier_caps() {
        use crate::models::computer_use::AppControlTier;

        let m = SessionManager::new();
        let session = grant_goal_directed(&m, ComputerUseScope::Full, false);
        let settings = ComputerUseSettings {
            enabled: true,
            ..ComputerUseSettings::default()
        };
        m.pause(&session.id).expect("pause before approval");

        let notes = m
            .approve_app(
                &session.id,
                "com.apple.Notes",
                "Notes",
                AppControlTier::FullControl,
                false,
                &settings,
            )
            .expect("approve Notes");
        assert_eq!(notes.approved_apps.len(), 1);
        assert_eq!(notes.approved_apps[0].tier, AppControlTier::FullControl);

        let chrome = m
            .approve_app(
                &session.id,
                "com.google.Chrome",
                "Chrome",
                AppControlTier::FullControl,
                false,
                &settings,
            )
            .expect("approve Chrome");
        assert_eq!(chrome.approved_apps.len(), 2);
        assert_eq!(
            chrome
                .approved_apps
                .iter()
                .find(|app| app.bundle_id == "com.google.Chrome")
                .unwrap()
                .tier,
            AppControlTier::ViewOnly,
        );
    }

    #[test]
    fn explicit_approval_rejects_hard_blocked_display_names() {
        let manager = SessionManager::new();
        let session = grant_goal_directed(&manager, ComputerUseScope::Full, false);
        let settings = ComputerUseSettings {
            enabled: true,
            ..ComputerUseSettings::default()
        };
        manager.pause(&session.id).expect("pause before approval");

        for display_name in ["Acme Bank", "Health Records", "Crypto Wallet"] {
            assert_eq!(
                manager
                    .approve_app(
                        &session.id,
                        "com.example.ordinary",
                        display_name,
                        AppControlTier::FullControl,
                        false,
                        &settings,
                    )
                    .unwrap_err(),
                DenyCode::AppHardBlocked,
                "{display_name}"
            );
        }
    }

    #[test]
    fn active_session_rejects_a_second_machine_wide_consent_request() {
        let manager = SessionManager::new();
        let settings = test_settings();
        let _active = grant_goal_directed(&manager, ComputerUseScope::Full, false);

        assert!(matches!(
            manager.request_session(
                &settings,
                "second session",
                Some("com.apple.Notes".into()),
                ComputerUseScope::Full,
            ),
            Err(DenyCode::NoActiveSession)
        ));
    }

    #[test]
    fn paused_session_accepts_explicit_app_approval_without_resuming_actions() {
        let manager = SessionManager::new();
        let settings = test_settings();
        let active = grant_goal_directed(&manager, ComputerUseScope::Full, false);
        manager.pause(&active.id).expect("pause");

        let updated = manager
            .approve_app(
                &active.id,
                "com.apple.Notes",
                "Notes",
                AppControlTier::FullControl,
                false,
                &settings,
            )
            .expect("approval while paused");

        assert_eq!(updated.state, SessionState::Paused);
        assert_eq!(updated.active_app.as_deref(), Some("com.apple.Notes"));
    }

    #[test]
    fn active_session_rejects_explicit_app_approval_until_paused() {
        let manager = SessionManager::new();
        let settings = test_settings();
        let active = grant_goal_directed(&manager, ComputerUseScope::Full, false);

        assert_eq!(
            manager
                .approve_app(
                    &active.id,
                    "com.apple.Notes",
                    "Notes",
                    AppControlTier::FullControl,
                    false,
                    &settings,
                )
                .unwrap_err(),
            DenyCode::SessionPaused,
        );
        assert!(manager.current().unwrap().approved_apps.is_empty());
    }

    #[test]
    fn terminal_and_ide_approvals_are_capped_at_click_only() {
        use crate::models::computer_use::AppControlTier;

        for bundle_id in ["com.apple.Terminal", "com.microsoft.VSCode"] {
            assert_eq!(
                maximum_tier_for_bundle(bundle_id),
                AppControlTier::ClickOnly,
                "{bundle_id}",
            );
        }
    }

    #[test]
    fn unclassified_apps_follow_the_documented_full_control_default() {
        use crate::models::computer_use::AppControlTier;

        assert_eq!(
            maximum_tier_for_bundle("com.example.UnclassifiedDesktopApp"),
            AppControlTier::FullControl,
        );
    }

    #[test]
    fn unenumerated_browser_and_finance_apps_are_capped_at_view_only() {
        use crate::models::computer_use::AppControlTier;

        for (bundle_id, display_name) in [
            ("company.arc", "Arc Browser"),
            ("io.example.ChromiumNightly", "Nightly"),
            ("com.vendor.brokerdesk", "Broker Desk"),
            ("io.example.marketwatch", "Finance Monitor"),
        ] {
            assert_eq!(
                maximum_tier_for_app(bundle_id, display_name),
                AppControlTier::ViewOnly,
                "{bundle_id} / {display_name}",
            );
        }
    }

    #[test]
    fn unenumerated_terminal_and_ide_apps_are_capped_at_click_only() {
        use crate::models::computer_use::AppControlTier;

        for (bundle_id, display_name) in [
            ("co.example.hyperterminal", "Hyper Terminal"),
            ("dev.zed.Zed", "Zed"),
            ("com.apple.dt.Xcode", "Xcode"),
            ("io.example.editor", "Example IDE"),
        ] {
            assert_eq!(
                maximum_tier_for_app(bundle_id, display_name),
                AppControlTier::ClickOnly,
                "{bundle_id} / {display_name}",
            );
        }
    }

    #[test]
    fn explicitly_known_generic_smoke_apps_retain_full_control() {
        use crate::models::computer_use::AppControlTier;

        for bundle_id in ["com.apple.Notes", "com.apple.TextEdit"] {
            assert_eq!(
                maximum_tier_for_bundle(bundle_id),
                AppControlTier::FullControl,
                "{bundle_id}",
            );
        }
    }

    #[test]
    fn system_settings_requires_sentinel_confirmation() {
        use crate::models::computer_use::AppControlTier;

        let m = SessionManager::new();
        let session = grant_goal_directed(&m, ComputerUseScope::Full, false);
        let settings = ComputerUseSettings {
            enabled: true,
            ..ComputerUseSettings::default()
        };
        m.pause(&session.id).expect("pause before approval");
        assert_eq!(
            m.approve_app(
                &session.id,
                "com.apple.systempreferences",
                "System Settings",
                AppControlTier::FullControl,
                false,
                &settings,
            )
            .unwrap_err(),
            DenyCode::ConfirmationRequired,
        );
        assert!(m
            .approve_app(
                &session.id,
                "com.apple.systempreferences",
                "System Settings",
                AppControlTier::FullControl,
                true,
                &settings,
            )
            .is_ok());
    }
}
