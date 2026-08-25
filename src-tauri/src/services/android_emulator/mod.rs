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

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State};

pub mod a11y;
pub(crate) mod grpc;
pub mod input;
pub mod media;
pub(crate) mod preview;
pub mod requirements;
pub mod sdk;
pub mod session;
pub mod setup;

pub use a11y::{
    AndroidAccessibilityNode, AndroidAccessibilitySnapshot, AndroidEmulatorElementHit,
    AndroidEmulatorRect, AndroidEmulatorSystemAction,
};
pub use media::AndroidEmulatorMediaFile;
pub use requirements::{
    AndroidDevice, AndroidDeviceFamily, AndroidEmulatorIssue, AndroidEmulatorRequirements,
};
pub use session::{AndroidEmulatorLifecycleEvent, AndroidEmulatorSession};
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

/// App-exit and detach cleanup must share one absolute budget. Individual
/// adb operations receive the remaining deadline instead of starting a new
/// timeout for each pull, remove, or screenshot.
pub(crate) const ANDROID_CLEANUP_BUDGET: Duration = Duration::from_secs(8);

#[derive(Debug, Default)]
pub(crate) struct SystemCommandRunner;

impl CommandRunner for SystemCommandRunner {
    fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, String> {
        let mut command = Command::new(program);
        command.args(args);
        crate::services::cli_spawn::apply_creation_flags(&mut command);
        let output = command.output().map_err(|error| error.to_string())?;
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
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture Android emulator stdout".to_string())?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| "failed to capture Android emulator stderr".to_string())?;
        let stdout_reader = thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stdout.read_to_end(&mut bytes);
            bytes
        });
        let stderr_reader = thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stderr.read_to_end(&mut bytes);
            bytes
        });
        let finish_readers = || {
            (
                stdout_reader.join().unwrap_or_default(),
                stderr_reader.join().unwrap_or_default(),
            )
        };
        loop {
            if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
                let _ = crate::services::child_signal::terminate_process_group(&mut child);
                let _ = child.wait();
                let _ = finish_readers();
                return Err("android emulator operation cancelled".to_string());
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    let (stdout, stderr) = finish_readers();
                    return Ok(CommandOutput {
                        success: status.success(),
                        stdout,
                        stderr,
                    });
                }
                Ok(None) => thread::sleep(Duration::from_millis(25)),
                Err(error) => {
                    let _ = crate::services::child_signal::terminate_process_group(&mut child);
                    let _ = child.wait();
                    let _ = finish_readers();
                    return Err(error.to_string());
                }
            }
        }
    }
}

/// Service state is cloneable so Tauri commands can move only the owned
/// state and command runner into a blocking task.
#[derive(Clone)]
pub struct AndroidEmulatorService {
    pub(crate) runner: Arc<dyn CommandRunner>,
    pub(crate) app_data_dir: PathBuf,
    pub(crate) state: Arc<Mutex<session::AndroidServiceState>>,
    pub(crate) ownership: Arc<session::OwnershipLedger>,
    pub(crate) desired_visibility: Arc<AtomicBool>,
    pub(crate) session_cancel: Arc<session::SessionCancellation>,
    pub(crate) operation_lock: Arc<Mutex<()>>,
    pub(crate) next_generation: Arc<AtomicU64>,
    pub(crate) app: Arc<Mutex<Option<AppHandle>>>,
    pub(crate) media_backend: Arc<dyn media::AndroidMediaBackend>,
    pub(crate) exiting: Arc<AtomicBool>,
    pub(crate) exit_cleanup_started: Arc<AtomicBool>,
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
    pub(crate) fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        let runner: Arc<dyn CommandRunner> = Arc::new(SystemCommandRunner);
        Ok(Self {
            runner,
            app_data_dir: app_data_dir.clone(),
            state: Arc::new(Mutex::new(session::AndroidServiceState::default())),
            ownership: Arc::new(session::OwnershipLedger::open(app_data_dir)?),
            desired_visibility: Arc::new(AtomicBool::new(true)),
            session_cancel: Arc::new(session::SessionCancellation::default()),
            operation_lock: Arc::new(Mutex::new(())),
            next_generation: Arc::new(AtomicU64::new(0)),
            app: Arc::new(Mutex::new(None)),
            media_backend: Arc::new(media::SystemAndroidMediaBackend),
            exiting: Arc::new(AtomicBool::new(false)),
            exit_cleanup_started: Arc::new(AtomicBool::new(false)),
            setup_cancel: Arc::new(AtomicBool::new(false)),
            setup_running: Arc::new(AtomicBool::new(false)),
            licenses_accepted: Arc::new(AtomicBool::new(false)),
            download_confirmed: Arc::new(AtomicBool::new(false)),
        })
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
            let operations = setup::SystemSetupOperations;
            setup::run_setup(
                &app,
                runner.as_ref(),
                &app_data_dir,
                &cancel,
                &licenses,
                &download,
                mode,
                &operations,
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

#[tauri::command]
pub fn android_emulator_read_frame(
    service: State<'_, AndroidEmulatorService>,
    generation: u64,
) -> Result<tauri::ipc::Response, preview::PreviewReadError> {
    service
        .read_frame_sync(generation)
        .map(tauri::ipc::Response::new)
}

#[tauri::command]
pub async fn android_emulator_attach(
    app: AppHandle,
    service: State<'_, AndroidEmulatorService>,
    avd_name: String,
    stream_fps: u16,
    fallback_fps: f64,
    preview_transport: Option<preview::PreviewTransport>,
) -> Result<AndroidEmulatorSession, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.attach_sync(app, avd_name, stream_fps, fallback_fps, preview_transport)
    })
    .await
    .map_err(|error| format!("failed to attach Android emulator: {error}"))?
}

