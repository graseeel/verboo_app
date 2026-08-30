use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::models::types::{LocalTerminalSession, LocalTerminalStartRequest, TerminalDataEvent};
use crate::services::cli_spawn::{CliRuntime, CliSpawn};

const TERMINAL_DATA_CHANNEL: &str = "terminal:data";
const TERMINAL_EXIT_CHANNEL: &str = "terminal:exit";

/// Active PTY session, holding:
///   - the public LocalTerminalSession
///   - `master` for resize + close-on-drop
///   - `writer` for write_all (taken once from master via take_writer)
///   - `killer` to terminate the child cleanly
struct ActiveSession {
    session: LocalTerminalSession,
    master: Arc<Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>>,
    writer: Arc<Mutex<Option<Box<dyn std::io::Write + Send>>>>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
}

/// Service that owns all local terminal sessions. Mirrors Electron's
/// `LocalTerminalService` (src/main/services/localTerminalService.ts):
///   - spawn login shell with platform-specific args
///   - emit `terminal:data`, `terminal:exit`, `terminal:error` events
///   - sanitize startup noise for 2s after spawn
pub struct TerminalService {
    sessions: Arc<Mutex<HashMap<String, ActiveSession>>>,
}

impl TerminalService {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn start(
        &self,
        app: AppHandle,
        request: LocalTerminalStartRequest,
    ) -> Result<LocalTerminalSession, String> {
        let cwd = resolve_cwd(&request.cwd);
        let shell = resolve_default_shell();
        let shell_args = shell_args_for(&shell);
        let id = Uuid::new_v4().to_string();
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        let pty_system = native_pty_system();
        let cols = request.cols.max(20) as u16;
        let rows = request.rows.max(2) as u16;
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Falha ao abrir PTY: {e}"))?;

        let mut cmd = CommandBuilder::new(&shell);
        cmd.args(&shell_args);
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("TERM_PROGRAM", "verboo-terminal");
        for (k, v) in shell_env_for(&shell) {
            cmd.env(k, v);
        }
        // The in-app terminal is an app surface: if the managed CLI is
        // installed, `verboo` on PATH is that CLI (prepend), even when the
        // user has a global `verboo`. Login profiles may still reorder PATH.
        if let Some(shim_dir) = terminal_verboo_shim_dir(&app) {
            if let Some(path) = path_env_for_managed_cli(Some(&shim_dir), std::env::var_os("PATH"))
            {
                cmd.env("PATH", path);
            }
        }

        let sanitize_until = Instant::now() + std::time::Duration::from_secs(2);

        // Clone the reader from the master BEFORE spawning.
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Falha ao clonar leitor PTY: {e}"))?;

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Falha ao spawn shell: {e}"))?;

        let killer = child.clone_killer();
        // Drop the slave to release the FD (master is what we keep).
        drop(pair.slave);
        let master: Box<dyn portable_pty::MasterPty + Send> = pair.master;
        // take_writer must be called before the master goes behind a Mutex.
        let writer = master
            .take_writer()
            .map_err(|e| format!("Falha ao obter writer PTY: {e}"))?;
        let master_arc = Arc::new(Mutex::new(Some(master)));
        let writer_arc = Arc::new(Mutex::new(Some(writer)));

        let session_id = id.clone();
        let app_for_reader = app.clone();
        let sessions_for_exit = self.sessions.clone();
        let id_for_exit = id.clone();
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buffer = [0u8; 8192];
            let mut startup_buffer = String::new();
            let mut startup_prompt_sent = false;
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        let raw = String::from_utf8_lossy(&buffer[..n]).to_string();
                        let now = Instant::now();
                        let in_startup_window = now < sanitize_until;
                        let next_data = if in_startup_window {
                            startup_terminal_data(
                                &mut startup_buffer,
                                &mut startup_prompt_sent,
                                raw,
                            )
                        } else {
                            Some(raw)
                        };
                        if let Some(data) = next_data {
                            let _ = app_for_reader.emit(
                                TERMINAL_DATA_CHANNEL,
                                TerminalDataEvent {
                                    session_id: session_id.clone(),
                                    data,
                                },
                            );
                        }
                    }
                    Err(_) => break,
                }
            }
            // Drain child exit status (best-effort, ignore).
            let _ = child.wait();
            // PTY closed → emit exit.
            let _ = app_for_reader.emit(
                TERMINAL_EXIT_CHANNEL,
                TerminalExitEvent {
                    session_id: id_for_exit.clone(),
                },
            );
            if let Ok(mut sessions) = sessions_for_exit.lock() {
                if let Some(active) = sessions.get_mut(&id_for_exit) {
                    active.session.running = false;
                }
            }
        });

        let session = LocalTerminalSession {
            id: id.clone(),
            cwd: cwd.to_string_lossy().to_string(),
            shell: shell.clone(),
            created_at,
            running: true,
        };

        let active = ActiveSession {
            session: session.clone(),
            master: master_arc,
            writer: writer_arc,
            killer,
        };

        {
            let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            sessions.insert(id, active);
        }

        Ok(session)
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<bool, String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let active = sessions
            .get(session_id)
            .ok_or_else(|| "Sessão não encontrada".to_string())?;
        if !active.session.running {
            return Ok(false);
        }
        let mut writer_guard = active.writer.lock().map_err(|e| e.to_string())?;
        let Some(writer) = writer_guard.as_mut() else {
            return Ok(false);
        };
        match writer.write_all(data.as_bytes()) {
            Ok(_) => {
                let _ = writer.flush();
                Ok(true)
            }
            Err(e) => Err(format!("Falha ao escrever no PTY: {e}")),
        }
    }

    pub fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<bool, String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let active = sessions
            .get(session_id)
            .ok_or_else(|| "Sessão não encontrada".to_string())?;
        if !active.session.running {
            return Ok(false);
        }
        let guard = active.master.lock().map_err(|e| e.to_string())?;
        let Some(master) = guard.as_ref() else {
            return Ok(false);
        };
        let size = PtySize {
            rows: rows.max(2) as u16,
            cols: cols.max(20) as u16,
            pixel_width: 0,
            pixel_height: 0,
        };
        match master.resize(size) {
            Ok(_) => Ok(true),
            Err(_) => Ok(false),
        }
    }

    pub fn stop(&self, session_id: &str) -> Result<bool, String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let mut active = sessions
            .remove(session_id)
            .ok_or_else(|| "Sessão não encontrada".to_string())?;
        // Kill the child → PTY closes → reader thread exits → exit event emits.
        let _ = active.killer.kill();
        // Drop the writer + master to fully close the PTY.
        if let Ok(mut w) = active.writer.lock() {
            let _ = w.take();
        }
        if let Ok(mut m) = active.master.lock() {
            let _ = m.take();
        }
        Ok(true)
    }

    pub fn get_state(&self) -> Result<Option<LocalTerminalSession>, String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let mut latest: Option<&LocalTerminalSession> = None;
        for active in sessions.values() {
            match latest {
                Some(cur) if active.session.created_at <= cur.created_at => {}
                _ => latest = Some(&active.session),
            }
        }
        Ok(latest.cloned())
    }
}

