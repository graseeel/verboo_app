use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};

use crate::services::computer_use_spawn::ComputerUseSpawn;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct FocusLease {
    session_id: String,
    pid: u32,
}

fn runtime_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or("no application data directory")?;
    Ok(base.join("ai.verboo.code.desktop").join("computer-use-runtime"))
}

fn lease_path() -> Result<PathBuf, String> {
    Ok(runtime_dir()?.join("focus.json"))
}

fn read_lease() -> Result<Option<FocusLease>, String> {
    match fs::read(lease_path()?) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn write_lease(lease: &FocusLease) -> Result<(), String> {
    let dir = runtime_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = lease_path()?;
    fs::write(&path, serde_json::to_vec(lease).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn start(session_id: &str, app: &str, capability_path: &Path) -> Result<(), String> {
    stop_any()?;

    let mut spawn = ComputerUseSpawn::new();
    spawn
        .command
        .arg("--focus-session")
        .arg(app)
        .arg(capability_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = spawn
        .command
        .spawn()
        .map_err(|e| format!("start focus HUD: {e}"))?;
    let stdout = child.stdout.take().ok_or("focus HUD has no stdout")?;
    let mut reader = BufReader::new(stdout);
    let mut ready = String::new();
    reader
        .read_line(&mut ready)
        .map_err(|e| format!("read focus HUD readiness: {e}"))?;
    if !ready.contains("focus-ready") {
        let stderr = child
            .stderr
            .take()
            .and_then(|mut stream| {
                use std::io::Read;
                let mut value = String::new();
                stream.read_to_string(&mut value).ok().map(|_| value)
            })
            .unwrap_or_default();
        let _ = child.kill();
        return Err(format!("focus HUD did not become ready: {stderr}"));
    }

    let lease = FocusLease {
        session_id: session_id.to_string(),
        pid: child.id(),
    };
    if let Err(error) = write_lease(&lease) {
        let _ = child.kill();
        return Err(error);
    }

    std::thread::spawn(move || {
        let pid = child.id();
        let _ = child.wait();
        if read_lease().ok().flatten().is_some_and(|lease| lease.pid == pid) {
            if let Ok(path) = lease_path() {
                let _ = fs::remove_file(path);
            }
        }
    });
    Ok(())
}

pub fn stop(expected_session_id: &str) -> Result<bool, String> {
    let Some(lease) = read_lease()? else {
        return Ok(true);
    };
    if lease.session_id != expected_session_id {
        return Ok(false);
    }
    stop_lease(&lease)?;
    Ok(true)
}

pub fn stop_any() -> Result<(), String> {
    if let Some(lease) = read_lease()? {
        stop_lease(&lease)?;
    }
    Ok(())
}

fn stop_lease(lease: &FocusLease) -> Result<(), String> {
    #[cfg(unix)] {
        let result = unsafe { libc::kill(lease.pid as i32, libc::SIGTERM) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(format!("stop focus HUD: {error}"));
            }
        }
    }
    if let Ok(path) = lease_path() {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focus_lease_is_bound_to_one_session() {
        let lease = FocusLease {
            session_id: "authorized".into(),
            pid: 42,
        };
        assert_eq!(lease.session_id, "authorized");
        assert_ne!(lease.session_id, "another-session");
    }

    #[test]
    fn focus_lease_round_trips_without_extra_authority() {
        let lease = FocusLease {
            session_id: "session-1".into(),
            pid: 99,
        };
        let value = serde_json::to_value(&lease).unwrap();
        assert_eq!(value, serde_json::json!({"session_id":"session-1","pid":99}));
        assert!(value.get("app").is_none());
        assert!(value.get("token").is_none());
    }
}
