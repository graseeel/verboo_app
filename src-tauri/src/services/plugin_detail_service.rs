//! Plugin detail service — for INSTALLED plugins, walks `skills/*/SKILL.md`
//! and reads `.claude-plugin/plugin.json` to expose the rich metadata the
//! CLI's `plugin list --json` omits: skills list (name + description),
//! author, homepage, version, license, keywords.
//!
//! Path derivation: the `install_path` comes ONLY from the CLI's
//! `plugin list --json` output (the `installPath` field). We NEVER
//! hand-construct plugin paths — we join `<install_path>/skills/` and
//! `<install_path>/.claude-plugin/plugin.json` using `Path::join`.
//!
//! Skills are discovered by walking `skills/*/SKILL.md`. Each SKILL.md has
//! a YAML frontmatter block (`---\nname: ...\ndescription: ...\n---`)
//! followed by markdown body. We parse only the frontmatter — the body is
//! not exposed (the FE can read the file directly if needed).

use std::path::{Path, PathBuf};

use crate::models::plugins::{Plugin, PluginError};

// ════════════════════════════════════════════════════════════════════
// Public types
// ════════════════════════════════════════════════════════════════════

/// A skill discovered in an installed plugin's `skills/` directory.
/// Parsed from `skills/<dir>/SKILL.md` frontmatter.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSkill {
    /// Skill name from frontmatter `name:`. Falls back to the directory
    /// name if frontmatter is missing or has no `name`.
    pub name: String,
    /// Skill description from frontmatter `description:`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Absolute path to the SKILL.md file (for FE deep-linking).
    pub skill_path: String,
}

/// Rich detail for an installed plugin — merges the CLI's `Plugin` row
/// with on-disk `.claude-plugin/plugin.json` metadata + discovered skills.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDetail {
    /// The CLI's plugin row (id, version, scope, enabled, installPath, etc.).
    #[serde(flatten)]
    pub plugin: Plugin,
    /// Skills discovered in `skills/*/SKILL.md`. Empty if the plugin has
    /// no skills directory.
    pub skills: Vec<PluginSkill>,
    /// Author name from `.claude-plugin/plugin.json`. Distinct from
    /// `Plugin.author` (which is a `PluginAuthor` object from the CLI's
    /// `--available` payload). This is the flat string from the manifest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_name: Option<String>,
    /// Author email from `.claude-plugin/plugin.json`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_email: Option<String>,
    /// Homepage URL from `.claude-plugin/plugin.json`. Distinct from
    /// `Plugin.homepage` (CLI's `--available` payload) — this is the
    /// manifest's homepage, which may differ.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_homepage: Option<String>,
    /// Repository URL from `.claude-plugin/plugin.json`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    /// License from `.claude-plugin/plugin.json` (e.g. "MIT").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    /// Keywords from `.claude-plugin/plugin.json`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    /// Description from `.claude-plugin/plugin.json` (richer than the
    /// CLI's `--available` description when present).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_description: Option<String>,
}

// ════════════════════════════════════════════════════════════════════
// Public API
// ════════════════════════════════════════════════════════════════════

/// Builds a `PluginDetail` for an installed plugin. Reads:
///   - `skills/*/SKILL.md` frontmatter (name + description per skill)
///   - `.claude-plugin/plugin.json` (author, homepage, version, license, keywords)
///
/// `install_path` comes ONLY from the CLI's `plugin list --json` output.
/// Never hand-constructed.
///
/// Tolerant: missing `skills/` dir → empty skills list. Missing
/// `.claude-plugin/plugin.json` → only the CLI's `Plugin` fields are
/// returned. Malformed SKILL.md frontmatter → skill skipped with warn.
pub fn build_plugin_detail(plugin: Plugin) -> Result<PluginDetail, PluginError> {
    let install_path = Path::new(&plugin.install_path);

    // If the install_path doesn't exist, the plugin is in a broken state.
    // We still return the CLI row (so the FE can show something) but with
    // empty skills and no manifest metadata.
    if !install_path.exists() {
        return Ok(PluginDetail {
            plugin,
            skills: vec![],
            author_name: None,
            author_email: None,
            manifest_homepage: None,
            repository: None,
            license: None,
            keywords: vec![],
            manifest_description: None,
        });
    }

    let skills = discover_skills(install_path);
    let manifest_meta = read_plugin_json(install_path);

    Ok(PluginDetail {
        plugin,
        skills: skills.0,
        author_name: manifest_meta.author,
        author_email: manifest_meta.author_email,
        manifest_homepage: manifest_meta.homepage,
        repository: manifest_meta.repository,
        license: manifest_meta.license,
        keywords: manifest_meta.keywords,
        manifest_description: manifest_meta.description,
    })
}

