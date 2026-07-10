// Renderer-facing helpers — called from the Tauri runtime once the renderer
// bridge exposes `send_notification` and friends.
#![allow(dead_code)]

use crate::models::types::{CompletionNotificationMode, LanguageCode, UserSettings};

/// Notification key — which kind of notification the renderer wants to fire.
/// Mirrors Electron's `notificationText` keys
/// (src/main/index.ts:569).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationKind {
    Permission,
    Question,
    Error,
    Done,
    DoneError,
}

/// Result of a notification decision: either send it or skip per user settings.
#[derive(Debug, Clone, PartialEq)]
pub struct NotificationText {
    pub title: String,
    pub body: String,
}

/// Decides whether a completion notification should fire.
///
/// - `never` → never fire
/// - `background` → fire when the user is NOT looking at the conversation
///   that finished. "Not looking" means: the window is not focused, OR
///   the conversation that finished is not the active one (multichat: user
///   is in conversation A, conversation B finishes → fire).
/// - `always` → fire unconditionally (unless the user is actively looking
///   at the finished conversation in a focused window — the caller's
///   early-return handles that case).
pub fn should_fire_completion(
    settings: &UserSettings,
    kind: NotificationKind,
    window_focused: bool,
    is_active_conversation: bool,
) -> bool {
    match kind {
        NotificationKind::Done | NotificationKind::DoneError => match settings.completion_notifications {
            CompletionNotificationMode::Never => false,
            CompletionNotificationMode::Background => {
                // Fire if the user is not looking at THIS conversation.
                // "Not looking" = window not focused OR this is not the
                // active conversation (multichat scenario).
                !window_focused || !is_active_conversation
            }
            CompletionNotificationMode::Always => true,
        },
        NotificationKind::Permission => settings.permission_notifications,
        NotificationKind::Question => settings.question_notifications,
        NotificationKind::Error => true, // errors always fire
    }
}
/// Electron's `notificationText` (src/main/index.ts:569).
pub fn notification_text(
    settings: &UserSettings,
    kind: NotificationKind,
) -> NotificationText {
    let pt = settings.language == LanguageCode::PtBr;
    let (title_pt, body_pt, title_en, body_en) = match kind {
        NotificationKind::Permission => (
            "Verboo precisa de permissão",
            "Revise a solicitação no app.",
            "Verboo needs permission",
            "Review the request in the app.",
        ),
        NotificationKind::Question => (
            "Verboo precisa de uma resposta",
            "Volte ao app para continuar.",
            "Verboo needs an answer",
            "Return to the app to continue.",
        ),
        NotificationKind::Error => (
            "Verboo encontrou um erro",
            "Toque para ver os detalhes.",
            "Verboo hit an error",
            "Tap to see the details.",
        ),
        NotificationKind::Done => (
            "Verboo concluiu",
            "Toque para ver a resposta.",
            "Verboo finished",
            "Tap to see the response.",
        ),
        NotificationKind::DoneError => (
            "Verboo terminou com erro",
            "Toque para ver os detalhes.",
            "Verboo finished with an error",
            "Tap to see the details.",
        ),
    };
    if pt {
        NotificationText {
            title: title_pt.into(),
            body: body_pt.into(),
        }
    } else {
        NotificationText {
            title: title_en.into(),
            body: body_en.into(),
        }
    }
}

