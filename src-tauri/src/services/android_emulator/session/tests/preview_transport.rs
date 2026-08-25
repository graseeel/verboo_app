struct OpenErrorFactory(super::super::grpc::GrpcError);

impl ScreenshotStreamFactory for OpenErrorFactory {
    fn open(&self, _width: u32, _height: u32) -> OpenStreamFuture<'_> {
        let error = self.0;
        Box::pin(async move { Err(error) })
    }
}

struct RecordingPreviewFactoryProvider {
    calls: Mutex<Vec<(u32, String)>>,
    error: super::super::grpc::GrpcError,
}

impl RecordingPreviewFactoryProvider {
    fn new(error: super::super::grpc::GrpcError) -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            error,
        }
    }

    fn calls(&self) -> Vec<(u32, String)> {
        self.calls.lock().unwrap().clone()
    }
}

impl PreviewFactoryProvider for RecordingPreviewFactoryProvider {
    fn for_owned_pid(
        &self,
        pid: u32,
        avd_name: &str,
    ) -> Result<Arc<dyn ScreenshotStreamFactory>, super::super::grpc::GrpcError> {
        self.calls.lock().unwrap().push((pid, avd_name.to_string()));
        Ok(Arc::new(OpenErrorFactory(self.error)))
    }
}

struct OneFrameStream {
    first: Option<generated::Image>,
}

impl ScreenshotStream for OneFrameStream {
    fn message(&mut self) -> StreamMessageFuture<'_> {
        match self.first.take() {
            Some(frame) => Box::pin(async move { Ok(Some(frame)) }),
            None => Box::pin(std::future::pending()),
        }
    }
}

struct OneFrameFactory {
    frame: Mutex<Option<generated::Image>>,
    requested_sizes: Arc<Mutex<Vec<(u32, u32)>>>,
}

impl ScreenshotStreamFactory for OneFrameFactory {
    fn open(&self, width: u32, height: u32) -> OpenStreamFuture<'_> {
        self.requested_sizes.lock().unwrap().push((width, height));
        let frame = self
            .frame
            .lock()
            .unwrap()
            .take()
            .ok_or(super::super::grpc::GrpcError::Unsupported);
        Box::pin(async move {
            frame.map(|frame| {
                Box::new(OneFrameStream { first: Some(frame) }) as Box<dyn ScreenshotStream>
            })
        })
    }
}

struct OneFramePreviewFactoryProvider {
    calls: Mutex<Vec<(u32, String)>>,
    frame: Mutex<Option<generated::Image>>,
    requested_sizes: Arc<Mutex<Vec<(u32, u32)>>>,
}

impl OneFramePreviewFactoryProvider {
    fn new(frame: generated::Image) -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            frame: Mutex::new(Some(frame)),
            requested_sizes: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl PreviewFactoryProvider for OneFramePreviewFactoryProvider {
    fn for_owned_pid(
        &self,
        pid: u32,
        avd_name: &str,
    ) -> Result<Arc<dyn ScreenshotStreamFactory>, super::super::grpc::GrpcError> {
        self.calls.lock().unwrap().push((pid, avd_name.to_string()));
        let frame = self
            .frame
            .lock()
            .unwrap()
            .take()
            .ok_or(super::super::grpc::GrpcError::Unsupported)?;
        Ok(Arc::new(OneFrameFactory {
            frame: Mutex::new(Some(frame)),
            requested_sizes: self.requested_sizes.clone(),
        }))
    }
}

#[derive(Default)]
struct LoopProbe {
    count: Mutex<usize>,
    changed: Condvar,
}

impl LoopProbe {
    fn mark(&self) {
        *self.count.lock().unwrap() += 1;
        self.changed.notify_all();
    }

    fn wait_for(&self, expected: usize) {
        let mut count = self.count.lock().unwrap();
        while *count < expected {
            count = self.changed.wait(count).unwrap();
        }
    }

