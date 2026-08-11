//! Resolves and manages only the Node runtime owned by Verboo Desktop.
//!
//! Packaged builds accept the target-qualified Tauri sidecar beside the app
//! executable. Debug builds may use the explicit `VERBOO_NODE_PATH` override.
//! System Node locations, npm, nvm, Homebrew, and PATH are deliberately not
//! runtime fallbacks; the desktop app must work on a clean machine.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub mod archive;
pub mod contract;
pub mod download;

use archive::{
    create_receipt, executable_name, extract_declared, validate_installed_runtime,
    validate_runtime_executable, write_receipt,
};
use contract::NodeRuntimeContract;
use download::{NodeArchiveSource, OfficialNodeSource};

use crate::services::cli_update::contract::DesktopTarget;

const RUNTIME_SMOKE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeRuntimeStatus {
    Missing,
    Checking,
    Downloading,
    Ready,
    Error,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NodeRuntimeSnapshot {
    pub status: NodeRuntimeStatus,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
    pub bootstrap_required: bool,
}

#[derive(Clone)]
pub struct NodeRuntimeService {
    inner: Arc<ServiceInner>,
}

struct ServiceInner {
    runtime_root: PathBuf,
    contract: NodeRuntimeContract,
    target: DesktopTarget,
    source: Arc<dyn NodeArchiveSource>,
    legacy_candidates: Vec<PathBuf>,
    honor_development_override: bool,
    state: Mutex<NodeRuntimeSnapshot>,
    operation: Mutex<()>,
}

impl NodeRuntimeService {
    pub fn production(app_data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let contract = NodeRuntimeContract::embedded()?;
        let target = DesktopTarget::host()
            .ok_or_else(|| "managed Node is unavailable on this platform".to_string())?;
        let source = Arc::new(OfficialNodeSource::production()?);
        Ok(Self::new(
            app_data_dir,
            contract,
            target,
            source,
            embedded_node_candidates(),
            true,
        ))
    }

    fn new(
        app_data_dir: impl AsRef<Path>,
        contract: NodeRuntimeContract,
        target: DesktopTarget,
        source: Arc<dyn NodeArchiveSource>,
        legacy_candidates: Vec<PathBuf>,
        honor_development_override: bool,
    ) -> Self {
        Self {
            inner: Arc::new(ServiceInner {
                runtime_root: app_data_dir.as_ref().join("runtime").join("node"),
                contract,
                target,
                source,
                legacy_candidates,
                honor_development_override,
                state: Mutex::new(NodeRuntimeSnapshot {
                    status: NodeRuntimeStatus::Missing,
                    downloaded_bytes: None,
                    total_bytes: None,
                    error: None,
                    bootstrap_required: true,
                }),
                operation: Mutex::new(()),
            }),
        }
    }

    #[cfg(test)]
    fn with_parts(
        app_data_dir: impl AsRef<Path>,
        contract: NodeRuntimeContract,
        target: DesktopTarget,
        source: Arc<dyn NodeArchiveSource>,
        legacy_candidates: Vec<PathBuf>,
    ) -> Self {
        Self::new(
            app_data_dir,
            contract,
            target,
            source,
            legacy_candidates,
            false,
        )
    }

    pub fn snapshot(&self) -> NodeRuntimeSnapshot {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn resolve_existing(&self) -> Result<Option<PathBuf>, String> {
        if self.inner.honor_development_override {
            if let Some(override_path) = development_override_result()? {
                self.mark_ready();
                return Ok(Some(override_path));
            }
        }

        let managed_root = self.managed_runtime_dir();
        match validate_installed_runtime(
            &self.inner.contract,
            self.inner.target,
            &managed_root,
            RUNTIME_SMOKE_TIMEOUT,
        ) {
            Ok(executable) => {
                self.mark_ready();
                return Ok(Some(executable));
            }
            Err(error) if managed_root.exists() => {
                eprintln!("[verboo:node-runtime] managed runtime rejected: {error}");
            }
            Err(_) => {}
        }

        for candidate in &self.inner.legacy_candidates {
            if !is_executable(candidate) {
                continue;
            }
            match validate_runtime_executable(
                &self.inner.contract,
                candidate,
                RUNTIME_SMOKE_TIMEOUT,
            ) {
                Ok(()) => {
                    self.mark_ready();
                    return Ok(Some(candidate.clone()));
                }
                Err(error) => eprintln!(
                    "[verboo:node-runtime] legacy runtime rejected at {}: {error}",
                    candidate.display()
                ),
            }
        }
        Ok(None)
    }

    pub fn ensure_ready(&self) -> Result<PathBuf, String> {
        let _operation = self
            .inner
            .operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.set_snapshot(NodeRuntimeSnapshot {
            status: NodeRuntimeStatus::Checking,
            downloaded_bytes: None,
            total_bytes: None,
            error: None,
            bootstrap_required: true,
        });

        match self.resolve_existing() {
            Ok(Some(executable)) => {
                self.mark_ready();
                return Ok(executable);
            }
            Ok(None) => {}
            Err(error) => return self.fail(error),
        }

        match self.install_managed() {
            Ok(executable) => {
                self.mark_ready();
                Ok(executable)
            }
            Err(error) => self.fail(error),
        }
    }

    fn install_managed(&self) -> Result<PathBuf, String> {
        ensure_owned_directory(&self.inner.runtime_root)?;
        let staging_root = self.inner.runtime_root.join(".staging");
        ensure_owned_directory(&staging_root)?;
        let staging = tempfile::Builder::new()
            .prefix("install-")
            .tempdir_in(&staging_root)
            .map_err(|error| format!("failed to create managed Node staging: {error}"))?;
        let artifact = self.inner.contract.artifact(self.inner.target)?;
        let archive_path = staging.path().join(&artifact.archive);
        self.set_snapshot(NodeRuntimeSnapshot {
            status: NodeRuntimeStatus::Downloading,
            downloaded_bytes: Some(0),
            total_bytes: Some(artifact.size),
            error: None,
            bootstrap_required: true,
        });
        self.inner
            .source
            .download(artifact, &archive_path, &mut |downloaded, total| {
                self.set_snapshot(NodeRuntimeSnapshot {
                    status: NodeRuntimeStatus::Downloading,
                    downloaded_bytes: Some(downloaded),
                    total_bytes: Some(total),
                    error: None,
                    bootstrap_required: true,
                });
            })?;

        let staged_runtime = staging.path().join("runtime");
        ensure_owned_directory(&staged_runtime)?;
        extract_declared(artifact, &archive_path, &staged_runtime)?;
        let receipt = create_receipt(
            &self.inner.contract,
            self.inner.target,
            &staged_runtime,
            RUNTIME_SMOKE_TIMEOUT,
        )?;
        write_receipt(&staged_runtime, &receipt)?;
        sync_directory(&staged_runtime)?;

        let destination = self.managed_runtime_dir();
        let parent = destination
            .parent()
            .ok_or_else(|| "managed Node destination has no parent".to_string())?;
        ensure_owned_directory(parent)?;
        let backup = staging
            .path()
            .join(format!("replaced-{}", uuid::Uuid::new_v4()));
        let had_existing = destination.exists();
        if had_existing {
            fs::rename(&destination, &backup)
                .map_err(|error| format!("failed to preserve managed Node runtime: {error}"))?;
        }
        if let Err(error) = fs::rename(&staged_runtime, &destination) {
            if had_existing {
                let _ = fs::rename(&backup, &destination);
            }
            return Err(format!("failed to activate managed Node runtime: {error}"));
        }
        sync_directory(parent)?;
        if had_existing {
            if let Err(error) = fs::remove_dir_all(&backup) {
                eprintln!("[verboo:node-runtime] stale runtime cleanup deferred: {error}");
            }
        }

        validate_installed_runtime(
            &self.inner.contract,
            self.inner.target,
            &destination,
            RUNTIME_SMOKE_TIMEOUT,
        )
    }

    pub fn managed_executable_path(&self) -> PathBuf {
        self.managed_runtime_dir()
            .join(executable_name(self.inner.target))
    }

    fn managed_runtime_dir(&self) -> PathBuf {
        self.inner
            .runtime_root
            .join(self.inner.contract.version())
            .join(self.inner.target.as_str())
    }

    pub(crate) fn runtime_root(&self) -> &Path {
        &self.inner.runtime_root
    }

    pub fn garbage_collect_obsolete(&self, cli_smoke_succeeded: bool) -> Result<(), String> {
        if !cli_smoke_succeeded || !self.inner.runtime_root.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(&self.inner.runtime_root)
            .map_err(|error| format!("failed to inspect managed Node runtimes: {error}"))?
        {
            let entry = entry
                .map_err(|error| format!("failed to inspect managed Node runtime: {error}"))?;
            let name = entry.file_name();
            if name == ".staging" || name == self.inner.contract.version() {
                continue;
            }
            let file_type = entry
                .file_type()
                .map_err(|error| format!("failed to inspect managed Node entry: {error}"))?;
            if file_type.is_dir() && !file_type.is_symlink() {
                fs::remove_dir_all(entry.path()).map_err(|error| {
                    format!("failed to remove obsolete managed Node runtime: {error}")
                })?;
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn test_fixture(
        status: NodeRuntimeStatus,
        downloaded_bytes: Option<u64>,
        total_bytes: Option<u64>,
    ) -> Self {
        struct UnavailableSource;
        impl NodeArchiveSource for UnavailableSource {
            fn download(
                &self,
                _artifact: &contract::NodeArtifact,
                _destination: &Path,
                _progress: &mut dyn FnMut(u64, u64),
            ) -> Result<(), String> {
                Err("unavailable test source".to_string())
            }
        }

        let service = Self::new(
            std::env::temp_dir().join(format!("verboo-node-state-{}", uuid::Uuid::new_v4())),
            NodeRuntimeContract::embedded().expect("compiled Node contract must be valid"),
            DesktopTarget::host().expect("test host must be supported"),
            Arc::new(UnavailableSource),
            Vec::new(),
            false,
        );
        service.set_snapshot(NodeRuntimeSnapshot {
            status,
            downloaded_bytes,
            total_bytes,
            error: (status == NodeRuntimeStatus::Error)
                .then(|| "runtime_install_failed".to_string()),
            bootstrap_required: status != NodeRuntimeStatus::Ready,
        });
        service
    }

    fn set_snapshot(&self, snapshot: NodeRuntimeSnapshot) {
        *self
            .inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = snapshot;
    }

    fn mark_ready(&self) {
        self.set_snapshot(NodeRuntimeSnapshot {
            status: NodeRuntimeStatus::Ready,
            downloaded_bytes: None,
            total_bytes: None,
            error: None,
            bootstrap_required: false,
        });
    }

    fn fail<T>(&self, detail: String) -> Result<T, String> {
        eprintln!("[verboo:node-runtime] preparation failed: {detail}");
        self.set_snapshot(NodeRuntimeSnapshot {
            status: NodeRuntimeStatus::Error,
            downloaded_bytes: None,
            total_bytes: None,
            error: Some("runtime_install_failed".to_string()),
            bootstrap_required: true,
        });
        Err("managed Node preparation failed".to_string())
    }
}

fn ensure_owned_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("failed to create managed Node directory: {error}"))?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect managed Node directory: {error}"))?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err("managed Node directory is not an owned directory".to_string());
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("failed to sync managed Node directory: {error}"))
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

pub fn resolve_node_path() -> Option<PathBuf> {
    development_override().or_else(resolve_embedded_node_path)
}

pub fn resolve_embedded_node_path() -> Option<PathBuf> {
    for candidate in embedded_node_candidates() {
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(debug_assertions)]
fn development_override() -> Option<PathBuf> {
    development_override_result().ok().flatten()
}

#[cfg(not(debug_assertions))]
fn development_override() -> Option<PathBuf> {
    None
}

#[cfg(debug_assertions)]
fn development_override_result() -> Result<Option<PathBuf>, String> {
    let node = std::env::var_os("VERBOO_NODE_PATH").map(PathBuf::from);
    let cli = std::env::var_os("VERBOO_CLI_PATH").map(PathBuf::from);
    match (node, cli) {
        (None, None) => Ok(None),
        (Some(node), Some(cli)) if is_executable(&node) && cli.is_file() => Ok(Some(node)),
        (Some(_), Some(_)) => Err("debug CLI and Node overrides are invalid".to_string()),
        _ => Err("VERBOO_NODE_PATH and VERBOO_CLI_PATH must be configured together".to_string()),
    }
}

#[cfg(not(debug_assertions))]
fn development_override_result() -> Result<Option<PathBuf>, String> {
    Ok(None)
}

fn embedded_node_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            push_unique(&mut candidates, directory.join(sidecar_runtime_name()));
        }
    }

    // `cargo test` and direct debug binaries do not copy externalBin beside
    // the Rust test executable. The build script has already produced the
    // exact target-qualified source under src-tauri/binaries, so debug builds
    // may use it without consulting a system installation.
    #[cfg(debug_assertions)]
    if let Some(target) = crate::services::cli_update::contract::DesktopTarget::host() {
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        push_unique(
            &mut candidates,
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join(format!("verboo-node-{target}{suffix}")),
        );
    }
    candidates
}

fn sidecar_runtime_name() -> &'static str {
    if cfg!(windows) {
        "verboo-node.exe"
    } else {
        "verboo-node"
    }
}

