//! iOS simulator onboarding (PA-13, contract design-ios-onboarding).
//!
//! `ios_simulator_setup_*` commands drive the setup paths for the
//! Simulator panel. `detect_requirements` is the single source of truth
//! (never cached); the `SetupMode` is a SCOPE CEILING, not a step list
//! (frozen vocabulary 2026-08-19, verbatim — do not rename).
//!
//! Admin prompts always go through the macOS system dialog (`osascript
//! with administrator privileges`); the password is never captured. The
//! App Store polling (15s) is backend-driven and emits the
//! `waitingForXcode` step.
//!
//! LIMITS (declared): the parsers and the issue→step state machine are
//! unit-tested here on mac. The real `xcodebuild -downloadPlatform` run,
//! the App Store polling and the admin prompts require a real Xcode +
//! macOS runtime (field test, partially possible on the owner's mac —
//! see the PA-13 report).

use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::{detect_requirements, run_simctl, CommandRunner, IosSimulatorIssue};

/// Backend emits `ios-simulator:setup-progress` (frozen vocabulary).
pub(crate) const SETUP_PROGRESS_EVENT: &str = "ios-simulator:setup-progress";
/// Backend emits `ios-simulator:setup-done` (frozen vocabulary).
pub(crate) const SETUP_DONE_EVENT: &str = "ios-simulator:setup-done";

/// Frozen step names (design-ios-onboarding §VOCABULARIO CONGELADO).
pub(crate) const STEP_WAITING_FOR_XCODE: &str = "waitingForXcode";
pub(crate) const STEP_SELECT_XCODE: &str = "selectXcode";
pub(crate) const STEP_ACCEPT_LICENSE: &str = "acceptLicense";
pub(crate) const STEP_FIRST_LAUNCH: &str = "firstLaunch";
pub(crate) const STEP_DOWNLOAD_PLATFORM: &str = "downloadPlatform";
pub(crate) const STEP_CREATE_DEVICE: &str = "createDevice";
pub(crate) const STEP_VERIFY: &str = "verify";

/// Literal `error` value emitted when the user cancels a setup (frozen).
pub(crate) const ERROR_CANCELLED: &str = "cancelled";

/// Xcode page in the App Store.
const XCODE_APP_STORE_URL: &str = "macappstore://apps.apple.com/app/id497799835";
/// App Store polling interval while waiting for Xcode (15s, frozen).
const APP_STORE_POLL_INTERVAL: Duration = Duration::from_secs(15);
/// Budget for `xcodebuild -downloadPlatform iOS` (~7GB runtime).
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// Budget for the admin prompt (osascript waiting for the user's password).
const ADMIN_PROMPT_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Setup scope ceiling (frozen vocabulary): `'full' | 'toolchain'`.
/// The backend always derives the real steps from `detect_requirements`;
/// the mode only caps how far the automatic sequence may go.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SetupMode {
    Full,
    Toolchain,
}

/// Payload of `ios-simulator:setup-progress` (frozen vocabulary).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupProgress {
    pub step: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Payload of `ios-simulator:setup-done` (frozen vocabulary).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupDone {
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Maps the existing requirements enum to its frozen camelCase values
/// (same values as `ios_simulator_requirements`).
pub(crate) fn issue_name(issue: &IosSimulatorIssue) -> String {
    match issue {
        IosSimulatorIssue::UnsupportedPlatform => "unsupportedPlatform",
        IosSimulatorIssue::XcodeMissing => "xcodeMissing",
        IosSimulatorIssue::UnsupportedXcode => "unsupportedXcode",
        IosSimulatorIssue::SimctlMissing => "simctlMissing",
        IosSimulatorIssue::SimulatorsMissing => "simulatorsMissing",
        IosSimulatorIssue::DiscoveryFailed => "discoveryFailed",
    }
    .to_string()
}

/// Pure: the next action for a detected issue. The mode is applied by the
/// orchestrator as a ceiling — the step list always derives from here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SetupAction {
    DoneReady,
    /// Auto setup never forces a downgrade/upgrade: the renderer shows the
    /// manual guide with the detected issue.
    ManualGuide,
    WaitForXcode,
    FixToolchain,
    RuntimeOrDevice,
}

