//! OS privacy permission probe for Computer Use (macOS TCC).
//!
//! Used by the P0.2b poller so we do **not** spawn `computer-use-helper`
//! every 5s. Helper spawn is reserved for AX actions (and will become
//! long-lived in P0.1b).

/// Snapshot of the two TCC permissions required for Computer Use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TccStatus {
    pub accessibility: bool,
    pub screen_recording: bool,
}

impl TccStatus {
    pub fn both_granted(self) -> bool {
        self.accessibility && self.screen_recording
    }
}

/// Probe current process TCC grants without spawning the helper sidecar.
///
/// On non-macOS targets returns both granted (CU is macOS-only in P0).
pub fn probe_tcc_status() -> TccStatus {
    #[cfg(target_os = "macos")]
    {
        macos::probe()
    }
    #[cfg(not(target_os = "macos"))]
    {
        TccStatus {
            accessibility: true,
            screen_recording: true,
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::TccStatus;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
    }

    pub fn probe() -> TccStatus {
        // AXIsProcessTrusted returns a Boolean (unsigned char). Non-zero = trusted.
        let accessibility = unsafe { AXIsProcessTrusted() } != 0;
        let screen_recording = unsafe { CGPreflightScreenCaptureAccess() };
        TccStatus {
            accessibility,
            screen_recording,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_returns_struct() {
        let status = probe_tcc_status();
        // Host-dependent on macOS; only assert the call is safe.
        let _ = status.both_granted();
    }
}
