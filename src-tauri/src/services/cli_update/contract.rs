use std::collections::HashSet;
use std::fmt;

use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    DESKTOP_PROTOCOL, EMBEDDED_NODE_MODULES, EMBEDDED_NODE_NAPI, EMBEDDED_NODE_VERSION,
    MAX_ARCHIVE_BYTES,
};

const OFFICIAL_RELEASE_PREFIX: &str = "https://github.com/verbeux-ai/code/releases/download/";
const SUPPORTED_NODE_RANGE: &str = ">=24.0.0 <25.0.0";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
pub enum DesktopTarget {
    #[serde(rename = "aarch64-apple-darwin")]
    MacArm64,
    #[serde(rename = "x86_64-apple-darwin")]
    MacX64,
    #[serde(rename = "x86_64-pc-windows-msvc")]
    WindowsX64,
    #[serde(rename = "x86_64-unknown-linux-gnu")]
    LinuxX64,
}

impl DesktopTarget {
    pub const ALL: [Self; 4] = [
        Self::MacArm64,
        Self::MacX64,
        Self::WindowsX64,
        Self::LinuxX64,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::MacArm64 => "aarch64-apple-darwin",
            Self::MacX64 => "x86_64-apple-darwin",
            Self::WindowsX64 => "x86_64-pc-windows-msvc",
            Self::LinuxX64 => "x86_64-unknown-linux-gnu",
        }
    }

    pub const fn host() -> Option<Self> {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        return Some(Self::MacArm64);
        #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
        return Some(Self::MacX64);
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        return Some(Self::WindowsX64);
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        return Some(Self::LinuxX64);
        #[allow(unreachable_code)]
        None
    }
}

