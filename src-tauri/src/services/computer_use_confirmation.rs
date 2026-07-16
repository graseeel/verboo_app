use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const CONFIRMATION_TTL_SECONDS: u64 = 120;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingConfirmation {
    pub id: String,
    pub session_id: String,
    pub app_bundle_id: String,
    pub action: String,
    pub summary: String,
    pub fingerprint: String,
    pub created_at: u64,
    pub expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingConfirmationView {
    pub id: String,
    pub session_id: String,
    pub app_bundle_id: String,
    pub action: String,
    pub summary: String,
    pub created_at: u64,
    pub expires_at: u64,
}

impl PendingConfirmation {
    pub fn renderer_view(&self) -> PendingConfirmationView {
        PendingConfirmationView {
            id: self.id.clone(),
            session_id: self.session_id.clone(),
            app_bundle_id: self.app_bundle_id.clone(),
            action: self.action.clone(),
            summary: self.summary.clone(),
            created_at: self.created_at,
            expires_at: self.expires_at,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum StoredDecision {
    Approved,
    Denied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ConfirmationReceipt {
    session_id: String,
    fingerprint: String,
    decision: StoredDecision,
    expires_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmationConsumption {
    Approved,
    Denied,
    Missing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmationWaitOutcome {
    Approved,
    Denied,
    Expired,
    AuthorityRevoked,
}

#[derive(Debug, Clone)]
pub struct ConfirmationStore {
    directory: PathBuf,
}

impl ConfirmationStore {
    pub fn runtime() -> Result<Self, String> {
        let base = dirs::data_dir().ok_or("no application data directory")?;
        Ok(Self::at(
            base.join("ai.verboo.code.desktop")
                .join("computer-use-runtime"),
        ))
    }

    pub(crate) fn at(directory: PathBuf) -> Self {
        Self { directory }
    }

    fn pending_path(&self) -> PathBuf {
        self.directory.join("pending-confirmation.json")
    }

    fn receipt_path(&self) -> PathBuf {
        self.directory.join("confirmation-receipt.json")
    }

    pub fn request(
        &self,
        session_id: &str,
        app_bundle_id: &str,
        action: &str,
        summary: &str,
        fingerprint: &str,
    ) -> Result<PendingConfirmation, String> {
        if let Some(existing) = self.pending(session_id)? {
            if existing.fingerprint == fingerprint {
                return Ok(existing);
            }
        }
        let created_at = now();
        let pending = PendingConfirmation {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            app_bundle_id: app_bundle_id.to_string(),
            action: action.to_string(),
            summary: summary.to_string(),
            fingerprint: fingerprint.to_string(),
            created_at,
            expires_at: created_at.saturating_add(CONFIRMATION_TTL_SECONDS),
        };
        write_private_atomic(&self.pending_path(), &pending)?;
        Ok(pending)
    }

    pub fn pending(&self, session_id: &str) -> Result<Option<PendingConfirmation>, String> {
        let path = self.pending_path();
        let Some(pending) = read_optional::<PendingConfirmation>(&path)? else {
            return Ok(None);
        };
        if pending.expires_at <= now() {
            let _ = fs::remove_file(path);
            return Ok(None);
        }
        Ok((pending.session_id == session_id).then_some(pending))
    }

    pub fn decide(
        &self,
        session_id: &str,
        confirmation_id: &str,
        allow: bool,
    ) -> Result<(), String> {
        let pending = self
            .pending(session_id)?
            .ok_or("confirmation is missing or expired")?;
        if pending.id != confirmation_id {
            return Err("confirmation id does not match the pending action".into());
        }
        let receipt = ConfirmationReceipt {
            session_id: pending.session_id,
            fingerprint: pending.fingerprint,
            decision: if allow {
                StoredDecision::Approved
            } else {
                StoredDecision::Denied
            },
            expires_at: now().saturating_add(CONFIRMATION_TTL_SECONDS),
        };
        write_private_atomic(&self.receipt_path(), &receipt)?;
        remove_if_exists(&self.pending_path())
    }

    pub fn consume(
        &self,
        session_id: &str,
        fingerprint: &str,
    ) -> Result<ConfirmationConsumption, String> {
        let path = self.receipt_path();
        let Some(receipt) = read_optional::<ConfirmationReceipt>(&path)? else {
            return Ok(ConfirmationConsumption::Missing);
        };
        if receipt.expires_at <= now() {
            let _ = fs::remove_file(path);
            return Ok(ConfirmationConsumption::Missing);
        }
        if receipt.session_id != session_id || receipt.fingerprint != fingerprint {
            return Ok(ConfirmationConsumption::Missing);
        }

        // Atomically claim the receipt before interpreting it. A read followed
        // by remove lets two MCP processes consume the same one-shot approval.
        // rename(2) gives exactly one caller ownership of the receipt file.
        let claim_path = self
            .directory
            .join(format!(".confirmation-claim-{}.json", Uuid::new_v4()));
        match fs::rename(&path, &claim_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ConfirmationConsumption::Missing)
            }
            Err(error) => return Err(error.to_string()),
        }
        let claimed = read_optional::<ConfirmationReceipt>(&claim_path)?
            .ok_or("claimed confirmation receipt disappeared")?;
        remove_if_exists(&claim_path)?;
        if claimed.expires_at <= now()
            || claimed.session_id != session_id
            || claimed.fingerprint != fingerprint
        {
            return Ok(ConfirmationConsumption::Missing);
        }
        Ok(match claimed.decision {
            StoredDecision::Approved => ConfirmationConsumption::Approved,
            StoredDecision::Denied => ConfirmationConsumption::Denied,
        })
    }

    pub fn wait_for_decision<F>(
        &self,
        pending: &PendingConfirmation,
        authority_is_active: F,
    ) -> Result<ConfirmationWaitOutcome, String>
    where
        F: FnMut() -> bool,
    {
        self.wait_for_decision_with_poll(pending, Duration::from_millis(50), authority_is_active)
    }

    fn wait_for_decision_with_poll<F>(
        &self,
        pending: &PendingConfirmation,
        poll_interval: Duration,
        mut authority_is_active: F,
    ) -> Result<ConfirmationWaitOutcome, String>
    where
        F: FnMut() -> bool,
    {
        let poll_interval = poll_interval.max(Duration::from_millis(1));
        loop {
            if !authority_is_active() {
                self.clear_session(&pending.session_id)?;
                return Ok(ConfirmationWaitOutcome::AuthorityRevoked);
            }

            match self.consume(&pending.session_id, &pending.fingerprint)? {
                ConfirmationConsumption::Approved => {
                    if !authority_is_active() {
                        self.clear_session(&pending.session_id)?;
                        return Ok(ConfirmationWaitOutcome::AuthorityRevoked);
                    }
                    return Ok(ConfirmationWaitOutcome::Approved);
                }
                ConfirmationConsumption::Denied => {
                    return Ok(ConfirmationWaitOutcome::Denied);
                }
                ConfirmationConsumption::Missing => {}
            }

            match self.pending(&pending.session_id)? {
                Some(current)
                    if current.id == pending.id && current.fingerprint == pending.fingerprint => {}
                Some(_) => {
                    self.clear_session(&pending.session_id)?;
                    return Err("pending confirmation changed while the action was waiting".into());
                }
                None => {
                    // `decide` writes the receipt before removing the pending
                    // file. Re-check once to close the narrow inter-process
                    // race between the first consume and this pending read.
                    return match self.consume(&pending.session_id, &pending.fingerprint)? {
                        ConfirmationConsumption::Approved if authority_is_active() => {
                            Ok(ConfirmationWaitOutcome::Approved)
                        }
                        ConfirmationConsumption::Approved => {
                            self.clear_session(&pending.session_id)?;
                            Ok(ConfirmationWaitOutcome::AuthorityRevoked)
                        }
                        ConfirmationConsumption::Denied => Ok(ConfirmationWaitOutcome::Denied),
                        ConfirmationConsumption::Missing => Ok(ConfirmationWaitOutcome::Expired),
                    };
                }
            }

            thread::sleep(poll_interval);
        }
    }

    pub fn clear_session(&self, session_id: &str) -> Result<(), String> {
        if self.pending(session_id)?.is_some() {
            remove_if_exists(&self.pending_path())?;
        }
        if let Some(receipt) = read_optional::<ConfirmationReceipt>(&self.receipt_path())? {
            if receipt.session_id == session_id {
                remove_if_exists(&self.receipt_path())?;
            }
        }
        Ok(())
    }
}

fn read_optional<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn write_private_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path.parent().ok_or("confirmation path has no parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".confirmation-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Barrier,
    };
    use std::time::Duration;

    #[test]
    fn approval_is_bound_to_one_exact_action_and_consumed_once() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfirmationStore::at(directory.path().to_path_buf());
        let pending = store
            .request(
                "session-1",
                "com.apple.Notes",
                "left_click",
                "Activate AXButton control 'Send'",
                "fingerprint-1",
            )
            .unwrap();
        assert_eq!(store.pending("session-1").unwrap().unwrap().id, pending.id);
        store.decide("session-1", &pending.id, true).unwrap();
        assert!(store.pending("session-1").unwrap().is_none());
        assert_eq!(
            store.consume("session-1", "fingerprint-1").unwrap(),
            ConfirmationConsumption::Approved,
        );
        assert_eq!(
            store.consume("session-1", "fingerprint-1").unwrap(),
            ConfirmationConsumption::Missing,
        );
    }

    #[test]
    fn approval_cannot_authorize_a_different_action() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfirmationStore::at(directory.path().to_path_buf());
        let pending = store
            .request("session-1", "com.apple.Notes", "left_click", "Send", "one")
            .unwrap();
        store.decide("session-1", &pending.id, true).unwrap();
        assert_eq!(
            store.consume("session-1", "two").unwrap(),
            ConfirmationConsumption::Missing,
        );
        assert_eq!(
            store.consume("session-1", "one").unwrap(),
            ConfirmationConsumption::Approved,
        );
    }

    #[test]
    fn denial_is_returned_once_and_stale_ids_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfirmationStore::at(directory.path().to_path_buf());
        let pending = store
            .request(
                "session-1",
                "com.apple.Notes",
                "left_click",
                "Delete",
                "delete",
            )
            .unwrap();
        assert!(store.decide("session-1", "wrong", false).is_err());
        store.decide("session-1", &pending.id, false).unwrap();
        assert_eq!(
            store.consume("session-1", "delete").unwrap(),
            ConfirmationConsumption::Denied,
        );
        assert_eq!(
            store.consume("session-1", "delete").unwrap(),
            ConfirmationConsumption::Missing,
        );
    }

    #[test]
    fn renderer_view_never_exposes_the_action_fingerprint() {
        let pending = PendingConfirmation {
            id: "confirmation-1".into(),
            session_id: "session-1".into(),
            app_bundle_id: "com.apple.Notes".into(),
            action: "left_click".into(),
            summary: "Delete".into(),
            fingerprint: "secret-action-fingerprint".into(),
            created_at: 1,
            expires_at: 2,
        };

        let value = serde_json::to_value(pending.renderer_view()).unwrap();
        assert_eq!(value["sessionId"], "session-1");
        assert!(value.get("fingerprint").is_none());
        assert!(!value.to_string().contains("secret-action-fingerprint"));
    }

    #[test]
    fn concurrent_consumers_cannot_reuse_one_approval() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfirmationStore::at(directory.path().to_path_buf());
        let pending = store
            .request(
                "session-1",
                "com.apple.Notes",
                "left_click",
                "Send",
                "one-shot",
            )
            .unwrap();
        store.decide("session-1", &pending.id, true).unwrap();

        let barrier = Arc::new(Barrier::new(3));
        let handles = (0..2)
            .map(|_| {
                let store = store.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    store.consume("session-1", "one-shot").unwrap()
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let results = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(
            results
                .iter()
                .filter(|result| **result == ConfirmationConsumption::Approved)
                .count(),
            1,
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| **result == ConfirmationConsumption::Missing)
                .count(),
            1,
        );
    }

    #[test]
    fn same_invocation_waits_for_approval_and_then_resumes() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfirmationStore::at(directory.path().to_path_buf());
        let pending = store
            .request(
                "session-1",
                "com.apple.Calculator",
                "left_click",
                "Activate the 1 button",
                "calculator-one",
            )
            .unwrap();
        let waiter_store = store.clone();
        let waiter_pending = pending.clone();
        let (result_tx, result_rx) = mpsc::channel();
        let waiter = std::thread::spawn(move || {
            let result = waiter_store.wait_for_decision_with_poll(
                &waiter_pending,
                Duration::from_millis(5),
                || true,
            );
            result_tx.send(result).unwrap();
        });

        assert!(result_rx.recv_timeout(Duration::from_millis(40)).is_err());
        store.decide("session-1", &pending.id, true).unwrap();
        assert_eq!(
            result_rx
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .unwrap(),
            ConfirmationWaitOutcome::Approved,
        );
        waiter.join().unwrap();
        assert!(store.pending("session-1").unwrap().is_none());
        assert_eq!(
            store.consume("session-1", "calculator-one").unwrap(),
            ConfirmationConsumption::Missing,
        );
    }

    #[test]
    fn same_invocation_returns_denial_without_authorizing_the_action() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfirmationStore::at(directory.path().to_path_buf());
        let pending = store
            .request(
                "session-1",
                "com.apple.Calculator",
                "left_click",
                "Activate the 1 button",
                "calculator-one",
            )
            .unwrap();
        let waiter_store = store.clone();
        let waiter_pending = pending.clone();
        let waiter = std::thread::spawn(move || {
            waiter_store.wait_for_decision_with_poll(
                &waiter_pending,
                Duration::from_millis(5),
                || true,
            )
        });

        store.decide("session-1", &pending.id, false).unwrap();
        assert_eq!(
            waiter.join().unwrap().unwrap(),
            ConfirmationWaitOutcome::Denied,
        );
        assert_eq!(
            store.consume("session-1", "calculator-one").unwrap(),
            ConfirmationConsumption::Missing,
        );
    }

    #[test]
    fn revoked_authority_cancels_the_wait_and_clears_pending_state() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfirmationStore::at(directory.path().to_path_buf());
        let pending = store
            .request(
                "session-1",
                "com.apple.Calculator",
                "left_click",
                "Activate the 1 button",
                "calculator-one",
            )
            .unwrap();
        let authority_active = Arc::new(AtomicBool::new(true));
        let waiter_active = Arc::clone(&authority_active);
        let waiter_store = store.clone();
        let waiter_pending = pending.clone();
        let waiter = std::thread::spawn(move || {
            waiter_store.wait_for_decision_with_poll(
                &waiter_pending,
                Duration::from_millis(5),
                || waiter_active.load(Ordering::SeqCst),
            )
        });

        authority_active.store(false, Ordering::SeqCst);
        assert_eq!(
            waiter.join().unwrap().unwrap(),
            ConfirmationWaitOutcome::AuthorityRevoked,
        );
        assert!(store.pending("session-1").unwrap().is_none());
    }

    #[test]
    fn expired_confirmation_fails_closed_without_waiting() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfirmationStore::at(directory.path().to_path_buf());
        let mut pending = store
            .request(
                "session-1",
                "com.apple.Calculator",
                "left_click",
                "Activate the 1 button",
                "calculator-one",
            )
            .unwrap();
        pending.expires_at = now();
        write_private_atomic(&store.pending_path(), &pending).unwrap();

        assert_eq!(
            store
                .wait_for_decision_with_poll(&pending, Duration::from_millis(5), || true)
                .unwrap(),
            ConfirmationWaitOutcome::Expired,
        );
        assert!(store.pending("session-1").unwrap().is_none());
    }
}
