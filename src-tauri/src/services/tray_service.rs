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
                format!(" {secs}s")
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
    execution: TrayExecution,
    label: Option<String>,
    last_change_at: Option<Instant>,
    frame_index: usize,
}

impl TrayService {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                enabled: false,
                execution: TrayExecution::Idle,
                label: None,
                last_change_at: None,
                frame_index: 0,
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
        }
    }

    /// Returns true if the tray should be visible.
    pub fn is_enabled(&self) -> bool {
        self.state
            .lock()
            .map(|s| s.enabled)
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
            }
            state.label = mb_state.label.clone();
            return (state.execution, state.label.clone());
        }
        (TrayExecution::Idle, None)
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
        let (exec, label, frame, last_change) = match self.state.lock() {
            Ok(s) => (
                s.execution,
                s.label.clone(),
                s.frame_index,
                s.last_change_at,
            ),
            Err(_) => return "Verboo ready".into(),
        };
        let elapsed_secs = last_change.map(|t| t.elapsed().as_secs());
        let spinner = exec.spinner_frame(frame);
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
                format!(" {secs}s")
            }
            _ => String::new(),
        };
        if spinner.is_empty() {
            format!("Verboo {state_label}{elapsed_str}")
        } else {
            format!("{spinner}Verboo {state_label}{elapsed_str}")
        }
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
        }
    }
}

impl Default for TrayService {
    fn default() -> Self {
        Self::new()
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
}
