use serde_json::Value;

use crate::models::types::{
    SubagentThreadEvent, SubagentThreadEventKind, SubagentThreadStatus, SubagentThreadUpdate,
};

const TOOL_OUTPUT_MAX: usize = 2_000;
const TOOL_OUTPUT_MAX_ERROR: usize = 3_200;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NativeSubagentSignal {
    pub tool_use_id: String,
    pub runtime_agent_id: Option<String>,
    pub session_id: Option<String>,
    pub update: SubagentThreadUpdate,
    pub start_watcher: bool,
    pub stop_watcher: bool,
}

pub(crate) fn child_updates_from_payload(
    thread_id: &str,
    payload: &Value,
    received_at: u64,
) -> Vec<SubagentThreadUpdate> {
    if payload.get("type").and_then(Value::as_str) == Some("stream_event") {
        return Vec::new();
    }

    let Some(content) = payload
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let uuid = payload
        .get("uuid")
        .and_then(Value::as_str)
        .unwrap_or("event");

    content
        .iter()
        .enumerate()
        .filter_map(|(index, block)| {
            let kind = block.get("type").and_then(Value::as_str)?;
            let event_id = format!("{thread_id}:{uuid}:{index}");
            let event = match kind {
                "text" => SubagentThreadEvent {
                    id: event_id,
                    kind: SubagentThreadEventKind::AgentMessage,
                    text: clean(block.get("text")?.as_str()?),
                    timestamp: received_at,
                    tool_name: None,
                    tool_use_id: None,
                    is_error: None,
                },
                "tool_use" => {
                    let tool_name = block.get("name").and_then(Value::as_str)?.to_string();
                    let tool_use_id = block.get("id").and_then(Value::as_str).map(str::to_string);
                    let text = safe_tool_description(block.get("input"));
                    SubagentThreadEvent {
                        id: event_id,
                        kind: SubagentThreadEventKind::ToolCall,
                        text,
                        timestamp: received_at,
                        tool_name: Some(tool_name),
                        tool_use_id,
                        is_error: None,
                    }
                }
                "tool_result" => {
                    let is_error = block
                        .get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let raw = extract_text(block.get("content")?)?;
                    SubagentThreadEvent {
                        id: event_id,
                        kind: SubagentThreadEventKind::ToolResult,
                        text: truncate_tool_output(&raw, is_error),
                        timestamp: received_at,
                        tool_name: None,
                        tool_use_id: block
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        is_error: Some(is_error),
                    }
                }
                _ => return None,
            };

            Some(SubagentThreadUpdate {
                thread_id: thread_id.to_string(),
                runtime_agent_id: None,
                tool_use_id: None,
                label: None,
                mission: None,
                status: status_for_child_event(&event),
                event: Some(event),
            })
        })
        .collect()
}

