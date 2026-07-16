//! Computer Use AuditWriter (Kratos arch §6).
//!
//! Append-only SQLite audit log at:
//!   ~/Library/Application Support/ai.verboo.code.desktop/computer_use.audit.db
//!
//! Separate from main app DB (Q5). Audit events are append-only; retention may
//! delete only a verified chronological prefix and records its terminal hash
//! in a durable anchor before the deletion commits.
//! Hash chain (prev_hash + row_hash) for tamper detection.
//! On launch: verify every row matches the recomputed chain.
//!
//! Mirror to os_log on macOS for post-uninstall tamper evidence (Q6).
//! (os_log mirror deferred to P0.2b — current impl uses stderr as placeholder.)

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::models::computer_use::AuditRow;

const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS audit (
    -- Identity
    rowid                       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_mono                     INTEGER NOT NULL,
    ts_wall                     INTEGER NOT NULL,
    session_id                  TEXT    NOT NULL,
    conversation_id             TEXT,
    turn_id                     TEXT,
    -- Origin
    actor                       TEXT    NOT NULL,    -- 'user' | 'agent'
    app_bundle_id               TEXT,
    window_title                TEXT,
    -- Action
    action_type                 TEXT    NOT NULL,
    action_summary              TEXT,
    action_args                 TEXT,                  -- JSON; secrets redacted
    -- Outcome
    outcome                     TEXT    NOT NULL,    -- pending|success|denied|blocked|error|aborted|stale|paused|rate_limited
    result_detail               TEXT,
    -- Payload
    bytes                       INTEGER,
    thumbnail_hash              TEXT,
    screenshot_path             TEXT,
    screenshot_attach_to_llm    INTEGER NOT NULL DEFAULT 0,
    is_self_test                INTEGER NOT NULL DEFAULT 0,
    screenshot_id               TEXT,
    screenshot_pruned_ids       TEXT,
    -- Integrity
    prev_hash                   TEXT    NOT NULL,
    row_hash                    TEXT    NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts_wall ON audit(ts_wall);
CREATE INDEX IF NOT EXISTS idx_audit_action_type ON audit(action_type);
CREATE INDEX IF NOT EXISTS idx_audit_outcome ON audit(outcome);

CREATE TABLE IF NOT EXISTS audit_state (
    singleton                    INTEGER PRIMARY KEY CHECK (singleton = 1),
    anchor_rowid                 INTEGER NOT NULL DEFAULT 0,
    anchor_hash                  TEXT    NOT NULL,
    retention_days               INTEGER NOT NULL DEFAULT 90,
    storage_cap_bytes            INTEGER NOT NULL DEFAULT 209715200
);
";

const INSERT_SQL: &str = "
INSERT INTO audit (
    ts_mono, ts_wall, session_id, conversation_id, turn_id,
    actor, app_bundle_id, window_title,
    action_type, action_summary, action_args,
    outcome, result_detail,
    bytes, thumbnail_hash, screenshot_path, screenshot_attach_to_llm, is_self_test,
    screenshot_id, screenshot_pruned_ids,
    prev_hash, row_hash
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
";

const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const DEFAULT_RETENTION_DAYS: u32 = 90;
const DEFAULT_STORAGE_CAP_BYTES: u64 = 200 * 1024 * 1024;
const SECONDS_PER_DAY: u64 = 24 * 60 * 60;
const MIN_APPEND_RESERVE_BYTES: u64 = 4 * 1024;
const SCREENSHOT_RETENTION_HASH_VERSION: &str = "screenshot-retention-v1";

pub struct AuditWriter {
    conn: Mutex<Connection>,
    db_path: PathBuf,
    screenshot_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandoffAuditEvent {
    pub action_type: String,
    pub app_bundle_id: String,
    pub summary: Option<String>,
    pub outcome: String,
    pub actor: String,
}

#[derive(Debug, Clone)]
struct ScreenshotAuditMetadata {
    screenshot_id: String,
    pruned_ids_json: String,
}

/// Audit-backed handoff rows produced while holding the audit connection lock
/// after the complete hash chain has been verified. The fields are private so
/// callers cannot manufacture "verified" evidence from untrusted screen data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedHandoffAuditEvidence {
    events: Vec<HandoffAuditEvent>,
    verified_through_rowid: Option<i64>,
}

impl VerifiedHandoffAuditEvidence {
    pub fn events(&self) -> &[HandoffAuditEvent] {
        &self.events
    }

    #[cfg(test)]
    pub fn into_events(self) -> Vec<HandoffAuditEvent> {
        self.events
    }

    #[cfg(test)]
    pub fn verified_through_rowid(&self) -> Option<i64> {
        self.verified_through_rowid
    }
}

#[derive(Debug)]
pub enum AuditError {
    Db(String),
    StorageFull {
        current_bytes: u64,
        cap_bytes: u64,
    },
    HashChainBroken {
        expected: String,
        found: String,
        at_rowid: i64,
    },
}

impl std::fmt::Display for AuditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuditError::Db(s) => write!(f, "audit db error: {s}"),
            AuditError::StorageFull {
                current_bytes,
                cap_bytes,
            } => write!(
                f,
                "audit storage full: current={current_bytes} cap={cap_bytes}"
            ),
            AuditError::HashChainBroken {
                expected,
                found,
                at_rowid,
            } => {
                write!(
                    f,
                    "hash chain broken at rowid={at_rowid}: expected={expected} found={found}"
                )
            }
        }
    }
}

impl std::error::Error for AuditError {}

