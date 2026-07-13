# Plugins Marketplace — Backend Spec (P0 / Wave 1)

> **Status:** SPEC — implementation gated by Maestro GO/NO-GO.
> **Owner:** Kratos (Architect). Implementation: Geralt (P5 backend) + Ciri (P6 FE).
> **Plan base:** [`docs/plan-plugins-search-codex.md`](./plan-plugins-search-codex.md) (sections D-G).
> **CLI:** `@verboo/code` 0.13.0 (verified 2026-07-13). Shell-out via CliSpawn pattern.
> **Out of scope (this doc):** P1-P4 sidebar/search chrome, P6 FE view, marketplace auto-update loop, plugin settings UI, per-plugin permissions, FLIP animation, runtime plugin loading.

---

## §0 Product summary

The Verboo Code desktop app exposes a **dedicated Plugins view** (sidebar item → fullscreen, semantically a sibling of Settings/Profile) that surfaces the CLI's plugin + marketplace model in a Codex-aligned UI. The user can list installed plugins, browse available plugins from configured marketplaces, install/uninstall/enable/disable/update with explicit confirmation, and manage marketplace sources (add/remove).

The backend does **NOT** reimplement plugin logic in Rust. Every backend operation is a thin shell-out wrapper around the `verboo plugin` and `verboo plugin marketplace` commands. Rust owns: (a) command translation, (b) timeout, (c) auth gate, (d) ANSI/JSON normalization, (e) error mapping. The CLI is the only authority for filesystem state under `~/.claude/plugins/` and `~/.verboo/plugins/`.

| # | Tauri command | Wraps CLI | Tags |
|---|---|---|---|
| 1 | `plugin_list` | `verboo plugin list --json` | [FEATURE] |
| 2 | `plugin_available` | `verboo plugin list --json --available` | [FEATURE] |
| 3 | `plugin_install` | `verboo plugin install <id>@<marketplace> --scope <scope>` | [FEATURE] |
| 4 | `plugin_enable` | `verboo plugin enable <id>@<marketplace> --scope <scope>` | [FEATURE] |
| 5 | `plugin_disable` | `verboo plugin disable <id>@<marketplace> --scope <scope>` | [FEATURE] |
| 6 | `plugin_uninstall` | `verboo plugin uninstall <id>@<marketplace> --scope <scope>` | [FEATURE] |
| 7 | `plugin_update` | `verboo plugin update <id>@<marketplace> --scope <scope>` | [FEATURE] |
| 8 | `plugin_validate` | `verboo plugin validate <path>` | [FEATURE] |
| 9 | `marketplace_list` | `verboo plugin marketplace list --json` | [FEATURE] |
| 10 | `marketplace_add` | `verboo plugin marketplace add <source> --scope <scope>` | [FEATURE] |
| 11 | `marketplace_remove` | `verboo plugin marketplace remove <name>` | [FEATURE] |

> "Featured" / categories were flagged as a GAP in the plan (Section D §"marketplace.json local"). **Verified 2026-07-13: the CLI's `--available` flag already returns a merged installed+available payload with `pluginId`, `description`, `marketplaceName`, `source`, and `installCount`.** The original marketplace.json adapter plan is therefore **obsolete** — see §6 for the simplification.

---

## §1 Source-of-truth principle

The CLI 0.13 is authoritative for:

- **Installed plugin state:** `~/.claude/plugins/installed_plugins.json` (canonical) and `~/.verboo/plugins/installed_plugins.json` (mirror). JSON shape — see §2.1.
- **Marketplace config:** `~/.claude/plugins/known_marketplaces.json` (canonical) and `~/.verboo/plugins/known_marketplaces.json` (mirror). JSON shape — see §2.4.
- **Cached plugin manifests:** `<marketplace installLocation>/.claude-plugin/marketplace.json` (e.g. `/Users/grasel/.claude/plugins/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json`). Used by `validate` and as data source for `available[]` enumeration.

Backend rules:

- **No Rust plugin logic.** Do not parse `installed_plugins.json` directly to mimic `list`. Always shell-out to CLI so we cannot drift.
- **No Rust marketplace logic.** Do not parse `known_marketplaces.json` directly to mimic `marketplace list`.
- **No Rust validate logic.** Do not implement schema validation. The CLI does it (currently against `marketplace.schema.json`).
- **CLI drift is observable, not corrected.** If the CLI changes shape, the wrapper emits a `parse_error` with the offending JSON preview. The fix is in the CLI, not the wrapper.
- **Cache invalidation is the CLI's problem.** Re-invoking `list --available` after a mutation is the canonical refresh.

---

## §2 Data model

### §2.1 `Plugin` (TypeScript + Rust mirror)

Aligned to `verboo plugin list --json` (real shape verified 2026-07-13):

```typescript
// src/shared/plugins.ts
export type PluginScope = 'user' | 'project' | 'local';

export interface Plugin {
  /** name@marketplace (composite id, the CLI's primary key) */
  id: string;
  /** Bare name without @marketplace — for display */
  name: string;
  /** Semver */
  version: string;
  scope: PluginScope;
  enabled: boolean;
  installed: boolean;          // always true in this payload; see §2.2 for available
  installPath: string;         // absolute path to cached plugin
  installedAt: string;         // ISO 8601
  lastUpdated: string;         // ISO 8601
  gitCommitSha?: string;       // from installed_plugins.json; CLI list omits, FE may derive
  // Optional (only from --available, present when installed AND has available row)
  description?: string;
  homepage?: string;
  author?: { name?: string; email?: string };
  category?: string;
  installCount?: number;
}
```

```rust
// src-tauri/src/models/plugins.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plugin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub scope: PluginScope,
    pub enabled: bool,
    pub installed: bool,
    pub install_path: String,
    pub installed_at: String,
    pub last_updated: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_commit_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<PluginAuthor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginAuthor {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginScope {
    User,
    Project,
    Local,
}
```

