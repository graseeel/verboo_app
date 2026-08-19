//! Marketplace manifest reader — reads `.claude-plugin/marketplace.json` from
//! each marketplace's `installLocation` (provided by the CLI's `marketplace
//! list --json`) and exposes the rich per-plugin metadata the CLI's
//! `plugin list --json --available` discards: `category`, `author`,
//! `homepage`, `description`, `version`, `keywords`, `tags`, `displayName`.
//!
//! The CLI's `--available` JSON is a SUBSET of the marketplace.json — it
//! only carries `pluginId`, `name`, `description`, `marketplaceName`,
//! `source`, `installCount`. To reach Codex parity (thematic categories,
//! developer, homepage, skills list), the backend must read the manifest
//! on disk and merge by `pluginId`.
//!
//! Path derivation: the `installLocation` comes ONLY from the CLI's
//! `marketplace list --json` output. We NEVER hand-construct marketplace
//! paths — we join `<installLocation>/.claude-plugin/marketplace.json`
//! using `Path::join`. If the manifest is missing, we return
//! `InvalidMarketplace` (the source is not a valid marketplace).

use std::path::Path;

use crate::models::plugins::{Marketplace, PluginError};

// ════════════════════════════════════════════════════════════════════
// Public types
// ════════════════════════════════════════════════════════════════════

/// Rich per-plugin metadata extracted from a marketplace's
/// `.claude-plugin/marketplace.json`. Fields are `Option` because the
/// manifest is third-party and may omit any field. The FE renders `None`
/// as "unknown" — we NEVER invent values.
///
/// Keyed by `name` (the bare plugin name without `@marketplace`) in the
/// manifest's `plugins[]` array. The merge key is `pluginId` =
/// `name@marketplaceName`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MarketplacePluginEntry {
    /// Bare plugin name (e.g. "42crunch-api-security-testing"). From
    /// manifest `plugins[].name`.
    pub name: String,
    /// Thematic category (e.g. "security", "design", "development"). From
    /// manifest `plugins[].category`. Present in 208/222 real plugins.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// Developer/author name. From manifest `plugins[].author.name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// Author email (rare). From manifest `plugins[].author.email`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_email: Option<String>,
    /// Homepage URL. From manifest `plugins[].homepage`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    /// Long description. From manifest `plugins[].description`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Semver version (rare in marketplace.json — 14/222 real). From
    /// manifest `plugins[].version`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Display name (some manifests carry this). From manifest
    /// `plugins[].displayName`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Keywords array (rare). From manifest `plugins[].keywords`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    /// Tags array (some manifests carry this). From manifest `plugins[].tags`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// GitHub owner derived from the marketplace's `repo` field (e.g.
    /// "gabriel" from "gabriel/superpowers-marketplace"). Only populated
    /// for GitHub-sourced marketplaces. Used by `plugin_icon_service` for
    /// avatar fallback when the plugin's homepage yields no icon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github_owner: Option<String>,
    /// Example prompts/usage strings (optional). From manifest
    /// `plugins[].examples`. Parsed LENIENTLY: wrong type (object, number,
    /// nested array) → field ignored, entry survives. Third-party manifests
    /// may carry `examples` with their own schema; we only consume the
    /// string-array shape. Usage policy (official marketplaces only) lives
    /// in the renderer.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub examples: Vec<String>,
}

/// The parsed `.claude-plugin/marketplace.json` for a single marketplace.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceManifest {
    /// Marketplace name (e.g. "claude-plugins-official").
    pub name: String,
    /// Marketplace description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Marketplace owner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_name: Option<String>,
    /// Per-plugin entries from `plugins[]`.
    pub plugins: Vec<MarketplacePluginEntry>,
    /// The `installLocation` the CLI reported for this marketplace. Used
    /// by the FE to display the on-disk path; not part of the manifest itself.
    /// Read in tests (`assert_eq!(manifest.install_location, ...)`).
    #[serde(skip)]
    #[allow(dead_code)]
    pub install_location: String,
}

// ════════════════════════════════════════════════════════════════════
// Public API
// ════════════════════════════════════════════════════════════════════

