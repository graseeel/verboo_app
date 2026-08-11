use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(unix)]
use tar::Archive;
#[cfg(unix)]
use xz2::read::XzDecoder;

use super::contract::{NodeArtifact, NodeRuntimeContract};
use crate::services::cli_update::contract::DesktopTarget;

const RECEIPT_SCHEMA_VERSION: u32 = 1;
const MAX_EXTRACTED_FILE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeRuntimeReceipt {
    pub schema_version: u32,
    pub version: String,
    pub target: DesktopTarget,
    pub archive_sha256: String,
    pub executable_sha256: String,
    pub modules: String,
    pub napi: String,
}

pub fn extract_declared(
    artifact: &NodeArtifact,
    archive_path: &Path,
    destination: &Path,
) -> Result<(), String> {
    let mut created = Vec::with_capacity(2);
    let result = extract_declared_inner(artifact, archive_path, destination, &mut created);
    if result.is_err() {
        for path in created {
            let _ = fs::remove_file(path);
        }
    }
    result
}

#[cfg(unix)]
fn extract_declared_inner(
    artifact: &NodeArtifact,
    archive_path: &Path,
    destination: &Path,
    created: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if artifact.target == DesktopTarget::WindowsX64 {
        return Err("managed Node archive target does not match this platform".to_string());
    }
    let file = File::open(archive_path)
        .map_err(|error| format!("failed to open managed Node archive: {error}"))?;
    let decoder = XzDecoder::new(file);
    let mut archive = Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("invalid managed Node tar.xz archive: {error}"))?;
    let mut executable_found = false;
    let mut license_found = false;

    for entry in entries {
        let mut entry =
            entry.map_err(|error| format!("invalid managed Node tar entry: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("invalid managed Node archive path: {error}"))?;
        let path = safe_archive_path(&path)?;
        let is_executable = path == artifact.entry;
        let is_license = path == artifact.license;
        let entry_type = entry.header().entry_type();

        if !entry_type.is_file() && !entry_type.is_dir() {
            return Err(format!(
                "managed Node archive contains unsupported entry type at {path}"
            ));
        }
        if !is_executable && !is_license {
            continue;
        }
        if !entry_type.is_file() {
            return Err(format!(
                "managed Node declared file has the wrong entry type at {path}"
            ));
        }

        let already_found = if is_executable {
            &mut executable_found
        } else {
            &mut license_found
        };
        if *already_found {
            return Err(format!(
                "managed Node archive repeats declared entry {path}"
            ));
        }
        *already_found = true;

        let declared_size = entry
            .header()
            .size()
            .map_err(|error| format!("invalid managed Node entry size: {error}"))?;
        let output = if is_executable {
            destination.join(executable_name(artifact.target))
        } else {
            destination.join("LICENSE")
        };
        write_declared_file(&mut entry, declared_size, &output, is_executable)?;
        created.push(output);
    }

    require_declared_entries(executable_found, license_found)
}

#[cfg(windows)]
fn extract_declared_inner(
    artifact: &NodeArtifact,
    archive_path: &Path,
    destination: &Path,
    created: &mut Vec<PathBuf>,
) -> Result<(), String> {
    use zip::ZipArchive;

    if artifact.target != DesktopTarget::WindowsX64 {
        return Err("managed Node archive target does not match this platform".to_string());
    }
    let file = File::open(archive_path)
        .map_err(|error| format!("failed to open managed Node archive: {error}"))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| format!("invalid managed Node ZIP archive: {error}"))?;
    let mut executable_found = false;
    let mut license_found = false;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("invalid managed Node ZIP entry: {error}"))?;
        let path = safe_archive_path(Path::new(entry.name()))?;
        let is_executable = path == artifact.entry;
        let is_license = path == artifact.license;
        let mode_type = entry.unix_mode().map(|mode| mode & 0o170000).unwrap_or(0);
        let regular_or_unspecified = mode_type == 0 || mode_type == 0o100000;
        let directory_or_unspecified = mode_type == 0 || mode_type == 0o040000;
        if (entry.is_dir() && !directory_or_unspecified)
            || (!entry.is_dir() && !regular_or_unspecified)
        {
            return Err(format!(
                "managed Node archive contains unsupported entry type at {path}"
            ));
        }
        if !is_executable && !is_license {
            continue;
        }
        if entry.is_dir() || !regular_or_unspecified {
            return Err(format!(
                "managed Node declared file has the wrong entry type at {path}"
            ));
        }

        let already_found = if is_executable {
            &mut executable_found
        } else {
            &mut license_found
        };
        if *already_found {
            return Err(format!(
                "managed Node archive repeats declared entry {path}"
            ));
        }
        *already_found = true;

        let output = if is_executable {
            destination.join(executable_name(artifact.target))
        } else {
            destination.join("LICENSE")
        };
        let declared_size = entry.size();
        write_declared_file(&mut entry, declared_size, &output, is_executable)?;
        created.push(output);
    }

    require_declared_entries(executable_found, license_found)
}

