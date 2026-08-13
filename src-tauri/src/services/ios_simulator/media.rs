use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};

use super::{IosSimulatorDevice, IosSimulatorService};
use crate::services::child_signal;

const RECORDING_START_TIMEOUT: Duration = Duration::from_secs(10);
const RECORDING_STOP_TIMEOUT: Duration = Duration::from_secs(8);

pub(crate) trait RecordingProcess: Send {
    fn wait_until_started(&mut self, deadline: Instant) -> Result<(), String>;
    fn interrupt_and_wait(&mut self, deadline: Instant) -> Result<(), String>;
}

pub(crate) trait SimulatorMediaBackend: Send + Sync {
    fn screenshot(&self, udid: &str, display: &str, path: &Path) -> Result<(), String>;
    fn start_recording(
        &self,
        udid: &str,
        display: &str,
        path: &Path,
    ) -> Result<Box<dyn RecordingProcess>, String>;
    fn reveal(&self, path: &Path) -> Result<(), String>;
}

pub(crate) struct SystemSimulatorMediaBackend;

impl SimulatorMediaBackend for SystemSimulatorMediaBackend {
    fn screenshot(&self, udid: &str, display: &str, path: &Path) -> Result<(), String> {
        let mut command = Command::new("xcrun");
        command
            .args(["simctl", "io", udid, "screenshot"])
            .arg(format!("--display={display}"))
            .arg(path);
        child_signal::configure_process_group(&mut command);
        crate::services::cli_spawn::apply_creation_flags(&mut command);
        let output = command.output().map_err(|error| error.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "não foi possível capturar a tela do simulador: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }

    fn start_recording(
        &self,
        udid: &str,
        display: &str,
        path: &Path,
    ) -> Result<Box<dyn RecordingProcess>, String> {
        let mut command = Command::new("xcrun");
        command
            .arg("simctl")
            .arg("io")
            .arg(udid)
            .arg("recordVideo")
            .arg("--codec=h264")
            .arg(format!("--display={display}"))
            .arg(path);
        child_signal::configure_process_group(&mut command);
        crate::services::cli_spawn::apply_creation_flags(&mut command);
        let mut child = command
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("não foi possível iniciar a gravação: {error}"))?;
        let stderr = match child.stderr.take() {
            Some(stderr) => stderr,
            None => {
                let _ = child_signal::interrupt_child_until(
                    &mut child,
                    Instant::now() + RECORDING_STOP_TIMEOUT,
                );
                return Err("o simctl não forneceu stderr para a gravação".to_string());
            }
        };
        Ok(Box::new(SystemRecordingProcess::new(child, stderr)))
    }

    fn reveal(&self, path: &Path) -> Result<(), String> {
        if !cfg!(target_os = "macos") {
            return Err("Revelar arquivos do simulador exige macOS.".to_string());
        }
        let mut command = Command::new("/usr/bin/open");
        command.arg("-R").arg(path);
        crate::services::cli_spawn::apply_creation_flags(&mut command);
        let output = command.output().map_err(|error| error.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "não foi possível revelar o arquivo no Finder: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }
}

struct SystemRecordingProcess {
    child: Child,
    started: Receiver<Result<(), String>>,
    stderr_reader: Option<JoinHandle<()>>,
}

impl SystemRecordingProcess {
    fn new(child: Child, stderr: impl std::io::Read + Send + 'static) -> Self {
        let (sender, started) = mpsc::channel();
        let stderr_reader = Some(thread::spawn(move || read_recording_stderr(stderr, sender)));
        Self {
            child,
            started,
            stderr_reader,
        }
    }
}

fn read_recording_stderr(stderr: impl std::io::Read, sender: Sender<Result<(), String>>) {
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) if line.contains("Recording started") => {
                let _ = sender.send(Ok(()));
            }
            Ok(_) => {}
            Err(error) => {
                let _ = sender.send(Err(format!("falha lendo o estado da gravação: {error}")));
                break;
            }
        }
    }
}