pub(crate) fn setup_action_for_issue(issue: Option<&IosSimulatorIssue>) -> SetupAction {
    match issue {
        None => SetupAction::DoneReady,
        Some(IosSimulatorIssue::UnsupportedPlatform)
        | Some(IosSimulatorIssue::UnsupportedXcode)
        | Some(IosSimulatorIssue::DiscoveryFailed) => SetupAction::ManualGuide,
        Some(IosSimulatorIssue::XcodeMissing) => SetupAction::WaitForXcode,
        Some(IosSimulatorIssue::SimctlMissing) => SetupAction::FixToolchain,
        Some(IosSimulatorIssue::SimulatorsMissing) => SetupAction::RuntimeOrDevice,
    }
}

/// Pure: extracts the download percent from an `xcodebuild -downloadPlatform`
/// progress line ("Progress: 42%", "[2/4] : Downloading ... 42%,").
/// Returns the LAST percent token found; None when the line has no percent.
pub(crate) fn parse_download_percent(line: &str) -> Option<u8> {
    let mut digits = String::new();
    let mut last: Option<u8> = None;
    for ch in line.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
        } else {
            if ch == '%' {
                if let Ok(n) = digits.parse::<u8>() {
                    last = Some(n.min(100));
                }
            }
            digits.clear();
        }
    }
    last
}

/// Pure: the model number in an iPhone device type name ("iPhone 17 Pro"
/// -> 17; "iPhone SE (3rd generation)" -> None).
pub(crate) fn iphone_model_number(name: &str) -> Option<u32> {
    name.split_whitespace().find_map(|token| token.parse::<u32>().ok())
}

/// Pure: picks the newest iPhone device type from `simctl list devicetypes
/// --json` entries (name, identifier). Newest = highest model number;
/// ties keep the FIRST occurrence (deterministic).
pub(crate) fn pick_newest_iphone_devicetype(
    devicetypes: &[(&str, &str)],
) -> Option<(String, String)> {
    let mut best: Option<(u32, &str, &str)> = None;
    for (name, identifier) in devicetypes {
        if !name.contains("iPhone") {
            continue;
        }
        let Some(number) = iphone_model_number(name) else {
            continue;
        };
        match best {
            Some((best_number, _, _)) if number <= best_number => {}
            _ => best = Some((number, name, identifier)),
        }
    }
    best.map(|(_, name, identifier)| (name.to_string(), identifier.to_string()))
}

/// Pure: parses an iOS runtime name ("iOS 26.5") into a comparable
/// (major, minor) pair. Non-iOS runtimes return None.
pub(crate) fn ios_runtime_version(name: &str) -> Option<(u32, u32)> {
    let rest = name.strip_prefix("iOS ")?;
    let mut parts = rest.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    Some((major, minor))
}

/// Pure: picks the newest iOS runtime from `simctl list runtimes --json`
/// entries (name, identifier), highest version wins.
pub(crate) fn pick_newest_ios_runtime(runtimes: &[(&str, &str)]) -> Option<(String, String)> {
    runtimes
        .iter()
        .filter_map(|(name, identifier)| ios_runtime_version(name).map(|v| (v, *name, *identifier)))
        .max_by_key(|(version, _, _)| *version)
        .map(|(_, name, identifier)| (name.to_string(), identifier.to_string()))
}

/// Opens the Xcode page in the App Store. No other effect (frozen).
pub(crate) fn open_xcode_app_store() -> Result<(), String> {
    let mut command = Command::new("open");
    command.arg(XCODE_APP_STORE_URL);
    crate::services::cli_spawn::apply_creation_flags(&mut command);
    match command.status() {
        Ok(status) if status.success() => Ok(()),
        Ok(_) => Err("failed to open the Xcode App Store page".to_string()),
        Err(error) => Err(format!("failed to open the Xcode App Store page: {error}")),
    }
}

/// Spawns the automatic setup sequence in a background thread. Emits
/// `setup-progress` / `setup-done` (frozen vocabulary).
pub(crate) fn start_setup_thread(
    app: AppHandle,
    runner: Arc<dyn CommandRunner>,
    cancel: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    mode: SetupMode,
) -> Result<(), String> {
    if running.swap(true, Ordering::SeqCst) {
        return Err("an iOS simulator setup is already running".to_string());
    }
    cancel.store(false, Ordering::SeqCst);
    thread::spawn(move || {
        run_setup(&app, runner.as_ref(), &cancel, mode);
        running.store(false, Ordering::SeqCst);
    });
    Ok(())
}

