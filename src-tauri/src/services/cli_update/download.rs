use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use reqwest::blocking::Client;
use sha2::{Digest, Sha256};

use super::contract::CliArtifact;
use super::MAX_ARCHIVE_BYTES;

pub fn build_download_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(10 * 60))
        .user_agent(format!("Verboo-Desktop/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("failed to create CLI download client: {error}"))
}

pub fn download_verified<F>(
    client: &Client,
    artifact: &CliArtifact,
    destination: &Path,
    progress: F,
) -> Result<(), String>
where
    F: FnMut(u64, u64),
{
    validate_declared_size(artifact.size)?;
    let response = client
        .get(&artifact.url)
        .send()
        .map_err(|error| format!("failed to download CLI archive: {error}"))?
        .error_for_status()
        .map_err(|error| format!("CLI archive server returned an error: {error}"))?;
    if let Some(content_length) = response.content_length() {
        if content_length != artifact.size {
            return Err(format!(
                "CLI archive Content-Length mismatch: expected {}, received {}",
                artifact.size, content_length
            ));
        }
    }
    write_verified_archive(response, artifact, destination, progress)
}

pub(crate) fn write_verified_archive<R, F>(
    mut reader: R,
    artifact: &CliArtifact,
    destination: &Path,
    mut progress: F,
) -> Result<(), String>
where
    R: Read,
    F: FnMut(u64, u64),
{
    validate_declared_size(artifact.size)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create CLI staging directory: {error}"))?;
    }

    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("failed to create CLI staging archive: {error}"))?;

    let result = (|| {
        let mut hasher = Sha256::new();
        let mut received = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = reader
                .read(&mut buffer)
                .map_err(|error| format!("failed while reading CLI archive: {error}"))?;
            if read == 0 {
                break;
            }
            received = received
                .checked_add(read as u64)
                .ok_or_else(|| "CLI archive size overflow".to_string())?;
            if received > artifact.size {
                return Err(format!("CLI archive exceeds signed size {}", artifact.size));
            }
            output
                .write_all(&buffer[..read])
                .map_err(|error| format!("failed to write CLI staging archive: {error}"))?;
            hasher.update(&buffer[..read]);
            progress(received, artifact.size);
        }

        if received != artifact.size {
            return Err(format!(
                "CLI archive size mismatch: expected {}, received {}",
                artifact.size, received
            ));
        }
        let actual_hash = hex::encode(hasher.finalize());
        if actual_hash != artifact.sha256 {
            return Err("CLI archive SHA-256 mismatch".to_string());
        }
        output
            .flush()
            .map_err(|error| format!("failed to flush CLI staging archive: {error}"))?;
        output
            .sync_all()
            .map_err(|error| format!("failed to sync CLI staging archive: {error}"))?;
        Ok(())
    })();

    if result.is_err() {
        drop(output);
        let _ = fs::remove_file(destination);
    }
    result
}

fn validate_declared_size(size: u64) -> Result<(), String> {
    if size == 0 || size > MAX_ARCHIVE_BYTES {
        return Err(format!("invalid signed CLI archive size: {size}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;
    use crate::services::cli_update::contract::DesktopTarget;

    fn artifact(bytes: &[u8]) -> CliArtifact {
        CliArtifact {
            target: DesktopTarget::MacArm64,
            url: "https://example.invalid/archive.tar.gz".to_string(),
            size: bytes.len() as u64,
            sha256: hex::encode(Sha256::digest(bytes)),
            archive: "tar.gz".to_string(),
        }
    }

    #[test]
    fn writes_only_the_exact_signed_bytes_and_reports_progress() {
        let bytes = b"verified archive";
        let artifact = artifact(bytes);
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("archive.tar.gz");
        let mut progress = Vec::new();
        write_verified_archive(
            Cursor::new(bytes),
            &artifact,
            &destination,
            |done, total| {
                progress.push((done, total));
            },
        )
        .unwrap();
        assert_eq!(fs::read(destination).unwrap(), bytes);
        assert_eq!(
            progress.last(),
            Some(&(bytes.len() as u64, bytes.len() as u64))
        );
    }

    #[test]
    fn rejects_interrupted_or_oversized_bodies_and_removes_only_staging() {
        let complete = b"complete archive";
        let artifact = artifact(complete);
        for body in [&complete[..4], b"complete archive plus trailing".as_slice()] {
            let directory = tempfile::tempdir().unwrap();
            let destination = directory.path().join("unique-staging.tar.gz");
            let sibling = directory.path().join("keep-me");
            fs::write(&sibling, b"owned elsewhere").unwrap();
            assert!(
                write_verified_archive(Cursor::new(body), &artifact, &destination, |_, _| {})
                    .is_err()
            );
            assert!(!destination.exists());
            assert_eq!(fs::read(&sibling).unwrap(), b"owned elsewhere");
        }
    }

    #[test]
    fn rejects_a_changed_hash_and_preserves_an_existing_destination() {
        let bytes = b"archive";
        let mut artifact = artifact(bytes);
        artifact.sha256 = "0".repeat(64);
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("archive.tar.gz");
        assert!(
            write_verified_archive(Cursor::new(bytes), &artifact, &destination, |_, _| {})
                .unwrap_err()
                .contains("SHA-256")
        );
        assert!(!destination.exists());

        fs::write(&destination, b"pre-existing").unwrap();
        assert!(
            write_verified_archive(Cursor::new(bytes), &artifact, &destination, |_, _| {}).is_err()
        );
        assert_eq!(fs::read(destination).unwrap(), b"pre-existing");
    }

    #[test]
    fn rejects_a_signed_size_above_the_hard_limit_before_writing() {
        let mut artifact = artifact(b"x");
        artifact.size = MAX_ARCHIVE_BYTES + 1;
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("archive.tar.gz");
        assert!(
            write_verified_archive(Cursor::new(b"x"), &artifact, &destination, |_, _| {}).is_err()
        );
        assert!(!destination.exists());
    }
}
