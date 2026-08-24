struct FailingPreviewStateSink;

impl PreviewEventSink for FailingPreviewStateSink {
    fn frame_ready(&self, _event: FrameReady) -> Result<(), String> {
        Ok(())
    }

    fn preview_state(&self, _state: PreviewState) -> Result<(), String> {
        Err("state sink".to_string())
    }
}

impl AndroidFrameSink for FailingPreviewStateSink {
    fn frame(&self, _frame: AndroidEmulatorFrame) -> Result<(), String> {
        Ok(())
    }

    fn error(&self, _message: String) {}

    fn lifecycle(&self, _stage: AndroidEmulatorStartupStage) {}
}

struct FailingFrameReadySink;

impl PreviewEventSink for FailingFrameReadySink {
    fn frame_ready(&self, _event: FrameReady) -> Result<(), String> {
        Err("frame sink".to_string())
    }

    fn preview_state(&self, _state: PreviewState) -> Result<(), String> {
        Ok(())
    }
}

impl AndroidFrameSink for FailingFrameReadySink {
    fn frame(&self, _frame: AndroidEmulatorFrame) -> Result<(), String> {
        Ok(())
    }

    fn error(&self, _message: String) {}

    fn lifecycle(&self, _stage: AndroidEmulatorStartupStage) {}
}

fn owned_vaf1_session(generation: u64) -> Arc<AndroidSession> {
    let session = test_android_session_for_mode(
        AndroidEmulatorOwnership::Verboo,
        PreviewMode::Vaf1,
        generation,
        Some(4242),
    );
    *session.stream_fps.lock().unwrap() = 60;
    session
}

fn run_owned_vaf1_coordinator(
    service: &AndroidEmulatorService,
    session: &Arc<AndroidSession>,
    sink: Arc<dyn AndroidFrameSink>,
    provider: Arc<dyn PreviewFactoryProvider>,
) -> Arc<RecordingLegacyPreviewBackendFactory> {
    let legacy = Arc::new(RecordingLegacyPreviewBackendFactory::new(Arc::new(
        Mutex::new(Vec::new()),
    )));
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
        legacy.clone(),
        sink,
    );
    legacy
}

fn publish_residual_frame(session: &AndroidSession) {
    let payload = [1, 2, 3];
    session.preview.slot.publish(
        1,
        ValidatedRgbFrame {
            width: 1,
            height: 1,
            timestamp_us: 9,
            payload: &payload,
        },
    );
}

#[test]
fn read_frame_is_unavailable_after_sequence_exhausted_without_residual_frame() {
    let root = tempfile::tempdir().unwrap();
    let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    let session = owned_vaf1_session(7);
    publish_residual_frame(&session);
    seed_session_seq_last_for_test(u32::MAX);

    let legacy = run_owned_vaf1_coordinator(
        &service,
        &session,
        Arc::new(RecordingAttachSink),
        Arc::new(OneFramePreviewFactoryProvider::new(rgb_image(2, 3))),
    );
    service.state.lock().unwrap().session = Some(session.clone());

    assert_eq!(
        session.first_preview.status(),
        FirstPreviewState::Failed(FirstPreviewError::SequenceExhausted)
    );
    assert_eq!(legacy.loop_probe.count(), 0);
    assert_eq!(
        service.read_frame_sync(7),
        Err(PreviewReadError::Unavailable)
    );
}

#[test]
fn read_frame_is_unavailable_after_worker_outcome_failed() {
    let root = tempfile::tempdir().unwrap();
    let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    let session = owned_vaf1_session(7);
    let legacy = run_owned_vaf1_coordinator(
        &service,
        &session,
        Arc::new(FailingPreviewStateSink),
        Arc::new(OneFramePreviewFactoryProvider::new(rgb_image(2, 3))),
    );
    service.state.lock().unwrap().session = Some(session.clone());

    assert_eq!(
        session.first_preview.status(),
        FirstPreviewState::Failed(FirstPreviewError::Event("state sink".to_owned()))
    );
    assert_eq!(legacy.loop_probe.count(), 0);
    assert_eq!(
        service.read_frame_sync(7),
        Err(PreviewReadError::Unavailable)
    );
}

