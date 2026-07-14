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
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

use crate::models::plugins::PluginError;
use crate::services::marketplace_manifest_service::MarketplacePluginEntry;

// ════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════

/// Cache TTL: 7 days in seconds.
const TTL_SECS: u64 = 7 * 24 * 60 * 60;

/// Max cache size: 50 MB.
const MAX_CACHE_BYTES: u64 = 50 * 1024 * 1024;

/// Max icon size: 512 KB.
const MAX_ICON_BYTES: usize = 512 * 1024;

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
const CACHE_VERSION: u32 = 2;

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

    // Resolve pluginId → manifest entry → homepage → domain.
    let entry = manifests.get(plugin_id).ok_or_else(|| PluginError::Unknown {
        message: format!("plugin {plugin_id} not found in marketplace manifests"),
        exit_code: None,
    })?;

    let homepage = match entry.homepage.as_deref() {
        Some(h) if !h.is_empty() => h,
        _ => {
            // No homepage → can't fetch. Return None (FE renders monogram).
            return Ok(PluginIconResult {
                icon_path: None,
                domain: None,
                cached: false,
            });
        }
    };

    let domain = extract_domain(homepage).ok_or_else(|| PluginError::Unknown {
        message: format!("could not extract domain from homepage: {homepage}"),
        exit_code: None,
    })?;

    // Blocklist: generic code/package hosts (github.com, npmjs.com, etc.)
    // have their own branding as favicon — fetching would show dozens of
    // identical wrong icons (e.g. GitHub's octocat for every GitHub-hosted
    // plugin). Skip the fetch entirely; FE renders a monogram.
    if is_generic_host(&domain) {
        return Ok(PluginIconResult {
            icon_path: None,
            domain: Some(domain),
            cached: false,
        });
    }

    // Ensure cache dir exists.
    std::fs::create_dir_all(&cache_dir).map_err(|e| PluginError::Unknown {
        message: format!("failed to create cache dir: {e}"),
        exit_code: None,
    })?;

    // Load the index ONCE (runs migration if needed) and reuse it for
    // both the cache check and the write. Previous code called load_index
    // 2x, which re-ran the migration on every call — dropping v2 entries
    // that were just written.
    let mut index = load_index(&cache_dir);

    // Check cache first.
    if let Some(cached) = check_cache(&index, &domain, &cache_dir) {
        return Ok(PluginIconResult {
            icon_path: Some(cached.to_string_lossy().to_string()),
            domain: Some(domain),
            cached: true,
        });
    }

    // Fetch (semaphore-limited). If all paths fail, return None (not an error).
    let icon_data = match fetch_icon(&domain).await {
        Some(data) => data,
        None => {
            return Ok(PluginIconResult {
                icon_path: None,
                domain: Some(domain),
                cached: false,
            });
        }
    };

    // Write to cache + update index + enforce LRU cap. Pass the already-loaded
    // index (no second load_index call).
    let icon_path = write_to_cache(&cache_dir, &domain, &icon_data, &mut index)?;

    Ok(PluginIconResult {
        icon_path: Some(icon_path.to_string_lossy().to_string()),
        domain: Some(domain),
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

/// Returns true if the domain is a generic code/package host whose
/// favicon is the host's branding (e.g. GitHub's octocat), NOT the
/// plugin's. Fetching these would show dozens of identical wrong icons.
/// We skip the fetch entirely and return None (FE renders monogram).
pub(crate) fn is_generic_host(domain: &str) -> bool {
    let lower = domain.to_lowercase();
    GENERIC_HOST_BLOCKLIST.iter().any(|h| lower == *h || lower.ends_with(&format!(".{h}")))
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

    // Evict any blocklisted domains that slipped in before the blocklist.
    let before = index.len();
    index.retain(|domain, entry| {
        if is_generic_host(domain) {
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

/// Checks the cache for a fresh entry for `domain`. Returns the icon path
/// if the entry exists, the file is present, and the TTL hasn't expired.
fn check_cache(index: &CacheIndex, domain: &str, cache_dir: &Path) -> Option<PathBuf> {
    let entry = index.get(domain)?;
    let now = now_secs();
    if now.saturating_sub(entry.fetched_at) > TTL_SECS {
        return None; // expired
    }
    let path = cache_dir.join(&entry.file);
    if !path.exists() {
        return None; // file missing (evicted manually?)
    }
    Some(path)
}

/// Writes icon data to the cache and updates the index. Enforces the 50 MB
/// LRU cap by evicting oldest entries until under the limit.
fn write_to_cache(
    cache_dir: &Path,
    domain: &str,
    data: &IconData,
    index: &mut CacheIndex,
) -> Result<PathBuf, PluginError> {
    let hash = hash_domain(domain);
    let filename = format!("{hash}.{}", data.ext);
    let path = cache_dir.join(&filename);

    std::fs::write(&path, &data.bytes).map_err(|e| PluginError::Unknown {
        message: format!("failed to write icon cache: {e}"),
        exit_code: None,
    })?;

    let size = data.bytes.len() as u64;
    let now = now_secs();

    // Remove any old entry for this domain (different ext) to avoid stale files.
    if let Some(old) = index.remove(domain) {
        let old_path = cache_dir.join(&old.file);
        if old_path != path && old_path.exists() {
            let _ = std::fs::remove_file(&old_path);
        }
    }

    index.insert(
        domain.to_string(),
        CacheIndexEntry {
            file: filename,
            ext: data.ext.to_string(),
            fetched_at: now,
            size,
        },
    );

    // Enforce 50 MB cap via LRU eviction.
    enforce_lru_cap(cache_dir, index);

    save_index(cache_dir, index);

    Ok(path)
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

/// SHA-256 hash of the domain, hex-encoded. Used as the cache filename.
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

/// Fetches the icon for a domain. Tries `/apple-touch-icon.png` then
/// `/favicon.ico`. Returns `None` if all paths fail (network error, 404,
/// invalid content type, too large, etc.). HTTPS only.
async fn fetch_icon(domain: &str) -> Option<IconData> {
    let _permit = semaphore().await.acquire().await.ok()?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .ok()?;

    for path in ICON_PATHS {
        let url = format!("https://{domain}{path}");
        match client.get(&url).send().await {
            Ok(resp) => {
                let status = resp.status();
                if !status.is_success() {
                    continue;
                }
                let content_type = resp
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                let bytes = match resp.bytes().await {
                    Ok(b) => b.to_vec(),
                    Err(_) => continue,
                };
                if bytes.len() > MAX_ICON_BYTES {
                    continue;
                }
                match validate_icon(&bytes, &content_type) {
                    Some(ext) => return Some(IconData { bytes, ext }),
                    None => continue,
                }
            }
            Err(_) => continue,
        }
    }
    None
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

    // ── resolve_plugin_icon blocklist integration ─────────────────────

    #[test]
    fn resolve_plugin_icon_blocklisted_domain_returns_none_without_fetch() {
        // github.com is blocklisted → return None without any network request.
        // The cache dir should NOT have any icon file written.
        let dir = tempfile::tempdir().expect("tempdir");
        let mut manifests = HashMap::new();
        manifests.insert(
            "asana@claude-plugins-official".into(),
            MarketplacePluginEntry {
                name: "asana".into(),
                category: None,
                author: None,
                author_email: None,
                homepage: Some("https://github.com/anthropics/claude-plugins-public/tree/main/plugins/asana".into()),
                description: None,
                version: None,
                display_name: None,
                keywords: vec![],
                tags: vec![],
            },
        );
        let result = block_on(resolve_plugin_icon(
            "asana@claude-plugins-official",
            &manifests,
            dir.path().to_path_buf(),
            true, // toggle ON
        ))
        .expect("resolve");
        assert!(result.icon_path.is_none(), "blocklisted domain must return None");
        assert_eq!(result.domain.as_deref(), Some("github.com"));
        assert!(!result.cached);
        // No icon files should have been written.
        let icon_files: Vec<_> = std::fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != "index.json")
            .collect();
        assert!(icon_files.is_empty(), "no icon files should exist for blocklisted domain");
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
        // Regression: even if a blocklisted domain (github.com) is in the
        // cache from a previous version, resolve_plugin_icon must NOT serve
        // it — the blocklist check runs BEFORE the cache check.
        let dir = tempfile::tempdir().expect("tempdir");
        let mut index = CacheIndex::new();
        let png_bytes = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00];
        let hash = hash_domain("github.com");
        let filename = format!("{hash}.png");
        std::fs::write(dir.path().join(&filename), &png_bytes).expect("write");
        index.insert(
            "github.com".into(),
            CacheIndexEntry {
                file: filename,
                ext: "png".into(),
                fetched_at: now_secs(),
                size: png_bytes.len() as u64,
            },
        );
        save_index(dir.path(), &index);

        let mut manifests = HashMap::new();
        manifests.insert(
            "asana@claude-plugins-official".into(),
            MarketplacePluginEntry {
                name: "asana".into(),
                category: None,
                author: None,
                author_email: None,
                homepage: Some("https://github.com/anthropics/claude-plugins-public".into()),
                description: None,
                version: None,
                display_name: None,
                keywords: vec![],
                tags: vec![],
            },
        );
        let result = block_on(resolve_plugin_icon(
            "asana@claude-plugins-official",
            &manifests,
            dir.path().to_path_buf(),
            true,
        ))
        .expect("resolve");
        // Blocklist check returns None BEFORE cache check — even though
        // github.com is cached, it must NOT be served.
        assert!(result.icon_path.is_none(), "blocklisted cached domain must not be served");
        assert_eq!(result.domain.as_deref(), Some("github.com"));
        assert!(!result.cached);
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
            "github.com".into(),
            CacheIndexEntry {
                file: filename,
                ext: "png".into(),
                fetched_at: now_secs(),
                size: png_bytes.len() as u64,
            },
        );
        // Also add a non-blocklisted entry that should survive.
        let hash2 = hash_domain("42crunch.com");
        let filename2 = format!("{hash2}.png");
        std::fs::write(dir.path().join(&filename2), &png_bytes).expect("write");
        index.insert(
            "42crunch.com".into(),
            CacheIndexEntry {
                file: filename2,
                ext: "png".into(),
                fetched_at: now_secs(),
                size: png_bytes.len() as u64,
            },
        );
        save_index(dir.path(), &index);

        // Load — should evict github.com but keep 42crunch.com.
        let loaded = load_index(dir.path());
        assert!(!loaded.contains_key("github.com"), "blocklisted domain should be evicted");
        assert!(loaded.contains_key("42crunch.com"), "non-blocklisted should survive");
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
            "example.com".into(),
            CacheIndexEntry {
                file: filename,
                ext: "png".into(),
                fetched_at: now_secs(),
                size: png_bytes.len() as u64,
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
            "example.com".into(),
            CacheIndexEntry {
                file: "abc.png".into(),
                ext: "png".into(),
                fetched_at: now_secs(),
                size: 100,
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
            "42crunch.com".into(),
            CacheIndexEntry {
                file: "abc.png".into(),
                ext: "png".into(),
                fetched_at: now_secs(),
                size: 100,
            },
        );
        save_index(dir.path(), &index);

        // First load — should NOT drop the entry (it's v2, non-blocklisted).
        let loaded = load_index(dir.path());
        assert_eq!(loaded.len(), 1, "v2 entry must survive first load");
        assert!(loaded.contains_key("42crunch.com"));

        // Second load — must also NOT drop (migration runs once, not every load).
        save_index(dir.path(), &loaded);
        let loaded2 = load_index(dir.path());
        assert_eq!(loaded2.len(), 1, "v2 entry must survive second load");
        assert!(loaded2.contains_key("42crunch.com"));
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
        let hash = hash_domain("42crunch.com");
        let filename = format!("{hash}.png");
        std::fs::write(dir.path().join(&filename), &png_bytes).expect("write");
        index.insert(
            "42crunch.com".into(),
            CacheIndexEntry {
                file: filename,
                ext: "png".into(),
                fetched_at: now_secs(),
                size: png_bytes.len() as u64,
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
            "example.com".into(),
            CacheIndexEntry {
                file: "abc.png".into(),
                ext: "png".into(),
                fetched_at: now_secs(),
                size: 100,
            },
        );
        save_index(dir.path(), &index);
        let loaded = load_index(dir.path());
        assert_eq!(loaded.len(), 1);
        assert!(loaded.contains_key("example.com"));
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
        };
        // Create the file so check_cache finds it.
        std::fs::write(dir.path().join("abc.png"), b"fake png").expect("write");
        index.insert("example.com".into(), entry);
        let result = check_cache(&index, "example.com", dir.path());
        assert!(result.is_some());
        assert!(result.unwrap().ends_with("abc.png"));
    }

    #[test]
    fn cache_check_expired_entry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut index = CacheIndex::new();
        let old = now_secs().saturating_sub(TTL_SECS + 100);
        std::fs::write(dir.path().join("abc.png"), b"fake").expect("write");
        index.insert(
            "example.com".into(),
            CacheIndexEntry {
                file: "abc.png".into(),
                ext: "png".into(),
                fetched_at: old,
                size: 100,
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
            "example.com".into(),
            CacheIndexEntry {
                file: "nonexistent.png".into(),
                ext: "png".into(),
                fetched_at: now_secs(),
                size: 100,
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
        assert!(index.contains_key("example.com"));
    }

    #[test]
    fn write_to_cache_replaces_old_ext() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut index = CacheIndex::new();
        // Old entry: .ico
        std::fs::write(dir.path().join("old.ico"), b"old").expect("write");
        index.insert(
            "example.com".into(),
            CacheIndexEntry {
                file: "old.ico".into(),
                ext: "ico".into(),
                fetched_at: now_secs(),
                size: 3,
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
        let entry = index.get("example.com").expect("entry");
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
            "example.com".into(),
            CacheIndexEntry {
                file: filename,
                ext: "png".into(),
                fetched_at: now_secs(),
                size: png_bytes.len() as u64,
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
