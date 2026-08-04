use std::{collections::HashSet, fs, path::PathBuf};

use serde::Deserialize;
use verboo_in_chrome::catalog::browser_catalog;

#[derive(Debug, Deserialize)]
struct ExtensionCatalog {
    tools: Vec<ExtensionTool>,
}

#[derive(Debug, Deserialize)]
struct ExtensionTool {
    name: String,
}

// These controller modules are imported only by the private dispatch table,
// are not in BROWSER_TOOL_CATALOG, and canonicalizeToolCall rejects them.
// They are staged/non-MCP handlers, so they must not be mistaken for missing
// catalog entries until they are deliberately exposed by the JSON catalog.
const NON_CATALOG_CONTROLLER_MODULES: &[&str] = &[
    "console_reader",
    "file_upload",
    "gif_recording",
    "network_reader",
];

fn extension_catalog_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../extensions/verboo-chrome/src/controller/browserTools.json")
}

fn extension_tools_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../extensions/verboo-chrome/src/controller/tools")
}

fn read_extension_catalog() -> ExtensionCatalog {
    let path = extension_catalog_path();
    let source = fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "could not read extension browser catalog at {}: {}",
            path.display(),
            error
        )
    });
    serde_json::from_str(&source).unwrap_or_else(|error| {
        panic!(
            "could not parse extension browser catalog at {}: {}",
            path.display(),
            error
        )
    })
}

fn camel_case_to_snake_case(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_ascii_uppercase() {
            if !result.is_empty() {
                result.push('_');
            }
            result.push(character.to_ascii_lowercase());
        } else {
            result.push(character);
        }
    }
    result
}

fn extension_tool_module_names() -> Vec<String> {
    let path = extension_tools_path();
    let entries = fs::read_dir(&path).unwrap_or_else(|error| {
        panic!(
            "could not read extension browser tool modules at {}: {}",
            path.display(),
            error
        )
    });
    let mut names = Vec::new();

    for entry in entries {
        let entry = entry.unwrap_or_else(|error| {
            panic!(
                "could not inspect extension browser tool module in {}: {}",
                path.display(),
                error
            )
        });
        let file_path = entry.path();
        let is_test = file_path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .is_some_and(|stem| stem.ends_with(".test"));
        if !file_path.is_file()
            || file_path
                .extension()
                .and_then(|extension| extension.to_str())
                != Some("js")
            || is_test
        {
            continue;
        }

        let stem = file_path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .expect("JavaScript tool module must have a UTF-8 filename");
        names.push(camel_case_to_snake_case(stem));
    }

    names.sort();
    names
}

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
fn catalog_matches_implemented_extension_tools() {
    let extension_catalog_path = extension_catalog_path();
    let extension_names = read_extension_catalog()
        .tools
        .into_iter()
        .map(|tool| tool.name)
        .collect::<Vec<_>>();

    assert!(
        !extension_names.is_empty(),
        "extension browser catalog at {} contains no tools",
        extension_catalog_path.display()
    );

    let extension_name_set = extension_names.iter().cloned().collect::<HashSet<_>>();
    assert_eq!(
        extension_names.len(),
        extension_name_set.len(),
        "extension browser catalog at {} contains duplicate tool names",
        extension_catalog_path.display()
    );

    let module_names = extension_tool_module_names();
    let module_name_set = module_names.iter().cloned().collect::<HashSet<_>>();
    let allowed_non_catalog_names = NON_CATALOG_CONTROLLER_MODULES
        .iter()
        .map(|name| (*name).to_string())
        .collect::<HashSet<_>>();
    for name in &allowed_non_catalog_names {
        assert!(
            module_name_set.contains(name),
            "allowlisted non-catalog controller module `{name}` is missing from {}",
            extension_tools_path().display()
        );
    }

    let catalog_module_names = module_name_set
        .difference(&allowed_non_catalog_names)
        .cloned()
        .collect::<HashSet<_>>();
    let mut catalog_only = extension_name_set
        .difference(&catalog_module_names)
        .cloned()
        .collect::<Vec<_>>();
    let mut module_only = catalog_module_names
        .difference(&extension_name_set)
        .cloned()
        .collect::<Vec<_>>();
    catalog_only.sort();
    module_only.sort();

    assert!(
        catalog_only.is_empty(),
        "extension catalog contains names without a tool module in {}: {:?}",
        extension_tools_path().display(),
        catalog_only
    );
    assert!(
        module_only.is_empty(),
        "extension tool modules contain names absent from the catalog at {}: {:?}",
        extension_catalog_path.display(),
        module_only
    );
    assert_eq!(
        extension_names.len(),
        catalog_module_names.len(),
        "extension catalog/module name counts differ after the explicit non-MCP allowlist"
    );
    assert!(
        extension_names
            .iter()
            .all(|name| catalog_module_names.contains(name)),
        "every catalog name must have a corresponding implemented tool module at {}",
        extension_catalog_path.display(),
    );
}