/// Returns the notification to actually fire, or None if suppressed by
/// settings. Convenience wrapper.
pub fn fire_notification(
    settings: &UserSettings,
    kind: NotificationKind,
    window_focused: bool,
    is_active_conversation: bool,
) -> Option<NotificationText> {
    if !should_fire_completion(settings, kind, window_focused, is_active_conversation) {
        return None;
    }
    Some(notification_text(settings, kind))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{PersonalityMode, UpdateSettings};

    fn settings_pt(completion: CompletionNotificationMode) -> UserSettings {
        UserSettings {
            language: LanguageCode::PtBr,
            default_access_mode: crate::models::types::AccessMode::Auto,
            full_access_enabled: false,
            last_selected_model_id: None,
            show_in_menu_bar: true,
            show_menu_bar_text: true,
            stay_signed_in: true,
            prevent_sleep_while_running: false,
            completion_notifications: completion,
            permission_notifications: true,
            question_notifications: true,
            response_enhancements_enabled: false,
            personality: PersonalityMode::Pragmatic,
            custom_instructions: String::new(),
            trusted_commands: Vec::new(),
            memories_enabled: false,
            chronicle_preview: false,
            ignore_tool_chats_for_memory: true,
            goal_mode: crate::models::types::GoalModeSettings {
                enabled: false,
                max_turns: 3,
                max_elapsed_minutes: 30,
                allow_auto_access: false,
            },
            updates: UpdateSettings {
                channel: crate::models::types::UpdateChannel::Beta,
                auto_check: true,
                auto_download: false,
            },
            vision_fallback_consent: crate::models::types::VisionFallbackConsent::Ask,
            trusted_skills: Vec::new(),
            avatar: None,
        }
    }

    fn settings_en(completion: CompletionNotificationMode) -> UserSettings {
        let mut s = settings_pt(completion);
        s.language = LanguageCode::EnUs;
        s
    }

    #[test]
    fn notification_text_pt_for_done() {
        let settings = settings_pt(CompletionNotificationMode::Always);
        let text = notification_text(&settings, NotificationKind::Done);
        assert_eq!(text.title, "Verboo concluiu");
        assert_eq!(text.body, "Toque para ver a resposta.");
    }

    #[test]
    fn notification_text_en_for_permission() {
        let settings = settings_en(CompletionNotificationMode::Always);
        let text = notification_text(&settings, NotificationKind::Permission);
        assert_eq!(text.title, "Verboo needs permission");
        assert_eq!(text.body, "Review the request in the app.");
    }

    #[test]
    fn completion_never_suppresses_done() {
        let settings = settings_en(CompletionNotificationMode::Never);
        assert!(!should_fire_completion(
            &settings,
            NotificationKind::Done,
            false,
            false,
        ));
    }

    #[test]
    fn completion_background_suppresses_when_focused_and_active() {
        // User is looking at the conversation that finished (active + focused)
        // → suppress in background mode.
        let settings = settings_en(CompletionNotificationMode::Background);
        assert!(!should_fire_completion(
            &settings,
            NotificationKind::Done,
            true,  // window focused
            true,  // is active conversation
        ));
    }

    #[test]
    fn completion_background_fires_when_unfocused() {
        // Window not focused → fire (user is not looking at the app).
        let settings = settings_en(CompletionNotificationMode::Background);
        assert!(should_fire_completion(
            &settings,
            NotificationKind::Done,
            false, // window not focused
            true,  // is active conversation (doesn't matter — window unfocused)
        ));
    }

    #[test]
    fn completion_background_fires_when_other_conversation_active() {
        // MULTICHAT SCENARIO: user is in conversation A (window focused),
        // conversation B finishes. is_active_conversation=false → fire.
        // This is the bug that was fixed: the old code only checked
        // window_focused, so it suppressed the notification even though
        // the user was looking at a DIFFERENT conversation.
        let settings = settings_en(CompletionNotificationMode::Background);
        assert!(should_fire_completion(
            &settings,
            NotificationKind::Done,
            true,  // window focused (user is in conversation A)
            false, // but the finished conversation is B, not A
        ));
    }

    #[test]
    fn completion_always_fires_regardless_of_focus() {
        let settings = settings_en(CompletionNotificationMode::Always);
        assert!(should_fire_completion(
            &settings,
            NotificationKind::Done,
            true,
            true,
        ));
        assert!(should_fire_completion(
            &settings,
            NotificationKind::Done,
            false,
            false,
        ));
    }

    #[test]
    fn permission_fires_only_if_enabled() {
        let mut settings = settings_en(CompletionNotificationMode::Always);
        settings.permission_notifications = true;
        assert!(should_fire_completion(
            &settings,
            NotificationKind::Permission,
            true,
            true,
        ));
        settings.permission_notifications = false;
        assert!(!should_fire_completion(
            &settings,
            NotificationKind::Permission,
            true,
            true,
        ));
    }

    #[test]
    fn question_fires_only_if_enabled() {
        let mut settings = settings_en(CompletionNotificationMode::Always);
        settings.question_notifications = false;
        assert!(!should_fire_completion(
            &settings,
            NotificationKind::Question,
            true,
            true,
        ));
    }

    #[test]
    fn errors_always_fire() {
        let mut settings = settings_en(CompletionNotificationMode::Never);
        settings.permission_notifications = false;
        settings.question_notifications = false;
        assert!(should_fire_completion(
            &settings,
            NotificationKind::Error,
            true,
            true,
        ));
    }

    #[test]
    fn done_error_respects_completion_mode() {
        let settings = settings_en(CompletionNotificationMode::Never);
        assert!(!should_fire_completion(
            &settings,
            NotificationKind::DoneError,
            false,
            false,
        ));
        let settings = settings_en(CompletionNotificationMode::Background);
        // Unfocused → fires.
        assert!(should_fire_completion(
            &settings,
            NotificationKind::DoneError,
            false,
            false,
        ));
    }

    #[test]
    fn fire_notification_wraps_text() {
        let settings = settings_en(CompletionNotificationMode::Always);
        let result = fire_notification(&settings, NotificationKind::Done, true, true);
        assert!(result.is_some());
        assert_eq!(result.unwrap().title, "Verboo finished");
    }

    #[test]
    fn fire_notification_returns_none_when_suppressed() {
        let settings = settings_en(CompletionNotificationMode::Never);
        assert!(fire_notification(&settings, NotificationKind::Done, true, true).is_none());
    }

    #[test]
    fn all_kinds_have_distinct_titles_in_both_languages() {
        for lang in [LanguageCode::EnUs, LanguageCode::PtBr] {
            let mut s = settings_en(CompletionNotificationMode::Always);
            s.language = lang;
            let titles: Vec<String> = [
                NotificationKind::Permission,
                NotificationKind::Question,
                NotificationKind::Error,
                NotificationKind::Done,
                NotificationKind::DoneError,
            ]
            .iter()
            .map(|k| notification_text(&s, *k).title)
            .collect();
            let deduped: std::collections::HashSet<_> = titles.iter().collect();
            assert_eq!(titles.len(), deduped.len(), "duplicate title for {lang:?}");
        }
    }
}
