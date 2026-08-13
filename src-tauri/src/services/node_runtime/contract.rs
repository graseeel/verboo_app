use std::collections::HashMap;

use serde::Deserialize;
use url::Url;

use crate::services::cli_update::contract::DesktopTarget;
use crate::services::cli_update::{PINNED_NODE_MODULES, PINNED_NODE_NAPI, PINNED_NODE_VERSION};

pub const EMBEDDED_CONTRACT: &str = include_str!("../../../../scripts/tauri/node-runtime.json");

const OFFICIAL_NODE_ROOT: &str = "https://nodejs.org/dist/v24.19.0/";
const MAX_RUNTIME_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NodeRuntimeManifest {
    version: String,
    modules: String,
    napi: String,
    base_url: String,
    targets: HashMap<DesktopTarget, NodeArtifactDefinition>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NodeArtifactDefinition {
    archive: String,
    size: u64,
    sha256: String,
    entry: String,
    license: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeArtifact {
    pub target: DesktopTarget,
    pub url: String,
    pub archive: String,
    pub size: u64,
    pub sha256: String,
    pub entry: String,
    pub license: String,
}

#[derive(Debug, Clone)]
pub struct NodeRuntimeContract {
    version: String,
    modules: String,
    napi: String,
    artifacts: HashMap<DesktopTarget, NodeArtifact>,
}

impl NodeRuntimeContract {
    pub fn embedded() -> Result<Self, String> {
        Self::from_slice(EMBEDDED_CONTRACT.as_bytes())
    }

    pub fn from_slice(bytes: &[u8]) -> Result<Self, String> {
        let manifest: NodeRuntimeManifest = serde_json::from_slice(bytes)
            .map_err(|error| format!("invalid managed Node contract JSON: {error}"))?;
        validate_runtime_identity(&manifest)?;

        let base_url = Url::parse(&manifest.base_url)
            .map_err(|error| format!("invalid managed Node base URL: {error}"))?;
        let mut artifacts = HashMap::with_capacity(DesktopTarget::ALL.len());
        for target in DesktopTarget::ALL {
            let definition = manifest
                .targets
                .get(&target)
                .ok_or_else(|| format!("managed Node contract is missing target {target}"))?;
            validate_definition(target, definition)?;
            let url = base_url
                .join(&definition.archive)
                .map_err(|error| format!("invalid managed Node artifact URL: {error}"))?;
            if url.as_str() != format!("{OFFICIAL_NODE_ROOT}{}", definition.archive) {
                return Err(format!(
                    "managed Node artifact for {target} escapes the official release root"
                ));
            }
            artifacts.insert(
                target,
                NodeArtifact {
                    target,
                    url: url.to_string(),
                    archive: definition.archive.clone(),
                    size: definition.size,
                    sha256: definition.sha256.clone(),
                    entry: definition.entry.clone(),
                    license: definition.license.clone(),
                },
            );
        }

        Ok(Self {
            version: manifest.version,
            modules: manifest.modules,
            napi: manifest.napi,
            artifacts,
        })
    }

    pub fn version(&self) -> &str {
        &self.version
    }

    pub fn modules(&self) -> &str {
        &self.modules
    }

    pub fn napi(&self) -> &str {
        &self.napi
    }

    pub fn artifact(&self, target: DesktopTarget) -> Result<&NodeArtifact, String> {
        self.artifacts
            .get(&target)
            .ok_or_else(|| format!("managed Node contract is missing target {target}"))
    }
}

fn validate_runtime_identity(manifest: &NodeRuntimeManifest) -> Result<(), String> {
    if manifest.version != PINNED_NODE_VERSION
        || manifest.modules != PINNED_NODE_MODULES
        || manifest.napi != PINNED_NODE_NAPI
    {
        return Err("managed Node contract does not match the desktop ABI".to_string());
    }
    if manifest.base_url != OFFICIAL_NODE_ROOT {
        return Err("managed Node contract uses a non-official release root".to_string());
    }
    if manifest.targets.len() != DesktopTarget::ALL.len()
        || manifest
            .targets
            .keys()
            .any(|target| !DesktopTarget::ALL.contains(target))
    {
        return Err("managed Node contract target matrix is incomplete".to_string());
    }
    Ok(())
}

fn validate_definition(
    target: DesktopTarget,
    definition: &NodeArtifactDefinition,
) -> Result<(), String> {
    if definition.size == 0 || definition.size > MAX_RUNTIME_ARCHIVE_BYTES {
        return Err(format!("managed Node archive size is invalid for {target}"));
    }
    if definition.sha256.len() != 64
        || !definition
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("managed Node SHA-256 is invalid for {target}"));
    }

    let expected_archive = expected_archive(target);
    if definition.archive != expected_archive {
        return Err(format!(
            "managed Node archive layout is invalid for {target}"
        ));
    }
    let root = expected_archive
        .strip_suffix(".tar.xz")
        .or_else(|| expected_archive.strip_suffix(".zip"))
        .expect("every supported archive has a known suffix");
    let expected_entry = if target == DesktopTarget::WindowsX64 {
        format!("{root}/node.exe")
    } else {
        format!("{root}/bin/node")
    };
    if definition.entry != expected_entry || definition.license != format!("{root}/LICENSE") {
        return Err(format!("managed Node entry layout is invalid for {target}"));
    }
    Ok(())
}

