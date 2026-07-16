//! OS privacy permission probe for Computer Use (macOS TCC).
//!
//! Verboo has two real TCC identities on macOS: the controller app and the
//! independently launched `Verboo Computer Use.app` agent. Both must remain
//! authorized because the controller owns the focus/emergency subprocesses
//! while the agent owns screenshots and input actions.

use serde_json::{json, Value};

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

pub fn combine(controller: TccStatus, agent: TccStatus) -> TccStatus {
    TccStatus {
        accessibility: controller.accessibility && agent.accessibility,
        screen_recording: controller.screen_recording && agent.screen_recording,
    }
}

fn permission_word(granted: bool) -> &'static str {
    if granted {
        "granted"
    } else {
        "missing"
    }
}

pub fn permission_payload(controller: TccStatus, agent: TccStatus) -> Value {
    let combined = combine(controller, agent);
    json!({
        "accessibility": permission_word(combined.accessibility),
        "screenRecording": permission_word(combined.screen_recording),
        "controller": {
            "accessibility": permission_word(controller.accessibility),
            "screenRecording": permission_word(controller.screen_recording),
        },
        "agent": {
            "accessibility": permission_word(agent.accessibility),
            "screenRecording": permission_word(agent.screen_recording),
        },
    })
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

/// Ask Screen Recording TCC for the identity of the current controller app.
///
/// This call intentionally runs in the Tauri process instead of a raw child
/// executable so macOS attributes the grant to `Verboo Code.app`.
pub fn request_controller_screen_recording() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::request_screen_recording()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
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
        fn CGRequestScreenCaptureAccess() -> bool;
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

    pub fn request_screen_recording() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combined_authority_requires_controller_and_agent_grants() {
        let granted = TccStatus {
            accessibility: true,
            screen_recording: true,
        };
        let missing_accessibility = TccStatus {
            accessibility: false,
            screen_recording: true,
        };

        assert_eq!(combine(granted, granted), granted);
        assert_eq!(
            combine(granted, missing_accessibility),
            missing_accessibility
        );
        assert_eq!(
            combine(missing_accessibility, granted),
            missing_accessibility
        );
    }

    #[test]
    fn permission_payload_exposes_each_real_tcc_identity() {
        let controller = TccStatus {
            accessibility: true,
            screen_recording: false,
        };
        let agent = TccStatus {
            accessibility: false,
            screen_recording: true,
        };

        let payload = permission_payload(controller, agent);

        assert_eq!(payload["accessibility"], "missing");
        assert_eq!(payload["screenRecording"], "missing");
        assert_eq!(payload["controller"]["accessibility"], "granted");
        assert_eq!(payload["controller"]["screenRecording"], "missing");
        assert_eq!(payload["agent"]["accessibility"], "missing");
        assert_eq!(payload["agent"]["screenRecording"], "granted");
    }

    #[test]
    fn probe_returns_struct() {
        let status = probe_tcc_status();
        // Host-dependent on macOS; only assert the call is safe.
        let _ = status.both_granted();
    }
}
