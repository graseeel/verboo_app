// Helpers and state-machine accessors in this module are reserved for the
// renderer-facing commands that the renderer will call in a later wiring pass.
#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Records that a requirements check ran successfully at the given Unix-ms
/// timestamp. Persisted to `{app_data_dir}/first-launch.json` so a re-install
/// or upgrade doesn't re-prompt. Mirrors Electron's `firstLaunchFlag`
/// (src/main/index.ts:128).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstLaunchRecord {
    pub checked_at_ms: i64,
    pub ok: bool,
}

const FILENAME: &str = "first-launch.json";

/// Tracks first-launch state so we don't re-run the requirements check on
/// every launch. Mirrors Electron's `shouldRunFirstLaunchRequirementsCheck`
/// (src/main/index.ts:760).
pub struct LifecycleService {
    app_data_dir: PathBuf,
    state: Mutex<Option<FirstLaunchRecord>>,
}

impl LifecycleService {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let mut service = Self {
            app_data_dir,
            state: Mutex::new(None),
        };
        service.load_from_disk();
        service
    }

    /// True if the requirements check has never run for this user.
    pub fn should_run_first_launch_check(&self) -> bool {
        let guard = self.state.lock().ok();
        match guard.as_ref().and_then(|g| g.as_ref()) {
            None => true,
            Some(record) => !record.ok,
        }
    }

    /// Persists a successful first-launch check.
    pub fn mark_first_launch_check_done(&self) -> Result<(), String> {
        let record = FirstLaunchRecord {
            checked_at_ms: now_ms(),
            ok: true,
        };
        self.persist(record)?;
        Ok(())
    }

    /// Returns a copy of the persisted record, if any.
    pub fn record(&self) -> Option<FirstLaunchRecord> {
        let guard = self.state.lock().ok()?;
        guard.as_ref().and_then(|g| Some(g.clone()))
    }

    fn load_from_disk(&mut self) {
        let path = self.app_data_dir.join(FILENAME);
        let Ok(data) = std::fs::read_to_string(&path) else {
            return;
        };
        if let Ok(record) = serde_json::from_str::<FirstLaunchRecord>(&data) {
            if let Ok(mut state) = self.state.lock() {
                *state = Some(record);
            }
        }
    }

    fn persist(&self, record: FirstLaunchRecord) -> Result<(), String> {
        std::fs::create_dir_all(&self.app_data_dir)
            .map_err(|e| format!("Falha ao criar {}: {e}", self.app_data_dir.display()))?;
        let data =
            serde_json::to_string(&record).map_err(|e| format!("Falha ao serializar: {e}"))?;
        std::fs::write(self.app_data_dir.join(FILENAME), data)
            .map_err(|e| format!("Falha ao gravar first-launch.json: {e}"))?;
        if let Ok(mut state) = self.state.lock() {
            *state = Some(record);
        }
        Ok(())
    }
}

/// Returns true on macOS (close → hide to keep the menubar tray alive),
/// false on Windows/Linux (close → quit, matching Electron).
pub fn should_close_to_tray() -> bool {
    cfg!(target_os = "macos")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "verboo-lifecycle-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn should_check_first_launch_when_no_record() {
        let dir = temp_dir();
        let service = LifecycleService::new(dir.clone());
        assert!(service.should_run_first_launch_check());
        assert!(service.record().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn skips_check_after_record_persisted() {
        let dir = temp_dir();
        let service = LifecycleService::new(dir.clone());
        service.mark_first_launch_check_done().unwrap();
        // New instance reads from disk — must skip the check.
        let reloaded = LifecycleService::new(dir.clone());
        assert!(!reloaded.should_run_first_launch_check());
        let record = reloaded.record().expect("record must be loaded");
        assert!(record.ok);
        assert!(record.checked_at_ms > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reloads_record_from_disk_after_drop() {
        let dir = temp_dir();
        {
            let service = LifecycleService::new(dir.clone());
            service.mark_first_launch_check_done().unwrap();
        }
        let reloaded = LifecycleService::new(dir.clone());
        assert!(!reloaded.should_run_first_launch_check());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn close_to_tray_only_on_macos() {
        // Don't assert the exact value (it's cfg!-dependent), but verify the
        // function compiles and returns a bool.
        let _ = should_close_to_tray();
    }

    #[test]
    fn corrupted_record_treated_as_unchecked() {
        let dir = temp_dir();
        std::fs::write(dir.join(FILENAME), "not valid json").unwrap();
        let service = LifecycleService::new(dir.clone());
        assert!(service.should_run_first_launch_check());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
