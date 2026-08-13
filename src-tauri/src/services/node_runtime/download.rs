use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use sha2::{Digest, Sha256};

use super::contract::NodeArtifact;

pub trait NodeArchiveSource: Send + Sync {
    fn download(
        &self,
        artifact: &NodeArtifact,
        destination: &Path,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<(), String>;
}

pub struct OfficialNodeSource {
    client: Client,
}

impl OfficialNodeSource {
    pub fn production() -> Result<Self, String> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(10 * 60))
            .redirect(Policy::limited(5))
            .user_agent(format!("Verboo-Desktop/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| format!("failed to create managed Node download client: {error}"))?;
        Ok(Self { client })
    }
}

impl NodeArchiveSource for OfficialNodeSource {
    fn download(
        &self,
        artifact: &NodeArtifact,
        destination: &Path,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<(), String> {
        if !artifact
            .url
            .starts_with("https://nodejs.org/dist/v24.19.0/")
        {
            return Err("managed Node download rejected a non-official URL".to_string());
        }
        let response = self
            .client
            .get(&artifact.url)
            .send()
            .map_err(|error| format!("managed Node download failed: {error}"))?
            .error_for_status()
            .map_err(|error| format!("managed Node server returned an error: {error}"))?;
        if response
            .content_length()
            .is_some_and(|length| length != artifact.size)
        {
            return Err("managed Node response size does not match the app contract".to_string());
        }
        write_verified_archive(response, artifact, destination, progress)
    }
}

pub(crate) fn write_verified_archive(
    mut reader: impl Read,
    artifact: &NodeArtifact,
    destination: &Path,
    mut progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|error| format!("failed to create managed Node staging archive: {error}"))?;

    let result = (|| {
        let mut hasher = Sha256::new();
        let mut received = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        progress(0, artifact.size);
        loop {
            let read = reader
                .read(&mut buffer)
                .map_err(|error| format!("failed to read managed Node archive: {error}"))?;
            if read == 0 {
                break;
            }
            received = received
                .checked_add(read as u64)
                .ok_or_else(|| "managed Node archive size overflow".to_string())?;
            if received > artifact.size {
                return Err("managed Node archive exceeds the expected size".to_string());
            }
            output
                .write_all(&buffer[..read])
                .map_err(|error| format!("failed to write managed Node archive: {error}"))?;
            hasher.update(&buffer[..read]);
            progress(received, artifact.size);
        }
        if received != artifact.size {
            return Err("managed Node archive is incomplete".to_string());
        }
        if hex::encode(hasher.finalize()) != artifact.sha256 {
            return Err("managed Node archive SHA-256 mismatch".to_string());
        }
        output
            .flush()
            .map_err(|error| format!("failed to flush managed Node archive: {error}"))?;
        output
            .sync_all()
            .map_err(|error| format!("failed to sync managed Node archive: {error}"))?;
        Ok(())
    })();

    if result.is_err() {
        drop(output);
        let _ = fs::remove_file(destination);
    }
    result
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Cursor;

    use sha2::{Digest, Sha256};

    use super::*;
    use crate::services::cli_update::contract::DesktopTarget;
    use crate::services::node_runtime::contract::NodeArtifact;

    fn fixture_artifact(bytes: &[u8]) -> NodeArtifact {
        NodeArtifact {
            target: DesktopTarget::MacArm64,
            url: "https://nodejs.org/dist/v24.19.0/node-fixture.tar.xz".to_string(),
            archive: "node-fixture.tar.xz".to_string(),
            size: bytes.len() as u64,
            sha256: hex::encode(Sha256::digest(bytes)),
            entry: "node-v24.19.0-fixture/bin/node".to_string(),
            license: "node-v24.19.0-fixture/LICENSE".to_string(),
        }
    }

    #[test]
    fn exact_download_is_hashed_and_reports_progress() {
        let bytes = b"verified runtime archive";
        let artifact = fixture_artifact(bytes);
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("runtime.partial");
        let mut progress = Vec::new();

        write_verified_archive(Cursor::new(bytes), &artifact, &output, |done, total| {
            progress.push((done, total));
        })
        .unwrap();

        assert_eq!(fs::read(output).unwrap(), bytes);
        assert_eq!(
            progress.last(),
            Some(&(bytes.len() as u64, bytes.len() as u64))
        );
    }

    #[test]
    fn short_oversized_or_changed_download_never_leaves_staging() {
        let exact = b"exact";
        let artifact = fixture_artifact(exact);
        for body in [b"sho".as_slice(), b"exact-extra".as_slice()] {
            let directory = tempfile::tempdir().unwrap();
            let output = directory.path().join("runtime.partial");
            assert!(
                write_verified_archive(Cursor::new(body), &artifact, &output, |_, _| {}).is_err()
            );
            assert!(!output.exists());
        }

        let mut changed_hash = fixture_artifact(exact);
        changed_hash.sha256 = "0".repeat(64);
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("runtime.partial");
        assert!(
            write_verified_archive(Cursor::new(exact), &changed_hash, &output, |_, _| {}).is_err()
        );
        assert!(!output.exists());
    }

    #[test]
    fn refuses_to_overwrite_an_existing_destination() {
        let bytes = b"verified";
        let artifact = fixture_artifact(bytes);
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("runtime.partial");
        fs::write(&output, b"keep").unwrap();

        assert!(write_verified_archive(Cursor::new(bytes), &artifact, &output, |_, _| {}).is_err());
        assert_eq!(fs::read(output).unwrap(), b"keep");
    }
}