fn expected_archive(target: DesktopTarget) -> &'static str {
    match target {
        DesktopTarget::MacArm64 => "node-v24.19.0-darwin-arm64.tar.xz",
        DesktopTarget::MacX64 => "node-v24.19.0-darwin-x64.tar.xz",
        DesktopTarget::WindowsX64 => "node-v24.19.0-win-x64.zip",
        DesktopTarget::LinuxX64 => "node-v24.19.0-linux-x64.tar.xz",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiled_contract_pins_every_supported_target() {
        let contract = NodeRuntimeContract::embedded().unwrap();
        assert_eq!(contract.version(), "24.19.0");
        assert_eq!(contract.modules(), "137");
        assert_eq!(contract.napi(), "10");

        for target in DesktopTarget::ALL {
            let artifact = contract.artifact(target).unwrap();
            assert_eq!(artifact.target, target);
            assert!(artifact
                .url
                .starts_with("https://nodejs.org/dist/v24.19.0/"));
            assert!(artifact.size > 20_000_000 && artifact.size < 50_000_000);
            assert_eq!(artifact.sha256.len(), 64);
        }
    }

    #[test]
    fn rejects_non_official_urls_and_changed_abi() {
        let mut value: serde_json::Value = serde_json::from_str(EMBEDDED_CONTRACT).unwrap();
        value["baseUrl"] = "https://example.invalid/".into();
        assert!(NodeRuntimeContract::from_slice(value.to_string().as_bytes()).is_err());

        value["baseUrl"] = OFFICIAL_NODE_ROOT.into();
        value["modules"] = "999".into();
        assert!(NodeRuntimeContract::from_slice(value.to_string().as_bytes()).is_err());
    }

    #[test]
    fn rejects_missing_extra_and_mismatched_target_entries() {
        let mut value: serde_json::Value = serde_json::from_str(EMBEDDED_CONTRACT).unwrap();
        value["targets"]
            .as_object_mut()
            .unwrap()
            .remove(DesktopTarget::LinuxX64.as_str());
        assert!(NodeRuntimeContract::from_slice(value.to_string().as_bytes()).is_err());

        let mut value: serde_json::Value = serde_json::from_str(EMBEDDED_CONTRACT).unwrap();
        value["targets"][DesktopTarget::MacArm64.as_str()]["entry"] =
            "node-v24.19.0-darwin-x64/bin/node".into();
        assert!(NodeRuntimeContract::from_slice(value.to_string().as_bytes()).is_err());

        let mut value: serde_json::Value = serde_json::from_str(EMBEDDED_CONTRACT).unwrap();
        value["unexpected"] = true.into();
        assert!(NodeRuntimeContract::from_slice(value.to_string().as_bytes()).is_err());
    }
}
