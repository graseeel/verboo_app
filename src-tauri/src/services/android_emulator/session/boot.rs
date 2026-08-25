//! Android emulator boot, launcher, ownership, and ADB backend.

use super::*;

pub(super) fn emulator_path(sdk_path: &Path) -> PathBuf {
    sdk_path.join("emulator").join(if cfg!(windows) {
        "emulator.exe"
    } else {
        "emulator"
    })
}

pub(super) fn is_boot_completed(output: &str) -> bool {
    output.trim() == "1"
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum GpuMode {
    Host,
    SwiftshaderIndirect,
}

impl GpuMode {
    fn emulator_value(self) -> &'static str {
        match self {
            Self::Host => "host",
            Self::SwiftshaderIndirect => "swiftshader_indirect",
        }
    }
}

pub(super) struct OwnedBootResult {
    pub(super) serial: String,
    pub(super) process: Arc<Mutex<Option<Child>>>,
    pub(super) pid: u32,
    pub(super) gpu: GpuMode,
    pub(super) gpu_software: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum OwnedBootAttemptError {
    Cancelled,
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum OwnedBootError {
    Cancelled,
    Failed(String),
}

pub(super) fn emulator_launch_args(avd_name: &str, gpu: GpuMode) -> Vec<String> {
    vec![
        "-avd".to_string(),
        avd_name.to_string(),
        "-no-window".to_string(),
        "-no-boot-anim".to_string(),
        "-no-audio".to_string(),
        "-no-snapshot-save".to_string(),
        "-gpu".to_string(),
        gpu.emulator_value().to_string(),
        "-grpc-use-token".to_string(),
    ]
}

pub(super) fn parse_png_dimensions(png: &[u8]) -> Result<(u32, u32), String> {
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

pub(super) fn should_shutdown(ownership: AndroidEmulatorOwnership) -> bool {
    matches!(ownership, AndroidEmulatorOwnership::Verboo)
}

pub(super) fn validate_stream_fps(fps: u16) -> Result<u16, String> {
    if (MIN_STREAM_FPS..=MAX_STREAM_FPS).contains(&fps) {
        Ok(fps)
    } else {
        Err(format!(
            "Android stream rate must be between {MIN_STREAM_FPS} and {MAX_STREAM_FPS} fps"
        ))
    }
}

pub(super) fn validate_fallback_fps(fps: f64) -> Result<f64, String> {
    if fps.is_finite() && (MIN_FALLBACK_FPS..=MAX_FALLBACK_FPS).contains(&fps) {
        Ok(fps)
    } else {
        Err(format!(
            "Android fallback rate must be between {MIN_FALLBACK_FPS} and {MAX_FALLBACK_FPS} fps"
        ))
    }
}

pub(super) fn ownership_for_running_avd(
    ledger: &OwnershipLedger,
    avd_name: &str,
) -> AndroidEmulatorOwnership {
    if ledger.phase(avd_name).is_some() {
        AndroidEmulatorOwnership::Verboo
    } else {
        AndroidEmulatorOwnership::External
    }
}

pub(super) fn attach_ownership(
    ledger: &OwnershipLedger,
    avd_name: &str,
    existing_serial: Option<&str>,
) -> (AndroidEmulatorOwnership, bool) {
    match existing_serial {
        Some(_) => (ownership_for_running_avd(ledger, avd_name), false),
        None => (AndroidEmulatorOwnership::Verboo, true),
    }
}

pub(super) fn emit_lifecycle(app: &AppHandle, stage: AndroidEmulatorStartupStage) {
    let _ = app.emit(LIFECYCLE_EVENT, AndroidEmulatorLifecycleEvent { stage });
}

pub(crate) fn emit_error(app: &AppHandle, error: AndroidEmulatorError) {
    let _ = app.emit(ERROR_EVENT, error);
}

pub(crate) fn emit_session_ended(app: &AppHandle, event: AndroidEmulatorSessionEnded) {
    let _ = app.emit(SESSION_ENDED_EVENT, event);
}

pub(super) trait EmulatorLauncher: Send + Sync {
    fn spawn(&self, path: &Path, args: &[String]) -> Result<Child, String>;
}

pub(super) struct SystemEmulatorLauncher;

impl EmulatorLauncher for SystemEmulatorLauncher {
    fn spawn(&self, path: &Path, args: &[String]) -> Result<Child, String> {
        let mut command = Command::new(path);
        command.args(args);
        command.stdin(Stdio::null());
        command.stdout(Stdio::null());
        command.stderr(Stdio::null());
        crate::services::cli_spawn::apply_creation_flags(&mut command);
        crate::services::child_signal::configure_process_group(&mut command);
        command
            .spawn()
            .map_err(|error| format!("failed to start Android emulator: {error}"))
    }
}

pub(super) trait OwnedBootAttempts: Send + Sync {
    fn attempt(
        &self,
        avd_name: &str,
        gpu: GpuMode,
        cancel: &SessionCancellation,
    ) -> Result<OwnedBootResult, OwnedBootAttemptError>;

    fn terminate(&self, result: &OwnedBootResult) -> Result<(), String>;
}

pub(super) struct SystemOwnedBootAttempts<'a> {
    runner: Arc<dyn CommandRunner>,
    launcher: &'a dyn EmulatorLauncher,
    emulator_path: PathBuf,
    adb: String,
}

impl<'a> SystemOwnedBootAttempts<'a> {
    pub(super) fn new(
        runner: Arc<dyn CommandRunner>,
        launcher: &'a dyn EmulatorLauncher,
        emulator_path: PathBuf,
        adb: String,
    ) -> Self {
        Self {
            runner,
            launcher,
            emulator_path,
            adb,
        }
    }
}

impl OwnedBootAttempts for SystemOwnedBootAttempts<'_> {
    fn attempt(
        &self,
        avd_name: &str,
        gpu: GpuMode,
        cancel: &SessionCancellation,
    ) -> Result<OwnedBootResult, OwnedBootAttemptError> {
        if cancel.is_cancelled() {
            return Err(OwnedBootAttemptError::Cancelled);
        }
        let args = emulator_launch_args(avd_name, gpu);
        let child = match cancel.run_if_active(|| self.launcher.spawn(&self.emulator_path, &args)) {
            Some(Ok(child)) => child,
            Some(Err(error)) => return Err(OwnedBootAttemptError::Failed(error)),
            None => return Err(OwnedBootAttemptError::Cancelled),
        };
        let pid = child.id();
        let process = Arc::new(Mutex::new(Some(child)));
        let serial = match wait_for_boot(
            self.runner.as_ref(),
            &self.adb,
            avd_name,
            &process,
            cancel.flag(),
            Instant::now() + BOOT_TIMEOUT,
        ) {
            Ok(serial) => serial,
            Err(error) => {
                let _ = terminate_process(&process);
                if cancel.is_cancelled() {
                    return Err(OwnedBootAttemptError::Cancelled);
                }
                return Err(OwnedBootAttemptError::Failed(error));
            }
        };
        if cancel.is_cancelled() {
            let _ = terminate_process(&process);
            return Err(OwnedBootAttemptError::Cancelled);
        }
        Ok(OwnedBootResult {
            serial,
            process,
            pid,
            gpu,
            gpu_software: gpu == GpuMode::SwiftshaderIndirect,
        })
    }

    fn terminate(&self, result: &OwnedBootResult) -> Result<(), String> {
        terminate_process(&result.process)
    }
}

pub(super) fn boot_owned_with_attempts(
    ledger: &dyn BootLedger,
    attempts: &dyn OwnedBootAttempts,
    avd_name: &str,
    cancel: &SessionCancellation,
) -> Result<OwnedBootResult, OwnedBootError> {
    let modes = [GpuMode::Host, GpuMode::SwiftshaderIndirect];
    let mut last_error = None;
    for gpu in modes {
        if cancel.is_cancelled() {
            let _ = ledger.remove(avd_name);
            return Err(OwnedBootError::Cancelled);
        }
        ledger
            .mark_boot_requested(avd_name)
            .map_err(OwnedBootError::Failed)?;
        if cancel.is_cancelled() {
            let _ = ledger.remove(avd_name);
            return Err(OwnedBootError::Cancelled);
        }
        match attempts.attempt(avd_name, gpu, cancel) {
            Ok(mut result) => {
                if cancel.is_cancelled() {
                    let _ = attempts.terminate(&result);
                    let _ = ledger.remove(avd_name);
                    return Err(OwnedBootError::Cancelled);
                }
                match cancel.run_if_active(|| ledger.mark_booted(avd_name)) {
                    None => {
                        let _ = attempts.terminate(&result);
                        let _ = ledger.remove(avd_name);
                        return Err(OwnedBootError::Cancelled);
                    }
                    Some(Ok(())) => {}
                    Some(Err(error)) => {
                        let terminate_error = attempts.terminate(&result).err();
                        let remove_error = ledger.remove(avd_name).err();
                        let rollback = [terminate_error, remove_error]
                            .into_iter()
                            .flatten()
                            .collect::<Vec<_>>()
                            .join("; ");
                        return Err(OwnedBootError::Failed(if rollback.is_empty() {
                            error
                        } else {
                            format!("{error}; rollback failed: {rollback}")
                        }));
                    }
                }
                if cancel.is_cancelled() {
                    let _ = attempts.terminate(&result);
                    let _ = ledger.remove(avd_name);
                    return Err(OwnedBootError::Cancelled);
                }
                result.gpu_software = gpu == GpuMode::SwiftshaderIndirect;
                return Ok(result);
            }
            Err(OwnedBootAttemptError::Cancelled) => {
                let _ = ledger.remove(avd_name);
                return Err(OwnedBootError::Cancelled);
            }
            Err(OwnedBootAttemptError::Failed(error)) => {
                let _ = ledger.remove(avd_name);
                if cancel.is_cancelled() {
                    return Err(OwnedBootError::Cancelled);
                }
                last_error = Some(error);
            }
        }
    }
    Err(OwnedBootError::Failed(last_error.unwrap_or_else(|| {
        "Android emulator boot failed".to_string()
    })))
}

pub(super) fn surface_flinger_uses_software_gpu(output: &str) -> bool {
    output.to_ascii_lowercase().contains("swiftshader")
}

pub(super) fn apply_postboot_gpu_probe(
    mut result: OwnedBootResult,
    surface_flinger: &str,
) -> OwnedBootResult {
    result.gpu_software = result.gpu_software || surface_flinger_uses_software_gpu(surface_flinger);
    result
}

pub(super) fn probe_owned_surface_flinger(
    runner: &dyn CommandRunner,
    attempts: &dyn OwnedBootAttempts,
    ledger: &dyn BootLedger,
    avd_name: &str,
    adb: &str,
    mut result: OwnedBootResult,
    cancel: &AtomicBool,
) -> Result<OwnedBootResult, OwnedBootError> {
    if cancel.load(Ordering::Acquire) {
        let _ = attempts.terminate(&result);
        let _ = ledger.remove(avd_name);
        return Err(OwnedBootError::Cancelled);
    }
    let surface_flinger = runner
        .run_interruptible(
            adb,
            &[
                "-s".to_string(),
                result.serial.clone(),
                "shell".to_string(),
                "dumpsys".to_string(),
                "SurfaceFlinger".to_string(),
            ],
            cancel,
            Instant::now() + ADB_COMMAND_TIMEOUT,
        )
        .ok()
        .filter(|output| output.success)
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default();
    if cancel.load(Ordering::Acquire) {
        let _ = attempts.terminate(&result);
        let _ = ledger.remove(avd_name);
        return Err(OwnedBootError::Cancelled);
    }
    result = apply_postboot_gpu_probe(result, &surface_flinger);
    Ok(result)
}

pub(super) fn find_running_serial(
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

pub(super) fn wait_for_boot(
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

pub(super) fn process_exited(process: &Arc<Mutex<Option<Child>>>) -> Result<bool, String> {
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

pub(super) fn terminate_process(process: &Arc<Mutex<Option<Child>>>) -> Result<(), String> {
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

pub(super) fn shutdown_owned_emulator(
    runner: &dyn CommandRunner,
    session: &AndroidSession,
    deadline: Option<Instant>,
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
    let args = vec![
        "-s".to_string(),
        session.serial.clone(),
        "emu".to_string(),
        "kill".to_string(),
    ];
    let adb = session.adb_path.to_string_lossy().into_owned();
    let output = if let Some(deadline) = deadline {
        let cancel = AtomicBool::new(false);
        runner.run_interruptible(&adb, &args, &cancel, deadline)?
    } else {
        runner.run(&adb, &args)?
    };
    if output.success {
        Ok(())
    } else {
        Err(command_error("adb emu kill", &output))
    }
}

pub(super) fn command_error(command: &str, output: &CommandOutput) -> String {
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if detail.is_empty() {
        format!("{command} failed")
    } else {
        format!("{command} failed: {detail}")
    }
}
