// TrayService is wired to the renderer in a later phase.
#![allow(dead_code)]

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::models::types::{MenuBarState, UserSettings};

/// Tray execution state. Mirrors Electron's `MenuBarState.execution`
/// (src/shared/types.ts). The renderer pushes these via `update_menu_bar`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayExecution {
    Idle,
    Thinking,
    Tool,
    Permission,
    Done,
    Error,
}

impl TrayExecution {
    /// Parses the renderer's string into a typed enum. Unknown values
    /// default to `Idle` so a renderer bug never wedges the tray.
    pub fn parse(s: &str) -> Self {
        match s {
            "thinking" => Self::Thinking,
            "tool" => Self::Tool,
            "permission" => Self::Permission,
            "done" => Self::Done,
            "error" => Self::Error,
            _ => Self::Idle,
        }
    }

    /// Returns the spinner glyph for the current state. Mirrors Electron's
    /// `SPINNER_FRAMES` (trayStatusService.ts:15).
    pub fn spinner_frame(&self, frame_index: usize) -> &'static str {
        const SPINNER: [&str; 10] = [
            "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
        ];
        match self {
            Self::Thinking | Self::Tool | Self::Permission => SPINNER[frame_index % SPINNER.len()],
            _ => "",
        }
    }

    /// Returns the macOS title-bar text for the current state. Mirrors
    /// Electron's `titleForState` (trayStatusService.ts:117):
    ///   `${spinner}Verboo ${label}${elapsed}`
    /// where `label` is the localized state name ("thinking", "working",
    /// "permission", "done", "error") and `elapsed` is the seconds since
    /// the state began (only shown while active).
    pub fn title(&self, label: Option<&str>, elapsed_secs: Option<u64>) -> String {
        let spinner = self.spinner_frame(0);
        let state_label = match self {
            Self::Idle => label.unwrap_or("ready"),
            Self::Thinking => "thinking",
            Self::Tool => "working",
            Self::Permission => "permission",
            Self::Done => "done",
            Self::Error => "error",
        };
        let elapsed_str = match (self, elapsed_secs) {
            (Self::Thinking | Self::Tool | Self::Permission, Some(secs)) if secs > 0 => {
                format!(" {}", format_elapsed(secs))
            }
            _ => String::new(),
        };
        if spinner.is_empty() {
            format!("Verboo {state_label}{elapsed_str}")
        } else {
            format!("{spinner}Verboo {state_label}{elapsed_str}")
        }
    }

    /// Returns the icon frame index (0..4) for the breathing animation.
    /// Mirrors Electron's `ICON_FRAME_SIZES` (trayStatusService.ts:14).
    pub fn icon_frame(&self, frame_index: usize) -> usize {
        const FRAMES: [usize; 4] = [18, 17, 16, 17];
        match self {
            Self::Thinking | Self::Tool | Self::Permission => FRAMES[frame_index % FRAMES.len()],
            _ => 18,
        }
    }

    /// Returns true if the state should auto-reset to Idle after ~3.5s.
    /// Mirrors Electron's `RESET_AFTER_MS = 3500`.
    pub fn should_auto_reset(&self) -> bool {
        matches!(self, Self::Done | Self::Error)
    }
}

/// Tray state machine. Owns the current execution state, the ticker
/// deadline, and the user settings (for `showInMenuBar`). The actual
/// `TrayIcon` lives in `lib.rs` because it needs an `AppHandle`; this
/// struct is pure and testable.
///
/// Internally `Arc<Mutex<State>>` so it can be cloned into the background
/// tick thread that drives the spinner animation + 3.5s auto-reset.
#[derive(Clone)]
pub struct TrayService {
    state: Arc<Mutex<State>>,
}

#[derive(Debug, Clone)]
struct State {
    enabled: bool,
    show_text: bool,
    execution: TrayExecution,
    label: Option<String>,
    last_change_at: Option<Instant>,
    last_pushed_at: Option<Instant>,
    frame_index: usize,
    /// Last title string pushed to the OS — skip set_title when unchanged
    /// (prevents menu-bar text jitter when the ticker fires every 250ms).
    last_title: Option<String>,
}

