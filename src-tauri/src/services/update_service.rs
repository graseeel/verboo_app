// UpdateService state-machine accessors are reserved for the renderer-facing
// commands that the renderer will call in a later wiring pass.
#![allow(dead_code)]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::models::types::{UpdateChannel, UpdateSettings, UpdateSnapshot, UpdateStatus};
use sha2::{Digest, Sha256};

const CHECK_INTERVAL_MS: u64 = 6 * 60 * 60 * 1000;
pub const STABLE_UPDATE_ENDPOINT: &str =
    "https://github.com/graseeel/verboo_app/releases/latest/download/latest.json";
pub const BETA_UPDATE_ENDPOINT: &str =
    "https://github.com/graseeel/verboo_app/releases/download/updater-beta/latest.json";

/// State machine and verified-download staging for the updater UI. The actual
/// Tauri updater calls (`UpdaterExt::updater_builder().check()`,
/// `Update::download`, and `Update::install`)
/// live in `lib.rs` because they're async + need an `AppHandle`. This struct
/// owns the snapshot, channel configuration, and periodic-check timer logic.
///
/// Internally `Arc<Mutex<State>>` so it can be cloned into async closures
/// that can't borrow `tauri::State` across `.await` points.
#[derive(Clone)]
pub struct UpdateService {
    state: Arc<Mutex<State>>,
    pending_update: Arc<PendingUpdateStore<tauri_plugin_updater::Update>>,
}

pub(crate) struct StagedUpdate<U> {
    pub(crate) update: U,
    pub(crate) artifact: tempfile::TempPath,
    digest: [u8; 32],
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DownloadTicket {
    pub(crate) id: u64,
    pub(crate) channel: UpdateChannel,
}

#[derive(Debug, Clone)]
struct ActiveDownload {
    ticket: DownloadTicket,
    version: Option<String>,
}

struct PendingUpdateStore<U> {
    value: Mutex<Option<StagedUpdate<U>>>,
}

impl<U> Default for PendingUpdateStore<U> {
    fn default() -> Self {
        Self {
            value: Mutex::new(None),
        }
    }
}

impl<U> PendingUpdateStore<U> {
    fn prepare(update: U, bytes: Vec<u8>) -> Result<StagedUpdate<U>, String> {
        let digest: [u8; 32] = Sha256::digest(&bytes).into();
        let mut artifact = tempfile::Builder::new()
            .prefix("verboo-update-")
            .suffix(".bin")
            .tempfile()
            .map_err(|error| format!("Falha ao preparar atualização: {error}"))?;
        artifact
            .write_all(&bytes)
            .map_err(|error| format!("Falha ao armazenar atualização: {error}"))?;
        Ok(StagedUpdate {
            update,
            artifact: artifact.into_temp_path(),
            digest,
        })
    }

    fn replace(&self, staged: StagedUpdate<U>) -> Result<(), String> {
        let mut value = self
            .value
            .lock()
            .map_err(|_| "Estado da atualização pendente indisponível".to_string())?;
        *value = Some(staged);
        Ok(())
    }

    fn stage(&self, update: U, bytes: Vec<u8>) -> Result<(), String> {
        self.replace(Self::prepare(update, bytes)?)
    }

    fn take(&self) -> Result<Option<StagedUpdate<U>>, String> {
        self.value
            .lock()
            .map(|mut value| value.take())
            .map_err(|_| "Estado da atualização pendente indisponível".to_string())
    }

    fn restore(&self, staged: StagedUpdate<U>) -> Result<(), String> {
        let mut value = self
            .value
            .lock()
            .map_err(|_| "Estado da atualização pendente indisponível".to_string())?;
        *value = Some(staged);
        Ok(())
    }

    fn clear(&self) -> Result<(), String> {
        let mut value = self
            .value
            .lock()
            .map_err(|_| "Estado da atualização pendente indisponível".to_string())?;
        *value = None;
        Ok(())
    }

