//! Android SDK management (PA-24, contract `contrato-android-simulator`).
//! SDK path resolution, cmdline-tools download, sdkmanager/avdmanager
//! helpers, and the pure parsers (progress, URL selection, system image).
//!
//! LIMITS (declared): downloads use `curl` (present on macOS, Windows 10+
//! and most Linux distros) and `unzip`/`tar`; sdkmanager/avdmanager need a
//! JRE on the host. The real download/install runs are exercised by CI
//! (3 OSes) and the field test on the owner's mac.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use super::CommandRunner;

/// Pinned public Google build of the command-line tools. All four variants
/// (mac_arm64/mac_x86_64/linux/win) exist for this build (verified
/// 2026-08-19). Public artifact, not owner-specific.
pub const CMDLINE_TOOLS_VERSION: &str = "15859902";

/// Pure: the public cmdline-tools download URL for a host (os, arch).
/// mac uses the arch-specific variant (mac_arm64/mac_x86_64); the download
/// helper falls back to the universal `mac` URL if the variant 404s
/// (Google changed the naming across builds).
pub fn cmdline_tools_url(os: &str, arch: &str) -> String {
    let token = match os {
        "linux" => "linux".to_string(),
        "win" => "win".to_string(),
        "mac" => match arch {
            "aarch64" | "arm64" => "mac_arm64".to_string(),
            "x86_64" | "x64" | "amd64" => "mac_x86_64".to_string(),
            _ => "mac".to_string(),
        },
        _ => return String::new(),
    };
    format!(
        "https://dl.google.com/android/repository/commandlinetools-{token}-{CMDLINE_TOOLS_VERSION}_latest.zip"
    )
}

/// Pure: extracts the last percent token from an sdkmanager/curl progress
/// line ("[==  ] 25% Unzipping..." → 25). None when no percent.
pub fn parse_sdkmanager_progress(line: &str) -> Option<u8> {
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

/// Pure: parses `sdkmanager --list` output and picks the newest
/// `system-images;android-XX;google_apis;<abi>` package.
pub fn parse_latest_system_image(list_output: &str, abi: &str) -> Option<String> {
    let mut best: Option<(u32, String)> = None;
    for line in list_output.lines() {
        let pkg = line.split_whitespace().next().unwrap_or("");
        let mut parts = pkg.split(';');
        if parts.next() != Some("system-images") {
            continue;
        }
        let Some(api_part) = parts.next() else {
            continue;
        };
        let Some(api) = api_part
            .strip_prefix("android-")
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        if parts.next() != Some("google_apis") {
            continue;
        }
        if parts.next() != Some(abi) {
            continue;
        }
        if best.as_ref().map_or(true, |(b, _)| api > *b) {
            best = Some((api, pkg.to_string()));
        }
    }
    best.map(|(_, pkg)| pkg)
}

/// Pure: the API level in a system-image package id
/// ("system-images;android-35;google_apis;arm64-v8a" → 35).
pub fn api_level_from_image(image: &str) -> u32 {
    image
        .split(';')
        .find_map(|part| part.strip_prefix("android-").and_then(|n| n.parse().ok()))
        .unwrap_or(0)
}

/// The host ABI token for system images.
pub fn host_abi() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64-v8a"
    } else {
        "x86_64"
    }
}

/// Pure: picks the SDK root from the candidate env vars, falling back to
/// the app-managed `<app_data>/android-sdk` directory. `ANDROID_HOME` wins
/// over `ANDROID_SDK_ROOT` (both are respected; never owner-hardcoded).
/// Kept free of env access so it is unit-testable on any host.
pub fn pick_sdk_root(
    android_home: Option<&str>,
    android_sdk_root: Option<&str>,
    app_data_dir: &Path,
) -> PathBuf {
    android_home
        .or(android_sdk_root)
        .map(PathBuf::from)
        .unwrap_or_else(|| app_data_dir.join("android-sdk"))
}

/// Resolves the SDK root: `ANDROID_HOME`/`ANDROID_SDK_ROOT` when set, else
/// the app-managed `<app_data>/android-sdk` directory.
pub fn resolve_sdk_path(app_data_dir: &Path) -> PathBuf {
    pick_sdk_root(
        std::env::var("ANDROID_HOME").ok().as_deref(),
        std::env::var("ANDROID_SDK_ROOT").ok().as_deref(),
        app_data_dir,
    )
}

