//! Preview runtime, coordinator, and legacy backend for an Android session.

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PreviewAvailability {
    Grpc,
    Unavailable,
    Unauthenticated,
    Unsupported,
}

pub(crate) struct PreviewRuntime {
    pub(super) mode: PreviewMode,
    pub(super) slot: Arc<LatestSlot>,
    control: Mutex<Option<tokio::sync::watch::Sender<PreviewControl>>>,
    fallback_started: AtomicBool,
    pub(super) availability: Mutex<PreviewAvailability>,
    pub(super) health: Arc<PreviewHealth>,
    #[cfg(test)]
    control_install_pause: Mutex<Option<TestPause>>,
    #[cfg(test)]
    worker_publish_pause: Mutex<Option<TestPause>>,
    #[cfg(test)]
    failed_availability_pause: Mutex<Option<TestPause>>,
}

impl PreviewRuntime {
    pub(crate) fn new(mode: PreviewMode, generation: u64) -> Self {
        Self {
            mode,
            slot: Arc::new(LatestSlot::new(generation)),
            control: Mutex::new(None),
            fallback_started: AtomicBool::new(false),
            availability: Mutex::new(match mode {
                PreviewMode::Vaf1 => PreviewAvailability::Grpc,
                PreviewMode::LegacyPrimary | PreviewMode::LegacyFallback => {
                    PreviewAvailability::Unavailable
                }
            }),
            health: Arc::new(PreviewHealth::new()),
            #[cfg(test)]
            control_install_pause: Mutex::new(None),
            #[cfg(test)]
            worker_publish_pause: Mutex::new(None),
            #[cfg(test)]
            failed_availability_pause: Mutex::new(None),
        }
    }

    pub(super) fn install_control(
        &self,
        sender: tokio::sync::watch::Sender<PreviewControl>,
    ) -> Result<(), String> {
        #[cfg(test)]
        wait_test_pause(&self.control_install_pause);
        let mut control = self
            .control
            .lock()
            .expect("Android preview control poisoned");
        if control.is_some() {
            return Err("Android preview control already installed".to_string());
        }
        *control = Some(sender);
        Ok(())
    }

    pub(super) fn install_control_with_gate(
        &self,
        gate: &PreviewGate,
        sender: tokio::sync::watch::Sender<PreviewControl>,
    ) -> Result<(), String> {
        #[cfg(test)]
        wait_test_pause(&self.control_install_pause);
        let mut control = self
            .control
            .lock()
            .expect("Android preview control poisoned");
        if control.is_some() {
            return Err("Android preview control already installed".to_string());
        }
        gate.install_control(sender.clone())?;
        *control = Some(sender);
        Ok(())
    }

    pub(super) fn send_control(&self, next: PreviewControl) {
        let control = self
            .control
            .lock()
            .expect("Android preview control poisoned");
        if let Some(sender) = control.as_ref() {
            let stop = sender.borrow().stop || next.stop;
            sender.send_replace(PreviewControl {
                visible: next.visible,
                stop,
            });
        }
    }

    pub(super) fn is_operational(&self, first_preview: &FirstPreviewGate) -> bool {
        first_preview.status() == FirstPreviewState::Ready && self.health.is_operational()
    }

    #[cfg(test)]
    pub(super) fn pause_before_control_install_for_test(
        &self,
    ) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
        arm_test_pause(&self.control_install_pause)
    }

    #[cfg(test)]
    pub(super) fn control_for_test(&self) -> Option<PreviewControl> {
        self.control
            .lock()
            .expect("Android preview control poisoned")
            .as_ref()
            .map(|sender| *sender.borrow())
    }

    #[cfg(test)]
    pub(super) fn pause_before_worker_publish_for_test(
        &self,
    ) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
        arm_test_pause(&self.worker_publish_pause)
    }

    #[cfg(test)]
    pub(super) fn pause_before_failed_availability_for_test(
        &self,
    ) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
        arm_test_pause(&self.failed_availability_pause)
    }
}