    fn is_ready(&self) -> bool {
        self.value
            .lock()
            .map(|value| value.is_some())
            .unwrap_or(false)
    }
}

impl<U> StagedUpdate<U> {
    pub(crate) fn read_verified(&self) -> Result<Vec<u8>, String> {
        let bytes = std::fs::read(&self.artifact)
            .map_err(|error| format!("Falha ao abrir atualização baixada: {error}"))?;
        let actual: [u8; 32] = Sha256::digest(&bytes).into();
        if actual != self.digest {
            return Err("A integridade da atualização baixada foi alterada".into());
        }
        Ok(bytes)
    }
}

#[derive(Debug, Clone)]
struct State {
    settings: UpdateSettings,
    snapshot: UpdateSnapshot,
    current_version: String,
    checking: bool,
    downloaded: bool,
    last_timer_at_ms: Option<i64>,
    next_download_id: u64,
    active_download: Option<ActiveDownload>,
}

impl UpdateService {
    pub fn new(current_version: String, is_packaged: bool) -> Self {
        let snapshot = UpdateSnapshot {
            status: if is_packaged {
                UpdateStatus::Idle
            } else {
                UpdateStatus::Unsupported
            },
            channel: UpdateChannel::Beta,
            current_version: current_version.clone(),
            available_version: None,
            release_name: None,
            release_date: None,
            release_notes: None,
            percent: None,
            transferred_bytes: None,
            total_bytes: None,
            bytes_per_second: None,
            last_checked_at: None,
            downloaded_at: None,
            error: None,
        };
        Self {
            state: Arc::new(Mutex::new(State {
                settings: UpdateSettings {
                    channel: UpdateChannel::Beta,
                    auto_check: true,
                    auto_download: false,
                },
                snapshot,
                current_version,
                checking: false,
                downloaded: false,
                last_timer_at_ms: None,
                next_download_id: 0,
                active_download: None,
            })),
            pending_update: Arc::new(PendingUpdateStore::default()),
        }
    }

    /// Returns the current snapshot (cloned for caller use).
    pub fn snapshot(&self) -> UpdateSnapshot {
        self.state.lock().map(|s| s.snapshot.clone()).unwrap_or_default()
    }

    /// Clones the service for use in async closures where `tauri::State`
    /// cannot be held across `.await` points. Cheap — just bumps an Arc refcount.
    pub fn clone_handle(&self) -> UpdateService {
        self.clone()
    }

    /// Returns the current settings.
    pub fn settings(&self) -> UpdateSettings {
        self.state
            .lock()
            .map(|s| s.settings.clone())
            .unwrap_or(UpdateSettings {
                channel: UpdateChannel::Beta,
                auto_check: true,
                auto_download: false,
            })
    }

    pub fn endpoint(&self) -> &'static str {
        match self.settings().channel {
            UpdateChannel::Stable => STABLE_UPDATE_ENDPOINT,
            UpdateChannel::Beta => BETA_UPDATE_ENDPOINT,
        }
    }

