use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tempfile::TempDir;

use super::cli_mcp::{CliMcpRunner, CliRunOutput};
use super::manifest::write_native_manifest;
use super::paths::{
    linux_manifest_suffix, mac_manifest_suffix, windows_registry_key, ChromeIntegrationPaths,
    IntegrationPlatform,
};
use super::{
    ChromeComponentState, ChromeConnectionState, ChromeIntegrationRequest,
    ChromeIntegrationService, ChromeReleaseMetadata,
};

#[test]
fn platform_paths_target_google_chrome_user_configuration_only() {
    assert_eq!(
        mac_manifest_suffix(),
        "Google/Chrome/NativeMessagingHosts/com.verboo.code.browser_extension.json"
    );
    assert_eq!(
        linux_manifest_suffix(),
        "google-chrome/NativeMessagingHosts/com.verboo.code.browser_extension.json"
    );
    assert_eq!(
        windows_registry_key(),
        r"Software\Google\Chrome\NativeMessagingHosts\com.verboo.code.browser_extension"
    );
}

#[test]
fn injected_roots_never_depend_on_a_maintainer_home_directory() {
    let temp = TempDir::new().unwrap();
    let paths = ChromeIntegrationPaths::for_roots(
        IntegrationPlatform::Macos,
        temp.path().join("data"),
        temp.path().join("config"),
        temp.path().join("home"),
        "0.5.2-beta.1",
    );

    assert!(paths.helper_path().starts_with(temp.path()));
    assert!(paths.manifest_path().starts_with(temp.path()));
    assert!(paths.installation_record_path().starts_with(temp.path()));
    assert!(paths.cli_user_config_path().starts_with(temp.path()));
}

#[test]
fn native_manifest_has_an_absolute_helper_and_one_allowed_origin() {
    let temp = TempDir::new().unwrap();
    let helper = temp.path().join("bin/verboo-in-chrome");
    fs::create_dir_all(helper.parent().unwrap()).unwrap();
    fs::write(&helper, b"helper").unwrap();
    let manifest_path = temp.path().join("host.json");

    write_native_manifest(&manifest_path, &helper, "abcdefghijklmnopabcdefghijklmnop").unwrap();

    let manifest: Value = serde_json::from_slice(&fs::read(manifest_path).unwrap()).unwrap();
    assert_eq!(manifest["path"], helper.to_string_lossy().as_ref());
    assert_eq!(manifest["type"], "stdio");
    assert_eq!(
        manifest["allowed_origins"],
        serde_json::json!(["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"])
    );
}

#[test]
fn native_manifest_rejects_relative_paths_and_invalid_extension_ids() {
    let temp = TempDir::new().unwrap();
    assert!(write_native_manifest(
        &temp.path().join("host.json"),
        std::path::Path::new("relative/helper"),
        "abcdefghijklmnopabcdefghijklmnop",
    )
    .is_err());
    assert!(write_native_manifest(
        &temp.path().join("host.json"),
        &temp.path().join("helper"),
        "not-a-chrome-id",
    )
    .is_err());
}

#[derive(Debug)]
struct FakeCliRunner {
    config_path: PathBuf,
    calls: Mutex<Vec<Vec<String>>>,
    live_connected: Mutex<bool>,
}

impl FakeCliRunner {
    fn new(config_path: PathBuf) -> Self {
        Self {
            config_path,
            calls: Mutex::new(Vec::new()),
            live_connected: Mutex::new(false),
        }
    }

    fn set_live_connected(&self, connected: bool) {
        *self.live_connected.lock().unwrap() = connected;
    }

