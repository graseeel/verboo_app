//! Android accessibility snapshots and system actions (PA-28).

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use quick_xml::events::Event;
use quick_xml::Reader;
use quick_xml::XmlVersion;
use serde::{Deserialize, Serialize};

use super::input::{emit_presence, InputOrigin, PresenceTarget};
use super::session::AndroidSession;
use super::AndroidEmulatorService;

const A11Y_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const UIAUTOMATOR_DUMP_PATH: &str = "/sdcard/verboo-uiautomator.xml";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AndroidEmulatorRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AndroidAccessibilityNode {
    pub id: String,
    pub role: String,
    pub label: Option<String>,
    pub value: Option<String>,
    pub frame: AndroidEmulatorRect,
    pub enabled: bool,
    pub visible: bool,
    pub actionable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AndroidAccessibilitySnapshot {
    pub nodes: Vec<AndroidAccessibilityNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AndroidEmulatorElementHit {
    pub element: AndroidAccessibilityNode,
    pub rect: AndroidEmulatorRect,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AndroidEmulatorSystemAction {
    Back,
    Home,
    Recents,
    Rotate,
    Notifications,
}

impl AndroidEmulatorSystemAction {
    fn presence_name(self) -> &'static str {
        match self {
            Self::Back => "back",
            Self::Home => "home",
            Self::Recents => "recents",
            Self::Rotate => "rotate",
            Self::Notifications => "notifications",
        }
    }
}

pub(crate) fn parse_uiautomator_dump(
    xml: &str,
    dimensions: (u32, u32),
) -> Result<AndroidAccessibilitySnapshot, String> {
    if dimensions.0 == 0 || dimensions.1 == 0 {
        return Err("Android accessibility dimensions are not ready".to_string());
    }

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut nodes = Vec::new();
    let mut buffer = Vec::new();
    loop {
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| format!("could not parse Android accessibility XML: {error}"))?;
        match event {
            Event::Eof => break,
            Event::Start(element) | Event::Empty(element) if element.name().as_ref() == b"node" => {
                let mut attributes = Vec::new();
                for attribute in element.attributes().with_checks(false) {
                    let attribute = attribute.map_err(|error| {
                        format!("could not parse Android accessibility attribute: {error}")
                    })?;
                    let key = String::from_utf8_lossy(attribute.key.as_ref()).into_owned();
                    let value = attribute
                        .decoded_and_normalized_value(XmlVersion::Implicit1_0, reader.decoder())
                        .map_err(|error| {
                            format!("could not decode Android accessibility attribute: {error}")
                        })?
                        .into_owned();
                    attributes.push((key, value));
                }
                let raw_bounds = attribute(&attributes, "bounds")
                    .ok_or_else(|| "Android accessibility node is missing bounds".to_string())?;
                let bounds = parse_bounds(raw_bounds)?;
                let frame = normalize_bounds(bounds, dimensions);
                let ordinal = nodes.len();
                let id = non_empty_attribute(&attributes, "resource-id")
                    .or_else(|| non_empty_attribute(&attributes, "index"))
                    .unwrap_or_else(|| format!("node-{ordinal}"));
                let role = attribute(&attributes, "class")
                    .unwrap_or_default()
                    .to_string();
                let label = non_empty_attribute(&attributes, "content-desc");
                let value = non_empty_attribute(&attributes, "text");
                let clickable = bool_attribute(&attributes, "clickable", false);
                let long_clickable = bool_attribute(&attributes, "long-clickable", false);
                let focusable = bool_attribute(&attributes, "focusable", false);
                nodes.push(AndroidAccessibilityNode {
                    id,
                    role,
                    label,
                    value,
                    frame,
                    enabled: bool_attribute(&attributes, "enabled", true),
                    visible: bool_attribute(&attributes, "visible-to-user", true),
                    actionable: clickable || long_clickable || focusable,
                });
            }
            _ => {}
        }
        buffer.clear();
    }
    Ok(AndroidAccessibilitySnapshot { nodes })
}

fn attribute<'a>(attributes: &'a [(String, String)], key: &str) -> Option<&'a str> {
    attributes
        .iter()
        .find_map(|(name, value)| (name == key).then_some(value.as_str()))
}

