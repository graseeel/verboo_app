use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use crate::services::cli_spawn::apply_creation_flags;

use super::cli_mcp::{self, CliMcpRunner, CliMcpState, RealCliMcpRunner};
use super::diagnostics;
use super::manifest::{
    atomic_write, manifest_is_managed, manifest_registration_is_managed, register_manifest,
    unregister_manifest, valid_extension_id, write_native_manifest,
};
use super::models::{
    ChromeComponentState, ChromeConnectionState, ChromeConnectionTestResult,
    ChromeExtensionIdSource, ChromeIntegrationAggregate, ChromeIntegrationRequest,
    ChromeIntegrationStatus, ChromePanelState, ChromeReleaseMetadata, InstallationRecord,
};
use super::paths::ChromeIntegrationPaths;

const INSTALL_OWNER: &str = "verboo-code";

pub struct ChromeIntegrationService {
    paths: ChromeIntegrationPaths,
    bundled_helper: PathBuf,
    release: ChromeReleaseMetadata,
    cli: Arc<dyn CliMcpRunner>,
    connection_state: Arc<dyn Fn() -> ChromeConnectionState + Send + Sync>,
}

impl std::fmt::Debug for ChromeIntegrationService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ChromeIntegrationService")
            .field("paths", &self.paths)
            .field("bundled_helper", &self.bundled_helper)
            .field("release", &self.release)
            .finish_non_exhaustive()
    }
}

impl ChromeIntegrationService {
    pub fn new(app_version: impl Into<String>) -> Result<Self, String> {
        let app_version = app_version.into();
        let paths = ChromeIntegrationPaths::for_current_user(app_version)?;
        Ok(Self {
            paths,
            bundled_helper: bundled_helper_path()?,
            release: ChromeReleaseMetadata::from_build(),
            cli: Arc::new(RealCliMcpRunner),
            connection_state: Arc::new(diagnostics::connection_state),
        })
    }

    pub(crate) fn with_dependencies(
        paths: ChromeIntegrationPaths,
        bundled_helper: PathBuf,
        release: ChromeReleaseMetadata,
        cli: Arc<dyn CliMcpRunner>,
        connection_state: ChromeConnectionState,
    ) -> Self {
        Self {
            paths,
            bundled_helper,
            release,
            cli,
            connection_state: Arc::new(move || connection_state),
        }
    }

    pub fn status(&self) -> Result<ChromeIntegrationStatus, String> {
        self.status_internal(None)
    }

    pub fn configure(
        &self,
        request: ChromeIntegrationRequest,
    ) -> Result<ChromeIntegrationStatus, String> {
        let (extension_id, source) = self.resolve_extension_id(&request).inspect_err(|error| {
            eprintln!("[verboo:chrome] resolve_extension_id failed: {error}")
        })?;
        let record = self
            .read_record()
            .inspect_err(|error| eprintln!("[verboo:chrome] read_record failed: {error}"))?;
        self.reject_foreign_components(record.as_ref(), &extension_id)
            .inspect_err(|error| eprintln!("[verboo:chrome] foreign components: {error}"))?;

        let old_record = record.clone();
        let result = (|| {
            self.install_helper()?;
            write_native_manifest(
                &self.paths.manifest_path(),
                &self.paths.helper_path(),
                &extension_id,
            )?;
            register_manifest(self.paths.platform(), &self.paths.manifest_path())?;
            let next_record = InstallationRecord {
                owner: INSTALL_OWNER.into(),
                version: self.paths.app_version().into(),
                helper_path: self.paths.helper_path(),
                manifest_path: self.paths.manifest_path(),
                extension_id: extension_id.clone(),
                extension_id_source: source,
            };
            self.write_record(&next_record)?;
            self.ensure_mcp_registered()?;
            Ok(())
        })();
        if let Err(error) = result {
            // The UI collapses unknown codes into a generic message, so the
            // real cause (an I/O path, a permission, a CLI stderr) was lost.
            eprintln!("[verboo:chrome] configure failed: {error}");
            if old_record.is_none() {
                self.rollback_fresh_install();
            }
            return Err(error);
        }
        if let Some(old_record) = old_record {
            if old_record.helper_path != self.paths.helper_path() {
                remove_file_if_present(&old_record.helper_path)?;
            }
        }
        self.status_internal(Some((&extension_id, source)))
    }