/// Discovers skills under `<install_path>/skills/`. Walks recursively so both
/// flat layouts (`skills/<name>/SKILL.md` — superpowers) and nested layouts
/// (`skills/<category>/<name>/SKILL.md` — mattpocock-skills) are supported.
/// Skills without a valid SKILL.md are skipped with a warn log.
pub fn discover_skills(install_path: &Path) -> (Vec<PluginSkill>,) {
    let skills_dir = install_path.join("skills");
    let mut out = Vec::new();

    if !skills_dir.exists() {
        return (out,);
    }

    walk_skills_dir(&skills_dir, &mut out);

    // Sort by name for stable FE display.
    out.sort_by(|a, b| a.name.cmp(&b.name));
    (out,)
}

/// Recursively walks `dir` looking for `SKILL.md`. Each `SKILL.md` is parsed
/// as a skill. Subdirectories that don't contain `SKILL.md` are recursed into
/// to support category-grouped layouts (e.g. `skills/misc/setup-pre-commit/`).
fn walk_skills_dir(dir: &Path, out: &mut Vec<PluginSkill>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[verboo:plugins] failed to read dir {}: {e}", dir.display());
            return;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if skill_md.exists() {
            // Leaf skill directory with SKILL.md.
            match parse_skill_md(&skill_md) {
                Ok(skill) => out.push(skill),
                Err(e) => {
                    eprintln!(
                        "[verboo:plugins] skipping skill {}: {e}",
                        skill_md.display()
                    );
                }
            }
        } else {
            // No SKILL.md → recurse into category directory.
            walk_skills_dir(&path, out);
        }
    }
}

// ════════════════════════════════════════════════════════════════════
// Internal: SKILL.md frontmatter parsing
// ════════════════════════════════════════════════════════════════════

/// Parses a SKILL.md file's YAML frontmatter. Returns a `PluginSkill` with
/// `name` (falls back to directory name) and `description` (optional).
///
/// Frontmatter format (verified against real superpowers SKILL.md):
/// ```text
/// ---
/// name: test-driven-development
/// description: Use when implementing any feature or bugfix...
/// ---
///
/// # Body...
/// ```
///
/// We parse only the frontmatter (between `---` markers). The body is
/// not exposed. We do NOT pull in a YAML crate — the frontmatter is a
/// flat `key: value` map, so a line-based parser is sufficient and
/// avoids a new dependency.
fn parse_skill_md(path: &Path) -> Result<PluginSkill, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read failed: {e}"))?;

    let dir_name = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let (name, description) = parse_frontmatter(&raw, &dir_name);

    Ok(PluginSkill {
        name,
        description,
        skill_path: path.to_string_lossy().to_string(),
    })
}

/// Extracts `name` and `description` from YAML frontmatter. Falls back to
/// `dir_name` for `name` if frontmatter is missing or has no `name`.
/// `description` is `None` if absent.
fn parse_frontmatter(raw: &str, dir_name: &str) -> (String, Option<String>) {
    let lines: Vec<&str> = raw.lines().collect();
    if lines.is_empty() || lines[0].trim() != "---" {
        // No frontmatter — use dir name.
        return (dir_name.to_string(), None);
    }

    // Find the closing `---`.
    let end = lines
        .iter()
        .skip(1)
        .position(|l| l.trim() == "---");
    let end = match end {
        Some(idx) => idx + 1, // +1 because we skipped lines[0]
        None => return (dir_name.to_string(), None), // no closing marker
    };

    let frontmatter = &lines[1..end];
    let mut name = None;
    let mut description = None;

    for line in frontmatter {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            let key = key.trim();
            let value = value.trim().trim_matches('"').trim_matches('\'');
            match key {
                "name" => name = Some(value.to_string()),
                "description" => description = Some(value.to_string()),
                _ => {}
            }
        }
    }

    (name.unwrap_or_else(|| dir_name.to_string()), description)
}

// ════════════════════════════════════════════════════════════════════
// Internal: plugin.json parsing
// ════════════════════════════════════════════════════════════════════

