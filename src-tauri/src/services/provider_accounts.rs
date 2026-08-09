//! Sanitized bridge for the CLI's `provider-accounts` protocol.
//!
//! The CLI owns provider credentials and account selection.  This module only
//! transports the versioned, non-secret summaries and usage snapshots to the
//! renderer.  In particular, raw CLI output is never part of a renderer error.

use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::models::types::VerbooModel;
use crate::services::cli_spawn::CliSpawn;
use crate::services::provider_catalog;

const CLI_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_STDOUT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub provider_accounts_v1: bool,
    pub provider_usage_v1: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login_transport: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccountSummary {
    pub schema_version: u32,
    pub provider: String,
    pub account_id: String,
    pub display_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_display_name: Option<String>,
    pub is_default: bool,
    pub connection_state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_validated_at: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsageWindow {
    pub id: String,
    pub kind: String,
    pub display_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_scope: Option<String>,
    pub used_percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPlan {
    pub id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsageSnapshot {
    pub schema_version: u32,
    pub provider: String,
    pub account_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<ProviderPlan>,
    pub windows: Vec<ProviderUsageWindow>,
    pub fetched_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsageResult {
    pub provider: String,
    pub account_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<ProviderUsageSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope<T> {
    schema_version: u32,
    ok: bool,
    data: Option<T>,
    error: Option<EnvelopeError>,
}

#[derive(Debug, serde::Deserialize)]
struct EnvelopeError {
    code: String,
    #[allow(dead_code)]
    message: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapabilitiesData {
    #[serde(default)]
    protocols: Vec<String>,
    #[serde(default)]
    login_transport: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountsData {
    #[serde(default)]
    accounts: Vec<ProviderAccountSummary>,
}

fn stable_error(code: &str) -> String {
    match code {
        "provider_auth_required"
        | "verboo_auth_required"
        | "provider_account_not_found"
        | "provider_usage_timeout"
        | "provider_usage_unavailable"
        | "provider_command_unknown"
        | "provider_argument_required" => code.to_string(),
        _ => "provider_protocol_error".to_string(),
    }
}

/// Converts all protocol failures to a stable local code.  Raw CLI output is
/// intentionally ignored: it can contain provider tokens or subject IDs.
pub fn sanitize_protocol_error(code: &str, _raw: &str) -> String {
    stable_error(code)
}

fn parse_envelope<T: serde::de::DeserializeOwned>(stdout: &str) -> Result<T, String> {
    let envelope: Envelope<T> = serde_json::from_str(stdout.trim())
        .map_err(|_| "provider_protocol_error".to_string())?;
    if envelope.schema_version != 1 {
        return Err("provider_protocol_error".to_string());
    }
    if !envelope.ok {
        return Err(stable_error(
            envelope
                .error
                .as_ref()
                .map(|error| error.code.as_str())
                .unwrap_or("provider_protocol_error"),
        ));
    }
    envelope.data.ok_or_else(|| "provider_protocol_error".to_string())
}

fn run_cli(args: &[&str]) -> Result<String, String> {
    let spawn = CliSpawn::new(args.iter().copied());
    let mut command = spawn.command;
    crate::services::child_signal::configure_process_group(&mut command);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| "provider_cli_unavailable".to_string())?;

    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for _ in reader.lines() {}
        });
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "provider_cli_unavailable".to_string())?;
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut output = String::new();
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if output.len().saturating_add(line.len()).saturating_add(1) > MAX_STDOUT_BYTES {
                let _ = tx.send(Err("provider_protocol_error".to_string()));
                return;
            }
            output.push_str(&line);
            output.push('\n');
        }
        let _ = tx.send(Ok(output));
    });

    let started = Instant::now();
    loop {
        if let Ok(result) = rx.try_recv() {
            let _ = child.kill();
            let _ = child.wait();
            return result;
        }
        if started.elapsed() > CLI_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err("provider_usage_timeout".to_string());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

pub fn provider_capabilities() -> Result<ProviderCapabilities, String> {
    let stdout = match run_cli(&["provider-accounts", "capabilities"]) {
        Ok(value) => value,
        Err(_) => {
            return Ok(ProviderCapabilities {
                provider_accounts_v1: false,
                provider_usage_v1: false,
                login_transport: None,
            })
        }
    };
    let data: CapabilitiesData = match parse_envelope(&stdout) {
        Ok(value) => value,
        Err(_) => {
            return Ok(ProviderCapabilities {
                provider_accounts_v1: false,
                provider_usage_v1: false,
                login_transport: None,
            })
        }
    };
    Ok(ProviderCapabilities {
        provider_accounts_v1: data.protocols.iter().any(|p| p == "provider_accounts_v1"),
        provider_usage_v1: data.protocols.iter().any(|p| p == "provider_usage_v1"),
        login_transport: data.login_transport,
    })
}

pub fn provider_accounts_list() -> Result<Vec<ProviderAccountSummary>, String> {
    let stdout = run_cli(&["provider-accounts", "list"])?;
    let data: AccountsData = parse_envelope(&stdout)?;
    Ok(data
        .accounts
        .into_iter()
        .filter(|account| account.schema_version == 1 && (account.provider == "codex" || account.provider == "claude"))
        .collect())
}

pub fn provider_accounts_usage(
    provider: Option<String>,
    account_id: Option<String>,
) -> Result<Vec<ProviderUsageResult>, String> {
    let provider = provider.ok_or_else(|| "provider_argument_required".to_string())?;
    if provider != "codex" && provider != "claude" {
        return Err("provider_argument_required".to_string());
    }
    let account_id = account_id.ok_or_else(|| "provider_argument_required".to_string())?;
    let stdout = run_cli(&[
        "provider-accounts",
        "usage",
        "--provider",
        provider.as_str(),
        "--account",
        account_id.as_str(),
    ])?;
    match parse_envelope::<ProviderUsageSnapshot>(&stdout) {
        Ok(snapshot) => Ok(vec![ProviderUsageResult {
            provider,
            account_id,
            snapshot: Some(snapshot),
            error_code: None,
        }]),
        Err(error_code) => Ok(vec![ProviderUsageResult {
            provider,
            account_id,
            snapshot: None,
            error_code: Some(stable_error(&error_code)),
        }]),
    }
}

pub fn provider_account_set_default(provider: String, account_id: String) -> Result<(), String> {
    let stdout = run_cli(&[
        "provider-accounts",
        "set-default",
        "--provider",
        provider.as_str(),
        "--account",
        account_id.as_str(),
    ])?;
    parse_envelope::<serde_json::Value>(&stdout).map(|_| ())
}

pub fn provider_account_remove(provider: String, account_id: String) -> Result<(), String> {
    let stdout = run_cli(&[
        "provider-accounts",
        "remove",
        "--provider",
        provider.as_str(),
        "--account",
        account_id.as_str(),
    ])?;
    parse_envelope::<serde_json::Value>(&stdout).map(|_| ())
}

/// Ask the CLI for the account-specific model catalog. A legacy CLI without
/// this command still degrades to the existing provider-wide catalog so the
/// account switch remains usable instead of failing closed on an upgrade gap.
pub fn provider_account_models(provider: String, account_id: String) -> Result<Vec<VerbooModel>, String> {
    let stdout = match run_cli(&[
        "provider-accounts",
        "models",
        "--provider",
        provider.as_str(),
        "--account",
        account_id.as_str(),
    ]) {
        Ok(value) => value,
        Err(_) => return provider_wide_models(&provider),
    };
    match parse_envelope::<Vec<VerbooModel>>(&stdout) {
        Ok(models) => Ok(models
            .into_iter()
            .filter(|model| model.provider.as_deref() == Some(provider.as_str()))
            .collect()),
        Err(_) => provider_wide_models(&provider),
    }
}

fn provider_wide_models(provider: &str) -> Result<Vec<VerbooModel>, String> {
    Ok(provider_catalog::list_provider_models()?
        .into_iter()
        .filter(|model| model.provider.as_deref() == Some(provider))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sanitized_account_list_and_ignores_unknown_fields() {
        let json = r#"{
          "schemaVersion":1,
          "ok":true,
          "data":{
            "protocols":["provider_accounts_v1","provider_usage_v1"],
            "accounts":[{
              "schemaVersion":1,
              "provider":"codex",
              "accountId":"local-a",
              "displayLabel":"Codex 1",
              "planId":"plus",
              "planDisplayName":"Plus",
              "isDefault":true,
              "connectionState":"connected",
              "futureField":"ignored"
            }]
          }
        }"#;
        let data: AccountsData = parse_envelope(json).expect("v1 account list must parse");
        assert_eq!(data.accounts[0].account_id, "local-a");
        assert_eq!(data.accounts[0].plan_display_name.as_deref(), Some("Plus"));
    }

    #[test]
    fn protocol_error_never_returns_raw_cli_output() {
        let error = sanitize_protocol_error("provider_usage_unavailable", "token-secret provider-subject-secret");
        assert_eq!(error, "provider_usage_unavailable");
        assert!(!error.contains("secret"));
    }

    #[test]
    fn unsupported_capabilities_degrade_to_false_flags() {
        let data: CapabilitiesData = parse_envelope(r#"{"schemaVersion":1,"ok":true,"data":{"protocols":[]}}"#).unwrap();
        assert!(data.protocols.is_empty());
    }
}
