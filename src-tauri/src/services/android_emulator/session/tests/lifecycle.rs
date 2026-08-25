#[test]
fn boot_completion_requires_property_one() {
    assert!(is_boot_completed("1\n"));
    assert!(!is_boot_completed("0\n"));
    assert!(!is_boot_completed("1\n0\n"));
}

#[test]
fn owned_launch_args_request_host_gpu_and_grpc_token() {
    assert_eq!(
        emulator_launch_args("Pixel 8;safe", GpuMode::Host),
        vec![
            "-avd",
            "Pixel 8;safe",
            "-no-window",
            "-no-boot-anim",
            "-no-audio",
            "-no-snapshot-save",
            "-gpu",
            "host",
            "-grpc-use-token",
        ]
    );
    assert_eq!(
        emulator_launch_args("Pixel 8;safe", GpuMode::SwiftshaderIndirect)[6..9],
        ["-gpu", "swiftshader_indirect", "-grpc-use-token"]
    );
}

#[test]
fn external_running_avd_is_reused_without_a_verboo_boot_request() {
    let root = tempfile::tempdir().unwrap();
    let ledger = OwnershipLedger::open(root.path().to_path_buf()).unwrap();

    assert_eq!(
        attach_ownership(&ledger, "Pixel 8;safe", Some("emulator-5554")),
        (AndroidEmulatorOwnership::External, false),
    );
}

#[test]
fn external_attach_reuses_existing_serial_without_spawning_or_claiming_avd() {
    let root = tempfile::tempdir().unwrap();
    let runner = Arc::new(ExternalAttachRunner::default());
    let launcher = RecordingEmulatorLauncher::default();
    let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    service.runner = runner.clone();

    let session = service
        .attach_sync_with_sink(
            None,
            Arc::new(RecordingAttachSink),
            &launcher,
            Arc::new(SystemPreviewFactoryProvider),
            Arc::new(SystemLegacyPreviewBackendFactory::default()),
            "Pixel_8_API_35".to_string(),
            2,
            1.0,
            None,
        )
        .unwrap();
    service.detach_sync().unwrap();

    assert_eq!(session.serial, "emulator-5554");
    assert_eq!(session.ownership, AndroidEmulatorOwnership::External);
    assert_eq!(
        service.ownership.phase("Pixel_8_API_35"),
        None,
        "attaching an external AVD must not mark a Verboo boot request"
    );
    assert!(
        launcher.calls.lock().unwrap().is_empty(),
        "an already-running external AVD must never be spawned by Verboo"
    );

    let commands = runner.commands.lock().unwrap();
    assert!(!commands.iter().any(|(_, args)| {
        args.iter().any(|arg| {
            matches!(
                arg.as_str(),
                "-no-window" | "-no-boot-anim" | "-no-audio" | "-avd"
            )
        })
    }));
    assert!(!commands.iter().any(|(_, args)| {
        args.ends_with(&[
            "shell".to_string(),
            "dumpsys".to_string(),
            "SurfaceFlinger".to_string(),
        ])
    }));
}

#[test]
fn absent_running_avd_requests_a_verboo_headless_boot() {
    let root = tempfile::tempdir().unwrap();
    let ledger = OwnershipLedger::open(root.path().to_path_buf()).unwrap();

    assert_eq!(
        attach_ownership(&ledger, "Pixel 8;safe", None),
        (AndroidEmulatorOwnership::Verboo, true),
    );
    assert!(emulator_launch_args("Pixel 8;safe", GpuMode::Host).contains(&"-no-window".to_string()));
}

#[test]
fn preboot_failure_retries_once_and_recreates_ledger() {
    let ledger = Arc::new(RecordingBootLedger::default());
    let attempts = ScriptedOwnedBootAttempts::new(vec![
        Err(OwnedBootAttemptError::Failed(
            "host preboot exit".to_string(),
        )),
        Ok(fake_owned_boot(2222, GpuMode::SwiftshaderIndirect)),
    ]);
    let cancel = SessionCancellation::default();
    let result =
        boot_owned_with_attempts(ledger.as_ref(), &attempts, "Pixel_8_API_35", &cancel).unwrap();
    assert_eq!(result.pid, 2222);
    assert!(result.gpu_software);
    assert_eq!(
        attempts.gpus(),
        vec![GpuMode::Host, GpuMode::SwiftshaderIndirect]
    );
    assert_eq!(
        ledger.calls(),
        vec![
            "mark_boot_requested",
            "remove",
            "mark_boot_requested",
            "mark_booted",
        ]
    );
}

