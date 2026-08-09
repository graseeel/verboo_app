use crate::models::types::{UpdateSnapshot, UpdateStatus, UpdateTarget};
use std::sync::Arc;

use super::cli_update::service::{CliUpdateService, CliUpdateSnapshot, CliUpdateStatus};
use super::update_service::UpdateService;

#[derive(Clone)]
pub struct UpdateCoordinator {
    app: UpdateService,
    cli: Option<CliUpdateService>,
    operation: Arc<tokio::sync::Mutex<()>>,
}

impl UpdateCoordinator {
    pub fn new(app: UpdateService, cli: Option<CliUpdateService>) -> Self {
        Self {
            app,
            cli,
            operation: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    pub fn app(&self) -> UpdateService {
        self.app.clone_handle()
    }

    pub fn cli(&self) -> Option<CliUpdateService> {
        self.cli.clone()
    }

    pub fn snapshot(&self) -> UpdateSnapshot {
        combine_snapshots(
            self.app.snapshot(),
            self.cli.as_ref().map(CliUpdateService::snapshot),
        )
    }

    pub async fn begin_operation(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.operation.clone().lock_owned().await
    }
}

pub fn combine_snapshots(
    mut app: UpdateSnapshot,
    cli: Option<CliUpdateSnapshot>,
) -> UpdateSnapshot {
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
    use crate::models::types::UpdateTarget;

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
