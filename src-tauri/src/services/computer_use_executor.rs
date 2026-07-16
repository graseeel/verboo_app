use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::models::types::VerbooModel;

const LEASE_FILE_NAME: &str = "visual-executor-lease.json";
const NO_VISUAL_EXECUTOR_MESSAGE: &str =
    "Computer Use is unavailable because the model catalog has no vision-capable model.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutorChoice {
    Current {
        model_id: String,
    },
    TemporaryVision {
        original_model_id: String,
        vision_model_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecutorSelectionError;

impl fmt::Display for ExecutorSelectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(NO_VISUAL_EXECUTOR_MESSAGE)
    }
}

impl std::error::Error for ExecutorSelectionError {}

/// Computer Use accepts only vision capability proven by the backend model
/// discovery path. Name-derived or provenance-free flags fail closed.
pub fn is_backend_verified_visual_executor(model: &VerbooModel) -> bool {
    model.supports_vision == Some(true)
        && matches!(
            model.vision_support_source.as_deref(),
            Some("router" | "raw-capabilities")
        )
}

pub fn require_backend_verified_visual_executor(
    catalog: &[VerbooModel],
    executor_model_id: &str,
) -> Result<(), ExecutorSelectionError> {
    catalog
        .iter()
        .any(|model| model.id == executor_model_id && is_backend_verified_visual_executor(model))
        .then_some(())
        .ok_or(ExecutorSelectionError)
}

