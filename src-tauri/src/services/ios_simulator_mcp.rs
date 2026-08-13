use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde_json::Value;

use crate::services::auth_token::{augment_identity_env, inject_api_key, resolve_token};
use crate::services::cli_spawn::CliSpawn;
use crate::services::credentials_store::CredentialsStore;

const MCP_NAME: &str = "verboo-ios-simulator";
const MANAGED_MARKER: &str = "VERBOO_IOS_SIMULATOR_MANAGED";
const VERSION_MARKER: &str = "VERBOO_IOS_SIMULATOR_VERSION";

#[derive(Debug, Clone)]
struct CliOutput {
    success: bool,
    stderr: String,
}

trait CliRunner: Send + Sync {
    fn run(&self, args: &[String]) -> Result<CliOutput, String>;
}

#[derive(Debug)]
struct RealCliRunner;

impl CliRunner for RealCliRunner {
    fn run(&self, args: &[String]) -> Result<CliOutput, String> {
        let mut spawn = CliSpawn::new(args);
        augment_identity_env(&mut spawn.command);
        let credentials = CredentialsStore::new();
        let _guard = inject_api_key(resolve_token(&credentials).as_deref(), &mut spawn.command);
        let output = spawn.command.output().map_err(|error| error.to_string())?;
        Ok(CliOutput {
            success: output.status.success(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RegistrationState {
    Missing,
    Current,
    Outdated,
    Conflict,
}

pub struct IosSimulatorMcpService {
    app_version: String,
    integration_root: PathBuf,
    bundled_helper: PathBuf,
    config_path: PathBuf,
    runner: Arc<dyn CliRunner>,
}

impl IosSimulatorMcpService {
    pub fn new(app_data_dir: PathBuf, app_version: String) -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let bundled_helper = executable
            .parent()
            .map(|parent| parent.join(helper_filename()))
            .ok_or("ios_simulator_mcp_bundled_helper_missing")?;
        let config_root = std::env::var_os("VERBOO_CONFIG_DIR")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".verboo")))
            .ok_or("ios_simulator_mcp_config_directory_unavailable")?;
        Ok(Self {
            app_version,
            integration_root: app_data_dir.join("ios-simulator-integration"),
            bundled_helper,
            config_path: config_root.join(".config.json"),
            runner: Arc::new(RealCliRunner),
        })
    }

    #[cfg(test)]
    fn with_dependencies(
        app_version: impl Into<String>,
        integration_root: PathBuf,
        bundled_helper: PathBuf,
        config_path: PathBuf,
        runner: Arc<dyn CliRunner>,
    ) -> Self {
        Self {
            app_version: app_version.into(),
            integration_root,
            bundled_helper,
            config_path,
            runner,
        }
    }

    pub fn ensure_registered(&self) -> Result<(), String> {
        let helper = self.managed_helper_path();
        match self.registration_state(&helper)? {
            RegistrationState::Conflict => return Err("ios_simulator_mcp_conflict".into()),
            RegistrationState::Missing => {
                self.install_helper(&helper)?;
                self.add(&helper).or_else(|error| {
                    if is_offline_cli_failure(&error) {
                        self.write_managed_entry(&helper)
                    } else {
                        Err(error)
                    }
                })
            }
            RegistrationState::Current => self.install_helper(&helper),
            RegistrationState::Outdated => {
                self.install_helper(&helper)?;
                self.write_managed_entry(&helper)
            }
        }
    }

    pub fn reconcile_for_platform(&self, is_macos: bool) -> Result<(), String> {
        if is_macos {
            return self.ensure_registered();
        }
        self.remove_managed_entry_from_config()
    }

    fn remove_managed_entry_from_config(&self) -> Result<(), String> {
        if !self.config_path.exists() {
            return Ok(());
        }
        let mut config: Value = serde_json::from_slice(
            &fs::read(&self.config_path).map_err(|error| error.to_string())?,
        )
        .map_err(|_| "ios_simulator_mcp_config_invalid".to_string())?;
        let Some(servers) = config
            .get_mut("mcpServers")
            .and_then(Value::as_object_mut)
        else {
            return Ok(());
        };
        let should_remove = servers.get(MCP_NAME).is_some_and(|entry| {
            let managed = entry
                .get("env")
                .and_then(Value::as_object)
                .and_then(|env| env.get(MANAGED_MARKER))
                .and_then(Value::as_str)
                == Some("1");
            let command = entry
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let command_path = Path::new(command);
            managed
                && command_path.starts_with(&self.integration_root)
                && command_path.file_name()
                    == Some(std::ffi::OsStr::new(helper_filename()))
        });
        if !should_remove {
            return Ok(());
        }
        servers.remove(MCP_NAME);
        atomic_write_config(
            &self.config_path,
            &serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?,
        )
    }

    fn managed_helper_path(&self) -> PathBuf {
        self.integration_root
            .join(&self.app_version)
            .join(helper_filename())
    }

    fn registration_state(&self, expected_helper: &Path) -> Result<RegistrationState, String> {
        if !self.config_path.exists() {
            return Ok(RegistrationState::Missing);
        }
        let config: Value = serde_json::from_slice(
            &fs::read(&self.config_path).map_err(|error| error.to_string())?,
        )
        .map_err(|_| "ios_simulator_mcp_config_invalid".to_string())?;
        let Some(entry) = config
            .get("mcpServers")
            .and_then(Value::as_object)
            .and_then(|servers| servers.get(MCP_NAME))
        else {
            return Ok(RegistrationState::Missing);
        };
        let command = entry
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let env = entry.get("env").and_then(Value::as_object);
        let managed = env
            .and_then(|env| env.get(MANAGED_MARKER))
            .and_then(Value::as_str)
            == Some("1");
        let version = env
            .and_then(|env| env.get(VERSION_MARKER))
            .and_then(Value::as_str);
        let command_path = Path::new(command);
        let owned = command_path.starts_with(&self.integration_root)
            && command_path.file_name() == Some(std::ffi::OsStr::new(helper_filename()));
        if !managed || !owned {
            return Ok(RegistrationState::Conflict);
        }
        let args = entry
            .get("args")
            .and_then(Value::as_array)
            .map(|args| args.iter().filter_map(Value::as_str).collect::<Vec<_>>())
            .unwrap_or_default();
        if command_path == expected_helper
            && version == Some(self.app_version.as_str())
            && args == ["mcp"]
        {
            Ok(RegistrationState::Current)
        } else {
            Ok(RegistrationState::Outdated)
        }
    }

    fn install_helper(&self, destination: &Path) -> Result<(), String> {
        if !self.bundled_helper.is_file() {
            return Err("ios_simulator_mcp_bundled_helper_missing".into());
        }
        let parent = destination
            .parent()
            .ok_or("ios_simulator_mcp_helper_parent_missing")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let temporary = parent.join(format!(
            ".{}.{}.copy.tmp",
            helper_filename(),
            uuid::Uuid::new_v4().simple(),
        ));
        let result = fs::copy(&self.bundled_helper, &temporary)
            .map_err(|error| error.to_string())
            .and_then(|_| replace_file(&temporary, destination));
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
        #[cfg(unix)]
        fs::set_permissions(destination, fs::Permissions::from_mode(0o755))
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn add(&self, helper: &Path) -> Result<(), String> {
        self.require_success(self.runner.run(&[
            "mcp".into(),
            "add".into(),
            MCP_NAME.into(),
            "--scope".into(),
            "user".into(),
            "-e".into(),
            format!("{MANAGED_MARKER}=1"),
            "-e".into(),
            format!("{VERSION_MARKER}={}", self.app_version),
            "--".into(),
            helper.to_string_lossy().into_owned(),
            "mcp".into(),
        ])?)
    }

    fn require_success(&self, output: CliOutput) -> Result<(), String> {
        if output.success {
            Ok(())
        } else if output.stderr.trim().is_empty() {
            Err("ios_simulator_mcp_cli_failed".into())
        } else {
            Err(format!(
                "ios_simulator_mcp_cli_failed: {}",
                output.stderr.trim()
            ))
        }
    }

    fn write_managed_entry(&self, helper: &Path) -> Result<(), String> {
        let mut config = if self.config_path.exists() {
            serde_json::from_slice::<Value>(
                &fs::read(&self.config_path).map_err(|error| error.to_string())?,
            )
            .map_err(|_| "ios_simulator_mcp_config_invalid".to_string())?
        } else {
            Value::Object(Default::default())
        };
        let root = config
            .as_object_mut()
            .ok_or("ios_simulator_mcp_config_invalid")?;
        let servers = root
            .entry("mcpServers")
            .or_insert_with(|| Value::Object(Default::default()))
            .as_object_mut()
            .ok_or("ios_simulator_mcp_config_invalid")?;

        if let Some(existing) = servers.get(MCP_NAME) {
            let command = existing
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let env = existing.get("env").and_then(Value::as_object);
            let managed = env
                .and_then(|env| env.get(MANAGED_MARKER))
                .and_then(Value::as_str)
                == Some("1");
            let owned = Path::new(command).starts_with(&self.integration_root)
                && Path::new(command).file_name() == Some(std::ffi::OsStr::new(helper_filename()));
            if !managed || !owned {
                return Err("ios_simulator_mcp_conflict".into());
            }
        }

        servers.insert(
            MCP_NAME.into(),
            serde_json::json!({
                "type": "stdio",
                "command": helper,
                "args": ["mcp"],
                "env": {
                    MANAGED_MARKER: "1",
                    VERSION_MARKER: self.app_version,
                }
            }),
        );
        atomic_write_config(
            &self.config_path,
            &serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?,
        )
    }
}

fn is_offline_cli_failure(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("nenhum modelo disponível")
        || error.contains("no model available")
        || error.contains("connection refused")
        || error.contains("failed to connect")
        || error.contains("network unavailable")
}

fn atomic_write_config(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("ios_simulator_mcp_config_parent_missing")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("config"),
        uuid::Uuid::new_v4().simple(),
    ));
    let result = (|| {
        fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            let mode = fs::metadata(path)
                .map(|metadata| metadata.permissions().mode() & 0o777)
                .unwrap_or(0o600);
            fs::set_permissions(&temporary, fs::Permissions::from_mode(mode))
                .map_err(|error| error.to_string())?;
        }
        replace_file(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn helper_filename() -> &'static str {
    if cfg!(windows) {
        "verboo-ios-simulator.exe"
    } else {
        "verboo-ios-simulator"
    }
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        fs::remove_file(destination).map_err(|error| error.to_string())?;
    }
    fs::rename(source, destination).map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;
    use tempfile::TempDir;

    #[derive(Default)]
    struct FakeRunner {
        calls: Mutex<Vec<Vec<String>>>,
        failure: Option<String>,
    }

    impl CliRunner for FakeRunner {
        fn run(&self, args: &[String]) -> Result<CliOutput, String> {
            self.calls.lock().unwrap().push(args.to_vec());
            if let Some(stderr) = self.failure.as_ref() {
                return Ok(CliOutput {
                    success: false,
                    stderr: stderr.clone(),
                });
            }
            Ok(CliOutput {
                success: true,
                stderr: String::new(),
            })
        }
    }

    fn fixture(config: Option<Value>) -> (TempDir, IosSimulatorMcpService, Arc<FakeRunner>) {
        let temp = TempDir::new().unwrap();
        let bundled = temp.path().join("bundle").join(helper_filename());
        fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        fs::write(&bundled, b"simulator-helper").unwrap();
        let config_path = temp.path().join("config/.config.json");
        if let Some(config) = config {
            fs::create_dir_all(config_path.parent().unwrap()).unwrap();
            fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        }
        let runner = Arc::new(FakeRunner::default());
        let service = IosSimulatorMcpService::with_dependencies(
            "1.2.3",
            temp.path().join("data/ios-simulator-integration"),
            bundled,
            config_path,
            runner.clone(),
        );
        (temp, service, runner)
    }

    #[test]
    fn ios_simulator_mcp_missing_entry_is_installed_and_registered() {
        let (_temp, service, runner) = fixture(None);
        service.ensure_registered().unwrap();

        let helper = service.managed_helper_path();
        assert_eq!(fs::read(&helper).unwrap(), b"simulator-helper");
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&helper).unwrap().permissions().mode() & 0o777,
            0o755
        );
        let calls = runner.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0][..5], ["mcp", "add", MCP_NAME, "--scope", "user"]);
        assert!(calls[0].contains(&format!("{MANAGED_MARKER}=1")));
        assert!(calls[0].contains(&format!("{VERSION_MARKER}=1.2.3")));
        assert_eq!(calls[0].last().map(String::as_str), Some("mcp"));
    }

    #[test]
    fn ios_simulator_mcp_foreign_entry_is_left_untouched() {
        let (_temp, service, runner) = fixture(Some(json!({
            "mcpServers": {
                MCP_NAME: {
                    "command": "/foreign/verboo-ios-simulator",
                    "args": ["mcp"],
                    "env": {}
                }
            }
        })));

        assert_eq!(
            service.ensure_registered().unwrap_err(),
            "ios_simulator_mcp_conflict"
        );
        assert!(runner.calls.lock().unwrap().is_empty());
        assert!(!service.managed_helper_path().exists());
    }

    #[test]
    fn ios_simulator_mcp_managed_old_version_is_replaced_idempotently() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("data/ios-simulator-integration");
        let old_helper = root.join("0.7.1-beta").join(helper_filename());
        let config = json!({
            "mcpServers": {
                MCP_NAME: {
                    "command": old_helper,
                    "args": ["mcp"],
                    "env": {
                        MANAGED_MARKER: "1",
                        VERSION_MARKER: "0.7.1-beta"
                    }
                }
            }
        });
        let bundled = temp.path().join("bundle").join(helper_filename());
        fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        fs::write(&bundled, b"new").unwrap();
        let config_path = temp.path().join("config/.config.json");
        fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        let runner = Arc::new(FakeRunner {
            calls: Mutex::new(Vec::new()),
            failure: Some("verboo_auth_required".into()),
        });
        let service = IosSimulatorMcpService::with_dependencies(
            "0.7.2-beta",
            root,
            bundled,
            config_path.clone(),
            runner.clone(),
        );

        service.ensure_registered().unwrap();

        let updated: Value = serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
        assert_eq!(
            updated["mcpServers"][MCP_NAME]["command"],
            service.managed_helper_path().to_string_lossy().as_ref(),
        );
        assert_eq!(
            updated["mcpServers"][MCP_NAME]["env"][VERSION_MARKER],
            "0.7.2-beta"
        );
        assert_eq!(fs::read(service.managed_helper_path()).unwrap(), b"new");
        assert!(runner.calls.lock().unwrap().is_empty());

        service.ensure_registered().unwrap();
        assert!(runner.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn ios_simulator_mcp_registers_atomically_when_model_discovery_is_offline() {
        let temp = TempDir::new().unwrap();
        let bundled = temp.path().join("bundle").join(helper_filename());
        fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        fs::write(&bundled, b"helper").unwrap();
        let config_path = temp.path().join("config/.config.json");
        fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        fs::write(&config_path, br#"{"theme":"dark","mcpServers":{}}"#).unwrap();
        let runner = Arc::new(FakeRunner {
            calls: Mutex::new(Vec::new()),
            failure: Some("Nenhum modelo disponível nesta conta. Execute `verboo /login`.".into()),
        });
        let service = IosSimulatorMcpService::with_dependencies(
            "1.2.3",
            temp.path().join("data/ios-simulator-integration"),
            bundled,
            config_path.clone(),
            runner,
        );

        service.ensure_registered().unwrap();

        let config: Value = serde_json::from_slice(&fs::read(config_path).unwrap()).unwrap();
        assert_eq!(config["theme"], "dark");
        assert_eq!(
            config["mcpServers"][MCP_NAME]["command"],
            service.managed_helper_path().to_string_lossy().as_ref(),
        );
        assert_eq!(config["mcpServers"][MCP_NAME]["env"][MANAGED_MARKER], "1");
    }

    #[test]
    fn non_macos_reconciliation_removes_only_the_managed_simulator_entry() {
        let (_temp, service, runner) = fixture(None);
        fs::create_dir_all(service.config_path.parent().unwrap()).unwrap();
        fs::write(
            &service.config_path,
            serde_json::to_vec(&json!({
                "theme": "dark",
                "mcpServers": {
                    MCP_NAME: {
                        "type": "stdio",
                        "command": service.managed_helper_path(),
                        "args": ["mcp"],
                        "env": {
                            MANAGED_MARKER: "1",
                            VERSION_MARKER: "1.2.3"
                        }
                    },
                    "user-owned": {"command": "/usr/bin/example"}
                }
            }))
            .unwrap(),
        )
        .unwrap();

        service.reconcile_for_platform(false).unwrap();

        let config: Value =
            serde_json::from_slice(&fs::read(&service.config_path).unwrap()).unwrap();
        assert!(config["mcpServers"].get(MCP_NAME).is_none());
        assert_eq!(config["mcpServers"]["user-owned"]["command"], "/usr/bin/example");
        assert!(runner.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn non_macos_reconciliation_preserves_a_foreign_simulator_entry() {
        let (_temp, service, runner) = fixture(Some(json!({
            "mcpServers": {
                MCP_NAME: {
                    "command": "/foreign/verboo-ios-simulator",
                    "args": ["mcp"],
                    "env": {}
                }
            }
        })));

        service.reconcile_for_platform(false).unwrap();

        let config: Value =
            serde_json::from_slice(&fs::read(&service.config_path).unwrap()).unwrap();
        assert_eq!(
            config["mcpServers"][MCP_NAME]["command"],
            "/foreign/verboo-ios-simulator"
        );
        assert!(runner.calls.lock().unwrap().is_empty());
    }
}
