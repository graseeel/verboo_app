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

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::requirements::{detect_requirements, AndroidEmulatorIssue};
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

/// Runs the setup sequence in a background thread. The step list is derived
/// from `detect_requirements` (single source of truth); `mode` is the scope
/// ceiling (toolchain stops before system image/AVD). Emits progress/done.
pub(crate) fn run_setup(
    app: &AppHandle,
    runner: &dyn CommandRunner,
    app_data_dir: &Path,
    cancel: &AtomicBool,
    licenses_accepted: &AtomicBool,
    download_confirmed: &AtomicBool,
    mode: SetupMode,
) {
    let sdk_path = sdk::resolve_sdk_path(app_data_dir);

    // ── detect (single source of truth, never cached) ─────────────
    let requirements = detect_requirements(runner, &sdk_path);
    if let Some(issue) = requirements.issue {
        emit_done(app, false, Some(issue), None);
        return;
    }
    // Requirements ready → nothing to set up (full path would just verify).
    if requirements.ready && mode == SetupMode::Full {
        emit_progress(app, STEP_VERIFY.to_string(), None, None, None);
        emit_done(app, true, None, None);
        return;
    }

    // ── downloadTools ─────────────────────────────────────────────
    let tools = sdk::sdkmanager_path(&sdk_path);
    if !tools.is_file() {
        if cancelled(cancel) {
            emit_done(app, false, None, Some(ERROR_CANCELLED.to_string()));
            return;
        }
        let size = sdk::cmdline_tools_download_size();
        if mode == SetupMode::Full && needs_download_confirmation(Some(size)) {
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
        let mut last_percent = 0u8;
        let mut on_percent = |p: u8| {
            if p != last_percent {
                last_percent = p;
            }
        };
        let result = sdk::download_cmdline_tools(&sdk_path, cancel, &mut on_percent);
        match result {
            Ok(()) => emit_progress(app, STEP_DOWNLOAD_TOOLS.to_string(), Some(100), None, None),
            Err(e) => {
                if cancelled(cancel) {
                    emit_done(app, false, None, Some(ERROR_CANCELLED.to_string()));
                } else {
                    emit_done(app, false, None, Some(e));
                }
                return;
            }
        }
    }

    // ── acceptLicenses (NEVER silent) ─────────────────────────────
    if !sdk::licenses_accepted(&sdk_path) {
        if cancelled(cancel) {
            emit_done(app, false, None, Some(ERROR_CANCELLED.to_string()));
            return;
        }
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
        match sdk::accept_all_licenses(&sdk_path) {
            Ok(()) => {}
            Err(e) => {
                emit_done(app, false, None, Some(e));
                return;
            }
        }
    }

    // ── installPackages (platform-tools + emulator) ───────────────
    let packages = ["platform-tools".to_string(), "emulator".to_string()];
    let mut last_percent = 0u8;
    let mut on_percent = |p: u8| {
        if p != last_percent {
            last_percent = p;
        }
    };
    emit_progress(app, STEP_INSTALL_PACKAGES.to_string(), Some(0), None, None);
    match sdk::sdkmanager_install(&sdk_path, &packages, cancel, &mut on_percent) {
        Ok(()) => emit_progress(
            app,
            STEP_INSTALL_PACKAGES.to_string(),
            Some(100),
            None,
            None,
        ),
        Err(e) => {
            if cancelled(cancel) {
                emit_done(app, false, None, Some(ERROR_CANCELLED.to_string()));
            } else {
                emit_done(app, false, None, Some(e));
            }
            return;
        }
    }

    // ── scope ceiling: toolchain stops before the system image/AVD ─
    if mode == SetupMode::Toolchain {
        emit_progress(app, STEP_VERIFY.to_string(), None, None, None);
        emit_done(app, true, None, None);
        return;
    }

    // ── downloadSystemImage (large → confirm) ─────────────────────
    if !sdk::has_system_image(&sdk_path) {
        if cancelled(cancel) {
            emit_done(app, false, None, Some(ERROR_CANCELLED.to_string()));
            return;
        }
        let image_size = sdk::system_image_download_size();
        if needs_download_confirmation(Some(image_size)) {
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
        }
        emit_progress(
            app,
            STEP_DOWNLOAD_SYSTEM_IMAGE.to_string(),
            Some(0),
            None,
            None,
        );
        let image = sdk::pick_latest_system_image(runner, &sdk_path);
        let packages = image.map(|pkg| vec![pkg]).unwrap_or_else(|| {
            vec![format!(
                "system-images;android-35;google_apis;{}",
                sdk::host_abi()
            )]
        });
        let mut last_percent = 0u8;
        let mut on_percent = |p: u8| {
            if p != last_percent {
                last_percent = p;
            }
        };
        match sdk::sdkmanager_install(&sdk_path, &packages, cancel, &mut on_percent) {
            Ok(()) => emit_progress(
                app,
                STEP_DOWNLOAD_SYSTEM_IMAGE.to_string(),
                Some(100),
                None,
                None,
            ),
            Err(e) => {
                if cancelled(cancel) {
                    emit_done(app, false, None, Some(ERROR_CANCELLED.to_string()));
                } else {
                    emit_done(app, false, None, Some(e));
                }
                return;
            }
        }
    }

    // ── createAvd (newest installed system image) ─────────────────
    if sdk::list_avd_names(runner, &sdk_path).is_empty() {
        if cancelled(cancel) {
            emit_done(app, false, None, Some(ERROR_CANCELLED.to_string()));
            return;
        }
        emit_progress(app, STEP_CREATE_AVD.to_string(), None, None, None);
        match sdk::create_default_avd(runner, &sdk_path) {
            Ok(()) => {}
            Err(e) => {
                emit_done(app, false, None, Some(e));
                return;
            }
        }
    }

    // ── enableAccel (auto never promises what it cannot do) ───────
    if !sdk::accel_available() {
        emit_progress(app, STEP_ENABLE_ACCEL.to_string(), None, None, None);
        emit_done(app, false, Some(AndroidEmulatorIssue::AccelMissing), None);
        return;
    }

    // ── verify ────────────────────────────────────────────────────
    emit_progress(app, STEP_VERIFY.to_string(), None, None, None);
    emit_done(app, true, None, None);
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

fn emit_progress(
    app: &AppHandle,
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

fn emit_done(
    app: &AppHandle,
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
}