> **Naming:** JSON uses `installPath` / `installedAt` (camelCase) from the CLI. Rust struct uses `snake_case` with `#[serde(rename_all = "camelCase")]` to match CLI on the wire and stay idiomatic in code.

**Real CLI sample (verified 2026-07-13):**
```json
[
  {
    "id": "rust-analyzer-lsp@claude-plugins-official",
    "version": "1.0.0",
    "scope": "user",
    "enabled": true,
    "installPath": "/Users/grasel/.verboo/plugins/cache/claude-plugins-official/rust-analyzer-lsp/1.0.0",
    "installedAt": "2026-07-06T00:46:08.857Z",
    "lastUpdated": "2026-07-06T00:46:08.857Z"
  }
]
```

> **Discrepancy note:** the CLI list payload omits `gitCommitSha`, but `~/.claude/plugins/installed_plugins.json` includes it. We deliberately do NOT parse `installed_plugins.json` directly — if the FE needs `gitCommitSha` for "what changed" display, it should be added to the CLI list output and re-emitted through `plugin_list`. Out of MVP scope.

---

### §2.2 `PluginAvailable` (the `--available` shape)

The CLI returns a wrapper object `{ installed: Plugin[], available: AvailablePlugin[] }` when `--available` is passed. The available entries carry the marketplace metadata that powers the Featured grid.

```typescript
export interface PluginAvailablePayload {
  installed: Plugin[];
  available: AvailablePlugin[];
}

export interface AvailablePlugin {
  /** name@marketplace — same shape as Plugin.id */
  pluginId: string;
  /** Bare name without @marketplace */
  name: string;
  description: string;
  marketplaceName: string;
  /** Discriminated union — see §2.3 */
  source: PluginSource;
  installCount: number;
}
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginAvailablePayload {
    pub installed: Vec<Plugin>,
    pub available: Vec<AvailablePlugin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AvailablePlugin {
    pub plugin_id: String,
    pub name: String,
    pub description: String,
    pub marketplace_name: String,
    pub source: PluginSource,
    pub install_count: u64,
}
```

**Real CLI sample (verified 2026-07-13, abbreviated):**
```json
{
  "installed": [ /* Plugin[] as above */ ],
  "available": [
    {
      "pluginId": "42crunch-api-security-testing@claude-plugins-official",
      "name": "42crunch-api-security-testing",
      "description": "Automate API security directly in Claude Code with 42Crunch — ...",
      "marketplaceName": "claude-plugins-official",
      "source": {
        "source": "git-subdir",
        "url": "https://github.com/42Crunch-AI/claude-plugins.git",
        "path": "plugins/api-security-testing",
        "ref": "v1.5.5",
        "sha": "adf0b87c0a3419542e8cfa1329655f7311327d63"
      },
      "installCount": 1818
    }
  ]
}
```

---

### §2.3 `PluginSource` (discriminated union)

The CLI emits `source` as either an object with a `source` discriminator field OR a relative path string shorthand for in-repo plugins:

```typescript
export type PluginSource =
  | { source: 'git-subdir'; url: string; path: string; ref: string; sha: string }
  | { source: 'git'; url: string; sha: string }
  | { source: 'url'; url: string; sha: string }
  | { source: 'github'; repo: string }                 // e.g. "anthropics/claude-plugins-official"
  | { source: 'npm'; package: string; version: string }
  | { source: 'local'; path: string }
  | string;  // relative path shorthand, e.g. "./plugins/agent-sdk-dev"
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PluginSource {
    GitSubdir {
        #[serde(rename = "source")] kind: String, // "git-subdir"
        url: String,
        path: String,
        #[serde(rename = "ref")] ref_: String,
        sha: String,
    },
    Git {
        #[serde(rename = "source")] kind: String, // "git"
        url: String,
        sha: String,
    },
    Url {
        #[serde(rename = "source")] kind: String, // "url"
        url: String,
        sha: String,
    },
    Github {
        #[serde(rename = "source")] kind: String, // "github"
        repo: String,
    },
    Npm {
        #[serde(rename = "source")] kind: String, // "npm"
        package: String,
        version: String,
    },
    Local {
        #[serde(rename = "source")] kind: String, // "local"
        path: String,
    },
    /// Relative path shorthand (e.g. "./plugins/agent-sdk-dev").
    /// Real CLI sample observed in `available[]` payload.
    Shorthand(String),
}
```

> **Render rule for the FE:** unknown future source variants must not crash the UI. Use a string fallback `kind = source ?? "unknown"` and let the Install button disable itself with tooltip "Unsupported source type — please open an issue".

---

### §2.4 `Marketplace`

Aligned to `verboo plugin marketplace list --json` (real shape verified 2026-07-13):

```typescript
export type MarketplaceSource = 'github' | 'url';

export interface Marketplace {
  /** Bare marketplace name (e.g. "claude-plugins-official") */
  name: string;
  source: MarketplaceSource;
  /** Present when source === 'github' */
  repo?: string;
  /** Present when source === 'url' */
  url?: string;
  installLocation: string;
  /** Derived (FE side) — count of available plugins from this marketplace in the latest --available payload */
  pluginCount?: number;
  /** Derived (FE side) — see §6 trust policy */
  trust?: MarketplaceTrust;
}

export type MarketplaceTrust = 'official' | 'verified' | 'community';
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Marketplace {
    pub name: String,
    pub source: String, // "github" | "url" — left as string to tolerate future values
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub install_location: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_count: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MarketplaceTrust {
    Official,
    Verified,
    Community,
}
```

