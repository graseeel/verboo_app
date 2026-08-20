//! Android emulator session, lifecycle, preview, and ownership primitives (PA-26).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::requirements::{self, AndroidDevice};
use super::{sdk, AndroidEmulatorService, CommandOutput, CommandRunner};

pub(crate) const FRAME_EVENT: &str = "android-emulator:frame";
pub(crate) const LIFECYCLE_EVENT: &str = "android-emulator:lifecycle";
pub(crate) const ERROR_EVENT: &str = "android-emulator:error";
pub(crate) const PRESENCE_EVENT: &str = "android-emulator:presence";

const BOOT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MIN_STREAM_FPS: u16 = 1;
const MAX_STREAM_FPS: u16 = 60;
const MIN_FALLBACK_FPS: f64 = 0.5;
const MAX_FALLBACK_FPS: f64 = 2.0;
const ADB_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AndroidEmulatorOwnership {
    External,
    Verboo,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AndroidEmulatorStartupStage {
    Booting,
    WaitingForDisplay,
    GeneratingFirstPreview,
    PreparingInteraction,
    Ready,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidEmulatorLifecycleEvent {
    pub stage: AndroidEmulatorStartupStage,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidEmulatorFrame {
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidEmulatorError {
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AndroidEmulatorPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AndroidEmulatorPresenceEvent {
    pub generation: u64,
    pub phase: String,
    pub action: Option<String>,
    pub target: Option<AndroidEmulatorPoint>,
    pub start: Option<AndroidEmulatorPoint>,
    pub end: Option<AndroidEmulatorPoint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidEmulatorSession {
    pub device: AndroidDevice,
    pub serial: String,
    pub generation: u64,
    pub ownership: AndroidEmulatorOwnership,
    pub stream_fps: u16,
    pub fallback_fps: f64,
    pub lifecycle: AndroidEmulatorLifecycleEvent,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OwnershipPhase {
    BootRequested,
    BootedByVerboo,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LedgerFile {
    version: u32,
    devices: BTreeMap<String, OwnershipPhase>,
}

/// Android's ownership ledger is deliberately separate from the iOS ledger.
/// The key is the exact AVD name, which is Android's stable device identity.
pub(crate) struct OwnershipLedger {
    path: Option<PathBuf>,
    devices: Mutex<BTreeMap<String, OwnershipPhase>>,
}

impl OwnershipLedger {
    pub(crate) fn open(app_data_dir: PathBuf) -> Result<Self, String> {
        let root = app_data_dir.join("android-emulator");
        std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let path = root.join("ownership.json");
        let devices = if path.exists() {
            let file: LedgerFile =
                serde_json::from_slice(&std::fs::read(&path).map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())?;
            if file.version != 1 {
                return Err(format!(
                    "unknown Android emulator ownership ledger version: {}",
                    file.version
                ));
            }
            file.devices
        } else {
            BTreeMap::new()
        };
        Ok(Self {
            path: Some(path),
            devices: Mutex::new(devices),
        })
    }

    pub(crate) fn mark_boot_requested(&self, avd_name: &str) -> Result<(), String> {
        self.update(avd_name, Some(OwnershipPhase::BootRequested))
    }

    pub(crate) fn mark_booted(&self, avd_name: &str) -> Result<(), String> {
        self.update(avd_name, Some(OwnershipPhase::BootedByVerboo))
    }

    pub(crate) fn remove(&self, avd_name: &str) -> Result<(), String> {
        self.update(avd_name, None)
    }

    pub(crate) fn phase(&self, avd_name: &str) -> Option<OwnershipPhase> {
        self.devices
            .lock()
            .expect("Android emulator ownership ledger poisoned")
            .get(avd_name)
            .copied()
    }

    fn update(&self, avd_name: &str, phase: Option<OwnershipPhase>) -> Result<(), String> {
        let mut devices = self
            .devices
            .lock()
            .expect("Android emulator ownership ledger poisoned");
        let previous = devices.clone();
        match phase {
            Some(phase) => {
                devices.insert(avd_name.to_string(), phase);
            }
            None => {
                devices.remove(avd_name);
            }
        }
        let Some(path) = self.path.as_deref() else {
            return Ok(());
        };
        if let Err(error) = persist_ledger(path, &devices) {
            *devices = previous;
            return Err(error);
        }
        Ok(())
    }
}

fn persist_ledger(path: &Path, devices: &BTreeMap<String, OwnershipPhase>) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&LedgerFile {
        version: 1,
        devices: devices.clone(),
    })
    .map_err(|error| error.to_string())?;
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())
}

pub(crate) struct PreviewGate {
    visible: Mutex<bool>,
    changed: Condvar,
    #[cfg(test)]
    parked_workers: AtomicUsize,
}

impl PreviewGate {
    pub(crate) fn new(visible: bool) -> Self {
        Self {
            visible: Mutex::new(visible),
            changed: Condvar::new(),
            #[cfg(test)]
            parked_workers: AtomicUsize::new(0),
        }
    }

    pub(crate) fn set_visible(&self, visible: bool) {
        *self.visible.lock().expect("Android preview gate poisoned") = visible;
        self.changed.notify_all();
    }

    pub(crate) fn stop_and_wake(&self, stop: &AtomicBool) {
        let _visible = self.visible.lock().expect("Android preview gate poisoned");
        stop.store(true, Ordering::Release);
        self.changed.notify_all();
    }

    pub(crate) fn wait_until_visible(&self, stop: &AtomicBool) -> bool {
        let mut visible = self.visible.lock().expect("Android preview gate poisoned");
        while !*visible && !stop.load(Ordering::Acquire) {
            #[cfg(test)]
            self.parked_workers.fetch_add(1, Ordering::AcqRel);
            visible = self
                .changed
                .wait(visible)
                .expect("Android preview gate poisoned");
            #[cfg(test)]
            self.parked_workers.fetch_sub(1, Ordering::AcqRel);
        }
        !stop.load(Ordering::Acquire) && *visible
    }

    #[cfg(test)]
    pub(crate) fn parked_workers(&self) -> usize {
        self.parked_workers.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn is_visible(&self) -> bool {
        *self.visible.lock().expect("Android preview gate poisoned")
    }

    fn emit_if_visible(&self, stop: &AtomicBool, emit: impl FnOnce()) -> bool {
        let visible = self.visible.lock().expect("Android preview gate poisoned");
        if !*visible || stop.load(Ordering::Acquire) {
            return false;
        }
        emit();
        true
    }

    pub(crate) fn wait_for_visible_interval(&self, stop: &AtomicBool, duration: Duration) -> bool {
        let visible = self.visible.lock().expect("Android preview gate poisoned");
        if !*visible || stop.load(Ordering::Acquire) {
            return false;
        }
        let (visible, _) = self
            .changed
            .wait_timeout_while(visible, duration, |visible| {
                *visible && !stop.load(Ordering::Acquire)
            })
            .expect("Android preview gate poisoned");
        !stop.load(Ordering::Acquire) && *visible
    }

    pub(crate) fn notify(&self) {
        self.changed.notify_all();
    }
}

trait AndroidFrameSink: Send + Sync {
    fn frame(&self, frame: AndroidEmulatorFrame);
    fn error(&self, message: String);
}

struct TauriFrameSink {
    app: AppHandle,
}

impl AndroidFrameSink for TauriFrameSink {
    fn frame(&self, frame: AndroidEmulatorFrame) {
        let _ = self.app.emit(FRAME_EVENT, frame);
    }

    fn error(&self, message: String) {
        emit_error(&self.app, message);
    }
}

pub(crate) struct AndroidSession {
    pub(crate) avd_name: String,
    pub(crate) device: AndroidDevice,
    pub(crate) serial: String,
    pub(crate) adb_path: PathBuf,
    pub(crate) ownership: AndroidEmulatorOwnership,
    pub(crate) generation: u64,
    pub(crate) stream_fps: Arc<Mutex<u16>>,
    pub(crate) fallback_fps: Arc<Mutex<f64>>,
    pub(crate) gate: Arc<PreviewGate>,
    pub(crate) stop: Arc<AtomicBool>,
    pub(crate) input_lock: Arc<Mutex<()>>,
    pub(crate) dimensions: Arc<Mutex<Option<(u32, u32)>>>,
    pub(crate) emulator_process: Arc<Mutex<Option<Child>>>,
    pub(crate) workers: Mutex<Vec<JoinHandle<()>>>,
}

impl AndroidSession {
    pub(crate) fn summary(&self) -> AndroidEmulatorSession {
        AndroidEmulatorSession {
            device: self.device.clone(),
            serial: self.serial.clone(),
            generation: self.generation,
            ownership: self.ownership,
            stream_fps: *self
                .stream_fps
                .lock()
                .expect("Android stream rate poisoned"),
            fallback_fps: *self
                .fallback_fps
                .lock()
                .expect("Android fallback rate poisoned"),
            lifecycle: AndroidEmulatorLifecycleEvent {
                stage: AndroidEmulatorStartupStage::Ready,
            },
        }
    }
}

#[derive(Default)]
pub(crate) struct AndroidServiceState {
    pub(crate) session: Option<Arc<AndroidSession>>,
}

pub(crate) fn adb_path(sdk_path: &Path) -> PathBuf {
    sdk_path
        .join("platform-tools")
        .join(if cfg!(windows) { "adb.exe" } else { "adb" })
}

fn emulator_path(sdk_path: &Path) -> PathBuf {
    sdk_path.join("emulator").join(if cfg!(windows) {
        "emulator.exe"
    } else {
        "emulator"
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boot_completion_requires_property_one() {
        assert!(is_boot_completed("1\n"));
        assert!(!is_boot_completed("0\n"));
        assert!(!is_boot_completed("1\n0\n"));
    }

    #[test]
    fn emulator_launch_uses_only_the_frozen_minimal_flags() {
        assert_eq!(
            emulator_launch_args("Pixel 8;safe"),
            vec!["-avd", "Pixel 8;safe", "-no-snapshot-save"]
        );
    }

    #[test]
    fn png_dimensions_read_the_real_ihdr() {
        let mut png = vec![0; 24];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[12..16].copy_from_slice(b"IHDR");
        png[16..20].copy_from_slice(&1080u32.to_be_bytes());
        png[20..24].copy_from_slice(&2400u32.to_be_bytes());
        assert_eq!(parse_png_dimensions(&png).unwrap(), (1080, 2400));
    }

    #[test]
    fn lifecycle_stages_serialize_with_the_frozen_ios_literals() {
        assert_eq!(
            serde_json::to_string(&AndroidEmulatorStartupStage::WaitingForDisplay).unwrap(),
            "\"waitingForDisplay\""
        );
        assert_eq!(
            serde_json::to_string(&AndroidEmulatorStartupStage::GeneratingFirstPreview).unwrap(),
            "\"generatingFirstPreview\""
        );
    }

    #[test]
    fn only_verboo_ownership_is_shutdown_eligible() {
        assert!(should_shutdown(AndroidEmulatorOwnership::Verboo));
        assert!(!should_shutdown(AndroidEmulatorOwnership::External));
    }

    #[test]
    fn ownership_ledger_round_trips_boot_requested_then_booted() {
        let root = tempfile::tempdir().unwrap();
        let ledger = OwnershipLedger::open(root.path().to_path_buf()).unwrap();
        ledger.mark_boot_requested("Pixel_8_API_35").unwrap();
        assert_eq!(
            OwnershipLedger::open(root.path().to_path_buf())
                .unwrap()
                .phase("Pixel_8_API_35"),
            Some(OwnershipPhase::BootRequested)
        );
        ledger.mark_booted("Pixel_8_API_35").unwrap();
        assert_eq!(
            OwnershipLedger::open(root.path().to_path_buf())
                .unwrap()
                .phase("Pixel_8_API_35"),
            Some(OwnershipPhase::BootedByVerboo)
        );
    }

    #[test]
    fn hidden_preview_gate_stops_waiting_without_capturing() {
        let gate = std::sync::Arc::new(PreviewGate::new(false));
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let waiting_gate = gate.clone();
        let waiting_stop = stop.clone();
        let worker = std::thread::spawn(move || {
            started_sender.send(()).unwrap();
            waiting_gate.wait_until_visible(&waiting_stop)
        });
        started_receiver
            .recv_timeout(std::time::Duration::from_millis(100))
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(100);
        while gate.parked_workers() == 0 && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(gate.parked_workers(), 1);
        gate.stop_and_wake(&stop);
        assert!(!worker.join().unwrap());
    }

    #[test]
    fn hidden_preview_gate_parks_then_resumes_when_visible() {
        let gate = std::sync::Arc::new(PreviewGate::new(false));
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let (ready_sender, ready_receiver) = std::sync::mpsc::channel();
        let waiting_gate = gate.clone();
        let waiting_stop = stop.clone();
        let worker = std::thread::spawn(move || {
            started_sender.send(()).unwrap();
            ready_sender
                .send(waiting_gate.wait_until_visible(&waiting_stop))
                .unwrap();
        });
        started_receiver
            .recv_timeout(std::time::Duration::from_millis(100))
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(100);
        while gate.parked_workers() == 0 && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(gate.parked_workers(), 1);
        assert!(ready_receiver.try_recv().is_err());
        gate.set_visible(true);
        assert_eq!(
            ready_receiver
                .recv_timeout(std::time::Duration::from_millis(100))
                .unwrap(),
            true
        );
        worker.join().unwrap();
        gate.set_visible(false);
        assert!(!gate.wait_for_visible_interval(&stop, std::time::Duration::from_millis(1)));
    }

    #[derive(Default)]
    struct RecordingRunner {
        commands: std::sync::Mutex<Vec<(String, Vec<String>)>>,
    }

    impl CommandRunner for RecordingRunner {
        fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, String> {
            self.commands
                .lock()
                .unwrap()
                .push((program.to_string(), args.to_vec()));
            Ok(CommandOutput {
                success: true,
                stdout: Vec::new(),
                stderr: Vec::new(),
            })
        }
    }

    fn png_output() -> CommandOutput {
        let mut stdout = vec![0; 24];
        stdout[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        stdout[12..16].copy_from_slice(b"IHDR");
        stdout[16..20].copy_from_slice(&1080u32.to_be_bytes());
        stdout[20..24].copy_from_slice(&1920u32.to_be_bytes());
        CommandOutput {
            success: true,
            stdout,
            stderr: Vec::new(),
        }
    }

    #[derive(Default)]
    struct PngRunner;

    impl CommandRunner for PngRunner {
        fn run(&self, _program: &str, _args: &[String]) -> Result<CommandOutput, String> {
            Ok(png_output())
        }

        fn run_interruptible(
            &self,
            _program: &str,
            _args: &[String],
            cancel: &AtomicBool,
            deadline: Instant,
        ) -> Result<CommandOutput, String> {
            if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
                return Err("cancelled".to_string());
            }
            Ok(png_output())
        }
    }

    struct CountingFrameSink {
        frames: AtomicUsize,
        errors: AtomicUsize,
    }

    impl CountingFrameSink {
        fn new() -> Self {
            Self {
                frames: AtomicUsize::new(0),
                errors: AtomicUsize::new(0),
            }
        }
    }

    impl AndroidFrameSink for CountingFrameSink {
        fn frame(&self, _frame: AndroidEmulatorFrame) {
            self.frames.fetch_add(1, Ordering::AcqRel);
        }

        fn error(&self, _message: String) {
            self.errors.fetch_add(1, Ordering::AcqRel);
        }
    }

    struct BlockingCaptureRunner {
        block_first_capture: AtomicBool,
        capture_started: Mutex<Option<std::sync::mpsc::Sender<()>>>,
        release_capture: Mutex<std::sync::mpsc::Receiver<()>>,
        capture_returned: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    }

    impl CommandRunner for BlockingCaptureRunner {
        fn run(&self, _program: &str, _args: &[String]) -> Result<CommandOutput, String> {
            Ok(png_output())
        }

        fn run_interruptible(
            &self,
            _program: &str,
            _args: &[String],
            cancel: &AtomicBool,
            deadline: Instant,
        ) -> Result<CommandOutput, String> {
            if self.block_first_capture.swap(false, Ordering::AcqRel) {
                if let Some(sender) = self.capture_started.lock().unwrap().take() {
                    sender.send(()).unwrap();
                }
                loop {
                    if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
                        return Err("capture cancelled".to_string());
                    }
                    if self
                        .release_capture
                        .lock()
                        .unwrap()
                        .recv_timeout(Duration::from_millis(5))
                        .is_ok()
                    {
                        break;
                    }
                }
                if let Some(sender) = self.capture_returned.lock().unwrap().take() {
                    sender.send(()).unwrap();
                }
            }
            Ok(png_output())
        }
    }

    struct BootCancellationRunner {
        started: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    }

    impl CommandRunner for BootCancellationRunner {
        fn run(&self, _program: &str, _args: &[String]) -> Result<CommandOutput, String> {
            if let Some(sender) = self.started.lock().unwrap().take() {
                sender.send(()).unwrap();
            }
            thread::sleep(Duration::from_millis(800));
            Ok(CommandOutput {
                success: true,
                stdout: Vec::new(),
                stderr: Vec::new(),
            })
        }

        fn run_interruptible(
            &self,
            _program: &str,
            _args: &[String],
            cancel: &AtomicBool,
            deadline: Instant,
        ) -> Result<CommandOutput, String> {
            if let Some(sender) = self.started.lock().unwrap().take() {
                sender.send(()).unwrap();
            }
            while !cancel.load(Ordering::Acquire) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(1));
            }
            Err("boot command cancelled".to_string())
        }
    }

    fn test_android_session(ownership: AndroidEmulatorOwnership) -> Arc<AndroidSession> {
        Arc::new(AndroidSession {
            avd_name: "Pixel_8_API_35".to_string(),
            device: AndroidDevice {
                avd_name: "Pixel_8_API_35".to_string(),
                display_name: "Pixel 8".to_string(),
                api_level: 35,
                family: requirements::AndroidDeviceFamily::Phone,
                running: true,
            },
            serial: "emulator-5554".to_string(),
            adb_path: PathBuf::from("adb"),
            ownership,
            generation: 1,
            stream_fps: Arc::new(Mutex::new(30)),
            fallback_fps: Arc::new(Mutex::new(2.0)),
            gate: Arc::new(PreviewGate::new(true)),
            stop: Arc::new(AtomicBool::new(false)),
            input_lock: Arc::new(Mutex::new(())),
            dimensions: Arc::new(Mutex::new(Some((1080, 1920)))),
            emulator_process: Arc::new(Mutex::new(None)),
            workers: Mutex::new(Vec::new()),
        })
    }

    #[test]
    fn first_preview_emits_zero_frames_when_hidden() {
        let runner: Arc<dyn CommandRunner> = Arc::new(PngRunner);
        let sink = CountingFrameSink::new();
        let session = test_android_session(AndroidEmulatorOwnership::External);
        *session.dimensions.lock().unwrap() = None;
        session.gate.set_visible(false);
        let cancel = AtomicBool::new(false);

        assert!(!capture_and_emit(runner, &sink, &session, &cancel).unwrap());
        assert_eq!(sink.frames.load(Ordering::Acquire), 0);
        assert!(session.gate.is_visible() == false);
        assert_eq!(*session.dimensions.lock().unwrap(), None);
    }

    #[test]
    fn real_frame_loop_suppresses_an_in_flight_capture_while_hidden() {
        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        let (returned_sender, returned_receiver) = std::sync::mpsc::channel();
        let runner: Arc<dyn CommandRunner> = Arc::new(BlockingCaptureRunner {
            block_first_capture: AtomicBool::new(true),
            capture_started: Mutex::new(Some(started_sender)),
            release_capture: Mutex::new(release_receiver),
            capture_returned: Mutex::new(Some(returned_sender)),
        });
        let sink = Arc::new(CountingFrameSink::new());
        let session = test_android_session(AndroidEmulatorOwnership::External);
        let root = tempfile::tempdir().unwrap();
        let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
        service.state.lock().unwrap().session = Some(session.clone());
        let worker = spawn_frame_loop(runner, sink.clone(), session.clone());

        started_receiver
            .recv_timeout(Duration::from_millis(100))
            .unwrap();
        service.set_visible_sync(false).unwrap();
        release_sender.send(()).unwrap();
        returned_receiver
            .recv_timeout(Duration::from_millis(100))
            .unwrap();
        assert_eq!(sink.frames.load(Ordering::Acquire), 0);

        let parked_deadline = Instant::now() + Duration::from_millis(100);
        while session.gate.parked_workers() == 0 && Instant::now() < parked_deadline {
            thread::yield_now();
        }
        assert_eq!(session.gate.parked_workers(), 1);

        service.set_visible_sync(true).unwrap();
        let frame_deadline = Instant::now() + Duration::from_millis(500);
        while sink.frames.load(Ordering::Acquire) == 0 && Instant::now() < frame_deadline {
            thread::yield_now();
        }
        assert!(sink.frames.load(Ordering::Acquire) >= 1);
        assert_eq!(sink.errors.load(Ordering::Acquire), 0);

        session.gate.stop_and_wake(&session.stop);
        worker.join().unwrap();
    }

    #[test]
    fn detach_cancels_boot_polling_without_waiting_for_command_deadline() {
        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let runner = Arc::new(BootCancellationRunner {
            started: Mutex::new(Some(started_sender)),
        });
        let root = tempfile::tempdir().unwrap();
        let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
        service.runner = runner.clone();
        let stop = service.session_cancel.clone();
        let process = Arc::new(Mutex::new(None));
        let runner_for_thread = runner.clone();
        let stop_for_thread = stop.clone();
        let result = thread::spawn(move || {
            wait_for_boot(
                runner_for_thread.as_ref(),
                "adb",
                "Pixel_8_API_35",
                &process,
                stop_for_thread.as_ref(),
                Instant::now() + Duration::from_secs(2),
            )
        });
        started_receiver
            .recv_timeout(Duration::from_millis(100))
            .unwrap();
        let cancelled_at = Instant::now();
        assert_eq!(
            service.detach_sync().unwrap_err(),
            "No Android emulator is attached."
        );
        assert_eq!(
            result.join().unwrap().unwrap_err(),
            "Android emulator boot cancelled"
        );
        assert!(
            cancelled_at.elapsed() < Duration::from_millis(700),
            "boot cancellation exceeded its interruptibility budget"
        );
    }

    #[test]
    fn switching_owned_avd_removes_ledger_before_external_reentry() {
        let root = tempfile::tempdir().unwrap();
        let runner = Arc::new(RecordingRunner::default());
        let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
        service.runner = runner.clone();
        service.ownership.mark_booted("Pixel_8_API_35").unwrap();
        service.state.lock().unwrap().session =
            Some(test_android_session(AndroidEmulatorOwnership::Verboo));

        service.stop_current_locked(true).unwrap();

        assert_eq!(
            service.ownership.phase("Pixel_8_API_35"),
            None,
            "switch cleanup must remove the old owned AVD from the ledger"
        );
        assert_eq!(
            ownership_for_running_avd(&service.ownership, "Pixel_8_API_35"),
            AndroidEmulatorOwnership::External,
            "a reappearing external AVD must not inherit stale Verboo ownership"
        );
        let kill_count_after_switch = runner
            .commands
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, args)| args.ends_with(&["emu".to_string(), "kill".to_string()]))
            .count();
        assert_eq!(kill_count_after_switch, 1);

        service.state.lock().unwrap().session = Some(test_android_session(
            ownership_for_running_avd(&service.ownership, "Pixel_8_API_35"),
        ));
        service.end_sync().unwrap();
        let kill_count_after_external_end = runner
            .commands
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, args)| args.ends_with(&["emu".to_string(), "kill".to_string()]))
            .count();
        assert_eq!(kill_count_after_external_end, 1);
    }
}

pub(crate) fn is_boot_completed(output: &str) -> bool {
    output.trim() == "1"
}

pub(crate) fn emulator_launch_args(avd_name: &str) -> Vec<String> {
    vec![
        "-avd".to_string(),
        avd_name.to_string(),
        "-no-snapshot-save".to_string(),
    ]
}

pub(crate) fn parse_png_dimensions(png: &[u8]) -> Result<(u32, u32), String> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if png.len() < 24 || &png[..8] != PNG_SIGNATURE || &png[12..16] != b"IHDR" {
        return Err("adb returned an invalid PNG frame".to_string());
    }
    let width = u32::from_be_bytes(png[16..20].try_into().expect("PNG width bytes"));
    let height = u32::from_be_bytes(png[20..24].try_into().expect("PNG height bytes"));
    if width == 0 || height == 0 {
        return Err("adb returned an empty PNG frame".to_string());
    }
    Ok((width, height))
}

