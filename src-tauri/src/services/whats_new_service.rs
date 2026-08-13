use crate::models::types::{WhatsNewAcknowledgeResult, WhatsNewStatus};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

const STATE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ReleaseState {
    schema_version: u32,
    acknowledged_version: String,
}

enum LoadedState {
    Missing,
    Valid(ReleaseState),
    Invalid(String),
}

pub struct WhatsNewService {
    state_path: PathBuf,
    current_version: String,
    build_tag: Option<String>,
    preview: bool,
    suppressed_for_session: Mutex<bool>,
}

impl WhatsNewService {
    pub fn new(
        app_data_dir: PathBuf,
        current_version: String,
        build_tag: Option<String>,
        preview: bool,
    ) -> Self {
        Self {
            state_path: app_data_dir.join("release-state.json"),
            current_version,
            build_tag,
            preview,
            suppressed_for_session: Mutex::new(false),
        }
    }

    pub fn status(&self) -> Result<Option<WhatsNewStatus>, String> {
        if *self
            .suppressed_for_session
            .lock()
            .map_err(|_| "what's new session lock poisoned")?
        {
            return Ok(None);
        }
        let current = Version::parse(&self.current_version).map_err(|error| {
            format!(
                "invalid running app version {}: {error}",
                self.current_version
            )
        })?;
        let tag = if self.preview {
            format!("v{}", self.current_version)
        } else {
            let Some(tag) = self.build_tag.clone() else {
                return Ok(None);
            };
            if tag != format!("v{}", self.current_version) {
                eprintln!(
                    "[verboo:whats-new] release tag {tag} does not match {}",
                    self.current_version
                );
                return Ok(None);
            }
            tag
        };

        if !self.preview {
            match self.load_state() {
                LoadedState::Missing => {}
                LoadedState::Valid(state) if state.schema_version == STATE_SCHEMA_VERSION => {
                    let acknowledged = Version::parse(&state.acknowledged_version).map_err(|error| {
                        format!(
                            "invalid acknowledged app version {}: {error}",
                            state.acknowledged_version
                        )
                    });
                    match acknowledged {
                        Ok(acknowledged) if current <= acknowledged => return Ok(None),
                        Ok(_) => {}
                        Err(error) => return self.repair_and_suppress(error),
                    }
                }
                LoadedState::Valid(state) => {
                    return self.repair_and_suppress(format!(
                        "unsupported release state schema {}",
                        state.schema_version,
                    ));
                }
                LoadedState::Invalid(error) => return self.repair_and_suppress(error),
            }
        }

        Ok(Some(WhatsNewStatus {
            version: self.current_version.clone(),
            tag,
            preview: self.preview,
        }))
    }

    pub fn acknowledge(&self, version: &str) -> Result<WhatsNewAcknowledgeResult, String> {
        if version != self.current_version {
            return Err(format!(
                "cannot acknowledge app version {version} while running {}",
                self.current_version
            ));
        }
        let current = Version::parse(&self.current_version).map_err(|error| {
            format!(
                "invalid running app version {}: {error}",
                self.current_version
            )
        })?;
        let expected_tag = format!("v{}", self.current_version);
        if !self.preview && self.build_tag.as_deref() != Some(expected_tag.as_str()) {
            return Err("cannot acknowledge an untagged or mismatched app build".into());
        }
        *self
            .suppressed_for_session
            .lock()
            .map_err(|_| "what's new session lock poisoned")? = true;
        if self.preview {
            return Ok(WhatsNewAcknowledgeResult {
                persisted: false,
                error: None,
            });
        }
        let acknowledged_version = match self.load_state() {
            LoadedState::Valid(state) if state.schema_version == STATE_SCHEMA_VERSION => {
                match Version::parse(&state.acknowledged_version) {
                    Ok(existing) if existing > current => state.acknowledged_version,
                    _ => self.current_version.clone(),
                }
            }
            _ => self.current_version.clone(),
        };
        let state = ReleaseState {
            schema_version: STATE_SCHEMA_VERSION,
            acknowledged_version,
        };
        match atomic_write_json(&self.state_path, &state) {
            Ok(()) => Ok(WhatsNewAcknowledgeResult {
                persisted: true,
                error: None,
            }),
            Err(error) => Ok(WhatsNewAcknowledgeResult {
                persisted: false,
                error: Some(error),
            }),
        }
    }

