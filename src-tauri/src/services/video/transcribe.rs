use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

pub const WHISPER_BASE_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
pub const WHISPER_BASE_BYTES: u64 = 147_951_465;
pub const WHISPER_BASE_SHA256: &str =
    "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe";

#[derive(Debug, Clone)]
struct VideoModelSpec {
    url: &'static str,
    bytes: u64,
    sha256: String,
}

impl VideoModelSpec {
    fn whisper_base() -> Self {
        Self {
            url: WHISPER_BASE_URL,
            bytes: WHISPER_BASE_BYTES,
            sha256: WHISPER_BASE_SHA256.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AsrModelState {
    Absent,
    Ready,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoComponentState {
    pub asr_model: AsrModelState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoTranscriberProgress {
    pub state: &'static str,
    pub bytes_downloaded: u64,
    pub total_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct VideoTranscriberStore {
    model_dir: PathBuf,
    operation_active: Arc<AtomicBool>,
}

impl VideoTranscriberStore {
    pub fn new(app_data_dir: impl AsRef<Path>) -> Self {
        Self {
            model_dir: app_data_dir.as_ref().join("models").join("whisper"),
            operation_active: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn model_dir(&self) -> &Path {
        &self.model_dir
    }

    pub fn model_path(&self) -> PathBuf {
        self.model_dir.join("ggml-base.bin")
    }

    pub fn partial_path(&self) -> PathBuf {
        self.model_dir.join("ggml-base.bin.partial")
    }

    pub async fn state(&self) -> Result<VideoComponentState, String> {
        self.state_for_spec(VideoModelSpec::whisper_base()).await
    }

    async fn state_for_spec(&self, spec: VideoModelSpec) -> Result<VideoComponentState, String> {
        let model_path = self.model_path();
        tokio::task::spawn_blocking(move || inspect_model_state(&model_path, &spec))
            .await
            .map_err(|error| format!("video transcriber inspection task failed: {error}"))?
    }

    pub async fn remove(&self) -> Result<(), String> {
        let _operation = self.begin_operation()?;
        remove_if_present(&self.model_path()).await?;
        remove_if_present(&self.partial_path()).await?;
        Ok(())
    }

    pub async fn download<F>(&self, mut on_progress: F) -> Result<(), String>
    where
        F: FnMut(VideoTranscriberProgress),
    {
        let _operation = self.begin_operation()?;
        if self.state().await?.asr_model == AsrModelState::Ready {
            return Ok(());
        }
        let spec = VideoModelSpec::whisper_base();
        remove_if_present(&self.model_path()).await?;
        remove_if_present(&self.partial_path()).await?;
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(600))
            .build()
            .map_err(|error| format!("failed to create model downloader: {error}"))?;
        let mut response = client
            .get(spec.url)
            .send()
            .await
            .map_err(|error| format!("model download failed: {error}"))?
            .error_for_status()
            .map_err(|error| format!("model download failed: {error}"))?;

        if response
            .content_length()
            .is_some_and(|bytes| bytes > spec.bytes)
        {
            return Err("model download exceeds maximum size".to_string());
        }

        let mut session = self.begin_install(&spec).await?;
        let result = async {
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|error| format!("model download failed: {error}"))?
            {
                session.write_chunk(&chunk).await?;
                on_progress(VideoTranscriberProgress {
                    state: "downloading",
                    bytes_downloaded: session.downloaded,
                    total_bytes: spec.bytes,
                    error: None,
                });
            }
            session.finish().await
        }
        .await;

        if let Err(error) = result {
            let _ = remove_if_present(&self.partial_path()).await;
            return Err(error);
        }
        Ok(())
    }

    fn begin_operation(&self) -> Result<OperationGuard, String> {
        self.operation_active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "a video transcriber operation is already running".to_string())?;
        Ok(OperationGuard(self.operation_active.clone()))
    }

    async fn begin_install<'a>(
        &self,
        spec: &'a VideoModelSpec,
    ) -> Result<InstallSession<'a>, String> {
        tokio::fs::create_dir_all(&self.model_dir)
            .await
            .map_err(|error| format!("failed to create model directory: {error}"))?;
        remove_if_present(&self.partial_path()).await?;
        remove_if_present(&self.model_path()).await?;
        let file = tokio::fs::File::create(self.partial_path())
            .await
            .map_err(|error| format!("failed to create partial model: {error}"))?;
        Ok(InstallSession {
            spec,
            file,
            hasher: Sha256::new(),
            downloaded: 0,
            partial_path: self.partial_path(),
            model_path: self.model_path(),
        })
    }

    #[cfg(test)]
    async fn install_chunks_for_test<F>(
        &self,
        spec: VideoModelSpec,
        chunks: Vec<Result<Vec<u8>, String>>,
        mut on_progress: F,
    ) -> Result<(), String>
    where
        F: FnMut(u64),
    {
        let mut session = self.begin_install(&spec).await?;
        let result = async {
            for chunk in chunks {
                let chunk = chunk?;
                session.write_chunk(&chunk).await?;
                on_progress(session.downloaded);
            }
            session.finish().await
        }
        .await;
        if result.is_err() {
            let _ = remove_if_present(&self.partial_path()).await;
        }
        result
    }
}

fn inspect_model_state(
    model_path: &Path,
    spec: &VideoModelSpec,
) -> Result<VideoComponentState, String> {
    let metadata = match std::fs::metadata(model_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(VideoComponentState {
                asr_model: AsrModelState::Absent,
                bytes: None,
            });
        }
        Err(error) => return Err(format!("failed to inspect video transcriber: {error}")),
    };
    if metadata.len() != spec.bytes {
        return Ok(VideoComponentState {
            asr_model: AsrModelState::Absent,
            bytes: None,
        });
    }

    let mut file = std::fs::File::open(model_path)
        .map_err(|error| format!("failed to open video transcriber: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("failed to hash video transcriber: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual_sha = format!("{:x}", hasher.finalize());
    if actual_sha != spec.sha256 {
        return Ok(VideoComponentState {
            asr_model: AsrModelState::Absent,
            bytes: None,
        });
    }

    Ok(VideoComponentState {
        asr_model: AsrModelState::Ready,
        bytes: Some(metadata.len()),
    })
}

#[derive(Debug)]
struct OperationGuard(Arc<AtomicBool>);

impl Drop for OperationGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

struct InstallSession<'a> {
    spec: &'a VideoModelSpec,
    file: tokio::fs::File,
    hasher: Sha256,
    downloaded: u64,
    partial_path: PathBuf,
    model_path: PathBuf,
}

impl InstallSession<'_> {
    async fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), String> {
        let next = self
            .downloaded
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| "model size overflow".to_string())?;
        if next > self.spec.bytes {
            return Err(format!(
                "model size mismatch: expected {}, received more than {}",
                self.spec.bytes, self.spec.bytes
            ));
        }
        self.file
            .write_all(bytes)
            .await
            .map_err(|error| format!("failed to write partial model: {error}"))?;
        self.hasher.update(bytes);
        self.downloaded = next;
        Ok(())
    }