/// The app-managed SDK directory relative to the app data dir
/// (`<app_data>/android-sdk`). Used as a stable hint at state-construction
/// time; the real app data dir is resolved inside the setup flow.
pub fn managed_sdk_default_dir_hint() -> PathBuf {
    PathBuf::from(".").join("android-sdk")
}

/// Licenses are accepted when the SDK root has the `licenses/android-sdk-license`
/// marker file (written by `sdkmanager --licenses` after acceptance).
pub fn licenses_accepted(sdk_path: &Path) -> bool {
    let marker = sdk_path.join("licenses").join("android-sdk-license");
    marker.is_file()
}

/// Any installed system image (non-empty `system-images/` tree).
pub fn has_system_image(sdk_path: &Path) -> bool {
    let images = sdk_path.join("system-images");
    let Ok(entries) = std::fs::read_dir(&images) else {
        return false;
    };
    entries.flatten().next().is_some()
}

/// The installed AVD names (`emulator -list-avds`).
pub(crate) fn list_avd_names(runner: &dyn CommandRunner, sdk_path: &Path) -> Vec<String> {
    let emulator = sdk_path.join("emulator").join(if cfg!(windows) {
        "emulator.exe"
    } else {
        "emulator"
    });
    match runner.run(
        emulator.to_string_lossy().as_ref(),
        &["-list-avds".to_string()],
    ) {
        Ok(output) if output.success => {
            let names =
                super::requirements::parse_avd_list(&String::from_utf8_lossy(&output.stdout));
            names
        }
        _ => Vec::new(),
    }
}

/// Acceleration availability, per SO (contract §Deteccao):
/// - macOS: Hypervisor.framework — `sysctl kern.hv_support` == 1.
/// - Windows: WHPX — `WinHvPlatform.dll` present (fast proxy; the real
///   feature state is validated in CI/field — enabling is always guided).
/// - Linux: `/dev/kvm` exists AND is openable (kvm group membership).
pub fn accel_available() -> bool {
    if cfg!(target_os = "macos") {
        let mut command = Command::new("sysctl");
        command.arg("kern.hv_support");
        crate::services::cli_spawn::apply_creation_flags(&mut command);
        match command.output() {
            Ok(output) if output.status.success() => {
                String::from_utf8_lossy(&output.stdout).contains("1")
            }
            _ => false,
        }
    } else if cfg!(target_os = "windows") {
        Path::new("C:\\Windows\\System32\\WinHvPlatform.dll").exists()
    } else if cfg!(target_os = "linux") {
        let kvm = Path::new("/dev/kvm");
        kvm.exists()
            && std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(kvm)
                .is_ok()
    } else {
        false
    }
}

/// Expected cmdline-tools download size in bytes (~150 MB; DISPLAY-ONLY
/// hint for the `awaiting: 'download'` confirmation card).
pub fn cmdline_tools_download_size() -> u64 {
    150 * 1024 * 1024
}

/// Human label for the cmdline-tools download (DISPLAY-ONLY — the UI never
/// anchors logic on it; contract §Eventos).
pub fn cmdline_tools_size_label() -> String {
    "~150 MB (Android command-line tools)".to_string()
}

/// Expected system-image download size in bytes (~1.4 GB; DISPLAY-ONLY).
pub fn system_image_download_size() -> u64 {
    1_400 * 1024 * 1024
}

/// Human label for the system-image download (DISPLAY-ONLY).
pub fn system_image_size_label() -> String {
    "~1.4 GB (Android system image)".to_string()
}

/// The newest `system-images;android-XX;google_apis;<abi>` package from
/// `sdkmanager --list` (pure decision; falls back to a pinned API 35 image
/// when the list cannot be read).
pub(crate) fn pick_latest_system_image(
    runner: &dyn CommandRunner,
    sdk_path: &Path,
) -> Option<String> {
    let sdkmanager = sdkmanager_path(sdk_path);
    let abi = host_abi();
    match runner.run(
        sdkmanager.to_string_lossy().as_ref(),
        &["--list".to_string()],
    ) {
        Ok(output) if output.success => {
            let list = String::from_utf8_lossy(&output.stdout);
            parse_latest_system_image(&list, abi)
        }
        _ => Some(format!("system-images;android-35;google_apis;{abi}")),
    }
}

/// The sdkmanager binary under the SDK root (standard `cmdline-tools/latest`
/// layout).
pub fn sdkmanager_path(sdk_path: &Path) -> PathBuf {
    sdk_path
        .join("cmdline-tools")
        .join("latest")
        .join("bin")
        .join(if cfg!(windows) {
            "sdkmanager.bat"
        } else {
            "sdkmanager"
        })
}