**Real CLI sample (verified 2026-07-13):**
```json
[
  {
    "name": "claude-plugins-official",
    "source": "github",
    "repo": "anthropics/claude-plugins-official",
    "installLocation": "/Users/grasel/.claude/plugins/marketplaces/claude-plugins-official"
  },
  {
    "name": "superpowers-marketplace",
    "source": "github",
    "repo": "obra/superpowers-marketplace",
    "installLocation": "/Users/grasel/.claude/plugins/marketplaces/superpowers-marketplace"
  },
  {
    "name": "verboo-plugins",
    "source": "url",
    "url": "https://code.verboo.ai/api/plugins/marketplace.json",
    "installLocation": "/Users/grasel/.verboo/plugins/marketplaces/verboo-plugins"
  }
]
```

> **Trust assignment (FE side):** the CLI does not emit a trust level. The FE hardcodes a known set of trusted marketplace names (initial list: `claude-plugins-official`, `verboo-plugins`). Unknown marketplaces → `community`. Configurable in a follow-up release. **Out of MVP scope for P5** (Rust does not compute trust).

---

### §2.5 `PluginValidateResult`

The CLI's `verboo plugin validate <path>` currently emits **non-JSON human-readable output**. Example:

```
Validating marketplace manifest: /Users/grasel/.claude/plugins/cache/superpowers-marketplace/superpowers/6.1.0/.claude-plugin/marketplace.json

✘ Found 1 error:

  ❯ root: Unrecognized key: "description"

✘ Validation failed
```

Because the CLI doesn't expose a `--json` flag for `validate`, the backend must either:
1. **Detect a `--json` flag at runtime** (does not exist today — `verboo plugin validate --help` shows none), OR
2. **Parse the human-readable output** with a tolerant regex, OR
3. **Use exit code + truncated stderr/stdout** as a coarse signal.

We choose **(3)** for MVP — matches what the CLI exposes today — and define the contract:

```typescript
export interface PluginValidateResult {
  /** true if CLI exited 0 AND output does not contain "✘" or "Validation failed" */
  valid: boolean;
  warnings: string[];   // lines matching "⚠" or "warning:" prefix (best-effort regex)
  errors: string[];     // lines matching "❯ " prefix under "Found N error(s):" block
  /** Optional: SHA-like hex string if CLI starts emitting it in a future version. Today: undefined. */
  hash?: string;
  /** Optional: signature blob if CLI starts emitting it. Today: undefined. */
  signature?: string;
  /** Truncated raw stdout for debugging (max 2 KB). */
  rawOutput?: string;
}
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginValidateResult {
    pub valid: bool,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub errors: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_output: Option<String>,
}
```

> **Future-proofing:** if/when the CLI adds `validate --json`, swap the regex parser for a `serde_json::from_str` and add a feature-detect gate. The shape stays compatible.

---

### §2.6 `PluginError` (9 variants)

```typescript
export type PluginError =
  | { kind: 'cli_not_found' }
  | { kind: 'cli_auth_required' }
  | { kind: 'network_error'; message: string }
  | { kind: 'parse_error'; message: string; rawPreview?: string }
  | { kind: 'invalid_plugin'; errors: string[]; warnings?: string[] }
  | { kind: 'already_installed'; plugin: string }
  | { kind: 'not_installed'; plugin: string }
  | { kind: 'timeout'; command: string; seconds: number }
  | { kind: 'unknown'; message: string; exitCode?: number };
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PluginError {
    CliNotFound,
    CliAuthRequired,
    NetworkError { message: String },
    ParseError { message: String, #[serde(skip_serializing_if = "Option::is_none")] raw_preview: Option<String> },
    InvalidPlugin { errors: Vec<String>, #[serde(skip_serializing_if = "Option::is_none")] warnings: Option<Vec<String>> },
    AlreadyInstalled { plugin: String },
    NotInstalled { plugin: String },
    Timeout { command: String, seconds: u64 },
    Unknown { message: String, #[serde(skip_serializing_if = "Option::is_none")] exit_code: Option<i32> },
}

impl std::fmt::Display for PluginError { /* … stable string per kind, used in logs only */ }
impl std::error::Error for PluginError {}
```

The 9 variants cover all observable failure modes from the CLI today. See §4 for the mapping table.

---

## §3 Tauri commands

All commands live in `src-tauri/src/plugins.rs` (new module). All are `#[tauri::command] pub async fn …`. Registration in `src-tauri/src/lib.rs` `invoke_handler` block, alphabetically grouped with the existing commands.

### §3.1 Signatures

```rust
#[tauri::command]
pub async fn plugin_list() -> Result<Vec<Plugin>, PluginError>;

#[tauri::command]
pub async fn plugin_available() -> Result<PluginAvailablePayload, PluginError>;

#[tauri::command]
pub async fn plugin_install(
    id: String,           // "name@marketplace"
    scope: PluginScope,
) -> Result<Plugin, PluginError>;

#[tauri::command]
pub async fn plugin_enable(
    id: String,
    scope: Option<PluginScope>,  // CLI default: auto-detect
) -> Result<(), PluginError>;

#[tauri::command]
pub async fn plugin_disable(
    id: String,
    scope: Option<PluginScope>,
) -> Result<(), PluginError>;

#[tauri::command]
pub async fn plugin_uninstall(
    id: String,
    scope: PluginScope,
    keep_data: Option<bool>,     // default false
) -> Result<(), PluginError>;

#[tauri::command]
pub async fn plugin_update(
    id: String,
    scope: PluginScope,
) -> Result<Plugin, PluginError>;

#[tauri::command]
pub async fn plugin_validate(
    path: String,         // absolute path to manifest OR installLocation root
) -> Result<PluginValidateResult, PluginError>;

#[tauri::command]
pub async fn marketplace_list() -> Result<Vec<Marketplace>, PluginError>;

#[tauri::command]
pub async fn marketplace_add(
    source: String,       // URL, path, or "github:owner/repo"
    scope: Option<String>,  // "user" (default), "project", "local"
) -> Result<Marketplace, PluginError>;

#[tauri::command]
pub async fn marketplace_remove(name: String) -> Result<(), PluginError>;
```