/// Reads the `.claude-plugin/marketplace.json` for a single marketplace.
/// `install_location` comes ONLY from the CLI's `marketplace list --json`
/// output — never hand-constructed.
///
/// Returns `InvalidMarketplace` if the manifest file is missing (the source
/// is not a valid marketplace). Returns `ParseError` if the manifest exists
/// but is not valid JSON or does not match the expected schema root.
pub fn read_marketplace_manifest(install_location: &str) -> Result<MarketplaceManifest, PluginError> {
    let base = Path::new(install_location);
    let manifest_path = base.join(".claude-plugin").join("marketplace.json");

    if !manifest_path.exists() {
        return Err(PluginError::InvalidMarketplace {
            message: format!(
                "Marketplace file not found at {}",
                manifest_path.display()
            ),
        });
    }

    let raw = std::fs::read_to_string(&manifest_path).map_err(|e| PluginError::Unknown {
        message: format!("failed to read {}: {e}", manifest_path.display()),
        exit_code: None,
    })?;

    parse_manifest(&raw, install_location)
}

/// Reads manifests for ALL marketplaces in parallel and returns a map
/// keyed by `pluginId` (`name@marketplaceName`). Marketplaces whose
/// manifest is missing or unparseable are skipped with a warn log —
/// one bad marketplace must NOT fail the whole catalog.
pub fn read_all_manifests(
    marketplaces: &[Marketplace],
) -> std::collections::HashMap<String, MarketplacePluginEntry> {
    let mut map = std::collections::HashMap::new();
    for mp in marketplaces {
        // Derive GitHub owner from repo field (first segment of "owner/repo").
        let github_owner: Option<String> = mp
            .repo
            .as_deref()
            .and_then(|r| r.split('/').next())
            .filter(|s| !s.is_empty())
            .map(String::from);

        match read_marketplace_manifest(&mp.install_location) {
            Ok(manifest) => {
                for mut entry in manifest.plugins {
                    entry.github_owner = github_owner.clone();
                    let plugin_id = format!("{}@{}", entry.name, mp.name);
                    map.insert(plugin_id, entry);
                }
            }
            Err(e) => {
                eprintln!(
                    "[verboo:plugins] skipping marketplace {} manifest: {}",
                    mp.name, e
                );
            }
        }
    }
    map
}

// ════════════════════════════════════════════════════════════════════
// Internal: parsing
// ════════════════════════════════════════════════════════════════════

/// Parses a marketplace manifest JSON string. Tolerant: unknown fields are
/// ignored, missing optional fields default to `None`/empty. The root must
/// be an object with `name` (string) and `plugins` (array) — otherwise
/// `ParseError`.
fn parse_manifest(raw: &str, install_location: &str) -> Result<MarketplaceManifest, PluginError> {
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|e| PluginError::ParseError {
        message: format!("marketplace.json: {e}"),
        raw_preview: Some(truncate_str(raw.trim(), 500)),
    })?;

    let obj = value.as_object().ok_or_else(|| PluginError::ParseError {
        message: "marketplace.json root is not an object".into(),
        raw_preview: Some(truncate_str(raw.trim(), 500)),
    })?;

    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PluginError::ParseError {
            message: "marketplace.json missing 'name'".into(),
            raw_preview: Some(truncate_str(raw.trim(), 500)),
        })?
        .to_string();

    let description = obj
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let owner_name = obj
        .get("owner")
        .and_then(|v| v.get("name"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let plugins = obj
        .get("plugins")
        .and_then(|v| v.as_array())
        .map(|arr| parse_plugin_entries(arr))
        .unwrap_or_default();

    Ok(MarketplaceManifest {
        name,
        description,
        owner_name,
        plugins,
        install_location: install_location.to_string(),
    })
}

/// Parses `plugins[]` entries. Tolerant: each entry is parsed individually
/// so one malformed entry doesn't fail the whole manifest. Invalid entries
/// are skipped with a warn log.
fn parse_plugin_entries(arr: &[serde_json::Value]) -> Vec<MarketplacePluginEntry> {
    let mut out = Vec::with_capacity(arr.len());
    for (idx, item) in arr.iter().enumerate() {
        match parse_one_entry(item) {
            Ok(e) => out.push(e),
            Err(e) => {
                eprintln!(
                    "[verboo:plugins] skipping marketplace plugin[{idx}]: {e} | row={}",
                    truncate_str(&item.to_string(), 200)
                );
            }
        }
    }
    out
}

/// Parses a single `plugins[]` entry. Returns `Err` with a message if the
/// entry is missing `name` (required). All other fields are optional.
fn parse_one_entry(item: &serde_json::Value) -> Result<MarketplacePluginEntry, String> {
    let obj = item
        .as_object()
        .ok_or_else(|| "plugin entry is not an object".to_string())?;

    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing 'name'".to_string())?
        .to_string();

    let category = obj.get("category").and_then(|v| v.as_str()).map(|s| s.to_string());
    let homepage = obj.get("homepage").and_then(|v| v.as_str()).map(|s| s.to_string());
    let description = obj.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());
    let version = obj.get("version").and_then(|v| v.as_str()).map(|s| s.to_string());
    let display_name = obj
        .get("displayName")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let (author, author_email) = obj
        .get("author")
        .and_then(|v| v.as_object())
        .map(|a| {
            let name = a.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
            let email = a.get("email").and_then(|v| v.as_str()).map(|s| s.to_string());
            (name, email)
        })
        .unwrap_or((None, None));

    let keywords = obj
        .get("keywords")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let tags = obj
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    // `examples`: lenient parse. Accept only array-of-strings; any other
    // shape (object, number, nested array, mixed types) → empty vec.
    // Never fails the entry — third-party manifests may use `examples`
    // with their own schema.
    let examples = parse_examples_lenient(obj.get("examples"));

    Ok(MarketplacePluginEntry {
        name,
        category,
        author,
        author_email,
        homepage,
        description,
        version,
        display_name,
        keywords,
        tags,
        github_owner: None,
        examples,
    })
}

