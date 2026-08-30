//! Android emulator screenshots and recordings (PA-28).

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::capture_store::{AndroidEmulatorCaptureStore, NormalizedCaptureRect};
use super::session::AndroidSession;
use super::{
    AndroidAccessibilityNode, AndroidDevice, AndroidEmulatorRect, AndroidEmulatorService,
    CommandRunner, ANDROID_CLEANUP_BUDGET,
};
use crate::services::child_signal;

const RECORDING_START_TIMEOUT: Duration = Duration::from_secs(10);
const RECORDING_STOP_TIMEOUT: Duration = Duration::from_secs(8);
const ANDROID_SCREENRECORD_MAX_SECONDS: &str = "180";
const ANDROID_SCREENRECORD_BIT_RATE: &str = "8000000";

pub(crate) trait RecordingProcess: Send {
    fn wait_until_started(&mut self, deadline: Instant) -> Result<(), String>;
    fn interrupt_and_wait(&mut self, deadline: Instant) -> Result<(), String>;
}

pub(crate) trait AndroidMediaBackend: Send + Sync {
    fn screenshot(
        &self,
        runner: &dyn CommandRunner,
        adb: &Path,
        serial: &str,
        path: &Path,
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> Result<(), String>;
    fn start_recording(
        &self,
        runner: Arc<dyn CommandRunner>,
        adb: &Path,
        serial: &str,
        path: &Path,
        cancel: Arc<AtomicBool>,
    ) -> Result<Box<dyn RecordingProcess>, String>;
}

pub(crate) struct SystemAndroidMediaBackend;

impl AndroidMediaBackend for SystemAndroidMediaBackend {
    fn screenshot(
        &self,
        runner: &dyn CommandRunner,
        adb: &Path,
        serial: &str,
        path: &Path,
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> Result<(), String> {
        let output = runner.run_interruptible(
            adb.to_string_lossy().as_ref(),
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
        if !output.success {
            return Err(format!(
                "não foi possível capturar a tela do emulador Android: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        if output.stdout.is_empty() {
            return Err("adb não retornou uma captura de tela Android".to_string());
        }
        fs::write(path, output.stdout)
            .map_err(|error| format!("não foi possível salvar a captura Android: {error}"))
    }

    fn start_recording(
        &self,
        runner: Arc<dyn CommandRunner>,
        adb: &Path,
        serial: &str,
        path: &Path,
        cancel: Arc<AtomicBool>,
    ) -> Result<Box<dyn RecordingProcess>, String> {
        let remote_path = remote_recording_path(path);
        let mut command = Command::new(adb);
        command.args(build_screenrecord_args(serial, &remote_path));
        command.stdout(Stdio::null()).stderr(Stdio::piped());
        child_signal::configure_process_group(&mut command);
        crate::services::cli_spawn::apply_creation_flags(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("não foi possível iniciar a gravação Android: {error}"))?;
        let stderr = match child.stderr.take() {
            Some(stderr) => stderr,
            None => {
                let _ = child_signal::interrupt_child_until(
                    &mut child,
                    Instant::now() + RECORDING_STOP_TIMEOUT,
                );
                return Err("o adb não forneceu stderr para a gravação Android".to_string());
            }
        };
        Ok(Box::new(SystemRecordingProcess::new(
            child,
            stderr,
            runner,
            cancel,
            adb.to_path_buf(),
            serial.to_string(),
            remote_path,
            path.to_path_buf(),
        )))
    }
}

struct SystemRecordingProcess {
    child: Child,
    started: Receiver<Result<(), String>>,
    stderr_reader: Option<JoinHandle<()>>,
    runner: Arc<dyn CommandRunner>,
    cleanup_cancel: Arc<AtomicBool>,
    adb: PathBuf,
    serial: String,
    remote_path: String,
    local_path: PathBuf,
}

impl SystemRecordingProcess {
    fn new(
        child: Child,
        stderr: impl Read + Send + 'static,
        runner: Arc<dyn CommandRunner>,
        cleanup_cancel: Arc<AtomicBool>,
        adb: PathBuf,
        serial: String,
        remote_path: String,
        local_path: PathBuf,
    ) -> Self {
        let (sender, started) = mpsc::channel();
        let stderr_reader = Some(thread::spawn(move || read_recording_stderr(stderr, sender)));
        Self {
            child,
            started,
            stderr_reader,
            runner,
            cleanup_cancel,
            adb,
            serial,
            remote_path,
            local_path,
        }
    }
}

fn read_recording_stderr(stderr: impl Read, sender: Sender<Result<(), String>>) {
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) if line.to_ascii_lowercase().contains("error") => {
                let _ = sender.send(Err(line.trim().to_string()));
                break;
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
            match self.started.try_recv() {
                Ok(result) => {
                    if result.is_err() {
                        return result;
                    }
                }
                Err(TryRecvError::Disconnected) => {}
                Err(TryRecvError::Empty) => {}
            }
            if let Some(status) = self.child.try_wait().map_err(|error| error.to_string())? {
                return Err(format!(
                    "a gravação Android encerrou antes de iniciar ({status})"
                ));
            }
            // screenrecord does not guarantee a portable "started" line on
            // every Android API level. A live child after one poll is the
            // backend's start acknowledgement; stderr remains drained.
            thread::sleep(Duration::from_millis(25));
            if self
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
            {
                return Ok(());
            }
        }
        Err("a gravação Android não ficou pronta dentro do prazo".to_string())
    }

    fn interrupt_and_wait(&mut self, deadline: Instant) -> Result<(), String> {
        let result = child_signal::interrupt_child_until(&mut self.child, deadline);
        if let Some(reader) = self.stderr_reader.take() {
            let _ = reader.join();
        }
        result?;

        let adb = self.adb.to_string_lossy().into_owned();
        let output = self.runner.run_interruptible(
            &adb,
            &[
                "-s".to_string(),
                self.serial.clone(),
                "pull".to_string(),
                self.remote_path.clone(),
                self.local_path.to_string_lossy().into_owned(),
            ],
            self.cleanup_cancel.as_ref(),
            deadline,
        )?;
        if !output.success {
            return Err(format!(
                "não foi possível recuperar a gravação Android: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }

        let _ = self.runner.run_interruptible(
            &adb,
            &[
                "-s".to_string(),
                self.serial.clone(),
                "shell".to_string(),
                "rm".to_string(),
                "-f".to_string(),
                self.remote_path.clone(),
            ],
            self.cleanup_cancel.as_ref(),
            deadline,
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AndroidEmulatorMediaFile {
    pub path: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AndroidEmulatorOrientation {
    Portrait,
    Landscape,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AndroidEmulatorAnnotationCapture {
    pub crop_path: String,
    pub viewport_path: String,
    pub crop_width: u32,
    pub crop_height: u32,
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub crop_bytes: usize,
    pub viewport_bytes: usize,
    pub device: AndroidDevice,
    pub orientation: AndroidEmulatorOrientation,
    pub device_generation: u64,
    pub frame_generation: u64,
    pub rect: AndroidEmulatorRect,
    pub device_rect: AndroidEmulatorRect,
    pub element: Option<AndroidAccessibilityNode>,
}

pub(crate) struct ActiveRecording {
    pub(crate) partial_path: PathBuf,
    pub(crate) final_path: PathBuf,
    pub(crate) process: Box<dyn RecordingProcess>,
}

pub(crate) fn output_stem(device_name: &str, now: DateTime<Local>) -> String {
    format!(
        "Verboo Android - {} - {}",
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
        "Android Emulator".to_string()
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
    backend: &dyn AndroidMediaBackend,
    runner: &dyn CommandRunner,
    desktop: &Path,
    adb: &Path,
    serial: &str,
    device_name: &str,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<AndroidEmulatorMediaFile, String> {
    fs::create_dir_all(desktop)
        .map_err(|error| format!("não foi possível usar a Mesa: {error}"))?;
    let final_path = collision_safe_path(desktop, &output_stem(device_name, Local::now()), "png");
    let partial_path = partial_path_for(&final_path);
    let result = (|| {
        backend.screenshot(runner, adb, serial, &partial_path, cancel, deadline)?;
        sync_file(&partial_path)?;
        fs::rename(&partial_path, &final_path)
            .map_err(|error| format!("não foi possível promover a captura Android: {error}"))?;
        Ok(media_file(&final_path))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial_path);
    }
    result
}

pub(crate) fn build_screenrecord_args(serial: &str, remote_path: &str) -> Vec<String> {
    vec![
        "-s".to_string(),
        serial.to_string(),
        "shell".to_string(),
        "screenrecord".to_string(),
        "--time-limit".to_string(),
        ANDROID_SCREENRECORD_MAX_SECONDS.to_string(),
        "--bit-rate".to_string(),
        ANDROID_SCREENRECORD_BIT_RATE.to_string(),
        remote_path.to_string(),
    ]
}

fn remote_recording_path(local_path: &Path) -> String {
    let stem = local_path
        .file_stem()
        .map(|value| value.to_string_lossy())
        .unwrap_or_else(|| std::borrow::Cow::Borrowed("verboo-recording"));
    let safe = stem
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    format!("/sdcard/{}.mp4", safe.trim_matches('-'))
}

pub(crate) fn start_recording(
    backend: &dyn AndroidMediaBackend,
    runner: Arc<dyn CommandRunner>,
    desktop: &Path,
    adb: &Path,
    serial: &str,
    device_name: &str,
) -> Result<ActiveRecording, String> {
    fs::create_dir_all(desktop)
        .map_err(|error| format!("não foi possível usar a Mesa: {error}"))?;
    let final_path = collision_safe_path(desktop, &output_stem(device_name, Local::now()), "mp4");
    let partial_path = partial_path_for(&final_path);
    let cleanup_cancel = Arc::new(AtomicBool::new(false));
    let mut process =
        match backend.start_recording(runner, adb, serial, &partial_path, cleanup_cancel) {
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
        partial_path,
        final_path,
        process,
    })
}

pub(crate) fn stop_recording(
    recording: ActiveRecording,
) -> Result<AndroidEmulatorMediaFile, String> {
    stop_recording_until(recording, Instant::now() + RECORDING_STOP_TIMEOUT)
}

pub(crate) fn stop_recording_until(
    mut recording: ActiveRecording,
    deadline: Instant,
) -> Result<AndroidEmulatorMediaFile, String> {
    recording.process.interrupt_and_wait(deadline)?;
    sync_file(&recording.partial_path)?;
    fs::rename(&recording.partial_path, &recording.final_path).map_err(|error| {
        format!(
            "não foi possível finalizar a gravação Android; o arquivo parcial foi preservado em {}: {error}",
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
        .map_err(|error| format!("não foi possível abrir o arquivo de mídia Android: {error}"))?
        .sync_all()
        .map_err(|error| {
            format!("não foi possível sincronizar o arquivo de mídia Android: {error}")
        })
}

fn media_file(path: &Path) -> AndroidEmulatorMediaFile {
    AndroidEmulatorMediaFile {
        path: path.to_string_lossy().into_owned(),
    }
}

impl AndroidEmulatorService {
    pub(crate) fn capture_screen_sync(
        &self,
        desktop: &Path,
    ) -> Result<AndroidEmulatorMediaFile, String> {
        let _operation = self
            .operation_lock
            .lock()
            .expect("Android emulator operation lock poisoned");
        let session = self.current_session()?;
        let file = capture_screen(
            self.media_backend.as_ref(),
            self.runner.as_ref(),
            desktop,
            &session.adb_path,
            &session.serial,
            &session.device.display_name,
            session.stop.as_ref(),
            Instant::now() + ANDROID_CLEANUP_BUDGET,
        )?;
        let current_generation = self
            .current_session()
            .map(|current| current.generation)
            .ok();
        if current_generation != Some(session.generation) {
            return Err("A captura pertence a outra sessão do emulador Android.".to_string());
        }
        Ok(file)
    }

    pub(crate) fn capture_annotation_sync(
        &self,
        store: &AndroidEmulatorCaptureStore,
        device_generation: u64,
        rect: AndroidEmulatorRect,
        element: Option<AndroidAccessibilityNode>,
    ) -> Result<AndroidEmulatorAnnotationCapture, String> {
        let _operation = self
            .operation_lock
            .lock()
            .expect("Android emulator operation lock poisoned");
        let session = self.current_session()?;
        if session.generation != device_generation {
            return Err("A captura pertence a outra sessão do emulador Android.".into());
        }

        fs::create_dir_all(store.temp_root())
            .map_err(|error| format!("create android emulator temp store falhou: {error}"))?;
        let staging = store.temp_root().join(format!("{}.png", Uuid::new_v4()));
        let written = match (|| {
            self.media_backend.screenshot(
                self.runner.as_ref(),
                &session.adb_path,
                &session.serial,
                &staging,
                session.stop.as_ref(),
                Instant::now() + ANDROID_CLEANUP_BUDGET,
            )?;
            let bytes = fs::read(&staging).map_err(|error| {
                format!("read android emulator annotation staging falhou: {error}")
            })?;
            store.write_capture(
                &bytes,
                NormalizedCaptureRect {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                },
            )
        })() {
            Ok(written) => {
                let _ = fs::remove_file(&staging);
                written
            }
            Err(error) => {
                let _ = fs::remove_file(&staging);
                return Err(error);
            }
        };

        let still_current = self
            .current_session()
            .ok()
            .map(|current| current.generation == device_generation)
            .unwrap_or(false);
        if !still_current {
            let _ = store.delete_temp_files(vec![
                written.crop_path.clone(),
                written.viewport_path.clone(),
            ]);
            return Err("A sessão do emulador Android mudou durante a captura.".into());
        }

        let device_rect = element
            .as_ref()
            .map(|node| node.frame)
            .unwrap_or(AndroidEmulatorRect {
                x: rect.x * f64::from(written.viewport_width),
                y: rect.y * f64::from(written.viewport_height),
                width: rect.width * f64::from(written.viewport_width),
                height: rect.height * f64::from(written.viewport_height),
            });

        Ok(AndroidEmulatorAnnotationCapture {
            crop_path: written.crop_path,
            viewport_path: written.viewport_path,
            crop_width: written.crop_width,
            crop_height: written.crop_height,
            viewport_width: written.viewport_width,
            viewport_height: written.viewport_height,
            crop_bytes: written.crop_bytes,
            viewport_bytes: written.viewport_bytes,
            device: session.device.clone(),
            orientation: if written.viewport_height >= written.viewport_width {
                AndroidEmulatorOrientation::Portrait
            } else {
                AndroidEmulatorOrientation::Landscape
            },
            device_generation,
            frame_generation: session.generation,
            rect,
            device_rect,
            element,
        })
    }

    pub(crate) fn start_recording_sync(&self, desktop: &Path) -> Result<(), String> {
        let _operation = self
            .operation_lock
            .lock()
            .expect("Android emulator operation lock poisoned");
        let session = self.current_session()?;
        let mut recording = session
            .recording
            .lock()
            .expect("Android emulator recording poisoned");
        if recording.is_some() {
            return Err("uma gravação já está em andamento".to_string());
        }
        let active = start_recording(
            self.media_backend.as_ref(),
            self.runner.clone(),
            desktop,
            &session.adb_path,
            &session.serial,
            &session.device.display_name,
        )?;
        *recording = Some(active);
        Ok(())
    }

    pub(crate) fn stop_recording_sync(&self) -> Result<AndroidEmulatorMediaFile, String> {
        let _operation = self
            .operation_lock
            .lock()
            .expect("Android emulator operation lock poisoned");
        let session = self.current_session()?;
        let recording = session
            .recording
            .lock()
            .expect("Android emulator recording poisoned")
            .take()
            .ok_or_else(|| "não há gravação em andamento".to_string())?;
        stop_recording_until(recording, Instant::now() + ANDROID_CLEANUP_BUDGET)
    }

    pub(crate) fn finalize_recording_for_session(
        &self,
        session: &AndroidSession,
        deadline: Instant,
    ) -> Result<(), String> {
        let recording = session
            .recording
            .lock()
            .expect("Android emulator recording poisoned")
            .take();
        let Some(recording) = recording else {
            return Ok(());
        };
        if let Err(error) = stop_recording_until(recording, deadline) {
            if let Some(app) = self
                .app
                .lock()
                .expect("Android emulator app handle poisoned")
                .clone()
            {
                super::session::emit_error(
                    &app,
                    super::session::AndroidEmulatorError::from_message(error.clone()),
                );
            }
            return Err(error);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    use crate::services::android_emulator::preview::{FirstPreviewGate, PreviewMode};
    use crate::services::android_emulator::requirements::AndroidDeviceFamily;
    use crate::services::android_emulator::session::{
        AndroidEmulatorOwnership, AndroidSession, PreviewGate, PreviewRuntime,
    };
    use crate::services::android_emulator::AndroidDevice;

    use super::super::capture_store::AndroidEmulatorCaptureStore;
    use super::super::AndroidEmulatorRect;

    #[derive(Default)]
    struct FakeBackend {
        calls: Mutex<Vec<String>>,
        recording_process: Mutex<Option<FakeRecordingProcess>>,
    }

    impl AndroidMediaBackend for FakeBackend {
        fn screenshot(
            &self,
            _runner: &dyn CommandRunner,
            adb: &Path,
            serial: &str,
            path: &Path,
            _cancel: &AtomicBool,
            _deadline: Instant,
        ) -> Result<(), String> {
            self.calls.lock().unwrap().push(format!(
                "screencap {} {} {}",
                adb.display(),
                serial,
                path.display()
            ));
            std::fs::write(path, b"fake-png").map_err(|error| error.to_string())
        }

        fn start_recording(
            &self,
            _runner: Arc<dyn CommandRunner>,
            adb: &Path,
            serial: &str,
            path: &Path,
            _cancel: Arc<AtomicBool>,
        ) -> Result<Box<dyn RecordingProcess>, String> {
            self.calls.lock().unwrap().push(format!(
                "record {} {} {}",
                adb.display(),
                serial,
                path.display()
            ));
            std::fs::write(path, b"fake-mp4").map_err(|error| error.to_string())?;
            let process = FakeRecordingProcess::default();
            *self.recording_process.lock().unwrap() = Some(process.clone());
            Ok(Box::new(process))
        }
    }

    #[derive(Clone, Default)]
    struct FakeRecordingProcess {
        started: Arc<Mutex<usize>>,
        interrupted: Arc<Mutex<usize>>,
    }

    impl RecordingProcess for FakeRecordingProcess {
        fn wait_until_started(&mut self, _deadline: Instant) -> Result<(), String> {
            *self.started.lock().unwrap() += 1;
            Ok(())
        }

        fn interrupt_and_wait(&mut self, _deadline: Instant) -> Result<(), String> {
            *self.interrupted.lock().unwrap() += 1;
            Ok(())
        }
    }

    #[test]
    fn capture_screen_uses_adb_screencap_and_atomically_promotes_the_file() {
        let desktop = tempfile::tempdir().unwrap();
        let backend = FakeBackend::default();
        let runner: Arc<dyn CommandRunner> = Arc::new(RecordingCommandRunner::default());
        let cancel = AtomicBool::new(false);
        let file = capture_screen(
            &backend,
            runner.as_ref(),
            desktop.path(),
            Path::new("/sdk/platform-tools/adb"),
            "emulator-5554",
            "Pixel 8",
            &cancel,
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();

        assert!(file.path.ends_with(".png"));
        assert!(Path::new(&file.path).exists());
        assert!(!file.path.contains(".partial."));
        assert_eq!(desktop.path().read_dir().unwrap().count(), 1);
        assert!(backend.calls.lock().unwrap()[0].contains("emulator-5554"));
    }

    fn annotation_png(width: u32, height: u32) -> Vec<u8> {
        use image::{DynamicImage, ImageBuffer, ImageFormat, Rgba};
        use std::io::Cursor;
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(
            width,
            height,
            Rgba([90, 40, 180, 255]),
        ));
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .unwrap();
        bytes
    }

    struct PngBackend {
        png: Vec<u8>,
        paths: Mutex<Vec<PathBuf>>,
    }

    impl PngBackend {
        fn new(width: u32, height: u32) -> Self {
            Self {
                png: annotation_png(width, height),
                paths: Mutex::new(Vec::new()),
            }
        }
    }

    impl AndroidMediaBackend for PngBackend {
        fn screenshot(
            &self,
            _runner: &dyn CommandRunner,
            _adb: &Path,
            _serial: &str,
            path: &Path,
            _cancel: &AtomicBool,
            _deadline: Instant,
        ) -> Result<(), String> {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            std::fs::write(path, &self.png).map_err(|error| error.to_string())?;
            self.paths.lock().unwrap().push(path.to_path_buf());
            Ok(())
        }

        fn start_recording(
            &self,
            _runner: Arc<dyn CommandRunner>,
            _adb: &Path,
            _serial: &str,
            _path: &Path,
            _cancel: Arc<AtomicBool>,
        ) -> Result<Box<dyn RecordingProcess>, String> {
            Err("recording is not used by annotation captures".into())
        }
    }

    #[test]
    fn capture_annotation_writes_uuid_pngs_under_temp_and_never_the_desktop() {
        let root = tempfile::tempdir().unwrap();
        let desktop = root.path().join("Desktop");
        std::fs::create_dir_all(&desktop).unwrap();
        let mut service =
            super::super::AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
        let backend = Arc::new(PngBackend::new(400, 800));
        service.media_backend = backend.clone();
        service.state.lock().unwrap().session = Some(test_session());
        let store = AndroidEmulatorCaptureStore::for_test(
            root.path().join("temp"),
            root.path().join("android_captures"),
        );
        let rect = AndroidEmulatorRect {
            x: 0.25,
            y: 0.25,
            width: 0.5,
            height: 0.25,
        };

        let capture = service
            .capture_annotation_sync(&store, 1, rect, None)
            .unwrap();

        assert_eq!((capture.crop_width, capture.crop_height), (200, 200));
        assert_eq!(
            (capture.viewport_width, capture.viewport_height),
            (400, 800)
        );
        let crop = PathBuf::from(&capture.crop_path);
        let viewport = PathBuf::from(&capture.viewport_path);
        assert!(crop.starts_with(store.temp_root()));
        assert!(viewport.starts_with(store.temp_root()));
        assert!(!crop.starts_with(&desktop));
        assert!(!viewport.starts_with(&desktop));
        assert_eq!(desktop.read_dir().unwrap().count(), 0);
        assert_eq!(store.durable_root().read_dir().unwrap().count(), 0);
        for path in backend.paths.lock().unwrap().iter() {
            assert!(
                path.starts_with(store.temp_root()),
                "screencap staging leaked off temp: {}",
                path.display()
            );
            assert!(!path.starts_with(&desktop));
            assert!(
                !path.exists(),
                "staging screencap must be deleted after write_capture"
            );
        }
        assert_eq!(capture.orientation, AndroidEmulatorOrientation::Portrait);
        assert_eq!(capture.device_generation, 1);
        assert_eq!(capture.frame_generation, 1);
        assert_eq!(capture.rect, rect);
        assert_eq!(
            capture.device_rect,
            AndroidEmulatorRect {
                x: 100.0,
                y: 200.0,
                width: 200.0,
                height: 200.0,
            }
        );
        let json = serde_json::to_value(&capture).unwrap();
        assert!(json.get("cropPath").is_some());
        assert!(json.get("viewportPath").is_some());
        assert!(json.get("deviceGeneration").is_some());
    }

    #[test]
    fn capture_annotation_rejects_a_stale_generation_without_touching_desktop() {
        let root = tempfile::tempdir().unwrap();
        let desktop = root.path().join("Desktop");
        std::fs::create_dir_all(&desktop).unwrap();
        let mut service =
            super::super::AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
        service.media_backend = Arc::new(PngBackend::new(400, 800));
        service.state.lock().unwrap().session = Some(test_session());
        let store = AndroidEmulatorCaptureStore::for_test(
            root.path().join("temp"),
            root.path().join("android_captures"),
        );

        let error = service
            .capture_annotation_sync(
                &store,
                99,
                AndroidEmulatorRect {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
                None,
            )
            .unwrap_err();

        assert!(
            error.contains("outra sessão"),
            "stale generation must name the session mismatch, got {error}"
        );
        assert_eq!(desktop.read_dir().unwrap().count(), 0);
        assert_eq!(store.temp_root().read_dir().unwrap().count(), 0);
    }

    #[test]
    fn screenrecord_declares_the_android_three_minute_limit() {
        assert_eq!(
            build_screenrecord_args("emulator-5554", "/sdcard/verboo-recording.mp4"),
            vec![
                "-s",
                "emulator-5554",
                "shell",
                "screenrecord",
                "--time-limit",
                "180",
                "--bit-rate",
                "8000000",
                "/sdcard/verboo-recording.mp4"
            ]
        );
    }

    #[test]
    fn recording_copies_the_ios_recording_process_lifecycle_and_promotes_on_stop() {
        let desktop = tempfile::tempdir().unwrap();
        let backend = FakeBackend::default();
        let recording = start_recording(
            &backend,
            Arc::new(RecordingCommandRunner::default()),
            desktop.path(),
            Path::new("/sdk/platform-tools/adb"),
            "emulator-5554",
            "Pixel 8",
        )
        .unwrap();
        let process = backend.recording_process.lock().unwrap().clone().unwrap();
        assert_eq!(*process.started.lock().unwrap(), 1);

        let file = stop_recording(recording).unwrap();
        assert!(Path::new(&file.path).exists());
        assert!(!file.path.contains(".partial."));
        assert_eq!(*process.interrupted.lock().unwrap(), 1);
        assert_eq!(desktop.path().read_dir().unwrap().count(), 1);
    }

    #[test]
    fn service_rejects_a_second_recording_and_stops_the_active_session_recording() {
        let root = tempfile::tempdir().unwrap();
        let mut service =
            super::super::AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
        let backend = Arc::new(FakeBackend::default());
        service.media_backend = backend.clone();
        service.state.lock().unwrap().session = Some(test_session());

        service.start_recording_sync(root.path()).unwrap();
        assert_eq!(
            service.start_recording_sync(root.path()).unwrap_err(),
            "uma gravação já está em andamento"
        );
        let file = service.stop_recording_sync().unwrap();
        assert!(Path::new(&file.path).exists());
        assert!(service.stop_recording_sync().is_err());
        assert_eq!(
            root.path()
                .read_dir()
                .unwrap()
                .filter_map(Result::ok)
                .filter(
                    |entry| entry.path().extension().and_then(|value| value.to_str())
                        == Some("mp4")
                )
                .count(),
            1
        );
    }

    #[test]
    fn app_exit_finalizes_recording_then_shuts_the_owned_android_session() {
        let root = tempfile::tempdir().unwrap();
        let mut service =
            super::super::AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
        let backend = Arc::new(FakeBackend::default());
        let runner = Arc::new(RecordingCommandRunner::default());
        service.media_backend = backend.clone();
        service.runner = runner.clone();
        let session = test_session_with_ownership(AndroidEmulatorOwnership::Verboo);
        service.state.lock().unwrap().session = Some(session);

        service.start_recording_sync(root.path()).unwrap();
        let process = backend.recording_process.lock().unwrap().clone().unwrap();
        let report = service.stop_for_app_exit(Instant::now() + Duration::from_secs(1));

        assert!(
            report.errors.is_empty(),
            "app-exit cleanup failed: {report:?}"
        );
        assert_eq!(*process.interrupted.lock().unwrap(), 1);
        assert!(service.state.lock().unwrap().session.is_none());
        assert_eq!(media_files(root.path(), "mp4"), 1);
        assert_eq!(media_files(root.path(), "partial"), 0);
        assert!(runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(_, args)| args == &["-s", "emulator-5554", "emu", "kill"]));
    }

    #[test]
    fn screencap_uses_the_cancelable_runner_and_returns_after_detach_cancellation() {
        let backend = SystemAndroidMediaBackend;
        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let runner = Arc::new(BlockingCommandRunner {
            started: Arc::new(Mutex::new(Some(started_sender))),
        });
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let cancel_for_thread = cancel.clone();
        let runner_for_thread = runner.clone();
        let output = tempfile::tempdir()
            .unwrap()
            .path()
            .join("capture.partial.png");
        let worker = std::thread::spawn(move || {
            backend.screenshot(
                runner_for_thread.as_ref(),
                Path::new("adb"),
                "emulator-5554",
                &output,
                cancel_for_thread.as_ref(),
                Instant::now() + Duration::from_secs(5),
            )
        });
        started_receiver
            .recv_timeout(Duration::from_millis(250))
            .unwrap();

        let started_at = Instant::now();
        cancel.store(true, std::sync::atomic::Ordering::Release);
        let result = worker.join().unwrap();
        assert!(started_at.elapsed() < Duration::from_millis(500));
        assert!(result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn recording_pull_uses_its_cancelable_runner_deadline() {
        let runner = Arc::new(BlockingCleanupRunner::new(BlockingCleanupStep::Pull));
        let mut process = test_recording_process(runner.clone());

        let started = Instant::now();
        let result = process.interrupt_and_wait(Instant::now() + Duration::from_millis(100));

        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(result.is_err(), "pull should stop at its deadline");
        let calls = runner.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0][2], "pull");
    }

    #[cfg(unix)]
    #[test]
    fn recording_remove_uses_its_cancelable_runner_deadline() {
        let runner = Arc::new(BlockingCleanupRunner::new(BlockingCleanupStep::Remove));
        let mut process = test_recording_process(runner.clone());

        let started = Instant::now();
        process
            .interrupt_and_wait(Instant::now() + Duration::from_millis(100))
            .unwrap();

        assert!(started.elapsed() < Duration::from_millis(500));
        let calls = runner.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0][2], "pull");
        assert_eq!(calls[1][2..5], ["shell", "rm", "-f"]);
    }

    #[test]
    fn app_exit_bounds_a_blocking_media_cleanup_to_the_shared_deadline() {
        let root = tempfile::tempdir().unwrap();
        let mut service =
            super::super::AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
        service.media_backend = Arc::new(BlockingBackend);
        let session = test_session_with_ownership(AndroidEmulatorOwnership::External);
        service.state.lock().unwrap().session = Some(session);
        service.start_recording_sync(root.path()).unwrap();

        let started = Instant::now();
        let _report = service.stop_for_app_exit(started + Duration::from_millis(100));

        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(service.state.lock().unwrap().session.is_none());
    }

    #[test]
    fn detach_bounds_a_blocking_media_cleanup_to_its_deadline() {
        let root = tempfile::tempdir().unwrap();
        let mut service =
            super::super::AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
        service.media_backend = Arc::new(BlockingBackend);
        let session = test_session_with_ownership(AndroidEmulatorOwnership::External);
        service.state.lock().unwrap().session = Some(session);
        service.start_recording_sync(root.path()).unwrap();

        let started = Instant::now();
        let result = service.detach_sync_until(started + Duration::from_millis(100));

        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(result.is_ok());
        assert!(service.state.lock().unwrap().session.is_none());
    }

    #[test]
    fn detach_does_not_wait_past_the_deadline_for_the_operation_lock() {
        let root = tempfile::tempdir().unwrap();
        let service = super::super::AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
        let _operation = service.operation_lock.lock().unwrap();
        let started = Instant::now();

        let result = service.detach_sync_until(started + Duration::from_millis(100));

        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(result.is_err());
    }

    #[test]
    fn app_exit_does_not_wait_past_the_deadline_for_the_operation_lock() {
        let root = tempfile::tempdir().unwrap();
        let service = super::super::AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
        let _operation = service.operation_lock.lock().unwrap();
        let started = Instant::now();

        let report = service.stop_for_app_exit(started + Duration::from_millis(100));

        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(!report.errors.is_empty());
    }

    #[test]
    fn collision_safe_paths_never_reuse_a_final_or_partial_name() {
        let desktop = tempfile::tempdir().unwrap();
        let first = desktop.path().join("Verboo Android - Pixel 8 - stamp.png");
        let partial = desktop
            .path()
            .join("Verboo Android - Pixel 8 - stamp (1).partial.png");
        std::fs::write(&first, b"existing").unwrap();
        std::fs::write(&partial, b"in-flight").unwrap();

        let path = collision_safe_path(desktop.path(), "Verboo Android - Pixel 8 - stamp", "png");
        assert_eq!(
            path.file_name().unwrap().to_string_lossy(),
            "Verboo Android - Pixel 8 - stamp (2).png"
        );
    }

    fn test_session() -> Arc<AndroidSession> {
        test_session_with_ownership(AndroidEmulatorOwnership::External)
    }

    fn test_session_with_ownership(ownership: AndroidEmulatorOwnership) -> Arc<AndroidSession> {
        Arc::new(AndroidSession {
            avd_name: "Pixel_8_API_35".to_string(),
            device: AndroidDevice {
                avd_name: "Pixel_8_API_35".to_string(),
                display_name: "Pixel 8".to_string(),
                api_level: 35,
                family: AndroidDeviceFamily::Phone,
                running: true,
            },
            serial: "emulator-5554".to_string(),
            adb_path: PathBuf::from("adb"),
            ownership,
            generation: 1,
            stream_fps: Arc::new(Mutex::new(30)),
            fallback_fps: Arc::new(Mutex::new(2.0)),
            gate: Arc::new(PreviewGate::new(true)),
            stop: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            input_lock: Arc::new(Mutex::new(())),
            dimensions: Arc::new(Mutex::new(Some((1080, 1920)))),
            device_display_size: (1080, 1920),
            emulator_process: Arc::new(Mutex::new(None)),
            recording: Arc::new(Mutex::new(None)),
            workers: Mutex::new(Vec::new()),
            emulator_pid: None,
            gpu_software: false,
            preview: Arc::new(PreviewRuntime::new(PreviewMode::LegacyPrimary, 1)),
            first_preview: Arc::new(FirstPreviewGate::new()),
        })
    }

    fn media_files(root: &Path, extension: &str) -> usize {
        root.read_dir()
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str()) == Some(extension)
            })
            .count()
    }

    #[derive(Default)]
    struct RecordingCommandRunner {
        calls: Mutex<Vec<(String, Vec<String>)>>,
    }

    impl crate::services::android_emulator::CommandRunner for RecordingCommandRunner {
        fn run(
            &self,
            program: &str,
            args: &[String],
        ) -> Result<crate::services::android_emulator::CommandOutput, String> {
            self.calls
                .lock()
                .unwrap()
                .push((program.to_string(), args.to_vec()));
            Ok(crate::services::android_emulator::CommandOutput {
                success: true,
                stdout: Vec::new(),
                stderr: Vec::new(),
            })
        }
    }

    #[derive(Default)]
    struct BlockingCommandRunner {
        started: Arc<Mutex<Option<std::sync::mpsc::Sender<()>>>>,
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum BlockingCleanupStep {
        Pull,
        Remove,
    }

    struct BlockingCleanupRunner {
        calls: Mutex<Vec<Vec<String>>>,
        blocked_step: BlockingCleanupStep,
    }

    impl BlockingCleanupRunner {
        fn new(blocked_step: BlockingCleanupStep) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                blocked_step,
            }
        }
    }

    impl crate::services::android_emulator::CommandRunner for BlockingCleanupRunner {
        fn run(
            &self,
            _program: &str,
            _args: &[String],
        ) -> Result<crate::services::android_emulator::CommandOutput, String> {
            Ok(crate::services::android_emulator::CommandOutput {
                success: true,
                stdout: Vec::new(),
                stderr: Vec::new(),
            })
        }

        fn run_interruptible(
            &self,
            _program: &str,
            args: &[String],
            _cancel: &std::sync::atomic::AtomicBool,
            deadline: Instant,
        ) -> Result<crate::services::android_emulator::CommandOutput, String> {
            self.calls.lock().unwrap().push(args.to_vec());
            let step = match args.get(2).map(String::as_str) {
                Some("pull") => Some(BlockingCleanupStep::Pull),
                Some("shell") => Some(BlockingCleanupStep::Remove),
                _ => None,
            };
            if step == Some(self.blocked_step) {
                while Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(2));
                }
                return Err("fake adb cleanup blocked until deadline".to_string());
            }
            Ok(crate::services::android_emulator::CommandOutput {
                success: true,
                stdout: Vec::new(),
                stderr: Vec::new(),
            })
        }
    }

    #[cfg(unix)]
    fn test_recording_process(runner: Arc<BlockingCleanupRunner>) -> SystemRecordingProcess {
        let mut child = Command::new("perl")
            .arg("-e")
            .arg("sleep 30")
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stderr = child.stderr.take().unwrap();
        SystemRecordingProcess::new(
            child,
            stderr,
            runner,
            Arc::new(AtomicBool::new(false)),
            PathBuf::from("adb"),
            "emulator-5554".to_string(),
            "/sdcard/verboo-recording.mp4".to_string(),
            PathBuf::from("recording.partial.mp4"),
        )
    }

    impl crate::services::android_emulator::CommandRunner for BlockingCommandRunner {
        fn run(
            &self,
            _program: &str,
            _args: &[String],
        ) -> Result<crate::services::android_emulator::CommandOutput, String> {
            Ok(crate::services::android_emulator::CommandOutput {
                success: true,
                stdout: Vec::new(),
                stderr: Vec::new(),
            })
        }

        fn run_interruptible(
            &self,
            _program: &str,
            _args: &[String],
            cancel: &std::sync::atomic::AtomicBool,
            deadline: Instant,
        ) -> Result<crate::services::android_emulator::CommandOutput, String> {
            if let Some(sender) = self.started.lock().unwrap().take() {
                let _ = sender.send(());
            }
            while !cancel.load(std::sync::atomic::Ordering::Acquire) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(2));
            }
            Err("fake adb cancelled".to_string())
        }
    }

    struct BlockingBackend;

    impl AndroidMediaBackend for BlockingBackend {
        fn screenshot(
            &self,
            _runner: &dyn crate::services::android_emulator::CommandRunner,
            _adb: &Path,
            _serial: &str,
            _path: &Path,
            _cancel: &std::sync::atomic::AtomicBool,
            _deadline: Instant,
        ) -> Result<(), String> {
            unreachable!("the blocking cleanup test does not capture a screenshot")
        }

        fn start_recording(
            &self,
            _runner: Arc<dyn crate::services::android_emulator::CommandRunner>,
            _adb: &Path,
            _serial: &str,
            path: &Path,
            _cancel: Arc<std::sync::atomic::AtomicBool>,
        ) -> Result<Box<dyn RecordingProcess>, String> {
            std::fs::write(path, b"fake-mp4").map_err(|error| error.to_string())?;
            Ok(Box::new(DeadlineBoundRecordingProcess))
        }
    }

    struct DeadlineBoundRecordingProcess;

    impl RecordingProcess for DeadlineBoundRecordingProcess {
        fn wait_until_started(&mut self, _deadline: Instant) -> Result<(), String> {
            Ok(())
        }

        fn interrupt_and_wait(&mut self, deadline: Instant) -> Result<(), String> {
            while Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(2));
            }
            Err("fake adb pull blocked until deadline".to_string())
        }
    }
}
