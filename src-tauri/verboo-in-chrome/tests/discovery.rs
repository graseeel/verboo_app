use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::net::UnixListener;

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
    assert!(!store.record_path(4_000_000_000).exists());
}

#[cfg(unix)]
#[test]
fn returns_the_legitimate_session_when_a_live_host_is_orphaned() {
    let (_temp, store) = store();
    let legitimate = store
        .register(std::process::id(), "chrome-extension://legitimate".into())
        .unwrap();
    let _legitimate_listener = UnixListener::bind(&legitimate.endpoint).unwrap();

    let mut orphan = store
        .register(1, "chrome-extension://orphan".into())
        .unwrap();
    // The host is still alive, but its recorded Chrome parent died; launchd
    // (PID 1) adopted it. The record retains the original parent PID.
    orphan.parent_pid = Some(4_000_000_000);
    store.write_record(&orphan).unwrap();
    let _orphan_listener = UnixListener::bind(&orphan.endpoint).unwrap();

    assert_eq!(store.discover_session().unwrap(), Some(legitimate));
    assert!(!store.record_path(orphan.pid).exists());
}

#[cfg(unix)]
#[test]
fn prunes_legacy_records_without_a_browser_parent() {
    let (_temp, store) = store();
    let record = store
        .register(std::process::id(), "chrome-extension://legacy".into())
        .unwrap();
    let _listener = UnixListener::bind(&record.endpoint).unwrap();
    let path = store.record_path(record.pid);
    let mut value = serde_json::to_value(&record).unwrap();
    value.as_object_mut().unwrap().remove("parentPid");
    fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();

    assert_eq!(store.discover_session().unwrap(), None);
    assert!(!store.record_path(record.pid).exists());
}

#[cfg(unix)]
#[test]
fn rejects_a_live_process_when_its_endpoint_is_missing() {
    let (_temp, store) = store();
    let record = store
        .register(
            std::process::id(),
            "chrome-extension://missing-endpoint".into(),
        )
        .unwrap();

    assert_eq!(store.discover_session().unwrap(), None);
    assert!(!store.record_path(record.pid).exists());
}

#[test]
fn discovers_exactly_one_live_session() {
    let (_temp, store) = store();
    let expected = store
        .register(std::process::id(), "chrome-extension://test".into())
        .unwrap();
    #[cfg(unix)]
    let _listener = UnixListener::bind(&expected.endpoint).unwrap();

    assert_eq!(store.discover_session().unwrap(), Some(expected));
}

#[cfg(unix)]
#[test]
fn rejects_multiple_live_browser_sessions() {
    let (_temp, store) = store();
    let first = store
        .register(std::process::id(), "chrome-extension://one".into())
        .unwrap();
    let _first_listener = UnixListener::bind(&first.endpoint).unwrap();
    let parent_pid = unsafe { libc::getppid() } as u32;
    let second = store
        .register(parent_pid, "chrome-extension://two".into())
        .unwrap();
    let _second_listener = UnixListener::bind(&second.endpoint).unwrap();

    assert!(matches!(
        store.discover_session(),
        Err(DiscoveryError::MultipleBrowserSessions)
    ));
}

#[cfg(unix)]
#[test]
fn prunes_an_unreachable_endpoint_before_reporting_multiple_sessions() {
    let (_temp, store) = store();
    let live = store
        .register(std::process::id(), "chrome-extension://live".into())
        .unwrap();
    let _listener = UnixListener::bind(&live.endpoint).unwrap();
    let parent_pid = unsafe { libc::getppid() } as u32;
    let stale = store
        .register(parent_pid, "chrome-extension://stale-endpoint".into())
        .unwrap();
    let stale_listener = UnixListener::bind(&stale.endpoint).unwrap();
    drop(stale_listener);

    assert_eq!(store.discover_session().unwrap(), Some(live));
    assert!(!store.record_path(stale.pid).exists());
    assert!(!std::path::Path::new(&stale.endpoint).exists());
}
