//! Android emulator session, lifecycle, preview, and ownership primitives (PA-26).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::preview::{
    next_preview_generation, FirstPreviewError, FirstPreviewGate, FirstPreviewState, FrameReady,
    LatestSlot, PreviewControl, PreviewEventSink, PreviewHealth, PreviewMode, PreviewReadError,
    PreviewReason, PreviewSource, PreviewState, PreviewTransport, WorkerOutcome,
};
use super::requirements::{self, AndroidDevice};
use super::{
    grpc, sdk, AndroidEmulatorService, CommandOutput, CommandRunner, ANDROID_CLEANUP_BUDGET,
};
use crate::models::types::AndroidStreamFps;

#[path = "session/boot.rs"]
mod boot;
#[path = "session/preview.rs"]
mod preview_runtime;
pub(crate) use boot::emit_error;
use boot::{
    apply_postboot_gpu_probe, attach_ownership, boot_owned_with_attempts, command_error,
    emit_lifecycle, emit_session_ended, emulator_launch_args, emulator_path, find_running_serial,
    is_boot_completed, ownership_for_running_avd, parse_png_dimensions,
    probe_owned_surface_flinger, should_shutdown, shutdown_owned_emulator,
    surface_flinger_uses_software_gpu, validate_fallback_fps, validate_stream_fps, wait_for_boot,
    EmulatorLauncher, GpuMode, OwnedBootAttemptError, OwnedBootAttempts, OwnedBootError,
    OwnedBootResult, SystemEmulatorLauncher, SystemOwnedBootAttempts,
};
use preview_runtime::{
    capture_and_emit, coordinate_fallback, fail_first_or_emit_terminal, finish_started_preview,
    is_device_gone_screencap, run_android_frame_loop, run_preview_coordinator,
    start_preview_for_session, CoordinatorOutcome, LegacyPreviewBackend,
    LegacyPreviewBackendFactory, PreviewFactoryProvider, PreviewStart,
    SystemLegacyPreviewBackendFactory, SystemPreviewFactoryProvider,
    DEVICE_GONE_CONSECUTIVE_FAILURES,
};
pub(crate) use preview_runtime::{PreviewAvailability, PreviewRuntime};

pub(crate) const FRAME_EVENT: &str = "android-emulator:frame";
pub(crate) const FRAME_READY_EVENT: &str = "android-emulator:frame-ready";
pub(crate) const PREVIEW_STATE_EVENT: &str = "android-emulator:preview-state";
pub(crate) const LIFECYCLE_EVENT: &str = "android-emulator:lifecycle";
pub(crate) const ERROR_EVENT: &str = "android-emulator:error";
pub(crate) const PRESENCE_EVENT: &str = "android-emulator:presence";
/// Additive session-ended channel (E2 device-death teardown). Frozen
/// literal — do not rename; renderer subscribes to this exact string.
pub(crate) const SESSION_ENDED_EVENT: &str = "android-emulator:session-ended";

const BOOT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MIN_STREAM_FPS: u16 = 1;
const MAX_STREAM_FPS: u16 = 60;
const MIN_FALLBACK_FPS: f64 = 0.5;
const MAX_FALLBACK_FPS: f64 = 2.0;
const ADB_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

#[cfg(test)]
struct TestPause {
    reached: std::sync::mpsc::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
}

#[cfg(test)]
fn arm_test_pause(
    slot: &Mutex<Option<TestPause>>,
) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
    let (reached_sender, reached_receiver) = std::sync::mpsc::channel();
    let (release_sender, release_receiver) = std::sync::mpsc::channel();
    *slot.lock().expect("Android test pause poisoned") = Some(TestPause {
        reached: reached_sender,
        release: release_receiver,
    });
    (reached_receiver, release_sender)
}

#[cfg(test)]
fn wait_test_pause(slot: &Mutex<Option<TestPause>>) {
    let Some(pause) = slot.lock().expect("Android test pause poisoned").take() else {
        return;
    };
    let _ = pause.reached.send(());
    let _ = pause.release.recv();
}

pub(crate) struct SessionCancellation {
    cancelled: AtomicBool,
    revision: AtomicU64,
    transition: Mutex<()>,
    #[cfg(test)]
    ticket_observed: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    #[cfg(test)]
    after_reset: Mutex<Option<TestPause>>,
    #[cfg(test)]
    before_publish: Mutex<Option<TestPause>>,
    #[cfg(test)]
    after_lost_generation_check: Mutex<Option<TestPause>>,
}