pub(super) trait PreviewFactoryProvider: Send + Sync {
    fn for_owned_pid(
        &self,
        pid: u32,
        avd_name: &str,
    ) -> Result<Arc<dyn super::super::preview::ScreenshotStreamFactory>, grpc::GrpcError>;
}

pub(super) struct SystemPreviewFactoryProvider;

struct LazyOwnedGrpcFactory {
    pid: u32,
    avd_name: String,
}

impl super::super::preview::ScreenshotStreamFactory for LazyOwnedGrpcFactory {
    fn open(&self, width: u32, height: u32) -> super::super::preview::OpenStreamFuture<'_> {
        let pid = self.pid;
        let avd_name = self.avd_name.clone();
        Box::pin(async move {
            let discovery = grpc::locate_owned_grpc(pid, &avd_name)?;
            let factory = grpc::TonicStreamFactory::new(discovery);
            factory.open(width, height).await
        })
    }
}

impl PreviewFactoryProvider for SystemPreviewFactoryProvider {
    fn for_owned_pid(
        &self,
        pid: u32,
        avd_name: &str,
    ) -> Result<Arc<dyn super::super::preview::ScreenshotStreamFactory>, grpc::GrpcError> {
        Ok(Arc::new(LazyOwnedGrpcFactory {
            pid,
            avd_name: avd_name.to_string(),
        }))
    }
}

pub(super) trait LegacyPreviewBackend: Send + Sync {
    fn emit_first_png(&self) -> Result<(), String>;
    fn run_loop(&self);
}

pub(super) trait LegacyPreviewBackendFactory: Send + Sync {
    fn build(
        &self,
        runner: Arc<dyn CommandRunner>,
        sink: Arc<dyn AndroidFrameSink>,
        session: Arc<AndroidSession>,
        mode: PreviewMode,
    ) -> Arc<dyn LegacyPreviewBackend>;
}

pub(super) struct SystemLegacyPreviewBackendFactory {
    service: Option<AndroidEmulatorService>,
}

impl SystemLegacyPreviewBackendFactory {
    pub(super) fn new(service: AndroidEmulatorService) -> Self {
        Self {
            service: Some(service),
        }
    }
}

impl Default for SystemLegacyPreviewBackendFactory {
    fn default() -> Self {
        Self { service: None }
    }
}

impl LegacyPreviewBackendFactory for SystemLegacyPreviewBackendFactory {
    fn build(
        &self,
        runner: Arc<dyn CommandRunner>,
        sink: Arc<dyn AndroidFrameSink>,
        session: Arc<AndroidSession>,
        mode: PreviewMode,
    ) -> Arc<dyn LegacyPreviewBackend> {
        Arc::new(SystemLegacyPreviewBackend {
            runner,
            sink,
            session,
            mode,
            service: self.service.clone(),
        })
    }
}

struct SystemLegacyPreviewBackend {
    runner: Arc<dyn CommandRunner>,
    sink: Arc<dyn AndroidFrameSink>,
    session: Arc<AndroidSession>,
    mode: PreviewMode,
    service: Option<AndroidEmulatorService>,
}

impl LegacyPreviewBackend for SystemLegacyPreviewBackend {
    fn emit_first_png(&self) -> Result<(), String> {
        loop {
            if !self.session.gate.wait_until_visible(&self.session.stop) {
                return Err("Android emulator attach was cancelled".to_string());
            }
            match capture_and_emit(
                self.runner.clone(),
                self.sink.as_ref(),
                self.session.as_ref(),
                self.session.stop.as_ref(),
            ) {
                Ok(true) => return Ok(()),
                Ok(false) if self.session.stop.load(Ordering::Acquire) => {
                    return Err("Android emulator attach was cancelled".to_string());
                }
                Ok(false) => continue,
                Err(error) => return Err(error),
            }
        }
    }