impl RecordingProcess for SystemRecordingProcess {
    fn wait_until_started(&mut self, deadline: Instant) -> Result<(), String> {
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match self
                .started
                .recv_timeout(Duration::from_millis(50).min(remaining))
            {
                Ok(result) => return result,
                Err(RecvTimeoutError::Timeout) => {
                    if let Some(status) =
                        self.child.try_wait().map_err(|error| error.to_string())?
                    {
                        return Err(format!("a gravação encerrou antes de iniciar ({status})"));
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("a gravação encerrou antes de sinalizar início".to_string())
                }
            }
        }
        Err("a gravação não ficou pronta dentro do prazo".to_string())
    }

    fn interrupt_and_wait(&mut self, deadline: Instant) -> Result<(), String> {
        let result = child_signal::interrupt_child_until(&mut self.child, deadline);
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
        result
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IosSimulatorMediaFile {
    pub path: String,
    pub file_name: String,
}

pub(crate) struct ActiveRecording {
    pub device_generation: u64,
    pub partial_path: PathBuf,
    pub final_path: PathBuf,
    pub started_at_ms: u64,
    pub process: Box<dyn RecordingProcess>,
}

pub(crate) fn output_stem(device_name: &str, now: DateTime<Local>) -> String {
    format!(
        "Verboo Simulator - {} - {}",
        sanitize_component(device_name),
        now.format("%Y-%m-%d %H.%M.%S"),
    )
}

fn sanitize_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, ' ' | '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let sanitized = sanitized.trim().trim_matches('.');
    if sanitized.is_empty() {
        "Simulator".to_string()
    } else {
        sanitized.to_string()
    }
}

pub(crate) fn collision_safe_path(desktop: &Path, stem: &str, extension: &str) -> PathBuf {
    for suffix in 0_u32.. {
        let file_name = if suffix == 0 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem} ({suffix}).{extension}")
        };
        let candidate = desktop.join(&file_name);
        let candidate_stem = file_name
            .strip_suffix(&format!(".{extension}"))
            .expect("media candidate must have the requested extension");
        let partial = desktop.join(format!("{candidate_stem}.partial.{extension}"));
        if !candidate.exists() && !partial.exists() {
            return candidate;
        }
    }
    unreachable!("u32 suffix space exhausted")
}

pub(crate) fn capture_screen(
    backend: &dyn SimulatorMediaBackend,
    desktop: &Path,
    device: &IosSimulatorDevice,
) -> Result<IosSimulatorMediaFile, String> {
    fs::create_dir_all(desktop)
        .map_err(|error| format!("não foi possível usar a Mesa: {error}"))?;
    let final_path = collision_safe_path(desktop, &output_stem(&device.name, Local::now()), "png");
    let partial_path = partial_path_for(&final_path);
    let result = (|| {
        backend.screenshot(&device.udid, "internal", &partial_path)?;
        sync_file(&partial_path)?;
        fs::rename(&partial_path, &final_path)
            .map_err(|error| format!("não foi possível promover a captura: {error}"))?;
        Ok(media_file(&final_path))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial_path);
    }
    result
}

pub(crate) fn start_recording(
    backend: &dyn SimulatorMediaBackend,
    desktop: &Path,
    device: &IosSimulatorDevice,
) -> Result<ActiveRecording, String> {
    fs::create_dir_all(desktop)
        .map_err(|error| format!("não foi possível usar a Mesa: {error}"))?;
    let final_path = collision_safe_path(desktop, &output_stem(&device.name, Local::now()), "mov");
    let partial_path = partial_path_for(&final_path);
    let mut process = match backend.start_recording(&device.udid, "internal", &partial_path) {
        Ok(process) => process,
        Err(error) => {
            let _ = fs::remove_file(&partial_path);
            return Err(error);
        }
    };
    if let Err(error) = process.wait_until_started(Instant::now() + RECORDING_START_TIMEOUT) {
        let _ = process.interrupt_and_wait(Instant::now() + RECORDING_STOP_TIMEOUT);
        let _ = fs::remove_file(&partial_path);
        return Err(error);
    }
    Ok(ActiveRecording {
        device_generation: 0,
        partial_path,
        final_path,
        started_at_ms: super::unix_time_ms(),
        process,
    })
}

pub(crate) fn stop_recording(recording: ActiveRecording) -> Result<IosSimulatorMediaFile, String> {
    stop_recording_until(recording, Instant::now() + RECORDING_STOP_TIMEOUT)
}

