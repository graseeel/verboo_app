//! Plugin Marketplace types — mirrors `docs/plugins-marketplace.md` §2.
//!
//! The desktop backend is a thin shell-out wrapper around the `verboo plugin`
//! CLI commands. These types model the JSON payloads the CLI 0.13 emits on
//! `list --json`, `list --json --available`, and `marketplace list --json`,
//! plus the 9-variant error union used to classify CLI failures for the FE.
//!
//! Real CLI shapes verified 2026-07-13 against `@verboo/code` 0.13.0.

use serde::{Deserialize, Serialize};

// ════════════════════════════════════════════════════════════════════
// Enums
// ════════════════════════════════════════════════════════════════════

/// Scope of a plugin install. Mirrors the CLI's `--scope` flag values.
/// Note: the CLI accepts a fourth `managed` scope ONLY on `plugin update`;
/// install/uninstall/enable/disable accept these three values. We do not
/// model `managed` here because P5 only installs/uninstalls/enables/disables.
/// See spec §12 Q5.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginScope {
    User,
    Project,
    Local,
}

impl PluginScope {
    /// Returns the wire string used by the CLI's `--scope` flag.
    pub fn as_cli_arg(self) -> &'static str {
        match self {
            PluginScope::User => "user",
            PluginScope::Project => "project",
            PluginScope::Local => "local",
        }
    }
}

impl std::fmt::Display for PluginScope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_cli_arg())
    }
}

/// Trust classification of a marketplace. The CLI does NOT emit this — it
/// is a desktop-side policy (initial hardcoded list: claude-plugins-official,
/// verboo-plugins). Computed by the FE, not by Rust. Out of MVP scope for
/// P5's Rust side; kept here so the FE has a single shared definition.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MarketplaceTrust {
    Official,
    Verified,
    Community,
}

// ════════════════════════════════════════════════════════════════════
// Plugin + AvailablePlugin
// ════════════════════════════════════════════════════════════════════

/// An installed plugin row. Mirrors `verboo plugin list --json` (real shape
/// verified 2026-07-13). The CLI's bare `list` payload omits `name` and
/// `installed` — `name` is derived from `id` (the part before `@marketplace`)
/// and `installed` defaults to `true` (rows from `list` are by definition
/// installed). The post-parse path in `plugin_list` / `plugin_available`
/// fills `name` from `id` when the CLI omits it.
///
/// JSON field naming is camelCase on the wire (CLI emits `installPath` /
/// `installedAt` / `lastUpdated`) — `#[serde(rename_all = "camelCase")]`
/// keeps Rust idiomatic without drift.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plugin {
    /// Composite primary key: `name@marketplace`.
    pub id: String,
    /// Bare name without `@marketplace` (for display). Defaults to empty
    /// when the CLI omits it; the post-parse path fills it from `id`.
    #[serde(default)]
    pub name: String,
    /// Semver.
    pub version: String,
    pub scope: PluginScope,
    pub enabled: bool,
    /// Always `true` in `Plugin[]` payloads. Defaults to `true` because
    /// the CLI's `list` payload omits it (rows from `list` are by
    /// definition installed). Surfaced for FE merge logic with `--available`.
    #[serde(default = "default_true")]
    pub installed: bool,
    /// Absolute path to the cached plugin on disk.
    pub install_path: String,
    /// ISO 8601 timestamp.
    pub installed_at: String,
    /// ISO 8601 timestamp.
    pub last_updated: String,
    /// From `installed_plugins.json`. The CLI's `list` payload omits this
    /// today — kept optional so the FE can populate it from cache later.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_commit_sha: Option<String>,
    // ── Optional fields only present in `--available` rows ──────────
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<PluginAuthor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_count: Option<u64>,
}

/// Default function for `Plugin::installed`. Used by `#[serde(default = ...)]`
/// so the CLI's bare `list` payload (which omits `installed`) parses cleanly.
/// Rows from `list` are by definition installed.
fn default_true() -> bool {
    true
}