    fn count(&self) -> usize {
        *self.count.lock().unwrap()
    }
}

struct RecordingLegacyPreviewBackendFactory {
    order: Arc<Mutex<Vec<String>>>,
    loop_probe: Arc<LoopProbe>,
    observed_rates: Arc<Mutex<Vec<f64>>>,
    fail_first_png: Mutex<Option<String>>,
}

impl RecordingLegacyPreviewBackendFactory {
    fn new(order: Arc<Mutex<Vec<String>>>) -> Self {
        Self {
            order,
            loop_probe: Arc::new(LoopProbe::default()),
            observed_rates: Arc::new(Mutex::new(Vec::new())),
            fail_first_png: Mutex::new(None),
        }
    }

    fn fail_first_png(&self, message: &str) {
        *self.fail_first_png.lock().unwrap() = Some(message.to_string());
    }
}

struct RecordingLegacyPreviewBackend {
    generation: u64,
    mode: PreviewMode,
    stream_fps: Arc<Mutex<u16>>,
    fallback_fps: Arc<Mutex<f64>>,
    order: Arc<Mutex<Vec<String>>>,
    loop_probe: Arc<LoopProbe>,
    observed_rates: Arc<Mutex<Vec<f64>>>,
    fail_first_png: Option<String>,
}

impl LegacyPreviewBackend for RecordingLegacyPreviewBackend {
    fn emit_first_png(&self) -> Result<(), String> {
        self.order
            .lock()
            .unwrap()
            .push(format!("png:{}", self.generation));
        match &self.fail_first_png {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }

    fn run_loop(&self) {
        let rate = self.mode.capture_fps(
            *self.stream_fps.lock().unwrap(),
            *self.fallback_fps.lock().unwrap(),
        );
        self.observed_rates.lock().unwrap().push(rate);
        self.loop_probe.mark();
    }
}

impl LegacyPreviewBackendFactory for RecordingLegacyPreviewBackendFactory {
    fn build(
        &self,
        _runner: Arc<dyn CommandRunner>,
        _sink: Arc<dyn AndroidFrameSink>,
        session: Arc<AndroidSession>,
        mode: PreviewMode,
    ) -> Arc<dyn LegacyPreviewBackend> {
        Arc::new(RecordingLegacyPreviewBackend {
            generation: session.generation,
            mode,
            stream_fps: session.stream_fps.clone(),
            fallback_fps: session.fallback_fps.clone(),
            order: self.order.clone(),
            loop_probe: self.loop_probe.clone(),
            observed_rates: self.observed_rates.clone(),
            fail_first_png: self.fail_first_png.lock().unwrap().take(),
        })
    }
}

struct BlockingFirstPngFactory {
    entered: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    release: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
}

struct FirstPngReleaseGuard(Option<std::sync::mpsc::Sender<()>>);

impl Drop for FirstPngReleaseGuard {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}

impl BlockingFirstPngFactory {
    fn new() -> (
        Arc<Self>,
        std::sync::mpsc::Receiver<()>,
        FirstPngReleaseGuard,
    ) {
        let (entered_sender, entered_receiver) = std::sync::mpsc::channel();
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        (
            Arc::new(Self {
                entered: Mutex::new(Some(entered_sender)),
                release: Mutex::new(Some(release_receiver)),
            }),
            entered_receiver,
            FirstPngReleaseGuard(Some(release_sender)),
        )
    }
}

struct BlockingFirstPngBackend {
    session: Arc<AndroidSession>,
    entered: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    release: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
}

impl LegacyPreviewBackend for BlockingFirstPngBackend {
    fn emit_first_png(&self) -> Result<(), String> {
        self.entered
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .send(())
            .unwrap();
        self.release.lock().unwrap().take().unwrap().recv().unwrap();
        if self.session.stop.load(Ordering::Acquire) {
            Err("first PNG cancelled".to_string())
        } else {
            Ok(())
        }
    }