/// The avdmanager binary under the SDK root.
pub fn avdmanager_path(sdk_path: &Path) -> PathBuf {
    sdk_path
        .join("cmdline-tools")
        .join("latest")
        .join("bin")
        .join(if cfg!(windows) {
            "avdmanager.bat"
        } else {
            "avdmanager"
        })
}

/// Downloads and installs the cmdline-tools into the SDK root (standard
/// `cmdline-tools/latest` layout). Emits progress via `on_percent`.
pub fn download_cmdline_tools(
    sdk_path: &Path,
    cancel: &AtomicBool,
    on_percent: &mut dyn FnMut(u8),
) -> Result<(), String> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let url = cmdline_tools_url(os, arch);
    if url.is_empty() {
        return Err("unsupported platform for Android command-line tools".to_string());
    }
    std::fs::create_dir_all(sdk_path).map_err(|e| e.to_string())?;
    let zip_path = sdk_path.join("cmdline-tools.zip");
    let deadline = Instant::now() + Duration::from_secs(10 * 60);
    let mut args = vec![
        "-sS".to_string(),
        "-L".to_string(),
        "--progress-bar".to_string(),
        "-f".to_string(),
        "-o".to_string(),
        zip_path.to_string_lossy().into_owned(),
        url.clone(),
    ];
    let result = run_with_progress("curl", &args, cancel, deadline, on_percent);
    if result.is_err() && os == "mac" {
        // Google changed the mac naming across builds: fall back to the
        // universal `mac` URL when the arch-specific variant 404s.
        let fallback = cmdline_tools_url("mac", "universal");
        if !fallback.is_empty() && fallback != url {
            let _ = std::fs::remove_file(&zip_path);
            if let Some(last) = args.last_mut() {
                *last = fallback;
            }
            run_with_progress("curl", &args, cancel, deadline, on_percent)?;
        } else {
            return result;
        }
    } else {
        result?;
    }

    unzip_archive(&zip_path, &sdk_path.join("cmdline-tools"))?;
    // The zip extracts to a top-level `cmdline-tools/`; the SDK expects
    // `cmdline-tools/latest/`.
    let extracted = sdk_path.join("cmdline-tools").join("cmdline-tools");
    let latest = sdk_path.join("cmdline-tools").join("latest");
    if extracted.exists() {
        if latest.exists() {
            std::fs::remove_dir_all(&latest).ok();
        }
        std::fs::rename(&extracted, &latest).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_file(&zip_path);
    Ok(())
}

