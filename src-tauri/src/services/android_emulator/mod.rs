//! Android emulator service (PA-24, contract `contrato-android-simulator`).
//!
//! F0 native: requirements detection + guided setup, working on
//! macOS/Windows/Linux. The frozen vocabulary (commands, events, steps,
//! issues) lives in the contract note — verbatim, do not rename.
//!
//! The setup worker follows the iOS mold (`ios_simulator/setup.rs`): a
//! background state machine emitting `setup-progress`/`setup-done`, with
//! clean cancellation (group-kill) and admin prompts that never capture a
//! password. Android-specific: the worker PAUSES at interactive steps
//! (license acceptance, large-download confirmation) and resumes when the
//! renderer re-invokes `android_emulator_setup_start` with the matching
//! flag (frozen `awaiting` protocol).

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, State};

pub mod requirements;
pub mod sdk;
pub mod setup;

pub use requirements::{
    AndroidDevice, AndroidDeviceFamily, AndroidEmulatorIssue, AndroidEmulatorRequirements,
};
pub use setup::{SetupDone, SetupMode, SetupProgress};

/// Frozen key map for `android_emulator_press_key` (contract §key map):
/// logical key → Android keycode. F1 consumes it; pinned here so the
/// vocabulary is load-bearing from F0.
pub fn keycode_for_key(key: &str) -> Option<u32> {
    match key {
        "enter" => Some(66),
        "backspace" => Some(67),
        "tab" => Some(61),
        "escape" => Some(111),
        "arrowUp" => Some(19),
        "arrowDown" => Some(20),
        "arrowLeft" => Some(21),
        "arrowRight" => Some(22),
        "space" => Some(62),
        _ => None,
    }
}

#[derive(Debug, Clone)]
pub(crate) struct CommandOutput {
    pub(crate) success: bool,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
}

/// Abstraction over process execution so the setup/requirements logic is
/// testable with mocks (same pattern as the iOS simulator service).
pub(crate) trait CommandRunner: Send + Sync {
    fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, String>;

    fn run_interruptible(
        &self,
        program: &str,
        args: &[String],
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> Result<CommandOutput, String> {
        if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
            return Err("android emulator operation cancelled".to_string());
        }
        self.run(program, args)
    }
}

#[derive(Debug, Default)]
pub(crate) struct SystemCommandRunner;