    fn run_loop(&self) {}
}

impl LegacyPreviewBackendFactory for BlockingFirstPngFactory {
    fn build(
        &self,
        _runner: Arc<dyn CommandRunner>,
        _sink: Arc<dyn AndroidFrameSink>,
        session: Arc<AndroidSession>,
        _mode: PreviewMode,
    ) -> Arc<dyn LegacyPreviewBackend> {
        Arc::new(BlockingFirstPngBackend {
            session,
            entered: Mutex::new(self.entered.lock().unwrap().take()),
            release: Mutex::new(self.release.lock().unwrap().take()),
        })
    }
}

fn rgb_image(width: u32, height: u32) -> generated::Image {
    generated::Image {
        format: Some(generated::ImageFormat {
            format: generated::image_format::ImgFormat::Rgb888 as i32,
            width,
            height,
        }),
        image: vec![0; width as usize * height as usize * 3],
        seq: 4_000_000_000,
        timestamp_us: 1,
    }
}

fn assert_order_before(order: &[String], first: &str, second: &str) {
    let first_index = order
        .iter()
        .position(|entry| entry.contains(first))
        .unwrap_or_else(|| panic!("missing {first} in {order:?}"));
    let second_index = order
        .iter()
        .position(|entry| entry.contains(second))
        .unwrap_or_else(|| panic!("missing {second} in {order:?}"));
    assert!(first_index < second_index, "{order:?}");
}

#[test]
fn vaf1_grpc_failure_fallback_is_ordered_single_owner_and_no_legacy_error() {
    let root = tempfile::tempdir().unwrap();
    let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    let sink = Arc::new(OrderedAttachSink::default());
    let provider = Arc::new(RecordingPreviewFactoryProvider::new(GrpcError::Unavailable));
    let legacy = Arc::new(RecordingLegacyPreviewBackendFactory::new(sink.order_arc()));
    let session = test_android_session_for_mode(
        AndroidEmulatorOwnership::Verboo,
        PreviewMode::Vaf1,
        7,
        Some(4242),
    );
    *session.stream_fps.lock().unwrap() = 60;
    sink.lifecycle(AndroidEmulatorStartupStage::GeneratingFirstPreview);
    let (control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
        visible: true,
        stop: false,
    });
    session.preview.install_control(control_tx).unwrap();

    run_preview_coordinator(
        service.runner.clone(),
        session.clone(),
        control_rx,
        provider.clone(),
        legacy.clone(),
        sink.clone(),
    );
    assert_eq!(session.first_preview.status(), FirstPreviewState::Ready);
    finish_started_preview(sink.as_ref(), &session, PreviewStart::Coordinator).unwrap();
    sink.attach_response(7);

    let second_backend = legacy.build(
        service.runner.clone(),
        sink.clone(),
        session.clone(),
        PreviewMode::LegacyFallback,
    );
    assert!(matches!(
        coordinate_fallback(
            session.as_ref(),
            Some(PreviewReason::Unauthenticated),
            sink.as_ref(),
            second_backend.as_ref(),
        ),
        Ok(CoordinatorOutcome::AlreadyOwned)
    ));

