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
      'already_installed',
      'not_installed',
      'timeout',
      'unknown',
    ].includes(kind)
  )
}
