use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use directories::BaseDirs;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::protocol::PROTOCOL_VERSION;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryRecord {
    pub protocol_version: u32,
    pub pid: u32,
    #[serde(default)]
    pub parent_pid: Option<u32>,
    pub endpoint: String,
    pub secret: String,
    pub helper_version: String,
    pub extension_origin: String,
}

#[derive(Debug, Error)]
pub enum DiscoveryError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid discovery record: {0}")]
    Json(#[from] serde_json::Error),
    #[error("no writable per-user runtime directory is available")]
    RuntimeDirectoryUnavailable,
    #[error("multiple Chrome browser sessions are connected")]
    MultipleBrowserSessions,
}

pub type DiscoveryResult<T> = std::result::Result<T, DiscoveryError>;

#[derive(Debug, Clone)]
pub struct DiscoveryStore {
    root: PathBuf,
}

impl DiscoveryStore {
    pub fn for_current_user() -> DiscoveryResult<Self> {
        let base = BaseDirs::new().ok_or(DiscoveryError::RuntimeDirectoryUnavailable)?;
        #[cfg(target_os = "linux")]
        let root = base
            .runtime_dir()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| base.cache_dir().to_path_buf())
            .join("verboo-in-chrome");
        #[cfg(not(target_os = "linux"))]
        let root = base.cache_dir().join("verboo-in-chrome");
        Ok(Self::at(root))
    }

    pub fn at(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn record_path(&self, pid: u32) -> PathBuf {
        self.root.join(format!("{pid}.json"))
    }

    pub fn register(&self, pid: u32, extension_origin: String) -> DiscoveryResult<DiscoveryRecord> {
        let record = self.prepare(pid, extension_origin)?;
        self.write_record(&record)?;
        Ok(record)
    }

    pub(crate) fn prepare(
        &self,
        pid: u32,
        extension_origin: String,
    ) -> DiscoveryResult<DiscoveryRecord> {
        self.ensure_private_root()?;
        let record = DiscoveryRecord {
            protocol_version: PROTOCOL_VERSION,
            pid,
            parent_pid: current_parent_pid(),
            endpoint: endpoint_for(&self.root, pid),
            secret: Uuid::new_v4().simple().to_string(),
            helper_version: env!("CARGO_PKG_VERSION").to_string(),
            extension_origin,
        };
        Ok(record)
    }

    pub fn write_record(&self, record: &DiscoveryRecord) -> DiscoveryResult<()> {
        self.write_record_with_hook(record, || {})
    }

    fn write_record_with_hook<F>(
        &self,
        record: &DiscoveryRecord,
        before_replace: F,
    ) -> DiscoveryResult<()>
    where
        F: FnOnce(),
    {
        self.ensure_private_root()?;
        let path = self.record_path(record.pid);
        let temporary_path =
            self.root
                .join(format!(".{}.{}.tmp", record.pid, Uuid::new_v4().simple()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let result = (|| {
            let mut file = options.open(&temporary_path)?;
            file.write_all(&serde_json::to_vec(record)?)?;
            file.sync_all()?;
            #[cfg(unix)]
            fs::set_permissions(&temporary_path, fs::Permissions::from_mode(0o600))?;
            before_replace();
            replace_record(&temporary_path, &path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary_path);
        }
        result
    }

    pub fn remove(&self, pid: u32) -> DiscoveryResult<()> {
        match fs::remove_file(self.record_path(pid)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    pub fn remove_record(&self, record: &DiscoveryRecord) -> DiscoveryResult<()> {
        self.remove(record.pid)?;
        #[cfg(unix)]
        remove_endpoint(&record.endpoint)?;
        Ok(())
    }

    pub fn discover_session(&self) -> DiscoveryResult<Option<DiscoveryRecord>> {
        if !self.root.exists() {
            return Ok(None);
        }

        let mut live = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                != Some("json")
            {
                continue;
            }
            let path = entry.path();
            let record: DiscoveryRecord = serde_json::from_slice(&fs::read(&path)?)?;
            let process_alive = process_is_alive(record.pid);
            let parent_alive = parent_is_alive(record.parent_pid);
            if record.protocol_version == PROTOCOL_VERSION
                && process_alive
                && parent_alive
                && endpoint_path_exists(&record.endpoint)
            {
                live.push(record);
            } else {
                discard_record(&path, &record);
            }
        }

        if live.len() > 1 {
            live.retain(|record| {
                if endpoint_is_accepting(&record.endpoint) {
                    true
                } else {
                    discard_record(&self.record_path(record.pid), record);
                    false
                }
            });
        }

        match live.len() {
            0 => Ok(None),
            1 => Ok(live.pop()),
            _ => Err(DiscoveryError::MultipleBrowserSessions),
        }
    }

    fn ensure_private_root(&self) -> DiscoveryResult<()> {
        fs::create_dir_all(&self.root)?;
        #[cfg(unix)]
        fs::set_permissions(&self.root, fs::Permissions::from_mode(0o700))?;
        Ok(())
    }
}

fn discard_record(path: &Path, record: &DiscoveryRecord) {
    let _ = fs::remove_file(path);
    #[cfg(unix)]
    let _ = remove_endpoint(&record.endpoint);
}

#[cfg(unix)]
fn replace_record(temporary_path: &Path, path: &Path) -> DiscoveryResult<()> {
    fs::rename(temporary_path, path)?;
    Ok(())
}

#[cfg(windows)]
fn replace_record(temporary_path: &Path, path: &Path) -> DiscoveryResult<()> {
    let _ = fs::remove_file(path);
    fs::rename(temporary_path, path)?;
    Ok(())
}

#[cfg(unix)]
fn remove_endpoint(endpoint: &str) -> DiscoveryResult<()> {
    match fs::remove_file(endpoint) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(unix)]
fn endpoint_path_exists(endpoint: &str) -> bool {
    Path::new(endpoint).exists()
}

#[cfg(not(unix))]
fn endpoint_path_exists(_endpoint: &str) -> bool {
    true
}

#[cfg(unix)]
fn endpoint_is_accepting(endpoint: &str) -> bool {
    std::os::unix::net::UnixStream::connect(endpoint).is_ok()
}

#[cfg(not(unix))]
fn endpoint_is_accepting(_endpoint: &str) -> bool {
    true
}

fn current_parent_pid() -> Option<u32> {
    #[cfg(unix)]
    {
        let parent = unsafe { libc::getppid() };
        return u32::try_from(parent).ok();
    }
    #[cfg(not(unix))]
    {
        None
    }
}

#[cfg(unix)]
fn parent_is_alive(parent_pid: Option<u32>) -> bool {
    parent_pid.is_some_and(process_is_alive)
}

#[cfg(not(unix))]
fn parent_is_alive(_parent_pid: Option<u32>) -> bool {
    true
}

#[cfg(unix)]
fn endpoint_for(root: &Path, pid: u32) -> String {
    root.join(format!("{pid}.sock"))
        .to_string_lossy()
        .into_owned()
}

#[cfg(windows)]
fn endpoint_for(_root: &Path, pid: u32) -> String {
    format!(r"\\.\pipe\verboo-in-chrome-{pid}")
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    if pid > i32::MAX as u32 {
        return false;
    }
    if pid == std::process::id() {
        return true;
    }
    let result = unsafe { libc::kill(pid as i32, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        false
    } else {
        unsafe { CloseHandle(handle) };
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn publishes_a_replacement_without_exposing_partial_state() {
        let temp = TempDir::new().unwrap();
        let store = DiscoveryStore::at(temp.path().join("runtime"));
        let previous = store
            .register(std::process::id(), "chrome-extension://previous".into())
            .unwrap();
        let previous_secret = previous.secret.clone();
        let mut replacement = previous.clone();
        replacement.secret = "replacement-secret".into();

        store
            .write_record_with_hook(&replacement, || {
                let observed: DiscoveryRecord =
                    serde_json::from_slice(&fs::read(store.record_path(previous.pid)).unwrap())
                        .unwrap();
                assert_eq!(observed.secret, previous_secret);
            })
            .unwrap();

        let published: DiscoveryRecord =
            serde_json::from_slice(&fs::read(store.record_path(previous.pid)).unwrap()).unwrap();
        assert_eq!(published.secret, replacement.secret);
    }
}