> **`plugin_validate(path: String)`** replaces the plan's `plugin_validate(name, marketplace)`. Rationale: the CLI takes `<path>`, not (name, marketplace). For an installed plugin, the FE resolves the installPath via the existing `plugin_list` cache and passes it directly. For an arbitrary marketplace manifest, the FE fetches it (or reads a known marketplace installLocation) and passes that. See §5 flow 8.
>
> **TypeScript callers must convert errors to user-readable messages.** Wrap each invoke in `try { return await invoke(...) } catch (e) { return mapPluginError(e) }` in the FE store layer (P6 scope).

---

### §3.2 CLI command matrix

| Tauri | CLI | Args | Timeout | Tags |
|---|---|---|---|---|
| `plugin_list` | `verboo plugin list --json` | none | 15 s | [FEATURE] |
| `plugin_available` | `verboo plugin list --json --available` | none | 30 s | [FEATURE] |
| `plugin_install` | `verboo plugin install <id> --scope <scope>` | `--json` NOT used | 60 s | [FEATURE] |
| `plugin_enable` | `verboo plugin enable <id> --scope <scope>` | `--json` NOT used | 10 s | [FEATURE] |
| `plugin_disable` | `verboo plugin disable <id> --scope <scope>` | `--json` NOT used | 10 s | [FEATURE] |
| `plugin_uninstall` | `verboo plugin uninstall <id> --scope <scope> [--keep-data]` | `--json` NOT used | 15 s | [FEATURE] |
| `plugin_update` | `verboo plugin update <id> --scope <scope>` | `--json` NOT used | 60 s | [FEATURE] |
| `plugin_validate` | `verboo plugin validate <path>` | `--json` NOT available | 30 s | [FEATURE] |
| `marketplace_list` | `verboo plugin marketplace list --json` | none | 15 s | [FEATURE] |
| `marketplace_add` | `verboo plugin marketplace add <source> --scope <scope>` | `--json` NOT used | 60 s | [FEATURE] |
| `marketplace_remove` | `verboo plugin marketplace remove <name>` | `--json` NOT used | 15 s | [FEATURE] |

> **Mutation commands do not emit JSON** — only `list` and `marketplace list` honor `--json` today. The wrappers for the mutation commands return `()` (or the new `Plugin` post-mutation, by re-fetching `list`) and rely on exit code + stderr inspection for errors. See §4.

---

### §3.3 Re-fetch strategy for mutations

Three patterns depending on the operation:

1. **`plugin_install` / `plugin_update`:** after a successful exit, the CLI may NOT emit the updated plugin metadata in stdout. Re-invoke `plugin_list --json` and find the row by `id`. Cache the result and return the new `Plugin`. On miss (CLI install succeeded but the row is missing from list — drift), return a synthesized `Plugin` with `version = "unknown"` and a warning logged.
2. **`plugin_enable` / `plugin_disable` / `plugin_uninstall`:** return `()`. Frontend optimistically toggles state and re-fetches `plugin_list` once on focus or on user pull-to-refresh.
3. **`marketplace_add`:** return a synthesized `Marketplace` with `installLocation = ""` and a `name` echo. Frontend follows up with `marketplace_list` to canonicalize.
4. **`marketplace_remove`:** return `()`.

All patterns keep the wrapper small and never fake CLI behavior.

---

## §4 Error mapping

Every wrapper funnels through a single `map_cli_error(command, exit_code, stdout, stderr, duration) -> PluginError` function. The mapping rules, in order:

| Signal | PluginError kind | Notes |
|---|---|---|
| `Command::spawn()` returns `Err(io::ErrorKind::NotFound)` | `cli_not_found` | No fallback to "verboo by name" — `CliSpawn::new` already exhausted all three resolution paths. |
| Stderr contains `not logged in`, `auth required`, `Please login`, `OAuth token`, `401`, `403` (case-insensitive substring, any of) | `cli_auth_required` | Tag: [EXISTING] — CLI does the auth check; we just translate. |
| Stderr contains `ETIMEDOUT`, `ECONNREFUSED`, `ENOTFOUND`, `getaddrinfo`, `network`, `Failed to fetch`, `404`, `503`, `502`, `git pull` failure message patterns | `network_error` with message = first matching substring (truncated 200 chars) | Tag: [FEATURE] — wrapper-level classifier. |
| Stdout is empty OR doesn't begin with `{` or `[` after ANSI strip OR `serde_json::from_str` fails | `parse_error` with `raw_preview` = first 500 chars of (ANSI-stripped) stdout | Tag: [FEATURE]. |
| `plugin_validate` was the command AND exit_code != 0 AND stderr/stdout contains `✘` | `invalid_plugin` with `errors` parsed from output | Tag: [FEATURE]. |
| Stderr/exit message contains `already installed`, `is already installed` | `already_installed` with `plugin` parsed from message if possible, else "unknown" | Tag: [EXISTING]. |
| Stderr/exit message contains `not installed`, `is not installed`, `cannot find plugin` | `not_installed` with `plugin` parsed from message if possible, else "unknown" | Tag: [EXISTING]. |
| `tokio::time::timeout` fired | `timeout` with `command` and `seconds` | Tag: [FEATURE]. |
| Anything else AND `exit_code != 0` | `unknown` with `message` = first 500 chars of stderr (or stdout if stderr empty) AND `exit_code` | Tag: [FEATURE]. |

> **Substring matching is intentionally conservative.** We only classify when the CLI signals something we can recover from. Anything ambiguous falls through to `unknown` and surfaces in logs.
>
> **NEVER silently retry.** A single failed invocation is the user's signal. Ciri's UI uses the error kind to decide what banner/CTAs to show.

---

## §5 User flows

### §5.1 Flow: open Plugins view (mount-time)