/// Metadata extracted from `.claude-plugin/plugin.json`. All fields are
/// optional — the manifest is third-party and may omit any field.
#[derive(Debug, Default)]
struct PluginJsonMeta {
    author: Option<String>,
    author_email: Option<String>,
    homepage: Option<String>,
    repository: Option<String>,
    license: Option<String>,
    keywords: Vec<String>,
    description: Option<String>,
}

/// Reads `.claude-plugin/plugin.json` from the plugin's install path.
/// Returns `PluginJsonMeta::default()` (all `None`) if the manifest is
/// missing or unparseable — the FE still gets the CLI's `Plugin` row.
fn read_plugin_json(install_path: &Path) -> PluginJsonMeta {
    let manifest_path = install_path.join(".claude-plugin").join("plugin.json");
    if !manifest_path.exists() {
        return PluginJsonMeta::default();
    }

    let raw = match std::fs::read_to_string(&manifest_path) {
        Ok(r) => r,
        Err(e) => {
            eprintln!(
                "[verboo:plugins] failed to read {}: {e}",
                manifest_path.display()
            );
            return PluginJsonMeta::default();
        }
    };

    let value: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "[verboo:plugins] failed to parse {}: {e}",
                manifest_path.display()
            );
            return PluginJsonMeta::default();
        }
    };

    let obj = match value.as_object() {
        Some(o) => o,
        None => return PluginJsonMeta::default(),
    };

    let (author, author_email) = obj
        .get("author")
        .and_then(|v| v.as_object())
        .map(|a| {
            let name = a.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
            let email = a.get("email").and_then(|v| v.as_str()).map(|s| s.to_string());
            (name, email)
        })
        .unwrap_or((None, None));

    let homepage = obj.get("homepage").and_then(|v| v.as_str()).map(|s| s.to_string());
    let license = obj.get("license").and_then(|v| v.as_str()).map(|s| s.to_string());
    let description = obj
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // `repository` can be a string OR an object with `url`.
    let repository = obj
        .get("repository")
        .and_then(|v| {
            v.as_str()
                .map(|s| s.to_string())
                .or_else(|| v.get("url").and_then(|u| u.as_str()).map(|s| s.to_string()))
        });

    let keywords = obj
        .get("keywords")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    PluginJsonMeta {
        author,
        author_email,
        homepage,
        repository,
        license,
        keywords,
        description,
    }
}