/// Accepts all pending SDK licenses by piping `y` to `sdkmanager --licenses`
/// (only called after the user explicitly accepted in the UI — never
/// silently).
pub fn accept_all_licenses(sdk_path: &Path) -> Result<(), String> {
    let sdkmanager = sdkmanager_path(sdk_path);
    let mut command = Command::new(sdkmanager);
    command.arg("--licenses");
    crate::services::cli_spawn::apply_creation_flags(&mut command);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::services::child_signal::configure_process_group(&mut command);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("sdkmanager stdin unavailable")?;
    let deadline = Instant::now() + Duration::from_secs(5 * 60);
    loop {
        if Instant::now() >= deadline {
            let _ = crate::services::child_signal::terminate_process_group(&mut child);
            let _ = child.wait();
            return Err("sdkmanager license acceptance timed out".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                drop(stdin);
                if status.success() {
                    return Ok(());
                }
                return Err("sdkmanager --licenses failed".to_string());
            }
            Ok(None) => {
                use std::io::Write;
                let _ = stdin.write_all(b"y\n");
                let _ = stdin.flush();
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Captures the pending license text for display (truncated). Falls back to
/// a generic message when sdkmanager cannot run.
pub(crate) fn fetch_license_text(runner: &dyn CommandRunner, sdk_path: &Path) -> String {
    let sdkmanager = sdkmanager_path(sdk_path);
    let cancel = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(30);
    let generic = "Android SDK licenses must be accepted.".to_string();
    match runner.run_interruptible(
        sdkmanager.to_string_lossy().as_ref(),
        &["--licenses".to_string()],
        &cancel,
        deadline,
    ) {
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stdout);
            let text = text.trim();
            if text.is_empty() {
                generic
            } else {
                text.chars().take(2000).collect()
            }
        }
        Err(_) => generic,
    }
}

/// Installs SDK packages with parsed progress and clean cancellation.
pub fn sdkmanager_install(
    sdk_path: &Path,
    packages: &[String],
    cancel: &AtomicBool,
    on_percent: &mut dyn FnMut(u8),
) -> Result<(), String> {
    let sdkmanager = sdkmanager_path(sdk_path);
    let mut args = vec!["--install".to_string()];
    args.extend(packages.iter().cloned());
    let deadline = Instant::now() + Duration::from_secs(30 * 60);
    run_with_progress(
        sdkmanager.to_string_lossy().as_ref(),
        &args,
        cancel,
        deadline,
        on_percent,
    )
}

/// Creates the default AVD: newest installed system image, pixel device
/// (falls back to the default device definition).
pub(crate) fn create_default_avd(
    runner: &dyn CommandRunner,
    sdk_path: &Path,
) -> Result<(), String> {
    let abi = host_abi();
    let image = newest_installed_system_image(sdk_path, abi)
        .ok_or_else(|| "no Android system image is installed".to_string())?;
    let avdmanager = avdmanager_path(sdk_path);
    let api = api_level_from_image(&image);
    let name = format!("Verboo_Device_API_{api}");
    let base = vec![
        "create".to_string(),
        "avd".to_string(),
        "-n".to_string(),
        name,
        "-k".to_string(),
        image,
        "--force".to_string(),
    ];
    let with_device = {
        let mut args = base.clone();
        args.extend(["--device".to_string(), "pixel_7".to_string()]);
        args
    };
    let output = runner
        .run(avdmanager.to_string_lossy().as_ref(), &with_device)
        .or_else(|_| runner.run(avdmanager.to_string_lossy().as_ref(), &base))?;
    if output.success {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// The newest installed `system-images;android-XX;google_apis;<abi>` package.
fn newest_installed_system_image(sdk_path: &Path, abi: &str) -> Option<String> {
    let images = sdk_path.join("system-images");
    let mut best: Option<(u32, String)> = None;
    for entry in std::fs::read_dir(&images).ok()?.flatten() {
        let dir = entry.path();
        let name = dir.file_name()?.to_string_lossy().into_owned();
        let Some(api) = name
            .strip_prefix("android-")
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        if !dir.join("google_apis").join(abi).exists() {
            continue;
        }
        if best.as_ref().map_or(true, |(b, _)| api > *b) {
            best = Some((api, format!("system-images;{name};google_apis;{abi}")));
        }
    }
    best.map(|(_, pkg)| pkg)
}

/// Runs a command while streaming stdout/stderr (split on `\r`/`\n` — both
/// curl and sdkmanager update their progress bar in place with `\r`),
/// parsing percent tokens and honoring cancel/deadline (group-kill).
fn run_with_progress(
    program: &str,
    args: &[String],
    cancel: &AtomicBool,
    deadline: Instant,
    on_percent: &mut dyn FnMut(u8),
) -> Result<(), String> {
    use std::sync::mpsc;

    let mut command = Command::new(program);
    command.args(args);
    crate::services::cli_spawn::apply_creation_flags(&mut command);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::services::child_signal::configure_process_group(&mut command);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        if let Some(stream) = stdout {
            drain_stream(stream, &tx);
        }
        if let Some(stream) = stderr {
            drain_stream(stream, &tx);
        }
    });
    loop {
        if cancel.load(Ordering::Acquire) || Instant::now() >= deadline {
            let _ = crate::services::child_signal::terminate_process_group(&mut child);
            let _ = child.wait();
            return Err("android emulator operation cancelled".to_string());
        }
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                while let Ok(line) = rx.try_recv() {
                    if let Some(percent) = parse_sdkmanager_progress(&line) {
                        on_percent(percent);
                    }
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => {
                let _ = crate::services::child_signal::terminate_process_group(&mut child);
                let _ = child.wait();
                return Err(e.to_string());
            }
        }
    }
    while let Ok(line) = rx.try_recv() {
        if let Some(percent) = parse_sdkmanager_progress(&line) {
            on_percent(percent);
        }
    }
    let _ = reader.join();
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{program} exited with {status}"))
    }
}

/// Reads a stream, splitting on `\r`/`\n` and sending each chunk to `tx`.
fn drain_stream<R: std::io::Read>(mut stream: R, tx: &std::sync::mpsc::Sender<String>) {
    let mut buf = [0u8; 1024];
    let mut chunk = String::new();
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                chunk.push_str(&String::from_utf8_lossy(&buf[..n]));
                while let Some(pos) = chunk.find(|c| c == '\r' || c == '\n') {
                    let line = chunk[..pos].to_string();
                    chunk.drain(..=pos);
                    if tx.send(line).is_err() {
                        return;
                    }
                }
            }
            Err(_) => break,
        }
    }
    if !chunk.is_empty() {
        let _ = tx.send(chunk);
    }
}

