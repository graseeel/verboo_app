use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::Utc;
use semver::Version;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use uuid::Uuid;

use super::contract::DesktopTarget;

const CURRENT_POINTER: &str = "current.json";
const LAST_KNOWN_GOOD_POINTER: &str = "last-known-good.json";
const REJECTED_POINTER: &str = "rejected.json";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliPointer {
    pub version: String,
    pub target: DesktopTarget,
    pub manifest_digest: String,
    pub installed_at: String,
}

impl CliPointer {
    pub fn new(
        version: impl Into<String>,
        target: DesktopTarget,
        manifest_digest: impl Into<String>,
    ) -> Result<Self, String> {
        let pointer = Self {
            version: version.into(),
            target,
            manifest_digest: manifest_digest.into(),
            installed_at: Utc::now().to_rfc3339(),
        };
        validate_pointer(&pointer)?;
        Ok(pointer)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LeaseRecord {
    pid: u32,
    version: String,
    target: DesktopTarget,
    manifest_digest: String,
    acquired_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RejectedRecord {
    manifest_digest: String,
    rejected_at: String,
}

#[derive(Debug, Clone)]
pub struct CliStore {
    root: PathBuf,
}

impl CliStore {
    pub fn open(app_data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let store = Self {
            root: app_data_dir.as_ref().join("cli"),
        };
        for directory in [
            store.versions_dir(),
            store.staging_dir(),
            store.leases_dir(),
        ] {
            fs::create_dir_all(&directory).map_err(|error| {
                format!(
                    "failed to create CLI storage directory {}: {error}",
                    directory.display()
                )
            })?;
        }
        Ok(store)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn versions_dir(&self) -> PathBuf {
        self.root.join("versions")
    }

    pub fn staging_dir(&self) -> PathBuf {
        self.root.join("staging")
    }

    pub fn leases_dir(&self) -> PathBuf {
        self.root.join("leases")
    }

    pub fn version_dir(&self, version: &str) -> Result<PathBuf, String> {
        validate_version(version)?;
        Ok(self.versions_dir().join(version))
    }

    pub fn current(&self) -> Result<Option<CliPointer>, String> {
        self.read_pointer(CURRENT_POINTER)
    }

    pub fn last_known_good(&self) -> Result<Option<CliPointer>, String> {
        self.read_pointer(LAST_KNOWN_GOOD_POINTER)
    }

    pub fn create_staging_dir(&self) -> Result<PathBuf, String> {
        let path = self
            .staging_dir()
            .join(format!("{}-{}", std::process::id(), Uuid::new_v4()));
        fs::create_dir(&path)
            .map_err(|error| format!("failed to create unique CLI staging directory: {error}"))?;
        Ok(path)
    }

    pub fn promote_staged(
        &self,
        staged_payload: &Path,
        pointer: &CliPointer,
    ) -> Result<PathBuf, String> {
        validate_pointer(pointer)?;
        let destination = self.version_dir(&pointer.version)?;
        if destination.exists() {
            return Err(format!(
                "CLI version {} is already installed",
                pointer.version
            ));
        }
        fs::rename(staged_payload, &destination).map_err(|error| {
            format!(
                "failed to promote CLI {} into immutable storage: {error}",
                pointer.version
            )
        })?;
        sync_directory(&self.versions_dir())?;
        Ok(destination)
    }

    pub fn activate(&self, pointer: &CliPointer) -> Result<(), String> {
        validate_pointer(pointer)?;
        let cli_mjs = self.version_dir(&pointer.version)?.join("dist/cli.mjs");
        if !cli_mjs.is_file() {
            return Err(format!(
                "cannot activate CLI {} because dist/cli.mjs is missing",
                pointer.version
            ));
        }

        if let Some(previous) = self.current()? {
            if previous != *pointer {
                self.write_pointer(LAST_KNOWN_GOOD_POINTER, &previous)?;
            }
        }
        self.write_pointer(CURRENT_POINTER, pointer)
    }

    pub fn mark_current_good(&self) -> Result<(), String> {
        let current = self
            .current()?
            .ok_or_else(|| "cannot mark a missing CLI as known good".to_string())?;
        self.write_pointer(LAST_KNOWN_GOOD_POINTER, &current)
    }

    pub fn restore_last_known_good(&self) -> Result<CliPointer, String> {
        let pointer = self
            .last_known_good()?
            .ok_or_else(|| "no last-known-good CLI is available".to_string())?;
        let cli_mjs = self.version_dir(&pointer.version)?.join("dist/cli.mjs");
        if !cli_mjs.is_file() {
            return Err("last-known-good CLI payload is missing".to_string());
        }
        self.write_pointer(CURRENT_POINTER, &pointer)?;
        Ok(pointer)
    }

    pub fn rollback_activation(
        &self,
        activated: &CliPointer,
        previous: &CliPointer,
    ) -> Result<(), String> {
        validate_pointer(activated)?;
        validate_pointer(previous)?;
        let current = self
            .current()?
            .ok_or_else(|| "cannot roll back a missing CLI activation".to_string())?;
        if current != *activated {
            return Err("current CLI changed while an update was being installed".to_string());
        }
        let previous_cli = self.version_dir(&previous.version)?.join("dist/cli.mjs");
        if !previous_cli.is_file() {
            return Err(format!(
                "cannot roll back because CLI {} is missing",
                previous.version
            ));
        }
        self.write_pointer(CURRENT_POINTER, previous)?;
        self.write_pointer(LAST_KNOWN_GOOD_POINTER, previous)
    }

    pub fn acquire_runtime(&self, node_path: PathBuf) -> Result<CliRuntimeLease, String> {
        let pointer = self
            .current()?
            .ok_or_else(|| "CLI bootstrap is required".to_string())?;
        let cli_mjs_path = self.version_dir(&pointer.version)?.join("dist/cli.mjs");
        if !node_path.is_file() {
            return Err(format!(
                "Verboo Node runtime is missing at {}",
                node_path.display()
            ));
        }
        if !cli_mjs_path.is_file() {
            return Err(format!(
                "installed CLI {} is missing dist/cli.mjs",
                pointer.version
            ));
        }

        let lease_path =
            self.leases_dir()
                .join(format!("{}-{}.json", std::process::id(), Uuid::new_v4()));
        let record = LeaseRecord {
            pid: std::process::id(),
            version: pointer.version.clone(),
            target: pointer.target,
            manifest_digest: pointer.manifest_digest.clone(),
            acquired_at: Utc::now().to_rfc3339(),
        };
        atomic_write_json(&lease_path, &record)?;
        Ok(CliRuntimeLease {
            node_path,
            cli_mjs_path,
            version: pointer.version,
            target: pointer.target,
            manifest_digest: pointer.manifest_digest,
            lease_path,
        })
    }

    pub fn record_rejected(&self, manifest_digest: &str) -> Result<(), String> {
        validate_digest(manifest_digest)?;
        atomic_write_json(
            &self.root.join(REJECTED_POINTER),
            &RejectedRecord {
                manifest_digest: manifest_digest.to_string(),
                rejected_at: Utc::now().to_rfc3339(),
            },
        )
    }

    pub fn was_rejected(&self, manifest_digest: &str) -> Result<bool, String> {
        let record: Option<RejectedRecord> = read_json(&self.root.join(REJECTED_POINTER))?;
        Ok(record
            .map(|record| record.manifest_digest == manifest_digest)
            .unwrap_or(false))
    }

    pub fn cleanup_abandoned_staging(&self) -> Result<(), String> {
        for entry in fs::read_dir(self.staging_dir())
            .map_err(|error| format!("failed to inspect CLI staging: {error}"))?
        {
            let entry =
                entry.map_err(|error| format!("failed to inspect CLI staging entry: {error}"))?;
            let path = entry.path();
            let Some(owner_pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.split_once('-'))
                .and_then(|(pid, _)| pid.parse::<u32>().ok())
            else {
                // Unknown staging entries are retained rather than guessed at.
                continue;
            };
            if process_may_be_alive(owner_pid) {
                continue;
            }
            if path.is_dir() {
                fs::remove_dir_all(&path).map_err(|error| {
                    format!("failed to remove abandoned CLI staging directory: {error}")
                })?;
            } else {
                fs::remove_file(&path).map_err(|error| {
                    format!("failed to remove abandoned CLI staging file: {error}")
                })?;
            }
        }
        Ok(())
    }

    pub fn garbage_collect(&self) -> Result<(), String> {
        let mut retained = HashSet::new();
        if let Some(pointer) = self.current()? {
            retained.insert(pointer.version);
        }
        if let Some(pointer) = self.last_known_good()? {
            retained.insert(pointer.version);
        }

        for entry in fs::read_dir(self.leases_dir())
            .map_err(|error| format!("failed to inspect CLI leases: {error}"))?
        {
            let path = entry
                .map_err(|error| format!("failed to inspect CLI lease entry: {error}"))?
                .path();
            let Some(record) = read_json::<LeaseRecord>(&path)? else {
                // A lease may disappear between read_dir and read when its
                // child exits. That is safe; malformed bytes are not ignored.
                continue;
            };
            validate_lease(&record)?;
            if process_may_be_alive(record.pid) {
                retained.insert(record.version);
            } else {
                let _ = fs::remove_file(path);
            }
        }

        for entry in fs::read_dir(self.versions_dir())
            .map_err(|error| format!("failed to inspect installed CLI versions: {error}"))?
        {
            let entry = entry
                .map_err(|error| format!("failed to inspect installed CLI version: {error}"))?;
            let path = entry.path();
            let Some(version) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if path.is_dir() && !retained.contains(&version) {
                fs::remove_dir_all(&path).map_err(|error| {
                    format!("failed to remove unused CLI version {version}: {error}")
                })?;
            }
        }
        Ok(())
    }

    fn read_pointer(&self, filename: &str) -> Result<Option<CliPointer>, String> {
        let pointer = read_json::<CliPointer>(&self.root.join(filename))?;
        if let Some(pointer) = pointer.as_ref() {
            validate_pointer(pointer)?;
        }
        Ok(pointer)
    }

    fn write_pointer(&self, filename: &str, pointer: &CliPointer) -> Result<(), String> {
        validate_pointer(pointer)?;
        atomic_write_json(&self.root.join(filename), pointer)
    }
}

pub struct CliRuntimeLease {
    pub node_path: PathBuf,
    pub cli_mjs_path: PathBuf,
    pub version: String,
    pub target: DesktopTarget,
    pub manifest_digest: String,
    lease_path: PathBuf,
}

impl std::fmt::Debug for CliRuntimeLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CliRuntimeLease")
            .field("node_path", &self.node_path)
            .field("cli_mjs_path", &self.cli_mjs_path)
            .field("version", &self.version)
            .field("target", &self.target)
            .field("manifest_digest", &self.manifest_digest)
            .finish_non_exhaustive()
    }
}

impl Drop for CliRuntimeLease {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.lease_path);
    }
}

