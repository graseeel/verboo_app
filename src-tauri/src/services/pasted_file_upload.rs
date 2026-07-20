use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use uuid::Uuid;

use crate::models::types::AttachmentMeta;
use crate::services::file_service::{inspect_attachment_result, FileInspectionError};
use crate::services::video::MAX_VIDEO_BYTES;

pub const MAX_UPLOAD_CHUNK_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
struct UploadSession {
    path: PathBuf,
    display_name: String,
    declared_size: u64,
    written: u64,
}

pub struct PastedFileUploadService {
    root: PathBuf,
    sessions: Mutex<HashMap<String, UploadSession>>,
}

impl PastedFileUploadService {
    pub fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        let root = app_data_dir.join("video_jobs").join("uploads");
        cleanup_uploads(&root)?;
        Ok(Self {
            root,
            sessions: Mutex::new(HashMap::new()),
        })
    }

    pub fn begin(&self, name: &str, size: u64, _media_type: &str) -> Result<String, String> {
        if size > MAX_VIDEO_BYTES {
            return Err("upload exceeds 500 MiB limit".into());
        }
        fs::create_dir_all(&self.root).map_err(|error| format!("create upload dir: {error}"))?;
        let upload_id = Uuid::new_v4().to_string();
        let path = self
            .root
            .join(format!("{}.{}", upload_id, safe_extension(name)));
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| format!("create upload: {error}"))?;
        self.sessions
            .lock()
            .map_err(|error| error.to_string())?
            .insert(
                upload_id.clone(),
                UploadSession {
                    path,
                    display_name: safe_display_name(name),
                    declared_size: size,
                    written: 0,
                },
            );
        Ok(upload_id)
    }

    pub fn append(&self, upload_id: &str, offset: u64, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > MAX_UPLOAD_CHUNK_BYTES {
            self.remove_session(upload_id);
            return Err("upload chunk exceeds 1 MiB limit".into());
        }
        let mut sessions = self.sessions.lock().map_err(|error| error.to_string())?;
        let result = match sessions.get_mut(upload_id) {
            None => Err("unknown upload id".to_string()),
            Some(session) if offset != session.written => {
                Err("upload offset does not match written bytes".into())
            }
            Some(session) => {
                let next = session.written.saturating_add(bytes.len() as u64);
                if next > session.declared_size || next > MAX_VIDEO_BYTES {
                    Err("upload exceeds declared or maximum size".into())
                } else {
                    OpenOptions::new()
                        .append(true)
                        .open(&session.path)
                        .map_err(|error| format!("open upload: {error}"))
                        .and_then(|mut file| {
                            file.write_all(bytes)
                                .map_err(|error| format!("write upload: {error}"))
                        })
                        .map(|()| session.written = next)
                }
            }
        };
        drop(sessions);
        if result.is_err() {
            self.remove_session(upload_id);
        }
        result
    }

    pub fn finish(&self, upload_id: &str) -> Result<AttachmentMeta, String> {
        let session = self
            .sessions
            .lock()
            .map_err(|error| error.to_string())?
            .get(upload_id)
            .cloned()
            .ok_or_else(|| "unknown upload id".to_string())?;
        if session.written != session.declared_size {
            self.remove_session(upload_id);
            return Err("upload is incomplete".into());
        }
        let result = (|| {
            let file = OpenOptions::new()
                .write(true)
                .open(&session.path)
                .map_err(|error| format!("open upload for sync: {error}"))?;
            file.sync_all()
                .map_err(|error| format!("sync upload: {error}"))?;
            drop(file);
            let actual_size = fs::metadata(&session.path)
                .map_err(|error| format!("read upload metadata: {error}"))?
                .len();
            if actual_size != session.declared_size || actual_size > MAX_VIDEO_BYTES {
                return Err("upload size does not match declaration".into());
            }
            let path = session.path.to_string_lossy().to_string();
            let mut meta = inspect_attachment_result(&path).map_err(file_inspection_error)?;
            meta.name = session.display_name.clone();
            Ok(meta)
        })();
        match result {
            Ok(meta) => {
                self.sessions
                    .lock()
                    .map_err(|error| error.to_string())?
                    .remove(upload_id);
                Ok(meta)
            }
            Err(error) => {
                self.remove_session(upload_id);
                Err(error)
            }
        }
    }

    pub fn abort(&self, upload_id: &str) -> Result<(), String> {
        if Uuid::parse_str(upload_id).is_err() {
            return Err("unknown upload id".into());
        }
        let session_path = self
            .sessions
            .lock()
            .map_err(|error| error.to_string())?
            .remove(upload_id)
            .map(|session| session.path);
        if let Some(path) = session_path {
            return remove_upload_file(&path);
        }

        for entry in
            fs::read_dir(&self.root).map_err(|error| format!("read upload dir: {error}"))?
        {
            let entry = entry.map_err(|error| format!("read upload entry: {error}"))?;
            if entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
                && entry.path().file_stem().and_then(|stem| stem.to_str()) == Some(upload_id)
            {
                return remove_upload_file(&entry.path());
            }
        }
        Ok(())
    }

    fn remove_session(&self, upload_id: &str) {
        let path = self
            .sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(upload_id).map(|session| session.path));
        if let Some(path) = path {
            let _ = fs::remove_file(path);
        }
    }
}