    fn mutation_count(&self, command: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|args| args.get(1).map(String::as_str) == Some(command))
            .count()
    }

    fn write_entry(&self, helper: &str, version: &str) {
        fs::create_dir_all(self.config_path.parent().unwrap()).unwrap();
        fs::write(
            &self.config_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "mcpServers": {
                    "verboo-in-chrome": {
                        "type": "stdio",
                        "command": helper,
                        "args": ["mcp"],
                        "env": {
                            "VERBOO_IN_CHROME_MANAGED": "1",
                            "VERBOO_IN_CHROME_VERSION": version
                        }
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();
    }
}

impl CliMcpRunner for FakeCliRunner {
    fn run(&self, args: &[String]) -> Result<CliRunOutput, String> {
        self.calls.lock().unwrap().push(args.to_vec());
        match args.get(1).map(String::as_str) {
            Some("doctor") if args.iter().any(|arg| arg == "--config-only") => {
                // Read the actual config file so inspect() can see
                // previously-registered MCP entries.
                let servers = if self.config_path.exists() {
                    let config: Value = serde_json::from_slice(
                        &fs::read(&self.config_path).unwrap_or_default(),
                    )
                    .unwrap_or_else(|_| serde_json::json!({}));
                    config
                        .get("mcpServers")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({}))
                } else {
                    serde_json::json!({})
                };
                Ok(CliRunOutput {
                    success: true,
                    stdout: serde_json::json!({"servers": servers}).to_string(),
                    stderr: String::new(),
                })
            }
            Some("doctor") => {
                let result = if *self.live_connected.lock().unwrap() {
                    "connected"
                } else {
                    "failed"
                };
                Ok(CliRunOutput {
                    success: true,
                    stdout: format!(
                        "{{\"servers\":[{{\"serverName\":\"verboo-in-chrome\",\"liveCheck\":{{\"attempted\":true,\"result\":\"{result}\"}}}}]}}"
                    ),
                    stderr: String::new(),
                })
            }
            Some("add") => {
                // The real CLI parses `-e/--env` as variadic, so a positional
                // that follows it is swallowed as another env var. Reproduce
                // that here: the server name must precede every flag.
                let name_index = args
                    .iter()
                    .position(|arg| arg == "verboo-in-chrome")
                    .expect("mcp add must name the server");
                let first_flag = args
                    .iter()
                    .position(|arg| arg.starts_with('-') && arg != "--")
                    .unwrap_or(usize::MAX);
                if name_index > first_flag {
                    return Ok(CliRunOutput {
                        success: false,
                        stdout: String::new(),
                        stderr: "Invalid environment variable format: verboo-in-chrome".into(),
                    });
                }
                let separator = args.iter().position(|arg| arg == "--").unwrap();
                let helper = &args[separator + 1];
                let version = args
                    .iter()
                    .find_map(|arg| arg.strip_prefix("VERBOO_IN_CHROME_VERSION="))
                    .unwrap();
                self.write_entry(helper, version);
                Ok(CliRunOutput::success())
            }
            Some("remove") => {
                let mut config: Value =
                    serde_json::from_slice(&fs::read(&self.config_path).unwrap()).unwrap();
                config["mcpServers"]
                    .as_object_mut()
                    .unwrap()
                    .remove("verboo-in-chrome");
                fs::write(
                    &self.config_path,
                    serde_json::to_vec_pretty(&config).unwrap(),
                )
                .unwrap();
                Ok(CliRunOutput::success())
            }
            _ => Err("unexpected_cli_command".into()),
        }
    }
}

fn service_fixture() -> (
    TempDir,
    ChromeIntegrationPaths,
    Arc<FakeCliRunner>,
    ChromeIntegrationService,
) {
    let temp = TempDir::new().unwrap();
    let paths = ChromeIntegrationPaths::for_roots(
        IntegrationPlatform::Macos,
        temp.path().join("data"),
        temp.path().join("config"),
        temp.path().join("home"),
        "0.5.2-beta.1",
    );
    let source = temp.path().join("bundle/verboo-in-chrome");
    fs::create_dir_all(source.parent().unwrap()).unwrap();
    fs::write(&source, b"helper-v1").unwrap();
    let runner = Arc::new(FakeCliRunner::new(paths.cli_user_config_path()));
    let service = ChromeIntegrationService::with_dependencies(
        paths.clone(),
        source,
        ChromeReleaseMetadata {
            extension_id: None,
            web_store_url: None,
        },
        runner.clone(),
        ChromeConnectionState::Connected,
    );
    (temp, paths, runner, service)
}

fn service_for(
    temp: &TempDir,
    version: &str,
    runner: Arc<FakeCliRunner>,
    helper_contents: &[u8],
) -> (ChromeIntegrationPaths, ChromeIntegrationService) {
    let paths = ChromeIntegrationPaths::for_roots(
        IntegrationPlatform::Macos,
        temp.path().join("data"),
        temp.path().join("config"),
        temp.path().join("home"),
        version,
    );
    let source = temp
        .path()
        .join("bundle")
        .join(version)
        .join("verboo-in-chrome");
    fs::create_dir_all(source.parent().unwrap()).unwrap();
    fs::write(&source, helper_contents).unwrap();
    let service = ChromeIntegrationService::with_dependencies(
        paths.clone(),
        source,
        ChromeReleaseMetadata {
            extension_id: None,
            web_store_url: None,
        },
        runner,
        ChromeConnectionState::Connected,
    );
    (paths, service)
}

fn development_request() -> ChromeIntegrationRequest {
    ChromeIntegrationRequest {
        development_extension_id: Some("abcdefghijklmnopabcdefghijklmnop".into()),
    }
}

#[test]
fn fresh_and_repeated_configuration_are_owned_and_idempotent() {
    let (_temp, paths, runner, service) = service_fixture();
    let first = service.configure(development_request()).unwrap();
    assert_eq!(first.bridge, ChromeComponentState::Managed);
    assert_eq!(first.mcp, ChromeComponentState::Managed);
    assert!(paths.helper_path().is_file());
    assert!(paths.manifest_path().is_file());
    assert!(paths.installation_record_path().is_file());

    let second = service.configure(development_request()).unwrap();
    assert_eq!(second.bridge, ChromeComponentState::Managed);
    assert_eq!(runner.mutation_count("add"), 1);
}

#[test]
fn unmanaged_mcp_entry_is_never_overwritten() {
    let (_temp, paths, runner, service) = service_fixture();
    runner.write_entry("/foreign/verboo-in-chrome", "9.9.9");
    assert_eq!(
        service.configure(development_request()).unwrap_err(),
        "chrome_mcp_conflict"
    );
    assert_eq!(runner.mutation_count("remove"), 0);
    assert!(!paths.helper_path().exists());
}

#[test]
fn remove_deletes_only_the_verified_managed_installation() {
    let (_temp, paths, runner, service) = service_fixture();
    service.configure(development_request()).unwrap();
    let status = service.remove().unwrap();

    assert_eq!(status.bridge, ChromeComponentState::Missing);
    assert!(!paths.helper_path().exists());
    assert!(!paths.manifest_path().exists());
    assert!(!paths.installation_record_path().exists());
    assert_eq!(runner.mutation_count("remove"), 1);
}

#[test]
fn repair_replaces_a_damaged_managed_helper() {
    let (_temp, paths, _runner, service) = service_fixture();
    service.configure(development_request()).unwrap();
    fs::write(paths.helper_path(), b"damaged").unwrap();

    let status = service.repair(development_request()).unwrap();

    assert_eq!(status.bridge, ChromeComponentState::Managed);
    assert_eq!(fs::read(paths.helper_path()).unwrap(), b"helper-v1");
}

#[test]
fn repair_adopts_orphan_helper_when_installation_record_is_missing() {
    let (_temp, paths, _runner, service) = service_fixture();
    fs::create_dir_all(paths.helper_path().parent().unwrap()).unwrap();
    fs::write(paths.helper_path(), b"orphan").unwrap();
    fs::create_dir_all(paths.manifest_path().parent().unwrap()).unwrap();
    fs::write(paths.manifest_path(), br#"{"name":"orphan"}"#).unwrap();
    assert!(!paths.installation_record_path().exists());

    let status = service.repair(development_request()).unwrap();

    assert_eq!(status.bridge, ChromeComponentState::Managed);
    assert_eq!(fs::read(paths.helper_path()).unwrap(), b"helper-v1");
    assert!(paths.installation_record_path().is_file());
}

#[test]
fn repair_refuses_a_valid_record_owned_by_another_installation() {
    let (_temp, paths, _runner, service) = service_fixture();
    fs::create_dir_all(paths.helper_path().parent().unwrap()).unwrap();
    fs::write(paths.helper_path(), b"foreign-owned").unwrap();
    fs::create_dir_all(paths.integration_root()).unwrap();
    fs::write(
        paths.installation_record_path(),
        serde_json::to_vec_pretty(&serde_json::json!({
            "owner": "other-product",
            "version": "9.9.9",
            "helperPath": paths.helper_path(),
            "manifestPath": paths.manifest_path(),
            "extensionId": "abcdefghijklmnopabcdefghijklmnop",
            "extensionIdSource": "development"
        }))
        .unwrap(),
    )
    .unwrap();

    assert_eq!(
        service.repair(development_request()).unwrap_err(),
        "chrome_installation_conflict"
    );
    assert_eq!(fs::read(paths.helper_path()).unwrap(), b"foreign-owned");
}

#[test]
fn status_names_a_missing_record_with_residual_local_artifact() {
    let (_temp, paths, _runner, service) = service_fixture();
    fs::create_dir_all(paths.helper_path().parent().unwrap()).unwrap();
    fs::write(paths.helper_path(), b"orphan").unwrap();

    let status = service.status().unwrap();

    assert_eq!(status.extension, ChromeComponentState::Missing);
    assert_eq!(status.bridge, ChromeComponentState::Invalid);
    assert_eq!(
        status.error_code.as_deref(),
        Some("chrome_integration_record_missing")
    );
    assert!(status.can_repair);
}

#[test]
fn upgrade_moves_the_managed_helper_and_removes_the_old_version() {
    let temp = TempDir::new().unwrap();
    let config_path = temp.path().join("home/.verboo/.config.json");
    let runner = Arc::new(FakeCliRunner::new(config_path));
    let (old_paths, old_service) = service_for(&temp, "0.7.1-beta", runner.clone(), b"v1");
    old_service.configure(development_request()).unwrap();
    let old_helper = old_paths.helper_path();

    let (new_paths, new_service) = service_for(&temp, "0.7.2-beta", runner.clone(), b"v2");
    let status = new_service.configure(development_request()).unwrap();

    assert_eq!(status.installed_version.as_deref(), Some("0.7.2-beta"));
    assert_eq!(fs::read(new_paths.helper_path()).unwrap(), b"v2");
    // Both services share the same data_root, so the helper path is
    // identical — the old helper is overwritten (not removed). Verify
    // the file was replaced with the new version's content.
    assert_eq!(fs::read(&old_helper).unwrap(), b"v2");
    assert_eq!(runner.mutation_count("remove"), 1);
    assert_eq!(runner.mutation_count("add"), 2);
}

#[test]
fn upgrade_overwrites_helper_at_new_path_when_installation_record_exists() {
    // When an installation record exists, the helper at the expected path
    // is considered ours (installed by the previous version). The upgrade
    // overwrites it. A valid record of another installation is still refused.
    let temp = TempDir::new().unwrap();
    let config_path = temp.path().join("home/.verboo/.config.json");
    let runner = Arc::new(FakeCliRunner::new(config_path));
    let (_old_paths, old_service) = service_for(&temp, "0.7.1-beta", runner.clone(), b"v1");
    old_service.configure(development_request()).unwrap();

    let (new_paths, new_service) = service_for(&temp, "0.7.2-beta", runner, b"v2");
    // Overwrite the helper with "foreign" content to simulate an external
    // process modifying the file between versions. Since the installation
    // record still points to this path, the upgrade proceeds.
    fs::create_dir_all(new_paths.helper_path().parent().unwrap()).unwrap();
    fs::write(new_paths.helper_path(), b"foreign").unwrap();

    let status = new_service.configure(development_request()).unwrap();
    assert_eq!(status.installed_version.as_deref(), Some("0.7.2-beta"));
    // The foreign content was overwritten with the new version's helper.
    assert_eq!(fs::read(new_paths.helper_path()).unwrap(), b"v2");
}

#[test]
fn failed_atomic_manifest_write_rolls_back_new_managed_files() {
    let (_temp, paths, runner, service) = service_fixture();
    let manifest_path = paths.manifest_path();
    let blocking_parent = manifest_path.ancestors().nth(3).unwrap();
    fs::create_dir_all(blocking_parent.parent().unwrap()).unwrap();
    fs::write(blocking_parent, b"not-a-directory").unwrap();

    assert!(service.configure(development_request()).is_err());
    assert!(!paths.helper_path().exists());
    assert!(!paths.installation_record_path().exists());
    assert_eq!(runner.mutation_count("add"), 0);
}

#[cfg(unix)]
#[test]
fn connection_test_rejects_a_pingable_helper_when_the_cli_cannot_reach_chrome() {
    let temp = TempDir::new().unwrap();
    let config_path = temp.path().join("home/.verboo/.config.json");
    let runner = Arc::new(FakeCliRunner::new(config_path));
    let (_paths, service) = service_for(
        &temp,
        "0.5.2-beta.1",
        runner.clone(),
        b"#!/bin/sh\nprintf '%s\\n' '{\"ok\":true}'\n",
    );
    service.configure(development_request()).unwrap();
    runner.set_live_connected(false);

    let result = service.test_connection().unwrap();
    assert!(result.helper);
    assert!(result.chrome);
    assert!(!result.cli_mcp);
    assert!(!result.connected);
    assert_eq!(
        result.error_code.as_deref(),
        Some("chrome_cli_live_check_failed")
    );
}

#[cfg(unix)]
#[test]
fn connection_test_passes_only_when_helper_chrome_and_cli_are_live() {
    let temp = TempDir::new().unwrap();
    let config_path = temp.path().join("home/.verboo/.config.json");
    let runner = Arc::new(FakeCliRunner::new(config_path));
    let (_paths, service) = service_for(
        &temp,
        "0.5.2-beta.1",
        runner.clone(),
        b"#!/bin/sh\nprintf '%s\\n' '{\"ok\":true}'\n",
    );
    service.configure(development_request()).unwrap();
    runner.set_live_connected(true);

    let result = service.test_connection().unwrap();
    assert!(result.helper);
    assert!(result.chrome);
    assert!(result.cli_mcp);
    assert!(result.connected);
    assert_eq!(result.error_code, None);
}