    let order = sink.order();
    assert_order_before(&order, "generatingFirstPreview", "preview-state");
    assert_order_before(
        &order,
        "preview-state:7:adbFallback:60:true:unavailable",
        "png:7",
    );
    assert_order_before(&order, "png:7", "preparingInteraction");
    assert_order_before(&order, "ready", "attach-response:7");
    assert_eq!(legacy.loop_probe.count(), 1);
    assert_eq!(provider.calls(), vec![(4242, "Pixel_8_API_35".to_string())]);
    assert!(sink.errors().is_empty());
}

#[test]
fn vaf1_first_slot_and_frame_ready_precede_ready_and_attach_response() {
    let root = tempfile::tempdir().unwrap();
    let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    let sink = Arc::new(OrderedAttachSink::default());
    let provider = Arc::new(OneFramePreviewFactoryProvider::new(rgb_image(2, 3)));
    let legacy = Arc::new(RecordingLegacyPreviewBackendFactory::new(sink.order_arc()));
    let session = test_android_session_for_mode(
        AndroidEmulatorOwnership::Verboo,
        PreviewMode::Vaf1,
        7,
        Some(4242),
    );
    *session.stream_fps.lock().unwrap() = 60;
    sink.lifecycle(AndroidEmulatorStartupStage::GeneratingFirstPreview);
    let start = start_preview_for_session(
        service.runner.clone(),
        session.clone(),
        sink.clone(),
        provider.clone(),
        legacy,
    );
    finish_started_preview(sink.as_ref(), &session, start).unwrap();
    sink.attach_response(7);

    let bytes = session.preview.slot.take(7).unwrap();
    assert_eq!(&bytes[0..4], b"VAF1");
    assert_eq!(u64::from_le_bytes(bytes[4..12].try_into().unwrap()), 7);
    let order = sink.order();
    assert_order_before(&order, "generatingFirstPreview", "preview-state:7:grpc");
    assert_order_before(&order, "preview-state:7:grpc", "frame-ready:7:1");
    assert_order_before(&order, "frame-ready:7:1", "preparingInteraction");
    assert_order_before(&order, "ready", "attach-response:7");
    assert_eq!(
        provider.calls.lock().unwrap().as_slice(),
        &[(4242, "Pixel_8_API_35".to_string())]
    );
    assert!(sink.errors().is_empty());
    service.stop_preview_workers(&session);
}

#[test]
fn vaf1_published_frame_writes_dimensions_so_tap_can_normalize() {
    let root = tempfile::tempdir().unwrap();
    let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    service.runner = Arc::new(RecordingRunner::default());
    let sink = Arc::new(OrderedAttachSink::default());
    let provider = Arc::new(OneFramePreviewFactoryProvider::new(rgb_image(2, 3)));
    let legacy = Arc::new(RecordingLegacyPreviewBackendFactory::new(sink.order_arc()));
    let session = test_android_session_for_mode(
        AndroidEmulatorOwnership::Verboo,
        PreviewMode::Vaf1,
        7,
        Some(4242),
    );
    *session.dimensions.lock().unwrap() = None;
    *session.stream_fps.lock().unwrap() = 60;
    let start = start_preview_for_session(
        service.runner.clone(),
        session.clone(),
        sink.clone(),
        provider,
        legacy,
    );
    finish_started_preview(sink.as_ref(), &session, start).unwrap();
    assert_eq!(
        *session.dimensions.lock().unwrap(),
        Some((2, 3)),
        "VAF1 publish must write session.dimensions from the validated frame"
    );
    service.state.lock().unwrap().session = Some(session);
    service
        .tap_sync(0.5, 0.5, super::super::input::InputOrigin::Agent)
        .expect("tap after a VAF1 frame must normalize; dimensions were not ready");
    service.stop_preview_workers(service.state.lock().unwrap().session.as_ref().unwrap());
}

#[test]
fn external_vaf1_emits_adb_state_before_png_with_zero_launcher() {
    let root = tempfile::tempdir().unwrap();
    let runner = Arc::new(ExternalAttachRunner::default());
    let launcher = RecordingEmulatorLauncher::default();
    let sink = Arc::new(OrderedAttachSink::default());
    let provider = Arc::new(RecordingPreviewFactoryProvider::new(GrpcError::Unavailable));
    let legacy = Arc::new(RecordingLegacyPreviewBackendFactory::new(sink.order_arc()));
    let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    service.runner = runner.clone();

    let first = service
        .attach_sync_with_sink(
            None,
            sink.clone(),
            &launcher,
            provider.clone(),
            legacy.clone(),
            "Pixel_8_API_35".to_string(),
            60,
            1.0,
            Some(PreviewTransport::Vaf1),
        )
        .unwrap();
    sink.attach_response(first.generation);
    let second = service
        .attach_sync_with_sink(
            None,
            sink.clone(),
            &launcher,
            provider.clone(),
            legacy.clone(),
            "Pixel_8_API_35".to_string(),
            60,
            1.0,
            Some(PreviewTransport::Vaf1),
        )
        .unwrap();
    sink.attach_response(second.generation);
    legacy.loop_probe.wait_for(1);

    let order = sink.order();
    assert_eq!(first.generation, second.generation);
    assert_order_before(&order, "generatingFirstPreview", "preview-state");
    assert_order_before(
        &order,
        "preview-state:1:adbFallback:60:true:unavailable",
        "png:1",
    );
    assert_order_before(&order, "png:1", "preparingInteraction");
    assert_order_before(&order, "ready", "attach-response:1");
    assert_eq!(provider.calls(), Vec::<(u32, String)>::new());
    assert!(launcher.calls.lock().unwrap().is_empty());
    assert_eq!(legacy.loop_probe.count(), 1);
    assert_eq!(
        runner
            .commands
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, args)| args.windows(2).any(|pair| pair == ["emu", "kill"]))
            .count(),
        0,
    );
    assert!(sink.errors().is_empty());
}