/// Parses `examples` leniently. Returns `Vec<String>` only when the value
/// is an array of strings. Any other shape (object, number, string, null,
/// nested arrays, mixed types) → empty vec. Non-string elements are
/// silently skipped (not errors).
fn parse_examples_lenient(value: Option<&serde_json::Value>) -> Vec<String> {
    let arr = match value {
        Some(serde_json::Value::Array(a)) => a,
        _ => return Vec::new(),
    };
    arr.iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect()
}

/// Truncates `s` to at most `max` chars (char-boundary-aware, no panic).
/// Local copy to avoid a cross-module dependency for a one-liner.
fn truncate_str(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

// ════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // ── parse_manifest (real fixtures from investigation) ──────────────

    #[test]
    fn parse_manifest_real_claude_plugins_official_fixture() {
        // Real fixture (abbreviated) from ~/.verboo/plugins/marketplaces/
        // claude-plugins-official/.claude-plugin/marketplace.json.
        let raw = r#"{
            "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
            "name": "claude-plugins-official",
            "description": "Directory of popular Claude Code extensions",
            "owner": { "name": "Anthropic", "email": "support@anthropic.com" },
            "plugins": [
                {
                    "name": "42crunch-api-security-testing",
                    "description": "Automate API security...",
                    "author": { "name": "42Crunch" },
                    "category": "security",
                    "source": { "source": "git-subdir", "url": "..." },
                    "homepage": "https://42crunch.com"
                },
                {
                    "name": "adobe-for-creativity",
                    "description": "Harness Adobe's creative AI...",
                    "author": { "name": "Adobe" },
                    "category": "design",
                    "source": { "source": "git-subdir", "url": "..." },
                    "homepage": "https://github.com/adobe/skills/tree/main/..."
                },
                {
                    "name": "agent-sdk-dev",
                    "description": "Development kit for working with the Claude Agent SDK",
                    "author": { "name": "Anthropic", "email": "support@anthropic.com" },
                    "source": "./plugins/agent-sdk-dev",
                    "category": "development",
                    "homepage": "https://github.com/anthropics/..."
                }
            ]
        }"#;
        let manifest = parse_manifest(raw, "/tmp/fake-mp").expect("parse");
        assert_eq!(manifest.name, "claude-plugins-official");
        assert_eq!(manifest.description.as_deref(), Some("Directory of popular Claude Code extensions"));
        assert_eq!(manifest.owner_name.as_deref(), Some("Anthropic"));
        assert_eq!(manifest.plugins.len(), 3);

        let p0 = &manifest.plugins[0];
        assert_eq!(p0.name, "42crunch-api-security-testing");
        assert_eq!(p0.category.as_deref(), Some("security"));
        assert_eq!(p0.author.as_deref(), Some("42Crunch"));
        assert!(p0.author_email.is_none());
        assert_eq!(p0.homepage.as_deref(), Some("https://42crunch.com"));
        assert!(p0.description.is_some());

        let p2 = &manifest.plugins[2];
        assert_eq!(p2.category.as_deref(), Some("development"));
        assert_eq!(p2.author_email.as_deref(), Some("support@anthropic.com"));
    }

    #[test]
    fn parse_manifest_tolerates_missing_optional_fields() {
        // Minimal manifest with only required fields.
        let raw = r#"{
            "name": "minimal-marketplace",
            "plugins": [
                { "name": "bare-plugin" }
            ]
        }"#;
        let manifest = parse_manifest(raw, "/tmp/fake").expect("parse");
        assert_eq!(manifest.plugins.len(), 1);
        let p = &manifest.plugins[0];
        assert_eq!(p.name, "bare-plugin");
        assert!(p.category.is_none());
        assert!(p.author.is_none());
        assert!(p.homepage.is_none());
        assert!(p.description.is_none());
        assert!(p.version.is_none());
        assert!(p.keywords.is_empty());
        assert!(p.tags.is_empty());
    }

    #[test]
    fn parse_manifest_skips_malformed_plugin_entries() {
        // One bad entry (missing name) + one good → returns 1.
        let raw = r#"{
            "name": "mp",
            "plugins": [
                { "category": "no-name" },
                { "name": "good", "category": "dev" }
            ]
        }"#;
        let manifest = parse_manifest(raw, "/tmp/fake").expect("parse");
        assert_eq!(manifest.plugins.len(), 1);
        assert_eq!(manifest.plugins[0].name, "good");
    }

    #[test]
    fn parse_manifest_missing_name_returns_parse_error() {
        let raw = r#"{ "plugins": [] }"#;
        let e = parse_manifest(raw, "/tmp/fake").unwrap_err();
        assert!(matches!(e, PluginError::ParseError { .. }));
    }

    #[test]
    fn parse_manifest_missing_plugins_array_returns_empty() {
        let raw = r#"{ "name": "mp" }"#;
        let manifest = parse_manifest(raw, "/tmp/fake").expect("parse");
        assert!(manifest.plugins.is_empty());
    }

    #[test]
    fn parse_manifest_non_object_root_returns_parse_error() {
        let raw = r#"[]"#;
        let e = parse_manifest(raw, "/tmp/fake").unwrap_err();
        assert!(matches!(e, PluginError::ParseError { .. }));
    }

    #[test]
    fn parse_manifest_invalid_json_returns_parse_error() {
        let raw = r#"{ not valid json"#;
        let e = parse_manifest(raw, "/tmp/fake").unwrap_err();
        match e {
            PluginError::ParseError { raw_preview, .. } => {
                assert!(raw_preview.is_some());
            }
            other => panic!("expected ParseError, got {other:?}"),
        }
    }

    #[test]
    fn parse_manifest_keywords_and_tags_arrays() {
        let raw = r#"{
            "name": "mp",
            "plugins": [{
                "name": "p",
                "keywords": ["k1", "k2"],
                "tags": ["t1"]
            }]
        }"#;
        let manifest = parse_manifest(raw, "/tmp/fake").expect("parse");
        let p = &manifest.plugins[0];
        assert_eq!(p.keywords, vec!["k1", "k2"]);
        assert_eq!(p.tags, vec!["t1"]);
    }

    #[test]
    fn parse_manifest_display_name_field() {
        let raw = r#"{
            "name": "mp",
            "plugins": [{ "name": "p", "displayName": "Pretty P" }]
        }"#;
        let manifest = parse_manifest(raw, "/tmp/fake").expect("parse");
        assert_eq!(manifest.plugins[0].display_name.as_deref(), Some("Pretty P"));
    }

    #[test]
    fn parse_manifest_examples_valid_string_array() {
        let raw = r#"{
            "name": "mp",
            "plugins": [{
                "name": "p",
                "examples": ["Summarize this file", "Explain the bug in foo()"]
            }]
        }"#;
        let manifest = parse_manifest(raw, "/tmp/fake").expect("parse");
        assert_eq!(manifest.plugins.len(), 1);
        assert_eq!(
            manifest.plugins[0].examples,
            vec!["Summarize this file", "Explain the bug in foo()"]
        );
    }

    #[test]
    fn parse_manifest_examples_wrong_type_entry_survives() {
        // `examples` as an object (third-party schema) → field ignored,
        // entry survives with empty examples. Same for number, string,
        // nested array, and mixed types.
        let cases: &[(&str, &[&str])] = &[
            (r#""examples": {"prompt": "x", "schema": "y"}"#, &[]),   // object
            (r#""examples": 42"#, &[]),                                // number
            (r#""examples": "single string""#, &[]),                   // string
            (r#""examples": [["nested"], ["array"]]"#, &[]),           // nested array
            (r#""examples": ["ok", 42, {"obj": true}]"#, &["ok"]),    // mixed
        ];
        for (raw_examples, expected) in cases {
            let raw = format!(
                r#"{{"name": "mp", "plugins": [{{"name": "p", {}}}]}}"#,
                raw_examples
            );
            let manifest = parse_manifest(&raw, "/tmp/fake").expect("parse");
            assert_eq!(manifest.plugins.len(), 1, "entry must survive wrong-type examples: {raw_examples}");
            assert_eq!(manifest.plugins[0].name, "p");
            let expected_vec: Vec<String> = expected.iter().map(|s| s.to_string()).collect();
            assert_eq!(manifest.plugins[0].examples, expected_vec, "raw_examples={raw_examples}");
        }
    }

    // ── read_marketplace_manifest (filesystem) ────────────────────────

    #[test]
    fn read_manifest_missing_file_returns_invalid_marketplace() {
        // A directory that exists but has no .claude-plugin/marketplace.json.
        let dir = tempfile::tempdir().expect("tempdir");
        let e = read_marketplace_manifest(dir.path().to_str().unwrap()).unwrap_err();
        match e {
            PluginError::InvalidMarketplace { message } => {
                assert!(message.contains("Marketplace file not found"));
                assert!(message.contains(".claude-plugin"));
                assert!(message.contains("marketplace.json"));
            }
            other => panic!("expected InvalidMarketplace, got {other:?}"),
        }
    }

    #[test]
    fn read_manifest_reads_real_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest_dir = dir.path().join(".claude-plugin");
        std::fs::create_dir_all(&manifest_dir).expect("mkdir");
        let manifest_path = manifest_dir.join("marketplace.json");
        let mut f = std::fs::File::create(&manifest_path).expect("create");
        let raw = r#"{
            "name": "test-mp",
            "description": "Test marketplace",
            "plugins": [{ "name": "p", "category": "dev" }]
        }"#;
        f.write_all(raw.as_bytes()).expect("write");

        let manifest = read_marketplace_manifest(dir.path().to_str().unwrap()).expect("read");
        assert_eq!(manifest.name, "test-mp");
        assert_eq!(manifest.plugins.len(), 1);
        assert_eq!(manifest.plugins[0].category.as_deref(), Some("dev"));
        assert_eq!(manifest.install_location, dir.path().to_str().unwrap());
    }

    // ── read_all_manifests (multi-marketplace) ────────────────────────

    #[test]
    fn read_all_manifests_skips_invalid_marketplaces() {
        // One marketplace with a valid manifest, one without.
        let good_dir = tempfile::tempdir().expect("tempdir");
        let good_manifest_dir = good_dir.path().join(".claude-plugin");
        std::fs::create_dir_all(&good_manifest_dir).expect("mkdir");
        std::fs::write(
            good_manifest_dir.join("marketplace.json"),
            r#"{ "name": "good-mp", "plugins": [{ "name": "plugin-a", "category": "dev" }] }"#,
        )
        .expect("write");

        let bad_dir = tempfile::tempdir().expect("tempdir");
        // No .claude-plugin/marketplace.json in bad_dir.

        let marketplaces = vec![
            Marketplace {
                name: "good-mp".into(),
                source: "github".into(),
                repo: Some("o/r".into()),
                url: None,
                install_location: good_dir.path().to_string_lossy().to_string(),
                plugin_count: None,
            },
            Marketplace {
                name: "bad-mp".into(),
                source: "github".into(),
                repo: Some("o/r2".into()),
                url: None,
                install_location: bad_dir.path().to_string_lossy().to_string(),
                plugin_count: None,
            },
        ];

        let map = read_all_manifests(&marketplaces);
        // Only the good marketplace's plugin is in the map.
        assert_eq!(map.len(), 1);
        let entry = map.get("plugin-a@good-mp").expect("entry");
        assert_eq!(entry.category.as_deref(), Some("dev"));
    }

    #[test]
    fn read_all_manifests_keys_by_plugin_id() {
        // Confirm the merge key is `name@marketplaceName`.
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest_dir = dir.path().join(".claude-plugin");
        std::fs::create_dir_all(&manifest_dir).expect("mkdir");
        std::fs::write(
            manifest_dir.join("marketplace.json"),
            r#"{ "name": "mp", "plugins": [{ "name": "p1", "category": "a" }, { "name": "p2", "category": "b" }] }"#,
        )
        .expect("write");

        let marketplaces = vec![Marketplace {
            name: "mp".into(),
            source: "github".into(),
            repo: None,
            url: None,
            install_location: dir.path().to_string_lossy().to_string(),
            plugin_count: None,
        }];

        let map = read_all_manifests(&marketplaces);
        assert_eq!(map.len(), 2);
        assert!(map.contains_key("p1@mp"));
        assert!(map.contains_key("p2@mp"));
        assert_eq!(map.get("p1@mp").unwrap().category.as_deref(), Some("a"));
    }

    // ── truncate_str (local copy) ────────────────────────────────────

    #[test]
    fn truncate_str_multibyte_no_panic() {
        let s = "€".repeat(600);
        let t = truncate_str(&s, 500);
        assert_eq!(t.chars().count(), 500);
    }
}
