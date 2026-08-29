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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_minutes: Option<u32>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SupportedProvider {
    Codex,
    Claude,
}

impl SupportedProvider {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "codex" => Ok(Self::Codex),
            "claude" => Ok(Self::Claude),
            _ => Err("provider_argument_required".to_string()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProviderAccountId(String);

impl ProviderAccountId {
    fn parse(value: String) -> Result<Self, String> {
        if value.trim().is_empty() {
            return Err("provider_argument_required".to_string());
        }
        Ok(Self(value))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
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

/// Maps CLI-provided error codes to stable, renderer-facing codes. Known
/// codes pass through; anything else becomes a generic protocol error. Raw
/// CLI output never reaches this function — the envelope is parsed before any
/// code is extracted — so provider tokens or subject IDs can never become a
/// renderer-facing message.
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

fn parse_envelope<T: serde::de::DeserializeOwned>(stdout: &str) -> Result<T, String> {
    let envelope: Envelope<T> =
        serde_json::from_str(stdout.trim()).map_err(|_| "provider_protocol_error".to_string())?;
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
    envelope
        .data
        .ok_or_else(|| "provider_protocol_error".to_string())
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
    let stdout = run_cli(&["provider-accounts", "capabilities"])?;
    parse_capabilities(&stdout)
}

fn parse_capabilities(stdout: &str) -> Result<ProviderCapabilities, String> {
    match parse_envelope::<CapabilitiesData>(stdout) {
        Ok(data) => Ok(ProviderCapabilities {
            provider_accounts_v1: data.protocols.iter().any(|p| p == "provider_accounts_v1"),
            provider_usage_v1: data.protocols.iter().any(|p| p == "provider_usage_v1"),
            login_transport: data.login_transport,
        }),
        // A valid legacy response may explicitly report an unknown command.
        // Process/bootstrap failures and malformed output remain errors so the
        // renderer cannot mistake them for a supported legacy state.
        Err(code) if code == "provider_command_unknown" => Ok(ProviderCapabilities {
            provider_accounts_v1: false,
            provider_usage_v1: false,
            login_transport: None,
        }),
        Err(code) => Err(code),
    }
}

pub fn provider_accounts_list() -> Result<Vec<ProviderAccountSummary>, String> {
    let stdout = run_cli(&["provider-accounts", "list"])?;
    let data: AccountsData = parse_envelope(&stdout)?;
    Ok(data
        .accounts
        .into_iter()
        .filter(|account| {
            account.schema_version == 1
                && (account.provider == "codex" || account.provider == "claude")
        })
        .collect())
}

pub fn provider_accounts_usage(
    provider: Option<String>,
    account_id: Option<String>,
) -> Result<Vec<ProviderUsageResult>, String> {
    let provider = SupportedProvider::parse(
        provider
            .as_deref()
            .ok_or_else(|| "provider_argument_required".to_string())?,
    )?;
    let account_id = ProviderAccountId::parse(
        account_id.ok_or_else(|| "provider_argument_required".to_string())?,
    )?;
    let stdout = run_cli(&[
        "provider-accounts",
        "usage",
        "--provider",
        provider.as_str(),
        "--account",
        account_id.as_str(),
    ])?;
    match parse_envelope::<ProviderUsageSnapshot>(&stdout) {
        Ok(snapshot)
            if validate_usage_snapshot_identity(
                &snapshot,
                provider.as_str(),
                account_id.as_str(),
            )
            .is_ok() =>
        {
            Ok(vec![ProviderUsageResult {
                provider: provider.as_str().to_string(),
                account_id: account_id.as_str().to_string(),
                snapshot: Some(snapshot),
                error_code: None,
            }])
        }
        Ok(_) => Ok(vec![ProviderUsageResult {
            provider: provider.as_str().to_string(),
            account_id: account_id.as_str().to_string(),
            snapshot: None,
            error_code: Some("provider_protocol_error".to_string()),
        }]),
        Err(error_code) => Ok(vec![ProviderUsageResult {
            provider: provider.as_str().to_string(),
            account_id: account_id.as_str().to_string(),
            snapshot: None,
            error_code: Some(stable_error(&error_code)),
        }]),
    }
}

fn validate_usage_snapshot_identity(
    snapshot: &ProviderUsageSnapshot,
    provider: &str,
    account_id: &str,
) -> Result<(), String> {
    if snapshot.provider == provider && snapshot.account_id == account_id {
        Ok(())
    } else {
        Err("provider_protocol_error".to_string())
    }
}

pub fn provider_account_set_default(provider: String, account_id: String) -> Result<(), String> {
    let provider = SupportedProvider::parse(&provider)?;
    let account_id = ProviderAccountId::parse(account_id)?;
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
    let provider = SupportedProvider::parse(&provider)?;
    let account_id = ProviderAccountId::parse(account_id)?;
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

/// Maps a `provider-accounts models` failure to a stable local code.
///
/// An older CLI that does not implement the `models` subcommand reports
/// `provider_command_unknown`. That is remapped to a distinct code so the
/// renderer can show "update the CLI" instead of a generic failure. Every
/// other failure keeps its stable code: a real error must never be
/// relabeled as an old-CLI gap.
fn models_error_code(code: &str) -> String {
    match code {
        "provider_command_unknown" => "provider_models_unsupported".to_string(),
        other => stable_error(other),
    }
}

/// Ask the CLI for the account-specific model catalog. The account-specific
/// response is authoritative: a missing command or malformed response must
/// remain an error so the renderer cannot send a model that this account does
/// not support. An old CLI without the subcommand surfaces the distinct
/// `provider_models_unsupported` code.
pub fn provider_account_models(
    provider: String,
    account_id: String,
) -> Result<Vec<VerbooModel>, String> {
    let provider = SupportedProvider::parse(&provider)?;
    let account_id = ProviderAccountId::parse(account_id)?;
    let stdout = run_cli(&[
        "provider-accounts",
        "models",
        "--provider",
        provider.as_str(),
        "--account",
        account_id.as_str(),
    ])?;
    let models =
        parse_envelope::<Vec<VerbooModel>>(&stdout).map_err(|code| models_error_code(&code))?;
    Ok(models
        .into_iter()
        .filter(|model| model.provider.as_deref() == Some(provider.as_str()))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_usage_snapshot_for_a_different_account() {
        let snapshot = ProviderUsageSnapshot {
            schema_version: 1,
            provider: "codex".to_string(),
            account_id: "local-b".to_string(),
            plan: None,
            windows: vec![],
            fetched_at: "2026-08-09T00:00:00.000Z".to_string(),
        };

        assert_eq!(
            validate_usage_snapshot_identity(&snapshot, "codex", "local-a"),
            Err("provider_protocol_error".to_string())
        );
    }

    #[test]
    fn accepts_usage_snapshot_for_the_requested_account() {
        let snapshot = ProviderUsageSnapshot {
            schema_version: 1,
            provider: "codex".to_string(),
            account_id: "local-a".to_string(),
            plan: None,
            windows: vec![],
            fetched_at: "2026-08-09T00:00:00.000Z".to_string(),
        };

        assert_eq!(
            validate_usage_snapshot_identity(&snapshot, "codex", "local-a"),
            Ok(())
        );
    }

    #[test]
    fn preserves_provider_reported_window_duration() {
        let stdout = r#"{
          "schemaVersion":1,
          "ok":true,
          "data":{
            "schemaVersion":1,
            "provider":"codex",
            "accountId":"local-a",
            "windows":[{
              "id":"codex:primary",
              "kind":"session",
              "displayLabel":"ignored",
              "windowMinutes":300,
              "usedPercent":27
            }],
            "fetchedAt":"2026-08-28T23:00:00.000Z"
          }
        }"#;

        let snapshot: ProviderUsageSnapshot =
            parse_envelope(stdout).expect("usage snapshot with a duration must parse");

        assert_eq!(snapshot.windows[0].window_minutes, Some(300));
    }

    #[test]
    fn unknown_models_subcommand_maps_to_models_unsupported() {
        let stdout = r#"{"schemaVersion":1,"ok":false,"error":{"code":"provider_command_unknown","message":"unknown command 'models'"}}"#;
        let code =
            parse_envelope::<serde_json::Value>(stdout).expect_err("unknown command must fail");
        assert_eq!(models_error_code(&code), "provider_models_unsupported");
    }

    #[test]
    fn models_error_without_unknown_command_keeps_its_stable_code() {
        assert_eq!(
            models_error_code("provider_account_not_found"),
            "provider_account_not_found"
        );
        assert_eq!(
            models_error_code("provider_protocol_error"),
            "provider_protocol_error"
        );
    }

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
    fn stable_error_keeps_known_code_and_never_leaks_raw_cli_text() {
        // stable_error is the production error path: known codes pass
        // through and unknown text becomes a generic protocol error, so raw
        // CLI output can never become a renderer-facing message.
        assert_eq!(
            stable_error("provider_usage_unavailable"),
            "provider_usage_unavailable"
        );
        let unknown = stable_error("token-secret provider-subject-secret");
        assert_eq!(unknown, "provider_protocol_error");
        assert!(!unknown.contains("secret"));
    }

    #[test]
    fn unsupported_capabilities_degrade_to_false_flags() {
        let capabilities =
            parse_capabilities(r#"{"schemaVersion":1,"ok":true,"data":{"protocols":[]}}"#).unwrap();
        assert!(!capabilities.provider_accounts_v1);
        assert!(!capabilities.provider_usage_v1);
    }

    #[test]
    fn unknown_capabilities_command_is_the_only_legacy_fallback() {
        let capabilities = parse_capabilities(
            r#"{"schemaVersion":1,"ok":false,"error":{"code":"provider_command_unknown","message":"unknown command"}}"#,
        ).unwrap();
        assert!(!capabilities.provider_accounts_v1);
        assert!(!capabilities.provider_usage_v1);
    }

    #[test]
    fn malformed_capabilities_are_not_misreported_as_legacy() {
        assert_eq!(
            parse_capabilities(""),
            Err("provider_protocol_error".to_string())
        );
    }
}
