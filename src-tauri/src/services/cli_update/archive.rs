use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use flate2::read::GzDecoder;
use serde::Deserialize;
use tar::Archive;

use super::contract::DesktopTarget;

#[derive(Debug, Clone, Copy)]
pub struct ExtractionLimits {
    pub max_entries: u64,
    pub max_total_bytes: u64,
}

impl Default for ExtractionLimits {
    fn default() -> Self {
        Self {
            max_entries: 100_000,
            max_total_bytes: 2 * 1024 * 1024 * 1024,
        }
    }
}

pub fn extract_verified_archive<R: Read>(
    reader: R,
    destination: &Path,
    limits: ExtractionLimits,
) -> Result<(), String> {
    if destination.exists() {
        return Err("CLI extraction destination already exists".to_string());
    }
    fs::create_dir_all(destination)
        .map_err(|error| format!("failed to create CLI extraction directory: {error}"))?;

    let result = extract_into(reader, destination, limits);
    if result.is_err() {
        let _ = fs::remove_dir_all(destination);
    }
    result
}

fn extract_into<R: Read>(
    reader: R,
    destination: &Path,
    limits: ExtractionLimits,
) -> Result<(), String> {
    let decoder = GzDecoder::new(reader);
    let mut archive = Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("invalid CLI tar.gz archive: {error}"))?;
    let mut entry_count = 0_u64;
    let mut total_bytes = 0_u64;

    for entry in entries {
        let mut entry = entry.map_err(|error| format!("invalid CLI tar entry: {error}"))?;
        entry_count += 1;
        if entry_count > limits.max_entries {
            return Err(format!(
                "CLI archive exceeds entry limit {}",
                limits.max_entries
            ));
        }

        let relative = safe_relative_path(
            &entry
                .path()
                .map_err(|error| format!("invalid CLI archive path encoding: {error}"))?,
        )?;
        let output = destination.join(&relative);
        let entry_type = entry.header().entry_type();
        if entry_type.is_dir() {
            fs::create_dir_all(&output)
                .map_err(|error| format!("failed to create CLI directory: {error}"))?;
            continue;
        }
        if !entry_type.is_file() {
            return Err(format!(
                "CLI archive contains unsupported entry type at {}",
                relative.display()
            ));
        }

        let declared_size = entry
            .header()
            .size()
            .map_err(|error| format!("invalid CLI archive entry size: {error}"))?;
        total_bytes = total_bytes
            .checked_add(declared_size)
            .ok_or_else(|| "CLI archive extracted size overflow".to_string())?;
        if total_bytes > limits.max_total_bytes {
            return Err(format!(
                "CLI archive exceeds extracted size limit {}",
                limits.max_total_bytes
            ));
        }

        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create CLI archive parent: {error}"))?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(|error| {
                format!(
                    "failed to create extracted CLI file {}: {error}",
                    relative.display()
                )
            })?;
        let copied = std::io::copy(&mut entry, &mut file)
            .map_err(|error| format!("failed to extract CLI file: {error}"))?;
        if copied != declared_size {
            return Err(format!(
                "CLI archive entry size mismatch at {}",
                relative.display()
            ));
        }
        file.flush()
            .map_err(|error| format!("failed to flush extracted CLI file: {error}"))?;
        apply_safe_mode(&file, entry.header().mode().unwrap_or(0o644))?;
    }
    Ok(())
}

fn safe_relative_path(path: &Path) -> Result<PathBuf, String> {
    let text = path
        .to_str()
        .ok_or_else(|| "CLI archive path is not UTF-8".to_string())?;
    let bytes = text.as_bytes();
    if text.is_empty()
        || text.starts_with('/')
        || text.contains('\\')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
    {
        return Err(format!("unsafe CLI archive path: {text}"));
    }
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("unsafe CLI archive path: {text}"));
    }
    Ok(path.to_path_buf())
}

#[cfg(unix)]
fn apply_safe_mode(file: &fs::File, archive_mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(archive_mode & 0o777))
        .map_err(|error| format!("failed to set extracted CLI permissions: {error}"))
}

