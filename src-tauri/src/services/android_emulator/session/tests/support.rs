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

#[derive(Default)]
struct ExternalAttachRunner {
    commands: std::sync::Mutex<Vec<(String, Vec<String>)>>,
}

impl ExternalAttachRunner {
    fn run_recorded(&self, program: &str, args: &[String]) -> Result<CommandOutput, String> {
        self.commands
            .lock()
            .unwrap()
            .push((program.to_string(), args.to_vec()));

        if args_match(args, &["-list-avds"]) {
            return Ok(CommandOutput {
                success: true,
                stdout: b"Pixel_8_API_35\n".to_vec(),
                stderr: Vec::new(),
            });
        }
        if args_match(args, &["devices"]) {
            return Ok(CommandOutput {
                success: true,
                stdout: b"List of devices attached\nemulator-5554\tdevice\n".to_vec(),
                stderr: Vec::new(),
            });
        }
        if args_match(args, &["-s", "emulator-5554", "emu", "avd", "name"]) {
            return Ok(CommandOutput {
                success: true,
                stdout: b"Pixel_8_API_35\n".to_vec(),
                stderr: Vec::new(),
            });
        }
        if args_match(
            args,
            &[
                "-s",
                "emulator-5554",
                "shell",
                "getprop",
                "sys.boot_completed",
            ],
        ) {
            return Ok(CommandOutput {
                success: true,
                stdout: b"1\n".to_vec(),
                stderr: Vec::new(),
            });
        }
        if args_match(
            args,
            &["-s", "emulator-5554", "exec-out", "screencap", "-p"],
        ) {
            return Ok(png_output());
        }

        Err(format!(
            "unexpected Android attach command: {program} {args:?}"
        ))
    }
}

impl CommandRunner for ExternalAttachRunner {
    fn run(&self, program: &str, args: &[String]) -> Result<CommandOutput, String> {
        self.run_recorded(program, args)
    }

    fn run_interruptible(
        &self,
        program: &str,
        args: &[String],
        _cancel: &AtomicBool,
        _deadline: Instant,
    ) -> Result<CommandOutput, String> {
        self.run_recorded(program, args)
    }
}

fn args_match(args: &[String], expected: &[&str]) -> bool {
    args.len() == expected.len()
        && args
            .iter()
            .zip(expected.iter())
            .all(|(actual, expected)| actual == expected)
}

struct RecordingAttachSink;

impl PreviewEventSink for RecordingAttachSink {
    fn frame_ready(&self, _event: FrameReady) -> Result<(), String> {
        Ok(())
    }

    fn preview_state(&self, _state: PreviewState) -> Result<(), String> {
        Ok(())
    }
}

impl AndroidFrameSink for RecordingAttachSink {
    fn frame(&self, _frame: AndroidEmulatorFrame) -> Result<(), String> {
        Ok(())
    }

    fn error(&self, _message: String) {}

    fn lifecycle(&self, _stage: AndroidEmulatorStartupStage) {}
}

#[derive(Default)]
struct RecordingEmulatorLauncher {
    calls: std::sync::Mutex<Vec<(PathBuf, Vec<String>)>>,
}

impl EmulatorLauncher for RecordingEmulatorLauncher {
    fn spawn(&self, path: &Path, args: &[String]) -> Result<Child, String> {
        self.calls
            .lock()
            .unwrap()
            .push((path.to_path_buf(), args.to_vec()));
        Err("test emulator launcher must not be called for an external AVD".to_string())
    }
}

#[derive(Default)]
struct NoSpawnLauncher {
    calls: AtomicUsize,
}

impl NoSpawnLauncher {
    fn spawn_calls(&self) -> usize {
        self.calls.load(Ordering::Acquire)
    }
}

impl EmulatorLauncher for NoSpawnLauncher {
    fn spawn(&self, _path: &Path, _args: &[String]) -> Result<Child, String> {
        self.calls.fetch_add(1, Ordering::AcqRel);
        panic!("cancelled owned attempt must not spawn");
    }
}

struct GateCheckingLauncher {
    owner: Arc<SessionCancellation>,
    calls: AtomicUsize,
    gate_held: AtomicBool,
}

impl GateCheckingLauncher {
    fn new(owner: Arc<SessionCancellation>) -> Self {
        Self {
            owner,
            calls: AtomicUsize::new(0),
            gate_held: AtomicBool::new(false),
        }
    }

    fn spawn_calls(&self) -> usize {
        self.calls.load(Ordering::Acquire)
    }

    fn spawn_gate_was_held(&self) -> bool {
        self.gate_held.load(Ordering::Acquire)
    }
}