#[test]
fn explicit_legacy_uses_fallback_rate_and_state() {
    let root = tempfile::tempdir().unwrap();
    let runner = Arc::new(ExternalAttachRunner::default());
    let launcher = RecordingEmulatorLauncher::default();
    let sink = Arc::new(OrderedAttachSink::default());
    let provider = Arc::new(RecordingPreviewFactoryProvider::new(GrpcError::Unavailable));
    let legacy = Arc::new(RecordingLegacyPreviewBackendFactory::new(sink.order_arc()));
    let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    service.runner = runner;
    service
        .attach_sync_with_sink(
            None,
            sink.clone(),
            &launcher,
            provider.clone(),
            legacy.clone(),
            "Pixel_8_API_35".to_string(),
            60,
            1.0,
            Some(PreviewTransport::LegacyPng),
        )
        .unwrap();
    legacy.loop_probe.wait_for(1);
    assert_eq!(*legacy.observed_rates.lock().unwrap(), vec![1.0]);
    assert!(sink
        .order()
        .iter()
        .any(|entry| entry == "preview-state:1:adbFallback:60:true:none"));
    assert_order_before(&sink.order(), "preview-state", "png:1");
    assert!(sink.errors().is_empty());
}

#[test]
fn absent_transport_keeps_first_png_bytes_and_two_fps_without_preview_state() {
    use base64::Engine as _;

    let root = tempfile::tempdir().unwrap();
    let runner = Arc::new(ExternalAttachRunner::default());
    let launcher = RecordingEmulatorLauncher::default();
    let sink = Arc::new(OrderedAttachSink::default());
    let provider = Arc::new(RecordingPreviewFactoryProvider::new(GrpcError::Unavailable));
    let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    service.runner = runner;
    service
        .attach_sync_with_sink(
            None,
            sink.clone(),
            &launcher,
            provider,
            Arc::new(SystemLegacyPreviewBackendFactory),
            "Pixel_8_API_35".to_string(),
            2,
            1.0,
            None,
        )
        .unwrap();
    let expected = base64::engine::general_purpose::STANDARD.encode(png_output().stdout);
    let first = sink.frames().into_iter().next().unwrap();
    assert_eq!(first.png_base64, expected);
    assert_eq!(first.width, 1080);
    assert_eq!(first.height, 1920);
    assert!(!sink
        .order()
        .iter()
        .any(|entry| entry.contains("preview-state")));
    assert_eq!(
        service.current_session().unwrap().preview.mode,
        PreviewMode::LegacyPrimary
    );
    assert_eq!(
        *service
            .current_session()
            .unwrap()
            .stream_fps
            .lock()
            .unwrap(),
        2
    );
    service.detach_sync().unwrap();
}

#[test]
fn hide_returns_only_after_inflight_publish_event_and_slot_clear() {
    let root = tempfile::tempdir().unwrap();
    let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    let session = test_android_session_for_mode(
        AndroidEmulatorOwnership::External,
        PreviewMode::Vaf1,
        7,
        None,
    );
    let sink = Arc::new(OrderedAttachSink::default());
    let (control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
        visible: true,
        stop: false,
    });
    session.preview.install_control(control_tx).unwrap();
    service.state.lock().unwrap().session = Some(session.clone());

    let (borrowed_tx, borrowed_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let worker_slot = session.preview.slot.clone();
    let worker_sink = sink.clone();
    let worker = thread::spawn(move || {
        let final_control = control_rx.borrow();
        borrowed_tx.send(()).unwrap();
        release_rx.recv().unwrap();
        let payload = [1, 2, 3];
        worker_slot.publish(
            1,
            ValidatedRgbFrame {
                width: 1,
                height: 1,
                timestamp_us: 1,
                payload: &payload,
            },
        );
        worker_sink
            .frame_ready(FrameReady {
                generation: 7,
                seq: 1,
            })
            .unwrap();
        drop(final_control);
    });

    borrowed_rx.recv().unwrap();
    let (setter_started_tx, setter_started_rx) = std::sync::mpsc::channel();
    let setter_service = service.clone();
    let setter_order = sink.order_arc();
    let setter = thread::spawn(move || {
        setter_started_tx.send(()).unwrap();
        setter_service.set_visible_sync(false).unwrap();
        setter_order.lock().unwrap().push("hide-return".to_string());
    });
    setter_started_rx.recv().unwrap();
    release_tx.send(()).unwrap();
    worker.join().unwrap();
    setter.join().unwrap();

    assert_eq!(session.preview.slot.take(7), Err(PreviewReadError::NoFrame));
    let order = sink.order();
    assert_order_before(&order, "frame-ready:7:1", "hide-return");
    assert!(!service.desired_visibility.load(Ordering::Acquire));
}

