//! Android emulator requirements detection (PA-24, contract
//! `contrato-android-simulator`). `detect_requirements` is the single
//! source of truth (never cached). Probes are platform-specific
//! (`#[cfg]` per SO); the probe→issue decision is a pure function so every
//! combination is unit-testable on any host.
//!
//! LIMITS (declared): the real probes (adb/emulator/sdkmanager binaries,
//! WHPX/KVM acceleration) require a real Android SDK + the target OS —
//! exercised by CI (3 OSes) and the field test on the owner's mac. On mac
//! only the pure logic and the macOS probes compile/run.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::CommandRunner;

/// Frozen issue enum (contract §Deteccao, camelCase — do not rename).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AndroidEmulatorIssue {
    SdkMissing,
    AdbMissing,
    EmulatorMissing,
    SystemImageMissing,
    AvdMissing,
    AccelMissing,
    LicensesNotAccepted,
    DiscoveryFailed,
    UnsupportedPlatform,
}

/// Frozen device family (contract §AndroidDevice).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AndroidDeviceFamily {
    Phone,
    Tablet,
    Other,
}

/// Frozen device entry (contract §AndroidDevice).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AndroidDevice {
    pub avd_name: String,
    pub display_name: String,
    pub api_level: u32,
    pub family: AndroidDeviceFamily,
    pub running: bool,
}

/// Frozen requirements payload (contract §Deteccao).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidEmulatorRequirements {
    pub ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<AndroidEmulatorIssue>,
    pub devices: Vec<AndroidDevice>,
}

/// Pure: maps the probe results to the first failing issue, in the frozen
/// probe order platform→sdk→adb→emulator→licenses→systemImage→avd→accel.
/// `None` = all probes pass (ready). Kept free of `#[cfg]` so every
/// combination is unit-testable on any host.
pub fn decide_issue(
    platform_ok: bool,
    sdk_ok: bool,
    adb_ok: bool,
    emulator_ok: bool,
    licenses_ok: bool,
    system_image_ok: bool,
    avd_ok: bool,
    accel_ok: bool,
) -> Option<AndroidEmulatorIssue> {
    if !platform_ok {
        return Some(AndroidEmulatorIssue::UnsupportedPlatform);
    }
    if !sdk_ok {
        return Some(AndroidEmulatorIssue::SdkMissing);
    }
    if !adb_ok {
        return Some(AndroidEmulatorIssue::AdbMissing);
    }
    if !emulator_ok {
        return Some(AndroidEmulatorIssue::EmulatorMissing);
    }
    if !licenses_ok {
        return Some(AndroidEmulatorIssue::LicensesNotAccepted);
    }
    if !system_image_ok {
        return Some(AndroidEmulatorIssue::SystemImageMissing);
    }
    if !avd_ok {
        return Some(AndroidEmulatorIssue::AvdMissing);
    }
    if !accel_ok {
        return Some(AndroidEmulatorIssue::AccelMissing);
    }
    None
}

/// Pure: parses `emulator -list-avds` output (one AVD name per line).
pub fn parse_avd_list(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// Pure: parses `adb devices` output into the running emulator serials
/// (lines like `emulator-5554\tdevice`).
pub fn parse_adb_devices(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| {
            let serial = line.split_whitespace().next()?;
            if serial.starts_with("emulator-") {
                Some(serial.to_string())
            } else {
                None
            }
        })
        .collect()
}