impl SessionCancellation {
    pub(crate) fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            revision: AtomicU64::new(0),
            transition: Mutex::new(()),
            #[cfg(test)]
            ticket_observed: Mutex::new(None),
            #[cfg(test)]
            after_reset: Mutex::new(None),
            #[cfg(test)]
            before_publish: Mutex::new(None),
            #[cfg(test)]
            after_lost_generation_check: Mutex::new(None),
        }
    }

    pub(crate) fn cancel(&self) {
        let _transition = self
            .transition
            .lock()
            .expect("Android session cancellation poisoned");
        self.revision.fetch_add(1, Ordering::Relaxed);
        self.cancelled.store(true, Ordering::Release);
    }

    pub(crate) fn ticket(&self) -> u64 {
        let _transition = self
            .transition
            .lock()
            .expect("Android session cancellation poisoned");
        let ticket = self.revision.load(Ordering::Relaxed);
        #[cfg(test)]
        if let Some(sender) = self
            .ticket_observed
            .lock()
            .expect("Android session cancellation test hook poisoned")
            .take()
        {
            let _ = sender.send(());
        }
        ticket
    }

    pub(crate) fn reset_if_unchanged(&self, ticket: u64) -> bool {
        let _transition = self
            .transition
            .lock()
            .expect("Android session cancellation poisoned");
        if self.revision.load(Ordering::Relaxed) != ticket {
            return false;
        }
        self.cancelled.store(false, Ordering::Release);
        true
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub(crate) fn flag(&self) -> &AtomicBool {
        &self.cancelled
    }

    pub(crate) fn run_if_active<T>(&self, action: impl FnOnce() -> T) -> Option<T> {
        let _transition = self
            .transition
            .lock()
            .expect("Android session cancellation poisoned");
        if self.is_cancelled() {
            return None;
        }
        Some(action())
    }

    #[cfg(test)]
    fn transition_is_held(&self) -> bool {
        self.transition.try_lock().is_err()
    }

    #[cfg(test)]
    fn observe_next_ticket(&self, sender: std::sync::mpsc::Sender<()>) {
        *self
            .ticket_observed
            .lock()
            .expect("Android session cancellation test hook poisoned") = Some(sender);
    }

    #[cfg(test)]
    fn pause_after_reset_for_test(
        &self,
    ) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
        arm_test_pause(&self.after_reset)
    }

    #[cfg(test)]
    fn pause_before_publish_for_test(
        &self,
    ) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
        arm_test_pause(&self.before_publish)
    }

    #[cfg(test)]
    fn pause_after_reset(&self) {
        wait_test_pause(&self.after_reset);
    }

    #[cfg(test)]
    fn pause_before_publish(&self) {
        wait_test_pause(&self.before_publish);
    }

    #[cfg(test)]
    fn pause_after_lost_generation_check_for_test(
        &self,
    ) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
        arm_test_pause(&self.after_lost_generation_check)
    }

    #[cfg(test)]
    fn pause_after_lost_generation_check(&self) {
        wait_test_pause(&self.after_lost_generation_check);
    }
}

impl Default for SessionCancellation {
    fn default() -> Self {
        Self::new()
    }
}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<PreviewReason>,
}

impl AndroidEmulatorError {
    pub(crate) fn from_message(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
        }
    }

    pub(crate) fn with_code(message: impl Into<String>, code: PreviewReason) -> Self {
        Self {
            message: message.into(),
            code: Some(code),
        }
    }
}

/// Payload of `android-emulator:session-ended`. `generation` is the
/// session that was cleaned up. `code` uses the E1 PreviewReason wire
/// vocabulary (`deviceLost`, `unavailable`, …) and is omitted when None.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AndroidEmulatorSessionEnded {
    pub generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<PreviewReason>,
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

trait BootLedger: Send + Sync {
    fn mark_boot_requested(&self, avd_name: &str) -> Result<(), String>;
    fn mark_booted(&self, avd_name: &str) -> Result<(), String>;
    fn remove(&self, avd_name: &str) -> Result<(), String>;
}

impl BootLedger for OwnershipLedger {
    fn mark_boot_requested(&self, avd_name: &str) -> Result<(), String> {
        OwnershipLedger::mark_boot_requested(self, avd_name)
    }