    pub(crate) fn endpoint_for(ticket: &DownloadTicket) -> &'static str {
        match ticket.channel {
            UpdateChannel::Stable => STABLE_UPDATE_ENDPOINT,
            UpdateChannel::Beta => BETA_UPDATE_ENDPOINT,
        }
    }

    /// Applies a new settings patch (channel / autoCheck / autoDownload).
    /// Returns the resulting snapshot. Mirrors Electron's `UpdateService.configure`.
    pub fn configure(&self, settings: UpdateSettings) -> UpdateSnapshot {
        if let Ok(mut state) = self.state.lock() {
            let channel_changed = state.settings.channel != settings.channel;
            state.settings = settings.clone();
            state.snapshot.channel = settings.channel;
            if channel_changed {
                state.active_download = None;
                state.downloaded = false;
                state.snapshot.status = UpdateStatus::Idle;
                state.snapshot.available_version = None;
                state.snapshot.release_name = None;
                state.snapshot.release_date = None;
                state.snapshot.release_notes = None;
                state.snapshot.percent = None;
                state.snapshot.transferred_bytes = None;
                state.snapshot.total_bytes = None;
                state.snapshot.bytes_per_second = None;
                state.snapshot.downloaded_at = None;
                let _ = self.pending_update.clear();
            }
        }
        self.snapshot()
    }

    /// Returns true if a periodic auto-check should run now (autoCheck on,
    /// enough time elapsed since last check, not already checking).
    pub fn should_auto_check(&self) -> bool {
        let Ok(state) = self.state.lock() else {
            return false;
        };
        if !state.settings.auto_check {
            return false;
        }
        if state.checking {
            return false;
        }
        match state.snapshot.last_checked_at {
            None => true,
            Some(t) => now_ms().saturating_sub(t) >= CHECK_INTERVAL_MS as i64,
        }
    }

    /// Returns true if the updater is available (packaged + manifest exists).
    /// Mirrors Electron's `updaterAvailable()`. Decided by the caller (lib.rs),
    /// which has access to the AppHandle; this method just records the result.
    pub fn mark_checking(&self) -> UpdateSnapshot {
        if let Ok(mut state) = self.state.lock() {
            state.checking = true;
            state.snapshot.status = UpdateStatus::Checking;
            state.snapshot.error = None;
        }
        self.snapshot()
    }

    /// Records a check failure. Returns the resulting snapshot.
    pub fn mark_error(&self, error: String) -> UpdateSnapshot {
        if let Ok(mut state) = self.state.lock() {
            state.checking = false;
            state.snapshot.status = UpdateStatus::Error;
            state.snapshot.error = Some(error);
            state.snapshot.last_checked_at = Some(now_ms());
        }
        self.snapshot()
    }

    /// Records that the check finished with no update available.
    pub fn mark_not_available(&self) -> UpdateSnapshot {
        if let Ok(mut state) = self.state.lock() {
            state.checking = false;
            state.snapshot.status = UpdateStatus::NotAvailable;
            state.snapshot.last_checked_at = Some(now_ms());
        }
        self.snapshot()
    }

    /// Records that an update is available. Mirrors `updateInfoToSnapshot`.
    pub fn mark_available(
        &self,
        version: String,
        release_name: Option<String>,
        release_date: Option<String>,
        release_notes: Option<String>,
    ) -> UpdateSnapshot {
        if let Ok(mut state) = self.state.lock() {
            state.checking = false;
            state.snapshot.status = UpdateStatus::Available;
            state.snapshot.available_version = Some(version);
            state.snapshot.release_name = release_name;
            state.snapshot.release_date = release_date;
            state.snapshot.release_notes = release_notes;
            state.snapshot.last_checked_at = Some(now_ms());
            state.snapshot.error = None;
        }
        self.snapshot()
    }

    /// Records that the download has started.
    pub fn mark_downloading(&self) -> UpdateSnapshot {
        if let Ok(mut state) = self.state.lock() {
            state.snapshot.status = UpdateStatus::Downloading;
            state.snapshot.error = None;
        }
        self.snapshot()
    }

    pub(crate) fn begin_download(&self) -> Result<Option<DownloadTicket>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Estado da atualização indisponível".to_string())?;
        if state.active_download.is_some() {
            return Ok(None);
        }
        state.next_download_id = state.next_download_id.saturating_add(1);
        let ticket = DownloadTicket {
            id: state.next_download_id,
            channel: state.settings.channel.clone(),
        };
        state.active_download = Some(ActiveDownload {
            ticket: ticket.clone(),
            version: None,
        });
        state.snapshot.status = UpdateStatus::Downloading;
        state.snapshot.error = None;
        Ok(Some(ticket))
    }

    pub(crate) fn bind_download_version(
        &self,
        ticket: &DownloadTicket,
        version: &str,
    ) -> Result<bool, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Estado da atualização indisponível".to_string())?;
        let current_channel = state.settings.channel.clone();
        let Some(active) = state.active_download.as_mut() else {
            return Ok(false);
        };
        if active.ticket != *ticket || current_channel != ticket.channel {
            return Ok(false);
        }
        active.version = Some(version.to_string());
        Ok(true)
    }

    pub(crate) fn finish_download_error(
        &self,
        ticket: &DownloadTicket,
        error: String,
    ) -> UpdateSnapshot {
        if let Ok(mut state) = self.state.lock() {
            let is_current = state
                .active_download
                .as_ref()
                .map(|active| active.ticket == *ticket)
                .unwrap_or(false);
            if is_current {
                state.active_download = None;
                state.snapshot.status = UpdateStatus::Error;
                state.snapshot.error = Some(error);
                state.snapshot.last_checked_at = Some(now_ms());
            }
            return state.snapshot.clone();
        }
        self.snapshot()
    }

    /// Records a download-progress event.
    pub fn mark_download_progress(
        &self,
        transferred: u64,
        total: u64,
        bytes_per_second: f64,
    ) -> UpdateSnapshot {
        let percent = if total == 0 {
            0.0
        } else {
            (transferred as f64 / total as f64) * 100.0
        };
        if let Ok(mut state) = self.state.lock() {
            state.snapshot.status = UpdateStatus::Downloading;
            state.snapshot.percent = Some(percent.clamp(0.0, 100.0));
            state.snapshot.transferred_bytes = Some(transferred);
            state.snapshot.total_bytes = Some(total);
            state.snapshot.bytes_per_second = Some(bytes_per_second);
        }
        self.snapshot()
    }

    pub(crate) fn mark_download_progress_for(
        &self,
        ticket: &DownloadTicket,
        transferred: u64,
        total: u64,
        bytes_per_second: f64,
    ) -> Option<UpdateSnapshot> {
        let Ok(mut state) = self.state.lock() else {
            return None;
        };
        let is_current = state
            .active_download
            .as_ref()
            .map(|active| active.ticket == *ticket)
            .unwrap_or(false);
        if !is_current {
            return None;
        }
        let percent = if total == 0 {
            0.0
        } else {
            (transferred as f64 / total as f64) * 100.0
        };
        state.snapshot.status = UpdateStatus::Downloading;
        state.snapshot.percent = Some(percent.clamp(0.0, 100.0));
        state.snapshot.transferred_bytes = Some(transferred);
        state.snapshot.total_bytes = Some(total);
        state.snapshot.bytes_per_second = Some(bytes_per_second);
        Some(state.snapshot.clone())
    }

    /// Records that the download has completed.
    pub fn mark_downloaded(&self) -> UpdateSnapshot {
        if let Ok(mut state) = self.state.lock() {
            state.downloaded = true;
            state.snapshot.status = UpdateStatus::Downloaded;
            state.snapshot.downloaded_at = Some(now_ms());
            state.snapshot.percent = Some(100.0);
        }
        self.snapshot()
    }

    pub(crate) fn stage_downloaded(
        &self,
        ticket: &DownloadTicket,
        update: tauri_plugin_updater::Update,
        bytes: Vec<u8>,
    ) -> Result<Option<UpdateSnapshot>, String> {
        let version = update.version.clone();
        let staged = PendingUpdateStore::prepare(update, bytes)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Estado da atualização indisponível".to_string())?;
        let is_current = state
            .active_download
            .as_ref()
            .map(|active| {
                active.ticket == *ticket
                    && active.version.as_deref() == Some(version.as_str())
                    && state.settings.channel == ticket.channel
            })
            .unwrap_or(false);
        if !is_current {
            return Ok(None);
        }
        self.pending_update.replace(staged)?;
        state.active_download = None;
        state.downloaded = true;
        state.snapshot.status = UpdateStatus::Downloaded;
        state.snapshot.available_version = Some(version);
        state.snapshot.downloaded_at = Some(now_ms());
        state.snapshot.percent = Some(100.0);
        Ok(Some(state.snapshot.clone()))
    }

    pub(crate) fn restore_failed_install(
        &self,
        update: tauri_plugin_updater::Update,
        bytes: Vec<u8>,
    ) -> Result<(), String> {
        self.pending_update.stage(update, bytes)
    }

    pub(crate) fn take_staged_update(
        &self,
    ) -> Result<Option<StagedUpdate<tauri_plugin_updater::Update>>, String> {
        self.pending_update.take()
    }

    pub(crate) fn restore_staged_update(
        &self,
        staged: StagedUpdate<tauri_plugin_updater::Update>,
    ) -> Result<(), String> {
        self.pending_update.restore(staged)
    }

    /// Returns true if the snapshot indicates the download has completed and
    /// the user can quit-and-install.
    pub fn can_install(&self) -> bool {
        let downloaded = self
            .state
            .lock()
            .map(|s| s.snapshot.status == UpdateStatus::Downloaded)
            .unwrap_or(false);
        downloaded && self.pending_update.is_ready()
    }

    /// Resets to Idle after the user dismisses an error or decline an update.
    pub fn reset(&self) -> UpdateSnapshot {
        if let Ok(mut state) = self.state.lock() {
            state.active_download = None;
            state.snapshot.status = UpdateStatus::Idle;
            state.snapshot.error = None;
            let _ = self.pending_update.clear();
        }
        self.snapshot()
    }

    /// Returns true if periodic auto-check should fire — bumped each call so
    /// the timer caller can persist the fire time.
    pub fn bump_timer_tick(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.last_timer_at_ms = Some(now_ms());
        }
    }
}

