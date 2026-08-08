//! Read-only iOS Simulator panel backed by Apple's `simctl` command line tool
//! and, when available, WebDriverAgent's loopback MJPEG stream.
//!
//! The panel deliberately does not use Simulator.app, Device Hub, or any
//! macOS screen-capture API. The initial frame comes from `simctl`; WDA is
//! only used as an asynchronous, loopback-only video source after its runner
//! is ready.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

mod bridge;
mod capture_store;
mod lifecycle;
mod media;
mod ownership;
mod system_controls;
mod wda_client;

pub use self::bridge::IosSimulatorBridge;
pub use self::capture_store::IosSimulatorCaptureStore;
use self::capture_store::{NormalizedCaptureRect, PromotedSimulatorFile};
pub(crate) use self::lifecycle::PreviewGate;
use self::lifecycle::{wait_for_display_metrics, LifecycleAuthority, LifecycleSignal};
pub use self::lifecycle::{
    IosSimulatorLifecycleSnapshot, IosSimulatorRecordingState, IosSimulatorStartupStage,
};
pub use self::media::IosSimulatorMediaFile;
use self::media::{
    capture_screen, start_recording, stop_recording_until, ActiveRecording, SimulatorMediaBackend,
    SystemSimulatorMediaBackend,
};
pub use self::ownership::IosSimulatorOwnership;
use self::ownership::{complete_device_boot, prepare_device_for_attach, OwnershipLedger};
pub use self::system_controls::IosSimulatorSystemAction;
use self::system_controls::{next_clockwise_orientation, system_gesture, SystemGesture};
use self::wda_client::{
    IosSimulatorKey, StreamProfile, SystemWdaClient, WdaClient, WdaControlHandle,
    WdaInterfaceOrientation, WdaPoint, WdaWindowSize,
};

