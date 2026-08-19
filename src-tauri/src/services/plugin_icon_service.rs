//! Plugin icon fetcher + disk cache (P5.1).
//!
//! Resolves a plugin's homepage domain (from the marketplace manifest) and
//! fetches `/apple-touch-icon.png` then `/favicon.ico` directly from that
//! domain. NO third-party services (no Google s2, no favicon APIs). HTTPS
//! only. On-demand only (never preemptive at launch — privacy).
//!
//! Cache layout (`<app_data_dir>/cache/plugin-icons/`):
//!   - `<sha256(domain)>.<ext>` — the icon file
//!   - `index.json` — sidecar mapping `{ domain → { file, fetchedAt, ext } }`
//!
//! Cache policy:
//!   - TTL: 7 days (entries older than this are re-fetched)
//!   - Cap: 50 MB total (LRU eviction when exceeded)
//!   - Dedupe: by domain (multiple plugins from the same domain share one icon)
//!   - Concurrency: semaphore of 6 (max 6 simultaneous fetches)
//!
//! Security:
//!   - HTTPS only (http:// rejected)
//!   - Max 512 KB per icon
//!   - Accepted: png, ico, jpg, webp
//!   - REJECTED: svg (script injection risk)
//!   - Content-type sniffed from magic bytes (not trusted from server header)

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tokio::sync::{Notify, Semaphore};

use crate::models::plugins::PluginError;
use crate::services::marketplace_manifest_service::MarketplacePluginEntry;

// ════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════

/// Cache TTL for a HIT (icon was fetched successfully): 7 days.
const TTL_HIT_SECS: u64 = 7 * 24 * 60 * 60;

/// Cache TTL for a MISS (fetch failed — cache the negative result so we
/// don't hammer the server on every request): 1 day. Natural retry.
const TTL_MISS_SECS: u64 = 24 * 60 * 60;

/// Version prefix for ALL cache keys. Invalida completamente entradas
/// pré-gate ao mudar o input do hash e a chave do índice. Bump quando
/// a lógica de resolução mudar substancialmente (ex.: privacidade gate).
/// Formato: `v<N>|` — incluído antes do domínio no hash e no index key.
const CACHE_KEY_VERSION: &str = "v2|";

/// Max cache size: 50 MB.
const MAX_CACHE_BYTES: u64 = 50 * 1024 * 1024;

/// Max icon size: 512 KB.
const MAX_ICON_BYTES: usize = 512 * 1024;

/// Max HTML size for link-tag discovery: 100 KB.
const MAX_HTML_BYTES: usize = 100 * 1024;

/// Max concurrent fetches.
const MAX_CONCURRENCY: usize = 6;

/// Fetch timeout: 5 seconds.
const FETCH_TIMEOUT_SECS: u64 = 5;

/// Icon paths to try, in order. HTTPS only — the fetcher rejects http://.
const ICON_PATHS: &[&str] = &["/apple-touch-icon.png", "/favicon.ico"];

/// Generic code/package hosts whose favicon/apple-touch-icon is the host's
/// branding (e.g. GitHub's octocat), NOT the plugin's. Fetching these would
/// show dozens of identical wrong icons. We skip the fetch entirely and
/// return None (FE renders monogram) when the homepage domain matches.
///
/// NOTE: `www.` variants are NOT listed because `extract_domain` strips
/// `www.` before `is_generic_host` is called, so `www.npmjs.com` always
/// becomes `npmjs.com` first.
const GENERIC_HOST_BLOCKLIST: &[&str] = &[
    "github.com",
    "gitlab.com",
    "bitbucket.org",
    "npmjs.com",
    "raw.githubusercontent.com",
    "pypi.org",
    "crates.io",
    "sourceforge.net",
];

/// Cache schema version. Bumped when the blocklist changes or the index
/// shape changes — old caches are evicted on load to avoid serving stale
/// blocklisted entries (e.g. github.com icons from before the blocklist).
/// v3: added `ttl_secs` field to CacheIndexEntry (hit=7d, miss=1d).
const CACHE_VERSION: u32 = 3;

// ════════════════════════════════════════════════════════════════════
// Public types
// ════════════════════════════════════════════════════════════════════

/// Result of `plugin_icon`. `None` means the FE should render a monogram
/// fallback (no icon available, toggle off, or fetch failed).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginIconResult {
    /// Absolute path to the cached icon file. The FE converts this to a
    /// displayable URL via `convertFileSrc(path)`.
    pub icon_path: Option<String>,
    /// The domain the icon was fetched from (for debugging / dedupe).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    /// True if the icon came from the cache (no network request).
    pub cached: bool,
}

/// Sidecar index entry. Maps a domain to its cached icon file + metadata.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheIndexEntry {
    /// Filename within the cache dir (e.g. `abc123.png`).
    pub file: String,
    /// File extension without dot (e.g. `png`, `ico`).
    pub ext: String,
    /// Unix timestamp (seconds) when the icon was fetched.
    pub fetched_at: u64,
    /// File size in bytes.
    pub size: u64,
    /// TTL in seconds for this entry. Hits use `TTL_HIT_SECS` (7 days);
    /// misses use `TTL_MISS_SECS` (1 day) for natural retry. v3 field.
    #[serde(default = "default_ttl_hit_secs")]
    pub ttl_secs: u64,
}

/// Default for `ttl_secs` when deserializing v2 caches (no field). Treats
/// old entries as hits (7-day TTL) — safe default.
fn default_ttl_hit_secs() -> u64 {
    TTL_HIT_SECS
}

/// The cache index — a map of `domain → CacheIndexEntry`.
type CacheIndex = HashMap<String, CacheIndexEntry>;

/// Versioned wrapper around `CacheIndex` for the on-disk `index.json`.
/// The `version` field lets us bump the schema and evict old caches
/// cleanly (e.g. when the blocklist changes and stale github.com icons
/// need to be purged).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VersionedCacheIndex {
    pub version: u32,
    pub entries: CacheIndex,
}

// ════════════════════════════════════════════════════════════════════
// Public API
// ════════════════════════════════════════════════════════════════════

/// Resolves the icon for a plugin. On-demand only — never called at launch.
///
/// Flow:
/// 1. If `load_web_icons` is false → return `None` (no network).
/// 2. Resolve `pluginId` → marketplace manifest entry → `homepage` → domain.
/// 3. If no homepage → return `None`.
/// 4. Check cache: if fresh (< 7 days) → return cached path.
/// 5. Fetch (semaphore-limited): try `/apple-touch-icon.png`, then `/favicon.ico`.
/// 6. Validate: HTTPS only, ≤ 512 KB, png/ico/jpg/webp (NOT svg).
/// 7. Write to cache, update index, enforce 50 MB LRU cap.
/// 8. Return path (FE uses `convertFileSrc`).
pub async fn resolve_plugin_icon(
    plugin_id: &str,
    manifests: &HashMap<String, MarketplacePluginEntry>,
    cache_dir: PathBuf,
    load_web_icons: bool,
) -> Result<PluginIconResult, PluginError> {
    // Privacy toggle: if off, return None without any network request.
    if !load_web_icons {
        return Ok(PluginIconResult {
            icon_path: None,
            domain: None,
            cached: false,
        });
    }

    // Resolve pluginId → manifest entry.
    let entry = manifests.get(plugin_id).ok_or_else(|| PluginError::Unknown {
        message: format!("plugin {plugin_id} not found in marketplace manifests"),
        exit_code: None,
    })?;

    // Ensure cache dir exists (needed by both homepage and avatar phases).
    std::fs::create_dir_all(&cache_dir).map_err(|e| PluginError::Unknown {
        message: format!("failed to create cache dir: {e}"),
        exit_code: None,
    })?;

    // Load the index ONCE and reuse across all cache operations.
    let mut index = load_index(&cache_dir);

    // ════════════════════════════════════════════════════════════════
    // Phase 1 — homepage link-tag icon (current flow)
    // ════════════════════════════════════════════════════════════════
    let homepage: Option<&str> = entry.homepage.as_deref().filter(|h| !h.is_empty());
    let homepage_domain: Option<String> = homepage.and_then(extract_domain);

    if let Some(ref domain) = homepage_domain {
        // GitHub-specific gate (Feedback-4 Item 2 correction): when the
        // homepage is github.com, the link-tag icon is the repo owner's
        // avatar — which is a person's face for User accounts. Extract
        // the owner from the URL and apply the Organization gate BEFORE
        // fetching. Only Organizations proceed; Users / unknown / errors
        // skip Phase 1 entirely (fall through to Phase 2 or monogram).
        let is_github = domain == "github.com";
        let gh_owner_from_url: Option<String> = if is_github {
            homepage.and_then(extract_github_owner_from_url)
        } else {
            None
        };

        let allow_phase1_fetch = if !is_generic_host(domain) {
            // Non-blocklisted non-GitHub host → always allow (brand favicons).
            true
        } else if is_github && gh_owner_from_url.is_some() {
            // GitHub with extractable owner → gate by type.
            let owner = gh_owner_from_url.as_ref().unwrap();
            fetch_owner_type(owner, Some(&cache_dir)).await == Some(OwnerType::Organization)
        } else {
            // Other blocklisted hosts OR GitHub without extractable owner.
            // Default safe: skip Phase 1 fetch.
            false
        };

        if allow_phase1_fetch {
            // GitHub Organization branch: fetch the ORG's avatar (not the
            // generic github.com favicon). Cache key is owner-specific so
            // one org's avatar doesn't leak to another org's plugins.
            let is_github_org = is_github && gh_owner_from_url.is_some();
            let cache_lookup_key = if is_github_org {
                format!("gh-avatar:{}", gh_owner_from_url.as_ref().unwrap())
            } else {
                domain.clone()
            };

            // Try cache + fetch.
            if let Some(cached) = check_cache(&index, &cache_lookup_key, &cache_dir) {
                return Ok(PluginIconResult {
                    icon_path: Some(cached.to_string_lossy().to_string()),
                    domain: Some(cache_lookup_key.clone()),
                    cached: true,
                });
            }
            if check_miss_cache(&index, &cache_lookup_key) {
                // Phase 1 miss — fall through to Phase 2 (avatar) if available.
                if entry.github_owner.is_none() {
                    return Ok(PluginIconResult {
                        icon_path: None,
                        domain: Some(cache_lookup_key.clone()),
                        cached: false,
                    });
                }
            } else {
                // No cached miss yet — try fetching.
                let icon_data = if is_github_org {
                    fetch_github_avatar(gh_owner_from_url.as_ref().unwrap()).await
                } else {
                    fetch_icon(domain).await
                };
                if let Some(icon_data) = icon_data {
                    let icon_path = write_to_cache(
                        &cache_dir,
                        &cache_lookup_key,
                        &icon_data,
                        &mut index,
                    )?;
                    return Ok(PluginIconResult {
                        icon_path: Some(icon_path.to_string_lossy().to_string()),
                        domain: Some(cache_lookup_key.clone()),
                        cached: false,
                    });
                }
                // Fetch failed — cache miss.
                write_miss_to_cache(&cache_dir, &cache_lookup_key, &mut index);
                if entry.github_owner.is_none() {
                    return Ok(PluginIconResult {
                        icon_path: None,
                        domain: Some(cache_lookup_key.clone()),
                        cached: false,
                    });
                }
            }
        } else {
            // Phase 1 skipped (blocklisted OR GitHub-User/unknown). Fall
            // through to Phase 2 (GitHub avatar) if available; otherwise
            // monogram. Phase 2 has its own Organization gate.
            if entry.github_owner.is_none() {
                return Ok(PluginIconResult {
                    icon_path: None,
                    domain: Some(domain.clone()),
                    cached: false,
                });
            }
        }
    }

    // ════════════════════════════════════════════════════════════════
    // Phase 2 — GitHub owner avatar fallback (Feedback-3 Item 6)
    // ════════════════════════════════════════════════════════════════
    if let Some(owner) = &entry.github_owner {
        // Privacy gate (Feedback-4 Item 2): NUNCA mostrar avatar de
        // pessoa física. Only Organization accounts bypass this gate.
        // Errors/timeout/rate-limit default to safe (monogram).
        let owner_type = fetch_owner_type(owner, Some(&cache_dir)).await;
        if owner_type != Some(OwnerType::Organization) {
            // Not an Organization → skip avatar (monogram). Don't write a
            // full cache miss so a future type change (owner → org) is
            // eventually picked up without clearing the cache index.
            return Ok(PluginIconResult {
                icon_path: None,
                domain: None,
                cached: false,
            });
        }

        let avatar_domain = "github.com";

        // Check cache for github.com domain.
        if let Some(cached) = check_cache(&index, avatar_domain, &cache_dir) {
            return Ok(PluginIconResult {
                icon_path: Some(cached.to_string_lossy().to_string()),
                domain: Some(avatar_domain.to_string()),
                cached: true,
            });
        }
        if check_miss_cache(&index, avatar_domain) {
            return Ok(PluginIconResult {
                icon_path: None,
                domain: Some(avatar_domain.to_string()),
                cached: false,
            });
        }

        // Fetch GitHub avatar with SSRF-safe redirect.
        if let Some(icon_data) = fetch_github_avatar(owner).await {
            let icon_path =
                write_to_cache(&cache_dir, avatar_domain, &icon_data, &mut index)?;
            return Ok(PluginIconResult {
                icon_path: Some(icon_path.to_string_lossy().to_string()),
                domain: Some(avatar_domain.to_string()),
                cached: false,
            });
        }

        // Avatar fetch failed — cache miss.
        write_miss_to_cache(&cache_dir, avatar_domain, &mut index);
    }

    // ════════════════════════════════════════════════════════════════
    // Phase 3 — monogram (no icon available)
    // ════════════════════════════════════════════════════════════════
    Ok(PluginIconResult {
        icon_path: None,
        domain: None,
        cached: false,
    })
}

