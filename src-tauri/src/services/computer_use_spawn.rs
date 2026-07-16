//! Builds a `Command` for the bundled Swift `computer-use-helper` sidecar.
//!
//! Mirrors `cli_spawn.rs` pattern but for the Swift binary at
//! `<Resources>/computer-use-helper-<triple>` (Tauri `externalBin`).
//!
//! Release builds accept only canonical helper files inside the installed app
//! layout. Development and test builds additionally allow an explicit env
//! override, the local Cargo build, and a PATH fallback.

#[cfg(test)]
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::services::computer_use_mcp::ActionHelperAuthority;

#[cfg(target_os = "macos")]
use std::os::fd::AsRawFd;
#[cfg(target_os = "macos")]
use std::os::unix::fs::PermissionsExt;
#[cfg(target_os = "macos")]
use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

const AGENT_APP_NAME: &str = "Verboo Computer Use.app";
const AGENT_EXECUTABLE_NAME: &str = "computer-use-helper";

/// Target triple for the current platform. Mirrors Tauri's `externalBin`
/// naming so the same binary works in dev and bundled modes.
fn target_triple() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "aarch64-apple-darwin"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "x86_64-apple-darwin"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "x86_64-pc-windows-msvc"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "x86_64-unknown-linux-gnu"
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
    )))]
    {
        compile_error!("computer-use-helper: unsupported target triple")
    }
}