pub const FRAME_EVENT: &str = "ios-simulator:frame";
pub const ERROR_EVENT: &str = "ios-simulator:error";
pub const PRESENCE_EVENT: &str = "ios-simulator:presence";
pub const OPEN_REQUESTED_EVENT: &str = "ios-simulator:open-requested";
pub const LIFECYCLE_EVENT: &str = "ios-simulator:lifecycle";
pub const DEFAULT_FALLBACK_FPS: f64 = 2.0;
const MIN_FALLBACK_FPS: f64 = 0.5;
const MAX_FALLBACK_FPS: f64 = 2.0;
// Existing lifecycle tests use this concise alias.
#[cfg(test)]
const MAX_FPS: f64 = MAX_FALLBACK_FPS;
const WDA_READY_TIMEOUT: Duration = Duration::from_secs(45);
const WDA_SIGINT_GRACE_PERIOD: Duration = Duration::from_secs(5);
const WDA_SIGTERM_GRACE_PERIOD: Duration = Duration::from_secs(2);
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(5);
const FIRST_FRAME_RETRY: Duration = Duration::from_millis(100);
const MJPEG_CONNECT_RETRY: Duration = Duration::from_millis(50);
const MJPEG_READ_TIMEOUT: Duration = Duration::from_millis(50);
const MAX_MJPEG_BUFFER: usize = 8 * 1024 * 1024;
const WDA_STAGING_RELATIVE_ROOT: &str = "cache/ios-simulator/wda";
const WDA_PROJECT_DIRECTORY: &str = "project/WebDriverAgent.xcodeproj";
const WDA_PROJECT_ROOT_DIRECTORY: &str = "project";
const WDA_DERIVED_DATA_DIRECTORY: &str = "derived-data";
const WDA_SOURCE_DIGEST_FILE: &str = ".source-sha256";
const WDA_PROJECT_TEMP_DIRECTORY: &str = ".project-staging";
const WDA_LOOPBACK_SOURCE_FILE: &str = "WebDriverAgentLib/Routing/FBTCPSocket.m";
const WDA_UNSAFE_BIND_CALL: &str = "acceptOnPort:self.port error:error";
const WDA_LOOPBACK_BIND_CALL: &str = "acceptOnInterface:@\"127.0.0.1\" port:self.port error:error";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IosSimulatorIssue {
    UnsupportedPlatform,
    XcodeMissing,
    UnsupportedXcode,
    SimctlMissing,
    SimulatorsMissing,
    DiscoveryFailed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IosSimulatorDeviceFamily {
    Iphone,
    Ipad,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IosSimulatorDevice {
    pub name: String,
    pub udid: String,
    pub state: String,
    pub ios_version: String,
    pub family: IosSimulatorDeviceFamily,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IosSimulatorRequirements {
    pub ready: bool,
    pub issue: Option<IosSimulatorIssue>,
    pub xcode_version: Option<String>,
    pub devices: Vec<IosSimulatorDevice>,
    pub attached_udid: Option<String>,
    pub stream_fps: Option<u16>,
    pub fallback_fps: Option<f64>,
    pub source: Option<IosSimulatorStreamSource>,
    pub effective_fps: Option<f64>,
    pub lifecycle: IosSimulatorLifecycleSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IosSimulatorSession {
    pub device: IosSimulatorDevice,
    pub device_generation: u64,
    pub ownership: IosSimulatorOwnership,
    pub stream_fps: u16,
    pub fallback_fps: f64,
    pub source: IosSimulatorStreamSource,
    pub effective_fps: Option<f64>,
    pub lifecycle: IosSimulatorLifecycleSnapshot,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IosSimulatorStreamSource {
    Simctl,
    Mjpeg,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IosSimulatorFrame {
    pub udid: String,
    pub data_url: String,
    pub device_generation: u64,
    pub frame_generation: u64,
    pub captured_at_ms: u64,
    pub source: IosSimulatorStreamSource,
    pub effective_fps: Option<f64>,
    pub agent_presence: Option<IosSimulatorPresenceEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IosSimulatorError {
    pub udid: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IosSimulatorPresencePhase {
    Start,
    Clear,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IosSimulatorPresenceAction {
    Tap,
    Drag,
    TypeText,
    PressKey,
    Inspect,
    Screenshot,
    Attach,
    Detach,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IosSimulatorPresenceEvent {
    pub generation: u64,
    pub phase: IosSimulatorPresencePhase,
    pub action: Option<IosSimulatorPresenceAction>,
    pub target: Option<NormalizedPoint>,
    pub start: Option<NormalizedPoint>,
    pub end: Option<NormalizedPoint>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IosSimulatorDeviceRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IosSimulatorAccessibilityNode {
    pub id: String,
    pub role: String,
    pub label: Option<String>,
    pub value: Option<String>,
    pub frame: IosSimulatorDeviceRect,
    pub enabled: bool,
    pub visible: bool,
    pub actionable: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IosSimulatorOrientation {
    Portrait,
    Landscape,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IosSimulatorAnnotationCapture {
    pub crop_path: String,
    pub viewport_path: String,
    pub crop_width: u32,
    pub crop_height: u32,
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub crop_bytes: usize,
    pub viewport_bytes: usize,
    pub device: IosSimulatorDevice,
    pub orientation: IosSimulatorOrientation,
    pub device_generation: u64,
    pub frame_generation: u64,
    pub rect: NormalizedRect,
    pub device_rect: IosSimulatorDeviceRect,
    pub element: Option<IosSimulatorAccessibilityNode>,
}

#[derive(Debug, Clone)]
struct CommandOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

trait CommandRunner: Send + Sync {
    fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, String>;

    fn run_interruptible(
        &self,
        program: &str,
        args: &[String],
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> Result<CommandOutput, String> {
        if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
            return Err("operação do simulador cancelada".to_string());
        }
        self.run(program, args)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WdaStagedPaths {
    project: PathBuf,
    derived_data: PathBuf,
}

#[derive(Debug, Clone)]
struct WdaLaunchSpec {
    project: PathBuf,
    derived_data: PathBuf,
    destination_udid: String,
    http_port: u16,
    mjpeg_port: u16,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct SimctlDisplayMetrics {
    window_size: WdaWindowSize,
    interface_orientation: WdaInterfaceOrientation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SimulatorDisplayErrorKind {
    IntegratedDisplayUnavailable,
    AmbiguousOrientation,
    InvalidDisplayMetrics,
    CommandFailed,
}

impl SimulatorDisplayErrorKind {
    pub(crate) fn is_retryable(self) -> bool {
        matches!(
            self,
            Self::IntegratedDisplayUnavailable | Self::AmbiguousOrientation
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SimulatorDisplayError {
    pub(crate) kind: SimulatorDisplayErrorKind,
    pub(crate) message: String,
}

trait WdaProcess: Send {
    fn try_wait(&mut self) -> Result<Option<ExitStatus>, String>;
    fn stop(&mut self);
}

type WdaForceStop = Arc<dyn Fn() + Send + Sync>;
type LifecycleEmitter = Arc<dyn Fn() + Send + Sync>;

struct WdaProcessHandle {
    process: Box<dyn WdaProcess>,
}

trait WdaLauncher: Send + Sync {
    fn launch(
        &self,
        spec: &WdaLaunchSpec,
        stop: &AtomicBool,
        force_stop_slot: &Mutex<Option<WdaForceStop>>,
    ) -> Result<WdaProcessHandle, String>;
}

#[cfg(test)]
struct NoopWdaLauncher;

#[cfg(test)]
impl WdaLauncher for NoopWdaLauncher {
    fn launch(
        &self,
        _spec: &WdaLaunchSpec,
        _stop: &AtomicBool,
        _force_stop_slot: &Mutex<Option<WdaForceStop>>,
    ) -> Result<WdaProcessHandle, String> {
        Err("WDA não está habilitado neste ambiente de teste.".to_string())
    }
}

#[cfg(test)]
struct NoopWdaClient;

#[cfg(test)]
impl WdaClient for NoopWdaClient {
    fn wait_until_ready(&self, _base_url: &str, _deadline: Instant) -> Result<(), String> {
        Err("WDA não está habilitado neste ambiente de teste.".to_string())
    }

    fn apply_stream_settings(
        &self,
        _control: &WdaControlHandle,
        _profile: StreamProfile,
    ) -> Result<(), String> {
        Err("WDA não está habilitado neste ambiente de teste.".to_string())
    }

    fn tap(&self, _control: &WdaControlHandle, _point: WdaPoint) -> Result<(), String> {
        Err("WDA não está habilitado neste ambiente de teste.".to_string())
    }

    fn drag(
        &self,
        _control: &WdaControlHandle,
        _from: WdaPoint,
        _to: WdaPoint,
        _duration: Duration,
    ) -> Result<(), String> {
        Err("WDA não está habilitado neste ambiente de teste.".to_string())
    }

    fn type_text(&self, _control: &WdaControlHandle, _text: &str) -> Result<(), String> {
        Err("WDA não está habilitado neste ambiente de teste.".to_string())
    }

    fn press_key(&self, _control: &WdaControlHandle, _key: IosSimulatorKey) -> Result<(), String> {
        Err("WDA não está habilitado neste ambiente de teste.".to_string())
    }

    fn home(&self, _control: &WdaControlHandle) -> Result<(), String> {
        Err("WDA não está habilitado neste ambiente de teste.".to_string())
    }

    fn system_gesture(
        &self,
        _control: &WdaControlHandle,
        _gesture: SystemGesture,
    ) -> Result<(), String> {
        Err("WDA não está habilitado neste ambiente de teste.".to_string())
    }

    fn rotate(
        &self,
        _control: &WdaControlHandle,
        _orientation: WdaInterfaceOrientation,
    ) -> Result<(), String> {
        Err("WDA não está habilitado neste ambiente de teste.".to_string())
    }
}

#[cfg(test)]
struct OkWdaClient;

#[cfg(test)]
impl WdaClient for OkWdaClient {
    fn wait_until_ready(&self, _base_url: &str, _deadline: Instant) -> Result<(), String> {
        Ok(())
    }

    fn apply_stream_settings(
        &self,
        _control: &WdaControlHandle,
        _profile: StreamProfile,
    ) -> Result<(), String> {
        Ok(())
    }

    fn tap(&self, _control: &WdaControlHandle, _point: WdaPoint) -> Result<(), String> {
        Ok(())
    }

    fn drag(
        &self,
        _control: &WdaControlHandle,
        _from: WdaPoint,
        _to: WdaPoint,
        _duration: Duration,
    ) -> Result<(), String> {
        Ok(())
    }

    fn type_text(&self, _control: &WdaControlHandle, _text: &str) -> Result<(), String> {
        Ok(())
    }

    fn press_key(
        &self,
        _control: &WdaControlHandle,
        _key: IosSimulatorKey,
    ) -> Result<(), String> {
        Ok(())
    }

    fn home(&self, _control: &WdaControlHandle) -> Result<(), String> {
        Ok(())
    }

    fn system_gesture(
        &self,
        _control: &WdaControlHandle,
        _gesture: SystemGesture,
    ) -> Result<(), String> {
        Ok(())
    }

    fn rotate(
        &self,
        _control: &WdaControlHandle,
        _orientation: WdaInterfaceOrientation,
    ) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Debug, Default)]
struct SystemCommandRunner;

impl CommandRunner for SystemCommandRunner {
    fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, String> {
        let mut command = Command::new(program);
        command.args(args);
        crate::services::cli_spawn::apply_creation_flags(&mut command);
        // The app build recipe may export DEVELOPER_DIR to the Command Line
        // Tools. Runtime simulator support must follow the user's active
        // xcode-select instead, so never inherit that variable here.
        let output = command
            .env_remove("DEVELOPER_DIR")
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
        command
            .env_remove("DEVELOPER_DIR")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_process_group(&mut command);
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        loop {
            if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
                interrupt_process_until(&mut child, deadline);
                return Err("operação do simulador cancelada".to_string());
            }
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => thread::sleep(Duration::from_millis(25)),
                Err(error) => {
                    interrupt_process_until(&mut child, deadline);
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

struct SystemWdaLauncher {
    runner: Arc<dyn CommandRunner>,
}

impl SystemWdaLauncher {
    fn new(runner: Arc<dyn CommandRunner>) -> Self {
        Self { runner }
    }
}

impl WdaLauncher for SystemWdaLauncher {
    fn launch(
        &self,
        spec: &WdaLaunchSpec,
        stop: &AtomicBool,
        force_stop_slot: &Mutex<Option<WdaForceStop>>,
    ) -> Result<WdaProcessHandle, String> {
        let xcodebuild = resolve_runtime_tool(self.runner.as_ref(), "xcodebuild")?;
        if stop.load(Ordering::Acquire) {
            return Err("inicialização do WDA cancelada".to_string());
        }
        let mut command = Command::new(xcodebuild);
        crate::services::cli_spawn::apply_creation_flags(&mut command);
        command.args(wda_command_args(spec));
        command
            .env_remove("DEVELOPER_DIR")
            .env("USE_IP", "127.0.0.1")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_process_group(&mut command);
        // Serialize the final cancellation check, process spawn and force-stop
        // publication. App shutdown can therefore never miss a runner that
        // was spawned concurrently with its cleanup deadline.
        let mut published_force_stop = force_stop_slot
            .lock()
            .expect("iOS simulator WDA control poisoned");
        if stop.load(Ordering::Acquire) {
            return Err("inicialização do WDA cancelada".to_string());
        }
        let child = command
            .spawn()
            .map_err(|error| format!("não foi possível iniciar o WDA: {error}"))?;
        let pid = child.id();
        let force_stop: WdaForceStop = Arc::new(move || force_terminate_process_group(pid));
        *published_force_stop = Some(force_stop.clone());
        Ok(WdaProcessHandle {
            process: Box::new(ChildWdaProcess { child }),
        })
    }
}

struct ChildWdaProcess {
    child: Child,
}

impl WdaProcess for ChildWdaProcess {
    fn try_wait(&mut self) -> Result<Option<ExitStatus>, String> {
        self.child.try_wait().map_err(|error| error.to_string())
    }

    fn stop(&mut self) {
        terminate_process_group(&mut self.child);
    }
}

fn resolve_runtime_tool(runner: &dyn CommandRunner, tool: &str) -> Result<String, String> {
    let output = runner.run("xcrun", &["--find".into(), tool.into()])?;
    if !output.success {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            format!("o xcrun não encontrou {tool}")
        } else {
            message
        });
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        Err(format!("o xcrun não retornou o caminho de {tool}"))
    } else {
        Ok(path)
    }
}

fn build_wda_launch_spec(
    staged_wda: WdaStagedPaths,
    destination_udid: &str,
    http_port: u16,
    mjpeg_port: u16,
) -> WdaLaunchSpec {
    WdaLaunchSpec {
        project: staged_wda.project,
        derived_data: staged_wda.derived_data,
        destination_udid: destination_udid.to_string(),
        http_port,
        mjpeg_port,
    }
}

fn wda_command_args(spec: &WdaLaunchSpec) -> Vec<String> {
    vec![
        "-project".into(),
        spec.project.to_string_lossy().into_owned(),
        "-derivedDataPath".into(),
        spec.derived_data.to_string_lossy().into_owned(),
        "-scheme".into(),
        "WebDriverAgentRunner".into(),
        "-destination".into(),
        format!("platform=iOS Simulator,id={}", spec.destination_udid),
        "-collect-test-diagnostics".into(),
        "never".into(),
        "test".into(),
        "CODE_SIGN_IDENTITY=".into(),
        "CODE_SIGNING_REQUIRED=NO".into(),
        "CODE_SIGNING_ALLOWED=NO".into(),
        "USE_IP=127.0.0.1".into(),
        format!("USE_PORT={}", spec.http_port),
        format!("MJPEG_SERVER_PORT={}", spec.mjpeg_port),
    ]
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    // xcodebuild starts xctest/XCTRunner children. Put the complete WDA
    // tree in its own process group so detach can reap all of it.
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_process_group(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    let pid = child.id() as libc::pid_t;
    // xcodebuild treats SIGINT like the user's Ctrl-C and tears down the XCTest
    // automation session cleanly. Starting with SIGTERM can leave the app under
    // test racing XCTAutomationSupport teardown and crashing inside the
    // simulator. Escalation remains bounded for a genuinely stuck runner.
    unsafe {
        let _ = libc::kill(-pid, libc::SIGINT);
    }
    if wait_for_process_exit(child, WDA_SIGINT_GRACE_PERIOD) {
        return;
    }
    unsafe {
        let _ = libc::kill(-pid, libc::SIGTERM);
    }
    if wait_for_process_exit(child, WDA_SIGTERM_GRACE_PERIOD) {
        return;
    }
    unsafe {
        let _ = libc::kill(-pid, libc::SIGKILL);
    }
    let _ = child.wait();
}

#[cfg(unix)]
fn wait_for_process_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) | Err(_) => return false,
        }
    }
}

#[cfg(unix)]
fn interrupt_process_until(child: &mut Child, deadline: Instant) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    let pid = child.id() as libc::pid_t;
    let now = Instant::now();
    if now < deadline {
        unsafe {
            let _ = libc::kill(-pid, libc::SIGINT);
        }
        if wait_for_process_exit_until(child, deadline) {
            return;
        }
        unsafe {
            let _ = libc::kill(-pid, libc::SIGTERM);
        }
        if wait_for_process_exit_until(child, deadline) {
            return;
        }
    }
    unsafe {
        let _ = libc::kill(-pid, libc::SIGKILL);
    }
    let _ = child.wait();
}

#[cfg(unix)]
fn wait_for_process_exit_until(child: &mut Child, deadline: Instant) -> bool {
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) | Err(_) => return false,
        }
    }
}

#[cfg(not(unix))]
fn interrupt_process_until(child: &mut Child, _deadline: Instant) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(unix)]
fn force_terminate_process_group(pid: u32) {
    unsafe {
        let _ = libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn force_terminate_process_group(_pid: u32) {}

#[cfg(not(unix))]
fn terminate_process_group(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

trait FrameSink: Send + Sync {
    fn frame(&self, frame: IosSimulatorFrame);
    fn error(&self, error: IosSimulatorError);
}

struct TauriFrameSink {
    app: AppHandle,
    presence_snapshot: Arc<Mutex<Option<IosSimulatorPresenceEvent>>>,
}

impl FrameSink for TauriFrameSink {
    fn frame(&self, mut frame: IosSimulatorFrame) {
        frame.agent_presence = self
            .presence_snapshot
            .lock()
            .expect("iOS simulator presence snapshot poisoned")
            .clone();
        let _ = self.app.emit(FRAME_EVENT, frame);
    }

    fn error(&self, error: IosSimulatorError) {
        let _ = self.app.emit(ERROR_EVENT, error);
    }
}

#[derive(Debug, Clone, Copy)]
struct StreamStats {
    source: IosSimulatorStreamSource,
    effective_fps: Option<f64>,
}

#[derive(Clone)]
struct LatestFrame {
    device_generation: u64,
    frame_generation: u64,
    bytes: Vec<u8>,
    media_type: &'static str,
}

struct FrameRateMeter {
    previous: Option<Instant>,
    smoothed_fps: Option<f64>,
}

impl FrameRateMeter {
    fn observe(&mut self) -> Option<f64> {
        self.observe_at(Instant::now())
    }

    fn observe_at(&mut self, now: Instant) -> Option<f64> {
        let Some(previous) = self.previous.replace(now) else {
            return self.smoothed_fps;
        };
        let elapsed = now.duration_since(previous).as_secs_f64();
        if elapsed <= 0.0 {
            return self.smoothed_fps;
        }
        let current = 1.0 / elapsed;
        self.smoothed_fps = Some(match self.smoothed_fps {
            Some(previous) => previous * 0.7 + current * 0.3,
            None => current,
        });
        self.smoothed_fps
    }

    fn reset(&mut self) {
        self.previous = None;
        self.smoothed_fps = None;
    }
}

fn switch_meter_source(
    meter: &mut FrameRateMeter,
    current_source: &mut Option<IosSimulatorStreamSource>,
    next_source: IosSimulatorStreamSource,
) {
    if *current_source != Some(next_source) {
        meter.reset();
        *current_source = Some(next_source);
    }
}

impl Default for FrameRateMeter {
    fn default() -> Self {
        Self {
            previous: None,
            smoothed_fps: None,
        }
    }
}

struct Session {
    device: IosSimulatorDevice,
    device_generation: u64,
    ownership: IosSimulatorOwnership,
    fallback_fps: Arc<Mutex<f64>>,
    stream_profile: Arc<Mutex<StreamProfile>>,
    stats: Arc<Mutex<StreamStats>>,
    stop: Arc<AtomicBool>,
    input_lock: Arc<Mutex<()>>,
    latest_frame: Arc<Mutex<Option<LatestFrame>>>,
    gate: Arc<PreviewGate>,
    mjpeg_active: Arc<AtomicBool>,
    next_frame_generation: Arc<AtomicU64>,
    wda_control: Arc<Mutex<Option<WdaControlHandle>>>,
    wda_force_stop: Arc<Mutex<Option<WdaForceStop>>>,
    staged_wda: Option<WdaStagedPaths>,
    sink: Option<Arc<dyn FrameSink>>,
    recording: Arc<Mutex<Option<ActiveRecording>>>,
    workers: Mutex<Vec<JoinHandle<()>>>,
}

#[derive(Default)]
struct PresenceAuthority {
    next_generation: AtomicU64,
    current: Mutex<Option<u64>>,
}

impl PresenceAuthority {
    fn begin(&self) -> u64 {
        let generation = self
            .next_generation
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1);
        *self
            .current
            .lock()
            .expect("iOS simulator presence poisoned") = Some(generation);
        generation
    }

    fn complete(&self, generation: u64) -> bool {
        let mut current = self
            .current
            .lock()
            .expect("iOS simulator presence poisoned");
        if *current != Some(generation) {
            return false;
        }
        *current = None;
        true
    }

    fn clear(&self) -> Option<u64> {
        self.current
            .lock()
            .expect("iOS simulator presence poisoned")
            .take()
    }

    #[cfg(test)]
    fn current_generation(&self) -> Option<u64> {
        *self.current.lock().unwrap()
    }
}

#[derive(Default)]
struct ServiceState {
    session: Option<Session>,
}

/// Service state is cloneable so async Tauri commands can move only the
/// owned state and command runner into a blocking task.
#[derive(Clone)]
pub struct IosSimulatorService {
    state: Arc<Mutex<ServiceState>>,
    runner: Arc<dyn CommandRunner>,
    ownership: Arc<OwnershipLedger>,
    lifecycle: Arc<LifecycleAuthority>,
    desired_visibility: Arc<AtomicBool>,
    operation_lock: Arc<Mutex<()>>,
    exiting: Arc<AtomicBool>,
    exit_cleanup_started: Arc<AtomicBool>,
    wda_launcher: Arc<dyn WdaLauncher>,
    wda_client: Arc<dyn WdaClient>,
    next_device_generation: Arc<AtomicU64>,
    presence: Arc<PresenceAuthority>,
    presence_snapshot: Arc<Mutex<Option<IosSimulatorPresenceEvent>>>,
    app: Arc<Mutex<Option<AppHandle>>>,
    media_backend: Arc<dyn SimulatorMediaBackend>,
    emitted_outputs: Arc<Mutex<HashSet<PathBuf>>>,
    #[cfg(test)]
    lifecycle_emissions: Arc<Mutex<Vec<IosSimulatorLifecycleSnapshot>>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ExitCleanupReport {
    pub shutdown_udids: Vec<String>,
    pub errors: Vec<String>,
}

impl Default for IosSimulatorService {
    fn default() -> Self {
        let runner: Arc<dyn CommandRunner> = Arc::new(SystemCommandRunner);
        Self {
            state: Arc::new(Mutex::new(ServiceState::default())),
            wda_launcher: Arc::new(SystemWdaLauncher::new(runner.clone())),
            wda_client: Arc::new(SystemWdaClient::default()),
            ownership: Arc::new(OwnershipLedger::in_memory()),
            lifecycle: Arc::new(LifecycleAuthority::default()),
            desired_visibility: Arc::new(AtomicBool::new(true)),
            operation_lock: Arc::new(Mutex::new(())),
            exiting: Arc::new(AtomicBool::new(false)),
            exit_cleanup_started: Arc::new(AtomicBool::new(false)),
            next_device_generation: Arc::new(AtomicU64::new(0)),
            presence: Arc::new(PresenceAuthority::default()),
            presence_snapshot: Arc::new(Mutex::new(None)),
            app: Arc::new(Mutex::new(None)),
            media_backend: Arc::new(SystemSimulatorMediaBackend),
            emitted_outputs: Arc::new(Mutex::new(HashSet::new())),
            #[cfg(test)]
            lifecycle_emissions: Arc::new(Mutex::new(Vec::new())),
            runner,
        }
    }
}

impl IosSimulatorService {
    pub(crate) fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        let runner: Arc<dyn CommandRunner> = Arc::new(SystemCommandRunner);
        Ok(Self {
            state: Arc::new(Mutex::new(ServiceState::default())),
            runner: runner.clone(),
            ownership: Arc::new(OwnershipLedger::open(app_data_dir)?),
            lifecycle: Arc::new(LifecycleAuthority::default()),
            desired_visibility: Arc::new(AtomicBool::new(true)),
            operation_lock: Arc::new(Mutex::new(())),
            exiting: Arc::new(AtomicBool::new(false)),
            exit_cleanup_started: Arc::new(AtomicBool::new(false)),
            wda_launcher: Arc::new(SystemWdaLauncher::new(runner)),
            wda_client: Arc::new(SystemWdaClient::default()),
            next_device_generation: Arc::new(AtomicU64::new(0)),
            presence: Arc::new(PresenceAuthority::default()),
            presence_snapshot: Arc::new(Mutex::new(None)),
            app: Arc::new(Mutex::new(None)),
            media_backend: Arc::new(SystemSimulatorMediaBackend),
            emitted_outputs: Arc::new(Mutex::new(HashSet::new())),
            #[cfg(test)]
            lifecycle_emissions: Arc::new(Mutex::new(Vec::new())),
        })
    }

    pub(crate) fn bind_app(&self, app: AppHandle) {
        *self.app.lock().expect("iOS simulator app handle poisoned") = Some(app);
    }

    pub(crate) fn reconcile_owned_devices(&self) -> Result<Vec<String>, String> {
        self.reject_if_exiting()?;
        if !cfg!(target_os = "macos") {
            return Ok(Vec::new());
        }
        let requirements = detect_requirements(self.runner.as_ref());
        if let Some(issue) = requirements.issue {
            let owned_udids = self.ownership.owned_udids();
            if !owned_udids.is_empty() {
                eprintln!(
                    "[verboo:ios-simulator] reconciliação adiada: {}; ledger preservado para a próxima oportunidade: {:?}",
                    issue_message(&issue, requirements.xcode_version.as_deref()),
                    owned_udids,
                );
            }
            return Ok(Vec::new());
        }
        let states = requirements
            .devices
            .into_iter()
            .map(|device| (device.udid, device.state))
            .collect::<HashMap<_, _>>();
        let mut shutdown = Vec::new();
        for udid in self.ownership.owned_udids() {
            match states.get(&udid).map(String::as_str) {
                Some("Shutdown") => {
                    if let Err(error) = self.ownership.remove(&udid) {
                        eprintln!(
                            "[verboo:ios-simulator] simulador {udid} já está desligado, mas o ledger não pôde ser atualizado; registro preservado: {error}"
                        );
                    }
                }
                Some(_) => {
                    match run_simctl(self.runner.as_ref(), &["shutdown".into(), udid.clone()]) {
                        Ok(_) => {
                            if let Err(error) = self.ownership.remove(&udid) {
                                eprintln!(
                                    "[verboo:ios-simulator] simulador {udid} foi desligado, mas o ledger não pôde ser atualizado; registro preservado: {error}"
                                );
                            } else {
                                shutdown.push(udid);
                            }
                        }
                        Err(error) => {
                            eprintln!(
                                "[verboo:ios-simulator] não foi possível desligar {udid}; ledger preservado para a próxima oportunidade: {error}"
                            );
                        }
                    }
                }
                None => eprintln!(
                    "[verboo:ios-simulator] não foi possível confirmar o estado de {udid}; ledger preservado para a próxima oportunidade"
                ),
            }
        }
        Ok(shutdown)
    }

    pub(crate) fn request_agent_panel_open(&self) {
        if self.exiting.load(Ordering::Acquire) {
            return;
        }
        let _ = self.set_visible_sync(true);
        if let Some(app) = self
            .app
            .lock()
            .expect("iOS simulator app handle poisoned")
            .clone()
        {
            let _ = app.emit(OPEN_REQUESTED_EVENT, ());
        }
    }

    pub(crate) fn current_session_summary(&self) -> Option<IosSimulatorSession> {
        let state = self.state.lock().expect("iOS simulator state poisoned");
        let session = state.session.as_ref()?;
        let stats = *session.stats.lock().expect("iOS simulator stats poisoned");
        let stream_fps = session
            .stream_profile
            .lock()
            .expect("iOS simulator stream profile poisoned")
            .fps();
        let fallback_fps = *session
            .fallback_fps
            .lock()
            .expect("iOS simulator fallback rate poisoned");
        Some(IosSimulatorSession {
            device: session.device.clone(),
            device_generation: session.device_generation,
            ownership: session.ownership,
            stream_fps,
            fallback_fps,
            source: stats.source,
            effective_fps: stats.effective_fps,
            lifecycle: self.lifecycle.snapshot(),
        })
    }

    fn emit_lifecycle_snapshot(&self) {
        let snapshot = self.lifecycle.snapshot();
        #[cfg(test)]
        self.lifecycle_emissions
            .lock()
            .expect("iOS simulator lifecycle emissions poisoned")
            .push(snapshot.clone());
        if let Some(app) = self
            .app
            .lock()
            .expect("iOS simulator app handle poisoned")
            .clone()
        {
            let _ = app.emit(LIFECYCLE_EVENT, snapshot);
        }
    }

    #[cfg(test)]
    fn emitted_lifecycle_snapshots(&self) -> Vec<IosSimulatorLifecycleSnapshot> {
        self.lifecycle_emissions
            .lock()
            .expect("iOS simulator lifecycle emissions poisoned")
            .clone()
    }

    fn lifecycle_emitter(&self) -> LifecycleEmitter {
        let app = self.app.clone();
        let lifecycle = self.lifecycle.clone();
        Arc::new(move || {
            if let Some(app) = app
                .lock()
                .expect("iOS simulator app handle poisoned")
                .clone()
            {
                let _ = app.emit(LIFECYCLE_EVENT, lifecycle.snapshot());
            }
        })
    }

    pub(crate) fn set_visible_sync(&self, visible: bool) -> Result<(), String> {
        self.reject_if_exiting()?;
        self.desired_visibility.store(visible, Ordering::Release);
        let gate = self
            .state
            .lock()
            .expect("iOS simulator state poisoned")
            .session
            .as_ref()
            .map(|session| session.gate.clone());
        if let Some(gate) = gate {
            gate.set_visible(visible);
        }
        if let Some(generation) = self.lifecycle.snapshot().device_generation {
            if self
                .lifecycle
                .transition(generation, LifecycleSignal::PreviewSuspended(!visible))
            {
                self.emit_lifecycle_snapshot();
            }
        }
        Ok(())
    }

    fn current_identity(&self) -> Result<(String, IosSimulatorOwnership), String> {
        let state = self.state.lock().expect("iOS simulator state poisoned");
        let session = state
            .session
            .as_ref()
            .ok_or_else(|| "Nenhum simulador está anexado.".to_string())?;
        Ok((session.device.udid.clone(), session.ownership))
    }

    pub(crate) fn detach_external_sync(&self) -> Result<(), String> {
        self.reject_if_exiting()?;
        let _operation = self
            .operation_lock
            .lock()
            .expect("iOS simulator operation lock poisoned");
        self.reject_if_exiting()?;
        let (_, ownership) = self.current_identity()?;
        if ownership != IosSimulatorOwnership::External {
            return Err("Use Encerrar simulação para um dispositivo iniciado pelo Verboo.".into());
        }
        self.stop_session(None);
        Ok(())
    }

    pub(crate) fn end_owned_sync(&self) -> Result<(), String> {
        self.reject_if_exiting()?;
        let _operation = self
            .operation_lock
            .lock()
            .expect("iOS simulator operation lock poisoned");
        self.reject_if_exiting()?;
        let (udid, ownership) = self.current_identity()?;
        if ownership != IosSimulatorOwnership::Verboo {
            return Err(
                "Este simulador foi iniciado fora do Verboo e só pode ser desanexado.".into(),
            );
        }
        self.stop_session(None);
        run_simctl(self.runner.as_ref(), &["shutdown".into(), udid.clone()])?;
        self.ownership.remove(&udid)
    }

    pub(crate) fn switch_cleanup(&self) -> Result<(), String> {
        self.reject_if_exiting()?;
        let (udid, ownership) = self.current_identity()?;
        self.stop_session(None);
        if ownership == IosSimulatorOwnership::Verboo {
            run_simctl(self.runner.as_ref(), &["shutdown".into(), udid.clone()])?;
            self.ownership.remove(&udid)?;
        }
        Ok(())
    }

    pub(crate) fn retry_interaction_sync(&self) -> Result<IosSimulatorLifecycleSnapshot, String> {
        self.reject_if_exiting()?;
        let _operation = self
            .operation_lock
            .lock()
            .expect("iOS simulator operation lock poisoned");
        self.reject_if_exiting()?;
        let (
            device,
            generation,
            stop,
            gate,
            stream_profile,
            mjpeg_active,
            stats,
            latest_frame,
            next_frame_generation,
            wda_force_stop,
            wda_control,
            staged_wda,
            sink,
        ) = {
            let state = self.state.lock().expect("iOS simulator state poisoned");
            let session = state
                .session
                .as_ref()
                .ok_or_else(|| "Nenhum simulador está anexado.".to_string())?;
            (
                session.device.clone(),
                session.device_generation,
                session.stop.clone(),
                session.gate.clone(),
                session.stream_profile.clone(),
                session.mjpeg_active.clone(),
                session.stats.clone(),
                session.latest_frame.clone(),
                session.next_frame_generation.clone(),
                session.wda_force_stop.clone(),
                session.wda_control.clone(),
                session.staged_wda.clone(),
                session.sink.clone().ok_or_else(|| {
                    "A interação do simulador não está disponível para nova tentativa.".to_string()
                })?,
            )
        };
        let staged_wda = staged_wda.ok_or_else(|| {
            "A interação do simulador não está disponível para nova tentativa.".to_string()
        })?;
        let old_worker = {
            let state = self.state.lock().expect("iOS simulator state poisoned");
            let session = state
                .session
                .as_ref()
                .ok_or_else(|| "Nenhum simulador está anexado.".to_string())?;
            let mut workers = session
                .workers
                .lock()
                .expect("iOS simulator workers poisoned");
            (workers.len() > 1).then(|| workers.remove(1))
        };
        if let Some(worker) = old_worker {
            let _ = worker.join();
        }
        if self
            .lifecycle
            .transition(generation, LifecycleSignal::ClearRecoverableError)
        {
            self.emit_lifecycle_snapshot();
        }
        let lifecycle = self.lifecycle.clone();
        let lifecycle_emitter = self.lifecycle_emitter();
        let worker = spawn_wda_worker(
            self.runner.clone(),
            self.wda_launcher.clone(),
            self.wda_client.clone(),
            staged_wda,
            device.udid,
            None,
            lifecycle,
            lifecycle_emitter,
            gate,
            stream_profile,
            stop,
            mjpeg_active,
            stats,
            generation,
            latest_frame,
            next_frame_generation,
            wda_force_stop,
            wda_control,
            sink,
        );
        let state = self.state.lock().expect("iOS simulator state poisoned");
        let session = state
            .session
            .as_ref()
            .ok_or_else(|| "A sessão do simulador foi encerrada.".to_string())?;
        session
            .workers
            .lock()
            .expect("iOS simulator workers poisoned")
            .push(worker);
        Ok(self.lifecycle.snapshot())
    }

    pub(crate) fn begin_agent_action(
        &self,
        action: IosSimulatorPresenceAction,
        target: Option<NormalizedPoint>,
        start: Option<NormalizedPoint>,
        end: Option<NormalizedPoint>,
    ) -> u64 {
        if self.exiting.load(Ordering::Acquire) {
            return 0;
        }
        let generation = self.presence.begin();
        let presence = IosSimulatorPresenceEvent {
            generation,
            phase: IosSimulatorPresencePhase::Start,
            action: Some(action),
            target,
            start,
            end,
        };
        *self
            .presence_snapshot
            .lock()
            .expect("iOS simulator presence snapshot poisoned") = Some(presence.clone());
        if let Some(app) = self
            .app
            .lock()
            .expect("iOS simulator app handle poisoned")
            .clone()
        {
            let _ = app.emit(OPEN_REQUESTED_EVENT, presence.clone());
            let _ = app.emit(PRESENCE_EVENT, presence);
        }
        generation
    }

    pub(crate) fn complete_agent_action(&self, generation: u64) -> bool {
        if !self.presence.complete(generation) {
            return false;
        }
        self.clear_presence_snapshot(generation);
        self.emit_presence_clear(generation);
        true
    }

    pub(crate) fn clear_agent_presence(&self) {
        if let Some(generation) = self.presence.clear() {
            self.clear_presence_snapshot(generation);
            self.emit_presence_clear(generation);
        }
    }

    fn clear_presence_snapshot(&self, generation: u64) {
        let mut snapshot = self
            .presence_snapshot
            .lock()
            .expect("iOS simulator presence snapshot poisoned");
        if snapshot
            .as_ref()
            .is_some_and(|presence| presence.generation == generation)
        {
            *snapshot = None;
        }
    }

    fn emit_presence_clear(&self, generation: u64) {
        if let Some(app) = self
            .app
            .lock()
            .expect("iOS simulator app handle poisoned")
            .clone()
        {
            let _ = app.emit(
                PRESENCE_EVENT,
                IosSimulatorPresenceEvent {
                    generation,
                    phase: IosSimulatorPresencePhase::Clear,
                    action: None,
                    target: None,
                    start: None,
                    end: None,
                },
            );
        }
    }

    #[cfg(test)]
    fn with_runner(runner: Arc<dyn CommandRunner>) -> Self {
        Self {
            state: Arc::new(Mutex::new(ServiceState::default())),
            runner,
            ownership: Arc::new(OwnershipLedger::in_memory()),
            lifecycle: Arc::new(LifecycleAuthority::default()),
            desired_visibility: Arc::new(AtomicBool::new(true)),
            operation_lock: Arc::new(Mutex::new(())),
            exiting: Arc::new(AtomicBool::new(false)),
            exit_cleanup_started: Arc::new(AtomicBool::new(false)),
            wda_launcher: Arc::new(NoopWdaLauncher),
            wda_client: Arc::new(NoopWdaClient),
            next_device_generation: Arc::new(AtomicU64::new(0)),
            presence: Arc::new(PresenceAuthority::default()),
            presence_snapshot: Arc::new(Mutex::new(None)),
            app: Arc::new(Mutex::new(None)),
            media_backend: Arc::new(SystemSimulatorMediaBackend),
            emitted_outputs: Arc::new(Mutex::new(HashSet::new())),
            #[cfg(test)]
            lifecycle_emissions: Arc::new(Mutex::new(Vec::new())),
        }
    }

    #[cfg(test)]
    fn with_media_backend(backend: Arc<dyn SimulatorMediaBackend>) -> Self {
        let mut service = Self::default();
        service.media_backend = backend;
        service
    }

    #[cfg(test)]
    fn with_dependencies(
        runner: Arc<dyn CommandRunner>,
        wda_launcher: Arc<dyn WdaLauncher>,
    ) -> Self {
        Self {
            state: Arc::new(Mutex::new(ServiceState::default())),
            runner,
            ownership: Arc::new(OwnershipLedger::in_memory()),
            lifecycle: Arc::new(LifecycleAuthority::default()),
            desired_visibility: Arc::new(AtomicBool::new(true)),
            operation_lock: Arc::new(Mutex::new(())),
            exiting: Arc::new(AtomicBool::new(false)),
            exit_cleanup_started: Arc::new(AtomicBool::new(false)),
            wda_launcher,
            wda_client: Arc::new(SystemWdaClient::default()),
            next_device_generation: Arc::new(AtomicU64::new(0)),
            presence: Arc::new(PresenceAuthority::default()),
            presence_snapshot: Arc::new(Mutex::new(None)),
            app: Arc::new(Mutex::new(None)),
            media_backend: Arc::new(SystemSimulatorMediaBackend),
            emitted_outputs: Arc::new(Mutex::new(HashSet::new())),
            #[cfg(test)]
            lifecycle_emissions: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn attached(
        &self,
    ) -> (
        Option<String>,
        Option<u16>,
        Option<f64>,
        Option<IosSimulatorStreamSource>,
        Option<f64>,
    ) {
        let state = self.state.lock().expect("iOS simulator state poisoned");
        state
            .session
            .as_ref()
            .map(|session| {
                let stream_fps = session
                    .stream_profile
                    .lock()
                    .expect("iOS simulator stream profile poisoned")
                    .fps();
                let fallback_fps = *session
                    .fallback_fps
                    .lock()
                    .expect("iOS simulator fallback rate poisoned");
                let stats = *session.stats.lock().expect("iOS simulator stats poisoned");
                (
                    Some(session.device.udid.clone()),
                    Some(stream_fps),
                    Some(fallback_fps),
                    Some(stats.source),
                    stats.effective_fps,
                )
            })
            .unwrap_or((None, None, None, None, None))
    }

    fn stop_current(&self) {
        self.stop_session(None);
    }

    fn reject_if_exiting(&self) -> Result<(), String> {
        if self.exiting.load(Ordering::Acquire) {
            return Err("O Verboo está encerrando a simulação.".into());
        }
        Ok(())
    }

    pub(crate) fn begin_exit(&self) {
        self.exiting.store(true, Ordering::Release);
    }

    pub(crate) fn stop_for_app_exit(&self, deadline: Instant) -> ExitCleanupReport {
        self.begin_exit();
        if self.exit_cleanup_started.swap(true, Ordering::AcqRel) {
            return ExitCleanupReport::default();
        }

        let mut report = ExitCleanupReport::default();
        let operation = loop {
            match self.operation_lock.try_lock() {
                Ok(operation) => break Some(operation),
                Err(std::sync::TryLockError::WouldBlock) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(std::sync::TryLockError::WouldBlock) => break None,
                Err(std::sync::TryLockError::Poisoned(_)) => break None,
            }
        };
        let Some(_operation) = operation else {
            report
                .errors
                .push("a operação do simulador não liberou o lock antes do encerramento".into());
            return report;
        };

        self.stop_session(Some(deadline));
        for udid in self.ownership.owned_udids() {
            if Instant::now() >= deadline {
                report.errors.push(format!(
                    "prazo de encerramento expirou antes de desligar {udid}"
                ));
                break;
            }
            match run_simctl(self.runner.as_ref(), &["shutdown".into(), udid.clone()]) {
                Ok(_) => match self.ownership.remove(&udid) {
                    Ok(()) => report.shutdown_udids.push(udid),
                    Err(error) => report.errors.push(error),
                },
                Err(error) => report.errors.push(error),
            }
        }
        report
    }

    fn stop_session(&self, deadline: Option<Instant>) {
        self.clear_agent_presence();
        self.finalize_active_recording(deadline);
        let (session, generation) = {
            let mut state = self
                .state
                .lock()
                .expect("iOS simulator state poisoned");
            let generation = state.session.as_ref().map(|session| session.device_generation);
            (state.session.take(), generation)
        };
        if let Some(session) = session {
            // Detach is intentionally only a stream cancellation. It does
            // not call `simctl shutdown`: the user's device remains usable.
            session.gate.stop_and_wake(&session.stop);
            session.gate.set_visible(false);
            {
                let _input_guard = session
                    .input_lock
                    .lock()
                    .expect("iOS simulator input queue poisoned");
                // No WebDriver session exists. Removing the sessionless
                // control handle first prevents new input while the worker
                // interrupts xcodebuild with SIGINT.
                let _ = session
                    .wda_control
                    .lock()
                    .expect("iOS simulator WDA control poisoned")
                    .take();
            }
            let workers = std::mem::take(
                &mut *session
                    .workers
                    .lock()
                    .expect("iOS simulator workers poisoned"),
            );
            if let Some(deadline) = deadline {
                while workers.iter().any(|worker| !worker.is_finished())
                    && Instant::now() < deadline
                {
                    thread::sleep(Duration::from_millis(5));
                }
                if workers.iter().any(|worker| !worker.is_finished()) {
                    if let Some(force_stop) = session
                        .wda_force_stop
                        .lock()
                        .expect("iOS simulator WDA control poisoned")
                        .as_ref()
                        .cloned()
                    {
                        force_stop();
                    }
                }
            }
            for worker in workers {
                if deadline.is_none() || worker.is_finished() {
                    let _ = worker.join();
                }
            }
        }
        // R1-B1: every session-end path (detach, end, switch, app exit) must
        // leave the renderer with an IDLE lifecycle — otherwise the panel
        // freezes on the last ready snapshot ("Pronto" + "Aguardando a
        // primeira captura…") forever. The generation guard makes a late
        // stop of session N a no-op when session N+1 has already begun:
        // lifecycle.clear(generation) returns false when the snapshot no
        // longer belongs to that generation, so the newer session is never
        // erased by a stale teardown.
        if let Some(generation) = generation {
            if self.lifecycle.clear(generation) {
                self.emit_lifecycle_snapshot();
            }
        }
    }

    fn current_session_generation(&self) -> Option<u64> {
        self.state
            .lock()
            .expect("iOS simulator state poisoned")
            .session
            .as_ref()
            .map(|session| session.device_generation)
    }

    fn remember_emitted_output(&self, file: &IosSimulatorMediaFile) {
        if let Ok(path) = fs::canonicalize(&file.path) {
            self.emitted_outputs
                .lock()
                .expect("iOS simulator emitted outputs poisoned")
                .insert(path);
        }
    }

    fn finish_recording(
        &self,
        generation: u64,
        recording: ActiveRecording,
        deadline: Instant,
    ) -> Result<IosSimulatorMediaFile, String> {
        let result = stop_recording_until(recording, deadline);
        if let Ok(file) = &result {
            self.remember_emitted_output(file);
        }
        if self.current_session_generation() == Some(generation) {
            let state_changed = self.lifecycle.transition(
                generation,
                LifecycleSignal::RecordingChanged(IosSimulatorRecordingState::Idle),
            );
            if state_changed {
                self.emit_lifecycle_snapshot();
            }
            if let Err(error) = &result {
                if self
                    .lifecycle
                    .transition(generation, LifecycleSignal::RecoverableError(error.clone()))
                {
                    self.emit_lifecycle_snapshot();
                }
            }
        }
        result
    }

    fn finalize_active_recording(&self, deadline: Option<Instant>) {
        let (generation, recording) = {
            let state = self.state.lock().expect("iOS simulator state poisoned");
            let Some(session) = state.session.as_ref() else {
                return;
            };
            let generation = session.device_generation;
            let recording = session
                .recording
                .lock()
                .expect("iOS simulator recording poisoned")
                .take();
            (generation, recording)
        };
        let Some(recording) = recording else {
            return;
        };
        if self.lifecycle.transition(
            generation,
            LifecycleSignal::RecordingChanged(IosSimulatorRecordingState::Finalizing),
        ) {
            self.emit_lifecycle_snapshot();
        }
        let _ = self.finish_recording(
            generation,
            recording,
            deadline.unwrap_or_else(|| Instant::now() + Duration::from_secs(8)),
        );
    }

    pub(crate) fn capture_screen_sync(
        &self,
        desktop: &Path,
    ) -> Result<IosSimulatorMediaFile, String> {
        self.reject_if_exiting()?;
        let _operation = self
            .operation_lock
            .lock()
            .expect("iOS simulator operation lock poisoned");
        self.reject_if_exiting()?;
        let (device, generation) = {
            let state = self.state.lock().expect("iOS simulator state poisoned");
            let session = state
                .session
                .as_ref()
                .ok_or_else(|| "Nenhum simulador está anexado.".to_string())?;
            (session.device.clone(), session.device_generation)
        };
        let file = capture_screen(self.media_backend.as_ref(), desktop, &device)?;
        if self.current_session_generation() != Some(generation) {
            return Err("A captura pertence a outra sessão do simulador.".into());
        }
        self.remember_emitted_output(&file);
        Ok(file)
    }

    pub(crate) fn start_recording_sync(
        &self,
        desktop: &Path,
    ) -> Result<IosSimulatorLifecycleSnapshot, String> {
        self.reject_if_exiting()?;
        let _operation = self
            .operation_lock
            .lock()
            .expect("iOS simulator operation lock poisoned");
        self.reject_if_exiting()?;
        let (generation, device, recording) = {
            let state = self.state.lock().expect("iOS simulator state poisoned");
            let session = state
                .session
                .as_ref()
                .ok_or_else(|| "Nenhum simulador está anexado.".to_string())?;
            (
                session.device_generation,
                session.device.clone(),
                session.recording.clone(),
            )
        };
        let mut recording = recording.lock().expect("iOS simulator recording poisoned");
        if recording.is_some() {
            return Err("uma gravação já está em andamento".to_string());
        }
        if self.lifecycle.transition(
            generation,
            LifecycleSignal::RecordingChanged(IosSimulatorRecordingState::Starting),
        ) {
            self.emit_lifecycle_snapshot();
        }
        let mut active = match start_recording(self.media_backend.as_ref(), desktop, &device) {
            Ok(active) => active,
            Err(error) => {
                if self.lifecycle.transition(
                    generation,
                    LifecycleSignal::RecordingChanged(IosSimulatorRecordingState::Idle),
                ) {
                    self.emit_lifecycle_snapshot();
                }
                if self
                    .lifecycle
                    .transition(generation, LifecycleSignal::RecoverableError(error.clone()))
                {
                    self.emit_lifecycle_snapshot();
                }
                return Err(error);
            }
        };
        active.device_generation = generation;
        let started_at_ms = active.started_at_ms;
        *recording = Some(active);
        if self.lifecycle.transition(
            generation,
            LifecycleSignal::RecordingChanged(IosSimulatorRecordingState::Recording {
                started_at_ms,
            }),
        ) {
            self.emit_lifecycle_snapshot();
        }
        Ok(self.lifecycle.snapshot())
    }

    pub(crate) fn stop_recording_sync(&self) -> Result<IosSimulatorMediaFile, String> {
        self.reject_if_exiting()?;
        let _operation = self
            .operation_lock
            .lock()
            .expect("iOS simulator operation lock poisoned");
        self.reject_if_exiting()?;
        let (generation, recording) = {
            let state = self.state.lock().expect("iOS simulator state poisoned");
            let session = state
                .session
                .as_ref()
                .ok_or_else(|| "Nenhum simulador está anexado.".to_string())?;
            let generation = session.device_generation;
            let recording = session
                .recording
                .lock()
                .expect("iOS simulator recording poisoned")
                .take()
                .ok_or_else(|| "não há gravação em andamento".to_string())?;
            (generation, recording)
        };
        if self.lifecycle.transition(
            generation,
            LifecycleSignal::RecordingChanged(IosSimulatorRecordingState::Finalizing),
        ) {
            self.emit_lifecycle_snapshot();
        }
        self.finish_recording(
            generation,
            recording,
            Instant::now() + Duration::from_secs(8),
        )
    }

    pub(crate) fn reveal_output_sync(&self, requested: &Path) -> Result<(), String> {
        self.reject_if_exiting()?;
        let canonical = requested
            .canonicalize()
            .map_err(|error| format!("o arquivo de mídia não existe: {error}"))?;
        if !self
            .emitted_outputs
            .lock()
            .expect("iOS simulator emitted outputs poisoned")
            .contains(&canonical)
        {
            return Err("o arquivo não foi produzido pela sessão atual do simulador".to_string());
        }
        self.media_backend.reveal(&canonical)
    }

    fn start_session(
        &self,
        device: IosSimulatorDevice,
        stream_profile: StreamProfile,
        fallback_fps: f64,
        display_metrics: SimctlDisplayMetrics,
        staged_wda: Option<WdaStagedPaths>,
        sink: Arc<dyn FrameSink>,
    ) -> u64 {
        self.stop_current();
        let device_generation = self
            .next_device_generation
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1);
        self.lifecycle.begin(
            device_generation,
            device.clone(),
            IosSimulatorOwnership::External,
            true,
        );
        self.lifecycle
            .transition(device_generation, LifecycleSignal::BootComplete);
        self.lifecycle
            .transition(device_generation, LifecycleSignal::DisplayReady);
        self.emit_lifecycle_snapshot();
        self.start_session_at_generation(
            device,
            IosSimulatorOwnership::External,
            device_generation,
            stream_profile,
            fallback_fps,
            Some(display_metrics),
            staged_wda,
            sink,
        );
        device_generation
    }

    fn start_session_at_generation(
        &self,
        device: IosSimulatorDevice,
        ownership: IosSimulatorOwnership,
        device_generation: u64,
        stream_profile: StreamProfile,
        fallback_fps: f64,
        display_metrics: Option<SimctlDisplayMetrics>,
        staged_wda: Option<WdaStagedPaths>,
        sink: Arc<dyn FrameSink>,
    ) {
        let udid = device.udid.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let fallback_rate = Arc::new(Mutex::new(fallback_fps));
        let stream_profile = Arc::new(Mutex::new(stream_profile));
        let mjpeg_active = Arc::new(AtomicBool::new(false));
        let gate = Arc::new(PreviewGate::new(
            self.desired_visibility.load(Ordering::Acquire),
        ));
        let input_lock = Arc::new(Mutex::new(()));
        let latest_frame = Arc::new(Mutex::new(None));
        let next_frame_generation = Arc::new(AtomicU64::new(0));
        let wda_force_stop = Arc::new(Mutex::new(None));
        let wda_control = Arc::new(Mutex::new(None));
        let stats = Arc::new(Mutex::new(StreamStats {
            source: IosSimulatorStreamSource::Simctl,
            effective_fps: None,
        }));
        let lifecycle = self.lifecycle.clone();
        let lifecycle_emitter = self.lifecycle_emitter();
        let mut workers = vec![spawn_capture_loop_internal(
            self.runner.clone(),
            udid.clone(),
            fallback_rate.clone(),
            stop.clone(),
            mjpeg_active.clone(),
            stats.clone(),
            device_generation,
            latest_frame.clone(),
            next_frame_generation.clone(),
            sink.clone(),
            gate.clone(),
            FIRST_FRAME_TIMEOUT,
            FIRST_FRAME_RETRY,
            Some(lifecycle.clone()),
            Some(lifecycle_emitter.clone()),
        )];
        let staged_wda_for_session = staged_wda.clone();
        if let Some(staged_wda) = staged_wda {
            workers.push(spawn_wda_worker(
                self.runner.clone(),
                self.wda_launcher.clone(),
                self.wda_client.clone(),
                staged_wda,
                udid.clone(),
                display_metrics,
                lifecycle.clone(),
                lifecycle_emitter.clone(),
                gate.clone(),
                stream_profile.clone(),
                stop.clone(),
                mjpeg_active.clone(),
                stats.clone(),
                device_generation,
                latest_frame.clone(),
                next_frame_generation.clone(),
                wda_force_stop.clone(),
                wda_control.clone(),
                sink.clone(),
            ));
        } else if display_metrics.is_none() {
            workers.push(spawn_display_readiness_worker(
                self.runner.clone(),
                udid.clone(),
                stop.clone(),
                device_generation,
                lifecycle,
                lifecycle_emitter,
            ));
        }
        self.state
            .lock()
            .expect("iOS simulator state poisoned")
            .session = Some(Session {
            device,
            device_generation,
            ownership,
            fallback_fps: fallback_rate,
            stream_profile,
            stats,
            stop: stop.clone(),
            input_lock,
            latest_frame,
            gate,
            mjpeg_active,
            next_frame_generation: next_frame_generation.clone(),
            wda_control,
            wda_force_stop,
            staged_wda: staged_wda_for_session,
            sink: Some(sink.clone()),
            recording: Arc::new(Mutex::new(None)),
            workers: Mutex::new(workers),
        });
    }

    fn attach_sync(
        &self,
        app: AppHandle,
        udid: String,
        stream_fps: u16,
        fallback_fps: f64,
    ) -> Result<IosSimulatorSession, String> {
        self.reject_if_exiting()?;
        let _operation = self
            .operation_lock
            .lock()
            .expect("iOS simulator operation lock poisoned");
        self.reject_if_exiting()?;
        self.bind_app(app.clone());
        let stream_profile = StreamProfile::try_from(stream_fps)?;
        let fallback_fps = validate_fallback_fps(fallback_fps)?;
        if let Some(session) = self.current_session_summary() {
            if session.device.udid == udid {
                return Ok(session);
            }
        }
        let preparation =
            prepare_device_for_attach(self.runner.as_ref(), self.ownership.as_ref(), &udid)?;
        let device_for_lifecycle = preparation.device.clone();
        let device_generation = self
            .next_device_generation
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1);
        self.lifecycle.begin(
            device_generation,
            device_for_lifecycle,
            preparation.ownership,
            true,
        );
        self.emit_lifecycle_snapshot();
        let prepared = match complete_device_boot(
            self.runner.as_ref(),
            self.ownership.as_ref(),
            preparation,
            &self.exiting,
            Instant::now() + WDA_READY_TIMEOUT,
        ) {
            Ok(prepared) => prepared,
            Err(error) => {
                if self.lifecycle.transition(
                    device_generation,
                    LifecycleSignal::InteractionFailed(error.clone()),
                ) {
                    self.emit_lifecycle_snapshot();
                }
                return Err(error);
            }
        };
        if self
            .lifecycle
            .transition(device_generation, LifecycleSignal::BootComplete)
        {
            self.emit_lifecycle_snapshot();
        }
        if self.current_session_summary().is_some() {
            self.switch_cleanup()?;
        }
        let device = prepared.device;
        let sink = Arc::new(TauriFrameSink {
            app: app.clone(),
            presence_snapshot: self.presence_snapshot.clone(),
        });
        let (staged_wda, staging_error) = match resolve_wda_staged_paths(&app) {
            Ok(staged_wda) => (staged_wda, None),
            Err(message) => (None, Some(message)),
        };

        self.start_session_at_generation(
            device.clone(),
            prepared.ownership,
            device_generation,
            stream_profile,
            fallback_fps,
            None,
            staged_wda,
            sink.clone(),
        );
        if let Some(message) = staging_error {
            if self.lifecycle.transition(
                device_generation,
                LifecycleSignal::InteractionFailed(message.clone()),
            ) {
                self.emit_lifecycle_snapshot();
            }
            sink.error(IosSimulatorError {
                udid: udid.clone(),
                message: format!(
                    "Vídeo MJPEG indisponível; usando o modo econômico: não foi possível preparar o WDA: {message}"
                ),
            });
        }
        Ok(IosSimulatorSession {
            device,
            device_generation,
            ownership: prepared.ownership,
            stream_fps: stream_profile.fps(),
            fallback_fps,
            source: IosSimulatorStreamSource::Simctl,
            effective_fps: None,
            lifecycle: self.lifecycle.snapshot(),
        })
    }

    fn set_stream_rate_sync(&self, stream_fps: u16) -> Result<u16, String> {
        self.reject_if_exiting()?;
        let profile = StreamProfile::try_from(stream_fps)?;
        let (stream_profile, input_lock, stop, active_wda) = {
            let state = self.state.lock().expect("iOS simulator state poisoned");
            let session = state
                .session
                .as_ref()
                .ok_or_else(|| "Nenhum simulador está anexado.".to_string())?;
            let active_wda = session
                .wda_control
                .lock()
                .expect("iOS simulator WDA control poisoned")
                .clone();
            (
                session.stream_profile.clone(),
                session.input_lock.clone(),
                session.stop.clone(),
                active_wda,
            )
        };
        let _input_guard = input_lock
            .lock()
            .expect("iOS simulator input queue poisoned");
        if stop.load(Ordering::Acquire) {
            return Err("A sessão do simulador foi encerrada.".to_string());
        }
        if let Some(handle) = active_wda {
            self.wda_client.apply_stream_settings(&handle, profile)?;
        }
        *stream_profile
            .lock()
            .expect("iOS simulator stream profile poisoned") = profile;
        Ok(profile.fps())
    }

    fn set_fallback_rate_sync(&self, fallback_fps: f64) -> Result<f64, String> {
        self.reject_if_exiting()?;
        let fallback_fps = validate_fallback_fps(fallback_fps)?;
        let state = self.state.lock().expect("iOS simulator state poisoned");
        let session = state
            .session
            .as_ref()
            .ok_or_else(|| "Nenhum simulador está anexado.".to_string())?;
        *session
            .fallback_fps
            .lock()
            .expect("iOS simulator fallback rate poisoned") = fallback_fps;
        Ok(fallback_fps)
    }

    fn active_wda_access(
        &self,
    ) -> Result<(Arc<Mutex<()>>, Arc<AtomicBool>, WdaControlHandle), String> {
        let state = self.state.lock().expect("iOS simulator state poisoned");
        let session = state
            .session
            .as_ref()
            .ok_or_else(|| "Nenhum simulador está anexado.".to_string())?;
        let handle = session
            .wda_control
            .lock()
            .expect("iOS simulator WDA control poisoned")
            .clone()
            .ok_or_else(|| {
                "A interação fica disponível quando o stream MJPEG do WDA está pronto.".to_string()
            })?;
        Ok((session.input_lock.clone(), session.stop.clone(), handle))
    }

    fn active_system_access(
        &self,
    ) -> Result<
        (
            Arc<Mutex<()>>,
            Arc<AtomicBool>,
            WdaControlHandle,
            String,
            IosSimulatorDeviceFamily,
            u64,
            String,
        ),
        String,
    > {
        let state = self.state.lock().expect("iOS simulator state poisoned");
        let session = state
            .session
            .as_ref()
            .ok_or_else(|| "Nenhum simulador está anexado.".to_string())?;
        let handle = session
            .wda_control
            .lock()
            .expect("iOS simulator WDA control poisoned")
            .clone()
            .ok_or_else(|| {
                "A interação fica disponível quando o stream MJPEG do WDA está pronto.".to_string()
            })?;
        Ok((
            session.input_lock.clone(),
            session.stop.clone(),
            handle,
            session.device.udid.clone(),
            session.device.family,
            session.device_generation,
            session.device.ios_version.clone(),
        ))
    }

    pub(crate) fn system_action_sync(
        &self,
        action: IosSimulatorSystemAction,
    ) -> Result<(), String> {
        self.reject_if_exiting()?;
        let (input_lock, stop, handle, udid, family, device_generation, ios_version) =
            self.active_system_access()?;
        let _guard = input_lock
            .lock()
            .expect("iOS simulator input queue poisoned");
        if stop.load(Ordering::Acquire) {
            return Err("A sessão do simulador foi encerrada.".to_string());
        }
        match action {
            IosSimulatorSystemAction::Home => self.wda_client.home(&handle),
            IosSimulatorSystemAction::AppSwitcher
            | IosSimulatorSystemAction::Notifications
            | IosSimulatorSystemAction::ControlCenter => {
                let gesture = system_gesture(action, family, handle.orientation)
                    .ok_or_else(|| "A ação do sistema não possui gesto.".to_string())?;
                self.wda_client.system_gesture(&handle, gesture)
            }
            IosSimulatorSystemAction::RotateClockwise => {
                let target = next_clockwise_orientation(handle.orientation, family);
                self.wda_client.rotate(&handle, target)?;
                let metrics = match wait_for_target_display_metrics(
                    self.runner.as_ref(),
                    &udid,
                    target,
                    Instant::now() + WDA_READY_TIMEOUT,
                    ios_version.starts_with("27"),
                ) {
                    Ok(metrics) => metrics,
                    Err(error)
                        if ios_version.starts_with("27")
                            && error.kind == SimulatorDisplayErrorKind::AmbiguousOrientation =>
                    {
                        // A rotação foi enviada (o WDA respondeu OK), mas o
                        // runtime 27 reporta a orientação como Ambiguous de
                        // forma permanente — a confirmação nunca chega. O
                        // usuário precisa saber que é limitação do runtime,
                        // não uma falha da ação.
                        let message = error.message;
                        let generation = device_generation;
                        if self
                            .lifecycle
                            .transition(generation, LifecycleSignal::RecoverableError(message.clone()))
                        {
                            self.emit_lifecycle_snapshot();
                        }
                        return Err(message);
                    }
                    Err(error) => return Err(error.message),
                };
                let state = self.state.lock().expect("iOS simulator state poisoned");
                let session = state
                    .session
                    .as_ref()
                    .ok_or_else(|| "A sessão do simulador foi encerrada.".to_string())?;
                if session.device_generation != device_generation
                    || session.stop.load(Ordering::Acquire)
                {
                    return Err("A rotação pertence a uma sessão anterior do simulador.".into());
                }
                *session
                    .wda_control
                    .lock()
                    .expect("iOS simulator WDA control poisoned") = Some(WdaControlHandle {
                    window_size: metrics.window_size,
                    orientation: metrics.interface_orientation,
                    ..handle
                });
                Ok(())
            }
        }
    }

    pub(crate) fn tap_sync(&self, point: NormalizedPoint) -> Result<(), String> {
        self.reject_if_exiting()?;
        let (input_lock, stop, handle) = self.active_wda_access()?;
        let point = normalized_to_wda_point(point, handle.window_size)?;
        let _guard = input_lock
            .lock()
            .expect("iOS simulator input queue poisoned");
        if stop.load(Ordering::Acquire) {
            return Err("A sessão do simulador foi encerrada.".to_string());
        }
        self.wda_client.tap(&handle, point)
    }

    pub(crate) fn drag_sync(
        &self,
        from: NormalizedPoint,
        to: NormalizedPoint,
        duration_ms: u64,
    ) -> Result<(), String> {
        self.reject_if_exiting()?;
        let (input_lock, stop, handle) = self.active_wda_access()?;
        let from = normalized_to_wda_point(from, handle.window_size)?;
        let to = normalized_to_wda_point(to, handle.window_size)?;
        let duration = Duration::from_millis(duration_ms.clamp(50, 2_000));
        let _guard = input_lock
            .lock()
            .expect("iOS simulator input queue poisoned");
        if stop.load(Ordering::Acquire) {
            return Err("A sessão do simulador foi encerrada.".to_string());
        }
        self.wda_client.drag(&handle, from, to, duration)
    }

    pub(crate) fn type_text_sync(&self, text: &str) -> Result<(), String> {
        self.reject_if_exiting()?;
        validate_input_text(text)?;
        let (input_lock, stop, handle) = self.active_wda_access()?;
        let _guard = input_lock
            .lock()
            .expect("iOS simulator input queue poisoned");
        if stop.load(Ordering::Acquire) {
            return Err("A sessão do simulador foi encerrada.".to_string());
        }
        self.wda_client.type_text(&handle, text)
    }

    pub(crate) fn press_key_sync(&self, key: IosSimulatorKey) -> Result<(), String> {
        self.reject_if_exiting()?;
        let (input_lock, stop, handle) = self.active_wda_access()?;
        let _guard = input_lock
            .lock()
            .expect("iOS simulator input queue poisoned");
        if stop.load(Ordering::Acquire) {
            return Err("A sessão do simulador foi encerrada.".to_string());
        }
        self.wda_client.press_key(&handle, key)
    }

    pub(crate) fn accessibility_snapshot_sync(
        &self,
    ) -> Result<Vec<IosSimulatorAccessibilityNode>, String> {
        self.reject_if_exiting()?;
        Err(
            "A inspeção por acessibilidade foi desativada nesta versão para proteger a estabilidade do simulador. Use a captura de área."
                .to_string(),
        )
    }

    fn capture_annotation_sync(
        &self,
        store: &IosSimulatorCaptureStore,
        device_generation: u64,
        rect: NormalizedRect,
        element: Option<IosSimulatorAccessibilityNode>,
    ) -> Result<IosSimulatorAnnotationCapture, String> {
        self.reject_if_exiting()?;
        self.capture_annotation_with_after_write(store, device_generation, rect, element, || {})
    }

    fn capture_annotation_with_after_write<F: FnOnce()>(
        &self,
        store: &IosSimulatorCaptureStore,
        device_generation: u64,
        rect: NormalizedRect,
        element: Option<IosSimulatorAccessibilityNode>,
        after_write: F,
    ) -> Result<IosSimulatorAnnotationCapture, String> {
        let (device, latest_frame) = {
            let state = self.state.lock().expect("iOS simulator state poisoned");
            let session = state
                .session
                .as_ref()
                .ok_or_else(|| "Nenhum simulador está anexado.".to_string())?;
            if session.device_generation != device_generation {
                return Err("A captura pertence a outra sessão do simulador.".into());
            }
            let latest = session
                .latest_frame
                .lock()
                .expect("iOS simulator latest frame poisoned")
                .clone()
                .ok_or_else(|| "Aguardando a primeira captura do simulador.".to_string())?;
            if latest.device_generation != device_generation {
                return Err("O quadro selecionado pertence a outra sessão.".into());
            }
            if !matches!(latest.media_type, "image/png" | "image/jpeg") {
                return Err("Formato de captura do simulador não suportado.".into());
            }
            (session.device.clone(), latest)
        };

        let written = store.write_capture(
            &latest_frame.bytes,
            NormalizedCaptureRect {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            },
        )?;
        after_write();
        let still_current = self
            .state
            .lock()
            .expect("iOS simulator state poisoned")
            .session
            .as_ref()
            .map(|session| session.device_generation == device_generation)
            .unwrap_or(false);
        if !still_current {
            let _ = store.delete_temp_files(vec![
                written.crop_path.clone(),
                written.viewport_path.clone(),
            ]);
            return Err("A sessão do simulador mudou durante a captura.".into());
        }

        let device_rect =
            element
                .as_ref()
                .map(|node| node.frame)
                .unwrap_or(IosSimulatorDeviceRect {
                    x: rect.x * f64::from(written.viewport_width),
                    y: rect.y * f64::from(written.viewport_height),
                    width: rect.width * f64::from(written.viewport_width),
                    height: rect.height * f64::from(written.viewport_height),
                });
        Ok(IosSimulatorAnnotationCapture {
            crop_path: written.crop_path,
            viewport_path: written.viewport_path,
            crop_width: written.crop_width,
            crop_height: written.crop_height,
            viewport_width: written.viewport_width,
            viewport_height: written.viewport_height,
            crop_bytes: written.crop_bytes,
            viewport_bytes: written.viewport_bytes,
            device,
            orientation: if written.viewport_height >= written.viewport_width {
                IosSimulatorOrientation::Portrait
            } else {
                IosSimulatorOrientation::Landscape
            },
            device_generation,
            frame_generation: latest_frame.frame_generation,
            rect,
            device_rect,
            element,
        })
    }

    fn detach_sync(&self) -> Result<(), String> {
        self.detach_external_sync()
    }
}

#[tauri::command]
pub async fn ios_simulator_requirements(
    service: State<'_, IosSimulatorService>,
) -> Result<IosSimulatorRequirements, String> {
    let runner = service.runner.clone();
    let (attached_udid, stream_fps, fallback_fps, source, effective_fps) = service.attached();
    let lifecycle = service.lifecycle.snapshot();
    tauri::async_runtime::spawn_blocking(move || {
        let mut requirements = detect_requirements(runner.as_ref());
        requirements.attached_udid = attached_udid;
        requirements.stream_fps = stream_fps;
        requirements.fallback_fps = fallback_fps;
        requirements.source = source;
        requirements.effective_fps = effective_fps;
        requirements.lifecycle = lifecycle;
        Ok(requirements)
    })
    .await
    .map_err(|error| format!("falha ao detectar simuladores: {error}"))?
}

#[tauri::command]
pub async fn ios_simulator_attach(
    app: AppHandle,
    service: State<'_, IosSimulatorService>,
    udid: String,
    stream_fps: u16,
    fallback_fps: f64,
) -> Result<IosSimulatorSession, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.attach_sync(app, udid, stream_fps, fallback_fps)
    })
    .await
    .map_err(|error| format!("falha ao anexar simulador: {error}"))?
}

#[tauri::command]
pub async fn ios_simulator_detach(service: State<'_, IosSimulatorService>) -> Result<(), String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.detach_sync())
        .await
        .map_err(|error| format!("falha ao desanexar simulador: {error}"))?
}

#[tauri::command]
pub fn ios_simulator_set_visible(
    service: State<'_, IosSimulatorService>,
    visible: bool,
) -> Result<(), String> {
    service.set_visible_sync(visible)
}

#[tauri::command]
pub fn ios_simulator_end(service: State<'_, IosSimulatorService>) -> Result<(), String> {
    service.end_owned_sync()
}

#[tauri::command]
pub fn ios_simulator_retry_interaction(
    service: State<'_, IosSimulatorService>,
) -> Result<IosSimulatorLifecycleSnapshot, String> {
    service.retry_interaction_sync()
}

#[tauri::command]
pub fn ios_simulator_system_action(
    service: State<'_, IosSimulatorService>,
    action: IosSimulatorSystemAction,
) -> Result<(), String> {
    service.system_action_sync(action)
}

fn desktop_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .desktop_dir()
        .map_err(|error| format!("não foi possível localizar a Mesa: {error}"))
}

#[tauri::command]
pub fn ios_simulator_capture_screen(
    app: AppHandle,
    service: State<'_, IosSimulatorService>,
) -> Result<IosSimulatorMediaFile, String> {
    let desktop = desktop_directory(&app)?;
    service.capture_screen_sync(&desktop)
}

#[tauri::command]
pub fn ios_simulator_recording_start(
    app: AppHandle,
    service: State<'_, IosSimulatorService>,
) -> Result<IosSimulatorLifecycleSnapshot, String> {
    let desktop = desktop_directory(&app)?;
    service.start_recording_sync(&desktop)
}

#[tauri::command]
pub fn ios_simulator_recording_stop(
    service: State<'_, IosSimulatorService>,
) -> Result<IosSimulatorMediaFile, String> {
    service.stop_recording_sync()
}

#[tauri::command]
pub fn ios_simulator_reveal_output(
    path: String,
    service: State<'_, IosSimulatorService>,
) -> Result<(), String> {
    service.reveal_output_sync(Path::new(&path))
}

#[tauri::command]
pub fn ios_simulator_set_stream_rate(
    service: State<'_, IosSimulatorService>,
    stream_fps: u16,
) -> Result<u16, String> {
    service.set_stream_rate_sync(stream_fps)
}

#[tauri::command]
pub fn ios_simulator_set_fallback_rate(
    service: State<'_, IosSimulatorService>,
    fallback_fps: f64,
) -> Result<f64, String> {
    service.set_fallback_rate_sync(fallback_fps)
}

#[tauri::command]
pub async fn ios_simulator_tap(
    service: State<'_, IosSimulatorService>,
    point: NormalizedPoint,
) -> Result<(), String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.tap_sync(point))
        .await
        .map_err(|error| format!("falha ao tocar no simulador: {error}"))?
}

#[tauri::command]
pub async fn ios_simulator_drag(
    service: State<'_, IosSimulatorService>,
    from: NormalizedPoint,
    to: NormalizedPoint,
    duration_ms: u64,
) -> Result<(), String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.drag_sync(from, to, duration_ms))
        .await
        .map_err(|error| format!("falha ao arrastar no simulador: {error}"))?
}

#[tauri::command]
pub async fn ios_simulator_type_text(
    service: State<'_, IosSimulatorService>,
    text: String,
) -> Result<(), String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.type_text_sync(&text))
        .await
        .map_err(|error| format!("falha ao digitar no simulador: {error}"))?
}

#[tauri::command]
pub async fn ios_simulator_press_key(
    service: State<'_, IosSimulatorService>,
    key: IosSimulatorKey,
) -> Result<(), String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.press_key_sync(key))
        .await
        .map_err(|error| format!("falha ao pressionar tecla no simulador: {error}"))?
}

#[tauri::command]
pub async fn ios_simulator_accessibility_snapshot(
    service: State<'_, IosSimulatorService>,
) -> Result<Vec<IosSimulatorAccessibilityNode>, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.accessibility_snapshot_sync())
        .await
        .map_err(|error| format!("falha ao inspecionar o simulador: {error}"))?
}