#[test]
fn boot_owned_cancels_materialized_success_before_mark_booted() {
    let ledger = RecordingBootLedger::default();
    let attempts = ScriptedOwnedBootAttempts::new(vec![Ok(fake_owned_boot(2222, GpuMode::Host))]);
    attempts.cancel_before_success();
    let cancel = SessionCancellation::default();

    assert!(matches!(
        boot_owned_with_attempts(&ledger, &attempts, "Pixel_8_API_35", &cancel,),
        Err(OwnedBootError::Cancelled)
    ));
    assert_eq!(attempts.terminates(), 1);
    assert_eq!(ledger.calls(), vec!["mark_boot_requested", "remove"]);
}

#[test]
fn boot_owned_does_not_start_swiftshader_after_host_failure_cancel() {
    let cancel = Arc::new(SessionCancellation::default());
    let ledger = RecordingBootLedger::default();
    ledger.cancel_on_second_mark_boot_requested(cancel.clone());
    let attempts = ScriptedOwnedBootAttempts::new(vec![
        Err(OwnedBootAttemptError::Failed("host failed".to_string())),
        Ok(fake_owned_boot(2222, GpuMode::SwiftshaderIndirect)),
    ]);

    assert!(matches!(
        boot_owned_with_attempts(&ledger, &attempts, "Pixel_8_API_35", cancel.as_ref(),),
        Err(OwnedBootError::Cancelled)
    ));
    assert_eq!(attempts.gpus(), vec![GpuMode::Host]);
    assert_eq!(
        ledger.calls(),
        vec![
            "mark_boot_requested",
            "remove",
            "mark_boot_requested",
            "remove",
        ]
    );
}

#[test]
fn system_owned_attempt_rejects_cancel_before_spawn() {
    let runner = Arc::new(RecordingRunner::default());
    let launcher = NoSpawnLauncher::default();
    let attempts = SystemOwnedBootAttempts::new(
        runner,
        &launcher,
        PathBuf::from("emulator"),
        "adb".to_string(),
    );
    let cancel = SessionCancellation::default();
    cancel.cancel();

    assert!(matches!(
        attempts.attempt("Pixel_8_API_35", GpuMode::Host, &cancel),
        Err(OwnedBootAttemptError::Cancelled)
    ));
    assert_eq!(launcher.spawn_calls(), 0);
}

#[test]
fn session_cancellation_owns_cancel_and_short_action_gate() {
    let cancel = SessionCancellation::default();
    assert!(!cancel.is_cancelled());

    assert_eq!(
        cancel.run_if_active(|| cancel.transition_is_held()),
        Some(true)
    );

    cancel.cancel();
    assert!(cancel.is_cancelled());
    assert_eq!(cancel.run_if_active(|| true), None);
}

#[test]
fn session_cancellation_ticket_rejects_cancel_after_ticket() {
    let cancel = SessionCancellation::default();
    let ticket = cancel.ticket();

    cancel.cancel();

    assert!(!cancel.reset_if_unchanged(ticket));
    assert!(cancel.is_cancelled());
}

#[test]
fn session_cancellation_ticket_allows_cancel_before_new_ticket() {
    let cancel = SessionCancellation::default();
    cancel.cancel();
    let ticket = cancel.ticket();

    assert!(cancel.reset_if_unchanged(ticket));
    assert!(!cancel.is_cancelled());
}