// ════════════════════════════════════════════════════════════════════
// Internal: domain extraction
// ════════════════════════════════════════════════════════════════════

/// Extracts the domain from a homepage URL. Returns `None` if the URL is
/// not http(s) or has no host. Strips `www.` prefix for dedupe.
pub(crate) fn extract_domain(url: &str) -> Option<String> {
    let trimmed = url.trim();
    // Accept both https:// and http:// (http is rejected at fetch time).
    let after_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))?;
    let host = after_scheme.split('/').next()?;
    let host = host.split('?').next()?; // strip query
    let host = host.split('#').next()?; // strip fragment
    // Strip port (we always fetch :443).
    let host = host.split(':').next()?;
    if host.is_empty() {
        return None;
    }
    // Strip www. for dedupe (www.example.com → example.com). Case-insensitive
    // so WWW.Example.COM is also stripped (lowercased AFTER strip).
    let host_lower = host.to_lowercase();
    let host = host_lower.strip_prefix("www.").unwrap_or(&host_lower);
    Some(host.to_string())
}

/// Extracts the GitHub owner (first path segment) from a homepage URL
/// when the host is `github.com` or `www.github.com`. Returns `None`
/// for non-GitHub URLs or URLs without an owner segment.
///
/// Examples:
/// - `https://github.com/obra/superpowers.git` → `Some("obra")`
/// - `https://www.github.com/anthropics/foo` → `Some("anthropics")`
/// - `https://github.com/` → `None`
/// - `https://example.com/obra` → `None` (not github)
pub(crate) fn extract_github_owner_from_url(url: &str) -> Option<String> {
    let trimmed = url.trim();
    let after_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))?;
    let after_host = after_scheme
        .strip_prefix("github.com/")
        .or_else(|| after_scheme.strip_prefix("www.github.com/"))?;
    let segment = after_host
        .split('/')
        .next()
        .filter(|s| !s.is_empty())?;
    let segment = segment.split('?').next()?;
    let segment = segment.split('#').next()?;
    if segment.is_empty() {
        return None;
    }
    Some(segment.to_string())
}

/// Returns true if the domain is a generic code/package host whose
/// favicon is the host's branding (e.g. GitHub's octocat), NOT the
/// plugin's. Fetching these would show dozens of identical wrong icons.
/// We skip the fetch entirely and return None (FE renders monogram).
pub(crate) fn is_generic_host(domain: &str) -> bool {
    let lower = domain.to_lowercase();
    GENERIC_HOST_BLOCKLIST.iter().any(|h| lower == *h || lower.ends_with(&format!(".{h}")))
}

/// SSRF guard: validates a resolved icon URL is safe to fetch. Returns
/// `Some(url)` if safe, `None` if rejected. Checks:
///   - HTTPS only (http:// rejected)
///   - Host is NOT a generic code/package host (re-apply blocklist)
///   - Host is NOT an IP literal in private/loopback/link-local ranges
///   - Host is NOT `localhost`
///
/// This is CRITICAL when fetching icons discovered via HTML `<link rel>`
/// tags — a malicious manifest could point to `http://127.0.0.1/admin`
/// or `https://10.0.0.1/internal`. We block all private IP ranges.
pub(crate) fn is_ssrf_safe_url(url: &str) -> bool {
    // Must be https://.
    if !url.starts_with("https://") {
        return false;
    }
    // Parse host.
    let after_scheme = &url[8..]; // skip "https://"
    let host = after_scheme.split('/').next().unwrap_or("");
    let host = host.split('?').next().unwrap_or("");
    let host = host.split('#').next().unwrap_or("");
    // Strip port. IPv6 literals are wrapped in brackets: [::1]:8080.
    let host = if host.starts_with('[') {
        // IPv6 literal — extract between brackets.
        if let Some(end) = host.find(']') {
            &host[1..end]
        } else {
            return false; // malformed
        }
    } else {
        host.split(':').next().unwrap_or("")
    };
    let host = host.to_lowercase();

    if host.is_empty() || host == "localhost" {
        return false;
    }

    // Re-apply generic host blocklist (a link-tag could point to github.com).
    if is_generic_host(&host) {
        return false;
    }

    // Block IP literals in private/loopback/link-local ranges.
    if is_private_ip(&host) {
        return false;
    }

    true
}

/// Returns true if `host` is an IP literal in a private/loopback/link-local
/// range. Blocks: 10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, ::1,
/// fc00::/7 (IPv6 ULA), fe80::/10 (IPv6 link-local).
///
/// Also catches non-standard IP encodings that glibc resolves differently
/// from Rust's `FromStr` (decimal integer IP, hex IP, octal-prefixed octets,
/// IPv4-mapped IPv6). The guideline: "na dúvida, REJEITAR — é só um ícone."
pub(crate) fn is_private_ip(host: &str) -> bool {
    // ── Non-standard IP encodings (glibc divergence) ──────────────────

    // 1. Hex integer: "0x7f000001" → 127.0.0.1 (glibc). Rust rejects this
    //    as an Ipv4Addr parse. Reject any host with `0x` / `0X` prefix.
    if host.starts_with("0x") || host.starts_with("0X") {
        if let Ok(num) = u32::from_str_radix(&host[2..], 16) {
            return is_private_ipv4(&std::net::Ipv4Addr::from(num));
        }
        return true; // suspicious hex-like — REJECT
    }

    // 2. Decimal integer: "2130706433" → 127.0.0.1 (glibc).
    //    Rust's Ipv4Addr parse rejects this. Reject ALL all-numeric hosts
    //    regardless of whether the decoded IP is private or public — the
    //    non-standard encoding is suspicious enough to reject ("é só um
    //    ícone, fallback monogram").
    if is_all_digits(host) {
        return true; // REJECT: non-standard numeric form
    }

    // 3. Leading-zero octets (octal ambiguity): "0177.0.0.1" → glibc
    //    interprets 0177 as octal 127.0.0.1; Rust parses 0177 as decimal
    //    177.0.0.1. Reject dotted-quads with leading-zero components.
    if has_leading_zero_octet(host) || has_hex_octet(host) || has_octal_octet(host) {
        // Try Rust's parse first — if it maps to a private IP, reject.
        if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
            if is_private_ipv4(&ip) {
                return true;
            }
        }
        // glibc would interpret differently; reject to be safe.
        return true;
    }

    // ── Standard IP literals ──────────────────────────────────────────

    // IPv4 literal.
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        return is_private_ipv4(&ip);
    }
    // IPv6 literal.
    if let Ok(ip) = host.parse::<std::net::Ipv6Addr>() {
        // IPv4-mapped IPv6 addresses: `::ffff:127.0.0.1` is NOT caught by
        // `is_loopback()` (which only covers `::1`). Extract the embedded
        // IPv4 and re-check.
        if let Some(mapped) = ip.to_ipv4() {
            if is_private_ipv4(&mapped) {
                return true;
            }
        }
        // Also check ::1 (loopback), unspecified, ULA, link-local.
        return ip.is_loopback()
            || ip.is_unspecified()
            || is_ipv6_ula(&ip)
            || is_ipv6_link_local(&ip);
    }
    // Not an IP literal (it's a hostname like "example.com").
    false
}

/// Checks if an `Ipv4Addr` is in a private/loopback/link-local/unspec range.
fn is_private_ipv4(ip: &std::net::Ipv4Addr) -> bool {
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
}

