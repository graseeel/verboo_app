use std::process::Child;

/// Sends an interrupt signal (SIGINT on Unix, Ctrl+C on Windows) to a child
/// process. Falls back to `child.kill()` if signal delivery fails.
///
/// On Windows, the child must have been created with
/// `CREATE_NEW_PROCESS_GROUP` so `GenerateConsoleCtrlEvent` can target its
/// group. If it wasn't, we fall back to `TerminateProcess`.
pub fn interrupt_child(child: &mut Child) -> Result<(), String> {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        if pid > 0 {
            // SAFETY: kill(pid, SIGINT) is async-signal-safe for valid pid.
            let rc = unsafe { libc::kill(pid, libc::SIGINT) };
            if rc == 0 {
                return Ok(());
            }
        }
    }

    #[cfg(windows)]
    {
        // The child must have been spawned with CREATE_NEW_PROCESS_GROUP;
        // in that case the child's PID is also its process-group ID.
        let raw_pid = child.id();
        let rc = unsafe {
            windows_sys::Win32::System::Console::GenerateConsoleCtrlEvent(
                windows_sys::Win32::System::Console::CTRL_C_EVENT,
                raw_pid,
            )
        };
        if rc != 0 {
            return Ok(());
        }
    }

    child
        .kill()
        .map_err(|e| format!("Falha ao interromper processo: {e}"))
}

/// Returns the process creation flags required for interrupt on Windows.
#[cfg(windows)]
pub fn process_creation_flags() -> u32 {
    // CREATE_NEW_PROCESS_GROUP so GenerateConsoleCtrlEvent can target the
    // child group with CTRL_C_EVENT.
    windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP
}

#[cfg(not(windows))]
#[allow(dead_code)]
pub fn process_creation_flags() -> u32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creation_flags_zero_on_non_windows() {
        #[cfg(not(windows))]
        assert_eq!(process_creation_flags(), 0);
    }
}