    fn mark_booted(&self, avd_name: &str) -> Result<(), String> {
        OwnershipLedger::mark_booted(self, avd_name)
    }

    fn remove(&self, avd_name: &str) -> Result<(), String> {
        OwnershipLedger::remove(self, avd_name)
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
    state: Mutex<PreviewGateState>,
    changed: Condvar,
    #[cfg(test)]
    parked_workers: AtomicUsize,
}

struct PreviewGateState {
    visible: bool,
    stop: bool,
    control: Option<tokio::sync::watch::Sender<PreviewControl>>,
}

impl PreviewGate {
    pub(crate) fn new(visible: bool) -> Self {
        Self {
            state: Mutex::new(PreviewGateState {
                visible,
                stop: false,
                control: None,
            }),
            changed: Condvar::new(),
            #[cfg(test)]
            parked_workers: AtomicUsize::new(0),
        }
    }

    pub(crate) fn set_visible(&self, visible: bool) {
        let mut state = self.state.lock().expect("Android preview gate poisoned");
        state.visible = visible;
        if let Some(sender) = state.control.as_ref() {
            sender.send_replace(PreviewControl {
                visible: state.visible,
                stop: state.stop,
            });
        }
        self.changed.notify_all();
    }

    pub(crate) fn stop_and_wake(&self, stop: &AtomicBool) {
        let mut state = self.state.lock().expect("Android preview gate poisoned");
        stop.store(true, Ordering::Release);
        state.stop = true;
        state.visible = false;
        if let Some(sender) = state.control.as_ref() {
            sender.send_replace(PreviewControl {
                visible: false,
                stop: true,
            });
        }
        self.changed.notify_all();
    }

    pub(crate) fn install_control(
        &self,
        sender: tokio::sync::watch::Sender<PreviewControl>,
    ) -> Result<(), String> {
        let mut state = self.state.lock().expect("Android preview gate poisoned");
        if state.control.is_some() {
            return Err("Android preview control already installed".to_string());
        }
        sender.send_replace(PreviewControl {
            visible: state.visible,
            stop: state.stop,
        });
        state.control = Some(sender);
        Ok(())
    }

    pub(crate) fn refresh_control(&self) {
        let state = self.state.lock().expect("Android preview gate poisoned");
        if let Some(sender) = state.control.as_ref() {
            sender.send_replace(PreviewControl {
                visible: state.visible,
                stop: state.stop,
            });
        }
    }

    pub(crate) fn wait_until_visible(&self, stop: &AtomicBool) -> bool {
        let mut state = self.state.lock().expect("Android preview gate poisoned");
        while !state.visible && !stop.load(Ordering::Acquire) {
            #[cfg(test)]
            self.parked_workers.fetch_add(1, Ordering::AcqRel);
            state = self
                .changed
                .wait(state)
                .expect("Android preview gate poisoned");
            #[cfg(test)]
            self.parked_workers.fetch_sub(1, Ordering::AcqRel);
        }
        !stop.load(Ordering::Acquire) && state.visible
    }

    #[cfg(test)]
    pub(crate) fn parked_workers(&self) -> usize {
        self.parked_workers.load(Ordering::Acquire)
    }

    pub(crate) fn is_visible(&self) -> bool {
        self.state
            .lock()
            .expect("Android preview gate poisoned")
            .visible
    }

    fn emit_if_visible(&self, stop: &AtomicBool, emit: impl FnOnce()) -> bool {
        let state = self.state.lock().expect("Android preview gate poisoned");
        if !state.visible || stop.load(Ordering::Acquire) {
            return false;
        }
        emit();
        true
    }

    pub(crate) fn wait_for_visible_interval(&self, stop: &AtomicBool, duration: Duration) -> bool {
        let state = self.state.lock().expect("Android preview gate poisoned");
        if !state.visible || stop.load(Ordering::Acquire) {
            return false;
        }
        let (state, _) = self
            .changed
            .wait_timeout_while(state, duration, |state| {
                state.visible && !stop.load(Ordering::Acquire)
            })
            .expect("Android preview gate poisoned");
        !stop.load(Ordering::Acquire) && state.visible
    }