/// PATH entries for tools launched *by* the CLI (`git`, `gh`, `rg`, etc.).
/// These entries do not participate in selecting the Node runtime.
pub fn platform_specific_path_entries() -> Vec<PathBuf> {
    let user_home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);

    #[cfg(target_os = "macos")]
    {
        let mut entries = vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/opt/homebrew/sbin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/local/sbin"),
        ];
        if let Some(home) = user_home.as_ref() {
            entries.push(home.join(".local/bin"));
            entries.push(home.join(".cargo/bin"));
        }
        entries
    }

    #[cfg(target_os = "linux")]
    {
        let mut entries = vec![
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/local/sbin"),
            PathBuf::from("/snap/bin"),
        ];
        if let Some(home) = user_home.as_ref() {
            entries.push(home.join(".local/bin"));
            entries.push(home.join(".cargo/bin"));
        }
        entries
    }

    #[cfg(target_os = "windows")]
    {
        let mut entries = Vec::new();
        let local_app_data = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| user_home.as_ref().map(|home| home.join("AppData/Local")));
        let program_files = std::env::var_os("PROGRAMFILES")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\Program Files"));
        if let Some(local) = local_app_data.as_ref() {
            entries.push(local.join("Programs/Git/bin"));
            entries.push(local.join("Programs/Git/cmd"));
            entries.push(local.join("GitHubCli"));
        }
        entries.push(program_files.join("Git/cmd"));
        entries.push(program_files.join("GitHub CLI"));
        if let Some(home) = user_home.as_ref() {
            entries.push(home.join(".local/bin"));
            entries.push(home.join("scoop/shims"));
            entries.push(home.join(".cargo/bin"));
            entries.push(home.join("AppData/Local/Microsoft/WindowsApps"));
        }
        entries
    }
}