pub(crate) fn should_shutdown(ownership: AndroidEmulatorOwnership) -> bool {
    matches!(ownership, AndroidEmulatorOwnership::Verboo)
}

impl AndroidEmulatorService {
    pub(crate) fn bind_app(&self, app: AppHandle) {
        *self
            .app
            .lock()
            .expect("Android emulator app handle poisoned") = Some(app);
    }

    pub(crate) fn current_session(&self) -> Result<Arc<AndroidSession>, String> {
        self.current_session_option()
            .ok_or_else(|| "No Android emulator is attached.".to_string())
    }

    fn current_session_option(&self) -> Option<Arc<AndroidSession>> {
        self.state
            .lock()
            .expect("Android emulator state poisoned")
            .session
            .clone()
    }

    pub(crate) fn attach_sync(
        &self,
        app: AppHandle,
        avd_name: String,
        stream_fps: u16,
        fallback_fps: f64,
    ) -> Result<AndroidEmulatorSession, String> {
        let stream_fps = validate_stream_fps(stream_fps)?;
        let fallback_fps = validate_fallback_fps(fallback_fps)?;
        let _operation = self
            .operation_lock
            .lock()
            .expect("Android emulator operation lock poisoned");
        self.session_cancel.store(false, Ordering::Release);
        self.bind_app(app.clone());

        if let Some(current) = self.current_session_option() {
            if current.avd_name == avd_name {
                *current
                    .stream_fps
                    .lock()
                    .expect("Android stream rate poisoned") = stream_fps;
                *current
                    .fallback_fps
                    .lock()
                    .expect("Android fallback rate poisoned") = fallback_fps;
                current.gate.notify();
                return Ok(current.summary());
            }
            self.stop_current_locked(true)?;
        }

        let sdk_path = sdk::resolve_sdk_path(&self.app_data_dir);
        let available = sdk::list_avd_names(self.runner.as_ref(), &sdk_path);
        if !available.iter().any(|candidate| candidate == &avd_name) {
            return Err(format!("Android AVD is not available: {avd_name}"));
        }

        let adb_path = adb_path(&sdk_path);
        let adb = adb_path.to_string_lossy().into_owned();
        let generation = self
            .next_generation
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1);
        emit_lifecycle(&app, AndroidEmulatorStartupStage::Booting);