pub(crate) fn native_parent_signal(
    parent_turn_id: &str,
    payload: &Value,
    received_at: u64,
) -> Option<NativeSubagentSignal> {
    if payload.get("type").and_then(Value::as_str) == Some("assistant") {
        let uuid = payload
            .get("uuid")
            .and_then(Value::as_str)
            .unwrap_or("agent");
        let content = payload.get("message")?.get("content")?.as_array()?;
        for (index, block) in content.iter().enumerate() {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let name = block.get("name").and_then(Value::as_str)?;
            if !is_agent_tool(name) {
                continue;
            }
            let tool_use_id = block.get("id").and_then(Value::as_str)?.to_string();
            let input = block.get("input").and_then(Value::as_object);
            let mission = ["prompt", "task", "message"]
                .iter()
                .find_map(|key| input?.get(*key).and_then(Value::as_str))
                .unwrap_or_default();
            let label = input
                .and_then(|value| value.get("description"))
                .and_then(Value::as_str)
                .unwrap_or(name);
            let thread_id = native_thread_id(parent_turn_id, &tool_use_id);
            return Some(NativeSubagentSignal {
                tool_use_id: tool_use_id.clone(),
                runtime_agent_id: None,
                session_id: payload
                    .get("session_id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                update: SubagentThreadUpdate {
                    thread_id: thread_id.clone(),
                    runtime_agent_id: None,
                    tool_use_id: Some(tool_use_id.clone()),
                    label: Some(clean(label)),
                    mission: Some(clean(mission)),
                    status: Some(SubagentThreadStatus::Running),
                    event: Some(SubagentThreadEvent {
                        id: format!("{thread_id}:{uuid}:{index}"),
                        kind: SubagentThreadEventKind::Mission,
                        text: clean(mission),
                        timestamp: received_at,
                        tool_name: None,
                        tool_use_id: Some(tool_use_id),
                        is_error: None,
                    }),
                },
                start_watcher: false,
                stop_watcher: false,
            });
        }
    }

    if payload.get("type").and_then(Value::as_str) == Some("system") {
        let subtype = payload.get("subtype").and_then(Value::as_str)?;
        if !matches!(
            subtype,
            "task_started" | "task_progress" | "task_notification"
        ) {
            return None;
        }
        let tool_use_id = payload
            .get("tool_use_id")
            .and_then(Value::as_str)?
            .to_string();
        let runtime_agent_id = payload
            .get("task_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        let uuid = payload
            .get("uuid")
            .and_then(Value::as_str)
            .unwrap_or(subtype);
        let thread_id = native_thread_id(parent_turn_id, &tool_use_id);
        let (status, text, start_watcher, stop_watcher) = match subtype {
            "task_started" => (
                SubagentThreadStatus::Running,
                payload
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("Agent started"),
                true,
                false,
            ),
            "task_progress" => (
                status_for_tool(payload.get("last_tool_name").and_then(Value::as_str)),
                payload
                    .get("description")
                    .and_then(Value::as_str)
                    .or_else(|| payload.get("last_tool_name").and_then(Value::as_str))
                    .unwrap_or("Agent working"),
                true,
                false,
            ),
            "task_notification" => {
                let status = match payload.get("status").and_then(Value::as_str) {
                    Some("completed") => SubagentThreadStatus::Completed,
                    Some("stopped") => SubagentThreadStatus::Cancelled,
                    _ => SubagentThreadStatus::Failed,
                };
                (
                    status,
                    payload
                        .get("summary")
                        .and_then(Value::as_str)
                        .unwrap_or("Agent finished"),
                    false,
                    true,
                )
            }
            _ => return None,
        };
        return Some(NativeSubagentSignal {
            tool_use_id: tool_use_id.clone(),
            runtime_agent_id: runtime_agent_id.clone(),
            session_id: payload
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            update: SubagentThreadUpdate {
                thread_id: thread_id.clone(),
                runtime_agent_id,
                tool_use_id: Some(tool_use_id.clone()),
                label: None,
                mission: None,
                status: Some(status),
                event: Some(SubagentThreadEvent {
                    id: format!("{thread_id}:{uuid}"),
                    kind: SubagentThreadEventKind::Status,
                    text: clean(text),
                    timestamp: received_at,
                    tool_name: payload
                        .get("last_tool_name")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    tool_use_id: Some(tool_use_id),
                    is_error: None,
                }),
            },
            start_watcher,
            stop_watcher,
        });
    }

    None
}

pub(crate) fn native_thread_id(parent_turn_id: &str, tool_use_id: &str) -> String {
    format!("{parent_turn_id}:subagent:{tool_use_id}")
}

fn status_for_child_event(event: &SubagentThreadEvent) -> Option<SubagentThreadStatus> {
    match event.kind {
        SubagentThreadEventKind::ToolCall => Some(status_for_tool(event.tool_name.as_deref())),
        SubagentThreadEventKind::Error => Some(SubagentThreadStatus::Failed),
        _ => None,
    }
}

fn status_for_tool(name: Option<&str>) -> SubagentThreadStatus {
    let compact = name.unwrap_or_default().to_ascii_lowercase();
    if matches!(compact.as_str(), "read" | "ls" | "glob" | "grep") {
        SubagentThreadStatus::Reading
    } else if matches!(compact.as_str(), "websearch" | "webfetch" | "search") {
        SubagentThreadStatus::Searching
    } else {
        SubagentThreadStatus::Running
    }
}

fn is_agent_tool(name: &str) -> bool {
    let compact: String = name
        .chars()
        .filter(|character| !matches!(character, '-' | '_' | ' '))
        .flat_map(char::to_lowercase)
        .collect();
    compact == "agent" || compact == "task" || compact.contains("subagent")
}

fn safe_tool_description(input: Option<&Value>) -> String {
    let Some(input) = input.and_then(Value::as_object) else {
        return String::new();
    };
    [
        "command",
        "cmd",
        "file_path",
        "filePath",
        "path",
        "pattern",
        "query",
        "url",
    ]
    .iter()
    .find_map(|key| input.get(*key).and_then(Value::as_str))
    .map(clean)
    .unwrap_or_default()
}

fn extract_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(items) = value.as_array() {
        let joined = items
            .iter()
            .filter_map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .or_else(|| item.get("text").and_then(Value::as_str).map(str::to_string))
            })
            .collect::<Vec<_>>()
            .join("\n");
        return (!joined.is_empty()).then_some(joined);
    }
    value
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn truncate_tool_output(value: &str, is_error: bool) -> String {
    let cleaned = clean(value);
    let trimmed = cleaned.trim();
    let max = if is_error {
        TOOL_OUTPUT_MAX_ERROR
    } else {
        TOOL_OUTPUT_MAX
    };
    let count = trimmed.chars().count();
    if count <= max {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(max).collect();
    format!("{head}\n\n[… {} more characters truncated]", count - max)
}

fn clean(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character != '\u{1b}' {
            result.push(character);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        } else {
            chars.next();
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn child_assistant_markdown_is_preserved_in_full() {
        let markdown = format!("# Result\n\n{}", "m".repeat(4_000));
        let payload = json!({
            "type": "assistant",
            "uuid": "assistant-1",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": markdown }]
            }
        });

        let updates = child_updates_from_payload("thread:1", &payload, 10);

        assert_eq!(updates.len(), 1);
        let event = updates[0].event.as_ref().expect("event");
        assert_eq!(event.id, "thread:1:assistant-1:0");
        assert_eq!(event.kind, SubagentThreadEventKind::AgentMessage);
        assert_eq!(event.text.len(), 4_010);
    }

    #[test]
    fn child_tool_call_keeps_only_safe_description() {
        let payload = json!({
            "type": "assistant",
            "uuid": "tool-row",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": "tool-1",
                    "name": "Read",
                    "input": {
                        "file_path": "/tmp/example.rs",
                        "secret": "must-not-appear",
                        "blob": "x"
                    }
                }]
            }
        });

        let updates = child_updates_from_payload("thread:1", &payload, 20);
        let event = updates[0].event.as_ref().expect("event");

        assert_eq!(event.kind, SubagentThreadEventKind::ToolCall);
        assert_eq!(event.tool_name.as_deref(), Some("Read"));
        assert_eq!(event.tool_use_id.as_deref(), Some("tool-1"));
        assert_eq!(event.text, "/tmp/example.rs");
        assert!(!event.text.contains("must-not-appear"));
    }

    #[test]
    fn child_tool_result_is_bounded_and_errors_get_larger_limit() {
        let payload = json!({
            "type": "user",
            "uuid": "result-row",
            "message": {
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "tool-1",
                    "is_error": true,
                    "content": "e".repeat(4_000)
                }]
            }
        });

        let updates = child_updates_from_payload("thread:1", &payload, 30);
        let event = updates[0].event.as_ref().expect("event");

        assert_eq!(event.kind, SubagentThreadEventKind::ToolResult);
        assert!(event.is_error.unwrap_or(false));
        assert!(event.text.len() < 4_000);
        assert!(event.text.contains("800 more characters truncated"));
    }

    #[test]
    fn malformed_child_block_does_not_hide_later_valid_block() {
        let payload = json!({
            "type": "assistant",
            "uuid": "mixed-row",
            "message": {
                "content": [
                    { "type": "text", "text": 42 },
                    { "type": "text", "text": "valid" }
                ]
            }
        });

        let updates = child_updates_from_payload("thread:1", &payload, 40);

        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].event.as_ref().unwrap().text, "valid");
        assert_eq!(
            updates[0].event.as_ref().unwrap().id,
            "thread:1:mixed-row:1"
        );
    }

    #[test]
    fn parent_agent_call_captures_exact_mission() {
        let payload = json!({
            "type": "assistant",
            "uuid": "parent-row",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": "agent-tool-1",
                    "name": "Agent",
                    "input": {
                        "description": "Parser scout",
                        "prompt": "Inspect every parser branch."
                    }
                }]
            }
        });

        let signal = native_parent_signal("turn:1", &payload, 50).expect("signal");

        assert_eq!(signal.tool_use_id, "agent-tool-1");
        assert_eq!(signal.update.thread_id, "turn:1:subagent:agent-tool-1");
        assert_eq!(signal.update.label.as_deref(), Some("Parser scout"));
        assert_eq!(
            signal.update.mission.as_deref(),
            Some("Inspect every parser branch.")
        );
        assert_eq!(signal.update.status, Some(SubagentThreadStatus::Running));
    }

    #[test]
    fn parent_task_lifecycle_binds_runtime_and_terminal_status() {
        let started = json!({
            "type": "system",
            "subtype": "task_started",
            "uuid": "task-started-1",
            "session_id": "session-1",
            "task_id": "agent-42",
            "tool_use_id": "agent-tool-1",
            "description": "Parser scout"
        });
        let progress = json!({
            "type": "system",
            "subtype": "task_progress",
            "uuid": "task-progress-1",
            "session_id": "session-1",
            "task_id": "agent-42",
            "tool_use_id": "agent-tool-1",
            "last_tool_name": "Read"
        });
        let completed = json!({
            "type": "system",
            "subtype": "task_notification",
            "uuid": "task-done-1",
            "session_id": "session-1",
            "task_id": "agent-42",
            "tool_use_id": "agent-tool-1",
            "status": "completed",
            "summary": "Done"
        });

        let start = native_parent_signal("turn:1", &started, 60).unwrap();
        let reading = native_parent_signal("turn:1", &progress, 70).unwrap();
        let done = native_parent_signal("turn:1", &completed, 80).unwrap();

        assert_eq!(start.runtime_agent_id.as_deref(), Some("agent-42"));
        assert_eq!(start.session_id.as_deref(), Some("session-1"));
        assert!(start.start_watcher);
        assert_eq!(reading.update.status, Some(SubagentThreadStatus::Reading));
        assert_eq!(done.update.status, Some(SubagentThreadStatus::Completed));
        assert!(done.stop_watcher);
    }
}