    fn run_loop(&self) {
        let on_device_lost = self.service.as_ref().map(|service| {
            let service = service.clone();
            let sink = self.sink.clone();
            Arc::new(move |generation| {
                let service = service.clone();
                let sink = sink.clone();
                thread::spawn(move || {
                    service.teardown_lost_device(generation, sink.as_ref());
                });
            }) as Arc<dyn Fn(u64) + Send + Sync>
        });
        run_android_frame_loop(
            self.runner.clone(),
            self.sink.clone(),
            self.session.clone(),
            self.mode,
            on_device_lost,
        );
        let terminal = if self.session.stop.load(Ordering::Acquire) {
            FirstPreviewError::Cancelled
        } else {
            FirstPreviewError::LegacyPng("Android legacy preview loop terminated".to_string())
        };
        self.session.preview.health.terminal(terminal);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CoordinatorOutcome {
    FallbackLoopFinished,
    AlreadyOwned,
}

pub(super) enum PreviewStart {
    LegacyPrimary(Arc<dyn LegacyPreviewBackend>),
    Coordinator,
    Cancelled,
}

fn availability_for_reason(reason: Option<PreviewReason>) -> PreviewAvailability {
    match reason {
        Some(PreviewReason::Unauthenticated) => PreviewAvailability::Unauthenticated,
        Some(PreviewReason::Unsupported) => PreviewAvailability::Unsupported,
        Some(PreviewReason::Unavailable)
        | Some(PreviewReason::GpuSoftware)
        | Some(PreviewReason::DeviceLost)
        | None => PreviewAvailability::Unavailable,
    }
}

fn publish_availability_unless_stopped(
    session: &AndroidSession,
    next: PreviewAvailability,
) -> bool {
    let mut availability = session
        .preview
        .availability
        .lock()
        .expect("Android preview availability poisoned");
    if session.stop.load(Ordering::Acquire) {
        return false;
    }
    *availability = next;
    true
}

pub(super) fn grpc_reason(error: grpc::GrpcError) -> PreviewReason {
    match error {
        grpc::GrpcError::Unavailable => PreviewReason::Unavailable,
        grpc::GrpcError::Unauthenticated => PreviewReason::Unauthenticated,
        grpc::GrpcError::Unsupported => PreviewReason::Unsupported,
    }
}

fn fail_closed_reason(error: &FirstPreviewError) -> Option<PreviewReason> {
    match error {
        FirstPreviewError::Cancelled => None,
        FirstPreviewError::Unauthenticated => Some(PreviewReason::Unauthenticated),
        FirstPreviewError::Unsupported => Some(PreviewReason::Unsupported),
        FirstPreviewError::Unavailable
        | FirstPreviewError::SequenceExhausted
        | FirstPreviewError::Event(_)
        | FirstPreviewError::LegacyPng(_) => Some(PreviewReason::Unavailable),
    }
}

fn requested_preview_fps(stream_fps: u16) -> u16 {
    AndroidStreamFps::try_from(stream_fps)
        .map(AndroidStreamFps::get)
        .unwrap_or(AndroidStreamFps::Fps60.get())
}

fn emit_fail_closed_preview_state(
    sink: &dyn AndroidFrameSink,
    session: &AndroidSession,
    error: &FirstPreviewError,
) {
    let Some(reason) = fail_closed_reason(error) else {
        return;
    };
    let requested_fps = requested_preview_fps(
        *session
            .stream_fps
            .lock()
            .expect("Android stream rate poisoned"),
    );
    let _ = sink.preview_state(PreviewState {
        generation: session.generation,
        source: PreviewSource::AdbFallback,
        requested_fps,
        degraded: true,
        reason: Some(reason),
    });
}

fn preview_failed_error(error: &FirstPreviewError) -> AndroidEmulatorError {
    AndroidEmulatorError {
        message: format!("Android emulator preview failed: {error}"),
        code: fail_closed_reason(error),
    }
}

pub(super) fn fail_first_or_emit_terminal(
    sink: &dyn AndroidFrameSink,
    session: &AndroidSession,
    error: FirstPreviewError,
) {
    emit_fail_closed_preview_state(sink, session, &error);
    if !session.first_preview.fail(error.clone()) {
        sink.error(preview_failed_error(&error));
    }
}

pub(super) fn coordinate_fallback(
    session: &AndroidSession,
    reason: Option<PreviewReason>,
    sink: &dyn AndroidFrameSink,
    legacy: &dyn LegacyPreviewBackend,
) -> Result<CoordinatorOutcome, FirstPreviewError> {
    if session
        .preview
        .fallback_started
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(CoordinatorOutcome::AlreadyOwned);
    }
    session.preview.slot.clear();
    if !publish_availability_unless_stopped(session, availability_for_reason(reason)) {
        return Ok(CoordinatorOutcome::AlreadyOwned);
    }
    let requested_fps = *session
        .stream_fps
        .lock()
        .expect("Android stream rate poisoned");
    if let Err(error) = sink.preview_state(PreviewState {
        generation: session.generation,
        source: PreviewSource::AdbFallback,
        requested_fps,
        degraded: true,
        reason,
    }) {
        let error = FirstPreviewError::Event(error);
        session.preview.health.terminal(error.clone());
        fail_first_or_emit_terminal(sink, session, error.clone());
        return Err(error);
    }
    if let Err(error) = legacy.emit_first_png() {
        let error = FirstPreviewError::LegacyPng(error);
        session.preview.health.terminal(error.clone());
        fail_first_or_emit_terminal(sink, session, error.clone());
        return Err(error);
    }
    session.preview.health.adb_active();
    session.first_preview.ready();
    legacy.run_loop();
    Ok(CoordinatorOutcome::FallbackLoopFinished)
}

pub(super) fn run_preview_coordinator(
    runner: Arc<dyn CommandRunner>,
    session: Arc<AndroidSession>,
    control: tokio::sync::watch::Receiver<PreviewControl>,
    provider: Arc<dyn PreviewFactoryProvider>,
    legacy_factory: Arc<dyn LegacyPreviewBackendFactory>,
    sink: Arc<dyn AndroidFrameSink>,
) {
    let worker_outcome = match session.preview.mode {
        PreviewMode::LegacyFallback => WorkerOutcome::Fallback(PreviewReason::Unavailable),
        PreviewMode::Vaf1 if session.ownership == AndroidEmulatorOwnership::External => {
            WorkerOutcome::Fallback(PreviewReason::Unavailable)
        }
        PreviewMode::Vaf1 => match session.emulator_pid {
            None => WorkerOutcome::Fallback(PreviewReason::Unavailable),
            Some(pid) => match provider.for_owned_pid(pid, &session.avd_name) {
                Err(error) => WorkerOutcome::Fallback(grpc_reason(error)),
                Ok(factory) => match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Err(_) => WorkerOutcome::Fallback(PreviewReason::Unavailable),
                    Ok(runtime) => {
                        runtime.block_on(super::super::preview::run_vaf1_worker_with_open_retry(
                            session.generation,
                            session.stream_fps.clone(),
                            session.preview.slot.clone(),
                            session.dimensions.clone(),
                            session.first_preview.clone(),
                            session.preview.health.clone(),
                            control,
                            factory,
                            sink.clone(),
                            super::super::preview::coordinator_clock(),
                            session.gpu_software,
                            Some(super::super::preview::OWNED_OPEN_RETRY),
                        ))
                    }
                },
            },
        },
        PreviewMode::LegacyPrimary => return,
    };