    async fn finish(mut self) -> Result<(), String> {
        if self.downloaded != self.spec.bytes {
            return Err(format!(
                "model size mismatch: expected {}, received {}",
                self.spec.bytes, self.downloaded
            ));
        }
        let actual_sha = format!("{:x}", self.hasher.finalize());
        if actual_sha != self.spec.sha256 {
            return Err(format!(
                "model checksum mismatch: expected {}, received {actual_sha}",
                self.spec.sha256
            ));
        }
        self.file
            .flush()
            .await
            .map_err(|error| format!("failed to flush partial model: {error}"))?;
        self.file
            .sync_all()
            .await
            .map_err(|error| format!("failed to sync partial model: {error}"))?;
        drop(self.file);
        tokio::fs::rename(&self.partial_path, &self.model_path)
            .await
            .map_err(|error| format!("failed to publish verified model: {error}"))
    }
}

async fn remove_if_present(path: &Path) -> Result<(), String> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to remove {}: {error}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn test_spec(bytes: &[u8]) -> VideoModelSpec {
        VideoModelSpec {
            url: "https://example.invalid/model.bin",
            bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        }
    }

    #[tokio::test]
    async fn fake_chunks_install_atomically_without_network() {
        let dir = tempfile::tempdir().unwrap();
        let store = VideoTranscriberStore::new(dir.path());
        let payload = b"verified-model";

        store
            .install_chunks_for_test(
                test_spec(payload),
                vec![Ok(b"verified-".to_vec()), Ok(b"model".to_vec())],
                |_| {},
            )
            .await
            .unwrap();

        assert_eq!(std::fs::read(store.model_path()).unwrap(), payload);
        assert!(!store.partial_path().exists());
    }

    #[tokio::test]
    async fn checksum_mismatch_cleans_partial_and_never_publishes_model() {
        let dir = tempfile::tempdir().unwrap();
        let store = VideoTranscriberStore::new(dir.path());
        let mut spec = test_spec(b"payload");
        spec.sha256 = "0".repeat(64);

        let error = store
            .install_chunks_for_test(spec, vec![Ok(b"payload".to_vec())], |_| {})
            .await
            .unwrap_err();

        assert!(error.contains("checksum"));
        assert!(!store.model_path().exists());
        assert!(!store.partial_path().exists());
    }

    #[tokio::test]
    async fn byte_limit_failure_cleans_partial() {
        let dir = tempfile::tempdir().unwrap();
        let store = VideoTranscriberStore::new(dir.path());
        let spec = test_spec(b"short");

        let error = store
            .install_chunks_for_test(spec, vec![Ok(b"too-long".to_vec())], |_| {})
            .await
            .unwrap_err();

        assert!(error.contains("size"));
        assert!(!store.partial_path().exists());
    }

    #[tokio::test]
    async fn remove_deletes_model_and_partial() {
        let dir = tempfile::tempdir().unwrap();
        let store = VideoTranscriberStore::new(dir.path());
        std::fs::create_dir_all(store.model_dir()).unwrap();
        std::fs::write(store.model_path(), b"model").unwrap();
        std::fs::write(store.partial_path(), b"partial").unwrap();

        store.remove().await.unwrap();

        assert!(!store.model_path().exists());
        assert!(!store.partial_path().exists());
        assert_eq!(
            store.state().await.unwrap().asr_model,
            AsrModelState::Absent
        );
    }

    #[tokio::test]
    async fn matching_size_and_checksum_is_the_idempotent_ready_decision() {
        let dir = tempfile::tempdir().unwrap();
        let store = VideoTranscriberStore::new(dir.path());
        std::fs::create_dir_all(store.model_dir()).unwrap();
        std::fs::write(store.model_path(), b"verified-model").unwrap();

        let state = store
            .state_for_spec(test_spec(b"verified-model"))
            .await
            .unwrap();

        assert_eq!(state.asr_model, AsrModelState::Ready);
    }

    #[tokio::test]
    async fn wrong_size_model_is_not_ready() {
        let dir = tempfile::tempdir().unwrap();
        let store = VideoTranscriberStore::new(dir.path());
        std::fs::create_dir_all(store.model_dir()).unwrap();
        std::fs::write(store.model_path(), b"short").unwrap();

        let state = store.state_for_spec(test_spec(b"correct")).await.unwrap();

        assert_eq!(state.asr_model, AsrModelState::Absent);
    }

    #[tokio::test]
    async fn same_size_corrupt_model_is_not_ready() {
        let dir = tempfile::tempdir().unwrap();
        let store = VideoTranscriberStore::new(dir.path());
        std::fs::create_dir_all(store.model_dir()).unwrap();
        std::fs::write(store.model_path(), b"corrupt").unwrap();

        let state = store.state_for_spec(test_spec(b"correct")).await.unwrap();

        assert_eq!(state.asr_model, AsrModelState::Absent);
    }

    #[test]
    fn concurrent_operations_are_rejected_deterministically() {
        let dir = tempfile::tempdir().unwrap();
        let store = VideoTranscriberStore::new(dir.path());
        let first = store.begin_operation().unwrap();
        assert_eq!(
            store.begin_operation().unwrap_err(),
            "a video transcriber operation is already running"
        );
        drop(first);
        assert!(store.begin_operation().is_ok());
    }
}