impl AuditWriter {
    #[cfg(test)]
    pub fn count_for_session(&self, session_id: &str) -> Result<u64, AuditError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AuditError::Db("audit mutex poisoned".into()))?;
        conn.query_row(
            "SELECT COUNT(*) FROM audit WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|e| AuditError::Db(e.to_string()))
    }

    #[cfg(test)]
    pub fn handoff_events_for_session(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<HandoffAuditEvent>, AuditError> {
        self.verified_handoff_evidence_for_session(session_id, limit)
            .map(VerifiedHandoffAuditEvidence::into_events)
    }

    /// Produce session-scoped handoff evidence only after validating every
    /// audit row. Verification and selection happen in one SQLite read
    /// transaction, so concurrent writers cannot move the evidence beyond its
    /// precise verified-through boundary.
    pub fn verified_handoff_evidence_for_session(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<VerifiedHandoffAuditEvidence, AuditError> {
        let limit = limit.clamp(1, 100) as i64;
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| AuditError::Db("audit mutex poisoned".into()))?;
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(|error| AuditError::Db(format!("begin handoff verification: {error}")))?;
        let verified_through_rowid = verify_chain_locked(&transaction)?;
        let events = {
            let mut statement = transaction
                .prepare(
                    "SELECT action_type, COALESCE(app_bundle_id, ''), outcome, actor
                     FROM (
                        SELECT rowid, action_type, app_bundle_id, outcome, actor
                        FROM audit
                        WHERE session_id = ?1
                          AND NOT (
                            action_type IN ('confirmation_approved', 'confirmation_denied')
                            AND actor <> 'user'
                          )
                        ORDER BY rowid DESC
                        LIMIT ?2
                     )
                     ORDER BY rowid ASC",
                )
                .map_err(|error| AuditError::Db(error.to_string()))?;
            let rows = statement
                .query_map(rusqlite::params![session_id, limit], |row| {
                    Ok(HandoffAuditEvent {
                        action_type: row.get(0)?,
                        app_bundle_id: row.get(1)?,
                        // Screen-derived labels and titles remain in the audit DB;
                        // they never cross the trusted-handoff boundary.
                        summary: None,
                        outcome: row.get(2)?,
                        actor: row.get(3)?,
                    })
                })
                .map_err(|error| AuditError::Db(error.to_string()))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| AuditError::Db(error.to_string()))?
        };
        transaction
            .commit()
            .map_err(|error| AuditError::Db(format!("commit handoff verification: {error}")))?;
        Ok(VerifiedHandoffAuditEvidence {
            events,
            verified_through_rowid,
        })
    }

    /// Open (or create) the audit DB at the canonical path.
    pub fn open() -> Result<Self, AuditError> {
        let path = Self::db_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AuditError::Db(format!("create db dir: {e}")))?;
        }
        let conn = Connection::open(&path)
            .map_err(|e| AuditError::Db(format!("open {}: {e}", path.display())))?;

        // Insert-only discipline — apply via PRAGMA.
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| AuditError::Db(format!("WAL: {e}")))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| AuditError::Db(format!("sync: {e}")))?;

        conn.execute_batch(SCHEMA_SQL)
            .map_err(|e| AuditError::Db(format!("schema: {e}")))?;
        ensure_screenshot_retention_schema(&conn)?;
        initialize_audit_state(&conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
            screenshot_dir: screenshot_dir_for_db(&path),
            db_path: path,
        })
    }

    /// Canonical audit DB path (Kratos arch §6.1).
    pub fn db_path() -> PathBuf {
        let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
        base.join("ai.verboo.code.desktop")
            .join("computer_use.audit.db")
    }

    fn fetch_last_hash(conn: &Connection) -> Result<String, AuditError> {
        let mut stmt = conn
            .prepare("SELECT row_hash FROM audit ORDER BY rowid DESC LIMIT 1")
            .map_err(|e| AuditError::Db(format!("fetch last hash: {e}")))?;
        let hash: Option<String> = stmt
            .query_row([], |row| row.get(0))
            .optional()
            .map_err(|e| AuditError::Db(format!("fetch last hash row: {e}")))?;
        match hash {
            Some(hash) if is_sha256_hex(&hash) => Ok(hash),
            Some(_) => Err(AuditError::Db(
                "last audit hash is malformed; refusing to extend the chain".into(),
            )),
            None => read_anchor(conn).map(|(_, hash)| hash),
        }
    }

    /// Verify the complete hash chain oldest-to-newest. Query and decode
    /// failures are errors; malformed rows are never skipped.
    pub fn verify_chain(&self) -> Result<(), AuditError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AuditError::Db("audit mutex poisoned".into()))?;
        verify_chain_locked(&conn)?;
        Ok(())
    }

    /// Apply local retention/cap policy before consent can be requested.
    /// Only a fully verified expired prefix is eligible for deletion.
    pub fn configure_policy(
        &self,
        retention_days: u32,
        storage_cap_bytes: u64,
    ) -> Result<usize, AuditError> {
        let now_wall = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        self.configure_policy_at(retention_days, storage_cap_bytes, now_wall)
    }

    fn configure_policy_at(
        &self,
        retention_days: u32,
        storage_cap_bytes: u64,
        now_wall: u64,
    ) -> Result<usize, AuditError> {
        let retention_days = retention_days.clamp(7, 365);
        let storage_cap_bytes = storage_cap_bytes.max(1).min(i64::MAX as u64);
        let cutoff = now_wall.saturating_sub(u64::from(retention_days) * SECONDS_PER_DAY);
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| AuditError::Db("audit mutex poisoned".into()))?;
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| AuditError::Db(format!("begin retention: {error}")))?;
        verify_chain_locked(&transaction)?;

        let mut last_expired: Option<(i64, String)> = None;
        let mut candidate_paths = Vec::new();
        {
            let mut statement = transaction
                .prepare(
                    "SELECT rowid, ts_wall, row_hash, screenshot_path
                     FROM audit ORDER BY rowid ASC",
                )
                .map_err(|error| AuditError::Db(format!("retention prepare: {error}")))?;
            let mut rows = statement
                .query([])
                .map_err(|error| AuditError::Db(format!("retention query: {error}")))?;
            while let Some(row) = rows
                .next()
                .map_err(|error| AuditError::Db(format!("retention row: {error}")))?
            {
                let rowid: i64 = row
                    .get(0)
                    .map_err(|error| AuditError::Db(format!("retention rowid: {error}")))?;
                let ts_wall: i64 = row
                    .get(1)
                    .map_err(|error| AuditError::Db(format!("retention timestamp: {error}")))?;
                if ts_wall < 0 || ts_wall as u64 >= cutoff {
                    break;
                }
                let row_hash: String = row
                    .get(2)
                    .map_err(|error| AuditError::Db(format!("retention hash: {error}")))?;
                let screenshot_path: Option<String> = row
                    .get(3)
                    .map_err(|error| AuditError::Db(format!("retention screenshot: {error}")))?;
                if let Some(path) = screenshot_path {
                    candidate_paths.push(PathBuf::from(path));
                }
                last_expired = Some((rowid, row_hash));
            }
        }

        let pruned = if let Some((anchor_rowid, anchor_hash)) = last_expired {
            transaction
                .execute(
                    "UPDATE audit_state
                     SET anchor_rowid = ?1, anchor_hash = ?2,
                         retention_days = ?3, storage_cap_bytes = ?4
                     WHERE singleton = 1",
                    rusqlite::params![
                        anchor_rowid,
                        anchor_hash,
                        i64::from(retention_days),
                        storage_cap_bytes as i64,
                    ],
                )
                .map_err(|error| AuditError::Db(format!("update retention anchor: {error}")))?;
            transaction
                .execute("DELETE FROM audit WHERE rowid <= ?1", [anchor_rowid])
                .map_err(|error| AuditError::Db(format!("delete retained prefix: {error}")))?
        } else {
            transaction
                .execute(
                    "UPDATE audit_state
                     SET retention_days = ?1, storage_cap_bytes = ?2
                     WHERE singleton = 1",
                    rusqlite::params![i64::from(retention_days), storage_cap_bytes as i64],
                )
                .map_err(|error| AuditError::Db(format!("update audit policy: {error}")))?;
            0
        };
        transaction
            .commit()
            .map_err(|error| AuditError::Db(format!("commit retention: {error}")))?;
        drop(conn);

        self.remove_unreferenced_screenshots(candidate_paths)?;
        self.sweep_orphan_screenshots()?;
        Ok(pruned)
    }

    #[cfg(test)]
    pub fn storage_usage_bytes(&self) -> Result<u64, AuditError> {
        storage_usage_bytes(&self.db_path, &self.screenshot_dir)
    }

    pub fn ensure_capacity(&self, reserve_bytes: u64) -> Result<(), AuditError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AuditError::Db("audit mutex poisoned".into()))?;
        let (_, cap_bytes) = read_policy(&conn)?;
        let current_bytes = storage_usage_bytes(&self.db_path, &self.screenshot_dir)?;
        if current_bytes.saturating_add(reserve_bytes) >= cap_bytes {
            return Err(AuditError::StorageFull {
                current_bytes,
                cap_bytes,
            });
        }
        Ok(())
    }

    fn remove_unreferenced_screenshots(&self, candidates: Vec<PathBuf>) -> Result<(), AuditError> {
        if candidates.is_empty() {
            return Ok(());
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| AuditError::Db("audit mutex poisoned".into()))?;
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| AuditError::Db(format!("begin screenshot sweep: {error}")))?;
        verify_chain_locked(&transaction)?;
        let protected = protected_screenshot_paths(&transaction)?;
        let expected_parent = normalized_absolute(&self.screenshot_dir)?;
        for candidate in candidates.into_iter().collect::<HashSet<_>>() {
            if protected.contains(&candidate) {
                continue;
            }
            let Some(parent) = candidate.parent() else {
                continue;
            };
            if normalized_absolute(parent)? != expected_parent {
                continue;
            }
            match fs::remove_file(&candidate) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(AuditError::Db(format!(
                        "remove expired screenshot {}: {error}",
                        candidate.display()
                    )))
                }
            }
        }
        transaction
            .commit()
            .map_err(|error| AuditError::Db(format!("commit screenshot sweep: {error}")))?;
        Ok(())
    }

    pub fn sweep_orphan_screenshots(&self) -> Result<(), AuditError> {
        match fs::symlink_metadata(&self.screenshot_dir) {
            Ok(metadata) if metadata.file_type().is_dir() => {
                set_private_directory_permissions(&self.screenshot_dir)?;
            }
            Ok(_) => {
                return Err(AuditError::Db(
                    "screenshot storage is not a private directory".into(),
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(AuditError::Db(format!(
                    "inspect screenshot storage: {error}"
                )))
            }
        }
        let candidates = match fs::read_dir(&self.screenshot_dir) {
            Ok(entries) => entries
                .map(|entry| {
                    entry
                        .map(|entry| entry.path())
                        .map_err(|error| AuditError::Db(format!("read screenshot entry: {error}")))
                })
                .collect::<Result<Vec<_>, _>>()?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                return Err(AuditError::Db(format!(
                    "read screenshot directory {}: {error}",
                    self.screenshot_dir.display()
                )))
            }
        };
        self.remove_unreferenced_screenshots(candidates)
    }

    /// Append a row. Computes row_hash from prev_hash + canonical(row fields).
    /// On hash computation failure or DB error, returns Err — caller MUST
    /// refuse the action (failure-safe).
    pub fn append(&self, row: AuditRow) -> Result<(), AuditError> {
        self.append_internal(row, None, None)
    }

    /// Atomically bind a validated, already-filtered PNG to its success row.
    /// The filesystem write happens while the same cross-process SQLite writer
    /// lock protects the hash-chain append. A failed insert removes a newly
    /// created orphan before returning fail-closed.
    #[cfg(test)]
    pub fn append_with_screenshot(&self, row: AuditRow, png: &[u8]) -> Result<(), AuditError> {
        if !png.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
            return Err(AuditError::Db(
                "validated screenshot payload is not a PNG".into(),
            ));
        }
        self.append_internal(row, Some(png), None)
    }

    /// Persist one engine-verified screenshot together with its opaque id and
    /// the ids evicted from the bounded visual registry. Both fields extend
    /// the append-only row hash, so productive evidence pruning never relies
    /// on mutable, unaudited bookkeeping.
    pub fn append_verified_screenshot(
        &self,
        row: AuditRow,
        screenshot_id: &str,
        pruned_screenshot_ids: &[String],
        png: &[u8],
    ) -> Result<(), AuditError> {
        if !png.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
            return Err(AuditError::Db(
                "validated screenshot payload is not a PNG".into(),
            ));
        }
        let metadata = screenshot_audit_metadata(screenshot_id, pruned_screenshot_ids)?;
        let session_id = row.session_id.clone();
        self.append_internal(row, Some(png), Some(&metadata))?;
        self.remove_pruned_screenshot_evidence(&session_id, pruned_screenshot_ids)
    }

    fn append_internal(
        &self,
        mut row: AuditRow,
        screenshot_png: Option<&[u8]>,
        screenshot_metadata: Option<&ScreenshotAuditMetadata>,
    ) -> Result<(), AuditError> {
        // The desktop process and the MCP subprocess write to the same database.
        // BEGIN IMMEDIATE serializes the read-current-hash + insert sequence
        // across processes, so no writer can build a row from a stale hash.
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| AuditError::Db("audit mutex poisoned".into()))?;
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| AuditError::Db(format!("begin append: {e}")))?;
        let screenshot = screenshot_png
            .map(|png| prepare_screenshot(&self.screenshot_dir, png))
            .transpose()?;
        if let Some(screenshot) = &screenshot {
            row.bytes = Some(i64::try_from(screenshot.bytes).map_err(|_| {
                AuditError::Db("screenshot is too large for audit metadata".into())
            })?);
            row.thumbnail_hash = Some(screenshot.hash.clone());
            row.screenshot_path = Some(screenshot.path.to_string_lossy().into_owned());
        }
        let (_, storage_cap_bytes) = read_policy(&transaction)?;
        let current_bytes = storage_usage_bytes(&self.db_path, &self.screenshot_dir)?;
        let file_reserve = screenshot
            .as_ref()
            .filter(|prepared| !prepared.existed)
            .map(|prepared| prepared.bytes)
            .unwrap_or(0);
        let reserve = (canonical_bytes(&row, screenshot_metadata).len() as u64)
            .max(MIN_APPEND_RESERVE_BYTES)
            .saturating_add(file_reserve);
        if current_bytes.saturating_add(reserve) >= storage_cap_bytes {
            return Err(AuditError::StorageFull {
                current_bytes,
                cap_bytes: storage_cap_bytes,
            });
        }
        row.prev_hash = Self::fetch_last_hash(&transaction)?;
        let canonical = canonical_bytes(&row, screenshot_metadata);
        row.row_hash = hash_row(&row.prev_hash, &canonical);

        let created_screenshot = if let Some(prepared) = &screenshot {
            persist_prepared_screenshot(prepared, screenshot_png.unwrap_or_default())?
        } else {
            false
        };

        if let Err(error) = transaction.execute(
            INSERT_SQL,
            rusqlite::params![
                row.ts_mono as i64,
                row.ts_wall as i64,
                row.session_id,
                row.conversation_id,
                row.turn_id,
                actor_str(row.actor),
                row.app_bundle_id,
                row.window_title,
                row.action_type,
                row.action_summary,
                row.action_args,
                row.outcome.as_str(),
                row.result_detail,
                row.bytes,
                row.thumbnail_hash,
                row.screenshot_path,
                row.screenshot_attach_to_llm as i64,
                row.is_self_test as i64,
                screenshot_metadata.map(|metadata| metadata.screenshot_id.as_str()),
                screenshot_metadata.map(|metadata| metadata.pruned_ids_json.as_str()),
                row.prev_hash,
                row.row_hash,
            ],
        ) {
            if created_screenshot {
                if let Some(prepared) = &screenshot {
                    let _ = fs::remove_file(&prepared.path);
                }
            }
            return Err(AuditError::Db(format!("insert: {error}")));
        }
        if let Err(error) = transaction.commit() {
            if created_screenshot {
                if let Some(prepared) = &screenshot {
                    let _ = fs::remove_file(&prepared.path);
                }
            }
            return Err(AuditError::Db(format!("commit append: {error}")));
        }
        Ok(())
    }

    fn remove_pruned_screenshot_evidence(
        &self,
        session_id: &str,
        pruned_screenshot_ids: &[String],
    ) -> Result<(), AuditError> {
        if pruned_screenshot_ids.is_empty() {
            return Ok(());
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| AuditError::Db("audit mutex poisoned".into()))?;
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                AuditError::Db(format!("begin productive screenshot prune: {error}"))
            })?;
        verify_chain_locked(&transaction)?;
        let candidates =
            candidate_paths_for_pruned_ids(&transaction, session_id, pruned_screenshot_ids)?;
        let protected = protected_screenshot_paths(&transaction)?;
        let expected_parent = normalized_absolute(&self.screenshot_dir)?;
        for candidate in candidates {
            if protected.contains(&candidate) {
                continue;
            }
            let Some(parent) = candidate.parent() else {
                continue;
            };
            if normalized_absolute(parent)? != expected_parent {
                continue;
            }
            match fs::remove_file(&candidate) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(AuditError::Db(format!(
                        "remove pruned screenshot {}: {error}",
                        candidate.display()
                    )))
                }
            }
        }
        transaction.commit().map_err(|error| {
            AuditError::Db(format!("commit productive screenshot prune: {error}"))
        })?;
        Ok(())
    }
}