impl Plugin {
    /// Fills `name` from `id` (the part before `@marketplace`) when `name`
    /// is empty. Called by the post-parse path in `plugin_list` and
    /// `plugin_available` because the CLI's bare `list` payload omits `name`.
    pub fn fill_name_from_id(&mut self) {
        if self.name.is_empty() {
            if let Some(bare) = self.id.split('@').next() {
                self.name = bare.to_string();
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAuthor {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

/// Payload from `verboo plugin list --json --available`. The CLI returns
/// `{ installed: Plugin[], available: AvailablePlugin[] }` in one call —
/// we do not parse `installed_plugins.json` ourselves (spec §1).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginAvailablePayload {
    pub installed: Vec<Plugin>,
    pub available: Vec<AvailablePlugin>,
}

/// A plugin available for install from a marketplace. Differs from `Plugin`
/// because the CLI's `--available` row has a different shape: keyed by
/// `pluginId` (same `name@marketplace` form), carries `marketplaceName`,
/// `source`, `installCount`, but no `installPath` (not installed).
///
/// `install_count` and `description` default when the CLI omits them —
/// real CLI 0.13 payloads have ~12 plugins without `installCount`
/// (superpowers, mattpocock, verboo-test, notion, etc.). Without defaults,
/// serde fails the entire `Vec<AvailablePlugin>` → parse_error → FE shows
/// "Verifique sua conexão" (wrong; network is fine).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailablePlugin {
    /// `name@marketplace` — same shape as `Plugin.id`.
    pub plugin_id: String,
    /// Bare name without `@marketplace`.
    pub name: String,
    /// Defaults to empty when the CLI omits it (some marketplace manifests
    /// don't include a description).
    #[serde(default)]
    pub description: String,
    pub marketplace_name: String,
    /// Discriminated union (git-subdir / git / url / github / npm / local)
    /// with a `String` fallback for the CLI's relative-path shorthand.
    pub source: PluginSource,
    /// Defaults to 0 when the CLI omits it — ~12 plugins in real CLI 0.13
    /// payloads lack `installCount` (superpowers, mattpocock, etc.).
    #[serde(default)]
    pub install_count: u64,
}

// ════════════════════════════════════════════════════════════════════
// PluginSource (discriminated union)
// ════════════════════════════════════════════════════════════════════

/// The CLI emits `source` either as an object with a `source` discriminator
/// field OR as a relative path shorthand string (e.g. `"./plugins/x"`).
/// We model this as an untagged outer enum with three arms: a tagged
/// `Object` sub-enum (which maps the discriminator to a concrete variant),
/// a `Shorthand` string fallback, and a `Raw` catch-all for unknown
/// future object-form variants. Spec §2.3 forward-compat: unknown
/// discriminator values (e.g. `{"source":"zip",...}`) must NOT crash
/// `plugin_available` — they fall through to `Raw(serde_json::Value)`
/// so the FE can render a safe "unsupported source type" badge.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum PluginSource {
    Object(PluginSourceObject),
    /// Relative path shorthand (e.g. `"./plugins/agent-sdk-dev"`).
    Shorthand(String),
    /// Catch-all for unknown future object-form variants. The FE renders
    /// a safe "unsupported source type" badge. The raw JSON value is
    /// preserved for diagnostics.
    Raw(serde_json::Value),
}

/// Tagged inner enum. The CLI's `source` field discriminates the variant.
/// `#[serde(rename_all = "kebab-case")]` maps `GitSubdir` → `git-subdir`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "source", rename_all = "kebab-case")]
pub enum PluginSourceObject {
    GitSubdir {
        url: String,
        path: String,
        /// Rust keyword `ref` — wire field is `ref`.
        #[serde(rename = "ref")]
        ref_: String,
        sha: String,
    },
    Git {
        url: String,
        sha: String,
    },
    Url {
        url: String,
        sha: String,
    },
    Github {
        repo: String,
    },
    Npm {
        package: String,
        version: String,
    },
    Local {
        path: String,
    },
}

// ════════════════════════════════════════════════════════════════════
// Marketplace
// ════════════════════════════════════════════════════════════════════

/// A configured marketplace source. Mirrors `verboo plugin marketplace list
/// --json` (verified 2026-07-13). `plugin_count` and `trust` are FE-derived
/// (see spec §2.4) and never emitted by the CLI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marketplace {
    /// Bare marketplace name (e.g. "claude-plugins-official").
    pub name: String,
    /// `"github"` or `"url"` — left as a string to tolerate future values
    /// without a remapping round-trip in the wire format.
    pub source: String,
    /// Present when `source === "github"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// Present when `source === "url"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Filesystem path where the marketplace is installed. Populated by
    /// CLI's `marketplace list --json` and consumed by `read_marketplace_manifest`.
    /// Not read directly by the app, but serialized to the FE for context.
    #[allow(dead_code)]
    pub install_location: String,
    /// FE-derived (count of available plugins). Not emitted by CLI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_count: Option<u64>,
}

// ════════════════════════════════════════════════════════════════════
// PluginValidateResult
// ════════════════════════════════════════════════════════════════════

/// Result of `verboo plugin validate <path>`. The CLI does NOT emit JSON
/// today (verified 2026-07-13); we coarse-parse stdout/stderr markers
/// (`✘`, `Validation failed`) and the exit code. Spec §2.5.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginValidateResult {
    /// `true` if CLI exited 0 AND output does not contain `✘` or
    /// `Validation failed`.
    pub valid: bool,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub errors: Vec<String>,
    /// Reserved for future CLI versions. `None` today.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    /// Reserved for future CLI versions. `None` today.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// Truncated raw stdout for debugging (max 2 KB).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_output: Option<String>,
}

