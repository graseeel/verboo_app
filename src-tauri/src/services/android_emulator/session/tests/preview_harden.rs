#[test]
fn request_session_cancel_joins_only_from_service_without_crossing_worker_locks() {
    let root = tempfile::tempdir().unwrap();
    let service = Arc::new(AndroidEmulatorService::new(root.path().to_path_buf()).unwrap());
    let session = test_android_session_for_mode(
        AndroidEmulatorOwnership::External,
        PreviewMode::Vaf1,
        7,
        None,
    );
    session.gate.set_visible(false);
    service.state.lock().unwrap().session = Some(session.clone());
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (checks_tx, checks_rx) = std::sync::mpsc::channel();
    let worker_session = session.clone();
    let worker_service = service.clone();
    let worker = thread::spawn(move || {
        started_tx.send(()).unwrap();
        assert!(!worker_session.gate.wait_until_visible(&worker_session.stop));
        let worker_mutex_available = worker_session.workers.try_lock().is_ok();
        let operation_lock_available = worker_service.operation_lock.try_lock().is_ok();
        checks_tx
            .send((worker_mutex_available, operation_lock_available))
            .unwrap();
    });
    started_rx.recv().unwrap();
    session.workers.lock().unwrap().push(worker);

    service.request_session_cancel();

    assert_eq!(checks_rx.recv().unwrap(), (true, true));
    assert!(session.workers.lock().unwrap().is_empty());
    assert!(matches!(
        session.preview.health.status(),
        PreviewHealthState::Terminal(FirstPreviewError::Cancelled)
    ));
}

#[test]
fn cancel_after_reset_cannot_publish_same_avd_replacement() {
    let root = tempfile::tempdir().unwrap();
    let service = Arc::new(AndroidEmulatorService::new(root.path().to_path_buf()).unwrap());
    let current = test_android_session_for_mode(
        AndroidEmulatorOwnership::Verboo,
        PreviewMode::Vaf1,
        7,
        Some(4242),
    );
    service.state.lock().unwrap().session = Some(current.clone());
    let (paused, release) = service.session_cancel.pause_after_reset_for_test();
    let sink = Arc::new(OrderedAttachSink::default());
    let provider = Arc::new(RecordingPreviewFactoryProvider::new(GrpcError::Unavailable));
    let legacy = Arc::new(RecordingLegacyPreviewBackendFactory::new(sink.order_arc()));
    let attach_service = service.clone();
    let attach_sink = sink.clone();
    let attach_provider = provider.clone();
    let attach_legacy = legacy.clone();
    let attach = thread::spawn(move || {
        attach_service.attach_sync_with_sink(
            None,
            attach_sink,
            &RecordingEmulatorLauncher::default(),
            attach_provider,
            attach_legacy,
            "Pixel_8_API_35".to_string(),
            60,
            1.0,
            Some(PreviewTransport::Vaf1),
        )
    });

    paused.recv().unwrap();
    service.request_session_cancel();
    release.send(()).unwrap();

    assert_eq!(
        attach.join().unwrap().unwrap_err(),
        "Android emulator attach was cancelled"
    );
    assert!(Arc::ptr_eq(&current, &service.current_session().unwrap()));
    assert!(current.stop.load(Ordering::Acquire));
    assert!(sink
        .order()
        .iter()
        .all(|entry| !entry.contains("generatingFirstPreview") && !entry.contains("ready")));
    assert!(current.workers.lock().unwrap().is_empty());
}

#[test]
fn cancel_before_new_session_publish_rolls_back_without_worker_or_ready() {
    let root = tempfile::tempdir().unwrap();
    let runner = Arc::new(ExternalAttachRunner::default());
    let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    service.runner = runner.clone();
    let service = Arc::new(service);
    let (paused, release) = service.session_cancel.pause_before_publish_for_test();
    let sink = Arc::new(OrderedAttachSink::default());
    let provider = Arc::new(RecordingPreviewFactoryProvider::new(GrpcError::Unavailable));
    let legacy = Arc::new(RecordingLegacyPreviewBackendFactory::new(sink.order_arc()));
    let attach_service = service.clone();
    let attach_sink = sink.clone();
    let attach_provider = provider.clone();
    let attach_legacy = legacy.clone();
    let attach = thread::spawn(move || {
        attach_service.attach_sync_with_sink(
            None,
            attach_sink,
            &RecordingEmulatorLauncher::default(),
            attach_provider,
            attach_legacy,
            "Pixel_8_API_35".to_string(),
            60,
            1.0,
            Some(PreviewTransport::Vaf1),
        )
    });

    paused.recv().unwrap();
    service.request_session_cancel();
    release.send(()).unwrap();

    assert_eq!(
        attach.join().unwrap().unwrap_err(),
        "Android emulator attach was cancelled"
    );
    assert!(service.current_session_option().is_none());
    assert!(sink
        .order()
        .iter()
        .all(|entry| !entry.contains("generatingFirstPreview") && !entry.contains("ready")));
    assert!(runner
        .commands
        .lock()
        .unwrap()
        .iter()
        .all(|(_, args)| { !args.iter().any(|arg| arg == "kill") }));
}