/// Selects the model that owns the complete Computer Use screenshot/action loop.
///
/// Selection deliberately uses only exact model IDs, catalog order, and the
/// explicit `supports_vision` flag. Unknown vision support fails closed.
pub fn select_executor(
    current_model_id: &str,
    catalog: &[VerbooModel],
    preferred_visual_model_id: Option<&str>,
) -> Result<ExecutorChoice, ExecutorSelectionError> {
    if catalog
        .iter()
        .any(|model| model.id == current_model_id && is_backend_verified_visual_executor(model))
    {
        return Ok(ExecutorChoice::Current {
            model_id: current_model_id.to_string(),
        });
    }

    let preferred = preferred_visual_model_id.and_then(|preferred_id| {
        catalog
            .iter()
            .find(|model| model.id == preferred_id && is_backend_verified_visual_executor(model))
    });
    let executor = preferred.or_else(|| {
        catalog
            .iter()
            .find(|model| is_backend_verified_visual_executor(model))
    });

    executor
        .map(|model| ExecutorChoice::TemporaryVision {
            original_model_id: current_model_id.to_string(),
            vision_model_id: model.id.clone(),
        })
        .ok_or(ExecutorSelectionError)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VisualExecutorLease {
    pub conversation_id: String,
    pub original_model_id: String,
    pub executor_model_id: String,
    pub started_at_ms: u64,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseInconsistency {
    EmptyConversationId,
    EmptyOriginalModelId,
    EmptyExecutorModelId,
    OriginalMatchesExecutor,
    InvalidLifetime,
    StartedInFuture,
    ExecutorUnavailableOrNotVisionCapable,
    MalformedRecord,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseRecoveryReason {
    Expired,
    Inconsistent(LeaseInconsistency),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseRecoveryDecision {
    NoLease,
    OfferRestoreOrResume {
        lease: VisualExecutorLease,
    },
    /// The persisted record has already been cleared; the caller must restore
    /// the returned original model ID in conversation state.
    RestoreOriginal {
        original_model_id: String,
        reason: LeaseRecoveryReason,
    },
    /// A malformed record cannot safely identify an original model. It has
    /// already been cleared and no model ID is invented.
    ClearInconsistent {
        reason: LeaseInconsistency,
    },
}

#[derive(Debug, Clone)]
pub struct VisualExecutorLeaseStore {
    directory: PathBuf,
    file_path: PathBuf,
}

impl VisualExecutorLeaseStore {
    pub fn new(directory: impl AsRef<Path>) -> Self {
        let directory = directory.as_ref().to_path_buf();
        let file_path = directory.join(LEASE_FILE_NAME);
        Self {
            directory,
            file_path,
        }
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.file_path
    }

    /// Atomically replaces the lease using a private temporary file in the
    /// same directory, so readers observe either the old or the new record.
    pub fn persist(&self, lease: &VisualExecutorLease) -> Result<(), String> {
        self.ensure_private_directory()?;
        let bytes = serde_json::to_vec(lease).map_err(|error| error.to_string())?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(&self.directory).map_err(|error| error.to_string())?;
        set_private_file_permissions(temporary.path())?;
        temporary
            .write_all(&bytes)
            .map_err(|error| error.to_string())?;
        temporary.flush().map_err(|error| error.to_string())?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        temporary
            .persist(&self.file_path)
            .map_err(|error| error.error.to_string())?;
        set_private_file_permissions(&self.file_path)?;
        sync_directory(&self.directory)?;
        Ok(())
    }

    pub fn load(&self) -> Result<Option<VisualExecutorLease>, String> {
        let bytes = match fs::read(&self.file_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| error.to_string())
    }

    pub fn clear(&self) -> Result<(), String> {
        match fs::remove_file(&self.file_path) {
            Ok(()) => {
                sync_directory_if_present(&self.directory)?;
                Ok(())
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn clear_if_conversation(&self, conversation_id: &str) -> Result<bool, String> {
        let Some(lease) = self.load()? else {
            return Ok(false);
        };
        if lease.conversation_id != conversation_id {
            return Ok(false);
        }
        self.clear()?;
        Ok(true)
    }

    /// Classifies an orphaned lease at startup.
    ///
    /// Valid leases remain persisted so the UI can offer Restore or Resume.
    /// Expired and inconsistent leases are cleared before the decision is
    /// returned. Executor consistency is based only on exact catalog ID and
    /// `supports_vision == Some(true)`.
    pub fn recover_decision(
        &self,
        now_ms: u64,
        catalog: &[VerbooModel],
    ) -> Result<LeaseRecoveryDecision, String> {
        let bytes = match fs::read(&self.file_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(LeaseRecoveryDecision::NoLease)
            }
            Err(error) => return Err(error.to_string()),
        };
        let lease: VisualExecutorLease = match serde_json::from_slice(&bytes) {
            Ok(lease) => lease,
            Err(_) => {
                self.clear()?;
                return Ok(LeaseRecoveryDecision::ClearInconsistent {
                    reason: LeaseInconsistency::MalformedRecord,
                });
            }
        };

        if let Some(reason) = structural_inconsistency(&lease, now_ms) {
            self.clear()?;
            return recovery_for_inconsistent_lease(lease, reason);
        }
        if now_ms >= lease.expires_at_ms {
            self.clear()?;
            return Ok(LeaseRecoveryDecision::RestoreOriginal {
                original_model_id: lease.original_model_id,
                reason: LeaseRecoveryReason::Expired,
            });
        }
        let executor_is_available = catalog.iter().any(|model| {
            model.id == lease.executor_model_id && is_backend_verified_visual_executor(model)
        });
        if !executor_is_available {
            self.clear()?;
            return Ok(LeaseRecoveryDecision::RestoreOriginal {
                original_model_id: lease.original_model_id,
                reason: LeaseRecoveryReason::Inconsistent(
                    LeaseInconsistency::ExecutorUnavailableOrNotVisionCapable,
                ),
            });
        }

        Ok(LeaseRecoveryDecision::OfferRestoreOrResume { lease })
    }

    fn ensure_private_directory(&self) -> Result<(), String> {
        fs::create_dir_all(&self.directory).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.directory, fs::Permissions::from_mode(0o700))
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

fn structural_inconsistency(
    lease: &VisualExecutorLease,
    now_ms: u64,
) -> Option<LeaseInconsistency> {
    if lease.conversation_id.trim().is_empty() {
        return Some(LeaseInconsistency::EmptyConversationId);
    }
    if lease.original_model_id.trim().is_empty() {
        return Some(LeaseInconsistency::EmptyOriginalModelId);
    }
    if lease.executor_model_id.trim().is_empty() {
        return Some(LeaseInconsistency::EmptyExecutorModelId);
    }
    if lease.original_model_id == lease.executor_model_id {
        return Some(LeaseInconsistency::OriginalMatchesExecutor);
    }
    if lease.started_at_ms >= lease.expires_at_ms {
        return Some(LeaseInconsistency::InvalidLifetime);
    }
    if now_ms < lease.started_at_ms {
        return Some(LeaseInconsistency::StartedInFuture);
    }
    None
}

fn recovery_for_inconsistent_lease(
    lease: VisualExecutorLease,
    reason: LeaseInconsistency,
) -> Result<LeaseRecoveryDecision, String> {
    if lease.original_model_id.trim().is_empty() {
        return Ok(LeaseRecoveryDecision::ClearInconsistent { reason });
    }
    Ok(LeaseRecoveryDecision::RestoreOriginal {
        original_model_id: lease.original_model_id,
        reason: LeaseRecoveryReason::Inconsistent(reason),
    })
}

fn set_private_file_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(directory: &Path) -> Result<(), String> {
    fs::File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn sync_directory(_directory: &Path) -> Result<(), String> {
    Ok(())
}

fn sync_directory_if_present(directory: &Path) -> Result<(), String> {
    match sync_directory(directory) {
        Ok(()) => Ok(()),
        Err(_) if !directory.exists() => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use crate::models::types::VerbooModel;

    use super::{
        select_executor, ExecutorChoice, LeaseInconsistency, LeaseRecoveryDecision,
        LeaseRecoveryReason, VisualExecutorLease, VisualExecutorLeaseStore,
    };

    fn model(id: &str, supports_vision: Option<bool>) -> VerbooModel {
        VerbooModel {
            id: id.to_string(),
            display_name: format!("Display name for {id}"),
            context_window: None,
            max_output_tokens: None,
            supports_vision,
            vision_support_source: supports_vision.map(|_| "router".to_string()),
            reasoning: None,
            raw: serde_json::json!({"provider": "must-not-affect-selection"}),
        }
    }

    #[test]
    fn executor_selection_rejects_unverified_or_heuristic_vision_metadata() {
        for source in [None, Some("heuristic".to_string())] {
            let mut candidate = model("vision-by-name-only", Some(true));
            candidate.vision_support_source = source;

            assert!(
                select_executor("vision-by-name-only", &[candidate], None).is_err(),
                "Computer Use must require backend-proven vision metadata"
            );
        }
    }

    fn lease() -> VisualExecutorLease {
        VisualExecutorLease {
            conversation_id: "conversation-1".into(),
            original_model_id: "text-model".into(),
            executor_model_id: "vision-model".into(),
            started_at_ms: 1_000,
            expires_at_ms: 5_000,
        }
    }

    fn recovery_catalog() -> Vec<VerbooModel> {
        vec![
            model("text-model", Some(false)),
            model("vision-model", Some(true)),
        ]
    }

    #[test]
    fn current_vision_model_remains_the_executor_even_with_a_preference() {
        let catalog = vec![
            model("preferred-vision", Some(true)),
            model("current-vision", Some(true)),
        ];

        let choice = select_executor("current-vision", &catalog, Some("preferred-vision"))
            .expect("current vision model should be usable");

        assert_eq!(
            choice,
            ExecutorChoice::Current {
                model_id: "current-vision".into(),
            }
        );
    }

    #[test]
    fn non_vision_current_model_uses_a_valid_preferred_visual_executor() {
        let catalog = vec![
            model("text-model", Some(false)),
            model("first-vision", Some(true)),
            model("preferred-vision", Some(true)),
        ];

        let choice = select_executor("text-model", &catalog, Some("preferred-vision"))
            .expect("preferred visual executor should be usable");

        assert_eq!(
            choice,
            ExecutorChoice::TemporaryVision {
                original_model_id: "text-model".into(),
                vision_model_id: "preferred-vision".into(),
            }
        );
    }

    #[test]
    fn unknown_vision_support_also_requires_a_temporary_executor() {
        let catalog = vec![
            model("current-unknown", None),
            model("preferred-vision", Some(true)),
        ];

        let choice = select_executor("current-unknown", &catalog, Some("preferred-vision"))
            .expect("unknown vision support must fail closed to a visual executor");

        assert_eq!(
            choice,
            ExecutorChoice::TemporaryVision {
                original_model_id: "current-unknown".into(),
                vision_model_id: "preferred-vision".into(),
            }
        );
    }

    #[test]
    fn invalid_preference_falls_back_to_first_vision_model_in_catalog_order() {
        let mut catalog = vec![
            model("text-model", Some(false)),
            model("ordinary/first", Some(true)),
            model("ultra/vendor-looking", Some(true)),
            model("preferred-but-non-vision", Some(false)),
        ];
        catalog[1].display_name = "Z last alphabetically".into();
        catalog[1].raw = serde_json::json!({"provider": "ordinary"});
        catalog[2].display_name = "A first alphabetically".into();
        catalog[2].raw = serde_json::json!({"provider": "preferred-looking"});

        let choice = select_executor("text-model", &catalog, Some("preferred-but-non-vision"))
            .expect("catalog contains visual executors");

        assert_eq!(
            choice,
            ExecutorChoice::TemporaryVision {
                original_model_id: "text-model".into(),
                vision_model_id: "ordinary/first".into(),
            }
        );
    }

    #[test]
    fn absent_current_model_is_treated_as_unknown_and_uses_catalog_order() {
        let catalog = vec![
            model("first-vision", Some(true)),
            model("second-vision", Some(true)),
        ];

        let choice = select_executor("missing-current", &catalog, None)
            .expect("a visual executor is available");

        assert_eq!(
            choice,
            ExecutorChoice::TemporaryVision {
                original_model_id: "missing-current".into(),
                vision_model_id: "first-vision".into(),
            }
        );
    }

    #[test]
    fn no_vision_capable_model_returns_a_clear_error() {
        let catalog = vec![
            model("text-model", Some(false)),
            model("unknown-model", None),
        ];

        let error = select_executor("text-model", &catalog, None)
            .expect_err("computer use must not start without a visual executor");

        assert_eq!(
            error.to_string(),
            "Computer Use is unavailable because the model catalog has no vision-capable model."
        );
    }

    #[test]
    fn lease_round_trips_through_an_injected_private_store() {
        let directory = tempdir().unwrap();
        let store = VisualExecutorLeaseStore::new(directory.path());
        let expected = lease();

        store.persist(&expected).unwrap();

        assert_eq!(store.load().unwrap(), Some(expected));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(store.path()).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(directory.path()).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn persisting_a_replacement_is_atomic_and_leaves_no_temporary_file() {
        let directory = tempdir().unwrap();
        let store = VisualExecutorLeaseStore::new(directory.path());
        let first = lease();
        let mut replacement = first.clone();
        replacement.conversation_id = "conversation-2".into();

        store.persist(&first).unwrap();
        store.persist(&replacement).unwrap();

        assert_eq!(store.load().unwrap(), Some(replacement));
        let entries: Vec<_> = fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![store.path().file_name().unwrap()]);
    }

    #[test]
    fn clear_is_idempotent() {
        let directory = tempdir().unwrap();
        let store = VisualExecutorLeaseStore::new(directory.path());
        store.persist(&lease()).unwrap();

        store.clear().unwrap();
        store.clear().unwrap();

        assert_eq!(store.load().unwrap(), None);
    }

    #[test]
    fn clear_if_conversation_never_clears_another_conversation_lease() {
        let directory = tempdir().unwrap();
        let store = VisualExecutorLeaseStore::new(directory.path());
        store.persist(&lease()).unwrap();

        assert!(!store.clear_if_conversation("conversation-2").unwrap());
        assert!(store.load().unwrap().is_some());
        assert!(store.clear_if_conversation("conversation-1").unwrap());
        assert!(store.load().unwrap().is_none());
    }

    #[test]
    fn valid_recovery_offers_restore_or_resume_and_keeps_the_lease() {
        let directory = tempdir().unwrap();
        let store = VisualExecutorLeaseStore::new(directory.path());
        let expected = lease();
        store.persist(&expected).unwrap();

        let decision = store.recover_decision(2_000, &recovery_catalog()).unwrap();

        assert_eq!(
            decision,
            LeaseRecoveryDecision::OfferRestoreOrResume {
                lease: expected.clone(),
            }
        );
        assert_eq!(store.load().unwrap(), Some(expected));
    }

    #[test]
    fn expired_recovery_restores_original_and_clears_the_lease() {
        let directory = tempdir().unwrap();
        let store = VisualExecutorLeaseStore::new(directory.path());
        store.persist(&lease()).unwrap();

        let decision = store.recover_decision(5_000, &recovery_catalog()).unwrap();

        assert_eq!(
            decision,
            LeaseRecoveryDecision::RestoreOriginal {
                original_model_id: "text-model".into(),
                reason: LeaseRecoveryReason::Expired,
            }
        );
        assert_eq!(store.load().unwrap(), None);
    }

    #[test]
    fn inconsistent_recovery_restores_original_and_clears_the_lease() {
        let directory = tempdir().unwrap();
        let store = VisualExecutorLeaseStore::new(directory.path());
        let mut inconsistent = lease();
        inconsistent.executor_model_id = inconsistent.original_model_id.clone();
        fs::create_dir_all(directory.path()).unwrap();
        fs::write(store.path(), serde_json::to_vec(&inconsistent).unwrap()).unwrap();

        let decision = store.recover_decision(2_000, &recovery_catalog()).unwrap();

        assert_eq!(
            decision,
            LeaseRecoveryDecision::RestoreOriginal {
                original_model_id: "text-model".into(),
                reason: LeaseRecoveryReason::Inconsistent(
                    LeaseInconsistency::OriginalMatchesExecutor
                ),
            }
        );
        assert_eq!(store.load().unwrap(), None);
    }

    #[test]
    fn unavailable_executor_makes_recovery_inconsistent_and_clears_the_lease() {
        let directory = tempdir().unwrap();
        let store = VisualExecutorLeaseStore::new(directory.path());
        store.persist(&lease()).unwrap();
        let catalog = vec![
            model("text-model", Some(false)),
            model("vision-model", Some(false)),
        ];

        let decision = store.recover_decision(2_000, &catalog).unwrap();

        assert_eq!(
            decision,
            LeaseRecoveryDecision::RestoreOriginal {
                original_model_id: "text-model".into(),
                reason: LeaseRecoveryReason::Inconsistent(
                    LeaseInconsistency::ExecutorUnavailableOrNotVisionCapable
                ),
            }
        );
        assert_eq!(store.load().unwrap(), None);
    }

    #[test]
    fn malformed_recovery_is_cleared_without_inventing_an_original_model() {
        let directory = tempdir().unwrap();
        let store = VisualExecutorLeaseStore::new(directory.path());
        fs::create_dir_all(directory.path()).unwrap();
        fs::write(store.path(), b"not-json").unwrap();

        let decision = store.recover_decision(2_000, &recovery_catalog()).unwrap();

        assert_eq!(
            decision,
            LeaseRecoveryDecision::ClearInconsistent {
                reason: LeaseInconsistency::MalformedRecord,
            }
        );
        assert_eq!(store.load().unwrap(), None);
    }
}