#[test]
fn read_frame_is_unavailable_after_frame_ready_sink_failure() {
    let root = tempfile::tempdir().unwrap();
    let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    let session = owned_vaf1_session(7);
    let legacy = run_owned_vaf1_coordinator(
        &service,
        &session,
        Arc::new(FailingFrameReadySink),
        Arc::new(OneFramePreviewFactoryProvider::new(rgb_image(2, 3))),
    );
    service.state.lock().unwrap().session = Some(session.clone());

    assert_eq!(
        session.first_preview.status(),
        FirstPreviewState::Failed(FirstPreviewError::Event("frame sink".to_owned()))
    );
    assert_eq!(legacy.loop_probe.count(), 0);
    assert_eq!(
        service.read_frame_sync(7),
        Err(PreviewReadError::Unavailable)
    );
}

#[test]
fn read_frame_maps_empty_slot_and_availability_without_coordinator() {
    // State-mapping only: documents how read_frame_sync matches availability.
    // Concurrent linearization is proved by
    // read_frame_sees_no_frame_during_real_failed_overlap_then_unavailable.
    let root = tempfile::tempdir().unwrap();
    let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    let session = owned_vaf1_session(7);
    session
        .preview
        .health
        .terminal(FirstPreviewError::SequenceExhausted);
    session
        .first_preview
        .fail(FirstPreviewError::SequenceExhausted);
    service.state.lock().unwrap().session = Some(session.clone());

    assert_eq!(service.read_frame_sync(7), Err(PreviewReadError::NoFrame));

    *session.preview.availability.lock().unwrap() = PreviewAvailability::Unavailable;
    assert_eq!(
        service.read_frame_sync(7),
        Err(PreviewReadError::Unavailable)
    );
}

#[test]
fn read_frame_sees_no_frame_during_real_failed_overlap_then_unavailable() {
    let root = tempfile::tempdir().unwrap();
    let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    let session = owned_vaf1_session(7);
    let (paused, release) = session
        .preview
        .pause_before_failed_availability_for_test();
    let coord_service = service.clone();
    let coord_session = session.clone();
    let coordinator = std::thread::spawn(move || {
        run_owned_vaf1_coordinator(
            &coord_service,
            &coord_session,
            Arc::new(FailingPreviewStateSink),
            Arc::new(OneFramePreviewFactoryProvider::new(rgb_image(2, 3))),
        )
    });
    paused.recv().unwrap();
    service.state.lock().unwrap().session = Some(session.clone());
    assert_eq!(
        session.first_preview.status(),
        FirstPreviewState::Failed(FirstPreviewError::Event("state sink".to_owned()))
    );
    assert_eq!(service.read_frame_sync(7), Err(PreviewReadError::NoFrame));
    release.send(()).unwrap();
    coordinator.join().unwrap();
    assert_eq!(
        service.read_frame_sync(7),
        Err(PreviewReadError::Unavailable)
    );
}

struct PausingUnsupportedProvider {
    entered: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    release: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
}

impl PreviewFactoryProvider for PausingUnsupportedProvider {
    fn for_owned_pid(
        &self,
        _pid: u32,
        _avd_name: &str,
    ) -> Result<Arc<dyn ScreenshotStreamFactory>, GrpcError> {
        if let Some(entered) = self.entered.lock().unwrap().take() {
            entered.send(()).unwrap();
        }
        if let Some(release) = self.release.lock().unwrap().take() {
            release.recv().unwrap();
        }
        Err(GrpcError::Unsupported)
    }
}

fn wait_for_read_frame(
    service: &AndroidEmulatorService,
    generation: u64,
    expected: PreviewReadError,
) {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let got = service.read_frame_sync(generation);
        if got == Err(expected) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {expected:?}, last={got:?}"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn read_frame_is_unavailable_after_cancelled_session_stays_published() {
    let root = tempfile::tempdir().unwrap();
    let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    let session = owned_vaf1_session(7);
    service.state.lock().unwrap().session = Some(session.clone());
    service.stop_preview_workers(&session);

    assert_eq!(
        service.read_frame_sync(7),
        Err(PreviewReadError::Unavailable)
    );
}