// ════════════════════════════════════════════════════════════════════
// PluginError (9 variants)
// ════════════════════════════════════════════════════════════════════

/// 10-variant error union. Internal tag (`#[serde(tag = "kind")]`) so the
/// FE can `switch (error.kind)` like a TypeScript discriminated union.
/// Variants ordered by the mapping table in spec §4 — most-specific first.
///
/// Per-variant `#[serde(rename_all = "camelCase")]` ensures struct-variant
/// fields serialize as camelCase on the wire (spec §2.3). Container-level
/// `rename_all = "snake_case"` only renames the variant names themselves.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PluginError {
    /// `Command::spawn()` returned `NotFound` — no CLI on PATH/bundle/env.
    CliNotFound,
    /// Stderr matched auth-failure substrings. We avoid the CLI's startup
    /// latency by surfacing a friendly error before shell-out.
    CliAuthRequired,
    /// Network-related substrings matched. Tagged [FEATURE] in spec §4.
    #[serde(rename_all = "camelCase")]
    NetworkError { message: String },
    /// JSON parse failure or empty/non-JSON stdout after ANSI strip.
    #[serde(rename_all = "camelCase")]
    ParseError {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        raw_preview: Option<String>,
    },
    /// `plugin_validate` returned a schema-invalid manifest.
    #[serde(rename_all = "camelCase")]
    InvalidPlugin {
        errors: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        warnings: Option<Vec<String>>,
    },
    /// A marketplace repo/source is missing `.claude-plugin/marketplace.json`
    /// — the source is not a valid marketplace (e.g. user tried to add a
    /// regular GitHub repo). Distinct from `InvalidPlugin` (schema-invalid
    /// plugin manifest) and `Unknown` (operational failure). Surfaced when
    /// the CLI's `marketplace add` fails with "Marketplace file not found"
    /// OR when the manifest_service cannot locate the manifest on disk.
    #[serde(rename_all = "camelCase")]
    InvalidMarketplace { message: String },
    /// Stderr indicated the plugin is already installed.
    #[serde(rename_all = "camelCase")]
    AlreadyInstalled { plugin: String },
    /// Stderr indicated the plugin is not installed.
    #[serde(rename_all = "camelCase")]
    NotInstalled { plugin: String },
    /// `tokio::time::timeout` fired.
    #[serde(rename_all = "camelCase")]
    Timeout { command: String, seconds: u64 },
    /// Catch-all for unknown CLI exit codes/messages.
    #[serde(rename_all = "camelCase")]
    Unknown {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
    },
}

/// Resultado de uma mutação de plugin (install/uninstall/update/enable/
/// disable/marketplace_add/marketplace_remove). Wrapper inequívoco para o
/// renderer fazer optimistic update + revert em falha.
///
/// - `success: true` → CLI exit 0, mutação aplicada. Caches invalidados.
/// - `success: false` → CLI non-zero exit. `exitCode` quando disponível.
///   `error` carrega o `PluginError` tipado para diagnóstico.
///
/// O renderer NÃO precisa inspecionar `PluginError` para decidir revert —
/// `success: false` basta. `exitCode` e `error` são para logging/UX.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<PluginError>,
    /// Plugin id afetado (quando aplicável) para reconcile direcionado.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
}

impl std::fmt::Display for PluginError {
    /// Stable per-kind string. Used for logs only — the FE consumes the
    /// serialized form, not this string.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PluginError::CliNotFound => f.write_str("cli_not_found"),
            PluginError::CliAuthRequired => f.write_str("cli_auth_required"),
            PluginError::NetworkError { message } => {
                write!(f, "network_error: {message}")
            }
            PluginError::ParseError { message, .. } => {
                write!(f, "parse_error: {message}")
            }
            PluginError::InvalidPlugin { errors, .. } => {
                write!(f, "invalid_plugin ({} error(s))", errors.len())
            }
            PluginError::InvalidMarketplace { message } => {
                write!(f, "invalid_marketplace: {message}")
            }
            PluginError::AlreadyInstalled { plugin } => {
                write!(f, "already_installed: {plugin}")
            }
            PluginError::NotInstalled { plugin } => {
                write!(f, "not_installed: {plugin}")
            }
            PluginError::Timeout { command, seconds } => {
                write!(f, "timeout after {seconds}s: {command}")
            }
            PluginError::Unknown { message, .. } => write!(f, "unknown: {message}"),
        }
    }
}