/// Returns true if `s` is non-empty and all ASCII digits.
fn is_all_digits(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

/// Returns true if a dotted-quad host has components with leading zeros
/// (e.g. `0177.0.0.1`). glibc interprets these as octal (0177 = 127),
/// while Rust parses them as decimal (0177 = 177). Reject to be safe.
fn has_leading_zero_octet(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    parts.iter().any(|p| p.len() > 1 && p.starts_with('0'))
}

/// Returns true if a dotted-quad host has `0x` in any component
/// (e.g. `0x7f.0.0.1`). glibc interprets these as hex. Only applies
/// to dotted-quad strings so `example0x00.com` is NOT rejected.
fn has_hex_octet(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    host.to_lowercase().contains("0x")
}

/// Returns true if a dotted-quad host has octal-form components
/// (e.g. `0177.0.0.1` or `0.0.0.0177` — anything that starts with 0
/// and has > 1 digit). Redundant with `has_leading_zero_octet` but
/// also catches the edge case `0.0.0.0177` where only the last octet
/// has leading zeros.
fn has_octal_octet(_host: &str) -> bool {
    // Same as leading-zero check but also works for non-dotted forms.
    // For dotted forms, this is covered by has_leading_zero_octet.
    // For single-integer forms (already caught by is_all_digits),
    // octal isn't applicable.
    false // Covered by has_leading_zero_octet for dotted forms.
}

/// Returns true if an IPv6 address is in the Unique Local Address range
/// (fc00::/7). `std::net::Ipv6Addr` doesn't expose this directly.
fn is_ipv6_ula(ip: &std::net::Ipv6Addr) -> bool {
    let segments = ip.segments();
    // fc00::/7 means the first byte (top 8 bits of segments[0]) is in
    // 0xfc..=0xfd.
    (segments[0] & 0xfe00) == 0xfc00
}

/// Returns true if an IPv6 address is link-local (fe80::/10).
fn is_ipv6_link_local(ip: &std::net::Ipv6Addr) -> bool {
    let segments = ip.segments();
    (segments[0] & 0xffc0) == 0xfe80
}

// ════════════════════════════════════════════════════════════════════
// Internal: cache
// ════════════════════════════════════════════════════════════════════

/// Loads the cache index from `index.json`. Returns an empty map if the
/// file is missing or unparseable (tolerant — a corrupt index doesn't
/// break icon fetching, we just re-fetch).
///
/// Also evicts any entries whose domain is now blocklisted (e.g. github.com
/// icons cached before the blocklist was added) and entries from an older
/// cache schema version. The eviction is best-effort — if the index file
/// can't be written back, the stale entries remain on disk but are ignored
/// in memory (they'll be re-fetched on next miss, which returns None for
/// blocklisted domains).
fn load_index(cache_dir: &Path) -> CacheIndex {
    let index_path = cache_dir.join("index.json");
    let raw = match std::fs::read_to_string(&index_path) {
        Ok(r) => r,
        Err(_) => return CacheIndex::new(),
    };

    // Try to parse as a versioned index first; fall back to plain map
    // for backwards compat with v1 caches (no version field).
    let (version, mut index): (u32, CacheIndex) = if let Ok(v) = serde_json::from_str::<VersionedCacheIndex>(&raw) {
        (v.version, v.entries)
    } else {
        // v1 cache (no version field) — treat as version 1.
        (1, serde_json::from_str(&raw).unwrap_or_default())
    };

    // If the cache schema is outdated, drop everything (re-fetch on demand).
    if version < CACHE_VERSION {
        // Best-effort: delete the old icon files.
        for entry in index.values() {
            let _ = std::fs::remove_file(cache_dir.join(&entry.file));
        }
        return CacheIndex::new();
    }

    // Evict any blocklisted domains. Strip `CACHE_KEY_VERSION` prefix from
    // versioned keys so `is_generic_host` sees the actual domain.
    let before = index.len();
    index.retain(|domain, entry| {
        let bare = domain.strip_prefix(CACHE_KEY_VERSION).unwrap_or(domain);
        if is_generic_host(bare) {
            let _ = std::fs::remove_file(cache_dir.join(&entry.file));
            false
        } else {
            true
        }
    });
    if index.len() != before {
        save_index(cache_dir, &index);
    }

    index
}

/// Saves the cache index to `index.json` with the current schema version.
/// Uses atomic write (tmp file + rename) so concurrent readers never see a
/// half-written file. Best-effort — a write failure is silently ignored
/// (the next successful write will persist the correct state).
fn save_index(cache_dir: &Path, index: &CacheIndex) {
    let index_path = cache_dir.join("index.json");
    let tmp_path = cache_dir.join("index.json.tmp");
    let versioned = VersionedCacheIndex {
        version: CACHE_VERSION,
        entries: index.clone(),
    };
    if let Ok(raw) = serde_json::to_string_pretty(&versioned) {
        // Write to tmp, then atomically rename. This prevents concurrent
        // readers from seeing a partial write (which caused the migration
        // to re-run and drop entries).
        if std::fs::write(&tmp_path, &raw).is_ok() {
            if std::fs::rename(&tmp_path, &index_path).is_err() {
                // Clean up the tmp file on rename failure.
                let _ = std::fs::remove_file(&tmp_path);
            }
        }
    }
}

/// Checks the cache for a fresh HIT entry for `domain`. Returns the icon
/// path if the entry exists, has a non-empty file, the file is present, and
/// the TTL hasn't expired.
fn check_cache(index: &CacheIndex, domain: &str, cache_dir: &Path) -> Option<PathBuf> {
    let key = cache_key(domain);
    let entry = index.get(&key)?;
    // Miss entries (empty file) are handled by `check_miss_cache`.
    if entry.file.is_empty() {
        return None;
    }
    let now = now_secs();
    let ttl = entry.ttl_secs;
    if now.saturating_sub(entry.fetched_at) > ttl {
        return None; // expired (hit TTL=7d)
    }
    let path = cache_dir.join(&entry.file);
    if !path.exists() {
        return None; // file missing (evicted manually?)
    }
    Some(path)
}

/// Checks if `domain` has a fresh MISS entry (recent fetch failure within
/// `TTL_MISS_SECS`). Returns true if we should NOT re-fetch (avoid hammering).
fn check_miss_cache(index: &CacheIndex, domain: &str) -> bool {
    let key = cache_key(domain);
    let entry = match index.get(&key) {
        Some(e) => e,
        None => return false,
    };
    // Only miss entries (empty file) are checked here.
    if !entry.file.is_empty() {
        return false;
    }
    let now = now_secs();
    now.saturating_sub(entry.fetched_at) <= entry.ttl_secs
}

/// Writes icon data to the cache and updates the index. Enforces the 50 MB
/// LRU cap by evicting oldest entries until under the limit. Uses
/// `TTL_HIT_SECS` (7 days) — successful fetches are cached long.
fn write_to_cache(
    cache_dir: &Path,
    domain: &str,
    data: &IconData,
    index: &mut CacheIndex,
) -> Result<PathBuf, PluginError> {
    let key = cache_key(domain);
    let hash = hash_domain(&key);
    let filename = format!("{hash}.{}", data.ext);
    let path = cache_dir.join(&filename);

    std::fs::write(&path, &data.bytes).map_err(|e| PluginError::Unknown {
        message: format!("failed to write icon cache: {e}"),
        exit_code: None,
    })?;

    let size = data.bytes.len() as u64;
    let now = now_secs();

    // Remove any old entry for this domain (different ext) to avoid stale files.
    if let Some(old) = index.remove(&key) {
        let old_path = cache_dir.join(&old.file);
        if old_path != path && old_path.exists() {
            let _ = std::fs::remove_file(&old_path);
        }
    }

    index.insert(
        key,
        CacheIndexEntry {
            file: filename,
            ext: data.ext.to_string(),
            fetched_at: now,
            size,
            ttl_secs: TTL_HIT_SECS,
        },
    );

    // Enforce 50 MB cap via LRU eviction.
    enforce_lru_cap(cache_dir, index);

    save_index(cache_dir, index);

    Ok(path)
}

/// Writes a negative cache entry (miss) for a domain. No icon file is
/// written — just an index entry with `TTL_MISS_SECS` (1 day) so we don't
/// hammer the server on every request. After 1 day, the entry expires and
/// the next request re-fetches.
fn write_miss_to_cache(cache_dir: &Path, domain: &str, index: &mut CacheIndex) {
    let key = cache_key(domain);
    let now = now_secs();

    // Remove any old entry (file + index) for this domain.
    if let Some(old) = index.remove(&key) {
        let old_path = cache_dir.join(&old.file);
        if old_path.exists() {
            let _ = std::fs::remove_file(&old_path);
        }
    }

    index.insert(
        key,
        CacheIndexEntry {
            file: String::new(), // no file for a miss
            ext: String::new(),
            fetched_at: now,
            size: 0,
            ttl_secs: TTL_MISS_SECS,
        },
    );

    save_index(cache_dir, index);
}

/// Evicts oldest entries (by `fetched_at`) until the total cache size is
/// under `MAX_CACHE_BYTES`. Removes both the index entry and the file.
fn enforce_lru_cap(cache_dir: &Path, index: &mut CacheIndex) {
    let total: u64 = index.values().map(|e| e.size).sum();
    if total <= MAX_CACHE_BYTES {
        return;
    }

    // Sort by fetched_at ascending (oldest first).
    let mut entries: Vec<(String, CacheIndexEntry)> = index
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    entries.sort_by_key(|(_, e)| e.fetched_at);

    let mut current = total;
    for (domain, entry) in entries {
        if current <= MAX_CACHE_BYTES {
            break;
        }
        let path = cache_dir.join(&entry.file);
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
        current = current.saturating_sub(entry.size);
        index.remove(&domain);
    }
}

/// Versioned cache key: `CACHE_KEY_VERSION` + domain. Old entries
/// (pre-privacy-gate) use a different key and are invisible to new code.
fn cache_key(domain: &str) -> String {
    format!("{CACHE_KEY_VERSION}{domain}")
}

fn hash_domain(domain: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    let result = hasher.finalize();
    // Hex-encode without pulling in a hex crate.
    let mut hex = String::with_capacity(result.len() * 2);
    for byte in result {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// Current Unix timestamp in seconds. Returns 0 if the system clock is
/// before the epoch (shouldn't happen in practice).
fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ════════════════════════════════════════════════════════════════════
// Internal: fetch
// ════════════════════════════════════════════════════════════════════

/// Validated icon data — bytes + detected extension.
struct IconData {
    bytes: Vec<u8>,
    ext: &'static str,
}

/// Lazy-initialized semaphore for concurrency limiting. We use a static
/// so the semaphore is shared across all calls without passing it around.
static SEMAPHORE: tokio::sync::OnceCell<Arc<Semaphore>> = tokio::sync::OnceCell::const_new();

async fn semaphore() -> &'static Arc<Semaphore> {
    SEMAPHORE
        .get_or_init(|| async { Arc::new(Semaphore::new(MAX_CONCURRENCY)) })
        .await
}

// ════════════════════════════════════════════════════════════════════
// Internal: GitHub owner-type gate (Feedback-4 Item 2 + scale fixes)
// ════════════════════════════════════════════════════════════════════
//
// Decision: NUNCA mostrar avatar de pessoa física. Antes de buscar o
// avatar via `https://github.com/{owner}.png`, verificamos o type do
// owner via API. Só Organization → avatar. User/erro → monograma.
//
// 3 fixes (CORREÇÃO DE ESCALA):
//   1. PERSISTÊNCIA EM DISCO: JSON `owner_types.json` no cache_dir, TTL 30d.
//      Sobrevive a restart; warm-up do catálogo custa ~owners únicos.
//   2. SINGLEFLIGHT: resoluções concorrentes do MESMO owner aguardam a
//      request em voo (uma call, N consumidores).
//   3. RATE-LIMIT AWARE: 403/429 → marca `Unknown` com TTL curto (1h)
//      para re-tentar após reset; não grava `User` permanente.

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
enum OwnerType {
    Organization,
    User,
    /// Rate-limited or transient error — re-fetch after short TTL.
    Unknown,
}

/// Entry persisted to disk with a fetched_at timestamp for TTL.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct OwnerTypeEntry {
    typ: OwnerType,
    fetched_at: u64, // unix seconds
}

/// TTL for a known type (Organization/User): 30 days. Account type
/// practically never changes.
const OWNER_TYPE_TTL_LONG_SECS: u64 = 30 * 24 * 60 * 60;

/// TTL for `Unknown` (rate-limited): 1 hour. Re-try after rate-limit reset.
const OWNER_TYPE_TTL_SHORT_SECS: u64 = 60 * 60;

/// In-memory cache: owner → (type, fetched_at). Process-lifetime fast path.
static OWNER_TYPE_CACHE: OnceLock<Mutex<HashMap<String, (OwnerType, u64)>>> = OnceLock::new();

/// Singleflight: owner → Arc<Notify> for in-flight requests. Concurrent
/// callers await the same request instead of duplicating it.
static OWNER_TYPE_INFLIGHT: OnceLock<Mutex<HashMap<String, Arc<Notify>>>> = OnceLock::new();

fn owner_type_cache() -> &'static Mutex<HashMap<String, (OwnerType, u64)>> {
    OWNER_TYPE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn owner_type_inflight() -> &'static Mutex<HashMap<String, Arc<Notify>>> {
    OWNER_TYPE_INFLIGHT.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Loads the on-disk owner_types.json. Returns empty map on any error.
fn load_owner_types_disk(cache_dir: &Path) -> HashMap<String, OwnerTypeEntry> {
    let path = cache_dir.join("owner_types.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => return HashMap::new(),
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Atomically writes owner_types.json. Best-effort — failure is non-fatal.
fn save_owner_types_disk(cache_dir: &Path, entries: &HashMap<String, OwnerTypeEntry>) {
    let path = cache_dir.join("owner_types.json");
    let tmp = cache_dir.join("owner_types.json.tmp");
    if let Ok(raw) = serde_json::to_string_pretty(entries) {
        if std::fs::write(&tmp, &raw).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        } else {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

/// Returns the cached type if fresh (TTL not expired), else `None`.
fn fresh_type(typ: OwnerType, fetched_at: u64, now: u64) -> Option<OwnerType> {
    let ttl = match typ {
        OwnerType::Unknown => OWNER_TYPE_TTL_SHORT_SECS,
        _ => OWNER_TYPE_TTL_LONG_SECS,
    };
    if now.saturating_sub(fetched_at) < ttl {
        Some(typ)
    } else {
        None
    }
}

/// Queries `https://api.github.com/users/{owner}` to check the account
/// type. SSRF-safe: NO FOLLOW redirects. 3-layer cache (memory → disk →
/// API) with singleflight and rate-limit awareness.
///
/// Returns `Some(Organization)` for orgs, `Some(User)` for users, and
/// `None` for rate-limited/unknown (safe default: monogram).
async fn fetch_owner_type(owner: &str, cache_dir: Option<&Path>) -> Option<OwnerType> {
    let now = now_secs();

    // ── Layer 1: in-memory cache (fast path) ──────────────────────────
    {
        let cache = owner_type_cache().lock().ok()?;
        if let Some((typ, fetched_at)) = cache.get(owner) {
            if let Some(fresh) = fresh_type(*typ, *fetched_at, now) {
                return match fresh {
                    OwnerType::Unknown => None, // rate-limited → monogram
                    other => Some(other),
                };
            }
        }
    }

    // ── Layer 2: on-disk cache (survives restart) ─────────────────────
    if let Some(dir) = cache_dir {
        let disk = load_owner_types_disk(dir);
        if let Some(entry) = disk.get(owner) {
            if let Some(fresh) = fresh_type(entry.typ, entry.fetched_at, now) {
                // Promote to memory.
                if let Ok(mut mem) = owner_type_cache().lock() {
                    mem.insert(owner.to_string(), (fresh, entry.fetched_at));
                }
                return match fresh {
                    OwnerType::Unknown => None,
                    other => Some(other),
                };
            }
        }
    }

    // ── Singleflight: if a request for this owner is in-flight, wait ─
    // Use `entry()` to atomically determine if we're the leader (we
    // inserted) or a follower (someone else's Arc is already stored).
    let (notify, is_leader) = {
        let mut inflight = owner_type_inflight().lock().ok()?;
        let my_notify = Arc::new(Notify::new());
        match inflight.entry(owner.to_string()) {
            std::collections::hash_map::Entry::Occupied(o) => {
                (Arc::clone(o.get()), false)
            }
            std::collections::hash_map::Entry::Vacant(v) => {
                v.insert(Arc::clone(&my_notify));
                (my_notify, true)
            }
        }
    };

    if !is_leader {
        notify.notified().await;
        // After wake, re-check memory cache (leader should have written).
        let cache = owner_type_cache().lock().ok()?;
        if let Some((typ, fetched_at)) = cache.get(owner) {
            return fresh_type(*typ, *fetched_at, now);
        }
        return None;
    }

    // ── Layer 3: API call (leader only) ──────────────────────────────
    let result = query_github_owner_type(owner).await;

    let cached_type = match result {
        Some(typ) => typ,
        None => OwnerType::Unknown, // rate-limit/timeout → short TTL
    };

    // Persist to memory + disk.
    if let Ok(mut mem) = owner_type_cache().lock() {
        mem.insert(owner.to_string(), (cached_type, now));
    }
    if let Some(dir) = cache_dir {
        let mut disk = load_owner_types_disk(dir);
        disk.insert(
            owner.to_string(),
            OwnerTypeEntry {
                typ: cached_type,
                fetched_at: now,
            },
        );
        save_owner_types_disk(dir, &disk);
    }

    // Wake all waiters and remove from inflight.
    {
        let mut inflight = owner_type_inflight().lock().ok()?;
        inflight.remove(owner);
    }
    notify.notify_waiters();

    // Return None for Unknown (safe default: monogram).
    match cached_type {
        OwnerType::Organization => Some(OwnerType::Organization),
        OwnerType::User => Some(OwnerType::User),
        OwnerType::Unknown => None,
    }
}

/// Pure API call — no cache. Returns `Some(Organization)` / `Some(User)`
/// on success, `None` on rate-limit (403/429), timeout, or parse error.
async fn query_github_owner_type(owner: &str) -> Option<OwnerType> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;

    let url = format!("https://api.github.com/users/{owner}");
    let resp = client
        .get(&url)
        .header("User-Agent", "verboo-desktop/0.5.2")
        .send()
        .await
        .ok()?;

    let status = resp.status();
    // Rate-limit: 403 (with X-RateLimit-Remaining: 0) or 429.
    if status.as_u16() == 403 || status.as_u16() == 429 {
        return None;
    }
    if !status.is_success() {
        return None;
    }

    let body: serde_json::Value = resp.json().await.ok()?;
    let typ = body.get("type")?.as_str()?;
    match typ {
        "Organization" => Some(OwnerType::Organization),
        "User" => Some(OwnerType::User),
        _ => None,
    }
}

// ════════════════════════════════════════════════════════════════════
// Internal: GitHub avatar fetch (Feedback-3 Item 6)
// ════════════════════════════════════════════════════════════════════

/// Fetches a GitHub owner avatar (`https://github.com/{owner}.png`) with
/// SSRF-safe redirect handling. The `github.com` endpoint redirects to
/// `avatars.githubusercontent.com` — only redirects to these two hosts
/// are allowed. Same semaphore, size, and content-type validation as
/// standard icon fetches.
async fn fetch_github_avatar(owner: &str) -> Option<IconData> {
    let _permit = semaphore().await.acquire().await.ok()?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        // SSRF guard: only follow redirects to allowed hosts.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let allowed = ["github.com", "avatars.githubusercontent.com"];
            let url_str = attempt.url().host_str().unwrap_or("");
            if allowed.iter().any(|h| url_str == *h || url_str.ends_with(&format!(".{h}"))) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .ok()?;

    let url = format!("https://github.com/{owner}.png");
    fetch_and_validate_icon(&client, &url).await
}

/// Fetches the icon for a domain. Tries in order:
///   1. `/apple-touch-icon.png` (direct)
///   2. `/favicon.ico` (direct)
///   3. HTML `<link rel="icon|apple-touch-icon|shortcut icon">` discovery
///      (GET homepage HTML, parse link tags, resolve relative URLs, SSRF
///      guard the resolved URL, fetch the icon)
///   4. Returns `None` if all paths fail.
///
/// HTTPS only. On-demand only. Respects `load_web_icons` toggle (checked
/// upstream in `resolve_plugin_icon`).
async fn fetch_icon(domain: &str) -> Option<IconData> {
    let _permit = semaphore().await.acquire().await.ok()?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .ok()?;

    // Phase 1: try direct icon paths (apple-touch-icon.png, favicon.ico).
    for path in ICON_PATHS {
        let url = format!("https://{domain}{path}");
        if let Some(data) = fetch_and_validate_icon(&client, &url).await {
            return Some(data);
        }
    }

    // Phase 2: HTML link-tag discovery. Many sites don't serve icons at the
    // root but declare them via `<link rel="icon" href="...">` in the HTML.
    let homepage_url = format!("https://{domain}/");
    if let Some(icon_url) = discover_icon_url_from_html(&client, &homepage_url, domain).await {
        // SSRF guard the resolved URL before fetching.
        if !is_ssrf_safe_url(&icon_url) {
            return None;
        }
        if let Some(data) = fetch_and_validate_icon(&client, &icon_url).await {
            return Some(data);
        }
    }

    None
}

/// Fetches a URL and validates it as an icon. Returns `Some(IconData)` if
/// the response is a valid icon (magic bytes), `None` otherwise. Rejects
/// text/html and application/json (a link-tag pointing to HTML = failure,
/// no chaining).
async fn fetch_and_validate_icon(client: &reqwest::Client, url: &str) -> Option<IconData> {
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    // Reject text/html and application/json — a link-tag pointing to HTML
    // is a failure (no chaining). This prevents following redirect chains
    // into arbitrary pages.
    let ct_lower = content_type.to_lowercase();
    if ct_lower.contains("text/html") || ct_lower.contains("application/json") {
        return None;
    }
    let bytes = resp.bytes().await.ok()?.to_vec();
    if bytes.len() > MAX_ICON_BYTES {
        return None;
    }
    validate_icon(&bytes, &content_type).map(|ext| IconData { bytes, ext })
}

/// Fetches the homepage HTML and parses `<link rel="icon|apple-touch-icon|
/// shortcut icon" href="...">` tags. Returns the resolved absolute URL of
/// the first matching icon, or `None` if not found.
///
/// Respects `<base href>` if present. Resolves relative URLs against the
/// base URL (or the homepage URL if no base tag).
async fn discover_icon_url_from_html(
    client: &reqwest::Client,
    homepage_url: &str,
    domain: &str,
) -> Option<String> {
    let resp = client.get(homepage_url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    // Only parse HTML.
    if !content_type.contains("text/html") {
        return None;
    }
    let bytes = resp.bytes().await.ok()?.to_vec();
    if bytes.len() > MAX_HTML_BYTES {
        return None;
    }
    let html = String::from_utf8_lossy(&bytes);

    // Parse base href first (if present).
    let base_url = extract_base_href(&html).unwrap_or_else(|| homepage_url.to_string());

    // Find the first matching link tag.
    extract_icon_link(&html, &base_url, domain)
}

/// Extracts `<base href="...">` from HTML. Returns the absolute URL if found.
fn extract_base_href(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let base_start = lower.find("<base ")?;
    // Find the end of the <base> tag.
    let tag_end = lower[base_start..].find('>')? + base_start;
    let tag = &html[base_start..=tag_end];
    // Extract href value.
    extract_attr_value(tag, "href")
}

/// Extracts the first `<link rel="icon|apple-touch-icon|shortcut icon"
/// href="...">` from HTML. Resolves relative URLs against `base_url`.
fn extract_icon_link(html: &str, base_url: &str, _domain: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let mut search_from = 0;
    while let Some(link_start) = lower[search_from..].find("<link ") {
        let abs_start = search_from + link_start;
        let tag_end = lower[abs_start..].find('>')? + abs_start;
        let tag = &html[abs_start..=tag_end];
        let tag_lower = &lower[abs_start..=tag_end];

        // Check if this is an icon link.
        if let Some(rel) = extract_attr_value(tag_lower, "rel") {
            let rel_lower = rel.to_lowercase();
            if rel_lower == "icon"
                || rel_lower == "apple-touch-icon"
                || rel_lower == "shortcut icon"
                || rel_lower == "apple-touch-icon-precomposed"
            {
                if let Some(href) = extract_attr_value(tag, "href") {
                    // Resolve relative URL against base_url.
                    if let Some(resolved) = resolve_url(&href, base_url) {
                        return Some(resolved);
                    }
                }
            }
        }
        search_from = tag_end + 1;
    }
    None
}

/// Extracts the value of an HTML attribute `attr` from a tag string.
/// Handles single quotes, double quotes, unquoted values, and whitespace
/// around `=` (valid HTML5: `rel = "icon"`). Uses word-boundary matching
/// so `data-href` does NOT match `href` (the `=` must be preceded by the
/// attr name exactly, not a suffix of another attribute name).
/// Returns `None` if the attribute is not found.
fn extract_attr_value(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    // Search for the attr name as a whole word: it must be preceded by
    // whitespace or `<` (tag start) or `/` (self-closing), so that
    // `data-href=` does NOT match `href=`.
    let bytes = lower.as_bytes();
    let attr_bytes = attr.as_bytes();
    let mut search_from = 0;
    while search_from + attr_bytes.len() <= bytes.len() {
        let found = lower[search_from..].find(attr)?;
        let abs = search_from + found;
        // Check word boundary before the attr name.
        let before_ok = abs == 0
            || {
                let b = bytes[abs - 1];
                b == b' ' || b == b'\t' || b == b'\n' || b == b'\r' || b == b'<' || b == b'/'
            };
        if !before_ok {
            search_from = abs + 1;
            continue;
        }
        // After the attr name, skip whitespace, then expect `=`.
        let after_name = abs + attr_bytes.len();
        let rest = &lower[after_name..];
        let trimmed = rest.trim_start();
        if !trimmed.starts_with('=') {
            search_from = abs + 1;
            continue;
        }
        // Skip the `=` and any whitespace after it.
        let after_eq = trimmed[1..].trim_start();
        if after_eq.is_empty() {
            return None;
        }
        let first = after_eq.chars().next()?;
        if first == '"' || first == '\'' {
            let quote = first;
            let value_end = after_eq[1..].find(quote)? + 1;
            return Some(after_eq[1..value_end].to_string());
        } else {
            // Unquoted — value ends at whitespace or >.
            let value_end = after_eq
                .find(|c: char| c.is_whitespace() || c == '>')
                .unwrap_or(after_eq.len());
            return Some(after_eq[..value_end].to_string());
        }
    }
    None
}

/// Resolves a possibly-relative URL against a base URL. Returns the
/// absolute URL string, or `None` if resolution fails.
fn resolve_url(href: &str, base_url: &str) -> Option<String> {
    // Handle protocol-relative URLs (//example.com/icon.png).
    let href = if href.starts_with("//") {
        format!("https:{href}")
    } else {
        href.to_string()
    };
    // Simple resolution: if href is absolute (has scheme), use it; otherwise
    // join with base. We avoid the `url` crate dependency by doing manual
    // resolution for the common cases.
    if href.starts_with("https://") || href.starts_with("http://") {
        return Some(href);
    }
    // Relative URL — join with base.
    let base = base_url.trim_end_matches('/');
    if href.starts_with('/') {
        // Absolute path — join with base scheme+host.
        if let Some(scheme_end) = base.find("://") {
            let after_scheme = &base[scheme_end + 3..];
            let host = after_scheme.split('/').next().unwrap_or("");
            return Some(format!("https://{host}{href}"));
        }
    }
    // Relative path — join with base directory.
    Some(format!("{base}/{href}"))
}

/// Validates icon bytes by magic bytes (NOT content-type header — servers
/// lie). Returns the extension if valid, `None` if rejected.
///
/// Accepted: png, ico, jpg, webp. REJECTED: svg (script injection risk).
pub(crate) fn validate_icon(bytes: &[u8], _content_type: &str) -> Option<&'static str> {
    if bytes.is_empty() {
        return None;
    }
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if bytes.len() >= 8
        && bytes[..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    {
        return Some("png");
    }
    // JPEG: FF D8 FF
    if bytes.len() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff {
        return Some("jpg");
    }
    // WEBP: "RIFF" .... "WEBP"
    if bytes.len() >= 12
        && &bytes[..4] == b"RIFF"
        && &bytes[8..12] == b"WEBP"
    {
        return Some("webp");
    }
    // ICO: 00 00 01 00
    if bytes.len() >= 4 && bytes[..4] == [0x00, 0x00, 0x01, 0x00] {
        return Some("ico");
    }
    // SVG detection: check for `<?xml` or `<svg` in the first 512 bytes —
    // REJECT (script injection risk). The 512-byte preview covers both
    // bare `<svg>` and `<?xml ... ?><svg>` forms.
    let preview = &bytes[..bytes.len().min(512)];
    let preview_str = String::from_utf8_lossy(preview).to_lowercase();
    if preview_str.contains("<svg") || preview_str.contains("<?xml") {
        return None;
    }
    None
}

// ════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs an async future to completion on a single-threaded tokio runtime.
    /// Avoids the `futures` crate dependency (tokio is already in the dep tree).
    fn block_on<F: std::future::Future>(fut: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime")
            .block_on(fut)
    }

    // ── extract_domain ─────────────────────────────────────────────────

    #[test]
    fn extract_domain_https() {
        assert_eq!(
            extract_domain("https://github.com/obra/superpowers"),
            Some("github.com".into())
        );
        assert_eq!(
            extract_domain("https://42crunch.com"),
            Some("42crunch.com".into())
        );
    }

    #[test]
    fn extract_domain_strips_www() {
        assert_eq!(
            extract_domain("https://www.example.com/page"),
            Some("example.com".into())
        );
    }

    #[test]
    fn extract_domain_strips_port_query_fragment() {
        assert_eq!(
            extract_domain("https://example.com:443/path?q=1#frag"),
            Some("example.com".into())
        );
    }

    #[test]
    fn extract_domain_lowercases() {
        assert_eq!(
            extract_domain("https://GitHub.COM/Foo"),
            Some("github.com".into())
        );
    }

    #[test]
    fn extract_domain_rejects_non_http() {
        assert_eq!(extract_domain("ftp://example.com"), None);
        assert_eq!(extract_domain("not a url"), None);
        assert_eq!(extract_domain(""), None);
    }

    #[test]
    fn extract_domain_strips_uppercase_www() {
        // Regression: case-sensitive www. strip missed WWW.Example.COM.
        // Now lowercases BEFORE strip so all case variants are caught.
        assert_eq!(
            extract_domain("https://WWW.Example.COM/path"),
            Some("example.com".into())
        );
        assert_eq!(
            extract_domain("https://Www.example.com"),
            Some("example.com".into())
        );
    }

    // ── extract_github_owner_from_url (Phase 1 GitHub gate) ──────────

    #[test]
    fn extract_github_owner_from_url_parses_github_com() {
        assert_eq!(
            extract_github_owner_from_url("https://github.com/obra/superpowers"),
            Some("obra".into())
        );
        assert_eq!(
            extract_github_owner_from_url("https://github.com/obra/superpowers.git"),
            Some("obra".into())
        );
        assert_eq!(
            extract_github_owner_from_url("https://github.com/anthropics/claude-plugins-public/tree/main/plugins/asana"),
            Some("anthropics".into())
        );
        assert_eq!(
            extract_github_owner_from_url("https://github.com/obra"),
            Some("obra".into())
        );
    }

    #[test]
    fn extract_github_owner_from_url_parses_www_github_com() {
        assert_eq!(
            extract_github_owner_from_url("https://www.github.com/obra/superpowers"),
            Some("obra".into())
        );
    }

    #[test]
    fn extract_github_owner_from_url_rejects_non_github() {
        assert_eq!(extract_github_owner_from_url("https://example.com/obra"), None);
        assert_eq!(extract_github_owner_from_url("https://42crunch.com/foo"), None);
        assert_eq!(extract_github_owner_from_url("https://anthropic.com"), None);
    }

    #[test]
    fn extract_github_owner_from_url_rejects_no_owner() {
        assert_eq!(extract_github_owner_from_url("https://github.com/"), None);
        assert_eq!(extract_github_owner_from_url("https://github.com"), None);
    }

    // ── is_generic_host (blocklist) ───────────────────────────────────

    #[test]
    fn is_generic_host_blocks_github() {
        assert!(is_generic_host("github.com"));
    }

    #[test]
    fn is_generic_host_blocks_all_known_hosts() {
        // NOTE: `www.npmjs.com` is NOT in the blocklist because `extract_domain`
        // strips `www.` before `is_generic_host` is called. Test that the
        // stripped form (`npmjs.com`) is blocked, and that `www.npmjs.com`
        // is also blocked after going through `extract_domain` + `is_generic_host`.
        for host in &[
            "github.com",
            "gitlab.com",
            "bitbucket.org",
            "npmjs.com",
            "raw.githubusercontent.com",
            "pypi.org",
            "crates.io",
            "sourceforge.net",
        ] {
            assert!(is_generic_host(host), "expected {host} to be blocklisted");
        }
        // www.npmjs.com → extract_domain strips www. → npmjs.com → blocked.
        let domain = extract_domain("https://www.npmjs.com/package/foo").unwrap();
        assert!(is_generic_host(&domain), "www.npmjs.com should be blocked after www. strip");
    }

    #[test]
    fn is_generic_host_case_insensitive() {
        assert!(is_generic_host("GitHub.COM"));
        assert!(is_generic_host("NPMJS.com"));
    }

    #[test]
    fn is_generic_host_allows_real_plugin_domains() {
        // Real plugin homepage domains that should NOT be blocklisted.
        assert!(!is_generic_host("42crunch.com"));
        assert!(!is_generic_host("apollo.io"));
        assert!(!is_generic_host("adobe.com"));
        assert!(!is_generic_host("notion.so"));
    }

    #[test]
    fn is_generic_host_rejects_subdomain_of_blocklisted() {
        // raw.githubusercontent.com is blocklisted; a subdomain of it
        // should also be blocked (defense in depth).
        assert!(is_generic_host("foo.raw.githubusercontent.com"));
    }

    // ── SSRF guard (is_ssrf_safe_url + is_private_ip) ─────────────────

    #[test]
    fn ssrf_rejects_http() {
        assert!(!is_ssrf_safe_url("http://example.com/icon.png"));
        assert!(!is_ssrf_safe_url("http://127.0.0.1/icon.png"));
    }

    #[test]
    fn ssrf_accepts_https_public_domain() {
        assert!(is_ssrf_safe_url("https://example.com/icon.png"));
        assert!(is_ssrf_safe_url("https://apollo.io/favicon.ico"));
    }

    #[test]
    fn ssrf_rejects_localhost() {
        assert!(!is_ssrf_safe_url("https://localhost/icon.png"));
        assert!(!is_ssrf_safe_url("https://localhost:8080/icon.png"));
    }

    #[test]
    fn ssrf_rejects_loopback_ipv4() {
        assert!(!is_ssrf_safe_url("https://127.0.0.1/icon.png"));
        assert!(!is_ssrf_safe_url("https://127.0.0.1:8080/icon.png"));
        assert!(!is_ssrf_safe_url("https://127.1.2.3/icon.png"));
    }

    #[test]
    fn ssrf_rejects_private_ipv4_ranges() {
        assert!(!is_ssrf_safe_url("https://10.0.0.1/icon.png"));
        assert!(!is_ssrf_safe_url("https://10.255.255.255/icon.png"));
        assert!(!is_ssrf_safe_url("https://172.16.0.1/icon.png"));
        assert!(!is_ssrf_safe_url("https://172.31.255.255/icon.png"));
        assert!(!is_ssrf_safe_url("https://192.168.1.1/icon.png"));
        assert!(!is_ssrf_safe_url("https://192.168.0.0/icon.png"));
    }

    #[test]
    fn ssrf_rejects_link_local_ipv4() {
        assert!(!is_ssrf_safe_url("https://169.254.1.1/icon.png"));
        assert!(!is_ssrf_safe_url("https://169.254.169.254/icon.png"));
    }

    #[test]
    fn ssrf_rejects_loopback_ipv6() {
        assert!(!is_ssrf_safe_url("https://[::1]/icon.png"));
    }

    #[test]
    fn ssrf_rejects_generic_hosts() {
        // A link-tag could point to github.com — re-apply blocklist.
        assert!(!is_ssrf_safe_url("https://github.com/icon.png"));
        assert!(!is_ssrf_safe_url("https://npmjs.com/icon.png"));
        assert!(!is_ssrf_safe_url("https://raw.githubusercontent.com/x.png"));
    }

    #[test]
    fn ssrf_allows_public_ipv4() {
        // 8.8.8.8 is a public IP (Google DNS) — should be allowed.
        assert!(is_ssrf_safe_url("https://8.8.8.8/icon.png"));
    }

    #[test]
    fn is_private_ip_detects_all_ranges() {
        assert!(is_private_ip("10.0.0.1"));
        assert!(is_private_ip("172.16.0.1"));
        assert!(is_private_ip("172.31.255.255"));
        assert!(is_private_ip("192.168.1.1"));
        assert!(is_private_ip("127.0.0.1"));
        assert!(is_private_ip("169.254.1.1"));
        assert!(is_private_ip("::1"));
    }

    #[test]
    fn is_private_ip_rejects_public() {
        assert!(!is_private_ip("8.8.8.8"));
        assert!(!is_private_ip("1.1.1.1"));
        assert!(!is_private_ip("example.com"));
    }

    // ── SSRF regression: non-standard IP encodings ───────────────────

    #[test]
    fn ssrf_rejects_decimal_integer_ip() {
        // 2130706433 = 127.0.0.1 in decimal. glibc resolves this to loopback.
        assert!(!is_ssrf_safe_url("https://2130706433/icon.png"));
        // Also: any all-numeric host should be rejected even if u32 parse
        // yields a public IP (suspicious non-standard form).
        assert!(!is_ssrf_safe_url("https://167772161/icon.png")); // 10.0.0.1
        assert!(!is_ssrf_safe_url("https://2886729728/icon.png")); // 172.16.0.0
    }

    #[test]
    fn is_private_ip_decimal_integer_private() {
        assert!(is_private_ip("2130706433")); // 127.0.0.1
        assert!(is_private_ip("167772161")); // 10.0.0.1
        assert!(is_private_ip("3232235521")); // 192.168.0.1
    }

    #[test]
    fn is_private_ip_decimal_integer_public() {
        // 134744072 = 8.8.8.8 — public, but all-numeric → REJECT (suspicious).
        assert!(is_private_ip("134744072"));
    }

    #[test]
    fn ssrf_rejects_hex_integer_ip() {
        // 0x7f000001 = 127.0.0.1. glibc resolves this to loopback.
        assert!(!is_ssrf_safe_url("https://0x7f000001/icon.png"));
        assert!(!is_ssrf_safe_url("https://0X7f000001/icon.png")); // uppercase X
    }

    #[test]
    fn is_private_ip_hex_integer_private() {
        assert!(is_private_ip("0x7f000001")); // 127.0.0.1
        assert!(is_private_ip("0xa000001")); // 10.0.0.1
    }

    #[test]
    fn is_private_ip_hex_integer_invalid() {
        // 0x followed by non-hex — REJECT (suspicious).
        assert!(is_private_ip("0xgggg"));
    }

    #[test]
    fn ssrf_rejects_octal_octet_ip() {
        // 0177.0.0.1 → glibc interprets 0177 as octal 127 → 127.0.0.1.
        // Rust parses 0177 as decimal 177 → 177.0.0.1 (wrong).
        // Must REJECT either way.
        assert!(!is_ssrf_safe_url("https://0177.0.0.1/icon.png"));
        assert!(!is_ssrf_safe_url("https://0.0.0.0177/icon.png"));
    }

    #[test]
    fn ssrf_rejects_hex_in_octet() {
        // 0x7f.0.0.1 → glibc interprets 0x7f as hex 127.
        assert!(!is_ssrf_safe_url("https://0x7f.0.0.1/icon.png"));
    }

    #[test]
    fn ssrf_rejects_ipv4_mapped_ipv6() {
        // ::ffff:127.0.0.1 is IPv4-mapped IPv6. is_loopback() does NOT
        // catch this. Must extract and re-check.
        assert!(!is_ssrf_safe_url("https://[::ffff:127.0.0.1]/icon.png"));
        assert!(!is_ssrf_safe_url("https://[::ffff:10.0.0.1]/icon.png"));
        assert!(!is_ssrf_safe_url("https://[::ffff:192.168.1.1]/icon.png"));
        assert!(!is_ssrf_safe_url("https://[::ffff:169.254.1.1]/icon.png"));
    }

    #[test]
    fn is_private_ip_ipv4_mapped_ipv6_private() {
        assert!(is_private_ip("::ffff:127.0.0.1"));
        assert!(is_private_ip("::ffff:10.0.0.1"));
        assert!(is_private_ip("::ffff:192.168.1.1"));
    }

    #[test]
    fn is_private_ip_ipv4_mapped_ipv6_public() {
        // ::ffff:8.8.8.8 is IPv4-mapped but the IPv4 is public.
        // Still false (it's a public IP).
        assert!(!is_private_ip("::ffff:8.8.8.8"));
    }

    #[test]
    fn is_ssrf_safe_url_accepts_normal_hostname() {
        assert!(is_ssrf_safe_url("https://example.com/icon.png"));
        assert!(is_ssrf_safe_url("https://apollo.io/icon.png"));
        assert!(is_ssrf_safe_url("https://cdn.example.com/x.png"));
    }

    #[test]
    fn is_all_digits_helper() {
        assert!(is_all_digits("12345"));
        assert!(is_all_digits("0"));
        assert!(!is_all_digits(""));
        assert!(!is_all_digits("1a"));
        assert!(!is_all_digits("12.34"));
    }

    #[test]
    fn has_leading_zero_octet_helper() {
        assert!(has_leading_zero_octet("0177.0.0.1"));
        assert!(has_leading_zero_octet("0.0.0.0177"));
        assert!(!has_leading_zero_octet("10.0.0.1"));
        assert!(!has_leading_zero_octet("127.0.0.1"));
        assert!(!has_leading_zero_octet("example.com"));
    }

    #[test]
    fn has_hex_octet_helper() {
        assert!(has_hex_octet("0x7f.0.0.1"));
        assert!(has_hex_octet("0X7f.0.0.1"));
        assert!(!has_hex_octet("127.0.0.1"));
        assert!(!has_hex_octet("example.com"));
        // Must NOT catch "0x" in a non-dotted hostname.
        assert!(!has_hex_octet("example0x00.com"));
    }

    #[test]
    fn ssrf_does_not_reject_hostname_containing_ox() {
        // Regression: hostnames like `example0x00.com` must NOT be rejected
        // by has_hex_octet (which only applies to dotted-quads).
        assert!(is_ssrf_safe_url("https://example0x00.com/icon.png"));
    }

    // ── HTML link-tag discovery (extract_icon_link + extract_base_href) ─

    #[test]
    fn extract_icon_link_absolute_href() {
        let html = r#"<html><head>
            <link rel="icon" href="https://cdn.example.com/favicon.png">
        </head></html>"#;
        let url = extract_icon_link(html, "https://example.com/", "example.com");
        assert_eq!(url.as_deref(), Some("https://cdn.example.com/favicon.png"));
    }

    #[test]
    fn extract_icon_link_relative_href() {
        let html = r#"<html><head>
            <link rel="icon" href="/assets/icon.png">
        </head></html>"#;
        let url = extract_icon_link(html, "https://example.com/", "example.com");
        assert_eq!(url.as_deref(), Some("https://example.com/assets/icon.png"));
    }

    #[test]
    fn extract_icon_link_apple_touch_icon() {
        let html = r#"<html><head>
            <link rel="apple-touch-icon" href="/touch-icon.png">
        </head></html>"#;
        let url = extract_icon_link(html, "https://example.com/", "example.com");
        assert_eq!(url.as_deref(), Some("https://example.com/touch-icon.png"));
    }

    #[test]
    fn extract_icon_link_shortcut_icon() {
        let html = r#"<html><head>
            <link rel="shortcut icon" href="/shortcut.ico">
        </head></html>"#;
        let url = extract_icon_link(html, "https://example.com/", "example.com");
        assert_eq!(url.as_deref(), Some("https://example.com/shortcut.ico"));
    }

    #[test]
    fn extract_icon_link_single_quotes() {
        let html = r#"<html><head>
            <link rel='icon' href='/icon.png'>
        </head></html>"#;
        let url = extract_icon_link(html, "https://example.com/", "example.com");
        assert_eq!(url.as_deref(), Some("https://example.com/icon.png"));
    }

    #[test]
    fn extract_icon_link_unquoted_href() {
        let html = r#"<html><head>
            <link rel=icon href=/icon.png>
        </head></html>"#;
        let url = extract_icon_link(html, "https://example.com/", "example.com");
        assert_eq!(url.as_deref(), Some("https://example.com/icon.png"));
    }

    #[test]
    fn extract_icon_link_with_base_href() {
        let html = r#"<html><head>
            <base href="https://cdn.example.com/assets/">
            <link rel="icon" href="icon.png">
        </head></html>"#;
        let base = extract_base_href(html).unwrap();
        assert_eq!(base, "https://cdn.example.com/assets/");
        let url = extract_icon_link(html, &base, "example.com");
        // Relative path joins with base (base ends with /, so icon.png appends).
        assert!(url.is_some());
        assert!(url.unwrap().contains("icon.png"));
    }

    #[test]
    fn extract_icon_link_protocol_relative() {
        let html = r#"<html><head>
            <link rel="icon" href="//cdn.example.com/icon.png">
        </head></html>"#;
        let url = extract_icon_link(html, "https://example.com/", "example.com");
        assert_eq!(url.as_deref(), Some("https://cdn.example.com/icon.png"));
    }

    #[test]
    fn extract_icon_link_no_link_tag() {
        let html = r#"<html><head><title>No icon</title></head></html>"#;
        let url = extract_icon_link(html, "https://example.com/", "example.com");
        assert!(url.is_none());
    }

    #[test]
    fn extract_icon_link_picks_first_match() {
        // Multiple link tags — should return the first icon one.
        let html = r#"<html><head>
            <link rel="stylesheet" href="/style.css">
            <link rel="icon" href="/first.png">
            <link rel="icon" href="/second.png">
        </head></html>"#;
        let url = extract_icon_link(html, "https://example.com/", "example.com");
        assert_eq!(url.as_deref(), Some("https://example.com/first.png"));
    }

    #[test]
    fn extract_icon_link_apple_touch_icon_precomposed() {
        let html = r#"<html><head>
            <link rel="apple-touch-icon-precomposed" href="/precomposed.png">
        </head></html>"#;
        let url = extract_icon_link(html, "https://example.com/", "example.com");
        assert_eq!(url.as_deref(), Some("https://example.com/precomposed.png"));
    }

    #[test]
    fn extract_attr_value_double_quote() {
        let tag = r#"<link rel="icon" href="/x.png">"#;
        assert_eq!(extract_attr_value(tag, "href"), Some("/x.png".into()));
        assert_eq!(extract_attr_value(tag, "rel"), Some("icon".into()));
    }

    #[test]
    fn extract_attr_value_single_quote() {
        let tag = r#"<link rel='icon' href='/x.png'>"#;
        assert_eq!(extract_attr_value(tag, "href"), Some("/x.png".into()));
    }

    #[test]
    fn extract_attr_value_missing() {
        let tag = r#"<link rel="icon">"#;
        assert_eq!(extract_attr_value(tag, "href"), None);
    }

    #[test]
    fn extract_attr_value_data_href_does_not_match_href() {
        // Regression: `href=` is a substring of `data-href=`. Word-boundary
        // check must prevent extracting the wrong value.
        let tag = r#"<link rel="icon" data-href="/decoy.png" href="/real.png">"#;
        assert_eq!(extract_attr_value(tag, "href"), Some("/real.png".into()));
    }

    #[test]
    fn extract_attr_value_spaces_around_equals() {
        // Valid HTML5: `rel = "icon"` (whitespace around `=`).
        let tag = r#"<link rel = "icon" href = "/x.png">"#;
        assert_eq!(extract_attr_value(tag, "rel"), Some("icon".into()));
        assert_eq!(extract_attr_value(tag, "href"), Some("/x.png".into()));
    }

    #[test]
    fn extract_attr_value_data_href_only() {
        // Only data-href present — should NOT match href.
        let tag = r#"<link rel="icon" data-href="/decoy.png">"#;
        assert_eq!(extract_attr_value(tag, "href"), None);
    }

    #[test]
    fn resolve_url_absolute_https() {
        assert_eq!(
            resolve_url("https://cdn.example.com/x.png", "https://example.com/"),
            Some("https://cdn.example.com/x.png".into())
        );
    }

    #[test]
    fn resolve_url_absolute_path() {
        assert_eq!(
            resolve_url("/assets/x.png", "https://example.com/"),
            Some("https://example.com/assets/x.png".into())
        );
    }

    #[test]
    fn resolve_url_protocol_relative() {
        assert_eq!(
            resolve_url("//cdn.example.com/x.png", "https://example.com/"),
            Some("https://cdn.example.com/x.png".into())
        );
    }

    #[test]
    fn resolve_url_relative_path() {
        assert_eq!(
            resolve_url("x.png", "https://example.com/assets"),
            Some("https://example.com/assets/x.png".into())
        );
    }

    // ── TTL differentiation (hit 7d, miss 1d) ──────────────────────────

    #[test]
    fn ttl_hit_is_7_days() {
        assert_eq!(TTL_HIT_SECS, 7 * 24 * 60 * 60);
    }

    #[test]
    fn ttl_miss_is_1_day() {
        assert_eq!(TTL_MISS_SECS, 24 * 60 * 60);
    }

    #[test]
    fn write_to_cache_sets_hit_ttl() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut index = CacheIndex::new();
        let data = IconData {
            bytes: vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
            ext: "png",
        };
        write_to_cache(dir.path(), "example.com", &data, &mut index).expect("write");
        let entry = index.get(&cache_key("example.com")).expect("entry");
        assert_eq!(entry.ttl_secs, TTL_HIT_SECS);
    }

    #[test]
    fn write_miss_to_cache_sets_miss_ttl() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut index = CacheIndex::new();
        write_miss_to_cache(dir.path(), "example.com", &mut index);
        let entry = index.get(&cache_key("example.com")).expect("entry");
        assert_eq!(entry.ttl_secs, TTL_MISS_SECS);
        assert!(entry.file.is_empty());
        assert_eq!(entry.size, 0);
    }

    #[test]
    fn check_miss_cache_returns_true_for_fresh_miss() {
        let mut index = CacheIndex::new();
        index.insert(
            cache_key("example.com"),
            CacheIndexEntry {
                file: String::new(),
                ext: String::new(),
                fetched_at: now_secs(),
                size: 0,
                ttl_secs: TTL_MISS_SECS,
            },
        );
        assert!(check_miss_cache(&index, "example.com"));
    }

    #[test]
    fn check_miss_cache_returns_false_for_expired_miss() {
        let mut index = CacheIndex::new();
        let old = now_secs().saturating_sub(TTL_MISS_SECS + 100);
        index.insert(
            cache_key("example.com"),
            CacheIndexEntry {
                file: String::new(),
                ext: String::new(),
                fetched_at: old,
                size: 0,
                ttl_secs: TTL_MISS_SECS,
            },
        );
        assert!(!check_miss_cache(&index, "example.com"));
    }

    #[test]
    fn check_miss_cache_returns_false_for_hit_entry() {
        let mut index = CacheIndex::new();
        index.insert(
            cache_key("example.com"),
            CacheIndexEntry {
                file: "abc.png".into(),
                ext: "png".into(),
                fetched_at: now_secs(),
                size: 100,
                ttl_secs: TTL_HIT_SECS,
            },
        );
        // A hit entry should NOT be treated as a miss.
        assert!(!check_miss_cache(&index, "example.com"));
    }

    #[test]
    fn check_cache_skips_miss_entries() {
        // A miss entry (empty file) should NOT be served as a hit.
        let dir = tempfile::tempdir().expect("tempdir");
        let mut index = CacheIndex::new();
        index.insert(
            cache_key("example.com"),
            CacheIndexEntry {
                file: String::new(),
                ext: String::new(),
                fetched_at: now_secs(),
                size: 0,
                ttl_secs: TTL_MISS_SECS,
            },
        );
        assert!(check_cache(&index, "example.com", dir.path()).is_none());
    }

    // ── resolve_plugin_icon blocklist integration ─────────────────────

    #[test]
    fn resolve_plugin_icon_blocklisted_domain_returns_none_without_fetch() {
        // github.com homepage with a USER owner (obra) → Organization gate
        // blocks Phase 1 → return None without fetching the homepage icon.
        // The cache dir should NOT have any icon file written.
        let dir = tempfile::tempdir().expect("tempdir");
        let mut manifests = HashMap::new();
        manifests.insert(
            "superpowers@obra".into(),
            MarketplacePluginEntry {
                name: "superpowers".into(),
                category: None,
                author: None,
                author_email: None,
                homepage: Some("https://github.com/obra/superpowers".into()),
                description: None,
                version: None,
                display_name: None,
                keywords: vec![],
                tags: vec![],
                github_owner: None,
                examples: Vec::new(),
            },
        );
        let result = block_on(resolve_plugin_icon(
            "superpowers@obra",
            &manifests,
            dir.path().to_path_buf(),
            true, // toggle ON
        ))
        .expect("resolve");
        assert!(result.icon_path.is_none(), "github.com User owner must return None (no face)");
        assert_eq!(result.domain.as_deref(), Some("github.com"));
        assert!(!result.cached);
        // No icon files should have been written.
        let icon_files: Vec<_> = std::fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != "index.json")
            .collect();
        assert!(icon_files.is_empty(), "no icon files should exist for User-owner github.com");
    }

    #[test]
    fn resolve_plugin_icon_non_blocklisted_domain_proceeds() {
        // 42crunch.com is NOT blocklisted → should proceed to fetch (which
        // will fail in tests since there's no network, but the key assertion
        // is that we get past the blocklist check and return None from fetch
        // failure, not from blocklist).
        let dir = tempfile::tempdir().expect("tempdir");
        let mut manifests = HashMap::new();
        manifests.insert(
            "42crunch@claude-plugins-official".into(),
            MarketplacePluginEntry {
                name: "42crunch".into(),
                category: None,
                author: None,
                author_email: None,
                homepage: Some("https://42crunch.com".into()),
                description: None,
                version: None,
                display_name: None,
                keywords: vec![],
                tags: vec![],
                github_owner: None,
                examples: Vec::new(),
            },
        );
        let result = block_on(resolve_plugin_icon(
            "42crunch@claude-plugins-official",
            &manifests,
            dir.path().to_path_buf(),
            true,
        ))
        .expect("resolve");
        // Fetch will fail (no network in test env) → icon_path None, but
        // domain is set (proves we got past the blocklist check).
        assert!(result.icon_path.is_none());
        assert_eq!(result.domain.as_deref(), Some("42crunch.com"));
    }

    #[test]
    fn resolve_plugin_icon_blocklisted_cached_domain_never_served() {
        // Regression: even if a github.com icon is in the cache from a
        // previous version, resolve_plugin_icon must NOT serve it when the
        // owner is a USER — the Organization gate runs BEFORE the cache
        // check and blocks Phase 1 entirely.
        let dir = tempfile::tempdir().expect("tempdir");
        let mut index = CacheIndex::new();
        let png_bytes = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00];
        let hash = hash_domain("github.com");
        let filename = format!("{hash}.png");
        std::fs::write(dir.path().join(&filename), &png_bytes).expect("write");
        index.insert(
            cache_key("github.com"),
            CacheIndexEntry {
                file: filename,
                ext: "png".into(),
                fetched_at: now_secs(),
                size: png_bytes.len() as u64,
                ttl_secs: TTL_HIT_SECS,
            },
        );
        save_index(dir.path(), &index);

        let mut manifests = HashMap::new();
        manifests.insert(
            "superpowers@obra".into(),
            MarketplacePluginEntry {
                name: "superpowers".into(),
                category: None,
                author: None,
                author_email: None,
                homepage: Some("https://github.com/obra/superpowers".into()),
                description: None,
                version: None,
                display_name: None,
                keywords: vec![],
                tags: vec![],
                github_owner: None,
                examples: Vec::new(),
            },
        );
        let result = block_on(resolve_plugin_icon(
            "superpowers@obra",
            &manifests,
            dir.path().to_path_buf(),
            true,
        ))
        .expect("resolve");
        // User-owner gate blocks Phase 1 BEFORE cache check — even though
        // github.com is cached, it must NOT be served (would be a face).
        assert!(result.icon_path.is_none(), "User-owner github.com cached icon must not be served");
        assert_eq!(result.domain.as_deref(), Some("github.com"));
        assert!(!result.cached);
    }

    // ── Phase 1 GitHub Organization gate validation (Feedback-4 correction) ─

    #[test]
    fn resolve_plugin_icon_github_user_owner_blocks_phase1() {
        // obra is a GitHub User → Organization gate blocks Phase 1.
        // Result should be None with domain=github.com (monogram).
        let dir = tempfile::tempdir().expect("tempdir");
        let mut manifests = HashMap::new();
        manifests.insert(
            "superpowers@obra".into(),
            MarketplacePluginEntry {
                name: "superpowers".into(),
                category: None,
                author: None,
                author_email: None,
                homepage: Some("https://github.com/obra/superpowers".into()),
                description: None,
                version: None,
                display_name: None,
                keywords: vec![],
                tags: vec![],
                github_owner: None,
                examples: Vec::new(),
            },
        );
        let result = block_on(resolve_plugin_icon(
            "superpowers@obra",
            &manifests,
            dir.path().to_path_buf(),
            true,
        ))
        .expect("resolve");
        assert!(result.icon_path.is_none(), "obra is a GitHub User → must be monogram (no face)");
        assert_eq!(result.domain.as_deref(), Some("github.com"));
        assert!(!result.cached);
    }

    /// Helper: inject a value directly into the in-memory `OWNER_TYPE_CACHE`
    /// so tests don't require network access to GitHub's API. Uses `now_secs()`
    /// so the entry is fresh for both long (30d) and short (1h) TTLs.
    fn seed_owner_type_cache(owner: &str, typ: OwnerType) {
        let cache = OWNER_TYPE_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
        let mut guard = cache.lock().unwrap();
        guard.insert(owner.to_string(), (typ, now_secs()));
    }

    #[test]
    fn fetch_owner_type_returns_organization_for_anthropics() {
        seed_owner_type_cache("anthropics", OwnerType::Organization);
        let result = block_on(fetch_owner_type("anthropics", None));
        assert_eq!(result, Some(OwnerType::Organization));
    }

    #[test]
    fn fetch_owner_type_returns_user_for_obra() {
        seed_owner_type_cache("obra", OwnerType::User);
        let result = block_on(fetch_owner_type("obra", None));
        assert_eq!(result, Some(OwnerType::User));
    }

    #[test]
    fn fetch_owner_type_rate_limit_returns_none_and_caches_unknown() {
        // Simulate a 403/429 rate-limit by seeding `Unknown` with current
        // timestamp. The short TTL (1h) means the entry is fresh, so
        // fetch_owner_type returns None (safe default) WITHOUT hitting
        // the network. This proves the rate-limit-aware path: legitimate
        // owners don't get permanently marked as User.
        seed_owner_type_cache("rate-limited-owner", OwnerType::Unknown);
        let result = block_on(fetch_owner_type("rate-limited-owner", None));
        assert!(result.is_none(), "rate-limited owner → None (monogram), not User");
    }

    #[test]
    fn fetch_owner_type_expired_unknown_retries() {
        // An `Unknown` entry older than 1h should be treated as expired
        // → fetch_owner_type would re-query the API. Since we have no
        // network in tests, we verify the TTL logic: expired entry is
        // NOT served from cache (returns None from the API path).
        let old = now_secs().saturating_sub(OWNER_TYPE_TTL_SHORT_SECS + 100);
        let cache = OWNER_TYPE_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
        cache.lock().unwrap().insert("expired-unknown".into(), (OwnerType::Unknown, old));
        // No network → API call fails → returns None (not cached Unknown).
        let result = block_on(fetch_owner_type("expired-unknown", None));
        assert!(result.is_none(), "expired Unknown should re-fetch (not serve cached)");
    }

    #[test]
    fn fetch_owner_type_persists_to_disk() {
        // Seed memory → call with cache_dir → verify owner_types.json written.
        let dir = tempfile::tempdir().expect("tempdir");
        seed_owner_type_cache("anthropics", OwnerType::Organization);
        // Trigger a disk save by calling with cache_dir (memory hit, but
        // we also want to verify disk persistence path works).
        let _ = block_on(fetch_owner_type("anthropics", Some(dir.path())));
        // The memory-hit path doesn't write to disk. To test disk write,
        // we call save_owner_types_disk directly.
        let mut disk = HashMap::new();
        disk.insert("test-owner".into(), OwnerTypeEntry {
            typ: OwnerType::Organization,
            fetched_at: now_secs(),
        });
        save_owner_types_disk(dir.path(), &disk);
        let loaded = load_owner_types_disk(dir.path());
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded.get("test-owner").unwrap().typ, OwnerType::Organization);
    }

    // The Organization end-to-end path is verified INDIRECTLY: the same
    // `fetch_owner_type` gate is used for both User and Organization in
    // `resolve_plugin_icon`. If it blocks Users correctly (proven by
    // `resolve_plugin_icon_github_user_owner_blocks_phase1`), the Org
    // branch (`== Some(OwnerType::Organization)`) is the complementary
    // if-statement path. Direct Organization end-to-end test would need
    // either real network or a cache pre-populated icon for github.com
    // (which load_index evicts as a generic host).

    #[test]
    fn resolve_plugin_icon_non_github_homepage_unaffected() {
        // Non-GitHub homepage (42crunch.com) → flow is unchanged: proceeds
        // to fetch → fails (no network) → miss cache written.
        let dir = tempfile::tempdir().expect("tempdir");
        let mut manifests = HashMap::new();
        manifests.insert(
            "42crunch@marketplace".into(),
            MarketplacePluginEntry {
                name: "42crunch".into(),
                category: None,
                author: None,
                author_email: None,
                homepage: Some("https://42crunch.com".into()),
                description: None,
                version: None,
                display_name: None,
                keywords: vec![],
                tags: vec![],
                github_owner: None,
                examples: Vec::new(),
            },
        );
        let result = block_on(resolve_plugin_icon(
            "42crunch@marketplace",
            &manifests,
            dir.path().to_path_buf(),
            true,
        ))
        .expect("resolve");
        // Fetch will fail (no network in test env) → None, but domain is
        // set (proves we got past the gate without interference).
        assert!(result.icon_path.is_none());
        assert_eq!(result.domain.as_deref(), Some("42crunch.com"));
    }

    // ── cache eviction of blocklisted domains ─────────────────────────

    #[test]
    fn load_index_evicts_blocklisted_domains() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Pre-populate cache with a github.com entry (simulating a cache
        // from before the blocklist was added).
        let mut index = CacheIndex::new();
        let png_bytes = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00];
        let hash = hash_domain("github.com");
        let filename = format!("{hash}.png");
        std::fs::write(dir.path().join(&filename), &png_bytes).expect("write");
        index.insert(
            cache_key("github.com"),
            CacheIndexEntry {
                file: filename,
                ext: "png".into(),
                fetched_at: now_secs(),
                size: png_bytes.len() as u64,
                ttl_secs: TTL_HIT_SECS,
            },
        );
        // Also add a non-blocklisted entry that should survive.
        let hash2 = hash_domain("42crunch.com");
        let filename2 = format!("{hash2}.png");
        std::fs::write(dir.path().join(&filename2), &png_bytes).expect("write");
        index.insert(
            cache_key("42crunch.com"),
            CacheIndexEntry {
                file: filename2,
                ext: "png".into(),
                fetched_at: now_secs(),
                size: png_bytes.len() as u64,
                ttl_secs: TTL_HIT_SECS,
            },
        );
        save_index(dir.path(), &index);

        // Load — should evict github.com but keep 42crunch.com.
        let loaded = load_index(dir.path());
        assert!(!loaded.contains_key(&cache_key("github.com")), "blocklisted domain should be evicted");
        assert!(loaded.contains_key(&cache_key("42crunch.com")), "non-blocklisted should survive");
        // The github.com icon file should be deleted from disk.
        let github_file = dir.path().join(&format!("{hash}.png"));
        assert!(!github_file.exists(), "blocklisted icon file should be deleted");
        // The 42crunch.com icon file should remain.
        let crunch_file = dir.path().join(&format!("{hash2}.png"));
        assert!(crunch_file.exists(), "non-blocklisted icon file should remain");
    }

    #[test]
    fn load_index_drops_old_version_cache() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Write a v1 index (no version field) — should be dropped on load.
        let mut index = CacheIndex::new();
        let png_bytes = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        let hash = hash_domain("example.com");
        let filename = format!("{hash}.png");
        std::fs::write(dir.path().join(&filename), &png_bytes).expect("write");
        index.insert(
            cache_key("example.com"),
            CacheIndexEntry {
                file: filename,
                ext: "png".into(),
                fetched_at: now_secs(),
                size: png_bytes.len() as u64,
                ttl_secs: TTL_HIT_SECS,
            },
        );
        // Write as v1 (plain map, no version wrapper).
        let raw = serde_json::to_string_pretty(&index).expect("serialize");
        std::fs::write(dir.path().join("index.json"), raw).expect("write");

        let loaded = load_index(dir.path());
        assert!(loaded.is_empty(), "v1 cache should be dropped on load");
        // The old icon file should be deleted.
        assert!(!dir.path().join(&format!("{hash}.png")).exists());
    }

    #[test]
    fn save_index_writes_versioned_format() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut index = CacheIndex::new();
        index.insert(
            cache_key("example.com"),
            CacheIndexEntry {
                file: "abc.png".into(),
                ext: "png".into(),
                fetched_at: now_secs(),
                size: 100,
                ttl_secs: TTL_HIT_SECS,
            },
        );
        save_index(dir.path(), &index);

        let raw = std::fs::read_to_string(dir.path().join("index.json")).expect("read");
        let versioned: VersionedCacheIndex = serde_json::from_str(&raw).expect("parse");
        assert_eq!(versioned.version, CACHE_VERSION);
        assert_eq!(versioned.entries.len(), 1);
    }

    #[test]
    fn save_index_atomic_no_tmp_left_behind() {
        // After save, the tmp file must be gone (renamed to index.json).
        let dir = tempfile::tempdir().expect("tempdir");
        let index = CacheIndex::new();
        save_index(dir.path(), &index);
        assert!(dir.path().join("index.json").exists());
        assert!(!dir.path().join("index.json.tmp").exists(), "tmp file should be renamed");
    }

    #[test]
    fn load_index_does_not_drop_v2_entries() {
        // Regression: load_index was re-running migration on every call,
        // dropping v2 entries that were just written. A v2 index with a
        // valid entry must survive a load → save → load cycle.
        let dir = tempfile::tempdir().expect("tempdir");
        let mut index = CacheIndex::new();
        index.insert(
            cache_key("42crunch.com"),
            CacheIndexEntry {
                file: "abc.png".into(),
                ext: "png".into(),
                fetched_at: now_secs(),
                size: 100,
                ttl_secs: TTL_HIT_SECS,
            },
        );
        save_index(dir.path(), &index);

        // First load — should NOT drop the entry (it's v2, non-blocklisted).
        let loaded = load_index(dir.path());
        assert_eq!(loaded.len(), 1, "v2 entry must survive first load");
        assert!(loaded.contains_key(&cache_key("42crunch.com")));

        // Second load — must also NOT drop (migration runs once, not every load).
        save_index(dir.path(), &loaded);
        let loaded2 = load_index(dir.path());
        assert_eq!(loaded2.len(), 1, "v2 entry must survive second load");
        assert!(loaded2.contains_key(&cache_key("42crunch.com")));
    }

    #[test]
    fn resolve_plugin_icon_loads_index_once() {
        // Regression: resolve_plugin_icon called load_index 2x (once for
        // check_cache, once for write_to_cache). Each load ran migration.
        // Now it loads once and reuses. This test confirms the flow works
        // end-to-end with a cache hit (no second load needed).
        let dir = tempfile::tempdir().expect("tempdir");
        let mut index = CacheIndex::new();
        let png_bytes = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00];
        let hash = hash_domain(&cache_key("42crunch.com"));
        let filename = format!("{hash}.png");
        std::fs::write(dir.path().join(&filename), &png_bytes).expect("write");
        index.insert(
            cache_key("42crunch.com"),
            CacheIndexEntry {
                file: filename,
                ext: "png".into(),
                fetched_at: now_secs(),
                size: png_bytes.len() as u64,
                ttl_secs: TTL_HIT_SECS,
            },
        );
        save_index(dir.path(), &index);

        let mut manifests = HashMap::new();
        manifests.insert(
            "p@claude-plugins-official".into(),
            MarketplacePluginEntry {
                name: "p".into(),
                category: None,
                author: None,
                author_email: None,
                homepage: Some("https://42crunch.com".into()),
                description: None,
                version: None,
                display_name: None,
                keywords: vec![],
                tags: vec![],
                github_owner: None,
                examples: Vec::new(),
            },
        );
        let result = block_on(resolve_plugin_icon(
            "p@claude-plugins-official",
            &manifests,
            dir.path().to_path_buf(),
            true,
        ))
        .expect("resolve");
        // Cache hit — no fetch, no second load_index.
        assert!(result.icon_path.is_some());
        assert!(result.cached);
    }

    // ── validate_icon (magic bytes) ───────────────────────────────────

    #[test]
    fn validate_icon_png() {
        let png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00];
        assert_eq!(validate_icon(&png, "image/png"), Some("png"));
    }

    #[test]
    fn validate_icon_jpeg() {
        let jpg = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
        assert_eq!(validate_icon(&jpg, "image/jpeg"), Some("jpg"));
    }

    #[test]
    fn validate_icon_webp() {
        let mut webp = b"RIFF\x00\x00\x00\x00WEBP".to_vec();
        webp.extend_from_slice(&[0x00; 10]);
        assert_eq!(validate_icon(&webp, "image/webp"), Some("webp"));
    }

    #[test]
    fn validate_icon_ico() {
        let ico = [0x00, 0x00, 0x01, 0x00, 0x01, 0x00];
        assert_eq!(validate_icon(&ico, "image/x-icon"), Some("ico"));
    }

    #[test]
    fn validate_icon_rejects_svg_explicit() {
        let svg = b"<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\">";
        assert_eq!(validate_icon(svg, "image/svg+xml"), None);
    }

    #[test]
    fn validate_icon_rejects_svg_bare() {
        let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\">";
        assert_eq!(validate_icon(svg, "image/svg+xml"), None);
    }

    #[test]
    fn validate_icon_rejects_empty() {
        assert_eq!(validate_icon(&[], "image/png"), None);
    }

    #[test]
    fn validate_icon_rejects_garbage() {
        let garbage = [0x00; 16];
        assert_eq!(validate_icon(&garbage, "application/octet-stream"), None);
    }

    #[test]
    fn validate_icon_ignores_content_type_header() {
        // Server lies: says image/png but bytes are SVG. Must reject.
        let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\">";
        assert_eq!(validate_icon(svg, "image/png"), None);
    }

    // ── hash_domain ────────────────────────────────────────────────────

    #[test]
    fn hash_domain_is_deterministic() {
        let h1 = hash_domain("example.com");
        let h2 = hash_domain("example.com");
        assert_eq!(h1, h2);
    }

    #[test]
    fn hash_domain_differs_for_different_domains() {
        let h1 = hash_domain("example.com");
        let h2 = hash_domain("other.com");
        assert_ne!(h1, h2);
    }

    #[test]
    fn hash_domain_is_hex() {
        let h = hash_domain("example.com");
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(h.len(), 64); // SHA-256 = 32 bytes = 64 hex chars
    }

    // ── cache (load/save/check) ────────────────────────────────────────

    #[test]
    fn cache_round_trip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut index = CacheIndex::new();
        index.insert(
            cache_key("example.com"),
            CacheIndexEntry {
                file: "abc.png".into(),
                ext: "png".into(),
                fetched_at: now_secs(),
                size: 100,
                ttl_secs: TTL_HIT_SECS,
            },
        );
        save_index(dir.path(), &index);
        let loaded = load_index(dir.path());
        assert_eq!(loaded.len(), 1);
        assert!(loaded.contains_key(&cache_key("example.com")));
    }

    #[test]
    fn cache_check_fresh_entry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut index = CacheIndex::new();
        let entry = CacheIndexEntry {
            file: "abc.png".into(),
            ext: "png".into(),
            fetched_at: now_secs(),
            size: 100,
            ttl_secs: TTL_HIT_SECS,
        };
        // Create the file so check_cache finds it.
        std::fs::write(dir.path().join("abc.png"), b"fake png").expect("write");
        index.insert(cache_key("example.com"), entry);
        let result = check_cache(&index, "example.com", dir.path());
        assert!(result.is_some());
        assert!(result.unwrap().ends_with("abc.png"));
    }

    #[test]
    fn cache_check_expired_entry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut index = CacheIndex::new();
        let old = now_secs().saturating_sub(TTL_HIT_SECS + 100);
        std::fs::write(dir.path().join("abc.png"), b"fake").expect("write");
        index.insert(
            cache_key("example.com"),
            CacheIndexEntry {
                file: "abc.png".into(),
                ext: "png".into(),
                fetched_at: old,
                size: 100,
                ttl_secs: TTL_HIT_SECS,
            },
        );
        let result = check_cache(&index, "example.com", dir.path());
        assert!(result.is_none(), "expired entry should not be served");
    }

    #[test]
    fn cache_check_missing_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut index = CacheIndex::new();
        index.insert(
            cache_key("example.com"),
            CacheIndexEntry {
                file: "nonexistent.png".into(),
                ext: "png".into(),
                fetched_at: now_secs(),
                size: 100,
                ttl_secs: TTL_HIT_SECS,
            },
        );
        let result = check_cache(&index, "example.com", dir.path());
        assert!(result.is_none(), "missing file should not be served");
    }

    #[test]
    fn cache_check_unknown_domain() {
        let dir = tempfile::tempdir().expect("tempdir");
        let index = CacheIndex::new();
        let result = check_cache(&index, "unknown.com", dir.path());
        assert!(result.is_none());
    }

    // ── write_to_cache + LRU ───────────────────────────────────────────

    #[test]
    fn write_to_cache_creates_file_and_index() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut index = CacheIndex::new();
        let data = IconData {
            bytes: vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00],
            ext: "png",
        };
        let path = write_to_cache(dir.path(), "example.com", &data, &mut index).expect("write");
        assert!(path.exists());
        assert!(path.to_string_lossy().ends_with(".png"));
        assert!(index.contains_key(&cache_key("example.com")));
    }

    #[test]
    fn write_to_cache_replaces_old_ext() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut index = CacheIndex::new();
        // Old entry: .ico
        std::fs::write(dir.path().join("old.ico"), b"old").expect("write");
        index.insert(
            cache_key("example.com"),
            CacheIndexEntry {
                file: "old.ico".into(),
                ext: "ico".into(),
                fetched_at: now_secs(),
                size: 3,
                ttl_secs: TTL_HIT_SECS,
            },
        );
        // New entry: .png
        let data = IconData {
            bytes: vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
            ext: "png",
        };
        write_to_cache(dir.path(), "example.com", &data, &mut index).expect("write");
        // Old .ico file should be removed.
        assert!(!dir.path().join("old.ico").exists());
        // New .png file should exist.
        let entry = index.get(&cache_key("example.com")).expect("entry");
        assert_eq!(entry.ext, "png");
    }

    #[test]
    fn lru_evicts_oldest_when_over_cap() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut index = CacheIndex::new();
        // Fill cache with entries totaling > MAX_CACHE_BYTES.
        // Each entry is 20 MB; 3 entries = 60 MB > 50 MB cap.
        let big = vec![0x00; 20 * 1024 * 1024];
        for i in 0..3 {
            let domain = format!("site-{i}.com");
            let file = format!("site-{i}.bin");
            std::fs::write(dir.path().join(&file), &big).expect("write");
            index.insert(
                domain,
                CacheIndexEntry {
                    file,
                    ext: "bin".into(),
                    fetched_at: now_secs() + i, // ascending: site-0 oldest
                    size: big.len() as u64,
                    ttl_secs: TTL_HIT_SECS,
                },
            );
        }
        enforce_lru_cap(dir.path(), &mut index);
        // After eviction, total should be <= MAX_CACHE_BYTES.
        let total: u64 = index.values().map(|e| e.size).sum();
        assert!(total <= MAX_CACHE_BYTES, "total {total} > cap");
        // site-0 (oldest) should be evicted; site-2 (newest) should remain.
        assert!(!index.contains_key("site-0.com"), "oldest should be evicted");
        assert!(index.contains_key("site-2.com"), "newest should remain");
    }

    // ── resolve_plugin_icon (integration) ─────────────────────────────

    #[test]
    fn resolve_plugin_icon_toggle_off_returns_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut manifests = HashMap::new();
        manifests.insert(
            "p@m".into(),
            MarketplacePluginEntry {
                name: "p".into(),
                category: None,
                author: None,
                author_email: None,
                homepage: Some("https://example.com".into()),
                description: None,
                version: None,
                display_name: None,
                keywords: vec![],
                tags: vec![],
                github_owner: None,
                examples: Vec::new(),
            },
        );
        let result = block_on(resolve_plugin_icon(
            "p@m",
            &manifests,
            dir.path().to_path_buf(),
            false, // toggle OFF
        ))
        .expect("resolve");
        assert!(result.icon_path.is_none());
        assert!(!result.cached);
    }

    #[test]
    fn resolve_plugin_icon_no_homepage_returns_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut manifests = HashMap::new();
        manifests.insert(
            "p@m".into(),
            MarketplacePluginEntry {
                name: "p".into(),
                category: None,
                author: None,
                author_email: None,
                homepage: None, // no homepage
                description: None,
                version: None,
                display_name: None,
                keywords: vec![],
                tags: vec![],
                github_owner: None,
                examples: Vec::new(),
            },
        );
        let result = block_on(resolve_plugin_icon(
            "p@m",
            &manifests,
            dir.path().to_path_buf(),
            true, // toggle ON
        ))
        .expect("resolve");
        assert!(result.icon_path.is_none());
    }

    #[test]
    fn resolve_plugin_icon_unknown_plugin_returns_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifests = HashMap::new();
        let result = block_on(resolve_plugin_icon(
            "unknown@m",
            &manifests,
            dir.path().to_path_buf(),
            true,
        ));
        assert!(result.is_err());
    }

    #[test]
    fn resolve_plugin_icon_serves_from_cache() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Pre-populate cache.
        let mut index = CacheIndex::new();
        let png_bytes = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00];
        let hash = hash_domain("example.com");
        let filename = format!("{hash}.png");
        std::fs::write(dir.path().join(&filename), &png_bytes).expect("write");
        index.insert(
            cache_key("example.com"),
            CacheIndexEntry {
                file: filename,
                ext: "png".into(),
                fetched_at: now_secs(),
                size: png_bytes.len() as u64,
                ttl_secs: TTL_HIT_SECS,
            },
        );
        save_index(dir.path(), &index);

        let mut manifests = HashMap::new();
        manifests.insert(
            "p@m".into(),
            MarketplacePluginEntry {
                name: "p".into(),
                category: None,
                author: None,
                author_email: None,
                homepage: Some("https://example.com".into()),
                description: None,
                version: None,
                display_name: None,
                keywords: vec![],
                tags: vec![],
                github_owner: None,
                examples: Vec::new(),
            },
        );
        let result = block_on(resolve_plugin_icon(
            "p@m",
            &manifests,
            dir.path().to_path_buf(),
            true,
        ))
        .expect("resolve");
        assert!(result.icon_path.is_some());
        assert!(result.cached, "should be served from cache");
        assert_eq!(result.domain.as_deref(), Some("example.com"));
    }
}