#[test]
fn cancelled_session_absorbs_inflight_unsupported_fallback() {
    let root = tempfile::tempdir().unwrap();
    let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    let session = owned_vaf1_session(7);
    let sink = Arc::new(OrderedAttachSink::default());
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let provider = Arc::new(PausingUnsupportedProvider {
        entered: Mutex::new(Some(entered_tx)),
        release: Mutex::new(Some(release_rx)),
    });
    let legacy = Arc::new(RecordingLegacyPreviewBackendFactory::new(sink.order_arc()));
    let start = start_preview_for_session(
        service.runner.clone(),
        session.clone(),
        sink.clone(),
        provider,
        legacy.clone(),
    );
    assert!(matches!(start, PreviewStart::Coordinator));
    entered_rx.recv().unwrap();

    service.state.lock().unwrap().session = Some(session.clone());
    let stop_service = service.clone();
    let stop_session = session.clone();
    let stop = std::thread::spawn(move || {
        stop_service.stop_preview_workers(&stop_session);
    });

    wait_for_read_frame(&service, 7, PreviewReadError::Unavailable);
    assert_eq!(
        service.read_frame_sync(7),
        Err(PreviewReadError::Unavailable)
    );
    assert!(
        sink.order()
            .iter()
            .all(|entry| !entry.contains("adbFallback") && !entry.contains("unsupported")),
        "no fallback event before release: {:?}",
        sink.order()
    );

    release_tx.send(()).unwrap();
    stop.join().unwrap();

    assert_eq!(
        service.read_frame_sync(7),
        Err(PreviewReadError::Unavailable)
    );
    assert_eq!(legacy.loop_probe.count(), 0);
    assert!(
        sink.order()
            .iter()
            .all(|entry| !entry.contains("adbFallback") && !entry.contains("unsupported")),
        "no fallback event after cancel: {:?}",
        sink.order()
    );
}

#[test]
fn read_frame_is_strict_before_empty_and_maps_transport_availability() {
    let root = tempfile::tempdir().unwrap();
    let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    assert_eq!(
        service.read_frame_sync(1),
        Err(PreviewReadError::Unavailable)
    );

    let session = test_android_session_for_mode(
        AndroidEmulatorOwnership::External,
        PreviewMode::Vaf1,
        7,
        None,
    );
    service.state.lock().unwrap().session = Some(session.clone());
    assert_eq!(
        service.read_frame_sync(8),
        Err(PreviewReadError::StaleGeneration {
            current_generation: 7,
        })
    );
    assert_eq!(service.read_frame_sync(7), Err(PreviewReadError::NoFrame));

    *session.preview.availability.lock().unwrap() = PreviewAvailability::Unauthenticated;
    assert_eq!(
        service.read_frame_sync(7),
        Err(PreviewReadError::Unauthenticated)
    );
    *session.preview.availability.lock().unwrap() = PreviewAvailability::Unsupported;
    assert_eq!(
        service.read_frame_sync(7),
        Err(PreviewReadError::Unsupported)
    );
}

#[test]
fn read_frame_moves_exact_vaf1_bytes_and_legacy_mode_is_unsupported() {
    let root = tempfile::tempdir().unwrap();
    let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    let session = test_android_session_for_mode(
        AndroidEmulatorOwnership::External,
        PreviewMode::Vaf1,
        7,
        None,
    );
    let payload = [1, 2, 3];
    session.preview.slot.publish(
        1,
        ValidatedRgbFrame {
            width: 1,
            height: 1,
            timestamp_us: 9,
            payload: &payload,
        },
    );
    service.state.lock().unwrap().session = Some(session);
    let bytes = service.read_frame_sync(7).unwrap();
    assert_eq!(&bytes[0..4], b"VAF1");
    assert_eq!(bytes.len(), 39);
    assert_eq!(&bytes[36..39], &payload);
    assert_eq!(service.read_frame_sync(7), Err(PreviewReadError::NoFrame));

    let legacy = test_android_session_for_mode(
        AndroidEmulatorOwnership::External,
        PreviewMode::LegacyFallback,
        8,
        None,
    );
    service.state.lock().unwrap().session = Some(legacy);
    assert_eq!(
        service.read_frame_sync(7),
        Err(PreviewReadError::StaleGeneration {
            current_generation: 8,
        })
    );
    assert_eq!(
        service.read_frame_sync(8),
        Err(PreviewReadError::Unsupported)
    );
}