/// Extracts a zip archive into `dest` (unzip on mac/linux, tar on Windows).
fn unzip_archive(zip_path: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let mut command = Command::new("tar");
        command.arg("-xf").arg(zip_path).arg("-C").arg(dest);
        crate::services::cli_spawn::apply_creation_flags(&mut command);
        let status = command.status().map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("tar failed to extract {zip_path:?}"))
        }
    }
    #[cfg(not(windows))]
    {
        let mut command = Command::new("unzip");
        command.arg("-q").arg(zip_path).arg("-d").arg(dest);
        crate::services::cli_spawn::apply_creation_flags(&mut command);
        let status = command.status().map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("unzip failed to extract {zip_path:?}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmdline_tools_url_selects_by_os_and_arch() {
        let linux = cmdline_tools_url("linux", "x86_64");
        assert!(linux.contains("commandlinetools-linux-"));
        assert!(linux.ends_with("_latest.zip"));
        let win = cmdline_tools_url("win", "x86_64");
        assert!(win.contains("commandlinetools-win-"));
        let mac_arm = cmdline_tools_url("mac", "aarch64");
        assert!(mac_arm.contains("commandlinetools-mac_arm64-"));
        let mac_x64 = cmdline_tools_url("mac", "x86_64");
        assert!(mac_x64.contains("commandlinetools-mac_x86_64-"));
        // Unknown arch on mac → universal URL.
        let mac_universal = cmdline_tools_url("mac", "universal");
        assert!(mac_universal.contains("commandlinetools-mac-"));
        // Unsupported OS → empty.
        assert_eq!(cmdline_tools_url("ios", "aarch64"), "");
    }

    #[test]
    fn sdkmanager_progress_parses_percent_lines() {
        assert_eq!(
            parse_sdkmanager_progress("[==  ] 25% Unzipping..."),
            Some(25)
        );
        assert_eq!(
            parse_sdkmanager_progress("[====] 100% Computing updates..."),
            Some(100)
        );
        assert_eq!(parse_sdkmanager_progress("42%"), Some(42));
        assert_eq!(
            parse_sdkmanager_progress("Fetching https://dl.google.com/..."),
            None
        );
        assert_eq!(parse_sdkmanager_progress(""), None);
    }

    #[test]
    fn picks_newest_system_image_from_list() {
        let list = "\
system-images;android-34;google_apis;arm64-v8a | 10 | Google APIs ARM 64 v8a System Image
system-images;android-35;google_apis;arm64-v8a | 12 | Google APIs ARM 64 v8a System Image
system-images;android-35;google_apis;x86_64 | 12 | Google APIs Intel x86_64 System Image
platform-tools | 1 | Android SDK Platform-Tools
";
        assert_eq!(
            parse_latest_system_image(list, "arm64-v8a"),
            Some("system-images;android-35;google_apis;arm64-v8a".to_string())
        );
        assert_eq!(
            parse_latest_system_image(list, "x86_64"),
            Some("system-images;android-35;google_apis;x86_64".to_string())
        );
        assert_eq!(
            parse_latest_system_image(list, "arm64-v8a"),
            Some("system-images;android-35;google_apis;arm64-v8a".to_string())
        );
        assert_eq!(parse_latest_system_image("", "arm64-v8a"), None);
    }

    #[test]
    fn extracts_api_level_from_image() {
        assert_eq!(
            api_level_from_image("system-images;android-35;google_apis;arm64-v8a"),
            35
        );
        assert_eq!(api_level_from_image("platform-tools"), 0);
    }

    #[test]
    fn sdk_path_resolution_prefers_env_over_managed() {
        let managed = PathBuf::from("/tmp/verboo-app-data");
        // ANDROID_HOME wins over ANDROID_SDK_ROOT.
        assert_eq!(
            pick_sdk_root(Some("/sdk/home"), Some("/sdk/root"), &managed),
            PathBuf::from("/sdk/home")
        );
        // ANDROID_SDK_ROOT alone is respected.
        assert_eq!(
            pick_sdk_root(None, Some("/sdk/root"), &managed),
            PathBuf::from("/sdk/root")
        );
        // Neither env var → app-managed `<app_data>/android-sdk`.
        assert_eq!(
            pick_sdk_root(None, None, &managed),
            managed.join("android-sdk")
        );
    }
}