        let existing_serial = find_running_serial(
            self.runner.as_ref(),
            &adb,
            &avd_name,
            self.session_cancel.as_ref(),
            Instant::now() + ADB_COMMAND_TIMEOUT,
        );
        if self.session_cancel.load(Ordering::Acquire) {
            return Err("Android emulator attach was cancelled".to_string());
        }
        let process = Arc::new(Mutex::new(None));
        let (ownership, boot_requested) = if existing_serial.is_some() {
            (ownership_for_running_avd(&self.ownership, &avd_name), false)
        } else {
            self.ownership.mark_boot_requested(&avd_name)?;
            let emulator = emulator_path(&sdk_path);
            let child = match spawn_emulator(&emulator, &avd_name) {
                Ok(child) => child,
                Err(error) => {
                    let _ = self.ownership.remove(&avd_name);
                    return Err(error);
                }
            };
            *process.lock().expect("Android emulator process poisoned") = Some(child);
            (AndroidEmulatorOwnership::Verboo, true)
        };

        emit_lifecycle(&app, AndroidEmulatorStartupStage::WaitingForDisplay);
        let serial = match wait_for_boot(
            self.runner.as_ref(),
            &adb,
            &avd_name,
            &process,
            self.session_cancel.as_ref(),
            Instant::now() + BOOT_TIMEOUT,
        ) {
            Ok(serial) => serial,
            Err(error) => {
                if boot_requested {
                    let _ = terminate_process(&process);
                    let _ = self.ownership.remove(&avd_name);
                }
                emit_error(&app, error.clone());
                return Err(error);
            }
        };