#[tauri::command]
pub async fn android_emulator_detach(
    service: State<'_, AndroidEmulatorService>,
) -> Result<(), String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.detach_sync())
        .await
        .map_err(|error| format!("failed to detach Android emulator: {error}"))?
}

#[tauri::command]
pub async fn android_emulator_end(
    service: State<'_, AndroidEmulatorService>,
) -> Result<(), String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.end_sync())
        .await
        .map_err(|error| format!("failed to end Android emulator: {error}"))?
}

#[tauri::command]
pub fn android_emulator_set_visible(
    service: State<'_, AndroidEmulatorService>,
    visible: bool,
) -> Result<(), String> {
    service.set_visible_sync(visible)
}

#[tauri::command]
pub fn android_emulator_set_stream_rate(
    service: State<'_, AndroidEmulatorService>,
    fps: u16,
) -> Result<u16, String> {
    service.set_stream_rate_sync(fps)
}

#[tauri::command]
pub fn android_emulator_set_fallback_rate(
    service: State<'_, AndroidEmulatorService>,
    fps: f64,
) -> Result<f64, String> {
    service.set_fallback_rate_sync(fps)
}

#[tauri::command]
pub async fn android_emulator_tap(
    service: State<'_, AndroidEmulatorService>,
    x: f64,
    y: f64,
    origin: Option<input::InputOrigin>,
) -> Result<(), String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.tap_sync(x, y, origin.unwrap_or_default())
    })
        .await
        .map_err(|error| format!("failed to tap Android emulator: {error}"))?
}

#[tauri::command]
pub async fn android_emulator_drag(
    service: State<'_, AndroidEmulatorService>,
    from_x: f64,
    from_y: f64,
    to_x: f64,
    to_y: f64,
    duration_ms: u64,
    origin: Option<input::InputOrigin>,
) -> Result<(), String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.drag_sync(
            from_x,
            from_y,
            to_x,
            to_y,
            duration_ms,
            origin.unwrap_or_default(),
        )
    })
    .await
    .map_err(|error| format!("failed to drag Android emulator: {error}"))?
}

#[tauri::command]
pub async fn android_emulator_type_text(
    service: State<'_, AndroidEmulatorService>,
    text: String,
    origin: Option<input::InputOrigin>,
) -> Result<(), String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.type_text_sync(&text, origin.unwrap_or_default())
    })
        .await
        .map_err(|error| format!("failed to type into Android emulator: {error}"))?
}

#[tauri::command]
pub async fn android_emulator_press_key(
    service: State<'_, AndroidEmulatorService>,
    key: String,
    origin: Option<input::InputOrigin>,
) -> Result<(), String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.press_key_sync(&key, origin.unwrap_or_default())
    })
        .await
        .map_err(|error| format!("failed to press Android emulator key: {error}"))?
}

#[tauri::command]
pub async fn android_emulator_system_action(
    service: State<'_, AndroidEmulatorService>,
    action: AndroidEmulatorSystemAction,
    origin: Option<input::InputOrigin>,
) -> Result<(), String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.system_action_sync(action, origin.unwrap_or_default())
    })
        .await
        .map_err(|error| format!("failed to run Android emulator system action: {error}"))?
}

#[tauri::command]
pub async fn android_emulator_accessibility_snapshot(
    service: State<'_, AndroidEmulatorService>,
) -> Result<AndroidAccessibilitySnapshot, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.accessibility_snapshot_sync())
        .await
        .map_err(|error| format!("failed to read Android accessibility snapshot: {error}"))?
}

#[tauri::command]
pub async fn android_emulator_inspect_point(
    service: State<'_, AndroidEmulatorService>,
    x: f64,
    y: f64,
) -> Result<Option<AndroidEmulatorElementHit>, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.inspect_point_sync(x, y))
        .await
        .map_err(|error| format!("failed to inspect Android emulator point: {error}"))?
}

fn desktop_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .desktop_dir()
        .map_err(|error| format!("não foi possível localizar a Mesa: {error}"))
}

#[tauri::command]
pub fn android_emulator_capture_screen(
    app: AppHandle,
    service: State<'_, AndroidEmulatorService>,
) -> Result<AndroidEmulatorMediaFile, String> {
    let desktop = desktop_directory(&app)?;
    service.capture_screen_sync(&desktop)
}

#[tauri::command]
pub fn android_emulator_recording_start(
    app: AppHandle,
    service: State<'_, AndroidEmulatorService>,
) -> Result<(), String> {
    let desktop = desktop_directory(&app)?;
    service.start_recording_sync(&desktop)
}

#[tauri::command]
pub fn android_emulator_recording_stop(
    service: State<'_, AndroidEmulatorService>,
) -> Result<AndroidEmulatorMediaFile, String> {
    service.stop_recording_sync()
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

    #[cfg(unix)]
    #[test]
    fn interruptible_runner_drains_large_output_without_pipe_deadlock() {
        let runner = SystemCommandRunner;
        let cancel = AtomicBool::new(false);
        let output = runner
            .run_interruptible(
                "perl",
                &["-e".to_string(), "print 'x' x 262144".to_string()],
                &cancel,
                Instant::now() + Duration::from_secs(5),
            )
            .expect("large Android command output should complete");
        assert!(output.success);
        assert_eq!(output.stdout.len(), 262_144);
        assert!(output.stderr.is_empty());
    }
}