#[cfg(not(unix))]
fn apply_safe_mode(_file: &fs::File, _archive_mode: u32) -> Result<(), String> {
    Ok(())
}

#[derive(Debug, Deserialize)]
struct PayloadPackage {
    name: String,
    version: String,
    #[serde(rename = "verbooDesktop")]
    verboo_desktop: PayloadDesktopMetadata,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PayloadDesktopMetadata {
    schema_version: u32,
    target: DesktopTarget,
}

pub fn validate_payload(
    root: &Path,
    expected_version: &str,
    expected_target: DesktopTarget,
) -> Result<PathBuf, String> {
    let package_path = root.join("package.json");
    let package_metadata = fs::symlink_metadata(&package_path)
        .map_err(|error| format!("CLI payload lacks package.json: {error}"))?;
    if !package_metadata.file_type().is_file() {
        return Err("CLI package.json is not a regular file".to_string());
    }
    let package: PayloadPackage = serde_json::from_slice(
        &fs::read(&package_path)
            .map_err(|error| format!("failed to read CLI package.json: {error}"))?,
    )
    .map_err(|error| format!("invalid CLI package.json: {error}"))?;
    if package.name != "@verboo/code"
        || package.version != expected_version
        || package.verboo_desktop.schema_version != 1
        || package.verboo_desktop.target != expected_target
    {
        return Err("CLI payload package metadata mismatch".to_string());
    }

    let cli_mjs = root.join("dist").join("cli.mjs");
    if !fs::symlink_metadata(&cli_mjs)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
    {
        return Err("CLI payload lacks regular dist/cli.mjs".to_string());
    }
    if !root.join("node_modules").is_dir() {
        return Err("CLI payload lacks node_modules".to_string());
    }
    for forbidden in ["node", "node.exe", "npm", "npm.cmd", "npx", "npx.cmd"] {
        if root.join(forbidden).exists() {
            return Err(format!("CLI payload must not bundle {forbidden}"));
        }
    }
    Ok(cli_mjs)
}

pub fn smoke_payload(
    node_executable: &Path,
    root: &Path,
    expected_version: &str,
    timeout: Duration,
) -> Result<(), String> {
    let cli_mjs = root.join("dist").join("cli.mjs");
    let mut command = Command::new(node_executable);
    command
        .arg(&cli_mjs)
        .arg("--version")
        .current_dir(root)
        .env("DISABLE_AUTOUPDATER", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::services::cli_spawn::apply_creation_flags(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start CLI smoke check: {error}"))?;
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    loop {
        match child
            .try_wait()
            .map_err(|error| format!("failed while waiting for CLI smoke check: {error}"))?
        {
            Some(_) => break,
            None if Instant::now() >= deadline => {
                timed_out = true;
                let _ = child.kill();
                break;
            }
            None => thread::sleep(Duration::from_millis(20)),
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("failed to collect CLI smoke output: {error}"))?;
    if timed_out {
        return Err("CLI smoke check timed out".to_string());
    }
    if !output.status.success() {
        return Err(format!(
            "CLI smoke check failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let actual = String::from_utf8(output.stdout)
        .map_err(|_| "CLI smoke output is not UTF-8".to_string())?;
    let expected = format!("{expected_version} (Verboo Code)");
    if actual.trim() != expected {
        return Err(format!(
            "CLI smoke version mismatch: expected {expected:?}, got {:?}",
            actual.trim()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use flate2::write::GzEncoder;
    use flate2::Compression;
    use tar::{Builder, EntryType, Header};

    use super::*;

    fn tar_gz(entries: &[(&str, &[u8], EntryType)]) -> Vec<u8> {
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut builder = Builder::new(encoder);
        for (path, bytes, entry_type) in entries {
            let mut header = Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_entry_type(*entry_type);
            let name = path.as_bytes();
            assert!(name.len() < 100);
            header.as_mut_bytes()[..name.len()].copy_from_slice(name);
            header.set_cksum();
            builder.append(&header, Cursor::new(*bytes)).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn extract(
        entries: &[(&str, &[u8], EntryType)],
    ) -> (tempfile::TempDir, PathBuf, Result<(), String>) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("payload");
        let result = extract_verified_archive(
            Cursor::new(tar_gz(entries)),
            &root,
            ExtractionLimits::default(),
        );
        (directory, root, result)
    }

    #[test]
    fn extracts_regular_relative_files_only() {
        let (_directory, root, result) = extract(&[
            ("package.json", b"{}", EntryType::Regular),
            ("dist/cli.mjs", b"entry", EntryType::Regular),
        ]);
        result.unwrap();
        assert_eq!(fs::read(root.join("dist/cli.mjs")).unwrap(), b"entry");
    }

    #[test]
    fn rejects_parent_absolute_windows_and_backslash_paths_without_escape() {
        for path in ["../escaped", "/absolute", "C:/drive", "dir\\windows"] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().join("payload");
            let outside = directory.path().join("escaped");
            let result = extract_verified_archive(
                Cursor::new(tar_gz(&[(path, b"owned", EntryType::Regular)])),
                &root,
                ExtractionLimits::default(),
            );
            assert!(result.is_err(), "path {path:?} must be rejected");
            assert!(!root.exists(), "failed staging must be removed");
            assert!(!outside.exists(), "path {path:?} escaped the staging root");
        }
    }

    #[test]
    fn rejects_links_devices_and_entry_or_byte_limit_overflow() {
        for entry_type in [EntryType::Symlink, EntryType::Link, EntryType::Fifo] {
            let (_directory, root, result) = extract(&[("bad", b"", entry_type)]);
            assert!(result.is_err());
            assert!(!root.exists());
        }

        let bytes = tar_gz(&[
            ("one", b"1", EntryType::Regular),
            ("two", b"2", EntryType::Regular),
        ]);
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("payload");
        assert!(extract_verified_archive(
            Cursor::new(bytes),
            &root,
            ExtractionLimits {
                max_entries: 1,
                max_total_bytes: 2,
            },
        )
        .is_err());

        let bytes = tar_gz(&[("large", b"123", EntryType::Regular)]);
        assert!(extract_verified_archive(
            Cursor::new(bytes),
            &root,
            ExtractionLimits {
                max_entries: 2,
                max_total_bytes: 2,
            },
        )
        .is_err());
    }

    #[test]
    fn validates_exact_payload_metadata_and_runtime_exclusion() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::create_dir_all(root.join("node_modules/dependency")).unwrap();
        fs::write(root.join("dist/cli.mjs"), b"entry").unwrap();
        fs::write(
            root.join("package.json"),
            br#"{"name":"@verboo/code","version":"0.15.6","verbooDesktop":{"schemaVersion":1,"target":"aarch64-apple-darwin"}}"#,
        )
        .unwrap();
        assert_eq!(
            validate_payload(root, "0.15.6", DesktopTarget::MacArm64).unwrap(),
            root.join("dist/cli.mjs")
        );
        assert!(validate_payload(root, "0.15.7", DesktopTarget::MacArm64).is_err());
        fs::write(root.join("node"), b"forbidden").unwrap();
        assert!(validate_payload(root, "0.15.6", DesktopTarget::MacArm64)
            .unwrap_err()
            .contains("must not bundle"));
    }

    #[cfg(unix)]
    #[test]
    fn smoke_requires_exact_version_and_enforces_timeout() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("payload");
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(root.join("dist/cli.mjs"), b"ignored").unwrap();

        let runner = directory.path().join("runner");
        fs::write(&runner, b"#!/bin/sh\nprintf '0.15.6 (Verboo Code)\\n'\n").unwrap();
        fs::set_permissions(&runner, fs::Permissions::from_mode(0o755)).unwrap();
        smoke_payload(&runner, &root, "0.15.6", Duration::from_secs(1)).unwrap();
        assert!(smoke_payload(&runner, &root, "0.15.7", Duration::from_secs(1)).is_err());

        fs::write(&runner, b"#!/bin/sh\nsleep 2\n").unwrap();
        assert!(
            smoke_payload(&runner, &root, "0.15.6", Duration::from_millis(20))
                .unwrap_err()
                .contains("timed out")
        );
    }
}