fn non_empty_attribute(attributes: &[(String, String)], key: &str) -> Option<String> {
    attribute(attributes, key)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn bool_attribute(attributes: &[(String, String)], key: &str, default: bool) -> bool {
    attribute(attributes, key)
        .and_then(|value| match value {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        })
        .unwrap_or(default)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RawBounds {
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
}

fn parse_bounds(value: &str) -> Result<RawBounds, String> {
    let value = value.trim();
    let (first, rest) = value
        .strip_prefix('[')
        .and_then(|value| value.split_once(']'))
        .ok_or_else(|| format!("invalid Android accessibility bounds: {value}"))?;
    let (second, remainder) = rest
        .strip_prefix('[')
        .and_then(|value| value.split_once(']'))
        .ok_or_else(|| format!("invalid Android accessibility bounds: {value}"))?;
    if !remainder.is_empty() {
        return Err(format!("invalid Android accessibility bounds: {value}"));
    }
    let (x1, y1) = parse_coordinate_pair(first, value)?;
    let (x2, y2) = parse_coordinate_pair(second, value)?;
    if x2 < x1 || y2 < y1 {
        return Err(format!("invalid Android accessibility bounds: {value}"));
    }
    Ok(RawBounds { x1, y1, x2, y2 })
}

fn parse_coordinate_pair(value: &str, original: &str) -> Result<(i32, i32), String> {
    let (x, y) = value
        .split_once(',')
        .ok_or_else(|| format!("invalid Android accessibility bounds: {original}"))?;
    let x = x
        .parse::<i32>()
        .map_err(|_| format!("invalid Android accessibility bounds: {original}"))?;
    let y = y
        .parse::<i32>()
        .map_err(|_| format!("invalid Android accessibility bounds: {original}"))?;
    Ok((x, y))
}

fn normalize_bounds(bounds: RawBounds, dimensions: (u32, u32)) -> AndroidEmulatorRect {
    let width = f64::from(dimensions.0);
    let height = f64::from(dimensions.1);
    AndroidEmulatorRect {
        x: f64::from(bounds.x1) / width,
        y: f64::from(bounds.y1) / height,
        width: f64::from(bounds.x2 - bounds.x1) / width,
        height: f64::from(bounds.y2 - bounds.y1) / height,
    }
}

pub(crate) fn hit_test_nodes(
    nodes: &[AndroidAccessibilityNode],
    x: f64,
    y: f64,
) -> Result<Option<AndroidEmulatorElementHit>, String> {
    if !x.is_finite() || !y.is_finite() || !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
        return Err("Android inspect point must be normalized between 0 and 1".to_string());
    }
    let node = nodes
        .iter()
        .filter(|node| {
            x >= node.frame.x
                && x <= node.frame.x + node.frame.width
                && y >= node.frame.y
                && y <= node.frame.y + node.frame.height
        })
        .min_by(|left, right| {
            let left_area = left.frame.width * left.frame.height;
            let right_area = right.frame.width * right.frame.height;
            left_area
                .partial_cmp(&right_area)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    Ok(node.map(|node| AndroidEmulatorElementHit {
        element: node.clone(),
        rect: node.frame.clone(),
    }))
}

pub(crate) fn build_system_action_args(
    serial: &str,
    action: AndroidEmulatorSystemAction,
) -> Vec<String> {
    let mut args = vec!["-s".to_string(), serial.to_string(), "shell".to_string()];
    match action {
        AndroidEmulatorSystemAction::Back => {
            args.extend(["input", "keyevent", "4"].map(str::to_string));
        }
        AndroidEmulatorSystemAction::Home => {
            args.extend(["input", "keyevent", "3"].map(str::to_string));
        }
        AndroidEmulatorSystemAction::Recents => {
            args.extend(["input", "keyevent", "187"].map(str::to_string));
        }
        AndroidEmulatorSystemAction::Notifications => {
            args.extend(["cmd", "statusbar", "expand-notifications"].map(str::to_string));
        }
        AndroidEmulatorSystemAction::Rotate => {
            args.extend(["settings", "put", "system", "user_rotation", "1"].map(str::to_string));
        }
    }
    args
}

fn run_checked(
    service: &AndroidEmulatorService,
    session: &AndroidSession,
    args: &[String],
    operation: &str,
) -> Result<Vec<u8>, String> {
    if session.stop.load(Ordering::Acquire) {
        return Err("Android emulator session has ended".to_string());
    }
    let output = service.runner.run_interruptible(
        session.adb_path.to_string_lossy().as_ref(),
        args,
        &session.stop,
        Instant::now() + A11Y_COMMAND_TIMEOUT,
    )?;
    if output.success {
        Ok(output.stdout)
    } else {
        Err(format!(
            "adb {operation} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

impl AndroidEmulatorService {
    pub(crate) fn system_action_sync(
        &self,
        action: AndroidEmulatorSystemAction,
        origin: InputOrigin,
    ) -> Result<(), String> {
        let session = self.current_session()?;
        let _guard = session
            .input_lock
            .lock()
            .expect("Android emulator input queue poisoned");
        let target = PresenceTarget::None;
        let emit_agent_presence = origin == InputOrigin::Agent;
        if emit_agent_presence {
            emit_presence(
                &self.app,
                session.generation,
                "systemAction",
                &target,
                "start",
            );
        }
        let result = run_checked(
            self,
            &session,
            &build_system_action_args(&session.serial, action),
            action.presence_name(),
        )
        .map(|_| ());
        if emit_agent_presence {
            emit_presence(
                &self.app,
                session.generation,
                "systemAction",
                &target,
                "clear",
            );
        }
        result
    }

    pub(crate) fn accessibility_snapshot_sync(
        &self,
    ) -> Result<AndroidAccessibilitySnapshot, String> {
        let session = self.current_session()?;
        let _guard = session
            .input_lock
            .lock()
            .expect("Android emulator input queue poisoned");
        let dump_args = vec![
            "-s".to_string(),
            session.serial.clone(),
            "shell".to_string(),
            "uiautomator".to_string(),
            "dump".to_string(),
            "--compressed".to_string(),
            UIAUTOMATOR_DUMP_PATH.to_string(),
        ];
        run_checked(self, &session, &dump_args, "uiautomator dump")?;
        let read_args = vec![
            "-s".to_string(),
            session.serial.clone(),
            "exec-out".to_string(),
            "cat".to_string(),
            UIAUTOMATOR_DUMP_PATH.to_string(),
        ];
        let xml = run_checked(self, &session, &read_args, "read accessibility dump")?;
        let dimensions = session.adb_input_display_size()?;
        parse_uiautomator_dump(&String::from_utf8_lossy(&xml), dimensions)
    }

    pub(crate) fn inspect_point_sync(
        &self,
        x: f64,
        y: f64,
    ) -> Result<Option<AndroidEmulatorElementHit>, String> {
        let snapshot = self.accessibility_snapshot_sync()?;
        hit_test_nodes(&snapshot.nodes, x, y)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use crate::services::android_emulator::preview::{FirstPreviewGate, PreviewMode};
    use crate::services::android_emulator::session::{
        AndroidEmulatorOwnership, AndroidSession, PreviewGate, PreviewRuntime,
    };
    use crate::services::android_emulator::{AndroidDevice, CommandOutput, CommandRunner};

    // Fixture origin: the XML shape emitted by Android's
    // `adb shell uiautomator dump` command. There is no live AVD in this
    // macOS gate, so the fixture documents the real command/output format
    // rather than pretending to be a live capture.
    const UIAUTOMATOR_DUMP_FIXTURE: &str = r#"<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" clickable="false" enabled="true" visible-to-user="true" bounds="[0,0][1080,1920]"><node index="1" text="Entrar" resource-id="com.example:id/login" class="android.widget.Button" package="com.example" content-desc="Entrar" clickable="true" enabled="true" visible-to-user="true" long-clickable="false" focusable="true" bounds="[100,200][500,400]" /></node></hierarchy>"#;

    #[test]
    fn accessibility_snapshot_normalizes_bounds_against_device_display_not_preview_frame() {
        let root = tempfile::tempdir().unwrap();
        let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
        service.runner = Arc::new(AccessibilityRunner::default());
        let session = test_session();
        *session.dimensions.lock().unwrap() = Some((720, 1600));
        service.state.lock().unwrap().session = Some(session);

        let snapshot = service.accessibility_snapshot_sync().unwrap();
        assert_eq!(
            snapshot.nodes[1].frame,
            AndroidEmulatorRect {
                x: 100.0 / 1080.0,
                y: 200.0 / 1920.0,
                width: 400.0 / 1080.0,
                height: 200.0 / 1920.0,
            },
            "uiautomator bounds are device pixels; must not divide by the 720x1600 preview frame"
        );
    }

    #[test]
    fn uiautomator_dump_nodes_normalize_bounds_and_preserve_semantics() {
        let snapshot = parse_uiautomator_dump(UIAUTOMATOR_DUMP_FIXTURE, (1080, 1920))
            .expect("documented uiautomator fixture should parse");

        assert_eq!(snapshot.nodes.len(), 2);
        assert_eq!(snapshot.nodes[1].id, "com.example:id/login");
        assert_eq!(snapshot.nodes[1].role, "android.widget.Button");
        assert_eq!(snapshot.nodes[1].label.as_deref(), Some("Entrar"));
        assert_eq!(snapshot.nodes[1].value.as_deref(), Some("Entrar"));
        assert!(snapshot.nodes[1].enabled);
        assert!(snapshot.nodes[1].visible);
        assert!(snapshot.nodes[1].actionable);
        assert_eq!(
            snapshot.nodes[1].frame,
            AndroidEmulatorRect {
                x: 100.0 / 1080.0,
                y: 200.0 / 1920.0,
                width: 400.0 / 1080.0,
                height: 200.0 / 1920.0,
            }
        );
    }

    #[test]
    fn malformed_or_reversed_uiautomator_bounds_are_rejected() {
        let malformed =
            r#"<hierarchy><node class="android.view.View" bounds="[0,0][oops,20]" /></hierarchy>"#;
        let error = parse_uiautomator_dump(malformed, (1080, 1920)).unwrap_err();
        assert!(error.contains("bounds"), "unexpected parser error: {error}");

        let reversed =
            r#"<hierarchy><node class="android.view.View" bounds="[20,20][10,10]" /></hierarchy>"#;
        let error = parse_uiautomator_dump(reversed, (1080, 1920)).unwrap_err();
        assert!(error.contains("bounds"), "unexpected parser error: {error}");
    }

    #[test]
    fn inspect_point_returns_the_most_specific_matching_node() {
        let snapshot = AndroidAccessibilitySnapshot {
            nodes: vec![
                node(
                    "root",
                    AndroidEmulatorRect {
                        x: 0.0,
                        y: 0.0,
                        width: 1.0,
                        height: 1.0,
                    },
                ),
                node(
                    "button",
                    AndroidEmulatorRect {
                        x: 0.2,
                        y: 0.2,
                        width: 0.4,
                        height: 0.2,
                    },
                ),
            ],
        };

        let hit = hit_test_nodes(&snapshot.nodes, 0.3, 0.3)
            .expect("normalized point should be accepted")
            .expect("point should hit the button");
        assert_eq!(hit.element.id, "button");
        assert_eq!(hit.rect, snapshot.nodes[1].frame);
        assert!(hit_test_nodes(&snapshot.nodes, 1.1, 0.3).is_err());
    }

    #[test]
    fn system_action_arguments_match_the_frozen_android_contract() {
        assert_eq!(
            build_system_action_args("emulator-5554", AndroidEmulatorSystemAction::Back),
            vec!["-s", "emulator-5554", "shell", "input", "keyevent", "4"]
        );
        assert_eq!(
            build_system_action_args("emulator-5554", AndroidEmulatorSystemAction::Home),
            vec!["-s", "emulator-5554", "shell", "input", "keyevent", "3"]
        );
        assert_eq!(
            build_system_action_args("emulator-5554", AndroidEmulatorSystemAction::Recents),
            vec!["-s", "emulator-5554", "shell", "input", "keyevent", "187"]
        );
        assert_eq!(
            build_system_action_args("emulator-5554", AndroidEmulatorSystemAction::Notifications),
            vec![
                "-s",
                "emulator-5554",
                "shell",
                "cmd",
                "statusbar",
                "expand-notifications"
            ]
        );
        assert_eq!(
            build_system_action_args("emulator-5554", AndroidEmulatorSystemAction::Rotate),
            vec![
                "-s",
                "emulator-5554",
                "shell",
                "settings",
                "put",
                "system",
                "user_rotation",
                "1"
            ]
        );
    }

    #[derive(Default)]
    struct AccessibilityRunner {
        calls: Mutex<Vec<Vec<String>>>,
    }

    impl CommandRunner for AccessibilityRunner {
        fn run(&self, _program: &str, args: &[String]) -> Result<CommandOutput, String> {
            self.calls.lock().unwrap().push(args.to_vec());
            let stdout = if args.iter().any(|argument| argument == "cat") {
                UIAUTOMATOR_DUMP_FIXTURE.as_bytes().to_vec()
            } else {
                Vec::new()
            };
            Ok(CommandOutput {
                success: true,
                stdout,
                stderr: Vec::new(),
            })
        }
    }

    #[test]
    fn system_action_emits_presence_only_for_agent_origin() {
        let root = tempfile::tempdir().unwrap();
        let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
        service.runner = Arc::new(AccessibilityRunner::default());
        service.state.lock().unwrap().session = Some(test_session());

        super::super::input::take_presence_log();
        service
            .system_action_sync(AndroidEmulatorSystemAction::Back, InputOrigin::Agent)
            .unwrap();
        assert_eq!(
            super::super::input::take_presence_log(),
            ["start:systemAction", "clear:systemAction"]
        );

        service
            .system_action_sync(AndroidEmulatorSystemAction::Home, InputOrigin::Manual)
            .unwrap();
        assert!(
            super::super::input::take_presence_log().is_empty(),
            "manual systemAction must not emit presence"
        );

        service
            .system_action_sync(AndroidEmulatorSystemAction::Recents, InputOrigin::default())
            .unwrap();
        assert_eq!(
            super::super::input::take_presence_log(),
            ["start:systemAction", "clear:systemAction"]
        );
    }

    #[test]
    fn service_snapshot_and_system_action_use_the_real_interruptible_adb_path() {
        let root = tempfile::tempdir().unwrap();
        let mut service = AndroidEmulatorService::new(root.path().to_path_buf()).unwrap();
        let runner = Arc::new(AccessibilityRunner::default());
        service.runner = runner.clone();
        service.state.lock().unwrap().session = Some(test_session());

        let snapshot = service.accessibility_snapshot_sync().unwrap();
        assert_eq!(snapshot.nodes.len(), 2);
        service
            .system_action_sync(AndroidEmulatorSystemAction::Back, InputOrigin::default())
            .unwrap();

        let calls = runner.calls.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert_eq!(
            calls[0],
            vec![
                "-s",
                "emulator-5554",
                "shell",
                "uiautomator",
                "dump",
                "--compressed",
                "/sdcard/verboo-uiautomator.xml"
            ]
        );
        assert_eq!(
            calls[1],
            vec![
                "-s",
                "emulator-5554",
                "exec-out",
                "cat",
                "/sdcard/verboo-uiautomator.xml"
            ]
        );
        assert_eq!(
            calls[2],
            vec!["-s", "emulator-5554", "shell", "input", "keyevent", "4"]
        );
    }

    fn test_session() -> Arc<AndroidSession> {
        Arc::new(AndroidSession {
            avd_name: "Pixel_8_API_35".to_string(),
            device: AndroidDevice {
                avd_name: "Pixel_8_API_35".to_string(),
                display_name: "Pixel 8".to_string(),
                api_level: 35,
                family: crate::services::android_emulator::requirements::AndroidDeviceFamily::Phone,
                running: true,
            },
            serial: "emulator-5554".to_string(),
            adb_path: PathBuf::from("adb"),
            ownership: AndroidEmulatorOwnership::External,
            generation: 1,
            stream_fps: Arc::new(Mutex::new(30)),
            fallback_fps: Arc::new(Mutex::new(2.0)),
            gate: Arc::new(PreviewGate::new(true)),
            stop: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            input_lock: Arc::new(Mutex::new(())),
            dimensions: Arc::new(Mutex::new(Some((1080, 1920)))),
            device_display_size: (1080, 1920),
            emulator_process: Arc::new(Mutex::new(None)),
            recording: Arc::new(Mutex::new(None)),
            workers: Mutex::new(Vec::new()),
            emulator_pid: None,
            gpu_software: false,
            preview: Arc::new(PreviewRuntime::new(PreviewMode::LegacyPrimary, 1)),
            first_preview: Arc::new(FirstPreviewGate::new()),
        })
    }

    fn node(id: &str, frame: AndroidEmulatorRect) -> AndroidAccessibilityNode {
        AndroidAccessibilityNode {
            id: id.to_string(),
            role: "android.view.View".to_string(),
            label: None,
            value: None,
            frame,
            enabled: true,
            visible: true,
            actionable: true,
        }
    }
}