    pub(crate) fn notify(&self) {
        self.changed.notify_all();
    }
}

pub(crate) trait AndroidFrameSink: PreviewEventSink + Send + Sync {
    fn frame(&self, frame: AndroidEmulatorFrame) -> Result<(), String>;
    fn error(&self, error: AndroidEmulatorError);
    fn lifecycle(&self, stage: AndroidEmulatorStartupStage);
    fn session_ended(&self, event: AndroidEmulatorSessionEnded);
}

struct TauriFrameSink {
    app: AppHandle,
}

impl PreviewEventSink for TauriFrameSink {
    fn frame_ready(&self, event: FrameReady) -> Result<(), String> {
        self.app
            .emit(FRAME_READY_EVENT, event)
            .map_err(|error| error.to_string())
    }

    fn preview_state(&self, state: PreviewState) -> Result<(), String> {
        self.app
            .emit(PREVIEW_STATE_EVENT, state)
            .map_err(|error| error.to_string())
    }
}

impl AndroidFrameSink for TauriFrameSink {
    fn frame(&self, frame: AndroidEmulatorFrame) -> Result<(), String> {
        self.app
            .emit(FRAME_EVENT, frame)
            .map_err(|error| error.to_string())
    }

    fn error(&self, error: AndroidEmulatorError) {
        emit_error(&self.app, error);
    }

    fn lifecycle(&self, stage: AndroidEmulatorStartupStage) {
        emit_lifecycle(&self.app, stage);
    }