#[test]
fn attach_rejects_cancel_between_ticket_and_arm_before_launcher() {
    let root = tempfile::tempdir().unwrap();
    let runner = Arc::new(RecordingRunner::default());
    let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    service.runner = runner.clone();
    let service = Arc::new(service);
    let launcher = Arc::new(RecordingEmulatorLauncher::default());
    let (ticket_sender, ticket_receiver) = std::sync::mpsc::channel();
    service.session_cancel.observe_next_ticket(ticket_sender);
    let operation = service.operation_lock.lock().unwrap();

    let attach_service = service.clone();
    let attach_launcher = launcher.clone();
    let attach = thread::spawn(move || {
        attach_service.attach_sync_with_sink(
            None,
            Arc::new(RecordingAttachSink),
            attach_launcher.as_ref(),
            Arc::new(SystemPreviewFactoryProvider),
            Arc::new(SystemLegacyPreviewBackendFactory::default()),
            "Pixel_8_API_35".to_string(),
            2,
            1.0,
            None,
        )
    });

    let ticket_captured = ticket_receiver
        .recv_timeout(Duration::from_millis(100))
        .is_ok();
    service.request_session_cancel();
    drop(operation);

    let result = attach.join().unwrap();
    assert!(
        ticket_captured,
        "attach must capture its ticket before waiting for operation_lock"
    );
    assert_eq!(result.unwrap_err(), "Android emulator attach was cancelled");
    assert!(service.session_cancel.is_cancelled());
    assert!(launcher.calls.lock().unwrap().is_empty());
    assert!(runner.commands.lock().unwrap().is_empty());
}

#[test]
fn owned_spawn_is_linearized_under_session_cancellation_gate() {
    let cancel = Arc::new(SessionCancellation::default());
    let runner = Arc::new(ExternalAttachRunner::default());
    let launcher = GateCheckingLauncher::new(cancel.clone());
    let attempts = SystemOwnedBootAttempts::new(
        runner,
        &launcher,
        PathBuf::from("emulator"),
        "adb".to_string(),
    );

    let result = attempts
        .attempt("Pixel_8_API_35", GpuMode::Host, cancel.as_ref())
        .expect("the gate test launcher should produce a boot result");
    assert_eq!(launcher.spawn_calls(), 1);
    assert!(launcher.spawn_gate_was_held());
    attempts.terminate(&result).unwrap();
}

#[test]
fn owned_mark_booted_is_linearized_under_session_cancellation_gate() {
    let cancel = Arc::new(SessionCancellation::default());
    let ledger = GateCheckingBootLedger::new(cancel.clone());
    let attempts = ScriptedOwnedBootAttempts::new(vec![Ok(fake_owned_boot(2222, GpuMode::Host))]);

    let result = boot_owned_with_attempts(&ledger, &attempts, "Pixel_8_API_35", cancel.as_ref())
        .expect("the gate test ledger should accept mark_booted");
    assert!(ledger.mark_booted_gate_was_held());
    attempts.terminate(&result).unwrap();
}

#[test]
fn cancel_never_retries_and_two_failures_never_spawn_a_third_time() {
    let cancel_ledger = RecordingBootLedger::default();
    let cancelled = ScriptedOwnedBootAttempts::new(vec![Err(OwnedBootAttemptError::Cancelled)]);
    let cancel = SessionCancellation::default();
    assert!(matches!(
        boot_owned_with_attempts(&cancel_ledger, &cancelled, "Pixel_8_API_35", &cancel,),
        Err(OwnedBootError::Cancelled)
    ));
    assert_eq!(cancelled.gpus(), vec![GpuMode::Host]);
    assert_eq!(cancel_ledger.calls(), vec!["mark_boot_requested", "remove"]);

    let failed_ledger = RecordingBootLedger::default();
    let failed = ScriptedOwnedBootAttempts::new(vec![
        Err(OwnedBootAttemptError::Failed("host failed".to_string())),
        Err(OwnedBootAttemptError::Failed("software failed".to_string())),
    ]);
    let not_cancelled = SessionCancellation::default();
    assert!(
        boot_owned_with_attempts(&failed_ledger, &failed, "Pixel_8_API_35", &not_cancelled,)
            .is_err()
    );
    assert_eq!(failed.gpus().len(), 2);
    assert_eq!(failed_ledger.calls().last(), Some(&"remove"));
}