pub struct ComputerUseSpawn {
    pub command: Command,
    #[cfg_attr(not(test), allow(dead_code))]
    pub runtime: ComputerUseRuntime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComputerUseRuntime {
    /// Bundled sidecar at `<Resources>/computer-use-helper-<triple>`.
    Bundled { path: PathBuf },
    /// Env override via `VERBOO_COMPUTER_USE_HELPER`.
    Env { path: PathBuf },
    /// Local dev build at `<src-tauri>/binaries/computer-use-helper-<triple>`.
    Dev { path: PathBuf },
    /// Resolved via PATH lookup.
    Path,
    /// No trusted packaged helper was available. The command points at a
    /// deliberately unavailable absolute path so spawning fails closed.
    Unavailable { expected: PathBuf },
}

impl ComputerUseRuntime {
    fn path(&self) -> Option<&Path> {
        match self {
            Self::Bundled { path } | Self::Env { path } | Self::Dev { path } => Some(path),
            Self::Path | Self::Unavailable { .. } => None,
        }
    }
}

impl std::fmt::Display for ComputerUseRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ComputerUseRuntime::Bundled { path } => write!(f, "bundled({})", path.display()),
            ComputerUseRuntime::Env { path } => write!(f, "env({})", path.display()),
            ComputerUseRuntime::Dev { path } => write!(f, "dev({})", path.display()),
            ComputerUseRuntime::Path => write!(f, "path"),
            ComputerUseRuntime::Unavailable { expected } => {
                write!(f, "unavailable({})", expected.display())
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResolverPolicy {
    Development,
    Release,
}

impl ResolverPolicy {
    fn current_build() -> Self {
        if cfg!(debug_assertions) || cfg!(test) {
            Self::Development
        } else {
            Self::Release
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum HelperResolution {
    Found(ComputerUseRuntime),
    PathLookup(String),
    Unavailable(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComputerUseAgentRuntime {
    Bundled {
        app_path: PathBuf,
        executable_path: PathBuf,
    },
    Env {
        app_path: PathBuf,
        executable_path: PathBuf,
    },
    Dev {
        app_path: PathBuf,
        executable_path: PathBuf,
    },
}

impl ComputerUseAgentRuntime {
    fn app_path(&self) -> &Path {
        match self {
            Self::Bundled { app_path, .. }
            | Self::Env { app_path, .. }
            | Self::Dev { app_path, .. } => app_path,
        }
    }

}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AgentResolution {
    Found(ComputerUseAgentRuntime),
    Unavailable(PathBuf),
}

#[cfg(target_os = "macos")]
pub struct ComputerUseAgentConnection {
    pub stream: UnixStream,
    pub pid: u32,
    pub executable_path: PathBuf,
}

impl ComputerUseSpawn {
    /// Resolve the helper binary and build a Command ready to spawn.
    /// Stdio MUST be set by the caller (piped for IPC).
    pub fn new() -> Self {
        match resolve_current_helper() {
            HelperResolution::Found(runtime) => Self {
                command: Command::new(runtime.path().expect("found runtime has an absolute path")),
                runtime,
            },
            HelperResolution::PathLookup(program) => Self {
                command: Command::new(program),
                runtime: ComputerUseRuntime::Path,
            },
            HelperResolution::Unavailable(expected) => Self {
                command: Command::new(&expected),
                runtime: ComputerUseRuntime::Unavailable { expected },
            },
        }
    }
}

fn find_bundled_helper_from(executable: &Path, triple: &str) -> Option<PathBuf> {
    let executable = executable.canonicalize().ok()?;
    let exe_dir = executable.parent()?;
    let names = [
        "computer-use-helper".to_string(),
        format!("computer-use-helper-{triple}"),
    ];

    #[cfg(target_os = "macos")]
    {
        if let Some(contents) = exe_dir.parent() {
            let contents = contents.canonicalize().ok()?;
            for resource_root in [
                contents.join("Resources"),
                contents.join("Resources/binaries"),
            ] {
                let Ok(canonical_root) = resource_root.canonicalize() else {
                    continue;
                };
                if !canonical_root.starts_with(&contents) {
                    continue;
                }
                for name in &names {
                    if let Some(candidate) =
                        canonical_file_within(&resource_root.join(name), &canonical_root)
                    {
                        return Some(candidate);
                    }
                }
            }
        }
    }

    let canonical_exe_dir = exe_dir.canonicalize().ok()?;
    for name in names {
        if let Some(candidate) = canonical_file_within(&exe_dir.join(name), &canonical_exe_dir) {
            return Some(candidate);
        }
    }
    None
}

fn canonical_file_within(candidate: &Path, canonical_root: &Path) -> Option<PathBuf> {
    let candidate = candidate.canonicalize().ok()?;
    if candidate.is_file() && candidate.starts_with(canonical_root) {
        Some(candidate)
    } else {
        None
    }
}

fn find_dev_helper_from(manifest: &Path, triple: &str) -> Option<PathBuf> {
    let dev_path = manifest
        .join("binaries")
        .join(format!("computer-use-helper-{triple}"));
    let dev_path = dev_path.canonicalize().ok()?;
    if dev_path.is_file() {
        Some(dev_path)
    } else {
        None
    }
}

fn canonical_agent_bundle(path: &Path) -> Option<(PathBuf, PathBuf)> {
    let app_path = path.canonicalize().ok()?;
    if !app_path.is_dir() || app_path.extension().and_then(|value| value.to_str()) != Some("app") {
        return None;
    }
    let info_plist = app_path.join("Contents/Info.plist");
    if !info_plist.is_file() {
        return None;
    }
    let executable_path = app_path
        .join("Contents/MacOS")
        .join(AGENT_EXECUTABLE_NAME)
        .canonicalize()
        .ok()?;
    if !executable_path.is_file() || !executable_path.starts_with(&app_path) {
        return None;
    }
    Some((app_path, executable_path))
}

fn find_bundled_agent_from(executable: &Path) -> Option<(PathBuf, PathBuf)> {
    let executable = executable.canonicalize().ok()?;
    let contents = executable.parent()?.parent()?.canonicalize().ok()?;
    for candidate in [
        contents.join("Helpers").join(AGENT_APP_NAME),
        contents.join("Resources/binaries").join(AGENT_APP_NAME),
        contents.join("Resources/resources").join(AGENT_APP_NAME),
        contents.join("Resources").join(AGENT_APP_NAME),
    ] {
        let Some((app_path, executable_path)) = canonical_agent_bundle(&candidate) else {
            continue;
        };
        if app_path.starts_with(&contents) {
            return Some((app_path, executable_path));
        }
    }
    None
}

fn find_dev_agent_from(manifest: &Path) -> Option<(PathBuf, PathBuf)> {
    canonical_agent_bundle(&manifest.join("binaries").join(AGENT_APP_NAME))
}

fn resolve_current_agent() -> AgentResolution {
    let current_exe = std::env::current_exe().ok();
    let manifest_dir = option_env!("CARGO_MANIFEST_DIR").map(Path::new);
    let env_override = std::env::var_os("VERBOO_COMPUTER_USE_AGENT");
    resolve_agent_with_policy(
        ResolverPolicy::current_build(),
        current_exe.as_deref(),
        manifest_dir,
        env_override.as_deref().map(Path::new),
    )
}

fn resolve_agent_with_policy(
    policy: ResolverPolicy,
    current_exe: Option<&Path>,
    manifest_dir: Option<&Path>,
    env_override: Option<&Path>,
) -> AgentResolution {
    if policy == ResolverPolicy::Development {
        if let Some((app_path, executable_path)) = env_override.and_then(canonical_agent_bundle) {
            return AgentResolution::Found(ComputerUseAgentRuntime::Env {
                app_path,
                executable_path,
            });
        }
    }

    if let Some((app_path, executable_path)) = current_exe.and_then(find_bundled_agent_from) {
        return AgentResolution::Found(ComputerUseAgentRuntime::Bundled {
            app_path,
            executable_path,
        });
    }

    if policy == ResolverPolicy::Development {
        if let Some((app_path, executable_path)) = manifest_dir.and_then(find_dev_agent_from) {
            return AgentResolution::Found(ComputerUseAgentRuntime::Dev {
                app_path,
                executable_path,
            });
        }
    }

    let expected = current_exe
        .and_then(|executable| executable.parent()?.parent())
        .map(|contents| contents.join("Helpers").join(AGENT_APP_NAME))
        .unwrap_or_else(|| {
            PathBuf::from(std::path::MAIN_SEPARATOR.to_string())
                .join("verboo-computer-use-agent-unavailable.app")
        });
    AgentResolution::Unavailable(expected)
}

#[cfg(test)]
fn agent_launch_arguments(socket_path: &Path) -> Vec<OsString> {
    vec![
        OsString::from("--verboo-agent-socket"),
        socket_path.as_os_str().to_owned(),
    ]
}

fn installed_agent_app_path_from(data_dir: &Path) -> PathBuf {
    data_dir
        .join("Verboo")
        .join("Computer Use")
        .join(AGENT_APP_NAME)
}

#[cfg(target_os = "macos")]
fn installed_agent_app_path() -> Result<PathBuf, String> {
    let data_dir = dirs::data_local_dir()
        .ok_or_else(|| "macOS Application Support directory is unavailable".to_string())?;
    Ok(installed_agent_app_path_from(&data_dir))
}

fn configure_agent_launcher_command(
    command: &mut Command,
    source_app_path: &Path,
    installed_app_path: &Path,
    socket_path: &Path,
    authority: Option<&ActionHelperAuthority>,
) {
    command
        .arg("--launch-agent-app")
        .arg(source_app_path)
        .arg("--installed-agent-app")
        .arg(installed_app_path)
        .arg("--launch-agent-socket")
        .arg(socket_path)
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped());
    if let Some(authority) = authority {
        command.env("VERBOO_CU_TOKEN", &authority.token);
        command.env("VERBOO_CU_CAPABILITY_FILE", &authority.capability_path);
    }
}

#[derive(Debug, serde::Deserialize)]
struct AgentLauncherResult {
    pid: u32,
    app_path: PathBuf,
    executable_path: PathBuf,
}

fn parse_agent_launcher_result(stdout: &[u8]) -> Result<AgentLauncherResult, String> {
    let line = std::str::from_utf8(stdout)
        .map_err(|error| format!("read Launch Services result: {error}"))?
        .lines()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| "Launch Services returned no process identity".to_string())?;
    serde_json::from_str(line).map_err(|error| format!("parse Launch Services result: {error}"))
}

pub fn resolved_agent_path() -> Option<PathBuf> {
    match resolve_current_agent() {
        AgentResolution::Found(runtime) => Some(runtime.app_path().to_path_buf()),
        AgentResolution::Unavailable(_) => None,
    }
}

#[cfg(target_os = "macos")]
fn agent_socket_path() -> Result<PathBuf, String> {
    let uid = unsafe { libc::geteuid() };
    // Darwin's sockaddr_un path is intentionally short (104 bytes). The
    // per-user 0700 directory plus peer-executable validation keeps this
    // predictable /tmp rendezvous private without relying on a long cache path.
    let directory = PathBuf::from("/tmp").join(format!("verboo-cu-agent-{uid}"));
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("create agent socket directory: {error}"))?;
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("protect agent socket directory: {error}"))?;
    Ok(directory.join(format!("{}.sock", uuid::Uuid::new_v4())))
}

#[cfg(target_os = "macos")]
fn peer_pid(stream: &UnixStream) -> Result<u32, String> {
    let mut pid: libc::pid_t = 0;
    let mut size = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut size,
        )
    };
    if result != 0 || pid <= 1 {
        return Err(format!(
            "read agent peer pid: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(pid as u32)
}

#[cfg(target_os = "macos")]
fn process_path(pid: u32) -> Option<PathBuf> {
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let length = unsafe {
        libc::proc_pidpath(
            pid as libc::c_int,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
        )
    };
    if length <= 0 {
        return None;
    }
    buffer.truncate(length as usize);
    let value = std::str::from_utf8(&buffer).ok()?;
    Path::new(value).canonicalize().ok()
}

#[cfg(target_os = "macos")]
pub fn agent_process_matches(pid: u32, expected_executable: &Path) -> bool {
    let expected = expected_executable.canonicalize().ok();
    expected.is_some() && process_path(pid) == expected
}

#[cfg(target_os = "macos")]
pub fn launch_action_agent(
    authority: Option<&ActionHelperAuthority>,
) -> Result<ComputerUseAgentConnection, String> {
    let AgentResolution::Found(runtime) = resolve_current_agent() else {
        return Err("Verboo Computer Use.app is not packaged".into());
    };
    let socket_path = agent_socket_path()?;
    let listener =
        UnixListener::bind(&socket_path).map_err(|error| format!("bind agent socket: {error}"))?;
    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("protect agent socket: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("configure agent socket: {error}"))?;

    let installed_app_path = installed_agent_app_path()?;
    let mut launcher = ComputerUseSpawn::new().command;
    configure_agent_launcher_command(
        &mut launcher,
        runtime.app_path(),
        &installed_app_path,
        &socket_path,
        authority,
    );
    let output = launcher
        .output()
        .map_err(|error| format!("run Verboo Computer Use launcher: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = std::fs::remove_file(&socket_path);
        return Err(format!(
            "launch Verboo Computer Use agent: {}{}",
            output.status,
            if stderr.trim().is_empty() {
                String::new()
            } else {
                format!(": {}", stderr.trim())
            }
        ));
    }
    let launched = parse_agent_launcher_result(&output.stdout)?;
    let canonical_installed_app = installed_app_path
        .canonicalize()
        .map_err(|error| format!("canonicalize installed agent app: {error}"))?;
    let canonical_installed_executable = canonical_installed_app
        .join("Contents/MacOS")
        .join(AGENT_EXECUTABLE_NAME)
        .canonicalize()
        .map_err(|error| format!("canonicalize installed agent executable: {error}"))?;
    if launched.app_path.canonicalize().ok().as_ref() != Some(&canonical_installed_app)
        || launched.executable_path.canonicalize().ok().as_ref()
            != Some(&canonical_installed_executable)
    {
        unsafe {
            libc::kill(launched.pid as libc::pid_t, libc::SIGKILL);
        }
        let _ = std::fs::remove_file(&socket_path);
        return Err("Launch Services returned an unexpected agent identity".into());
    }

    let deadline = Instant::now() + Duration::from_secs(8);
    let accepted = loop {
        match listener.accept() {
            Ok((stream, _)) => {
                if let Err(error) = stream.set_nonblocking(false) {
                    break Err(format!("configure agent transport: {error}"));
                }
                let pid = match peer_pid(&stream) {
                    Ok(pid) => pid,
                    Err(error) => break Err(error),
                };
                if pid == launched.pid && agent_process_matches(pid, &canonical_installed_executable)
                {
                    break Ok((stream, pid));
                }
                unsafe {
                    libc::kill(pid as libc::pid_t, libc::SIGKILL);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if !agent_process_matches(launched.pid, &canonical_installed_executable) {
                    break Err("Verboo Computer Use agent exited before connecting".to_string());
                }
                if Instant::now() >= deadline {
                    break Err("timed out waiting for Verboo Computer Use agent".to_string());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => break Err(format!("accept Verboo Computer Use agent: {error}")),
        }
    };
    let _ = std::fs::remove_file(&socket_path);
    let (stream, pid) = match accepted {
        Ok(connection) => connection,
        Err(error) => {
            unsafe {
                libc::kill(launched.pid as libc::pid_t, libc::SIGKILL);
            }
            return Err(error);
        }
    };
    Ok(ComputerUseAgentConnection {
        stream,
        pid,
        executable_path: canonical_installed_executable,
    })
}

fn resolve_current_helper() -> HelperResolution {
    let current_exe = std::env::current_exe().ok();
    let manifest_dir = option_env!("CARGO_MANIFEST_DIR").map(Path::new);
    let env_override = std::env::var_os("VERBOO_COMPUTER_USE_HELPER");
    resolve_helper_with_policy(
        ResolverPolicy::current_build(),
        current_exe.as_deref(),
        manifest_dir,
        env_override.as_deref().map(Path::new),
        target_triple(),
    )
}

fn resolve_helper_with_policy(
    policy: ResolverPolicy,
    current_exe: Option<&Path>,
    manifest_dir: Option<&Path>,
    env_override: Option<&Path>,
    triple: &str,
) -> HelperResolution {
    if policy == ResolverPolicy::Development {
        if let Some(path) = env_override.and_then(canonical_existing_file) {
            return HelperResolution::Found(ComputerUseRuntime::Env { path });
        }
    }

    if let Some(path) = current_exe.and_then(|exe| find_bundled_helper_from(exe, triple)) {
        return HelperResolution::Found(ComputerUseRuntime::Bundled { path });
    }

    if policy == ResolverPolicy::Development {
        if let Some(path) = manifest_dir.and_then(|manifest| find_dev_helper_from(manifest, triple))
        {
            return HelperResolution::Found(ComputerUseRuntime::Dev { path });
        }

        return HelperResolution::PathLookup(format!("computer-use-helper-{triple}"));
    }

    HelperResolution::Unavailable(expected_packaged_path(current_exe, triple))
}

fn canonical_existing_file(path: &Path) -> Option<PathBuf> {
    let path = path.canonicalize().ok()?;
    path.is_file().then_some(path)
}

fn expected_packaged_path(current_exe: Option<&Path>, triple: &str) -> PathBuf {
    if let Some(parent) = current_exe.and_then(Path::parent) {
        return parent.join(format!("computer-use-helper-{triple}"));
    }

    // This branch is only reached if the OS cannot report the current
    // executable. Keep a path separator in the command so the OS cannot
    // resolve an attacker-controlled binary from PATH.
    #[cfg(not(target_os = "windows"))]
    {
        PathBuf::from(std::path::MAIN_SEPARATOR.to_string())
            .join(format!("verboo-computer-use-helper-unavailable-{triple}"))
    }
    #[cfg(target_os = "windows")]
    {
        PathBuf::from(r"C:\Windows\System32")
            .join(format!("verboo-computer-use-helper-unavailable-{triple}"))
    }
}

/// Resolve the absolute path to the computer-use-helper binary, or None if
/// only a PATH-based (unresolvable) fallback exists.
///
/// In release builds, only a canonical bundled sidecar is returned. In
/// development and test builds the env override and local dev build are also
/// eligible.
///
/// PATH-only resolution returns None (cannot verify it resolves at runtime).
pub fn resolved_helper_path() -> Option<PathBuf> {
    match resolve_current_helper() {
        HelperResolution::Found(runtime) => runtime.path().map(Path::to_path_buf),
        HelperResolution::PathLookup(_) | HelperResolution::Unavailable(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture_executable(root: &std::path::Path) -> PathBuf {
        let executable = root.join("Verboo Code.app/Contents/MacOS/verboo-code");
        fs::create_dir_all(executable.parent().expect("executable parent")).unwrap();
        fs::write(&executable, b"app").unwrap();
        executable
    }

    fn fixture_file(path: &std::path::Path) {
        fs::create_dir_all(path.parent().expect("fixture parent")).unwrap();
        fs::write(path, b"helper").unwrap();
    }

    fn fixture_agent(path: &std::path::Path) -> PathBuf {
        let executable = path.join("Contents/MacOS/computer-use-helper");
        fixture_file(&executable);
        fixture_file(&path.join("Contents/Info.plist"));
        executable
    }

    #[test]
    fn target_triple_matches_host() {
        let t = target_triple();
        // Smoke: contains "apple-darwin", "pc-windows", or "unknown-linux".
        assert!(
            t.contains("apple-darwin") || t.contains("pc-windows") || t.contains("unknown-linux")
        );
    }

    #[test]
    fn new_returns_some_runtime() {
        let spawn = ComputerUseSpawn::new();
        // We can't assert which runtime without machine-specific paths,
        // but the Display impl must not panic.
        let _ = spawn.runtime.to_string();
    }

    #[test]
    fn resolved_helper_path_returns_some_in_dev_mode() {
        // On this dev machine the helper should exist at
        // <src-tauri>/binaries/computer-use-helper-<triple>.
        let path = resolved_helper_path();
        assert!(
            path.is_some(),
            "expected dev build to exist on this machine"
        );
        assert!(
            path.as_ref().is_some_and(|p| p.is_file()),
            "resolved path is not a file"
        );
    }

    #[test]
    fn release_ignores_env_override_and_uses_packaged_resource() {
        let bundle = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let executable = fixture_executable(bundle.path());
        let packaged = bundle
            .path()
            .join("Verboo Code.app/Contents/Resources/computer-use-helper");
        let override_path = external.path().join("computer-use-helper");
        fixture_file(&packaged);
        fixture_file(&override_path);

        let resolution = resolve_helper_with_policy(
            ResolverPolicy::Release,
            Some(&executable),
            None,
            Some(&override_path),
            target_triple(),
        );

        assert_eq!(
            resolution,
            HelperResolution::Found(ComputerUseRuntime::Bundled {
                path: packaged.canonicalize().unwrap(),
            })
        );
    }

    #[test]
    fn release_accepts_sidecar_next_to_current_executable() {
        let bundle = tempfile::tempdir().unwrap();
        let executable = fixture_executable(bundle.path());
        let packaged = executable.parent().unwrap().join("computer-use-helper");
        fixture_file(&packaged);

        let resolution = resolve_helper_with_policy(
            ResolverPolicy::Release,
            Some(&executable),
            None,
            None,
            target_triple(),
        );

        assert_eq!(
            resolution,
            HelperResolution::Found(ComputerUseRuntime::Bundled {
                path: packaged.canonicalize().unwrap(),
            })
        );
    }

    #[cfg(unix)]
    #[test]
    fn release_rejects_packaged_symlink_that_escapes_bundle() {
        use std::os::unix::fs::symlink;

        let bundle = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let executable = fixture_executable(bundle.path());
        let packaged = bundle
            .path()
            .join("Verboo Code.app/Contents/Resources/computer-use-helper");
        let external_helper = external.path().join("computer-use-helper");
        fixture_file(&external_helper);
        fs::create_dir_all(packaged.parent().unwrap()).unwrap();
        symlink(&external_helper, &packaged).unwrap();

        let resolution = resolve_helper_with_policy(
            ResolverPolicy::Release,
            Some(&executable),
            None,
            None,
            target_triple(),
        );

        assert!(matches!(resolution, HelperResolution::Unavailable(_)));
    }

    #[test]
    fn release_rejects_env_and_never_falls_back_to_path_lookup() {
        let bundle = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let executable = fixture_executable(bundle.path());
        let override_path = external.path().join("computer-use-helper");
        fixture_file(&override_path);

        let resolution = resolve_helper_with_policy(
            ResolverPolicy::Release,
            Some(&executable),
            None,
            Some(&override_path),
            target_triple(),
        );

        let HelperResolution::Unavailable(expected) = resolution else {
            panic!("release resolver must fail closed");
        };
        assert!(expected.is_absolute());
    }

    #[test]
    fn development_env_override_wins() {
        let bundle = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let executable = fixture_executable(bundle.path());
        let packaged = bundle
            .path()
            .join("Verboo Code.app/Contents/Resources/computer-use-helper");
        let override_path = external.path().join("computer-use-helper");
        fixture_file(&packaged);
        fixture_file(&override_path);

        let resolution = resolve_helper_with_policy(
            ResolverPolicy::Development,
            Some(&executable),
            None,
            Some(&override_path),
            target_triple(),
        );

        assert_eq!(
            resolution,
            HelperResolution::Found(ComputerUseRuntime::Env {
                path: override_path.canonicalize().unwrap(),
            })
        );
    }

    #[test]
    fn development_preserves_path_fallback() {
        let bundle = tempfile::tempdir().unwrap();
        let executable = fixture_executable(bundle.path());
        let program = format!("computer-use-helper-{}", target_triple());

        let resolution = resolve_helper_with_policy(
            ResolverPolicy::Development,
            Some(&executable),
            Some(bundle.path().join("missing-manifest").as_path()),
            None,
            target_triple(),
        );

        assert_eq!(resolution, HelperResolution::PathLookup(program));
    }

    #[test]
    fn release_accepts_packaged_resources_binaries_candidate() {
        let bundle = tempfile::tempdir().unwrap();
        let executable = fixture_executable(bundle.path());
        let packaged = bundle.path().join(format!(
            "Verboo Code.app/Contents/Resources/binaries/computer-use-helper-{}",
            target_triple()
        ));
        fixture_file(&packaged);

        let resolution = resolve_helper_with_policy(
            ResolverPolicy::Release,
            Some(&executable),
            None,
            None,
            target_triple(),
        );

        assert_eq!(
            resolution,
            HelperResolution::Found(ComputerUseRuntime::Bundled {
                path: packaged.canonicalize().unwrap(),
            })
        );
    }

    #[test]
    fn release_resolves_packaged_agent_app_as_an_independent_identity() {
        let bundle = tempfile::tempdir().unwrap();
        let executable = fixture_executable(bundle.path());
        let agent = bundle
            .path()
            .join("Verboo Code.app/Contents/Helpers/Verboo Computer Use.app");
        let agent_executable = fixture_agent(&agent);

        let resolution =
            resolve_agent_with_policy(ResolverPolicy::Release, Some(&executable), None, None);

        assert_eq!(
            resolution,
            AgentResolution::Found(ComputerUseAgentRuntime::Bundled {
                app_path: agent.canonicalize().unwrap(),
                executable_path: agent_executable.canonicalize().unwrap(),
            })
        );
    }

    #[test]
    fn development_resolves_generated_agent_app_from_binaries() {
        let manifest = tempfile::tempdir().unwrap();
        let agent = manifest.path().join("binaries/Verboo Computer Use.app");
        let agent_executable = fixture_agent(&agent);

        let resolution = resolve_agent_with_policy(
            ResolverPolicy::Development,
            None,
            Some(manifest.path()),
            None,
        );

        assert_eq!(
            resolution,
            AgentResolution::Found(ComputerUseAgentRuntime::Dev {
                app_path: agent.canonicalize().unwrap(),
                executable_path: agent_executable.canonicalize().unwrap(),
            })
        );
    }

    #[cfg(unix)]
    #[test]
    fn release_rejects_agent_bundle_whose_executable_escapes_the_app() {
        use std::os::unix::fs::symlink;

        let bundle = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let executable = fixture_executable(bundle.path());
        let agent = bundle
            .path()
            .join("Verboo Code.app/Contents/Helpers/Verboo Computer Use.app");
        let escaped = external.path().join("computer-use-helper");
        fixture_file(&escaped);
        fs::create_dir_all(agent.join("Contents/MacOS")).unwrap();
        fixture_file(&agent.join("Contents/Info.plist"));
        symlink(&escaped, agent.join("Contents/MacOS/computer-use-helper")).unwrap();

        let resolution =
            resolve_agent_with_policy(ResolverPolicy::Release, Some(&executable), None, None);

        assert!(matches!(resolution, AgentResolution::Unavailable(_)));
    }

    #[test]
    fn direct_agent_arguments_use_the_private_socket_only() {
        let arguments = agent_launch_arguments(Path::new("/tmp/verboo-agent.sock"));
        let rendered = arguments
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(
            rendered,
            vec!["--verboo-agent-socket", "/tmp/verboo-agent.sock",]
        );
    }

    #[test]
    fn stable_agent_install_path_uses_the_verboo_application_support_directory() {
        assert_eq!(
            installed_agent_app_path_from(Path::new("/Users/test/Library/Application Support")),
            PathBuf::from(
                "/Users/test/Library/Application Support/Verboo/Computer Use/Verboo Computer Use.app"
            ),
        );
    }

    #[test]
    fn launch_services_agent_passes_capability_only_through_the_launch_environment() {
        let authority = crate::services::computer_use_mcp::ActionHelperAuthority {
            session_id: "session-cu".into(),
            token: "secret-token".into(),
            capability_path: PathBuf::from("/tmp/verboo-capability.json"),
        };
        let mut command = Command::new("/Applications/Verboo Code.app/Contents/MacOS/computer-use-helper");

        configure_agent_launcher_command(
            &mut command,
            Path::new("/Applications/Verboo Code.app/Contents/Helpers/Verboo Computer Use.app"),
            Path::new(
                "/Users/test/Library/Application Support/Verboo/Computer Use/Verboo Computer Use.app",
            ),
            Path::new("/tmp/verboo-agent.sock"),
            Some(&authority),
        );

        let arguments = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let environment = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|item| item.to_string_lossy().into_owned()),
                )
            })
            .collect::<std::collections::HashMap<_, _>>();

        assert!(!arguments.iter().any(|value| value.contains("secret-token")));
        assert_eq!(
            arguments,
            vec![
                "--launch-agent-app",
                "/Applications/Verboo Code.app/Contents/Helpers/Verboo Computer Use.app",
                "--installed-agent-app",
                "/Users/test/Library/Application Support/Verboo/Computer Use/Verboo Computer Use.app",
                "--launch-agent-socket",
                "/tmp/verboo-agent.sock",
            ],
        );
        assert_eq!(
            environment.get("VERBOO_CU_TOKEN"),
            Some(&Some("secret-token".into())),
        );
        assert_eq!(
            environment.get("VERBOO_CU_CAPABILITY_FILE"),
            Some(&Some("/tmp/verboo-capability.json".into())),
        );
    }

    #[test]
    fn launch_services_result_reports_the_exact_installed_process_identity() {
        let result = parse_agent_launcher_result(
            br#"{"pid":4321,"app_path":"/Users/test/Library/Application Support/Verboo/Computer Use/Verboo Computer Use.app","executable_path":"/Users/test/Library/Application Support/Verboo/Computer Use/Verboo Computer Use.app/Contents/MacOS/computer-use-helper"}"#,
        )
        .unwrap();

        assert_eq!(result.pid, 4321);
        assert_eq!(
            result.app_path,
            PathBuf::from(
                "/Users/test/Library/Application Support/Verboo/Computer Use/Verboo Computer Use.app"
            ),
        );
        assert_eq!(
            result.executable_path,
            PathBuf::from(
                "/Users/test/Library/Application Support/Verboo/Computer Use/Verboo Computer Use.app/Contents/MacOS/computer-use-helper"
            ),
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "launches the real local Verboo Computer Use agent"]
    fn signed_agent_installs_and_launches_through_launch_services() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::Shutdown;

        let authority =
            crate::services::computer_use_mcp::current_action_helper_authority().unwrap();
        let connection = launch_action_agent(authority.as_ref()).expect("launch agent");
        assert!(agent_process_matches(
            connection.pid,
            &connection.executable_path
        ));
        let mut writer = connection.stream.try_clone().unwrap();
        writer
            .write_all(b"{\"id\":1,\"method\":\"permissions\",\"params\":{}}\n")
            .unwrap();
        writer.flush().unwrap();

        let mut response = String::new();
        BufReader::new(connection.stream)
            .read_line(&mut response)
            .unwrap();
        let payload: serde_json::Value = serde_json::from_str(&response).unwrap();
        assert_eq!(payload["id"], 1);
        assert!(payload["result"]["accessibility"].is_string());
        assert!(payload["result"]["screenRecording"].is_string());
        let _ = writer.shutdown(Shutdown::Both);
        unsafe {
            libc::kill(connection.pid as libc::pid_t, libc::SIGTERM);
        }
    }
}