    pub fn repair(
        &self,
        request: ChromeIntegrationRequest,
    ) -> Result<ChromeIntegrationStatus, String> {
        self.configure(request)
    }

    pub fn test_connection(&self) -> Result<ChromeConnectionTestResult, String> {
        let record = self
            .read_record()?
            .ok_or("chrome_integration_not_configured")?;
        if record.owner != INSTALL_OWNER || !self.paths.is_managed_helper_path(&record.helper_path)
        {
            return Err("chrome_helper_conflict".into());
        }
        let mut command = Command::new(&record.helper_path);
        apply_creation_flags(&mut command);
        let helper = command.arg("ping").output().is_ok_and(|output| {
            output.status.success()
                && serde_json::from_slice::<serde_json::Value>(&output.stdout)
                    .ok()
                    .and_then(|value| value.get("ok").and_then(|ok| ok.as_bool()))
                    == Some(true)
        });
        if !helper {
            return Ok(ChromeConnectionTestResult {
                helper: false,
                chrome: false,
                cli_mcp: false,
                connected: false,
                error_code: Some("chrome_helper_ping_failed".into()),
            });
        }

        let connection = (self.connection_state)();
        let chrome = connection == ChromeConnectionState::Connected;
        if !chrome {
            let error_code = match connection {
                ChromeConnectionState::WaitingForChrome => "chrome_extension_not_connected",
                ChromeConnectionState::Ambiguous => "multiple_browser_sessions",
                ChromeConnectionState::Incompatible => "chrome_protocol_incompatible",
                ChromeConnectionState::Connected => unreachable!(),
            };
            return Ok(ChromeConnectionTestResult {
                helper: true,
                chrome: false,
                cli_mcp: false,
                connected: false,
                error_code: Some(error_code.into()),
            });
        }

        let cli_mcp = cli_mcp::test_live_connection(self.cli.as_ref()).unwrap_or(false);
        Ok(ChromeConnectionTestResult {
            helper: true,
            chrome: true,
            cli_mcp,
            connected: cli_mcp,
            error_code: (!cli_mcp).then(|| "chrome_cli_live_check_failed".into()),
        })
    }

    pub fn remove(&self) -> Result<ChromeIntegrationStatus, String> {
        let record = self.read_record()?;
        if let Some(record) = record.as_ref() {
            if record.owner != INSTALL_OWNER
                || !self.paths.is_managed_helper_path(&record.helper_path)
            {
                return Err("chrome_installation_conflict".into());
            }
            let (mcp_state, _) = cli_mcp::inspect(
                self.cli.as_ref(),
                &self.paths,
                &record.helper_path,
                &record.version,
            )?;
            if matches!(mcp_state, CliMcpState::Managed | CliMcpState::Outdated) {
                cli_mcp::remove(self.cli.as_ref())?;
            }
            if manifest_is_managed(
                &record.manifest_path,
                &record.helper_path,
                &record.extension_id,
            ) {
                unregister_manifest(self.paths.platform(), &record.manifest_path)?;
                remove_file_if_present(&record.manifest_path)?;
            }
            remove_file_if_present(&record.helper_path)?;
            remove_file_if_present(&self.paths.installation_record_path())?;
        }
        self.status()
    }

    pub fn store_url(&self) -> Option<&str> {
        self.release.web_store_url.as_deref()
    }

    fn resolve_extension_id(
        &self,
        request: &ChromeIntegrationRequest,
    ) -> Result<(String, ChromeExtensionIdSource), String> {
        if let Some(development_id) = request.development_extension_id.as_deref() {
            if !cfg!(debug_assertions) {
                return Err("chrome_development_id_not_allowed".into());
            }
            if !valid_extension_id(development_id) {
                return Err("chrome_extension_id_invalid".into());
            }
            return Ok((
                development_id.to_string(),
                ChromeExtensionIdSource::Development,
            ));
        }
        let extension_id = self
            .release
            .extension_id
            .as_deref()
            .filter(|value| valid_extension_id(value))
            .ok_or("chrome_release_metadata_missing")?;
        Ok((extension_id.to_string(), ChromeExtensionIdSource::Release))
    }

