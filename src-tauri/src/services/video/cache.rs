use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const MAX_CACHE_JSON_BYTES: u64 = 1024 * 1024;
const MAX_CACHE_TEXT_BYTES: usize = 512 * 1024;
const MAX_CACHE_OCR_ITEMS: usize = 2_000;
const MAX_CACHE_SHEETS: usize = 10;
const MAX_CACHE_SHEET_BYTES: u64 = 4 * 1024 * 1024;
const STALE_CACHE_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoCacheKey(String);

impl VideoCacheKey {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

pub struct VideoCacheKeyInput<'a> {
    pub original: &'a Path,
    pub pipeline_version: &'a str,
    pub route: &'a str,
    pub model_capability_fingerprint: &'a str,
    pub cli_capability_fingerprint: &'a str,
    pub asr_model_hash: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedContactSheet {
    pub timestamps_ms: Vec<u64>,
    pub file_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCacheEntry {
    pub created_at_ms: u64,
    pub description: String,
    pub transcript: String,
    #[serde(default)]
    pub ocr: Vec<String>,
    #[serde(default)]
    pub contact_sheets: Vec<CachedContactSheet>,
}

impl VideoCacheEntry {
    pub fn new(
        description: impl Into<String>,
        transcript: impl Into<String>,
        ocr: Vec<String>,
    ) -> Self {
        Self {
            created_at_ms: unix_millis(),
            description: description.into(),
            transcript: transcript.into(),
            ocr,
            contact_sheets: Vec::new(),
        }
    }
}

pub struct VideoCache {
    root: PathBuf,
}

impl VideoCache {
    pub fn new(app_data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let root = app_data_dir.as_ref().join("video_cache");
        fs::create_dir_all(&root).map_err(|error| format!("create video cache: {error}"))?;
        let cache = Self { root };
        cache.prune_stale()?;
        Ok(cache)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn key_for_file(input: VideoCacheKeyInput<'_>) -> Result<VideoCacheKey, String> {
        let mut original = File::open(input.original)
            .map_err(|error| format!("open original video for cache key: {error}"))?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let bytes = original
                .read(&mut buffer)
                .map_err(|error| format!("read original video for cache key: {error}"))?;
            if bytes == 0 {
                break;
            }
            hasher.update(&buffer[..bytes]);
        }
        for part in [
            input.pipeline_version,
            input.route,
            input.model_capability_fingerprint,
            input.cli_capability_fingerprint,
            input.asr_model_hash,
        ] {
            hasher.update([0]);
            hasher.update(part.as_bytes());
        }
        Ok(VideoCacheKey(format!("{:x}", hasher.finalize())))
    }

    pub fn entry_path(&self, key: &VideoCacheKey) -> PathBuf {
        self.root.join(format!("{}.json", key.as_str()))
    }

    pub fn read(&self, key: &VideoCacheKey) -> Option<VideoCacheEntry> {
        let path = self.entry_path(key);
        let result = (|| {
            let metadata = fs::metadata(&path).ok()?;
            if metadata.len() > MAX_CACHE_JSON_BYTES {
                return None;
            }
            let data = fs::read(&path).ok()?;
            let entry: VideoCacheEntry = serde_json::from_slice(&data).ok()?;
            validate_entry(&entry).ok()?;
            for sheet in &entry.contact_sheets {
                let metadata = fs::metadata(self.sheet_dir(key).join(&sheet.file_name)).ok()?;
                if metadata.len() > MAX_CACHE_SHEET_BYTES {
                    return None;
                }
            }
            Some(entry)
        })();
        if result.is_none() && path.exists() {
            let _ = self.evict(key);
        }
        result
    }

    /// Writes only derived data. The original video is never copied into this
    /// cache; contact sheets are bounded derivative PNGs and JSON is replaced
    /// by a synced temporary file followed by rename.
    pub fn write(
        &self,
        key: &VideoCacheKey,
        entry: &VideoCacheEntry,
        source_sheets: &[PathBuf],
    ) -> Result<(), String> {
        if source_sheets.len() != entry.contact_sheets.len() {
            return Err("cache sheet metadata does not match source sheets".to_string());
        }
        let mut entry = entry.clone();
        for (index, sheet) in entry.contact_sheets.iter_mut().enumerate() {
            sheet.file_name = format!("sheet-{index}.png");
        }
        validate_entry(&entry)?;

        let sheets_temp =
            self.root
                .join(format!(".{}-sheets-{}.tmp", key.as_str(), Uuid::new_v4()));
        if !source_sheets.is_empty() {
            fs::create_dir(&sheets_temp)
                .map_err(|error| format!("create temporary cache sheets: {error}"))?;
            for (source, sheet) in source_sheets.iter().zip(&entry.contact_sheets) {
                let metadata = fs::metadata(source)
                    .map_err(|error| format!("inspect contact sheet: {error}"))?;
                if !metadata.is_file() || metadata.len() > MAX_CACHE_SHEET_BYTES {
                    let _ = fs::remove_dir_all(&sheets_temp);
                    return Err("contact sheet exceeds cache limits".to_string());
                }
                fs::copy(source, sheets_temp.join(&sheet.file_name))
                    .map_err(|error| format!("copy contact sheet into cache: {error}"))?;
            }
        }

        let encoded = serde_json::to_vec(&entry)
            .map_err(|error| format!("serialize video cache entry: {error}"))?;
        if encoded.len() as u64 > MAX_CACHE_JSON_BYTES {
            let _ = fs::remove_dir_all(&sheets_temp);
            return Err("video cache JSON exceeds limit".to_string());
        }
        let temporary = self
            .root
            .join(format!(".{}-{}.tmp", key.as_str(), Uuid::new_v4()));
        let write_result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|error| format!("create temporary video cache: {error}"))?;
            file.write_all(&encoded)
                .map_err(|error| format!("write temporary video cache: {error}"))?;
            file.sync_all()
                .map_err(|error| format!("sync temporary video cache: {error}"))?;
            drop(file);

            let sheet_dir = self.sheet_dir(key);
            if sheet_dir.exists() {
                fs::remove_dir_all(&sheet_dir)
                    .map_err(|error| format!("replace cached contact sheets: {error}"))?;
            }
            if !source_sheets.is_empty() {
                fs::rename(&sheets_temp, &sheet_dir)
                    .map_err(|error| format!("publish cached contact sheets: {error}"))?;
            }
            replace_file(&temporary, &self.entry_path(key))
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temporary);
            let _ = fs::remove_dir_all(&sheets_temp);
        }
        write_result
    }

    pub fn prune_stale(&self) -> Result<(), String> {
        let now = SystemTime::now();
        for entry in
            fs::read_dir(&self.root).map_err(|error| format!("read video cache: {error}"))?
        {
            let entry = entry.map_err(|error| format!("read video cache entry: {error}"))?;
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(now);
            if now.duration_since(modified).unwrap_or_default() < STALE_CACHE_AGE {
                continue;
            }
            let path = entry.path();
            if entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_dir()
            {
                fs::remove_dir_all(path)
                    .map_err(|error| format!("prune video cache directory: {error}"))?;
            } else {
                fs::remove_file(path)
                    .map_err(|error| format!("prune video cache file: {error}"))?;
            }
        }
        Ok(())
    }

    fn sheet_dir(&self, key: &VideoCacheKey) -> PathBuf {
        self.root.join(format!("{}-sheets", key.as_str()))
    }

    fn evict(&self, key: &VideoCacheKey) -> Result<(), String> {
        remove_if_present(&self.entry_path(key))?;
        let sheets = self.sheet_dir(key);
        if sheets.exists() {
            fs::remove_dir_all(sheets)
                .map_err(|error| format!("evict cached contact sheets: {error}"))?;
        }
        Ok(())
    }
}

