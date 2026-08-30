fn preview_failed_must_not_look_like_debug(message: &str) {
    assert!(
        !message.contains("LegacyPng(") && !message.contains("SequenceExhausted"),
        "preview error must not serialize Debug of FirstPreviewError: {message}"
    );
    assert!(
        message.contains("Android emulator preview failed"),
        "preview error message must stay present for renderer fallback: {message}"
    );
}

#[test]
fn session_ended_channel_is_the_frozen_literal() {
    assert_eq!(SESSION_ENDED_EVENT, "android-emulator:session-ended");
}

#[test]
fn android_emulator_error_omits_code_when_absent_and_serializes_preview_reason() {
    let bare = serde_json::to_value(AndroidEmulatorError::from_message("x")).unwrap();
    assert_eq!(bare["message"], "x");
    assert!(bare.get("code").is_none());

    let typed = serde_json::to_value(AndroidEmulatorError::with_code(
        "x",
        PreviewReason::Unavailable,
    ))
    .unwrap();
    assert_eq!(typed["code"], "unavailable");

    let ended = serde_json::to_value(AndroidEmulatorSessionEnded {
        generation: 7,
        code: Some(PreviewReason::DeviceLost),
    })
    .unwrap();
    assert_eq!(ended["generation"], 7);
    assert_eq!(ended["code"], "deviceLost");
}

#[test]
fn fail_first_or_emit_terminal_emits_preview_reason_code_not_debug() {
    let sink = OrderedAttachSink::default();
    let session = test_android_session_for_mode(
        AndroidEmulatorOwnership::External,
        PreviewMode::Vaf1,
        7,
        None,
    );
    session.first_preview.fail(FirstPreviewError::Unavailable);
    fail_first_or_emit_terminal(
        &sink,
        &session,
        FirstPreviewError::LegacyPng(
            "adb screencap failed: error: device 'emulator-5554' not found".to_string(),
        ),
    );
    let payload = &sink.error_payloads()[0];
    assert_eq!(payload.code, Some(PreviewReason::Unavailable));
    preview_failed_must_not_look_like_debug(&payload.message);
}

#[test]
fn finish_started_preview_emits_preview_reason_code_not_debug() {
    let sink = OrderedAttachSink::default();
    let session = test_android_session_for_mode(
        AndroidEmulatorOwnership::Verboo,
        PreviewMode::Vaf1,
        7,
        Some(4242),
    );
    session
        .first_preview
        .fail(FirstPreviewError::SequenceExhausted);
    assert!(finish_started_preview(&sink, &session, PreviewStart::Coordinator).is_err());
    let payload = &sink.error_payloads()[0];
    assert_eq!(payload.code, Some(PreviewReason::Unavailable));
    preview_failed_must_not_look_like_debug(&payload.message);
}

#[test]
fn attach_preview_failure_returns_display_and_emits_code() {
    let root = tempfile::tempdir().unwrap();
    let runner = Arc::new(ExternalAttachRunner::default());
    let launcher = RecordingEmulatorLauncher::default();
    let sink = Arc::new(OrderedAttachSink::default());
    let provider = Arc::new(RecordingPreviewFactoryProvider::new(GrpcError::Unavailable));
    let legacy = Arc::new(RecordingLegacyPreviewBackendFactory::new(sink.order_arc()));
    legacy.fail_first_png("adb screencap failed: error: device 'emulator-5554' not found");
    let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    service.runner = runner;
    let err = service
        .attach_sync_with_sink(
            None,
            sink.clone(),
            &launcher,
            provider,
            legacy,
            "Pixel_8_API_35".to_string(),
            60,
            1.0,
            Some(PreviewTransport::Vaf1),
        )
        .unwrap_err();
    preview_failed_must_not_look_like_debug(&err);
    let payload = &sink.error_payloads()[0];
    assert_eq!(payload.code, Some(PreviewReason::Unavailable));
    preview_failed_must_not_look_like_debug(&payload.message);
}

fn gone_screencap_output() -> CommandOutput {
    CommandOutput {
        success: false,
        stdout: Vec::new(),
        stderr: b"error: device 'emulator-5554' not found\n".to_vec(),
    }
}

struct ScriptedScreencapRunner {
    results: Mutex<VecDeque<CommandOutput>>,
}

impl ScriptedScreencapRunner {
    fn new(results: Vec<CommandOutput>) -> Self {
        Self {
            results: Mutex::new(VecDeque::from(results)),
        }
    }
}

impl CommandRunner for ScriptedScreencapRunner {
    fn run(&self, _program: &str, _args: &[String]) -> Result<CommandOutput, String> {
        Ok(png_output())
    }

