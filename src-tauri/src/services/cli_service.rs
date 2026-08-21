use tauri::{AppHandle, Emitter, Runtime};

use crate::models::types::{CliAuthStatus, LoginEvent, LoginEventKind, LoginResult};

/// Runs authentication operations through the app-owned CLI runtime.
///
/// Production uses the signed CLI and managed Node runtime selected under app
/// data. Debug builds may opt into an explicit Node/CLI path pair.

pub struct CliService;

impl CliService {
    pub fn new() -> Self {
        Self
    }

    /// Runs `verboo auth status --json` and parses the result.
    ///
    /// T-B (2026-08-07): if the CLI runtime is missing (no Node, no
    /// `verboo` on PATH), returns `Ok(CliAuthStatus { logged_in: false,
    /// error: Some(typed_message) })` — NOT `Err`. The renderer's login
    /// gate calls this to check the session; an `Err` left the user
    /// stuck at "Verificando sessão local do Verboo…" even with a valid
    /// API key. Returning `Ok(logged_in: false)` lets the renderer
    /// proceed to the API-key path and unlock without the CLI.
    pub fn get_auth_status(&self) -> Result<CliAuthStatus, String> {
        // CliSpawn pins one immutable, app-owned CLI version for this process.
        let spawn = crate::services::cli_spawn::CliSpawn::new(["auth", "status", "--json"]);
        // T-B: explicit Missing check — return Ok(logged_in: false) with
        // a typed error, NOT Err. This unblocks the API-key gate.
        if spawn.runtime == crate::services::cli_spawn::CliRuntime::Missing {
            return Ok(CliAuthStatus {
                logged_in: false,
                auth_method: None,
                api_provider: None,
                email: None,
                org_id: None,
                org_name: None,
                subscription_type: None,
                error: Some(crate::services::cli_spawn::runtime_missing_error()),
            });
        }
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
    pub fn start_cli_login_nonblocking<R: Runtime>(
        &self,
        app: AppHandle<R>,
        flow_id: Option<u64>,
    ) -> Result<LoginResult, String> {
        let (mut child, mut stdout_pipe, mut stderr_pipe) = match Self::spawn_login_child() {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit(
                    "login:event",
                    LoginEvent {
                        kind: LoginEventKind::Error,
                        flow_id,
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
                                        flow_id,
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
                    flow_id,
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
    ///
    /// T-A (2026-08-07): pre-checks the CLI runtime BEFORE spawning. On a
    /// clean machine (no Node, no `verboo` on PATH) the old code fell
    /// through to `Command::new("verboo")` by elimination and `spawn()`
    /// returned raw ENOENT ("No such file or directory (os error 2)") —
    /// which leaked to the UI as "Falha ao iniciar login do CLI Verboo:
    /// No such file or directory (os error 2)". Now we surface a typed
    /// `io::Error` with a user-facing message that also points to the
    /// API-key alternative.
    pub fn spawn_login_child(
    ) -> std::io::Result<(
        std::process::Child,
        std::process::ChildStdout,
        std::process::ChildStderr,
    )> {
        let spawn = crate::services::cli_spawn::CliSpawn::new(["auth", "login"]);
        // T-A: explicit Missing check — never let the raw ENOENT leak.
        if spawn.runtime == crate::services::cli_spawn::CliRuntime::Missing {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                crate::services::cli_spawn::runtime_missing_error(),
            ));
        }
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
    ///
    /// T-A (2026-08-07): if the CLI runtime is missing, returns
    /// `Ok(LoginResult { ok: true, ... })` — there's no CLI session to
    /// log out of, so the operation "succeeds" (the user's intent —
    /// clear the session — is satisfied). Avoids leaking ENOENT.
    pub fn logout(&self) -> Result<LoginResult, String> {
        let spawn = crate::services::cli_spawn::CliSpawn::new(["auth", "logout"]);
        if spawn.runtime == crate::services::cli_spawn::CliRuntime::Missing {
            // No CLI runtime → no CLI session to clear. Report success.
            return Ok(LoginResult {
                ok: true,
                message: "Sessão Verboo encerrada.".to_string(),
                status: Some(CliAuthStatus {
                    logged_in: false,
                    auth_method: None,
                    api_provider: None,
                    email: None,
                    org_id: None,
                    org_name: None,
                    subscription_type: None,
                    error: None,
                }),
            });
        }
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
    use tauri::Listener;

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

    // ── T-A / T-B (2026-08-07): no-CLI-runtime gate ──────────────────
    //
    // On a clean machine (no Node, no `verboo` on PATH) the old code
    // leaked raw ENOENT ("No such file or directory (os error 2)") to
    // the UI. T-A: spawn_login_child returns a typed io::Error. T-B:
    // get_auth_status returns Ok(logged_in: false) — NOT Err — so the
    // renderer's API-key gate can proceed and unlock without the CLI.

    struct NoRuntimeGuard;

    impl Drop for NoRuntimeGuard {
        fn drop(&mut self) {
            std::env::remove_var("VERBOO_TEST_NO_NODE");
            std::env::remove_var("VERBOO_TEST_NO_VERBOO");
        }
    }

    fn set_no_runtime() -> NoRuntimeGuard {
        std::env::set_var("VERBOO_TEST_NO_NODE", "1");
        std::env::set_var("VERBOO_TEST_NO_VERBOO", "1");
        std::env::remove_var("VERBOO_CLI_PATH");
        std::env::remove_var("VERBOO_NODE_PATH");
        std::env::remove_var("NODE_BINARY");
        std::env::remove_var("NODE");
        NoRuntimeGuard
    }

    #[test]
    fn a1_login_error_event_echoes_flow_id_and_legacy_omits_it() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _no_runtime = set_no_runtime();
        let app = tauri::test::mock_app();
        let app_handle = app.handle().clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        let listener = app_handle.listen("login:event", move |event| {
            let payload: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
            sender.send(payload).unwrap();
        });
        let cli = CliService::new();

        assert!(cli
            .start_cli_login_nonblocking(app_handle.clone(), Some(41))
            .is_err());
        let with_id = receiver
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("spawn failure must emit a login event");
        assert_eq!(with_id["kind"], "error");
        assert_eq!(with_id["flowId"], 41);

        assert!(cli
            .start_cli_login_nonblocking(app_handle.clone(), None)
            .is_err());
        let legacy = receiver
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("legacy spawn failure must still emit a login event");
        assert_eq!(legacy["kind"], "error");
        assert!(!legacy
            .as_object()
            .expect("login event must serialize as an object")
            .contains_key("flowId"));

        app_handle.unlisten(listener);
    }

    #[test]
    fn a1_login_url_and_complete_events_echo_the_same_flow_id() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        a1_node_precheck();
        let script = r#"
            process.stdout.write('Open https://verboo.example/auth?token=flow-id in your browser.\n', () => {
                process.exit(0);
            });
        "#;
        let _path = write_fake_cli(script, "flow-id");
        let app = tauri::test::mock_app();
        let app_handle = app.handle().clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        let listener = app_handle.listen("login:event", move |event| {
            let payload: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
            sender.send(payload).unwrap();
        });
        let cli = CliService::new();

        assert!(cli
            .start_cli_login_nonblocking(app_handle.clone(), Some(73))
            .is_ok());
        let url = receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("URL event must arrive");
        let complete = receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("complete event must arrive");

        assert_eq!(url["kind"], "url");
        assert_eq!(url["flowId"], 73);
        assert_eq!(complete["kind"], "complete");
        assert_eq!(complete["flowId"], 73);

        app_handle.unlisten(listener);
        unset_fake_cli();
    }

    #[test]
    fn login_event_omits_flow_id_when_absent_for_every_kind() {
        let events = [
            LoginEvent {
                kind: LoginEventKind::Error,
                flow_id: None,
                url: None,
                message: Some("spawn failed".to_string()),
                ok: None,
                status: None,
            },
            LoginEvent {
                kind: LoginEventKind::Url,
                flow_id: None,
                url: Some("https://verboo.example/auth".to_string()),
                message: None,
                ok: None,
                status: None,
            },
            LoginEvent {
                kind: LoginEventKind::Complete,
                flow_id: None,
                url: None,
                message: Some("done".to_string()),
                ok: Some(true),
                status: Some(CliAuthStatus {
                    logged_in: true,
                    auth_method: None,
                    api_provider: None,
                    email: None,
                    org_id: None,
                    org_name: None,
                    subscription_type: None,
                    error: None,
                }),
            },
        ];

        for event in events {
            let payload = serde_json::to_value(event).expect("login event must serialize");
            assert!(!payload
                .as_object()
                .expect("login event must serialize as an object")
                .contains_key("flowId"));
        }
    }

    /// T-A: `spawn_login_child` returns a typed `io::Error` when the
    /// runtime is missing — never raw ENOENT ("os error 2").
    ///
    /// Mutation: revert `spawn_login_child` to skip the Missing check
    /// → `cmd.spawn()` fails with ENOENT → message contains
    /// "No such file or directory (os error 2)" → assertions FAIL.
    /// Named mutation:
    /// `spawn_login_child_leaks_raw_enoent_when_runtime_missing`.
    #[test]
    fn spawn_login_child_returns_typed_error_when_runtime_missing() {
        let _guard =
            crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _no_runtime = set_no_runtime();

        let result = CliService::spawn_login_child();
        assert!(result.is_err(), "spawn must fail when runtime missing");
        let err = result.unwrap_err();
        let msg = err.to_string();
        assert!(
            !msg.contains("os error"),
            "error must not contain raw OS errno; got: {msg}"
        );
        assert!(
            !msg.contains("No such file or directory"),
            "error must not contain raw errno text; got: {msg}"
        );
        assert!(
            msg.contains("CLI do Verboo") && msg.contains("primeira inicialização"),
            "error should explain the signed CLI bootstrap; got: {msg}"
        );
    }

    /// T-B: `get_auth_status` returns `Ok(logged_in: false)` with a
    /// typed error message when the runtime is missing — NOT `Err`.
    /// The renderer's login gate calls this to check the session; an
    /// `Err` left the user stuck at "Verificando sessão local do
    /// Verboo…" even with a valid API key. Returning `Ok(logged_in:
    /// false)` lets the renderer proceed to the API-key path.
    ///
    /// Mutation: revert `get_auth_status` to skip the Missing check →
    /// `cmd.output()` fails → `Err("Falha ao executar CLI Verboo:
    /// No such file or directory (os error 2)")` → `is_ok()` FAILS.
    /// Named mutation:
    /// `get_auth_status_returns_err_when_runtime_missing_blocks_api_key`.
    #[test]
    fn get_auth_status_returns_ok_not_err_when_runtime_missing() {
        let _guard =
            crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _no_runtime = set_no_runtime();

        let cli = CliService::new();
        let result = cli.get_auth_status();
        assert!(
            result.is_ok(),
            "get_auth_status must return Ok (not Err) when runtime missing so the API-key gate can proceed"
        );
        let status = result.unwrap();
        assert!(
            !status.logged_in,
            "logged_in must be false when runtime missing"
        );
        let err_msg = status.error.expect("error field should carry typed message");
        assert!(
            !err_msg.contains("os error"),
            "error field must not contain raw errno; got: {err_msg}"
        );
        assert!(
            err_msg.contains("CLI do Verboo") && err_msg.contains("primeira inicialização"),
            "error field should explain the signed CLI bootstrap; got: {err_msg}"
        );
    }

    /// T-A: `logout` returns `Ok(ok: true)` when the runtime is
    /// missing — there's no CLI session to log out of, so the
    /// operation "succeeds". Avoids leaking ENOENT.
    #[test]
    fn logout_returns_ok_when_runtime_missing() {
        let _guard =
            crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _no_runtime = set_no_runtime();

        let cli = CliService::new();
        let result = cli.logout();
        assert!(
            result.is_ok(),
            "logout must return Ok when runtime missing (no session to clear)"
        );
        let login_result = result.unwrap();
        assert!(login_result.ok, "logout should report success");
    }

    // ── A1: non-blocking login regression tests ──────────────────────
    //
    // QA gate: two tests using a FAKE CLI via VERBOO_CLI_PATH pointing
    // to a script that prints a login URL and stays alive for its configured
    // fake-child lifetime. The
    // tests must prove:
    //   (i)  spawn_login_child() returns in < 1 second. If any .output()
    //        leaked into the path, the test would block on the fake-child
    //        sleep and fail.
    //   (ii) reading stdout incrementally extracts the URL within one third
    //        of the fake child lifetime, BEFORE that lifetime completes.

    /// Helper: write a fake CLI script that prints a login URL and
    /// stays alive for the configured fake-child lifetime, and return its
    /// path. Sets VERBOO_CLI_PATH
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
        // serialized via the shared FAKE_CLI_ENV_GUARD so the env var doesn't race
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

    const FAKE_CHILD_LIFETIME: std::time::Duration = std::time::Duration::from_secs(30);

    fn fake_child_url_deadline() -> std::time::Duration {
        FAKE_CHILD_LIFETIME / 3
    }

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
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        a1_node_precheck();
        // QA criterion (i): if any .output() leaked, this would block
        // on the fake child lifetime. CliSpawn invokes the fake via `node
        // <cli.mjs>` (from VERBOO_CLI_PATH env var), so the script body
        // is the JS source, not a shebang script.
        let script = format!(
            r#"
            // `write` is not a portable flush barrier: the callback is the
            // Writable contract that the chunk was flushed. Do not block
            // Node's event loop before that point, or this fake can hide its
            // URL behind its lifetime on a different pipe implementation.
            process.stdout.write('Open https://verboo.example/auth?token=abc123 in your browser.\n', () => {{
                // Keep the child alive without monopolizing a CPU. The test
                // needs a live process, not a CPU-bound process.
                setTimeout(() => process.exit(0), {});
            }});
        "#,
            FAKE_CHILD_LIFETIME.as_millis()
        );
        let _path = write_fake_cli(&script, "spawn");
        let t0 = std::time::Instant::now();
        let result = crate::services::cli_service::CliService::spawn_login_child();
        let elapsed = t0.elapsed();
        let (mut child, _stdout, _stderr) =
            result.expect("spawn must succeed without blocking on the fake child lifetime");
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
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        a1_node_precheck();
        // QA criterion (ii): the URL must be reachable via incremental
        // stdout reading BEFORE the fake child lifetime ends. If we waited for
        // process exit before reading, we'd miss the deadline.
        let script = format!(
            r#"
            process.stdout.write('Open https://verboo.example/auth?token=xyz789 in your browser.\n', () => {{
                // Keep the child alive without monopolizing a CPU. The test
                // needs a live process, not a CPU-bound process.
                setTimeout(() => process.exit(0), {});
            }});
        "#,
            FAKE_CHILD_LIFETIME.as_millis()
        );
        let _path = write_fake_cli(&script, "url");
        let t0 = std::time::Instant::now();
        let (mut child, mut stdout_pipe, _stderr_pipe) =
            crate::services::cli_service::CliService::spawn_login_child()
                .expect("spawn must succeed");
        // Read stdout incrementally and try to extract the URL.
        use std::io::Read;
        let mut buf = String::new();
        let mut chunk = [0u8; 4096];
        let mut url_found_at: Option<std::time::Duration> = None;
        let deadline = t0 + fake_child_url_deadline();
        while std::time::Instant::now() < deadline {
            match stdout_pipe.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    buf.push_str(&String::from_utf8_lossy(&chunk[..n]));
                    if extract_login_url(&buf).is_some() {
                        assert!(
                            child
                                .try_wait()
                                .expect("A1: child liveness check must succeed")
                                .is_none(),
                            "A1: URL was read after the child exited; a pipe retains bytes from a dead process, so this would not prove incremental reading from a live child",
                        );
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
            url_found_at.unwrap() < fake_child_url_deadline(),
            "A1: URL must be extractable in less than one third of the fake child lifetime ({:?}). Took {:?}.",
            fake_child_url_deadline(),
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
