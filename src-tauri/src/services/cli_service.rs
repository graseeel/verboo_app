use std::process::Command;

use tauri::{AppHandle, Emitter};

use crate::models::types::{CliAuthStatus, LoginEvent, LoginEventKind, LoginResult};

/// Spawns the bundled `verboo` CLI to perform auth operations.
///
/// Resolution order (mirrors Electron's `resolveCliPath`):
///   1. `VERBOO_CLI_PATH` env var (explicit override)
///   2. `verboo` on PATH (system install — works in dev and on machines with
///      `npm i -g @verboo/code`)
///   3. (Fase 2+) bundled `@verboo/code/dist/cli.mjs` via bundled Node sidecar
///
/// For now we rely on (1) and (2). The bundled-CLI path requires the Node
/// sidecar (R0) which lands in a later phase.

pub struct CliService;

impl CliService {
    pub fn new() -> Self {
        Self
    }

    /// Returns the path to the `verboo` CLI executable, if findable.
    fn resolve_cli_path() -> Option<String> {
        crate::services::cli_path::resolve().or_else(|| Some("verboo".to_string()))
    }

    /// Runs `verboo auth status --json` and parses the result.
    pub fn get_auth_status(&self) -> Result<CliAuthStatus, String> {
        // Use CliSpawn (resolves Node + bundled cli.mjs / VERBOO_CLI_PATH /
        // global verboo) instead of spawning `verboo` by name directly.
        let spawn = crate::services::cli_spawn::CliSpawn::new(["auth", "status", "--json"]);
        let mut cmd = spawn.command;
        let output = cmd
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| format!("Falha ao executar CLI Verboo: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if let Some(parsed) = parse_auth_status_payload(&stdout) {
            return Ok(parsed);
        }

        Ok(CliAuthStatus {
            logged_in: false,
            auth_method: None,
            api_provider: None,
            email: None,
            org_id: None,
            org_name: None,
            subscription_type: None,
            error: Some(if stderr.trim().is_empty() {
                if stdout.trim().is_empty() {
                    "Não foi possível ler o status do CLI Verboo.".to_string()
                } else {
                    stdout
                }
            } else {
                stderr
            }),
        })
    }

    /// A1: Non-blocking CLI login. Spawns `verboo auth login` and returns
    /// immediately. A background thread reads stdout incrementally and
    /// emits `login:event` Tauri events as the login progresses:
    ///   - `Url`      → when a login URL is detected in stdout
    ///   - `Complete` → when the CLI process exits (success or failure)
    ///   - `Error`    → if spawn itself fails (infra error)
    ///
    /// Why this replaces the old `.output()` call: `.output()` blocks the
    /// Tauri command thread until the child exits. The CLI login flow
    /// waits for a browser callback that can take minutes, so the command
    /// thread froze ("Nao esta respondendo" on Windows). On Linux the CLI
    /// couldn't open a browser without a TTY and failed silently (issue
    /// #59). Reading stdout incrementally lets us surface the URL to the
    /// renderer even before the process exits, so the frontend can open
    /// the browser itself.
    ///
    /// Returns immediately with an empty `LoginResult` (the real result
    /// arrives via events). The `ok` flag here only signals that the
    /// spawn succeeded, not that login succeeded.
    pub fn start_cli_login_nonblocking(
        &self,
        app: AppHandle,
    ) -> Result<LoginResult, String> {
        let (mut child, mut stdout_pipe, mut stderr_pipe) = match Self::spawn_login_child() {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit(
                    "login:event",
                    LoginEvent {
                        kind: LoginEventKind::Error,
                        url: None,
                        message: Some(format!("Falha ao iniciar login do CLI Verboo: {e}")),
                        ok: None,
                        status: None,
                    },
                );
                return Err(format!("Falha ao iniciar login do CLI Verboo: {e}"));
            }
        };