impl CommandRunner for SystemCommandRunner {
    fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, String> {
        let mut command = Command::new(program);
        command.args(args);
        crate::services::cli_spawn::apply_creation_flags(&mut command);
        let output = command
            .output()
            .map_err(|error| error.to_string())?;
        Ok(CommandOutput {
            success: output.status.success(),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }

    fn run_interruptible(
        &self,
        program: &str,
        args: &[String],
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> Result<CommandOutput, String> {
        let mut command = Command::new(program);
        command.args(args);
        crate::services::cli_spawn::apply_creation_flags(&mut command);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        crate::services::child_signal::configure_process_group(&mut command);
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        loop {
            if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
                let _ = crate::services::child_signal::terminate_process_group(&mut child);
                let _ = child.wait();
                return Err("android emulator operation cancelled".to_string());
            }
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => thread::sleep(Duration::from_millis(25)),
                Err(error) => {
                    let _ = crate::services::child_signal::terminate_process_group(&mut child);
                    let _ = child.wait();
                    return Err(error.to_string());
                }
            }
        }
        let output = child
            .wait_with_output()
            .map_err(|error| error.to_string())?;
        Ok(CommandOutput {
            success: output.status.success(),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }
}

/// Service state is cloneable so Tauri commands can move only the owned
/// state and command runner into a blocking task.
#[derive(Clone)]
pub struct AndroidEmulatorService {
    runner: Arc<dyn CommandRunner>,
    app_data_dir: PathBuf,
    /// Cancellation flag for the onboarding setup sequence (PA-24).
    setup_cancel: Arc<AtomicBool>,
    /// Guard so only one setup sequence runs at a time (PA-24).
    setup_running: Arc<AtomicBool>,
    /// Set when the renderer re-invokes setup_start with acceptedLicenses=true
    /// (frozen `awaiting: 'licenses'` resume signal).
    licenses_accepted: Arc<AtomicBool>,
    /// Set when the renderer re-invokes setup_start with confirmDownload=true
    /// (frozen `awaiting: 'download'` resume signal).
    download_confirmed: Arc<AtomicBool>,
}

impl AndroidEmulatorService {
    pub(crate) fn new(app_data_dir: PathBuf) -> Self {
        let runner: Arc<dyn CommandRunner> = Arc::new(SystemCommandRunner);
        Self {
            runner,
            app_data_dir,
            setup_cancel: Arc::new(AtomicBool::new(false)),
            setup_running: Arc::new(AtomicBool::new(false)),
            licenses_accepted: Arc::new(AtomicBool::new(false)),
            download_confirmed: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Starts (or resumes) the onboarding setup sequence (PA-24).
    ///
    /// - Fresh start: `accepted_licenses`/`confirm_download` are None/false
    ///   and no worker is running → spawns the worker.
    /// - Resume: a worker is already running (paused at an interactive
    ///   step) → the matching flag is set and the worker proceeds.
    pub(crate) fn setup_start(
        &self,
        app: AppHandle,
        mode: setup::SetupMode,
        accepted_licenses: bool,
        confirm_download: bool,
    ) -> Result<(), String> {
        if self.setup_running.load(Ordering::SeqCst) {
            // Resume path: a worker is paused awaiting user confirmation.
            if accepted_licenses {
                self.licenses_accepted.store(true, Ordering::SeqCst);
            }
            if confirm_download {
                self.download_confirmed.store(true, Ordering::SeqCst);
            }
            if !accepted_licenses && !confirm_download {
                return Err("an Android emulator setup is already running".to_string());
            }
            return Ok(());
        }
        self.setup_cancel.store(false, Ordering::SeqCst);
        self.licenses_accepted.store(false, Ordering::SeqCst);
        self.download_confirmed.store(false, Ordering::SeqCst);
        self.setup_running.store(true, Ordering::SeqCst);
        let runner = self.runner.clone();
        let app_data_dir = self.app_data_dir.clone();
        let cancel = self.setup_cancel.clone();
        let running = self.setup_running.clone();
        let licenses = self.licenses_accepted.clone();
        let download = self.download_confirmed.clone();
        thread::spawn(move || {
            setup::run_setup(
                &app,
                runner.as_ref(),
                &app_data_dir,
                &cancel,
                &licenses,
                &download,
                mode,
            );
            running.store(false, Ordering::SeqCst);
        });
        Ok(())
    }

    /// Cancels an in-progress setup sequence (PA-24). The worker ends with
    /// `setup-done { ready: false, error: 'cancelled' }`.
    pub(crate) fn setup_cancel(&self) -> Result<(), String> {
        self.setup_cancel.store(true, Ordering::SeqCst);
        Ok(())
    }
}

/// Detects Android emulator requirements (frozen contract). Single source
/// of truth, never cached.
#[tauri::command]
pub fn android_emulator_requirements(
    service: State<'_, AndroidEmulatorService>,
) -> AndroidEmulatorRequirements {
    let sdk_path = sdk::resolve_sdk_path(&service.app_data_dir);
    requirements::detect_requirements(service.runner.as_ref(), &sdk_path)
}

/// Starts (or resumes) the automatic setup sequence (frozen contract).
/// Emits `android-emulator:setup-progress` and `android-emulator:setup-done`.
#[tauri::command]
pub fn android_emulator_setup_start(
    app: AppHandle,
    service: State<'_, AndroidEmulatorService>,
    mode: setup::SetupMode,
    accepted_licenses: Option<bool>,
    confirm_download: Option<bool>,
) -> Result<(), String> {
    service.setup_start(
        app,
        mode,
        accepted_licenses.unwrap_or(false),
        confirm_download.unwrap_or(false),
    )
}

/// Cancels an in-progress setup. The sequence ends with
/// `setup-done { ready: false, error: 'cancelled' }`.
#[tauri::command]
pub fn android_emulator_setup_cancel(
    service: State<'_, AndroidEmulatorService>,
) -> Result<(), String> {
    service.setup_cancel()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Frozen key map (contract §key map) is load-bearing: renaming a key
    /// or keycode below FAILS this test.
    #[test]
    fn keycode_map_matches_frozen_contract() {
        assert_eq!(keycode_for_key("enter"), Some(66));
        assert_eq!(keycode_for_key("backspace"), Some(67));
        assert_eq!(keycode_for_key("tab"), Some(61));
        assert_eq!(keycode_for_key("escape"), Some(111));
        assert_eq!(keycode_for_key("arrowUp"), Some(19));
        assert_eq!(keycode_for_key("arrowDown"), Some(20));
        assert_eq!(keycode_for_key("arrowLeft"), Some(21));
        assert_eq!(keycode_for_key("arrowRight"), Some(22));
        assert_eq!(keycode_for_key("space"), Some(62));
        assert_eq!(keycode_for_key("unknown"), None);
    }
}