fn validate_pointer(pointer: &CliPointer) -> Result<(), String> {
    validate_version(&pointer.version)?;
    validate_digest(&pointer.manifest_digest)?;
    chrono::DateTime::parse_from_rfc3339(&pointer.installed_at)
        .map_err(|error| format!("invalid CLI installation timestamp: {error}"))?;
    Ok(())
}

fn validate_lease(lease: &LeaseRecord) -> Result<(), String> {
    if lease.pid == 0 {
        return Err("invalid CLI lease process ID".to_string());
    }
    validate_version(&lease.version)?;
    validate_digest(&lease.manifest_digest)?;
    chrono::DateTime::parse_from_rfc3339(&lease.acquired_at)
        .map_err(|error| format!("invalid CLI lease timestamp: {error}"))?;
    Ok(())
}

fn validate_version(version: &str) -> Result<(), String> {
    Version::parse(version)
        .map(|_| ())
        .map_err(|error| format!("invalid CLI storage version {version:?}: {error}"))
}

fn validate_digest(digest: &str) -> Result<(), String> {
    if digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err("invalid CLI manifest digest".to_string())
    }
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "failed to read CLI state {}: {error}",
                path.display()
            ));
        }
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("invalid CLI state {}: {error}", path.display()))
}

fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("failed to serialize CLI state: {error}"))?;
    bytes.push(b'\n');
    atomic_write_bytes_with(path, &bytes, |_| Ok(()))
}