    fn load_state(&self) -> LoadedState {
        let bytes = match fs::read(&self.state_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return LoadedState::Missing;
            }
            Err(error) => {
                return LoadedState::Invalid(format!(
                    "failed to read {}: {error}",
                    self.state_path.display()
                ));
            }
        };
        match serde_json::from_slice::<ReleaseState>(&bytes) {
            Ok(state) => LoadedState::Valid(state),
            Err(error) => LoadedState::Invalid(format!(
                "invalid {}: {error}",
                self.state_path.display()
            )),
        }
    }

    fn repair_and_suppress(&self, reason: String) -> Result<Option<WhatsNewStatus>, String> {
        eprintln!(
            "[verboo:whats-new] {reason}; suppressing and repairing current release state"
        );
        *self
            .suppressed_for_session
            .lock()
            .map_err(|_| "what's new session lock poisoned")? = true;
        let repaired = ReleaseState {
            schema_version: STATE_SCHEMA_VERSION,
            acknowledged_version: self.current_version.clone(),
        };
        if let Err(error) = atomic_write_json(&self.state_path, &repaired) {
            eprintln!("[verboo:whats-new] state repair failed: {error}");
        }
        Ok(None)
    }
}

fn atomic_write_json(path: &Path, value: &ReleaseState) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "release state path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create release state directory: {error}"))?;
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "release state filename is invalid".to_string())?;
    let temporary = parent.join(format!(".{filename}.{}.tmp", Uuid::new_v4()));
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("failed to serialize release state: {error}"))?;
    bytes.push(b'\n');
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("failed to create temporary release state: {error}"))?;
        file.write_all(&bytes)
            .map_err(|error| format!("failed to write temporary release state: {error}"))?;
        file.flush()
            .map_err(|error| format!("failed to flush temporary release state: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("failed to sync temporary release state: {error}"))?;
        drop(file);
        replace_file(&temporary, path)?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination)
        .map_err(|error| format!("failed to atomically replace release state: {error}"))
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(format!(
            "failed to atomically replace release state: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    OpenOptions::new()
        .read(true)
        .open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("failed to sync release state directory: {error}"))
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use tempfile::tempdir;

    fn tagged(root: &Path, current: &str) -> WhatsNewService {
        WhatsNewService::new(
            root.to_path_buf(),
            current.to_string(),
            Some(format!("v{current}")),
            false,
        )
    }

    #[test]
    fn first_tagged_launch_is_eligible_then_acknowledgment_survives_restart() {
        let root = tempdir().unwrap();
        let service = tagged(root.path(), "0.7.0-beta");
        assert_eq!(service.status().unwrap().unwrap().version, "0.7.0-beta");
        assert!(service.acknowledge("0.7.0-beta").unwrap().persisted);
        assert!(service.status().unwrap().is_none());
        assert!(tagged(root.path(), "0.7.0-beta").status().unwrap().is_none());
    }

    #[test]
    fn newer_version_is_eligible_and_downgrade_is_suppressed() {
        let root = tempdir().unwrap();
        tagged(root.path(), "0.7.0-beta").acknowledge("0.7.0-beta").unwrap();
        assert!(tagged(root.path(), "0.8.0-beta").status().unwrap().is_some());
        assert!(tagged(root.path(), "0.6.2").status().unwrap().is_none());
    }

    #[test]
    fn absent_or_mismatched_build_tag_is_not_eligible() {
        let root = tempdir().unwrap();
        let absent = WhatsNewService::new(root.path().into(), "0.7.0-beta".into(), None, false);
        let mismatch = WhatsNewService::new(
            root.path().into(),
            "0.7.0-beta".into(),
            Some("v0.6.2".into()),
            false,
        );
        assert!(absent.status().unwrap().is_none());
        assert!(mismatch.status().unwrap().is_none());
    }

    #[test]
    fn preview_shows_once_per_process_without_writing_state() {
        let root = tempdir().unwrap();
        let preview = WhatsNewService::new(root.path().into(), "0.7.0-beta".into(), None, true);
        assert!(preview.status().unwrap().unwrap().preview);
        let result = preview.acknowledge("0.7.0-beta").unwrap();
        assert!(!result.persisted);
        assert!(result.error.is_none());
        assert!(!root.path().join("release-state.json").exists());
        assert!(preview.status().unwrap().is_none());
    }

    #[test]
    fn corrupt_state_is_repaired_and_suppressed_without_showing() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("release-state.json"), b"not json").unwrap();
        let service = tagged(root.path(), "0.7.0-beta");
        assert!(service.status().unwrap().is_none());
        let repaired: ReleaseState = serde_json::from_slice(
            &fs::read(root.path().join("release-state.json")).unwrap(),
        ).unwrap();
        assert_eq!(repaired.acknowledged_version, "0.7.0-beta");
    }

    #[test]
    fn unsupported_schema_is_repaired_and_unknown_fields_are_ignored() {
        let root = tempdir().unwrap();
        fs::write(
            root.path().join("release-state.json"),
            br#"{"schemaVersion":1,"acknowledgedVersion":"0.7.0-beta","futureField":true}"#,
        ).unwrap();
        assert!(tagged(root.path(), "0.7.0-beta").status().unwrap().is_none());

        fs::write(
            root.path().join("release-state.json"),
            br#"{"schemaVersion":2,"acknowledgedVersion":"0.7.0-beta"}"#,
        ).unwrap();
        assert!(tagged(root.path(), "0.8.0-beta").status().unwrap().is_none());
        let repaired: ReleaseState = serde_json::from_slice(
            &fs::read(root.path().join("release-state.json")).unwrap(),
        ).unwrap();
        assert_eq!(repaired.schema_version, 1);
        assert_eq!(repaired.acknowledged_version, "0.8.0-beta");
    }

    #[test]
    fn closing_the_process_without_acknowledging_keeps_the_release_eligible() {
        let root = tempdir().unwrap();
        assert!(tagged(root.path(), "0.7.0-beta").status().unwrap().is_some());
        assert!(tagged(root.path(), "0.7.0-beta").status().unwrap().is_some());
    }

    #[test]
    fn direct_acknowledgment_from_a_downgraded_build_never_lowers_the_record() {
        let root = tempdir().unwrap();
        tagged(root.path(), "0.8.0-beta").acknowledge("0.8.0-beta").unwrap();
        tagged(root.path(), "0.7.0-beta").acknowledge("0.7.0-beta").unwrap();
        let state: ReleaseState = serde_json::from_slice(
            &fs::read(root.path().join("release-state.json")).unwrap(),
        ).unwrap();
        assert_eq!(state.acknowledged_version, "0.8.0-beta");
    }

    #[test]
    fn cli_files_cannot_change_app_release_eligibility() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join("cli-update")).unwrap();
        fs::write(
            root.path().join("cli-update/current.json"),
            br#"{"version":"999.0.0"}"#,
        ).unwrap();
        assert!(tagged(root.path(), "0.7.0-beta").status().unwrap().is_some());
    }

    #[test]
    fn failed_persistence_suppresses_only_the_current_process() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("release-state.json")).unwrap();
        let service = tagged(root.path(), "0.7.0-beta");
        let result = service.acknowledge("0.7.0-beta").unwrap();
        assert!(!result.persisted);
        assert!(result.error.is_some());
        assert!(service.status().unwrap().is_none());
    }
}
