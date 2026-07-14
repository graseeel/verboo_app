// Plugin Marketplace types — mirrors `docs/plugins-marketplace.md` §2 and
// the Rust `src-tauri/src/models/plugins.rs` shapes.
//
// Real CLI 0.13 JSON shapes verified 2026-07-13. The desktop backend is a
// thin shell-out wrapper; these types describe what the Rust side returns
// to the renderer over Tauri's invoke bridge.

// ════════════════════════════════════════════════════════════════════
// Enums
// ════════════════════════════════════════════════════════════════════

export type PluginScope = 'user' | 'project' | 'local'

export type MarketplaceSource = 'github' | 'url'

export type MarketplaceTrust = 'official' | 'verified' | 'community'

// ════════════════════════════════════════════════════════════════════
// Plugin + AvailablePlugin
// ════════════════════════════════════════════════════════════════════

export interface PluginAuthor {
  name?: string
  email?: string
}

export interface Plugin {
  /** name@marketplace (composite id, the CLI's primary key) */
  id: string
  /** Bare name without @marketplace — for display */
  name: string
  /** Semver */
  version: string
  scope: PluginScope
  enabled: boolean
  installed: boolean
  installPath: string
  installedAt: string
  lastUpdated: string
  gitCommitSha?: string
  // ── Optional fields only present in `--available` rows ──────────
  description?: string
  homepage?: string
  author?: PluginAuthor
  category?: string
  installCount?: number
}

export interface AvailablePlugin {
  /** name@marketplace — same shape as Plugin.id */
  pluginId: string
  /** Bare name without @marketplace */
  name: string
  description: string
  marketplaceName: string
  /** Discriminated union OR relative-path shorthand string */
  source: PluginSource
  installCount: number
}

export interface PluginAvailablePayload {
  installed: Plugin[]
  available: AvailablePlugin[]
}

// ════════════════════════════════════════════════════════════════════
// PluginSource (discriminated union)
// ════════════════════════════════════════════════════════════════════

export type PluginSource =
  | { source: 'git-subdir'; url: string; path: string; ref: string; sha: string }
  | { source: 'git'; url: string; sha: string }
  | { source: 'url'; url: string; sha: string }
  | { source: 'github'; repo: string }
  | { source: 'npm'; package: string; version: string }
  | { source: 'local'; path: string }
  /** Relative path shorthand OR future unknown variant — FE renders a safe fallback */
  | string

// ════════════════════════════════════════════════════════════════════
// Marketplace
// ════════════════════════════════════════════════════════════════════

export interface Marketplace {
  /** Bare marketplace name (e.g. "claude-plugins-official") */
  name: string
  source: MarketplaceSource | string
  /** Present when source === 'github' */
  repo?: string
  /** Present when source === 'url' */
  url?: string
  installLocation: string
  /** FE-derived (count of available plugins) */
  pluginCount?: number
  /** FE-derived trust policy */
  trust?: MarketplaceTrust
}

// ════════════════════════════════════════════════════════════════════
// PluginValidateResult
// ════════════════════════════════════════════════════════════════════

export interface PluginValidateResult {
  /** true if CLI exited 0 AND output does not contain "✘" or "Validation failed" */
  valid: boolean
  warnings: string[]
  errors: string[]
  hash?: string
  signature?: string
  /** Truncated raw stdout for debugging (max 2 KB) */
  rawOutput?: string
}

// ════════════════════════════════════════════════════════════════════
// PluginError (9 variants — internally tagged via `kind`)
// ════════════════════════════════════════════════════════════════════

export type PluginError =
  | { kind: 'cli_not_found' }
  | { kind: 'cli_auth_required' }
  | { kind: 'network_error'; message: string }
  | { kind: 'parse_error'; message: string; rawPreview?: string }
  | { kind: 'invalid_plugin'; errors: string[]; warnings?: string[] }
  | { kind: 'invalid_marketplace'; message: string }
  | { kind: 'already_installed'; plugin: string }
  | { kind: 'not_installed'; plugin: string }
  | { kind: 'timeout'; command: string; seconds: number }
  | { kind: 'unknown'; message: string; exitCode?: number }