        // Spawn the reader thread. We capture login URL events as they
        // stream, then wait for the child to exit and emit a final
        // Complete event with the post-login auth status.
        let app_for_thread = app.clone();
        std::thread::spawn(move || {
            use std::io::Read;
            let mut stdout_buf = String::new();
            let mut stderr_buf = String::new();
            let mut url_emitted = false;

            // Read stdout incrementally, scanning for a login URL.
            let mut chunk = [0u8; 4096];
            loop {
                match stdout_pipe.read(&mut chunk) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        let s = String::from_utf8_lossy(&chunk[..n]).to_string();
                        stdout_buf.push_str(&s);
                        if !url_emitted {
                            if let Some(url) = extract_login_url(&stdout_buf) {
                                let _ = app_for_thread.emit(
                                    "login:event",
                                    LoginEvent {
                                        kind: LoginEventKind::Url,
                                        url: Some(url),
                                        message: None,
                                        ok: None,
                                        status: None,
                                    },
                                );
                                url_emitted = true;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }

            // Drain stderr.
            let mut chunk = [0u8; 4096];
            loop {
                match stderr_pipe.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => stderr_buf.push_str(&String::from_utf8_lossy(&chunk[..n])),
                    Err(_) => break,
                }
            }

            let status = child.wait().ok();

            let next_status = CliService::new().get_auth_status().unwrap_or(CliAuthStatus {
                logged_in: false,
                auth_method: None,
                api_provider: None,
                email: None,
                org_id: None,
                org_name: None,
                subscription_type: None,
                error: None,
            });

            let exit_ok = status.map(|s| s.success()).unwrap_or(false);
            let ok = next_status.logged_in || exit_ok;

            let message = if !stdout_buf.trim().is_empty() {
                stdout_buf
            } else if !stderr_buf.trim().is_empty() {
                stderr_buf
            } else if next_status.logged_in {
                "Login concluído.".to_string()
            } else {
                "Login não concluído.".to_string()
            };

            let _ = app_for_thread.emit(
                "login:event",
                LoginEvent {
                    kind: LoginEventKind::Complete,
                    url: None,
                    message: Some(message),
                    ok: Some(ok),
                    status: Some(next_status),
                },
            );
        });

        Ok(LoginResult {
            ok: true,
            message: "Login iniciado em background.".to_string(),
            status: None,
        })
    }

    /// A1: extracted from `start_cli_login_nonblocking` for testability.
    /// Spawns the auth login child and returns the alive `Child` plus
    /// the stdout/stderr pipes for incremental reading.
    pub fn spawn_login_child(
    ) -> std::io::Result<(
        std::process::Child,
        std::process::ChildStdout,
        std::process::ChildStderr,
    )> {
        let spawn = crate::services::cli_spawn::CliSpawn::new(["auth", "login"]);
        let mut cmd = spawn.command;
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        // A2-FIX (2026-07-29): creation_flags already applied by
        // CliSpawn::new (cli_spawn.rs). No need to re-apply here.
        let mut child = cmd.spawn()?;
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");
        Ok((child, stdout, stderr))
    }

    /// Runs `verboo auth logout`.
    pub fn logout(&self) -> Result<LoginResult, String> {
        let spawn = crate::services::cli_spawn::CliSpawn::new(["auth", "logout"]);
        let mut cmd = spawn.command;
        let output = cmd
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| format!("Falha ao executar logout do CLI Verboo: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        let next_status = self.get_auth_status().unwrap_or(CliAuthStatus {
            logged_in: false,
            auth_method: None,
            api_provider: None,
            email: None,
            org_id: None,
            org_name: None,
            subscription_type: None,
            error: None,
        });

        let message = if !stdout.trim().is_empty() {
            stdout
        } else if !stderr.trim().is_empty() {
            stderr
        } else if !next_status.logged_in {
            "Sessão Verboo encerrada.".to_string()
        } else {
            "Não foi possível encerrar a sessão Verboo.".to_string()
        };

        Ok(LoginResult {
            ok: !next_status.logged_in,
            message,
            status: Some(next_status),
        })
    }
}