fn atomic_write_bytes_with<F>(path: &Path, bytes: &[u8], before_replace: F) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let parent = path
        .parent()
        .ok_or_else(|| "CLI state path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create CLI state directory: {error}"))?;
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "CLI state filename is invalid".to_string())?;
    let temporary = parent.join(format!(".{filename}.{}.tmp", Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("failed to create temporary CLI state: {error}"))?;
    let result = (|| {
        file.write_all(bytes)
            .map_err(|error| format!("failed to write temporary CLI state: {error}"))?;
        file.flush()
            .map_err(|error| format!("failed to flush temporary CLI state: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("failed to sync temporary CLI state: {error}"))?;
        before_replace(&temporary)?;
        drop(file);
        replace_file(&temporary, path)?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination)
        .map_err(|error| format!("failed to atomically replace CLI state: {error}"))
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(format!(
            "failed to atomically replace CLI state: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("failed to sync CLI storage directory: {error}"))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn process_may_be_alive(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as i32, 0) };
    if result == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(windows)]
fn process_may_be_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return true;
    }
    let mut exit_code = 0_u32;
    let success = unsafe { GetExitCodeProcess(handle, &mut exit_code) };
    unsafe { CloseHandle(handle) };
    success == 0 || exit_code == STILL_ACTIVE as u32
}

#[cfg(not(any(unix, windows)))]
fn process_may_be_alive(_pid: u32) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pointer(version: &str) -> CliPointer {
        CliPointer::new(version, DesktopTarget::MacArm64, "a".repeat(64)).unwrap()
    }

    fn install(store: &CliStore, version: &str) {
        let root = store.version_dir(version).unwrap();
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(root.join("dist/cli.mjs"), b"entry").unwrap();
    }

    #[test]
    fn creates_only_the_owned_cli_storage_tree() {
        let app_data = tempfile::tempdir().unwrap();
        let store = CliStore::open(app_data.path()).unwrap();
        assert_eq!(store.root(), &app_data.path().join("cli"));
        assert!(store.versions_dir().is_dir());
        assert!(store.staging_dir().is_dir());
        assert!(store.leases_dir().is_dir());
    }

    #[test]
    fn activation_changes_only_the_pointer_and_preserves_a_live_lease() {
        let app_data = tempfile::tempdir().unwrap();
        let store = CliStore::open(app_data.path()).unwrap();
        let node = app_data.path().join("embedded-node");
        fs::write(&node, b"node").unwrap();
        install(&store, "0.15.5");
        install(&store, "0.15.6");
        store.activate(&pointer("0.15.5")).unwrap();
        let lease = store.acquire_runtime(node).unwrap();

        store.activate(&pointer("0.15.6")).unwrap();
        assert!(lease.cli_mjs_path.ends_with("0.15.5/dist/cli.mjs"));
        assert!(lease.cli_mjs_path.exists());
        assert_eq!(store.current().unwrap().unwrap().version, "0.15.6");
        assert_eq!(store.last_known_good().unwrap().unwrap().version, "0.15.5");
        store.garbage_collect().unwrap();
        assert!(store.version_dir("0.15.5").unwrap().exists());
    }

    #[test]
    fn dropping_a_lease_allows_unused_version_collection() {
        let app_data = tempfile::tempdir().unwrap();
        let store = CliStore::open(app_data.path()).unwrap();
        let node = app_data.path().join("embedded-node");
        fs::write(&node, b"node").unwrap();
        for version in ["0.15.4", "0.15.5", "0.15.6"] {
            install(&store, version);
        }
        store.activate(&pointer("0.15.4")).unwrap();
        let lease = store.acquire_runtime(node).unwrap();
        store.activate(&pointer("0.15.5")).unwrap();
        store.activate(&pointer("0.15.6")).unwrap();
        store.garbage_collect().unwrap();
        assert!(store.version_dir("0.15.4").unwrap().exists());
        drop(lease);
        store.garbage_collect().unwrap();
        assert!(!store.version_dir("0.15.4").unwrap().exists());
        assert!(store.version_dir("0.15.5").unwrap().exists());
        assert!(store.version_dir("0.15.6").unwrap().exists());
    }

    #[test]
    fn interrupted_atomic_pointer_write_keeps_the_previous_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("current.json");
        fs::write(&destination, b"old pointer\n").unwrap();
        let result = atomic_write_bytes_with(&destination, b"new pointer\n", |_| {
            Err("injected interruption".to_string())
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"old pointer\n");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn restores_last_known_good_and_blocks_rejected_digest_loops() {
        let app_data = tempfile::tempdir().unwrap();
        let store = CliStore::open(app_data.path()).unwrap();
        install(&store, "0.15.5");
        install(&store, "0.15.6");
        store.activate(&pointer("0.15.5")).unwrap();
        store.activate(&pointer("0.15.6")).unwrap();
        assert_eq!(store.restore_last_known_good().unwrap().version, "0.15.5");

        let digest = "b".repeat(64);
        assert!(!store.was_rejected(&digest).unwrap());
        store.record_rejected(&digest).unwrap();
        assert!(store.was_rejected(&digest).unwrap());
    }

    #[test]
    fn malformed_lease_fails_closed_before_collecting_any_version() {
        let app_data = tempfile::tempdir().unwrap();
        let store = CliStore::open(app_data.path()).unwrap();
        install(&store, "0.15.4");
        fs::write(store.leases_dir().join("unknown.json"), b"{not-json").unwrap();

        assert!(store.garbage_collect().is_err());
        assert!(store.version_dir("0.15.4").unwrap().exists());
    }

    #[test]
    fn staging_owned_by_this_live_process_is_never_cleaned_as_abandoned() {
        let app_data = tempfile::tempdir().unwrap();
        let store = CliStore::open(app_data.path()).unwrap();
        let staging = store.create_staging_dir().unwrap();
        fs::write(staging.join("in-progress"), b"keep").unwrap();

        store.cleanup_abandoned_staging().unwrap();
        assert_eq!(fs::read(staging.join("in-progress")).unwrap(), b"keep");
    }
}
