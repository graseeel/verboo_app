use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use semver::Version;
use verboo_desktop_lib::services::cli_update::archive::{smoke_payload, validate_payload};
use verboo_desktop_lib::services::cli_update::contract::DesktopTarget;
use verboo_desktop_lib::services::cli_update::service::{CliUpdateStatus, StartupValidation};
use verboo_desktop_lib::services::cli_update::store::CliPointer;
use verboo_desktop_lib::services::cli_update::{CliStore, CliUpdateService};
use verboo_desktop_lib::services::node_runtime;

const PREVIOUS_VERSION: &str = "0.15.9";

#[test]
#[ignore = "downloads and executes the current signed upstream CLI release"]
fn published_cli_release_bootstrap_and_update_e2e() {
    let expected_version = std::env::var("VERBOO_EXPECTED_CLI_VERSION")
        .expect("VERBOO_EXPECTED_CLI_VERSION must pin the release under test");
    assert!(
        Version::parse(&expected_version).unwrap() > Version::parse(PREVIOUS_VERSION).unwrap(),
        "the release under test must be newer than the seeded installed CLI"
    );
    let target = DesktopTarget::host().expect("host must be a shipped Verboo desktop target");
    let runtime_data = tempfile::tempdir().unwrap();
    let runtime = node_runtime::NodeRuntimeService::production(runtime_data.path()).unwrap();
    let node_path = runtime.ensure_ready().unwrap();
    assert_eq!(node_path, runtime.managed_executable_path());

    let bootstrap_data = tempfile::tempdir().unwrap();
    let bootstrap = CliUpdateService::production(bootstrap_data.path(), node_path.clone()).unwrap();
    assert_eq!(
        bootstrap.validate_startup().unwrap(),
        StartupValidation::Missing
    );

    let bootstrapped = bootstrap.bootstrap_if_missing().unwrap();
    assert_eq!(bootstrapped.status, CliUpdateStatus::Idle);
    assert_eq!(
        bootstrapped.current_version.as_deref(),
        Some(expected_version.as_str())
    );
    assert_eq!(
        bootstrap.validate_startup().unwrap(),
        StartupValidation::Valid {
            version: expected_version.clone(),
        }
    );
    assert_installed_cli_version(bootstrap.store(), &node_path, &expected_version);

    let update_data = tempfile::tempdir().unwrap();
    let update_store = CliStore::open(update_data.path()).unwrap();
    seed_previous_cli(&update_store, &node_path, target);
    let updater = CliUpdateService::production(update_data.path(), node_path.clone()).unwrap();

    let available = updater.check().unwrap();
    assert_eq!(available.status, CliUpdateStatus::Available);
    assert_eq!(available.current_version.as_deref(), Some(PREVIOUS_VERSION));
    assert_eq!(
        available.available_version.as_deref(),
        Some(expected_version.as_str())
    );

    let prepared = updater.prepare().unwrap();
    assert_eq!(prepared.status, CliUpdateStatus::Ready);
    assert_eq!(prepared.downloaded_bytes, prepared.total_bytes);
    assert!(prepared.downloaded_bytes.is_some_and(|bytes| bytes > 0));

    let activation = updater.activate_prepared_for_restart().unwrap();
    let committed = updater.commit_prepared_activation(&activation).unwrap();
    assert_eq!(committed.status, CliUpdateStatus::Idle);
    assert_eq!(
        committed.current_version.as_deref(),
        Some(expected_version.as_str())
    );

    let restarted = CliUpdateService::production(update_data.path(), node_path.clone()).unwrap();
    assert_eq!(
        restarted.validate_startup().unwrap(),
        StartupValidation::Valid {
            version: expected_version.clone(),
        }
    );
    assert_installed_cli_version(restarted.store(), &node_path, &expected_version);
}

fn seed_previous_cli(store: &CliStore, node_path: &Path, target: DesktopTarget) {
    let root = store.version_dir(PREVIOUS_VERSION).unwrap();
    fs::create_dir_all(root.join("dist")).unwrap();
    fs::create_dir_all(root.join("node_modules")).unwrap();
    fs::write(
        root.join("package.json"),
        serde_json::to_vec(&serde_json::json!({
            "name": "@verboo/code",
            "version": PREVIOUS_VERSION,
            "verbooDesktop": {
                "schemaVersion": 1,
                "target": target,
            },
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        root.join("dist/cli.mjs"),
        format!("process.stdout.write('{PREVIOUS_VERSION} (Verboo Code)\\n')\n"),
    )
    .unwrap();
    validate_payload(&root, PREVIOUS_VERSION, target).unwrap();
    smoke_payload(node_path, &root, PREVIOUS_VERSION, Duration::from_secs(30)).unwrap();

    let pointer = CliPointer::new(PREVIOUS_VERSION, target, "0".repeat(64)).unwrap();
    store.activate(&pointer).unwrap();
    store.mark_current_good().unwrap();
}

fn assert_installed_cli_version(store: &CliStore, node_path: &Path, expected_version: &str) {
    let pointer = store.current().unwrap().expect("CLI must be active");
    assert_eq!(pointer.version, expected_version);
    let root = store.version_dir(expected_version).unwrap();
    validate_payload(&root, expected_version, pointer.target).unwrap();
    smoke_payload(node_path, &root, expected_version, Duration::from_secs(30)).unwrap();

    let output = Command::new(node_path)
        .arg(root.join("dist/cli.mjs"))
        .arg("--version")
        .current_dir(&root)
        .env("DISABLE_AUTOUPDATER", "1")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "installed CLI failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        format!("{expected_version} (Verboo Code)")
    );
}