fn validate_entry(entry: &VideoCacheEntry) -> Result<(), String> {
    if entry.description.len()
        + entry.transcript.len()
        + entry.ocr.iter().map(String::len).sum::<usize>()
        > MAX_CACHE_TEXT_BYTES
    {
        return Err("video cache text exceeds limit".to_string());
    }
    if entry.ocr.len() > MAX_CACHE_OCR_ITEMS || entry.contact_sheets.len() > MAX_CACHE_SHEETS {
        return Err("video cache collection exceeds limit".to_string());
    }
    for sheet in &entry.contact_sheets {
        if sheet.timestamps_ms.len() > 12
            || !is_safe_file_name(&sheet.file_name)
            || !sheet.file_name.ends_with(".png")
        {
            return Err("invalid cached contact sheet".to_string());
        }
    }
    Ok(())
}

fn is_safe_file_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && !value.contains(['/', '\\'])
        && !value.starts_with('.')
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
}

fn replace_file(temporary: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(windows)]
    if destination.exists() {
        fs::remove_file(destination).map_err(|error| format!("replace video cache: {error}"))?;
    }
    fs::rename(temporary, destination).map_err(|error| format!("publish video cache: {error}"))
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("remove video cache file: {error}")),
    }
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::{VideoCache, VideoCacheEntry, VideoCacheKeyInput};

    fn key_input(original: &std::path::Path) -> VideoCacheKeyInput<'_> {
        VideoCacheKeyInput {
            original,
            pipeline_version: "video-pipeline-v1",
            route: "sampled_frames",
            model_capability_fingerprint: "model-a",
            cli_capability_fingerprint: "cli-a",
            asr_model_hash: "asr-a",
        }
    }

    #[test]
    fn cache_key_covers_video_bytes_and_all_pipeline_fingerprints() {
        let temp = TempDir::new().unwrap();
        let original = temp.path().join("clip.mp4");
        fs::write(&original, b"first bytes").unwrap();
        let first = VideoCache::key_for_file(key_input(&original)).unwrap();

        fs::write(&original, b"changed bytes").unwrap();
        let changed_bytes = VideoCache::key_for_file(key_input(&original)).unwrap();
        let changed_route = VideoCache::key_for_file(VideoCacheKeyInput {
            route: "native_sdr_proxy",
            ..key_input(&original)
        })
        .unwrap();
        let changed_model = VideoCache::key_for_file(VideoCacheKeyInput {
            model_capability_fingerprint: "model-b",
            ..key_input(&original)
        })
        .unwrap();

        assert_ne!(first, changed_bytes);
        assert_ne!(changed_bytes, changed_route);
        assert_ne!(changed_bytes, changed_model);
    }

    #[test]
    fn corrupt_cache_json_is_evicted_instead_of_returned() {
        let temp = TempDir::new().unwrap();
        let cache = VideoCache::new(temp.path()).unwrap();
        let original = temp.path().join("clip.mp4");
        fs::write(&original, b"clip").unwrap();
        let key = VideoCache::key_for_file(key_input(&original)).unwrap();
        fs::write(cache.entry_path(&key), b"{not-json").unwrap();

        assert!(cache.read(&key).is_none());
        assert!(!cache.entry_path(&key).exists());
    }

    #[test]
    fn cache_write_is_atomic_and_round_trips_bounded_context() {
        let temp = TempDir::new().unwrap();
        let cache = VideoCache::new(temp.path()).unwrap();
        let original = temp.path().join("clip.mp4");
        fs::write(&original, b"clip").unwrap();
        let key = VideoCache::key_for_file(key_input(&original)).unwrap();
        let entry = VideoCacheEntry::new("short description", "speech", vec!["ocr".into()]);

        cache.write(&key, &entry, &[]).unwrap();

        assert_eq!(cache.read(&key), Some(entry));
        assert!(fs::read_dir(cache.root()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".tmp")));
    }
}
