use std::fs;

use serde::Deserialize;

use super::models::ChromeConnectionState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryRecord {
    protocol_version: u32,
    pid: u32,
}

pub(crate) fn connection_state() -> ChromeConnectionState {
    let Some(root) = discovery_root() else {
        return ChromeConnectionState::WaitingForChrome;
    };
    let Ok(entries) = fs::read_dir(root) else {
        return ChromeConnectionState::WaitingForChrome;
    };
    let mut compatible = 0;
    let mut incompatible = false;
    for entry in entries.flatten() {
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = fs::read(entry.path()) else {
            continue;
        };
        let Ok(record) = serde_json::from_slice::<DiscoveryRecord>(&bytes) else {
            incompatible = true;
            continue;
        };
        if !process_is_alive(record.pid) {
            continue;
        }
        if record.protocol_version == 1 {
            compatible += 1;
        } else {
            incompatible = true;
        }
    }
    match compatible {
        0 if incompatible => ChromeConnectionState::Incompatible,
        0 => ChromeConnectionState::WaitingForChrome,
        1 if !incompatible => ChromeConnectionState::Connected,
        _ => ChromeConnectionState::Ambiguous,
    }
}

fn discovery_root() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "linux")]
    if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") {
        return Some(std::path::PathBuf::from(runtime).join("verboo-in-chrome"));
    }
    dirs::cache_dir().map(|root| root.join("verboo-in-chrome"))
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    if pid > i32::MAX as u32 {
        return false;
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
