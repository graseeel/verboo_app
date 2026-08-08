use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use semver::Version;
use serde::{Deserialize, Serialize};

use super::archive::{ExtractionLimits, extract_verified_archive, smoke_payload, validate_payload};
use super::contract::{
    CliArtifact, DesktopTarget, ManifestVerifier, RuntimeCompatibility, SelectedCandidate,
    VerifiedManifest, select_candidate,
};
#[cfg(test)]
use super::download::build_download_client;
use super::download::download_verified;
use super::store::{CliPointer, CliStore};

const LATEST_RELEASE_API: &str = "https://api.github.com/repos/verbeux-ai/code/releases/latest";
const RELEASE_DOWNLOAD_ROOT: &str = "https://github.com/verbeux-ai/code/releases/download";
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_SIGNATURE_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CliUpdateStatus {
    Idle,
    Checking,
    NotAvailable,
    Available,
    Downloading,
    Ready,
    BootstrapChecking,
    BootstrapDownloading,
    BootstrapError,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdateSnapshot {
    pub status: CliUpdateStatus,
    pub current_version: Option<String>,
    pub available_version: Option<String>,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
}

impl Default for CliUpdateSnapshot {
    fn default() -> Self {
        Self {
            status: CliUpdateStatus::Idle,
            current_version: None,
            available_version: None,
            downloaded_bytes: None,
            total_bytes: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupValidation {
    Missing,
    Valid { version: String },
    RolledBack { rejected: String, restored: String },
}

pub struct SignedManifestBytes {
    pub tag: String,
    pub manifest: Vec<u8>,
    pub signature: String,
}

pub trait CliReleaseSource: Send + Sync {
    fn fetch_signed_manifest(&self) -> Result<SignedManifestBytes, String>;

    fn download_artifact(
        &self,
        artifact: &CliArtifact,
        destination: &Path,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<(), String>;
}

pub trait ManifestTrust: Send + Sync {
    fn verify(&self, manifest: &[u8], signature: &str) -> Result<VerifiedManifest, String>;
}

impl ManifestTrust for ManifestVerifier {
    fn verify(&self, manifest: &[u8], signature: &str) -> Result<VerifiedManifest, String> {
        ManifestVerifier::verify(self, manifest, signature)
    }
}

pub struct GithubReleaseSource {
    client: Client,
    latest_release_api: String,
}

impl GithubReleaseSource {
    pub fn production() -> Result<Self, String> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(10 * 60))
            .redirect(Policy::limited(10))
            .user_agent(format!("Verboo-Desktop/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| format!("failed to create CLI release client: {error}"))?;
        Ok(Self {
            client,
            latest_release_api: LATEST_RELEASE_API.to_string(),
        })
    }

    #[cfg(test)]
    fn with_endpoint(client: Client, endpoint: impl Into<String>) -> Self {
        Self {
            client,
            latest_release_api: endpoint.into(),
        }
    }
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
}

impl CliReleaseSource for GithubReleaseSource {
    fn fetch_signed_manifest(&self) -> Result<SignedManifestBytes, String> {
        let release: GithubRelease = self
            .client
            .get(&self.latest_release_api)
            .send()
            .map_err(|error| format!("failed to discover the latest CLI release: {error}"))?
            .error_for_status()
            .map_err(|error| format!("CLI release discovery returned an error: {error}"))?
            .json()
            .map_err(|error| format!("invalid CLI release discovery response: {error}"))?;
        if release.draft || release.prerelease {
            return Err("latest CLI release is not a stable published release".to_string());
        }
        let version = release
            .tag_name
            .strip_prefix('v')
            .ok_or_else(|| "latest CLI release tag must start with v".to_string())?;
        Version::parse(version)
            .map_err(|error| format!("invalid latest CLI release tag: {error}"))?;

        let base = format!("{RELEASE_DOWNLOAD_ROOT}/{}", release.tag_name);
        let manifest = fetch_bounded(
            &self.client,
            &format!("{base}/verboo-cli-manifest.json"),
            MAX_MANIFEST_BYTES,
        )?;
        let signature_bytes = fetch_bounded(
            &self.client,
            &format!("{base}/verboo-cli-manifest.minisig"),
            MAX_SIGNATURE_BYTES,
        )?;
        let signature = String::from_utf8(signature_bytes)
            .map_err(|_| "CLI manifest signature is not UTF-8".to_string())?;
        Ok(SignedManifestBytes {
            tag: release.tag_name,
            manifest,
            signature,
        })
    }

    fn download_artifact(
        &self,
        artifact: &CliArtifact,
        destination: &Path,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<(), String> {
        download_verified(&self.client, artifact, destination, progress)
    }
}

fn fetch_bounded(client: &Client, url: &str, limit: u64) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .send()
        .map_err(|error| format!("failed to fetch CLI release metadata: {error}"))?
        .error_for_status()
        .map_err(|error| format!("CLI release metadata server returned an error: {error}"))?;
    if response.content_length().is_some_and(|size| size > limit) {
        return Err("CLI release metadata exceeds its size limit".to_string());
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read CLI release metadata: {error}"))?;
    if bytes.len() as u64 > limit {
        return Err("CLI release metadata exceeds its size limit".to_string());
    }
    Ok(bytes)
}

struct ServiceState {
    snapshot: CliUpdateSnapshot,
    candidate: Option<SelectedCandidate>,
    prepared: Option<CliPointer>,
}

struct ServiceInner {
    store: CliStore,
    source: Arc<dyn CliReleaseSource>,
    trust: Arc<dyn ManifestTrust>,
    node_path: PathBuf,
    app_version: String,
    target: DesktopTarget,
    state: Mutex<ServiceState>,
    operation: Mutex<()>,
}

#[derive(Debug, Clone)]
pub struct PreparedCliActivation {
    previous: CliPointer,
    activated: CliPointer,
}

#[derive(Clone)]
pub struct CliUpdateService {
    inner: Arc<ServiceInner>,
}

impl CliUpdateService {
    pub fn production(app_data_dir: impl AsRef<Path>, node_path: PathBuf) -> Result<Self, String> {
        let public_key = option_env!("VERBOO_CLI_MINISIGN_PUBLIC_KEY")
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                "this build has no Verboo CLI signing public key; CLI updates are disabled"
                    .to_string()
            })?;
        let target = DesktopTarget::host()
            .ok_or_else(|| "this platform does not support Verboo CLI updates".to_string())?;
        Self::new(
            CliStore::open(app_data_dir)?,
            node_path,
            env!("CARGO_PKG_VERSION"),
            target,
            Arc::new(ManifestVerifier::new(public_key)),
            Arc::new(GithubReleaseSource::production()?),
        )
    }

    pub fn new(
        store: CliStore,
        node_path: PathBuf,
        app_version: impl Into<String>,
        target: DesktopTarget,
        trust: Arc<dyn ManifestTrust>,
        source: Arc<dyn CliReleaseSource>,
    ) -> Result<Self, String> {
        store.cleanup_abandoned_staging()?;
        let current_version = store.current()?.map(|pointer| pointer.version);
        Ok(Self {
            inner: Arc::new(ServiceInner {
                store,
                source,
                trust,
                node_path,
                app_version: app_version.into(),
                target,
                state: Mutex::new(ServiceState {
                    snapshot: CliUpdateSnapshot {
                        current_version,
                        ..CliUpdateSnapshot::default()
                    },
                    candidate: None,
                    prepared: None,
                }),
                operation: Mutex::new(()),
            }),
        })
    }

    pub fn store(&self) -> &CliStore {
        &self.inner.store
    }

    pub fn snapshot(&self) -> CliUpdateSnapshot {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .snapshot
            .clone()
    }

    pub fn check(&self) -> Result<CliUpdateSnapshot, String> {
        let _operation = self.lock_operation();
        self.check_with_context(false)
    }

    pub fn prepare(&self) -> Result<CliUpdateSnapshot, String> {
        let _operation = self.lock_operation();
        self.prepare_with_context(false)
    }

    pub fn activate_prepared(&self) -> Result<CliUpdateSnapshot, String> {
        let _operation = self.lock_operation();
        self.activate_prepared_inner()
    }

    fn activate_prepared_inner(&self) -> Result<CliUpdateSnapshot, String> {
        let pointer = {
            let state = self.lock_state();
            state
                .prepared
                .clone()
                .ok_or_else(|| "no prepared CLI update is ready to activate".to_string())?
        };
        self.inner.store.activate(&pointer)?;
        self.inner.store.garbage_collect()?;
        let mut state = self.lock_state();
        state.snapshot = CliUpdateSnapshot {
            status: CliUpdateStatus::Idle,
            current_version: Some(pointer.version),
            available_version: None,
            downloaded_bytes: None,
            total_bytes: None,
            error: None,
        };
        state.candidate = None;
        state.prepared = None;
        Ok(state.snapshot.clone())
    }

    pub fn activate_prepared_for_restart(&self) -> Result<PreparedCliActivation, String> {
        let _operation = self.lock_operation();
        let (previous, activated) = {
            let state = self.lock_state();
            let activated = state
                .prepared
                .clone()
                .ok_or_else(|| "no prepared CLI update is ready to activate".to_string())?;
            let previous = self.inner.store.current()?.ok_or_else(|| {
                "normal CLI updates require an installed current version".to_string()
            })?;
            (previous, activated)
        };
        self.inner.store.activate(&activated)?;
        Ok(PreparedCliActivation {
            previous,
            activated,
        })
    }

    pub fn rollback_prepared_activation(
        &self,
        activation: &PreparedCliActivation,
    ) -> Result<CliUpdateSnapshot, String> {
        let _operation = self.lock_operation();
        self.inner
            .store
            .rollback_activation(&activation.activated, &activation.previous)?;
        let mut state = self.lock_state();
        state.snapshot.status = CliUpdateStatus::Ready;
        state.snapshot.current_version = Some(activation.previous.version.clone());
        state.snapshot.available_version = Some(activation.activated.version.clone());
        Ok(state.snapshot.clone())
    }

    pub fn commit_prepared_activation(
        &self,
        activation: &PreparedCliActivation,
    ) -> Result<CliUpdateSnapshot, String> {
        let _operation = self.lock_operation();
        let current = self
            .inner
            .store
            .current()?
            .ok_or_else(|| "activated CLI pointer disappeared".to_string())?;
        if current != activation.activated {
            return Err("activated CLI changed before restart was committed".to_string());
        }
        self.inner.store.garbage_collect()?;
        let mut state = self.lock_state();
        state.snapshot = CliUpdateSnapshot {
            status: CliUpdateStatus::Idle,
            current_version: Some(activation.activated.version.clone()),
            available_version: None,
            downloaded_bytes: None,
            total_bytes: None,
            error: None,
        };
        state.candidate = None;
        state.prepared = None;
        Ok(state.snapshot.clone())
    }

    pub fn bootstrap_if_missing(&self) -> Result<CliUpdateSnapshot, String> {
        let _operation = self.lock_operation();
        if self.inner.store.current()?.is_some() {
            return Ok(self.snapshot());
        }
        if let Err(error) = self.check_with_context(true) {
            self.fail(error.clone(), true);
            return Err(error);
        }
        if let Err(error) = self.prepare_with_context(true) {
            self.fail(error.clone(), true);
            return Err(error);
        }
        self.activate_prepared_inner()
    }

    pub fn validate_startup(&self) -> Result<StartupValidation, String> {
        let _operation = self.lock_operation();
        let Some(current) = self.inner.store.current()? else {
            return Ok(StartupValidation::Missing);
        };
        let current_root = self.inner.store.version_dir(&current.version)?;
        if smoke_payload(
            &self.inner.node_path,
            &current_root,
            &current.version,
            Duration::from_secs(30),
        )
        .is_ok()
        {
            self.inner.store.mark_current_good()?;
            self.inner.store.garbage_collect()?;
            return Ok(StartupValidation::Valid {
                version: current.version,
            });
        }

        if self.inner.store.was_rejected(&current.manifest_digest)? {
            return Err(format!(
                "CLI {} failed startup validation again; automatic rollback is blocked",
                current.version
            ));
        }
        let last_known_good = self.inner.store.last_known_good()?.ok_or_else(|| {
            "current CLI failed and no last-known-good version exists".to_string()
        })?;
        if last_known_good.manifest_digest == current.manifest_digest {
            return Err(
                "current CLI and last-known-good CLI have the same rejected digest".to_string(),
            );
        }
        let lkg_root = self.inner.store.version_dir(&last_known_good.version)?;
        smoke_payload(
            &self.inner.node_path,
            &lkg_root,
            &last_known_good.version,
            Duration::from_secs(30),
        )?;
        self.inner.store.record_rejected(&current.manifest_digest)?;
        let restored = self.inner.store.restore_last_known_good()?;
        Ok(StartupValidation::RolledBack {
            rejected: current.version,
            restored: restored.version,
        })
    }

    fn check_with_context(&self, bootstrap: bool) -> Result<CliUpdateSnapshot, String> {
        {
            let mut state = self.lock_state();
            state.snapshot.status = if bootstrap {
                CliUpdateStatus::BootstrapChecking
            } else {
                CliUpdateStatus::Checking
            };
            state.snapshot.error = None;
            state.snapshot.downloaded_bytes = None;
            state.snapshot.total_bytes = None;
            state.candidate = None;
        }

        let result = (|| {
            let signed = self.inner.source.fetch_signed_manifest()?;
            let verified = self
                .inner
                .trust
                .verify(&signed.manifest, &signed.signature)?;
            if signed.tag != format!("v{}", verified.manifest.cli_version) {
                return Err(
                    "signed CLI manifest version does not match its release tag".to_string()
                );
            }

            let current = self.inner.store.current()?;
            if self.inner.store.was_rejected(&verified.digest)? {
                return Err(format!(
                    "CLI {} was rejected by startup validation",
                    verified.manifest.cli_version
                ));
            }
            if let Some(current_version) = current.as_ref().map(|pointer| &pointer.version) {
                let available = Version::parse(&verified.manifest.cli_version)
                    .map_err(|error| format!("invalid signed CLI version: {error}"))?;
                let installed = Version::parse(current_version)
                    .map_err(|error| format!("invalid installed CLI version: {error}"))?;
                if available <= installed {
                    let mut state = self.lock_state();
                    state.snapshot.status = CliUpdateStatus::NotAvailable;
                    state.snapshot.current_version = Some(current_version.clone());
                    state.snapshot.available_version = None;
                    return Ok(state.snapshot.clone());
                }
            }

            let runtime = RuntimeCompatibility {
                current_cli_version: current.as_ref().map(|pointer| pointer.version.as_str()),
                ..RuntimeCompatibility::embedded(self.inner.target, &self.inner.app_version)
            };
            let candidate = select_candidate(&verified, runtime)?;
            let mut state = self.lock_state();
            state.snapshot.status = CliUpdateStatus::Available;
            state.snapshot.current_version = current.map(|pointer| pointer.version);
            state.snapshot.available_version = Some(candidate.version.to_string());
            state.snapshot.total_bytes = Some(candidate.artifact.size);
            state.candidate = Some(candidate);
            Ok(state.snapshot.clone())
        })();

        if let Err(error) = &result {
            self.fail(error.clone(), bootstrap);
        }
        result
    }

    fn prepare_with_context(&self, bootstrap: bool) -> Result<CliUpdateSnapshot, String> {
        let candidate = {
            let mut state = self.lock_state();
            let candidate = state
                .candidate
                .clone()
                .ok_or_else(|| "no compatible CLI update is available".to_string())?;
            state.snapshot.status = if bootstrap {
                CliUpdateStatus::BootstrapDownloading
            } else {
                CliUpdateStatus::Downloading
            };
            state.snapshot.downloaded_bytes = Some(0);
            state.snapshot.total_bytes = Some(candidate.artifact.size);
            state.snapshot.error = None;
            candidate
        };

        let staging = self.inner.store.create_staging_dir()?;
        let result = self.prepare_candidate(&candidate, &staging);
        if staging.exists() {
            let _ = fs::remove_dir_all(&staging);
        }
        match result {
            Ok(pointer) => {
                let mut state = self.lock_state();
                state.snapshot.status = CliUpdateStatus::Ready;
                state.snapshot.downloaded_bytes = Some(candidate.artifact.size);
                state.snapshot.total_bytes = Some(candidate.artifact.size);
                state.prepared = Some(pointer);
                Ok(state.snapshot.clone())
            }
            Err(error) => {
                self.fail(error.clone(), bootstrap);
                Err(error)
            }
        }
    }

    fn prepare_candidate(
        &self,
        candidate: &SelectedCandidate,
        staging: &Path,
    ) -> Result<CliPointer, String> {
        let version = candidate.version.to_string();
        let pointer = CliPointer::new(
            &version,
            candidate.artifact.target,
            &candidate.manifest_digest,
        )?;
        let existing = self.inner.store.version_dir(&version)?;
        if existing.exists() {
            validate_payload(&existing, &version, candidate.artifact.target)?;
            smoke_payload(
                &self.inner.node_path,
                &existing,
                &version,
                Duration::from_secs(30),
            )?;
            return Ok(pointer);
        }

        let archive_path = staging.join("archive.tar.gz");
        let service = self.clone();
        let mut progress = move |downloaded: u64, total: u64| {
            let mut state = service.lock_state();
            state.snapshot.downloaded_bytes = Some(downloaded);
            state.snapshot.total_bytes = Some(total);
        };
        self.inner
            .source
            .download_artifact(&candidate.artifact, &archive_path, &mut progress)?;
        let payload = staging.join("payload");
        let archive = fs::File::open(&archive_path)
            .map_err(|error| format!("failed to open verified CLI archive: {error}"))?;
        extract_verified_archive(archive, &payload, ExtractionLimits::default())?;
        validate_payload(&payload, &version, candidate.artifact.target)?;
        smoke_payload(
            &self.inner.node_path,
            &payload,
            &version,
            Duration::from_secs(30),
        )?;
        self.inner.store.promote_staged(&payload, &pointer)?;
        Ok(pointer)
    }

    fn fail(&self, error: String, bootstrap: bool) {
        let mut state = self.lock_state();
        state.snapshot.status = if bootstrap {
            CliUpdateStatus::BootstrapError
        } else {
            CliUpdateStatus::Error
        };
        state.snapshot.error = Some(error);
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, ServiceState> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_operation(&self) -> std::sync::MutexGuard<'_, ()> {
        self.inner
            .operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use flate2::Compression;
    use flate2::write::GzEncoder;
    use sha2::{Digest, Sha256};
    use tar::{Builder, Header};

    use super::*;
    use crate::services::cli_update::contract::{
        CliManifest, DesktopVersionCompatibility, NodeCompatibility,
    };
    use crate::services::cli_update::download::write_verified_archive;

    const PUBLIC_KEY: &str = "untrusted comment: minisign public key 8C2C9C2F56A02BEF\nRWTvK6BWL5wsjNVgnLFvSlaQ7XvT7Cs7qskFE7Dwl0ItgJKh2p9RSU+4\n";
    const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUTvK6BWL5wsjB2fb3xqCOd5aIHQ9GLUt3eoeHuwuSwQMZGkOjdPYjUMEfWGgIbP27xtzGuZZHgMPIYIOaG9ct6O4lOEd/oTowg=\ntrusted comment: timestamp:1786207558\tfile:manifest.json\thashed\nOfNzV/Vla/9D9Fbtw/iFqwQXoUUuXvEX3Lli34JGSYEwZvpfHxChd9Q3lq1LJ7E0ypZj1PZfFPsNtFAXLFZmCQ==\n";
    const SIGNED_MANIFEST: &[u8] = include_bytes!("test-fixtures/manifest.json");

    struct FixtureSource {
        tag: String,
        manifest: Vec<u8>,
        signature: String,
        archive: Option<Vec<u8>>,
        error: Option<String>,
    }

    impl CliReleaseSource for FixtureSource {
        fn fetch_signed_manifest(&self) -> Result<SignedManifestBytes, String> {
            if let Some(error) = self.error.as_ref() {
                return Err(error.clone());
            }
            Ok(SignedManifestBytes {
                tag: self.tag.clone(),
                manifest: self.manifest.clone(),
                signature: self.signature.clone(),
            })
        }

        fn download_artifact(
            &self,
            artifact: &CliArtifact,
            destination: &Path,
            progress: &mut dyn FnMut(u64, u64),
        ) -> Result<(), String> {
            let archive = self
                .archive
                .as_ref()
                .ok_or_else(|| "fixture has no archive".to_string())?;
            write_verified_archive(Cursor::new(archive), artifact, destination, progress)
        }
    }

    struct AcceptedManifest(VerifiedManifest);

    impl ManifestTrust for AcceptedManifest {
        fn verify(&self, _manifest: &[u8], _signature: &str) -> Result<VerifiedManifest, String> {
            Ok(self.0.clone())
        }
    }

    fn signed_source() -> Arc<dyn CliReleaseSource> {
        Arc::new(FixtureSource {
            tag: "v0.15.6".to_string(),
            manifest: SIGNED_MANIFEST.to_vec(),
            signature: SIGNATURE.to_string(),
            archive: None,
            error: None,
        })
    }

    fn service(
        app_data: &Path,
        node: PathBuf,
        trust: Arc<dyn ManifestTrust>,
        source: Arc<dyn CliReleaseSource>,
    ) -> CliUpdateService {
        CliUpdateService::new(
            CliStore::open(app_data).unwrap(),
            node,
            "0.7.0-beta",
            DesktopTarget::MacArm64,
            trust,
            source,
        )
        .unwrap()
    }

    fn install_minimal(store: &CliStore, version: &str) {
        let root = store.version_dir(version).unwrap();
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(root.join("dist/cli.mjs"), b"entry").unwrap();
    }

    #[test]
    fn signed_discovery_reports_one_compatible_update() {
        let app_data = tempfile::tempdir().unwrap();
        let service = service(
            app_data.path(),
            app_data.path().join("node"),
            Arc::new(ManifestVerifier::new(PUBLIC_KEY)),
            signed_source(),
        );
        let snapshot = service.check().unwrap();
        assert_eq!(snapshot.status, CliUpdateStatus::Available);
        assert_eq!(snapshot.available_version.as_deref(), Some("0.15.6"));
        assert_eq!(snapshot.total_bytes, Some(100));
    }

    #[test]
    fn discovery_does_not_offer_equal_or_older_cli() {
        let app_data = tempfile::tempdir().unwrap();
        let service = service(
            app_data.path(),
            app_data.path().join("node"),
            Arc::new(ManifestVerifier::new(PUBLIC_KEY)),
            signed_source(),
        );
        install_minimal(service.store(), "0.15.6");
        service
            .store()
            .activate(&CliPointer::new("0.15.6", DesktopTarget::MacArm64, "a".repeat(64)).unwrap())
            .unwrap();
        let snapshot = service.check().unwrap();
        assert_eq!(snapshot.status, CliUpdateStatus::NotAvailable);
        assert_eq!(snapshot.current_version.as_deref(), Some("0.15.6"));
    }

    #[test]
    fn offline_first_run_is_retryable_and_selects_no_runtime() {
        let app_data = tempfile::tempdir().unwrap();
        let source = Arc::new(FixtureSource {
            tag: String::new(),
            manifest: Vec::new(),
            signature: String::new(),
            archive: None,
            error: Some("offline".to_string()),
        });
        let service = service(
            app_data.path(),
            app_data.path().join("node"),
            Arc::new(ManifestVerifier::new(PUBLIC_KEY)),
            source,
        );
        assert!(service.bootstrap_if_missing().is_err());
        assert_eq!(service.snapshot().status, CliUpdateStatus::BootstrapError);
        assert_eq!(service.snapshot().error.as_deref(), Some("offline"));
        assert!(service.store().current().unwrap().is_none());
    }

    fn payload_archive(version: &str, target: DesktopTarget) -> Vec<u8> {
        let package = format!(
            "{{\"name\":\"@verboo/code\",\"version\":\"{version}\",\"verbooDesktop\":{{\"schemaVersion\":1,\"target\":\"{target}\"}}}}"
        );
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut builder = Builder::new(encoder);
        for (path, bytes) in [
            ("package.json", package.as_bytes()),
            ("dist/cli.mjs", b"entry".as_slice()),
            ("node_modules/dependency/index.js", b"module".as_slice()),
        ] {
            let mut header = Header::new_gnu();
            header.set_path(path).unwrap();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append(&header, Cursor::new(bytes)).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn prepared_activation_rolls_back_on_app_failure_then_commits_for_restart() {
        use std::os::unix::fs::PermissionsExt;

        let app_data = tempfile::tempdir().unwrap();
        let node = app_data.path().join("embedded-node");
        fs::write(&node, b"#!/bin/sh\nprintf '0.15.6 (Verboo Code)\\n'\n").unwrap();
        fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
        let archive = payload_archive("0.15.6", DesktopTarget::MacArm64);
        let artifact = CliArtifact {
            target: DesktopTarget::MacArm64,
            url: "https://github.com/verbeux-ai/code/releases/download/v0.15.6/verboo-cli-0.15.6-aarch64-apple-darwin.tar.gz".to_string(),
            size: archive.len() as u64,
            sha256: hex::encode(Sha256::digest(&archive)),
            archive: "tar.gz".to_string(),
        };
        let manifest = CliManifest {
            schema_version: 1,
            cli_version: "0.15.6".to_string(),
            released_at: "2026-08-08T12:00:00.000Z".to_string(),
            desktop_protocol: 1,
            desktop_version: DesktopVersionCompatibility {
                min: "0.7.0-beta".to_string(),
                max_exclusive: "0.8.0".to_string(),
            },
            node: NodeCompatibility {
                range: ">=24.0.0 <25.0.0".to_string(),
                modules: "137".to_string(),
                napi: "10".to_string(),
            },
            signing_key_id: "fixture".to_string(),
            artifacts: vec![artifact],
        };
        let verified = VerifiedManifest {
            manifest,
            digest: "c".repeat(64),
        };
        let source = Arc::new(FixtureSource {
            tag: "v0.15.6".to_string(),
            manifest: b"fixture".to_vec(),
            signature: "fixture".to_string(),
            archive: Some(archive),
            error: None,
        });
        let service = service(
            app_data.path(),
            node,
            Arc::new(AcceptedManifest(verified)),
            source,
        );
        install_minimal(service.store(), "0.15.5");
        service
            .store()
            .activate(&CliPointer::new("0.15.5", DesktopTarget::MacArm64, "a".repeat(64)).unwrap())
            .unwrap();
        service.check().unwrap();
        assert_eq!(service.prepare().unwrap().status, CliUpdateStatus::Ready);
        assert!(
            service
                .store()
                .version_dir("0.15.6")
                .unwrap()
                .join("dist/cli.mjs")
                .is_file()
        );
        let activation = service.activate_prepared_for_restart().unwrap();
        assert_eq!(
            service.store().current().unwrap().unwrap().version,
            "0.15.6"
        );
        let rolled_back = service.rollback_prepared_activation(&activation).unwrap();
        assert_eq!(rolled_back.status, CliUpdateStatus::Ready);
        assert_eq!(
            service.store().current().unwrap().unwrap().version,
            "0.15.5"
        );

        let activation = service.activate_prepared_for_restart().unwrap();
        let committed = service.commit_prepared_activation(&activation).unwrap();
        assert_eq!(committed.status, CliUpdateStatus::Idle);
        assert_eq!(committed.current_version.as_deref(), Some("0.15.6"));
        assert_eq!(
            service.store().current().unwrap().unwrap().version,
            "0.15.6"
        );
    }

    #[cfg(unix)]
    #[test]
    fn startup_failure_rolls_back_once_to_a_smoked_lkg() {
        use std::os::unix::fs::PermissionsExt;

        let app_data = tempfile::tempdir().unwrap();
        let node = app_data.path().join("embedded-node");
        fs::write(
            &node,
            b"#!/bin/sh\ncase \"$1\" in *0.15.5*) printf '0.15.5 (Verboo Code)\\n';; *) exit 9;; esac\n",
        )
        .unwrap();
        fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
        let service = service(
            app_data.path(),
            node,
            Arc::new(ManifestVerifier::new(PUBLIC_KEY)),
            signed_source(),
        );
        install_minimal(service.store(), "0.15.5");
        install_minimal(service.store(), "0.15.6");
        let good = CliPointer::new("0.15.5", DesktopTarget::MacArm64, "a".repeat(64)).unwrap();
        let bad = CliPointer::new("0.15.6", DesktopTarget::MacArm64, "b".repeat(64)).unwrap();
        service.store().activate(&good).unwrap();
        service.store().mark_current_good().unwrap();
        service.store().activate(&bad).unwrap();

        assert_eq!(
            service.validate_startup().unwrap(),
            StartupValidation::RolledBack {
                rejected: "0.15.6".to_string(),
                restored: "0.15.5".to_string(),
            }
        );
        assert!(service.store().was_rejected(&"b".repeat(64)).unwrap());
        assert_eq!(
            service.store().current().unwrap().unwrap().version,
            "0.15.5"
        );
    }

    #[test]
    fn production_source_endpoint_is_not_replaceable_outside_tests() {
        let client = build_download_client().unwrap();
        let source = GithubReleaseSource::with_endpoint(client, "https://example.invalid/latest");
        assert_eq!(source.latest_release_api, "https://example.invalid/latest");
    }
}