#[tauri::command]
pub async fn ios_simulator_capture_annotation(
    service: State<'_, IosSimulatorService>,
    store: State<'_, IosSimulatorCaptureStore>,
    device_generation: u64,
    rect: NormalizedRect,
    element: Option<IosSimulatorAccessibilityNode>,
) -> Result<IosSimulatorAnnotationCapture, String> {
    let service = service.inner().clone();
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.capture_annotation_sync(&store, device_generation, rect, element)
    })
    .await
    .map_err(|error| format!("falha ao capturar anotação do simulador: {error}"))?
}

#[tauri::command]
pub fn ios_simulator_delete_temp_files(
    store: State<'_, IosSimulatorCaptureStore>,
    paths: Vec<String>,
) -> Result<(), String> {
    store.delete_temp_files(paths)
}

#[tauri::command]
pub fn ios_simulator_promote_temp_files(
    store: State<'_, IosSimulatorCaptureStore>,
    owner_id: String,
    paths: Vec<String>,
) -> Result<Vec<PromotedSimulatorFile>, String> {
    store.promote(&owner_id, paths)
}

#[tauri::command]
pub fn ios_simulator_delete_capture_owner(
    store: State<'_, IosSimulatorCaptureStore>,
    owner_id: String,
) -> Result<(), String> {
    store.delete_owner(&owner_id)
}

#[tauri::command]
pub fn ios_simulator_cleanup_capture_owners(
    store: State<'_, IosSimulatorCaptureStore>,
    active_owner_ids: Vec<String>,
) -> Result<(), String> {
    store.cleanup_owners(active_owner_ids)
}

fn resolve_wda_project(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("VERBOO_WDA_PROJECT") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("resources/WebDriverAgent/WebDriverAgent.xcodeproj"));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/WebDriverAgent/WebDriverAgent.xcodeproj"),
    );
    candidates.into_iter().find(|path| path.exists())
}

fn resolve_wda_staged_paths(app: &AppHandle) -> Result<Option<WdaStagedPaths>, String> {
    let Some(source_project) = resolve_wda_project(app) else {
        return Ok(None);
    };
    let source = source_project
        .parent()
        .ok_or_else(|| "não foi possível resolver a raiz do projeto WDA".to_string())?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("não foi possível resolver os dados locais do app: {error}"))?;
    let staging_root = wda_staging_root(&app_data_dir)?;
    stage_wda_project_at(&source, &staging_root).map(Some)
}

fn wda_staging_root(app_data_dir: &Path) -> Result<PathBuf, String> {
    Ok(app_data_dir.join(WDA_STAGING_RELATIVE_ROOT))
}

fn stage_wda_project_at(source: &Path, staging_root: &Path) -> Result<WdaStagedPaths, String> {
    let source_metadata = std::fs::symlink_metadata(source)
        .map_err(|error| format!("não foi possível ler o projeto WDA: {error}"))?;
    if !source_metadata.is_dir() {
        return Err(format!(
            "o projeto WDA não é uma pasta: {}",
            source.display()
        ));
    }
    if !source.join("WebDriverAgent.xcodeproj").is_dir() {
        return Err(format!(
            "a raiz do WDA não contém WebDriverAgent.xcodeproj: {}",
            source.display()
        ));
    }
    if source.starts_with(staging_root) || staging_root.starts_with(source) {
        return Err("a origem e o destino do WDA não podem se sobrepor".to_string());
    }

    let digest = wda_source_digest(source)?;
    let project_root = staging_root.join(WDA_PROJECT_ROOT_DIRECTORY);
    let project = staging_root.join(WDA_PROJECT_DIRECTORY);
    let derived_data = staging_root.join(WDA_DERIVED_DATA_DIRECTORY);
    let digest_path = staging_root.join(WDA_SOURCE_DIGEST_FILE);
    if std::fs::read_to_string(&digest_path)
        .map(|saved| saved.trim() == digest && project.is_dir())
        .unwrap_or(false)
    {
        if let Err(error) = enforce_wda_loopback_binding(&project_root) {
            let _ = std::fs::remove_dir_all(&project_root);
            return Err(error);
        }
        std::fs::create_dir_all(&derived_data).map_err(|error| {
            format!("não foi possível reutilizar o DerivedData do WDA: {error}")
        })?;
        return Ok(WdaStagedPaths {
            project,
            derived_data,
        });
    }

    std::fs::create_dir_all(staging_root)
        .map_err(|error| format!("não foi possível criar o cache local do WDA: {error}"))?;
    let temporary_project = staging_root.join(WDA_PROJECT_TEMP_DIRECTORY);
    if temporary_project.exists() {
        std::fs::remove_dir_all(&temporary_project).map_err(|error| {
            format!("não foi possível limpar o staging temporário do WDA: {error}")
        })?;
    }
    if let Err(error) = copy_wda_directory(source, &temporary_project) {
        let _ = std::fs::remove_dir_all(&temporary_project);
        return Err(error);
    }

    if project_root.exists() {
        std::fs::remove_dir_all(&project_root)
            .map_err(|error| format!("não foi possível substituir o projeto WDA: {error}"))?;
    }
    std::fs::rename(&temporary_project, &project_root)
        .map_err(|error| format!("não foi possível finalizar o staging do WDA: {error}"))?;
    if let Err(error) = enforce_wda_loopback_binding(&project_root) {
        let _ = std::fs::remove_dir_all(&project_root);
        return Err(error);
    }
    if derived_data.exists() {
        std::fs::remove_dir_all(&derived_data)
            .map_err(|error| format!("não foi possível invalidar o DerivedData do WDA: {error}"))?;
    }
    std::fs::create_dir_all(&derived_data)
        .map_err(|error| format!("não foi possível criar o DerivedData do WDA: {error}"))?;

    let temporary_digest = staging_root.join(format!("{WDA_SOURCE_DIGEST_FILE}.tmp"));
    std::fs::write(&temporary_digest, &digest)
        .map_err(|error| format!("não foi possível registrar a versão do WDA: {error}"))?;
    if digest_path.exists() {
        std::fs::remove_file(&digest_path)
            .map_err(|error| format!("não foi possível atualizar o registro do WDA: {error}"))?;
    }
    std::fs::rename(&temporary_digest, &digest_path)
        .map_err(|error| format!("não foi possível finalizar o registro do WDA: {error}"))?;

    Ok(WdaStagedPaths {
        project,
        derived_data,
    })
}

