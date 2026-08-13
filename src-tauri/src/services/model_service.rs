use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::models::types::{ModelDiscoveryResult, ModelReasoning, VerbooModel};
use crate::services::provider_catalog;

const VERBOO_ROUTER_MODELS_URL: &str = "https://code.verboo.ai/router/v1/models";
const CACHE_TTL_SECS: u64 = 24 * 60 * 60;
const CACHE_FILE: &str = "models.json";
static VISION_METADATA_CACHE_REFRESHED: AtomicBool = AtomicBool::new(false);

/// Fetches available models from the Verboo Router API, with disk cache.
///
/// Resolution order (mirrors Electron's `ModelService`):
///   1. API key → fetch from router (live)
///   2. CLI token → fetch from router (live) — requires reading keychain
///   3. Disk cache (stale, with TTL check)
///   4. Empty result with error
#[derive(Clone)]
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

        // Try reading cache first for non-forced requests.
        // Router's vision metadata was added after older 24h caches were written.
        // If the whole cached catalog has no explicit vision metadata, treat that
        // cache as soft-stale once per process when a token is available, so the
        // Eye badge can appear immediately after Router rollout without waiting
        // for TTL expiry. If live refresh still lacks metadata, the cache is used
        // normally for the rest of the session.
        if !force_refresh {
            if let Some(cached) = self.read_cache(now) {
                if !Self::is_stale(cached.fetched_at, now) {
                    let should_soft_refresh = api_key.is_some()
                        && cache_lacks_vision_metadata(&cached.models)
                        && !VISION_METADATA_CACHE_REFRESHED.swap(true, Ordering::Relaxed);
                    if !should_soft_refresh {
                        return Ok(attach_provider_models(ModelDiscoveryResult {
                            models: cached.models,
                            source: "cache".into(),
                            stale: false,
                            error: None,
                            provider_error: None,
                        }));
                    }
                }
            }
        }

        // Try API key
        let mut live_error: Option<String> = None;

        if let Some(key) = api_key {
            match self.fetch_from_router(key) {
                Ok(models) => {
                    self.write_cache(&models, now)?;
                    return Ok(attach_provider_models(ModelDiscoveryResult {
                        models,
                        source: "api-key".into(),
                        stale: false,
                        error: None,
                        provider_error: None,
                    }));
                }
                Err(e) => {
                    live_error = Some(e);
                }
            }
        }

        // Fall back to cache (even if stale)
        if let Some(cached) = self.read_cache(now) {
            return Ok(attach_provider_models(ModelDiscoveryResult {
                models: cached.models,
                source: "cache".into(),
                stale: true,
                error: Some(
                    live_error.unwrap_or_else(|| {
                        "Entre com Verboo pelo CLI/app para atualizar os modelos da sua conta."
                            .into()
                    }),
                ),
                provider_error: None,
            }));
        }

        Ok(attach_provider_models(ModelDiscoveryResult {
            models: Vec::new(),
            source: "none".into(),
            stale: false,
            error: Some(
                live_error.unwrap_or_else(|| {
                    "Entre com Verboo pelo CLI/app ou configure uma chave API.".into()
                }),
            ),
            provider_error: None,
        }))
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
        let mut cached: CachedModels = serde_json::from_str(&data).ok()?;
        refresh_cached_vision_metadata(&mut cached.models);
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

/// F2-PROVIDERS: estende o catálogo com os modelos de provedor (claude/
/// codex) descobertos pelo CLI empacotado. Best-effort: se a listagem
/// falhar (CLI ausente, não autenticado, timeout), o catálogo atual
/// continua funcionando como hoje (provider = "verboo" implícito) — a
/// feature degrada, o app não quebra.
fn attach_provider_models(mut result: ModelDiscoveryResult) -> ModelDiscoveryResult {
    match provider_catalog::list_provider_models() {
        Ok(provider_models) => {
            if !provider_models.is_empty() {
                result.models.extend(provider_models);
                result.models = dedup_and_merge_models(result.models);
            }
        }
        Err(error) => result.provider_error = Some(error),
    }
    result
}

