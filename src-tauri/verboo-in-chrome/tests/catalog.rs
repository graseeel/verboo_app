use std::collections::HashSet;

use verboo_in_chrome::catalog::browser_catalog;

#[test]
fn exposes_only_unique_browser_tools_with_valid_contracts() {
    let catalog = browser_catalog().unwrap();
    assert!(!catalog.tools.is_empty());

    let mut names = HashSet::new();
    for tool in &catalog.tools {
        assert!(matches!(tool.risk.as_str(), "read" | "mutate" | "elevated"));
        assert!(
            names.insert(tool.name.as_str()),
            "duplicate tool: {}",
            tool.name
        );
        assert_eq!(
            tool.input_schema
                .get("type")
                .and_then(|value| value.as_str()),
            Some("object")
        );

        let lowercase_name = tool.name.to_ascii_lowercase();
        assert!(
            !["shell", "filesystem", "terminal", "git", "app"]
                .iter()
                .any(|forbidden| lowercase_name.contains(forbidden)),
            "non-browser tool exposed: {}",
            tool.name
        );
    }
}

#[test]
fn catalog_matches_the_extension_contract() {
    let catalog = browser_catalog().unwrap();
    let names = catalog
        .tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect::<Vec<_>>();

    assert_eq!(
        names,
        [
            "navigate",
            "read_page",
            "click",
            "type",
            "screenshot",
            "tabs",
            "tab_group"
        ]
    );
}
