use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::services::cli_spawn::CliSpawn;

use super::paths::ChromeIntegrationPaths;

pub(crate) const MCP_NAME: &str = "verboo-in-chrome";
pub(crate) const MANAGED_MARKER: &str = "VERBOO_IN_CHROME_MANAGED";
pub(crate) const VERSION_MARKER: &str = "VERBOO_IN_CHROME_VERSION";

#[derive(Debug, Clone)]
pub(crate) struct CliRunOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

impl CliRunOutput {
    #[cfg(test)]
    pub fn success() -> Self {
        Self {
            success: true,
            stdout: String::new(),
            stderr: String::new(),
        }
    }
}

pub(crate) trait CliMcpRunner: Send + Sync {
    fn run(&self, args: &[String]) -> Result<CliRunOutput, String>;
}

#[derive(Debug, Default)]
pub(crate) struct RealCliMcpRunner;

impl CliMcpRunner for RealCliMcpRunner {
    fn run(&self, args: &[String]) -> Result<CliRunOutput, String> {
        let output = CliSpawn::new(args)
            .command
            .output()
            .map_err(|error| error.to_string())?;
        Ok(CliRunOutput {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CliMcpEntry {
    pub command: String,
    pub args: Vec<String>,
    pub managed: bool,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CliMcpState {
    Missing,
    Managed,
    Outdated,
    Conflict,
    Invalid,
}

pub(crate) fn inspect(
    runner: &dyn CliMcpRunner,
    paths: &ChromeIntegrationPaths,
    expected_helper: &Path,
    expected_version: &str,
) -> Result<(CliMcpState, Option<CliMcpEntry>), String> {
    let doctor_args = strings(&[
        "mcp",
        "doctor",
        "--config-only",
        "--json",
        "--scope",
        "user",
    ]);
    let doctor = runner.run(&doctor_args)?;
    if !doctor.success || !contains_json_value(&doctor.stdout) {
        let _ = doctor.stderr;
        return Ok((CliMcpState::Invalid, None));
    }

    let Some(entry) = read_user_entry(&paths.cli_user_config_path())? else {
        return Ok((CliMcpState::Missing, None));
    };
    let owned_path = paths.is_managed_helper_path(Path::new(&entry.command));
    if !entry.managed || !owned_path || entry.args != ["mcp"] {
        return Ok((CliMcpState::Conflict, Some(entry)));
    }
    if Path::new(&entry.command) == expected_helper
        && entry.version.as_deref() == Some(expected_version)
    {
        Ok((CliMcpState::Managed, Some(entry)))
    } else {
        Ok((CliMcpState::Outdated, Some(entry)))
    }
}

fn contains_json_value(output: &str) -> bool {
    let Some(start) = output.find('{') else {
        return false;
    };
    serde_json::Deserializer::from_str(&output[start..])
        .into_iter::<Value>()
        .next()
        .is_some_and(|value| value.is_ok())
}

pub(crate) fn add(
    runner: &dyn CliMcpRunner,
    helper_path: &Path,
    version: &str,
) -> Result<(), String> {
    // `-e/--env` is variadic: any positional that follows it is swallowed as
    // another env var ("Invalid environment variable format: verboo-in-chrome").
    // The server name must therefore come before the flags.
    let args = vec![
        "mcp".into(),
        "add".into(),
        MCP_NAME.into(),
        "--scope".into(),
        "user".into(),
        "-e".into(),
        format!("{MANAGED_MARKER}=1"),
        "-e".into(),
        format!("{VERSION_MARKER}={version}"),
        "--".into(),
        helper_path.to_string_lossy().into_owned(),
        "mcp".into(),
    ];
    require_success(runner.run(&args)?)
}

pub(crate) fn remove(runner: &dyn CliMcpRunner) -> Result<(), String> {
    require_success(runner.run(&strings(&["mcp", "remove", "--scope", "user", MCP_NAME]))?)
}

fn require_success(output: CliRunOutput) -> Result<(), String> {
    if output.success {
        Ok(())
    } else {
        Err(if output.stderr.trim().is_empty() {
            "chrome_cli_command_failed".into()
        } else {
            format!("chrome_cli_command_failed: {}", output.stderr.trim())
        })
    }
}

fn read_user_entry(path: &Path) -> Result<Option<CliMcpEntry>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let config: Value =
        serde_json::from_slice(&fs::read(path).map_err(to_string)?).map_err(to_string)?;
    let Some(entry) = config
        .get("mcpServers")
        .and_then(Value::as_object)
        .and_then(|servers| servers.get(MCP_NAME))
    else {
        return Ok(None);
    };
    let Some(command) = entry.get("command").and_then(Value::as_str) else {
        return Ok(Some(CliMcpEntry {
            command: String::new(),
            args: Vec::new(),
            managed: false,
            version: None,
        }));
    };
    let args = entry
        .get("args")
        .and_then(Value::as_array)
        .map(|args| {
            args.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let env = entry.get("env").and_then(Value::as_object);
    let managed = env
        .and_then(|env| env.get(MANAGED_MARKER))
        .and_then(Value::as_str)
        == Some("1");
    let version = env
        .and_then(|env| env.get(VERSION_MARKER))
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(Some(CliMcpEntry {
        command: command.to_string(),
        args,
        managed,
        version,
    }))
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::contains_json_value;

    #[test]
    fn doctor_json_accepts_cli_terminal_wrappers_but_rejects_invalid_output() {
        assert!(contains_json_value(
            "\u{1b}[?2026h\n\u{1b}[?2026l{\"servers\":[]}\n"
        ));
        assert!(!contains_json_value("\u{1b}[?2026hnot-json"));
    }
}