#[test]
fn mark_booted_failure_terminates_spawned_child_and_removes_ledger() {
    let ledger = RecordingBootLedger::default();
    ledger.fail_next_mark_booted();
    let attempts = ScriptedOwnedBootAttempts::new(vec![Ok(fake_owned_boot(2222, GpuMode::Host))]);
    let cancel = SessionCancellation::default();
    assert!(matches!(
        boot_owned_with_attempts(
            &ledger,
            &attempts,
            "Pixel_8_API_35",
            &cancel,
        ),
        Err(OwnedBootError::Failed(ref message))
            if message == "ledger mark_booted failed"
    ));
    assert_eq!(attempts.terminates(), 1);
    assert_eq!(
        ledger.calls(),
        vec!["mark_boot_requested", "mark_booted", "remove"]
    );
}

#[test]
fn postboot_surfaceflinger_swiftshader_only_marks_degraded() {
    assert!(surface_flinger_uses_software_gpu(
        "GLES: Google (Google SwiftShader), OpenGL ES 3.0"
    ));
    assert!(!surface_flinger_uses_software_gpu(
        "GLES: Apple, ANGLE Metal Renderer"
    ));
    let attempts = ScriptedOwnedBootAttempts::new(vec![Ok(fake_owned_boot(3333, GpuMode::Host))]);
    let result = apply_postboot_gpu_probe(
        attempts.take_success(),
        "GLES: Google (Google SwiftShader), OpenGL ES 3.0",
    );
    assert!(result.gpu_software);
    assert_eq!(result.gpu, GpuMode::Host);
}

#[test]
fn owned_surfaceflinger_probe_uses_interruptible_runner_and_deadline() {
    let runner = InterruptibleProbeRunner::default();
    let ledger = RecordingBootLedger::default();
    let attempts = ScriptedOwnedBootAttempts::new(Vec::new());
    let cancel = AtomicBool::new(false);
    let result = probe_owned_surface_flinger(
        &runner,
        &attempts,
        &ledger,
        "Pixel_8_API_35",
        "adb",
        fake_owned_boot(3333, GpuMode::Host),
        &cancel,
    )
    .unwrap();

    assert_eq!(result.gpu, GpuMode::Host);
    assert!(!result.gpu_software);
    assert_eq!(runner.run_calls(), 0);
    assert_eq!(runner.interruptible_calls(), 1);
    assert_eq!(
        runner.args(),
        vec![vec![
            "-s".to_string(),
            "emulator-5554".to_string(),
            "shell".to_string(),
            "dumpsys".to_string(),
            "SurfaceFlinger".to_string(),
        ]]
    );
    assert_eq!(runner.cancels(), vec![false]);
    let deadline = runner.deadlines()[0];
    assert!(deadline > Instant::now());
    assert!(deadline <= Instant::now() + ADB_COMMAND_TIMEOUT);
}

#[test]
fn owned_surfaceflinger_probe_cancel_before_command_rolls_back() {
    let runner = InterruptibleProbeRunner::default();
    let ledger = RecordingBootLedger::default();
    let attempts = ScriptedOwnedBootAttempts::new(Vec::new());
    let cancel = AtomicBool::new(true);

    assert!(matches!(
        probe_owned_surface_flinger(
            &runner,
            &attempts,
            &ledger,
            "Pixel_8_API_35",
            "adb",
            fake_owned_boot(3333, GpuMode::Host),
            &cancel,
        ),
        Err(OwnedBootError::Cancelled)
    ));
    assert_eq!(runner.interruptible_calls(), 0);
    assert_eq!(attempts.terminates(), 1);
    assert_eq!(ledger.calls(), vec!["remove"]);
}

#[test]
fn owned_surfaceflinger_probe_cancel_after_command_rolls_back() {
    let runner = InterruptibleProbeRunner::default();
    let ledger = RecordingBootLedger::default();
    let attempts = ScriptedOwnedBootAttempts::new(Vec::new());
    let cancel = Arc::new(SessionCancellation::default());
    runner.cancel_after_probe(cancel.clone());

    assert!(matches!(
        probe_owned_surface_flinger(
            &runner,
            &attempts,
            &ledger,
            "Pixel_8_API_35",
            "adb",
            fake_owned_boot(3333, GpuMode::Host),
            cancel.flag(),
        ),
        Err(OwnedBootError::Cancelled)
    ));
    assert_eq!(runner.run_calls(), 0);
    assert_eq!(runner.interruptible_calls(), 1);
    assert_eq!(attempts.terminates(), 1);
    assert_eq!(ledger.calls(), vec!["remove"]);
}