impl Default for TerminalService {
    fn default() -> Self {
        Self::new()
    }
}

/// Mirror Electron's `TerminalExitEvent`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
    session_id: String,
}

fn resolve_default_shell() -> String {
    if cfg!(target_os = "windows") {
        std::env::var("SHELL")
            .or_else(|_| std::env::var("COMSPEC"))
            .unwrap_or_else(|_| "powershell.exe".to_string())
    } else if cfg!(target_os = "linux") {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
}

fn shell_args_for(shell: &str) -> Vec<String> {
    let name = shell_name_of(shell);
    if name == "zsh" {
        vec![
            "-l".into(),
            "-o".into(),
            "NO_PROMPT_SP".into(),
            "-o".into(),
            "NO_PROMPT_CR".into(),
        ]
    } else if name == "bash" {
        vec!["-l".into()]
    } else if name == "pwsh" || name == "powershell" {
        vec!["-NoLogo".into()]
    } else {
        Vec::new()
    }
}

fn shell_env_for(shell: &str) -> Vec<(&'static str, &'static str)> {
    let name = shell_name_of(shell);
    if name == "zsh" {
        vec![
            ("PROMPT_EOL_MARK", ""),
            ("PROMPT", "%n@%m %1~ %# "),
            ("RPROMPT", ""),
        ]
    } else if name == "bash" {
        vec![("PS1", "\\u@\\h \\w \\$ ")]
    } else {
        Vec::new()
    }
}

fn shell_name_of(shell: &str) -> String {
    let base = shell.rsplit(['/', '\\']).next().unwrap_or(shell);
    base.to_lowercase().trim_end_matches(".exe").to_string()
}

fn resolve_cwd(requested: &str) -> PathBuf {
    let try_path = |p: &str| -> Option<PathBuf> {
        if p.trim().is_empty() {
            return None;
        }
        let path = PathBuf::from(p);
        match std::fs::metadata(&path) {
            Ok(meta) if meta.is_dir() => Some(path),
            _ => None,
        }
    };
    if let Some(p) = try_path(requested) {
        return p;
    }
    if let Ok(cwd) = std::env::current_dir() {
        if cwd.is_dir() {
            return cwd;
        }
    }
    if let Some(home) = dirs::home_dir() {
        return home;
    }
    PathBuf::from("/")
}

/// `<app_data>/bin` holding a `verboo` shim that execs managed node + cli.mjs.
fn terminal_verboo_shim_dir(app: &AppHandle) -> Option<PathBuf> {
    let app_data = app.path().app_data_dir().ok()?;
    let (node_path, cli_mjs_path) = managed_cli_paths()?;
    let shim = write_managed_verboo_shim(&app_data, &node_path, &cli_mjs_path).ok()?;
    shim.parent().map(Path::to_path_buf)
}

fn managed_cli_paths() -> Option<(PathBuf, PathBuf)> {
    match CliSpawn::new(std::iter::empty::<&str>()).runtime {
        CliRuntime::InstalledNode {
            node_path,
            cli_mjs_path,
            ..
        }
        | CliRuntime::DevelopmentOverride {
            node_path,
            cli_mjs_path,
        } => Some((node_path, cli_mjs_path)),
        CliRuntime::Missing => None,
    }
}

fn path_env_for_managed_cli(
    shim_dir: Option<&Path>,
    inherited: Option<OsString>,
) -> Option<OsString> {
    let shim_dir = shim_dir?;
    let mut parts = vec![shim_dir.to_path_buf()];
    if let Some(inherited) = inherited {
        parts.extend(
            std::env::split_paths(&inherited).filter(|path| {
                !path.as_os_str().is_empty() && path != shim_dir
            }),
        );
    }
    std::env::join_paths(parts).ok()
}

fn sh_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn cmd_double_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn unix_verboo_shim(node_path: &Path, cli_mjs_path: &Path) -> String {
    format!(
        "#!/bin/sh\nexec {} {} \"$@\"\n",
        sh_single_quote(&node_path.to_string_lossy()),
        sh_single_quote(&cli_mjs_path.to_string_lossy()),
    )
}

fn windows_verboo_cmd_shim(node_path: &Path, cli_mjs_path: &Path) -> String {
    format!(
        "@echo off\n{} {} %*\n",
        cmd_double_quote(&node_path.to_string_lossy()),
        cmd_double_quote(&cli_mjs_path.to_string_lossy()),
    )
}

fn write_managed_verboo_shim(
    app_data_dir: &Path,
    node_path: &Path,
    cli_mjs_path: &Path,
) -> Result<PathBuf, String> {
    let bin_dir = app_data_dir.join("bin");
    std::fs::create_dir_all(&bin_dir)
        .map_err(|e| format!("failed to create terminal bin dir: {e}"))?;
    let (shim_path, body) = if cfg!(windows) {
        (
            bin_dir.join("verboo.cmd"),
            windows_verboo_cmd_shim(node_path, cli_mjs_path),
        )
    } else {
        (
            bin_dir.join("verboo"),
            unix_verboo_shim(node_path, cli_mjs_path),
        )
    };
    std::fs::write(&shim_path, body).map_err(|e| format!("failed to write verboo shim: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&shim_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("failed to chmod verboo shim: {e}"))?;
    }
    Ok(shim_path)
}

// Startup sanitization (mirrors Electron's localTerminalService helpers)

fn startup_terminal_data(
    startup_buffer: &mut String,
    startup_prompt_sent: &mut bool,
    data: String,
) -> Option<String> {
    if !*startup_prompt_sent {
        *startup_buffer += &data;
        if let Some(prompt) = startup_prompt_from(startup_buffer) {
            *startup_buffer = String::new();
            *startup_prompt_sent = true;
            return Some(prompt);
        }
        return None;
    }
    let sanitized = sanitize_startup_terminal_data(&data);
    if startup_prompt_only(&sanitized) {
        None
    } else {
        Some(sanitized)
    }
}

fn startup_prompt_from(data: &str) -> Option<String> {
    let visible = strip_terminal_controls(data);
    visible
        .lines()
        .find_map(|line| {
            let trimmed = line.trim_end();
            if trimmed.contains('@')
                && (trimmed.ends_with('$')
                    || trimmed.ends_with('#')
                    || trimmed.ends_with('%'))
            {
                Some(trimmed.to_string())
            } else {
                None
            }
        })
}

fn startup_prompt_only(data: &str) -> bool {
    let visible = strip_terminal_controls(data).trim().to_string();
    if visible.is_empty() {
        return false;
    }
    let parts: Vec<&str> = visible.split_whitespace().collect();
    if parts.is_empty() {
        return false;
    }
    parts[0].contains('@')
        && (visible.ends_with('$') || visible.ends_with('#') || visible.ends_with('%'))
}

fn sanitize_startup_terminal_data(data: &str) -> String {
    // Drop leading control chars, ANSI escapes, and pure whitespace.
    let mut out = String::with_capacity(data.len());
    let mut started = false;
    for c in data.chars() {
        if !started {
            if c.is_control() || c == '\x1b' || c == ' ' {
                continue;
            }
            started = true;
        }
        out.push(c);
    }
    strip_terminal_controls(&out)
}

pub(crate) fn strip_terminal_controls(data: &str) -> String {
    // Strip CSI (ESC [ ... terminator), OSC (ESC ] ... BEL/ST), two-byte
    // escapes, and bare control chars. Preserves UTF-8 multi-byte sequences
    // by copying clean regions as &str slices.
    let mut out = String::with_capacity(data.len());
    let bytes = data.as_bytes();
    let mut i = 0;
    let mut run_start = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b {
            if i > run_start {
                out.push_str(std::str::from_utf8(&bytes[run_start..i]).unwrap_or(""));
            }
            if i + 1 >= bytes.len() {
                return out;
            }
            let next = bytes[i + 1];
            if next == b'[' {
                let mut j = i + 2;
                while j < bytes.len() {
                    let c = bytes[j];
                    j += 1;
                    if (0x40..=0x7e).contains(&c) {
                        break;
                    }
                }
                i = j;
                run_start = i;
                continue;
            } else if next == b']' {
                let mut j = i + 2;
                while j < bytes.len() {
                    let c = bytes[j];
                    j += 1;
                    if c == 0x07 {
                        break;
                    }
                    if c == 0x1b && j < bytes.len() && bytes[j] == b'\\' {
                        j += 1;
                        break;
                    }
                }
                i = j;
                run_start = i;
                continue;
            } else if (0x40..=0x5f).contains(&next) {
                i += 2;
                run_start = i;
                continue;
            }
            i += 1;
            run_start = i;
            continue;
        }
        if (b < 0x20 && b != b'\n' && b != b'\r' && b != b'\t') || b == 0x7f {
            if i > run_start {
                out.push_str(std::str::from_utf8(&bytes[run_start..i]).unwrap_or(""));
            }
            i += 1;
            run_start = i;
            continue;
        }
        i += 1;
    }
    if i > run_start {
        out.push_str(std::str::from_utf8(&bytes[run_start..i]).unwrap_or(""));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn shell_args_match_electron() {
        assert_eq!(
            shell_args_for("/bin/zsh"),
            vec!["-l", "-o", "NO_PROMPT_SP", "-o", "NO_PROMPT_CR"]
        );
        assert_eq!(shell_args_for("/bin/bash"), vec!["-l"]);
        assert_eq!(shell_args_for("pwsh"), vec!["-NoLogo"]);
        assert_eq!(shell_args_for("powershell.exe"), vec!["-NoLogo"]);
    }

    #[test]
    fn shell_name_handles_windows_paths() {
        assert_eq!(shell_name_of("/bin/zsh"), "zsh");
        assert_eq!(shell_name_of("C:\\Windows\\System32\\pwsh.EXE"), "pwsh");
        assert_eq!(shell_name_of("powershell"), "powershell");
    }

    #[test]
    fn strip_terminal_controls_strips_csi_osc_and_controls() {
        let input = "\x1b[31mred\x1b[0m text";
        assert_eq!(strip_terminal_controls(input), "red text");

        let input = "\x1b]0;title\x07body";
        assert_eq!(strip_terminal_controls(input), "body");

        let input = "a\x07b";
        assert_eq!(strip_terminal_controls(input), "ab");
    }

    #[test]
    fn strip_terminal_controls_preserves_utf8() {
        let input = "café \x1b[31mred\x1b[0m 日本語";
        assert_eq!(strip_terminal_controls(input), "café red 日本語");
    }

    #[test]
    fn startup_prompt_from_detects_prompt_line() {
        let data = "Last login: ...\nuser@host ~ % ";
        // trim_end is applied inside startup_prompt_from
        assert_eq!(startup_prompt_from(data), Some("user@host ~ %".to_string()));

        let data = "no prompt here";
        assert_eq!(startup_prompt_from(data), None);
    }

    #[test]
    fn startup_prompt_only_distinguishes_prompt_lines() {
        assert!(startup_prompt_only("user@host ~ %"));
        assert!(!startup_prompt_only("echo hello"));
        assert!(!startup_prompt_only(""));
    }

    #[test]
    fn unix_shim_quotes_paths_with_spaces_and_forwards_args() {
        let script = unix_verboo_shim(
            Path::new("/Users/me/Verboo App/node"),
            Path::new("/Users/me/Verboo App/cli/dist/cli.mjs"),
        );
        assert!(script.starts_with("#!/bin/sh\n"), "{script}");
        assert!(script.contains("exec '/Users/me/Verboo App/node' '/Users/me/Verboo App/cli/dist/cli.mjs' \"$@\""), "{script}");
        assert!(!script.contains("/Users/grasel/Documents"), "{script}");
    }

    #[test]
    fn unix_shim_escapes_single_quotes_in_paths() {
        let script = unix_verboo_shim(Path::new("/tmp/o'brien/node"), Path::new("/tmp/cli.mjs"));
        assert!(script.contains("'/tmp/o'\\''brien/node'"), "{script}");
    }

    #[test]
    fn windows_cmd_shim_quotes_paths_with_spaces_and_forwards_args() {
        let script = windows_verboo_cmd_shim(
            Path::new(r"C:\Program Files\Verboo\node.exe"),
            Path::new(r"C:\Program Files\Verboo\cli\dist\cli.mjs"),
        );
        assert!(script.contains("@echo off"), "{script}");
        assert!(
            script.contains(r#""C:\Program Files\Verboo\node.exe" "C:\Program Files\Verboo\cli\dist\cli.mjs" %*"#),
            "{script}"
        );
    }

    #[test]
    fn path_env_is_untouched_when_managed_cli_is_missing() {
        let inherited = std::ffi::OsString::from("/usr/bin:/bin");
        assert_eq!(
            path_env_for_managed_cli(None, Some(inherited.clone())),
            None
        );
    }

    #[test]
    fn path_env_prepends_shim_dir_when_managed_cli_is_installed() {
        let shim = PathBuf::from("/app/data/bin");
        let inherited = std::env::join_paths([
            Path::new("/usr/local/bin"),
            Path::new("/usr/bin"),
        ])
        .unwrap();
        let combined = path_env_for_managed_cli(Some(&shim), Some(inherited)).expect("PATH");
        let parts: Vec<PathBuf> = std::env::split_paths(&combined).collect();
        assert_eq!(parts.first().map(PathBuf::as_path), Some(shim.as_path()));
        assert!(parts.iter().any(|p| p == Path::new("/usr/local/bin")), "{parts:?}");
        assert!(parts.iter().any(|p| p == Path::new("/usr/bin")), "{parts:?}");
    }

    #[test]
    fn write_shim_points_at_current_cli_and_is_executable_on_unix() {
        let root = tempfile::tempdir().unwrap();
        let node = root.path().join("runtime").join("node with space");
        let cli = root.path().join("cli").join("0.15.17").join("dist").join("cli.mjs");
        std::fs::create_dir_all(node.parent().unwrap()).unwrap();
        std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
        std::fs::write(&node, b"node").unwrap();
        std::fs::write(&cli, b"cli").unwrap();

        let bin = write_managed_verboo_shim(root.path(), &node, &cli).expect("shim");
        #[cfg(windows)]
        {
            assert_eq!(bin.file_name().and_then(|n| n.to_str()), Some("verboo.cmd"));
            let body = std::fs::read_to_string(&bin).unwrap();
            assert!(body.contains("%*"), "{body}");
            assert!(body.contains(&format!("\"{}\"", node.display())), "{body}");
        }
        #[cfg(not(windows))]
        {
            assert_eq!(bin.file_name().and_then(|n| n.to_str()), Some("verboo"));
            let body = std::fs::read_to_string(&bin).unwrap();
            assert!(body.contains("\"$@\""), "{body}");
            assert!(body.contains(&sh_single_quote(&node.to_string_lossy())), "{body}");
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&bin).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o755, "unix shim must be executable");
        }

        let newer_cli = root.path().join("cli").join("0.16.0").join("dist").join("cli.mjs");
        std::fs::create_dir_all(newer_cli.parent().unwrap()).unwrap();
        std::fs::write(&newer_cli, b"cli2").unwrap();
        write_managed_verboo_shim(root.path(), &node, &newer_cli).unwrap();
        let body = std::fs::read_to_string(&bin).unwrap();
        assert!(body.contains("0.16.0"), "{body}");
        assert!(!body.contains("0.15.17"), "{body}");
    }
}
