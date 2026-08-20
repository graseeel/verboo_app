//! Android emulator onboarding (PA-24, contract `contrato-android-simulator`).
//!
//! `android_emulator_setup_*` commands drive the setup paths for the
//! Android emulator panel. `detect_requirements` is the single source of
//! truth (never cached); `SetupMode` is a SCOPE CEILING, not a step list
//! (frozen vocabulary 2026-08-19, verbatim — do not rename).
//!
//! Interactive steps (frozen `awaiting` protocol): the worker PAUSES at
//! `acceptLicenses` and before a large download, emitting
//! `android-emulator:setup-progress { step, message, awaiting }`. The
//! renderer shows the confirmation surface and resumes by re-invoking
//! `android_emulator_setup_start` with the same `mode` plus the matching
//! flag (`acceptedLicenses`/`confirmDownload` = true). Licenses are NEVER
//! accepted silently; large downloads are NEVER confirmed silently.
//!
//! Admin/reboot requirements (Windows WHPX, Linux kvm group) STOP the
//! automatic path at `enableAccel` and hand over the manual guide for that
//! specific step — the automatic path never promises what it cannot do.
//!
//! LIMITS (declared): the state machine, the parsers and the awaiting
//! decision are unit-tested here on mac. The real downloads (cmdline-tools,
//! system image), sdkmanager installs and AVD creation require a real
//! Android SDK + the target OS — exercised by CI (3 OSes) and the field
//! test on the owner's mac.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

use super::requirements::{detect_requirements, AndroidEmulatorIssue, AndroidEmulatorRequirements};
use super::{sdk, CommandRunner};

/// Backend emits `android-emulator:setup-progress` (frozen vocabulary).
pub(crate) const SETUP_PROGRESS_EVENT: &str = "android-emulator:setup-progress";
/// Backend emits `android-emulator:setup-done` (frozen vocabulary).
pub(crate) const SETUP_DONE_EVENT: &str = "android-emulator:setup-done";

/// Frozen step names (contract §Steps de setup — verbatim).
pub(crate) const STEP_DOWNLOAD_TOOLS: &str = "downloadTools";
pub(crate) const STEP_ACCEPT_LICENSES: &str = "acceptLicenses";
pub(crate) const STEP_INSTALL_PACKAGES: &str = "installPackages";
pub(crate) const STEP_DOWNLOAD_SYSTEM_IMAGE: &str = "downloadSystemImage";
pub(crate) const STEP_CREATE_AVD: &str = "createAvd";
pub(crate) const STEP_ENABLE_ACCEL: &str = "enableAccel";
pub(crate) const STEP_VERIFY: &str = "verify";

/// Frozen awaiting tokens (contract §Eventos — `awaiting?: licenses|download`).
pub(crate) const AWAITING_LICENSES: &str = "licenses";
pub(crate) const AWAITING_DOWNLOAD: &str = "download";

/// Frozen cancel error (contract §Eventos — same pattern as iOS).
pub(crate) const ERROR_CANCELLED: &str = "cancelled";

/// Frozen setup mode (contract §Vocabulario congelado — camelCase).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SetupMode {
    Toolchain,
    Full,
}

/// Emitted on `android-emulator:setup-progress` (frozen shape).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupProgress {
    pub step: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Present ONLY while paused awaiting an explicit user decision.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub awaiting: Option<String>,
}

/// Emitted on `android-emulator:setup-done` (frozen shape).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupDone {
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<AndroidEmulatorIssue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Pure: whether a step is a download step (carries `percent`).
pub fn is_download_step(step: &str) -> bool {
    matches!(
        step,
        STEP_DOWNLOAD_TOOLS | STEP_INSTALL_PACKAGES | STEP_DOWNLOAD_SYSTEM_IMAGE
    )
}

/// Threshold (bytes) above which a download requires explicit confirmation
/// (frozen `awaiting: 'download'`). 500 MiB — large enough that a normal
/// cmdline-tools download (~150 MB) never pauses, while a system image
/// (1+ GB) always does.
pub const LARGE_DOWNLOAD_BYTES: u64 = 500 * 1024 * 1024;