    match worker_outcome {
        WorkerOutcome::Fallback(reason) => {
            let backend = legacy_factory.build(
                runner,
                sink.clone(),
                session.clone(),
                PreviewMode::LegacyFallback,
            );
            let reason = if session.preview.mode == PreviewMode::LegacyFallback {
                None
            } else {
                Some(reason)
            };
            let _ = coordinate_fallback(session.as_ref(), reason, sink.as_ref(), backend.as_ref());
        }
        WorkerOutcome::Failed(error) => {
            // Linearization (Maestro): the worker marks health/first_preview
            // terminal before this arm. Overlap until availability is written is
            // accepted — a concurrent read_frame_sync that sees an empty slot
            // while still Grpc returns NoFrame. After this lock write, later
            // reads observe Unavailable. Do not reorder that linearization.
            // Clear the slot before publishing Unavailable so SequenceExhausted
            // cannot serve a residual frame (same contract as coordinate_fallback).
            // Coordinator availability writes check session.stop under the same
            // lock so an in-flight Fallback cannot overwrite a cancel terminal.
            session.preview.health.terminal(error.clone());
            session.preview.slot.clear();
            #[cfg(test)]
            wait_test_pause(&session.preview.failed_availability_pause);
            if publish_availability_unless_stopped(
                session.as_ref(),
                PreviewAvailability::Unavailable,
            ) {
                fail_first_or_emit_terminal(sink.as_ref(), session.as_ref(), error);
            }
        }
        WorkerOutcome::Stopped => {
            let error = FirstPreviewError::Cancelled;
            session.preview.health.terminal(error.clone());
            let _ = publish_availability_unless_stopped(
                session.as_ref(),
                PreviewAvailability::Unavailable,
            );
            session.first_preview.fail(error);
        }
    }
}

