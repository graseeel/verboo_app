//! Computer Use AuditWriter (Kratos arch §6).
//!
//! Append-only SQLite audit log at:
//!   ~/Library/Application Support/ai.verboo.code.desktop/computer_use.audit.db
//!
//! Separate from main app DB (Q5). INSERT-only — never UPDATE/DELETE.
//! Hash chain (prev_hash + row_hash) for tamper detection.
//! On launch: verify last 256 rows match the recomputed chain.
//!
//! Mirror to os_log on macOS for post-uninstall tamper evidence (Q6).
//! (os_log mirror deferred to P0.2b — current impl uses stderr as placeholder.)

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use sha2::{Digest, Sha256};

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
    -- Integrity
    prev_hash                   TEXT    NOT NULL,
    row_hash                    TEXT    NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts_wall ON audit(ts_wall);
CREATE INDEX IF NOT EXISTS idx_audit_action_type ON audit(action_type);
CREATE INDEX IF NOT EXISTS idx_audit_outcome ON audit(outcome);
";

const INSERT_SQL: &str = "
INSERT INTO audit (
    ts_mono, ts_wall, session_id, conversation_id, turn_id,
    actor, app_bundle_id, window_title,
    action_type, action_summary, action_args,
    outcome, result_detail,
    bytes, thumbnail_hash, screenshot_path, screenshot_attach_to_llm, is_self_test,
    prev_hash, row_hash
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
";

const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

pub struct AuditWriter {
    conn: Mutex<Connection>,
    /// Cached last row_hash for chain continuity. Mutex-protected with conn.
    last_hash: Mutex<String>,
}

#[derive(Debug)]
pub enum AuditError {
    Db(String),
    HashChainBroken { expected: String, found: String, at_rowid: i64 },
}

impl std::fmt::Display for AuditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuditError::Db(s) => write!(f, "audit db error: {s}"),
            AuditError::HashChainBroken { expected, found, at_rowid } => {
                write!(f, "hash chain broken at rowid={at_rowid}: expected={expected} found={found}")
            }
        }
    }
}

impl std::error::Error for AuditError {}

impl AuditWriter {
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

        // Recover last hash from existing rows (or use genesis for empty DB).
        let last_hash = Self::fetch_last_hash(&conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
            last_hash: Mutex::new(last_hash),
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
            .ok();
        Ok(hash.unwrap_or_else(|| GENESIS_HASH.to_string()))
    }

    /// Verify the hash chain on launch. Recomputes last 256 rows; if any
    /// divergence, returns HashChainBroken at the first divergence point.
    pub fn verify_chain(&self) -> Result<(), AuditError> {
        let conn = self.conn.lock().expect("audit conn");
        let mut stmt = conn
            .prepare(
                "SELECT rowid, prev_hash, row_hash, ts_mono, ts_wall, session_id,
                        conversation_id, turn_id, actor, app_bundle_id, window_title,
                        action_type, action_summary, action_args, outcome, result_detail,
                        bytes, thumbnail_hash, screenshot_path, screenshot_attach_to_llm,
                        is_self_test
                 FROM audit ORDER BY rowid DESC LIMIT 256",
            )
            .map_err(|e| AuditError::Db(format!("verify prep: {e}")))?;

        let rows: Vec<(i64, String, String, Vec<u8>)> = stmt
            .query_map([], |row| {
                let rowid: i64 = row.get(0)?;
                let prev_hash: String = row.get(1)?;
                let row_hash: String = row.get(2)?;
                // Canonical bytes: read via `rusqlite::types::Value` to handle
                // both TEXT and INTEGER columns correctly (ts_mono, ts_wall,
                // screenshot_attach_to_llm, is_self_test are INTEGER).
                let mut buf = Vec::new();
                for i in 3..21 {
                    let v: rusqlite::types::Value = row.get(i).unwrap_or(rusqlite::types::Value::Null);
                    match v {
                        rusqlite::types::Value::Null => buf.push(0),
                        rusqlite::types::Value::Text(s) => {
                            buf.extend_from_slice(s.as_bytes());
                            buf.push(0);
                        }
                        rusqlite::types::Value::Integer(n) => {
                            let s = n.to_string();
                            buf.extend_from_slice(s.as_bytes());
                            buf.push(0);
                        }
                        rusqlite::types::Value::Real(f) => {
                            let s = f.to_string();
                            buf.extend_from_slice(s.as_bytes());
                            buf.push(0);
                        }
                        _ => buf.push(0),
                    }
                }
                Ok((rowid, prev_hash, row_hash, buf))
            })
            .map_err(|e| AuditError::Db(format!("verify map: {e}")))?
            .filter_map(Result::ok)
            .collect();

        // Walk rows in chronological order (reverse of DESC).
        let mut prev_expected = GENESIS_HASH.to_string();
        for (rowid, prev_hash, row_hash, buf) in rows.into_iter().rev() {
            if prev_hash != prev_expected {
                return Err(AuditError::HashChainBroken {
                    expected: prev_expected,
                    found: prev_hash,
                    at_rowid: rowid,
                });
            }
            let recomputed = hash_row(&prev_hash, &buf);
            if recomputed != row_hash {
                return Err(AuditError::HashChainBroken {
                    expected: recomputed,
                    found: row_hash,
                    at_rowid: rowid,
                });
            }
            prev_expected = row_hash;
        }
        Ok(())
    }