#[test]
fn hide_between_control_snapshot_and_install_cannot_start_visible_preview() {
    let root = tempfile::tempdir().unwrap();
    let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    let session = test_android_session_for_mode(
        AndroidEmulatorOwnership::Verboo,
        PreviewMode::Vaf1,
        7,
        Some(4242),
    );
    service.state.lock().unwrap().session = Some(session.clone());
    let (paused, release) = session.preview.pause_before_control_install_for_test();
    let sink = Arc::new(OrderedAttachSink::default());
    let provider = Arc::new(RecordingPreviewFactoryProvider::new(GrpcError::Unavailable));
    let legacy = Arc::new(RecordingLegacyPreviewBackendFactory::new(sink.order_arc()));
    let start_session = session.clone();
    let start_sink = sink.clone();
    let start_provider = provider.clone();
    let start_legacy = legacy.clone();
    let worker = thread::spawn(move || {
        start_preview_for_session(
            Arc::new(ExternalAttachRunner::default()),
            start_session,
            start_sink,
            start_provider,
            start_legacy,
        )
    });

    paused.recv().unwrap();
    service.set_visible_sync(false).unwrap();
    release.send(()).unwrap();
    let start = worker.join().unwrap();
    assert_eq!(
        session.preview.control_for_test().unwrap().visible,
        false,
        "the installed control must observe hide"
    );
    service.stop_preview_workers(&session);

    assert_eq!(session.preview.slot.take(7), Err(PreviewReadError::NoFrame));
    assert!(sink.order().iter().all(|entry| {
        !entry.contains("preview-state")
            && !entry.contains("frame-ready")
            && !entry.contains("png:")
    }));
    drop(start);
}

#[test]
fn different_avd_generation_exhaustion_preserves_current_session_before_stop() {
    let root = tempfile::tempdir().unwrap();
    let runner = Arc::new(ExternalAttachRunner::default());
    let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    service.runner = runner;
    service
        .next_generation
        .store(MAX_SAFE_GENERATION, Ordering::Release);
    let current = test_android_session_for_avd(
        "Pixel_7_API_34",
        AndroidEmulatorOwnership::External,
        PreviewMode::Vaf1,
        MAX_SAFE_GENERATION,
        None,
    );
    let process = current.emulator_process.clone();
    service.state.lock().unwrap().session = Some(current.clone());

    let result = service.attach_sync_with_sink(
        None,
        Arc::new(OrderedAttachSink::default()),
        &RecordingEmulatorLauncher::default(),
        Arc::new(RecordingPreviewFactoryProvider::new(GrpcError::Unavailable)),
        Arc::new(RecordingLegacyPreviewBackendFactory::new(Arc::new(
            Mutex::new(Vec::new()),
        ))),
        "Pixel_8_API_35".to_string(),
        60,
        1.0,
        Some(PreviewTransport::Vaf1),
    );

    assert_eq!(result.unwrap_err(), "Android preview generation exhausted");
    assert!(Arc::ptr_eq(&current, &service.current_session().unwrap()));
    assert!(!current.stop.load(Ordering::Acquire));
    assert!(Arc::ptr_eq(
        &process,
        &service.current_session().unwrap().emulator_process
    ));
}