fn screenshot_audit_metadata(
    screenshot_id: &str,
    pruned_screenshot_ids: &[String],
) -> Result<ScreenshotAuditMetadata, AuditError> {
    if !is_safe_screenshot_id(screenshot_id) {
        return Err(AuditError::Db(
            "verified screenshot id is empty or too long".into(),
        ));
    }
    let mut unique = HashSet::new();
    for pruned_id in pruned_screenshot_ids {
        if !is_safe_screenshot_id(pruned_id)
            || pruned_id == screenshot_id
            || !unique.insert(pruned_id.as_str())
        {
            return Err(AuditError::Db(
                "verified screenshot prune ids are malformed or ambiguous".into(),
            ));
        }
    }
    let pruned_ids_json = serde_json::to_string(pruned_screenshot_ids)
        .map_err(|error| AuditError::Db(format!("encode screenshot prune ids: {error}")))?;
    Ok(ScreenshotAuditMetadata {
        screenshot_id: screenshot_id.to_owned(),
        pruned_ids_json,
    })
}

fn candidate_paths_for_pruned_ids(
    conn: &Connection,
    session_id: &str,
    pruned_screenshot_ids: &[String],
) -> Result<HashSet<PathBuf>, AuditError> {
    let target_ids = pruned_screenshot_ids.iter().collect::<HashSet<_>>();
    let mut paths_by_id: HashMap<String, HashSet<PathBuf>> = HashMap::new();
    let mut association_counts: HashMap<String, usize> = HashMap::new();
    let mut statement = conn
        .prepare(
            "SELECT screenshot_id, screenshot_path
             FROM audit
             WHERE session_id = ?1 AND screenshot_id IS NOT NULL",
        )
        .map_err(|error| {
            AuditError::Db(format!("prepare pruned screenshot candidates: {error}"))
        })?;
    let rows = statement
        .query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|error| AuditError::Db(format!("query pruned screenshot candidates: {error}")))?;
    for row in rows {
        let (screenshot_id, path) = row.map_err(|error| {
            AuditError::Db(format!("decode pruned screenshot candidate: {error}"))
        })?;
        if target_ids.contains(&screenshot_id) {
            let Some(path) = path else {
                return Ok(HashSet::new());
            };
            *association_counts.entry(screenshot_id.clone()).or_default() += 1;
            paths_by_id
                .entry(screenshot_id)
                .or_default()
                .insert(PathBuf::from(path));
        }
    }
    if pruned_screenshot_ids.iter().any(|screenshot_id| {
        paths_by_id
            .get(screenshot_id)
            .is_none_or(|paths| paths.len() != 1)
            || association_counts.get(screenshot_id).copied() != Some(1)
    }) {
        return Ok(HashSet::new());
    }
    Ok(paths_by_id.into_values().flatten().collect())
}

fn protected_screenshot_paths(conn: &Connection) -> Result<HashSet<PathBuf>, AuditError> {
    let mut statement = conn
        .prepare(
            "SELECT rowid, session_id, screenshot_id, screenshot_path, screenshot_pruned_ids
             FROM audit
             WHERE screenshot_path IS NOT NULL OR screenshot_pruned_ids IS NOT NULL
             ORDER BY rowid ASC",
        )
        .map_err(|error| AuditError::Db(format!("prepare screenshot protection state: {error}")))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|error| AuditError::Db(format!("query screenshot protection state: {error}")))?;
    let mut references = Vec::new();
    let mut prune_markers: HashMap<(String, String), Vec<i64>> = HashMap::new();
    let mut association_counts: HashMap<(String, String), usize> = HashMap::new();
    for row in rows {
        let (rowid, session_id, screenshot_id, screenshot_path, pruned_ids_json) =
            row.map_err(|error| {
                AuditError::Db(format!("decode screenshot protection state: {error}"))
            })?;
        if let Some(pruned_ids_json) = pruned_ids_json {
            for pruned_id in decode_pruned_screenshot_ids(&pruned_ids_json)? {
                prune_markers
                    .entry((session_id.clone(), pruned_id))
                    .or_default()
                    .push(rowid);
            }
        }
        if let Some(path) = screenshot_path {
            let path = PathBuf::from(path);
            if let Some(screenshot_id) = &screenshot_id {
                *association_counts
                    .entry((session_id.clone(), screenshot_id.clone()))
                    .or_default() += 1;
            }
            references.push((rowid, session_id, screenshot_id, path));
        }
    }
    let mut protected = HashSet::new();
    for (rowid, session_id, screenshot_id, path) in references {
        let Some(screenshot_id) = screenshot_id else {
            protected.insert(path);
            continue;
        };
        let key = (session_id, screenshot_id);
        let ambiguous = association_counts.get(&key).copied() != Some(1);
        let pruned_after_association = prune_markers
            .get(&key)
            .is_some_and(|markers| markers.iter().any(|marker_rowid| *marker_rowid > rowid));
        if ambiguous || !pruned_after_association {
            protected.insert(path);
        }
    }
    Ok(protected)
}

fn decode_pruned_screenshot_ids(value: &str) -> Result<Vec<String>, AuditError> {
    let ids = serde_json::from_str::<Vec<String>>(value)
        .map_err(|_| AuditError::Db("screenshot prune ids are not a JSON string array".into()))?;
    let mut unique = HashSet::new();
    if ids
        .iter()
        .any(|id| !is_safe_screenshot_id(id) || !unique.insert(id.as_str()))
    {
        return Err(AuditError::Db(
            "screenshot prune ids are malformed or ambiguous".into(),
        ));
    }
    Ok(ids)
}

fn is_safe_screenshot_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value.chars().all(|character| !character.is_control())
}

struct PreparedScreenshot {
    path: PathBuf,
    hash: String,
    bytes: u64,
    existed: bool,
}

fn prepare_screenshot(directory: &Path, png: &[u8]) -> Result<PreparedScreenshot, AuditError> {
    ensure_private_screenshot_directory(directory)?;
    let hash = sha256_hex(png);
    let path = directory.join(format!("{hash}.png"));
    let existed = match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            let existing = fs::read(&path).map_err(|error| {
                AuditError::Db(format!(
                    "read stored screenshot {}: {error}",
                    path.display()
                ))
            })?;
            if existing != png {
                return Err(AuditError::Db(format!(
                    "stored screenshot hash mismatch at {}",
                    path.display()
                )));
            }
            true
        }
        Ok(_) => {
            return Err(AuditError::Db(format!(
                "screenshot path is not a regular file: {}",
                path.display()
            )))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(AuditError::Db(format!(
                "inspect screenshot {}: {error}",
                path.display()
            )))
        }
    };
    Ok(PreparedScreenshot {
        path,
        hash,
        bytes: png.len() as u64,
        existed,
    })
}