    fn reject_foreign_components(
        &self,
        record: Option<&InstallationRecord>,
        extension_id: &str,
    ) -> Result<(), String> {
        if let Some(record) = record {
            if record.owner != INSTALL_OWNER
                || !self.paths.is_managed_helper_path(&record.helper_path)
            {
                return Err("chrome_installation_conflict".into());
            }
            if self.paths.helper_path() != record.helper_path && self.paths.helper_path().exists() {
                return Err("chrome_helper_conflict".into());
            }
        } else {
            if self.paths.helper_path().exists() {
                return Err("chrome_helper_conflict".into());
            }
            if self.paths.manifest_path().exists() {
                return Err("chrome_manifest_conflict".into());
            }
        }
        let (mcp_state, _) = cli_mcp::inspect(
            self.cli.as_ref(),
            &self.paths,
            &self.paths.helper_path(),
            self.paths.app_version(),
        )?;
        if mcp_state == CliMcpState::Conflict {
            return Err("chrome_mcp_conflict".into());
        }
        if let Some(record) = record {
            if record.extension_id != extension_id
                && manifest_is_managed(
                    &record.manifest_path,
                    &record.helper_path,
                    &record.extension_id,
                )
            {
                return Ok(());
            }
        }
        Ok(())
    }

    fn ensure_mcp_registered(&self) -> Result<(), String> {
        let (state, _) = cli_mcp::inspect(
            self.cli.as_ref(),
            &self.paths,
            &self.paths.helper_path(),
            self.paths.app_version(),
        )?;
        match state {
            CliMcpState::Managed => Ok(()),
            CliMcpState::Missing => cli_mcp::add(
                self.cli.as_ref(),
                &self.paths.helper_path(),
                self.paths.app_version(),
            ),
            CliMcpState::Outdated => {
                cli_mcp::remove(self.cli.as_ref())?;
                cli_mcp::add(
                    self.cli.as_ref(),
                    &self.paths.helper_path(),
                    self.paths.app_version(),
                )
            }
            CliMcpState::Conflict => Err("chrome_mcp_conflict".into()),
            CliMcpState::Invalid => Err("chrome_mcp_invalid".into()),
        }
    }