fn safe_extension(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.is_empty() && extension.len() <= 16)
        .filter(|extension| {
            extension
                .chars()
                .all(|character| character.is_ascii_alphanumeric())
        })
        .unwrap_or("bin")
        .to_ascii_lowercase()
}

fn safe_display_name(name: &str) -> String {
    let filename = name
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or("upload.bin");
    let sanitized: String = filename
        .chars()
        .filter(|character| !character.is_control())
        .take(255)
        .collect();
    if sanitized.is_empty() {
        "upload.bin".into()
    } else {
        sanitized
    }
}

fn cleanup_uploads(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| format!("create upload dir: {error}"))?;
    for entry in fs::read_dir(root).map_err(|error| format!("read upload dir: {error}"))? {
        let entry = entry.map_err(|error| format!("read upload entry: {error}"))?;
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_file()
        {
            fs::remove_file(entry.path())
                .map_err(|error| format!("remove stale upload: {error}"))?;
        }
    }
    Ok(())
}

fn remove_upload_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("remove upload: {error}")),
    }
}

fn file_inspection_error(error: FileInspectionError) -> String {
    serde_json::to_string(&error).unwrap_or_else(|_| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> (tempfile::TempDir, PastedFileUploadService) {
        let dir = tempfile::tempdir().unwrap();
        let service = PastedFileUploadService::new(dir.path().to_path_buf()).unwrap();
        (dir, service)
    }

    #[test]
    fn rejects_offset_mismatch_and_unknown_id() {
        let (dir, service) = service();
        let id = service.begin("../../clip.mp4", 2, "video/mp4").unwrap();
        assert!(service.append(&id, 1, &[1]).is_err());
        assert!(fs::read_dir(dir.path().join("video_jobs/uploads"))
            .unwrap()
            .next()
            .is_none());
        assert!(service.append("missing", 0, &[1]).is_err());
    }

    #[test]
    fn rejects_declared_and_actual_oversize_uploads() {
        let (_dir, service) = service();
        assert!(service
            .begin("clip.mp4", MAX_VIDEO_BYTES + 1, "video/mp4")
            .is_err());
        let id = service.begin("clip.mp4", 1, "video/mp4").unwrap();
        assert!(service.append(&id, 0, &[1, 2]).is_err());

        let id = service
            .begin("clip.mp4", MAX_VIDEO_BYTES, "video/mp4")
            .unwrap();
        let path = {
            let mut sessions = service.sessions.lock().unwrap();
            let session = sessions.get_mut(&id).unwrap();
            session.written = MAX_VIDEO_BYTES;
            session.path.clone()
        };
        OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_len(MAX_VIDEO_BYTES + 1)
            .unwrap();
        assert!(service.finish(&id).is_err());
    }

    #[test]
    fn rejects_finish_before_complete_and_cleans_partial_file() {
        let (_dir, service) = service();
        let id = service.begin("clip.mp4", 2, "video/mp4").unwrap();
        service.append(&id, 0, &[1]).unwrap();
        assert!(service.finish(&id).is_err());
        assert!(service.abort(&id).is_ok());
    }

    #[test]
    fn abort_and_startup_cleanup_remove_partial_uploads() {
        let (dir, service) = service();
        let id = service.begin("clip.mp4", 1, "video/mp4").unwrap();
        service.append(&id, 0, &[1]).unwrap();
        service.abort(&id).unwrap();
        let root = dir.path().join("video_jobs/uploads");
        fs::write(root.join("stale.mp4"), [1]).unwrap();
        let _restarted = PastedFileUploadService::new(dir.path().to_path_buf()).unwrap();
        assert!(fs::read_dir(root).unwrap().next().is_none());
    }

    #[test]
    fn abort_removes_a_finished_upload_after_the_session_was_released() {
        let (dir, service) = service();
        let id = service.begin("clip.mp4", 1, "video/mp4").unwrap();
        service.append(&id, 0, &[1]).unwrap();
        service.sessions.lock().unwrap().remove(&id);

        service.abort(&id).unwrap();

        let root = dir.path().join("video_jobs/uploads");
        assert!(fs::read_dir(root).unwrap().next().is_none());
    }

    #[test]
    fn upload_name_is_generated_but_display_name_is_sanitized() {
        let (dir, service) = service();
        let id = service.begin("../../clip.mp4", 1, "video/mp4").unwrap();
        let root = dir.path().join("video_jobs/uploads");
        let stored_name = fs::read_dir(root)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .file_name()
            .to_string_lossy()
            .into_owned();
        assert!(stored_name.starts_with(&id));
        assert_eq!(safe_display_name("../../clip.mp4"), "clip.mp4");
        assert_eq!(
            safe_display_name(r"..\..\Meu vídeo ção.mp4"),
            "Meu vídeo ção.mp4"
        );
    }
}