#[test]
fn same_avd_transport_switch_preserves_owned_arcs_ledger_and_process() {
    let root = tempfile::tempdir().unwrap();
    let runner = Arc::new(ExternalAttachRunner::default());
    let launcher = RecordingEmulatorLauncher::default();
    let sink = Arc::new(OrderedAttachSink::default());
    let provider = Arc::new(RecordingPreviewFactoryProvider::new(GrpcError::Unavailable));
    let legacy = Arc::new(RecordingLegacyPreviewBackendFactory::new(sink.order_arc()));
    let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    service.runner = runner.clone();
    service.next_generation.store(7, Ordering::Release);
    service.ownership.mark_booted("Pixel_8_API_35").unwrap();
    let current = test_android_session_for_mode(
        AndroidEmulatorOwnership::Verboo,
        PreviewMode::Vaf1,
        7,
        Some(4242),
    );
    *current.stream_fps.lock().unwrap() = 60;
    let process = current.emulator_process.clone();
    let recording = current.recording.clone();
    let input_lock = current.input_lock.clone();
    let ledger_before = service.ownership.phase("Pixel_8_API_35");
    service.state.lock().unwrap().session = Some(current.clone());

    let switched = service
        .attach_sync_with_sink(
            None,
            sink.clone(),
            &launcher,
            provider.clone(),
            legacy.clone(),
            "Pixel_8_API_35".to_string(),
            60,
            1.0,
            Some(PreviewTransport::LegacyPng),
        )
        .unwrap();
    legacy.loop_probe.wait_for(1);
    let replacement = service.current_session().unwrap();
    assert_eq!(switched.generation, 8);
    assert!(Arc::ptr_eq(&process, &replacement.emulator_process));
    assert!(Arc::ptr_eq(&recording, &replacement.recording));
    assert!(Arc::ptr_eq(&input_lock, &replacement.input_lock));
    assert_eq!(replacement.serial, "emulator-5554");
    assert_eq!(replacement.emulator_pid, Some(4242));
    assert_eq!(service.ownership.phase("Pixel_8_API_35"), ledger_before);
    assert!(current.stop.load(Ordering::Acquire));
    assert!(current.workers.lock().unwrap().is_empty());
    assert!(launcher.calls.lock().unwrap().is_empty());
    assert!(provider.calls().is_empty());
    assert_eq!(
        runner
            .commands
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, args)| args.windows(2).any(|pair| pair == ["emu", "kill"]))
            .count(),
        0,
    );
    assert_order_before(
        &sink.order(),
        "preview-state:8:adbFallback:60:true:none",
        "png:8",
    );

    let same_mode = service
        .attach_sync_with_sink(
            None,
            sink.clone(),
            &launcher,
            provider,
            legacy.clone(),
            "Pixel_8_API_35".to_string(),
            30,
            0.5,
            Some(PreviewTransport::LegacyPng),
        )
        .unwrap();
    assert_eq!(same_mode.generation, 8);
    assert_eq!(same_mode.stream_fps, 30);
    assert_eq!(same_mode.fallback_fps, 0.5);
    assert_eq!(legacy.loop_probe.count(), 1);
    assert_eq!(
        sink.order()
            .iter()
            .filter(|entry| entry.contains("preview-state"))
            .count(),
        1,
    );
}