impl EmulatorLauncher for GateCheckingLauncher {
    fn spawn(&self, _path: &Path, _args: &[String]) -> Result<Child, String> {
        self.calls.fetch_add(1, Ordering::AcqRel);
        self.gate_held
            .store(self.owner.transition_is_held(), Ordering::Release);
        Command::new("true")
            .spawn()
            .map_err(|error| format!("gate test launcher failed: {error}"))
    }
}

#[derive(Default)]
struct RecordingBootLedger {
    calls: Mutex<Vec<&'static str>>,
    fail_mark_booted: AtomicBool,
    cancel_on_second_mark_boot_requested: Mutex<Option<Arc<SessionCancellation>>>,
}

impl RecordingBootLedger {
    fn calls(&self) -> Vec<&'static str> {
        self.calls.lock().unwrap().clone()
    }

    fn fail_next_mark_booted(&self) {
        self.fail_mark_booted.store(true, Ordering::Release);
    }

    fn cancel_on_second_mark_boot_requested(&self, cancel: Arc<SessionCancellation>) {
        *self.cancel_on_second_mark_boot_requested.lock().unwrap() = Some(cancel);
    }
}

impl BootLedger for RecordingBootLedger {
    fn mark_boot_requested(&self, _avd_name: &str) -> Result<(), String> {
        self.calls.lock().unwrap().push("mark_boot_requested");
        let second_request = self
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| **call == "mark_boot_requested")
            .count()
            == 2;
        if second_request {
            if let Some(cancel) = self
                .cancel_on_second_mark_boot_requested
                .lock()
                .unwrap()
                .take()
            {
                cancel.cancel();
            }
        }
        Ok(())
    }

    fn mark_booted(&self, _avd_name: &str) -> Result<(), String> {
        self.calls.lock().unwrap().push("mark_booted");
        if self.fail_mark_booted.swap(false, Ordering::AcqRel) {
            Err("ledger mark_booted failed".to_string())
        } else {
            Ok(())
        }
    }

    fn remove(&self, _avd_name: &str) -> Result<(), String> {
        self.calls.lock().unwrap().push("remove");
        Ok(())
    }
}

struct GateCheckingBootLedger {
    owner: Arc<SessionCancellation>,
    mark_booted_gate_held: AtomicBool,
}

impl GateCheckingBootLedger {
    fn new(owner: Arc<SessionCancellation>) -> Self {
        Self {
            owner,
            mark_booted_gate_held: AtomicBool::new(false),
        }
    }

    fn mark_booted_gate_was_held(&self) -> bool {
        self.mark_booted_gate_held.load(Ordering::Acquire)
    }
}

impl BootLedger for GateCheckingBootLedger {
    fn mark_boot_requested(&self, _avd_name: &str) -> Result<(), String> {
        Ok(())
    }

    fn mark_booted(&self, _avd_name: &str) -> Result<(), String> {
        self.mark_booted_gate_held
            .store(self.owner.transition_is_held(), Ordering::Release);
        Ok(())
    }

    fn remove(&self, _avd_name: &str) -> Result<(), String> {
        Ok(())
    }
}

struct ScriptedOwnedBootAttempts {
    script: Mutex<VecDeque<Result<OwnedBootResult, OwnedBootAttemptError>>>,
    gpus: Mutex<Vec<GpuMode>>,
    terminates: AtomicUsize,
    cancel_before_success: AtomicBool,
}

impl ScriptedOwnedBootAttempts {
    fn new(script: Vec<Result<OwnedBootResult, OwnedBootAttemptError>>) -> Self {
        Self {
            script: Mutex::new(script.into()),
            gpus: Mutex::new(Vec::new()),
            terminates: AtomicUsize::new(0),
            cancel_before_success: AtomicBool::new(false),
        }
    }

    fn cancel_before_success(&self) {
        self.cancel_before_success.store(true, Ordering::Release);
    }

    fn gpus(&self) -> Vec<GpuMode> {
        self.gpus.lock().unwrap().clone()
    }

    fn take_success(&self) -> OwnedBootResult {
        match self.script.lock().unwrap().pop_front() {
            Some(Ok(result)) => result,
            Some(Err(error)) => panic!("expected boot success, got {error:?}"),
            None => panic!("expected scripted boot success"),
        }
    }

    fn terminates(&self) -> usize {
        self.terminates.load(Ordering::Acquire)
    }
}

impl OwnedBootAttempts for ScriptedOwnedBootAttempts {
    fn attempt(
        &self,
        _avd_name: &str,
        gpu: GpuMode,
        cancel: &SessionCancellation,
    ) -> Result<OwnedBootResult, OwnedBootAttemptError> {
        self.gpus.lock().unwrap().push(gpu);
        let result = self.script.lock().unwrap().pop_front().unwrap_or_else(|| {
            Err(OwnedBootAttemptError::Failed(
                "unexpected third boot attempt".to_string(),
            ))
        });
        if result.is_ok() && self.cancel_before_success.swap(false, Ordering::AcqRel) {
            cancel.cancel();
        }
        result
    }