impl Default for UpdateService {
    fn default() -> Self {
        Self::new("0.0.0".into(), false)
    }
}

// UpdateService is #[derive(Clone)] — no manual Clone impl needed.

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn macos_bundle_path(executable: &Path) -> Option<PathBuf> {
    let macos_dir = executable.parent()?;
    if macos_dir.file_name()? != "MacOS" {
        return None;
    }
    let contents_dir = macos_dir.parent()?;
    if contents_dir.file_name()? != "Contents" {
        return None;
    }
    let bundle = contents_dir.parent()?;
    if bundle.extension()? != "app" {
        return None;
    }
    Some(bundle.to_path_buf())
}

pub(crate) fn macos_relaunch_script() -> &'static str {
    "while kill -0 \"$1\" 2>/dev/null; do sleep 0.1; done; exec /usr/bin/open -n \"$2\""
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service(packaged: bool) -> UpdateService {
        UpdateService::new("1.2.3".into(), packaged)
    }

    #[test]
    fn initial_snapshot_is_unsupported_in_dev() {
        let s = service(false);
        assert_eq!(s.snapshot().status, UpdateStatus::Unsupported);
        assert_eq!(s.snapshot().current_version, "1.2.3");
        assert_eq!(s.snapshot().channel, UpdateChannel::Beta);
    }

    #[test]
    fn initial_snapshot_is_idle_when_packaged() {
        let s = service(true);
        assert_eq!(s.snapshot().status, UpdateStatus::Idle);
    }

    #[test]
    fn configure_updates_channel_and_settings() {
        let s = service(true);
        let settings = UpdateSettings {
            channel: UpdateChannel::Stable,
            auto_check: false,
            auto_download: true,
        };
        let snap = s.configure(settings);
        assert_eq!(snap.channel, UpdateChannel::Stable);
        let after = s.settings();
        assert_eq!(after.channel, UpdateChannel::Stable);
        assert!(!after.auto_check);
        assert!(after.auto_download);
    }

    #[test]
    fn stable_and_beta_use_distinct_https_endpoints() {
        let s = service(true);
        s.configure(UpdateSettings {
            channel: UpdateChannel::Stable,
            auto_check: true,
            auto_download: false,
        });
        assert_eq!(s.endpoint(), STABLE_UPDATE_ENDPOINT);

        s.configure(UpdateSettings {
            channel: UpdateChannel::Beta,
            auto_check: true,
            auto_download: false,
        });
        assert_eq!(s.endpoint(), BETA_UPDATE_ENDPOINT);
        assert_ne!(STABLE_UPDATE_ENDPOINT, BETA_UPDATE_ENDPOINT);
        assert!(s.endpoint().starts_with("https://"));
    }

    #[test]
    fn mark_checking_transitions_state() {
        let s = service(true);
        let snap = s.mark_checking();
        assert_eq!(snap.status, UpdateStatus::Checking);
        assert!(snap.error.is_none());
    }

    #[test]
    fn mark_error_resets_checking_and_stamps_last_checked_at() {
        let s = service(true);
        s.mark_checking();
        let snap = s.mark_error("network down".into());
        assert_eq!(snap.status, UpdateStatus::Error);
        assert_eq!(snap.error.as_deref(), Some("network down"));
        assert!(snap.last_checked_at.is_some());
    }

    #[test]
    fn mark_available_populates_release_fields() {
        let s = service(true);
        let snap = s.mark_available(
            "2.0.0".into(),
            Some("Big release".into()),
            Some("2026-07-07".into()),
            Some("release notes here".into()),
        );
        assert_eq!(snap.status, UpdateStatus::Available);
        assert_eq!(snap.available_version.as_deref(), Some("2.0.0"));
        assert_eq!(snap.release_name.as_deref(), Some("Big release"));
        assert_eq!(snap.release_notes.as_deref(), Some("release notes here"));
    }

    #[test]
    fn downloaded_status_without_verified_bytes_cannot_install() {
        let s = service(true);
        s.mark_downloading();
        s.mark_downloaded();
        let snap = s.snapshot();
        assert_eq!(snap.status, UpdateStatus::Downloaded);
        assert_eq!(snap.percent, Some(100.0));
        assert!(!s.can_install());
    }

    #[test]
    fn pending_update_store_keeps_verified_bytes_until_install() {
        let store = PendingUpdateStore::default();

        store.stage("verified update", vec![1, 2, 3]).unwrap();

        assert!(store.is_ready());
        let staged = store.take().unwrap().unwrap();
        let artifact_path = staged.artifact.to_path_buf();
        assert_eq!(staged.update, "verified update");
        assert_eq!(std::fs::read(&artifact_path).unwrap(), vec![1, 2, 3]);
        assert!(!store.is_ready());

        drop(staged);
        assert!(!artifact_path.exists());
    }

    #[test]
    fn staged_update_rejects_bytes_changed_after_signature_verification() {
        let store = PendingUpdateStore::default();
        store.stage("verified update", vec![1, 2, 3]).unwrap();
        let staged = store.take().unwrap().unwrap();

        std::fs::write(&staged.artifact, [9, 9, 9]).unwrap();

        assert!(staged.read_verified().unwrap_err().contains("integridade"));
    }

    #[test]
    fn pending_update_can_be_restored_after_install_failure() {
        let store = PendingUpdateStore::default();
        store.stage("verified update", vec![4, 5, 6]).unwrap();
        let staged = store.take().unwrap().unwrap();

        store.restore(staged).unwrap();

        assert!(store.is_ready());
    }

    #[test]
    fn pending_update_store_clears_stale_download() {
        let store = PendingUpdateStore::default();
        store.stage("old update", vec![7, 8, 9]).unwrap();

        store.clear().unwrap();

        assert!(!store.is_ready());
        assert!(store.take().unwrap().is_none());
    }

    #[test]
    fn updater_download_and_install_are_separate_phases() {
        let source = include_str!("../lib.rs");
        let download = source
            .split("async fn download_update")
            .nth(1)
            .and_then(|rest| rest.split("fn install_update").next())
            .expect("download_update command source");
        let install = source
            .split("fn install_update")
            .nth(1)
            .and_then(|rest| rest.split("// ═══════════════════════════════════").next())
            .expect("install_update command source");

        assert!(download.contains(".download("));
        assert!(!download.contains("download_and_install"));
        assert!(download.contains("Falha ao preparar atualização"));
        assert!(install.contains(".install("));
    }

    #[test]
    fn progress_receives_cumulative_transferred_bytes() {
        let s = service(true);
        let snap = s.mark_download_progress(750, 1_000, 100_000.0);
        assert_eq!(snap.percent, Some(75.0));
        assert_eq!(snap.transferred_bytes, Some(750));
        assert_eq!(snap.total_bytes, Some(1_000));
        assert_eq!(snap.bytes_per_second, Some(100_000.0));
    }

    #[test]
    fn downloads_are_single_flight() {
        let s = service(true);

        let first = s.begin_download().unwrap().expect("first download ticket");

        assert!(s.begin_download().unwrap().is_none());
        assert!(s.bind_download_version(&first, "2.0.0").unwrap());
    }

    #[test]
    fn changing_channel_invalidates_an_in_flight_download() {
        let s = service(true);
        let beta = s.begin_download().unwrap().expect("beta download ticket");
        assert!(s.bind_download_version(&beta, "2.0.0-beta.1").unwrap());

        s.configure(UpdateSettings {
            channel: UpdateChannel::Stable,
            auto_check: true,
            auto_download: false,
        });

        assert!(!s.bind_download_version(&beta, "2.0.0-beta.1").unwrap());
        let stable = s.begin_download().unwrap().expect("stable download ticket");
        assert_eq!(stable.channel, UpdateChannel::Stable);
        assert_ne!(stable.id, beta.id);
    }

    #[test]
    fn should_auto_check_true_when_never_checked() {
        let s = service(true);
        s.configure(UpdateSettings {
            channel: UpdateChannel::Beta,
            auto_check: true,
            auto_download: false,
        });
        assert!(s.should_auto_check());
    }

    #[test]
    fn should_auto_check_false_when_disabled() {
        let s = service(true);
        s.configure(UpdateSettings {
            channel: UpdateChannel::Beta,
            auto_check: false,
            auto_download: false,
        });
        assert!(!s.should_auto_check());
    }

    #[test]
    fn should_auto_check_false_when_checking() {
        let s = service(true);
        s.mark_checking();
        assert!(!s.should_auto_check());
    }

    #[test]
    fn reset_clears_error() {
        let s = service(true);
        s.mark_error("err".into());
        let snap = s.reset();
        assert_eq!(snap.status, UpdateStatus::Idle);
        assert!(snap.error.is_none());
    }

    #[test]
    fn resolves_macos_bundle_from_packaged_executable() {
        let executable =
            std::path::Path::new("/Applications/Verboo Code.app/Contents/MacOS/verboo-desktop");

        assert_eq!(
            macos_bundle_path(executable),
            Some(std::path::PathBuf::from("/Applications/Verboo Code.app"))
        );
        assert_eq!(macos_bundle_path(std::path::Path::new("/tmp/verboo")), None);
    }

    #[test]
    fn macos_relaunch_waits_for_the_previous_process_to_exit() {
        assert_eq!(
            macos_relaunch_script(),
            "while kill -0 \"$1\" 2>/dev/null; do sleep 0.1; done; exec /usr/bin/open -n \"$2\""
        );
    }
}
