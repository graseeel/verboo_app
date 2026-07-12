// StaleFileDetector — tracks file snapshots per conversation so the FE can
// show a "stale" banner when another conversation (or the user) modifies a
// file the agent read/wrote earlier. Wired to Tauri commands in lib.rs.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Snapshot of a file's identity at the moment the agent read/wrote it.
/// Mirrors Electron's `FileSnapshot` (src/main/services/staleFileDetector.ts:4).
#[derive(Debug, Clone, PartialEq)]
struct FileSnapshot {
    mtime_ms: i64,
    sha256: String,
}

/// Detects when a file the agent read/wrote earlier has been modified by
/// something else (the user, another process, another conversation). The
/// renderer shows a "stale" banner so the user knows the agent's context
/// is out of date. Mirrors Electron's `StaleFileDetector`.
pub struct StaleFileDetector {
    snapshots: Mutex<HashMap<String, FileSnapshot>>,
}

impl StaleFileDetector {
    pub fn new() -> Self {
        Self {
            snapshots: Mutex::new(HashMap::new()),
        }
    }

    /// Snapshots a file after a read. Silently ignored if the file does not
    /// exist (e.g., a "create" operation that hasn't run yet).
    pub fn record_read(&self, conversation_id: &str, file_path: &str) {
        self.record(conversation_id, file_path);
    }

    /// Snapshots a file after a write. Silently ignored if the file was
    /// deleted between the write and the snapshot.
    pub fn record_write(&self, conversation_id: &str, file_path: &str) {
        self.record(conversation_id, file_path);
    }

    /// Returns true if the file's content differs from the snapshot. A
    /// missing file is considered stale (deleted by another conversation).
    pub fn is_stale(&self, conversation_id: &str, file_path: &str) -> bool {
        let key = key_of(conversation_id, file_path);
        let snapshot = {
            let guard = match self.snapshots.lock() {
                Ok(g) => g,
                Err(_) => return false,
            };
            match guard.get(&key) {
                Some(s) => s.clone(),
                None => return false,
            }
        };
        let path = PathBuf::from(file_path);
        let metadata = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => return true, // file deleted → stale
        };
        let mtime_ms = mtime_to_ms(metadata.modified().ok());
        if mtime_ms != snapshot.mtime_ms {
            let current_sha = match sha256_of_file(&path) {
                Some(h) => h,
                None => return true,
            };
            return current_sha != snapshot.sha256;
        }
        false
    }

    /// Clears all snapshots for a given conversation (call on conversation
    /// delete or compact).
    pub fn clear_conversation(&self, conversation_id: &str) {
        let prefix = format!("{conversation_id}::");
        if let Ok(mut guard) = self.snapshots.lock() {
            guard.retain(|k, _| !k.starts_with(&prefix));
        }
    }

    /// Returns all stale file paths for a conversation (batch check). The FE
    /// uses this to render the stale banner with a list of affected files.
    pub fn list_stale(&self, conversation_id: &str) -> Vec<String> {
        let prefix = format!("{conversation_id}::");
        let keys: Vec<String> = {
            let guard = match self.snapshots.lock() {
                Ok(g) => g,
                Err(_) => return Vec::new(),
            };
            guard
                .keys()
                .filter(|k| k.starts_with(&prefix))
                .cloned()
                .collect()
        };
        keys.into_iter()
            .filter_map(|k| {
                // Extract the file_path from the key (after the second `::`).
                let file_path = k.strip_prefix(&prefix)?;
                if self.is_stale(conversation_id, file_path) {
                    Some(file_path.to_string())
                } else {
                    None
                }
            })
            .collect()
    }
}