#[test]
fn owned_surfaceflinger_probe_error_without_cancel_is_nonfatal() {
    let runner = InterruptibleProbeRunner::default();
    runner.fail_probe();
    let ledger = RecordingBootLedger::default();
    let attempts = ScriptedOwnedBootAttempts::new(Vec::new());
    let cancel = AtomicBool::new(false);

    let result = probe_owned_surface_flinger(
        &runner,
        &attempts,
        &ledger,
        "Pixel_8_API_35",
        "adb",
        fake_owned_boot(3333, GpuMode::Host),
        &cancel,
    )
    .unwrap();

    assert!(!result.gpu_software);
    assert_eq!(attempts.terminates(), 0);
    assert!(ledger.calls().is_empty());
}

#[test]
fn png_dimensions_read_the_real_ihdr() {
    let mut png = vec![0; 24];
    png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    png[12..16].copy_from_slice(b"IHDR");
    png[16..20].copy_from_slice(&1080u32.to_be_bytes());
    png[20..24].copy_from_slice(&2400u32.to_be_bytes());
    assert_eq!(parse_png_dimensions(&png).unwrap(), (1080, 2400));
}

#[test]
fn lifecycle_stages_serialize_with_the_frozen_ios_literals() {
    assert_eq!(
        serde_json::to_string(&AndroidEmulatorStartupStage::WaitingForDisplay).unwrap(),
        "\"waitingForDisplay\""
    );
    assert_eq!(
        serde_json::to_string(&AndroidEmulatorStartupStage::GeneratingFirstPreview).unwrap(),
        "\"generatingFirstPreview\""
    );
}

#[test]
fn only_verboo_ownership_is_shutdown_eligible() {
    assert!(should_shutdown(AndroidEmulatorOwnership::Verboo));
    assert!(!should_shutdown(AndroidEmulatorOwnership::External));
}

#[test]
fn end_does_not_wait_past_the_deadline_for_the_operation_lock() {
    let root = tempfile::tempdir().unwrap();
    let service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    let _operation = service.operation_lock.lock().unwrap();
    let started = Instant::now();

    let result = service.end_sync_until(started + Duration::from_millis(100));

    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(result.is_err());
}

#[test]
fn ownership_ledger_round_trips_boot_requested_then_booted() {
    let root = tempfile::tempdir().unwrap();
    let ledger = OwnershipLedger::open(root.path().to_path_buf()).unwrap();
    ledger.mark_boot_requested("Pixel_8_API_35").unwrap();
    assert_eq!(
        OwnershipLedger::open(root.path().to_path_buf())
            .unwrap()
            .phase("Pixel_8_API_35"),
        Some(OwnershipPhase::BootRequested)
    );
    ledger.mark_booted("Pixel_8_API_35").unwrap();
    assert_eq!(
        OwnershipLedger::open(root.path().to_path_buf())
            .unwrap()
            .phase("Pixel_8_API_35"),
        Some(OwnershipPhase::BootedByVerboo)
    );
}

#[test]
fn hidden_preview_gate_stops_waiting_without_capturing() {
    let gate = std::sync::Arc::new(PreviewGate::new(false));
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (started_sender, started_receiver) = std::sync::mpsc::channel();
    let waiting_gate = gate.clone();
    let waiting_stop = stop.clone();
    let worker = std::thread::spawn(move || {
        started_sender.send(()).unwrap();
        waiting_gate.wait_until_visible(&waiting_stop)
    });
    started_receiver
        .recv_timeout(std::time::Duration::from_millis(100))
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(100);
    while gate.parked_workers() == 0 && std::time::Instant::now() < deadline {
        std::thread::yield_now();
    }
    assert_eq!(gate.parked_workers(), 1);
    gate.stop_and_wake(&stop);
    assert!(!worker.join().unwrap());
}