fn persist_prepared_screenshot(
    prepared: &PreparedScreenshot,
    png: &[u8],
) -> Result<bool, AuditError> {
    if prepared.existed {
        set_private_file_permissions(&prepared.path)?;
        return Ok(false);
    }
    let directory = prepared
        .path
        .parent()
        .ok_or_else(|| AuditError::Db("screenshot path does not have a parent directory".into()))?;
    ensure_private_screenshot_directory(directory)?;
    let temporary = directory.join(format!(".screenshot-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|error| {
            AuditError::Db(format!("create screenshot temporary file: {error}"))
        })?;
        file.write_all(png)
            .map_err(|error| AuditError::Db(format!("write screenshot: {error}")))?;
        file.sync_all()
            .map_err(|error| AuditError::Db(format!("sync screenshot: {error}")))?;
        match fs::hard_link(&temporary, &prepared.path) {
            Ok(()) => {
                fs::remove_file(&temporary).map_err(|error| {
                    AuditError::Db(format!("remove screenshot temporary file: {error}"))
                })?;
                set_private_file_permissions(&prepared.path)?;
                sync_directory(directory)?;
                Ok(true)
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing = fs::read(&prepared.path).map_err(|read_error| {
                    AuditError::Db(format!(
                        "verify concurrently stored screenshot: {read_error}"
                    ))
                })?;
                if existing != png {
                    return Err(AuditError::Db(
                        "concurrently stored screenshot hash mismatch".into(),
                    ));
                }
                fs::remove_file(&temporary).map_err(|remove_error| {
                    AuditError::Db(format!("remove screenshot temporary file: {remove_error}"))
                })?;
                set_private_file_permissions(&prepared.path)?;
                Ok(false)
            }
            Err(error) => Err(AuditError::Db(format!(
                "publish screenshot atomically: {error}"
            ))),
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), AuditError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
        AuditError::Db(format!(
            "set screenshot directory permissions {}: {error}",
            path.display()
        ))
    })
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<(), AuditError> {
    Ok(())
}

fn ensure_private_screenshot_directory(path: &Path) -> Result<(), AuditError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => {
            return Err(AuditError::Db(format!(
                "screenshot storage is not a private directory: {}",
                path.display()
            )))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|create_error| {
                AuditError::Db(format!("create screenshot directory: {create_error}"))
            })?;
            let metadata = fs::symlink_metadata(path).map_err(|metadata_error| {
                AuditError::Db(format!("inspect screenshot directory: {metadata_error}"))
            })?;
            if !metadata.file_type().is_dir() {
                return Err(AuditError::Db(
                    "screenshot storage creation did not produce a directory".into(),
                ));
            }
        }
        Err(error) => {
            return Err(AuditError::Db(format!(
                "inspect screenshot directory {}: {error}",
                path.display()
            )))
        }
    }
    set_private_directory_permissions(path)
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> Result<(), AuditError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
        AuditError::Db(format!(
            "set screenshot file permissions {}: {error}",
            path.display()
        ))
    })
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> Result<(), AuditError> {
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), AuditError> {
    let directory = fs::File::open(path)
        .map_err(|error| AuditError::Db(format!("open screenshot directory: {error}")))?;
    directory
        .sync_all()
        .map_err(|error| AuditError::Db(format!("sync screenshot directory: {error}")))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn initialize_audit_state(conn: &Connection) -> Result<(), AuditError> {
    conn.execute(
        "INSERT OR IGNORE INTO audit_state (
            singleton, anchor_rowid, anchor_hash, retention_days, storage_cap_bytes
         ) VALUES (1, 0, ?1, ?2, ?3)",
        rusqlite::params![
            GENESIS_HASH,
            i64::from(DEFAULT_RETENTION_DAYS),
            DEFAULT_STORAGE_CAP_BYTES as i64,
        ],
    )
    .map_err(|error| AuditError::Db(format!("initialize audit state: {error}")))?;
    let (anchor_rowid, anchor_hash) = read_anchor(conn)?;
    if anchor_rowid < 0 || !is_sha256_hex(&anchor_hash) {
        return Err(AuditError::Db("audit retention anchor is malformed".into()));
    }
    Ok(())
}

fn read_anchor(conn: &Connection) -> Result<(i64, String), AuditError> {
    conn.query_row(
        "SELECT anchor_rowid, anchor_hash FROM audit_state WHERE singleton = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .map_err(|error| AuditError::Db(format!("read audit anchor: {error}")))
}

fn read_policy(conn: &Connection) -> Result<(u32, u64), AuditError> {
    let (retention_days, storage_cap_bytes): (i64, i64) = conn
        .query_row(
            "SELECT retention_days, storage_cap_bytes
             FROM audit_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| AuditError::Db(format!("read audit policy: {error}")))?;
    if !(7..=365).contains(&retention_days) || storage_cap_bytes <= 0 {
        return Err(AuditError::Db("audit storage policy is malformed".into()));
    }
    Ok((retention_days as u32, storage_cap_bytes as u64))
}

fn screenshot_dir_for_db(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("computer-use-screenshots")
}

fn ensure_screenshot_retention_schema(conn: &Connection) -> Result<(), AuditError> {
    let transaction = rusqlite::Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(|error| AuditError::Db(format!("begin audit schema migration: {error}")))?;
    let columns = {
        let mut statement = transaction
            .prepare("PRAGMA table_info(audit)")
            .map_err(|error| AuditError::Db(format!("inspect audit schema: {error}")))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| AuditError::Db(format!("query audit schema: {error}")))?;
        rows.collect::<Result<HashSet<_>, _>>()
            .map_err(|error| AuditError::Db(format!("decode audit schema: {error}")))?
    };
    if !columns.contains("screenshot_id") {
        transaction
            .execute("ALTER TABLE audit ADD COLUMN screenshot_id TEXT", [])
            .map_err(|error| AuditError::Db(format!("migrate screenshot id column: {error}")))?;
    }
    if !columns.contains("screenshot_pruned_ids") {
        transaction
            .execute(
                "ALTER TABLE audit ADD COLUMN screenshot_pruned_ids TEXT",
                [],
            )
            .map_err(|error| AuditError::Db(format!("migrate screenshot prune column: {error}")))?;
    }
    transaction
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_audit_screenshot_id
             ON audit(session_id, screenshot_id)",
            [],
        )
        .map_err(|error| AuditError::Db(format!("index screenshot audit ids: {error}")))?;
    transaction
        .commit()
        .map_err(|error| AuditError::Db(format!("commit audit schema migration: {error}")))
}

fn storage_usage_bytes(db_path: &Path, screenshot_dir: &Path) -> Result<u64, AuditError> {
    let mut total = 0u64;
    for path in [
        db_path.to_path_buf(),
        PathBuf::from(format!("{}-wal", db_path.display())),
        PathBuf::from(format!("{}-shm", db_path.display())),
    ] {
        match fs::metadata(&path) {
            Ok(metadata) => total = total.saturating_add(metadata.len()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(AuditError::Db(format!(
                    "measure audit storage {}: {error}",
                    path.display()
                )))
            }
        }
    }
    match fs::read_dir(screenshot_dir) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.map_err(|error| {
                    AuditError::Db(format!("read screenshot storage entry: {error}"))
                })?;
                let file_type = entry.file_type().map_err(|error| {
                    AuditError::Db(format!(
                        "inspect screenshot storage {}: {error}",
                        entry.path().display()
                    ))
                })?;
                if !file_type.is_file() {
                    return Err(AuditError::Db(format!(
                        "unexpected non-file in screenshot storage: {}",
                        entry.path().display()
                    )));
                }
                let metadata = entry.metadata().map_err(|error| {
                    AuditError::Db(format!(
                        "measure screenshot storage {}: {error}",
                        entry.path().display()
                    ))
                })?;
                total = total.saturating_add(metadata.len());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(AuditError::Db(format!(
                "read screenshot storage {}: {error}",
                screenshot_dir.display()
            )))
        }
    }
    Ok(total)
}

fn normalized_absolute(path: &Path) -> Result<PathBuf, AuditError> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .map_err(|error| AuditError::Db(format!("resolve audit path: {error}")))
    }
}

#[derive(Debug)]
struct StoredAuditRow {
    rowid: i64,
    prev_hash: String,
    row_hash: String,
    ts_mono: i64,
    ts_wall: i64,
    session_id: String,
    conversation_id: Option<String>,
    turn_id: Option<String>,
    actor: String,
    app_bundle_id: Option<String>,
    window_title: Option<String>,
    action_type: String,
    action_summary: Option<String>,
    action_args: Option<String>,
    outcome: String,
    result_detail: Option<String>,
    bytes: Option<i64>,
    thumbnail_hash: Option<String>,
    screenshot_path: Option<String>,
    screenshot_attach_to_llm: i64,
    is_self_test: i64,
    screenshot_id: Option<String>,
    screenshot_pruned_ids: Option<String>,
}