impl Default for StaleFileDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl StaleFileDetector {
    fn record(&self, conversation_id: &str, file_path: &str) {
        let path = PathBuf::from(file_path);
        let Some(metadata) = std::fs::metadata(&path).ok() else {
            return;
        };
        let mtime_ms = mtime_to_ms(metadata.modified().ok());
        let Some(sha256) = sha256_of_file(&path) else {
            return;
        };
        let key = key_of(conversation_id, file_path);
        if let Ok(mut guard) = self.snapshots.lock() {
            guard.insert(
                key,
                FileSnapshot {
                    mtime_ms,
                    sha256,
                },
            );
        }
    }
}

fn key_of(conversation_id: &str, file_path: &str) -> String {
    format!("{conversation_id}::{file_path}")
}

fn mtime_to_ms(time: Option<SystemTime>) -> i64 {
    let Some(t) = time else {
        return 0;
    };
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(before) => -(before.duration().as_millis() as i64),
    }
}

fn sha256_of_file(path: &PathBuf) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    // Stream the file through the hasher instead of loading it all into
    // memory. Mirrors Node's createHash('sha256').update(buf).
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 16384];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(hex_encode(&hasher.finalize()))
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

// ── Minimal SHA-256 (no extra deps) ────────────────────────────────────
// Self-contained SHA-256 so we don't pull `sha2` just for stale-file checks.
// Verified against test vectors in `tests`.

struct Sha256 {
    state: [u32; 8],
    buffer: [u8; 64],
    buffer_len: usize,
    total_len: u64,
}