/// Pure: parses `adb -s <serial> emu avd name` output ("avd name: Pixel_8"
/// or just "Pixel_8") into the AVD name.
pub fn parse_avd_name_from_emu(output: &str) -> Option<String> {
    let line = output.lines().next()?.trim();
    let name = line.strip_prefix("avd name:").unwrap_or(line).trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Pure: infers the API level from an AVD name ("Pixel_8_API_35" → 35;
/// "Pixel_8" → 8). Prefers the number after "API"; falls back to the last
/// number in the name; 0 when none.
pub fn api_level_from_name(name: &str) -> u32 {
    let tokens: Vec<&str> = name.split(['_', '-', ' ']).collect();
    if let Some(idx) = tokens.iter().position(|t| t.eq_ignore_ascii_case("api")) {
        if let Some(next) = tokens.get(idx + 1) {
            if let Ok(level) = next.parse::<u32>() {
                return level;
            }
        }
    }
    tokens
        .iter()
        .rev()
        .find_map(|token| token.parse::<u32>().ok())
        .unwrap_or(0)
}

/// Pure: infers the device family from an AVD name (heuristic — the
/// authoritative source is the AVD config, read in F1).
pub fn android_device_family(name: &str) -> AndroidDeviceFamily {
    let lower = name.to_ascii_lowercase();
    if lower.contains("tablet") || lower.contains("pad") {
        AndroidDeviceFamily::Tablet
    } else if lower.contains("phone")
        || lower.contains("pixel")
        || lower.contains("nexus")
        || lower.contains("galaxy")
    {
        AndroidDeviceFamily::Phone
    } else {
        AndroidDeviceFamily::Other
    }
}

/// Detects Android emulator requirements (frozen contract). Single source
/// of truth, never cached. Probes short-circuit in the frozen order; the
/// decision is delegated to the pure `decide_issue`.
pub(crate) fn detect_requirements(
    runner: &dyn CommandRunner,
    sdk_path: &Path,
) -> AndroidEmulatorRequirements {
    let mut requirements = AndroidEmulatorRequirements {
        ready: false,
        issue: None,
        devices: Vec::new(),
    };

    let platform_ok = is_supported_platform();
    let sdk_ok = platform_ok && sdk_path.exists();
    let adb_ok = sdk_ok && adb_probe(runner, sdk_path);
    let emulator_ok = adb_ok && emulator_binary_exists(sdk_path);
    let licenses_ok = emulator_ok && licenses_accepted(sdk_path);
    let system_image_ok = licenses_ok && has_system_image(sdk_path);
    let mut avd_list: Vec<String> = Vec::new();
    let avd_ok = system_image_ok && {
        avd_list = list_avds(runner, sdk_path);
        !avd_list.is_empty()
    };
    let accel_ok = avd_ok && accel_available();

    let issue = decide_issue(
        platform_ok,
        sdk_ok,
        adb_ok,
        emulator_ok,
        licenses_ok,
        system_image_ok,
        avd_ok,
        accel_ok,
    );
    if let Some(issue) = issue {
        requirements.issue = Some(issue);
        return requirements;
    }

    let running = running_avd_names(runner, sdk_path);
    requirements.devices = avd_list
        .into_iter()
        .map(|avd_name| AndroidDevice {
            display_name: avd_name.clone(),
            api_level: api_level_from_name(&avd_name),
            family: android_device_family(&avd_name),
            running: running.contains(&avd_name),
            avd_name,
        })
        .collect();
    requirements.ready = true;
    requirements
}

fn is_supported_platform() -> bool {
    cfg!(any(
        target_os = "macos",
        target_os = "windows",
        target_os = "linux"
    ))
}

/// `adb version` succeeds → adb is present in the SDK.
fn adb_probe(runner: &dyn CommandRunner, sdk_path: &Path) -> bool {
    let adb = sdk_path.join("platform-tools").join(adb_executable());
    if !adb.is_file() {
        return false;
    }
    match runner.run(adb.to_string_lossy().as_ref(), &["version".to_string()]) {
        Ok(output) => output.success,
        Err(_) => false,
    }
}

fn emulator_binary_exists(sdk_path: &Path) -> bool {
    sdk_path
        .join("emulator")
        .join(emulator_executable())
        .is_file()
}

/// Licenses are accepted when the SDK root has the `licenses/android-sdk-license`
/// marker file (written by `sdkmanager --licenses` after acceptance).
fn licenses_accepted(sdk_path: &Path) -> bool {
    let marker = sdk_path.join("licenses").join("android-sdk-license");
    marker.is_file()
}

/// Any installed system image (non-empty `system-images/` tree).
fn has_system_image(sdk_path: &Path) -> bool {
    let images = sdk_path.join("system-images");
    let Ok(entries) = std::fs::read_dir(&images) else {
        return false;
    };
    entries.flatten().next().is_some()
}

/// `emulator -list-avds` → the installed AVD names.
fn list_avds(runner: &dyn CommandRunner, sdk_path: &Path) -> Vec<String> {
    let emulator = sdk_path.join("emulator").join(emulator_executable());
    match runner.run(
        emulator.to_string_lossy().as_ref(),
        &["-list-avds".to_string()],
    ) {
        Ok(output) if output.success => parse_avd_list(&String::from_utf8_lossy(&output.stdout)),
        _ => Vec::new(),
    }
}

/// Names of the AVDs currently booted (via `adb devices` + `emu avd name`).
fn running_avd_names(runner: &dyn CommandRunner, sdk_path: &Path) -> Vec<String> {
    let adb = sdk_path.join("platform-tools").join(adb_executable());
    let Ok(output) = runner.run(adb.to_string_lossy().as_ref(), &["devices".to_string()]) else {
        return Vec::new();
    };
    let serials = parse_adb_devices(&String::from_utf8_lossy(&output.stdout));
    let mut names = Vec::new();
    for serial in serials {
        let args = vec![
            "-s".to_string(),
            serial,
            "emu".to_string(),
            "avd".to_string(),
            "name".to_string(),
        ];
        if let Ok(out) = runner.run(adb.to_string_lossy().as_ref(), &args) {
            if let Some(name) = parse_avd_name_from_emu(&String::from_utf8_lossy(&out.stdout)) {
                names.push(name);
            }
        }
    }
    names
}

fn adb_executable() -> &'static str {
    if cfg!(windows) {
        "adb.exe"
    } else {
        "adb"
    }
}

fn emulator_executable() -> &'static str {
    if cfg!(windows) {
        "emulator.exe"
    } else {
        "emulator"
    }
}

