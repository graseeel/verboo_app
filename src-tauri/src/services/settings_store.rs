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
            language: s.language,
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
                // Unlimited — safety guard only, no budget.
                max_turns: s.goal_mode.max_turns,
                max_elapsed_minutes: s.goal_mode.max_elapsed_minutes,
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
            effort_by_model: s.effort_by_model.clone(),
            computer_use: normalize_computer_use(&s.computer_use),
        }
    }
}

/// Normalizes Computer Use settings (Kratos P0.5).
///
/// Enforces Maestro-locked policy invariants (Q2, Q7) and clamps ranges.
/// Strip-and-clamp rules — never fail-open:
///   - audit_retention_days        clamp [7, 365]
///   - audit_storage_cap_mb        clamp [10, 10_000]
///   - idle_timeout_seconds        clamp [300, 3600]
///   - self_test_enabled==false    strip all allowlist entries with
///     `is_self_test == true` (architecture §4)
///   - enabled==false              force self_test_enabled=false (can't run
///     self-test when feature is disabled)
///   - denylist                    de-duplicate (case-insensitive)
///   - allowlist                   de-duplicate by bundle_id (case-insensitive,
///     last-wins on conflict)
fn normalize_computer_use(
    s: &crate::models::types::ComputerUseSettings,
) -> crate::models::types::ComputerUseSettings {
    use crate::models::types::{ComputerUseAllowlistEntry, ComputerUseSettings};

    let clamped_retention = s.audit_retention_days.clamp(7, 365);
    let clamped_cap = s.audit_storage_cap_mb.clamp(10, 10_000);
    let clamped_idle = s.idle_timeout_seconds.clamp(300, 3600);

    // `enabled == false` is the top-level kill switch. Self-test cannot run
    // when CU is disabled — architecture §4 requires an active session, and
    // sessions require enabled==true.
    let self_test_enabled = s.enabled && s.self_test_enabled;

    // De-duplicate denylist (case-insensitive, preserve first-seen order).
    let mut seen_deny: std::collections::HashSet<String> = std::collections::HashSet::new();
    let denylist: Vec<String> = s
        .denylist
        .iter()
        .filter_map(|id| {
            let key = id.to_lowercase();
            if seen_deny.contains(&key) {
                None
            } else {
                seen_deny.insert(key);
                Some(id.clone())
            }
        })
        .collect();

    // De-duplicate allowlist by bundle_id (case-insensitive, last-wins).
    // Strip self-test entries when self_test_enabled is false.
    let mut by_bundle: std::collections::HashMap<String, ComputerUseAllowlistEntry> =
        std::collections::HashMap::new();
    for entry in &s.allowlist {
        if !self_test_enabled && entry.is_self_test {
            continue;
        }
        // Even when self-test is enabled, non-self-test entries with the
        // Verboo bundle id are invalid — Verboo is only ever a self-test target.
        let is_verboo = entry
            .bundle_id
            .eq_ignore_ascii_case("ai.verboo.code.desktop");
        if is_verboo && !entry.is_self_test {
            continue;
        }
        // Self-test entries must be on the Verboo bundle.
        if entry.is_self_test && !is_verboo {
            continue;
        }
        by_bundle.insert(entry.bundle_id.to_lowercase(), entry.clone());
    }
    let allowlist: Vec<ComputerUseAllowlistEntry> = by_bundle.into_values().collect();

    ComputerUseSettings {
        enabled: s.enabled,
        self_test_enabled,
        allowlist,
        denylist,
        preferred_visual_executor_id: s
            .preferred_visual_executor_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_owned),
        // Kept on the persisted schema for compatibility, but safe focus
        // isolation always restores every window it minimized.
        restore_hidden_apps: true,
        audit_retention_days: clamped_retention,
        audit_storage_cap_mb: clamped_cap,
        idle_timeout_seconds: clamped_idle,
        telemetry_opt_out: s.telemetry_opt_out,
        show_in_menu_bar: s.show_in_menu_bar,
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
            let needs_deep_merge = target_obj.get(key).and_then(|v| v.as_object()).is_some()
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
        let updated = store.update(json!({ "showInMenuBar": false })).unwrap();
        assert!(!updated.show_in_menu_bar);
        assert!(!store.get().unwrap().show_in_menu_bar);
        let restored = store.update(json!({ "showInMenuBar": true })).unwrap();
        assert!(restored.show_in_menu_bar);
    }

    // ── Computer Use (P0.5 — Kratos) ─────────────────────────────────

    #[test]
    fn computer_use_defaults_are_fail_safe() {
        // Verifies Maestro policy: enabled=false, self_test=false,
        // retention=90, cap=200, idle=900, telemetry_opt_out=false.
        let store = temp_store();
        let s = store.get().unwrap();
        let cu = &s.computer_use;
        assert!(!cu.enabled, "CU must default disabled");
        assert!(
            !cu.self_test_enabled,
            "self-test must default OFF (Maestro Q2)"
        );
        assert!(cu.allowlist.is_empty(), "allowlist must default empty");
        assert!(
            !cu.denylist.is_empty(),
            "denylist must default non-empty (Mail, 1Password, Bitwarden)"
        );
        assert_eq!(cu.audit_retention_days, 90);
        assert_eq!(cu.audit_storage_cap_mb, 200);
        assert_eq!(cu.idle_timeout_seconds, 900);
        assert!(!cu.telemetry_opt_out);
        assert!(cu.restore_hidden_apps);
    }

    #[test]
    fn computer_use_cannot_disable_safe_focus_restoration() {
        let store = temp_store();
        let normalized = store
            .update(json!({ "computerUse": { "restoreHiddenApps": false } }))
            .unwrap();
        assert!(normalized.computer_use.restore_hidden_apps);
    }

    #[test]
    fn computer_use_enable_then_self_test_works() {
        let store = temp_store();
        // CU on, then self-test on. Both must persist.
        let step1 = store
            .update(json!({ "computerUse": { "enabled": true } }))
            .unwrap();
        assert!(step1.computer_use.enabled);
        assert!(!step1.computer_use.self_test_enabled); // still off
        let step2 = store
            .update(json!({ "computerUse": { "selfTestEnabled": true } }))
            .unwrap();
        assert!(step2.computer_use.enabled);
        assert!(step2.computer_use.self_test_enabled);
    }

    #[test]
    fn computer_use_disabled_forces_self_test_off() {
        // Architecture §4 invariant: CU disabled => no self-test.
        let store = temp_store();
        let poisoned = serde_json::json!({
            "computerUse": {
                "enabled": false,
                "selfTestEnabled": true
            }
        });
        let normalized = store.update(poisoned).unwrap();
        assert!(!normalized.computer_use.enabled);
        assert!(
            !normalized.computer_use.self_test_enabled,
            "self-test cannot stay on when CU is disabled"
        );
    }

    #[test]
    fn computer_use_clamps_out_of_range_values() {
        let store = temp_store();
        let out_of_range = serde_json::json!({
            "computerUse": {
                "enabled": true,
                "auditRetentionDays": 0,      // below min 7
                "auditStorageCapMb": 1,        // below min 10
                "idleTimeoutSeconds": 10       // below min 300
            }
        });
        let s = store.update(out_of_range).unwrap();
        let cu = &s.computer_use;
        assert_eq!(cu.audit_retention_days, 7);
        assert_eq!(cu.audit_storage_cap_mb, 10);
        assert_eq!(cu.idle_timeout_seconds, 300);

        let over = serde_json::json!({
            "computerUse": {
                "enabled": true,
                "auditRetentionDays": 99999,
                "auditStorageCapMb": 9999999,
                "idleTimeoutSeconds": 99999
            }
        });
        let s = store.update(over).unwrap();
        let cu = &s.computer_use;
        assert_eq!(cu.audit_retention_days, 365);
        assert_eq!(cu.audit_storage_cap_mb, 10_000);
        assert_eq!(cu.idle_timeout_seconds, 3600);
    }

    #[test]
    fn computer_use_allowlist_upsert_dedupes_by_bundle_id() {
        let store = temp_store();
        let with_dupes = serde_json::json!({
            "computerUse": {
                "enabled": true,
                "allowlist": [
                    {
                        "bundleId": "com.apple.Notes",
                        "displayName": "Notes",
                        "scope": "view",
                        "isSelfTest": false
                    },
                    {
                        "bundleId": "com.apple.notes", // case differs
                        "displayName": "Notes (dupe)",
                        "scope": "input",
                        "isSelfTest": false
                    }
                ]
            }
        });
        let s = store.update(with_dupes).unwrap();
        // Both map to "com.apple.notes" lowercased; last-wins wins.
        assert_eq!(s.computer_use.allowlist.len(), 1);
        let entry = &s.computer_use.allowlist[0];
        assert_eq!(entry.scope, crate::models::types::ComputerUseScope::Input);
    }

    #[test]
    fn computer_use_strips_self_test_entries_when_disabled() {
        // Self-test OFF => any is_self_test=true entry must vanish.
        let store = temp_store();
        let poisoned = serde_json::json!({
            "computerUse": {
                "enabled": true,
                "selfTestEnabled": false,
                "allowlist": [
                    {
                        "bundleId": "com.apple.Notes",
                        "displayName": "Notes",
                        "scope": "view",
                        "isSelfTest": false
                    },
                    {
                        "bundleId": "ai.verboo.code.desktop",
                        "displayName": "Verboo (self-test)",
                        "scope": "input",
                        "isSelfTest": true
                    }
                ]
            }
        });
        let s = store.update(poisoned).unwrap();
        let cu = &s.computer_use;
        assert_eq!(cu.allowlist.len(), 1);
        assert_eq!(cu.allowlist[0].bundle_id, "com.apple.Notes");
        assert!(!cu.allowlist[0].is_self_test);
    }

    #[test]
    fn computer_use_rejects_verboo_non_self_test_entry() {
        // Architecture §4: Verboo bundle id is ONLY valid as a self-test target.
        // A non-self-test entry with bundle=ai.verboo.code.desktop is stripped.
        let store = temp_store();
        let poisoned = serde_json::json!({
            "computerUse": {
                "enabled": true,
                "selfTestEnabled": true,
                "allowlist": [
                    {
                        "bundleId": "ai.verboo.code.desktop",
                        "displayName": "Verboo (fraud)",
                        "scope": "full",
                        "isSelfTest": false
                    }
                ]
            }
        });
        let s = store.update(poisoned).unwrap();
        assert!(
            s.computer_use.allowlist.is_empty(),
            "non-self-test Verboo entry must be stripped (anti-tamper)"
        );
    }

    #[test]
    fn computer_use_denylist_dedupes_case_insensitive() {
        let store = temp_store();
        let with_dupes = serde_json::json!({
            "computerUse": {
                "enabled": true,
                "denylist": [
                    "com.apple.Mail",
                    "com.apple.mail", // case dupe
                    "com.apple.Safari"
                ]
            }
        });
        let s = store.update(with_dupes).unwrap();
        let dl = &s.computer_use.denylist;
        assert_eq!(dl.len(), 2); // Mail deduped; Safari stays
        assert!(dl.iter().any(|x| x.eq_ignore_ascii_case("com.apple.Mail")));
        assert!(dl.iter().any(|x| x == "com.apple.Safari"));
    }

    /// N2 positive case: with self_test_enabled=true, an is_self_test=true
    /// entry on the Verboo bundle is preserved (not stripped).
    #[test]
    fn computer_use_preserves_self_test_entries_when_enabled() {
        let store = temp_store();
        let patch = serde_json::json!({
            "computerUse": {
                "enabled": true,
                "selfTestEnabled": true,
                "allowlist": [
                    {
                        "bundleId": "ai.verboo.code.desktop",
                        "displayName": "Verboo (self-test)",
                        "scope": "input",
                        "isSelfTest": true
                    },
                    {
                        "bundleId": "com.apple.Notes",
                        "displayName": "Notes",
                        "scope": "view",
                        "isSelfTest": false
                    }
                ]
            }
        });
        let s = store.update(patch).unwrap();
        let cu = &s.computer_use;
        assert!(cu.self_test_enabled, "self-test toggle must persist");
        assert_eq!(cu.allowlist.len(), 2, "both entries must survive");

        let verboo_entry = cu
            .allowlist
            .iter()
            .find(|e| e.bundle_id.eq_ignore_ascii_case("ai.verboo.code.desktop"))
            .expect("self-test Verboo entry must be preserved when toggle on");
        assert!(
            verboo_entry.is_self_test,
            "Verboo entry must carry is_self_test=true"
        );
    }

    /// N4 (settings-layer half): setting `defaultAccessMode='full'` +
    /// `fullAccessEnabled=true` MUST NOT mutate any Computer Use state.
    /// CU is activated only via its own enable toggle + consent flow
    /// (architecture §0 — orthogonality).
    #[test]
    fn access_mode_full_does_not_activate_cu() {
        let store = temp_store();

        // Baseline: CU fully off, allowlist empty.
        let before = store.get().unwrap();
        assert!(!before.computer_use.enabled);
        assert!(before.computer_use.allowlist.is_empty());

        // Flip access mode to full + fullAccessEnabled.
        let s = store
            .update(json!({
                "defaultAccessMode": "full",
                "fullAccessEnabled": true
            }))
            .unwrap();

        // Access mode DID flip — that's a separate system.
        assert_eq!(s.default_access_mode, AccessMode::Full);
        assert!(s.full_access_enabled);

        // CU is completely untouched.
        assert!(
            !s.computer_use.enabled,
            "AccessMode=full MUST NOT enable Computer Use"
        );
        assert!(
            !s.computer_use.self_test_enabled,
            "AccessMode=full MUST NOT enable self-test"
        );
        assert!(
            s.computer_use.allowlist.is_empty(),
            "AccessMode=full MUST NOT auto-add any allowlist entry"
        );
        assert!(
            !s.computer_use
                .allowlist
                .iter()
                .any(|e| e.bundle_id.eq_ignore_ascii_case("ai.verboo.code.desktop")),
            "AccessMode=full MUST NOT inject a Verboo self-test entry"
        );
    }

    /// Defense-in-depth: even a poisoned payload that tries to enable CU
    /// while also flipping full access is normalized so the two systems
    /// remain independent. CU on requires its own explicit toggle.
    #[test]
    fn full_access_payload_does_not_leak_into_cu_state() {
        let store = temp_store();
        // Attacker / confused user writes a payload that bundles both.
        let s = store
            .update(json!({
                "defaultAccessMode": "full",
                "fullAccessEnabled": true,
                "computerUse": {
                    // Note: NO "enabled" key here. normalize() must not
                    // infer enabled from fullAccessEnabled.
                    "selfTestEnabled": true,
                    "allowlist": [
                        {
                            "bundleId": "ai.verboo.code.desktop",
                            "displayName": "fraud",
                            "scope": "full",
                            "isSelfTest": true
                        }
                    ]
                }
            }))
            .unwrap();

        assert!(s.full_access_enabled);
        // CU enabled defaults to false; full_access_enabled did not flip it.
        assert!(!s.computer_use.enabled);
        // And because CU is disabled, self_test_enabled is forced false
        // (normalize() line 204: `enabled && self_test_enabled`).
        assert!(
            !s.computer_use.self_test_enabled,
            "self-test cannot run when CU itself is disabled"
        );
        // Therefore the Verboo self-test entry is stripped.
        assert!(s.computer_use.allowlist.is_empty());
    }
}
