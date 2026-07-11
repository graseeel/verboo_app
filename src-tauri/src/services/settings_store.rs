use std::path::PathBuf;
use std::sync::Mutex;

use crate::models::types::UserSettings;

/// Persistent settings store backed by `{app_data_dir}/settings.json`.
///
/// - Loads from disk on first access (lazy), falling back to [`UserSettings::default`].
/// - Writes through to disk on every `update` / `reset`.
/// - Uses mode 0o600 on Unix (Tauri's `app_data_dir` enforces 0o700 on the dir).
pub struct SettingsStore {
    file_path: PathBuf,
    cache: Mutex<Option<UserSettings>>,
}

impl SettingsStore {
    /// Creates a new store that will persist to `{app_data_dir}/settings.json`.
    ///
    /// # Panics
    ///
    /// Panics if `app_data_dir` cannot be determined (should never happen in a
    /// running Tauri app).
    pub fn new(app_data_dir: PathBuf) -> Self {
        let file_path = app_data_dir.join("settings.json");
        Self {
            file_path,
            cache: Mutex::new(None),
        }
    }

    /// Returns the current settings, loading from disk on first call.
    pub fn get(&self) -> Result<UserSettings, String> {
        let mut cache = self.cache.lock().map_err(|e| e.to_string())?;
        if cache.is_none() {
            *cache = Some(self.load_from_disk());
        }
        Ok(cache.as_ref().unwrap().clone())
    }

    /// Merges a partial patch into the current settings and persists.
    ///
    /// Mirrors Electron's `update(patch: Partial<UserSettings>)` which does
    /// `{ ...current, ...patch }` — only fields present in `patch` are
    /// overwritten; missing fields preserve their current value. Nested
    /// objects are merged recursively (so `{ goalMode: { maxTurns: 5 } }`
    /// only changes `goalMode.maxTurns`, leaving other goalMode fields intact).
    ///
    /// The patch must be a JSON object. Non-object patches are rejected.
    pub fn update(&self, patch: serde_json::Value) -> Result<UserSettings, String> {
        let patch_obj = patch
            .as_object()
            .ok_or_else(|| "Settings patch must be a JSON object.".to_string())?;
        let current = self.get()?;
        let mut current_value = serde_json::to_value(&current).map_err(|e| e.to_string())?;
        merge_json(&mut current_value, patch_obj);
        let merged: UserSettings = serde_json::from_value(current_value)
            .map_err(|e| format!("Invalid settings patch: {e}"))?;
        let normalized = self.normalize(&merged);
        self.write_to_disk(&normalized)?;
        let mut cache = self.cache.lock().map_err(|e| e.to_string())?;
        *cache = Some(normalized.clone());
        Ok(normalized)
    }

    /// Resets to defaults and persists immediately.
    pub fn reset(&self) -> Result<UserSettings, String> {
        let defaults = UserSettings::default();
        self.write_to_disk(&defaults)?;
        let mut cache = self.cache.lock().map_err(|e| e.to_string())?;
        *cache = Some(defaults.clone());
        Ok(defaults)
    }

    // ── Private helpers ─────────────────────────────────────────

    fn file_path(&self) -> &std::path::Path {
        &self.file_path
    }

    fn load_from_disk(&self) -> UserSettings {
        match std::fs::read_to_string(self.file_path()) {
            Ok(raw) => match serde_json::from_str::<UserSettings>(&raw) {
                Ok(parsed) => self.normalize(&parsed),
                Err(_) => {
                    // Corrupt file — fall back to defaults
                    UserSettings::default()
                }
            },
            Err(_) => {
                // File doesn't exist yet — use defaults
                UserSettings::default()
            }
        }
    }