    fn terminate(&self, _result: &OwnedBootResult) -> Result<(), String> {
        self.terminates.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }
}

fn fake_owned_boot(pid: u32, gpu: GpuMode) -> OwnedBootResult {
    OwnedBootResult {
        serial: "emulator-5554".to_string(),
        process: Arc::new(Mutex::new(None)),
        pid,
        gpu,
        gpu_software: gpu == GpuMode::SwiftshaderIndirect,
    }
}

#[derive(Default)]
struct InterruptibleProbeRunner {
    run_calls: AtomicUsize,
    interruptible_calls: AtomicUsize,
    args: Mutex<Vec<Vec<String>>>,
    cancels: Mutex<Vec<bool>>,
    deadlines: Mutex<Vec<Instant>>,
    cancel_after_probe: AtomicBool,
    cancel_owner: Mutex<Option<Arc<SessionCancellation>>>,
    fail_probe: AtomicBool,
}

impl InterruptibleProbeRunner {
    fn run_calls(&self) -> usize {
        self.run_calls.load(Ordering::Acquire)
    }

    fn interruptible_calls(&self) -> usize {
        self.interruptible_calls.load(Ordering::Acquire)
    }

    fn args(&self) -> Vec<Vec<String>> {
        self.args.lock().unwrap().clone()
    }

    fn cancels(&self) -> Vec<bool> {
        self.cancels.lock().unwrap().clone()
    }

    fn deadlines(&self) -> Vec<Instant> {
        self.deadlines.lock().unwrap().clone()
    }

    fn cancel_after_probe(&self, owner: Arc<SessionCancellation>) {
        *self.cancel_owner.lock().unwrap() = Some(owner);
        self.cancel_after_probe.store(true, Ordering::Release);
    }

    fn fail_probe(&self) {
        self.fail_probe.store(true, Ordering::Release);
    }
}

impl CommandRunner for InterruptibleProbeRunner {
    fn run(&self, _program: &str, _args: &[String]) -> Result<CommandOutput, String> {
        self.run_calls.fetch_add(1, Ordering::AcqRel);
        panic!("owned SurfaceFlinger probe must use run_interruptible");
    }

