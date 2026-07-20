use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::models::types::SubagentThreadUpdate;
use crate::services::subagent_events::child_updates_from_payload;

const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(100);
const DEFAULT_UNRESOLVED_AFTER: Duration = Duration::from_secs(5);

pub(crate) struct CliSubagentTranscriptFollower {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl CliSubagentTranscriptFollower {
    pub(crate) fn spawn<F>(
        working_directory: &str,
        session_id: &str,
        runtime_agent_id: &str,
        thread_id: String,
        mut on_update: F,
    ) -> Self
    where
        F: FnMut(SubagentThreadUpdate) + Send + 'static,
    {
        let path = transcript_path(
            &projects_root(),
            working_directory,
            session_id,
            runtime_agent_id,
        );
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = stop.clone();
        let join = thread::spawn(move || {
            follow_transcript(
                &path,
                &thread_id,
                stop_for_thread,
                DEFAULT_POLL_INTERVAL,
                DEFAULT_UNRESOLVED_AFTER,
                &mut on_update,
            );
        });
        Self {
            stop,
            join: Some(join),
        }
    }

    pub(crate) fn stop(mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for CliSubagentTranscriptFollower {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}

fn projects_root() -> PathBuf {
    std::env::var_os("VERBOO_PROJECTS_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".claude").join("projects")))
        .unwrap_or_else(|| PathBuf::from(".claude/projects"))
}

fn transcript_path(
    projects_root: &Path,
    working_directory: &str,
    session_id: &str,
    runtime_agent_id: &str,
) -> PathBuf {
    projects_root
        .join(sanitize_project_path(working_directory))
        .join(session_id)
        .join("subagents")
        .join(format!("agent-{runtime_agent_id}.jsonl"))
}

fn sanitize_project_path(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect();
    if sanitized.len() <= 200 {
        return sanitized;
    }
    format!("{}-{}", &sanitized[..200], djb2_suffix(value))
}

fn djb2_suffix(value: &str) -> String {
    let hash = value
        .bytes()
        .fold(5381_i32, |hash, byte| hash.wrapping_mul(33) ^ byte as i32);
    let magnitude = hash.unsigned_abs();
    radix_36(magnitude)
}

fn radix_36(mut value: u32) -> String {
    if value == 0 {
        return "0".into();
    }
    let mut output = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        output.push(if digit < 10 {
            (b'0' + digit) as char
        } else {
            (b'a' + digit - 10) as char
        });
        value /= 36;
    }
    output.iter().rev().collect()
}

fn follow_transcript<F>(
    path: &Path,
    thread_id: &str,
    stop: Arc<AtomicBool>,
    poll_interval: Duration,
    unresolved_after: Duration,
    on_update: &mut F,
) where
    F: FnMut(SubagentThreadUpdate),
{
    let started_at = Instant::now();
    let mut unresolved_reported = false;
    let mut offset = 0_u64;
    let mut buffered = String::new();

    loop {
        let should_stop = stop.load(Ordering::Acquire);
        match read_appended(path, &mut offset) {
            Ok(chunk) if !chunk.is_empty() => {
                buffered.push_str(&chunk);
                drain_complete_lines(thread_id, &mut buffered, on_update);
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !unresolved_reported && started_at.elapsed() >= unresolved_after {
                    unresolved_reported = true;
                    on_update(SubagentThreadUpdate {
                        thread_id: thread_id.to_string(),
                        runtime_agent_id: None,
                        tool_use_id: None,
                        label: None,
                        mission: None,
                        status: None,
                        event: Some(crate::models::types::SubagentThreadEvent {
                            id: format!("{thread_id}:live-unavailable"),
                            kind: crate::models::types::SubagentThreadEventKind::Status,
                            text: "Live transcript unavailable; completion will still be reported."
                                .into(),
                            timestamp: timestamp_ms(),
                            tool_name: None,
                            tool_use_id: None,
                            is_error: None,
                        }),
                    });
                }
            }
            Err(_) => {}
        }

        if should_stop {
            drain_complete_lines(thread_id, &mut buffered, on_update);
            drain_final_line(thread_id, &mut buffered, on_update);
            break;
        }
        thread::sleep(poll_interval);
    }
}

fn read_appended(path: &Path, offset: &mut u64) -> std::io::Result<String> {
    let metadata = fs::metadata(path)?;
    if metadata.len() < *offset {
        *offset = 0;
    }
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(*offset))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    *offset += bytes.len() as u64;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn drain_complete_lines<F>(thread_id: &str, buffered: &mut String, on_update: &mut F)
where
    F: FnMut(SubagentThreadUpdate),
{
    while let Some(newline) = buffered.find('\n') {
        let line: String = buffered.drain(..=newline).collect();
        emit_line(thread_id, &line, on_update);
    }
}

fn drain_final_line<F>(thread_id: &str, buffered: &mut String, on_update: &mut F)
where
    F: FnMut(SubagentThreadUpdate),
{
    if buffered.trim().is_empty() {
        return;
    }
    let line = std::mem::take(buffered);
    emit_line(thread_id, &line, on_update);
}

fn emit_line<F>(thread_id: &str, line: &str, on_update: &mut F)
where
    F: FnMut(SubagentThreadUpdate),
{
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    let Ok(payload) = serde_json::from_str(trimmed) else {
        return;
    };
    for update in child_updates_from_payload(thread_id, &payload, timestamp_ms()) {
        on_update(update);
    }
}

fn timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::Mutex;

    #[test]
    fn path_matches_cli_layout_without_machine_specific_segments() {
        let path = transcript_path(
            Path::new("/projects"),
            "/Users/example/code/app",
            "session-1",
            "agent-42",
        );
        assert_eq!(
            path,
            PathBuf::from(
                "/projects/-Users-example-code-app/session-1/subagents/agent-agent-42.jsonl"
            )
        );
    }

    #[test]
    fn follower_waits_for_file_and_preserves_partial_jsonl_rows() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("agent.jsonl");
        let stop = Arc::new(AtomicBool::new(false));
        let updates = Arc::new(Mutex::new(Vec::new()));
        let updates_for_thread = updates.clone();
        let stop_for_thread = stop.clone();
        let path_for_thread = path.clone();

        let join = thread::spawn(move || {
            follow_transcript(
                &path_for_thread,
                "turn:1:subagent:tool-1",
                stop_for_thread,
                Duration::from_millis(5),
                Duration::from_secs(1),
                &mut |update| updates_for_thread.lock().unwrap().push(update),
            )
        });

        thread::sleep(Duration::from_millis(15));
        let mut file = File::create(&path).unwrap();
        write!(file, "{{\"type\":\"assistant\",\"uuid\":\"row-1\",\"message\":{{\"content\":[{{\"type\":\"text\",\"text\":\"hel").unwrap();
        file.flush().unwrap();
        thread::sleep(Duration::from_millis(15));
        assert!(updates.lock().unwrap().is_empty());

        writeln!(file, "lo\"}}]}}}}").unwrap();
        writeln!(file, "not-json").unwrap();
        file.flush().unwrap();
        thread::sleep(Duration::from_millis(30));
        stop.store(true, Ordering::Release);
        join.join().unwrap();

        let updates = updates.lock().unwrap();
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].event.as_ref().unwrap().text, "hello");
    }

    #[test]
    fn follower_flushes_complete_final_row_without_newline_on_stop() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("agent.jsonl");
        let payload = r#"{"type":"assistant","uuid":"row-1","message":{"content":[{"type":"text","text":"final"}]}}"#;
        std::fs::write(&path, payload).unwrap();
        let stop = Arc::new(AtomicBool::new(true));
        let mut updates = Vec::new();

        follow_transcript(
            &path,
            "thread-1",
            stop,
            Duration::from_millis(1),
            Duration::from_secs(1),
            &mut |update| updates.push(update),
        );

        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].event.as_ref().unwrap().text, "final");
    }
}