impl fmt::Display for DesktopTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopVersionCompatibility {
    pub min: String,
    pub max_exclusive: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeCompatibility {
    pub range: String,
    pub modules: String,
    pub napi: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliArtifact {
    pub target: DesktopTarget,
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub archive: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliManifest {
    pub schema_version: u32,
    pub cli_version: String,
    pub released_at: String,
    pub desktop_protocol: u32,
    pub desktop_version: DesktopVersionCompatibility,
    pub node: NodeCompatibility,
    pub signing_key_id: String,
    pub artifacts: Vec<CliArtifact>,
}

#[derive(Debug, Clone)]
pub struct VerifiedManifest {
    pub manifest: CliManifest,
    pub digest: String,
}

#[derive(Debug, Clone)]
pub struct RuntimeCompatibility<'a> {
    pub target: DesktopTarget,
    pub app_version: &'a str,
    pub desktop_protocol: u32,
    pub node_version: &'a str,
    pub node_modules: &'a str,
    pub node_napi: &'a str,
    pub current_cli_version: Option<&'a str>,
}

impl RuntimeCompatibility<'_> {
    pub fn embedded(target: DesktopTarget, app_version: &str) -> RuntimeCompatibility<'_> {
        RuntimeCompatibility {
            target,
            app_version,
            desktop_protocol: DESKTOP_PROTOCOL,
            node_version: EMBEDDED_NODE_VERSION,
            node_modules: EMBEDDED_NODE_MODULES,
            node_napi: EMBEDDED_NODE_NAPI,
            current_cli_version: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SelectedCandidate {
    pub version: Version,
    pub artifact: CliArtifact,
    pub manifest_digest: String,
}

#[derive(Debug, Clone)]
pub struct ManifestVerifier {
    public_key_text: String,
}

impl ManifestVerifier {
    pub fn new(public_key_text: impl Into<String>) -> Self {
        Self {
            public_key_text: public_key_text.into(),
        }
    }

    pub fn verify(
        &self,
        raw_manifest: &[u8],
        signature_text: &str,
    ) -> Result<VerifiedManifest, String> {
        let public_key = PublicKey::decode(self.public_key_text.trim())
            .map_err(|error| format!("invalid CLI signing public key: {error}"))?;
        let signature = Signature::decode(signature_text.trim())
            .map_err(|error| format!("invalid CLI manifest signature: {error}"))?;

        public_key
            .verify(raw_manifest, &signature, false)
            .map_err(|error| format!("CLI manifest signature verification failed: {error}"))?;

        // Signature verification deliberately precedes JSON parsing. Nothing
        // below this line is trusted unless the exact byte sequence was signed.
        let manifest: CliManifest = serde_json::from_slice(raw_manifest)
            .map_err(|error| format!("invalid signed CLI manifest JSON: {error}"))?;
        validate_authenticated_manifest(&manifest, &self.public_key_text)?;

        Ok(VerifiedManifest {
            manifest,
            digest: hex::encode(Sha256::digest(raw_manifest)),
        })
    }
}

pub fn select_candidate(
    verified: &VerifiedManifest,
    runtime: RuntimeCompatibility<'_>,
) -> Result<SelectedCandidate, String> {
    let manifest = &verified.manifest;
    if manifest.desktop_protocol != runtime.desktop_protocol {
        return Err(format!(
            "CLI desktop protocol {} is incompatible with app protocol {}",
            manifest.desktop_protocol, runtime.desktop_protocol
        ));
    }

    let app_version = parse_version("app", runtime.app_version)?;
    let min_app = parse_version("minimum app", &manifest.desktop_version.min)?;
    let max_app = parse_version(
        "exclusive maximum app",
        &manifest.desktop_version.max_exclusive,
    )?;
    if app_version < min_app || app_version >= max_app {
        return Err(format!(
            "CLI {} is incompatible with app {}",
            manifest.cli_version, runtime.app_version
        ));
    }

    if manifest.node.range != SUPPORTED_NODE_RANGE
        || runtime.node_version != EMBEDDED_NODE_VERSION
        || manifest.node.modules != runtime.node_modules
        || manifest.node.napi != runtime.node_napi
        || runtime.node_modules != EMBEDDED_NODE_MODULES
        || runtime.node_napi != EMBEDDED_NODE_NAPI
    {
        return Err("CLI Node runtime compatibility mismatch".to_string());
    }

    let version = parse_version("CLI", &manifest.cli_version)?;
    if let Some(current) = runtime.current_cli_version {
        let current = parse_version("installed CLI", current)?;
        if version <= current {
            return Err(format!(
                "CLI {} is not newer than installed CLI {}",
                version, current
            ));
        }
    }

    let artifact = manifest
        .artifacts
        .iter()
        .find(|artifact| artifact.target == runtime.target)
        .cloned()
        .ok_or_else(|| format!("CLI release has no artifact for {}", runtime.target))?;

    Ok(SelectedCandidate {
        version,
        artifact,
        manifest_digest: verified.digest.clone(),
    })
}

fn validate_authenticated_manifest(
    manifest: &CliManifest,
    public_key_text: &str,
) -> Result<(), String> {
    if manifest.schema_version != 1 {
        return Err(format!(
            "unsupported CLI manifest schema {}",
            manifest.schema_version
        ));
    }
    let version = parse_version("CLI", &manifest.cli_version)?;
    if !version.build.as_str().is_empty() {
        return Err("CLI release version must not contain build metadata".to_string());
    }
    chrono::DateTime::parse_from_rfc3339(&manifest.released_at)
        .map_err(|error| format!("invalid CLI release timestamp: {error}"))?;
    if manifest.desktop_protocol != DESKTOP_PROTOCOL {
        return Err(format!(
            "unsupported CLI desktop protocol {}",
            manifest.desktop_protocol
        ));
    }
    parse_version("minimum app", &manifest.desktop_version.min)?;
    parse_version(
        "exclusive maximum app",
        &manifest.desktop_version.max_exclusive,
    )?;
    if manifest.node.range != SUPPORTED_NODE_RANGE
        || manifest.node.modules != EMBEDDED_NODE_MODULES
        || manifest.node.napi != EMBEDDED_NODE_NAPI
    {
        return Err("invalid CLI Node compatibility contract".to_string());
    }

    let expected_key_id = hex::encode(Sha256::digest(public_key_text.trim().as_bytes()));
    if manifest.signing_key_id != expected_key_id[..16] {
        return Err("CLI manifest signing key ID mismatch".to_string());
    }

    if manifest.artifacts.len() != DesktopTarget::ALL.len() {
        return Err("CLI manifest must contain exactly four artifacts".to_string());
    }
    let mut seen = HashSet::new();
    for artifact in &manifest.artifacts {
        if !seen.insert(artifact.target) {
            return Err(format!(
                "CLI manifest contains duplicate artifact for {}",
                artifact.target
            ));
        }
        validate_artifact(artifact, &manifest.cli_version)?;
    }
    if DesktopTarget::ALL
        .iter()
        .any(|target| !seen.contains(target))
    {
        return Err("CLI manifest is missing a supported desktop target".to_string());
    }
    Ok(())
}

fn validate_artifact(artifact: &CliArtifact, version: &str) -> Result<(), String> {
    if artifact.archive != "tar.gz" {
        return Err(format!(
            "unsupported CLI archive format for {}",
            artifact.target
        ));
    }
    if artifact.size == 0 || artifact.size > MAX_ARCHIVE_BYTES {
        return Err(format!("invalid CLI archive size for {}", artifact.target));
    }
    if artifact.sha256.len() != 64
        || !artifact
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("invalid CLI SHA-256 for {}", artifact.target));
    }

    let filename = format!("verboo-cli-{version}-{}.tar.gz", artifact.target);
    let expected = format!("{OFFICIAL_RELEASE_PREFIX}v{version}/{filename}");
    let parsed = url::Url::parse(&artifact.url)
        .map_err(|error| format!("invalid CLI release URL: {error}"))?;
    if parsed.as_str() != expected {
        return Err(format!(
            "unexpected CLI release URL for {}",
            artifact.target
        ));
    }
    Ok(())
}

fn parse_version(label: &str, value: &str) -> Result<Version, String> {
    Version::parse(value).map_err(|error| format!("invalid {label} version {value:?}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUBLIC_KEY: &str = "untrusted comment: minisign public key 8C2C9C2F56A02BEF\nRWTvK6BWL5wsjNVgnLFvSlaQ7XvT7Cs7qskFE7Dwl0ItgJKh2p9RSU+4\n";
    const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUTvK6BWL5wsjB2fb3xqCOd5aIHQ9GLUt3eoeHuwuSwQMZGkOjdPYjUMEfWGgIbP27xtzGuZZHgMPIYIOaG9ct6O4lOEd/oTowg=\ntrusted comment: timestamp:1786207558\tfile:manifest.json\thashed\nOfNzV/Vla/9D9Fbtw/iFqwQXoUUuXvEX3Lli34JGSYEwZvpfHxChd9Q3lq1LJ7E0ypZj1PZfFPsNtFAXLFZmCQ==\n";
    const MANIFEST: &str = include_str!("test-fixtures/manifest.json");

    fn verified() -> VerifiedManifest {
        ManifestVerifier::new(PUBLIC_KEY)
            .verify(MANIFEST.as_bytes(), SIGNATURE)
            .expect("fixture must verify")
    }

    #[test]
    fn verifies_signature_before_parsing_or_trusting_json() {
        let mut changed = MANIFEST.as_bytes().to_vec();
        changed[0] = b'!';
        let error = ManifestVerifier::new(PUBLIC_KEY)
            .verify(&changed, SIGNATURE)
            .unwrap_err();
        assert!(error.contains("signature verification failed"), "{error}");
        assert!(
            !error.contains("JSON"),
            "signature must fail first: {error}"
        );
    }

    #[test]
    fn rejects_a_signature_from_another_key() {
        const OTHER_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWRf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
        let error = ManifestVerifier::new(OTHER_KEY)
            .verify(MANIFEST.as_bytes(), SIGNATURE)
            .unwrap_err();
        assert!(error.contains("signature verification failed"), "{error}");
    }

    #[test]
    fn selects_only_the_exact_target_and_embedded_runtime() {
        let selected = select_candidate(
            &verified(),
            RuntimeCompatibility::embedded(DesktopTarget::MacArm64, "0.7.0-beta"),
        )
        .unwrap();
        assert_eq!(selected.version, Version::parse("0.15.6").unwrap());
        assert_eq!(selected.artifact.target, DesktopTarget::MacArm64);

        let mut wrong_abi = RuntimeCompatibility::embedded(DesktopTarget::WindowsX64, "0.7.0-beta");
        wrong_abi.node_modules = "136";
        assert!(select_candidate(&verified(), wrong_abi).is_err());
    }

    #[test]
    fn rejects_downgrades_and_equal_versions() {
        let mut runtime = RuntimeCompatibility::embedded(DesktopTarget::LinuxX64, "0.7.0-beta");
        runtime.current_cli_version = Some("0.15.6");
        assert!(select_candidate(&verified(), runtime.clone()).is_err());
        runtime.current_cli_version = Some("0.16.0");
        assert!(select_candidate(&verified(), runtime).is_err());
    }

    #[test]
    fn rejects_wrong_app_or_protocol() {
        let runtime = RuntimeCompatibility::embedded(DesktopTarget::MacX64, "0.8.0");
        assert!(select_candidate(&verified(), runtime).is_err());

        let mut runtime = RuntimeCompatibility::embedded(DesktopTarget::MacX64, "0.7.0-beta");
        runtime.desktop_protocol = 2;
        assert!(select_candidate(&verified(), runtime).is_err());
    }

    #[test]
    fn authenticated_contract_rejects_duplicate_target_and_foreign_url() {
        let mut manifest = verified().manifest;
        manifest.artifacts[1].target = manifest.artifacts[0].target;
        assert!(validate_authenticated_manifest(&manifest, PUBLIC_KEY)
            .unwrap_err()
            .contains("duplicate"));

        let mut manifest = verified().manifest;
        manifest.artifacts[0].url = manifest.artifacts[0]
            .url
            .replace("verbeux-ai/code", "attacker/code");
        assert!(validate_authenticated_manifest(&manifest, PUBLIC_KEY)
            .unwrap_err()
            .contains("unexpected CLI release URL"));
    }
}