/// Pure: whether a download size needs the `awaiting: 'download'` pause.
pub fn needs_download_confirmation(bytes: Option<u64>) -> bool {
    bytes.map_or(true, |size| size >= LARGE_DOWNLOAD_BYTES)
}

/// The setup seam keeps the worker's orchestration testable without running
/// a real curl/sdkmanager/avdmanager process. The production implementation
/// below delegates every action to the existing SDK functions.
pub(crate) trait SetupOperations: Send + Sync {
    fn resolve_sdk_path(&self, app_data_dir: &Path) -> PathBuf;
    fn detect_requirements(
        &self,
        runner: &dyn CommandRunner,
        sdk_path: &Path,
    ) -> AndroidEmulatorRequirements;
    fn licenses_accepted(&self, sdk_path: &Path) -> bool;
    fn download_cmdline_tools(
        &self,
        sdk_path: &Path,
        cancel: &AtomicBool,
        on_percent: &mut dyn FnMut(u8),
    ) -> Result<(), String>;
    fn accept_all_licenses(&self, sdk_path: &Path) -> Result<(), String>;
    fn install_packages(
        &self,
        sdk_path: &Path,
        packages: &[String],
        cancel: &AtomicBool,
        on_percent: &mut dyn FnMut(u8),
    ) -> Result<(), String>;
    fn download_system_image(
        &self,
        runner: &dyn CommandRunner,
        sdk_path: &Path,
        cancel: &AtomicBool,
        on_percent: &mut dyn FnMut(u8),
    ) -> Result<(), String>;
    fn create_avd(&self, runner: &dyn CommandRunner, sdk_path: &Path) -> Result<(), String>;
}

pub(crate) struct SystemSetupOperations;

impl SetupOperations for SystemSetupOperations {
    fn resolve_sdk_path(&self, app_data_dir: &Path) -> PathBuf {
        sdk::resolve_sdk_path(app_data_dir)
    }

    fn detect_requirements(
        &self,
        runner: &dyn CommandRunner,
        sdk_path: &Path,
    ) -> AndroidEmulatorRequirements {
        detect_requirements(runner, sdk_path)
    }

    fn licenses_accepted(&self, sdk_path: &Path) -> bool {
        sdk::licenses_accepted(sdk_path)
    }

    fn download_cmdline_tools(
        &self,
        sdk_path: &Path,
        cancel: &AtomicBool,
        on_percent: &mut dyn FnMut(u8),
    ) -> Result<(), String> {
        sdk::download_cmdline_tools(sdk_path, cancel, on_percent)
    }

    fn accept_all_licenses(&self, sdk_path: &Path) -> Result<(), String> {
        sdk::accept_all_licenses(sdk_path)
    }

    fn install_packages(
        &self,
        sdk_path: &Path,
        packages: &[String],
        cancel: &AtomicBool,
        on_percent: &mut dyn FnMut(u8),
    ) -> Result<(), String> {
        sdk::sdkmanager_install(sdk_path, packages, cancel, on_percent)
    }

    fn download_system_image(
        &self,
        runner: &dyn CommandRunner,
        sdk_path: &Path,
        cancel: &AtomicBool,
        on_percent: &mut dyn FnMut(u8),
    ) -> Result<(), String> {
        let image = sdk::pick_latest_system_image(runner, sdk_path)
            .unwrap_or_else(|| format!("system-images;android-35;google_apis;{}", sdk::host_abi()));
        sdk::sdkmanager_install(sdk_path, &[image], cancel, on_percent)
    }

    fn create_avd(&self, runner: &dyn CommandRunner, sdk_path: &Path) -> Result<(), String> {
        sdk::create_default_avd(runner, sdk_path)
    }
}