    fn install_helper(&self) -> Result<(), String> {
        if !self.bundled_helper.is_file() {
            return Err("chrome_bundled_helper_missing".into());
        }
        atomic_copy(&self.bundled_helper, &self.paths.helper_path())?;
        #[cfg(unix)]
        fs::set_permissions(&self.paths.helper_path(), fs::Permissions::from_mode(0o755))
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn status_internal(
        &self,
        configured: Option<(&str, ChromeExtensionIdSource)>,
    ) -> Result<ChromeIntegrationStatus, String> {
        let record = self.read_record()?;
        let (extension_id, extension_source) = configured
            .map(|(id, source)| (Some(id.to_string()), source))
            .or_else(|| {
                record.as_ref().map(|record| {
                    (
                        Some(record.extension_id.clone()),
                        record.extension_id_source,
                    )
                })
            })
            .unwrap_or((None, ChromeExtensionIdSource::None));

        let bridge = self.bridge_state(record.as_ref());
        let (mcp_state, _) = cli_mcp::inspect(
            self.cli.as_ref(),
            &self.paths,
            &self.paths.helper_path(),
            self.paths.app_version(),
        )?;
        let mcp = component_from_mcp(mcp_state);
        let extension = if extension_id.is_some() {
            ChromeComponentState::Managed
        } else {
            ChromeComponentState::Missing
        };
        let connection = (self.connection_state)();
        let conflict = [extension, bridge, mcp].contains(&ChromeComponentState::Conflict);
        let ready = extension == ChromeComponentState::Managed
            && bridge == ChromeComponentState::Managed
            && mcp == ChromeComponentState::Managed;
        let aggregate = if ready && connection == ChromeConnectionState::Connected {
            ChromeIntegrationAggregate::Connected
        } else if ready {
            ChromeIntegrationAggregate::Ready
        } else if extension == ChromeComponentState::Missing
            && bridge == ChromeComponentState::Missing
            && mcp == ChromeComponentState::Missing
        {
            ChromeIntegrationAggregate::NotConfigured
        } else {
            ChromeIntegrationAggregate::Incomplete
        };
        // The app has no direct channel to observe whether the extension side
        // panel is open. When the native host is alive (`Connected`), the panel
        // state is genuinely `Unknown` — the extension only reveals it via
        // `approval_ui_unavailable` on a failed tool call. Otherwise the
        // question does not apply.
        let panel_state = if aggregate == ChromeIntegrationAggregate::Connected {
            ChromePanelState::Unknown
        } else {
            ChromePanelState::NotApplicable
        };
        let repairable = [bridge, mcp].iter().any(|state| {
            matches!(
                state,
                ChromeComponentState::Invalid | ChromeComponentState::Outdated
            )
        });
        let error_code = if conflict {
            Some("chrome_integration_conflict".into())
        } else if mcp == ChromeComponentState::Invalid {
            Some("chrome_mcp_invalid".into())
        } else {
            None
        };

        Ok(ChromeIntegrationStatus {
            extension,
            bridge,
            mcp,
            connection,
            panel_state,
            aggregate,
            installed_version: record.as_ref().map(|record| record.version.clone()),
            available_version: self.paths.app_version().into(),
            can_configure: !conflict && !ready,
            can_repair: !conflict && repairable,
            can_remove: record.is_some()
                || matches!(mcp_state, CliMcpState::Managed | CliMcpState::Outdated),
            store_url_available: self.release.web_store_url.is_some(),
            development_build: cfg!(debug_assertions),
            extension_id_source: extension_source,
            error_code,
        })
    }

    fn bridge_state(&self, record: Option<&InstallationRecord>) -> ChromeComponentState {
        let Some(record) = record else {
            return if self.paths.helper_path().exists() || self.paths.manifest_path().exists() {
                ChromeComponentState::Conflict
            } else {
                ChromeComponentState::Missing
            };
        };
        if record.owner != INSTALL_OWNER || !self.paths.is_managed_helper_path(&record.helper_path)
        {
            return ChromeComponentState::Conflict;
        }
        if !record.helper_path.is_file()
            || !manifest_is_managed(
                &record.manifest_path,
                &record.helper_path,
                &record.extension_id,
            )
            || manifest_registration_is_managed(self.paths.platform(), &record.manifest_path)
                != Ok(true)
        {
            return ChromeComponentState::Invalid;
        }
        if record.version != self.paths.app_version()
            || record.helper_path != self.paths.helper_path()
        {
            ChromeComponentState::Outdated
        } else {
            ChromeComponentState::Managed
        }
    }

    fn read_record(&self) -> Result<Option<InstallationRecord>, String> {
        let path = self.paths.installation_record_path();
        if !path.exists() {
            return Ok(None);
        }
        serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
            .map(Some)
            .map_err(|_| "chrome_installation_record_invalid".into())
    }

    fn write_record(&self, record: &InstallationRecord) -> Result<(), String> {
        atomic_write(
            &self.paths.installation_record_path(),
            &serde_json::to_vec_pretty(record).map_err(|error| error.to_string())?,
        )
    }

    fn rollback_fresh_install(&self) {
        let _ = unregister_manifest(self.paths.platform(), &self.paths.manifest_path());
        let _ = remove_file_if_present(&self.paths.manifest_path());
        let _ = remove_file_if_present(&self.paths.helper_path());
        let _ = remove_file_if_present(&self.paths.installation_record_path());
    }
}

fn component_from_mcp(state: CliMcpState) -> ChromeComponentState {
    match state {
        CliMcpState::Missing => ChromeComponentState::Missing,
        CliMcpState::Managed => ChromeComponentState::Managed,
        CliMcpState::Outdated => ChromeComponentState::Outdated,
        CliMcpState::Conflict => ChromeComponentState::Conflict,
        CliMcpState::Invalid => ChromeComponentState::Invalid,
    }
}

fn atomic_copy(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination.parent().ok_or("chrome_helper_parent_missing")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(
        ".{}.{}.copy.tmp",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("verboo-in-chrome"),
        uuid::Uuid::new_v4().simple()
    ));
    let result = fs::copy(source, &temporary)
        .map_err(|error| error.to_string())
        .and_then(|_| replace_file(&temporary, destination));
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| error.to_string())
}

fn remove_file_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn bundled_helper_path() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let name = if cfg!(windows) {
        "verboo-in-chrome.exe"
    } else {
        "verboo-in-chrome"
    };
    executable
        .parent()
        .map(|parent| parent.join(name))
        .ok_or_else(|| "chrome_bundled_helper_missing".into())
}
