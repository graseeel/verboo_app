use std::collections::HashSet;

use serde_json::json;
use verboo_in_chrome::simulator_catalog::simulator_catalog;

const EXPECTED_NAMES: [&str; 13] = [
    "ios_simulator_list",
    "ios_simulator_attach",
    "ios_simulator_wait_until_ready",
    "ios_simulator_screenshot",
    "ios_simulator_focused_element",
    "ios_simulator_tap",
    "ios_simulator_drag",
    "ios_simulator_type_text",
    "ios_simulator_press_key",
    "ios_simulator_system_action",
    "ios_simulator_list_apps",
    "ios_simulator_launch_app",
    "ios_simulator_detach",
];

#[test]
fn simulator_catalog_exposes_only_the_safe_generic_tools() {
    let catalog = simulator_catalog().unwrap();
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
    }
}

#[test]
fn simulator_catalog_uses_provider_compatible_top_level_schemas() {
    let catalog = simulator_catalog().unwrap();
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
    }
}

#[test]
fn simulator_tap_contract_accepts_a_semantic_target_without_coordinates() {
    let catalog = simulator_catalog().unwrap();
    let tap = catalog
        .tools
        .iter()
        .find(|tool| tool.name == "ios_simulator_tap")
        .unwrap();
    let description = tap.description.to_ascii_lowercase();
    assert!(description.contains("must provide target"));
    assert!(description.contains("primary locator"));
    assert!(description.contains("does not fall back"));

    let properties = tap.input_schema["properties"].as_object().unwrap();
    let target_description = properties["target"]["description"]
        .as_str()
        .unwrap()
        .to_ascii_lowercase();
    assert!(target_description.contains("must provide"));
    assert!(target_description.contains("visible text"));
    assert!(target_description.contains("accessibility identifier"));

    let validator = jsonschema::validator_for(&tap.input_schema).unwrap();
    assert!(validator.validate(&json!({"target": "Not Now"})).is_ok());
}

#[test]
fn simulator_catalog_bounds_points_and_text_and_marks_only_observations_read_only() {
    let catalog = simulator_catalog().unwrap();
    let read_only = catalog
        .tools
        .iter()
        .filter(|tool| tool.risk == "read")
        .map(|tool| tool.name.as_str())
        .collect::<HashSet<_>>();
    assert_eq!(
        read_only,
        [
            "ios_simulator_list",
            "ios_simulator_wait_until_ready",
            "ios_simulator_screenshot",
            "ios_simulator_focused_element",
            "ios_simulator_list_apps",
        ]
        .into_iter()
        .collect(),
    );

    let tap = catalog
        .tools
        .iter()
        .find(|tool| tool.name == "ios_simulator_tap")
        .unwrap();
    let tap_validator = jsonschema::validator_for(&tap.input_schema).unwrap();
    assert!(tap_validator.validate(&json!({"x": 0.0, "y": 1.0})).is_ok());
    assert!(tap_validator
        .validate(&json!({"target": "Not Now"}))
        .is_ok());
    assert!(tap_validator
        .validate(&json!({"x": 0.5, "y": 0.5, "target": "Not Now"}))
        .is_ok());
    assert!(tap_validator
        .validate(&json!({"x": 0.5, "y": 0.5, "target": ""}))
        .is_err());
    assert!(tap_validator
        .validate(&json!({"x": 0.5, "y": 0.5, "target": "a".repeat(257)}))
        .is_err());
    assert!(tap_validator
        .validate(&json!({"x": -0.01, "y": 0.5}))
        .is_err());
    assert!(tap_validator
        .validate(&json!({"x": 0.5, "y": 1.01}))
        .is_err());
    assert!(tap_validator
        .validate(&json!({"x": "0.5", "y": 0.5}))
        .is_err());

    let drag = catalog
        .tools
        .iter()
        .find(|tool| tool.name == "ios_simulator_drag")
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

    let type_text = catalog
        .tools
        .iter()
        .find(|tool| tool.name == "ios_simulator_type_text")
        .unwrap();
    let type_validator = jsonschema::validator_for(&type_text.input_schema).unwrap();
    assert!(type_validator
        .validate(&json!({"text": "a".repeat(4_000)}))
        .is_ok());
    assert!(type_validator
        .validate(&json!({"text": "a".repeat(4_001)}))
        .is_err());
}

#[test]
fn simulator_catalog_supports_bounded_native_waits_and_exact_attach_selectors() {
    let catalog = simulator_catalog().unwrap();
    let attach = catalog
        .tools
        .iter()
        .find(|tool| tool.name == "ios_simulator_attach")
        .unwrap();
    let attach_description = attach.description.to_ascii_lowercase();
    assert!(attach_description.contains("either udid"));
    assert!(attach_description.contains("both model and iosversion"));
    assert!(attach_description.contains("do not combine"));
    let attach_validator = jsonschema::validator_for(&attach.input_schema).unwrap();
    assert!(attach_validator
        .validate(&json!({"udid": "phone-a"}))
        .is_ok());
    assert!(attach_validator
        .validate(&json!({"model": "iPhone 17 Pro", "iosVersion": "27.0"}))
        .is_ok());

    let wait = catalog
        .tools
        .iter()
        .find(|tool| tool.name == "ios_simulator_wait_until_ready")
        .unwrap();
    let wait_validator = jsonschema::validator_for(&wait.input_schema).unwrap();
    assert!(wait_validator
        .validate(&json!({"timeoutMs": 90_000}))
        .is_ok());
    assert!(wait_validator
        .validate(&json!({"timeoutMs": 90_001}))
        .is_err());

    let screenshot = catalog
        .tools
        .iter()
        .find(|tool| tool.name == "ios_simulator_screenshot")
        .unwrap();
    let screenshot_validator = jsonschema::validator_for(&screenshot.input_schema).unwrap();
    assert!(screenshot_validator
        .validate(&json!({"afterFrameGeneration": 42, "timeoutMs": 5_000}))
        .is_ok());
    assert!(screenshot_validator
        .validate(&json!({"afterFrameGeneration": -1}))
        .is_err());
    assert!(screenshot_validator
        .validate(&json!({"timeoutMs": 10_001}))
        .is_err());
}