    fn write_to_disk(&self, settings: &UserSettings) -> Result<(), String> {
        let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
        // Ensure parent dir exists
        if let Some(parent) = self.file_path().parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(self.file_path(), &json).map_err(|e| e.to_string())?;

        // Set mode 0o600 on Unix (best-effort on other platforms)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(self.file_path()) {
                let mut perms = meta.permissions();
                perms.set_mode(0o600);
                let _ = std::fs::set_permissions(self.file_path(), perms);
            }
        }

        Ok(())
    }

    /// Normalizes a deserialized settings value to ensure no invalid fields
    /// pass through. Mirrors Electron's `normalizeSettings` (settingsService.ts):
    ///   - `default_access_mode='full'` requires `full_access_enabled=true`,
    ///     otherwise it falls back to `approval`.
    ///   - `updates` is forced to `beta` channel with `auto_check=true` and
    ///     `auto_download=true` (matches Electron's `normalizeUpdateSettings`).
    fn normalize(&self, s: &UserSettings) -> UserSettings {
        // Mirror Electron's normalizeAccessMode rule:
        //   mode === 'full' && !fullAccessEnabled ? 'approval' : mode
        let access_mode = match (&s.default_access_mode, s.full_access_enabled) {
            (crate::models::types::AccessMode::Full, false) => {
                crate::models::types::AccessMode::Approval
            }
            (other, _) => other.clone(),
        };

        UserSettings {
            language: s.language.clone(),
            default_access_mode: access_mode,
            full_access_enabled: s.full_access_enabled,
            last_selected_model_id: s.last_selected_model_id.clone(),
            show_in_menu_bar: s.show_in_menu_bar,
            show_menu_bar_text: s.show_menu_bar_text,
            stay_signed_in: s.stay_signed_in,
            prevent_sleep_while_running: s.prevent_sleep_while_running,
            completion_notifications: s.completion_notifications.clone(),
            permission_notifications: s.permission_notifications,
            question_notifications: s.question_notifications,
            response_enhancements_enabled: s.response_enhancements_enabled,
            personality: s.personality.clone(),
            custom_instructions: s.custom_instructions.clone(),
            trusted_commands: s.trusted_commands.clone(),
            custom_slash_commands: s.custom_slash_commands.clone(),
            memories_enabled: s.memories_enabled,
            chronicle_preview: s.chronicle_preview,
            ignore_tool_chats_for_memory: s.ignore_tool_chats_for_memory,
            goal_mode: crate::models::types::GoalModeSettings {
                enabled: s.goal_mode.enabled,
                max_turns: s.goal_mode.max_turns.clamp(1, 20),
                max_elapsed_minutes: s.goal_mode.max_elapsed_minutes.clamp(1, 240),
                allow_auto_access: s.goal_mode.allow_auto_access,
            },
            // Channel is locked to beta while stable builds are not published
            // (Settings UI disables the stable chip). auto_check / auto_download
            // MUST honor the user's toggle — forcing them true made the Updates
            // toggles look broken (UI flipped, next get() snapped back on).
            updates: crate::models::types::UpdateSettings {
                channel: crate::models::types::UpdateChannel::Beta,
                auto_check: s.updates.auto_check,
                auto_download: s.updates.auto_download,
            },
            vision_fallback_consent: s.vision_fallback_consent.clone(),
            trusted_skills: s.trusted_skills.clone(),
            avatar: s.avatar.clone(),
            include_verboo_co_author: s.include_verboo_co_author,
        }
    }
}

// Manual Clone impl — Mutex<Option<UserSettings>> is not Clone
impl Clone for SettingsStore {
    fn clone(&self) -> Self {
        let cache = self.cache.lock().ok().and_then(|c| c.clone());
        Self {
            file_path: self.file_path.clone(),
            cache: Mutex::new(cache),
        }
    }
}

