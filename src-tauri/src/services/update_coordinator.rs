use crate::models::types::{BootstrapStage, UpdateSnapshot, UpdateStatus, UpdateTarget};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use super::cli_update::service::{
    CliUpdateService, CliUpdateSnapshot, CliUpdateStatus, StartupValidation,
};
use super::node_runtime::{NodeRuntimeService, NodeRuntimeStatus};
use super::update_service::UpdateService;

#[derive(Clone)]
pub struct UpdateCoordinator {
    app: UpdateService,
    node: NodeRuntimeService,
    cli: Arc<RwLock<Option<CliUpdateService>>>,
    app_data_dir: PathBuf,
    operation: Arc<tokio::sync::Mutex<()>>,
    cli_initialization: Arc<Mutex<()>>,
    cli_initialization_error: Arc<Mutex<Option<String>>>,
}

impl UpdateCoordinator {
    pub fn new(app: UpdateService, node: NodeRuntimeService, app_data_dir: PathBuf) -> Self {
        Self {
            app,
            node,
            cli: Arc::new(RwLock::new(None)),
            app_data_dir,
            operation: Arc::new(tokio::sync::Mutex::new(())),
            cli_initialization: Arc::new(Mutex::new(())),
            cli_initialization_error: Arc::new(Mutex::new(None)),
        }
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(
        app: UpdateService,
        node: NodeRuntimeService,
        app_data_dir: PathBuf,
    ) -> Self {
        Self::new(app, node, app_data_dir)
    }

    pub fn app(&self) -> UpdateService {
        self.app.clone_handle()
    }

    pub fn cli(&self) -> Option<CliUpdateService> {
        self.cli
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn node(&self) -> NodeRuntimeService {
        self.node.clone()
    }

    pub fn initialize_existing_cli(&self) -> Result<(), String> {
        let _initialization = self
            .cli_initialization
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.cli().is_some() {
            return Ok(());
        }
        let Some(node_path) = self.node.resolve_existing()? else {
            return Ok(());
        };
        let service = self.try_construct_cli_service(node_path)?;
        self.store_cli(service.clone());
        match service.validate_startup()? {
            StartupValidation::Missing => Ok(()),
            StartupValidation::Valid { .. } => self.node.garbage_collect_obsolete(true),
            StartupValidation::RolledBack { rejected, restored } => {
                eprintln!(
                    "[verboo:cli-update] rolled back {rejected} to {restored}; restart required"
                );
                self.node.garbage_collect_obsolete(true)
            }
        }
    }

    pub fn ensure_cli_service(&self) -> Result<CliUpdateService, String> {
        if let Some(service) = self.cli() {
            return Ok(service);
        }
        let _initialization = self
            .cli_initialization
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(service) = self.cli() {
            return Ok(service);
        }
        let node_path = self.node.ensure_ready()?;
        let service = self.try_construct_cli_service(node_path)?;
        self.store_cli(service.clone());
        Ok(service)
    }

    fn construct_cli_service(&self, node_path: PathBuf) -> Result<CliUpdateService, String> {
        let service = CliUpdateService::production(&self.app_data_dir, node_path.clone())?;
        super::cli_update::runtime::configure(service.store().clone(), node_path)?;
        Ok(service)
    }

    fn try_construct_cli_service(&self, node_path: PathBuf) -> Result<CliUpdateService, String> {
        self.set_cli_initialization_error(None);
        self.construct_cli_service(node_path).map_err(|detail| {
            let detail = crate::services::bootstrap_diag::sanitize(&detail);
            eprintln!("[verboo:cli-update] initialization failed: {detail}");
            crate::services::bootstrap_diag::record(&detail);
            crate::services::diagnostic_log::emit_error(
                "updater",
                "cli_initialization_failed",
                &detail,
                None,
                serde_json::json!({}),
            );
            self.set_cli_initialization_error(Some(detail.clone()));
            detail
        })
    }

    fn set_cli_initialization_error(&self, error: Option<String>) {
        *self
            .cli_initialization_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = error;
    }

    fn store_cli(&self, service: CliUpdateService) {
        *self
            .cli
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(service);
    }

    pub fn snapshot(&self) -> UpdateSnapshot {
        if let Some(cli) = self.cli() {
            let cli_snapshot = cli.snapshot();
            let bootstrap_required = cli_snapshot.bootstrap_required;
            let mut snapshot = combine_snapshots(self.app.snapshot(), Some(cli_snapshot));
            snapshot.bootstrap_stage = bootstrap_required.then_some(BootstrapStage::Cli);
            return snapshot;
        }

        let node = self.node.snapshot();
        let cli_initialization_error = self
            .cli_initialization_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let cli = CliUpdateSnapshot {
            status: match (&cli_initialization_error, node.status) {
                (Some(_), _) => CliUpdateStatus::BootstrapError,
                (None, NodeRuntimeStatus::Missing)
                | (None, NodeRuntimeStatus::Checking)
                | (None, NodeRuntimeStatus::Ready) => CliUpdateStatus::BootstrapChecking,
                (None, NodeRuntimeStatus::Downloading) => CliUpdateStatus::BootstrapDownloading,
                (None, NodeRuntimeStatus::Error) => CliUpdateStatus::BootstrapError,
            },
            current_version: None,
            available_version: None,
            downloaded_bytes: node.downloaded_bytes,
            total_bytes: node.total_bytes,
            error: cli_initialization_error.clone().or(node.error),
            bootstrap_required: true,
        };
        let mut snapshot = combine_snapshots(self.app.snapshot(), Some(cli));
        snapshot.cli_bootstrap_required = true;
        snapshot.bootstrap_stage = Some(if cli_initialization_error.is_some() {
            BootstrapStage::Cli
        } else {
            BootstrapStage::Runtime
        });
        if snapshot.target.is_none() {
            snapshot.target = Some(UpdateTarget::Cli);
        }
        snapshot
    }

    /// Returns the first renderer-facing snapshot only after the existing
    /// runtime/CLI pair has had a chance to initialize. Setup starts that work
    /// in the background, but the renderer can request status before the
    /// background thread acquires the initialization lock. Running the same
    /// idempotent initializer here closes that race without blocking app setup.
    pub fn snapshot_after_startup_initialization(&self) -> UpdateSnapshot {
        if let Err(error) = self.initialize_existing_cli() {
            eprintln!("[verboo:cli-update] startup status preparation failed: {error}");
        }
        self.snapshot()
    }

    pub async fn begin_operation(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.operation.clone().lock_owned().await
    }
}

pub fn combine_snapshots(
    mut app: UpdateSnapshot,
    cli: Option<CliUpdateSnapshot>,
) -> UpdateSnapshot {
    app.bootstrap_stage = None;
    let Some(cli) = cli else {
        app.target = target_for_app_status(&app.status);
        return app;
    };

    app.cli_current_version = cli.current_version.clone();
    app.cli_available_version = cli.available_version.clone();
    app.cli_bootstrap_required = cli.bootstrap_required;

    let app_error = matches!(app.status, UpdateStatus::Error);
    let cli_error = matches!(
        cli.status,
        CliUpdateStatus::Error | CliUpdateStatus::BootstrapError
    );
    let component_error = merge_errors(
        app_error.then_some(app.error.clone()).flatten(),
        cli_error.then_some(cli.error.clone()).flatten(),
    );

    let app_ready = matches!(app.status, UpdateStatus::Downloaded);
    let cli_ready = matches!(cli.status, CliUpdateStatus::Ready);
    let app_downloading = matches!(app.status, UpdateStatus::Downloading);
    let cli_downloading = matches!(
        cli.status,
        CliUpdateStatus::Downloading | CliUpdateStatus::BootstrapDownloading
    );
    if app_downloading || cli_downloading {
        app.status = UpdateStatus::Downloading;
        app.target = merge_targets(app_downloading || app_ready, cli_downloading || cli_ready);
        app.error = component_error;
        apply_combined_progress(&mut app, &cli, app_downloading, app_ready);
        return app;
    }

    let app_checking = matches!(app.status, UpdateStatus::Checking);
    let cli_checking = matches!(
        cli.status,
        CliUpdateStatus::Checking | CliUpdateStatus::BootstrapChecking
    );
    if app_checking || cli_checking {
        app.status = UpdateStatus::Checking;
        app.target = merge_targets(app_checking, cli_checking);
        app.error = component_error;
        return app;
    }

    let app_available = matches!(app.status, UpdateStatus::Available);
    let cli_available = matches!(cli.status, CliUpdateStatus::Available);
    if app_available || cli_available {
        app.status = UpdateStatus::Available;
        app.target = merge_targets(app_available, cli_available);
        app.error = component_error;
        return app;
    }

    if app_ready || cli_ready {
        app.status = UpdateStatus::Downloaded;
        app.target = merge_targets(app_ready, cli_ready);
        app.percent = Some(100.0);
        app.error = component_error;
        return app;
    }

    if app_error || cli_error {
        app.status = UpdateStatus::Error;
        app.target = merge_targets(app_error, cli_error);
        app.error = component_error;
        return app;
    }

    app.target = None;
    if matches!(app.status, UpdateStatus::Unsupported)
        && !matches!(cli.status, CliUpdateStatus::NotAvailable)
    {
        return app;
    }
    if matches!(app.status, UpdateStatus::NotAvailable)
        || matches!(cli.status, CliUpdateStatus::NotAvailable)
    {
        app.status = UpdateStatus::NotAvailable;
    }
    app
}

fn target_for_app_status(status: &UpdateStatus) -> Option<UpdateTarget> {
    matches!(
        status,
        UpdateStatus::Checking
            | UpdateStatus::Available
            | UpdateStatus::Downloading
            | UpdateStatus::Downloaded
            | UpdateStatus::Error
    )
    .then_some(UpdateTarget::App)
}

fn merge_targets(app: bool, cli: bool) -> Option<UpdateTarget> {
    match (app, cli) {
        (true, true) => Some(UpdateTarget::Both),
        (true, false) => Some(UpdateTarget::App),
        (false, true) => Some(UpdateTarget::Cli),
        (false, false) => None,
    }
}

fn merge_errors(app: Option<String>, cli: Option<String>) -> Option<String> {
    match (app, cli) {
        (Some(app), Some(cli)) => Some(format!("App: {app}; CLI: {cli}")),
        (Some(app), None) => Some(format!("App: {app}")),
        (None, Some(cli)) => Some(format!("CLI: {cli}")),
        (None, None) => None,
    }
}

fn apply_combined_progress(
    app: &mut UpdateSnapshot,
    cli: &CliUpdateSnapshot,
    app_downloading: bool,
    app_ready: bool,
) {
    let mut transferred = 0_u64;
    let mut total = 0_u64;

    if app_downloading || app_ready {
        if let Some(app_total) = app.total_bytes {
            total = total.saturating_add(app_total);
            transferred =
                transferred.saturating_add(app.transferred_bytes.unwrap_or(if app_ready {
                    app_total
                } else {
                    0
                }));
        }
    }

    if matches!(
        cli.status,
        CliUpdateStatus::Downloading
            | CliUpdateStatus::BootstrapDownloading
            | CliUpdateStatus::Ready
    ) {
        if let Some(cli_total) = cli.total_bytes {
            total = total.saturating_add(cli_total);
            transferred = transferred.saturating_add(cli.downloaded_bytes.unwrap_or_else(|| {
                if matches!(cli.status, CliUpdateStatus::Ready) {
                    cli_total
                } else {
                    0
                }
            }));
        }
    }

    app.transferred_bytes = Some(transferred);
    app.total_bytes = (total > 0).then_some(total);
    app.percent =
        (total > 0).then_some((transferred as f64 / total as f64 * 100.0).clamp(0.0, 100.0));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{BootstrapStage, UpdateTarget};
    use crate::services::node_runtime::{NodeRuntimeService, NodeRuntimeStatus};

    fn coordinator_with_runtime(
        status: NodeRuntimeStatus,
        downloaded: Option<u64>,
        total: Option<u64>,
    ) -> UpdateCoordinator {
        UpdateCoordinator::new_for_test(
            UpdateService::new("0.7.0-beta".to_string(), true),
            NodeRuntimeService::test_fixture(status, downloaded, total),
            tempfile::tempdir().unwrap().path().to_path_buf(),
        )
    }

    #[test]
    fn missing_runtime_is_exposed_as_runtime_bootstrap() {
        let coordinator = coordinator_with_runtime(NodeRuntimeStatus::Missing, None, None);
        let snapshot = coordinator.snapshot();
        assert!(snapshot.cli_bootstrap_required);
        assert_eq!(snapshot.bootstrap_stage, Some(BootstrapStage::Runtime));
        assert_eq!(snapshot.target, Some(UpdateTarget::Cli));
    }

    #[test]
    fn runtime_download_progress_uses_the_existing_cli_target() {
        let coordinator =
            coordinator_with_runtime(NodeRuntimeStatus::Downloading, Some(25), Some(100));
        let snapshot = coordinator.snapshot();
        assert_eq!(snapshot.status, UpdateStatus::Downloading);
        assert_eq!(snapshot.percent, Some(25.0));
        assert_eq!(snapshot.bootstrap_stage, Some(BootstrapStage::Runtime));
        assert_eq!(snapshot.target, Some(UpdateTarget::Cli));
    }

    #[test]
    fn runtime_error_snapshot_keeps_url_and_status() {
        let coordinator = coordinator_with_runtime(NodeRuntimeStatus::Error, None, None);
        let snapshot = coordinator.snapshot();
        assert_eq!(snapshot.status, UpdateStatus::Error);
        assert_eq!(snapshot.bootstrap_stage, Some(BootstrapStage::Runtime));
        let error = snapshot.error.expect("runtime error must reach the combined snapshot");
        assert!(error.contains("HTTP 403"), "{error}");
        assert!(error.contains("nodejs.org"), "{error}");
        assert!(!error.contains("runtime_install_failed"), "{error}");
    }

    #[test]
    fn cli_initialization_failure_is_retryable_in_the_cli_stage() {
        let coordinator = coordinator_with_runtime(NodeRuntimeStatus::Ready, None, None);
        coordinator.set_cli_initialization_error(Some(
            "Verboo Node runtime is not executable at runtime/node/24.19.0/win-x64/node.exe"
                .to_string(),
        ));
        let snapshot = coordinator.snapshot();
        assert_eq!(snapshot.status, UpdateStatus::Error);
        assert!(snapshot.cli_bootstrap_required);
        assert_eq!(snapshot.bootstrap_stage, Some(BootstrapStage::Cli));
        assert_eq!(snapshot.target, Some(UpdateTarget::Cli));
        let error = snapshot.error.expect("construct error must reach the combined snapshot");
        assert!(error.contains("not executable"), "{error}");
        assert!(error.contains("win-x64/node.exe"), "{error}");
        assert!(!error.contains("cli_initialization_failed"), "{error}");
    }

    #[test]
    fn cli_initialization_failure_exposes_the_real_construct_error_on_the_snapshot() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        crate::services::cli_update::runtime::reset();
        crate::services::bootstrap_diag::reset();

        let app_data = tempfile::tempdir().unwrap();
        let store = crate::services::cli_update::store::CliStore::open(app_data.path()).unwrap();
        let node = app_data.path().join(if cfg!(windows) {
            "node.exe"
        } else {
            "node"
        });
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(&node, b"#!/bin/sh\nexit 0\n").unwrap();
            std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        #[cfg(windows)]
        {
            std::fs::write(&node, b"MZ").unwrap();
        }
        crate::services::cli_update::runtime::configure(store, node.clone()).unwrap();

        let override_cli = app_data.path().join("override/dist/cli.mjs");
        std::fs::create_dir_all(override_cli.parent().unwrap()).unwrap();
        std::fs::write(&override_cli, b"entry").unwrap();
        let previous_node = std::env::var_os("VERBOO_NODE_PATH");
        let previous_cli = std::env::var_os("VERBOO_CLI_PATH");
        std::env::set_var("VERBOO_NODE_PATH", &node);
        std::env::set_var("VERBOO_CLI_PATH", &override_cli);

        let coordinator = UpdateCoordinator::new_for_test(
            UpdateService::new("0.7.0-beta".to_string(), true),
            NodeRuntimeService::production(app_data.path()).unwrap(),
            app_data.path().to_path_buf(),
        );
        let error = match coordinator.ensure_cli_service() {
            Err(error) => error,
            Ok(_) => panic!("expected CLI construction to fail while authority is already configured"),
        };
        let snapshot = coordinator.snapshot();

        assert_ne!(error, "Verboo CLI preparation failed");
        assert!(
            error.contains("already configured"),
            "construct error should stay specific, got {error}"
        );
        let snap_err = snapshot
            .error
            .expect("combined snapshot should carry the construct error");
        assert!(
            snap_err.contains("already configured"),
            "{snap_err}"
        );
        assert!(!snap_err.contains("cli_initialization_failed"), "{snap_err}");

        match previous_node {
            Some(value) => std::env::set_var("VERBOO_NODE_PATH", value),
            None => std::env::remove_var("VERBOO_NODE_PATH"),
        }
        match previous_cli {
            Some(value) => std::env::set_var("VERBOO_CLI_PATH", value),
            None => std::env::remove_var("VERBOO_CLI_PATH"),
        }
        crate::services::cli_update::runtime::reset();
        crate::services::bootstrap_diag::reset();
    }

    #[test]
    fn cli_service_materializes_only_after_an_owned_node_is_ready() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        crate::services::cli_update::runtime::reset();
        let app_data = tempfile::tempdir().unwrap();
        let node = NodeRuntimeService::production(app_data.path()).unwrap();
        let coordinator = UpdateCoordinator::new_for_test(
            UpdateService::new("0.7.0-beta".to_string(), true),
            node,
            app_data.path().to_path_buf(),
        );

        assert!(coordinator.cli().is_none());
        coordinator.ensure_cli_service().unwrap();
        assert!(coordinator.cli().is_some());
        assert_eq!(
            coordinator.snapshot().bootstrap_stage,
            Some(BootstrapStage::Cli)
        );
        crate::services::cli_update::runtime::reset();
    }