pub(super) fn start_preview_for_session(
    runner: Arc<dyn CommandRunner>,
    session: Arc<AndroidSession>,
    sink: Arc<dyn AndroidFrameSink>,
    provider: Arc<dyn PreviewFactoryProvider>,
    legacy_factory: Arc<dyn LegacyPreviewBackendFactory>,
) -> PreviewStart {
    if session.stop.load(Ordering::Acquire) {
        let error = FirstPreviewError::Cancelled;
        session.preview.health.terminal(error.clone());
        session.first_preview.fail(error);
        return PreviewStart::Cancelled;
    }
    match session.preview.mode {
        PreviewMode::LegacyPrimary => {
            let backend =
                legacy_factory.build(runner, sink, session.clone(), PreviewMode::LegacyPrimary);
            match backend.emit_first_png() {
                Ok(()) => {
                    if session.stop.load(Ordering::Acquire) {
                        let error = FirstPreviewError::Cancelled;
                        session.preview.health.terminal(error.clone());
                        session.first_preview.fail(error);
                        return PreviewStart::Cancelled;
                    }
                    session.preview.health.adb_active();
                    session.first_preview.ready();
                }
                Err(_) if session.stop.load(Ordering::Acquire) => {
                    let error = FirstPreviewError::Cancelled;
                    session.preview.health.terminal(error.clone());
                    session.first_preview.fail(error);
                    return PreviewStart::Cancelled;
                }
                Err(error) => {
                    let error = FirstPreviewError::LegacyPng(error);
                    session.preview.health.terminal(error.clone());
                    session.first_preview.fail(error);
                }
            }
            PreviewStart::LegacyPrimary(backend)
        }
        PreviewMode::Vaf1 | PreviewMode::LegacyFallback => {
            let (control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
                visible: false,
                stop: false,
            });
            if let Err(error) = session
                .preview
                .install_control_with_gate(session.gate.as_ref(), control_tx)
            {
                let error = FirstPreviewError::Event(error);
                session.preview.health.terminal(error.clone());
                session.first_preview.fail(error);
                return PreviewStart::Coordinator;
            }
            let worker_session = session.clone();
            let name = format!("verboo-android-vaf1-{}", session.generation);
            let mut workers = session
                .workers
                .lock()
                .expect("Android emulator workers poisoned");
            if session.stop.load(Ordering::Acquire) {
                let error = FirstPreviewError::Cancelled;
                session.preview.health.terminal(error.clone());
                session.first_preview.fail(error);
                return PreviewStart::Cancelled;
            }
            match thread::Builder::new().name(name).spawn(move || {
                run_preview_coordinator(
                    runner,
                    worker_session,
                    control_rx,
                    provider,
                    legacy_factory,
                    sink,
                );
            }) {
                Ok(worker) => {
                    #[cfg(test)]
                    wait_test_pause(&session.preview.worker_publish_pause);
                    workers.push(worker);
                }
                Err(_) => {
                    let error = FirstPreviewError::Unavailable;
                    session.preview.health.terminal(error.clone());
                    session.first_preview.fail(error);
                }
            }
            PreviewStart::Coordinator
        }
    }
}