        if ownership == AndroidEmulatorOwnership::Verboo {
            self.ownership.mark_booted(&avd_name)?;
        }

        let device = AndroidDevice {
            avd_name: avd_name.clone(),
            display_name: avd_name.clone(),
            api_level: requirements::api_level_from_name(&avd_name),
            family: requirements::android_device_family(&avd_name),
            running: true,
        };
        let stop = Arc::new(AtomicBool::new(false));
        let gate = Arc::new(PreviewGate::new(
            self.desired_visibility.load(Ordering::Acquire),
        ));
        let session = Arc::new(AndroidSession {
            avd_name,
            device,
            serial,
            adb_path,
            ownership,
            generation,
            stream_fps: Arc::new(Mutex::new(stream_fps)),
            fallback_fps: Arc::new(Mutex::new(fallback_fps)),
            gate,
            stop,
            input_lock: Arc::new(Mutex::new(())),
            dimensions: Arc::new(Mutex::new(None)),
            emulator_process: process,
            workers: Mutex::new(Vec::new()),
        });
        self.state
            .lock()
            .expect("Android emulator state poisoned")
            .session = Some(session.clone());

        emit_lifecycle(&app, AndroidEmulatorStartupStage::GeneratingFirstPreview);
        let sink: Arc<dyn AndroidFrameSink> = Arc::new(TauriFrameSink { app: app.clone() });
        loop {
            if self.session_cancel.load(Ordering::Acquire)
                || !session.gate.wait_until_visible(&session.stop)
            {
                let avd_name = session.avd_name.clone();
                let _ = self.take_session();
                let _ = self.cleanup_session(session, true);
                if boot_requested {
                    let _ = self.ownership.remove(&avd_name);
                }
                return Err("Android emulator attach was cancelled".to_string());
            }
            match capture_and_emit(
                self.runner.clone(),
                sink.as_ref(),
                &session,
                self.session_cancel.as_ref(),
            ) {
                Ok(true) => break,
                Ok(false) if self.session_cancel.load(Ordering::Acquire) => {
                    let avd_name = session.avd_name.clone();
                    let _ = self.take_session();
                    let _ = self.cleanup_session(session, true);
                    if boot_requested {
                        let _ = self.ownership.remove(&avd_name);
                    }
                    return Err("Android emulator attach was cancelled".to_string());
                }
                Ok(false) => continue,
                Err(error) => {
                    let avd_name = session.avd_name.clone();
                    let _ = self.take_session();
                    let cleanup_error = self.cleanup_session(session, true).err();
                    if boot_requested {
                        let _ = self.ownership.remove(&avd_name);
                    }
                    if let Some(cleanup_error) = cleanup_error {
                        emit_error(&app, format!("{error}; cleanup failed: {cleanup_error}"));
                    } else {
                        emit_error(&app, error.clone());
                    }
                    return Err(error);
                }
            }
        }