    #[cfg(unix)]
    #[test]
    fn startup_status_initializes_an_installed_cli_before_reporting_bootstrap() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        crate::services::cli_update::runtime::reset();
        let app_data = tempfile::tempdir().unwrap();
        let node = app_data.path().join("node");
        fs::write(&node, b"#!/bin/sh\nprintf '0.15.12 (Verboo Code)\\n'\n").unwrap();
        fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
        let override_cli = app_data.path().join("override/dist/cli.mjs");
        fs::create_dir_all(override_cli.parent().unwrap()).unwrap();
        fs::write(&override_cli, b"entry").unwrap();
        let previous_node = std::env::var_os("VERBOO_NODE_PATH");
        let previous_cli = std::env::var_os("VERBOO_CLI_PATH");
        std::env::set_var("VERBOO_NODE_PATH", &node);
        std::env::set_var("VERBOO_CLI_PATH", &override_cli);

        let store = crate::services::cli_update::store::CliStore::open(app_data.path()).unwrap();
        let version_root = store.version_dir("0.15.12").unwrap();
        fs::create_dir_all(version_root.join("dist")).unwrap();
        fs::write(version_root.join("dist/cli.mjs"), b"entry").unwrap();
        store
            .activate(
                &crate::services::cli_update::store::CliPointer::new(
                    "0.15.12",
                    crate::services::cli_update::contract::DesktopTarget::host().unwrap(),
                    "a".repeat(64),
                )
                .unwrap(),
            )
            .unwrap();