#[test]
fn failed_same_mode_preview_retry_allocates_generation_and_restarts_without_kill() {
    let root = tempfile::tempdir().unwrap();
    let runner = Arc::new(ExternalAttachRunner::default());
    let launcher = RecordingEmulatorLauncher::default();
    let sink = Arc::new(OrderedAttachSink::default());
    let provider = Arc::new(RecordingPreviewFactoryProvider::new(GrpcError::Unavailable));
    let legacy = Arc::new(RecordingLegacyPreviewBackendFactory::new(sink.order_arc()));
    legacy.fail_first_png("first degraded PNG failed");
    let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    service.runner = runner.clone();
    service.next_generation.store(7, Ordering::Release);
    service.ownership.mark_booted("Pixel_8_API_35").unwrap();
    let current = test_android_session_for_mode(
        AndroidEmulatorOwnership::Verboo,
        PreviewMode::LegacyFallback,
        7,
        Some(4242),
    );
    current.preview.health.recovering();
    current.first_preview.ready();
    let process = current.emulator_process.clone();
    service.state.lock().unwrap().session = Some(current);

    assert!(service
        .attach_sync_with_sink(
            None,
            sink.clone(),
            &launcher,
            provider.clone(),
            legacy.clone(),
            "Pixel_8_API_35".to_string(),
            60,
            1.0,
            Some(PreviewTransport::LegacyPng),
        )
        .is_err());
    let failed = service.current_session().unwrap();
    assert_eq!(failed.generation, 8);
    assert!(matches!(
        failed.first_preview.status(),
        FirstPreviewState::Failed(FirstPreviewError::LegacyPng(_))
    ));
    assert!(matches!(
        failed.preview.health.status(),
        PreviewHealthState::Terminal(FirstPreviewError::LegacyPng(_))
    ));

    let retry = service
        .attach_sync_with_sink(
            None,
            sink.clone(),
            &launcher,
            provider.clone(),
            legacy.clone(),
            "Pixel_8_API_35".to_string(),
            60,
            1.0,
            Some(PreviewTransport::LegacyPng),
        )
        .unwrap();
    assert_eq!(retry.generation, 9);
    sink.attach_response(retry.generation);
    legacy.loop_probe.wait_for(1);
    let replacement = service.current_session().unwrap();
    assert!(Arc::ptr_eq(&process, &replacement.emulator_process));
    assert_eq!(
        replacement.preview.health.status(),
        PreviewHealthState::AdbActive
    );
    assert_order_before(
        &sink.order(),
        "preview-state:9:adbFallback:60:true:none",
        "png:9",
    );
    assert_order_before(&sink.order(), "png:9", "attach-response:9");
    assert!(launcher.calls.lock().unwrap().is_empty());
    assert!(provider.calls().is_empty());
    assert_eq!(legacy.loop_probe.count(), 1);
    assert_eq!(
        runner
            .commands
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, args)| args.windows(2).any(|pair| pair == ["emu", "kill"]))
            .count(),
        0,
    );
    service.stop_preview_workers(&replacement);
}

#[test]
fn saturated_generation_fails_before_stopping_current_preview() {
    let root = tempfile::tempdir().unwrap();
    let launcher = RecordingEmulatorLauncher::default();
    let sink = Arc::new(OrderedAttachSink::default());
    let provider = Arc::new(RecordingPreviewFactoryProvider::new(GrpcError::Unavailable));
    let legacy = Arc::new(RecordingLegacyPreviewBackendFactory::new(sink.order_arc()));
    let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    service
        .next_generation
        .store(MAX_SAFE_GENERATION, Ordering::Release);
    let current = test_android_session_for_mode(
        AndroidEmulatorOwnership::External,
        PreviewMode::Vaf1,
        MAX_SAFE_GENERATION,
        None,
    );
    service.state.lock().unwrap().session = Some(current.clone());
    assert!(service
        .attach_sync_with_sink(
            None,
            sink,
            &launcher,
            provider,
            legacy,
            "Pixel_8_API_35".to_string(),
            60,
            1.0,
            Some(PreviewTransport::LegacyPng),
        )
        .is_err());
    assert!(Arc::ptr_eq(&current, &service.current_session().unwrap()));
    assert!(!current.stop.load(Ordering::Acquire));
    assert_eq!(
        current.preview.slot.current_generation(),
        MAX_SAFE_GENERATION
    );
}