/// Runs the setup sequence in a background thread. The step list is derived
/// from `detect_requirements` (single source of truth); `mode` is the scope
/// ceiling (toolchain stops before system image/AVD). Emits progress/done.
pub(crate) fn run_setup<R: Runtime>(
    app: &AppHandle<R>,
    runner: &dyn CommandRunner,
    app_data_dir: &Path,
    cancel: &AtomicBool,
    licenses_accepted: &AtomicBool,
    download_confirmed: &AtomicBool,
    mode: SetupMode,
    operations: &dyn SetupOperations,
) {
    let sdk_path = operations.resolve_sdk_path(app_data_dir);
    let mut completed_steps = Vec::new();

    loop {
        if cancelled(cancel) {
            emit_done(app, false, None, Some(ERROR_CANCELLED.to_string()));
            return;
        }

        // Source of truth is deliberately re-read after every action.
        let requirements = operations.detect_requirements(runner, &sdk_path);
        let Some(issue) = requirements.issue else {
            emit_progress(app, STEP_VERIFY.to_string(), None, None, None);
            emit_done(app, true, None, None);
            return;
        };

        if mode == SetupMode::Toolchain
            && matches!(
                issue,
                AndroidEmulatorIssue::SystemImageMissing | AndroidEmulatorIssue::AvdMissing
            )
        {
            emit_progress(app, STEP_VERIFY.to_string(), None, None, None);
            emit_done(app, true, None, None);
            return;
        }

        let Some(step) = next_step_for_issue(issue, mode, &completed_steps, operations, &sdk_path)
        else {
            emit_done(app, false, Some(issue), None);
            return;
        };

        let result = match step {
            STEP_DOWNLOAD_TOOLS => {
                if mode == SetupMode::Full
                    && needs_download_confirmation(Some(sdk::cmdline_tools_download_size()))
                {
                    emit_progress(
                        app,
                        STEP_DOWNLOAD_TOOLS.to_string(),
                        Some(0),
                        Some(sdk::cmdline_tools_size_label()),
                        Some(AWAITING_DOWNLOAD.to_string()),
                    );
                    wait_for(download_confirmed, cancel);
                    if cancelled(cancel) {
                        emit_done(app, false, None, Some(ERROR_CANCELLED.to_string()));
                        return;
                    }
                }
                emit_progress(app, STEP_DOWNLOAD_TOOLS.to_string(), Some(0), None, None);
                let mut last_percent = 0;
                let mut on_percent = |percent| {
                    emit_percent_progress(app, STEP_DOWNLOAD_TOOLS, &mut last_percent, percent);
                };
                operations.download_cmdline_tools(&sdk_path, cancel, &mut on_percent)
            }
            STEP_ACCEPT_LICENSES => {
                let license_text = sdk::fetch_license_text(runner, &sdk_path);
                emit_progress(
                    app,
                    STEP_ACCEPT_LICENSES.to_string(),
                    None,
                    Some(license_text),
                    Some(AWAITING_LICENSES.to_string()),
                );
                wait_for(licenses_accepted, cancel);
                if cancelled(cancel) {
                    emit_done(app, false, None, Some(ERROR_CANCELLED.to_string()));
                    return;
                }
                operations.accept_all_licenses(&sdk_path)
            }
            STEP_INSTALL_PACKAGES => {
                let packages = ["platform-tools".to_string(), "emulator".to_string()];
                emit_progress(app, STEP_INSTALL_PACKAGES.to_string(), Some(0), None, None);
                let mut last_percent = 0;
                let mut on_percent = |percent| {
                    emit_percent_progress(app, STEP_INSTALL_PACKAGES, &mut last_percent, percent);
                };
                operations.install_packages(&sdk_path, &packages, cancel, &mut on_percent)
            }
            STEP_DOWNLOAD_SYSTEM_IMAGE => {
                emit_progress(
                    app,
                    STEP_DOWNLOAD_SYSTEM_IMAGE.to_string(),
                    Some(0),
                    Some(sdk::system_image_size_label()),
                    Some(AWAITING_DOWNLOAD.to_string()),
                );
                wait_for(download_confirmed, cancel);
                if cancelled(cancel) {
                    emit_done(app, false, None, Some(ERROR_CANCELLED.to_string()));
                    return;
                }
                emit_progress(
                    app,
                    STEP_DOWNLOAD_SYSTEM_IMAGE.to_string(),
                    Some(0),
                    None,
                    None,
                );
                let mut last_percent = 0;
                let mut on_percent = |percent| {
                    emit_percent_progress(
                        app,
                        STEP_DOWNLOAD_SYSTEM_IMAGE,
                        &mut last_percent,
                        percent,
                    );
                };
                operations.download_system_image(runner, &sdk_path, cancel, &mut on_percent)
            }
            STEP_CREATE_AVD => {
                emit_progress(app, STEP_CREATE_AVD.to_string(), None, None, None);
                operations.create_avd(runner, &sdk_path)
            }
            STEP_ENABLE_ACCEL => {
                emit_progress(app, STEP_ENABLE_ACCEL.to_string(), None, None, None);
                emit_done(app, false, Some(issue), None);
                return;
            }
            STEP_VERIFY => unreachable!("verify is emitted only after re-detection"),
            _ => unreachable!("unknown Android setup step: {step}"),
        };

        if let Err(error) = result {
            if cancelled(cancel) {
                emit_done(app, false, None, Some(ERROR_CANCELLED.to_string()));
            } else {
                emit_done(app, false, None, Some(error));
            }
            return;
        }
        completed_steps.push(step);
    }
}

