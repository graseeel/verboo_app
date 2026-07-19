#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use tempfile::TempDir;
use verboo_in_chrome::discovery::{DiscoveryError, DiscoveryStore};

fn store() -> (TempDir, DiscoveryStore) {
    let temp = TempDir::new().unwrap();
    let store = DiscoveryStore::at(temp.path().join("runtime"));
    (temp, store)
}

#[test]
fn creates_private_runtime_directory_and_record_on_unix() {
    let (_temp, store) = store();
    let record = store
        .register(std::process::id(), "chrome-extension://test".into())
        .unwrap();

    #[cfg(unix)]
    {
        assert_eq!(
            store.root().metadata().unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            store
                .record_path(record.pid)
                .metadata()
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn rotates_the_session_secret_when_registering_again() {
    let (_temp, store) = store();
    let first = store
        .register(std::process::id(), "chrome-extension://test".into())
        .unwrap();
    let second = store
        .register(std::process::id(), "chrome-extension://test".into())
        .unwrap();

    assert_ne!(first.secret, second.secret);
}

#[test]
fn ignores_stale_process_records() {
    let (_temp, store) = store();
    store
        .register(4_000_000_000, "chrome-extension://stale".into())
        .unwrap();

    assert_eq!(store.discover_session().unwrap(), None);
}

#[test]
fn discovers_exactly_one_live_session() {
    let (_temp, store) = store();
    let expected = store
        .register(std::process::id(), "chrome-extension://test".into())
        .unwrap();

    assert_eq!(store.discover_session().unwrap(), Some(expected));
}

#[cfg(unix)]
#[test]
fn rejects_multiple_live_browser_sessions() {
    let (_temp, store) = store();
    store
        .register(std::process::id(), "chrome-extension://one".into())
        .unwrap();
    let parent_pid = unsafe { libc::getppid() } as u32;
    store
        .register(parent_pid, "chrome-extension://two".into())
        .unwrap();

    assert!(matches!(
        store.discover_session(),
        Err(DiscoveryError::MultipleBrowserSessions)
    ));
}
