use std::process::Command;

use crate::models::types::{CliAuthStatus, LoginResult};

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
        if let Ok(path) = std::env::var("VERBOO_CLI_PATH") {
            if !path.trim().is_empty() {
                return Some(path);
            }
        }
        // Probe PATH. `which` is not portable; instead we let the OS resolve
        // `verboo` by name when spawning.
        Some("verboo".to_string())
    }

    /// Runs `verboo auth status --json` and parses the result.
    pub fn get_auth_status(&self) -> Result<CliAuthStatus, String> {
        let cli = Self::resolve_cli_path()
            .ok_or_else(|| "CLI Verboo não encontrado.".to_string())?;
        let output = Command::new(&cli)
            .args(["auth", "status", "--json"])
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

    /// Runs `verboo auth login` (interactive — opens browser, waits for callback).
    pub fn start_cli_login(&self) -> Result<LoginResult, String> {
        let cli = Self::resolve_cli_path()
            .ok_or_else(|| "CLI Verboo não encontrado.".to_string())?;
        let output = Command::new(&cli)
            .args(["auth", "login"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| format!("Falha ao executar login do CLI Verboo: {e}"))?;

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
        } else if next_status.logged_in {
            "Login concluído.".to_string()
        } else {
            "Login não concluído.".to_string()
        };

        Ok(LoginResult {
            ok: next_status.logged_in || output.status.success(),
            message,
            status: Some(next_status),
        })
    }

    /// Runs `verboo auth logout`.
    pub fn logout(&self) -> Result<LoginResult, String> {
        let cli = Self::resolve_cli_path()
            .ok_or_else(|| "CLI Verboo não encontrado.".to_string())?;
        let output = Command::new(&cli)
            .args(["auth", "logout"])
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
}