    fn session_ended(&self, event: AndroidEmulatorSessionEnded) {
        emit_session_ended(&self.app, event);
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
    pub(crate) recording: Arc<Mutex<Option<super::media::ActiveRecording>>>,
    pub(crate) workers: Mutex<Vec<JoinHandle<()>>>,
    pub(crate) emulator_pid: Option<u32>,
    pub(crate) gpu_software: bool,
    pub(crate) preview: Arc<PreviewRuntime>,
    pub(crate) first_preview: Arc<FirstPreviewGate>,
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

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct AndroidExitCleanupReport {
    pub(crate) errors: Vec<String>,
}

pub(crate) fn adb_path(sdk_path: &Path) -> PathBuf {
    sdk_path
        .join("platform-tools")
        .join(if cfg!(windows) { "adb.exe" } else { "adb" })
}

#[cfg(test)]
#[path = "session/tests.rs"]
mod tests;
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

    fn reject_if_exiting(&self) -> Result<(), String> {
        if self.exiting.load(Ordering::Acquire) {
            return Err("O Verboo está encerrando a simulação Android.".into());
        }
        Ok(())
    }

    pub(crate) fn begin_exit(&self) {
        self.exiting.store(true, Ordering::Release);
    }

    pub(crate) fn stop_for_app_exit(&self, deadline: Instant) -> AndroidExitCleanupReport {
        self.begin_exit();
        if self.exit_cleanup_started.swap(true, Ordering::AcqRel) {
            return AndroidExitCleanupReport::default();
        }

        let mut report = AndroidExitCleanupReport::default();
        self.request_session_cancel();
        let operation = match self.operation_lock_until(deadline) {
            Ok(operation) => operation,
            Err(error) => {
                report.errors.push(error);
                return report;
            }
        };
        let Some(session) = self.take_session() else {
            drop(operation);
            return report;
        };
        let avd_name = session.avd_name.clone();
        let ownership = session.ownership;
        if let Err(error) =
            self.cleanup_session_until(session, should_shutdown(ownership), Some(deadline))
        {
            report.errors.push(error);
        } else if should_shutdown(ownership) {
            if let Err(error) = self.ownership.remove(&avd_name) {
                report.errors.push(error);
            }
        }
        drop(operation);
        report
    }

    fn current_session_option(&self) -> Option<Arc<AndroidSession>> {
        self.state
            .lock()
            .expect("Android emulator state poisoned")
            .session
            .clone()
    }

    fn replacement_session(
        &self,
        current: &Arc<AndroidSession>,
        generation: u64,
        mode: PreviewMode,
        stream_fps: u16,
        fallback_fps: f64,
    ) -> Arc<AndroidSession> {
        Arc::new(AndroidSession {
            avd_name: current.avd_name.clone(),
            device: current.device.clone(),
            serial: current.serial.clone(),
            adb_path: current.adb_path.clone(),
            ownership: current.ownership,
            generation,
            stream_fps: Arc::new(Mutex::new(stream_fps)),
            fallback_fps: Arc::new(Mutex::new(fallback_fps)),
            gate: Arc::new(PreviewGate::new(
                self.desired_visibility.load(Ordering::Acquire),
            )),
            stop: Arc::new(AtomicBool::new(false)),
            input_lock: current.input_lock.clone(),
            dimensions: Arc::new(Mutex::new(None)),
            emulator_process: current.emulator_process.clone(),
            recording: current.recording.clone(),
            workers: Mutex::new(Vec::new()),
            emulator_pid: current.emulator_pid,
            gpu_software: current.gpu_software,
            preview: Arc::new(PreviewRuntime::new(mode, generation)),
            first_preview: Arc::new(FirstPreviewGate::new()),
        })
    }

    pub(crate) fn attach_sync(
        &self,
        app: AppHandle,
        avd_name: String,
        stream_fps: u16,
        fallback_fps: f64,
        preview_transport: Option<PreviewTransport>,
    ) -> Result<AndroidEmulatorSession, String> {
        let sink: Arc<dyn AndroidFrameSink> = Arc::new(TauriFrameSink { app: app.clone() });
        let launcher = SystemEmulatorLauncher;
        self.attach_sync_with_sink(
            Some(app),
            sink,
            &launcher,
            Arc::new(SystemPreviewFactoryProvider),
            Arc::new(SystemLegacyPreviewBackendFactory::new(self.clone())),
            avd_name,
            stream_fps,
            fallback_fps,
            preview_transport,
        )
    }

    fn validate_stream_fps_for_mode(mode: PreviewMode, fps: u16) -> Result<u16, String> {
        match mode {
            PreviewMode::LegacyPrimary => validate_stream_fps(fps),
            PreviewMode::Vaf1 | PreviewMode::LegacyFallback => {
                AndroidStreamFps::try_from(fps).map(AndroidStreamFps::get)
            }
        }
    }

    fn attach_sync_with_sink(
        &self,
        app: Option<AppHandle>,
        sink: Arc<dyn AndroidFrameSink>,
        launcher: &dyn EmulatorLauncher,
        preview_provider: Arc<dyn PreviewFactoryProvider>,
        legacy_factory: Arc<dyn LegacyPreviewBackendFactory>,
        avd_name: String,
        stream_fps: u16,
        fallback_fps: f64,
        preview_transport: Option<PreviewTransport>,
    ) -> Result<AndroidEmulatorSession, String> {
        let session_ticket = self.session_cancel.ticket();
        self.reject_if_exiting()?;
        let mode = PreviewMode::from_wire(preview_transport);
        let stream_fps = Self::validate_stream_fps_for_mode(mode, stream_fps)?;
        let fallback_fps = validate_fallback_fps(fallback_fps)?;
        let _operation = self
            .operation_lock
            .lock()
            .expect("Android emulator operation lock poisoned");
        self.reject_if_exiting()?;
        if !self.session_cancel.reset_if_unchanged(session_ticket) {
            return Err("Android emulator attach was cancelled".to_string());
        }
        #[cfg(test)]
        self.session_cancel.pause_after_reset();
        if let Some(app) = app {
            self.bind_app(app);
        }

        let current = { self.current_session_option() };
        #[cfg(test)]
        assert!(
            self.state.try_lock().is_ok(),
            "Android state guard crossed the same-AVD replacement boundary"
        );
        let mut reserved_generation = None;
        if let Some(current) = current {
            if current.avd_name == avd_name
                && current.preview.mode == mode
                && current
                    .preview
                    .is_operational(current.first_preview.as_ref())
            {
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
            if current.avd_name == avd_name {
                let generation = next_preview_generation(self.next_generation.as_ref())
                    .map_err(|_| "Android preview generation exhausted".to_string())?;
                let replacement =
                    self.replacement_session(&current, generation, mode, stream_fps, fallback_fps);
                if self.session_cancel.is_cancelled() {
                    return Err("Android emulator attach was cancelled".to_string());
                }
                self.stop_preview_workers(&current);
                if self
                    .session_cancel
                    .run_if_active(|| {
                        self.state
                            .lock()
                            .expect("Android emulator state poisoned")
                            .session = Some(replacement.clone());
                    })
                    .is_none()
                {
                    return Err("Android emulator attach was cancelled".to_string());
                }
                sink.lifecycle(AndroidEmulatorStartupStage::GeneratingFirstPreview);
                let start = start_preview_for_session(
                    self.runner.clone(),
                    replacement.clone(),
                    sink.clone(),
                    preview_provider,
                    legacy_factory,
                );
                finish_started_preview(sink.as_ref(), &replacement, start)
                    .map_err(|error| format!("Android emulator preview failed: {error}"))?;
                return Ok(replacement.summary());
            }
            let generation = next_preview_generation(self.next_generation.as_ref())
                .map_err(|_| "Android preview generation exhausted".to_string())?;
            if self.session_cancel.is_cancelled() {
                return Err("Android emulator attach was cancelled".to_string());
            }
            self.stop_current_locked(true)?;
            if self.session_cancel.is_cancelled() {
                return Err("Android emulator attach was cancelled".to_string());
            }
            reserved_generation = Some(generation);
        }

        let sdk_path = sdk::resolve_sdk_path(&self.app_data_dir);
        let available = sdk::list_avd_names(self.runner.as_ref(), &sdk_path);
        if !available.iter().any(|candidate| candidate == &avd_name) {
            return Err(format!("Android AVD is not available: {avd_name}"));
        }
        let ledger_avd_name = avd_name.clone();

        let adb_path = adb_path(&sdk_path);
        let adb = adb_path.to_string_lossy().into_owned();
        let generation = match reserved_generation {
            Some(generation) => generation,
            None => next_preview_generation(self.next_generation.as_ref())
                .map_err(|_| "Android preview generation exhausted".to_string())?,
        };
        sink.lifecycle(AndroidEmulatorStartupStage::Booting);

        let existing_serial = find_running_serial(
            self.runner.as_ref(),
            &adb,
            &avd_name,
            self.session_cancel.flag(),
            Instant::now() + ADB_COMMAND_TIMEOUT,
        );
        if self.session_cancel.is_cancelled() {
            return Err("Android emulator attach was cancelled".to_string());
        }
        let (ownership, boot_requested) =
            attach_ownership(&self.ownership, &avd_name, existing_serial.as_deref());
        sink.lifecycle(AndroidEmulatorStartupStage::WaitingForDisplay);
        let (serial, process, emulator_pid, gpu_software) = if boot_requested {
            let emulator = emulator_path(&sdk_path);
            let attempts =
                SystemOwnedBootAttempts::new(self.runner.clone(), launcher, emulator, adb.clone());
            let mut result = match boot_owned_with_attempts(
                self.ownership.as_ref(),
                &attempts,
                &avd_name,
                self.session_cancel.as_ref(),
            ) {
                Ok(result) => result,
                Err(OwnedBootError::Cancelled) => {
                    let error = "Android emulator boot cancelled".to_string();
                    sink.error(AndroidEmulatorError::from_message(error.clone()));
                    return Err(error);
                }
                Err(OwnedBootError::Failed(error)) => {
                    sink.error(AndroidEmulatorError::from_message(error.clone()));
                    return Err(error);
                }
            };
            result = match probe_owned_surface_flinger(
                self.runner.as_ref(),
                &attempts,
                self.ownership.as_ref(),
                &avd_name,
                &adb,
                result,
                self.session_cancel.flag(),
            ) {
                Ok(result) => result,
                Err(OwnedBootError::Cancelled) => {
                    let error = "Android emulator attach was cancelled".to_string();
                    sink.error(AndroidEmulatorError::from_message(error.clone()));
                    return Err(error);
                }
                Err(OwnedBootError::Failed(error)) => {
                    sink.error(AndroidEmulatorError::from_message(error.clone()));
                    return Err(error);
                }
            };
            if self.session_cancel.is_cancelled() {
                let _ = attempts.terminate(&result);
                let _ = self.ownership.remove(&avd_name);
                let error = "Android emulator attach was cancelled".to_string();
                sink.error(AndroidEmulatorError::from_message(error.clone()));
                return Err(error);
            }
            (
                result.serial,
                result.process,
                Some(result.pid),
                result.gpu_software,
            )
        } else {
            let process = Arc::new(Mutex::new(None));
            let serial = match wait_for_boot(
                self.runner.as_ref(),
                &adb,
                &avd_name,
                &process,
                self.session_cancel.flag(),
                Instant::now() + BOOT_TIMEOUT,
            ) {
                Ok(serial) => serial,
                Err(error) => {
                    sink.error(AndroidEmulatorError::from_message(error.clone()));
                    return Err(error);
                }
            };
            (serial, process, None, false)
        };

        if ownership == AndroidEmulatorOwnership::Verboo && !boot_requested {
            match self
                .session_cancel
                .run_if_active(|| self.ownership.mark_booted(&avd_name))
            {
                None => return Err("Android emulator attach was cancelled".to_string()),
                Some(result) => result?,
            }
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
            recording: Arc::new(Mutex::new(None)),
            workers: Mutex::new(Vec::new()),
            emulator_pid,
            gpu_software,
            preview: Arc::new(PreviewRuntime::new(mode, generation)),
            first_preview: Arc::new(FirstPreviewGate::new()),
        });
        #[cfg(test)]
        self.session_cancel.pause_before_publish();
        if self
            .session_cancel
            .run_if_active(|| {
                self.state
                    .lock()
                    .expect("Android emulator state poisoned")
                    .session = Some(session.clone());
            })
            .is_none()
        {
            let _ = self.cleanup_session(session.clone(), boot_requested);
            if boot_requested {
                let _ = self.ownership.remove(&ledger_avd_name);
            }
            return Err("Android emulator attach was cancelled".to_string());
        }
        sink.lifecycle(AndroidEmulatorStartupStage::GeneratingFirstPreview);
        let start = start_preview_for_session(
            self.runner.clone(),
            session.clone(),
            sink.clone(),
            preview_provider,
            legacy_factory,
        );
        if let Err(error) = finish_started_preview(sink.as_ref(), &session, start) {
            let _ = self.take_session();
            let _ = self.cleanup_session(session, true);
            if boot_requested {
                let _ = self.ownership.remove(&ledger_avd_name);
            }
            return Err(format!("Android emulator preview failed: {error}"));
        }
        Ok(session.summary())
    }

    pub(crate) fn read_frame_sync(&self, generation: u64) -> Result<Vec<u8>, PreviewReadError> {
        let state = self.state.lock().expect("Android emulator state poisoned");
        let session = state
            .session
            .as_ref()
            .ok_or(PreviewReadError::Unavailable)?;
        session.preview.slot.ensure_generation(generation)?;
        if session.preview.mode != PreviewMode::Vaf1 {
            return Err(PreviewReadError::Unsupported);
        }
        match session.preview.slot.take(generation) {
            Err(PreviewReadError::NoFrame) => match *session
                .preview
                .availability
                .lock()
                .expect("Android preview availability poisoned")
            {
                PreviewAvailability::Grpc => Err(PreviewReadError::NoFrame),
                PreviewAvailability::Unavailable => Err(PreviewReadError::Unavailable),
                PreviewAvailability::Unauthenticated => Err(PreviewReadError::Unauthenticated),
                PreviewAvailability::Unsupported => Err(PreviewReadError::Unsupported),
            },
            result => result,
        }
    }

    pub(crate) fn set_visible_sync(&self, visible: bool) -> Result<(), String> {
        self.desired_visibility.store(visible, Ordering::Release);
        if let Some(session) = self.current_session_option() {
            session.gate.set_visible(visible);
            session.preview.send_control(PreviewControl {
                visible,
                stop: false,
            });
            if !visible {
                session.preview.slot.clear();
            }
        }
        Ok(())
    }

    pub(crate) fn set_stream_rate_sync(&self, stream_fps: u16) -> Result<u16, String> {
        let session = self.current_session()?;
        let stream_fps = Self::validate_stream_fps_for_mode(session.preview.mode, stream_fps)?;
        *session
            .stream_fps
            .lock()
            .expect("Android stream rate poisoned") = stream_fps;
        session.gate.notify();
        session.gate.refresh_control();
        session.preview.send_control(PreviewControl {
            visible: session.gate.is_visible(),
            stop: false,
        });
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
        session.gate.refresh_control();
        session.preview.send_control(PreviewControl {
            visible: session.gate.is_visible(),
            stop: false,
        });
        Ok(fallback_fps)
    }

    fn request_session_cancel(&self) {
        self.session_cancel.cancel();
        if let Some(session) = self.current_session_option() {
            self.stop_preview_workers(&session);
        }
    }

    pub(crate) fn detach_sync(&self) -> Result<(), String> {
        self.detach_sync_until(Instant::now() + ANDROID_CLEANUP_BUDGET)
    }

    pub(crate) fn detach_sync_until(&self, deadline: Instant) -> Result<(), String> {
        self.request_session_cancel();
        let _operation = self.operation_lock_until(deadline)?;
        let session = self
            .take_session()
            .ok_or_else(|| "No Android emulator is attached.".to_string())?;
        self.cleanup_session_until(session, false, Some(deadline))
    }

    pub(crate) fn end_sync(&self) -> Result<(), String> {
        self.end_sync_until(Instant::now() + ANDROID_CLEANUP_BUDGET)
    }

    fn end_sync_until(&self, deadline: Instant) -> Result<(), String> {
        self.request_session_cancel();
        let _operation = self.operation_lock_until(deadline)?;
        let session = self
            .take_session()
            .ok_or_else(|| "No Android emulator is attached.".to_string())?;
        let avd_name = session.avd_name.clone();
        let ownership = session.ownership;
        self.cleanup_session_until(session, should_shutdown(ownership), Some(deadline))?;
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

    /// Device-death teardown: reuse detach/end cleanup. Revalidates
    /// generation under `operation_lock` before take so a completed
    /// re-attach is not torn down. Emits `android-emulator:session-ended`
    /// AFTER cleanup, only for the generation that actually died.
    pub(crate) fn teardown_lost_device(&self, generation: u64, sink: &dyn AndroidFrameSink) {
        let Some(session) = self.current_session_option() else {
            return;
        };
        if session.generation != generation {
            return;
        }
        #[cfg(test)]
        self.session_cancel.pause_after_lost_generation_check();

        let deadline = Instant::now() + ANDROID_CLEANUP_BUDGET;
        let Ok(_operation) = self.operation_lock_until(deadline) else {
            return;
        };
        let Some(session) = self.current_session_option() else {
            return;
        };
        if session.generation != generation {
            return;
        }
        let ownership = session.ownership;
        let avd_name = session.avd_name.clone();
        self.request_session_cancel();
        let Some(session) = self.take_session() else {
            return;
        };
        let cleaned =
            self.cleanup_session_until(session, should_shutdown(ownership), Some(deadline));
        if cleaned.is_ok() && should_shutdown(ownership) {
            let _ = self.ownership.remove(&avd_name);
        }
        if cleaned.is_ok() {
            sink.session_ended(AndroidEmulatorSessionEnded {
                generation,
                code: Some(PreviewReason::DeviceLost),
            });
        }
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

    fn stop_preview_workers(&self, session: &Arc<AndroidSession>) {
        session.gate.stop_and_wake(&session.stop);
        session.preview.send_control(PreviewControl {
            visible: false,
            stop: true,
        });
        session.preview.slot.clear();
        *session
            .preview
            .availability
            .lock()
            .expect("Android preview availability poisoned") = PreviewAvailability::Unavailable;
        session.first_preview.fail(FirstPreviewError::Cancelled);
        let workers = std::mem::take(
            &mut *session
                .workers
                .lock()
                .expect("Android emulator workers poisoned"),
        );
        for worker in workers {
            let _ = worker.join();
        }
        session
            .preview
            .health
            .terminal(FirstPreviewError::Cancelled);
    }

    fn cleanup_session(
        &self,
        session: Arc<AndroidSession>,
        terminate_owned: bool,
    ) -> Result<(), String> {
        self.cleanup_session_until(session, terminate_owned, None)
    }

    fn cleanup_session_until(
        &self,
        session: Arc<AndroidSession>,
        terminate_owned: bool,
        deadline: Option<Instant>,
    ) -> Result<(), String> {
        let recording_deadline =
            deadline.unwrap_or_else(|| Instant::now() + ANDROID_CLEANUP_BUDGET);
        self.stop_preview_workers(&session);
        let _ = self.finalize_recording_for_session(&session, recording_deadline);
        if terminate_owned && should_shutdown(session.ownership) {
            shutdown_owned_emulator(self.runner.as_ref(), &session, deadline)?;
        }
        Ok(())
    }

    fn operation_lock_until(&self, deadline: Instant) -> Result<MutexGuard<'_, ()>, String> {
        loop {
            match self.operation_lock.try_lock() {
                Ok(operation) => return Ok(operation),
                Err(std::sync::TryLockError::WouldBlock) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(std::sync::TryLockError::WouldBlock) => {
                    return Err(
                        "a operação do emulador Android não liberou o lock antes do encerramento"
                            .to_string(),
                    )
                }
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err("Android emulator operation lock poisoned".to_string())
                }
            }
        }
    }
}
