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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControllerPermissionRequestStep {
    Accessibility,
    ScreenRecording,
}

pub fn controller_permission_request_steps() -> [ControllerPermissionRequestStep; 2] {
    [
        ControllerPermissionRequestStep::Accessibility,
        ControllerPermissionRequestStep::ScreenRecording,
    ]
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

/// Ask Accessibility TCC for the identity of the current controller app.
///
/// This call intentionally runs in the Tauri process so macOS registers
/// `Verboo Code.app`, not a raw sidecar or the independent action agent.
pub fn request_controller_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::request_accessibility()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
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

fn request_screen_recording_with<Preflight, LegacyRequest, ScreenCaptureKitRequest>(
    preflight: Preflight,
    legacy_request: LegacyRequest,
    screen_capture_kit_request: ScreenCaptureKitRequest,
) -> bool
where
    Preflight: Fn() -> bool,
    LegacyRequest: Fn() -> bool,
    ScreenCaptureKitRequest: Fn(),
{
    if preflight() {
        return true;
    }
    screen_capture_kit_request();
    if preflight() {
        return true;
    }
    let _ = legacy_request();
    preflight()
}

pub fn request_controller_permissions() -> TccStatus {
    let mut status = TccStatus {
        accessibility: false,
        screen_recording: false,
    };

    for step in controller_permission_request_steps() {
        match step {
            ControllerPermissionRequestStep::Accessibility => {
                status.accessibility = request_controller_accessibility();
            }
            ControllerPermissionRequestStep::ScreenRecording => {
                status.screen_recording = request_controller_screen_recording();
            }
        }
    }

    status
}

#[cfg(target_os = "macos")]
mod macos {
    use super::TccStatus;
    use block2::RcBlock;
    use objc2::{rc::Retained, AnyThread};
    use objc2_foundation::{NSArray, NSError};
    use objc2_screen_capture_kit::{
        SCContentFilter, SCShareableContent, SCStream, SCStreamConfiguration, SCWindow,
    };
    use std::ffi::c_void;
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> u8;
        static kAXTrustedCheckOptionPrompt: *const c_void;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFDictionaryCreateMutable(
            allocator: *const c_void,
            capacity: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *mut c_void;
        fn CFDictionarySetValue(
            dictionary: *mut c_void,
            key: *const c_void,
            value: *const c_void,
        );
        fn CFRelease(value: *const c_void);
        static kCFBooleanTrue: *const c_void;
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

    pub fn request_accessibility() -> bool {
        unsafe {
            let options = CFDictionaryCreateMutable(
                std::ptr::null(),
                1,
                std::ptr::null(),
                std::ptr::null(),
            );
            if options.is_null() {
                return AXIsProcessTrusted() != 0;
            }
            CFDictionarySetValue(options, kAXTrustedCheckOptionPrompt, kCFBooleanTrue);
            let trusted = AXIsProcessTrustedWithOptions(options.cast_const()) != 0;
            CFRelease(options.cast_const());
            trusted
        }
    }

    pub fn request_screen_recording() -> bool {
        super::request_screen_recording_with(
            || unsafe { CGPreflightScreenCaptureAccess() },
            || unsafe { CGRequestScreenCaptureAccess() },
            request_screen_capture_kit,
        )
    }

    fn request_screen_capture_kit() {
        let completion = Arc::new((Mutex::new(false), Condvar::new()));
        let callback_completion = Arc::clone(&completion);
        let completion_handler = RcBlock::new(
            move |content: *mut SCShareableContent, _error: *mut NSError| {
                let Some(content) = (unsafe { Retained::retain(content) }) else {
                    mark_completed(&callback_completion);
                    return;
                };
                let displays = unsafe { content.displays() };
                let Some(display) = displays.firstObject() else {
                    mark_completed(&callback_completion);
                    return;
                };
                let excluded_windows = NSArray::<SCWindow>::from_slice(&[]);
                let filter = unsafe {
                    SCContentFilter::initWithDisplay_excludingWindows(
                        SCContentFilter::alloc(),
                        &display,
                        &excluded_windows,
                    )
                };
                let configuration = unsafe { SCStreamConfiguration::new() };
                unsafe {
                    configuration.setWidth(2);
                    configuration.setHeight(2);
                    configuration.setShowsCursor(false);
                    configuration.setCapturesAudio(false);
                }
                let stream = unsafe {
                    SCStream::initWithFilter_configuration_delegate(
                        SCStream::alloc(),
                        &filter,
                        &configuration,
                        None,
                    )
                };
                let start_completion = Arc::clone(&callback_completion);
                let stream_to_stop = stream.clone();
                let start_handler = RcBlock::new(move |error: *mut NSError| {
                    if !error.is_null() {
                        mark_completed(&start_completion);
                        return;
                    }
                    let stop_completion = Arc::clone(&start_completion);
                    let stop_handler = RcBlock::new(move |_error: *mut NSError| {
                        mark_completed(&stop_completion);
                    });
                    unsafe {
                        stream_to_stop.stopCaptureWithCompletionHandler(Some(&stop_handler));
                    }
                });
                unsafe {
                    stream.startCaptureWithCompletionHandler(Some(&start_handler));
                }
            },
        );

        unsafe {
            SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
                true,
                true,
                &completion_handler,
            );
        }

        let (lock, condition) = &*completion;
        let completed = lock.lock().unwrap_or_else(|error| error.into_inner());
        let _ = condition.wait_timeout_while(
            completed,
            Duration::from_secs(4),
            |completed| !*completed,
        );
    }

    fn mark_completed(completion: &Arc<(Mutex<bool>, Condvar)>) {
        let (lock, condition) = &**completion;
        let mut completed = lock.lock().unwrap_or_else(|error| error.into_inner());
        *completed = true;
        condition.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controller_permission_requests_run_in_process_before_the_agent_request() {
        assert_eq!(
            controller_permission_request_steps(),
            [
                ControllerPermissionRequestStep::Accessibility,
                ControllerPermissionRequestStep::ScreenRecording,
            ],
        );
    }

    #[test]
    fn screen_recording_request_uses_screen_capture_kit_before_legacy_fallback() {
        let legacy_requests = std::cell::Cell::new(0);
        let screen_capture_kit_requests = std::cell::Cell::new(0);
        let preflight_checks = std::cell::Cell::new(0);

        let granted = request_screen_recording_with(
            || {
                let check = preflight_checks.get() + 1;
                preflight_checks.set(check);
                check > 1
            },
            || {
                legacy_requests.set(legacy_requests.get() + 1);
                false
            },
            || {
                screen_capture_kit_requests.set(screen_capture_kit_requests.get() + 1);
            },
        );

        assert!(granted);
        assert_eq!(legacy_requests.get(), 0);
        assert_eq!(screen_capture_kit_requests.get(), 1);
        assert_eq!(preflight_checks.get(), 2);
    }

    #[test]
    fn screen_recording_request_uses_legacy_api_only_after_screen_capture_kit() {
        let events = std::cell::RefCell::new(Vec::new());

        let granted = request_screen_recording_with(
            || {
                events.borrow_mut().push("preflight");
                false
            },
            || {
                events.borrow_mut().push("legacy");
                false
            },
            || {
                events.borrow_mut().push("screen-capture-kit");
            },
        );

        assert!(!granted);
        assert_eq!(
            events.into_inner(),
            [
                "preflight",
                "screen-capture-kit",
                "preflight",
                "legacy",
                "preflight",
            ]
        );
    }

    #[test]
    fn screen_recording_request_stops_when_preflight_is_already_granted() {
        let legacy_requests = std::cell::Cell::new(0);
        let screen_capture_kit_requests = std::cell::Cell::new(0);

        let granted = request_screen_recording_with(
            || true,
            || {
                legacy_requests.set(legacy_requests.get() + 1);
                false
            },
            || {
                screen_capture_kit_requests.set(screen_capture_kit_requests.get() + 1);
            },
        );

        assert!(granted);
        assert_eq!(legacy_requests.get(), 0);
        assert_eq!(screen_capture_kit_requests.get(), 0);
    }

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