fn copy_wda_directory(source: &Path, target: &Path) -> Result<(), String> {
    std::fs::create_dir_all(target)
        .map_err(|error| format!("não foi possível criar a cópia temporária do WDA: {error}"))?;
    let mut entries = std::fs::read_dir(source)
        .map_err(|error| format!("não foi possível listar o projeto WDA: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("não foi possível listar o projeto WDA: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let metadata = std::fs::symlink_metadata(&source_path)
            .map_err(|error| format!("não foi possível ler um arquivo do WDA: {error}"))?;
        if metadata.is_dir() {
            copy_wda_directory(&source_path, &target_path)?;
        } else if metadata.is_file() {
            std::fs::copy(&source_path, &target_path)
                .map_err(|error| format!("não foi possível copiar o WDA: {error}"))?;
        } else {
            return Err(format!(
                "o projeto WDA contém um tipo de arquivo não suportado: {}",
                source_path.display()
            ));
        }
    }
    Ok(())
}

fn enforce_wda_loopback_binding(project_root: &Path) -> Result<(), String> {
    let source = project_root.join(WDA_LOOPBACK_SOURCE_FILE);
    let contents = std::fs::read_to_string(&source).map_err(|error| {
        format!(
            "não foi possível verificar o bind loopback do WDA em {}: {error}",
            source.display()
        )
    })?;
    if contents.contains(WDA_LOOPBACK_BIND_CALL) {
        return Ok(());
    }
    if contents.matches(WDA_UNSAFE_BIND_CALL).count() != 1 {
        return Err(
            "a versão do WDA não expõe o ponto de bind esperado; MJPEG foi desabilitado por segurança"
                .to_string(),
        );
    }
    let patched = contents.replace(WDA_UNSAFE_BIND_CALL, WDA_LOOPBACK_BIND_CALL);
    std::fs::write(&source, patched)
        .map_err(|error| format!("não foi possível restringir o bind MJPEG ao loopback: {error}"))
}

fn wda_source_digest(source: &Path) -> Result<String, String> {
    let mut digest = Sha256::new();
    update_wda_digest(source, Path::new(""), &mut digest)?;
    Ok(format!("{:x}", digest.finalize()))
}

fn update_wda_digest(
    directory: &Path,
    relative_directory: &Path,
    digest: &mut Sha256,
) -> Result<(), String> {
    let mut entries = std::fs::read_dir(directory)
        .map_err(|error| format!("não foi possível ler o projeto WDA: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("não foi possível ler o projeto WDA: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let relative = relative_directory.join(entry.file_name());
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("não foi possível ler um arquivo do WDA: {error}"))?;
        if metadata.is_dir() {
            digest.update(b"D");
            digest.update(relative.to_string_lossy().as_bytes());
            digest.update([0]);
            update_wda_digest(&path, &relative, digest)?;
        } else if metadata.is_file() {
            let bytes = std::fs::read(&path)
                .map_err(|error| format!("não foi possível ler um arquivo do WDA: {error}"))?;
            digest.update(b"F");
            digest.update(relative.to_string_lossy().as_bytes());
            digest.update([0]);
            digest.update((bytes.len() as u64).to_le_bytes());
            digest.update(bytes);
        } else {
            return Err(format!(
                "o projeto WDA contém um tipo de arquivo não suportado: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn validate_fallback_fps(fps: f64) -> Result<f64, String> {
    if fps.is_finite() && (MIN_FALLBACK_FPS..=MAX_FALLBACK_FPS).contains(&fps) {
        Ok(fps)
    } else {
        Err(format!(
            "A taxa do fallback deve estar entre {MIN_FALLBACK_FPS} e {MAX_FALLBACK_FPS} fps."
        ))
    }
}

fn normalized_to_wda_point(
    point: NormalizedPoint,
    window: WdaWindowSize,
) -> Result<WdaPoint, String> {
    if !point.x.is_finite()
        || !point.y.is_finite()
        || !(0.0..=1.0).contains(&point.x)
        || !(0.0..=1.0).contains(&point.y)
        || !window.width.is_finite()
        || !window.height.is_finite()
        || window.width <= 0.0
        || window.height <= 0.0
    {
        return Err("As coordenadas do simulador devem estar entre 0 e 1.".to_string());
    }
    Ok(WdaPoint {
        x: point.x * window.width,
        y: point.y * window.height,
    })
}

fn validate_input_text(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Err("O texto não pode estar vazio.".to_string());
    }
    if text.chars().count() > 4_000 {
        return Err("Cada entrada de texto aceita no máximo 4.000 caracteres.".to_string());
    }
    Ok(())
}

fn detect_requirements(runner: &dyn CommandRunner) -> IosSimulatorRequirements {
    let mut requirements = IosSimulatorRequirements {
        ready: false,
        issue: None,
        xcode_version: None,
        devices: Vec::new(),
        attached_udid: None,
        stream_fps: None,
        fallback_fps: None,
        source: None,
        effective_fps: None,
        lifecycle: IosSimulatorLifecycleSnapshot::default(),
    };

    if !cfg!(target_os = "macos") {
        requirements.issue = Some(IosSimulatorIssue::UnsupportedPlatform);
        return requirements;
    }

    let xcode = match runner.run("xcodebuild", &["-version".into()]) {
        Ok(output) if output.success => output,
        _ => {
            requirements.issue = Some(IosSimulatorIssue::XcodeMissing);
            return requirements;
        }
    };
    let Some(xcode_version) = parse_xcode_version(&xcode.stdout) else {
        requirements.issue = Some(IosSimulatorIssue::DiscoveryFailed);
        return requirements;
    };
    let Some(major) = xcode_major(&xcode_version) else {
        requirements.issue = Some(IosSimulatorIssue::DiscoveryFailed);
        return requirements;
    };
    requirements.xcode_version = Some(xcode_version);
    if major != 26 && major != 27 {
        requirements.issue = Some(IosSimulatorIssue::UnsupportedXcode);
        return requirements;
    }

    match runner.run("xcrun", &["--find".into(), "simctl".into()]) {
        Ok(output) if output.success => {}
        _ => {
            requirements.issue = Some(IosSimulatorIssue::SimctlMissing);
            return requirements;
        }
    }

    let output = match run_simctl(
        runner,
        &[
            "list".into(),
            "devices".into(),
            "available".into(),
            "--json".into(),
        ],
    ) {
        Ok(output) if output.success => output,
        _ => {
            requirements.issue = Some(IosSimulatorIssue::DiscoveryFailed);
            return requirements;
        }
    };
    let devices = match parse_simctl_devices(&output.stdout) {
        Ok(devices) => devices,
        Err(_) => {
            requirements.issue = Some(IosSimulatorIssue::DiscoveryFailed);
            return requirements;
        }
    };
    if devices.is_empty() {
        requirements.issue = Some(IosSimulatorIssue::SimulatorsMissing);
        return requirements;
    }
    requirements.ready = true;
    requirements.devices = devices;
    requirements
}

fn parse_xcode_version(stdout: &[u8]) -> Option<String> {
    String::from_utf8_lossy(stdout).lines().find_map(|line| {
        line.strip_prefix("Xcode ")
            .map(str::trim)
            .map(str::to_string)
    })
}

fn xcode_major(version: &str) -> Option<u32> {
    version.split('.').next()?.parse().ok()
}

#[derive(Debug, Deserialize)]
struct SimctlDevicesResponse {
    devices: HashMap<String, Vec<SimctlDevice>>,
}

#[derive(Debug, Deserialize)]
struct SimctlDevice {
    name: String,
    udid: String,
    state: String,
    #[serde(rename = "deviceTypeIdentifier")]
    device_type_identifier: String,
    #[serde(rename = "isAvailable", default = "default_available")]
    is_available: bool,
}

fn default_available() -> bool {
    true
}

fn parse_simctl_devices(stdout: &[u8]) -> Result<Vec<IosSimulatorDevice>, String> {
    let response: SimctlDevicesResponse =
        serde_json::from_slice(stdout).map_err(|error| error.to_string())?;
    let mut devices = Vec::new();
    for (runtime, runtime_devices) in response.devices {
        let Some(version) = simctl_runtime_version(&runtime) else {
            continue;
        };
        for device in runtime_devices {
            if !device.is_available {
                continue;
            }
            devices.push(IosSimulatorDevice {
                name: device.name,
                udid: device.udid,
                state: device.state,
                ios_version: version.clone(),
                family: simulator_device_family(&device.device_type_identifier)?,
            });
        }
    }
    devices.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(left.ios_version.cmp(&right.ios_version))
    });
    Ok(devices)
}

fn simctl_runtime_version(runtime: &str) -> Option<String> {
    ["SimRuntime.iOS-", "SimRuntime.iPadOS-"]
        .into_iter()
        .find_map(|prefix| runtime.split(prefix).nth(1))
        .map(|version| version.replace('-', "."))
}

fn simulator_device_family(identifier: &str) -> Result<IosSimulatorDeviceFamily, String> {
    if identifier.contains("iPhone") {
        Ok(IosSimulatorDeviceFamily::Iphone)
    } else if identifier.contains("iPad") {
        Ok(IosSimulatorDeviceFamily::Ipad)
    } else {
        Err(format!(
            "tipo de simulador não reconhecido pelo Verboo: {identifier}"
        ))
    }
}

fn simulator_display_metrics(
    runner: &dyn CommandRunner,
    udid: &str,
) -> Result<SimctlDisplayMetrics, SimulatorDisplayError> {
    let output =
        run_simctl(runner, &["io".into(), udid.into(), "enumerate".into()]).map_err(|message| {
            SimulatorDisplayError {
                kind: SimulatorDisplayErrorKind::CommandFailed,
                message,
            }
        })?;
    parse_simctl_display_metrics(&output.stdout)
}

fn wait_for_target_display_metrics(
    runner: &dyn CommandRunner,
    udid: &str,
    target: WdaInterfaceOrientation,
    deadline: Instant,
    ios27: bool,
) -> Result<SimctlDisplayMetrics, SimulatorDisplayError> {
    let mut last_error = None;
    while Instant::now() < deadline {
        match simulator_display_metrics(runner, udid) {
            Ok(metrics) if metrics.interface_orientation == target => return Ok(metrics),
            Ok(metrics) => {
                last_error = Some(display_error(
                    SimulatorDisplayErrorKind::InvalidDisplayMetrics,
                    &format!(
                        "a tela integrada ainda está em {:?}, não em {:?}",
                        metrics.interface_orientation, target
                    ),
                ));
            }
            Err(error) if error.kind.is_retryable() => {
                if ios27 && error.kind == SimulatorDisplayErrorKind::AmbiguousOrientation {
                    // iOS 27 reports the integrated display orientation as
                    // Ambiguous permanently (measured via `simctl io
                    // enumerate`). Waiting out the deadline would burn the
                    // whole WDA_READY_TIMEOUT on a state that never changes
                    // — return immediately so the caller can report the
                    // runtime limitation to the user.
                    return Err(display_error(
                        SimulatorDisplayErrorKind::AmbiguousOrientation,
                        "a verificação de orientação da tela integrada não é suportada neste runtime (iOS 27) — limitação do runtime; a rotação foi enviada, mas a confirmação fica pendente",
                    ));
                }
                last_error = Some(error);
            }
            Err(error) => return Err(error),
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if !remaining.is_zero() {
            thread::sleep(Duration::from_millis(100).min(remaining));
        }
    }
    Err(last_error.unwrap_or_else(|| {
        display_error(
            SimulatorDisplayErrorKind::AmbiguousOrientation,
            "a tela integrada não confirmou a rotação dentro do prazo",
        )
    }))
}

fn parse_simctl_display_metrics(
    stdout: &[u8],
) -> Result<SimctlDisplayMetrics, SimulatorDisplayError> {
    let output = String::from_utf8_lossy(stdout);
    let lines = output.lines().collect::<Vec<_>>();
    let integrated_index = lines
        .iter()
        .position(|line| line.trim() == "Screen Type: Integrated")
        .ok_or_else(|| {
            display_error(
                SimulatorDisplayErrorKind::IntegratedDisplayUnavailable,
                "o simctl não informou a tela integrada do simulador",
            )
        })?;
    let block_start = (0..=integrated_index)
        .rev()
        .find(|index| is_simctl_screen_header(lines[*index]))
        .ok_or_else(|| {
            display_error(
                SimulatorDisplayErrorKind::IntegratedDisplayUnavailable,
                "o simctl retornou uma tela integrada incompleta",
            )
        })?;
    let block_end = ((integrated_index + 1)..lines.len())
        .find(|index| is_simctl_screen_header(lines[*index]))
        .unwrap_or(lines.len());
    let block = &lines[block_start..block_end];

    let pixel_size = block
        .iter()
        .find_map(|line| line.trim().strip_prefix("Pixel Size:"))
        .and_then(parse_simctl_pixel_size)
        .ok_or_else(|| {
            display_error(
                SimulatorDisplayErrorKind::InvalidDisplayMetrics,
                "o simctl não informou o tamanho da tela integrada",
            )
        })?;
    let scale = block
        .iter()
        .find_map(|line| line.trim().strip_prefix("Preferred UI Scale:"))
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| {
            display_error(
                SimulatorDisplayErrorKind::InvalidDisplayMetrics,
                "o simctl informou uma escala de tela inválida",
            )
        })?;
    let orientation_value = block
        .iter()
        .find_map(|line| line.trim().strip_prefix("UI Orientation:"))
        .map(str::trim);
    let interface_orientation = match orientation_value {
        None => {
            return Err(display_error(
                SimulatorDisplayErrorKind::AmbiguousOrientation,
                "o simctl não informou a orientação da tela integrada",
            ));
        }
        Some(value) => match parse_simctl_orientation(value) {
            Some(orientation) => orientation,
            None if value.eq_ignore_ascii_case("ambiguous") => {
                return Err(display_error(
                    SimulatorDisplayErrorKind::AmbiguousOrientation,
                    "a orientação da tela integrada ainda está ambígua",
                ));
            }
            None => {
                return Err(display_error(
                    SimulatorDisplayErrorKind::InvalidDisplayMetrics,
                    "o simctl informou uma orientação de tela inválida",
                ));
            }
        },
    };

    let (pixel_width, pixel_height) = if interface_orientation.is_landscape() {
        (
            pixel_size.1.max(pixel_size.0),
            pixel_size.1.min(pixel_size.0),
        )
    } else {
        (
            pixel_size.0.min(pixel_size.1),
            pixel_size.0.max(pixel_size.1),
        )
    };
    let window_size = WdaWindowSize {
        width: pixel_width / scale,
        height: pixel_height / scale,
    };
    if !window_size.width.is_finite()
        || !window_size.height.is_finite()
        || window_size.width <= 0.0
        || window_size.height <= 0.0
    {
        return Err(display_error(
            SimulatorDisplayErrorKind::InvalidDisplayMetrics,
            "o simctl informou dimensões de tela inválidas",
        ));
    }
    Ok(SimctlDisplayMetrics {
        window_size,
        interface_orientation,
    })
}

fn display_error(kind: SimulatorDisplayErrorKind, message: &str) -> SimulatorDisplayError {
    SimulatorDisplayError {
        kind,
        message: message.to_string(),
    }
}

fn is_simctl_screen_header(line: &str) -> bool {
    let line = line.trim();
    line.starts_with('(') && line.ends_with(':') && line.contains(") ")
}

fn parse_simctl_pixel_size(value: &str) -> Option<(f64, f64)> {
    let value = value.trim().strip_prefix('{')?.strip_suffix('}')?;
    let (width, height) = value.split_once(',')?;
    let width = width.trim().parse::<f64>().ok()?;
    let height = height.trim().parse::<f64>().ok()?;
    (width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0)
        .then_some((width, height))
}

fn parse_simctl_orientation(value: &str) -> Option<WdaInterfaceOrientation> {
    match value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase()
        .as_str()
    {
        "portrait" => Some(WdaInterfaceOrientation::Portrait),
        "portraitupsidedown" => Some(WdaInterfaceOrientation::PortraitUpsideDown),
        "landscapeleft" => Some(WdaInterfaceOrientation::LandscapeLeft),
        "landscaperight" => Some(WdaInterfaceOrientation::LandscapeRight),
        _ => None,
    }
}

fn run_simctl(runner: &dyn CommandRunner, args: &[String]) -> Result<CommandOutput, String> {
    let mut command_args = Vec::with_capacity(args.len() + 1);
    command_args.push("simctl".into());
    command_args.extend(args.iter().cloned());
    let output = runner.run("xcrun", &command_args)?;
    if output.success {
        Ok(output)
    } else {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if message.is_empty() {
            "O simctl não conseguiu completar a operação.".to_string()
        } else {
            message
        })
    }
}

fn spawn_capture_loop(
    runner: Arc<dyn CommandRunner>,
    udid: String,
    rate: Arc<Mutex<f64>>,
    stop: Arc<AtomicBool>,
    mjpeg_active: Arc<AtomicBool>,
    stats: Arc<Mutex<StreamStats>>,
    device_generation: u64,
    latest_frame: Arc<Mutex<Option<LatestFrame>>>,
    next_frame_generation: Arc<AtomicU64>,
    sink: Arc<dyn FrameSink>,
) -> JoinHandle<()> {
    spawn_capture_loop_internal(
        runner,
        udid,
        rate,
        stop,
        mjpeg_active,
        stats,
        device_generation,
        latest_frame,
        next_frame_generation,
        sink,
        Arc::new(PreviewGate::new(true)),
        FIRST_FRAME_TIMEOUT,
        FIRST_FRAME_RETRY,
        None,
        None,
    )
}

fn spawn_capture_loop_internal(
    runner: Arc<dyn CommandRunner>,
    udid: String,
    rate: Arc<Mutex<f64>>,
    stop: Arc<AtomicBool>,
    mjpeg_active: Arc<AtomicBool>,
    stats: Arc<Mutex<StreamStats>>,
    device_generation: u64,
    latest_frame: Arc<Mutex<Option<LatestFrame>>>,
    next_frame_generation: Arc<AtomicU64>,
    sink: Arc<dyn FrameSink>,
    gate: Arc<PreviewGate>,
    first_frame_timeout: Duration,
    first_frame_retry: Duration,
    lifecycle: Option<Arc<LifecycleAuthority>>,
    lifecycle_emitter: Option<LifecycleEmitter>,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("verboo-ios-simctl".into())
        .spawn(move || {
            let mut meter = FrameRateMeter::default();
            let mut measured_source = None;
            let first_frame_deadline = Instant::now() + first_frame_timeout;
            let mut first_frame_ready = false;
            loop {
                if !gate.wait_until_visible(&stop) {
                    break;
                }
                if stop.load(Ordering::Acquire) {
                    break;
                }
                if mjpeg_active.load(Ordering::Acquire) {
                    switch_meter_source(
                        &mut meter,
                        &mut measured_source,
                        IosSimulatorStreamSource::Mjpeg,
                    );
                    thread::sleep(Duration::from_millis(50));
                    continue;
                }
                // The first fallback frame starts a new measurement window.
                // Otherwise its elapsed time includes the whole MJPEG
                // interval and reports a fake near-zero FPS.
                switch_meter_source(
                    &mut meter,
                    &mut measured_source,
                    IosSimulatorStreamSource::Simctl,
                );
                let started = Instant::now();
                let capture_runner = runner.clone();
                let capture_udid = udid.clone();
                let result = capture_screenshot(capture_runner.as_ref(), &capture_udid);
                if stop.load(Ordering::Acquire) {
                    break;
                }
                match result {
                    Ok(bytes) => {
                        first_frame_ready = true;
                        if let Some(lifecycle) = lifecycle.as_ref() {
                            let accepted = lifecycle
                                .transition(device_generation, LifecycleSignal::FirstFrameReady);
                            if accepted {
                                if let Some(emitter) = lifecycle_emitter.as_ref() {
                                    emitter();
                                }
                            }
                        }
                        let effective_fps = meter.observe();
                        set_stream_stats(&stats, IosSimulatorStreamSource::Simctl, effective_fps);
                        sink.frame(frame_from_bytes(
                            &udid,
                            bytes,
                            "image/png",
                            IosSimulatorStreamSource::Simctl,
                            effective_fps,
                            device_generation,
                            &latest_frame,
                            &next_frame_generation,
                        ));
                    }
                    Err(message) => {
                        if !first_frame_ready && Instant::now() < first_frame_deadline {
                            if first_frame_retry.is_zero() {
                                thread::yield_now();
                            } else {
                                thread::sleep(first_frame_retry);
                            }
                            continue;
                        }
                        sink.error(IosSimulatorError {
                            udid: udid.clone(),
                            message,
                        });
                        break;
                    }
                }
                let fps = *rate.lock().expect("iOS simulator rate poisoned");
                let interval = Duration::from_secs_f64(1.0 / fps);
                let elapsed = started.elapsed();
                if elapsed < interval {
                    thread::sleep(interval - elapsed);
                }
            }
        })
        .expect("não foi possível iniciar o loop do simctl")
}

#[cfg(test)]
struct CaptureWorkerHandle {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

#[cfg(test)]
impl CaptureWorkerHandle {
    fn stop_and_join(mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

#[cfg(test)]
fn spawn_capture_loop_with_first_frame_policy(
    runner: Arc<dyn CommandRunner>,
    sink: Arc<dyn FrameSink>,
    timeout: Duration,
    retry_interval: Duration,
) -> CaptureWorkerHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let worker = spawn_capture_loop_internal(
        runner,
        "phone-17-pro".to_string(),
        Arc::new(Mutex::new(DEFAULT_FALLBACK_FPS)),
        stop.clone(),
        Arc::new(AtomicBool::new(false)),
        Arc::new(Mutex::new(StreamStats {
            source: IosSimulatorStreamSource::Simctl,
            effective_fps: None,
        })),
        1,
        Arc::new(Mutex::new(None)),
        Arc::new(AtomicU64::new(0)),
        sink,
        Arc::new(PreviewGate::new(true)),
        timeout,
        retry_interval,
        None,
        None,
    );
    CaptureWorkerHandle {
        stop,
        worker: Some(worker),
    }
}

fn spawn_display_readiness_worker(
    runner: Arc<dyn CommandRunner>,
    udid: String,
    stop: Arc<AtomicBool>,
    device_generation: u64,
    lifecycle: Arc<LifecycleAuthority>,
    lifecycle_emitter: LifecycleEmitter,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("verboo-ios-display-readiness".into())
        .spawn(move || {
            if stop.load(Ordering::Acquire) {
                return;
            }
            match wait_for_display_metrics(
                runner.as_ref(),
                &udid,
                WDA_READY_TIMEOUT,
                Duration::from_millis(100),
            ) {
                Ok(_) => {
                    if lifecycle.transition(device_generation, LifecycleSignal::DisplayReady) {
                        lifecycle_emitter();
                    }
                }
                Err(error) if !stop.load(Ordering::Acquire) => {
                    if lifecycle.transition(
                        device_generation,
                        LifecycleSignal::InteractionFailed(error.message),
                    ) {
                        lifecycle_emitter();
                    }
                }
                Err(_) => {}
            }
        })
        .expect("não foi possível iniciar a prontidão da tela do simulador")
}

fn spawn_wda_worker(
    runner: Arc<dyn CommandRunner>,
    launcher: Arc<dyn WdaLauncher>,
    wda_client: Arc<dyn WdaClient>,
    staged_wda: WdaStagedPaths,
    udid: String,
    display_metrics: Option<SimctlDisplayMetrics>,
    lifecycle: Arc<LifecycleAuthority>,
    lifecycle_emitter: LifecycleEmitter,
    gate: Arc<PreviewGate>,
    stream_profile: Arc<Mutex<StreamProfile>>,
    stop: Arc<AtomicBool>,
    mjpeg_active: Arc<AtomicBool>,
    stats: Arc<Mutex<StreamStats>>,
    device_generation: u64,
    latest_frame: Arc<Mutex<Option<LatestFrame>>>,
    next_frame_generation: Arc<AtomicU64>,
    wda_force_stop: Arc<Mutex<Option<WdaForceStop>>>,
    wda_control: Arc<Mutex<Option<WdaControlHandle>>>,
    sink: Arc<dyn FrameSink>,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("verboo-ios-wda".into())
        .spawn(move || {
            let display_metrics = match display_metrics {
                Some(metrics) => metrics,
                None => match wait_for_display_metrics(
                    runner.as_ref(),
                    &udid,
                    WDA_READY_TIMEOUT,
                    Duration::from_millis(100),
                ) {
                    Ok(metrics) => {
                        if lifecycle.transition(device_generation, LifecycleSignal::DisplayReady) {
                            lifecycle_emitter();
                        }
                        metrics
                    }
                    Err(error) => {
                        if !stop.load(Ordering::Acquire)
                            && lifecycle.transition(
                                device_generation,
                                LifecycleSignal::InteractionFailed(error.message),
                            )
                        {
                            lifecycle_emitter();
                        }
                        return;
                    }
                },
            };
            let (http_port, mjpeg_port) = match allocate_loopback_ports() {
                Ok(ports) => ports,
                Err(message) => {
                    mark_interaction_failure(
                        &lifecycle,
                        device_generation,
                        &message,
                        &lifecycle_emitter,
                    );
                    emit_wda_fallback_error(&sink, &udid, message);
                    return;
                }
            };
            let spec = build_wda_launch_spec(staged_wda, &udid, http_port, mjpeg_port);
            if stop.load(Ordering::Acquire) {
                return;
            }
            let WdaProcessHandle { mut process } =
                match launcher.launch(&spec, stop.as_ref(), wda_force_stop.as_ref()) {
                    Ok(process) => process,
                    Err(message) => {
                        if !stop.load(Ordering::Acquire) {
                            mark_interaction_failure(
                                &lifecycle,
                                device_generation,
                                &message,
                                &lifecycle_emitter,
                            );
                            emit_wda_fallback_error(&sink, &udid, message);
                        }
                        return;
                    }
                };
            if stop.load(Ordering::Acquire) {
                process.stop();
                let _ = wda_force_stop
                    .lock()
                    .expect("iOS simulator WDA control poisoned")
                    .take();
                return;
            }

            let base_url = format!("http://127.0.0.1:{http_port}");
            if let Err(message) = wait_for_wda_or_stop(
                wda_client.as_ref(),
                &base_url,
                stop.as_ref(),
                Instant::now() + WDA_READY_TIMEOUT,
            ) {
                if !stop.load(Ordering::Acquire) {
                    mark_interaction_failure(
                        &lifecycle,
                        device_generation,
                        &message,
                        &lifecycle_emitter,
                    );
                    emit_wda_fallback_error(&sink, &udid, message);
                }
                process.stop();
                let _ = wda_force_stop
                    .lock()
                    .expect("iOS simulator WDA control poisoned")
                    .take();
                return;
            }
            let control_handle = WdaControlHandle {
                base_url,
                window_size: display_metrics.window_size,
                orientation: display_metrics.interface_orientation,
            };
            let configured_profile = *stream_profile
                .lock()
                .expect("iOS simulator stream profile poisoned");
            if let Err(message) =
                wda_client.apply_stream_settings(&control_handle, configured_profile)
            {
                if !stop.load(Ordering::Acquire) {
                    mark_interaction_failure(
                        &lifecycle,
                        device_generation,
                        &message,
                        &lifecycle_emitter,
                    );
                    emit_wda_fallback_error(&sink, &udid, message);
                }
                process.stop();
                let _ = wda_force_stop
                    .lock()
                    .expect("iOS simulator WDA control poisoned")
                    .take();
                return;
            }
            {
                // Serialize publication with set_stream_rate_sync. A profile
                // chosen during WDA startup is either observed here or sees
                // the published handle and applies itself immediately.
                let mut active = wda_control
                    .lock()
                    .expect("iOS simulator WDA control poisoned");
                let latest_profile = *stream_profile
                    .lock()
                    .expect("iOS simulator stream profile poisoned");
                if latest_profile != configured_profile {
                    if let Err(message) =
                        wda_client.apply_stream_settings(&control_handle, latest_profile)
                    {
                        if !stop.load(Ordering::Acquire) {
                            mark_interaction_failure(
                                &lifecycle,
                                device_generation,
                                &message,
                                &lifecycle_emitter,
                            );
                            emit_wda_fallback_error(&sink, &udid, message);
                        }
                        process.stop();
                        let _ = wda_force_stop
                            .lock()
                            .expect("iOS simulator WDA control poisoned")
                            .take();
                        return;
                    }
                }
                *active = Some(control_handle.clone());
            }
            if stop.load(Ordering::Acquire) {
                let _ = wda_control
                    .lock()
                    .expect("iOS simulator WDA control poisoned")
                    .take();
                process.stop();
                let _ = wda_force_stop
                    .lock()
                    .expect("iOS simulator WDA control poisoned")
                    .take();
                return;
            }
            if lifecycle.transition(device_generation, LifecycleSignal::InteractionReady) {
                lifecycle_emitter();
            }
            let mut stream = None;
            let mut buffer = Vec::new();
            let mut meter = FrameRateMeter::default();
            let mut activated = false;

            while !stop.load(Ordering::Acquire) {
                if !gate.is_visible() {
                    stream.take();
                    if mjpeg_active.swap(false, Ordering::AcqRel) {
                        set_stream_stats(&stats, IosSimulatorStreamSource::Simctl, None);
                    }
                    if !gate.wait_until_visible(&stop) {
                        break;
                    }
                    continue;
                }
                match process.try_wait() {
                    Ok(Some(status)) => {
                        if !stop.load(Ordering::Acquire) {
                            emit_wda_fallback_error(
                                &sink,
                                &udid,
                                format!("o runner do WDA encerrou antes do vídeo ({status})"),
                            );
                        }
                        break;
                    }
                    Ok(None) => {}
                    Err(message) => {
                        emit_wda_fallback_error(
                            &sink,
                            &udid,
                            format!("não foi possível verificar o runner do WDA: {message}"),
                        );
                        break;
                    }
                }

                if stream.is_none() {
                    match TcpStream::connect_timeout(
                        &SocketAddr::from(([127, 0, 0, 1], mjpeg_port)),
                        MJPEG_CONNECT_RETRY,
                    ) {
                        Ok(mut candidate) => {
                            if let Err(error) = send_mjpeg_request(&mut candidate) {
                                emit_wda_fallback_error(&sink, &udid, error);
                                break;
                            }
                            if let Err(error) = candidate.set_read_timeout(Some(MJPEG_READ_TIMEOUT))
                            {
                                emit_wda_fallback_error(
                                    &sink,
                                    &udid,
                                    format!("não foi possível configurar o vídeo MJPEG: {error}"),
                                );
                                break;
                            }
                            stream = Some(candidate);
                        }
                        Err(_) => {
                            thread::sleep(MJPEG_CONNECT_RETRY);
                            continue;
                        }
                    }
                }

                let read_result =
                    read_mjpeg_frame(stream.as_mut().expect("MJPEG stream"), &mut buffer);
                match read_result {
                    Ok(Some(bytes)) => {
                        if !activated {
                            // Set the flag immediately before the first WDA
                            // frame. The renderer still owns the simctl image;
                            // nothing here clears it during the handoff.
                            mjpeg_active.store(true, Ordering::Release);
                            activated = true;
                        }
                        let effective_fps = meter.observe();
                        set_stream_stats(&stats, IosSimulatorStreamSource::Mjpeg, effective_fps);
                        sink.frame(frame_from_bytes(
                            &udid,
                            bytes,
                            "image/jpeg",
                            IosSimulatorStreamSource::Mjpeg,
                            effective_fps,
                            device_generation,
                            &latest_frame,
                            &next_frame_generation,
                        ));
                    }
                    Ok(None) => {}
                    Err(message) => {
                        if !stop.load(Ordering::Acquire) {
                            mjpeg_active.store(false, Ordering::Release);
                            set_stream_stats(&stats, IosSimulatorStreamSource::Simctl, None);
                            emit_wda_fallback_error(&sink, &udid, message);
                        }
                        break;
                    }
                }
            }
            // The transport is sessionless, so xcodebuild interruption is the
            // only XCTest lifecycle operation during detach.
            let _ = wda_control
                .lock()
                .expect("iOS simulator WDA control poisoned")
                .take();
            process.stop();
            let _ = wda_force_stop
                .lock()
                .expect("iOS simulator WDA control poisoned")
                .take();
            mjpeg_active.store(false, Ordering::Release);
        })
        .expect("não foi possível iniciar o runner do WDA")
}

fn wait_for_wda_or_stop(
    client: &dyn WdaClient,
    base_url: &str,
    stop: &AtomicBool,
    deadline: Instant,
) -> Result<(), String> {
    let mut last_error = "o WDA ainda não respondeu".to_string();
    while Instant::now() < deadline {
        if stop.load(Ordering::Acquire) {
            return Err("inicialização do WDA cancelada".to_string());
        }
        let attempt_deadline = (Instant::now() + Duration::from_millis(150)).min(deadline);
        match client.wait_until_ready(base_url, attempt_deadline) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

fn emit_wda_fallback_error(sink: &Arc<dyn FrameSink>, udid: &str, message: String) {
    sink.error(IosSimulatorError {
        udid: udid.to_string(),
        message: format!("Vídeo MJPEG indisponível; usando o modo econômico: {message}"),
    });
}

fn mark_interaction_failure(
    lifecycle: &Arc<LifecycleAuthority>,
    device_generation: u64,
    message: &str,
    emitter: &LifecycleEmitter,
) {
    if lifecycle.transition(
        device_generation,
        LifecycleSignal::InteractionFailed(message.to_string()),
    ) {
        emitter();
    }
}

fn set_stream_stats(
    stats: &Arc<Mutex<StreamStats>>,
    source: IosSimulatorStreamSource,
    effective_fps: Option<f64>,
) {
    let mut current = stats.lock().expect("iOS simulator stats poisoned");
    current.source = source;
    current.effective_fps = effective_fps;
}

fn allocate_loopback_ports() -> Result<(u16, u16), String> {
    let http = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("não foi possível reservar a porta local do WDA: {error}"))?;
    let mjpeg = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("não foi possível reservar a porta local do MJPEG: {error}"))?;
    Ok((
        http.local_addr().map_err(|error| error.to_string())?.port(),
        mjpeg
            .local_addr()
            .map_err(|error| error.to_string())?
            .port(),
    ))
}

fn send_mjpeg_request(stream: &mut TcpStream) -> Result<(), String> {
    stream
        .write_all(b"GET / HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .map_err(|error| format!("não foi possível iniciar o vídeo MJPEG: {error}"))
}

fn read_mjpeg_frame(
    stream: &mut TcpStream,
    buffer: &mut Vec<u8>,
) -> Result<Option<Vec<u8>>, String> {
    let mut chunk = [0_u8; 32 * 1024];
    match stream.read(&mut chunk) {
        Ok(0) => return Err("o servidor MJPEG encerrou a conexão".to_string()),
        Ok(read) => buffer.extend_from_slice(&chunk[..read]),
        Err(error) if error.kind() == std::io::ErrorKind::TimedOut => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(None),
        Err(error) => return Err(format!("falha lendo o vídeo MJPEG: {error}")),
    }
    if buffer.len() > MAX_MJPEG_BUFFER {
        return Err("o vídeo MJPEG excedeu o limite de buffer".to_string());
    }
    Ok(extract_mjpeg_frame(buffer))
}

fn extract_mjpeg_frame(buffer: &mut Vec<u8>) -> Option<Vec<u8>> {
    let Some(start) = buffer.windows(2).position(|window| window == [0xff, 0xd8]) else {
        if buffer.len() > 1 {
            let last = *buffer.last().expect("buffer não vazio");
            buffer.clear();
            if last == 0xff {
                buffer.push(last);
            }
        }
        return None;
    };
    let Some(end_relative) = buffer[start + 2..]
        .windows(2)
        .position(|window| window == [0xff, 0xd9])
    else {
        if start > 0 {
            buffer.drain(..start);
        }
        return None;
    };
    let end = start + 2 + end_relative + 2;
    let frame = buffer[start..end].to_vec();
    buffer.drain(..end);
    Some(frame)
}

fn image_data_url(bytes: &[u8], media_type: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{media_type};base64,{encoded}")
}

fn frame_from_bytes(
    udid: &str,
    bytes: Vec<u8>,
    media_type: &'static str,
    source: IosSimulatorStreamSource,
    effective_fps: Option<f64>,
    device_generation: u64,
    latest_frame: &Arc<Mutex<Option<LatestFrame>>>,
    next_frame_generation: &Arc<AtomicU64>,
) -> IosSimulatorFrame {
    let frame_generation = next_frame_generation
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);
    let data_url = image_data_url(&bytes, media_type);
    *latest_frame
        .lock()
        .expect("iOS simulator latest frame poisoned") = Some(LatestFrame {
        device_generation,
        frame_generation,
        bytes,
        media_type,
    });
    IosSimulatorFrame {
        udid: udid.to_string(),
        data_url,
        device_generation,
        frame_generation,
        captured_at_ms: unix_time_ms(),
        source,
        effective_fps,
        agent_presence: None,
    }
}

fn capture_screenshot(runner: &dyn CommandRunner, udid: &str) -> Result<Vec<u8>, String> {
    let output_file = tempfile::Builder::new()
        .prefix("verboo-ios-simulator-")
        .suffix(".png")
        .tempfile()
        .map_err(|error| format!("não foi possível criar arquivo temporário: {error}"))?;
    let output_path = output_file.path().to_string_lossy().into_owned();
    let _output = run_simctl(
        runner,
        &[
            "io".into(),
            udid.into(),
            "screenshot".into(),
            "--display=internal".into(),
            output_path,
        ],
    )?;
    let bytes = std::fs::read(output_file.path())
        .map_err(|error| format!("não foi possível ler a captura do simulador: {error}"))?;
    if bytes.is_empty() {
        return Err("O simctl não produziu uma imagem válida.".to_string());
    }
    Ok(bytes)
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn issue_message(issue: &IosSimulatorIssue, xcode_version: Option<&str>) -> String {
    match issue {
        IosSimulatorIssue::UnsupportedPlatform => "O painel de simulador exige macOS.".to_string(),
        IosSimulatorIssue::XcodeMissing => "Xcode não foi encontrado. Instale o Xcode 26 ou 27 e selecione-o com xcode-select.".to_string(),
        IosSimulatorIssue::UnsupportedXcode => format!(
            "Xcode {} não é compatível. A F1 exige Xcode 26 ou 27.",
            xcode_version.unwrap_or("detectado"),
        ),
        IosSimulatorIssue::SimctlMissing => "O simctl não foi encontrado. Instale o Xcode completo e selecione-o com xcode-select.".to_string(),
        IosSimulatorIssue::SimulatorsMissing => "Nenhum simulador iOS disponível. Crie um simulador no Xcode e atualize esta lista.".to_string(),
        IosSimulatorIssue::DiscoveryFailed => "Não foi possível listar os simuladores. Verifique o Xcode selecionado e tente atualizar.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::media::RecordingProcess;
    use super::ownership::IosSimulatorOwnership;
    #[cfg(target_os = "macos")]
    use super::ownership::OwnershipPhase;
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Condvar, OnceLock};
    use std::thread::{self, sleep};

    const DEVICES_JSON: &str = r#"{
      "devices": {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
          {"name":"iPhone 17 Pro","udid":"phone-17-pro","state":"Shutdown","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"},
          {"name":"Unavailable","udid":"unavailable","state":"Shutdown","isAvailable":false,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"}
        ],
        "com.apple.CoreSimulator.SimRuntime.iPadOS-26-5": [
          {"name":"iPad Pro","udid":"ipad","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4"}
        ]
      }
    }"#;

    #[test]
    fn system_gestures_use_normalized_geometry_for_phone_and_ipad() {
        let phone = system_controls::system_gesture(
            system_controls::IosSimulatorSystemAction::AppSwitcher,
            IosSimulatorDeviceFamily::Iphone,
            WdaInterfaceOrientation::Portrait,
        )
        .unwrap();
        assert_eq!(phone.start, NormalizedPoint { x: 0.50, y: 0.98 });
        assert_eq!(phone.end, NormalizedPoint { x: 0.50, y: 0.62 });
        assert_eq!(phone.hold, Duration::from_millis(450));

        let notifications = system_controls::system_gesture(
            system_controls::IosSimulatorSystemAction::Notifications,
            IosSimulatorDeviceFamily::Ipad,
            WdaInterfaceOrientation::LandscapeRight,
        )
        .unwrap();
        let control_center = system_controls::system_gesture(
            system_controls::IosSimulatorSystemAction::ControlCenter,
            IosSimulatorDeviceFamily::Ipad,
            WdaInterfaceOrientation::LandscapeRight,
        )
        .unwrap();
        assert!(control_center.start.x > notifications.start.x);
        assert_eq!(control_center.start.y, 0.01);
        assert_eq!(
            system_controls::next_clockwise_orientation(
                WdaInterfaceOrientation::Portrait,
                IosSimulatorDeviceFamily::Iphone,
            ),
            WdaInterfaceOrientation::LandscapeRight,
        );
        assert_eq!(
            system_controls::next_clockwise_orientation(
                WdaInterfaceOrientation::LandscapeRight,
                IosSimulatorDeviceFamily::Iphone,
            ),
            WdaInterfaceOrientation::Portrait,
        );
        assert_eq!(
            system_controls::next_clockwise_orientation(
                WdaInterfaceOrientation::LandscapeRight,
                IosSimulatorDeviceFamily::Ipad,
            ),
            WdaInterfaceOrientation::PortraitUpsideDown,
        );
    }

    #[test]
    fn late_rotation_metrics_cannot_replace_a_newer_device_generation() {
        let client = Arc::new(BlockingRotateWdaClient::new());
        let service = service_with_active_wda_on_runner(client.clone(), Arc::new(RotationRunner));
        let rotating_service = service.clone();
        let rotation = thread::spawn(move || {
            rotating_service.system_action_sync(IosSimulatorSystemAction::RotateClockwise)
        });
        client.wait_for_rotate();

        let replacement_handle = WdaControlHandle {
            base_url: "http://127.0.0.1:8200".into(),
            window_size: WdaWindowSize {
                width: 500.0,
                height: 900.0,
            },
            orientation: WdaInterfaceOrientation::Portrait,
        };
        {
            let mut state = service.state.lock().unwrap();
            let session = state.session.as_mut().unwrap();
            session.device_generation = 2;
            *session.wda_control.lock().unwrap() = Some(replacement_handle.clone());
        }
        client.release_rotate();

        let error = rotation.join().unwrap().unwrap_err();
        assert!(error.contains("sessão anterior"));
        let state = service.state.lock().unwrap();
        let session = state.session.as_ref().unwrap();
        assert_eq!(
            *session.wda_control.lock().unwrap(),
            Some(replacement_handle),
        );
    }

    #[test]
    fn wait_for_ios27_ambiguous_returns_immediately_with_runtime_limitation() {
        let runner = SequencedDisplayRunner::repeating(AMBIGUOUS_DISPLAY);
        let error = wait_for_target_display_metrics(
            &runner,
            "phone-17-pro",
            WdaInterfaceOrientation::LandscapeRight,
            Instant::now() + Duration::from_secs(45),
            true,
        )
        .unwrap_err();
        assert_eq!(error.kind, SimulatorDisplayErrorKind::AmbiguousOrientation);
        assert!(
            error.message.contains("27"),
            "a mensagem deve citar o runtime 27: {}",
            error.message
        );
        assert_eq!(
            runner.enumerate_calls(),
            1,
            "o Ambiguous permanente do iOS 27 deve retornar sem esperar o deadline"
        );
    }

    #[test]
    fn rotate_on_ios26_succeeds_after_ambiguous_retries() {
        let client = Arc::new(OkWdaClient);
        let runner = SequencedDisplayRunner::new(vec![AMBIGUOUS_DISPLAY, LANDSCAPE_RIGHT_DISPLAY]);
        let service = service_with_active_wda_and_device(
            client,
            Arc::new(runner),
            test_device(),
        );
        service
            .system_action_sync(IosSimulatorSystemAction::RotateClockwise)
            .unwrap();
        let state = service.state.lock().unwrap();
        let session = state.session.as_ref().unwrap();
        let handle = session.wda_control.lock().unwrap().as_ref().unwrap().clone();
        assert_eq!(
            handle.orientation,
            WdaInterfaceOrientation::LandscapeRight,
            "o handle deve refletir a orientação confirmada no iOS 26"
        );
    }

    #[test]
    fn rotate_on_ios27_ambiguous_reports_runtime_limitation() {
        let client = Arc::new(OkWdaClient);
        let runner = SequencedDisplayRunner::repeating(AMBIGUOUS_DISPLAY);
        let service = service_with_active_wda_and_device(
            client,
            Arc::new(runner),
            ios27_device(),
        );
        // O lifecycle precisa pertencer à geração da sessão para o
        // RecoverableError ser aceito pelo transition.
        service.lifecycle.begin(1, test_device(), IosSimulatorOwnership::External, true);
        let error = service
            .system_action_sync(IosSimulatorSystemAction::RotateClockwise)
            .unwrap_err();
        assert!(
            error.contains("27"),
            "o erro deve citar o runtime 27: {error}"
        );
        assert!(
            error.contains("limitação") || error.contains("limitation"),
            "o erro deve dizer que é limitação do runtime: {error}"
        );
        assert!(
            service.lifecycle.snapshot().recoverable_error.is_some(),
            "o recoverableError do lifecycle deve carregar a mensagem de limitação"
        );
    }

    #[test]
    fn capture_screen_propagates_media_backend_error() {
        let mut service = service_with_active_wda_on_runner(
            Arc::new(NoopWdaClient),
            Arc::new(RecordingRunner::new()),
        );
        service.media_backend = Arc::new(FailingMediaBackend);
        let error = service
            .capture_screen_sync(Path::new("/tmp/verboo-desktop-test"))
            .unwrap_err();
        assert!(
            error.contains("Mesa foi negada"),
            "o erro do backend (TCC/Mesa) deve subir até o renderer, não ser engolido: {error}"
        );
    }

    #[derive(Default)]
    struct RecordingRunner {
        calls: Mutex<Vec<(String, Vec<String>)>>,
        xcode_available: bool,
        xcode_version: String,
        booted: bool,
        xcodebuild_path: Option<String>,
    }

    impl RecordingRunner {
        fn new() -> Self {
            Self {
                xcode_available: true,
                xcode_version: "27.0".into(),
                booted: false,
                ..Self::default()
            }
        }

        #[cfg(target_os = "macos")]
        fn booted() -> Self {
            Self {
                booted: true,
                ..Self::new()
            }
        }
    }

    #[cfg(target_os = "macos")]
    struct ReconciliationRunner {
        calls: Mutex<Vec<(String, Vec<String>)>>,
        devices_json: String,
        shutdown_failures: HashSet<String>,
    }

    const AMBIGUOUS_DISPLAY: &[u8] = br#"
    (1) LCD:
        Screen Type: Integrated
        Pixel Size: {1206, 2622}
        Preferred UI Scale: 3
        UI Orientation: Ambiguous
"#;
    const PORTRAIT_DISPLAY: &[u8] = br#"
    (1) LCD:
        Screen Type: Integrated
        Pixel Size: {1206, 2622}
        Preferred UI Scale: 3
        UI Orientation: Portrait
"#;
    const LANDSCAPE_RIGHT_DISPLAY: &[u8] = br#"
    (1) LCD:
        Screen Type: Integrated
        Pixel Size: {2622, 1206}
        Preferred UI Scale: 3
        UI Orientation: Landscape Right
"#;
    const INVALID_DISPLAY_METRICS: &[u8] = br#"
    (1) LCD:
        Screen Type: Integrated
        Pixel Size: {1206, 2622}
        Preferred UI Scale: 0
        UI Orientation: Portrait
"#;

    struct SequencedDisplayRunner {
        outputs: Mutex<Vec<Vec<u8>>>,
        enumerate_calls: AtomicUsize,
    }

    impl SequencedDisplayRunner {
        fn new(outputs: Vec<&[u8]>) -> Self {
            Self {
                outputs: Mutex::new(outputs.into_iter().map(ToOwned::to_owned).collect()),
                enumerate_calls: AtomicUsize::new(0),
            }
        }

        fn repeating(output: &[u8]) -> Self {
            Self {
                outputs: Mutex::new(vec![output.to_vec()]),
                enumerate_calls: AtomicUsize::new(0),
            }
        }

        fn enumerate_calls(&self) -> usize {
            self.enumerate_calls.load(Ordering::Acquire)
        }
    }

    impl CommandRunner for SequencedDisplayRunner {
        fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, String> {
            if program == "xcrun"
                && args.starts_with(&["simctl".into(), "io".into()])
                && args.last().map(String::as_str) == Some("enumerate")
            {
                self.enumerate_calls.fetch_add(1, Ordering::AcqRel);
                let mut outputs = self.outputs.lock().unwrap();
                let bytes = if outputs.len() > 1 {
                    outputs.remove(0)
                } else {
                    outputs.first().cloned().unwrap_or_default()
                };
                return Ok(output(true, &bytes, b""));
            }
            Ok(output(true, b"", b""))
        }
    }

    struct SequencedCaptureRunner {
        responses: Mutex<Vec<Result<Vec<u8>, &'static str>>>,
    }

    impl SequencedCaptureRunner {
        fn new(responses: Vec<Result<Vec<u8>, &'static str>>) -> Self {
            Self {
                responses: Mutex::new(responses),
            }
        }
    }

    impl CommandRunner for SequencedCaptureRunner {
        fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, String> {
            if program == "xcrun"
                && args.starts_with(&["simctl".into(), "io".into()])
                && args.get(3).map(String::as_str) == Some("screenshot")
            {
                let response = self.responses.lock().unwrap().remove(0);
                return Ok(match response {
                    Ok(bytes) => {
                        let screenshot_path = args.last().expect("screenshot path");
                        assert!(
                            std::path::Path::new(screenshot_path).is_absolute(),
                            "fake write must use absolute path, got: {screenshot_path:?}"
                        );
                        std::fs::write(screenshot_path, bytes).unwrap();
                        output(true, b"", b"")
                    }
                    Err(message) => output(false, b"", message.as_bytes()),
                });
            }
            Ok(output(true, b"", b""))
        }
    }

    fn wait_until<F: Fn() -> bool>(condition: F, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        while !condition() && Instant::now() < deadline {
            sleep(Duration::from_millis(5));
        }
    }

    #[cfg(target_os = "macos")]
    impl ReconciliationRunner {
        fn new() -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                devices_json: r#"{
                  "devices": {
                    "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
                      {"name":"Owned Phone","udid":"owned-phone","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"},
                      {"name":"Owned Creating","udid":"owned-creating","state":"Creating","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"},
                      {"name":"Owned Shutdown","udid":"owned-shutdown","state":"Shutdown","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"},
                      {"name":"External","udid":"external","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"}
                    ]
                  }
                }"#
                .to_string(),
                shutdown_failures: HashSet::new(),
            }
        }

        fn with_shutdown_failures(udids: &[&str]) -> Self {
            let mut runner = Self::new();
            runner.shutdown_failures = udids.iter().map(|udid| (*udid).to_string()).collect();
            runner
        }

        fn calls(&self) -> Vec<(String, Vec<String>)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl RecordingRunner {
        fn calls(&self) -> Vec<(String, Vec<String>)> {
            self.calls.lock().unwrap().clone()
        }
    }

    struct OrderedCleanupRunner {
        inner: RecordingRunner,
        wda_stops: Arc<AtomicUsize>,
        shutdown_before_stop: Arc<AtomicBool>,
    }

    impl OrderedCleanupRunner {
        fn new(wda_stops: Arc<AtomicUsize>) -> (Self, Arc<AtomicBool>) {
            let shutdown_before_stop = Arc::new(AtomicBool::new(false));
            (
                Self {
                    inner: RecordingRunner::new(),
                    wda_stops,
                    shutdown_before_stop: shutdown_before_stop.clone(),
                },
                shutdown_before_stop,
            )
        }

        fn calls(&self) -> Vec<(String, Vec<String>)> {
            self.inner.calls()
        }
    }

    impl CommandRunner for OrderedCleanupRunner {
        fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, String> {
            if program == "xcrun"
                && args.starts_with(&["simctl".into(), "shutdown".into()])
                && self.wda_stops.load(Ordering::Acquire) == 0
            {
                self.shutdown_before_stop.store(true, Ordering::Release);
            }
            self.inner.run(program, args)
        }
    }

    #[cfg(target_os = "macos")]
    struct LedgerObservingRunner {
        inner: RecordingRunner,
        ledger: Arc<OwnershipLedger>,
        udid: String,
        boot_saw_requested: AtomicBool,
    }

    #[cfg(target_os = "macos")]
    impl LedgerObservingRunner {
        fn new(ledger: Arc<OwnershipLedger>, udid: &str) -> Self {
            Self {
                inner: RecordingRunner::new(),
                ledger,
                udid: udid.to_string(),
                boot_saw_requested: AtomicBool::new(false),
            }
        }

        fn saw_boot_requested_during_boot(&self) -> bool {
            self.boot_saw_requested.load(Ordering::Acquire)
        }
    }

    #[cfg(target_os = "macos")]
    fn is_simctl_command(args: &[String], command: &str) -> bool {
        args.first().map(String::as_str) == Some("simctl")
            && args.get(1).map(String::as_str) == Some(command)
    }

    fn has_argument_fragment(calls: &[(String, Vec<String>)], fragment: &str) -> bool {
        calls.iter().any(|(program, args)| {
            program.contains(fragment) || args.iter().any(|arg| arg.contains(fragment))
        })
    }

    impl CommandRunner for RecordingRunner {
        fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, String> {
            self.calls
                .lock()
                .unwrap()
                .push((program.to_string(), args.to_vec()));
            if program == "xcodebuild" {
                if !self.xcode_available {
                    return Ok(output(false, b"", b"xcode-select: error"));
                }
                let version = format!("Xcode {}\nBuild version 18A123\n", self.xcode_version);
                return Ok(output(true, version.as_bytes(), b""));
            }
            if program == "xcrun" && args == ["--find", "simctl"] {
                return Ok(output(true, b"/usr/bin/simctl\n", b""));
            }
            if program == "xcrun" && args == ["--find", "xcodebuild"] {
                let path = self
                    .xcodebuild_path
                    .as_deref()
                    .unwrap_or("/selected/Xcode/usr/bin/xcodebuild");
                return Ok(output(true, format!("{path}\n").as_bytes(), b""));
            }
            if program == "xcrun" && args.starts_with(&["simctl".into(), "list".into()]) {
                let devices = if self.booted {
                    DEVICES_JSON.replace("\"Shutdown\"", "\"Booted\"")
                } else {
                    DEVICES_JSON.to_string()
                };
                return Ok(output(true, devices.as_bytes(), b""));
            }
            if program == "xcrun" && args.starts_with(&["simctl".into(), "io".into()]) {
                if args.last().map(String::as_str) == Some("enumerate") {
                    return Ok(output(true, PORTRAIT_DISPLAY, b""));
                }
                if let Some(path) = args.last() {
                    if path != "-" {
                        assert!(
                            std::path::Path::new(path).is_absolute(),
                            "fake write must use absolute path, got: {path:?}"
                        );
                        std::fs::write(path, b"fake-png").unwrap();
                    }
                }
                return Ok(output(true, b"", b""));
            }
            Ok(output(true, b"", b""))
        }
    }

    #[cfg(target_os = "macos")]
    impl CommandRunner for LedgerObservingRunner {
        fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, String> {
            if program == "xcrun"
                && args == ["simctl".to_string(), "boot".to_string(), self.udid.clone()]
            {
                self.boot_saw_requested.store(
                    self.ledger.phase(&self.udid) == Some(OwnershipPhase::BootRequested),
                    Ordering::Release,
                );
            }
            self.inner.run(program, args)
        }
    }

    #[cfg(target_os = "macos")]
    impl CommandRunner for ReconciliationRunner {
        fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, String> {
            self.calls
                .lock()
                .unwrap()
                .push((program.to_string(), args.to_vec()));
            if program == "xcodebuild" {
                return Ok(output(true, b"Xcode 27.0\nBuild version 18A123\n", b""));
            }
            if program == "xcrun" && args == ["--find", "simctl"] {
                return Ok(output(true, b"/usr/bin/simctl\n", b""));
            }
            if program == "xcrun" && args.starts_with(&["simctl".into(), "list".into()]) {
                return Ok(output(true, self.devices_json.as_bytes(), b""));
            }
            if program == "xcrun" && args.starts_with(&["simctl".into(), "shutdown".into()]) {
                if let Some(udid) = args.get(2) {
                    if self.shutdown_failures.contains(udid) {
                        return Err(format!("simctl shutdown failed for {udid}"));
                    }
                }
            }
            Ok(output(true, b"", b""))
        }
    }

    #[derive(Default)]
    struct CountingSink {
        frames: AtomicUsize,
        errors: AtomicUsize,
        records: Mutex<Vec<IosSimulatorFrame>>,
    }

    impl FrameSink for CountingSink {
        fn frame(&self, frame: IosSimulatorFrame) {
            self.frames.fetch_add(1, Ordering::SeqCst);
            self.records.lock().unwrap().push(frame);
        }

        fn error(&self, _error: IosSimulatorError) {
            self.errors.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn output(success: bool, stdout: &[u8], stderr: &[u8]) -> CommandOutput {
        CommandOutput {
            success,
            stdout: stdout.to_vec(),
            stderr: stderr.to_vec(),
        }
    }

    fn test_device() -> IosSimulatorDevice {
        IosSimulatorDevice {
            name: "iPhone 17 Pro".into(),
            udid: "phone-17-pro".into(),
            state: "Booted".into(),
            ios_version: "26.5".into(),
            family: IosSimulatorDeviceFamily::Iphone,
        }
    }

    fn test_display_metrics() -> SimctlDisplayMetrics {
        SimctlDisplayMetrics {
            window_size: WdaWindowSize {
                width: 393.0,
                height: 852.0,
            },
            interface_orientation: WdaInterfaceOrientation::Portrait,
        }
    }

    fn test_png(width: u32, height: u32) -> Vec<u8> {
        use image::{DynamicImage, ImageBuffer, ImageFormat, Rgba};
        use std::io::Cursor;

        let image = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(
            width,
            height,
            Rgba([120, 70, 220, 255]),
        ));
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .unwrap();
        bytes
    }

    fn staged_wda_paths() -> WdaStagedPaths {
        WdaStagedPaths {
            project: PathBuf::from(
                "/local-app-data/ios-simulator/wda/project/WebDriverAgent.xcodeproj",
            ),
            derived_data: PathBuf::from("/local-app-data/ios-simulator/wda/derived-data"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn wda_process_shutdown_interrupts_before_terminating() {
        let mut command = Command::new("sh");
        command
            .arg("-c")
            .arg("trap 'exit 0' INT; trap '' TERM; while :; do sleep 1; done")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_process_group(&mut command);
        let mut child = command.spawn().unwrap();
        sleep(Duration::from_millis(100));

        let started = Instant::now();
        terminate_process_group(&mut child);

        assert!(
            started.elapsed() < Duration::from_millis(1500),
            "WDA shutdown did not use SIGINT before its terminating fallback"
        );
    }

    struct FakeWdaLauncher {
        delay: Duration,
        fail: bool,
        launched: AtomicUsize,
        stopped: Arc<AtomicUsize>,
        force_stopped: Arc<AtomicUsize>,
        ports: Arc<Mutex<Vec<u16>>>,
    }

    struct FakeWdaProcess {
        stopped: Arc<AtomicUsize>,
    }

    impl WdaProcess for FakeWdaProcess {
        fn try_wait(&mut self) -> Result<Option<ExitStatus>, String> {
            Ok(None)
        }

        fn stop(&mut self) {
            self.stopped.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl WdaLauncher for FakeWdaLauncher {
        fn launch(
            &self,
            spec: &WdaLaunchSpec,
            stop: &AtomicBool,
            force_stop_slot: &Mutex<Option<WdaForceStop>>,
        ) -> Result<WdaProcessHandle, String> {
            if self.fail {
                return Err("xcodebuild falhou no teste".to_string());
            }
            let force_stopped = self.force_stopped.clone();
            let force_stop: WdaForceStop = Arc::new(move || {
                force_stopped.fetch_add(1, Ordering::SeqCst);
            });
            let mut published_force_stop = force_stop_slot.lock().unwrap();
            if stop.load(Ordering::Acquire) {
                return Err("inicialização do WDA cancelada".to_string());
            }
            *published_force_stop = Some(force_stop);
            drop(published_force_stop);

            let delay = self.delay;
            let http_port = spec.http_port;
            let mjpeg_port = spec.mjpeg_port;
            self.ports.lock().unwrap().push(mjpeg_port);
            let settings_applied = Arc::new(AtomicBool::new(false));
            let http_stopped = self.stopped.clone();
            let http_settings_applied = settings_applied.clone();
            thread::spawn(move || {
                sleep(delay);
                let Ok(listener) = TcpListener::bind(("127.0.0.1", http_port)) else {
                    return;
                };
                listener.set_nonblocking(true).unwrap();
                let deadline = Instant::now() + Duration::from_secs(2);
                while Instant::now() < deadline && http_stopped.load(Ordering::SeqCst) == 0 {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
                            let _ = stream.set_write_timeout(Some(Duration::from_millis(200)));
                            let request = read_fake_http_request(&mut stream);
                            let request_line = request.lines().next().unwrap_or_default();
                            let path = request_line.split_whitespace().nth(1).unwrap_or_default();
                            let body = if path == "/session" {
                                r#"{"value":{"sessionId":"session-1","capabilities":{}}}"#
                            } else if path.ends_with("/window/size") {
                                r#"{"value":{"width":393.0,"height":852.0}}"#
                            } else if path == "/status" {
                                r#"{"value":{"ready":true}}"#
                            } else {
                                if path == "/wda/verboo/settings" {
                                    http_settings_applied.store(true, Ordering::SeqCst);
                                }
                                r#"{"value":null}"#
                            };
                            let _ = write!(
                                stream,
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                body.len(),
                                body,
                            );
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            sleep(Duration::from_millis(5));
                        }
                        Err(_) => return,
                    }
                }
            });

            let stopped = self.stopped.clone();
            let mjpeg_settings_applied = settings_applied;
            thread::spawn(move || {
                sleep(delay);
                while !mjpeg_settings_applied.load(Ordering::SeqCst)
                    && stopped.load(Ordering::SeqCst) == 0
                {
                    sleep(Duration::from_millis(5));
                }
                let Ok(listener) = TcpListener::bind(("127.0.0.1", mjpeg_port)) else {
                    return;
                };
                listener.set_nonblocking(true).unwrap();
                let deadline = Instant::now() + Duration::from_secs(2);
                while Instant::now() < deadline && stopped.load(Ordering::SeqCst) == 0 {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let _ = stream.set_write_timeout(Some(Duration::from_millis(200)));
                            let mut request = [0_u8; 256];
                            let _ = stream.read(&mut request);
                            let _ = stream.write_all(
                                b"HTTP/1.0 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=--BoundaryString\r\n\r\n",
                            );
                            let frame = b"\xff\xd8fake-jpeg\xff\xd9";
                            while stopped.load(Ordering::SeqCst) == 0 {
                                let header = format!(
                                    "--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
                                    frame.len()
                                );
                                if stream.write_all(header.as_bytes()).is_err()
                                    || stream.write_all(frame).is_err()
                                    || stream.write_all(b"\r\n\r\n").is_err()
                                {
                                    break;
                                }
                                sleep(Duration::from_millis(20));
                            }
                            return;
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            sleep(Duration::from_millis(10));
                        }
                        Err(_) => return,
                    }
                }
            });
            self.launched.fetch_add(1, Ordering::SeqCst);
            Ok(WdaProcessHandle {
                process: Box::new(FakeWdaProcess {
                    stopped: self.stopped.clone(),
                }),
            })
        }
    }

    struct FirstFailureWdaLauncher {
        inner: FakeWdaLauncher,
        attempts: Arc<AtomicUsize>,
    }

    impl WdaLauncher for FirstFailureWdaLauncher {
        fn launch(
            &self,
            spec: &WdaLaunchSpec,
            stop: &AtomicBool,
            force_stop_slot: &Mutex<Option<WdaForceStop>>,
        ) -> Result<WdaProcessHandle, String> {
            let attempt = self.attempts.fetch_add(1, Ordering::SeqCst);
            if attempt == 0 {
                return Err("primeira inicialização falhou no teste".to_string());
            }
            self.inner.launch(spec, stop, force_stop_slot)
        }
    }

    fn read_fake_http_request(stream: &mut TcpStream) -> String {
        let mut buffer = Vec::new();
        let mut chunk = [0_u8; 4096];
        loop {
            let Ok(read) = stream.read(&mut chunk) else {
                break;
            };
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
            let Some(header_end) = buffer.windows(4).position(|part| part == b"\r\n\r\n") else {
                continue;
            };
            let header_end = header_end + 4;
            let headers = String::from_utf8_lossy(&buffer[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            if buffer.len() >= header_end + content_length {
                break;
            }
        }
        String::from_utf8_lossy(&buffer).into_owned()
    }

    struct NonResponsiveWdaLauncher {
        launched: AtomicUsize,
        stopped: Arc<AtomicUsize>,
        force_stopped: Arc<AtomicUsize>,
    }

    struct BlockingLaunchWdaLauncher {
        entered: (Mutex<bool>, Condvar),
        release: (Mutex<bool>, Condvar),
        completed: AtomicBool,
        spawned: AtomicUsize,
    }

    impl BlockingLaunchWdaLauncher {
        fn new() -> Self {
            Self {
                entered: (Mutex::new(false), Condvar::new()),
                release: (Mutex::new(false), Condvar::new()),
                completed: AtomicBool::new(false),
                spawned: AtomicUsize::new(0),
            }
        }

        fn wait_until_entered(&self) {
            let (entered, ready) = &self.entered;
            let mut entered = entered.lock().unwrap();
            while !*entered {
                entered = ready.wait(entered).unwrap();
            }
        }

        fn release(&self) {
            let (released, ready) = &self.release;
            *released.lock().unwrap() = true;
            ready.notify_all();
        }
    }

    struct BlockingInputWdaClient {
        calls: Mutex<Vec<&'static str>>,
        tap_started: (Mutex<bool>, Condvar),
        release_tap: (Mutex<bool>, Condvar),
    }

    impl BlockingInputWdaClient {
        fn new() -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                tap_started: (Mutex::new(false), Condvar::new()),
                release_tap: (Mutex::new(false), Condvar::new()),
            }
        }

        fn wait_for_tap(&self) {
            let (started, ready) = &self.tap_started;
            let mut started = started.lock().unwrap();
            while !*started {
                started = ready.wait(started).unwrap();
            }
        }

        fn release_tap(&self) {
            let (released, ready) = &self.release_tap;
            *released.lock().unwrap() = true;
            ready.notify_all();
        }
    }

    impl WdaClient for BlockingInputWdaClient {
        fn wait_until_ready(&self, _base_url: &str, _deadline: Instant) -> Result<(), String> {
            Ok(())
        }

        fn apply_stream_settings(
            &self,
            _control: &WdaControlHandle,
            _profile: StreamProfile,
        ) -> Result<(), String> {
            Ok(())
        }

        fn tap(&self, _control: &WdaControlHandle, _point: WdaPoint) -> Result<(), String> {
            self.calls.lock().unwrap().push("tap-start");
            let (started, ready) = &self.tap_started;
            *started.lock().unwrap() = true;
            ready.notify_all();
            let (released, ready) = &self.release_tap;
            let mut released = released.lock().unwrap();
            while !*released {
                released = ready.wait(released).unwrap();
            }
            self.calls.lock().unwrap().push("tap-end");
            Ok(())
        }

        fn drag(
            &self,
            _control: &WdaControlHandle,
            _from: WdaPoint,
            _to: WdaPoint,
            _duration: Duration,
        ) -> Result<(), String> {
            Ok(())
        }

        fn type_text(&self, _control: &WdaControlHandle, _text: &str) -> Result<(), String> {
            self.calls.lock().unwrap().push("type");
            Ok(())
        }

        fn press_key(
            &self,
            _control: &WdaControlHandle,
            _key: IosSimulatorKey,
        ) -> Result<(), String> {
            Ok(())
        }

        fn home(&self, _control: &WdaControlHandle) -> Result<(), String> {
            Ok(())
        }

        fn system_gesture(
            &self,
            _control: &WdaControlHandle,
            _gesture: SystemGesture,
        ) -> Result<(), String> {
            Ok(())
        }

        fn rotate(
            &self,
            _control: &WdaControlHandle,
            _orientation: WdaInterfaceOrientation,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    struct BlockingRotateWdaClient {
        rotate_started: (Mutex<bool>, Condvar),
        release_rotate: (Mutex<bool>, Condvar),
    }

    impl BlockingRotateWdaClient {
        fn new() -> Self {
            Self {
                rotate_started: (Mutex::new(false), Condvar::new()),
                release_rotate: (Mutex::new(false), Condvar::new()),
            }
        }

        fn wait_for_rotate(&self) {
            let (started, ready) = &self.rotate_started;
            let mut started = started.lock().unwrap();
            while !*started {
                started = ready.wait(started).unwrap();
            }
        }

        fn release_rotate(&self) {
            let (released, ready) = &self.release_rotate;
            *released.lock().unwrap() = true;
            ready.notify_all();
        }
    }

    impl WdaClient for BlockingRotateWdaClient {
        fn wait_until_ready(&self, _base_url: &str, _deadline: Instant) -> Result<(), String> {
            Ok(())
        }

        fn apply_stream_settings(
            &self,
            _control: &WdaControlHandle,
            _profile: StreamProfile,
        ) -> Result<(), String> {
            Ok(())
        }

        fn tap(&self, _control: &WdaControlHandle, _point: WdaPoint) -> Result<(), String> {
            Ok(())
        }

        fn drag(
            &self,
            _control: &WdaControlHandle,
            _from: WdaPoint,
            _to: WdaPoint,
            _duration: Duration,
        ) -> Result<(), String> {
            Ok(())
        }

        fn type_text(&self, _control: &WdaControlHandle, _text: &str) -> Result<(), String> {
            Ok(())
        }

        fn press_key(
            &self,
            _control: &WdaControlHandle,
            _key: IosSimulatorKey,
        ) -> Result<(), String> {
            Ok(())
        }

        fn home(&self, _control: &WdaControlHandle) -> Result<(), String> {
            Ok(())
        }

        fn system_gesture(
            &self,
            _control: &WdaControlHandle,
            _gesture: SystemGesture,
        ) -> Result<(), String> {
            Ok(())
        }

        fn rotate(
            &self,
            _control: &WdaControlHandle,
            _orientation: WdaInterfaceOrientation,
        ) -> Result<(), String> {
            let (started, ready) = &self.rotate_started;
            *started.lock().unwrap() = true;
            ready.notify_all();
            let (released, ready) = &self.release_rotate;
            let mut released = released.lock().unwrap();
            while !*released {
                released = ready.wait(released).unwrap();
            }
            Ok(())
        }
    }

    struct RotationRunner;

    impl CommandRunner for RotationRunner {
        fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, String> {
            if program == "xcrun"
                && args.starts_with(&["simctl".into(), "io".into()])
                && args.last().map(String::as_str) == Some("enumerate")
            {
                return Ok(output(true, LANDSCAPE_RIGHT_DISPLAY, b""));
            }
            Ok(output(true, b"", b""))
        }
    }

    fn service_with_active_wda(client: Arc<dyn WdaClient>) -> IosSimulatorService {
        service_with_active_wda_on_runner(client, Arc::new(RecordingRunner::new()))
    }

    fn ios27_device() -> IosSimulatorDevice {
        IosSimulatorDevice {
            ios_version: "27.0".into(),
            ..test_device()
        }
    }

    fn service_with_active_wda_and_device(
        client: Arc<dyn WdaClient>,
        runner: Arc<dyn CommandRunner>,
        device: IosSimulatorDevice,
    ) -> IosSimulatorService {
        let service = service_with_active_wda_on_runner(client, runner);
        service
            .state
            .lock()
            .unwrap()
            .session
            .as_mut()
            .unwrap()
            .device = device;
        service
    }

    fn service_with_active_wda_on_runner(
        client: Arc<dyn WdaClient>,
        runner: Arc<dyn CommandRunner>,
    ) -> IosSimulatorService {
        let service = IosSimulatorService {
            state: Arc::new(Mutex::new(ServiceState::default())),
            runner,
            ownership: Arc::new(OwnershipLedger::in_memory()),
            lifecycle: Arc::new(LifecycleAuthority::default()),
            desired_visibility: Arc::new(AtomicBool::new(true)),
            operation_lock: Arc::new(Mutex::new(())),
            exiting: Arc::new(AtomicBool::new(false)),
            exit_cleanup_started: Arc::new(AtomicBool::new(false)),
            wda_launcher: Arc::new(NoopWdaLauncher),
            wda_client: client,
            next_device_generation: Arc::new(AtomicU64::new(1)),
            presence: Arc::new(PresenceAuthority::default()),
            presence_snapshot: Arc::new(Mutex::new(None)),
            app: Arc::new(Mutex::new(None)),
            media_backend: Arc::new(SystemSimulatorMediaBackend),
            emitted_outputs: Arc::new(Mutex::new(HashSet::new())),
            #[cfg(test)]
            lifecycle_emissions: Arc::new(Mutex::new(Vec::new())),
        };
        service.state.lock().unwrap().session = Some(Session {
            device: test_device(),
            device_generation: 1,
            ownership: IosSimulatorOwnership::External,
            fallback_fps: Arc::new(Mutex::new(DEFAULT_FALLBACK_FPS)),
            stream_profile: Arc::new(Mutex::new(StreamProfile::DEFAULT)),
            stats: Arc::new(Mutex::new(StreamStats {
                source: IosSimulatorStreamSource::Mjpeg,
                effective_fps: Some(30.0),
            })),
            stop: Arc::new(AtomicBool::new(false)),
            input_lock: Arc::new(Mutex::new(())),
            latest_frame: Arc::new(Mutex::new(None)),
            gate: Arc::new(PreviewGate::new(true)),
            mjpeg_active: Arc::new(AtomicBool::new(false)),
            next_frame_generation: Arc::new(AtomicU64::new(0)),
            wda_control: Arc::new(Mutex::new(Some(WdaControlHandle {
                base_url: "http://127.0.0.1:8100".into(),
                window_size: test_display_metrics().window_size,
                orientation: WdaInterfaceOrientation::Portrait,
            }))),
            wda_force_stop: Arc::new(Mutex::new(None)),
            staged_wda: None,
            sink: None,
            recording: Arc::new(Mutex::new(None)),
            workers: Mutex::new(Vec::new()),
        });
        service
    }

    fn set_test_latest_frame(service: &IosSimulatorService, frame_generation: u64) {
        let state = service.state.lock().unwrap();
        let session = state.session.as_ref().unwrap();
        *session.latest_frame.lock().unwrap() = Some(LatestFrame {
            device_generation: session.device_generation,
            frame_generation,
            bytes: test_png(400, 800),
            media_type: "image/png",
        });
    }

    fn wait_for_wda_control(service: &IosSimulatorService, deadline: Instant) -> bool {
        let control = {
            let state = service.state.lock().unwrap();
            state
                .session
                .as_ref()
                .expect("simulator session should be active")
                .wda_control
                .clone()
        };
        while Instant::now() < deadline {
            if control.lock().unwrap().is_some() {
                return true;
            }
            sleep(Duration::from_millis(5));
        }
        false
    }

    struct ActiveSessionHarness {
        service: IosSimulatorService,
        runner: Arc<OrderedCleanupRunner>,
        launcher: Arc<FakeWdaLauncher>,
        sink: Arc<CountingSink>,
        ledger: Arc<OwnershipLedger>,
        shutdown_before_stop: Arc<AtomicBool>,
    }

    impl ActiveSessionHarness {
        fn new(ownership: IosSimulatorOwnership) -> Self {
            let stopped = Arc::new(AtomicUsize::new(0));
            let (runner, shutdown_before_stop) = OrderedCleanupRunner::new(stopped.clone());
            let runner = Arc::new(runner);
            let launcher = Arc::new(FakeWdaLauncher {
                delay: Duration::ZERO,
                fail: false,
                launched: AtomicUsize::new(0),
                stopped: stopped.clone(),
                force_stopped: Arc::new(AtomicUsize::new(0)),
                ports: Arc::new(Mutex::new(Vec::new())),
            });
            let service = IosSimulatorService::with_dependencies(runner.clone(), launcher.clone());
            let sink = Arc::new(CountingSink::default());
            service.start_session(
                test_device(),
                StreamProfile::DEFAULT,
                MAX_FPS,
                test_display_metrics(),
                Some(staged_wda_paths()),
                sink.clone(),
            );
            assert!(wait_for_wda_control(
                &service,
                Instant::now() + Duration::from_secs(5)
            ));
            {
                let mut state = service.state.lock().unwrap();
                state.session.as_mut().unwrap().ownership = ownership;
            }
            let ledger = service.ownership.clone();
            if ownership == IosSimulatorOwnership::Verboo {
                ledger.mark_booted("phone-17-pro").unwrap();
            }
            Self {
                service,
                runner,
                launcher,
                sink,
                ledger,
                shutdown_before_stop,
            }
        }

        fn wait_for_first_frame(&self) {
            wait_until(|| self.frames() > 0, Duration::from_secs(1));
            assert!(self.frames() > 0);
        }

        fn wait_for_more_frames(&self, previous: usize) {
            wait_until(|| self.frames() > previous, Duration::from_secs(1));
            assert!(self.frames() > previous);
        }

        fn frames(&self) -> usize {
            self.sink.frames.load(Ordering::Acquire)
        }

        fn wait_for_preview_workers_to_park(&self) {
            let (gate, expected_workers) = {
                let state = self.service.state.lock().unwrap();
                let session = state.session.as_ref().unwrap();
                let expected_workers = session.workers.lock().unwrap().len();
                (session.gate.clone(), expected_workers)
            };
            wait_until(
                || gate.parked_workers() == expected_workers,
                Duration::from_secs(1),
            );
            assert_eq!(gate.parked_workers(), expected_workers);
        }

        fn wda_launches(&self) -> usize {
            self.launcher.launched.load(Ordering::Acquire)
        }

        fn wda_stops(&self) -> usize {
            self.launcher.stopped.load(Ordering::Acquire)
        }

        fn shutdown_udids(&self) -> Vec<String> {
            self.runner
                .calls()
                .into_iter()
                .filter_map(|(_, args)| {
                    (args.first().map(String::as_str) == Some("simctl")
                        && args.get(1).map(String::as_str) == Some("shutdown"))
                    .then(|| args.get(2).cloned())
                    .flatten()
                })
                .collect()
        }

        fn stop_happened_before_shutdown(&self) -> bool {
            !self.shutdown_before_stop.load(Ordering::Acquire)
        }

        fn release_blocked_wda(&self) {}
    }

    #[test]
    fn capture_uses_one_exact_frame_generation_for_crop_and_viewport() {
        let service = service_with_active_wda(Arc::new(NoopWdaClient));
        set_test_latest_frame(&service, 7);
        let directory = tempfile::tempdir().unwrap();
        let store = IosSimulatorCaptureStore::for_test(
            directory.path().join("temp"),
            directory.path().join("durable"),
        );
        let rect = NormalizedRect {
            x: 0.25,
            y: 0.25,
            width: 0.5,
            height: 0.25,
        };

        let capture = service
            .capture_annotation_sync(&store, 1, rect, None)
            .unwrap();

        assert_eq!(capture.device_generation, 1);
        assert_eq!(capture.frame_generation, 7);
        assert_eq!((capture.crop_width, capture.crop_height), (200, 200));
        assert_eq!(
            (capture.viewport_width, capture.viewport_height),
            (400, 800)
        );
        assert!(service
            .capture_annotation_sync(&store, 2, rect, None)
            .is_err());
        store
            .delete_temp_files(vec![capture.crop_path, capture.viewport_path])
            .unwrap();
    }

    #[test]
    fn capture_removes_both_files_when_device_generation_changes_after_write() {
        let service = service_with_active_wda(Arc::new(NoopWdaClient));
        set_test_latest_frame(&service, 3);
        let directory = tempfile::tempdir().unwrap();
        let temp_root = directory.path().join("temp");
        let store =
            IosSimulatorCaptureStore::for_test(temp_root.clone(), directory.path().join("durable"));
        let closing_service = service.clone();

        let result = service.capture_annotation_with_after_write(
            &store,
            1,
            NormalizedRect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            None,
            move || {
                let _ = closing_service.detach_sync();
            },
        );

        assert!(result.is_err());
        assert_eq!(std::fs::read_dir(temp_root).unwrap().count(), 0);
    }

    #[test]
    fn late_agent_completion_cannot_clear_newer_presence() {
        let presence = PresenceAuthority::default();
        let first = presence.begin();
        let second = presence.begin();

        assert!(!presence.complete(first));
        assert_eq!(presence.current_generation(), Some(second));
        assert!(presence.complete(second));
        assert_eq!(presence.current_generation(), None);
    }

    impl WdaLauncher for NonResponsiveWdaLauncher {
        fn launch(
            &self,
            _spec: &WdaLaunchSpec,
            stop: &AtomicBool,
            force_stop_slot: &Mutex<Option<WdaForceStop>>,
        ) -> Result<WdaProcessHandle, String> {
            let force_stopped = self.force_stopped.clone();
            let force_stop: WdaForceStop = Arc::new(move || {
                force_stopped.fetch_add(1, Ordering::SeqCst);
            });
            let mut published_force_stop = force_stop_slot.lock().unwrap();
            if stop.load(Ordering::Acquire) {
                return Err("inicialização do WDA cancelada".to_string());
            }
            *published_force_stop = Some(force_stop);
            self.launched.fetch_add(1, Ordering::SeqCst);
            drop(published_force_stop);
            Ok(WdaProcessHandle {
                process: Box::new(FakeWdaProcess {
                    stopped: self.stopped.clone(),
                }),
            })
        }
    }

    impl WdaLauncher for BlockingLaunchWdaLauncher {
        fn launch(
            &self,
            _spec: &WdaLaunchSpec,
            stop: &AtomicBool,
            force_stop_slot: &Mutex<Option<WdaForceStop>>,
        ) -> Result<WdaProcessHandle, String> {
            let (entered, ready) = &self.entered;
            *entered.lock().unwrap() = true;
            ready.notify_all();

            let (released, ready) = &self.release;
            let mut released = released.lock().unwrap();
            while !*released {
                released = ready.wait(released).unwrap();
            }
            drop(released);

            let mut published_force_stop = force_stop_slot.lock().unwrap();
            if stop.load(Ordering::Acquire) {
                self.completed.store(true, Ordering::Release);
                return Err("inicialização do WDA cancelada".to_string());
            }
            self.spawned.fetch_add(1, Ordering::SeqCst);
            *published_force_stop = Some(Arc::new(|| {}));
            self.completed.store(true, Ordering::Release);
            Ok(WdaProcessHandle {
                process: Box::new(FakeWdaProcess {
                    stopped: Arc::new(AtomicUsize::new(0)),
                }),
            })
        }
    }

    #[test]
    fn parses_supported_xcode_and_only_ios_devices() {
        assert_eq!(
            parse_xcode_version(b"Xcode 27.0\nBuild version 18A123"),
            Some("27.0".into())
        );
        assert_eq!(xcode_major("26.4"), Some(26));
        assert_eq!(xcode_major("25.4"), Some(25));

        let devices = parse_simctl_devices(DEVICES_JSON.as_bytes()).unwrap();
        assert_eq!(devices.len(), 2);
        let phone = devices
            .iter()
            .find(|device| device.udid == "phone-17-pro")
            .unwrap();
        let ipad = devices.iter().find(|device| device.udid == "ipad").unwrap();
        assert_eq!(phone.name, "iPhone 17 Pro");
        assert_eq!(phone.ios_version, "26.5");
        assert_eq!(phone.family, IosSimulatorDeviceFamily::Iphone);
        assert_eq!(ipad.family, IosSimulatorDeviceFamily::Ipad);
    }

    #[test]
    fn parses_integrated_simulator_display_without_accessibility() {
        let output = br#"
    (3) Wireless:
        Screen Type: CarPlay
        Pixel Size: {720, 480}
        Preferred UI Scale: 1
        UI Orientation: Ambiguous
    (1) LCD:
        Screen Type: Integrated
        Pixel Size: {1206, 2622}
        Preferred UI Scale: 3
        UI Orientation: Portrait
"#;

        let metrics = parse_simctl_display_metrics(output).unwrap();
        assert_eq!(metrics.window_size.width, 402.0);
        assert_eq!(metrics.window_size.height, 874.0);
        assert_eq!(
            metrics.interface_orientation,
            WdaInterfaceOrientation::Portrait
        );
        assert!(parse_simctl_display_metrics(
            b"Screen Type: Integrated\nPixel Size: {1206, 2622}\nPreferred UI Scale: 0"
        )
        .is_err());
    }

    #[test]
    fn ambiguous_orientation_retries_until_integrated_display_is_ready() {
        let runner = SequencedDisplayRunner::new(vec![AMBIGUOUS_DISPLAY, PORTRAIT_DISPLAY]);
        let metrics = wait_for_display_metrics(
            &runner,
            "phone-17-pro",
            Duration::from_millis(100),
            Duration::ZERO,
        )
        .unwrap();
        assert_eq!(
            metrics.interface_orientation,
            WdaInterfaceOrientation::Portrait
        );
        assert_eq!(runner.enumerate_calls(), 2);
    }

    #[test]
    fn display_readiness_timeout_is_recoverable_and_keeps_device_context() {
        let runner = SequencedDisplayRunner::repeating(AMBIGUOUS_DISPLAY);
        let error = wait_for_display_metrics(
            &runner,
            "phone-17-pro",
            Duration::from_millis(20),
            Duration::from_millis(5),
        )
        .unwrap_err();
        assert!(error.recoverable);
        assert_eq!(error.kind, SimulatorDisplayErrorKind::AmbiguousOrientation);
    }

    #[test]
    fn rotation_does_not_retry_permanent_display_metrics_errors() {
        let runner = SequencedDisplayRunner::repeating(INVALID_DISPLAY_METRICS);
        let _ = wait_for_target_display_metrics(
            &runner,
            "phone-17-pro",
            WdaInterfaceOrientation::LandscapeRight,
            Instant::now() + Duration::from_millis(200),
            false,
        );
        assert_eq!(runner.enumerate_calls(), 1);
    }

    #[test]
    fn startup_screenshot_failures_retry_until_the_first_frame_deadline() {
        let runner = SequencedCaptureRunner::new(vec![
            Err("framebuffer not ready"),
            Err("framebuffer not ready"),
            Ok(test_png(393, 852)),
        ]);
        let sink = Arc::new(CountingSink::default());
        let worker = spawn_capture_loop_with_first_frame_policy(
            Arc::new(runner),
            sink.clone(),
            Duration::from_millis(100),
            Duration::ZERO,
        );
        wait_until(
            || sink.frames.load(Ordering::Acquire) == 1,
            Duration::from_secs(1),
        );
        worker.stop_and_join();
        assert_eq!(sink.errors.load(Ordering::Acquire), 0);
    }

    #[test]
    fn late_lifecycle_transition_cannot_replace_a_newer_device_generation() {
        let authority = LifecycleAuthority::default();
        authority.begin(7, test_device(), IosSimulatorOwnership::Verboo, true);
        authority.begin(8, test_device(), IosSimulatorOwnership::External, true);
        assert!(!authority.transition(7, LifecycleSignal::FirstFrameReady));
        assert_eq!(authority.snapshot().device_generation, Some(8));
    }

    #[test]
    fn mjpeg_parser_emits_only_complete_jpegs_and_keeps_split_bytes() {
        let mut buffer = b"HTTP/1.0 200 OK\r\n\r\n\xff".to_vec();
        assert_eq!(extract_mjpeg_frame(&mut buffer), None);
        buffer.extend_from_slice(b"\xd8one\xff");
        assert_eq!(extract_mjpeg_frame(&mut buffer), None);
        buffer.extend_from_slice(b"\xd9boundary\xff\xd8two\xff\xd9");
        assert_eq!(
            extract_mjpeg_frame(&mut buffer),
            Some(b"\xff\xd8one\xff\xd9".to_vec())
        );
        assert_eq!(
            extract_mjpeg_frame(&mut buffer),
            Some(b"\xff\xd8two\xff\xd9".to_vec())
        );
        assert!(buffer.is_empty());
    }

    #[test]
    fn wda_command_is_loopback_and_uses_the_selected_runtime_project() {
        let spec = WdaLaunchSpec {
            project: PathBuf::from(
                "/local-app-data/ios-simulator/wda/project/WebDriverAgent.xcodeproj",
            ),
            derived_data: PathBuf::from("/local-app-data/ios-simulator/wda/derived-data"),
            destination_udid: "phone-17-pro".into(),
            http_port: 12345,
            mjpeg_port: 23456,
        };
        let args = wda_command_args(&spec);
        assert!(args.contains(&"USE_IP=127.0.0.1".to_string()));
        assert!(args.contains(&"USE_PORT=12345".to_string()));
        assert!(args.contains(&"MJPEG_SERVER_PORT=23456".to_string()));
        let derived_data_index = args
            .iter()
            .position(|arg| arg == "-derivedDataPath")
            .expect("WDA must receive an explicit derived data path");
        assert_eq!(
            args.get(derived_data_index + 1),
            Some(&"/local-app-data/ios-simulator/wda/derived-data".to_string())
        );
        assert!(args
            .iter()
            .any(|arg| arg.contains("platform=iOS Simulator,id=phone-17-pro")));
        assert!(!args.iter().any(|arg| arg.contains("Xcode_27_beta.app")));
    }

    #[test]
    fn runtime_wda_tool_resolution_uses_xcrun() {
        let runner = RecordingRunner::new();
        assert_eq!(
            resolve_runtime_tool(&runner, "xcodebuild").unwrap(),
            "/selected/Xcode/usr/bin/xcodebuild"
        );
        assert!(runner.calls().iter().any(|(program, args)| {
            program == "xcrun" && args == &["--find".to_string(), "xcodebuild".to_string()]
        }));
    }

    #[test]
    fn stages_wda_by_content_into_one_reusable_local_tree() {
        let source_root = tempfile::tempdir().unwrap();
        let source = source_root.path().join("Documents/project");
        std::fs::create_dir_all(source.join("WebDriverAgent.xcodeproj/project")).unwrap();
        std::fs::write(
            source.join("WebDriverAgent.xcodeproj/project/project.pbxproj"),
            b"version-one",
        )
        .unwrap();
        std::fs::write(source.join("WebDriverAgentLib.m"), b"wda").unwrap();
        std::fs::create_dir_all(source.join("WebDriverAgentLib/Routing")).unwrap();
        std::fs::write(
            source.join(WDA_LOOPBACK_SOURCE_FILE),
            b"acceptOnPort:self.port error:error",
        )
        .unwrap();

        let stage_root = tempfile::tempdir().unwrap().path().join("wda-stage");
        let first = stage_wda_project_at(&source, &stage_root).unwrap();
        assert!(first.project.starts_with(&stage_root));
        assert!(first.derived_data.starts_with(&stage_root));
        assert!(!first.project.starts_with(&source_root.path()));
        assert_eq!(
            std::fs::read(first.project.join("project/project.pbxproj")).unwrap(),
            b"version-one"
        );
        assert!(std::fs::read_to_string(
            first
                .project
                .parent()
                .unwrap()
                .join(WDA_LOOPBACK_SOURCE_FILE)
        )
        .unwrap()
        .contains(WDA_LOOPBACK_BIND_CALL));

        let derived_sentinel = first.derived_data.join("Build/sentinel");
        std::fs::create_dir_all(derived_sentinel.parent().unwrap()).unwrap();
        std::fs::write(&derived_sentinel, b"reusable-build").unwrap();
        let second = stage_wda_project_at(&source, &stage_root).unwrap();
        assert_eq!(first, second);
        assert!(
            derived_sentinel.exists(),
            "same content must reuse DerivedData"
        );

        std::fs::write(source.join("WebDriverAgentLib.m"), b"wda-changed").unwrap();
        let third = stage_wda_project_at(&source, &stage_root).unwrap();
        assert_eq!(
            std::fs::read(third.project.parent().unwrap().join("WebDriverAgentLib.m")).unwrap(),
            b"wda-changed"
        );
        assert!(
            !derived_sentinel.exists(),
            "changed content must invalidate the old DerivedData"
        );
        let entries = std::fs::read_dir(&stage_root).unwrap().count();
        assert_eq!(
            entries, 3,
            "staging must keep one project, one DerivedData and one digest"
        );
    }

    #[test]
    fn wda_staging_fails_closed_when_the_loopback_bind_shape_changes() {
        let source_root = tempfile::tempdir().unwrap();
        let source = source_root.path().join("wda");
        std::fs::create_dir_all(source.join("WebDriverAgent.xcodeproj")).unwrap();
        std::fs::create_dir_all(source.join("WebDriverAgentLib/Routing")).unwrap();
        std::fs::write(
            source.join(WDA_LOOPBACK_SOURCE_FILE),
            b"acceptOnPort:self.port error:unexpected-error",
        )
        .unwrap();

        let stage_root = tempfile::tempdir().unwrap().path().join("stage");
        let error = stage_wda_project_at(&source, &stage_root).unwrap_err();
        assert!(error.contains("bind esperado"));
    }

    #[test]
    fn detach_after_staging_stops_wda_without_growing_the_staging_tree() {
        let source_root = tempfile::tempdir().unwrap();
        let source = source_root.path().join("wda");
        std::fs::create_dir_all(source.join("WebDriverAgent.xcodeproj")).unwrap();
        std::fs::create_dir_all(source.join("WebDriverAgentLib/Routing")).unwrap();
        std::fs::write(source.join(WDA_LOOPBACK_SOURCE_FILE), WDA_UNSAFE_BIND_CALL).unwrap();
        let stage_root = tempfile::tempdir().unwrap().path().join("stage");
        let staged = stage_wda_project_at(&source, &stage_root).unwrap();
        let entries_before = std::fs::read_dir(&stage_root).unwrap().count();

        let stopped = Arc::new(AtomicUsize::new(0));
        let launcher = Arc::new(FakeWdaLauncher {
            delay: Duration::ZERO,
            fail: false,
            launched: AtomicUsize::new(0),
            stopped: stopped.clone(),
            force_stopped: Arc::new(AtomicUsize::new(0)),
            ports: Arc::new(Mutex::new(Vec::new())),
        });
        let service =
            IosSimulatorService::with_dependencies(Arc::new(RecordingRunner::new()), launcher);
        service.start_session(
            test_device(),
            StreamProfile::DEFAULT,
            MAX_FPS,
            test_display_metrics(),
            Some(staged),
            Arc::new(CountingSink::default()),
        );
        sleep(Duration::from_millis(100));
        service.detach_sync();

        assert_eq!(stopped.load(Ordering::SeqCst), 1);
        assert_eq!(
            std::fs::read_dir(&stage_root).unwrap().count(),
            entries_before,
            "detach must not create or accumulate staging entries"
        );
        assert!(stage_root.join(WDA_DERIVED_DATA_DIRECTORY).is_dir());
        assert!(!stage_root.join(WDA_PROJECT_TEMP_DIRECTORY).exists());
    }

    #[test]
    fn wda_start_returns_without_waiting_for_a_runner_or_mjpeg_port() {
        let runner = Arc::new(RecordingRunner::new());
        let launcher = Arc::new(NonResponsiveWdaLauncher {
            launched: AtomicUsize::new(0),
            stopped: Arc::new(AtomicUsize::new(0)),
            force_stopped: Arc::new(AtomicUsize::new(0)),
        });
        let service = IosSimulatorService::with_dependencies(runner, launcher.clone());
        let sink = Arc::new(CountingSink::default());
        let started = Instant::now();
        service.start_session(
            test_device(),
            StreamProfile::DEFAULT,
            MAX_FPS,
            test_display_metrics(),
            Some(WdaStagedPaths {
                project: PathBuf::from("/local-app-data/wda/project/WebDriverAgent.xcodeproj"),
                derived_data: PathBuf::from("/local-app-data/wda/derived-data"),
            }),
            sink,
        );
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "attach must not wait for xcodebuild or the MJPEG port"
        );
        let deadline = Instant::now() + Duration::from_secs(1);
        while launcher.launched.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            sleep(Duration::from_millis(10));
        }
        service.detach_sync();
        assert_eq!(launcher.stopped.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn wda_migration_keeps_simctl_frame_until_first_mjpeg_frame() {
        let runner = Arc::new(RecordingRunner::new());
        let stopped = Arc::new(AtomicUsize::new(0));
        let launcher = Arc::new(FakeWdaLauncher {
            delay: Duration::from_millis(100),
            fail: false,
            launched: AtomicUsize::new(0),
            stopped: stopped.clone(),
            force_stopped: Arc::new(AtomicUsize::new(0)),
            ports: Arc::new(Mutex::new(Vec::new())),
        });
        let service = IosSimulatorService::with_dependencies(runner, launcher.clone());
        let sink = Arc::new(CountingSink::default());
        service.start_session(
            test_device(),
            StreamProfile::DEFAULT,
            MAX_FPS,
            test_display_metrics(),
            Some(staged_wda_paths()),
            sink.clone(),
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            let received_mjpeg = sink
                .records
                .lock()
                .unwrap()
                .iter()
                .any(|frame| frame.source == IosSimulatorStreamSource::Mjpeg);
            if received_mjpeg {
                break;
            }
            sleep(Duration::from_millis(10));
        }
        service.detach_sync();

        let records = sink.records.lock().unwrap().clone();
        let first_mjpeg = records
            .iter()
            .position(|frame| frame.source == IosSimulatorStreamSource::Mjpeg)
            .expect("WDA should emit a MJPEG frame");
        assert!(
            first_mjpeg > 0,
            "simctl must provide the warmup frame first"
        );
        assert!(records[..first_mjpeg]
            .iter()
            .all(|frame| frame.source == IosSimulatorStreamSource::Simctl));
        assert!(records.iter().all(|frame| !frame.data_url.is_empty()));
        assert_eq!(launcher.launched.load(Ordering::SeqCst), 1);
        assert_eq!(stopped.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn wda_build_failure_keeps_simctl_loop_running() {
        let runner = Arc::new(RecordingRunner::new());
        let launcher = Arc::new(FakeWdaLauncher {
            delay: Duration::ZERO,
            fail: true,
            launched: AtomicUsize::new(0),
            stopped: Arc::new(AtomicUsize::new(0)),
            force_stopped: Arc::new(AtomicUsize::new(0)),
            ports: Arc::new(Mutex::new(Vec::new())),
        });
        let service = IosSimulatorService::with_dependencies(runner, launcher);
        let sink = Arc::new(CountingSink::default());
        service.start_session(
            test_device(),
            StreamProfile::DEFAULT,
            MAX_FPS,
            test_display_metrics(),
            Some(staged_wda_paths()),
            sink.clone(),
        );
        sleep(Duration::from_millis(650));
        service.detach_sync();

        assert!(sink.frames.load(Ordering::SeqCst) >= 2);
        assert!(sink.errors.load(Ordering::SeqCst) >= 1);
        assert!(sink
            .records
            .lock()
            .unwrap()
            .iter()
            .all(|frame| frame.source == IosSimulatorStreamSource::Simctl));
    }

    #[test]
    fn wda_launch_spec_uses_the_staged_project_and_derived_data() {
        let source_root = tempfile::tempdir().unwrap();
        let source = source_root.path().join("Documents/wda");
        std::fs::create_dir_all(source.join("WebDriverAgent.xcodeproj")).unwrap();
        std::fs::create_dir_all(source.join("WebDriverAgentLib/Routing")).unwrap();
        std::fs::write(source.join(WDA_LOOPBACK_SOURCE_FILE), WDA_UNSAFE_BIND_CALL).unwrap();
        let stage_root = tempfile::tempdir().unwrap().path().join("local-wda");
        let staged = stage_wda_project_at(&source, &stage_root).unwrap();

        let spec = build_wda_launch_spec(staged.clone(), "phone-17-pro", 12345, 23456);
        let args = wda_command_args(&spec);
        assert_eq!(spec.project, staged.project);
        assert_eq!(spec.derived_data, staged.derived_data);
        assert!(!spec.project.starts_with(&source));
        assert!(args.windows(2).any(|pair| {
            pair == [
                "-project".to_string(),
                staged.project.to_string_lossy().into_owned(),
            ]
        }));
        assert!(args.windows(2).any(|pair| {
            pair == [
                "-derivedDataPath".to_string(),
                staged.derived_data.to_string_lossy().into_owned(),
            ]
        }));
        assert!(args.windows(2).any(|pair| {
            pair == ["-collect-test-diagnostics".to_string(), "never".to_string()]
        }));
    }

    #[test]
    fn frame_rate_meter_resets_before_measuring_the_fallback_source() {
        let start = Instant::now();
        let mut meter = FrameRateMeter::default();
        let mut source = None;
        switch_meter_source(&mut meter, &mut source, IosSimulatorStreamSource::Simctl);
        assert_eq!(meter.observe_at(start), None);
        assert_eq!(
            meter.observe_at(start + Duration::from_millis(100)),
            Some(10.0)
        );

        switch_meter_source(&mut meter, &mut source, IosSimulatorStreamSource::Mjpeg);
        assert_eq!(meter.observe_at(start + Duration::from_secs(1)), None);
        switch_meter_source(&mut meter, &mut source, IosSimulatorStreamSource::Simctl);
        assert_eq!(meter.observe_at(start + Duration::from_secs(20)), None);
        let fallback_fps = meter
            .observe_at(start + Duration::from_secs(20) + Duration::from_millis(500))
            .unwrap();
        assert!((fallback_fps - 2.0).abs() < f64::EPSILON);
    }

    #[test]
    fn normalized_points_map_across_phone_landscape_and_ipad_windows() {
        assert_eq!(
            normalized_to_wda_point(
                NormalizedPoint { x: 0.5, y: 0.25 },
                WdaWindowSize {
                    width: 393.0,
                    height: 852.0
                },
            )
            .unwrap(),
            WdaPoint { x: 196.5, y: 213.0 },
        );
        assert_eq!(
            normalized_to_wda_point(
                NormalizedPoint { x: 0.25, y: 0.5 },
                WdaWindowSize {
                    width: 852.0,
                    height: 393.0
                },
            )
            .unwrap(),
            WdaPoint { x: 213.0, y: 196.5 },
        );
        assert_eq!(
            normalized_to_wda_point(
                NormalizedPoint { x: 0.75, y: 0.5 },
                WdaWindowSize {
                    width: 1024.0,
                    height: 1366.0
                },
            )
            .unwrap(),
            WdaPoint { x: 768.0, y: 683.0 },
        );
        assert!(normalized_to_wda_point(
            NormalizedPoint { x: -0.1, y: 0.5 },
            WdaWindowSize {
                width: 393.0,
                height: 852.0
            },
        )
        .is_err());
    }

    #[test]
    fn input_queue_prevents_text_from_overtaking_a_blocked_tap() {
        let client = Arc::new(BlockingInputWdaClient::new());
        let service = service_with_active_wda(client.clone());
        let tap_service = service.clone();
        let tap = thread::spawn(move || {
            tap_service
                .tap_sync(NormalizedPoint { x: 0.5, y: 0.25 })
                .unwrap();
        });
        client.wait_for_tap();

        let text_service = service.clone();
        let text = thread::spawn(move || text_service.type_text_sync("Verboo").unwrap());
        sleep(Duration::from_millis(50));
        assert_eq!(client.calls.lock().unwrap().as_slice(), ["tap-start"]);

        client.release_tap();
        tap.join().unwrap();
        text.join().unwrap();
        assert_eq!(
            client.calls.lock().unwrap().as_slice(),
            ["tap-start", "tap-end", "type"],
        );
        service.detach_sync();
    }

    #[test]
    fn detach_leaves_xctest_session_teardown_to_the_interrupted_runner() {
        let client = Arc::new(BlockingInputWdaClient::new());
        let service = service_with_active_wda(client.clone());

        service.detach_sync();

        assert!(client.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn hiding_parks_preview_without_detaching_or_relaunching_wda() {
        let harness = ActiveSessionHarness::new(IosSimulatorOwnership::Verboo);
        harness.wait_for_first_frame();
        let launched = harness.wda_launches();
        harness.service.set_visible_sync(false).unwrap();
        harness.wait_for_preview_workers_to_park();
        let frames_when_hidden = harness.frames();
        sleep(Duration::from_millis(150));
        assert_eq!(harness.frames(), frames_when_hidden);
        assert!(harness.service.current_session_summary().is_some());
        assert_eq!(harness.wda_stops(), 0);
        harness.service.set_visible_sync(true).unwrap();
        harness.wait_for_more_frames(frames_when_hidden);
        assert_eq!(harness.wda_launches(), launched);
        harness.release_blocked_wda();
    }

    #[test]
    fn end_owned_shuts_down_exact_udid_after_workers_stop() {
        let harness = ActiveSessionHarness::new(IosSimulatorOwnership::Verboo);
        harness.service.end_owned_sync().unwrap();
        assert!(harness.stop_happened_before_shutdown());
        assert_eq!(harness.shutdown_udids(), vec!["phone-17-pro"]);
        assert!(harness.ledger.owned_udids().is_empty());
        harness.release_blocked_wda();
    }

    #[test]
    fn detach_external_stops_verboo_workers_but_never_shuts_device_down() {
        let harness = ActiveSessionHarness::new(IosSimulatorOwnership::External);
        harness.service.detach_external_sync().unwrap();
        assert_eq!(harness.wda_stops(), 1);
        assert!(harness.shutdown_udids().is_empty());
        harness.release_blocked_wda();
    }

    #[test]
    fn interaction_retry_keeps_session_and_fallback_generation() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let stopped = Arc::new(AtomicUsize::new(0));
        let launcher = Arc::new(FirstFailureWdaLauncher {
            inner: FakeWdaLauncher {
                delay: Duration::ZERO,
                fail: false,
                launched: AtomicUsize::new(0),
                stopped: stopped.clone(),
                force_stopped: Arc::new(AtomicUsize::new(0)),
                ports: Arc::new(Mutex::new(Vec::new())),
            },
            attempts: attempts.clone(),
        });
        let service =
            IosSimulatorService::with_dependencies(Arc::new(RecordingRunner::new()), launcher);
        let sink = Arc::new(CountingSink::default());
        service.start_session(
            test_device(),
            StreamProfile::DEFAULT,
            MAX_FPS,
            test_display_metrics(),
            Some(staged_wda_paths()),
            sink.clone(),
        );
        wait_until(
            || attempts.load(Ordering::Acquire) == 1,
            Duration::from_secs(1),
        );
        wait_until(
            || sink.frames.load(Ordering::Acquire) > 0,
            Duration::from_secs(1),
        );
        let generation = service.current_session_summary().unwrap().device_generation;
        service.retry_interaction_sync().unwrap();
        wait_until(
            || attempts.load(Ordering::Acquire) == 2,
            Duration::from_secs(1),
        );
        assert!(wait_for_wda_control(
            &service,
            Instant::now() + Duration::from_secs(2)
        ));
        assert!(service.lifecycle.snapshot().interaction_ready);
        assert_eq!(
            service.current_session_summary().unwrap().device_generation,
            generation
        );
        assert!(sink.frames.load(Ordering::Acquire) > 0);
        let _ = service.detach_sync();
    }

    #[test]
    fn app_exit_cleanup_stops_the_session_within_its_deadline() {
        let runner = Arc::new(RecordingRunner::new());
        let stopped = Arc::new(AtomicUsize::new(0));
        let force_stopped = Arc::new(AtomicUsize::new(0));
        let launcher = Arc::new(FakeWdaLauncher {
            delay: Duration::ZERO,
            fail: false,
            launched: AtomicUsize::new(0),
            stopped: stopped.clone(),
            force_stopped: force_stopped.clone(),
            ports: Arc::new(Mutex::new(Vec::new())),
        });
        let service = IosSimulatorService::with_dependencies(runner, launcher.clone());
        service.start_session(
            test_device(),
            StreamProfile::DEFAULT,
            MAX_FPS,
            test_display_metrics(),
            Some(staged_wda_paths()),
            Arc::new(CountingSink::default()),
        );
        assert!(wait_for_wda_control(
            &service,
            Instant::now() + Duration::from_secs(5)
        ));
        assert_eq!(launcher.launched.load(Ordering::SeqCst), 1);

        let started = Instant::now();
        service.stop_for_app_exit(Instant::now() + Duration::from_millis(100));

        assert!(started.elapsed() < Duration::from_millis(200));
        assert_eq!(stopped.load(Ordering::SeqCst), 1);
        assert_eq!(force_stopped.load(Ordering::SeqCst), 0);
        assert_eq!(service.attached().0, None);
    }

    #[test]
    fn app_exit_cancels_a_runner_that_has_not_spawned_yet() {
        let launcher = Arc::new(BlockingLaunchWdaLauncher::new());
        let service = IosSimulatorService::with_dependencies(
            Arc::new(RecordingRunner::new()),
            launcher.clone(),
        );
        service.start_session(
            test_device(),
            StreamProfile::DEFAULT,
            MAX_FPS,
            test_display_metrics(),
            Some(staged_wda_paths()),
            Arc::new(CountingSink::default()),
        );
        launcher.wait_until_entered();

        service.stop_for_app_exit(Instant::now() + Duration::from_millis(30));
        launcher.release();

        let deadline = Instant::now() + Duration::from_secs(1);
        while !launcher.completed.load(Ordering::Acquire) && Instant::now() < deadline {
            sleep(Duration::from_millis(5));
        }
        assert!(launcher.completed.load(Ordering::Acquire));
        assert_eq!(launcher.spawned.load(Ordering::SeqCst), 0);
        assert_eq!(service.attached().0, None);
    }

    struct ExitEventRunner {
        events: Arc<Mutex<Vec<&'static str>>>,
    }

    impl CommandRunner for ExitEventRunner {
        fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, String> {
            if program == "xcrun"
                && args.first().map(String::as_str) == Some("simctl")
                && args.get(1).map(String::as_str) == Some("shutdown")
            {
                let event = match args.get(2).map(String::as_str) {
                    Some("owned-phone") => "shutdown:owned-phone",
                    Some("external-ipad") => "shutdown:external-ipad",
                    _ => "shutdown:other",
                };
                self.events.lock().unwrap().push(event);
            }
            Ok(output(true, b"", b""))
        }
    }

    struct ExitRecordingProcess {
        events: Arc<Mutex<Vec<&'static str>>>,
    }

    impl RecordingProcess for ExitRecordingProcess {
        fn wait_until_started(&mut self, _deadline: Instant) -> Result<(), String> {
            Ok(())
        }

        fn interrupt_and_wait(&mut self, _deadline: Instant) -> Result<(), String> {
            self.events
                .lock()
                .unwrap()
                .extend(["recording-sigint", "recording-finalized"]);
            Ok(())
        }
    }

    struct FailingMediaBackend;

    impl SimulatorMediaBackend for FailingMediaBackend {
        fn screenshot(&self, _udid: &str, _display: &str, _path: &Path) -> Result<(), String> {
            Err("A Mesa foi negada pelo sistema (TCC)".into())
        }

        fn start_recording(
            &self,
            _udid: &str,
            _display: &str,
            _path: &Path,
        ) -> Result<Box<dyn RecordingProcess>, String> {
            Err("não usado no teste de captura".into())
        }

        fn reveal(&self, _path: &Path) -> Result<(), String> {
            Ok(())
        }
    }

    struct ExitMediaBackend;

    impl SimulatorMediaBackend for ExitMediaBackend {
        fn screenshot(&self, _udid: &str, _display: &str, path: &Path) -> Result<(), String> {
            assert!(path.is_absolute(), "fake write must use absolute path, got: {path:?}");
            fs::write(path, b"fake-png").map_err(|error| error.to_string())
        }

        fn start_recording(
            &self,
            _udid: &str,
            _display: &str,
            _path: &Path,
        ) -> Result<Box<dyn RecordingProcess>, String> {
            Err("não esperado durante o cleanup".into())
        }

        fn reveal(&self, _path: &Path) -> Result<(), String> {
            Ok(())
        }
    }

    struct ExitHarness {
        service: IosSimulatorService,
        events: Arc<Mutex<Vec<&'static str>>>,
        _desktop: tempfile::TempDir,
    }

    impl ExitHarness {
        fn with_owned_and_external_devices() -> Self {
            let events = Arc::new(Mutex::new(Vec::new()));
            let runner = Arc::new(ExitEventRunner {
                events: events.clone(),
            });
            let mut service = IosSimulatorService::with_runner(runner);
            service.media_backend = Arc::new(ExitMediaBackend);
            let desktop = tempfile::tempdir().unwrap();
            let partial_path = desktop
                .path()
                .join("Verboo Simulator - owned-phone.partial.mov");
            let final_path = desktop.path().join("Verboo Simulator - owned-phone.mov");
            fs::write(&partial_path, b"movie").unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            let worker_stop = stop.clone();
            let worker_events = events.clone();
            let worker = thread::spawn(move || {
                while !worker_stop.load(Ordering::Acquire) {
                    sleep(Duration::from_millis(1));
                }
                worker_events
                    .lock()
                    .unwrap()
                    .extend(["wda-sigint", "workers-stopped"]);
            });
            let device = IosSimulatorDevice {
                name: "Owned Phone".into(),
                udid: "owned-phone".into(),
                state: "Booted".into(),
                ios_version: "26.5".into(),
                family: IosSimulatorDeviceFamily::Iphone,
            };
            service.ownership.mark_booted("owned-phone").unwrap();
            service
                .lifecycle
                .begin(1, device.clone(), IosSimulatorOwnership::Verboo, true);
            service.state.lock().unwrap().session = Some(Session {
                device,
                device_generation: 1,
                ownership: IosSimulatorOwnership::Verboo,
                fallback_fps: Arc::new(Mutex::new(DEFAULT_FALLBACK_FPS)),
                stream_profile: Arc::new(Mutex::new(StreamProfile::DEFAULT)),
                stats: Arc::new(Mutex::new(StreamStats {
                    source: IosSimulatorStreamSource::Mjpeg,
                    effective_fps: Some(30.0),
                })),
                stop,
                input_lock: Arc::new(Mutex::new(())),
                latest_frame: Arc::new(Mutex::new(None)),
                gate: Arc::new(PreviewGate::new(true)),
                mjpeg_active: Arc::new(AtomicBool::new(false)),
                next_frame_generation: Arc::new(AtomicU64::new(0)),
                wda_control: Arc::new(Mutex::new(None)),
                wda_force_stop: Arc::new(Mutex::new(None)),
                staged_wda: None,
                sink: None,
                recording: Arc::new(Mutex::new(Some(ActiveRecording {
                    device_generation: 1,
                    partial_path,
                    final_path,
                    started_at_ms: 1,
                    process: Box::new(ExitRecordingProcess {
                        events: events.clone(),
                    }),
                }))),
                workers: Mutex::new(vec![worker]),
            });
            Self {
                service,
                events,
                _desktop: desktop,
            }
        }

        fn events(&self) -> Vec<&'static str> {
            let rejected_new_operation = self.service.set_visible_sync(false).is_err();
            let mut events = Vec::new();
            if rejected_new_operation {
                events.push("reject-new-operations");
            }
            events.extend(self.events.lock().unwrap().iter().copied());
            events
        }

        fn shutdown_count(&self, udid: &str) -> usize {
            let expected = match udid {
                "owned-phone" => "shutdown:owned-phone",
                "external-ipad" => "shutdown:external-ipad",
                _ => "shutdown:other",
            };
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| **event == expected)
                .count()
        }

        fn recording_interrupts(&self) -> usize {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| **event == "recording-sigint")
                .count()
        }
    }

    struct ExitDuringBootRunner {
        entered: (Mutex<bool>, Condvar),
        interrupted: AtomicBool,
        list_calls: AtomicUsize,
    }

    impl ExitDuringBootRunner {
        fn new() -> Self {
            Self {
                entered: (Mutex::new(false), Condvar::new()),
                interrupted: AtomicBool::new(false),
                list_calls: AtomicUsize::new(0),
            }
        }

        fn wait_until_bootstatus_blocks(&self) -> bool {
            let (entered, ready) = &self.entered;
            let mut entered = entered.lock().unwrap();
            let deadline = Instant::now() + Duration::from_millis(250);
            while !*entered {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return false;
                }
                let (guard, timeout) = ready.wait_timeout(entered, remaining).unwrap();
                entered = guard;
                if timeout.timed_out() && !*entered {
                    return false;
                }
            }
            true
        }
    }

    impl CommandRunner for ExitDuringBootRunner {
        fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, String> {
            if program == "xcodebuild" {
                return Ok(output(false, b"", b"xcodebuild unavailable\n"));
            }
            if program == "xcrun" && args == ["--find", "simctl"] {
                return Ok(output(true, b"/usr/bin/simctl\n", b""));
            }
            if program == "xcrun"
                && args.first().map(String::as_str) == Some("simctl")
                && args.get(1).map(String::as_str) == Some("list")
            {
                let state = if self.list_calls.fetch_add(1, Ordering::AcqRel) == 0 {
                    "Shutdown"
                } else {
                    "Booted"
                };
                let devices = format!(
                    r#"{{"devices":{{"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{{"name":"Owned Phone","udid":"owned-phone","state":"{state}","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"}}]}}}}"#
                );
                return Ok(output(true, devices.as_bytes(), b""));
            }
            Ok(output(true, b"", b""))
        }

        fn run_interruptible(
            &self,
            _program: &str,
            args: &[String],
            cancel: &AtomicBool,
            _deadline: Instant,
        ) -> Result<CommandOutput, String> {
            if args.get(1).map(String::as_str) == Some("bootstatus") {
                let (entered, ready) = &self.entered;
                *entered.lock().unwrap() = true;
                ready.notify_all();
                while !cancel.load(Ordering::Acquire) {
                    sleep(Duration::from_millis(1));
                }
                self.interrupted.store(true, Ordering::Release);
                return Err("operação do simulador cancelada".into());
            }
            Ok(output(true, b"", b""))
        }
    }

    struct ExitDuringBootHarness {
        service: IosSimulatorService,
        runner: Arc<ExitDuringBootRunner>,
    }

    impl ExitDuringBootHarness {
        fn new() -> Self {
            let runner = Arc::new(ExitDuringBootRunner::new());
            let service = IosSimulatorService::with_runner(runner.clone());
            Self { service, runner }
        }

        fn spawn_attach(&self) -> JoinHandle<Result<(), String>> {
            let runner = self.runner.clone();
            let ledger = self.service.ownership.clone();
            let cancel = self.service.exiting.clone();
            thread::spawn(move || {
                ledger.mark_boot_requested("owned-phone")?;
                let preparation = self::ownership::AttachPreparation {
                    device: IosSimulatorDevice {
                        name: "Owned Phone".into(),
                        udid: "owned-phone".into(),
                        state: "Shutdown".into(),
                        ios_version: "26.5".into(),
                        family: IosSimulatorDeviceFamily::Iphone,
                    },
                    ownership: IosSimulatorOwnership::Verboo,
                    boot_required: true,
                };
                complete_device_boot(
                    runner.as_ref(),
                    ledger.as_ref(),
                    preparation,
                    &cancel,
                    Instant::now() + Duration::from_secs(10),
                )
                .map(|_| ())
            })
        }

        fn wait_until_bootstatus_blocks(&self) -> bool {
            self.runner.wait_until_bootstatus_blocks()
        }

        fn bootstatus_was_interrupted(&self) -> bool {
            self.runner.interrupted.load(Ordering::Acquire)
        }
    }

    #[test]
    fn app_exit_finalizes_recording_then_stops_workers_then_shuts_owned_devices() {
        let harness = ExitHarness::with_owned_and_external_devices();
        let report = harness
            .service
            .stop_for_app_exit(Instant::now() + Duration::from_secs(1));
        assert_eq!(
            harness.events(),
            vec![
                "reject-new-operations",
                "recording-sigint",
                "recording-finalized",
                "wda-sigint",
                "workers-stopped",
                "shutdown:owned-phone",
            ]
        );
        assert_eq!(report.shutdown_udids, vec!["owned-phone"]);
        assert!(!harness.events().contains(&"shutdown:external-ipad"));
    }

    #[test]
    fn duplicate_exit_events_run_cleanup_once() {
        let harness = ExitHarness::with_owned_and_external_devices();
        harness
            .service
            .stop_for_app_exit(Instant::now() + Duration::from_secs(1));
        harness
            .service
            .stop_for_app_exit(Instant::now() + Duration::from_secs(1));
        assert_eq!(harness.shutdown_count("owned-phone"), 1);
        assert_eq!(harness.recording_interrupts(), 1);
    }

    #[test]
    fn exit_cancels_bootstatus_then_shuts_the_ledger_owned_device() {
        let harness = ExitDuringBootHarness::new();
        let attach = harness.spawn_attach();
        assert!(
            harness.wait_until_bootstatus_blocks(),
            "the cancellation harness must reach bootstatus without platform discovery"
        );
        harness.service.begin_exit();
        let report = harness
            .service
            .stop_for_app_exit(Instant::now() + Duration::from_secs(1));
        assert!(attach.join().unwrap().unwrap_err().contains("cancelada"));
        assert!(harness.bootstatus_was_interrupted());
        assert_eq!(report.shutdown_udids, vec!["owned-phone"]);
        assert!(harness.service.current_session_summary().is_none());
    }

    #[test]
    fn first_fallback_frame_publishes_before_wda_becomes_ready() {
        let launcher = Arc::new(BlockingLaunchWdaLauncher::new());
        let sink = Arc::new(CountingSink::default());
        let service = IosSimulatorService::with_dependencies(
            Arc::new(RecordingRunner::new()),
            launcher.clone(),
        );
        service.start_session(
            test_device(),
            StreamProfile::DEFAULT,
            MAX_FPS,
            test_display_metrics(),
            Some(staged_wda_paths()),
            sink.clone(),
        );
        launcher.wait_until_entered();
        wait_until(
            || sink.frames.load(Ordering::Acquire) > 0,
            Duration::from_secs(1),
        );
        assert!(sink.frames.load(Ordering::Acquire) > 0);
        assert_eq!(
            service.lifecycle.snapshot().stage,
            IosSimulatorStartupStage::PreparingInteraction,
        );
        assert!(!launcher.completed.load(Ordering::Acquire));
        service.stop_for_app_exit(Instant::now() + Duration::from_millis(30));
        launcher.release();
    }

    #[test]
    fn app_exit_force_stops_wda_only_after_the_cleanup_deadline() {
        let service = IosSimulatorService::with_runner(Arc::new(RecordingRunner::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let released = Arc::new(AtomicBool::new(false));
        let worker_finished = Arc::new(AtomicBool::new(false));
        let worker_released = released.clone();
        let worker_done = worker_finished.clone();
        let worker = thread::spawn(move || {
            while !worker_released.load(Ordering::Acquire) {
                sleep(Duration::from_millis(1));
            }
            worker_done.store(true, Ordering::Release);
        });
        let force_stopped = Arc::new(AtomicUsize::new(0));
        let forced = force_stopped.clone();
        let force_release = released.clone();
        let force_stop: WdaForceStop = Arc::new(move || {
            forced.fetch_add(1, Ordering::SeqCst);
            force_release.store(true, Ordering::Release);
        });
        service.state.lock().unwrap().session = Some(Session {
            device: test_device(),
            device_generation: 1,
            ownership: IosSimulatorOwnership::External,
            fallback_fps: Arc::new(Mutex::new(DEFAULT_FALLBACK_FPS)),
            stream_profile: Arc::new(Mutex::new(StreamProfile::DEFAULT)),
            stats: Arc::new(Mutex::new(StreamStats {
                source: IosSimulatorStreamSource::Mjpeg,
                effective_fps: Some(30.0),
            })),
            stop,
            input_lock: Arc::new(Mutex::new(())),
            latest_frame: Arc::new(Mutex::new(None)),
            gate: Arc::new(PreviewGate::new(true)),
            mjpeg_active: Arc::new(AtomicBool::new(false)),
            next_frame_generation: Arc::new(AtomicU64::new(0)),
            wda_control: Arc::new(Mutex::new(None)),
            wda_force_stop: Arc::new(Mutex::new(Some(force_stop))),
            staged_wda: None,
            sink: None,
            recording: Arc::new(Mutex::new(None)),
            workers: Mutex::new(vec![worker]),
        });

        let started = Instant::now();
        service.stop_for_app_exit(started + Duration::from_millis(30));

        assert!(started.elapsed() >= Duration::from_millis(20));
        assert_eq!(force_stopped.load(Ordering::SeqCst), 1);
        assert_eq!(service.attached().0, None);
        let finish_deadline = Instant::now() + Duration::from_millis(100);
        while !worker_finished.load(Ordering::Acquire) && Instant::now() < finish_deadline {
            sleep(Duration::from_millis(1));
        }
        assert!(worker_finished.load(Ordering::Acquire));
    }

    #[test]
    fn detach_stops_wda_worker_and_never_issues_shutdown() {
        let runner = Arc::new(RecordingRunner::new());
        let stopped = Arc::new(AtomicUsize::new(0));
        let force_stopped = Arc::new(AtomicUsize::new(0));
        let launcher = Arc::new(FakeWdaLauncher {
            delay: Duration::ZERO,
            fail: false,
            launched: AtomicUsize::new(0),
            stopped: stopped.clone(),
            force_stopped: force_stopped.clone(),
            ports: Arc::new(Mutex::new(Vec::new())),
        });
        let service = IosSimulatorService::with_dependencies(runner.clone(), launcher.clone());
        let sink = Arc::new(CountingSink::default());
        service.start_session(
            test_device(),
            StreamProfile::DEFAULT,
            MAX_FPS,
            test_display_metrics(),
            Some(staged_wda_paths()),
            sink,
        );
        let deadline = Instant::now() + Duration::from_secs(1);
        while launcher.launched.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            sleep(Duration::from_millis(10));
        }
        let port = loop {
            if let Some(port) = launcher.ports.lock().unwrap().first().copied() {
                break port;
            }
            assert!(Instant::now() < deadline, "WDA did not receive a port");
            sleep(Duration::from_millis(10));
        };
        let listener_deadline = Instant::now() + Duration::from_secs(1);
        while TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(20),
        )
        .is_err()
        {
            assert!(
                Instant::now() < listener_deadline,
                "fake WDA did not bind its loopback MJPEG port"
            );
            sleep(Duration::from_millis(10));
        }
        service.detach_sync();
        assert_eq!(stopped.load(Ordering::SeqCst), 1);
        assert_eq!(
            force_stopped.load(Ordering::SeqCst),
            0,
            "normal detach must let the WDA worker stop gracefully"
        );
        let cleanup_deadline = Instant::now() + Duration::from_secs(1);
        while TcpStream::connect_timeout(
            &SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(50),
        )
        .is_ok()
        {
            assert!(
                Instant::now() < cleanup_deadline,
                "detach left the MJPEG port listening"
            );
            sleep(Duration::from_millis(10));
        }
        assert!(!has_argument_fragment(&runner.calls(), "shutdown"));
    }

    #[test]
    fn unsupported_xcode_is_explicit() {
        assert!(matches!(
            IosSimulatorIssue::UnsupportedXcode,
            IosSimulatorIssue::UnsupportedXcode
        ));
        assert_eq!(xcode_major("25.3"), Some(25));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn requirements_list_devices_and_state() {
        let runner = RecordingRunner::new();
        let requirements = detect_requirements(&runner);
        assert!(requirements.ready);
        let phone = requirements
            .devices
            .iter()
            .find(|device| device.udid == "phone-17-pro")
            .unwrap();
        assert_eq!(phone.state, "Shutdown");
        assert_eq!(phone.ios_version, "26.5");
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_reports_unsupported_without_running_discovery_commands() {
        let runner = RecordingRunner::new();

        let requirements = detect_requirements(&runner);

        assert!(!requirements.ready);
        assert_eq!(
            requirements.issue,
            Some(IosSimulatorIssue::UnsupportedPlatform)
        );
        assert!(runner.calls().is_empty());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_reconciliation_preserves_the_ownership_ledger() {
        let runner = Arc::new(RecordingRunner::new());
        let service = IosSimulatorService::with_runner(runner.clone());
        service.ownership.mark_booted("owned-phone").unwrap();

        assert!(service.reconcile_owned_devices().unwrap().is_empty());
        assert_eq!(service.ownership.owned_udids(), vec!["owned-phone"]);
        assert!(runner.calls().is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn attach_boots_shutdown_device_but_skips_boot_for_booted_device() {
        let shutdown_runner = RecordingRunner::new();
        let shutdown_ledger = OwnershipLedger::in_memory();
        let shutdown_device = complete_device_boot(
            &shutdown_runner,
            &shutdown_ledger,
            prepare_device_for_attach(&shutdown_runner, &shutdown_ledger, "phone-17-pro").unwrap(),
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap()
        .device;
        assert_eq!(shutdown_device.state, "Booted");
        let shutdown_calls = shutdown_runner.calls();
        assert!(shutdown_calls.iter().any(|(_, args)| {
            is_simctl_command(args, "boot")
                && args.get(2).map(String::as_str) == Some("phone-17-pro")
        }));
        assert!(shutdown_calls.iter().any(|(_, args)| {
            is_simctl_command(args, "bootstatus")
                && args.get(2).map(String::as_str) == Some("phone-17-pro")
        }));
        assert!(shutdown_calls
            .iter()
            .filter(|(_, args)| is_simctl_command(args, "boot"))
            .all(|(_, args)| args.get(2).map(String::as_str) == Some("phone-17-pro")));
        assert!(shutdown_calls
            .iter()
            .filter(|(_, args)| is_simctl_command(args, "bootstatus"))
            .all(|(_, args)| args.get(2).map(String::as_str) == Some("phone-17-pro")));

        let booted_runner = RecordingRunner::booted();
        let booted_ledger = OwnershipLedger::in_memory();
        let booted_device =
            prepare_device_for_attach(&booted_runner, &booted_ledger, "phone-17-pro")
                .unwrap()
                .device;
        assert_eq!(booted_device.state, "Booted");
        let booted_calls = booted_runner.calls();
        assert!(!booted_calls
            .iter()
            .any(|(_, args)| is_simctl_command(args, "boot")));
        assert!(!booted_calls
            .iter()
            .any(|(_, args)| is_simctl_command(args, "bootstatus")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn external_booted_device_never_enters_the_ownership_ledger() {
        let ledger = Arc::new(OwnershipLedger::in_memory());
        let runner = RecordingRunner::booted();
        let preparation =
            prepare_device_for_attach(&runner, ledger.as_ref(), "phone-17-pro").unwrap();
        assert_eq!(preparation.ownership, IosSimulatorOwnership::External);
        assert!(!preparation.boot_required);
        assert!(ledger.owned_udids().is_empty());
        assert!(!has_argument_fragment(&runner.calls(), "bootstatus"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn boot_intent_exists_before_simctl_boot_runs() {
        let ledger = Arc::new(OwnershipLedger::in_memory());
        let runner = LedgerObservingRunner::new(ledger.clone(), "phone-17-pro");
        let preparation =
            prepare_device_for_attach(&runner, ledger.as_ref(), "phone-17-pro").unwrap();
        assert_eq!(
            ledger.phase("phone-17-pro"),
            Some(OwnershipPhase::BootRequested)
        );
        let prepared = complete_device_boot(
            &runner,
            ledger.as_ref(),
            preparation,
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();
        assert!(runner.saw_boot_requested_during_boot());
        assert_eq!(prepared.ownership, IosSimulatorOwnership::Verboo);
        assert_eq!(
            ledger.phase("phone-17-pro"),
            Some(OwnershipPhase::BootedByVerboo)
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn startup_reconciliation_shuts_down_only_recorded_devices() {
        let runner = Arc::new(ReconciliationRunner::new());
        let service = IosSimulatorService::with_runner(runner.clone());
        for udid in ["owned-phone", "owned-creating", "owned-shutdown"] {
            service.ownership.mark_booted(udid).unwrap();
        }

        let shutdown = service.reconcile_owned_devices().unwrap();

        assert_eq!(shutdown, vec!["owned-creating", "owned-phone"]);
        let calls = runner.calls();
        assert!(calls
            .iter()
            .any(|(_, args)| { args == &["simctl", "shutdown", "owned-phone"] }));
        assert!(calls
            .iter()
            .any(|(_, args)| { args == &["simctl", "shutdown", "owned-creating"] }));
        assert!(!calls
            .iter()
            .any(|(_, args)| { args == &["simctl", "shutdown", "external"] }));
        assert!(service.ownership.owned_udids().is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn startup_reconciliation_keeps_failed_shutdown_in_ledger() {
        let runner = Arc::new(ReconciliationRunner::with_shutdown_failures(&[
            "owned-phone",
        ]));
        let service = IosSimulatorService::with_runner(runner);
        service.ownership.mark_booted("owned-phone").unwrap();

        assert!(service.reconcile_owned_devices().is_ok());
        assert_eq!(service.ownership.owned_udids(), vec!["owned-phone"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn startup_reconciliation_continues_after_one_shutdown_failure() {
        let runner = Arc::new(ReconciliationRunner::with_shutdown_failures(&[
            "owned-creating",
        ]));
        let service = IosSimulatorService::with_runner(runner.clone());
        service.ownership.mark_booted("owned-phone").unwrap();
        service.ownership.mark_booted("owned-creating").unwrap();

        let shutdown = service.reconcile_owned_devices().unwrap();

        assert_eq!(shutdown, vec!["owned-phone"]);
        assert_eq!(service.ownership.owned_udids(), vec!["owned-creating"]);
        assert!(runner
            .calls()
            .iter()
            .any(|(_, args)| { args == &["simctl", "shutdown", "owned-phone"] }));
        assert!(runner
            .calls()
            .iter()
            .any(|(_, args)| { args == &["simctl", "shutdown", "owned-creating"] }));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn missing_xcode_does_not_abort_startup_and_preserves_owned_ledger() {
        let runner = Arc::new(RecordingRunner {
            xcode_available: false,
            ..RecordingRunner::default()
        });
        let empty_service = IosSimulatorService::with_runner(runner.clone());
        assert!(empty_service.ownership.owned_udids().is_empty());
        assert!(empty_service.reconcile_owned_devices().is_ok());

        let owned_service = IosSimulatorService::with_runner(runner);
        owned_service.ownership.mark_booted("owned-phone").unwrap();
        assert!(owned_service.reconcile_owned_devices().is_ok());
        assert_eq!(owned_service.ownership.owned_udids(), vec!["owned-phone"]);
    }

    #[test]
    fn screenshot_capture_reads_the_png_file_written_by_simctl() {
        let runner = RecordingRunner::new();
        let bytes = capture_screenshot(&runner, "phone-17-pro").unwrap();
        assert_eq!(bytes, b"fake-png");
        assert!(image_data_url(&bytes, "image/png").starts_with("data:image/png;base64,"));
        let calls = runner.calls();
        let screenshot = calls
            .iter()
            .find(|(_, args)| {
                args.starts_with(&["simctl".into(), "io".into(), "phone-17-pro".into()])
            })
            .expect("screenshot command should be recorded");
        assert_ne!(screenshot.1.last().map(String::as_str), Some("-"));
    }

    #[tokio::test]
    async fn detach_stops_capture_and_never_shuts_down_device() {
        let runner = Arc::new(RecordingRunner::new());
        let service = IosSimulatorService::with_runner(runner.clone());
        let sink = Arc::new(CountingSink::default());
        service.start_session(
            test_device(),
            StreamProfile::DEFAULT,
            MAX_FPS,
            test_display_metrics(),
            None,
            sink.clone(),
        );
        tokio::time::sleep(Duration::from_millis(80)).await;
        service.detach_sync();
        let frames_at_detach = sink.frames.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(sink.frames.load(Ordering::SeqCst), frames_at_detach);
        assert_eq!(sink.errors.load(Ordering::SeqCst), 0);
        let calls = runner.calls();
        assert!(
            !has_argument_fragment(&calls, "shutdown"),
            "detach must not issue any shutdown command; recorded calls: {calls:?}"
        );
    }

    #[test]
    fn detach_external_emits_idle_snapshot_as_last_lifecycle_event() {
        let runner = Arc::new(RecordingRunner::new());
        let service = IosSimulatorService::with_runner(runner.clone());
        let sink = Arc::new(CountingSink::default());
        service.start_session(
            test_device(),
            StreamProfile::DEFAULT,
            MAX_FPS,
            test_display_metrics(),
            None,
            sink.clone(),
        );
        service.detach_sync().unwrap();
        let emissions = service.emitted_lifecycle_snapshots();
        let last = emissions.last().expect("a lifecycle event must be emitted");
        assert_eq!(
            *last,
            IosSimulatorLifecycleSnapshot::default(),
            "o ÚLTIMO evento de lifecycle após detach deve ser o snapshot Idle (sem udid, sem geração)"
        );
        assert_eq!(last.udid, None, "o snapshot de fim de sessão não pode carregar udid");
        assert_eq!(
            last.device_generation, None,
            "o snapshot de fim de sessão não pode carregar geração"
        );
        assert_eq!(last.stage, IosSimulatorStartupStage::Idle);
    }

    #[test]
    fn stale_stop_session_cannot_clear_a_newer_generation() {
        let runner = Arc::new(RecordingRunner::new());
        let service = IosSimulatorService::with_runner(runner.clone());
        let sink = Arc::new(CountingSink::default());
        service.start_session(
            test_device(),
            StreamProfile::DEFAULT,
            MAX_FPS,
            test_display_metrics(),
            None,
            sink.clone(),
        );
        let emissions_before = service.emitted_lifecycle_snapshots().len();
        // A sessão seguinte (geração 2) já começou: o lifecycle pertence a ela.
        service.lifecycle.begin(2, test_device(), IosSimulatorOwnership::External, true);
        // O fim da sessão velha (geração 1) chega atrasado.
        service.stop_current();
        let snapshot = service.lifecycle.snapshot();
        assert_eq!(
            snapshot.device_generation,
            Some(2),
            "o fim da sessão N não pode apagar a sessão N+1 que já começou"
        );
        assert_eq!(
            service.emitted_lifecycle_snapshots().len(),
            emissions_before,
            "o stop atrasado não pode emitir evento de limpeza sobre a geração nova"
        );
    }

    #[test]
    fn runtime_command_removes_inherited_developer_dir() {
        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let old = std::env::var_os("DEVELOPER_DIR");
        std::env::set_var("DEVELOPER_DIR", "/definitely-not-the-selected-xcode");
        let output = SystemCommandRunner
            .run(
                "sh",
                &["-c".into(), "printf '%s' \"${DEVELOPER_DIR-unset}\"".into()],
            )
            .unwrap();
        match old {
            Some(value) => std::env::set_var("DEVELOPER_DIR", value),
            None => std::env::remove_var("DEVELOPER_DIR"),
        }
        assert!(output.success);
        assert_eq!(output.stdout, b"unset");
    }

    #[cfg(unix)]
    #[test]
    fn wda_launcher_removes_inherited_developer_dir() {
        use std::os::unix::fs::PermissionsExt;

        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("xcodebuild-probe.sh");
        let observed = directory.path().join("developer-dir.txt");
        std::fs::write(
            &script,
            "#!/bin/sh\nprintf '%s' \"${DEVELOPER_DIR-unset}\" > \"$VERBOO_WDA_ENV_FILE\"\nsleep 5\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();

        let old_developer_dir = std::env::var_os("DEVELOPER_DIR");
        let old_probe_path = std::env::var_os("VERBOO_WDA_ENV_FILE");
        std::env::set_var("DEVELOPER_DIR", "/inherited-command-line-tools");
        std::env::set_var("VERBOO_WDA_ENV_FILE", &observed);

        let mut runner = RecordingRunner::new();
        runner.xcodebuild_path = Some(script.to_string_lossy().into_owned());
        let launcher = SystemWdaLauncher::new(Arc::new(runner));
        let spec = WdaLaunchSpec {
            project: PathBuf::from("/bundled/WebDriverAgent.xcodeproj"),
            derived_data: PathBuf::from("/local-app-data/ios-simulator/wda/derived-data"),
            destination_udid: "phone-17-pro".into(),
            http_port: 12345,
            mjpeg_port: 23456,
        };
        let stop = AtomicBool::new(false);
        let force_stop_slot = Mutex::new(None);
        let mut process = launcher.launch(&spec, &stop, &force_stop_slot).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while !observed.exists() && Instant::now() < deadline {
            sleep(Duration::from_millis(10));
        }
        process.process.stop();

        match old_developer_dir {
            Some(value) => std::env::set_var("DEVELOPER_DIR", value),
            None => std::env::remove_var("DEVELOPER_DIR"),
        }
        match old_probe_path {
            Some(value) => std::env::set_var("VERBOO_WDA_ENV_FILE", value),
            None => std::env::remove_var("VERBOO_WDA_ENV_FILE"),
        }

        assert_eq!(std::fs::read_to_string(observed).unwrap(), "unset");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn missing_or_unsupported_xcode_is_reported_as_a_requirement() {
        let mut missing = RecordingRunner::new();
        missing.xcode_available = false;
        assert_eq!(
            detect_requirements(&missing).issue,
            Some(IosSimulatorIssue::XcodeMissing)
        );

        let mut unsupported = RecordingRunner::new();
        unsupported.xcode_version = "25.4".into();
        assert_eq!(
            detect_requirements(&unsupported).issue,
            Some(IosSimulatorIssue::UnsupportedXcode),
        );
    }
}