/// Recursively merges `patch` into `target`. For each key in `patch`:
///   - If both `target[key]` and `patch[key]` are objects, merge recursively.
///   - Otherwise, `target[key]` is replaced by `patch[key]`.
///
/// Mirrors Electron's `{ ...current, ...patch }` for shallow keys, plus
/// deep-merge for nested objects (which is what TS spread does on nested
/// objects when the patch explicitly provides a nested object).
fn merge_json(target: &mut serde_json::Value, patch: &serde_json::Map<String, serde_json::Value>) {
    if let Some(target_obj) = target.as_object_mut() {
        for (key, patch_val) in patch {
            let needs_deep_merge = target_obj
                .get(key)
                .and_then(|v| v.as_object())
                .is_some()
                && patch_val.as_object().is_some();
            if needs_deep_merge {
                if let Some(target_sub) = target_obj.get_mut(key).and_then(|v| v.as_object_mut()) {
                    if let Some(patch_sub) = patch_val.as_object() {
                        for (k, v) in patch_sub {
                            target_sub.insert(k.clone(), v.clone());
                        }
                    }
                }
            } else {
                target_obj.insert(key.clone(), patch_val.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{AccessMode, LanguageCode};
    use serde_json::json;

    fn temp_store() -> SettingsStore {
        let dir = std::env::temp_dir().join(format!(
            "verboo-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        SettingsStore::new(dir)
    }

    #[test]
    fn update_partial_patch_preserves_other_fields() {
        let store = temp_store();
        // Set a known state
        let initial = store.get().unwrap();
        assert_eq!(initial.language, LanguageCode::EnUs);

        // Patch only the language — other fields must be preserved.
        let patch = json!({ "language": "pt-BR" });
        let updated = store.update(patch).unwrap();
        assert_eq!(updated.language, LanguageCode::PtBr);
        // Other fields preserved from defaults
        assert_eq!(updated.default_access_mode, AccessMode::Approval);
        assert!(updated.show_in_menu_bar);
        assert!(updated.goal_mode.enabled);
    }

    #[test]
    fn update_partial_patch_for_single_field() {
        let store = temp_store();
        // Patch only `lastSelectedModelId`
        let patch = json!({ "lastSelectedModelId": "claude-sonnet-4-6" });
        let updated = store.update(patch).unwrap();
        assert_eq!(
            updated.last_selected_model_id.as_deref(),
            Some("claude-sonnet-4-6")
        );
        // Language should still be the default
        assert_eq!(updated.language, LanguageCode::EnUs);
    }

    #[test]
    fn update_partial_patch_for_nested_field() {
        let store = temp_store();
        // Patch only `goalMode.maxTurns`
        let patch = json!({ "goalMode": { "maxTurns": 5 } });
        let updated = store.update(patch).unwrap();
        assert_eq!(updated.goal_mode.max_turns, 5);
        // Other goal_mode fields preserved
        assert!(updated.goal_mode.enabled);
        assert!(updated.goal_mode.allow_auto_access);
    }

    #[test]
    fn update_full_patch_also_works() {
        let store = temp_store();
        let mut full = store.get().unwrap();
        full.language = LanguageCode::PtBr;
        let patch = serde_json::to_value(&full).unwrap();
        let updated = store.update(patch).unwrap();
        assert_eq!(updated.language, LanguageCode::PtBr);
    }

    #[test]
    fn update_invalid_patch_type_rejected() {
        let store = temp_store();
        let patch = json!("not-an-object");
        let result = store.update(patch);
        assert!(result.is_err());
    }

    #[test]
    fn update_auto_check_toggle_is_honored() {
        // Regression: normalize used to force auto_check/auto_download true,
        // so the Settings → Updates toggles could never turn off.
        let store = temp_store();
        let updated = store
            .update(json!({
                "updates": { "autoCheck": false, "autoDownload": false }
            }))
            .unwrap();
        assert!(!updated.updates.auto_check);
        assert!(!updated.updates.auto_download);
        // Channel still forced to beta (stable not published yet).
        assert_eq!(
            updated.updates.channel,
            crate::models::types::UpdateChannel::Beta
        );
        // Re-read from disk/cache must keep the user's choice.
        let again = store.get().unwrap();
        assert!(!again.updates.auto_check);
        assert!(!again.updates.auto_download);
    }

    #[test]
    fn update_show_in_menu_bar_toggle_is_honored() {
        let store = temp_store();
        let updated = store
            .update(json!({ "showInMenuBar": false }))
            .unwrap();
        assert!(!updated.show_in_menu_bar);
        assert!(!store.get().unwrap().show_in_menu_bar);
        let restored = store
            .update(json!({ "showInMenuBar": true }))
            .unwrap();
        assert!(restored.show_in_menu_bar);
    }
}