impl TrayService {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                // Default true until settings are applied at startup (matches UI default).
                enabled: true,
                show_text: true,
                execution: TrayExecution::Idle,
                label: None,
                last_change_at: None,
                last_pushed_at: None,
                frame_index: 0,
                last_title: None,
            })),
        }
    }

    /// Cheap clone — bumps Arc refcount. Used by the background tick thread.
    pub fn handle(&self) -> TrayService {
        self.clone()
    }

    /// Applies user settings. When `show_in_menu_bar` is false, the tray
    /// is hidden (caller responsibility). Mirrors Electron's `configure`.
    pub fn configure(&self, settings: &UserSettings) {
        if let Ok(mut state) = self.state.lock() {
            state.enabled = settings.show_in_menu_bar;
            state.show_text = settings.show_menu_bar_text;
            // Force title recompute after settings change.
            state.last_title = None;
        }
    }

    /// Returns true if the tray should be visible.
    pub fn is_enabled(&self) -> bool {
        self.state
            .lock()
            .map(|s| s.enabled)
            .unwrap_or(false)
    }

    /// Whether the macOS status-item title text should be shown.
    pub fn show_text(&self) -> bool {
        self.state
            .lock()
            .map(|s| s.show_text && s.enabled)
            .unwrap_or(false)
    }

    /// Updates the execution state from a renderer-pushed `MenuBarState`.
    /// Returns the new (execution, label) pair so the caller can re-render
    /// the tray icon/title.
    pub fn update_menu_bar(&self, mb_state: MenuBarState) -> (TrayExecution, Option<String>) {
        if let Ok(mut state) = self.state.lock() {
            let new_exec = TrayExecution::parse(&mb_state.execution);
            if new_exec != state.execution {
                state.execution = new_exec;
                state.last_change_at = Some(Instant::now());
                state.frame_index = 0;
                state.last_title = None;
            } else if new_exec == TrayExecution::Idle {
                // Always re-anchor idle so a stuck timer cannot keep counting
                // after the renderer has already reported idle.
                state.last_change_at = Some(Instant::now());
            }
            state.last_pushed_at = Some(Instant::now());
            // Prefer an explicit idle label; while active keep the state name
            // (ignore model/context fields — they were thrashing the title).
            state.label = mb_state.label.clone();
            return (state.execution, state.label.clone());
        }
        (TrayExecution::Idle, None)
    }

    /// Returns `Some(title)` only when the title string changed since the last
    /// call — callers should skip `set_title` when this returns `None`.
    pub fn take_title_if_changed(&self) -> Option<String> {
        let next = self.title();
        let Ok(mut state) = self.state.lock() else {
            return Some(next);
        };
        if !state.enabled || !state.show_text {
            if state.last_title.as_deref() == Some("") {
                return None;
            }
            state.last_title = Some(String::new());
            return Some(String::new());
        }
        if state.last_title.as_ref() == Some(&next) {
            return None;
        }
        state.last_title = Some(next.clone());
        Some(next)
    }

    /// Returns the current execution state.
    pub fn execution(&self) -> TrayExecution {
        self.state
            .lock()
            .map(|s| s.execution)
            .unwrap_or(TrayExecution::Idle)
    }

    /// Returns the macOS title text for the current state, including the
    /// spinner glyph + elapsed seconds. Computed from the current frame
    /// index and `last_change_at` timestamp.
    pub fn title(&self) -> String {
        let (exec, label, last_change) = match self.state.lock() {
            Ok(s) => (s.execution, s.label.clone(), s.last_change_at),
            Err(_) => return "Verboo ready".into(),
        };
        let elapsed_secs = last_change.map(|t| t.elapsed().as_secs());
        let state_label = match exec {
            TrayExecution::Idle => label.as_deref().unwrap_or("ready"),
            TrayExecution::Thinking => "thinking",
            TrayExecution::Tool => "working",
            TrayExecution::Permission => "permission",
            TrayExecution::Done => "done",
            TrayExecution::Error => "error",
        };
        let elapsed_str = match (&exec, elapsed_secs) {
            (TrayExecution::Thinking | TrayExecution::Tool | TrayExecution::Permission, Some(secs))
                if secs > 0 =>
            {
                format!(" {}", format_elapsed(secs))
            }
            _ => String::new(),
        };
        // No braille spinner in the title: the "working" animation lives in the
        // pulsing mascot icon. The spinner glyphs render at slightly different
        // widths in the menu-bar font, so cycling them every 250ms jittered the
        // whole title. The elapsed text only grows when the unit rolls over
        // (s → m → h), never per frame — so the width is stable.
        format!("Verboo {state_label}{elapsed_str}")
    }

    /// Returns the spinner glyph for the current frame. Empty string if
    /// the state is not animated.
    pub fn spinner(&self) -> String {
        let (exec, frame) = match self.state.lock() {
            Ok(s) => (s.execution, s.frame_index),
            Err(_) => return String::new(),
        };
        exec.spinner_frame(frame).into()
    }

    /// Returns the icon frame size for the current state.
    pub fn icon_frame(&self) -> usize {
        let (exec, frame) = match self.state.lock() {
            Ok(s) => (s.execution, s.frame_index),
            Err(_) => return 18,
        };
        exec.icon_frame(frame)
    }

    /// Advances the animation frame. Returns true if the caller should
    /// re-render the tray icon/title.
    pub fn tick(&self) -> bool {
        if let Ok(mut state) = self.state.lock() {
            if matches!(
                state.execution,
                TrayExecution::Thinking | TrayExecution::Tool | TrayExecution::Permission
            ) {
                state.frame_index = state.frame_index.wrapping_add(1);
                return true;
            }
        }
        false
    }

    /// Returns true if the current state should auto-reset to Idle
    /// (Done/Error after ~3.5s). The caller is responsible for calling
    /// `reset_to_idle` when this returns true.
    pub fn should_reset(&self) -> bool {
        let Ok(state) = self.state.lock() else {
            return false;
        };
        if !state.execution.should_auto_reset() {
            return false;
        }
        match state.last_change_at {
            Some(t) => t.elapsed() >= Duration::from_millis(3500),
            None => false,
        }
    }

    /// Resets to Idle. Called by the caller after `should_reset` returns true.
    pub fn reset_to_idle(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.execution = TrayExecution::Idle;
            state.last_change_at = Some(Instant::now());
            state.frame_index = 0;
            state.last_title = None;
        }
    }

    /// Force the tray to Idle unconditionally. Idempotent — safe to call
    /// multiple times. Used by the renderer on turn `done` / `error` / abort
    /// so a lagging `thinking` event can never resurrect a dead timer.
    pub fn force_idle(&self) {
        self.reset_to_idle();
    }

    /// Heartbeat query: returns the current execution state. If the state
    /// has been active (`Thinking|Tool|Permission`) for more than
    /// `STALE_THRESHOLD` without a renderer push, auto-resets to Idle and
    /// returns Idle. The renderer should call this on its 2.5s heartbeat
    /// instead of re-pushing a stale `menuBarStateRef` (which could resurrect
    /// a completed turn's timer).
    pub fn heartbeat(&self) -> TrayExecution {
        const STALE_THRESHOLD: Duration = Duration::from_secs(300);
        if let Ok(mut state) = self.state.lock() {
            let is_active = matches!(
                state.execution,
                TrayExecution::Thinking | TrayExecution::Tool | TrayExecution::Permission
            );
            let stale = is_active
                && state
                    .last_pushed_at
                    .map(|t| t.elapsed() >= STALE_THRESHOLD)
                    .unwrap_or(false);
            if stale {
                state.execution = TrayExecution::Idle;
                state.last_change_at = Some(Instant::now());
                state.frame_index = 0;
                state.last_title = None;
            }
            state.execution
        } else {
            TrayExecution::Idle
        }
    }
}