    fn run_interruptible(
        &self,
        _program: &str,
        args: &[String],
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> Result<CommandOutput, String> {
        self.interruptible_calls.fetch_add(1, Ordering::AcqRel);
        self.args.lock().unwrap().push(args.to_vec());
        self.cancels
            .lock()
            .unwrap()
            .push(cancel.load(Ordering::Acquire));
        self.deadlines.lock().unwrap().push(deadline);
        if self.cancel_after_probe.swap(false, Ordering::AcqRel) {
            if let Some(owner) = self.cancel_owner.lock().unwrap().take() {
                owner.cancel();
            }
        }
        if self.fail_probe.swap(false, Ordering::AcqRel) {
            return Err("SurfaceFlinger probe timed out".to_string());
        }
        Ok(CommandOutput {
            success: true,
            stdout: b"GLES: Apple, ANGLE Metal Renderer".to_vec(),
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
    fn frame(&self, _frame: AndroidEmulatorFrame) -> Result<(), String> {
        self.frames.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }

    fn error(&self, _message: String) {
        self.errors.fetch_add(1, Ordering::AcqRel);
    }

    fn lifecycle(&self, _stage: AndroidEmulatorStartupStage) {}
}

impl PreviewEventSink for CountingFrameSink {
    fn frame_ready(&self, _event: FrameReady) -> Result<(), String> {
        Ok(())
    }

    fn preview_state(&self, _state: PreviewState) -> Result<(), String> {
        Ok(())
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

#[derive(Default)]
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

fn test_android_session_for_mode(
    ownership: AndroidEmulatorOwnership,
    mode: PreviewMode,
    generation: u64,
    emulator_pid: Option<u32>,
) -> Arc<AndroidSession> {
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
        generation,
        stream_fps: Arc::new(Mutex::new(30)),
        fallback_fps: Arc::new(Mutex::new(2.0)),
        gate: Arc::new(PreviewGate::new(true)),
        stop: Arc::new(AtomicBool::new(false)),
        input_lock: Arc::new(Mutex::new(())),
        dimensions: Arc::new(Mutex::new(Some((1080, 1920)))),
        emulator_process: Arc::new(Mutex::new(None)),
        recording: Arc::new(Mutex::new(None)),
        workers: Mutex::new(Vec::new()),
        emulator_pid,
        gpu_software: false,
        preview: Arc::new(PreviewRuntime::new(mode, generation)),
        first_preview: Arc::new(FirstPreviewGate::new()),
    })
}

fn test_android_session_for_avd(
    avd_name: &str,
    ownership: AndroidEmulatorOwnership,
    mode: PreviewMode,
    generation: u64,
    emulator_pid: Option<u32>,
) -> Arc<AndroidSession> {
    let session = test_android_session_for_mode(ownership, mode, generation, emulator_pid);
    Arc::new(AndroidSession {
        avd_name: avd_name.to_string(),
        device: session.device.clone(),
        serial: session.serial.clone(),
        adb_path: session.adb_path.clone(),
        ownership: session.ownership,
        generation: session.generation,
        stream_fps: session.stream_fps.clone(),
        fallback_fps: session.fallback_fps.clone(),
        gate: session.gate.clone(),
        stop: session.stop.clone(),
        input_lock: session.input_lock.clone(),
        dimensions: session.dimensions.clone(),
        emulator_process: session.emulator_process.clone(),
        recording: session.recording.clone(),
        workers: Mutex::new(Vec::new()),
        emulator_pid: session.emulator_pid,
        gpu_software: session.gpu_software,
        preview: session.preview.clone(),
        first_preview: session.first_preview.clone(),
    })
}

fn test_android_session(ownership: AndroidEmulatorOwnership) -> Arc<AndroidSession> {
    test_android_session_for_mode(ownership, PreviewMode::LegacyPrimary, 1, None)
}

#[derive(Default)]
struct OrderedAttachSink {
    order: Arc<Mutex<Vec<String>>>,
    errors: Mutex<Vec<String>>,
    frames: Mutex<Vec<AndroidEmulatorFrame>>,
}

impl OrderedAttachSink {
    fn order_arc(&self) -> Arc<Mutex<Vec<String>>> {
        self.order.clone()
    }

    fn order(&self) -> Vec<String> {
        self.order.lock().unwrap().clone()
    }

    fn errors(&self) -> Vec<String> {
        self.errors.lock().unwrap().clone()
    }

    fn frames(&self) -> Vec<AndroidEmulatorFrame> {
        self.frames.lock().unwrap().clone()
    }

    fn attach_response(&self, generation: u64) {
        self.order
            .lock()
            .unwrap()
            .push(format!("attach-response:{generation}"));
    }
}

fn lifecycle_name(stage: AndroidEmulatorStartupStage) -> &'static str {
    match stage {
        AndroidEmulatorStartupStage::Booting => "booting",
        AndroidEmulatorStartupStage::WaitingForDisplay => "waitingForDisplay",
        AndroidEmulatorStartupStage::GeneratingFirstPreview => "generatingFirstPreview",
        AndroidEmulatorStartupStage::PreparingInteraction => "preparingInteraction",
        AndroidEmulatorStartupStage::Ready => "ready",
    }
}

fn source_name(source: PreviewSource) -> &'static str {
    match source {
        PreviewSource::Grpc => "grpc",
        PreviewSource::AdbFallback => "adbFallback",
    }
}

fn reason_name(reason: Option<PreviewReason>) -> &'static str {
    match reason {
        None => "none",
        Some(PreviewReason::GpuSoftware) => "gpuSoftware",
        Some(PreviewReason::Unavailable) => "unavailable",
        Some(PreviewReason::Unauthenticated) => "unauthenticated",
        Some(PreviewReason::Unsupported) => "unsupported",
    }
}

impl PreviewEventSink for OrderedAttachSink {
    fn frame_ready(&self, event: FrameReady) -> Result<(), String> {
        self.order
            .lock()
            .unwrap()
            .push(format!("frame-ready:{}:{}", event.generation, event.seq));
        Ok(())
    }

    fn preview_state(&self, state: PreviewState) -> Result<(), String> {
        self.order.lock().unwrap().push(format!(
            "preview-state:{}:{}:{}:{}:{}",
            state.generation,
            source_name(state.source),
            state.requested_fps,
            state.degraded,
            reason_name(state.reason),
        ));
        Ok(())
    }
}

impl AndroidFrameSink for OrderedAttachSink {
    fn frame(&self, frame: AndroidEmulatorFrame) -> Result<(), String> {
        self.order
            .lock()
            .unwrap()
            .push(format!("png:{}", frame.generation));
        self.frames.lock().unwrap().push(frame);
        Ok(())
    }

    fn error(&self, message: String) {
        self.errors.lock().unwrap().push(message);
    }

    fn lifecycle(&self, stage: AndroidEmulatorStartupStage) {
        self.order
            .lock()
            .unwrap()
            .push(format!("lifecycle:{}", lifecycle_name(stage)));
    }
}
