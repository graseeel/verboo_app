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
