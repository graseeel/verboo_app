use std::collections::HashSet;

use serde_json::json;
use verboo_in_chrome::simulator_catalog::simulator_catalog;

const EXPECTED_NAMES: [&str; 8] = [
    "ios_simulator_list",
    "ios_simulator_attach",
    "ios_simulator_screenshot",
    "ios_simulator_tap",
    "ios_simulator_drag",
    "ios_simulator_type_text",
    "ios_simulator_press_key",
    "ios_simulator_detach",
];

#[test]
fn simulator_catalog_exposes_exactly_the_eight_safe_tools() {
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
        ["ios_simulator_list", "ios_simulator_screenshot"]
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
        .validate(&json!({"x": -0.01, "y": 0.5}))
        .is_err());
    assert!(tap_validator
        .validate(&json!({"x": 0.5, "y": 1.01}))
        .is_err());
    assert!(tap_validator
        .validate(&json!({"x": "0.5", "y": 0.5}))
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