fn steps_for_issue(issue: AndroidEmulatorIssue, mode: SetupMode) -> Vec<&'static str> {
    let mut steps = match issue {
        AndroidEmulatorIssue::SdkMissing => vec![
            STEP_DOWNLOAD_TOOLS,
            STEP_ACCEPT_LICENSES,
            STEP_INSTALL_PACKAGES,
            STEP_DOWNLOAD_SYSTEM_IMAGE,
            STEP_CREATE_AVD,
        ],
        AndroidEmulatorIssue::AdbMissing | AndroidEmulatorIssue::EmulatorMissing => vec![
            STEP_ACCEPT_LICENSES,
            STEP_INSTALL_PACKAGES,
            STEP_DOWNLOAD_SYSTEM_IMAGE,
            STEP_CREATE_AVD,
        ],
        AndroidEmulatorIssue::LicensesNotAccepted => vec![
            STEP_ACCEPT_LICENSES,
            STEP_INSTALL_PACKAGES,
            STEP_DOWNLOAD_SYSTEM_IMAGE,
            STEP_CREATE_AVD,
        ],
        AndroidEmulatorIssue::SystemImageMissing => {
            vec![STEP_DOWNLOAD_SYSTEM_IMAGE, STEP_CREATE_AVD]
        }
        AndroidEmulatorIssue::AvdMissing => vec![STEP_CREATE_AVD],
        AndroidEmulatorIssue::AccelMissing => vec![STEP_ENABLE_ACCEL],
        AndroidEmulatorIssue::UnsupportedPlatform | AndroidEmulatorIssue::DiscoveryFailed => {
            Vec::new()
        }
    };
    if mode == SetupMode::Toolchain {
        steps.retain(|step| *step != STEP_DOWNLOAD_SYSTEM_IMAGE && *step != STEP_CREATE_AVD);
    }
    steps
}

fn next_step_for_issue(
    issue: AndroidEmulatorIssue,
    mode: SetupMode,
    completed_steps: &[&'static str],
    operations: &dyn SetupOperations,
    sdk_path: &Path,
) -> Option<&'static str> {
    steps_for_issue(issue, mode).into_iter().find(|step| {
        !completed_steps.contains(step)
            && (*step != STEP_ACCEPT_LICENSES || !operations.licenses_accepted(sdk_path))
    })
}

fn cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::Acquire)
}