/// Acceleration probe, per SO (contract §Deteccao):
/// - macOS: Hypervisor.framework — `sysctl kern.hv_support` == 1.
/// - Windows: WHPX — `WinHvPlatform.dll` present (fast proxy; the real
///   feature state is validated in CI/field — enabling is always guided).
/// - Linux: `/dev/kvm` exists AND is openable (kvm group membership).
#[cfg(target_os = "macos")]
fn accel_available() -> bool {
    let mut command = std::process::Command::new("sysctl");
    command.arg("kern.hv_support");
    crate::services::cli_spawn::apply_creation_flags(&mut command);
    match command.output() {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).contains("1")
        }
        _ => false,
    }
}

#[cfg(target_os = "windows")]
fn accel_available() -> bool {
    Path::new("C:\\Windows\\System32\\WinHvPlatform.dll").exists()
}

#[cfg(target_os = "linux")]
fn accel_available() -> bool {
    let kvm = Path::new("/dev/kvm");
    if !kvm.exists() {
        return false;
    }
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(kvm)
        .is_ok()
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn accel_available() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use AndroidEmulatorIssue as Issue;

    #[test]
    fn decide_issue_follows_frozen_probe_order() {
        // All pass → ready.
        assert_eq!(
            decide_issue(true, true, true, true, true, true, true, true),
            None
        );
        // First failing probe wins, in the frozen order.
        assert_eq!(
            decide_issue(false, true, true, true, true, true, true, true),
            Some(Issue::UnsupportedPlatform)
        );
        assert_eq!(
            decide_issue(true, false, true, true, true, true, true, true),
            Some(Issue::SdkMissing)
        );
        assert_eq!(
            decide_issue(true, true, false, true, true, true, true, true),
            Some(Issue::AdbMissing)
        );
        assert_eq!(
            decide_issue(true, true, true, false, true, true, true, true),
            Some(Issue::EmulatorMissing)
        );
        assert_eq!(
            decide_issue(true, true, true, true, false, true, true, true),
            Some(Issue::LicensesNotAccepted)
        );
        assert_eq!(
            decide_issue(true, true, true, true, true, false, true, true),
            Some(Issue::SystemImageMissing)
        );
        assert_eq!(
            decide_issue(true, true, true, true, true, true, false, true),
            Some(Issue::AvdMissing)
        );
        assert_eq!(
            decide_issue(true, true, true, true, true, true, true, false),
            Some(Issue::AccelMissing)
        );
        // Multiple failures → the earliest in the order wins.
        assert_eq!(
            decide_issue(true, false, false, false, false, false, false, false),
            Some(Issue::SdkMissing)
        );
    }

    #[test]
    fn parses_avd_list_output() {
        assert_eq!(
            parse_avd_list("Pixel_8_API_35\nPixel_Tablet_API_34\n\n"),
            vec![
                "Pixel_8_API_35".to_string(),
                "Pixel_Tablet_API_34".to_string()
            ]
        );
        assert_eq!(parse_avd_list(""), Vec::<String>::new());
    }

    #[test]
    fn parses_adb_devices_output() {
        let output = "List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\n\n";
        assert_eq!(
            parse_adb_devices(output),
            vec!["emulator-5554".to_string(), "emulator-5556".to_string()]
        );
        assert_eq!(
            parse_adb_devices("List of devices attached\n\n"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn parses_avd_name_from_emu_output() {
        assert_eq!(
            parse_avd_name_from_emu("avd name: Pixel_8_API_35\n"),
            Some("Pixel_8_API_35".to_string())
        );
        assert_eq!(
            parse_avd_name_from_emu("Pixel_8_API_35\n"),
            Some("Pixel_8_API_35".to_string())
        );
        assert_eq!(parse_avd_name_from_emu(""), None);
    }

    #[test]
    fn infers_api_level_from_avd_name() {
        assert_eq!(api_level_from_name("Pixel_8_API_35"), 35);
        assert_eq!(api_level_from_name("Pixel_8"), 8);
        assert_eq!(api_level_from_name("no_numbers"), 0);
    }

    #[test]
    fn infers_device_family_from_avd_name() {
        assert_eq!(
            android_device_family("Pixel_8_API_35"),
            AndroidDeviceFamily::Phone
        );
        assert_eq!(
            android_device_family("Pixel_Tablet_API_34"),
            AndroidDeviceFamily::Tablet
        );
        assert_eq!(
            android_device_family("my_custom_avd"),
            AndroidDeviceFamily::Other
        );
    }

    /// Frozen issue names are load-bearing (contract §Deteccao): renaming a
    /// variant below FAILS this test.
    #[test]
    fn issue_names_serialize_to_frozen_values() {
        assert_eq!(
            serde_json::to_string(&Issue::SdkMissing).unwrap(),
            "\"sdkMissing\""
        );
        assert_eq!(
            serde_json::to_string(&Issue::AdbMissing).unwrap(),
            "\"adbMissing\""
        );
        assert_eq!(
            serde_json::to_string(&Issue::EmulatorMissing).unwrap(),
            "\"emulatorMissing\""
        );
        assert_eq!(
            serde_json::to_string(&Issue::SystemImageMissing).unwrap(),
            "\"systemImageMissing\""
        );
        assert_eq!(
            serde_json::to_string(&Issue::AvdMissing).unwrap(),
            "\"avdMissing\""
        );
        assert_eq!(
            serde_json::to_string(&Issue::AccelMissing).unwrap(),
            "\"accelMissing\""
        );
        assert_eq!(
            serde_json::to_string(&Issue::LicensesNotAccepted).unwrap(),
            "\"licensesNotAccepted\""
        );
        assert_eq!(
            serde_json::to_string(&Issue::DiscoveryFailed).unwrap(),
            "\"discoveryFailed\""
        );
        assert_eq!(
            serde_json::to_string(&Issue::UnsupportedPlatform).unwrap(),
            "\"unsupportedPlatform\""
        );
    }

    #[test]
    fn device_family_serializes_to_frozen_values() {
        assert_eq!(
            serde_json::to_string(&AndroidDeviceFamily::Phone).unwrap(),
            "\"phone\""
        );
        assert_eq!(
            serde_json::to_string(&AndroidDeviceFamily::Tablet).unwrap(),
            "\"tablet\""
        );
        assert_eq!(
            serde_json::to_string(&AndroidDeviceFamily::Other).unwrap(),
            "\"other\""
        );
    }
}