#[test]
fn owned_running_avd_without_pid_reports_unavailable_not_unsupported() {
    let root = tempfile::tempdir().unwrap();
    let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    service.ownership.mark_booted("Pixel_8_API_35").unwrap();
    let current = test_android_session_for_mode(
        AndroidEmulatorOwnership::Verboo,
        PreviewMode::LegacyFallback,
        7,
        None,
    );
    service.state.lock().unwrap().session = Some(current);
    let sink = Arc::new(OrderedAttachSink::default());
    let legacy = Arc::new(RecordingLegacyPreviewBackendFactory::new(sink.order_arc()));

    service
        .attach_sync_with_sink(
            None,
            sink.clone(),
            &RecordingEmulatorLauncher::default(),
            Arc::new(RecordingPreviewFactoryProvider::new(GrpcError::Unsupported)),
            legacy,
            "Pixel_8_API_35".to_string(),
            60,
            1.0,
            Some(PreviewTransport::Vaf1),
        )
        .unwrap();

    assert!(sink
        .order()
        .iter()
        .any(|entry| entry.ends_with(":unavailable")));
    assert!(sink
        .order()
        .iter()
        .all(|entry| !entry.ends_with(":unsupported")));
    service.request_session_cancel();
}

#[test]
fn stop_preview_workers_cannot_miss_worker_published_at_spawn_edge() {
    let root = tempfile::tempdir().unwrap();
    let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    let session = test_android_session_for_mode(
        AndroidEmulatorOwnership::External,
        PreviewMode::Vaf1,
        7,
        None,
    );
    let (paused, release) = session.preview.pause_before_worker_publish_for_test();
    let release_guard = FirstPngReleaseGuard(Some(release));
    let sink = Arc::new(OrderedAttachSink::default());
    let provider = Arc::new(RecordingPreviewFactoryProvider::new(GrpcError::Unavailable));
    let legacy = Arc::new(RecordingLegacyPreviewBackendFactory::new(sink.order_arc()));
    let start_session = session.clone();
    let start_sink = sink.clone();
    let start_provider = provider.clone();
    let start_legacy = legacy.clone();
    let start_worker = thread::spawn(move || {
        start_preview_for_session(
            Arc::new(ExternalAttachRunner::default()),
            start_session,
            start_sink,
            start_provider,
            start_legacy,
        )
    });

    paused.recv().unwrap();
    assert!(
        session.workers.try_lock().is_err(),
        "worker handle must be published while the workers lock is held"
    );
    drop(release_guard);
    assert!(matches!(
        start_worker.join().unwrap(),
        PreviewStart::Coordinator
    ));

    service.stop_preview_workers(&session);
    assert!(session.workers.lock().unwrap().is_empty());
}

#[test]
fn stop_closes_pending_first_preview_and_joins_worker_at_edge() {
    let root = tempfile::tempdir().unwrap();
    let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    let session = test_android_session_for_mode(
        AndroidEmulatorOwnership::External,
        PreviewMode::Vaf1,
        7,
        None,
    );
    let (started_sender, started_receiver) = std::sync::mpsc::channel();
    let (finished_sender, finished_receiver) = std::sync::mpsc::channel();
    let stop = session.stop.clone();
    let worker = thread::spawn(move || {
        started_sender.send(()).unwrap();
        while !stop.load(Ordering::Acquire) {
            thread::yield_now();
        }
        finished_sender.send(()).unwrap();
    });
    session.workers.lock().unwrap().push(worker);
    started_receiver.recv().unwrap();

    service.stop_preview_workers(&session);

    assert_eq!(
        session.first_preview.status(),
        FirstPreviewState::Failed(FirstPreviewError::Cancelled)
    );
    finished_receiver.recv().unwrap();
    assert!(session.workers.lock().unwrap().is_empty());
}

#[test]
fn cancel_does_not_block_while_legacy_first_png_is_pending() {
    let root = tempfile::tempdir().unwrap();
    let runner = Arc::new(ExternalAttachRunner::default());
    let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    service.runner = runner;
    let service = Arc::new(service);
    let sink = Arc::new(OrderedAttachSink::default());
    let (legacy, entered, release) = BlockingFirstPngFactory::new();
    let attach_service = service.clone();
    let attach_sink = sink.clone();
    let attach_legacy = legacy.clone();
    let attach = thread::spawn(move || {
        attach_service.attach_sync_with_sink(
            None,
            attach_sink,
            &RecordingEmulatorLauncher::default(),
            Arc::new(RecordingPreviewFactoryProvider::new(GrpcError::Unavailable)),
            attach_legacy,
            "Pixel_8_API_35".to_string(),
            60,
            1.0,
            None,
        )
    });

    entered.recv().unwrap();
    if service.session_cancel.transition_is_held() {
        drop(release);
        let _ = attach.join();
        panic!("first PNG must not retain SessionCancellation.transition");
    }
    service.request_session_cancel();
    drop(release);
    assert!(attach.join().unwrap().is_err());
}