fn write_declared_file(
    reader: &mut impl Read,
    declared_size: u64,
    output: &Path,
    executable: bool,
) -> Result<(), String> {
    if declared_size > MAX_EXTRACTED_FILE_BYTES {
        return Err("managed Node declared file exceeds the extraction limit".to_string());
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(output)
        .map_err(|error| format!("failed to create managed Node declared file: {error}"))?;
    let result = (|| {
        let copied = std::io::copy(&mut reader.take(declared_size + 1), &mut file)
            .map_err(|error| format!("failed to extract managed Node declared file: {error}"))?;
        if copied != declared_size {
            return Err("managed Node declared file size mismatch".to_string());
        }
        file.flush()
            .map_err(|error| format!("failed to flush managed Node declared file: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("failed to sync managed Node declared file: {error}"))?;
        apply_runtime_permissions(&file, executable)
    })();
    if result.is_err() {
        drop(file);
        let _ = fs::remove_file(output);
    }
    result
}

fn require_declared_entries(executable: bool, license: bool) -> Result<(), String> {
    if !executable || !license {
        return Err("managed Node archive lacks a declared runtime file".to_string());
    }
    Ok(())
}

fn safe_archive_path(path: &Path) -> Result<String, String> {
    let text = path
        .to_str()
        .ok_or_else(|| "managed Node archive path is not UTF-8".to_string())?;
    let bytes = text.as_bytes();
    if text.is_empty()
        || text.starts_with('/')
        || text.contains('\\')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("unsafe managed Node archive path: {text}"));
    }
    Ok(text.to_string())
}

#[cfg(unix)]
fn apply_runtime_permissions(file: &File, executable: bool) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let mode = if executable { 0o755 } else { 0o644 };
    file.set_permissions(fs::Permissions::from_mode(mode))
        .map_err(|error| format!("failed to set managed Node permissions: {error}"))
}

#[cfg(windows)]
fn apply_runtime_permissions(_file: &File, _executable: bool) -> Result<(), String> {
    Ok(())
}

pub fn create_receipt(
    contract: &NodeRuntimeContract,
    target: DesktopTarget,
    root: &Path,
    timeout: Duration,
) -> Result<NodeRuntimeReceipt, String> {
    let executable = validate_runtime_files(root, target)?;
    smoke_runtime(contract, &executable, timeout)?;
    let artifact = contract.artifact(target)?;
    Ok(NodeRuntimeReceipt {
        schema_version: RECEIPT_SCHEMA_VERSION,
        version: contract.version().to_string(),
        target,
        archive_sha256: artifact.sha256.clone(),
        executable_sha256: hash_file(&executable)?,
        modules: contract.modules().to_string(),
        napi: contract.napi().to_string(),
    })
}