        let coordinator = UpdateCoordinator::new_for_test(
            UpdateService::new("0.7.0-beta".to_string(), true),
            NodeRuntimeService::production(app_data.path()).unwrap(),
            app_data.path().to_path_buf(),
        );

        let snapshot = coordinator.snapshot_after_startup_initialization();
        assert!(!snapshot.cli_bootstrap_required);
        assert_eq!(snapshot.cli_current_version.as_deref(), Some("0.15.12"));

        match previous_node {
            Some(value) => std::env::set_var("VERBOO_NODE_PATH", value),
            None => std::env::remove_var("VERBOO_NODE_PATH"),
        }
        match previous_cli {
            Some(value) => std::env::set_var("VERBOO_CLI_PATH", value),
            None => std::env::remove_var("VERBOO_CLI_PATH"),
        }
        crate::services::cli_update::runtime::reset();
    }

    fn app(status: UpdateStatus) -> UpdateSnapshot {
        UpdateSnapshot {
            status,
            current_version: "0.7.0-beta".to_string(),
            available_version: Some("0.8.0".to_string()),
            ..UpdateSnapshot::default()
        }
    }

    fn cli(status: CliUpdateStatus) -> CliUpdateSnapshot {
        CliUpdateSnapshot {
            status,
            current_version: Some("0.15.5".to_string()),
            available_version: Some("0.15.6".to_string()),
            downloaded_bytes: None,
            total_bytes: None,
            error: None,
            bootstrap_required: false,
        }
    }

    #[test]
    fn two_available_components_are_one_both_snapshot() {
        let combined = combine_snapshots(
            app(UpdateStatus::Available),
            Some(cli(CliUpdateStatus::Available)),
        );
        assert_eq!(combined.status, UpdateStatus::Available);
        assert_eq!(combined.target, Some(UpdateTarget::Both));
        assert_eq!(combined.available_version.as_deref(), Some("0.8.0"));
        assert_eq!(combined.cli_available_version.as_deref(), Some("0.15.6"));
    }

    #[test]
    fn staged_app_does_not_hide_cli_that_still_needs_download() {
        let combined = combine_snapshots(
            app(UpdateStatus::Downloaded),
            Some(cli(CliUpdateStatus::Available)),
        );
        assert_eq!(combined.status, UpdateStatus::Available);
        assert_eq!(combined.target, Some(UpdateTarget::Cli));
    }

    #[test]
    fn both_ready_components_require_one_combined_restart() {
        let combined = combine_snapshots(
            app(UpdateStatus::Downloaded),
            Some(cli(CliUpdateStatus::Ready)),
        );
        assert_eq!(combined.status, UpdateStatus::Downloaded);
        assert_eq!(combined.target, Some(UpdateTarget::Both));
    }

    #[test]
    fn weighted_progress_uses_bytes_not_the_mean_of_percentages() {
        let mut app = app(UpdateStatus::Downloading);
        app.transferred_bytes = Some(50);
        app.total_bytes = Some(100);
        let mut cli = cli(CliUpdateStatus::Downloading);
        cli.downloaded_bytes = Some(100);
        cli.total_bytes = Some(300);

        let combined = combine_snapshots(app, Some(cli));
        assert_eq!(combined.target, Some(UpdateTarget::Both));
        assert_eq!(combined.transferred_bytes, Some(150));
        assert_eq!(combined.total_bytes, Some(400));
        assert_eq!(combined.percent, Some(37.5));
    }

    #[test]
    fn staged_component_counts_as_fully_transferred_while_the_other_downloads() {
        let mut app = app(UpdateStatus::Downloaded);
        app.transferred_bytes = None;
        app.total_bytes = Some(100);
        let mut cli = cli(CliUpdateStatus::Downloading);
        cli.downloaded_bytes = Some(50);
        cli.total_bytes = Some(100);

        let combined = combine_snapshots(app, Some(cli));
        assert_eq!(combined.target, Some(UpdateTarget::Both));
        assert_eq!(combined.transferred_bytes, Some(150));
        assert_eq!(combined.total_bytes, Some(200));
        assert_eq!(combined.percent, Some(75.0));
    }

    #[test]
    fn absent_cli_preserves_the_app_updater() {
        let combined = combine_snapshots(app(UpdateStatus::Available), None);
        assert_eq!(combined.status, UpdateStatus::Available);
        assert_eq!(combined.target, Some(UpdateTarget::App));
        assert_eq!(combined.cli_current_version, None);
    }

    #[test]
    fn missing_cli_marks_the_first_bootstrap_as_required() {
        let mut missing_cli = cli(CliUpdateStatus::Idle);
        missing_cli.current_version = None;
        missing_cli.bootstrap_required = true;
        let combined = combine_snapshots(app(UpdateStatus::Idle), Some(missing_cli));

        assert!(combined.cli_bootstrap_required);
    }

    #[test]
    fn installed_cli_clears_the_first_bootstrap_gate() {
        let combined = combine_snapshots(
            app(UpdateStatus::Idle),
            Some(cli(CliUpdateStatus::NotAvailable)),
        );

        assert!(!combined.cli_bootstrap_required);
    }

    #[test]
    fn installed_but_unhealthy_cli_keeps_the_bootstrap_gate() {
        let mut unhealthy = cli(CliUpdateStatus::BootstrapError);
        unhealthy.bootstrap_required = true;
        unhealthy.error = Some("CLI smoke check failed".to_string());

        let combined = combine_snapshots(app(UpdateStatus::Idle), Some(unhealthy));

        assert!(combined.cli_bootstrap_required);
        assert_eq!(combined.status, UpdateStatus::Error);
        assert_eq!(
            combined.error.as_deref(),
            Some("CLI: CLI smoke check failed")
        );
    }

    #[test]
    fn cli_failure_does_not_hide_an_available_app_update() {
        let mut cli = cli(CliUpdateStatus::Error);
        cli.error = Some("offline".to_string());

        let combined = combine_snapshots(app(UpdateStatus::Available), Some(cli));

        assert_eq!(combined.status, UpdateStatus::Available);
        assert_eq!(combined.target, Some(UpdateTarget::App));
        assert_eq!(combined.error.as_deref(), Some("CLI: offline"));
    }

    #[test]
    fn app_failure_does_not_hide_an_available_cli_update() {
        let mut app = app(UpdateStatus::Error);
        app.error = Some("app endpoint unavailable".to_string());

        let combined = combine_snapshots(app, Some(cli(CliUpdateStatus::Available)));

        assert_eq!(combined.status, UpdateStatus::Available);
        assert_eq!(combined.target, Some(UpdateTarget::Cli));
        assert_eq!(
            combined.error.as_deref(),
            Some("App: app endpoint unavailable")
        );
    }
}