/// Merge de duas entradas do mesmo id. A entrada Router (provider ausente) é
/// a autoridade para identidade, contexto, capacidades e payload bruto. A
/// entrada CLI anexa somente o provider e preenche reasoning quando o Router
/// o omite. Assim nenhum metadado de capacidade do CLI — inclusive o antigo
/// default genérico de visão — substitui o `vision` verdadeiro do Router.
fn merge_duplicate_models(existing: VerbooModel, incoming: VerbooModel) -> VerbooModel {
    let (cli, mut router) = if existing.provider.is_some() {
        (existing, incoming)
    } else {
        (incoming, existing)
    };
    router.provider = cli.provider;
    if router.reasoning.is_none() {
        router.reasoning = cli.reasoning;
    }
    router
}

/// Deduplica modelos por id, fundindo campos quando o mesmo id aparece em
/// duas fontes (router + CLI). Preserva a ordem de primeira aparição.
fn dedup_and_merge_models(models: Vec<VerbooModel>) -> Vec<VerbooModel> {
    let mut by_id: std::collections::HashMap<String, VerbooModel> = std::collections::HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for m in models {
        if let Some(existing) = by_id.remove(&m.id) {
            by_id.insert(m.id.clone(), merge_duplicate_models(existing, m));
        } else {
            order.push(m.id.clone());
            by_id.insert(m.id.clone(), m);
        }
    }
    order
        .into_iter()
        .map(|id| by_id.remove(&id).unwrap())
        .collect()
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
    let reasoning = extract_reasoning(&obj);

    Some(VerbooModel {
        id,
        display_name,
        context_window,
        max_output_tokens,
        supports_vision,
        vision_support_source,
        reasoning,
        provider: None,
        raw: item.clone(),
    })
}