        emit_lifecycle(&app, AndroidEmulatorStartupStage::PreparingInteraction);
        emit_lifecycle(&app, AndroidEmulatorStartupStage::Ready);
        let worker = spawn_frame_loop(self.runner.clone(), sink, session.clone());
        session
            .workers
            .lock()
            .expect("Android emulator workers poisoned")
            .push(worker);
        Ok(session.summary())
    }

    pub(crate) fn set_visible_sync(&self, visible: bool) -> Result<(), String> {
        self.desired_visibility.store(visible, Ordering::Release);
        if let Some(session) = self.current_session_option() {
            session.gate.set_visible(visible);
        }
        Ok(())
    }

    pub(crate) fn set_stream_rate_sync(&self, stream_fps: u16) -> Result<u16, String> {
        let stream_fps = validate_stream_fps(stream_fps)?;
        let session = self.current_session()?;
        *session
            .stream_fps
            .lock()
            .expect("Android stream rate poisoned") = stream_fps;
        session.gate.notify();
        Ok(stream_fps)
    }

    pub(crate) fn set_fallback_rate_sync(&self, fallback_fps: f64) -> Result<f64, String> {
        let fallback_fps = validate_fallback_fps(fallback_fps)?;
        let session = self.current_session()?;
        *session
            .fallback_fps
            .lock()
            .expect("Android fallback rate poisoned") = fallback_fps;
        session.gate.notify();
        Ok(fallback_fps)
    }

    fn request_session_cancel(&self) {
        self.session_cancel.store(true, Ordering::Release);
        if let Some(session) = self.current_session_option() {
            session.gate.stop_and_wake(&session.stop);
        }
    }

    pub(crate) fn detach_sync(&self) -> Result<(), String> {
        self.request_session_cancel();
        let _operation = self
            .operation_lock
            .lock()
            .expect("Android emulator operation lock poisoned");
        let session = self
            .take_session()
            .ok_or_else(|| "No Android emulator is attached.".to_string())?;
        self.cleanup_session(session, false)
    }

    pub(crate) fn end_sync(&self) -> Result<(), String> {
        self.request_session_cancel();
        let _operation = self
            .operation_lock
            .lock()
            .expect("Android emulator operation lock poisoned");
        let session = self
            .take_session()
            .ok_or_else(|| "No Android emulator is attached.".to_string())?;
        let avd_name = session.avd_name.clone();
        let ownership = session.ownership;
        self.cleanup_session(session, should_shutdown(ownership))?;
        if should_shutdown(ownership) {
            self.ownership.remove(&avd_name)?;
        }
        Ok(())
    }

    fn take_session(&self) -> Option<Arc<AndroidSession>> {
        self.state
            .lock()
            .expect("Android emulator state poisoned")
            .session
            .take()
    }

    fn stop_current_locked(&self, terminate_owned: bool) -> Result<(), String> {
        let Some(session) = self.take_session() else {
            return Ok(());
        };
        let avd_name = session.avd_name.clone();
        let ownership = session.ownership;
        self.cleanup_session(session, terminate_owned)?;
        if terminate_owned && should_shutdown(ownership) {
            self.ownership.remove(&avd_name)?;
        }
        Ok(())
    }

    fn cleanup_session(
        &self,
        session: Arc<AndroidSession>,
        terminate_owned: bool,
    ) -> Result<(), String> {
        session.gate.stop_and_wake(&session.stop);
        let workers = std::mem::take(
            &mut *session
                .workers
                .lock()
                .expect("Android emulator workers poisoned"),
        );
        for worker in workers {
            let _ = worker.join();
        }
        if terminate_owned && should_shutdown(session.ownership) {
            shutdown_owned_emulator(self.runner.as_ref(), &session)?;
        }
        Ok(())
    }
}