impl StoredAuditRow {
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            rowid: row.get(0)?,
            prev_hash: row.get(1)?,
            row_hash: row.get(2)?,
            ts_mono: row.get(3)?,
            ts_wall: row.get(4)?,
            session_id: row.get(5)?,
            conversation_id: row.get(6)?,
            turn_id: row.get(7)?,
            actor: row.get(8)?,
            app_bundle_id: row.get(9)?,
            window_title: row.get(10)?,
            action_type: row.get(11)?,
            action_summary: row.get(12)?,
            action_args: row.get(13)?,
            outcome: row.get(14)?,
            result_detail: row.get(15)?,
            bytes: row.get(16)?,
            thumbnail_hash: row.get(17)?,
            screenshot_path: row.get(18)?,
            screenshot_attach_to_llm: row.get(19)?,
            is_self_test: row.get(20)?,
            screenshot_id: row.get(21)?,
            screenshot_pruned_ids: row.get(22)?,
        })
    }

    fn validate(&self) -> Result<(), AuditError> {
        let malformed = |detail: &str| {
            AuditError::Db(format!(
                "malformed audit row at rowid={}: {detail}",
                self.rowid
            ))
        };
        if self.rowid <= 0 {
            return Err(malformed("rowid must be positive"));
        }
        if self.ts_mono < 0 || self.ts_wall < 0 {
            return Err(malformed("timestamps must be non-negative integers"));
        }
        if self.session_id.is_empty() || self.action_type.is_empty() {
            return Err(malformed("session_id and action_type must not be empty"));
        }
        if !matches!(self.actor.as_str(), "user" | "agent") {
            return Err(malformed("actor is not recognized"));
        }
        if !matches!(
            self.outcome.as_str(),
            "pending"
                | "success"
                | "denied"
                | "blocked"
                | "error"
                | "aborted"
                | "stale"
                | "paused"
                | "rate_limited"
        ) {
            return Err(malformed("outcome is not recognized"));
        }
        if !matches!(self.screenshot_attach_to_llm, 0 | 1) || !matches!(self.is_self_test, 0 | 1) {
            return Err(malformed("boolean fields must be encoded as 0 or 1"));
        }
        if self.bytes.is_some_and(|bytes| bytes < 0) {
            return Err(malformed("bytes must be non-negative"));
        }
        if !is_sha256_hex(&self.prev_hash) || !is_sha256_hex(&self.row_hash) {
            return Err(malformed("hash fields must be lowercase SHA-256 hex"));
        }
        if let Some(action_args) = &self.action_args {
            serde_json::from_str::<serde_json::Value>(action_args)
                .map_err(|_| malformed("action_args is not valid JSON"))?;
        }
        match (&self.screenshot_id, &self.screenshot_pruned_ids) {
            (Some(screenshot_id), Some(pruned_ids_json)) => {
                let pruned_ids = decode_pruned_screenshot_ids(pruned_ids_json)
                    .map_err(|_| malformed("screenshot retention metadata is malformed"))?;
                if !is_safe_screenshot_id(screenshot_id)
                    || pruned_ids.iter().any(|id| id == screenshot_id)
                    || self.screenshot_path.is_none()
                {
                    return Err(malformed("screenshot retention metadata is inconsistent"));
                }
            }
            (None, None) => {}
            _ => return Err(malformed("screenshot retention metadata is incomplete")),
        }
        Ok(())
    }

    fn canonical_bytes(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(512);
        extend(&mut buf, &self.ts_mono.to_string());
        extend(&mut buf, &self.ts_wall.to_string());
        extend(&mut buf, &self.session_id);
        extend_opt(&mut buf, &self.conversation_id);
        extend_opt(&mut buf, &self.turn_id);
        extend(&mut buf, &self.actor);
        extend_opt(&mut buf, &self.app_bundle_id);
        extend_opt(&mut buf, &self.window_title);
        extend(&mut buf, &self.action_type);
        extend_opt(&mut buf, &self.action_summary);
        extend_opt(&mut buf, &self.action_args);
        extend(&mut buf, &self.outcome);
        extend_opt(&mut buf, &self.result_detail);
        match self.bytes {
            Some(bytes) => extend(&mut buf, &bytes.to_string()),
            None => buf.push(0),
        }
        extend_opt(&mut buf, &self.thumbnail_hash);
        extend_opt(&mut buf, &self.screenshot_path);
        extend(&mut buf, &self.screenshot_attach_to_llm.to_string());
        extend(&mut buf, &self.is_self_test.to_string());
        extend_screenshot_retention(
            &mut buf,
            self.screenshot_id.as_deref(),
            self.screenshot_pruned_ids.as_deref(),
        );
        buf
    }
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Verify every row while streaming in chronological order. Returning the last
/// rowid lets callers bind derived evidence to the exact verified boundary.
fn verify_chain_locked(conn: &Connection) -> Result<Option<i64>, AuditError> {
    let (anchor_rowid, anchor_hash) = read_anchor(conn)?;
    if anchor_rowid < 0 || !is_sha256_hex(&anchor_hash) {
        return Err(AuditError::Db("audit retention anchor is malformed".into()));
    }
    let mut statement = conn
        .prepare(
            "SELECT rowid, prev_hash, row_hash, ts_mono, ts_wall, session_id,
                    conversation_id, turn_id, actor, app_bundle_id, window_title,
                    action_type, action_summary, action_args, outcome, result_detail,
                    bytes, thumbnail_hash, screenshot_path, screenshot_attach_to_llm,
                    is_self_test, screenshot_id, screenshot_pruned_ids
             FROM audit ORDER BY rowid ASC",
        )
        .map_err(|error| AuditError::Db(format!("verify prep: {error}")))?;
    let mut rows = statement
        .query([])
        .map_err(|error| AuditError::Db(format!("verify query: {error}")))?;
    let mut expected_prev_hash = anchor_hash;
    let mut previous_rowid = anchor_rowid;
    let mut verified_through_rowid = (anchor_rowid > 0).then_some(anchor_rowid);

    loop {
        let row = rows
            .next()
            .map_err(|error| AuditError::Db(format!("verify next row: {error}")))?;
        let Some(row) = row else {
            break;
        };
        let stored = StoredAuditRow::read(row)
            .map_err(|error| AuditError::Db(format!("verify decode row: {error}")))?;
        stored.validate()?;
        if stored.rowid <= previous_rowid {
            return Err(AuditError::Db(format!(
                "audit rowid {} does not follow retention anchor {}",
                stored.rowid, previous_rowid
            )));
        }
        if stored.prev_hash != expected_prev_hash {
            return Err(AuditError::HashChainBroken {
                expected: expected_prev_hash,
                found: stored.prev_hash,
                at_rowid: stored.rowid,
            });
        }
        let recomputed = hash_row(&stored.prev_hash, &stored.canonical_bytes());
        if recomputed != stored.row_hash {
            return Err(AuditError::HashChainBroken {
                expected: recomputed,
                found: stored.row_hash,
                at_rowid: stored.rowid,
            });
        }
        expected_prev_hash = stored.row_hash;
        previous_rowid = stored.rowid;
        verified_through_rowid = Some(stored.rowid);
    }

    Ok(verified_through_rowid)
}

fn actor_str(a: crate::models::computer_use::AuditActor) -> &'static str {
    use crate::models::computer_use::AuditActor;
    match a {
        AuditActor::User => "user",
        AuditActor::Agent => "agent",
    }
}

/// Canonical bytes for hash input. Order matters — must match `verify_chain`.
fn canonical_bytes(
    row: &AuditRow,
    screenshot_metadata: Option<&ScreenshotAuditMetadata>,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(512);
    extend(&mut buf, &row.ts_mono.to_string());
    extend(&mut buf, &row.ts_wall.to_string());
    extend(&mut buf, &row.session_id);
    extend_opt(&mut buf, &row.conversation_id);
    extend_opt(&mut buf, &row.turn_id);
    extend(&mut buf, actor_str(row.actor));
    extend_opt(&mut buf, &row.app_bundle_id);
    extend_opt(&mut buf, &row.window_title);
    extend(&mut buf, &row.action_type);
    extend_opt(&mut buf, &row.action_summary);
    extend_opt(&mut buf, &row.action_args);
    extend(&mut buf, row.outcome.as_str());
    extend_opt(&mut buf, &row.result_detail);
    match row.bytes {
        Some(b) => extend(&mut buf, &b.to_string()),
        None => buf.push(0),
    }
    extend_opt(&mut buf, &row.thumbnail_hash);
    extend_opt(&mut buf, &row.screenshot_path);
    extend(
        &mut buf,
        if row.screenshot_attach_to_llm {
            "1"
        } else {
            "0"
        },
    );
    extend(&mut buf, if row.is_self_test { "1" } else { "0" });
    extend_screenshot_retention(
        &mut buf,
        screenshot_metadata.map(|metadata| metadata.screenshot_id.as_str()),
        screenshot_metadata.map(|metadata| metadata.pruned_ids_json.as_str()),
    );
    buf
}

fn extend_screenshot_retention(
    buf: &mut Vec<u8>,
    screenshot_id: Option<&str>,
    pruned_ids_json: Option<&str>,
) {
    if let (Some(screenshot_id), Some(pruned_ids_json)) = (screenshot_id, pruned_ids_json) {
        extend(buf, SCREENSHOT_RETENTION_HASH_VERSION);
        extend(buf, screenshot_id);
        extend(buf, pruned_ids_json);
    }
}

fn extend(buf: &mut Vec<u8>, s: &str) {
    buf.extend_from_slice(s.as_bytes());
    buf.push(0);
}

fn extend_opt(buf: &mut Vec<u8>, s: &Option<String>) {
    match s {
        Some(v) => extend(buf, v),
        None => buf.push(0),
    }
}