#[test]
fn hidden_preview_gate_parks_then_resumes_when_visible() {
    let gate = std::sync::Arc::new(PreviewGate::new(false));
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (started_sender, started_receiver) = std::sync::mpsc::channel();
    let (ready_sender, ready_receiver) = std::sync::mpsc::channel();
    let waiting_gate = gate.clone();
    let waiting_stop = stop.clone();
    let worker = std::thread::spawn(move || {
        started_sender.send(()).unwrap();
        ready_sender
            .send(waiting_gate.wait_until_visible(&waiting_stop))
            .unwrap();
    });
    started_receiver
        .recv_timeout(std::time::Duration::from_millis(100))
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(100);
    while gate.parked_workers() == 0 && std::time::Instant::now() < deadline {
        std::thread::yield_now();
    }
    assert_eq!(gate.parked_workers(), 1);
    assert!(ready_receiver.try_recv().is_err());
    gate.set_visible(true);
    assert_eq!(
        ready_receiver
            .recv_timeout(std::time::Duration::from_millis(100))
            .unwrap(),
        true
    );
    worker.join().unwrap();
    gate.set_visible(false);
    assert!(!gate.wait_for_visible_interval(&stop, std::time::Duration::from_millis(1)));
}

#[test]
fn detach_cancels_boot_polling_without_waiting_for_command_deadline() {
    let (started_sender, started_receiver) = std::sync::mpsc::channel();
    let runner = Arc::new(BootCancellationRunner {
        started: Mutex::new(Some(started_sender)),
    });
    let root = tempfile::tempdir().unwrap();
    let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    service.runner = runner.clone();
    let stop = service.session_cancel.clone();
    let process = Arc::new(Mutex::new(None));
    let runner_for_thread = runner.clone();
    let stop_for_thread = stop.clone();
    let result = thread::spawn(move || {
        wait_for_boot(
            runner_for_thread.as_ref(),
            "adb",
            "Pixel_8_API_35",
            &process,
            stop_for_thread.flag(),
            Instant::now() + Duration::from_secs(2),
        )
    });
    started_receiver
        .recv_timeout(Duration::from_millis(100))
        .unwrap();
    let cancelled_at = Instant::now();
    assert_eq!(
        service.detach_sync().unwrap_err(),
        "No Android emulator is attached."
    );
    assert_eq!(
        result.join().unwrap().unwrap_err(),
        "Android emulator boot cancelled"
    );
    assert!(
        cancelled_at.elapsed() < Duration::from_millis(700),
        "boot cancellation exceeded its interruptibility budget"
    );
}

#[test]
fn switching_owned_avd_removes_ledger_before_external_reentry() {
    let root = tempfile::tempdir().unwrap();
    let runner = Arc::new(RecordingRunner::default());
    let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
    service.runner = runner.clone();
    service.ownership.mark_booted("Pixel_8_API_35").unwrap();
    service.state.lock().unwrap().session =
        Some(test_android_session(AndroidEmulatorOwnership::Verboo));

    service.stop_current_locked(true).unwrap();

    assert_eq!(
        service.ownership.phase("Pixel_8_API_35"),
        None,
        "switch cleanup must remove the old owned AVD from the ledger"
    );
    assert_eq!(
        ownership_for_running_avd(&service.ownership, "Pixel_8_API_35"),
        AndroidEmulatorOwnership::External,
        "a reappearing external AVD must not inherit stale Verboo ownership"
    );
    let kill_count_after_switch = runner
        .commands
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, args)| args.ends_with(&["emu".to_string(), "kill".to_string()]))
        .count();
    assert_eq!(kill_count_after_switch, 1);

    service.state.lock().unwrap().session = Some(test_android_session(ownership_for_running_avd(
        &service.ownership,
        "Pixel_8_API_35",
    )));
    service.end_sync().unwrap();
    let kill_count_after_external_end = runner
        .commands
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, args)| args.ends_with(&["emu".to_string(), "kill".to_string()]))
        .count();
    assert_eq!(kill_count_after_external_end, 1);
}