fn validate_stream_fps(fps: u16) -> Result<u16, String> {
    if (MIN_STREAM_FPS..=MAX_STREAM_FPS).contains(&fps) {
        Ok(fps)
    } else {
        Err(format!(
            "Android stream rate must be between {MIN_STREAM_FPS} and {MAX_STREAM_FPS} fps"
        ))
    }
}

fn validate_fallback_fps(fps: f64) -> Result<f64, String> {
    if fps.is_finite() && (MIN_FALLBACK_FPS..=MAX_FALLBACK_FPS).contains(&fps) {
        Ok(fps)
    } else {
        Err(format!(
            "Android fallback rate must be between {MIN_FALLBACK_FPS} and {MAX_FALLBACK_FPS} fps"
        ))
    }
}

fn ownership_for_running_avd(ledger: &OwnershipLedger, avd_name: &str) -> AndroidEmulatorOwnership {
    if ledger.phase(avd_name).is_some() {
        AndroidEmulatorOwnership::Verboo
    } else {
        AndroidEmulatorOwnership::External
    }
}

fn emit_lifecycle(app: &AppHandle, stage: AndroidEmulatorStartupStage) {
    let _ = app.emit(LIFECYCLE_EVENT, AndroidEmulatorLifecycleEvent { stage });
}