impl Sha256 {
    fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
                0x1f83d9ab, 0x5be0cd19,
            ],
            buffer: [0u8; 64],
            buffer_len: 0,
            total_len: 0,
        }
    }

    fn update(&mut self, mut data: &[u8]) {
        self.total_len = self.total_len.wrapping_add(data.len() as u64);
        if self.buffer_len > 0 {
            let needed = 64 - self.buffer_len;
            let take = needed.min(data.len());
            self.buffer[self.buffer_len..self.buffer_len + take]
                .copy_from_slice(&data[..take]);
            self.buffer_len += take;
            data = &data[take..];
            if self.buffer_len == 64 {
                let block = self.buffer;
                self.process_block(&block);
                self.buffer_len = 0;
            }
        }
        while data.len() >= 64 {
            let mut block = [0u8; 64];
            block.copy_from_slice(&data[..64]);
            self.process_block(&block);
            data = &data[64..];
        }
        if !data.is_empty() {
            self.buffer[..data.len()].copy_from_slice(data);
            self.buffer_len = data.len();
        }
    }

    fn finalize(mut self) -> [u8; 32] {
        let total_bits = self.total_len.wrapping_mul(8);
        self.buffer[self.buffer_len] = 0x80;
        self.buffer_len += 1;
        if self.buffer_len > 56 {
            for b in &mut self.buffer[self.buffer_len..64] {
                *b = 0;
            }
            let block = self.buffer;
            self.process_block(&block);
            self.buffer_len = 0;
        }
        for b in &mut self.buffer[self.buffer_len..56] {
            *b = 0;
        }
        self.buffer[56..64].copy_from_slice(&total_bits.to_be_bytes());
        let block = self.buffer;
        self.process_block(&block);
        let mut out = [0u8; 32];
        for (i, word) in self.state.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        out
    }

    fn process_block(&mut self, block: &[u8; 64]) {
        const K: [u32; 64] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
            0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
            0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
            0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
            0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
            0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
            0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
            0xc67178f2,
        ];
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut a = self.state[0];
        let mut b = self.state[1];
        let mut c = self.state[2];
        let mut d = self.state[3];
        let mut e = self.state[4];
        let mut f = self.state[5];
        let mut g = self.state[6];
        let mut h = self.state[7];
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let mj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(mj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
        self.state[4] = self.state[4].wrapping_add(e);
        self.state[5] = self.state[5].wrapping_add(f);
        self.state[6] = self.state[6].wrapping_add(g);
        self.state[7] = self.state[7].wrapping_add(h);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(prefix: &str, content: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "{prefix}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, content).unwrap();
        path
    }

    // SHA-256 NIST test vectors
    #[test]
    fn sha256_empty_string() {
        let mut h = Sha256::new();
        h.update(b"");
        let out = hex_encode(&h.finalize());
        assert_eq!(out, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    #[test]
    fn sha256_abc() {
        let mut h = Sha256::new();
        h.update(b"abc");
        let out = hex_encode(&h.finalize());
        assert_eq!(out, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn sha256_long_message() {
        // 56 bytes — exercises the boundary where padding fills the block
        let mut h = Sha256::new();
        h.update(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq");
        let out = hex_encode(&h.finalize());
        assert_eq!(out, "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    }

    #[test]
    fn sha256_very_long_message() {
        // 1,000,000 'a' characters — official test vector
        let mut h = Sha256::new();
        let chunk = [b'a'; 1000];
        for _ in 0..1000 {
            h.update(&chunk);
        }
        let out = hex_encode(&h.finalize());
        assert_eq!(out, "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
    }

    #[test]
    fn sha256_unicode() {
        let mut h = Sha256::new();
        h.update("café 🦀 日本語".as_bytes());
        let out = hex_encode(&h.finalize());
        // Verified against Python hashlib:
        // hashlib.sha256("café 🦀 日本語".encode()).hexdigest()
        assert_eq!(out, "b840e255fffd24ffc03264220e0e74b6227218860f013b57d1e5ed11922c7084");
    }

    #[test]
    fn record_and_is_stale_detects_external_modification() {
        let path = temp_file("stale", b"original content");
        let detector = StaleFileDetector::new();
        detector.record_read("conv1", path.to_str().unwrap());
        assert!(!detector.is_stale("conv1", path.to_str().unwrap()));
        // Modify file (need to change mtime, so sleep a bit).
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&path, b"modified content").unwrap();
        assert!(detector.is_stale("conv1", path.to_str().unwrap()));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn record_then_same_content_is_not_stale() {
        // If mtime changed but content is identical, is_stale returns false.
        // This is the documented Electron behavior.
        let path = temp_file("same-content", b"identical");
        let detector = StaleFileDetector::new();
        detector.record_read("c", path.to_str().unwrap());
        // Re-write the same content (changes mtime, not content).
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&path, b"identical").unwrap();
        assert!(!detector.is_stale("c", path.to_str().unwrap()));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn is_stale_returns_false_for_unknown_file() {
        let detector = StaleFileDetector::new();
        assert!(!detector.is_stale("c", "/no/such/file"));
    }

    #[test]
    fn is_stale_returns_true_when_file_deleted() {
        let path = temp_file("deleted", b"will be deleted");
        let detector = StaleFileDetector::new();
        detector.record_write("c", path.to_str().unwrap());
        let _ = std::fs::remove_file(&path);
        assert!(detector.is_stale("c", path.to_str().unwrap()));
    }

    #[test]
    fn clear_conversation_drops_only_its_snapshots() {
        let path1 = temp_file("c1", b"one");
        let path2 = temp_file("c2", b"two");
        let detector = StaleFileDetector::new();
        detector.record_read("conv1", path1.to_str().unwrap());
        detector.record_read("conv2", path2.to_str().unwrap());
        detector.clear_conversation("conv1");
        // conv1's file should now look "not stale" (unknown snapshot).
        assert!(!detector.is_stale("conv1", path1.to_str().unwrap()));
        // conv2's file should still be tracked.
        assert!(!detector.is_stale("conv2", path2.to_str().unwrap()));
        let _ = std::fs::remove_file(&path1);
        let _ = std::fs::remove_file(&path2);
    }

    #[test]
    fn record_read_silently_ignores_missing_file() {
        let detector = StaleFileDetector::new();
        // Should not panic.
        detector.record_read("c", "/no/such/file");
        assert!(!detector.is_stale("c", "/no/such/file"));
    }
}
