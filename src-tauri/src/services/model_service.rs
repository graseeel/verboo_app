use std::path::PathBuf;

use crate::models::types::{ModelDiscoveryResult, VerbooModel};

const VERBOO_ROUTER_MODELS_URL: &str = "https://code.verboo.ai/router/v1/models";
const CACHE_TTL_SECS: u64 = 24 * 60 * 60;
const CACHE_FILE: &str = "models.json";

/// Fetches available models from the Verboo Router API, with disk cache.
///
/// Resolution order (mirrors Electron's `ModelService`):
///   1. API key → fetch from router (live)
///   2. CLI token → fetch from router (live) — requires reading keychain
///   3. Disk cache (stale, with TTL check)
///   4. Empty result with error
pub struct ModelService {
    cache_dir: PathBuf,
}

impl ModelService {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            cache_dir: app_data_dir.join("cache"),
        }
    }

    /// Returns the cached models file path.
    fn cache_path(&self) -> PathBuf {
        self.cache_dir.join(CACHE_FILE)
    }

    /// Lists models. Tries API key first, then CLI token.
    pub fn list_models(
        &self,
        api_key: Option<&str>,
        force_refresh: bool,
    ) -> Result<ModelDiscoveryResult, String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // Try reading cache first for non-forced requests
        if !force_refresh {
            if let Some(cached) = self.read_cache(now) {
                if !Self::is_stale(cached.fetched_at, now) {
                    return Ok(ModelDiscoveryResult {
                        models: cached.models,
                        source: "cache".into(),
                        stale: false,
                        error: None,
                    });
                }
            }
        }

        // Try API key
        let mut live_error: Option<String> = None;

        if let Some(key) = api_key {
            match self.fetch_from_router(key) {
                Ok(models) => {
                    self.write_cache(&models, now)?;
                    return Ok(ModelDiscoveryResult {
                        models,
                        source: "api-key".into(),
                        stale: false,
                        error: None,
                    });
                }
                Err(e) => {
                    live_error = Some(e);
                }
            }
        }

        // Fall back to cache (even if stale)
        if let Some(cached) = self.read_cache(now) {
            return Ok(ModelDiscoveryResult {
                models: cached.models,
                source: "cache".into(),
                stale: true,
                error: Some(
                    live_error.unwrap_or_else(|| {
                        "Entre com Verboo pelo CLI/app para atualizar os modelos da sua conta."
                            .into()
                    }),
                ),
            });
        }

        Ok(ModelDiscoveryResult {
            models: Vec::new(),
            source: "none".into(),
            stale: false,
            error: Some(
                live_error.unwrap_or_else(|| {
                    "Entre com Verboo pelo CLI/app ou configure uma chave API.".into()
                }),
            ),
        })
    }

    /// Fetches the model list from the Verboo Router API.
    fn fetch_from_router(&self, token: &str) -> Result<Vec<VerbooModel>, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| format!("Falha ao criar cliente HTTP: {e}"))?;

        let response = client
            .get(VERBOO_ROUTER_MODELS_URL)
            .header("Accept", "application/json")
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .map_err(|e| format!("Falha ao buscar modelos: {e}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().unwrap_or_default();
            let sanitized = sanitize_body(&body);
            return Err(format!("HTTP {status}{}", if sanitized.is_empty() { String::new() } else { format!(": {sanitized}") }));
        }

        let payload: serde_json::Value = response
            .json()
            .map_err(|e| format!("Falha ao decodificar lista de modelos: {e}"))?;

        Ok(normalize_models(&payload))
    }

    fn is_stale(fetched_at: u64, now: u64) -> bool {
        now.saturating_sub(fetched_at) >= CACHE_TTL_SECS
    }

    fn read_cache(&self, _now: u64) -> Option<CachedModels> {
        let data = std::fs::read_to_string(self.cache_path()).ok()?;
        let cached: CachedModels = serde_json::from_str(&data).ok()?;
        Some(cached)
    }

    fn write_cache(&self, models: &[VerbooModel], now: u64) -> Result<(), String> {
        std::fs::create_dir_all(&self.cache_dir)
            .map_err(|e| format!("Falha ao criar cache: {e}"))?;
        let cached = CachedModels {
            fetched_at: now,
            models: models.to_vec(),
        };
        let data = serde_json::to_string(&cached).map_err(|e| e.to_string())?;
        std::fs::write(self.cache_path(), data).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Removes the on-disk model cache. Called on logout so a subsequent
    /// validation can't unlock the app from stale cached models (B3).
    pub fn clear_cache(&self) {
        let _ = std::fs::remove_file(self.cache_path());
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct CachedModels {
    fetched_at: u64,
    models: Vec<VerbooModel>,
}

/// Mirrors Electron's `normalizeModels`/`normalizeModel`/`detectVisionSupport`.
fn normalize_models(payload: &serde_json::Value) -> Vec<VerbooModel> {
    let items = if let Some(obj) = payload.as_object() {
        obj.get("data")
            .and_then(|v| v.as_array())
            .map(|arr| arr.clone())
            .unwrap_or_default()
    } else if let Some(arr) = payload.as_array() {
        arr.clone()
    } else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(normalize_model)
        .collect()
}

fn normalize_model(item: &serde_json::Value) -> Option<VerbooModel> {
    let obj = item.as_object()?;
    let id = obj.get("id")?.as_str()?;
    let id = id.to_string();

    let display_name = obj
        .get("display_name")
        .or_else(|| obj.get("displayName"))
        .or_else(|| obj.get("label"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| id.clone());

    let context_window = obj
        .get("context_window")
        .or_else(|| obj.get("contextWindow"))
        .or_else(|| obj.get("context_length"))
        .or_else(|| obj.get("max_input_tokens"))
        .and_then(|v| v.as_u64())
        .map(|n| n as u32);

    let max_output_tokens = obj
        .get("max_output_tokens")
        .or_else(|| obj.get("maxOutputTokens"))
        .or_else(|| obj.get("max_completion_tokens"))
        .and_then(|v| v.as_u64())
        .map(|n| n as u32);

    let (supports_vision, vision_support_source) = detect_vision_support(&obj);

    Some(VerbooModel {
        id,
        display_name,
        context_window,
        max_output_tokens,
        supports_vision,
        vision_support_source,
        raw: item.clone(),
    })
}

fn detect_vision_support(
    obj: &serde_json::Map<String, serde_json::Value>,
) -> (Option<bool>, Option<String>) {
    // Direct boolean flags
    for key in &["supportsVision", "supports_vision", "vision"] {
        if let Some(v) = obj.get(*key) {
            if let Some(b) = v.as_bool() {
                return (Some(b), Some("router".into()));
            }
        }
    }

    // Capabilities object
    if let Some(caps) = obj.get("capabilities").and_then(|v| v.as_object()) {
        for key in &["supportsVision", "supports_vision", "vision"] {
            if let Some(v) = caps.get(*key) {
                if let Some(b) = v.as_bool() {
                    return (Some(b), Some("raw-capabilities".into()));
                }
            }
        }
    }

    // Modalities arrays
    let modalities = collect_strings(obj, &["input_modalities", "inputModalities", "modalities"]);
    if modalities.iter().any(|s| s == "image" || s == "vision") {
        return (Some(true), Some("raw-capabilities".into()));
    }

    if let Some(caps) = obj.get("capabilities").and_then(|v| v.as_object()) {
        let cap_modalities =
            collect_strings(caps, &["input_modalities", "inputModalities", "modalities"]);
        if cap_modalities.iter().any(|s| s == "image" || s == "vision") {
            return (Some(true), Some("raw-capabilities".into()));
        }
    }

    // Classification
    let classifications = collect_strings(obj, &["classification"]);
    if classifications.iter().any(|s| s.contains("vision") || s.contains("image")) {
        return (Some(true), Some("raw-capabilities".into()));
    }

    // Heuristic: check name for vision keywords (word-boundary match,
    // mirroring Electron's `\b<pattern>\b` regex).
    let id_text = vec![
        obj.get("id").and_then(|v| v.as_str()),
        obj.get("display_name").and_then(|v| v.as_str()),
        obj.get("displayName").and_then(|v| v.as_str()),
        obj.get("label").and_then(|v| v.as_str()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase();

    // Tokens with non-alphanumeric boundaries (including hyphens, slashes,
    // underscores). "minimax-vision" matches as two tokens: "minimax", "vision".
    let heuristic_patterns = ["vision", "vl", "omni", "multimodal"];
    let tokens: Vec<&str> = id_text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect();
    if tokens.iter().any(|tok| heuristic_patterns.contains(tok)) {
        return (Some(true), Some("heuristic".into()));
    }

    (None, None)
}

fn collect_strings(
    obj: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Vec<String> {
    let mut result = Vec::new();
    for key in keys {
        if let Some(arr) = obj.get(*key).and_then(|v| v.as_array()) {
            result.extend(arr.iter().filter_map(|v| v.as_str().map(|s| s.to_lowercase())));
        }
    }
    result
}

fn sanitize_body(body: &str) -> String {
    // Strip bearer tokens and long strings
    body.replace("Bearer ", "Bearer [redacted]")
        .replace('"', "")
        .chars()
        .filter(|c| c.is_ascii_graphic() || c.is_ascii_whitespace())
        .collect::<String>()
        .split_whitespace()
        .filter(|word| word.len() < 20)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_models_from_data_array() {
        let payload = json!({
            "data": [
                {"id": "claude-sonnet-4-6", "display_name": "Claude Sonnet 4.6", "context_window": 200000},
                {"id": "claude-opus-4-6", "displayName": "Claude Opus 4.6", "max_input_tokens": 200000},
            ]
        });
        let models = normalize_models(&payload);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "claude-sonnet-4-6");
    }

    #[test]
    fn normalize_models_from_plain_array() {
        let payload = json!([
            {"id": "gpt-4o", "context_window": 128000},
        ]);
        let models = normalize_models(&payload);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-4o");
    }

    #[test]
    fn normalize_models_handles_empty() {
        assert!(normalize_models(&json!({})).is_empty());
        assert!(normalize_models(&json!(null)).is_empty());
    }

    #[test]
    fn vision_detection_direct_flag() {
        let obj = json!({"supportsVision": true});
        let (vision, source) = detect_vision_support(obj.as_object().unwrap());
        assert_eq!(vision, Some(true));
        assert_eq!(source.as_deref(), Some("router"));
    }

    #[test]
    fn vision_detection_heuristic_name() {
        let obj = json!({"id": "claude-sonnet-4-vision"});
        let (vision, source) = detect_vision_support(obj.as_object().unwrap());
        assert_eq!(vision, Some(true));
        assert_eq!(source.as_deref(), Some("heuristic"));
    }

    #[test]
    fn vision_detection_no_match() {
        let obj = json!({"id": "claude-sonnet-4"});
        let (vision, _) = detect_vision_support(obj.as_object().unwrap());
        assert_eq!(vision, None);
    }

    #[test]
    fn vision_detection_word_boundary_vl() {
        // "vl" must match as a whole word, not as a substring.
        // "invlnv" should NOT trigger vision (Electron uses \bvl\b regex).
        let obj = json!({"id": "invlnv"});
        let (vision, _) = detect_vision_support(obj.as_object().unwrap());
        assert_eq!(vision, None, "substring 'vl' inside 'invlnv' must not match");

        // "model-vl-1" should match (vl is a token between hyphens).
        let obj = json!({"id": "model-vl-1"});
        let (vision, _) = detect_vision_support(obj.as_object().unwrap());
        assert_eq!(vision, Some(true));

        // "qwen-vl" should match.
        let obj = json!({"id": "qwen-vl"});
        let (vision, _) = detect_vision_support(obj.as_object().unwrap());
        assert_eq!(vision, Some(true));
    }

    #[test]
    fn stale_check() {
        let now = 1_000_000;
        assert!(!ModelService::is_stale(now - 3600, now)); // 1 hour ago
        assert!(ModelService::is_stale(now - 86401, now)); // > 24h ago
    }
}