pub(super) fn finish_started_preview(
    sink: &dyn AndroidFrameSink,
    session: &Arc<AndroidSession>,
    start: PreviewStart,
) -> Result<(), FirstPreviewError> {
    if matches!(start, PreviewStart::Cancelled) {
        return Err(FirstPreviewError::Cancelled);
    }
    match session.first_preview.wait() {
        Ok(()) => {
            if session.stop.load(Ordering::Acquire) {
                return Err(FirstPreviewError::Cancelled);
            }
            sink.lifecycle(AndroidEmulatorStartupStage::PreparingInteraction);
            sink.lifecycle(AndroidEmulatorStartupStage::Ready);
            if let PreviewStart::LegacyPrimary(backend) = start {
                let name = format!("verboo-android-frame-{}", session.generation);
                let mut workers = session
                    .workers
                    .lock()
                    .expect("Android emulator workers poisoned");
                let worker = thread::Builder::new()
                    .name(name)
                    .spawn(move || backend.run_loop())
                    .map_err(|_| FirstPreviewError::Unavailable)?;
                workers.push(worker);
            }
            Ok(())
        }
        Err(error) => {
            emit_fail_closed_preview_state(sink, session, &error);
            sink.error(preview_failed_error(&error));
            Err(error)
        }
    }
}

pub(super) fn capture_and_emit(
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
    let mut emission = Ok(());
    let visible = session.gate.emit_if_visible(&session.stop, || {
        *session
            .dimensions
            .lock()
            .expect("Android frame dimensions poisoned") = Some((width, height));
        emission = sink.frame(frame);
    });
    emission?;
    Ok(visible)
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

/// Consecutive screencap "not found"/"offline" failures required before
/// the PNG loop tears the session down. 3: one transient adb blip must
/// not detach; three in a row at fallback 0.5–2 fps is the death signal
/// (~1.5–6s), inside `ANDROID_CLEANUP_BUDGET`.
pub(super) const DEVICE_GONE_CONSECUTIVE_FAILURES: u8 = 3;

pub(super) fn is_device_gone_screencap(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("not found") || lower.contains("offline")
}

pub(super) fn run_android_frame_loop(
    runner: Arc<dyn CommandRunner>,
    sink: Arc<dyn AndroidFrameSink>,
    session: Arc<AndroidSession>,
    mode: PreviewMode,
    on_device_lost: Option<Arc<dyn Fn(u64) + Send + Sync>>,
) {
    let mut gone_streak = 0u8;
    loop {
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
                gone_streak = 0;
                let frame = AndroidEmulatorFrame {
                    png_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                    width,
                    height,
                    generation: session.generation,
                };
                let mut emission = Ok(());
                session.gate.emit_if_visible(&session.stop, || {
                    *session
                        .dimensions
                        .lock()
                        .expect("Android frame dimensions poisoned") = Some((width, height));
                    emission = sink.frame(frame);
                });
                if let Err(error) = emission {
                    sink.error(AndroidEmulatorError::from_message(error));
                    break;
                }
                match mode {
                    PreviewMode::LegacyPrimary => f64::from(
                        *session
                            .stream_fps
                            .lock()
                            .expect("Android stream rate poisoned"),
                    ),
                    PreviewMode::Vaf1 | PreviewMode::LegacyFallback => *session
                        .fallback_fps
                        .lock()
                        .expect("Android fallback rate poisoned"),
                }
            }
            Err(_) if session.stop.load(Ordering::Acquire) => break,
            Err(error) => {
                if is_device_gone_screencap(&error) {
                    gone_streak = gone_streak.saturating_add(1);
                    if gone_streak >= DEVICE_GONE_CONSECUTIVE_FAILURES {
                        sink.error(AndroidEmulatorError::with_code(
                            error,
                            PreviewReason::DeviceLost,
                        ));
                        if let Some(on_lost) = on_device_lost.clone() {
                            on_lost(session.generation);
                        }
                        break;
                    }
                } else {
                    gone_streak = 0;
                    sink.error(AndroidEmulatorError::from_message(error));
                    if mode != PreviewMode::LegacyPrimary {
                        break;
                    }
                }
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
    }
}