pub(crate) fn stop_recording_until(
    mut recording: ActiveRecording,
    deadline: Instant,
) -> Result<IosSimulatorMediaFile, String> {
    recording.process.interrupt_and_wait(deadline)?;
    sync_file(&recording.partial_path)?;
    fs::rename(&recording.partial_path, &recording.final_path).map_err(|error| {
        format!(
            "não foi possível finalizar a gravação; o arquivo parcial foi preservado em {}: {error}",
            recording.partial_path.display()
        )
    })?;
    Ok(media_file(&recording.final_path))
}

fn partial_path_for(final_path: &Path) -> PathBuf {
    let stem = final_path
        .file_stem()
        .expect("media final path must have a stem")
        .to_string_lossy();
    let extension = final_path
        .extension()
        .expect("media final path must have an extension")
        .to_string_lossy();
    final_path.with_file_name(format!("{stem}.partial.{extension}"))
}

fn sync_file(path: &Path) -> Result<(), String> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("não foi possível abrir o arquivo de mídia: {error}"))?
        .sync_all()
        .map_err(|error| format!("não foi possível sincronizar o arquivo de mídia: {error}"))
}

fn media_file(path: &Path) -> IosSimulatorMediaFile {
    IosSimulatorMediaFile {
        path: path.to_string_lossy().into_owned(),
        file_name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        IosSimulatorDevice, IosSimulatorDeviceFamily, IosSimulatorOwnership,
        IosSimulatorRecordingState, IosSimulatorStreamSource, LatestFrameStore, PreviewGate,
        Session, StreamProfile, StreamStats,
    };
    use super::*;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Condvar, Mutex};
    use std::thread;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Signal {
        Interrupt,
        Wait,
    }

    #[derive(Default)]
    struct FakeRecordingState {
        started_waits: usize,
        signal_log: Vec<Signal>,
    }

    #[derive(Clone)]
    struct FakeRecordingProcess {
        state: Arc<Mutex<FakeRecordingState>>,
        release: Option<Arc<(Mutex<bool>, Condvar)>>,
    }

    impl FakeRecordingProcess {
        fn new() -> Self {
            Self {
                state: Arc::new(Mutex::new(FakeRecordingState::default())),
                release: None,
            }
        }

        fn blocking() -> Self {
            Self {
                state: Arc::new(Mutex::new(FakeRecordingState::default())),
                release: Some(Arc::new((Mutex::new(false), Condvar::new()))),
            }
        }

        fn started_waits(&self) -> usize {
            self.state.lock().unwrap().started_waits
        }

        fn signal_log(&self) -> Vec<Signal> {
            self.state.lock().unwrap().signal_log.clone()
        }

        fn wait_for_interrupt(&self) {
            while self.state.lock().unwrap().signal_log.is_empty() {
                thread::sleep(Duration::from_millis(1));
            }
        }

        fn release_interrupt(&self) {
            let release = self.release.as_ref().expect("blocking process");
            let (released, ready) = &**release;
            *released.lock().unwrap() = true;
            ready.notify_all();
        }
    }

    impl Default for FakeRecordingProcess {
        fn default() -> Self {
            Self::new()
        }
    }

    impl RecordingProcess for FakeRecordingProcess {
        fn wait_until_started(&mut self, _deadline: Instant) -> Result<(), String> {
            self.state.lock().unwrap().started_waits += 1;
            Ok(())
        }

        fn interrupt_and_wait(&mut self, _deadline: Instant) -> Result<(), String> {
            self.state.lock().unwrap().signal_log = vec![Signal::Interrupt];
            if let Some(release) = self.release.as_ref() {
                let (released, ready) = &**release;
                let mut released = released.lock().unwrap();
                while !*released {
                    released = ready.wait(released).unwrap();
                }
            }
            self.state.lock().unwrap().signal_log.push(Signal::Wait);
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeMediaState {
        screenshot_udids: Mutex<Vec<String>>,
        screenshot_displays: Mutex<Vec<String>>,
        process: Mutex<Option<FakeRecordingProcess>>,
        spawn_count: AtomicUsize,
    }

    #[derive(Clone, Default)]
    struct FakeMediaBackend {
        state: Arc<FakeMediaState>,
    }

    impl FakeMediaBackend {
        fn with_process(process: FakeRecordingProcess) -> Self {
            Self {
                state: Arc::new(FakeMediaState {
                    process: Mutex::new(Some(process)),
                    ..FakeMediaState::default()
                }),
            }
        }

        fn screenshot_udids(&self) -> Vec<String> {
            self.state.screenshot_udids.lock().unwrap().clone()
        }

        fn screenshot_displays(&self) -> Vec<String> {
            self.state.screenshot_displays.lock().unwrap().clone()
        }

        fn spawn_count(&self) -> usize {
            self.state.spawn_count.load(Ordering::Acquire)
        }
    }

    impl SimulatorMediaBackend for FakeMediaBackend {
        fn screenshot(&self, udid: &str, display: &str, path: &Path) -> Result<(), String> {
            self.state
                .screenshot_udids
                .lock()
                .unwrap()
                .push(udid.to_string());
            self.state
                .screenshot_displays
                .lock()
                .unwrap()
                .push(display.to_string());
            assert!(path.is_absolute(), "fake write must use absolute path, got: {path:?}");
            fs::write(path, b"fake-png").map_err(|error| error.to_string())
        }

        fn start_recording(
            &self,
            _udid: &str,
            _display: &str,
            path: &Path,
        ) -> Result<Box<dyn RecordingProcess>, String> {
            self.state.spawn_count.fetch_add(1, Ordering::AcqRel);
            assert!(path.is_absolute(), "fake write must use absolute path, got: {path:?}");
            fs::write(path, b"fake-mov").map_err(|error| error.to_string())?;
            Ok(Box::new(
                self.state
                    .process
                    .lock()
                    .unwrap()
                    .take()
                    .unwrap_or_default(),
            ))
        }

        fn reveal(&self, _path: &Path) -> Result<(), String> {
            Ok(())
        }
    }

    struct RecordingSessionHarness {
        service: IosSimulatorService,
        desktop_dir: tempfile::TempDir,
        backend: FakeMediaBackend,
    }

    impl RecordingSessionHarness {
        fn active() -> Self {
            let backend = FakeMediaBackend::with_process(FakeRecordingProcess::new());
            let desktop_dir = tempfile::tempdir().unwrap();
            let device = test_device();
            let mut recording = start_recording(&backend, desktop_dir.path(), &device).unwrap();
            recording.device_generation = 1;
            let service = IosSimulatorService::with_media_backend(Arc::new(backend.clone()));
            service.state.lock().unwrap().session = Some(Session {
                device,
                device_generation: 1,
                ownership: IosSimulatorOwnership::External,
                fallback_fps: Arc::new(Mutex::new(super::super::DEFAULT_FALLBACK_FPS)),
                stream_profile: Arc::new(Mutex::new(StreamProfile::DEFAULT)),
                stats: Arc::new(Mutex::new(StreamStats {
                    source: IosSimulatorStreamSource::Mjpeg,
                    effective_fps: Some(30.0),
                })),
                stop: Arc::new(AtomicBool::new(false)),
                input_lock: Arc::new(Mutex::new(())),
                latest_frame: Arc::new(LatestFrameStore::default()),
                gate: Arc::new(PreviewGate::new(true)),
                mjpeg_active: Arc::new(AtomicBool::new(false)),
                next_frame_generation: Arc::new(AtomicU64::new(0)),
                wda_control: Arc::new(Mutex::new(None)),
                wda_force_stop: Arc::new(Mutex::new(None)),
                staged_wda: None,
                sink: None,
                recording: Arc::new(Mutex::new(Some(recording))),
                workers: Mutex::new(Vec::new()),
            });
            Self {
                service,
                desktop_dir,
                backend,
            }
        }

        fn desktop(&self) -> &Path {
            self.desktop_dir.path()
        }

        fn spawn_count(&self) -> usize {
            self.backend.spawn_count()
        }
    }

    fn test_device() -> IosSimulatorDevice {
        IosSimulatorDevice {
            name: "iPhone 17 Pro".into(),
            udid: "phone-17-pro".into(),
            state: "Booted".into(),
            ios_version: "26.5".into(),
            family: IosSimulatorDeviceFamily::Iphone,
            ownership: None,
        }
    }

    #[test]
    fn screenshot_uses_exact_udid_and_promotes_one_atomic_png() {
        let desktop = tempfile::tempdir().unwrap();
        let backend = FakeMediaBackend::default();
        let first = capture_screen(&backend, desktop.path(), &test_device()).unwrap();
        let second = capture_screen(&backend, desktop.path(), &test_device()).unwrap();
        assert_eq!(
            backend.screenshot_udids(),
            vec!["phone-17-pro", "phone-17-pro"]
        );
        assert_eq!(backend.screenshot_displays(), vec!["internal", "internal"]);
        assert_ne!(first.path, second.path);
        assert!(first.path.ends_with(".png"));
        assert!(desktop.path().read_dir().unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("partial")
        }));
    }

    #[test]
    fn recording_waits_for_started_then_interrupts_and_finalizes() {
        let desktop = tempfile::tempdir().unwrap();
        let process = FakeRecordingProcess::new();
        let backend = FakeMediaBackend::with_process(process.clone());
        let recording = start_recording(&backend, desktop.path(), &test_device()).unwrap();
        assert_eq!(process.started_waits(), 1);
        let output = stop_recording(recording).unwrap();
        assert_eq!(process.signal_log(), vec![Signal::Interrupt, Signal::Wait]);
        assert!(output.path.ends_with(".mov"));
    }

    #[test]
    fn a_second_recording_is_rejected_without_spawning_a_process() {
        let harness = RecordingSessionHarness::active();
        let error = harness
            .service
            .start_recording_sync(harness.desktop())
            .unwrap_err();
        assert!(error.contains("já está em andamento"));
        assert_eq!(harness.spawn_count(), 1);
    }

    #[test]
    fn late_recording_finalization_cannot_mutate_a_newer_lifecycle() {
        let process = FakeRecordingProcess::blocking();
        let backend = FakeMediaBackend::with_process(process.clone());
        let desktop_dir = tempfile::tempdir().unwrap();
        let device = test_device();
        let mut recording = start_recording(&backend, desktop_dir.path(), &device).unwrap();
        recording.device_generation = 1;
        let service = IosSimulatorService::with_media_backend(Arc::new(backend));
        service.state.lock().unwrap().session = Some(Session {
            device: device.clone(),
            device_generation: 1,
            ownership: IosSimulatorOwnership::External,
            fallback_fps: Arc::new(Mutex::new(super::super::DEFAULT_FALLBACK_FPS)),
            stream_profile: Arc::new(Mutex::new(StreamProfile::DEFAULT)),
            stats: Arc::new(Mutex::new(StreamStats {
                source: IosSimulatorStreamSource::Mjpeg,
                effective_fps: Some(30.0),
            })),
            stop: Arc::new(AtomicBool::new(false)),
            input_lock: Arc::new(Mutex::new(())),
            latest_frame: Arc::new(LatestFrameStore::default()),
            gate: Arc::new(PreviewGate::new(true)),
            mjpeg_active: Arc::new(AtomicBool::new(false)),
            next_frame_generation: Arc::new(AtomicU64::new(0)),
            wda_control: Arc::new(Mutex::new(None)),
            wda_force_stop: Arc::new(Mutex::new(None)),
            staged_wda: None,
            sink: None,
            recording: Arc::new(Mutex::new(Some(recording))),
            workers: Mutex::new(Vec::new()),
        });

        let stopping = service.clone();
        let stop = thread::spawn(move || stopping.stop_recording_sync());
        process.wait_for_interrupt();
        service
            .lifecycle
            .begin(2, device, IosSimulatorOwnership::External, true);
        service
            .state
            .lock()
            .unwrap()
            .session
            .as_mut()
            .unwrap()
            .device_generation = 2;
        process.release_interrupt();

        let output = stop.join().unwrap().unwrap();
        assert!(output.path.ends_with(".mov"));
        let snapshot = service.lifecycle.snapshot();
        assert_eq!(snapshot.device_generation, Some(2));
        assert_eq!(snapshot.recording, IosSimulatorRecordingState::Idle);
    }
}
