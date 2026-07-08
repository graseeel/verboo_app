//! Prevent-sleep guard for active agent turns.
//!
//! Mirrors Electron's `powerSaveBlocker` usage in `verbooCliService.ts`
//! (src/main/services/verbooCliService.ts:225-236). When a turn starts and
//! `UserSettings.prevent_sleep_while_running` is true, the guard keeps the
//! system awake (display + idle) until the turn finishes or is interrupted.
//!
//! Cross-platform behavior (from `keepawake` crate):
//!   - macOS: IOKit assertions (`PreventUserIdleSystemSleep` +
//!     `PreventDisplaySleep`).
//!   - Windows: `SetThreadExecutionState` with `ES_CONTINUOUS |
//!     ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED`.
//!   - Linux: systemd-inhibit `idle:sleep` (best-effort; no-op if no D-Bus).
//!
//! The guard is a no-op on unsupported platforms or when the setting is
//! disabled — `TurnService` always calls `start()` and drops the guard at
//! turn end, regardless of platform.

use keepawake::{Builder, KeepAwake};

use crate::models::types::UserSettings;

/// RAII guard that keeps the system awake while alive. Dropping it releases
/// the assertion. `None` means the guard is inactive (setting disabled or
/// creation failed).
pub struct PreventSleepGuard {
    _inner: Option<KeepAwake>,
}

impl PreventSleepGuard {
    /// Start a prevent-sleep guard if `settings.prevent_sleep_while_running`
    /// is true. Returns a guard that releases on drop. Errors are logged and
    /// swallowed — sleep prevention is best-effort and must never break a
    /// turn.
    pub fn start(settings: &UserSettings) -> Self {
        if !settings.prevent_sleep_while_running {
            return Self { _inner: None };
        }
        // keepawake 0.6 API: `Builder::default()` + chainable config + `.create()`
        // returns `Result<KeepAwake, BuilderError>`. See docs.rs/keepawake/0.6.0.
        let inner = match Builder::default()
            .display(true)
            .idle(true)
            .sleep(true)
            .create()
        {
            Ok(ka) => Some(ka),
            Err(e) => {
                eprintln!("[verboo:prevent-sleep] failed to start: {e}");
                None
            }
        };
        Self { _inner: inner }
    }

    /// Returns true if the guard is actively holding a sleep assertion.
    pub fn is_active(&self) -> bool {
        self._inner.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::UserSettings;

    fn default_settings(prevent_sleep: bool) -> UserSettings {
        let mut s = UserSettings::default();
        s.prevent_sleep_while_running = prevent_sleep;
        s
    }

    #[test]
    fn guard_is_inactive_when_setting_disabled() {
        let guard = PreventSleepGuard::start(&default_settings(false));
        assert!(!guard.is_active());
    }

    #[test]
    fn guard_attempts_to_activate_when_setting_enabled() {
        // We can't assert is_active() == true unconditionally because the
        // underlying assertion may fail in headless CI / containers. The
        // contract is: start() never panics, and is_active() reflects whether
        // the assertion was acquired.
        let guard = PreventSleepGuard::start(&default_settings(true));
        let _ = guard.is_active();
    }
}