impl Default for TrayService {
    fn default() -> Self {
        Self::new()
    }
}

/// Formats an elapsed duration the way Electron's tray did: seconds roll up
/// into minutes at 60s, and minutes into hours at 60m. e.g. `45s`, `1m 5s`,
/// `1h 3m`.
fn format_elapsed(total_secs: u64) -> String {
    let hours = total_secs / 3600;
    let minutes = (total_secs % 3600) / 60;
    let seconds = total_secs % 60;
    if hours > 0 {
        format!("{hours}h {minutes}m")
    } else if minutes > 0 {
        format!("{minutes}m {seconds}s")
    } else {
        format!("{seconds}s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{
        AccessMode, CompletionNotificationMode, GoalModeSettings, LanguageCode, PersonalityMode,
        UpdateChannel, UpdateSettings,
    };

    fn settings(show_in_menu_bar: bool) -> UserSettings {
        UserSettings {
            language: LanguageCode::EnUs,
            default_access_mode: AccessMode::Auto,
            full_access_enabled: false,
            last_selected_model_id: None,
            show_in_menu_bar,
            show_menu_bar_text: true,
            stay_signed_in: true,
            prevent_sleep_while_running: false,
            completion_notifications: CompletionNotificationMode::Always,
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
                enabled: false,
                max_turns: 3,
                max_elapsed_minutes: 30,
                allow_auto_access: false,
            },
            updates: UpdateSettings {
                channel: UpdateChannel::Beta,
                auto_check: true,
                auto_download: false,
            },
            vision_fallback_consent: crate::models::types::VisionFallbackConsent::Ask,
            trusted_skills: Vec::new(),
            avatar: None,
            include_verboo_co_author: false,
            effort_by_model: std::collections::HashMap::new(),
            load_web_icons: true,
        }
    }

    fn menu_bar(execution: &str) -> MenuBarState {
        MenuBarState {
            execution: execution.into(),
            label: None,
            started_at: None,
            model_id: None,
            model_display_name: None,
            context_window: None,
            context_usage: None,
            working_directory: None,
            logged_in: None,
            email: None,
        }
    }

    #[test]
    fn parse_recognizes_known_states() {
        assert_eq!(TrayExecution::parse("thinking"), TrayExecution::Thinking);
        assert_eq!(TrayExecution::parse("tool"), TrayExecution::Tool);
        assert_eq!(TrayExecution::parse("permission"), TrayExecution::Permission);
        assert_eq!(TrayExecution::parse("done"), TrayExecution::Done);
        assert_eq!(TrayExecution::parse("error"), TrayExecution::Error);
    }

    #[test]
    fn parse_defaults_to_idle_for_unknown() {
        assert_eq!(TrayExecution::parse(""), TrayExecution::Idle);
        assert_eq!(TrayExecution::parse("unknown"), TrayExecution::Idle);
        assert_eq!(TrayExecution::parse("THINKING"), TrayExecution::Idle);
    }

    #[test]
    fn title_for_each_state_no_elapsed() {
        // No elapsed_secs → just spinner + label.
        assert_eq!(TrayExecution::Idle.title(None, None), "Verboo ready");
        assert_eq!(TrayExecution::Idle.title(Some("Custom"), None), "Verboo Custom");
        // Active states include the spinner.
        let title = TrayExecution::Thinking.title(None, None);
        assert!(title.starts_with('⠋') || title.starts_with('⠙') || title.contains("Verboo thinking"));
        let title = TrayExecution::Tool.title(None, None);
        assert!(title.contains("Verboo working"));
        // Permission is an active state — includes the spinner.
        let perm_title = TrayExecution::Permission.title(None, None);
        assert!(perm_title.contains("Verboo permission"));
        assert!(!perm_title.starts_with("Verboo"));
        assert_eq!(TrayExecution::Done.title(None, None), "Verboo done");
        assert_eq!(TrayExecution::Error.title(None, None), "Verboo error");
    }

    #[test]
    fn title_includes_elapsed_for_active_states() {
        let title = TrayExecution::Thinking.title(None, Some(5));
        assert!(title.ends_with(" 5s"));
        // Idle never shows elapsed.
        let title = TrayExecution::Idle.title(None, Some(5));
        assert!(!title.contains("5s"));
        // Done/Error never show elapsed.
        assert!(!TrayExecution::Done.title(None, Some(5)).contains("5s"));
        assert!(!TrayExecution::Error.title(None, Some(5)).contains("5s"));
    }

    #[test]
    fn spinner_only_for_active_states() {
        assert_eq!(TrayExecution::Idle.spinner_frame(0), "");
        assert_eq!(TrayExecution::Done.spinner_frame(0), "");
        assert_eq!(TrayExecution::Error.spinner_frame(0), "");
        // Active states return a non-empty braille glyph.
        assert!(!TrayExecution::Thinking.spinner_frame(0).is_empty());
        assert!(!TrayExecution::Tool.spinner_frame(0).is_empty());
        assert!(!TrayExecution::Permission.spinner_frame(0).is_empty());
    }

    #[test]
    fn spinner_cycles_through_frames() {
        let mut frames = Vec::new();
        for i in 0..12 {
            frames.push(TrayExecution::Thinking.spinner_frame(i));
        }
        // Frame 0 and frame 10 should match (cycle of 10).
        assert_eq!(frames[0], frames[10]);
        // All frames are non-empty.
        assert!(frames.iter().all(|s| !s.is_empty()));
    }

    #[test]
    fn icon_frame_cycles_through_4_sizes() {
        let frames: Vec<usize> = (0..8).map(|i| TrayExecution::Thinking.icon_frame(i)).collect();
        assert_eq!(frames[0], 18);
        assert_eq!(frames[1], 17);
        assert_eq!(frames[2], 16);
        assert_eq!(frames[3], 17);
        assert_eq!(frames[4], 18); // cycle
        assert_eq!(frames[5], 17);
    }

    #[test]
    fn icon_frame_static_for_idle() {
        for i in 0..10 {
            assert_eq!(TrayExecution::Idle.icon_frame(i), 18);
        }
    }

    #[test]
    fn should_auto_reset_only_for_done_and_error() {
        assert!(!TrayExecution::Idle.should_auto_reset());
        assert!(!TrayExecution::Thinking.should_auto_reset());
        assert!(!TrayExecution::Tool.should_auto_reset());
        assert!(!TrayExecution::Permission.should_auto_reset());
        assert!(TrayExecution::Done.should_auto_reset());
        assert!(TrayExecution::Error.should_auto_reset());
    }

    #[test]
    fn configure_enables_tray_when_setting_true() {
        let service = TrayService::new();
        // Default is enabled (matches UI default) until settings load.
        assert!(service.is_enabled());
        // Round-trip: off then on again must stick.
        service.configure(&settings(false));
        assert!(!service.is_enabled());
        service.configure(&settings(true));
        assert!(service.is_enabled());
    }

    #[test]
    fn configure_disables_tray_when_setting_false() {
        let service = TrayService::new();
        service.configure(&settings(true));
        assert!(service.is_enabled());
        service.configure(&settings(false));
        assert!(!service.is_enabled());
    }

    #[test]
    fn update_menu_bar_transitions_state() {
        let service = TrayService::new();
        let (exec, _) = service.update_menu_bar(menu_bar("thinking"));
        assert_eq!(exec, TrayExecution::Thinking);
        let (exec, _) = service.update_menu_bar(menu_bar("done"));
        assert_eq!(exec, TrayExecution::Done);
    }

    #[test]
    fn update_menu_bar_unknown_state_resets_to_idle() {
        let service = TrayService::new();
        service.update_menu_bar(menu_bar("thinking"));
        let (exec, _) = service.update_menu_bar(menu_bar("garbage"));
        assert_eq!(exec, TrayExecution::Idle);
    }

    #[test]
    fn tick_advances_frame_only_for_active_states() {
        let service = TrayService::new();
        // Idle: tick is a no-op.
        assert!(!service.tick());
        service.update_menu_bar(menu_bar("thinking"));
        // Active: tick advances.
        assert!(service.tick());
        assert!(service.tick());
    }

    #[test]
    fn should_reset_returns_false_immediately_after_done() {
        let service = TrayService::new();
        service.update_menu_bar(menu_bar("done"));
        assert!(!service.should_reset());
    }

    #[test]
    fn should_reset_returns_true_after_3_5s() {
        let service = TrayService::new();
        service.update_menu_bar(menu_bar("done"));
        // Manually backdate the last_change_at to simulate elapsed time.
        {
            let mut state = service.state.lock().unwrap();
            state.last_change_at = Some(Instant::now() - Duration::from_millis(4000));
        }
        assert!(service.should_reset());
    }

    #[test]
    fn reset_to_idle_clears_state() {
        let service = TrayService::new();
        service.update_menu_bar(menu_bar("error"));
        service.reset_to_idle();
        assert_eq!(service.execution(), TrayExecution::Idle);
    }

    #[test]
    fn title_uses_label_when_idle() {
        let service = TrayService::new();
        let mut mb = menu_bar("idle");
        mb.label = Some("Custom label".into());
        service.update_menu_bar(mb);
        assert_eq!(service.title(), "Verboo Custom label");
    }

    #[test]
    fn title_falls_back_to_ready_when_no_label() {
        let service = TrayService::new();
        service.update_menu_bar(menu_bar("idle"));
        assert_eq!(service.title(), "Verboo ready");
    }

    #[test]
    fn force_idle_is_idempotent() {
        // Regression for BUG 2b: force_idle must clear the timer no matter
        // what state the tray was in, and must be safe to call multiple times.
        let service = TrayService::new();
        service.update_menu_bar(menu_bar("thinking"));
        service.force_idle();
        assert_eq!(service.execution(), TrayExecution::Idle);
        // Second call is a no-op (already idle) — must not panic.
        service.force_idle();
        service.force_idle();
        assert_eq!(service.execution(), TrayExecution::Idle);
    }

    #[test]
    fn force_idle_clears_title_so_next_render_pushes() {
        // force_idle must reset last_title so the next tick re-pushes the
        // idle title (otherwise the stale "thinking 5s" stays on screen).
        let service = TrayService::new();
        service.update_menu_bar(menu_bar("thinking"));
        // Simulate the tick loop capturing the title.
        let _ = service.title();
        let _ = service.take_title_if_changed();
        service.force_idle();
        // After force_idle, take_title_if_changed must return Some (the idle
        // title) so the caller re-pushes it to the OS.
        let next = service.take_title_if_changed();
        assert!(next.is_some());
        assert_eq!(next.unwrap(), "Verboo ready");
    }

    #[test]
    fn heartbeat_returns_idle_when_idle() {
        let service = TrayService::new();
        service.update_menu_bar(menu_bar("idle"));
        assert_eq!(service.heartbeat(), TrayExecution::Idle);
    }

    #[test]
    fn heartbeat_auto_resets_stale_active_state() {
        // Regression for BUG 2b: if the tray has been "thinking" for >5min
        // without a renderer push, the heartbeat must auto-reset to idle so
        // the timer cannot count forever after a completed turn.
        let service = TrayService::new();
        service.update_menu_bar(menu_bar("thinking"));
        // Backdate last_pushed_at to simulate 6 minutes without a push.
        {
            let mut state = service.state.lock().unwrap();
            state.last_pushed_at = Some(Instant::now() - Duration::from_secs(360));
        }
        let exec = service.heartbeat();
        assert_eq!(exec, TrayExecution::Idle);
        // State must be persisted — a subsequent heartbeat also returns Idle.
        assert_eq!(service.heartbeat(), TrayExecution::Idle);
    }

    #[test]
    fn heartbeat_does_not_reset_fresh_active_state() {
        // A genuinely active turn (pushed recently) must not be reset.
        let service = TrayService::new();
        service.update_menu_bar(menu_bar("thinking"));
        // No backdating — last_pushed_at is ~now.
        assert_eq!(service.heartbeat(), TrayExecution::Thinking);
    }

    #[test]
    fn heartbeat_auto_reset_clears_title_for_repush() {
        let service = TrayService::new();
        service.update_menu_bar(menu_bar("thinking"));
        let _ = service.take_title_if_changed(); // capture "thinking" title
        {
            let mut state = service.state.lock().unwrap();
            state.last_pushed_at = Some(Instant::now() - Duration::from_secs(360));
        }
        let _ = service.heartbeat();
        // After auto-reset, the idle title must be available for re-push.
        let next = service.take_title_if_changed();
        assert!(next.is_some());
        assert_eq!(next.unwrap(), "Verboo ready");
    }

    #[test]
    fn configure_sets_show_text_from_settings() {
        // Regression for BUG 3b: show_menu_bar_text must be honored.
        let service = TrayService::new();
        let mut s = settings(true);
        s.show_menu_bar_text = false;
        service.configure(&s);
        assert!(service.is_enabled());
        assert!(!service.show_text());
        s.show_menu_bar_text = true;
        service.configure(&s);
        assert!(service.show_text());
    }

    #[test]
    fn take_title_if_changed_suppresses_repeats() {
        // Regression for BUG 2a: the tick loop must NOT call set_title when
        // the string hasn't changed (prevents menu-bar jitter every 250ms).
        let service = TrayService::new();
        service.update_menu_bar(menu_bar("idle"));
        let first = service.take_title_if_changed();
        assert!(first.is_some()); // initial push
        // Immediately again — string unchanged, must return None.
        let second = service.take_title_if_changed();
        assert!(second.is_none());
        // After a state change, a new title must be returned.
        service.update_menu_bar(menu_bar("error"));
        let third = service.take_title_if_changed();
        assert!(third.is_some());
        assert_eq!(third.unwrap(), "Verboo error");
    }
}