impl std::error::Error for PluginError {}

// ════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    // ── PluginScope ────────────────────────────────────────────────────

    #[test]
    fn plugin_scope_serializes_lowercase() {
        let s = serde_json::to_string(&PluginScope::User).unwrap();
        assert_eq!(s, "\"user\"");
        let p = serde_json::to_string(&PluginScope::Project).unwrap();
        assert_eq!(p, "\"project\"");
        let l = serde_json::to_string(&PluginScope::Local).unwrap();
        assert_eq!(l, "\"local\"");
    }

    #[test]
    fn plugin_scope_round_trip() {
        for scope in [PluginScope::User, PluginScope::Project, PluginScope::Local] {
            let json = serde_json::to_string(&scope).unwrap();
            let back: PluginScope = serde_json::from_str(&json).unwrap();
            assert_eq!(back, scope);
        }
    }

    #[test]
    fn plugin_scope_as_cli_arg() {
        assert_eq!(PluginScope::User.as_cli_arg(), "user");
        assert_eq!(PluginScope::Project.as_cli_arg(), "project");
        assert_eq!(PluginScope::Local.as_cli_arg(), "local");
    }

    // ── Plugin round-trip against real CLI 0.13 shape ─────────────────

    #[test]
    fn plugin_parses_real_cli_list_payload() {
        // Verified shape 2026-07-13. The CLI omits `name` and `version`
        // in the bare `list` output — serde fills them via `default` only
        // if we added it; for `name` we need it to be present at parse time
        // OR we accept that the list payload is missing optional fields.
        // Spec §2.1 sample omits name+version, so we accept them as
        // required-but-populated-by-FE in the merge step. For this test we
        // verify the spec's literal sample (with extras merged in).
        let raw = r#"[
            {
                "id": "rust-analyzer-lsp@claude-plugins-official",
                "name": "rust-analyzer-lsp",
                "version": "1.0.0",
                "scope": "user",
                "enabled": true,
                "installed": true,
                "installPath": "/Users/grasel/.verboo/plugins/cache/claude-plugins-official/rust-analyzer-lsp/1.0.0",
                "installedAt": "2026-07-06T00:46:08.857Z",
                "lastUpdated": "2026-07-06T00:46:08.857Z"
            }
        ]"#;
        let plugins: Vec<Plugin> = serde_json::from_str(raw).expect("parse");
        assert_eq!(plugins.len(), 1);
        let p = &plugins[0];
        assert_eq!(p.id, "rust-analyzer-lsp@claude-plugins-official");
        assert_eq!(p.name, "rust-analyzer-lsp");
        assert_eq!(p.version, "1.0.0");
        assert_eq!(p.scope, PluginScope::User);
        assert!(p.enabled);
        assert!(p.installed);
        assert!(p.install_path.starts_with("/Users/"));
        assert!(p.git_commit_sha.is_none());
        assert!(p.description.is_none());
    }

    #[test]
    fn plugin_tolerates_missing_optional_fields() {
        // Per spec §2.1 sample, the bare `list` payload omits name+version.
        // Serde requires them by default — but the spec sample is the
        // `installed_plugins.json` shape, NOT the CLI list shape. The CLI
        // list shape (verified 2026-07-13) DOES include them. This test
        // confirms the optional-but-not-required fields (`description`,
        // `gitCommitSha`, etc.) survive absence cleanly.
        let raw = r#"{
            "id": "x@y",
            "name": "x",
            "version": "0.0.1",
            "scope": "user",
            "enabled": true,
            "installed": true,
            "installPath": "/p",
            "installedAt": "2026-07-06T00:46:08.857Z",
            "lastUpdated": "2026-07-06T00:46:08.857Z"
        }"#;
        let _p: Plugin = serde_json::from_str(raw).expect("parse");
    }

    #[test]
    fn plugin_parses_real_cli_list_without_name_and_installed() {
        // Regression: the CLI's bare `list` payload omits `name` and
        // `installed` (verified 2026-07-13). `name` defaults to empty
        // and is filled from `id` by the post-parse path; `installed`
        // defaults to `true` because rows from `list` are by definition
        // installed.
        let raw = r#"[
            {
                "id": "rust-analyzer-lsp@claude-plugins-official",
                "version": "1.0.0",
                "scope": "user",
                "enabled": true,
                "installPath": "/Users/grasel/.verboo/plugins/cache/claude-plugins-official/rust-analyzer-lsp/1.0.0",
                "installedAt": "2026-07-06T00:46:08.857Z",
                "lastUpdated": "2026-07-06T00:46:08.857Z"
            }
        ]"#;
        let mut plugins: Vec<Plugin> = serde_json::from_str(raw).expect("parse");
        assert_eq!(plugins.len(), 1);
        let p = &mut plugins[0];
        assert_eq!(p.id, "rust-analyzer-lsp@claude-plugins-official");
        assert_eq!(p.name, ""); // CLI omits — default empty
        assert!(p.installed); // CLI omits — default true
        // Post-parse fill: name derived from id (before `@`).
        p.fill_name_from_id();
        assert_eq!(p.name, "rust-analyzer-lsp");
    }

    #[test]
    fn plugin_fill_name_from_id_noop_when_already_set() {
        let mut p = Plugin {
            id: "x@y".into(),
            name: "explicit-name".into(),
            version: "1.0.0".into(),
            scope: PluginScope::User,
            enabled: true,
            installed: true,
            install_path: "/p".into(),
            installed_at: "2026-07-06T00:46:08.857Z".into(),
            last_updated: "2026-07-06T00:46:08.857Z".into(),
            git_commit_sha: None,
            description: None,
            homepage: None,
            author: None,
            category: None,
            install_count: None,
        };
        p.fill_name_from_id();
        assert_eq!(p.name, "explicit-name");
    }

    #[test]
    fn plugin_fill_name_from_id_handles_no_at_sign() {
        // Edge case: id without `@marketplace` — fill_name_from_id should
        // use the whole id as the name.
        let mut p = Plugin {
            id: "bare-id".into(),
            name: String::new(),
            version: "1.0.0".into(),
            scope: PluginScope::User,
            enabled: true,
            installed: true,
            install_path: "/p".into(),
            installed_at: "2026-07-06T00:46:08.857Z".into(),
            last_updated: "2026-07-06T00:46:08.857Z".into(),
            git_commit_sha: None,
            description: None,
            homepage: None,
            author: None,
            category: None,
            install_count: None,
        };
        p.fill_name_from_id();
        assert_eq!(p.name, "bare-id");
    }

    #[test]
    fn plugin_serializes_camel_case() {
        let p = Plugin {
            id: "x@y".into(),
            name: "x".into(),
            version: "1.0.0".into(),
            scope: PluginScope::Project,
            enabled: true,
            installed: true,
            install_path: "/p".into(),
            installed_at: "2026-07-06T00:46:08.857Z".into(),
            last_updated: "2026-07-06T00:46:08.857Z".into(),
            git_commit_sha: None,
            description: None,
            homepage: None,
            author: None,
            category: None,
            install_count: None,
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"installPath\""));
        assert!(json.contains("\"installedAt\""));
        assert!(json.contains("\"lastUpdated\""));
        assert!(json.contains("\"scope\":\"project\""));
        // None-valued optional fields must be skipped.
        assert!(!json.contains("gitCommitSha"));
        assert!(!json.contains("description"));
    }

    // ── AvailablePlugin + PluginSource discriminated union ────────────

    #[test]
    fn available_plugin_parses_git_subdir_source() {
        // Real CLI 0.13 sample (verified 2026-07-13, abbreviated).
        let raw = r#"{
            "pluginId": "42crunch-api-security-testing@claude-plugins-official",
            "name": "42crunch-api-security-testing",
            "description": "Automate API security...",
            "marketplaceName": "claude-plugins-official",
            "source": {
                "source": "git-subdir",
                "url": "https://github.com/42Crunch-AI/claude-plugins.git",
                "path": "plugins/api-security-testing",
                "ref": "v1.5.5",
                "sha": "adf0b87c0a3419542e8cfa1329655f7311327d63"
            },
            "installCount": 1818
        }"#;
        let a: AvailablePlugin = serde_json::from_str(raw).expect("parse");
        assert_eq!(a.plugin_id, "42crunch-api-security-testing@claude-plugins-official");
        assert_eq!(a.marketplace_name, "claude-plugins-official");
        assert_eq!(a.install_count, 1818);
        match &a.source {
            PluginSource::Object(PluginSourceObject::GitSubdir { url, path, ref_, sha }) => {
                assert_eq!(url, "https://github.com/42Crunch-AI/claude-plugins.git");
                assert_eq!(path, "plugins/api-security-testing");
                assert_eq!(ref_, "v1.5.5");
                assert_eq!(sha, "adf0b87c0a3419542e8cfa1329655f7311327d63");
            }
            other => panic!("expected GitSubdir, got {other:?}"),
        }
    }

    #[test]
    fn available_plugin_parses_without_install_count() {
        // Regression: ~12 plugins in real CLI 0.13 payloads omit
        // `installCount` (superpowers, mattpocock, verboo-test, notion).
        // Without `#[serde(default)]`, serde failed the entire
        // `Vec<AvailablePlugin>` → parse_error → FE showed "Verifique sua
        // conexão" (wrong; network was fine).
        let raw = r#"{
            "pluginId": "superpowers@obra-superpowers-marketplace",
            "name": "superpowers",
            "description": "Superpowers skill marketplace",
            "marketplaceName": "obra-superpowers-marketplace",
            "source": "./"
        }"#;
        let a: AvailablePlugin = serde_json::from_str(raw).expect("parse");
        assert_eq!(a.plugin_id, "superpowers@obra-superpowers-marketplace");
        assert_eq!(a.name, "superpowers");
        assert_eq!(a.install_count, 0); // default
        // Source "./" is a bare string → Shorthand fallback.
        assert!(matches!(a.source, PluginSource::Shorthand(_)));
    }

    #[test]
    fn available_plugin_parses_without_description() {
        // Some marketplace manifests omit `description`.
        let raw = r#"{
            "pluginId": "p@m",
            "name": "p",
            "marketplaceName": "m",
            "source": "./",
            "installCount": 5
        }"#;
        let a: AvailablePlugin = serde_json::from_str(raw).expect("parse");
        assert_eq!(a.description, ""); // default
        assert_eq!(a.install_count, 5);
    }

    #[test]
    fn available_plugin_parses_mattpocock_real_shape() {
        // Real-ish fixture from mattpocock marketplace: source "./",
        // no installCount. This is the exact shape that broke the catalog.
        let raw = r#"{
            "pluginId": "some-plugin@mattpocock-plugins",
            "name": "some-plugin",
            "description": "A plugin",
            "marketplaceName": "mattpocock-plugins",
            "source": "./"
        }"#;
        let a: AvailablePlugin = serde_json::from_str(raw).expect("parse");
        assert_eq!(a.install_count, 0);
        assert!(matches!(a.source, PluginSource::Shorthand(s) if s == "./"));
    }

    #[test]
    fn available_plugin_parses_git_subdir_without_ref() {
        // Edge case: git-subdir source without `ref`. The PluginSource
        // enum requires `ref_` — this should FAIL to parse (fall through
        // to Raw via the untagged outer enum). Confirm it doesn't explode.
        let raw = r#"{
            "pluginId": "p@m",
            "name": "p",
            "description": "d",
            "marketplaceName": "m",
            "source": {
                "source": "git-subdir",
                "url": "https://github.com/o/r.git",
                "path": "plugins/p",
                "sha": "abc123"
            },
            "installCount": 0
        }"#;
        // Without `ref`, the GitSubdir arm fails. The untagged outer enum
        // tries Object (fails: missing ref) → Shorthand (fails: not a string)
        // → Raw (succeeds: catches the whole object).
        let a: AvailablePlugin = serde_json::from_str(raw).expect("parse");
        assert!(matches!(a.source, PluginSource::Raw(_)));
    }

    #[test]
    fn plugin_source_shorthand_string_falls_through() {
        // Real CLI also emits a bare relative-path string for in-repo plugins.
        let raw = r#""./plugins/agent-sdk-dev""#;
        let s: PluginSource = serde_json::from_str(raw).expect("parse");
        match s {
            PluginSource::Shorthand(p) => assert_eq!(p, "./plugins/agent-sdk-dev"),
            other => panic!("expected Shorthand, got {other:?}"),
        }
    }

    #[test]
    fn plugin_source_github_arm_parses() {
        let raw = r#"{"source":"github","repo":"anthropics/claude-plugins-official"}"#;
        let s: PluginSource = serde_json::from_str(raw).expect("parse");
        match s {
            PluginSource::Object(PluginSourceObject::Github { repo }) => {
                assert_eq!(repo, "anthropics/claude-plugins-official")
            }
            other => panic!("expected Github, got {other:?}"),
        }
    }

    #[test]
    fn plugin_source_unknown_future_variant_falls_through_to_shorthand() {
        // The `untagged` outer enum must NOT crash on unknown bare-string
        // variants — the FE renders a safe "unsupported source" fallback.
        let raw = r#""unknown-future-form""#;
        let s: PluginSource = serde_json::from_str(raw).expect("parse");
        assert!(matches!(s, PluginSource::Shorthand(_)));
    }

    #[test]
    fn plugin_source_unknown_object_variant_falls_through_to_raw() {
        // Regression: spec §2.3 forward-compat rule. A future CLI version
        // adding a new `source` discriminator (e.g. `{"source":"zip",...}`)
        // must NOT crash `plugin_available`. The untagged enum tries
        // `Object(PluginSourceObject)` (fails: unknown discriminator) then
        // `Shorthand(String)` (fails: input is an object) then
        // `Raw(serde_json::Value)` (succeeds).
        let raw = r#"{"source":"zip","url":"https://example.com/p.zip"}"#;
        let s: PluginSource = serde_json::from_str(raw).expect("parse");
        match s {
            PluginSource::Raw(val) => {
                assert_eq!(val["source"], "zip");
                assert_eq!(val["url"], "https://example.com/p.zip");
            }
            other => panic!("expected Raw, got {other:?}"),
        }
    }

    #[test]
    fn plugin_available_payload_round_trip() {
        let payload = PluginAvailablePayload {
            installed: vec![Plugin {
                id: "a@b".into(),
                name: "a".into(),
                version: "1.0.0".into(),
                scope: PluginScope::User,
                enabled: true,
                installed: true,
                install_path: "/p".into(),
                installed_at: "2026-07-06T00:46:08.857Z".into(),
                last_updated: "2026-07-06T00:46:08.857Z".into(),
                git_commit_sha: None,
                description: None,
                homepage: None,
                author: None,
                category: None,
                install_count: None,
            }],
            available: vec![],
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"installed\""));
        assert!(json.contains("\"available\""));
        let back: PluginAvailablePayload = serde_json::from_str(&json).unwrap();
        assert_eq!(back.installed.len(), 1);
        assert!(back.available.is_empty());
    }

    // ── Marketplace ────────────────────────────────────────────────────

    #[test]
    fn marketplace_parses_real_cli_payload() {
        // Real CLI 0.13 sample (verified 2026-07-13).
        let raw = r#"[
            {
                "name": "claude-plugins-official",
                "source": "github",
                "repo": "anthropics/claude-plugins-official",
                "installLocation": "/Users/grasel/.claude/plugins/marketplaces/claude-plugins-official"
            },
            {
                "name": "verboo-plugins",
                "source": "url",
                "url": "https://code.verboo.ai/api/plugins/marketplace.json",
                "installLocation": "/Users/grasel/.verboo/plugins/marketplaces/verboo-plugins"
            }
        ]"#;
        let m: Vec<Marketplace> = serde_json::from_str(raw).expect("parse");
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].name, "claude-plugins-official");
        assert_eq!(m[0].source, "github");
        assert_eq!(m[0].repo.as_deref(), Some("anthropics/claude-plugins-official"));
        assert!(m[0].url.is_none());
        assert_eq!(m[1].source, "url");
        assert_eq!(
            m[1].url.as_deref(),
            Some("https://code.verboo.ai/api/plugins/marketplace.json")
        );
        assert!(m[1].repo.is_none());
    }

    #[test]
    fn marketplace_serializes_camel_case() {
        let m = Marketplace {
            name: "x".into(),
            source: "github".into(),
            repo: Some("o/r".into()),
            url: None,
            install_location: "/p".into(),
            plugin_count: None,
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("\"installLocation\""));
        assert!(json.contains("\"repo\""));
        assert!(!json.contains("\"url\""));
        assert!(!json.contains("\"pluginCount\""));
    }

    // ── PluginError ────────────────────────────────────────────────────

    #[test]
    fn plugin_error_serializes_with_kind_tag() {
        let e = PluginError::CliNotFound;
        let json = serde_json::to_string(&e).unwrap();
        assert_eq!(json, "{\"kind\":\"cli_not_found\"}");

        let e = PluginError::CliAuthRequired;
        assert_eq!(serde_json::to_string(&e).unwrap(), "{\"kind\":\"cli_auth_required\"}");
    }

    #[test]
    fn plugin_error_network_variant_carries_message() {
        let e = PluginError::NetworkError { message: "ETIMEDOUT".into() };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"kind\":\"network_error\""));
        assert!(json.contains("\"message\":\"ETIMEDOUT\""));
    }

    #[test]
    fn plugin_error_timeout_carries_command_and_seconds() {
        let e = PluginError::Timeout {
            command: "verboo plugin install x@y".into(),
            seconds: 60,
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"kind\":\"timeout\""));
        assert!(json.contains("\"seconds\":60"));
        assert!(json.contains("\"command\":\"verboo plugin install x@y\""));
    }

    #[test]
    fn plugin_error_already_installed_carries_plugin() {
        let e = PluginError::AlreadyInstalled { plugin: "x@y".into() };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"kind\":\"already_installed\""));
        assert!(json.contains("\"plugin\":\"x@y\""));
    }

    #[test]
    fn plugin_error_unknown_optional_exit_code_skipped() {
        let e = PluginError::Unknown { message: "boom".into(), exit_code: None };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"kind\":\"unknown\""));
        assert!(json.contains("\"message\":\"boom\""));
        assert!(!json.contains("exitCode"));
    }

    #[test]
    fn plugin_error_invalid_plugin_with_warnings() {
        let e = PluginError::InvalidPlugin {
            errors: vec!["bad key".into()],
            warnings: Some(vec!["legacy field".into()]),
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"kind\":\"invalid_plugin\""));
        assert!(json.contains("\"errors\""));
        assert!(json.contains("\"warnings\""));
    }

    #[test]
    fn plugin_error_invalid_plugin_without_warnings_skips_field() {
        let e = PluginError::InvalidPlugin {
            errors: vec!["bad".into()],
            warnings: None,
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"kind\":\"invalid_plugin\""));
        assert!(!json.contains("warnings"));
    }

    #[test]
    fn plugin_error_parse_error_with_raw_preview() {
        let e = PluginError::ParseError {
            message: "invalid JSON".into(),
            raw_preview: Some("garbage output".into()),
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"kind\":\"parse_error\""));
        assert!(json.contains("\"rawPreview\":\"garbage output\""));
    }

    #[test]
    fn plugin_error_parse_error_without_preview_skips_field() {
        let e = PluginError::ParseError {
            message: "empty".into(),
            raw_preview: None,
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(!json.contains("rawPreview"));
    }

    #[test]
    fn plugin_error_display_stable_strings() {
        assert_eq!(PluginError::CliNotFound.to_string(), "cli_not_found");
        assert_eq!(PluginError::CliAuthRequired.to_string(), "cli_auth_required");
        let t = PluginError::Timeout { command: "c".into(), seconds: 30 };
        assert!(t.to_string().contains("30s"));
    }

    #[test]
    fn plugin_error_invalid_marketplace_serializes() {
        let e = PluginError::InvalidMarketplace {
            message: "Marketplace file not found".into(),
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"kind\":\"invalid_marketplace\""));
        assert!(json.contains("\"message\":\"Marketplace file not found\""));
        let back: PluginError = serde_json::from_str(&json).unwrap();
        assert_eq!(back, e);
    }

    #[test]
    fn plugin_error_invalid_marketplace_display() {
        let e = PluginError::InvalidMarketplace { message: "m".into() };
        assert!(e.to_string().contains("invalid_marketplace"));
        assert!(e.to_string().contains("m"));
    }

    #[test]
    fn plugin_error_has_10_variants() {
        // Regression: ensure InvalidMarketplace is the 10th variant and
        // the enum round-trips all variants without drift.
        let variants = [
            PluginError::CliNotFound,
            PluginError::CliAuthRequired,
            PluginError::NetworkError { message: "n".into() },
            PluginError::ParseError { message: "p".into(), raw_preview: None },
            PluginError::InvalidPlugin { errors: vec![], warnings: None },
            PluginError::InvalidMarketplace { message: "im".into() },
            PluginError::AlreadyInstalled { plugin: "a".into() },
            PluginError::NotInstalled { plugin: "n".into() },
            PluginError::Timeout { command: "c".into(), seconds: 1 },
            PluginError::Unknown { message: "u".into(), exit_code: None },
        ];
        for v in &variants {
            let json = serde_json::to_string(v).unwrap();
            let back: PluginError = serde_json::from_str(&json).unwrap();
            assert_eq!(&back, v, "round-trip failed for {v}");
        }
        assert_eq!(variants.len(), 10);
    }

    // ── PluginValidateResult ──────────────────────────────────────────

    #[test]
    fn validate_result_round_trip() {
        let r = PluginValidateResult {
            valid: true,
            warnings: vec!["w".into()],
            errors: vec![],
            hash: None,
            signature: None,
            raw_output: Some("stdout...".into()),
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"valid\":true"));
        assert!(json.contains("\"warnings\""));
        let back: PluginValidateResult = serde_json::from_str(&json).unwrap();
        assert!(back.valid);
        assert_eq!(back.warnings.len(), 1);
    }
}