fn run_setup(
    app: &AppHandle,
    runner: &dyn CommandRunner,
    cancel: &Arc<AtomicBool>,
    mode: SetupMode,
) {
    let mut last_issue: Option<IosSimulatorIssue> = None;
    let mut toolchain_ran = false;
    loop {
        if cancel.load(Ordering::Acquire) {
            emit_done_cancelled(app);
            return;
        }
        emit_progress(app, STEP_VERIFY, None, None);
        let requirements = detect_requirements(runner);
        last_issue = requirements.issue;
        match setup_action_for_issue(requirements.issue.as_ref()) {
            SetupAction::DoneReady => {
                emit_done(app, true, None, None);
                return;
            }
            SetupAction::ManualGuide => {
                emit_done(app, false, requirements.issue, None);
                return;
            }
            SetupAction::WaitForXcode => {
                // Backend-driven App Store polling (15s, frozen): the
                // renderer only displays this step.
                emit_progress(app, STEP_WAITING_FOR_XCODE, None, None);
                wait_for_xcode_from_app_store(app, runner, cancel, &mut last_issue);
            }
            SetupAction::FixToolchain => {
                if toolchain_ran {
                    // The toolchain fix did not resolve the issue — report
                    // it instead of looping forever.
                    emit_done(app, false, requirements.issue, None);
                    return;
                }
                toolchain_ran = true;
                emit_progress(app, STEP_SELECT_XCODE, None, None);
                if fix_xcode_select(runner).is_err() {
                    emit_done(
                        app,
                        false,
                        last_issue,
                        Some("failed to select the Xcode developer directory"),
                    );
                    return;
                }
                emit_progress(app, STEP_ACCEPT_LICENSE, None, None);
                if accept_license(runner).is_err() {
                    emit_done(app, false, last_issue, Some("failed to accept the Xcode license"));
                    return;
                }
                emit_progress(app, STEP_FIRST_LAUNCH, None, None);
                if run_first_launch(runner).is_err() {
                    emit_done(
                        app,
                        false,
                        last_issue,
                        Some("failed to finalize the Xcode first launch"),
                    );
                    return;
                }
                if mode == SetupMode::Toolchain {
                    // Scope ceiling: stop after the toolchain. The loop's
                    // next `verify` reports ready or the remaining issue.
                    continue;
                }
            }
            SetupAction::RuntimeOrDevice => {
                if mode == SetupMode::Toolchain {
                    // Scope ceiling: no runtime downloads in toolchain mode.
                    emit_done(app, false, requirements.issue, None);
                    return;
                }
                if !has_ios_runtime(runner) {
                    emit_progress(app, STEP_DOWNLOAD_PLATFORM, Some(0), None);
                    match download_runtime(app, runner, cancel) {
                        Ok(()) => {}
                        Err(()) => {
                            if cancel.load(Ordering::Acquire) {
                                emit_done_cancelled(app);
                            } else {
                                emit_done(
                                    app,
                                    false,
                                    last_issue,
                                    Some("failed to download the iOS Simulator runtime"),
                                );
                            }
                            return;
                        }
                    }
                }
                // Source of truth, fresh (never cached): did the runtime
                // yield any device? If not, create the newest iPhone type.
                let after = detect_requirements(runner);
                last_issue = after.issue;
                if after.issue == Some(IosSimulatorIssue::SimulatorsMissing) {
                    emit_progress(app, STEP_CREATE_DEVICE, None, None);
                    if create_default_device(runner).is_err() {
                        emit_done(
                            app,
                            false,
                            last_issue,
                            Some("failed to create the default simulator device"),
                        );
                        return;
                    }
                }
            }
        }
    }
}

/// Backend-driven App Store polling: re-runs `detect_requirements` every
/// 15s while Xcode is missing. Returns when Xcode appears, a different
/// issue surfaces, or the user cancels.
fn wait_for_xcode_from_app_store(
    app: &AppHandle,
    runner: &dyn CommandRunner,
    cancel: &Arc<AtomicBool>,
    last_issue: &mut Option<IosSimulatorIssue>,
) {
    while !cancel.load(Ordering::Acquire) {
        thread::sleep(APP_STORE_POLL_INTERVAL);
        if cancel.load(Ordering::Acquire) {
            break;
        }
        emit_progress(app, STEP_WAITING_FOR_XCODE, None, None);
        let requirements = detect_requirements(runner);
        *last_issue = requirements.issue;
        if requirements.issue != Some(IosSimulatorIssue::XcodeMissing) {
            break;
        }
    }
}