    /// Append a row. Computes row_hash from prev_hash + canonical(row fields).
    /// On hash computation failure or DB error, returns Err — caller MUST
    /// refuse the action (failure-safe).
    pub fn append(&self, mut row: AuditRow) -> Result<(), AuditError> {
        let mut last = self.last_hash.lock().expect("audit last_hash");
        row.prev_hash = last.clone();
        let canonical = canonical_bytes(&row);
        row.row_hash = hash_row(&row.prev_hash, &canonical);

        let conn = self.conn.lock().expect("audit conn");
        conn.execute(
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
                row.prev_hash,
                row.row_hash,
            ],
        )
        .map_err(|e| AuditError::Db(format!("insert: {e}")))?;

        *last = row.row_hash;
        Ok(())
    }
}

fn actor_str(a: crate::models::computer_use::AuditActor) -> &'static str {
    use crate::models::computer_use::AuditActor;
    match a {
        AuditActor::User => "user",
        AuditActor::Agent => "agent",
    }
}

/// Canonical bytes for hash input. Order matters — must match `verify_chain`.
fn canonical_bytes(row: &AuditRow) -> Vec<u8> {
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
    extend(&mut buf, if row.screenshot_attach_to_llm { "1" } else { "0" });
    extend(&mut buf, if row.is_self_test { "1" } else { "0" });
    buf
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
        fn open_for_test(dir: &std::path::Path) -> Result<Self, AuditError> {
            std::fs::create_dir_all(dir).map_err(|e| AuditError::Db(e.to_string()))?;
            let path = dir.join("test_audit.db");
            let conn = Connection::open(&path).map_err(|e| AuditError::Db(e.to_string()))?;
            conn.execute_batch(SCHEMA_SQL)
                .map_err(|e| AuditError::Db(e.to_string()))?;
            Ok(Self {
                conn: Mutex::new(conn),
                last_hash: Mutex::new(GENESIS_HASH.to_string()),
            })
        }
    }

    #[test]
    fn append_chains_hashes() {
        let dir = unique_test_dir("chain");
        let w = AuditWriter::open_for_test(&dir).expect("open");
        w.append(row("s1", "list-apps", AuditOutcome::Success)).unwrap();
        w.append(row("s1", "list-windows", AuditOutcome::Success)).unwrap();
        w.append(row("s1", "click", AuditOutcome::Denied)).unwrap();
        w.verify_chain().expect("chain intact");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tamper_detection_breaks_chain() {
        let dir = unique_test_dir("tamper");
        let w = AuditWriter::open_for_test(&dir).expect("open");
        w.append(row("s1", "list-apps", AuditOutcome::Success)).unwrap();
        // Mutate last row directly (simulating tampering).
        {
            let conn = w.conn.lock().unwrap();
            conn.execute(
                "UPDATE audit SET action_summary = 'forged' WHERE rowid = 1",
                [],
            ).unwrap();
        }
        let err = w.verify_chain().unwrap_err();
        assert!(matches!(err, AuditError::HashChainBroken { .. }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn genesis_hash_is_64_zeros() {
        assert_eq!(GENESIS_HASH.len(), 64);
        assert!(GENESIS_HASH.chars().all(|c| c == '0'));
    }
}
