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

// ── Local ASR execution ────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTranscript {
    pub language: Option<String>,
    pub segments: Vec<TranscriptSegment>,
    pub warnings: Vec<super::VideoWarning>,
}

#[derive(serde::Deserialize)]
struct WhisperDocument {
    result: Option<WhisperResult>,
    #[serde(default)]
    transcription: Vec<WhisperSegment>,
}

#[derive(serde::Deserialize)]
struct WhisperResult {
    language: Option<String>,
}

#[derive(serde::Deserialize)]
struct WhisperSegment {
    offsets: Option<WhisperOffsets>,
    text: Option<String>,
}

#[derive(serde::Deserialize)]
struct WhisperOffsets {
    from: u64,
    to: u64,
}

pub fn bundled_whisper_path() -> Result<PathBuf, String> {
    super::prepare::bundled_media_tool("verboo-whisper")
}

pub(crate) fn whisper_args(model: &Path, wav: &Path, output_prefix: &Path) -> Vec<std::ffi::OsString> {
    vec![
        std::ffi::OsString::from("-m"),
        model.into(),
        std::ffi::OsString::from("-f"),
        wav.into(),
        std::ffi::OsString::from("-l"),
        std::ffi::OsString::from("auto"),
        std::ffi::OsString::from("-oj"),
        std::ffi::OsString::from("-of"),
        output_prefix.into(),
        std::ffi::OsString::from("-np"),
    ]
}

/// Runs the bundled whisper.cpp CLI against a prepared 16 kHz mono WAV under
/// the job's cancellation token. The model must already be installed — this
/// function never downloads anything.
pub fn transcribe_wav(
    job: &super::job::VideoJob,
    whisper: &Path,
    model: &Path,
    wav: &Path,
) -> Result<AudioTranscript, String> {
    if !model.is_file() {
        return Err("asr model is not installed".to_string());
    }
    if !wav.is_file() {
        return Err("prepared audio is missing".to_string());
    }
    let output_prefix = job.directory().join("transcript");
    super::prepare::run_media_tool(job, whisper, &whisper_args(model, wav, &output_prefix))?;
    let json_path = output_prefix.with_extension("json");
    let data = std::fs::read(&json_path)
        .map_err(|error| format!("read transcription output: {error}"))?;
    parse_whisper_json(&data)
}

pub(crate) fn parse_whisper_json(data: &[u8]) -> Result<AudioTranscript, String> {
    let document: WhisperDocument = serde_json::from_slice(data)
        .map_err(|error| format!("invalid transcription JSON: {error}"))?;
    let segments = document
        .transcription
        .into_iter()
        .filter_map(|segment| {
            let text = segment.text?.trim().to_string();
            if text.is_empty() {
                return None;
            }
            let offsets = segment.offsets?;
            Some(TranscriptSegment {
                start_ms: offsets.from,
                end_ms: offsets.to,
                text,
            })
        })
        .collect();
    Ok(AudioTranscript {
        language: document
            .result
            .and_then(|result| result.language)
            .filter(|language| !language.trim().is_empty()),
        segments,
        warnings: Vec::new(),
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
    fn whisper_json_parses_multilingual_segments_with_timestamps() {
        let payload = br#"{
          "result": { "language": "pt" },
          "transcription": [
            { "offsets": { "from": 1100, "to": 5900 }, "text": " ola mundo" },
            { "offsets": { "from": 6000, "to": 7000 }, "text": "   " },
            { "offsets": { "from": 7100, "to": 9000 }, "text": "hello world" }
          ]
        }"#;

        let transcript = parse_whisper_json(payload).unwrap();

        assert_eq!(transcript.language.as_deref(), Some("pt"));
        assert_eq!(transcript.segments.len(), 2);
        assert_eq!(transcript.segments[0].start_ms, 1100);
        assert_eq!(transcript.segments[0].end_ms, 5900);
        assert_eq!(transcript.segments[0].text, "ola mundo");
        assert_eq!(transcript.segments[1].text, "hello world");
    }

    #[test]
    fn whisper_json_without_speech_yields_no_segments() {
        let payload = br#"{ "result": { "language": "en" }, "transcription": [] }"#;

        let transcript = parse_whisper_json(payload).unwrap();

        assert!(transcript.segments.is_empty());
    }

    #[test]
    fn malformed_whisper_json_is_a_typed_error() {
        let error = parse_whisper_json(b"{not-json").unwrap_err();

        assert!(error.contains("invalid transcription JSON"));
    }

    #[cfg(unix)]
    mod fake_whisper {
        use std::os::unix::fs::PermissionsExt;
        use std::path::Path;

        use tempfile::TempDir;

        use crate::services::video::job::VideoJobRegistry;
        use crate::services::video::transcribe::transcribe_wav;

        fn write_fake_whisper(directory: &Path, script_body: &str) -> std::path::PathBuf {
            let path = directory.join("fake-whisper");
            std::fs::write(&path, format!("#!/bin/sh\n{script_body}\n")).unwrap();
            let mut permissions = std::fs::metadata(&path).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&path, permissions).unwrap();
            path
        }

        #[test]
        fn a_fake_whisper_run_round_trips_segments() {
            let temp = TempDir::new().unwrap();
            let registry = VideoJobRegistry::new(temp.path()).unwrap();
            let job = registry.start("conversation-asr").unwrap();
            let model = temp.path().join("model.bin");
            std::fs::write(&model, b"model").unwrap();
            let wav = temp.path().join("audio.wav");
            std::fs::write(&wav, b"wav").unwrap();
            // The fake echoes a valid whisper.cpp JSON document to the -of prefix.
            let script = r#"
prefix=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-of" ]; then prefix="$2"; fi
  shift
done
cat > "$prefix.json" <<'EOF'
{ "result": { "language": "en" },
  "transcription": [ { "offsets": { "from": 0, "to": 900 }, "text": "hi" } ] }
EOF
"#;
            let whisper = write_fake_whisper(temp.path(), script);

            let transcript = transcribe_wav(&job, &whisper, &model, &wav).unwrap();

            assert_eq!(transcript.language.as_deref(), Some("en"));
            assert_eq!(transcript.segments.len(), 1);
            assert_eq!(transcript.segments[0].text, "hi");
        }

        #[test]
        fn nonzero_exit_missing_model_and_cancellation_fail_closed() {
            let temp = TempDir::new().unwrap();
            let registry = VideoJobRegistry::new(temp.path()).unwrap();
            let model = temp.path().join("model.bin");
            std::fs::write(&model, b"model").unwrap();
            let wav = temp.path().join("audio.wav");
            std::fs::write(&wav, b"wav").unwrap();
            let failing = write_fake_whisper(temp.path(), "echo boom >&2; exit 3");

            let job = registry.start("conversation-asr-fail").unwrap();
            let error = transcribe_wav(&job, &failing, &model, &wav).unwrap_err();
            assert!(error.contains("boom"));

            let missing_model = transcribe_wav(
                &job,
                &failing,
                Path::new("/does-not-exist/model.bin"),
                &wav,
            )
            .unwrap_err();
            assert!(missing_model.contains("asr model"));

            job.cancel().unwrap();
            let cancelled = transcribe_wav(&job, &failing, &model, &wav).unwrap_err();
            assert!(cancelled.contains("cancelled"));
        }
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