/// Blocks until `flag` is set or `cancel` is set (polls every 100ms).
/// The renderer resumes by re-invoking setup_start with the matching flag.
fn wait_for(flag: &AtomicBool, cancel: &AtomicBool) {
    loop {
        if flag.load(Ordering::Acquire) || cancel.load(Ordering::Acquire) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn emit_percent_progress<R: Runtime>(
    app: &AppHandle<R>,
    step: &'static str,
    last_percent: &mut u8,
    percent: u8,
) {
    let percent = percent.min(100);
    if percent > *last_percent && (percent == 100 || percent >= last_percent.saturating_add(5)) {
        *last_percent = percent;
        emit_progress(app, step.to_string(), Some(percent), None, None);
    }
}

fn emit_progress<R: Runtime>(
    app: &AppHandle<R>,
    step: String,
    percent: Option<u8>,
    message: Option<String>,
    awaiting: Option<String>,
) {
    let _ = app.emit(
        SETUP_PROGRESS_EVENT,
        SetupProgress {
            step,
            percent,
            message,
            awaiting,
        },
    );
}

fn emit_done<R: Runtime>(
    app: &AppHandle<R>,
    ready: bool,
    issue: Option<AndroidEmulatorIssue>,
    error: Option<String>,
) {
    let _ = app.emit(
        SETUP_DONE_EVENT,
        SetupDone {
            ready,
            issue,
            error,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::sync::mpsc;
    use std::sync::Arc;

    use tauri::Listener;

    /// Frozen step/awaiting/error literals are load-bearing: renaming any
    /// of them below FAILS this test (contract §Steps de setup / §Eventos).
    #[test]
    fn frozen_vocabulary_literals_are_pinned() {
        assert_eq!(STEP_DOWNLOAD_TOOLS, "downloadTools");
        assert_eq!(STEP_ACCEPT_LICENSES, "acceptLicenses");
        assert_eq!(STEP_INSTALL_PACKAGES, "installPackages");
        assert_eq!(STEP_DOWNLOAD_SYSTEM_IMAGE, "downloadSystemImage");
        assert_eq!(STEP_CREATE_AVD, "createAvd");
        assert_eq!(STEP_ENABLE_ACCEL, "enableAccel");
        assert_eq!(STEP_VERIFY, "verify");
        assert_eq!(AWAITING_LICENSES, "licenses");
        assert_eq!(AWAITING_DOWNLOAD, "download");
        assert_eq!(ERROR_CANCELLED, "cancelled");
    }

    /// SetupMode serializes to the frozen camelCase values.
    #[test]
    fn setup_mode_serializes_to_frozen_values() {
        assert_eq!(
            serde_json::to_string(&SetupMode::Toolchain).unwrap(),
            "\"toolchain\""
        );
        assert_eq!(serde_json::to_string(&SetupMode::Full).unwrap(), "\"full\"");
    }

    /// Download steps carry percent; interactive/verification steps do not.
    #[test]
    fn download_steps_carry_percent_only() {
        assert!(is_download_step(STEP_DOWNLOAD_TOOLS));
        assert!(is_download_step(STEP_INSTALL_PACKAGES));
        assert!(is_download_step(STEP_DOWNLOAD_SYSTEM_IMAGE));
        assert!(!is_download_step(STEP_ACCEPT_LICENSES));
        assert!(!is_download_step(STEP_CREATE_AVD));
        assert!(!is_download_step(STEP_ENABLE_ACCEL));
        assert!(!is_download_step(STEP_VERIFY));
    }

    /// Large downloads (≥ 500 MiB) pause for confirmation; the cmdline-tools
    /// download (~150 MB) does not. Unknown sizes pause (fail-safe).
    #[test]
    fn large_downloads_require_confirmation() {
        assert!(needs_download_confirmation(Some(500 * 1024 * 1024)));
        assert!(needs_download_confirmation(Some(1_073_741_824)));
        assert!(!needs_download_confirmation(Some(150 * 1024 * 1024)));
        assert!(needs_download_confirmation(None));
    }

    #[test]
    fn captured_curl_progress_reaches_the_production_parser_and_throttle() {
        let app = tauri::test::mock_app();
        let app_handle = app.handle().clone();
        let observed = Arc::new(std::sync::Mutex::new(Vec::<u64>::new()));
        let observed_for_listener = observed.clone();
        let listener = app_handle.listen(SETUP_PROGRESS_EVENT, move |event| {
            let value: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
            if let Some(percent) = value["percent"].as_u64() {
                observed_for_listener.lock().unwrap().push(percent);
            }
        });

        // The worker uses this exact parser -> throttle chain for curl and
        // sdkmanager output. The final 100 callback models run_with_progress's
        // success completion callback and must be independent of parsing.
        let mut last_percent = 0;
        for line in include_str!("fixtures/curl_progress_sonda_2026_08_20.txt").lines() {
            if let Some(percent) = sdk::parse_sdkmanager_progress(line) {
                emit_percent_progress(&app_handle, STEP_DOWNLOAD_TOOLS, &mut last_percent, percent);
            }
        }
        emit_percent_progress(&app_handle, STEP_DOWNLOAD_TOOLS, &mut last_percent, 100);
        app_handle.unlisten(listener);

        let observed = observed.lock().unwrap().clone();
        let distinct: BTreeSet<u64> = observed.iter().copied().collect();
        assert!(
            distinct.len() > 2,
            "captured curl progress must survive production throttle: {observed:?}"
        );
        assert!(observed.contains(&100));
    }

    #[test]
    fn sdk_missing_runs_the_complete_ordered_setup_and_honors_pauses() {
        let app = tauri::test::mock_app();
        let app_handle = app.handle().clone();
        let progress_events = Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
        let (licenses_waiting_sender, licenses_waiting_receiver) = mpsc::channel();
        let (download_waiting_sender, download_waiting_receiver) = mpsc::channel();
        let progress_events_for_listener = progress_events.clone();
        let progress_listener = app_handle.listen(SETUP_PROGRESS_EVENT, move |event| {
            let value: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
            if value["awaiting"] == AWAITING_LICENSES {
                let _ = licenses_waiting_sender.send(());
            }
            if value["awaiting"] == AWAITING_DOWNLOAD {
                let _ = download_waiting_sender.send(());
            }
            progress_events_for_listener.lock().unwrap().push(value);
        });
        let (done_sender, done_receiver) = mpsc::channel();
        let done_listener = app_handle.listen(SETUP_DONE_EVENT, move |event| {
            let value: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
            let _ = done_sender.send(value);
        });

        let backend = Arc::new(FakeSetupRunner::new());
        let cancel = Arc::new(AtomicBool::new(false));
        let licenses_accepted = Arc::new(AtomicBool::new(false));
        let download_confirmed = Arc::new(AtomicBool::new(false));
        let app_data_dir = tempfile::tempdir().unwrap();
        let app_data_path = app_data_dir.path().to_path_buf();
        let worker_app = app_handle.clone();
        let worker_backend = backend.clone();
        let worker_cancel = cancel.clone();
        let worker_licenses = licenses_accepted.clone();
        let worker_download = download_confirmed.clone();
        let worker = std::thread::spawn(move || {
            run_setup(
                &worker_app,
                &FakeCommandRunner,
                &app_data_path,
                &worker_cancel,
                &worker_licenses,
                &worker_download,
                SetupMode::Full,
                worker_backend.as_ref(),
            );
        });

        licenses_waiting_receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("setup must pause for license acceptance");
        assert_eq!(backend.calls(), vec![STEP_DOWNLOAD_TOOLS]);
        assert!(download_waiting_receiver.try_recv().is_err());
        licenses_accepted.store(true, Ordering::Release);

        download_waiting_receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("setup must pause for large download confirmation");
        assert_eq!(
            backend.calls(),
            vec![
                STEP_DOWNLOAD_TOOLS,
                STEP_ACCEPT_LICENSES,
                STEP_INSTALL_PACKAGES,
            ]
        );
        download_confirmed.store(true, Ordering::Release);

        let done = done_receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("setup must emit setup-done");
        worker.join().unwrap();
        app_handle.unlisten(progress_listener);
        app_handle.unlisten(done_listener);

        assert_eq!(done["ready"], true);
        assert!(done.get("issue").is_none());
        assert!(done.get("error").is_none());
        assert_eq!(
            backend.calls(),
            vec![
                STEP_DOWNLOAD_TOOLS,
                STEP_ACCEPT_LICENSES,
                STEP_INSTALL_PACKAGES,
                STEP_DOWNLOAD_SYSTEM_IMAGE,
                STEP_CREATE_AVD,
            ]
        );
        assert_eq!(backend.detect_count(), 6);

        let events = progress_events.lock().unwrap().clone();
        let event_signatures: Vec<_> = events
            .iter()
            .map(|event| {
                (
                    event["step"].as_str().unwrap_or_default().to_string(),
                    event["percent"].as_u64(),
                    event["message"].as_str().map(str::to_string),
                    event["awaiting"].as_str().map(str::to_string),
                )
            })
            .collect();
        assert_eq!(
            event_signatures,
            vec![
                (STEP_DOWNLOAD_TOOLS.to_string(), Some(0), None, None),
                (STEP_DOWNLOAD_TOOLS.to_string(), Some(10), None, None),
                (STEP_DOWNLOAD_TOOLS.to_string(), Some(50), None, None),
                (STEP_DOWNLOAD_TOOLS.to_string(), Some(100), None, None),
                (
                    STEP_ACCEPT_LICENSES.to_string(),
                    None,
                    Some("Android SDK license text".to_string()),
                    Some(AWAITING_LICENSES.to_string()),
                ),
                (STEP_INSTALL_PACKAGES.to_string(), Some(0), None, None),
                (STEP_INSTALL_PACKAGES.to_string(), Some(10), None, None),
                (STEP_INSTALL_PACKAGES.to_string(), Some(50), None, None),
                (STEP_INSTALL_PACKAGES.to_string(), Some(100), None, None),
                (
                    STEP_DOWNLOAD_SYSTEM_IMAGE.to_string(),
                    Some(0),
                    Some(sdk::system_image_size_label()),
                    Some(AWAITING_DOWNLOAD.to_string()),
                ),
                (STEP_DOWNLOAD_SYSTEM_IMAGE.to_string(), Some(0), None, None),
                (STEP_DOWNLOAD_SYSTEM_IMAGE.to_string(), Some(10), None, None),
                (STEP_DOWNLOAD_SYSTEM_IMAGE.to_string(), Some(50), None, None),
                (
                    STEP_DOWNLOAD_SYSTEM_IMAGE.to_string(),
                    Some(100),
                    None,
                    None
                ),
                (STEP_CREATE_AVD.to_string(), None, None, None),
                (STEP_VERIFY.to_string(), None, None, None),
            ]
        );
        let distinct_percents: BTreeSet<u64> = events
            .iter()
            .filter_map(|event| event["percent"].as_u64())
            .collect();
        assert!(
            distinct_percents.len() > 2,
            "download progress must emit multiple distinct percentages: {distinct_percents:?}"
        );
        assert!(events.iter().any(|event| {
            event["step"] == STEP_DOWNLOAD_TOOLS && event["percent"].as_u64() == Some(50)
        }));
        assert!(events.iter().any(|event| {
            event["step"] == STEP_INSTALL_PACKAGES && event["percent"].as_u64() == Some(50)
        }));
        assert!(events.iter().any(|event| {
            event["step"] == STEP_DOWNLOAD_SYSTEM_IMAGE && event["percent"].as_u64() == Some(50)
        }));
    }

    struct FakeCommandRunner;

    impl CommandRunner for FakeCommandRunner {
        fn run(
            &self,
            _program: &str,
            _args: &[String],
        ) -> Result<super::super::CommandOutput, String> {
            Ok(super::super::CommandOutput {
                success: true,
                stdout: b"Android SDK license text".to_vec(),
                stderr: Vec::new(),
            })
        }
    }

    struct FakeSetupRunner {
        issues: std::sync::Mutex<std::collections::VecDeque<Option<AndroidEmulatorIssue>>>,
        calls: std::sync::Mutex<Vec<&'static str>>,
        detect_count: std::sync::Mutex<usize>,
        licenses_accepted: AtomicBool,
    }

    impl FakeSetupRunner {
        fn new() -> Self {
            Self {
                issues: std::sync::Mutex::new(
                    [
                        Some(AndroidEmulatorIssue::SdkMissing),
                        Some(AndroidEmulatorIssue::AdbMissing),
                        Some(AndroidEmulatorIssue::AdbMissing),
                        Some(AndroidEmulatorIssue::LicensesNotAccepted),
                        Some(AndroidEmulatorIssue::AvdMissing),
                        None,
                    ]
                    .into_iter()
                    .collect(),
                ),
                calls: std::sync::Mutex::new(Vec::new()),
                detect_count: std::sync::Mutex::new(0),
                licenses_accepted: AtomicBool::new(false),
            }
        }

        fn calls(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap().clone()
        }

        fn detect_count(&self) -> usize {
            *self.detect_count.lock().unwrap()
        }

        fn record(&self, step: &'static str) {
            self.calls.lock().unwrap().push(step);
        }
    }

    impl SetupOperations for FakeSetupRunner {
        fn resolve_sdk_path(&self, app_data_dir: &Path) -> std::path::PathBuf {
            app_data_dir.join("android-sdk")
        }

        fn detect_requirements(
            &self,
            _runner: &dyn CommandRunner,
            _sdk_path: &Path,
        ) -> super::super::AndroidEmulatorRequirements {
            *self.detect_count.lock().unwrap() += 1;
            let issue = self.issues.lock().unwrap().pop_front().unwrap_or(None);
            super::super::AndroidEmulatorRequirements {
                ready: issue.is_none(),
                issue,
                devices: Vec::new(),
            }
        }

        fn licenses_accepted(&self, _sdk_path: &Path) -> bool {
            self.licenses_accepted.load(Ordering::Acquire)
        }

        fn download_cmdline_tools(
            &self,
            _sdk_path: &Path,
            _cancel: &AtomicBool,
            on_percent: &mut dyn FnMut(u8),
        ) -> Result<(), String> {
            self.record(STEP_DOWNLOAD_TOOLS);
            on_percent(10);
            on_percent(50);
            on_percent(100);
            Ok(())
        }

        fn accept_all_licenses(&self, _sdk_path: &Path) -> Result<(), String> {
            self.record(STEP_ACCEPT_LICENSES);
            self.licenses_accepted.store(true, Ordering::Release);
            Ok(())
        }

        fn install_packages(
            &self,
            _sdk_path: &Path,
            _packages: &[String],
            _cancel: &AtomicBool,
            on_percent: &mut dyn FnMut(u8),
        ) -> Result<(), String> {
            self.record(STEP_INSTALL_PACKAGES);
            on_percent(10);
            on_percent(50);
            on_percent(100);
            Ok(())
        }

        fn download_system_image(
            &self,
            _runner: &dyn CommandRunner,
            _sdk_path: &Path,
            _cancel: &AtomicBool,
            on_percent: &mut dyn FnMut(u8),
        ) -> Result<(), String> {
            self.record(STEP_DOWNLOAD_SYSTEM_IMAGE);
            on_percent(10);
            on_percent(50);
            on_percent(100);
            Ok(())
        }

        fn create_avd(&self, _runner: &dyn CommandRunner, _sdk_path: &Path) -> Result<(), String> {
            self.record(STEP_CREATE_AVD);
            Ok(())
        }
    }
}