    fn run_interruptible(
        &self,
        _program: &str,
        args: &[String],
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> Result<CommandOutput, String> {
        if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
            return Err("cancelled".to_string());
        }
        if args.iter().any(|arg| arg == "screencap") {
            return Ok(self
                .results
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(png_output));
        }
        Ok(png_output())
    }
}

#[test]
fn device_gone_detector_matches_not_found_and_offline_only() {
    assert!(is_device_gone_screencap(
        "adb screencap failed: error: device 'emulator-5554' not found"
    ));
    assert!(is_device_gone_screencap(
        "adb screencap failed: error: device offline"
    ));
    assert!(!is_device_gone_screencap(
        "adb screencap failed: protocol fault"
    ));
}

#[test]
fn one_transient_screencap_gone_does_not_tear_down_or_end_session() {
    let runner: Arc<dyn CommandRunner> = Arc::new(ScriptedScreencapRunner::new(vec![
        gone_screencap_output(),
        png_output(),
    ]));
    let sink = Arc::new(OrderedAttachSink::default());
    let session = test_android_session_for_mode(
        AndroidEmulatorOwnership::External,
        PreviewMode::LegacyFallback,
        3,
        None,
    );
    *session.fallback_fps.lock().unwrap() = 100.0;
    let root = tempfile::tempdir().unwrap();
    let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    service.state.lock().unwrap().session = Some(session.clone());
    let lost = Arc::new(AtomicUsize::new(0));
    let worker = thread::spawn({
        let runner = runner.clone();
        let sink = sink.clone();
        let session = session.clone();
        let lost = lost.clone();
        move || {
            run_android_frame_loop(
                runner,
                sink,
                session,
                PreviewMode::LegacyFallback,
                Some(Arc::new(move |_| {
                    lost.fetch_add(1, Ordering::AcqRel);
                })),
            );
        }
    });
    let deadline = Instant::now() + Duration::from_millis(800);
    while sink.frames().is_empty() && Instant::now() < deadline {
        thread::yield_now();
    }
    assert!(
        !sink.frames().is_empty(),
        "one gone screencap must recover and publish a frame"
    );
    assert_eq!(lost.load(Ordering::Acquire), 0);
    assert!(service.current_session_option().is_some());
    assert!(sink.session_ended_events().is_empty());
    session.gate.stop_and_wake(&session.stop);
    worker.join().unwrap();
}