pub fn write_receipt(root: &Path, receipt: &NodeRuntimeReceipt) -> Result<(), String> {
    let path = root.join("receipt.json");
    let mut bytes = serde_json::to_vec_pretty(receipt)
        .map_err(|error| format!("failed to serialize managed Node receipt: {error}"))?;
    bytes.push(b'\n');
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .map_err(|error| format!("failed to create managed Node receipt: {error}"))?;
    let result = (|| {
        file.write_all(&bytes)
            .map_err(|error| format!("failed to write managed Node receipt: {error}"))?;
        file.flush()
            .map_err(|error| format!("failed to flush managed Node receipt: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("failed to sync managed Node receipt: {error}"))
    })();
    if result.is_err() {
        drop(file);
        let _ = fs::remove_file(path);
    }
    result
}

pub fn validate_installed_runtime(
    contract: &NodeRuntimeContract,
    target: DesktopTarget,
    root: &Path,
    timeout: Duration,
) -> Result<PathBuf, String> {
    let executable = validate_runtime_files(root, target)?;
    let receipt_path = root.join("receipt.json");
    let receipt_metadata = fs::symlink_metadata(&receipt_path)
        .map_err(|error| format!("managed Node receipt is unavailable: {error}"))?;
    if !receipt_metadata.file_type().is_file() {
        return Err("managed Node receipt is not a regular file".to_string());
    }
    let receipt: NodeRuntimeReceipt = serde_json::from_slice(
        &fs::read(&receipt_path)
            .map_err(|error| format!("failed to read managed Node receipt: {error}"))?,
    )
    .map_err(|error| format!("invalid managed Node receipt: {error}"))?;
    let artifact = contract.artifact(target)?;
    if receipt.schema_version != RECEIPT_SCHEMA_VERSION
        || receipt.version != contract.version()
        || receipt.target != target
        || receipt.archive_sha256 != artifact.sha256
        || receipt.modules != contract.modules()
        || receipt.napi != contract.napi()
        || receipt.executable_sha256 != hash_file(&executable)?
    {
        return Err("managed Node receipt does not match the app contract".to_string());
    }
    smoke_runtime(contract, &executable, timeout)?;
    Ok(executable)
}

fn validate_runtime_files(root: &Path, target: DesktopTarget) -> Result<PathBuf, String> {
    let executable = root.join(executable_name(target));
    let metadata = fs::symlink_metadata(&executable)
        .map_err(|error| format!("managed Node executable is unavailable: {error}"))?;
    if !metadata.file_type().is_file() {
        return Err("managed Node executable is not a regular file".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err("managed Node executable is not executable".to_string());
        }
    }

    let license = fs::symlink_metadata(root.join("LICENSE"))
        .map_err(|error| format!("managed Node license is unavailable: {error}"))?;
    if !license.file_type().is_file() {
        return Err("managed Node license is not a regular file".to_string());
    }
    Ok(executable)
}

fn smoke_runtime(
    contract: &NodeRuntimeContract,
    executable: &Path,
    timeout: Duration,
) -> Result<(), String> {
    let expression = "JSON.stringify({node:process.versions.node,modules:process.versions.modules,napi:process.versions.napi})";
    let mut command = Command::new(executable);
    command
        .args(["-p", expression])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::services::cli_spawn::apply_creation_flags(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start managed Node smoke check: {error}"))?;
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    loop {
        match child.try_wait().map_err(|error| {
            format!("failed while waiting for managed Node smoke check: {error}")
        })? {
            Some(_) => break,
            None if Instant::now() >= deadline => {
                timed_out = true;
                let _ = child.kill();
                break;
            }
            None => thread::sleep(Duration::from_millis(10)),
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("failed to collect managed Node smoke output: {error}"))?;
    if timed_out {
        return Err("managed Node smoke check timed out".to_string());
    }
    if !output.status.success() {
        return Err(format!(
            "managed Node smoke check failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let actual = String::from_utf8(output.stdout)
        .map_err(|_| "managed Node smoke output is not UTF-8".to_string())?;
    let expected = format!(
        "{{\"node\":\"{}\",\"modules\":\"{}\",\"napi\":\"{}\"}}",
        contract.version(),
        contract.modules(),
        contract.napi()
    );
    if actual.trim() != expected {
        return Err(format!(
            "managed Node runtime contract mismatch: expected {expected:?}, got {:?}",
            actual.trim()
        ));
    }
    Ok(())
}

pub(crate) fn validate_runtime_executable(
    contract: &NodeRuntimeContract,
    executable: &Path,
    timeout: Duration,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(executable)
        .map_err(|error| format!("managed Node executable is unavailable: {error}"))?;
    if !metadata.file_type().is_file() {
        return Err("managed Node executable is not a regular file".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err("managed Node executable is not executable".to_string());
        }
    }
    smoke_runtime(contract, executable, timeout)
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("failed to open managed Node executable: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("failed to hash managed Node executable: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn executable_name(target: DesktopTarget) -> &'static str {
    if target == DesktopTarget::WindowsX64 {
        "node.exe"
    } else {
        "node"
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Cursor;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    #[cfg(unix)]
    use tar::{Builder, EntryType, Header};
    #[cfg(unix)]
    use xz2::write::XzEncoder;

    use super::{create_receipt, extract_declared, validate_installed_runtime, write_receipt};
    use crate::services::cli_update::contract::DesktopTarget;
    use crate::services::node_runtime::contract::{NodeArtifact, NodeRuntimeContract};

    #[cfg(unix)]
    struct ArchiveFixture {
        _directory: tempfile::TempDir,
        artifact: NodeArtifact,
        archive: PathBuf,
    }

    #[cfg(unix)]
    fn append_entry(
        builder: &mut Builder<XzEncoder<Vec<u8>>>,
        path: &str,
        bytes: &[u8],
        entry_type: EntryType,
    ) {
        let mut header = Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o755);
        header.set_entry_type(entry_type);
        let name = path.as_bytes();
        assert!(name.len() < 100);
        header.as_mut_bytes()[..name.len()].copy_from_slice(name);
        header.set_cksum();
        builder.append(&header, Cursor::new(bytes)).unwrap();
    }

    #[cfg(unix)]
    fn archive_fixture(entries: &[(&str, &[u8], EntryType)]) -> ArchiveFixture {
        let directory = tempfile::tempdir().unwrap();
        let archive = directory.path().join("fixture.tar.xz");
        let encoder = XzEncoder::new(Vec::new(), 6);
        let mut builder = Builder::new(encoder);
        for (path, bytes, entry_type) in entries {
            append_entry(&mut builder, path, bytes, *entry_type);
        }
        let bytes = builder.into_inner().unwrap().finish().unwrap();
        fs::write(&archive, bytes).unwrap();
        ArchiveFixture {
            _directory: directory,
            artifact: NodeArtifact {
                target: DesktopTarget::MacArm64,
                url: "https://nodejs.org/dist/v24.19.0/node-fixture.tar.xz".to_string(),
                archive: "node-fixture.tar.xz".to_string(),
                size: fs::metadata(&archive).unwrap().len(),
                sha256: "0".repeat(64),
                entry: "node-v24.19.0-fixture/bin/node".to_string(),
                license: "node-v24.19.0-fixture/LICENSE".to_string(),
            },
            archive,
        }
    }

    #[cfg(unix)]
    #[test]
    fn extracts_only_declared_executable_and_license() {
        let fixture = archive_fixture(&[
            (
                "node-v24.19.0-fixture/bin/node",
                b"node",
                EntryType::Regular,
            ),
            (
                "node-v24.19.0-fixture/LICENSE",
                b"license",
                EntryType::Regular,
            ),
            (
                "node-v24.19.0-fixture/unexpected.txt",
                b"ignore",
                EntryType::Regular,
            ),
        ]);
        let root = tempfile::tempdir().unwrap();
        extract_declared(&fixture.artifact, &fixture.archive, root.path()).unwrap();
        assert_eq!(fs::read(root.path().join("node")).unwrap(), b"node");
        assert_eq!(fs::read(root.path().join("LICENSE")).unwrap(), b"license");
        assert!(!root.path().join("unexpected.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn extraction_never_removes_a_preexisting_destination_file() {
        let fixture = archive_fixture(&[
            (
                "node-v24.19.0-fixture/bin/node",
                b"replacement",
                EntryType::Regular,
            ),
            (
                "node-v24.19.0-fixture/LICENSE",
                b"license",
                EntryType::Regular,
            ),
        ]);
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("node"), b"keep").unwrap();
        assert!(extract_declared(&fixture.artifact, &fixture.archive, root.path()).is_err());
        assert_eq!(fs::read(root.path().join("node")).unwrap(), b"keep");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_links_traversal_duplicates_and_wrong_entry_types() {
        let executable = "node-v24.19.0-fixture/bin/node";
        let license = "node-v24.19.0-fixture/LICENSE";
        let fixtures = [
            archive_fixture(&[
                ("../escape", b"owned", EntryType::Regular),
                (executable, b"node", EntryType::Regular),
                (license, b"license", EntryType::Regular),
            ]),
            archive_fixture(&[
                (executable, b"one", EntryType::Regular),
                (executable, b"two", EntryType::Regular),
                (license, b"license", EntryType::Regular),
            ]),
            archive_fixture(&[
                ("node-v24.19.0-fixture/link", b"", EntryType::Symlink),
                (executable, b"node", EntryType::Regular),
                (license, b"license", EntryType::Regular),
            ]),
            archive_fixture(&[
                (executable, b"", EntryType::Directory),
                (license, b"license", EntryType::Regular),
            ]),
        ];

        for fixture in fixtures {
            let root = tempfile::tempdir().unwrap();
            assert!(extract_declared(&fixture.artifact, &fixture.archive, root.path()).is_err());
            assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        }
    }

    #[cfg(unix)]
    fn executable_fixture() -> (tempfile::TempDir, NodeRuntimeContract, DesktopTarget) {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("node");
        fs::write(
            &executable,
            b"#!/bin/sh\nprintf '{\"node\":\"24.19.0\",\"modules\":\"137\",\"napi\":\"10\"}\\n'\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(directory.path().join("LICENSE"), b"fixture license").unwrap();
        (
            directory,
            NodeRuntimeContract::embedded().unwrap(),
            DesktopTarget::host().unwrap(),
        )
    }

    #[cfg(unix)]
    #[test]
    fn receipt_must_match_contract_hash_and_runtime_smoke() {
        let (directory, contract, target) = executable_fixture();
        let receipt =
            create_receipt(&contract, target, directory.path(), Duration::from_secs(1)).unwrap();
        write_receipt(directory.path(), &receipt).unwrap();
        assert_eq!(
            validate_installed_runtime(&contract, target, directory.path(), Duration::from_secs(1))
                .unwrap(),
            directory.path().join("node")
        );

        let path = directory.path().join("receipt.json");
        let changed = fs::read_to_string(&path).unwrap().replace("137", "999");
        fs::write(path, changed).unwrap();
        assert!(validate_installed_runtime(
            &contract,
            target,
            directory.path(),
            Duration::from_secs(1)
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn runtime_smoke_rejects_wrong_abi_and_enforces_timeout() {
        use std::os::unix::fs::PermissionsExt;

        let (directory, contract, target) = executable_fixture();
        let executable = directory.path().join("node");
        fs::write(
            &executable,
            b"#!/bin/sh\nprintf '{\"node\":\"24.19.0\",\"modules\":\"999\",\"napi\":\"10\"}\\n'\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            create_receipt(&contract, target, directory.path(), Duration::from_secs(1)).is_err()
        );

        fs::write(&executable, b"#!/bin/sh\nsleep 2\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(create_receipt(
            &contract,
            target,
            directory.path(),
            Duration::from_millis(20)
        )
        .unwrap_err()
        .contains("timed out"));
    }

    #[test]
    fn unsafe_archive_paths_are_rejected_before_joining() {
        for path in ["../escape", "/absolute", "C:/drive", "dir\\windows"] {
            assert!(super::safe_archive_path(Path::new(path)).is_err());
        }
    }
}