fn hash_row(prev_hash: &str, canonical: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(prev_hash.as_bytes());
    hasher.update(b"|");
    hasher.update(canonical);
    let bytes = hasher.finalize();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::computer_use::{AuditActor, AuditOutcome};

    fn row(session_id: &str, action_type: &str, outcome: AuditOutcome) -> AuditRow {
        AuditRow {
            ts_mono: 1,
            ts_wall: 1,
            session_id: session_id.into(),
            conversation_id: None,
            turn_id: None,
            actor: AuditActor::Agent,
            app_bundle_id: Some("com.apple.finder".into()),
            window_title: Some("Finder".into()),
            action_type: action_type.into(),
            action_summary: None,
            action_args: None,
            outcome,
            result_detail: None,
            bytes: None,
            thumbnail_hash: None,
            screenshot_path: None,
            screenshot_attach_to_llm: false,
            is_self_test: false,
            prev_hash: String::new(),
            row_hash: String::new(),
        }
    }

    fn unique_test_dir(label: &str) -> std::path::PathBuf {
        let pid = std::process::id();
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("verboo-cu-test-{label}-{pid}-{nonce}"));
        std::fs::create_dir_all(&dir).expect("test dir");
        dir
    }

    impl AuditWriter {
        pub(crate) fn open_for_test(dir: &std::path::Path) -> Result<Self, AuditError> {
            std::fs::create_dir_all(dir).map_err(|e| AuditError::Db(e.to_string()))?;
            let path = dir.join("test_audit.db");
            let conn = Connection::open(&path).map_err(|e| AuditError::Db(e.to_string()))?;
            conn.execute_batch(SCHEMA_SQL)
                .map_err(|e| AuditError::Db(e.to_string()))?;
            ensure_screenshot_retention_schema(&conn)?;
            initialize_audit_state(&conn)?;
            Ok(Self {
                conn: Mutex::new(conn),
                screenshot_dir: screenshot_dir_for_db(&path),
                db_path: path,
            })
        }

        pub(crate) fn outcomes_for_test(&self, session_id: &str, action_type: &str) -> Vec<String> {
            let conn = self.conn.lock().expect("audit test mutex");
            let mut statement = conn
                .prepare(
                    "SELECT outcome FROM audit WHERE session_id = ?1 AND action_type = ?2 ORDER BY rowid ASC",
                )
                .expect("prepare audit outcome query");
            statement
                .query_map(rusqlite::params![session_id, action_type], |row| row.get(0))
                .expect("query audit outcomes")
                .collect::<Result<Vec<_>, _>>()
                .expect("decode audit outcomes")
        }

        pub(crate) fn action_summaries_for_test(
            &self,
            session_id: &str,
            action_type: &str,
        ) -> Vec<Option<String>> {
            let conn = self.conn.lock().expect("audit test mutex");
            let mut statement = conn
                .prepare(
                    "SELECT action_summary FROM audit WHERE session_id = ?1 AND action_type = ?2 ORDER BY rowid ASC",
                )
                .expect("prepare audit summary query");
            statement
                .query_map(rusqlite::params![session_id, action_type], |row| row.get(0))
                .expect("query audit summaries")
                .collect::<Result<Vec<_>, _>>()
                .expect("decode audit summaries")
        }

        fn row_count_for_test(&self) -> i64 {
            let conn = self.conn.lock().expect("audit test mutex");
            conn.query_row("SELECT COUNT(*) FROM audit", [], |row| row.get(0))
                .expect("count audit rows")
        }

        fn anchor_for_test(&self) -> (i64, String) {
            let conn = self.conn.lock().expect("audit test mutex");
            conn.query_row(
                "SELECT anchor_rowid, anchor_hash FROM audit_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read audit anchor")
        }

        fn action_types_for_test(&self) -> Vec<String> {
            let conn = self.conn.lock().expect("audit test mutex");
            let mut statement = conn
                .prepare("SELECT action_type FROM audit ORDER BY rowid ASC")
                .expect("prepare action type query");
            statement
                .query_map([], |row| row.get(0))
                .expect("query action types")
                .collect::<Result<Vec<_>, _>>()
                .expect("decode action types")
        }

        fn last_row_hash_for_test(&self) -> String {
            let conn = self.conn.lock().expect("audit test mutex");
            conn.query_row(
                "SELECT row_hash FROM audit ORDER BY rowid DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("read last row hash")
        }

        fn first_prev_hash_for_test(&self) -> String {
            let conn = self.conn.lock().expect("audit test mutex");
            conn.query_row(
                "SELECT prev_hash FROM audit ORDER BY rowid ASC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("read first previous hash")
        }

        pub(crate) fn configure_policy_for_test(
            &self,
            retention_days: u32,
            storage_cap_bytes: u64,
            now_wall: u64,
        ) -> Result<usize, AuditError> {
            self.configure_policy_at(retention_days, storage_cap_bytes, now_wall)
        }

        pub(crate) fn storage_usage_bytes_for_test(&self) -> Result<u64, AuditError> {
            self.storage_usage_bytes()
        }

        pub(crate) fn screenshot_metadata_for_test(
            &self,
            action_type: &str,
        ) -> (Option<i64>, Option<String>, Option<String>) {
            let conn = self.conn.lock().expect("audit test mutex");
            conn.query_row(
                "SELECT bytes, thumbnail_hash, screenshot_path
                 FROM audit WHERE action_type = ?1 ORDER BY rowid DESC LIMIT 1",
                [action_type],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read screenshot metadata")
        }

        pub(crate) fn screenshot_retention_metadata_for_test(
            &self,
            action_type: &str,
        ) -> (Option<String>, Option<String>) {
            let conn = self.conn.lock().expect("audit test mutex");
            conn.query_row(
                "SELECT screenshot_id, screenshot_pruned_ids
                 FROM audit WHERE action_type = ?1 ORDER BY rowid DESC LIMIT 1",
                [action_type],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read screenshot retention metadata")
        }
    }

    const DAY: u64 = 24 * 60 * 60;

    fn test_png() -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.extend_from_slice(b"validated-filtered-screenshot-fixture");
        bytes
    }

    #[test]
    fn validated_screenshot_is_private_hashed_and_bound_to_the_audit_row() {
        let dir = unique_test_dir("screenshot-persistence");
        let writer = AuditWriter::open_for_test(&dir).expect("open");
        let png = test_png();
        writer
            .append_with_screenshot(row("s1", "screenshot", AuditOutcome::Success), &png)
            .expect("persist screenshot trajectory");

        let (bytes, hash, path) = writer.screenshot_metadata_for_test("screenshot");
        assert_eq!(bytes, Some(png.len() as i64));
        assert_eq!(hash.as_deref(), Some(sha256_hex(&png).as_str()));
        let path = PathBuf::from(path.expect("screenshot path"));
        assert_eq!(fs::read(&path).expect("read stored screenshot"), png);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        writer
            .verify_chain()
            .expect("screenshot metadata is chained");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn screenshot_ids_with_canonical_delimiters_are_rejected_before_persistence() {
        let dir = unique_test_dir("screenshot-id-delimiter");
        let writer = AuditWriter::open_for_test(&dir).expect("open");

        assert!(matches!(
            writer.append_verified_screenshot(
                row("s1", "unsafe-shot", AuditOutcome::Success),
                "unsafe\0id",
                &[],
                &test_png(),
            ),
            Err(AuditError::Db(_))
        ));
        assert_eq!(writer.row_count_for_test(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn productive_prune_removes_evidence_after_hash_chained_marker() {
        let dir = unique_test_dir("productive-screenshot-prune");
        let writer = AuditWriter::open_for_test(&dir).expect("open");
        let first_png = test_png();
        let mut second_png = test_png();
        second_png.extend_from_slice(b"second-frame");

        writer
            .append_verified_screenshot(
                row("s1", "first-shot", AuditOutcome::Success),
                "shot-1",
                &[],
                &first_png,
            )
            .expect("append first screenshot");
        let first_path = PathBuf::from(
            writer
                .screenshot_metadata_for_test("first-shot")
                .2
                .expect("first screenshot path"),
        );

        writer
            .append_verified_screenshot(
                row("s1", "second-shot", AuditOutcome::Success),
                "shot-2",
                &["shot-1".to_string()],
                &second_png,
            )
            .expect("append screenshot carrying prune marker");

        assert!(!first_path.exists(), "pruned evidence should be removed");
        writer.verify_chain().expect("prune marker remains chained");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn productive_prune_keeps_shared_hash_until_every_screenshot_id_is_pruned() {
        let dir = unique_test_dir("shared-hash-productive-prune");
        let writer = AuditWriter::open_for_test(&dir).expect("open");
        let shared_png = test_png();
        let mut later_png = test_png();
        later_png.extend_from_slice(b"later-frame");

        writer
            .append_verified_screenshot(
                row("s1", "shared-one", AuditOutcome::Success),
                "shot-1",
                &[],
                &shared_png,
            )
            .expect("append first shared screenshot");
        let shared_path = PathBuf::from(
            writer
                .screenshot_metadata_for_test("shared-one")
                .2
                .expect("shared screenshot path"),
        );
        writer
            .append_verified_screenshot(
                row("s1", "shared-two", AuditOutcome::Success),
                "shot-2",
                &["shot-1".to_string()],
                &shared_png,
            )
            .expect("append second shared screenshot");

        assert!(
            shared_path.exists(),
            "the active screenshot id must keep the shared hash alive"
        );

        writer
            .append_verified_screenshot(
                row("s1", "later", AuditOutcome::Success),
                "shot-3",
                &["shot-2".to_string()],
                &later_png,
            )
            .expect("prune the final shared screenshot id");

        assert!(
            !shared_path.exists(),
            "the shared hash may be removed after every reference is pruned"
        );
        writer
            .verify_chain()
            .expect("shared prune markers are chained");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn productive_prune_preserves_hash_shared_with_legacy_ambiguous_evidence() {
        let dir = unique_test_dir("legacy-ambiguous-productive-prune");
        let writer = AuditWriter::open_for_test(&dir).expect("open");
        let shared_png = test_png();
        let mut later_png = test_png();
        later_png.extend_from_slice(b"later-frame");

        writer
            .append_with_screenshot(
                row("legacy", "legacy-shot", AuditOutcome::Success),
                &shared_png,
            )
            .expect("append legacy screenshot without an opaque id");
        let shared_path = PathBuf::from(
            writer
                .screenshot_metadata_for_test("legacy-shot")
                .2
                .expect("legacy screenshot path"),
        );
        writer
            .append_verified_screenshot(
                row("s1", "verified-shot", AuditOutcome::Success),
                "shot-1",
                &[],
                &shared_png,
            )
            .expect("append verified screenshot sharing the legacy hash");
        writer
            .append_verified_screenshot(
                row("s1", "later", AuditOutcome::Success),
                "shot-2",
                &["shot-1".to_string()],
                &later_png,
            )
            .expect("record the verified screenshot prune marker");

        assert!(
            shared_path.exists(),
            "legacy evidence without screenshot_id must stay fail-safe"
        );
        writer
            .verify_chain()
            .expect("legacy and v1 rows both verify");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn productive_prune_preserves_ambiguous_reused_screenshot_id() {
        let dir = unique_test_dir("reused-id-productive-prune");
        let writer = AuditWriter::open_for_test(&dir).expect("open");
        let first_png = test_png();
        let mut later_png = test_png();
        later_png.extend_from_slice(b"later-path");

        writer
            .append_verified_screenshot(
                row("s1", "duplicate-one", AuditOutcome::Success),
                "reused-id",
                &[],
                &first_png,
            )
            .expect("append first id association");
        writer
            .append_verified_screenshot(
                row("s1", "duplicate-two", AuditOutcome::Success),
                "reused-id",
                &[],
                &first_png,
            )
            .expect("append ambiguous second id association");
        let first_path = PathBuf::from(
            writer
                .screenshot_metadata_for_test("duplicate-one")
                .2
                .expect("first ambiguous path"),
        );
        let second_path = PathBuf::from(
            writer
                .screenshot_metadata_for_test("duplicate-two")
                .2
                .expect("second ambiguous path"),
        );
        writer
            .append_verified_screenshot(
                row("s1", "later", AuditOutcome::Success),
                "later-id",
                &["reused-id".to_string()],
                &later_png,
            )
            .expect("record ambiguous prune marker");

        assert!(first_path.exists());
        assert!(second_path.exists());
        assert_eq!(first_path, second_path, "the ambiguous id shares one hash");
        writer
            .verify_chain()
            .expect("ambiguous rows remain chained");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_earlier_unknown_prune_marker_cannot_delete_a_future_screenshot_id() {
        let dir = unique_test_dir("future-id-after-prune-marker");
        let writer = AuditWriter::open_for_test(&dir).expect("open");
        let first_png = test_png();
        let mut future_png = test_png();
        future_png.extend_from_slice(b"future-frame");

        writer
            .append_verified_screenshot(
                row("s1", "early-marker", AuditOutcome::Success),
                "shot-now",
                &["future-id".to_string()],
                &first_png,
            )
            .expect("unknown marker is retained without deleting evidence");
        writer
            .append_verified_screenshot(
                row("s1", "future-shot", AuditOutcome::Success),
                "future-id",
                &[],
                &future_png,
            )
            .expect("append screenshot whose id appears after the old marker");
        let future_path = PathBuf::from(
            writer
                .screenshot_metadata_for_test("future-shot")
                .2
                .expect("future screenshot path"),
        );

        writer
            .sweep_orphan_screenshots()
            .expect("sweep with ordered prune markers");

        assert!(
            future_path.exists(),
            "a marker may prune only an association that existed before it"
        );
        writer
            .verify_chain()
            .expect("ordered markers remain chained");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn opening_legacy_audit_adds_retention_columns_without_rehashing_old_rows() {
        let dir = unique_test_dir("legacy-screenshot-schema-migration");
        let legacy_writer = AuditWriter::open_for_test(&dir).expect("open legacy fixture");
        legacy_writer
            .append_with_screenshot(
                row("legacy", "legacy-shot", AuditOutcome::Success),
                &test_png(),
            )
            .expect("append a legacy-hashed row");
        drop(legacy_writer);

        let path = dir.join("test_audit.db");
        let conn = Connection::open(&path).expect("open legacy database");
        conn.execute_batch(
            "DROP INDEX idx_audit_screenshot_id;
             ALTER TABLE audit DROP COLUMN screenshot_id;
             ALTER TABLE audit DROP COLUMN screenshot_pruned_ids;",
        )
        .expect("downgrade fixture to legacy schema");
        drop(conn);

        let migrated = AuditWriter::open_for_test(&dir).expect("migrate legacy audit");
        migrated
            .verify_chain()
            .expect("legacy row hash must remain valid");
        let mut new_png = test_png();
        new_png.extend_from_slice(b"new-schema-row");
        migrated
            .append_verified_screenshot(
                row("s1", "new-shot", AuditOutcome::Success),
                "shot-new",
                &[],
                &new_png,
            )
            .expect("new retention metadata should persist after migration");
        migrated
            .verify_chain()
            .expect("legacy and extended hashes verify together");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn retention_removes_only_unreferenced_screenshot_files_after_commit() {
        let dir = unique_test_dir("screenshot-retention");
        let writer = AuditWriter::open_for_test(&dir).expect("open");
        let png = test_png();
        let now = 100 * DAY;

        let mut old = row("s1", "old-shot", AuditOutcome::Success);
        old.ts_wall = 10 * DAY;
        writer
            .append_with_screenshot(old, &png)
            .expect("append old screenshot");
        let screenshot_path = PathBuf::from(
            writer
                .screenshot_metadata_for_test("old-shot")
                .2
                .expect("old screenshot path"),
        );
        let mut recent = row("s1", "recent-shot", AuditOutcome::Success);
        recent.ts_wall = 90 * DAY;
        writer
            .append_with_screenshot(recent, &png)
            .expect("append shared recent screenshot");

        assert_eq!(writer.configure_policy_at(30, u64::MAX, now).unwrap(), 1);
        assert!(
            screenshot_path.exists(),
            "retained row still references PNG"
        );

        assert_eq!(
            writer.configure_policy_at(7, u64::MAX, 200 * DAY).unwrap(),
            1
        );
        assert!(!screenshot_path.exists(), "last reference was pruned");
        writer.verify_chain().expect("post-prune anchor is valid");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn startup_sweep_removes_crash_orphans_but_preserves_referenced_pngs() {
        let dir = unique_test_dir("screenshot-orphan-sweep");
        let writer = AuditWriter::open_for_test(&dir).expect("open");
        let png = test_png();
        writer
            .append_with_screenshot(row("s1", "kept", AuditOutcome::Success), &png)
            .expect("append referenced screenshot");
        let kept = PathBuf::from(
            writer
                .screenshot_metadata_for_test("kept")
                .2
                .expect("referenced screenshot path"),
        );
        let orphan = writer.screenshot_dir.join(".interrupted-write.tmp");
        fs::write(&orphan, b"partial").expect("write orphan fixture");

        writer
            .sweep_orphan_screenshots()
            .expect("sweep crash orphan");

        assert!(kept.exists());
        assert!(!orphan.exists());
        writer
            .verify_chain()
            .expect("sweep cannot mutate audit chain");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn startup_sweep_retries_hash_chained_productive_prunes() {
        let dir = unique_test_dir("screenshot-productive-prune-recovery");
        let writer = AuditWriter::open_for_test(&dir).expect("open");
        let first_png = test_png();
        let mut later_png = test_png();
        later_png.extend_from_slice(b"later-frame");
        writer
            .append_verified_screenshot(
                row("s1", "first-shot", AuditOutcome::Success),
                "shot-1",
                &[],
                &first_png,
            )
            .expect("append first screenshot");
        let first_path = PathBuf::from(
            writer
                .screenshot_metadata_for_test("first-shot")
                .2
                .expect("first screenshot path"),
        );
        writer
            .append_verified_screenshot(
                row("s1", "later-shot", AuditOutcome::Success),
                "shot-2",
                &["shot-1".to_string()],
                &later_png,
            )
            .expect("record productive prune");
        fs::write(&first_path, &first_png).expect("simulate interrupted file cleanup");

        writer
            .sweep_orphan_screenshots()
            .expect("retry productive prune on startup sweep");

        assert!(
            !first_path.exists(),
            "hash-chained prune state should survive a failed filesystem cleanup"
        );
        writer
            .verify_chain()
            .expect("sweep verifies the trusted chain");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tampered_prune_marker_never_authorizes_evidence_deletion() {
        let dir = unique_test_dir("tampered-productive-prune");
        let writer = AuditWriter::open_for_test(&dir).expect("open");
        let first_png = test_png();
        let mut later_png = test_png();
        later_png.extend_from_slice(b"later-frame");
        writer
            .append_verified_screenshot(
                row("s1", "first-shot", AuditOutcome::Success),
                "shot-1",
                &[],
                &first_png,
            )
            .expect("append first screenshot");
        let first_path = PathBuf::from(
            writer
                .screenshot_metadata_for_test("first-shot")
                .2
                .expect("first screenshot path"),
        );
        writer
            .append_verified_screenshot(
                row("s1", "later-shot", AuditOutcome::Success),
                "shot-2",
                &["shot-1".to_string()],
                &later_png,
            )
            .expect("record productive prune");
        fs::write(&first_path, &first_png).expect("restore cleanup candidate");
        {
            let conn = writer.conn.lock().expect("audit test mutex");
            conn.execute(
                "UPDATE audit SET screenshot_pruned_ids = '[]'
                 WHERE action_type = 'later-shot'",
                [],
            )
            .expect("tamper prune marker");
        }

        assert!(matches!(
            writer.sweep_orphan_screenshots(),
            Err(AuditError::HashChainBroken { .. })
        ));
        assert!(
            first_path.exists(),
            "unverified prune metadata must never remove evidence"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn screenshot_storage_symlink_is_rejected_without_writing_outside_app_data() {
        use std::os::unix::fs::symlink;

        let dir = unique_test_dir("screenshot-symlink");
        let outside = unique_test_dir("screenshot-symlink-outside");
        let writer = AuditWriter::open_for_test(&dir).expect("open");
        symlink(&outside, &writer.screenshot_dir).expect("create hostile symlink fixture");

        assert!(matches!(
            writer.append_with_screenshot(row("s1", "blocked", AuditOutcome::Success), &test_png()),
            Err(AuditError::Db(_))
        ));
        assert_eq!(writer.row_count_for_test(), 0);
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        let _ = fs::remove_file(&writer.screenshot_dir);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn retention_prunes_only_verified_expired_prefix_and_continues_chain() {
        let dir = unique_test_dir("retention-prefix");
        let writer = AuditWriter::open_for_test(&dir).expect("open");
        let now = 100 * DAY;

        let mut first_old = row("s1", "old-1", AuditOutcome::Success);
        first_old.ts_wall = 10 * DAY;
        writer.append(first_old).expect("append first old row");
        let mut second_old = row("s1", "old-2", AuditOutcome::Success);
        second_old.ts_wall = 20 * DAY;
        writer.append(second_old).expect("append second old row");
        let anchor_hash = writer.last_row_hash_for_test();

        let mut recent = row("s1", "recent", AuditOutcome::Success);
        recent.ts_wall = 90 * DAY;
        writer.append(recent).expect("append retained row");
        let mut later_but_old = row("s1", "old-after-retained", AuditOutcome::Success);
        later_but_old.ts_wall = 5 * DAY;
        writer
            .append(later_but_old)
            .expect("append out-of-order old row");

        let pruned = writer
            .configure_policy_at(30, u64::MAX, now)
            .expect("apply retention policy");

        assert_eq!(pruned, 2);
        assert_eq!(writer.anchor_for_test(), (2, anchor_hash.clone()));
        assert_eq!(
            writer.action_types_for_test(),
            vec!["recent", "old-after-retained"]
        );
        assert_eq!(writer.first_prev_hash_for_test(), anchor_hash);
        writer
            .verify_chain()
            .expect("retained suffix remains valid");

        let mut next = row("s1", "next", AuditOutcome::Success);
        next.ts_wall = now;
        writer.append(next).expect("extend anchored chain");
        writer.verify_chain().expect("extended chain remains valid");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retention_all_pruned_keeps_anchor_for_next_append() {
        let dir = unique_test_dir("retention-all");
        let writer = AuditWriter::open_for_test(&dir).expect("open");
        let now = 100 * DAY;

        for (index, timestamp) in [10 * DAY, 20 * DAY].into_iter().enumerate() {
            let mut old = row("s1", &format!("old-{index}"), AuditOutcome::Success);
            old.ts_wall = timestamp;
            writer.append(old).expect("append old row");
        }
        let last_pruned_hash = writer.last_row_hash_for_test();

        assert_eq!(
            writer
                .configure_policy_at(30, u64::MAX, now)
                .expect("prune all expired rows"),
            2
        );
        assert_eq!(writer.row_count_for_test(), 0);
        assert_eq!(writer.anchor_for_test(), (2, last_pruned_hash.clone()));
        writer.verify_chain().expect("anchor-only chain is valid");

        let mut next = row("s1", "next", AuditOutcome::Success);
        next.ts_wall = now;
        writer.append(next).expect("append after full prune");
        assert_eq!(writer.first_prev_hash_for_test(), last_pruned_hash);
        writer.verify_chain().expect("new anchored suffix is valid");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retention_never_prunes_a_tampered_chain() {
        let dir = unique_test_dir("retention-tampered");
        let writer = AuditWriter::open_for_test(&dir).expect("open");
        let now = 100 * DAY;
        let mut old = row("s1", "old", AuditOutcome::Success);
        old.ts_wall = 10 * DAY;
        writer.append(old).expect("append old row");
        {
            let conn = writer.conn.lock().expect("audit mutex");
            conn.execute(
                "UPDATE audit SET action_summary = 'tampered' WHERE rowid = 1",
                [],
            )
            .expect("tamper row");
        }

        assert!(matches!(
            writer.configure_policy_at(30, u64::MAX, now),
            Err(AuditError::HashChainBroken { at_rowid: 1, .. })
        ));
        assert_eq!(writer.row_count_for_test(), 1);
        assert_eq!(writer.anchor_for_test(), (0, GENESIS_HASH.to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn storage_cap_refuses_append_without_persisting_row() {
        let dir = unique_test_dir("storage-cap");
        let writer = AuditWriter::open_for_test(&dir).expect("open");
        let current = writer
            .storage_usage_bytes_for_test()
            .expect("storage usage");
        writer
            .configure_policy_at(90, current.saturating_add(1), 100 * DAY)
            .expect("persist tight storage cap");

        assert!(matches!(
            writer.append(row("s1", "blocked-by-cap", AuditOutcome::Success)),
            Err(AuditError::StorageFull { .. })
        ));
        assert_eq!(writer.row_count_for_test(), 0);
        writer
            .verify_chain()
            .expect("refused append changes no chain");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_chains_hashes() {
        let dir = unique_test_dir("chain");
        let w = AuditWriter::open_for_test(&dir).expect("open");
        w.append(row("s1", "list-apps", AuditOutcome::Success))
            .unwrap();
        w.append(row("s1", "list-windows", AuditOutcome::Success))
            .unwrap();
        w.append(row("s1", "click", AuditOutcome::Denied)).unwrap();
        w.verify_chain().expect("chain intact");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tamper_detection_breaks_chain() {
        let dir = unique_test_dir("tamper");
        let w = AuditWriter::open_for_test(&dir).expect("open");
        w.append(row("s1", "list-apps", AuditOutcome::Success))
            .unwrap();
        // Mutate last row directly (simulating tampering).
        {
            let conn = w.conn.lock().unwrap();
            conn.execute(
                "UPDATE audit SET action_summary = 'forged' WHERE rowid = 1",
                [],
            )
            .unwrap();
        }
        let err = w.verify_chain().unwrap_err();
        assert!(matches!(err, AuditError::HashChainBroken { .. }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tampering_older_than_256_rows_is_detected() {
        let dir = unique_test_dir("old-tamper");
        let w = AuditWriter::open_for_test(&dir).expect("open");
        for index in 0..300 {
            w.append(row("s1", &format!("action-{index}"), AuditOutcome::Success))
                .unwrap();
        }
        {
            let conn = w.conn.lock().unwrap();
            conn.execute(
                "UPDATE audit SET action_summary = 'forged-old-row' WHERE rowid = 1",
                [],
            )
            .unwrap();
        }
        assert!(matches!(
            w.verify_chain(),
            Err(AuditError::HashChainBroken { at_rowid: 1, .. })
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn malformed_row_fails_verification_instead_of_being_skipped() {
        let dir = unique_test_dir("malformed-row");
        let w = AuditWriter::open_for_test(&dir).expect("open");
        w.append(row("s1", "screenshot", AuditOutcome::Success))
            .unwrap();
        {
            let conn = w.conn.lock().unwrap();
            conn.execute(
                "UPDATE audit SET ts_mono = 'not-an-integer' WHERE rowid = 1",
                [],
            )
            .unwrap();
        }
        assert!(matches!(w.verify_chain(), Err(AuditError::Db(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn audit_query_failure_is_reported() {
        let dir = unique_test_dir("query-failure");
        let w = AuditWriter::open_for_test(&dir).expect("open");
        {
            let conn = w.conn.lock().unwrap();
            conn.execute_batch("DROP TABLE audit").unwrap();
        }
        assert!(matches!(w.verify_chain(), Err(AuditError::Db(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn genesis_hash_is_64_zeros() {
        assert_eq!(GENESIS_HASH.len(), 64);
        assert!(GENESIS_HASH.chars().all(|c| c == '0'));
    }

    #[test]
    fn handoff_events_are_session_scoped_bounded_and_chronological() {
        let dir = unique_test_dir("handoff");
        let w = AuditWriter::open_for_test(&dir).expect("open");
        w.append(row("s1", "screenshot", AuditOutcome::Success))
            .unwrap();
        w.append(row("other", "left-click", AuditOutcome::Success))
            .unwrap();
        let mut confirmed = row("s1", "confirmation_approved", AuditOutcome::Success);
        confirmed.actor = AuditActor::User;
        confirmed.action_summary = Some("Send message".into());
        w.append(confirmed).unwrap();

        let events = w.handoff_events_for_session("s1", 25).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].action_type, "screenshot");
        assert_eq!(events[1].summary, None);
        assert_eq!(events[1].actor, "user");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn handoff_excludes_agent_authored_confirmation_records() {
        let dir = unique_test_dir("handoff-confirmation-actor");
        let w = AuditWriter::open_for_test(&dir).expect("open");
        let mut forged_confirmation = row("s1", "confirmation_approved", AuditOutcome::Success);
        forged_confirmation.actor = AuditActor::Agent;
        forged_confirmation.action_summary = Some("raw secure-field label".into());
        w.append(forged_confirmation).unwrap();

        let mut user_confirmation = row("s1", "confirmation_approved", AuditOutcome::Success);
        user_confirmation.actor = AuditActor::User;
        user_confirmation.action_summary = Some("raw button label".into());
        w.append(user_confirmation).unwrap();

        let evidence = w
            .verified_handoff_evidence_for_session("s1", 25)
            .expect("valid chain produces verified evidence");
        assert_eq!(evidence.events().len(), 1);
        assert_eq!(evidence.events()[0].actor, "user");
        assert_eq!(evidence.verified_through_rowid(), Some(2));

        let handoff = crate::services::computer_use_handoff::build_handoff_from_verified_audit(
            "goal",
            "vision-model",
            &["com.apple.Notes".into()],
            &evidence,
            "completed",
        );
        assert!(handoff.actions.is_empty());
        assert!(handoff.errors_and_recoveries.is_empty());
        assert!(!serde_json::to_string(&handoff)
            .unwrap()
            .contains("raw button label"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verified_handoff_reports_controlled_failure_and_recovery_without_raw_audit_content() {
        let dir = unique_test_dir("handoff-failure-recovery");
        let w = AuditWriter::open_for_test(&dir).expect("open");
        w.append(row("s1", "type-text", AuditOutcome::Pending))
            .unwrap();
        let mut failed = row("s1", "type-text", AuditOutcome::Error);
        failed.action_summary = Some("AX label with account password".into());
        failed.result_detail = Some("typed secret=hunter2".into());
        w.append(failed).unwrap();
        w.append(row("s1", "type-text", AuditOutcome::Pending))
            .unwrap();
        w.append(row("s1", "type-text", AuditOutcome::Success))
            .unwrap();

        let evidence = w
            .verified_handoff_evidence_for_session("s1", 25)
            .expect("valid chain produces verified evidence");
        let handoff = crate::services::computer_use_handoff::build_handoff_from_verified_audit(
            "Update the selected note",
            "vision-model",
            &["com.apple.finder".into()],
            &evidence,
            "completed",
        );

        assert_eq!(handoff.actions.len(), 1);
        assert_eq!(
            handoff.errors_and_recoveries,
            vec![
                "Text entry failed in com.apple.finder",
                "Text entry recovered in com.apple.finder",
            ]
        );
        assert!(handoff.remaining.is_empty());
        let serialized = serde_json::to_string(&handoff).unwrap();
        assert!(!serialized.contains("account password"));
        assert!(!serialized.contains("hunter2"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn handoff_evidence_is_refused_when_any_audit_row_is_tampered() {
        let dir = unique_test_dir("handoff-tampered-chain");
        let w = AuditWriter::open_for_test(&dir).expect("open");
        w.append(row("s1", "screenshot", AuditOutcome::Success))
            .unwrap();
        {
            let conn = w.conn.lock().unwrap();
            conn.execute("UPDATE audit SET outcome = 'error' WHERE rowid = 1", [])
                .unwrap();
        }
        assert!(matches!(
            w.verified_handoff_evidence_for_session("s1", 25),
            Err(AuditError::HashChainBroken { .. })
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn independent_writers_preserve_one_hash_chain() {
        let dir = unique_test_dir("multi-writer");
        let first = AuditWriter::open_for_test(&dir).expect("open first writer");
        let second = AuditWriter::open_for_test(&dir).expect("open second writer");

        first
            .append(row("s1", "screenshot", AuditOutcome::Success))
            .unwrap();
        second
            .append(row("s1", "left-click", AuditOutcome::Success))
            .unwrap();

        first
            .verify_chain()
            .expect("independent processes must share one valid chain");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