#[test]
fn consecutive_gone_screencaps_tear_down_and_emit_session_ended() {
    assert_eq!(DEVICE_GONE_CONSECUTIVE_FAILURES, 3);
    let mut outputs = Vec::new();
    for _ in 0..DEVICE_GONE_CONSECUTIVE_FAILURES {
        outputs.push(gone_screencap_output());
    }
    let runner: Arc<dyn CommandRunner> = Arc::new(ScriptedScreencapRunner::new(outputs));
    let sink = Arc::new(OrderedAttachSink::default());
    let session = test_android_session_for_mode(
        AndroidEmulatorOwnership::External,
        PreviewMode::LegacyFallback,
        11,
        None,
    );
    *session.fallback_fps.lock().unwrap() = 100.0;
    session.first_preview.ready();
    let root = tempfile::tempdir().unwrap();
    let service = Arc::new(AndroidEmulatorService::new(root.path().to_path_buf()).unwrap());
    service.state.lock().unwrap().session = Some(session.clone());
    let lost_generation = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let worker = thread::spawn({
        let runner = runner.clone();
        let sink = sink.clone();
        let session = session.clone();
        let lost_generation = lost_generation.clone();
        move || {
            run_android_frame_loop(
                runner,
                sink,
                session,
                PreviewMode::LegacyFallback,
                Some(Arc::new(move |generation| {
                    lost_generation.store(generation, Ordering::Release);
                })),
            );
        }
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    while lost_generation.load(Ordering::Acquire) == 0 && Instant::now() < deadline {
        thread::yield_now();
    }
    session.gate.stop_and_wake(&session.stop);
    worker.join().unwrap();
    assert_eq!(lost_generation.load(Ordering::Acquire), 11);
    let error = &sink.error_payloads()[0];
    assert_eq!(error.code, Some(PreviewReason::DeviceLost));
    service.teardown_lost_device(11, sink.as_ref());
    assert!(
        sink.order()
            .iter()
            .any(|entry| entry == "android-emulator:session-ended"),
        "fake sink must observe the frozen channel name: {:?}",
        sink.order()
    );
    let ended = sink.session_ended_events();
    assert_eq!(ended.len(), 1, "session-ended must fire once after cleanup");
    assert_eq!(ended[0].generation, 11);
    assert_eq!(ended[0].code, Some(PreviewReason::DeviceLost));
    assert!(
        service.current_session_option().is_none(),
        "ledger/session must be clean after device-death teardown"
    );
}

#[test]
fn device_death_teardown_does_not_publish_over_in_flight_reattach() {
    let root = tempfile::tempdir().unwrap();
    let service = Arc::new(AndroidEmulatorService::new(root.path().to_path_buf()).unwrap());
    let current = test_android_session_for_mode(
        AndroidEmulatorOwnership::External,
        PreviewMode::Vaf1,
        4,
        None,
    );
    service.state.lock().unwrap().session = Some(current.clone());
    let (paused, release) = service.session_cancel.pause_after_reset_for_test();
    let sink = Arc::new(OrderedAttachSink::default());
    let provider = Arc::new(RecordingPreviewFactoryProvider::new(GrpcError::Unavailable));
    let legacy = Arc::new(RecordingLegacyPreviewBackendFactory::new(sink.order_arc()));
    let attach_service = service.clone();
    let attach_sink = sink.clone();
    let attach = thread::spawn(move || {
        attach_service.attach_sync_with_sink(
            None,
            attach_sink,
            &RecordingEmulatorLauncher::default(),
            provider,
            legacy,
            "Pixel_8_API_35".to_string(),
            60,
            1.0,
            Some(PreviewTransport::Vaf1),
        )
    });
    paused.recv().unwrap();
    // Same absorbing cancel as detach/end, issued while attach holds the
    // operation lock at pause_after_reset — do not join workers from a
    // sidecar that also waits on that lock before attach is released.
    service.request_session_cancel();
    release.send(()).unwrap();
    let attach_result = attach.join().unwrap();
    assert_eq!(
        attach_result.unwrap_err(),
        "Android emulator attach was cancelled"
    );
    let teardown_sink = OrderedAttachSink::default();
    service.teardown_lost_device(4, &teardown_sink);
    assert!(
        service.current_session_option().is_none(),
        "dying session must be taken; in-flight re-attach must not publish"
    );
    assert!(
        teardown_sink
            .order()
            .iter()
            .any(|entry| entry == "android-emulator:session-ended"),
        "fake sink must observe the frozen channel name after cleanup: {:?}",
        teardown_sink.order()
    );
    assert_eq!(teardown_sink.session_ended_events().len(), 1);
    assert_eq!(teardown_sink.session_ended_events()[0].generation, 4);
    assert_eq!(
        teardown_sink.session_ended_events()[0].code,
        Some(PreviewReason::DeviceLost)
    );
}

#[test]
fn device_death_teardown_does_not_kill_completed_reattach() {
    let root = tempfile::tempdir().unwrap();
    let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    service.runner = Arc::new(ExternalAttachRunner::default());
    service.next_generation.store(4, Ordering::Release);
    let service = Arc::new(service);
    let dying = test_android_session_for_mode(
        AndroidEmulatorOwnership::External,
        PreviewMode::Vaf1,
        4,
        None,
    );
    service.state.lock().unwrap().session = Some(dying);
    let (paused, release) = service
        .session_cancel
        .pause_after_lost_generation_check_for_test();
    let teardown_sink = Arc::new(OrderedAttachSink::default());
    let teardown_service = service.clone();
    let teardown = thread::spawn({
        let teardown_sink = teardown_sink.clone();
        move || teardown_service.teardown_lost_device(4, teardown_sink.as_ref())
    });
    paused.recv().unwrap();

    let attach_sink = Arc::new(OrderedAttachSink::default());
    let attached = service
        .attach_sync_with_sink(
            None,
            attach_sink,
            &RecordingEmulatorLauncher::default(),
            Arc::new(RecordingPreviewFactoryProvider::new(GrpcError::Unavailable)),
            Arc::new(RecordingLegacyPreviewBackendFactory::new(Arc::new(
                Mutex::new(Vec::new()),
            ))),
            "Pixel_8_API_35".to_string(),
            60,
            1.0,
            Some(PreviewTransport::Vaf1),
        )
        .expect("re-attach must complete while dying teardown is paused");
    assert_eq!(attached.generation, 5);
    let live = service
        .current_session_option()
        .expect("completed re-attach must publish a session");
    assert_eq!(live.generation, 5);

    release.send(()).unwrap();
    teardown.join().unwrap();

    let still = service
        .current_session_option()
        .expect("completed re-attach must stay intact after delayed teardown");
    assert_eq!(still.generation, 5);
    assert!(
        teardown_sink.session_ended_events().is_empty(),
        "stale teardown must abort silently with no session-ended: {:?}",
        teardown_sink.session_ended_events()
    );
    service.stop_preview_workers(&still);
}