/** Human-readable message for a PluginError. PT-BR copy (P5 uses PT-BR). */
export function describePluginError(err: PluginError): string {
  switch (err.kind) {
    case 'cli_not_found':
      return 'CLI Verboo não encontrado.'
    case 'cli_auth_required':
      return 'Faça login para gerenciar plugins.'
    case 'network_error':
      return `Erro de rede: ${err.message}`
    case 'parse_error':
      return `Falha ao ler resposta do CLI: ${err.message}`
    case 'invalid_plugin':
      return `Plugin inválido: ${err.errors.join('; ')}`
    case 'invalid_marketplace':
      return `Marketplace inválido: ${err.message}`
    case 'already_installed':
      return `Plugin já instalado: ${err.plugin}`
    case 'not_installed':
      return `Plugin não instalado: ${err.plugin}`
    case 'timeout':
      return `Tempo limite (${err.seconds}s): ${err.command}`
    case 'unknown':
      return `Erro desconhecido: ${err.message}`
  }
}

/** Type guard — narrows a caught (unknown) value to PluginError if it has a known `kind`. */
export function isPluginError(value: unknown): value is PluginError {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  return (
    typeof kind === 'string' &&
    [
      'cli_not_found',
      'cli_auth_required',
      'network_error',
      'parse_error',
      'invalid_plugin',
      'invalid_marketplace',
      'already_installed',
      'not_installed',
      'timeout',
      'unknown',
    ].includes(kind)
  )
}

// ════════════════════════════════════════════════════════════════════
// Rich detail types (Wave 2 P5+ — Codex parity)
// ════════════════════════════════════════════════════════════════════

/**
 * A skill discovered in an installed plugin's `skills/` directory.
 * Parsed from `skills/<dir>/SKILL.md` YAML frontmatter.
 */
export interface PluginSkill {
  /** Skill name from frontmatter `name:`. Falls back to directory name. */
  name: string
  /** Skill description from frontmatter `description:`. */
  description?: string
  /** Absolute path to the SKILL.md file (for FE deep-linking). */
  skillPath: string
}

/**
 * Rich detail for an installed plugin — merges the CLI's `Plugin` row
 * with on-disk `.claude-plugin/plugin.json` metadata + discovered skills.
 * The FE uses this for the plugin detail view (Codex parity).
 */
export interface PluginDetail extends Plugin {
  /** Skills discovered in `skills/<dir>/SKILL.md`. Empty if no skills dir. */
  skills: PluginSkill[]
  /** Author name from `.claude-plugin/plugin.json`. Distinct from
   * `Plugin.author` (which is a `PluginAuthor` object from the CLI's
   * `--available` payload). This is the flat string from the manifest. */
  authorName?: string
  /** Author email from `.claude-plugin/plugin.json`. */
  authorEmail?: string
  /** Homepage URL from `.claude-plugin/plugin.json`. */
  manifestHomepage?: string
  /** Repository URL from `.claude-plugin/plugin.json`. */
  repository?: string
  /** License from `.claude-plugin/plugin.json` (e.g. "MIT"). */
  license?: string
  /** Keywords from `.claude-plugin/plugin.json`. */
  keywords: string[]
  /** Description from `.claude-plugin/plugin.json` (richer than CLI's). */
  manifestDescription?: string
}

/**
 * Rich per-plugin metadata extracted from a marketplace's
 * `.claude-plugin/marketplace.json`. Keyed by `pluginId`
 * (`name@marketplaceName`) in the map returned by `marketplaceManifests()`.
 * The FE merges this with the CLI's `--available` JSON for Codex parity.
 */
export interface MarketplacePluginEntry {
  /** Bare plugin name (e.g. "42crunch-api-security-testing"). */
  name: string
  /** Thematic category (e.g. "security", "design", "development"). */
  category?: string
  /** Developer/author name. */
  author?: string
  /** Author email (rare). */
  authorEmail?: string
  /** Homepage URL. */
  homepage?: string
  /** Long description. */
  description?: string
  /** Semver version (rare in marketplace.json). */
  version?: string
  /** Display name (some manifests carry this). */
  displayName?: string
  /** Keywords array (rare). */
  keywords: string[]
  /** Tags array (some manifests carry this). */
  tags: string[]
}

/** Map keyed by `pluginId` (`name@marketplaceName`) → rich metadata. */
export type MarketplaceManifestMap = Record<string, MarketplacePluginEntry>

// ════════════════════════════════════════════════════════════════════
// Plugin icon (P5.1 — on-demand fetch from homepage domain)
// ════════════════════════════════════════════════════════════════════

/**
 * Result of `pluginIcon`. `iconPath === null` means the FE should render
 * a monogram fallback (no icon available, toggle off, or fetch failed).
 *
 * The FE converts `iconPath` to a displayable URL via `convertFileSrc(path)`.
 */
export interface PluginIconResult {
  /** Absolute path to the cached icon file, or null if unavailable. */
  iconPath: string | null
  /** The domain the icon was fetched from (for debugging / dedupe). */
  domain?: string
  /** True if the icon came from the cache (no network request). */
  cached: boolean
}
