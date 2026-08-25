use std::collections::HashSet;

use serde_json::json;
use verboo_in_chrome::android_emulator_catalog::android_emulator_catalog;

const EXPECTED_NAMES: [&str; 11] = [
    "android_emulator_list",
    "android_emulator_attach",
    "android_emulator_wait_until_ready",
    "android_emulator_screenshot",
    "android_emulator_tap",
    "android_emulator_drag",
    "android_emulator_type_text",
    "android_emulator_press_key",
    "android_emulator_system_action",
    "android_emulator_detach",
    "android_emulator_shutdown",
];

#[test]
fn android_emulator_catalog_exposes_the_panel_tools_with_the_ios_catalog_grip() {
    let catalog = android_emulator_catalog().unwrap();
    let names = catalog
        .tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect::<HashSet<_>>();

    assert_eq!(catalog.tools.len(), EXPECTED_NAMES.len());
    assert_eq!(names, EXPECTED_NAMES.into_iter().collect());
    for tool in &catalog.tools {
        assert!(matches!(tool.risk.as_str(), "read" | "mutate"));
        assert_eq!(tool.input_schema.get("type"), Some(&json!("object")));
        let description = tool.description.to_ascii_lowercase();
        assert!(
            description.contains("official verboo tool")
                && description.contains("embedded android emulator"),
            "{} must advertise itself as the official Verboo Android emulator tool, got: {}",
            tool.name,
            tool.description,
        );
    }
}

#[test]
fn android_emulator_catalog_uses_provider_compatible_top_level_schemas() {
    let catalog = android_emulator_catalog().unwrap();
    let unsupported = [
        "oneOf",
        "allOf",
        "anyOf",
        "dependentRequired",
        "if",
        "then",
        "else",
        "not",
    ];

    for tool in &catalog.tools {
        let schema = tool.input_schema.as_object().unwrap();
        for keyword in unsupported {
            assert!(
                !schema.contains_key(keyword),
                "{} exposes unsupported top-level schema keyword {keyword}",
                tool.name,
            );
        }
        assert_eq!(schema.get("additionalProperties"), Some(&json!(false)));
    }
}

#[test]
fn android_emulator_catalog_rejects_manual_origin_so_agent_presence_stays_default() {
    let catalog = android_emulator_catalog().unwrap();
    for name in [
        "android_emulator_tap",
        "android_emulator_drag",
        "android_emulator_type_text",
        "android_emulator_press_key",
        "android_emulator_system_action",
    ] {
        let tool = catalog.tools.iter().find(|tool| tool.name == name).unwrap();
        let properties = tool.input_schema["properties"].as_object().unwrap();
        assert!(
            !properties.contains_key("origin"),
            "{name} must not accept origin; the agent default guarantees presence"
        );
        let validator = jsonschema::validator_for(&tool.input_schema).unwrap();
        let mut arguments = match name {
            "android_emulator_tap" => json!({"x": 0.5, "y": 0.5}),
            "android_emulator_drag" => json!({
                "fromX": 0.5,
                "fromY": 0.9,
                "toX": 0.5,
                "toY": 0.2
            }),
            "android_emulator_type_text" => json!({"text": "hi"}),
            "android_emulator_press_key" => json!({"key": "enter"}),
            "android_emulator_system_action" => json!({"action": "home"}),
            _ => unreachable!(),
        };
        arguments
            .as_object_mut()
            .unwrap()
            .insert("origin".into(), json!("manual"));
        assert!(
            validator.validate(&arguments).is_err(),
            "{name} must reject a caller-supplied origin"
        );
    }
}

#[test]
fn android_emulator_tap_contract_accepts_a_semantic_target_without_coordinates() {
    let catalog = android_emulator_catalog().unwrap();
    let tap = catalog
        .tools
        .iter()
        .find(|tool| tool.name == "android_emulator_tap")
        .unwrap();
    let description = tap.description.to_ascii_lowercase();
    assert!(description.contains("must provide target"));
    assert!(description.contains("primary locator"));
    assert!(description.contains("does not fall back"));

    let validator = jsonschema::validator_for(&tap.input_schema).unwrap();
    assert!(validator.validate(&json!({"target": "Chrome"})).is_ok());
    assert!(validator.validate(&json!({"x": 0.0, "y": 1.0})).is_ok());
    assert!(validator
        .validate(&json!({"x": 0.5, "y": 0.5, "target": "Chrome"}))
        .is_ok());
    assert!(validator.validate(&json!({"x": -0.01, "y": 0.5})).is_err());
    assert!(validator.validate(&json!({"x": 0.5, "y": 1.01})).is_err());
}

#[test]
fn android_emulator_catalog_bounds_points_keys_actions_and_marks_only_observations_read_only() {
    let catalog = android_emulator_catalog().unwrap();
    let read_only = catalog
        .tools
        .iter()
        .filter(|tool| tool.risk == "read")
        .map(|tool| tool.name.as_str())
        .collect::<HashSet<_>>();
    assert_eq!(
        read_only,
        [
            "android_emulator_list",
            "android_emulator_wait_until_ready",
            "android_emulator_screenshot",
        ]
        .into_iter()
        .collect(),
    );

    let press = catalog
        .tools
        .iter()
        .find(|tool| tool.name == "android_emulator_press_key")
        .unwrap();
    let press_validator = jsonschema::validator_for(&press.input_schema).unwrap();
    assert!(press_validator.validate(&json!({"key": "space"})).is_ok());
    assert!(press_validator.validate(&json!({"key": "escape"})).is_ok());
    assert!(press_validator.validate(&json!({"key": "shift"})).is_err());

    let action = catalog
        .tools
        .iter()
        .find(|tool| tool.name == "android_emulator_system_action")
        .unwrap();
    let action_validator = jsonschema::validator_for(&action.input_schema).unwrap();
    assert!(action_validator
        .validate(&json!({"action": "back"}))
        .is_ok());
    assert!(action_validator
        .validate(&json!({"action": "recents"}))
        .is_ok());
    assert!(action_validator
        .validate(&json!({"action": "appSwitcher"}))
        .is_err());

    let attach = catalog
        .tools
        .iter()
        .find(|tool| tool.name == "android_emulator_attach")
        .unwrap();
    let attach_description = attach.description.to_ascii_lowercase();
    assert!(attach_description.contains("boot"));
    let attach_validator = jsonschema::validator_for(&attach.input_schema).unwrap();
    assert!(attach_validator
        .validate(&json!({"avdName": "Pixel_8_API_35"}))
        .is_ok());
    assert!(attach_validator.validate(&json!({})).is_ok());

    let drag = catalog
        .tools
        .iter()
        .find(|tool| tool.name == "android_emulator_drag")
        .unwrap();
    let drag_validator = jsonschema::validator_for(&drag.input_schema).unwrap();
    assert!(drag_validator
        .validate(&json!({
            "fromX": 0.5,
            "fromY": 0.9,
            "toX": 0.5,
            "toY": 0.2,
            "durationMs": 180
        }))
        .is_ok());
    assert!(drag_validator
        .validate(&json!({
            "from": {"x": 0.5, "y": 0.9},
            "to": {"x": 0.5, "y": 0.2}
        }))
        .is_err());
}