#[test]
fn first_preview_gate_failure_emits_terminal_preview_state_before_attach_error() {
    let root = tempfile::tempdir().unwrap();
    let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    let sink = Arc::new(OrderedAttachSink::default());
    let provider = Arc::new(OneFramePreviewFactoryProvider::new(rgb_image(2, 3)));
    let legacy = Arc::new(RecordingLegacyPreviewBackendFactory::new(sink.order_arc()));
    let session = test_android_session_for_mode(
        AndroidEmulatorOwnership::Verboo,
        PreviewMode::Vaf1,
        7,
        Some(4242),
    );
    *session.stream_fps.lock().unwrap() = 60;
    seed_session_seq_last_for_test(u32::MAX);
    sink.lifecycle(AndroidEmulatorStartupStage::GeneratingFirstPreview);
    let (control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
        visible: true,
        stop: false,
    });
    session.preview.install_control(control_tx).unwrap();
    run_preview_coordinator(
        service.runner.clone(),
        session.clone(),
        control_rx,
        provider,
        legacy,
        sink.clone(),
    );
    assert_eq!(
        session.first_preview.status(),
        FirstPreviewState::Failed(FirstPreviewError::SequenceExhausted)
    );
    assert!(finish_started_preview(sink.as_ref(), &session, PreviewStart::Coordinator).is_err());

    let order = sink.order();
    let terminal = "preview-state:7:adbFallback:60:true:unavailable";
    assert!(
        order.iter().any(|entry| entry == terminal),
        "fail-closed preview-state missing: {order:?}"
    );
    assert!(
        !sink.errors().is_empty(),
        "attach error missing: {order:?}"
    );
    assert_order_before(&order, terminal, "error");
    assert_order_before(&order, "preview-state:7:grpc", terminal);
    assert!(!order.iter().any(|entry| entry == "lifecycle:ready"));
}

#[test]
fn fallback_png_failure_and_cancel_are_the_only_initial_terminal_errors() {
    let root = tempfile::tempdir().unwrap();
    let runner = Arc::new(ExternalAttachRunner::default());
    let launcher = RecordingEmulatorLauncher::default();
    let sink = Arc::new(OrderedAttachSink::default());
    let provider = Arc::new(RecordingPreviewFactoryProvider::new(GrpcError::Unavailable));
    let legacy = Arc::new(RecordingLegacyPreviewBackendFactory::new(sink.order_arc()));
    legacy.fail_first_png("adb screencap failed");
    let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    service.runner = runner;
    assert!(service
        .attach_sync_with_sink(
            None,
            sink.clone(),
            &launcher,
            provider,
            legacy.clone(),
            "Pixel_8_API_35".to_string(),
            60,
            1.0,
            Some(PreviewTransport::Vaf1),
        )
        .is_err());
    assert_eq!(sink.errors().len(), 1);
    assert_eq!(legacy.loop_probe.count(), 0);
    assert!(sink
        .order()
        .iter()
        .any(|entry| entry == "preview-state:1:adbFallback:60:true:unavailable"));
    assert!(!sink.order().iter().any(|entry| entry == "lifecycle:ready"));

    let cancelled_sink = Arc::new(OrderedAttachSink::default());
    let cancelled_session = test_android_session_for_mode(
        AndroidEmulatorOwnership::External,
        PreviewMode::Vaf1,
        9,
        None,
    );
    cancelled_session
        .first_preview
        .fail(FirstPreviewError::Cancelled);
    assert!(finish_started_preview(
        cancelled_sink.as_ref(),
        &cancelled_session,
        PreviewStart::Coordinator,
    )
    .is_err());
    assert_eq!(cancelled_sink.errors().len(), 1);
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
    let worker = thread::spawn({
        let runner = runner.clone();
        let sink = sink.clone();
        let session = session.clone();
        move || run_android_frame_loop(runner, sink, session, PreviewMode::LegacyPrimary)
    });

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