// ════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::plugins::PluginScope;
    use std::io::Write;

    fn make_test_plugin(install_path: &Path) -> Plugin {
        Plugin {
            id: "test-mp@marketplace".into(),
            name: "test-mp".into(),
            version: "1.0.0".into(),
            scope: PluginScope::User,
            enabled: true,
            installed: true,
            install_path: install_path.to_string_lossy().to_string(),
            installed_at: "2026-07-14T00:00:00.000Z".into(),
            last_updated: "2026-07-14T00:00:00.000Z".into(),
            git_commit_sha: None,
            description: None,
            homepage: None,
            author: None,
            category: None,
            install_count: None,
        }
    }

    // ── parse_frontmatter ─────────────────────────────────────────────

    #[test]
    fn parse_frontmatter_real_superpowers_fixture() {
        // Real fixture from superpowers/skills/test-driven-development/SKILL.md.
        let raw = "---\nname: test-driven-development\ndescription: Use when implementing any feature or bugfix, before writing implementation code\n---\n\n# Test-Driven Development (TDD)\n\n## Overview\n";
        let (name, desc) = parse_frontmatter(raw, "fallback-dir");
        assert_eq!(name, "test-driven-development");
        assert_eq!(
            desc.as_deref(),
            Some("Use when implementing any feature or bugfix, before writing implementation code")
        );
    }

    #[test]
    fn parse_frontmatter_no_frontmatter_uses_dir_name() {
        let raw = "# Just markdown\nNo frontmatter here.\n";
        let (name, desc) = parse_frontmatter(raw, "my-skill-dir");
        assert_eq!(name, "my-skill-dir");
        assert!(desc.is_none());
    }

    #[test]
    fn parse_frontmatter_missing_name_uses_dir_name() {
        let raw = "---\ndescription: Has desc but no name\n---\n\n# Body\n";
        let (name, desc) = parse_frontmatter(raw, "dir-name");
        assert_eq!(name, "dir-name");
        assert_eq!(desc.as_deref(), Some("Has desc but no name"));
    }

    #[test]
    fn parse_frontmatter_missing_description() {
        let raw = "---\nname: just-name\n---\n\n# Body\n";
        let (name, desc) = parse_frontmatter(raw, "dir");
        assert_eq!(name, "just-name");
        assert!(desc.is_none());
    }

    #[test]
    fn parse_frontmatter_unclosed_marker_uses_dir_name() {
        let raw = "---\nname: no-closing-marker\nbody...\n";
        let (name, _desc) = parse_frontmatter(raw, "fallback");
        assert_eq!(name, "fallback");
    }

    #[test]
    fn parse_frontmatter_quoted_values() {
        let raw = "---\nname: \"quoted-name\"\ndescription: 'single-quoted desc'\n---\n";
        let (name, desc) = parse_frontmatter(raw, "dir");
        assert_eq!(name, "quoted-name");
        assert_eq!(desc.as_deref(), Some("single-quoted desc"));
    }

    #[test]
    fn parse_frontmatter_ignores_unknown_keys() {
        let raw = "---\nname: keep\nfoo: bar\nbaz: qux\ndescription: keep-desc\n---\n";
        let (name, desc) = parse_frontmatter(raw, "dir");
        assert_eq!(name, "keep");
        assert_eq!(desc.as_deref(), Some("keep-desc"));
    }

    // ── discover_skills (filesystem) ──────────────────────────────────

    #[test]
    fn discover_skills_real_structure() {
        // Simulate superpowers structure: skills/<name>/SKILL.md.
        let dir = tempfile::tempdir().expect("tempdir");
        let skills_dir = dir.path().join("skills");
        std::fs::create_dir_all(&skills_dir).expect("mkdir");

        // Skill 1
        let s1 = skills_dir.join("test-driven-development");
        std::fs::create_dir_all(&s1).expect("mkdir");
        std::fs::write(
            s1.join("SKILL.md"),
            "---\nname: test-driven-development\ndescription: Use when implementing\n---\n\n# TDD\n",
        )
        .expect("write");

        // Skill 2
        let s2 = skills_dir.join("systematic-debugging");
        std::fs::create_dir_all(&s2).expect("mkdir");
        std::fs::write(
            s2.join("SKILL.md"),
            "---\nname: systematic-debugging\ndescription: Use when debugging\n---\n\n# Debug\n",
        )
        .expect("write");

        // Non-SKILL.md file (should be ignored)
        std::fs::write(skills_dir.join("README.md"), "# Skills\n").expect("write");

        let (skills,) = discover_skills(dir.path());
        assert_eq!(skills.len(), 2);
        // Sorted by name.
        assert_eq!(skills[0].name, "systematic-debugging");
        assert_eq!(skills[1].name, "test-driven-development");
        assert!(skills[0].skill_path.ends_with("systematic-debugging/SKILL.md"));
    }

    #[test]
    fn discover_skills_missing_dir_returns_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (skills,) = discover_skills(dir.path());
        assert!(skills.is_empty());
    }

    #[test]
    fn discover_skills_skips_dirs_without_skill_md() {
        let dir = tempfile::tempdir().expect("tempdir");
        let skills_dir = dir.path().join("skills");
        std::fs::create_dir_all(&skills_dir).expect("mkdir");
        // Dir without SKILL.md.
        std::fs::create_dir_all(skills_dir.join("empty-skill")).expect("mkdir");
        // Dir with SKILL.md.
        let s1 = skills_dir.join("real-skill");
        std::fs::create_dir_all(&s1).expect("mkdir");
        std::fs::write(s1.join("SKILL.md"), "---\nname: real\n---\n").expect("write");

        let (skills,) = discover_skills(dir.path());
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "real");
    }

    // ── read_plugin_json (filesystem) ─────────────────────────────────

    #[test]
    fn read_plugin_json_real_superpowers_fixture() {
        // Real fixture from superpowers/.claude-plugin/plugin.json.
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest_dir = dir.path().join(".claude-plugin");
        std::fs::create_dir_all(&manifest_dir).expect("mkdir");
        let raw = r#"{
            "name": "superpowers",
            "description": "Core skills library for Claude Code: TDD, debugging, collaboration patterns, and proven techniques",
            "version": "6.1.1",
            "author": { "name": "Jesse Vincent", "email": "jesse@fsck.com" },
            "homepage": "https://github.com/obra/superpowers",
            "repository": "https://github.com/obra/superpowers",
            "license": "MIT",
            "keywords": ["skills", "tdd", "debugging", "collaboration", "best-practices", "workflows"]
        }"#;
        std::fs::write(manifest_dir.join("plugin.json"), raw).expect("write");

        let meta = read_plugin_json(dir.path());
        assert_eq!(meta.author.as_deref(), Some("Jesse Vincent"));
        assert_eq!(meta.author_email.as_deref(), Some("jesse@fsck.com"));
        assert_eq!(meta.homepage.as_deref(), Some("https://github.com/obra/superpowers"));
        assert_eq!(meta.repository.as_deref(), Some("https://github.com/obra/superpowers"));
        assert_eq!(meta.license.as_deref(), Some("MIT"));
        assert_eq!(meta.keywords.len(), 6);
        assert!(meta.keywords.contains(&"tdd".to_string()));
        assert!(meta.description.is_some());
    }

    #[test]
    fn read_plugin_json_missing_file_returns_defaults() {
        let dir = tempfile::tempdir().expect("tempdir");
        let meta = read_plugin_json(dir.path());
        assert!(meta.author.is_none());
        assert!(meta.homepage.is_none());
        assert!(meta.license.is_none());
        assert!(meta.keywords.is_empty());
    }

    #[test]
    fn read_plugin_json_repository_as_object() {
        // Some manifests use `repository: { url: "..." }` instead of a string.
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest_dir = dir.path().join(".claude-plugin");
        std::fs::create_dir_all(&manifest_dir).expect("mkdir");
        let raw = r#"{ "name": "p", "repository": { "url": "https://github.com/o/r" } }"#;
        std::fs::write(manifest_dir.join("plugin.json"), raw).expect("write");

        let meta = read_plugin_json(dir.path());
        assert_eq!(meta.repository.as_deref(), Some("https://github.com/o/r"));
    }

    #[test]
    fn read_plugin_json_invalid_json_returns_defaults() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest_dir = dir.path().join(".claude-plugin");
        std::fs::create_dir_all(&manifest_dir).expect("mkdir");
        std::fs::write(manifest_dir.join("plugin.json"), "{ not valid json").expect("write");

        let meta = read_plugin_json(dir.path());
        assert!(meta.author.is_none());
    }

    // ── build_plugin_detail (integration) ────────────────────────────

    #[test]
    fn build_plugin_detail_full_integration() {
        let dir = tempfile::tempdir().expect("tempdir");

        // skills/
        let skills_dir = dir.path().join("skills");
        std::fs::create_dir_all(&skills_dir).expect("mkdir");
        let s1 = skills_dir.join("tdd");
        std::fs::create_dir_all(&s1).expect("mkdir");
        std::fs::write(
            s1.join("SKILL.md"),
            "---\nname: tdd\ndescription: Test first\n---\n\n# TDD\n",
        )
        .expect("write");

        // .claude-plugin/plugin.json
        let manifest_dir = dir.path().join(".claude-plugin");
        std::fs::create_dir_all(&manifest_dir).expect("mkdir");
        std::fs::write(
            manifest_dir.join("plugin.json"),
            r#"{ "name": "p", "author": { "name": "Dev" }, "homepage": "https://example.com", "license": "MIT" }"#,
        )
        .expect("write");

        let plugin = make_test_plugin(dir.path());
        let detail = build_plugin_detail(plugin).expect("detail");
        assert_eq!(detail.skills.len(), 1);
        assert_eq!(detail.skills[0].name, "tdd");
        assert_eq!(detail.author_name.as_deref(), Some("Dev"));
        assert_eq!(detail.manifest_homepage.as_deref(), Some("https://example.com"));
        assert_eq!(detail.license.as_deref(), Some("MIT"));
        // The CLI's Plugin fields are preserved via #[serde(flatten)].
        assert_eq!(detail.plugin.id, "test-mp@marketplace");
    }

    #[test]
    fn build_plugin_detail_missing_install_path_returns_empty_skills() {
        let plugin = make_test_plugin(Path::new("/nonexistent/path/that/does/not/exist"));
        let detail = build_plugin_detail(plugin).expect("detail");
        assert!(detail.skills.is_empty());
        assert!(detail.author_name.is_none());
        // CLI row preserved.
        assert_eq!(detail.plugin.id, "test-mp@marketplace");
    }

    #[test]
    fn build_plugin_detail_no_skills_no_manifest() {
        let dir = tempfile::tempdir().expect("tempdir");
        let plugin = make_test_plugin(dir.path());
        let detail = build_plugin_detail(plugin).expect("detail");
        assert!(detail.skills.is_empty());
        assert!(detail.author_name.is_none());
        assert!(detail.manifest_homepage.is_none());
    }
}