pub(crate) fn emit_error(app: &AppHandle, message: String) {
    let _ = app.emit(ERROR_EVENT, AndroidEmulatorError { message });
}

fn spawn_emulator(path: &Path, avd_name: &str) -> Result<Child, String> {
    let mut command = Command::new(path);
    command.args(emulator_launch_args(avd_name));
    command.stdin(Stdio::null());
    command.stdout(Stdio::null());
    command.stderr(Stdio::null());
    crate::services::cli_spawn::apply_creation_flags(&mut command);
    crate::services::child_signal::configure_process_group(&mut command);
    command
        .spawn()
        .map_err(|error| format!("failed to start Android emulator: {error}"))
}

fn find_running_serial(
    runner: &dyn CommandRunner,
    adb: &str,
    avd_name: &str,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Option<String> {
    let output = runner
        .run_interruptible(adb, &["devices".to_string()], cancel, deadline)
        .ok()
        .filter(|output| output.success)?;
    for serial in requirements::parse_adb_devices(&String::from_utf8_lossy(&output.stdout)) {
        let Ok(name_output) = runner.run_interruptible(
            adb,
            &[
                "-s".to_string(),
                serial.clone(),
                "emu".to_string(),
                "avd".to_string(),
                "name".to_string(),
            ],
            cancel,
            deadline,
        ) else {
            continue;
        };
        if name_output.success
            && requirements::parse_avd_name_from_emu(&String::from_utf8_lossy(&name_output.stdout))
                .as_deref()
                == Some(avd_name)
        {
            return Some(serial);
        }
    }
    None
}

fn wait_for_boot(
    runner: &dyn CommandRunner,
    adb: &str,
    avd_name: &str,
    process: &Arc<Mutex<Option<Child>>>,
    stop: &AtomicBool,
    deadline: Instant,
) -> Result<String, String> {
    loop {
        if stop.load(Ordering::Acquire) {
            let _ = terminate_process(process);
            return Err("Android emulator boot cancelled".to_string());
        }
        if let Some(serial) = find_running_serial(runner, adb, avd_name, stop, deadline) {
            let output = runner.run_interruptible(
                adb,
                &[
                    "-s".to_string(),
                    serial.clone(),
                    "shell".to_string(),
                    "getprop".to_string(),
                    "sys.boot_completed".to_string(),
                ],
                stop,
                deadline,
            );
            if let Ok(output) = output {
                if output.success && is_boot_completed(&String::from_utf8_lossy(&output.stdout)) {
                    return Ok(serial);
                }
            }
        }
        if process_exited(process)? {
            return Err(format!(
                "Android emulator process exited before {avd_name} booted"
            ));
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "timed out waiting for Android AVD {avd_name} to boot"
            ));
        }
        thread::sleep(Duration::from_millis(250));
    }
}