1. Ciri dispatches `plugin_list` and `marketplace_list` in parallel.
2. If `plugin_list` returns `cli_not_found`, show banner "CLI Verboo não encontrado" + link to settings. Do NOT call `plugin_available`.
3. If `cli_auth_required`, show banner "Faça login para gerenciar plugins" + button "Ir para Settings" (the CLI list works without auth; only mutations need it — but for MVP we surface the banner consistently).
4. On `plugin_list` success, kick off `plugin_available` (slower — 30 s) to populate the Featured grid.
5. While `plugin_available` loads, render skeleton cards.
6. Merge `installed` ∪ `available` by `id`. Installed rows carry `enabled`/`installPath`; available-only rows show an Install button.

### §5.2 Flow: install a plugin

1. User clicks Install on a Featured card.
2. FE dispatches `plugin_validate(<installLocation>)` to surface pre-install errors. **Best-effort:** skip on no path (marketplace not yet cloned).
3. FE opens `PluginInstallModal` with:
   - Plugin name + version
   - Marketplace + source preview
   - Description
   - Trust level of the marketplace (badge: Official / Verified / Community)
   - Any warnings from step 2 (collapsible)
   - Scope selector (user / project / local). Default: user.
4. User clicks Confirm.
5. FE dispatches `plugin_install(id, scope)` with loading state on the card (spinner replaces Install).
6. On success: re-fetch `plugin_list`, replace Featured card with Installed card (with FLIP deferred to v2), toast "Plugin instalado".
7. On `cli_auth_required`: close modal, route to login CTA.
8. On `network_error`: keep modal open, show inline error + retry button.
9. On `already_installed`: toast "Já instalado — atualizando para latest" then dispatch `plugin_update`.
10. On `timeout`: keep modal open, show "Instalação demorou demais — tentando em background" + cancel button (Kratos: re-use Computer Use's background-poll pattern from `computer-use-architecture-v1.md` §4).

### §5.3 Flow: enable/disable (optimistic)

1. User flips toggle on an Installed card.
2. FE optimistically updates the toggle in `pluginsStore` and disables interactions on the card.
3. FE dispatches `plugin_enable(id, scope)` or `plugin_disable(id, scope)`.
4. On success: keep optimistic state.
5. On error: revert toggle to original, banner "Falha ao {enable/disable}" + retry.
6. Optional background re-fetch of `plugin_list` on tab focus (mirrors Computer Use's perms pattern).

### §5.4 Flow: uninstall

1. User clicks ⋯ → Uninstall on a card.
2. FE opens confirm modal: "Desinstalar {plugin}? Dados em `~/.claude/plugins/data/{id}/` serão {preserved|removed}." Scope-driven copy.
3. User clicks Confirm.
4. FE dispatches `plugin_uninstall(id, scope, keep_data=false)`.
5. On success: card fades out, animates to Featured if still available there, toast "Plugin desinstalado".
6. On `not_installed`: stale state — refresh list and remove card silently.

### §5.5 Flow: update

1. User clicks ⋯ → Update on an Installed card.
2. FE dispatches `plugin_update(id, scope)` with loading state.
3. On success: re-fetch list, toast "Plugin atualizado — reiniciar para aplicar".
4. **Restart banner** appears at top of PluginsView: "Atualizações de plugins aplicadas. Reinicie o Verboo Code para ativá-las." with [Reiniciar] and [Depois] buttons.
5. Banner persists across reloads (stored in `pluginsStore.pendingRestartPluginIds: Set<string>`) until the app restarts.

### §5.6 Flow: manage marketplaces

1. User clicks [Manage marketplaces] button in PluginsView header.
2. FE opens `MarketplaceModal` listing all marketplaces with trust badges.
3. User can:
   - **Add:** input URL / GitHub `owner/repo` / local path. Scope selector. Calls `marketplace_add`. On success: row appears in list.
   - **Remove:** confirm destructive modal. Calls `marketplace_remove`. On success: row removed.
4. Closing the modal triggers a re-fetch of `marketplace_list` and `plugin_available` so the Featured grid refreshes.

### §5.7 Flow: handle CLI version mismatch

1. On any wrapper invocation, if exit code = 0 AND stdout is empty AND stderr matches `unknown flag --json`, set a `cli_supports_json = false` flag in Rust state (OnceCell).
2. From that point on, mutation wrappers still work (they don't need JSON), but `plugin_list` and `marketplace_list` fall back to text parsing with a debug log warning.
3. P5 includes a UI banner surfaced from the FE: "Seu CLI Verboo é antigo — atualize para a versão 0.13+ para uma experiência completa."
4. The feature-detect runs once per session and is cached.

### §5.8 Flow: validate pre-install (the plan's gap)

Plan Section D specified `plugin_validate(name, marketplace)`. The CLI takes `<path>`. Two real callers:

- **Caller A: validate an installed plugin.** FE reads `plugin.installPath` from the cached `plugin_list` and dispatches `plugin_validate(installPath)`. CLI walks up to find `marketplace.json`.
- **Caller B: validate a marketplace source before adding it.** FE has no path yet. Skip the call — `marketplace_add` itself runs the CLI's internal validation. Surface stderr verbatim via `unknown` (or a future dedicated `invalid_marketplace` variant if/when the CLI exposes `--json`).

---

## §6 Featured / available adapter — simplified

The plan (Section D, "marketplace.json local") proposed reading `<installLocation>/.claude-plugin/marketplace.json` and/or fetching `https://code.verboo.ai/api/plugins/marketplace.json` directly.

**Verified 2026-07-13: this adapter is unnecessary in MVP.** The CLI's `verboo plugin list --json --available` already returns the merged payload the FE needs, sourced from the same marketplace.json files (CLI does the merge, CLI does the SHA capture, CLI does the installCount tracking). The single command `plugin_available` replaces both:

- ~~Read `<installLocation>/marketplace.json`~~ → CLI reads it for us.
- ~~Fetch `https://code.verboo.ai/api/plugins/marketplace.json`~~ → CLI fetches it.
- ~~Merge installed + available with enabled/installed flags~~ → CLI returns both in one payload.

**Simplification:**
- Drop the plan's custom adapter code.
- FE consumes `PluginAvailablePayload` directly (FE derives `installed` flags by id-joining with `Plugin[]`).
- The "verboo-plugins" marketplace (URL-source) is handled identically — the CLI fetches its `marketplace.json` on `marketplace update` and feeds it into the `--available` payload.

**Tagged [FEATURE]:** single command, single payload, single source of truth.

**Future escape hatch (P6 backlog):** if marketplace payloads grow beyond ~500 entries and `available[]` becomes slow to enumerate on every PluginsView mount, cache `PluginAvailablePayload` in `pluginsStore` with a 5-minute TTL + invalidate on `marketplace_add`/`marketplace_remove`/`marketplace_update`/`plugin_install`. Not in MVP.

---

## §7 Auth gate

The CLI does its own auth check inside each command. We do NOT duplicate it. The wrapper's only auth-related responsibility is to **avoid invoking the CLI when we already know the user is logged out**, to skip the CLI's startup latency and surface a friendly error.

Implementation:

```rust
fn require_auth(cli: &CliService) -> Result<(), PluginError> {
    let status = cli.get_auth_status()
        .map_err(|_| PluginError::Unknown {
            message: "Failed to query auth state".to_string(),
            exit_code: None,
        })?;
    if status.logged_in {
        Ok(())
    } else {
        Err(PluginError::CliAuthRequired)
    }
}
```

- **Read commands** (`plugin_list`, `plugin_available`, `marketplace_list`, `plugin_validate`) — DO NOT call `require_auth`. The CLI is happy to enumerate without auth (it only reads files). Skipping the gate avoids a needless CLI invocation.
- **Mutation commands** (all others) — call `require_auth` before shell-out.

> The renderer-side `cliAuth` state (App.tsx:279) is the FE's faster path: the FE can read `cliAuth.loggedIn` and skip the dispatch entirely on the write paths. The Rust-side gate is the safety net for cases where the FE state is stale (the renderer's `cliAuth` is set from `get_cli_auth_status` and may not have been refreshed yet). Tag: [BOTH] — FE-gated + Rust-gated.

---

## §8 CliSpawn integration

Pattern follows `cli_service.rs` (auth) and `turn_service.rs` (research). Reuse verbatim:

```rust
use crate::services::cli_spawn::CliSpawn;

async fn run_cli_json<I, S>(args: I, timeout_secs: u64) -> Result<String, PluginError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let spawn = CliSpawn::new(args);
    let mut cmd = spawn.command;
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let output = tokio::process::Command::from(cmd)
        .output()
        .await
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => PluginError::CliNotFound,
            _ => PluginError::Unknown {
                message: format!("spawn failed: {e}"),
                exit_code: None,
            },
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code();

    if !output.status.success() {
        return Err(map_cli_error(exit_code, &stdout, &stderr));
    }

    Ok(strip_ansi(&stdout))
}
```

### §8.1 ANSI strip

**Every** `verboo plugin … --json` output is wrapped in:

```
\u001b[?2026h   # alt-screen save
\u001b[?2026l   # alt-screen restore
```

…**before** the JSON body. The wrapper MUST strip these before parsing. Verified against CLI 0.13.0 (2026-07-13).

```rust
fn strip_ansi(s: &str) -> String {
    // Conservative: only strip the known alt-screen prefix and trailing
    // whitespace. Avoid greedy ANSI stripping that could mask real
    // problems.
    let s = s.trim_start();
    let s = s.strip_prefix("\u{1b}[?2026h").unwrap_or(s);
    let s = s.strip_prefix("\u{1b}[?2026l").unwrap_or(s);
    s.trim().to_string()
}
```

> **Test:** a unit test feeds `"\u{1b}[?2026h\n[{\"id\":\"x@y\"}]\u{1b}[?2026l\n"` through `strip_ansi` and asserts the result starts with `[`.

### §8.2 Timeout

```rust
use tokio::time::{timeout, Duration};

let raw = match timeout(Duration::from_secs(timeout_secs), run_cli_json(args_clone, timeout_secs)).await {
    Ok(r) => r?,
    Err(_) => return Err(PluginError::Timeout {
        command: format!("{:?}", args_clone),
        seconds: timeout_secs,
    }),
};
```

Note `kill_on_drop(true)` ensures the child dies cleanly when the timeout fires.

### §8.3 Argument building

Helpers (private to `plugins.rs`):

```rust
fn plugin_id_args(id: &str) -> Vec<String> {
    // CLI accepts "name@marketplace" verbatim.
    vec![id.to_string()]
}
```

The `id` is the FE's composite id. The CLI uses it as the primary key. No splitting required.

---

## §9 Threat model

Tagged per item with `[FEATURE]` (this plugin feature), `[EXISTING]` (already covered by an upstream layer — CLI / OS / Tauri capability), or `[BOTH]` (defense in depth).

### §9.1 Supply chain

| Threat | Tag | Mitigation |
|---|---|---|
| **T1 — Malicious plugin code installed and executed by Verboo Code** | [FEATURE] | Plugin runtime loading is **out of scope** for MVP. Plugins only affect the CLI's own session, never the desktop app's process. Reinforced by: no Rust plugin logic, no in-process plugin loader. |
| **T2 — User installs plugin from typo-squatted marketplace URL** | [BOTH] | FE always shows marketplace name + URL preview in `PluginInstallModal`. CLI writes the resolved marketplace to `known_marketplaces.json`; the next `marketplace_list` shows the canonical source. [EXISTING] CLI enforces HTTPS for URL-source marketplaces (today it does; verify in integration tests). |
| **T3 — Plugin manifest claims one version, ships another** | [BOTH] | `plugin_validate` runs the CLI's schema check (`marketplace.schema.json`). FE shows warnings + errors in the install modal. [EXISTING] CLI computes a `gitCommitSha` per install (visible in `installed_plugins.json`) and surfaces it on `--available` entries — diff against expected sha would catch a tamper post-checkout. |
| **T4 — Auto-install via dependency resolution (future)** | [EXISTING] | CLI does NOT auto-install plugin dependencies today. If it does in the future, this spec gates the desktop surface behind a confirm step regardless. |
| **T5 — Marketplace source hijacked via DNS / MITM** | [EXISTING] | CLI uses HTTPS for URL-source marketplaces (verify). GitHub-source marketplaces pin to `gitCommitSha`. |

### §9.2 Credentials & auth

| Threat | Tag | Mitigation |
|---|---|---|
| **T6 — Install invoked while user is unauthenticated, exposing partial state** | [FEATURE] | `require_auth` gate on all mutation commands. [BOTH] FE also pre-gates on `cliAuth.loggedIn` to skip dispatch. |
| **T7 — Auth token leaked via shell-out environment** | [EXISTING] | `CliSpawn::protect_user_cli_env` clears `DISABLE_AUTOUPDATER` and reuses the auth path the CLI already authenticates against. No token material is added to the child env. |
| **T8 — Auth prompt hangs the Tauri command thread** | [FEATURE] | Timeout per command (10-60 s). `kill_on_drop(true)` ensures child cleanup. [EXISTING] CLI accepts `--non-interactive` for all write commands (verify — if not, surface `cli_auth_required` on `not logged in` substring in stderr instead of letting it hang). |

### §9.3 Filesystem

| Threat | Tag | Mitigation |
|---|---|---|
| **T9 — Plugin install writes outside `~/.claude/plugins/`** | [EXISTING] | CLI owns the write paths. Wrapper does not pass `--install-path` or any escape hatches. |
| **T10 — `plugin validate <path>` accepts an arbitrary path and triggers OOM/long traversal** | [FEATURE] | Path is normalized to absolute; reject `..`, empty string, and any path under system directories (`/System`, `/Library`, `/usr`). 30 s timeout. Validate that path exists before spawn. |
| **T11 — Race between two concurrent installs of the same plugin** | [EXISTING] | CLI locks `installed_plugins.json` via OS file locking (verify). FE disables Install button on already-installing card. |

### §9.4 UI / UX

| Threat | Tag | Mitigation |
|---|---|---|
| **T12 — Long-running install appears frozen** | [FEATURE] | FE shows spinner + 60 s timeout. On timeout: "Instalação em background — feche a aba para cancelar". Mirrors Computer Use's pattern. |
| **T13 — User updates plugin, expects immediate effect** | [FEATURE] | Restart banner is mandatory in the install/update flow. Plugin runtime is CLI-side; desktop app has nothing to reload. |
| **T14 — Markdown / rich text in plugin description = XSS risk** | [FEATURE] | FE renders plugin description as plain text only (no `dangerouslySetInnerHTML`). UI library's safe rendering already handles this. |
| **T15 — Marketplace URL field = XSS / injection vector** | [FEATURE] | Input is URL-validated (https://, github:<owner/repo>, or absolute path). Reject on regex mismatch. |

### §9.5 Out of scope (deferred)

- Plugin permissions model — defer to v2 (CLI doesn't expose granular perms today).
- Auto-update loop — defer to v2.
- Plugin runtime sandboxing — defer to v2. Plugins affect CLI session only.
- Plugin telemetry / analytics — defer to v2.

---

## §10 P5 acceptance criteria (backend)

P5 is "Geralt builds this module". These criteria gate the Maestro's PASS verdict.

### §10.1 Functional

- [ ] 11 Tauri commands registered in `lib.rs` `invoke_handler`.
- [ ] All commands return `Result<T, PluginError>`.
- [ ] `plugin_list` returns `Vec<Plugin>` parsed from `verboo plugin list --json` with ANSI strip applied.
- [ ] `plugin_available` returns `PluginAvailablePayload` parsed from `verboo plugin list --json --available`.
- [ ] `plugin_install` / `plugin_enable` / `plugin_disable` / `plugin_uninstall` / `plugin_update` shell-out correctly with composite id (`name@marketplace`) and scope.
- [ ] `plugin_install` / `plugin_update` re-fetch `plugin_list` post-success and return the updated `Plugin`.
- [ ] `plugin_validate` returns `PluginValidateResult` with `valid` correctly set from exit code + body markers (`✘`, `Validation failed`).
- [ ] `marketplace_list` returns `Vec<Marketplace>`.
- [ ] `marketplace_add` accepts URL / GitHub repo / path forms and returns a `Marketplace`.
- [ ] `marketplace_remove` returns `()` on success.

### §10.2 Robustness

- [ ] ANSI strip handles `\u001b[?2026h` prefix AND absent prefix (unit test both).
- [ ] Timeout applies per command (15 s / 30 s / 60 s / 10 s as in §3.2).
- [ ] `kill_on_drop(true)` on the child process — child dies on timeout.
- [ ] Auth gate runs only on mutation commands, not on read commands.
- [ ] Error mapping covers all 9 `PluginError` variants with at least one unit test per kind.
- [ ] JSON parse failures return `parse_error` with a 500-char `rawPreview` (truncated to prevent log spam).
- [ ] `plugin_validate` rejects `..`, empty, and system-directory paths before spawn.

### §10.3 Tests

- [ ] Unit: `strip_ansi` with alt-screen prefix, plain text, mixed control chars.
- [ ] Unit: `map_cli_error` for each of the 9 error kinds (fixture-driven from real CLI invocations where possible).
- [ ] Unit: argument builders (id-with-scope, id-without-scope, path validation).
- [ ] Integration: shell-out to real CLI for `list`, `available`, `marketplace list`, `validate` against a sandboxed fixture dir. Uses `VERBOO_CLI_PATH` override to point at the local CLI 0.13 binary.
- [ ] Integration: shell-out for `enable` + `disable` on a throwaway plugin fixture (sandbox install dir), verify exit code + re-list state.
- [ ] Integration: timeout fires when CLI hangs (simulate with a sleep script).

### §10.4 Hygiene

- [ ] No new external crates beyond what's already in `Cargo.toml` (uses `tokio`, `serde`, `serde_json`, `regex`).
- [ ] No `unwrap()` on user-facing paths — all errors funnel through `PluginError`.
- [ ] Module file `plugins.rs` ≤ ~400 lines; split into `plugins/commands.rs`, `plugins/parse.rs`, `plugins/error.rs` if it grows.
- [ ] `pub use` in `services/mod.rs` and `models/mod.rs` for the new types.

### §10.5 Verifier gate

- [ ] Aloy: integration tests against real CLI 0.13 pass.
- [ ] Independent verifier agent: runs build + tests + invokes each of the 11 commands via a test harness, reports PASS/FAIL with evidence.
- [ ] No regression in the existing 543 Rust + 292 vitest (current dev baseline).

---

## §11 P6 acceptance criteria (informative — out of P5 scope)

Documented here so the P5 spec is internally complete. P6 is owned by Ciri and has its own gate.

- [ ] PluginsView renders fullscreen with header + search input + Installed section + Featured section.
- [ ] Search filters both Installed and Featured by name (case-insensitive substring).
- [ ] Click Install → validate → confirm modal → install → toast.
- [ ] Toggle enable/disable optimistic + revert on error.
- [ ] Uninstall confirm modal + fade-out + re-fetch.
- [ ] Update → toast → persistent restart banner until app restart.
- [ ] Manage marketplaces modal (add URL / GitHub / path + remove).
- [ ] Empty states: no installed (CTA), no results (query-aware copy).
- [ ] Loading skeletons, error banners (cli_not_found / network / auth / timeout).
- [ ] Reduced-motion: opacity-only animations.
- [ ] i18n EN + PT complete (keys `plugins.*`).
- [ ] View enter 200 ms fade+translateY; cards stagger 40 ms (max 8).
- [ ] No `transition: all`. Only `transform` + `opacity`. (Lição Ivo.)
- [ ] Verifier PASS.

---

## §12 Open questions / risks

| # | Question | Resolution path |
|---|---|---|
| Q1 | Does the CLI ever reject `--json` on `marketplace list` (post-0.13 drift)? | Feature-detect on first call; fallback to text parse with debug log warning. |
| Q2 | Does `verboo plugin install <id>` print progress to stdout (would block JSON parse if we ever add `--json` to it)? | Not a concern today — install doesn't accept `--json`. If added, stream progress to a Tauri event channel instead of stdout. |
| Q3 | Should `plugin_uninstall` support `--keep-data` via FE? | Yes — `keep_data: Option<bool>` already in the signature. FE default = false (clean removal). Show a checkbox in the confirm modal labeled "Preservar dados (`~/.claude/plugins/data/{id}/`)" — defaults unchecked. |
| Q4 | What if the user's CLI is older than 0.13 (no `--available` flag)? | Feature-detect: if `list --json --available` exits non-zero with `unknown flag --available` in stderr, set `cli_supports_available = false` and surface a banner: "Seu CLI Verboo é antigo — atualize para 0.13+ para ver plugins disponíveis". Install/enable/disable still work. |
| Q5 | Scope `managed` — CLI accepts it on `update` but not on install/uninstall. Should Rust signature allow it everywhere? | No — Rust signature mirrors CLI reality. `plugin_update` accepts `managed`; other mutations accept `user | project | local` only. Use `PluginScope` enum with three variants (matches §2.1). `managed` is a CLI-only update-specific scope; reject it on install/uninstall with a friendly error. |
| Q6 | What if a marketplace source fails to clone (network down at `marketplace_add` time)? | CLI returns exit code != 0 with stderr matching `clone`/`network`. Wrapper maps to `network_error`. FE shows banner + retry. |
| Q7 | Do we need a `marketplace_update` command in P5? | Plan listed 11 commands and did not include it. The CLI supports `verboo plugin marketplace update [name]`. **Defer to v2** (post-MVP) — the FE can call it via `invoke("plugin_marketplace_update")` once added. The user can trigger an update via the CLI directly in MVP. |

---

## §13 Glossary

- **Composite id:** `name@marketplace` — the CLI's primary key for an installed plugin. The marketplace suffix disambiguates same-named plugins from different sources.
- **Marketplace:** A configured source of plugins (GitHub repo or HTTPS URL to a `marketplace.json`). Stored in `known_marketplaces.json`.
- **Marketplace manifest:** The `marketplace.json` file inside a cloned marketplace repo, listing its plugins.
- **Trust level:** Desktop-side classification of a marketplace (`official` / `verified` / `community`). Not emitted by CLI today; FE hardcodes a known-good list. Out of MVP scope for P5.
- **CLI invocation:** A single shell-out to `verboo` via `CliSpawn`. Each Tauri command issues at least one (mutations may issue two — the mutation + a re-fetch).
- **`installed_plugins.json`:** Canonical on-disk record of installed plugins. NOT parsed by Rust. CLI owns it.
- **`known_marketplaces.json`:** Canonical on-disk record of configured marketplaces. NOT parsed by Rust. CLI owns it.

---

## §14 Spec changelog

- **2026-07-13 (initial):** Kratos spec, Wave 1 P0. Verified CLI 0.13.0 real JSON shapes for `list`, `list --available`, `marketplace list`, `validate`. Dropped plan's marketplace.json adapter (CLI's `--available` already does it). Adjusted `plugin_validate` signature to take `<path>` instead of `<name, marketplace>` to match CLI reality. Added feature-detect for `--available` flag (Q4). 11 Tauri commands match plan count exactly.