impl Default for CliService {
    fn default() -> Self {
        Self::new()
    }
}

/// A1: Extracts a login URL from CLI stdout. The CLI prints the OAuth
/// URL for the user to open in a browser. We scan for `http://` or
/// `https://` followed by non-whitespace, non-quote characters. Returns
/// the first match. The URL typically appears on its own line like:
///   `Open https://verboo.ai/auth?token=abc123 in your browser.`
/// We extract just the URL, not the surrounding prose.
fn extract_login_url(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        for prefix in ["https://", "http://"] {
            if let Some(idx) = line.find(prefix) {
                let rest = &line[idx..];
                // URL ends at first whitespace, quote, or end of line.
                let end = rest
                    .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
                    .unwrap_or(rest.len());
                let url = &rest[..end];
                if !url.is_empty() {
                    return Some(url.to_string());
                }
            }
        }
    }
    None
}

/// Mirrors Electron's `parseAuthStatusPayload`: tries the span from the first
/// `{` to the last `}`, then the whole output, then each line. First object
/// with a boolean `loggedIn` wins, so surrounding noise is ignored.
fn parse_auth_status_payload(output: &str) -> Option<CliAuthStatus> {
    let first_brace = output.find('{');
    let last_brace = output.rfind('}');
    let span = match (first_brace, last_brace) {
        (Some(f), Some(l)) if l > f => Some(output[f..=l].to_string()),
        _ => None,
    };

    let mut candidates: Vec<String> = Vec::new();
    if let Some(s) = span {
        candidates.push(s);
    }
    candidates.push(output.to_string());
    candidates.extend(output.lines().map(|l| l.to_string()));

    for candidate in candidates {
        if candidate.trim().is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&candidate) {
            if let Some(obj) = value.as_object() {
                if let Some(logged_in) = obj.get("loggedIn").and_then(|v| v.as_bool()) {
                    return Some(CliAuthStatus {
                        logged_in,
                        auth_method: obj
                            .get("authMethod")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        api_provider: obj
                            .get("apiProvider")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        email: obj
                            .get("email")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        org_id: obj
                            .get("orgId")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        org_name: obj
                            .get("orgName")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        subscription_type: obj
                            .get("subscriptionType")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string()),
                        error: None,
                    });
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_status_extracts_logged_in_fields() {
        let payload = r#"{
            "loggedIn": true,
            "authMethod": "claude.ai",
            "apiProvider": "firstParty",
            "email": "user@example.com",
            "orgId": "org-123",
            "orgName": null,
            "subscriptionType": null
        }"#;
        let status = parse_auth_status_payload(payload).expect("parsed");
        assert!(status.logged_in);
        assert_eq!(status.auth_method.as_deref(), Some("claude.ai"));
        assert_eq!(status.email.as_deref(), Some("user@example.com"));
        assert_eq!(status.org_name, None);
        assert_eq!(status.subscription_type, None);
    }

    #[test]
    fn parse_status_tolerates_surrounding_noise() {
        let payload = "warning: update available\n{\"loggedIn\":false}\nrun `verboo update`\n";
        let status = parse_auth_status_payload(payload).expect("parsed");
        assert!(!status.logged_in);
    }

    #[test]
    fn parse_status_returns_none_when_no_object() {
        assert!(parse_auth_status_payload("not json at all").is_none());
        assert!(parse_auth_status_payload("{\"foo\":\"bar\"}").is_none());
    }

    // ── A1: non-blocking login regression tests ──────────────────────
    //
    // QA gate: two tests using a FAKE CLI via VERBOO_CLI_PATH pointing
    // to a script that prints a login URL and sleeps 30 seconds. The
    // tests must prove:
    //   (i)  spawn_login_child() returns in < 1 second. If any .output()
    //        leaked into the path, the test would block on the 30s
    //        sleep and fail.
    //   (ii) reading stdout incrementally extracts the URL within ~2
    //        seconds of spawn, BEFORE the 30s sleep completes.

    /// Helper: write a fake CLI script that prints a login URL and
    /// sleeps for `sleep_secs`, and return its path. Sets VERBOO_CLI_PATH
    /// so CliSpawn::new picks it up.
    fn write_fake_cli(script_body: &str, suffix: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "verboo-fake-cli-{}-{suffix}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cli.mjs");
        std::fs::write(&path, script_body).unwrap();
        // Make executable on unix.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perm = std::fs::metadata(&path).unwrap().permissions();
            perm.set_mode(0o755);
            std::fs::set_permissions(&path, perm).unwrap();
        }
        // SAFETY: setting env var in a test is intentional. Tests are
        // serialized via A1_FAKE_CLI_GUARD so the env var doesn't race
        // between parallel test threads.
        unsafe {
            std::env::set_var("VERBOO_CLI_PATH", &path);
        }
        path
    }

    fn unset_fake_cli() {
        unsafe { std::env::remove_var("VERBOO_CLI_PATH"); }
    }

    /// Serializes the A1 fake-CLI tests so VERBOO_CLI_PATH doesn't race
    /// between parallel test threads. cargo test runs in parallel
    /// by default; without this guard, test (ii) could pick up the env
    /// var set by test (i) and read the wrong child's stdout.
    static A1_FAKE_CLI_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A1b-GUARD (2026-07-30): the fake CLI is a .mjs script spawned via
    /// `node <cli.mjs>`. The Linux CI Docker container
    /// (browser-linux-check.sh) does NOT install Node.js — it only
    /// installs build-essential, pkg-config, and the WebKitGTK system
    /// libraries.
    ///
    /// INVERTED to FAIL-BY-DEFAULT per QA feedback 2026-07-30: the
    /// previous `eprintln! + return` pattern was captured by the
    /// cargo test harness when the test passed, making the skip
    /// invisible. A green light that doesn't prove anything is the
    /// exact defect this project has been bitten by (workspace_files
    /// silent skip, stub with cfg returning Ok). Now:
    ///
    ///   - Default (no env var): if Node is missing, the test PANICS
    ///     with a FAIL message — visible in `cargo test` output and CI
    ///     log regardless of harness capture. The CI script must then
    ///     fix the runner (install Node) or add this test to `--skip`.
    ///
    ///   - Opt-out: set `VERBOO_SKIP_NODE_TESTS=1` to skip with a
    ///     SKIPPED panic message — still visible, still distinguishes
    ///     "explicitly opted out" from "should have run". CI should
    ///     NEVER set this — fix the runner instead.
    ///
    /// PRENSA is pinning Node 22 in the browser-linux-check Dockerfile
    /// (authorized by user 2026-07-30). After that lands, Node WILL be
    /// available on Linux CI and these tests will run normally. The
    /// panic guard is the safety net for the transition window, not
    /// the permanent path.
    fn node_available() -> bool {
        std::process::Command::new("node")
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Precheck for A1 tests. Returns silently if Node is available.
    /// Panics (FAIL or SKIPPED) if Node is missing — always visible in
    /// cargo test output. See `node_available` doc for rationale.
    fn a1_node_precheck() {
        if node_available() {
            return;
        }
        let skip_requested = std::env::var_os("VERBOO_SKIP_NODE_TESTS")
            .as_deref()
            == Some(std::ffi::OsStr::new("1"));
        if skip_requested {
            panic!(
                "A1 SKIPPED (VERBOO_SKIP_NODE_TESTS=1): Node is not available \
                 on PATH. This test SHOULD run where Node is installed. \
                 CI: add this test to --skip in browser-linux-check.sh, \
                 or install Node (PRENSA Dockerfile pins Node 22)."
            );
        }
        panic!(
            "A1 FAIL-BY-DEFAULT: Node is not available on PATH. A1 tests \
             require Node to spawn the fake CLI for the non-blocking \
             login regression check. Fix: install Node on this runner. \
             Local opt-out (NOT for CI): VERBOO_SKIP_NODE_TESTS=1."
        );
    }

    #[test]
    fn a1_spawn_returns_in_less_than_one_second() {
        let _guard = A1_FAKE_CLI_GUARD.lock().unwrap();
        a1_node_precheck();
        // QA criterion (i): if any .output() leaked, this would block
        // on the 30s sleep. CliSpawn invokes the fake via `node
        // <cli.mjs>` (from VERBOO_CLI_PATH env var), so the script body
        // is the JS source, not a shebang script.
        let script = r#"
            process.stdout.write('Open https://verboo.example/auth?token=abc123 in your browser.\n');
            const start = Date.now();
            while (Date.now() - start < 30000) {} // busy sleep 30s
            process.exit(0);
        "#;
        let _path = write_fake_cli(script, "spawn");
        let t0 = std::time::Instant::now();
        let result = crate::services::cli_service::CliService::spawn_login_child();
        let elapsed = t0.elapsed();
        let (mut child, _stdout, _stderr) =
            result.expect("spawn must succeed without blocking on the child's 30s sleep");
        // Kill the child so we don't leave a process running.
        let _ = child.kill();
        let _ = child.wait();
        unset_fake_cli();
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "A1 criterion (i): spawn must return in <1s; took {:?}. \
             If you see this, .output() leaked into the path.",
            elapsed
        );
    }

    #[test]
    fn a1_url_extracted_before_process_exits() {
        let _guard = A1_FAKE_CLI_GUARD.lock().unwrap();
        a1_node_precheck();
        // QA criterion (ii): the URL must be reachable via incremental
        // stdout reading BEFORE the 30s sleep ends. If we waited for
        // process exit before reading, we'd miss the deadline.
        let script = r#"
            process.stdout.write('Open https://verboo.example/auth?token=xyz789 in your browser.\n');
            const start = Date.now();
            while (Date.now() - start < 30000) {}
            process.exit(0);
        "#;
        let _path = write_fake_cli(script, "url");
        let t0 = std::time::Instant::now();
        let (mut child, mut stdout_pipe, _stderr_pipe) =
            crate::services::cli_service::CliService::spawn_login_child()
                .expect("spawn must succeed");
        // Read stdout incrementally and try to extract the URL.
        use std::io::Read;
        let mut buf = String::new();
        let mut chunk = [0u8; 4096];
        let mut url_found_at: Option<std::time::Duration> = None;
        let deadline = t0 + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            match stdout_pipe.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    buf.push_str(&String::from_utf8_lossy(&chunk[..n]));
                    if extract_login_url(&buf).is_some() {
                        url_found_at = Some(t0.elapsed());
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        unset_fake_cli();
        let url = extract_login_url(&buf);
        assert!(
            url.is_some(),
            "A1 criterion (ii): URL must be extractable from incremental stdout"
        );
        assert_eq!(
            url.as_deref(),
            Some("https://verboo.example/auth?token=xyz789"),
            "URL must match what the fake CLI printed"
        );
        assert!(
            url_found_at.unwrap() < std::time::Duration::from_secs(2),
            "A1: URL must be extractable in <2s, well before the 30s sleep. Took {:?}.",
            url_found_at
        );
    }

    #[test]
    fn a1_extract_login_url_handles_common_shapes() {
        // Sanity: the URL extractor handles the shapes real CLI auth
        // commands print.
        assert_eq!(
            extract_login_url("Open https://verboo.example/auth?token=abc in your browser."),
            Some("https://verboo.example/auth?token=abc".into())
        );
        assert_eq!(
            extract_login_url("Please open http://localhost:3000/login"),
            Some("http://localhost:3000/login".into())
        );
        assert_eq!(
            extract_login_url("Visit https://x.test/oauth?a=1&b=2 now."),
            Some("https://x.test/oauth?a=1&b=2".into())
        );
        assert_eq!(
            extract_login_url("warning: no url here"),
            None
        );
    }
}