fn push_unique(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.contains(&path) {
        paths.push(path);
    }
}

pub fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o100 != 0)
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        std::fs::metadata(path)
            .map(|metadata| metadata.is_file())
            .unwrap_or(false)
    }
}

#[cfg(test)]
pub(crate) fn resolve_test_node_on_path() -> Option<PathBuf> {
    if std::env::var_os("VERBOO_TEST_NO_NODE").is_some() {
        return None;
    }
    let filename = if cfg!(windows) { "node.exe" } else { "node" };
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .map(|directory| directory.join(filename))
        .find(|candidate| is_executable(candidate))
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::collections::VecDeque;
    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use std::io::Cursor;
    #[cfg(unix)]
    use std::sync::{Arc, Mutex};

    #[cfg(unix)]
    use tar::{Builder, EntryType, Header};
    #[cfg(unix)]
    use xz2::write::XzEncoder;

    use super::*;
    #[cfg(unix)]
    use crate::services::node_runtime::download::NodeArchiveSource;

    #[cfg(unix)]
    enum FakeResponse {
        Error(String),
        Partial(Vec<u8>),
        Success(Vec<u8>),
    }

    #[cfg(unix)]
    #[derive(Default)]
    struct FakeNodeArchiveSource {
        responses: Mutex<VecDeque<FakeResponse>>,
    }

    #[cfg(unix)]
    impl NodeArchiveSource for FakeNodeArchiveSource {
        fn download(
            &self,
            artifact: &contract::NodeArtifact,
            destination: &Path,
            progress: &mut dyn FnMut(u64, u64),
        ) -> Result<(), String> {
            match self.responses.lock().unwrap().pop_front().unwrap() {
                FakeResponse::Error(error) => Err(error),
                FakeResponse::Partial(bytes) => {
                    fs::write(destination, bytes).unwrap();
                    Err("interrupted".to_string())
                }
                FakeResponse::Success(bytes) => {
                    fs::write(destination, &bytes).unwrap();
                    progress(bytes.len() as u64, artifact.size);
                    Ok(())
                }
            }
        }
    }

    #[cfg(unix)]
    struct ServiceFixture {
        _directory: tempfile::TempDir,
        service: NodeRuntimeService,
        source: Arc<FakeNodeArchiveSource>,
        archive: Vec<u8>,
    }

    #[cfg(unix)]
    impl ServiceFixture {
        fn empty() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let contract = contract::NodeRuntimeContract::embedded().unwrap();
            let target = crate::services::cli_update::contract::DesktopTarget::host().unwrap();
            let artifact = contract.artifact(target).unwrap();
            let source = Arc::new(FakeNodeArchiveSource::default());
            let archive = fixture_archive(artifact);
            let service = NodeRuntimeService::with_parts(
                directory.path(),
                contract,
                target,
                source.clone(),
                Vec::new(),
            );
            Self {
                _directory: directory,
                service,
                source,
                archive,
            }
        }

        fn succeed_next(&self) {
            self.source
                .responses
                .lock()
                .unwrap()
                .push_back(FakeResponse::Success(self.archive.clone()));
        }

        fn interrupt_next(&self) {
            self.source
                .responses
                .lock()
                .unwrap()
                .push_back(FakeResponse::Partial(b"partial".to_vec()));
        }

        fn fail_next(&self, message: &str) {
            self.source
                .responses
                .lock()
                .unwrap()
                .push_back(FakeResponse::Error(message.to_string()));
        }
    }

    #[cfg(unix)]
    fn fixture_archive(artifact: &contract::NodeArtifact) -> Vec<u8> {
        let encoder = XzEncoder::new(Vec::new(), 6);
        let mut builder = Builder::new(encoder);
        for (path, bytes, mode) in [
            (
                artifact.entry.as_str(),
                b"#!/bin/sh\nprintf '{\"node\":\"24.19.0\",\"modules\":\"137\",\"napi\":\"10\"}\\n'\n"
                    .as_slice(),
                0o755,
            ),
            (artifact.license.as_str(), b"fixture license".as_slice(), 0o644),
        ] {
            let mut header = Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(mode);
            header.set_entry_type(EntryType::Regular);
            header.set_path(path).unwrap();
            header.set_cksum();
            builder.append(&header, Cursor::new(bytes)).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn managed_runtime_precedes_legacy_embedded_fallback() {
        use std::os::unix::fs::PermissionsExt;

        let mut fixture = ServiceFixture::empty();
        fixture.succeed_next();
        let managed = fixture.service.ensure_ready().unwrap();
        let legacy = fixture._directory.path().join("verboo-node");
        fs::write(
            &legacy,
            b"#!/bin/sh\nprintf '{\"node\":\"24.19.0\",\"modules\":\"137\",\"napi\":\"10\"}\\n'\n",
        )
        .unwrap();
        fs::set_permissions(&legacy, fs::Permissions::from_mode(0o755)).unwrap();
        Arc::get_mut(&mut fixture.service.inner)
            .unwrap()
            .legacy_candidates = vec![legacy];
        assert_eq!(fixture.service.resolve_existing().unwrap(), Some(managed));
    }

    #[cfg(unix)]
    #[test]
    fn failed_attempt_preserves_an_already_valid_runtime() {
        let fixture = ServiceFixture::empty();
        fixture.succeed_next();
        let managed = fixture.service.ensure_ready().unwrap();
        fixture.fail_next("offline");
        assert_eq!(fixture.service.ensure_ready().unwrap(), managed);
        assert!(managed.exists());
    }

    #[cfg(unix)]
    #[test]
    fn retry_installs_after_interrupted_download_without_selecting_partial_bytes() {
        let fixture = ServiceFixture::empty();
        fixture.interrupt_next();
        assert!(fixture.service.ensure_ready().is_err());
        assert!(!fixture.service.managed_executable_path().exists());
        fixture.succeed_next();
        assert_eq!(
            fixture.service.ensure_ready().unwrap(),
            fixture.service.managed_executable_path()
        );
    }

    #[cfg(unix)]
    #[test]
    fn obsolete_runtime_is_kept_until_cli_smoke_authorizes_cleanup() {
        let fixture = ServiceFixture::empty();
        fixture.succeed_next();
        fixture.service.ensure_ready().unwrap();
        let old = fixture.service.runtime_root().join("23.11.0");
        fs::create_dir_all(&old).unwrap();
        fixture.service.garbage_collect_obsolete(false).unwrap();
        assert!(old.exists());
        fixture.service.garbage_collect_obsolete(true).unwrap();
        assert!(!old.exists());
    }

    #[test]
    fn embedded_candidates_are_only_app_owned_locations() {
        let rendered = embedded_node_candidates()
            .iter()
            .map(|path| path.to_string_lossy())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(rendered.contains("verboo-node"));
        assert!(!rendered.contains("/usr/local/bin/node"));
        assert!(!rendered.contains("nodejs\\node.exe"));
        assert!(!rendered.contains(".nvm"));
    }

    #[test]
    fn sidecar_runtime_name_matches_tauri_external_bin() {
        assert_eq!(
            sidecar_runtime_name(),
            if cfg!(windows) {
                "verboo-node.exe"
            } else {
                "verboo-node"
            }
        );
    }

    #[test]
    fn missing_path_is_not_executable() {
        assert!(!is_executable(Path::new(
            "/nonexistent/verboo-node-that-does-not-exist"
        )));
    }

    #[test]
    fn child_tool_path_entries_remain_available() {
        assert!(!platform_specific_path_entries().is_empty());
    }
}