/// Ensures `xcode-select` points at an Xcode.app (canonical or beta — the
/// switch is only needed when it points at CommandLineTools, which has no
/// simulators). The switch runs through the macOS admin dialog.
fn fix_xcode_select(runner: &dyn CommandRunner) -> Result<(), ()> {
    let current = match runner.run("xcode-select", &["-p".into()]) {
        Ok(output) if output.success => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        _ => return Err(()),
    };
    if current.contains("Xcode.app") {
        return Ok(());
    }
    run_with_admin_privileges("xcode-select --switch /Applications/Xcode.app")
}

fn accept_license(runner: &dyn CommandRunner) -> Result<(), ()> {
    // `xcodebuild -license accept` needs root — the system admin dialog
    // asks for the password (we never capture it).
    run_with_admin_privileges("xcodebuild -license accept")
}

fn run_first_launch(runner: &dyn CommandRunner) -> Result<(), ()> {
    match runner.run("xcodebuild", &["-runFirstLaunch".into()]) {
        Ok(output) if output.success => Ok(()),
        _ => Err(()),
    }
}

/// Runs a shell command through the macOS system admin prompt (osascript
/// `with administrator privileges`). The password is typed into the
/// system dialog and never captured by us.
fn run_with_admin_privileges(shell_script: &str) -> Result<(), ()> {
    let script = format!(
        "do shell script (quoted form of {:?}) with administrator privileges",
        shell_script
    );
    let mut command = Command::new("osascript");
    command.arg("-e").arg(&script);
    crate::services::cli_spawn::apply_creation_flags(&mut command);
    let mut child = command.spawn().map_err(|_| ())?;
    let deadline = Instant::now() + ADMIN_PROMPT_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return if status.success() { Ok(()) } else { Err(()) },
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(());
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return Err(()),
        }
    }
}

/// Downloads the iOS Simulator runtime with parsed progress and clean
/// cancellation (kills the xcodebuild child group within the shutdown
/// window — third-party deadline rule).
fn download_runtime(
    app: &AppHandle,
    runner: &dyn CommandRunner,
    cancel: &Arc<AtomicBool>,
) -> Result<(), ()> {
    let deadline = Instant::now() + DOWNLOAD_TIMEOUT;
    let result = runner.run_streaming(
        "xcodebuild",
        &["-downloadPlatform".into(), "iOS".into()],
        cancel,
        deadline,
        &mut |line| {
            if let Some(percent) = parse_download_percent(line) {
                emit_progress(app, STEP_DOWNLOAD_PLATFORM, Some(percent), None);
            }
        },
    );
    match result {
        Ok(output) if output.success => Ok(()),
        _ => Err(()),
    }
}

fn has_ios_runtime(runner: &dyn CommandRunner) -> bool {
    match list_runtimes(runner) {
        Ok(runtimes) => runtimes.iter().any(|(name, _)| name.contains("iOS")),
        Err(_) => false,
    }
}

fn list_runtimes(runner: &dyn CommandRunner) -> Result<Vec<(String, String)>, ()> {
    let output = run_simctl(runner, &["list".into(), "runtimes".into(), "--json".into()])
        .map_err(|_| ())?;
    let parsed: RuntimesResponse = serde_json::from_slice(&output.stdout).map_err(|_| ())?;
    Ok(parsed
        .runtimes
        .into_iter()
        .map(|entry| (entry.name, entry.identifier))
        .collect())
}

fn list_devicetypes(runner: &dyn CommandRunner) -> Result<Vec<(String, String)>, ()> {
    let output = run_simctl(runner, &["list".into(), "devicetypes".into(), "--json".into()])
        .map_err(|_| ())?;
    let parsed: DevicetypesResponse = serde_json::from_slice(&output.stdout).map_err(|_| ())?;
    Ok(parsed
        .devicetypes
        .into_iter()
        .map(|entry| (entry.name, entry.identifier))
        .collect())
}