/// Extracts reasoning/effort metadata from the Router's raw model JSON.
/// Accepts `reasoning.effort_levels` / `reasoning.default_effort` (camelCase
/// or snake_case). Returns None when `effort_levels` is absent or empty —
/// the model has no effort UI. Does NOT filter levels by a hardcoded list;
/// any string[] the Router sends flows through (including future levels).
fn extract_reasoning(obj: &serde_json::Map<String, serde_json::Value>) -> Option<ModelReasoning> {
    let reasoning = obj.get("reasoning").and_then(|v| v.as_object())?;
    let effort_levels = reasoning
        .get("effort_levels")
        .or_else(|| reasoning.get("effortLevels"))
        .and_then(|v| v.as_array())?;
    let levels: Vec<String> = effort_levels
        .iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect();
    if levels.is_empty() {
        return None;
    }
    let default_effort = reasoning
        .get("default_effort")
        .or_else(|| reasoning.get("defaultEffort"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Some(ModelReasoning {
        effort_levels: levels,
        default_effort,
    })
}

fn detect_vision_support(
    obj: &serde_json::Map<String, serde_json::Value>,
) -> (Option<bool>, Option<String>) {
    // Direct boolean flags from Router payloads.
    for key in &[
        "supportsVision",
        "supports_vision",
        "vision",
        "hasVision",
        "has_vision",
        "visionCapable",
        "vision_capable",
        "supportsImages",
        "supports_images",
        "supportsImage",
        "supports_image",
        "imageInput",
        "image_input",
        "supportsImageInput",
        "supports_image_input",
        "imageInputSupported",
        "image_input_supported",
    ] {
        if let Some(v) = obj.get(*key) {
            if let Some(b) = v.as_bool() {
                return (Some(b), Some("router".into()));
            }
        }
    }

    // Capabilities object
    if let Some(caps) = obj.get("capabilities").and_then(|v| v.as_object()) {
        for key in &[
            "supportsVision",
            "supports_vision",
            "vision",
            "hasVision",
            "has_vision",
            "visionCapable",
            "vision_capable",
            "supportsImages",
            "supports_images",
            "supportsImage",
            "supports_image",
            "imageInput",
            "image_input",
            "supportsImageInput",
            "supports_image_input",
            "imageInputSupported",
            "image_input_supported",
        ] {
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

/// Returns true when the cached catalog contains zero entries with explicit
/// vision metadata. Used to detect caches written before the Router started
/// annotating models with vision flags, so a live refresh can backfill.
fn cache_lacks_vision_metadata(models: &[VerbooModel]) -> bool {
    if models.is_empty() {
        return false;
    }
    !models
        .iter()
        .any(|m| m.supports_vision.is_some() || model_raw_has_vision_metadata(&m.raw))
}

/// Returns true when the model's raw JSON contains any direct vision-related
/// boolean field. Captures fields that were not promoted to `supports_vision`
/// because they were absent at the time of the original fetch.
fn model_raw_has_vision_metadata(raw: &serde_json::Value) -> bool {
    let Some(obj) = raw.as_object() else {
        return false;
    };
    const KEYS: &[&str] = &[
        "supportsVision",
        "supports_vision",
        "vision",
        "hasVision",
        "has_vision",
        "visionCapable",
        "vision_capable",
        "supportsImages",
        "supports_images",
        "supportsImage",
        "supports_image",
        "imageInput",
        "image_input",
        "supportsImageInput",
        "supports_image_input",
        "imageInputSupported",
        "image_input_supported",
    ];
    for key in KEYS {
        if obj.get(*key).and_then(|v| v.as_bool()).is_some() {
            return true;
        }
    }
    if let Some(caps) = obj.get("capabilities").and_then(|v| v.as_object()) {
        for key in KEYS {
            if caps.get(*key).and_then(|v| v.as_bool()).is_some() {
                return true;
            }
        }
    }
    false
}

/// Re-runs detection on each cached model when its `supports_vision` field is
/// unset. This backfills vision metadata on caches written before the Router
/// started annotating models with vision flags, without overwriting explicit
/// `None` values that the Router intentionally returns as "no vision".
fn refresh_cached_vision_metadata(models: &mut [VerbooModel]) {
    for model in models.iter_mut() {
        if model.supports_vision.is_some() {
            continue;
        }
        if let Some(obj) = model.raw.as_object() {
            let (vision, source) = detect_vision_support(obj);
            if let Some(vision) = vision {
                model.supports_vision = Some(vision);
                model.vision_support_source = source;
            }
        }
    }
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
    fn vision_detection_router_supports_image() {
        let cases = [
            ("supportsImage", true),
            ("supports_image", true),
            ("imageInput", false),
            ("image_input", true),
            ("supportsImageInput", true),
            ("supports_image_input", true),
            ("imageInputSupported", false),
            ("image_input_supported", true),
        ];
        for (key, value) in cases {
            let obj = json!({ key: value });
            let (vision, source) = detect_vision_support(obj.as_object().unwrap());
            assert_eq!(
                vision,
                Some(value),
                "key {key} should resolve to {value}"
            );
            assert_eq!(
                source.as_deref(),
                Some("router"),
                "key {key} must be reported as router"
            );
        }
    }

    #[test]
    fn vision_detection_capabilities_supports_image() {
        let obj = json!({
            "capabilities": {
                "supports_image": true,
                "supports_image_input": false
            }
        });
        let (vision, source) = detect_vision_support(obj.as_object().unwrap());
        assert_eq!(vision, Some(true));
        assert_eq!(source.as_deref(), Some("raw-capabilities"));
    }

    #[test]
    fn vision_detection_modalities_with_image() {
        let obj = json!({
            "input_modalities": ["text", "image"]
        });
        let (vision, source) = detect_vision_support(obj.as_object().unwrap());
        assert_eq!(vision, Some(true));
        assert_eq!(source.as_deref(), Some("raw-capabilities"));

        let obj = json!({
            "capabilities": {
                "modalities": ["text", "vision"]
            }
        });
        let (vision, source) = detect_vision_support(obj.as_object().unwrap());
        assert_eq!(vision, Some(true));
        assert_eq!(source.as_deref(), Some("raw-capabilities"));
    }

    #[test]
    fn vision_detection_non_boolean_string_ignored() {
        // Only boolean triggers the router source. String values must fall through.
        let obj = json!({"supports_image": "yes"});
        let (vision, _) = detect_vision_support(obj.as_object().unwrap());
        assert_eq!(vision, None, "string 'yes' must not be treated as true");

        let obj = json!({"capabilities": {"supports_image": "true"}});
        let (vision, _) = detect_vision_support(obj.as_object().unwrap());
        assert_eq!(vision, None, "capabilities string must not be treated as true");
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
        // Models without any vision indicator should return None.
        // The Router API returns these fields for plan models — no vision
        // metadata, so detection returns None. Availability comes exclusively
        // from the Router response at runtime, NOT from a static vendor list.
        let obj = json!({"id": "deepseek-v4-flash"});
        let (vision, _) = detect_vision_support(obj.as_object().unwrap());
        assert_eq!(vision, None, "deepseek has no vision indicator");

        let obj = json!({"id": "ultra/glm-5.2"});
        let (vision, _) = detect_vision_support(obj.as_object().unwrap());
        assert_eq!(vision, None, "glm has no vision indicator");
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

    #[test]
    fn vision_detection_router_docs_shape_true() {
        // Exact shape from https://code.verboo.ai/pt/docs/api:
        // { "id": ..., "context_window": ..., "vision": true, "reasoning": { ... } }
        let obj = json!({
            "id": "vision-model",
            "context_window": 131072,
            "vision": true,
            "reasoning": {"effort_levels": ["low", "medium", "high"], "default_effort": "medium"}
        });
        let (vision, source) = detect_vision_support(obj.as_object().unwrap());
        assert_eq!(vision, Some(true));
        assert_eq!(source.as_deref(), Some("router"));
    }

    #[test]
    fn vision_detection_router_docs_shape_false() {
        // Router omits or false-explicitits the field. When present as `false`,
        // detection must honor it (no fallthrough to heuristic) and report router.
        let obj = json!({
            "id": "vision-model",
            "context_window": 131072,
            "vision": false
        });
        let (vision, source) = detect_vision_support(obj.as_object().unwrap());
        assert_eq!(vision, Some(false));
        assert_eq!(source.as_deref(), Some("router"));
    }

    #[test]
    fn vision_detection_router_aliases() {
        // Additional aliases the router might use across deployments.
        for (key, value) in [
            ("hasVision", true),
            ("has_vision", false),
            ("visionCapable", true),
            ("vision_capable", true),
            ("supportsImages", true),
            ("supports_images", false),
        ] {
            let obj = json!({ key: value });
            let (vision, source) = detect_vision_support(obj.as_object().unwrap());
            assert_eq!(
                vision,
                Some(value),
                "key {key} should resolve to {value}"
            );
            assert_eq!(
                source.as_deref(),
                Some("router"),
                "key {key} must be reported as router"
            );
        }
    }

    #[test]
    fn refresh_cached_vision_metadata_backfills_from_raw() {
        // Simulates an old cache that lacks `supports_vision` because it was
        // written before the router started sending the `vision` flag.
        let mut models = vec![VerbooModel {
            id: "x".into(),
            display_name: "X".into(),
            context_window: Some(131072),
            max_output_tokens: None,
            supports_vision: None,
            vision_support_source: None,
            reasoning: None,
            provider: None,
            raw: json!({"id": "x", "vision": true}),
        }];
        refresh_cached_vision_metadata(&mut models);
        assert_eq!(models[0].supports_vision, Some(true));
        assert_eq!(models[0].vision_support_source.as_deref(), Some("router"));
    }

    #[test]
    fn refresh_cached_vision_metadata_preserves_explicit_none() {
        // When the cache already has supports_vision set (including Some(true)
        // after a previous backfill), re-running detection is a no-op.
        let mut models = vec![VerbooModel {
            id: "y".into(),
            display_name: "Y".into(),
            context_window: Some(131072),
            max_output_tokens: None,
            supports_vision: Some(false),
            vision_support_source: Some("router".into()),
            reasoning: None,
            provider: None,
            raw: json!({"id": "y"}),
        }];
        refresh_cached_vision_metadata(&mut models);
        assert_eq!(models[0].supports_vision, Some(false));
    }

    #[test]
    fn cache_lacks_vision_metadata_flags_blank_catalog() {
        let models = vec![
            VerbooModel {
                id: "a".into(),
                display_name: "A".into(),
                context_window: None,
                max_output_tokens: None,
                supports_vision: None,
                vision_support_source: None,
                reasoning: None,
                provider: None,
                raw: json!({"id": "a"}),
            },
            VerbooModel {
                id: "b".into(),
                display_name: "B".into(),
                context_window: None,
                max_output_tokens: None,
                supports_vision: None,
                vision_support_source: None,
                reasoning: None,
                provider: None,
                raw: json!({"id": "b"}),
            },
        ];
        assert!(cache_lacks_vision_metadata(&models));
    }

    #[test]
    fn extract_reasoning_deepseek_shape() {
        // Real shape from Router cache: deepseek-v4-flash
        let obj = json!({
            "id": "deepseek-v4-flash",
            "reasoning": { "default_effort": "high", "effort_levels": ["high", "max"] }
        });
        let m = extract_reasoning(obj.as_object().unwrap()).unwrap();
        assert_eq!(m.effort_levels, vec!["high", "max"]);
        assert_eq!(m.default_effort.as_deref(), Some("high"));
    }

    #[test]
    fn extract_reasoning_glm52_shape() {
        // Real shape: glm-5.2 with "none" as an explicit level
        let obj = json!({
            "id": "glm-5.2",
            "reasoning": { "default_effort": "none", "effort_levels": ["none", "high", "max"] }
        });
        let m = extract_reasoning(obj.as_object().unwrap()).unwrap();
        assert_eq!(m.effort_levels, vec!["none", "high", "max"]);
        assert_eq!(m.default_effort.as_deref(), Some("none"));
    }

    #[test]
    fn extract_reasoning_kimi_shape_no_reasoning() {
        // kimi-k2.7 has no reasoning field in raw
        let obj = json!({
            "id": "kimi-k2.7",
            "context_window": 262144,
            "vision": true
        });
        assert!(extract_reasoning(obj.as_object().unwrap()).is_none());
    }

    #[test]
    fn extract_reasoning_empty_levels_returns_none() {
        let obj = json!({
            "id": "test",
            "reasoning": { "effort_levels": [] }
        });
        assert!(extract_reasoning(obj.as_object().unwrap()).is_none());
    }

    #[test]
    fn extract_reasoning_camel_case_keys() {
        // Future-proof: accept camelCase if Router ever sends it
        let obj = json!({
            "id": "test",
            "reasoning": { "defaultEffort": "medium", "effortLevels": ["low", "medium", "high"] }
        });
        let m = extract_reasoning(obj.as_object().unwrap()).unwrap();
        assert_eq!(m.effort_levels, vec!["low", "medium", "high"]);
        assert_eq!(m.default_effort.as_deref(), Some("medium"));
    }

    #[test]
    fn cache_lacks_vision_metadata_false_when_any_model_has_field() {
        let models = vec![VerbooModel {
            id: "a".into(),
            display_name: "A".into(),
            context_window: None,
            max_output_tokens: None,
            supports_vision: Some(false),
            vision_support_source: Some("router".into()),
            reasoning: None,
            provider: None,
            raw: json!({"id": "a", "vision": false}),
        }];
        assert!(!cache_lacks_vision_metadata(&models));
    }

    // ── F2-PROVIDERS: merge best-effort com o catálogo do CLI ──────────

    fn write_fake_cli(stdout_body: &str, suffix: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "verboo-model-service-fake-cli-{}-{suffix}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cli.mjs");
        let script = format!("console.log({stdout_body:?});\n");
        std::fs::write(&path, script).unwrap();
        // SAFETY: env var global intencional, serializado pelo guard.
        unsafe {
            std::env::set_var("VERBOO_CLI_PATH", &path);
        }
        path
    }

    fn clear_fake_cli() {
        unsafe {
            std::env::remove_var("VERBOO_CLI_PATH");
        }
    }

    fn base_discovery_result() -> ModelDiscoveryResult {
        ModelDiscoveryResult {
            models: vec![VerbooModel {
                id: "verboo-pro-1".into(),
                display_name: "Verboo Pro 1".into(),
                context_window: Some(131072),
                max_output_tokens: None,
                supports_vision: Some(true),
                vision_support_source: Some("router".into()),
                reasoning: None,
                provider: None,
                raw: json!({"id": "verboo-pro-1"}),
            }],
            source: "api-key".into(),
            stale: false,
            error: None,
            provider_error: None,
        }
    }

    #[test]
    fn attach_provider_models_extends_catalog_with_cli_models() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        write_fake_cli(
            r#"{"provider":"codex","id":"codex-opus-4-6","displayName":"Codex Opus 4.6","contextWindow":200000}
{"provider":"claude","id":"claude-sonnet-4-6","displayName":"Claude Sonnet 4.6","contextWindow":200000}"#,
            "ok",
        );
        let merged = attach_provider_models(base_discovery_result());
        clear_fake_cli();
        let providers: Vec<Option<String>> = merged.models.iter().map(|m| m.provider.clone()).collect();
        assert!(
            providers.contains(&Some("codex".to_string())),
            "o catálogo deve ganhar os modelos de provedor do CLI: {providers:?}"
        );
        assert!(
            providers.contains(&Some("claude".to_string())),
            "o catálogo deve ganhar os modelos de provedor do CLI: {providers:?}"
        );
        assert_eq!(
            merged.models.len(),
            3,
            "1 modelo verboo do router + 2 modelos de provedor do CLI"
        );
        assert!(
            merged.provider_error.is_none(),
            "uma listagem saudável não deve inventar aviso de provedor"
        );
    }

    #[test]
    fn attach_provider_models_degrades_gracefully_on_cli_failure() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // A saída REAL do CLI não-autenticado (medição do Prumo).
        write_fake_cli(
            "Não autenticado no Verboo. Execute `verboo /login` em um terminal interativo antes de usar o modo headless.",
            "fail",
        );
        let merged = attach_provider_models(base_discovery_result());
        clear_fake_cli();
        assert_eq!(
            merged.models.len(),
            1,
            "falha da listagem do CLI → o catálogo atual continua como hoje (sem provedores)"
        );
        assert_eq!(merged.models[0].provider, None, "provider implícito verboo");
        assert!(
            merged
                .provider_error
                .as_deref()
                .is_some_and(|error| error.contains("não retornou modelos")),
            "a degradação precisa ser explícita para o renderer: {:?}",
            merged.provider_error
        );
    }

    /// (a) duas entradas do mesmo id → UMA com os campos das duas fontes.
    /// Regra de campo casada com renderer `dedupModels` (providerCatalog.ts).
    #[test]
    fn dedup_and_merge_models_fuses_same_id_preserving_fields_from_both() {
        let router_model = VerbooModel {
            id: "glm-5.2".into(),
            display_name: "GLM 5.2".into(),
            context_window: Some(131072),
            max_output_tokens: Some(8192),
            supports_vision: Some(false),
            vision_support_source: Some("router".into()),
            reasoning: None,
            provider: None,
            raw: json!({"id": "glm-5.2", "source": "router"}),
        };
        let cli_model = VerbooModel {
            id: "glm-5.2".into(),
            display_name: "GLM 5.2".into(),
            context_window: Some(999999),
            max_output_tokens: None,
            supports_vision: Some(true),
            vision_support_source: Some("cli".into()),
            reasoning: Some(ModelReasoning {
                effort_levels: vec!["high".into(), "max".into()],
                default_effort: Some("high".into()),
            }),
            provider: Some("verboo".into()),
            raw: json!({"id": "glm-5.2", "source": "cli"}),
        };
        // Ordem router-then-CLI (caso de campo: roteador devolve primeiro).
        let merged = dedup_and_merge_models(vec![router_model.clone(), cli_model.clone()]);
        assert_eq!(merged.len(), 1, "duas entradas do mesmo id → uma");
        let m = &merged[0];
        assert_eq!(m.provider, Some("verboo".to_string()), "CLI vence provider");
        assert_eq!(
            m.max_output_tokens,
            Some(8192),
            "router preenche max_output_tokens (CLI nao tem)"
        );
        assert_eq!(m.context_window, Some(131072), "router vence context_window");
        assert_eq!(m.supports_vision, Some(false), "router vence supports_vision");
        assert_eq!(
            m.vision_support_source.as_deref(),
            Some("router"),
            "router vence vision_support_source"
        );
        assert_eq!(
            m.raw, json!({"id": "glm-5.2", "source": "router"}),
            "router vence raw"
        );
        assert_eq!(
            m.reasoning.as_ref().map(|value| value.effort_levels.as_slice()),
            Some(["high".to_string(), "max".to_string()].as_slice()),
            "CLI backfills reasoning quando o router omite"
        );
        // Ordem CLI-then-router (simétrica — merge nao depende de ordem).
        let merged_rev = dedup_and_merge_models(vec![cli_model, router_model]);
        assert_eq!(merged_rev.len(), 1, "ordem inversa tambem dedup");
        assert_eq!(
            merged_rev[0].provider,
            Some("verboo".to_string()),
            "CLI vence independente da ordem"
        );
        assert_eq!(
            merged_rev[0].max_output_tokens,
            Some(8192),
            "router preenche independente da ordem"
        );
        assert_eq!(merged_rev[0].context_window, Some(131072));
        assert_eq!(merged_rev[0].supports_vision, Some(false));
        assert_eq!(merged_rev[0].vision_support_source.as_deref(), Some("router"));
    }

    /// (b) modelo que existe em apenas uma fonte sobrevive intacto.
    /// Direção só-roteador.
    #[test]
    fn dedup_and_merge_models_preserves_router_only_model_intact() {
        let router_only = VerbooModel {
            id: "verboo-pro-1".into(),
            display_name: "Verboo Pro 1".into(),
            context_window: Some(131072),
            max_output_tokens: Some(8192),
            supports_vision: Some(true),
            vision_support_source: Some("router".into()),
            reasoning: None,
            provider: None,
            raw: json!({"id": "verboo-pro-1"}),
        };
        let merged = dedup_and_merge_models(vec![router_only.clone()]);
        assert_eq!(merged.len(), 1, "modelo unico sobrevive");
        assert_eq!(merged[0].id, "verboo-pro-1");
        assert_eq!(merged[0].provider, None, "router-only: provider ausente preservado");
        assert_eq!(merged[0].max_output_tokens, Some(8192));
        assert_eq!(merged[0].supports_vision, Some(true));
    }

    /// (b) Direção só-CLI.
    #[test]
    fn dedup_and_merge_models_preserves_cli_only_model_intact() {
        let cli_only = VerbooModel {
            id: "codex-opus-4-6".into(),
            display_name: "Codex Opus 4.6".into(),
            context_window: Some(200000),
            max_output_tokens: None,
            supports_vision: Some(true),
            vision_support_source: Some("cli".into()),
            reasoning: None,
            provider: Some("codex".into()),
            raw: json!({"id": "codex-opus-4-6"}),
        };
        let merged = dedup_and_merge_models(vec![cli_only.clone()]);
        assert_eq!(merged.len(), 1, "modelo unico sobrevive");
        assert_eq!(merged[0].id, "codex-opus-4-6");
        assert_eq!(
            merged[0].provider,
            Some("codex".to_string()),
            "cli-only: provider preservado"
        );
        assert_eq!(merged[0].max_output_tokens, None, "cli-only: max_output_tokens ausente preservado");
    }
}