fn process_exited(process: &Arc<Mutex<Option<Child>>>) -> Result<bool, String> {
    let mut process = process
        .lock()
        .map_err(|_| "Android emulator process lock poisoned".to_string())?;
    let Some(process) = process.as_mut() else {
        return Ok(false);
    };
    process
        .try_wait()
        .map(|status| status.is_some())
        .map_err(|error| error.to_string())
}

fn terminate_process(process: &Arc<Mutex<Option<Child>>>) -> Result<(), String> {
    let mut process = process
        .lock()
        .map_err(|_| "Android emulator process lock poisoned".to_string())?;
    let Some(process) = process.as_mut() else {
        return Ok(());
    };
    if process
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_none()
    {
        crate::services::child_signal::terminate_process_group(process)?;
        let _ = process.wait();
    }
    Ok(())
}

fn shutdown_owned_emulator(
    runner: &dyn CommandRunner,
    session: &AndroidSession,
) -> Result<(), String> {
    let mut process = session
        .emulator_process
        .lock()
        .map_err(|_| "Android emulator process lock poisoned".to_string())?;
    if let Some(process) = process.as_mut() {
        if process
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            crate::services::child_signal::terminate_process_group(process)?;
            let _ = process.wait();
        }
        return Ok(());
    }
    drop(process);
    let output = runner.run(
        session.adb_path.to_string_lossy().as_ref(),
        &[
            "-s".to_string(),
            session.serial.clone(),
            "emu".to_string(),
            "kill".to_string(),
        ],
    )?;
    if output.success {
        Ok(())
    } else {
        Err(command_error("adb emu kill", &output))
    }
}

fn capture_and_emit(
    runner: Arc<dyn CommandRunner>,
    sink: &dyn AndroidFrameSink,
    session: &AndroidSession,
    cancel: &AtomicBool,
) -> Result<bool, String> {
    let bytes = capture_png(
        runner.as_ref(),
        session.adb_path.to_string_lossy().as_ref(),
        &session.serial,
        cancel,
        Instant::now() + ADB_COMMAND_TIMEOUT,
    )?;
    let (width, height) = parse_png_dimensions(&bytes)?;
    if cancel.load(Ordering::Acquire) {
        return Ok(false);
    }
    let frame = AndroidEmulatorFrame {
        png_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        width,
        height,
        generation: session.generation,
    };
    Ok(session.gate.emit_if_visible(&session.stop, || {
        *session
            .dimensions
            .lock()
            .expect("Android frame dimensions poisoned") = Some((width, height));
        sink.frame(frame);
    }))
}

fn capture_png(
    runner: &dyn CommandRunner,
    adb: &str,
    serial: &str,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<Vec<u8>, String> {
    let output = runner.run_interruptible(
        adb,
        &[
            "-s".to_string(),
            serial.to_string(),
            "exec-out".to_string(),
            "screencap".to_string(),
            "-p".to_string(),
        ],
        cancel,
        deadline,
    )?;
    if output.success {
        Ok(output.stdout)
    } else {
        Err(command_error("adb screencap", &output))
    }
}

fn spawn_frame_loop(
    runner: Arc<dyn CommandRunner>,
    sink: Arc<dyn AndroidFrameSink>,
    session: Arc<AndroidSession>,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name(format!("verboo-android-frame-{}", session.generation))
        .spawn(move || loop {
            if !session.gate.wait_until_visible(&session.stop) {
                break;
            }
            let started = Instant::now();
            let capture = capture_png(
                runner.as_ref(),
                session.adb_path.to_string_lossy().as_ref(),
                &session.serial,
                &session.stop,
                Instant::now() + ADB_COMMAND_TIMEOUT,
            )
            .and_then(|bytes| {
                let dimensions = parse_png_dimensions(&bytes)?;
                Ok((bytes, dimensions))
            });
            let rate = match capture {
                Ok((bytes, (width, height))) => {
                    session.gate.emit_if_visible(&session.stop, || {
                        *session
                            .dimensions
                            .lock()
                            .expect("Android frame dimensions poisoned") = Some((width, height));
                        sink.frame(AndroidEmulatorFrame {
                            png_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                            width,
                            height,
                            generation: session.generation,
                        });
                    });
                    f64::from(
                        *session
                            .stream_fps
                            .lock()
                            .expect("Android stream rate poisoned"),
                    )
                }
                Err(_) if session.stop.load(Ordering::Acquire) => break,
                Err(error) => {
                    sink.error(error);
                    *session
                        .fallback_fps
                        .lock()
                        .expect("Android fallback rate poisoned")
                }
            };
            let interval = Duration::from_secs_f64(1.0 / rate.max(0.1));
            let remaining = interval.saturating_sub(started.elapsed());
            if !session
                .gate
                .wait_for_visible_interval(&session.stop, remaining)
                && session.stop.load(Ordering::Acquire)
            {
                break;
            }
        })
        .expect("Android frame worker thread must start")
}

fn command_error(command: &str, output: &CommandOutput) -> String {
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if detail.is_empty() {
        format!("{command} failed")
    } else {
        format!("{command} failed: {detail}")
    }
}