/// Creates the newest iPhone device type on the newest installed iOS
/// runtime (design step 4).
fn create_default_device(runner: &dyn CommandRunner) -> Result<(), ()> {
    let devicetypes = list_devicetypes(runner)?;
    let runtimes = list_runtimes(runner)?;
    // The pure pickers take `&[(&str, &str)]` — borrow from the owned
    // entries for the call.
    let devicetype_refs: Vec<(&str, &str)> =
        devicetypes.iter().map(|(n, i)| (n.as_str(), i.as_str())).collect();
    let runtime_refs: Vec<(&str, &str)> =
        runtimes.iter().map(|(n, i)| (n.as_str(), i.as_str())).collect();
    let (device_name, device_type_id) =
        pick_newest_iphone_devicetype(&devicetype_refs).ok_or(())?;
    let (_, runtime_id) = pick_newest_ios_runtime(&runtime_refs).ok_or(())?;
    let output = run_simctl(
        runner,
        &[
            "create".into(),
            device_name,
            device_type_id,
            runtime_id,
        ],
    )
    .map_err(|_| ())?;
    if output.success { Ok(()) } else { Err(()) }
}

#[derive(Deserialize)]
struct RuntimesResponse {
    runtimes: Vec<RuntimeEntry>,
}

#[derive(Deserialize)]
struct RuntimeEntry {
    name: String,
    identifier: String,
}

#[derive(Deserialize)]
struct DevicetypesResponse {
    devicetypes: Vec<DeviceTypeEntry>,
}

#[derive(Deserialize)]
struct DeviceTypeEntry {
    name: String,
    identifier: String,
}

fn emit_progress(app: &AppHandle, step: &'static str, percent: Option<u8>, message: Option<&str>) {
    let _ = app.emit(
        SETUP_PROGRESS_EVENT,
        SetupProgress {
            step,
            percent,
            message: message.map(str::to_string),
        },
    );
}

fn emit_done(
    app: &AppHandle,
    ready: bool,
    issue: Option<IosSimulatorIssue>,
    error: Option<&str>,
) {
    let _ = app.emit(
        SETUP_DONE_EVENT,
        SetupDone {
            ready,
            issue: issue.as_ref().map(issue_name),
            error: error.map(str::to_string),
        },
    );
}

fn emit_done_cancelled(app: &AppHandle) {
    // Frozen: user cancellation is `{ ready: false, error: 'cancelled' }`.
    emit_done(app, false, None, Some(ERROR_CANCELLED));
}

#[cfg(test)]
mod tests {
    use super::*;
    use IosSimulatorIssue as Issue;

    #[test]
    fn download_percent_parses_common_progress_lines() {
        assert_eq!(parse_download_percent("Progress: 42%"), Some(42));
        assert_eq!(
            parse_download_percent("[2/4] : Downloading iOS 26.5 Simulator Runtime ... 42%"),
            Some(42)
        );
        assert_eq!(parse_download_percent("100%"), Some(100));
        assert_eq!(parse_download_percent("Progress: 42%,"), Some(42));
        assert_eq!(parse_download_percent("Downloading..."), None);
        assert_eq!(parse_download_percent(""), None);
    }

    #[test]
    fn setup_action_maps_issues_to_frozen_steps() {
        assert_eq!(setup_action_for_issue(None), SetupAction::DoneReady);
        assert_eq!(
            setup_action_for_issue(Some(&Issue::XcodeMissing)),
            SetupAction::WaitForXcode
        );
        assert_eq!(
            setup_action_for_issue(Some(&Issue::SimctlMissing)),
            SetupAction::FixToolchain
        );
        assert_eq!(
            setup_action_for_issue(Some(&Issue::SimulatorsMissing)),
            SetupAction::RuntimeOrDevice
        );
        for issue in [
            Issue::UnsupportedPlatform,
            Issue::UnsupportedXcode,
            Issue::DiscoveryFailed,
        ] {
            assert_eq!(
                setup_action_for_issue(Some(&issue)),
                SetupAction::ManualGuide,
                "{issue:?} must go to the manual guide (auto never forces)"
            );
        }
    }

    #[test]
    fn picks_newest_iphone_devicetype() {
        let devicetypes = [
            (
                "iPhone SE (3rd generation)",
                "com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation",
            ),
            (
                "iPhone 17 Pro",
                "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
            ),
            ("iPhone 17", "com.apple.CoreSimulator.SimDeviceType.iPhone-17"),
            (
                "iPad Pro 13-inch (M4)",
                "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4",
            ),
        ];
        let picked = pick_newest_iphone_devicetype(&devicetypes).expect("an iPhone must win");
        assert_eq!(picked.0, "iPhone 17 Pro");
        assert_eq!(picked.1, "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro");
        // No iPhones at all -> None.
        assert!(pick_newest_iphone_devicetype(&[(
            "iPad Pro 13-inch (M4)",
            "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4"
        )])
        .is_none());
    }

    #[test]
    fn picks_newest_ios_runtime() {
        let runtimes = [
            ("iOS 26.1", "com.apple.CoreSimulator.SimRuntime.iOS-26-1"),
            ("iOS 26.5", "com.apple.CoreSimulator.SimRuntime.iOS-26-5"),
            ("iOS 25.0", "com.apple.CoreSimulator.SimRuntime.iOS-25-0"),
            ("tvOS 26.5", "com.apple.CoreSimulator.SimRuntime.tvOS-26-5"),
        ];
        let picked = pick_newest_ios_runtime(&runtimes).expect("an iOS runtime must win");
        assert_eq!(picked.0, "iOS 26.5");
        assert_eq!(picked.1, "com.apple.CoreSimulator.SimRuntime.iOS-26-5");
    }

    #[test]
    fn issue_name_matches_requirements_enum_camelcase() {
        assert_eq!(issue_name(&Issue::UnsupportedPlatform), "unsupportedPlatform");
        assert_eq!(issue_name(&Issue::XcodeMissing), "xcodeMissing");
        assert_eq!(issue_name(&Issue::UnsupportedXcode), "unsupportedXcode");
        assert_eq!(issue_name(&Issue::SimctlMissing), "simctlMissing");
        assert_eq!(issue_name(&Issue::SimulatorsMissing), "simulatorsMissing");
        assert_eq!(issue_name(&Issue::DiscoveryFailed), "discoveryFailed");
    }

    #[test]
    fn percent_only_carries_on_download_platform_steps() {
        // The orchestrator only passes Some(percent) on the download step;
        // other steps stay percent-less (frozen contract).
        let progress = SetupProgress {
            step: STEP_WAITING_FOR_XCODE,
            percent: None,
            message: None,
        };
        let json = serde_json::to_value(progress).expect("serialize");
        assert!(json.get("percent").is_none(), "non-download steps carry no percent");
        assert_eq!(
            json["step"],
            serde_json::Value::String("waitingForXcode".to_string()),
        );
    }

    /// Frozen vocabulary is load-bearing: the event names, step literals
    /// and the cancellation literal must stay EXACTLY as the renderer
    /// expects (design-ios-onboarding §VOCABULARIO CONGELADO). Mutation:
    /// rename any literal below → this test FAILS.
    #[test]
    fn frozen_vocabulary_literals_are_pinned() {
        assert_eq!(SETUP_PROGRESS_EVENT, "ios-simulator:setup-progress");
        assert_eq!(SETUP_DONE_EVENT, "ios-simulator:setup-done");
        assert_eq!(STEP_WAITING_FOR_XCODE, "waitingForXcode");
        assert_eq!(STEP_SELECT_XCODE, "selectXcode");
        assert_eq!(STEP_ACCEPT_LICENSE, "acceptLicense");
        assert_eq!(STEP_FIRST_LAUNCH, "firstLaunch");
        assert_eq!(STEP_DOWNLOAD_PLATFORM, "downloadPlatform");
        assert_eq!(STEP_CREATE_DEVICE, "createDevice");
        assert_eq!(STEP_VERIFY, "verify");
        assert_eq!(ERROR_CANCELLED, "cancelled");
    }

    /// The mode ceiling serializes to the frozen values 'full' | 'toolchain'.
    #[test]
    fn setup_mode_serializes_to_frozen_values() {
        assert_eq!(serde_json::to_string(&SetupMode::Full).unwrap(), "\"full\"");
        assert_eq!(serde_json::to_string(&SetupMode::Toolchain).unwrap(), "\"toolchain\"");
    }
}
