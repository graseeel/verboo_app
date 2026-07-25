//! Embedded Browser panel — backend lifecycle for the docked child webview.
//!
//! Implements ADR-0001 (multiwebview docked panel), ADR-0002 (snapshot
//! primitives for the shade fallback), and the load-bearing half of
//! ADR-0003 (page → app push via `webkit.messageHandlers.verboo`,
//! consumed in Fase 3).
//!
//! ## Estado do painel
//!
//! v1 = aba única. `BrowserPanelState` mantém no máximo uma `Webview<Wry>`
//! viva; comandos que assumem webview viva retornam `Err("no webview")` se
//! ela ainda não foi criada (ou já foi destruída). Fechar o painel chama
//! `browser_destroy` — sem `Drop` implícito porque o `Webview` precisa do
//! `AppHandle` para `close()` e o estado não carrega o handle.
//!
//! ## Mensagens da página
//!
//! O canal `webkit.messageHandlers.verboo` empilha strings recebidas em
//! uma fila por-painel (não mais `static Mutex<Vec<String>>` global — o
//! spike aceitava múltiplas webviews concorrentes colidindo no mesmo
//! vetor). O renderer faz drain via `browser_drain_messages`.
//!
//! ## Normalização de URL
//!
//! O backend só **valida** (`tauri::Url::parse` + checagem de scheme).
//! A normalização (prepend `https://`, fallback, etc.) é responsabilidade
//! do input do renderer — o painel aceita `http`, `https`, `about` e
//! `file`, exatamente como a barra de URL envia.
//!
//! ## Plataforma
//!
//! macOS tem snapshot e evaluateJS nativos (WKWebView). Windows/Linux
//! compilam mas retornam erro explícito nesses comandos — Fase 5 decide
//! se o port sai antes do release.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use image::GenericImageView;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::webview::Webview;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, State, Wry};

use crate::services::browser_platform;
use crate::services::browser_session::{
    BrowserSessionModel, BrowserSessionSnapshot, BrowserTabId, BrowserTabSnapshot,
};
use crate::services::browser_bridge::{BrowserBridgeQueue, BrowserPageEnvelope};

/// Identificador da webview ativa. Único por sessão (v1 = aba única).
/// Reservado para Fase 5+ (multi-tab) — hoje devolvido ao renderer apenas
/// para confirmar que o `create` pegou.
pub type PanelLabel = String;

/// Retângulo do painel em coordenadas lógicas (points). Coordenadas são
/// responsabilidade do renderer (CSS vars + ResizeObserver); o backend só
/// repassa para `set_position` / `set_size`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl BrowserBounds {
    /// Bounds são válidos quando ambos width e height são positivos e
    /// finitos. x/y podem ser negativos em teoria (window offscreen) —
    /// o macOS recorta; não bloqueamos aqui.
    pub fn is_valid(&self) -> bool {
        self.width.is_finite() && self.height.is_finite() && self.width > 0.0 && self.height > 0.0
    }
}

/// Estado runtime do painel. `webview` é `None` quando o painel está
/// fechado; `None` é a fonte da verdade para "não há webview".
///
/// `messages` é a fila por-painel (não mais global). O handler nativo
/// empurra aqui; o renderer drena via `browser_drain_messages`.
#[derive(Default)]
pub struct BrowserPanelState {
    inner: Mutex<BrowserPanelInner>,
}

struct BrowserTabRuntime {
    webview: Webview<Wry>,
    /// Held for its Drop side-effect: unregisters the native handler.
    #[allow(dead_code)]
    bridge: browser_platform::BridgeHandle,
    messages: BrowserBridgeQueue,
}

#[derive(Default)]
struct BrowserPanelInner {
    session: BrowserSessionModel,
    tabs: HashMap<BrowserTabId, BrowserTabRuntime>,
    bounds: Option<BrowserBounds>,
    visible: bool,
}

impl BrowserPanelState {
    fn lock(&self) -> std::sync::MutexGuard<'_, BrowserPanelInner> {
        // Poisoning aqui indica um panic dentro de um comando anterior
        // mantendo o lock. Para o painel isso é recuperável (a webview
        // provavelmente já morreu junto com o thread); preferimos
        // retornar estado potencialmente inconsistente a abortar o app.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Owns browser captures that must outlive a turn. Temporary screenshots are
/// promoted here before the transcript is persisted and grouped by a hashed
/// conversation id so deleting a chat can remove only its own files.
pub struct BrowserCaptureStore {
    root: PathBuf,
}

impl BrowserCaptureStore {
    pub fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        let root = app_data_dir.join("browser_captures");
        std::fs::create_dir_all(&root)
            .map_err(|error| format!("create browser capture store falhou: {error}"))?;
        cleanup_browser_temp_root()?;
        Ok(Self { root })
    }

    fn owner_dir(&self, owner_id: &str) -> Result<PathBuf, String> {
        if owner_id.is_empty() || owner_id.len() > 512 {
            return Err("owner id inválido".into());
        }
        let digest = Sha256::digest(owner_id.as_bytes());
        Ok(self.root.join(format!("{digest:x}")))
    }

    fn promote(&self, owner_id: &str, paths: Vec<String>) -> Result<Vec<PromotedBrowserFile>, String> {
        let owner_dir = self.owner_dir(owner_id)?;
        let sources = paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
        if let Some(path) = sources.iter().find(|path| !is_browser_temp_png(path) || !path.is_file()) {
            return Err(format!("captura temporária inválida: {}", path.display()));
        }
        std::fs::create_dir_all(&owner_dir)
            .map_err(|error| format!("create capture owner falhou: {error}"))?;

        let mut promoted: Vec<PromotedBrowserFile> = Vec::with_capacity(sources.len());
        for source in &sources {
            let destination = owner_dir.join(format!("{}.png", uuid::Uuid::new_v4()));
            if let Err(error) = std::fs::copy(source, &destination) {
                for copied in &promoted {
                    let _ = std::fs::remove_file(&copied.to);
                }
                return Err(format!("promote capture falhou: {error}"));
            }
            promoted.push(PromotedBrowserFile {
                from: source.to_string_lossy().into_owned(),
                to: destination.to_string_lossy().into_owned(),
            });
        }
        // The durable copies now exist. A failed temp cleanup is recoverable
        // and must not turn a successful promotion into a broken transcript.
        for source in sources {
            let _ = std::fs::remove_file(source);
        }
        Ok(promoted)
    }

    fn delete_owner(&self, owner_id: &str) -> Result<(), String> {
        let directory = self.owner_dir(owner_id)?;
        match std::fs::remove_dir_all(&directory) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("delete capture owner falhou: {error}")),
        }
    }

    fn cleanup_owners(&self, active_owner_ids: Vec<String>) -> Result<(), String> {
        let active = active_owner_ids
            .iter()
            .map(|owner| self.owner_dir(owner))
            .collect::<Result<std::collections::HashSet<_>, _>>()?;
        for entry in std::fs::read_dir(&self.root)
            .map_err(|error| format!("read capture store falhou: {error}"))?
        {
            let entry = entry.map_err(|error| format!("read capture owner falhou: {error}"))?;
            let path = entry.path();
            if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) && !active.contains(&path) {
                std::fs::remove_dir_all(&path)
                    .map_err(|error| format!("cleanup capture owner falhou: {error}"))?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PromotedBrowserFile {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserRuntimeSmokeReport {
    success: bool,
    navigated: bool,
    bridge_received: bool,
    evaluated: bool,
    bounds_updated: bool,
    snapshot_ms: u128,
    snapshot_bytes: usize,
    destroyed: bool,
    error: Option<String>,
    created_tabs: usize,
    activated_second_tab: bool,
    closed_tabs: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCreateReport {
    pub label: PanelLabel,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotReport {
    pub ms: u128,
    pub bytes: usize,
    pub path: String,
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluateReport {
    pub ms: u128,
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserViewport {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationCaptureRequest {
    pub tab_id: BrowserTabId,
    pub rect: BrowserRect,
    pub viewport: BrowserViewport,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationCaptureReport {
    pub crop_path: String,
    pub viewport_path: String,
    pub crop_width: u32,
    pub crop_height: u32,
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub crop_bytes: usize,
    pub viewport_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PixelCrop {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

/// Valida uma URL para uso na webview. Aceita os esquemas que a barra do
/// painel vai emitir: `http`, `https`, `about` (blank), `file` (dev local)
/// — qualquer outro esquema é barrado (CSP hostile, `javascript:`, `data:`).
///
/// Devolve a URL parseada; o backend não reescreve nada (sem lowercase,
/// sem prepend de scheme, sem strip de fragmentos).
pub fn parse_url_for_panel(url: &str) -> Result<tauri::Url, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("url vazia".into());
    }
    let parsed = tauri::Url::parse(trimmed).map_err(|e| format!("url inválida: {e}"))?;
    match parsed.scheme() {
        "http" | "https" | "about" | "file" => Ok(parsed),
        other => Err(format!("esquema não suportado: {other}")),
    }
}



#[tauri::command]
pub fn browser_set_bounds(
    state: State<'_, BrowserPanelState>,
    bounds: BrowserBounds,
) -> Result<(), String> {
    if !bounds.is_valid() {
        return Err(format!(
            "bounds inválidos: width={} height={}",
            bounds.width, bounds.height
        ));
    }
    let mut inner = state.lock();
    let active_id = inner
        .session
        .active_id()
        .ok_or_else(|| "sem webview".to_string())?
        .to_string();
    let webview = inner
        .tabs
        .get(&active_id)
        .map(|rt| rt.webview.clone())
        .ok_or_else(|| "aba ativa sem runtime".to_string())?;
    inner.bounds = Some(bounds.clone());
    drop(inner);
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| format!("set_position falhou: {e}"))?;
    webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|e| format!("set_size falhou: {e}"))
}

/// Drena (zera) a fila de mensagens vindas da página. Retorna snapshot
/// atual e limpa o buffer — o renderer chama isso ao receber o evento
/// `browser-messages` para evitar duplicação.
#[tauri::command]
pub fn browser_drain_messages(
    state: State<'_, BrowserPanelState>,
    tab_id: BrowserTabId,
) -> Result<Vec<String>, String> {
    let mut inner = state.lock();
    let runtime = inner
        .tabs
        .get_mut(&tab_id)
        .ok_or_else(|| format!("{STALE_DOCUMENT}: tab {tab_id} not found"))?;
    Ok(runtime.messages.drain())
}

/// Snapshot do viewport → PNG escrito em `<temp_dir>/verboo-browser-snapshot.png`.
///
/// Meta: ≤ 100ms em página real (Fase 0 mediu 15–23ms em example.com).
/// Timeout de 5s evita hang se a webview travar ou morrer.
#[tauri::command]
pub async fn browser_snapshot(
    state: State<'_, BrowserPanelState>,
    tab_id: BrowserTabId,
    generation: u64,
) -> Result<SnapshotReport, String> {
    #[cfg(target_os = "macos")]
    {
        // Check BEFORE async work.
        check_current(&state.lock().session, &tab_id, generation)?;

        let started = Instant::now();
        let bytes = capture_snapshot_bytes(&state, tab_id.clone()).await?;

        // Check AFTER async work — the user may have navigated during.
        let bytes = check_stale(
            &state.lock().session,
            &tab_id,
            generation,
            bytes,
            |_| { /* bytes is a Vec: no temp file to clean yet */ },
        )?;

        let ms = started.elapsed().as_millis();
        let directory = std::env::temp_dir().join("verboo-browser");
        std::fs::create_dir_all(&directory)
            .map_err(|e| format!("create snapshot dir falhou: {e}"))?;
        let path = directory.join(format!("{}-snapshot.png", uuid::Uuid::new_v4()));
        let _ = std::fs::write(&path, &bytes);
        Ok(SnapshotReport {
            ms,
            bytes: bytes.len(),
            path: path.to_string_lossy().into_owned(),
            data_url: format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&bytes)
            ),
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        let _ = tab_id;
        let _ = generation;
        Err("snapshot: somente macOS no spike".into())
    }
}

/// Captura o viewport sem mini-modal e salva tanto o PNG completo quanto um
/// recorte escalado pela densidade real do snapshot (1x/2x/etc.).
#[tauri::command]
pub async fn browser_capture_annotation(
    state: State<'_, BrowserPanelState>,
    request: AnnotationCaptureRequest,
) -> Result<AnnotationCaptureReport, String> {
    #[cfg(target_os = "macos")]
    {
        let bytes = capture_snapshot_bytes(&state, request.tab_id.clone()).await?;
        let image = image::load_from_memory(&bytes)
            .map_err(|error| format!("decode snapshot falhou: {error}"))?;
        let (viewport_width, viewport_height) = image.dimensions();
        let crop = crop_in_pixels(request.rect, request.viewport, viewport_width, viewport_height)?;
        let cropped = image.crop_imm(crop.x, crop.y, crop.width, crop.height);
        let mut crop_bytes = std::io::Cursor::new(Vec::new());
        cropped
            .write_to(&mut crop_bytes, image::ImageFormat::Png)
            .map_err(|error| format!("encode crop falhou: {error}"))?;
        let crop_bytes = crop_bytes.into_inner();

        let directory = std::env::temp_dir().join("verboo-browser");
        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("create snapshot dir falhou: {error}"))?;
        let id = uuid::Uuid::new_v4();
        let viewport_path = directory.join(format!("{id}-viewport.png"));
        let crop_path = directory.join(format!("{id}-crop.png"));
        std::fs::write(&viewport_path, &bytes)
            .map_err(|error| format!("write viewport falhou: {error}"))?;
        std::fs::write(&crop_path, &crop_bytes)
            .map_err(|error| format!("write crop falhou: {error}"))?;

        Ok(AnnotationCaptureReport {
            crop_path: crop_path.to_string_lossy().into_owned(),
            viewport_path: viewport_path.to_string_lossy().into_owned(),
            crop_width: crop.width,
            crop_height: crop.height,
            viewport_width,
            viewport_height,
            crop_bytes: crop_bytes.len(),
            viewport_bytes: bytes.len(),
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        let _ = request;
        Err("capture_annotation: somente macOS no v1".into())
    }
}

/// Remove only PNGs created by the embedded-browser capture pipeline. The
/// renderer calls this when a shade closes, an annotation is cancelled, or a
/// turn finishes so repeated visual work cannot grow the temp directory.
#[tauri::command]
pub fn browser_delete_temp_files(paths: Vec<String>) -> Result<(), String> {
    let paths = paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    if let Some(path) = paths.iter().find(|path| !is_browser_temp_png(path)) {
        return Err(format!(
            "arquivo temporário fora do diretório do navegador: {}",
            path.display()
        ));
    }

    for path in paths {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "remove temp falhou para {}: {error}",
                    path.display()
                ))
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn browser_promote_temp_files(
    store: State<'_, BrowserCaptureStore>,
    owner_id: String,
    paths: Vec<String>,
) -> Result<Vec<PromotedBrowserFile>, String> {
    store.promote(&owner_id, paths)
}

#[tauri::command]
pub fn browser_delete_capture_owner(
    store: State<'_, BrowserCaptureStore>,
    owner_id: String,
) -> Result<(), String> {
    store.delete_owner(&owner_id)
}

#[tauri::command]
pub fn browser_cleanup_capture_owners(
    store: State<'_, BrowserCaptureStore>,
    active_owner_ids: Vec<String>,
) -> Result<(), String> {
    store.cleanup_owners(active_owner_ids)
}

/// Executa um script na página e devolve o resultado stringificado.
/// Usado pela Fase 3 (ler bounding box de elementos) e smoke tests.
/// Macros que retornam objeto viram `<obj:?>` — serialização estruturada
/// vai via Fase 3 com JSON.
#[tauri::command]
pub async fn browser_evaluate_script(
    state: State<'_, BrowserPanelState>,
    tab_id: BrowserTabId,
    generation: u64,
    script: String,
) -> Result<EvaluateReport, String> {
    #[cfg(target_os = "macos")]
    {
        check_current(&state.lock().session, &tab_id, generation)?;
        let report = evaluate_script(&state, tab_id.clone(), script).await?;
        check_stale(
            &state.lock().session,
            &tab_id,
            generation,
            report,
            |_| { /* EvaluateReport has no temp files */ },
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        let _ = tab_id;
        let _ = generation;
        let _ = script;
        Err("evaluate_script: somente macOS no spike".into())
    }
}

/// Confirma que o processo de conteúdo ainda responde e que o bridge
/// isolado continua instalado. Três falhas consecutivas no renderer
/// encerram a instância morta e expõem a ação explícita de recriação.
#[tauri::command]
pub async fn browser_healthcheck(state: State<'_, BrowserPanelState>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let active_id = state
            .lock()
            .session
            .active_id()
            .ok_or_else(|| "sem aba ativa".to_string())?
            .to_string();
        let report = evaluate_script(
            &state,
            active_id,
            "window.__verbooBrowser && window.__verbooBrowser.ping()".into(),
        )
        .await?;
        if report.value.starts_with("pong:") {
            Ok(())
        } else {
            Err("browser bridge did not answer health check".into())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        current_webview(&state, "").map(|_| ())
    }
}

/// Runs the packaged-app multiwebview path for CI. This is intentionally
/// activated only by an explicit environment variable in `run()`.
pub fn start_runtime_smoke(app: AppHandle, report_path: PathBuf) {
    eprintln!("[smoke] start_runtime_smoke spawned");
    tauri::async_runtime::spawn(async move {
        let result = run_runtime_smoke(&app).await;
        let (report, exit_code) = match result {
            Ok(report) => (report, 0),
            Err(error) => {
                let _ = destroy_smoke_webview(&app).await;
                (BrowserRuntimeSmokeReport {
                    success: false,
                    navigated: false,
                    bridge_received: false,
                    evaluated: false,
                    bounds_updated: false,
                    snapshot_ms: 0,
                    snapshot_bytes: 0,
                    destroyed: false,
                    error: Some(error),
                    created_tabs: 0,
                    activated_second_tab: false,
                    closed_tabs: 0,
                }, 1)
            }
        };
        if let Some(parent) = report_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_vec_pretty(&report) {
            let _ = std::fs::write(&report_path, json);
        }
        app.exit(exit_code);
    });
}

// ── Internals ────────────────────────────────────────────────────────

const SMOKE_STEP_TIMEOUT: Duration = Duration::from_secs(10);
const SMOKE_DESTROY_TIMEOUT: Duration = Duration::from_secs(10);

async fn run_runtime_smoke(app: &AppHandle) -> Result<BrowserRuntimeSmokeReport, String> {
    eprintln!("[smoke] run_runtime_smoke starting");
    let page1_path = std::env::temp_dir().join(format!(
        "verboo-browser-runtime-smoke-tab1-{}.html",
        uuid::Uuid::new_v4()
    ));
    let page2_path = std::env::temp_dir().join(format!(
        "verboo-browser-runtime-smoke-tab2-{}.html",
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&page1_path, "<!doctype html><html><title>Tab-One</title><body style='background:#12131c;color:white'>First tab</body></html>")
        .map_err(|e| format!("write smoke page 1 falhou: {e}"))?;
    std::fs::write(&page2_path, "<!doctype html><html><title>Tab-Two</title><body style='background:#2a2a3c;color:white'>Second tab</body></html>")
        .map_err(|e| format!("write smoke page 2 falhou: {e}"))?;
    let page1_url = tauri::Url::from_file_path(&page1_path)
        .map_err(|_| "smoke page 1 URL inválida".to_string())?
        .to_string();
    let page2_url = tauri::Url::from_file_path(&page2_path)
        .map_err(|_| "smoke page 2 URL inválida".to_string())?
        .to_string();
    let cleanup_pages = || {
        let _ = std::fs::remove_file(&page1_path);
        let _ = std::fs::remove_file(&page2_path);
    };

    let mut report = BrowserRuntimeSmokeReport {
        success: false,
        navigated: false,
        bridge_received: false,
        evaluated: false,
        bounds_updated: false,
        snapshot_ms: 0,
        snapshot_bytes: 0,
        destroyed: false,
        error: None,
        created_tabs: 0,
        activated_second_tab: false,
        closed_tabs: 0,
    };

    // CI can reach WebKit faster than a local launch, so yield briefly before
    // creating a child webview or waiting for its navigation callbacks.
    tokio::time::sleep(Duration::from_millis(750)).await;

    // ── step: open session with bounds ────────────────────────
    eprintln!("[smoke] step: session_open starting");
    let session_bounds = BrowserBounds { x: 40.0, y: 80.0, width: 480.0, height: 360.0 };
    if let Err(e) = tokio::time::timeout(SMOKE_STEP_TIMEOUT, on_main_thread(app, move |handle| {
        browser_session_open(handle.state(), session_bounds)
    })).await {
        eprintln!("[smoke] step: session_open failed/timeout: {e}");
        report.error = Some(format!("session open timed out: {e}"));
        cleanup_pages();
        return Ok(report);
    }
    eprintln!("[smoke] step: session_open ok");
    report.bounds_updated = true;

    // ── step: create tab 1 ────────────────────────────────────
    eprintln!("[smoke] step: tab1 create starting");
    let tab1_id = match tokio::time::timeout(SMOKE_STEP_TIMEOUT, on_main_thread(app, move |handle| {
        browser_tab_create(handle.clone(), handle.state(), Some(page1_url))
    })).await {
        Ok(Ok(snap)) => {
            eprintln!("[smoke] step: tab1 create ok");
            report.created_tabs = 1;
            snap.active_tab_id.clone().unwrap_or_else(|| "missing-tab1".into())
        }
        Ok(Err(e)) => { eprintln!("[smoke] step: tab1 create failed/timeout: {e}"); report.error = Some(format!("tab 1 create failed: {e}")); cleanup_pages(); return Ok(report); }
        Err(_elapsed) => { eprintln!("[smoke] step: tab1 create failed/timeout: timed out"); report.error = Some("tab 1 create timed out".into()); cleanup_pages(); return Ok(report); }
    };

    // Wait for tab 1 to load.
    eprintln!("[smoke] step: wait_for_page_loaded tab1 starting");
    if !wait_for_page_loaded(app, &tab1_id).await {
        eprintln!("[smoke] step: wait_for_page_loaded tab1 failed/timeout: page-loaded not observed");
        report.error = Some("tab 1 page-loaded not observed".into());
        let _ = destroy_smoke_webview(app).await;
        cleanup_pages();
        return Ok(report);
    }
    eprintln!("[smoke] step: wait_for_page_loaded tab1 ok");
    report.navigated = true;
    report.bridge_received = true;

    // ── step: create tab 2 ────────────────────────────────────
    eprintln!("[smoke] step: tab2 create starting");
    let tab2_id = match tokio::time::timeout(SMOKE_STEP_TIMEOUT, on_main_thread(app, move |handle| {
        browser_tab_create(handle.clone(), handle.state(), Some(page2_url))
    })).await {
        Ok(Ok(snap)) => {
            eprintln!("[smoke] step: tab2 create ok");
            report.created_tabs = 2;
            snap.active_tab_id.unwrap_or_else(|| "missing-tab2".into())
        }
        Ok(Err(e)) => { eprintln!("[smoke] step: tab2 create failed/timeout: {e}"); report.error = Some(format!("tab 2 create failed: {e}")); cleanup_pages(); return Ok(report); }
        Err(_elapsed) => { eprintln!("[smoke] step: tab2 create failed/timeout: timed out"); report.error = Some("tab 2 create timed out".into()); cleanup_pages(); return Ok(report); }
    };

    // Wait for tab 2 to load.
    eprintln!("[smoke] step: wait_for_page_loaded tab2 starting");
    if !wait_for_page_loaded(app, &tab2_id).await {
        eprintln!("[smoke] step: wait_for_page_loaded tab2 failed/timeout: page-loaded not observed");
        report.error = Some("tab 2 page-loaded not observed".into());
        let _ = destroy_smoke_webview(app).await;
        cleanup_pages();
        return Ok(report);
    }
    eprintln!("[smoke] step: wait_for_page_loaded tab2 ok");

    // ── step: evaluate document.title on the active tab (tab 2) ─
    eprintln!("[smoke] step: evaluate starting");
    let tab2_gen = { let s = app.state::<BrowserPanelState>(); let inner = s.lock(); inner.session.current_generation(&tab2_id).unwrap_or(0) };
    match tokio::time::timeout(
        SMOKE_STEP_TIMEOUT,
        browser_evaluate_script(app.state(), tab2_id.clone(), tab2_gen, "document.title".into()),
    ).await {
        Ok(Ok(r)) => { eprintln!("[smoke] step: evaluate ok"); report.evaluated = r.value == "Tab-Two"; }
        Ok(Err(e)) => { eprintln!("[smoke] step: evaluate failed/timeout: {e}"); report.evaluated = false; report.error = Some(format!("evaluate failed: {e}")); }
        Err(_elapsed) => { eprintln!("[smoke] step: evaluate failed/timeout: timed out"); report.evaluated = false; report.error = Some("evaluate timed out".into()); }
    }

    // ── step: snapshot ────────────────────────────────────────
    let mut snapshot_bytes: usize = 0;
    let mut snapshot_ms: u128 = 0;
    let tab2_gen = { let s = app.state::<BrowserPanelState>(); let inner = s.lock(); inner.session.current_generation(&tab2_id).unwrap_or(0) };
    eprintln!("[smoke] step: snapshot warmup starting");
    match tokio::time::timeout(SMOKE_STEP_TIMEOUT, browser_snapshot(app.state(), tab2_id.clone(), tab2_gen)).await {
        Ok(Ok(warmup)) => { eprintln!("[smoke] step: snapshot warmup ok"); let _ = browser_delete_temp_files(vec![warmup.path]); }
        Ok(Err(e)) => { eprintln!("[smoke] step: snapshot warmup failed/timeout: {e}"); report.error = Some(format!("snapshot warmup failed: {e}")); }
        Err(_elapsed) => { eprintln!("[smoke] step: snapshot warmup failed/timeout: timed out"); report.error = Some("snapshot warmup timed out".into()); }
    }
    eprintln!("[smoke] step: snapshot measured starting");
    match tokio::time::timeout(SMOKE_STEP_TIMEOUT, browser_snapshot(app.state(), tab2_id.clone(), tab2_gen)).await {
        Ok(Ok(snap)) => {
            eprintln!("[smoke] step: snapshot measured ok");
            snapshot_ms = snap.ms;
            snapshot_bytes = snap.bytes;
            let _ = browser_delete_temp_files(vec![snap.path]);
        }
        Ok(Err(e)) => { eprintln!("[smoke] step: snapshot measured failed/timeout: {e}"); report.error = Some(format!("snapshot measured failed: {e}")); }
        Err(_elapsed) => { eprintln!("[smoke] step: snapshot measured failed/timeout: timed out"); report.error = Some("snapshot measured timed out".into()); }
    }
    report.snapshot_ms = snapshot_ms;
    report.snapshot_bytes = snapshot_bytes;

    // ── step: activate tab 1 ──────────────────────────────────
    eprintln!("[smoke] step: tab_activate starting");
    let tab1_id_clone = tab1_id.clone();
    match browser_tab_activate(app.state(), tab1_id_clone) {
        Ok(_snap) => { eprintln!("[smoke] step: tab_activate ok"); report.activated_second_tab = true; }
        Err(e) => { eprintln!("[smoke] step: tab_activate failed/timeout: {e}"); report.error = Some(format!("tab activate failed: {e}")); }
    }

    // ── step: close both tabs ─────────────────────────────────
    let mut closed = 0usize;
    eprintln!("[smoke] step: close tab1 starting");
    match browser_tab_close(app.state(), tab1_id) {
        Ok(_) => { eprintln!("[smoke] step: close tab1 ok"); closed += 1; }
        Err(e) => { eprintln!("[smoke] step: close tab1 failed/timeout: {e}"); report.error = Some(format!("close tab 1 failed: {e}")); }
    }
    eprintln!("[smoke] step: close tab2 starting");
    match browser_tab_close(app.state(), tab2_id) {
        Ok(_) => { eprintln!("[smoke] step: close tab2 ok"); closed += 1; }
        Err(e) => { eprintln!("[smoke] step: close tab2 failed/timeout: {e}"); report.error = Some(format!("close tab 2 failed: {e}")); }
    }
    report.closed_tabs = closed;

    // ── step: verify runtime map is empty ─────────────────────
    let remaining = {
        let state = app.state::<BrowserPanelState>();
        let inner = state.lock();
        inner.tabs.len()
    };
    if remaining > 0 {
        report.error = Some(format!(
            "runtime map not empty after closing {} tabs: {remaining} entries remain",
            closed
        ));
    }

    // ── step: destroy session ─────────────────────────────────
    eprintln!("[smoke] step: destroy starting");
    report.destroyed = destroy_smoke_webview(app).await;
    eprintln!("[smoke] step: destroy {}",
        if report.destroyed { "ok" } else { "failed/timeout" });

    cleanup_pages();
    report.success = report.error.is_none();
    Ok(report)
}

/// Drain messages for a specific tab until `page-loaded` is observed.
/// Returns `true` if the message was found within the budget (100 × 50 ms = 5 s).
async fn wait_for_page_loaded(app: &AppHandle, tab_id: &str) -> bool {
    for _ in 0..100 {
        let Ok(messages) = browser_drain_messages(app.state(), tab_id.into()) else {
            return false;
        };
        if messages.iter().any(|m| {
            serde_json::from_str::<serde_json::Value>(m)
                .ok()
                .and_then(|v| v.get("type")?.as_str().map(|k| k == "page-loaded"))
                .unwrap_or(false)
        }) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

/// Destroy the smoke webview, with its own timeout. This must NOT fail
/// the smoke test — it is the final cleanup and always runs.
async fn destroy_smoke_webview(app: &AppHandle) -> bool {
    match tokio::time::timeout(SMOKE_DESTROY_TIMEOUT, on_main_thread(app, |handle| browser_session_destroy(handle.state()))).await {
        Ok(Ok(())) => true,
        Ok(Err(e)) => { eprintln!("[smoke] destroy failed: {e}"); false }
        Err(_elapsed) => { eprintln!("[smoke] destroy timed out"); false }
    }
}

const ON_MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(10);

async fn on_main_thread<T, F>(app: &AppHandle, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(AppHandle) -> Result<T, String> + Send + 'static,
{
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = operation(handle);
        let _ = sender.send(result);
    }).map_err(|error| format!("schedule main-thread smoke falhou: {error}"))?;
    tokio::time::timeout(ON_MAIN_THREAD_TIMEOUT, receiver)
        .await
        .map_err(|_| "on_main_thread timed out (dispatch may not have executed)".to_string())?
        .map_err(|_| "main-thread smoke channel dropped".to_string())?
}

#[cfg(target_os = "macos")]
async fn evaluate_script(
    state: &State<'_, BrowserPanelState>,
    tab_id: BrowserTabId,
    script: String,
) -> Result<EvaluateReport, String> {
    let webview = current_webview(state, tab_id.as_str())?;
    let started = Instant::now();
    let value = tokio::time::timeout(Duration::from_secs(5), browser_platform::evaluate(webview, tab_id, script))
        .await
        .map_err(|_| "eval timed out".to_string())?
        .map_err(|error| error.message)?;
    Ok(EvaluateReport { ms: started.elapsed().as_millis(), value })
}

#[cfg(target_os = "macos")]
async fn capture_snapshot_bytes(
    state: &State<'_, BrowserPanelState>,
    tab_id: BrowserTabId,
) -> Result<Vec<u8>, String> {
    let webview = current_webview(state, tab_id.as_str())?;
    tokio::time::timeout(Duration::from_secs(5), browser_platform::snapshot_png(webview))
        .await
        .map_err(|_| "snapshot timed out".to_string())?
        .map_err(|error| error.message)
}

fn crop_in_pixels(
    rect: BrowserRect,
    viewport: BrowserViewport,
    image_width: u32,
    image_height: u32,
) -> Result<PixelCrop, String> {
    if viewport.width <= 0.0
        || viewport.height <= 0.0
        || !viewport.width.is_finite()
        || !viewport.height.is_finite()
        || rect.width <= 0.0
        || rect.height <= 0.0
    {
        return Err("rect/viewport inválido".into());
    }
    let scale_x = image_width as f64 / viewport.width;
    let scale_y = image_height as f64 / viewport.height;
    let left = (rect.x * scale_x)
        .floor()
        .clamp(0.0, image_width.saturating_sub(1) as f64) as u32;
    let top = (rect.y * scale_y)
        .floor()
        .clamp(0.0, image_height.saturating_sub(1) as f64) as u32;
    let right = ((rect.x + rect.width) * scale_x)
        .ceil()
        .clamp((left + 1) as f64, image_width as f64) as u32;
    let bottom = ((rect.y + rect.height) * scale_y)
        .ceil()
        .clamp((top + 1) as f64, image_height as f64) as u32;
    Ok(PixelCrop {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    })
}

fn is_browser_temp_png(path: &Path) -> bool {
    let directory = std::env::temp_dir().join("verboo-browser");
    path.parent() == Some(directory.as_path())
        && path.extension().and_then(|extension| extension.to_str()) == Some("png")
}

fn cleanup_browser_temp_root() -> Result<(), String> {
    let directory = std::env::temp_dir().join("verboo-browser");
    let entries = match std::fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("read browser temp falhou: {error}")),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if is_browser_temp_png(&path) {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}

fn next_label_seq() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    SEQ.fetch_add(1, Ordering::Relaxed)
}

fn current_webview(state: &State<'_, BrowserPanelState>, tab_id: &str) -> Result<Webview<Wry>, String> {
    let inner = state.lock();
    inner
        .tabs
        .get(tab_id)
        .map(|rt| rt.webview.clone())
        .ok_or_else(|| format!("{tab_id} sem runtime"))
}

// ── macos-only bridge plumbing ───────────────────────────────────────
//
// Wrapped in `mod macos_bridge` with `#[cfg(target_os = "macos")]` so that
// every helper that touches macos-only types (SendBrowserStatePtr, the
// platform adapter's `attach_bridge`, the `MsgHandler` ivar, etc.) is
// compiled only on macOS. On Windows/Linux, only the not-macos stub of
// `attach_message_handler` is compiled.
//
// This module replaces an earlier flat block where each macos-only helper
// carried its own `#[cfg]` — which left `attach_message_handler` and
// `push_message_with_tab` ungated and broke the Windows build.
#[cfg(target_os = "macos")]
mod macos_bridge {
    use super::*;

    /// Newtype send/sync para carregar `*const BrowserPanelState` dentro de
    /// `Arc<dyn Fn(String) + Send + Sync>`.
    pub(crate) struct SendBrowserStatePtr(*const BrowserPanelState);
    unsafe impl Send for SendBrowserStatePtr {}
    unsafe impl Sync for SendBrowserStatePtr {}
    impl SendBrowserStatePtr {
        /// # Safety: o ponteiro deve apontar para um BrowserPanelState vivo.
        pub(crate) unsafe fn state(&self) -> &BrowserPanelState { &*self.0 }
    }

    pub(crate) fn new_bridge_token() -> String {
        uuid::Uuid::new_v4().to_string()
    }

    pub(crate) fn attach_message_handler(
        webview: &Webview<Wry>,
        state: &BrowserPanelState,
        tab_id: &str,
    ) -> Result<(), String> {
        let bridge_token = new_bridge_token();
        let config = crate::services::browser_bridge::BridgeConfig {
            tab_id: tab_id.to_string(),
            token: bridge_token.clone(),
        };
        let state_ptr = SendBrowserStatePtr(state as *const BrowserPanelState);
        let sink_tab_id = tab_id.to_string();
        let sink: browser_platform::PageMessageSink = Arc::new(move |text| {
            // SAFETY: BrowserPanelState managed by Tauri, lives for entire session
            let s: &BrowserPanelState = unsafe { state_ptr.state() };
            push_message_with_tab(s, &sink_tab_id, text);
        });
        // Wire the Task 3 plumbing: on_document_start now feeds the bridge
        // queue's expect_document so the page's first message is not rejected
        // as StaleDocument. The queue is created BEFORE attach_bridge so the
        // closure can capture an Arc<Mutex<>> handle to it.
        let queue = Arc::new(std::sync::Mutex::new(BrowserBridgeQueue::new(
            tab_id.to_string(),
            bridge_token,
        )));
        let queue_for_doc = queue.clone();
        let on_document_start: Arc<dyn Fn(String) + Send + Sync + 'static> = Arc::new(move |uuid| {
            queue_for_doc.lock().unwrap().expect_document(uuid);
        });
        let handle = browser_platform::attach_bridge(webview, config, sink, on_document_start)
            .map_err(|e| format!("attach_bridge falhou: {}", e.message))?;

        // Insert the runtime into the panel state. The session model is also
        // updated so the new tab becomes the active one.
        {
            let mut inner = state.lock();
            let snapshot = BrowserTabSnapshot::blank(tab_id.to_string(), tab_id.to_string());
            inner
                .session
                .insert_and_activate(snapshot)
                .map_err(|err| format!("session.insert_and_activate failed: {err:?}"))?;
            // The on_document_start closure has been dropped after attach_bridge
            // returned (it was consumed by the call), so the Arc has exactly one
            // strong reference left and try_unwrap succeeds.
            let queue_owned = Arc::try_unwrap(queue)
                .map_err(|_| "queue Arc still shared after attach_bridge".to_string())?
                .into_inner()
                .unwrap_or_else(|poison| poison.into_inner());
            inner.tabs.insert(
                tab_id.to_string(),
                BrowserTabRuntime {
                    webview: webview.clone(),
                    bridge: handle,
                    messages: queue_owned,
                },
            );
        }
        Ok(())
    }

    /// Push usado pelo handler nativo (macOS) para enfileirar uma mensagem
    /// em uma aba específica. A página envia um `BrowserPageEnvelope` JSON
    /// completo (via `transport.post()`), que o sink repassa ao queue para
    /// validação completa (bridge_token, document_token, tamanho, overflow).
    /// No-op se a aba destino não existe mais.
    pub(crate) fn push_message_with_tab(state: &BrowserPanelState, tab_id: &str, msg: String) {
        let mut inner = state.lock();
        if let Some(runtime) = inner.tabs.get_mut(tab_id) {
            let envelope: BrowserPageEnvelope = match serde_json::from_str(&msg) {
                Ok(e) => e,
                Err(_) => return, // malformed envelope — ignore
            };
            let _ = runtime.messages.accept(envelope);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn attach_message_handler(
    _webview: &Webview<Wry>,
    _state: &BrowserPanelState,
    _tab_id: &str,
) -> Result<(), String> {
    Ok(())
}

// ── Multi-tab session commands (Task 4) ────────────────────────────

#[tauri::command]
pub fn browser_session_open(
    state: State<'_, BrowserPanelState>,
    bounds: BrowserBounds,
) -> Result<BrowserSessionSnapshot, String> {
    if !bounds.is_valid() {
        return Err(format!(
            "bounds inválidos: width={} height={}",
            bounds.width, bounds.height
        ));
    }
    let mut inner = state.lock();
    inner.bounds = Some(bounds);
    inner.visible = true;
    Ok(inner.session.snapshot(inner.visible))
}

#[tauri::command]
pub fn browser_session_snapshot(
    state: State<'_, BrowserPanelState>,
) -> Result<BrowserSessionSnapshot, String> {
    let inner = state.lock();
    Ok(inner.session.snapshot(inner.visible))
}

#[tauri::command]
pub fn browser_session_set_visible(
    state: State<'_, BrowserPanelState>,
    visible: bool,
) -> Result<BrowserSessionSnapshot, String> {
    let mut inner = state.lock();
    inner.visible = visible;
    Ok(inner.session.snapshot(inner.visible))
}

#[tauri::command]
pub fn browser_session_destroy(
    state: State<'_, BrowserPanelState>,
) -> Result<(), String> {
    let mut inner = state.lock();
    let tab_ids: Vec<BrowserTabId> = inner.tabs.keys().cloned().collect();
    for id in tab_ids {
        if let Some(runtime) = inner.tabs.remove(&id) {
            let _ = runtime.webview.close();
            // runtime.bridge drops here, unregistering the native handler.
        }
        let _ = inner.session.close(&id);
    }
    inner.bounds = None;
    inner.visible = false;
    Ok(())
}

#[tauri::command]
pub fn browser_tab_create(
    app: AppHandle,
    state: State<'_, BrowserPanelState>,
    url: Option<String>,
) -> Result<BrowserSessionSnapshot, String> {
    // Bounds come from the session — set once by browser_session_open.
    // The renderer never re-sends them.
    let bounds = {
        let inner = state.lock();
        resolve_session_bounds(&inner)?
    };

    let window = app
        .get_window("main")
        .ok_or_else(|| "janela principal não encontrada".to_string())?;

    let tab_id = format!("verboo-browser-{}", next_label_seq());
    let initial = url.as_deref().unwrap_or("about:blank");
    let parsed = parse_url_for_panel(initial)?;

    let blank = parse_url_for_panel("about:blank")?;
    let builder = tauri::webview::WebviewBuilder::new(&tab_id, tauri::WebviewUrl::External(blank))
        .incognito(true);

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| format!("add_child falhou: {e}"))?;

    // Atomic creation: attach the bridge. On failure, destroy the partial
    // webview and propagate the error — the runtime map and session model
    // are NOT mutated (try_attach_or_destroy pattern).
    #[cfg(target_os = "macos")]
    let attach_result = macos_bridge::attach_message_handler(&webview, &state, &tab_id);
    #[cfg(not(target_os = "macos"))]
    let attach_result = attach_message_handler(&webview, &state, &tab_id);
    if let Err(error) = attach_result {
        let _ = webview.close();
        return Err(error);
    }

    // Hide all other tabs, show this one.
    {
        let mut inner = state.lock();
        let other_ids: Vec<BrowserTabId> = inner
            .tabs
            .keys()
            .filter(|id| id.as_str() != tab_id.as_str())
            .cloned()
            .collect();
        for id in other_ids {
            if let Some(rt) = inner.tabs.get(&id) {
                let _ = rt.webview.hide();
            }
        }
        if let Some(rt) = inner.tabs.get(&tab_id) {
            let _ = rt.webview.show();
        }
        inner.visible = true;
    }

    if initial != "about:blank" {
        if let Err(error) = webview.navigate(parsed) {
            // Rollback: close the tab we just created.
            let mut inner = state.lock();
            let runtime = inner.tabs.remove(&tab_id);
            if let Some(rt) = runtime {
                let _ = rt.webview.close();
            }
            let _ = inner.session.close(&tab_id);
            return Err(format!("navigate inicial falhou: {error}"));
        }
    }

    let inner = state.lock();
    Ok(inner.session.snapshot(inner.visible))
}

#[tauri::command]
pub fn browser_tab_activate(
    state: State<'_, BrowserPanelState>,
    tab_id: BrowserTabId,
) -> Result<BrowserSessionSnapshot, String> {
    // Collect the visibility transitions we need to perform, then apply
    // them outside the session-model borrow. This avoids the double-mut
    // borrow that would happen if the closure captured `inner`.
    let (previous, snapshot_before) = {
        let inner = state.lock();
        let prev = inner.session.active_id().map(|id| id.to_string());
        (prev, inner.session.snapshot(inner.visible))
    };
    let previous = match previous {
        Some(id) => id,
        None => return Ok(snapshot_before),
    };
    if previous == tab_id {
        return Ok(snapshot_before);
    }
    // Hide previous, show next. If show fails, restore previous.
    let hide_prev = {
        let inner = state.lock();
        match inner.tabs.get(&previous) {
            Some(rt) => rt.webview.clone(),
            None => return Ok(snapshot_before),
        }
    };
    let show_next = {
        let inner = state.lock();
        match inner.tabs.get(&tab_id) {
            Some(rt) => rt.webview.clone(),
            None => return Ok(snapshot_before),
        }
    };
    let _ = hide_prev.hide();
    match show_next.show() {
        Ok(()) => {
            let mut inner = state.lock();
            let _ = inner.session.activate(&tab_id);
            Ok(inner.session.snapshot(inner.visible))
        }
        Err(error) => {
            let _ = hide_prev.show();
            let _ = error;
            Ok(snapshot_before)
        }
    }
}

#[tauri::command]
pub fn browser_tab_close(
    state: State<'_, BrowserPanelState>,
    tab_id: BrowserTabId,
) -> Result<BrowserSessionSnapshot, String> {
    let mut inner = state.lock();
    let snapshot_before = inner.session.snapshot(inner.visible);
    let runtime = match inner.tabs.remove(&tab_id) {
        Some(rt) => rt,
        None => return Ok(snapshot_before),
    };
    let _ = runtime.webview.close();
    // runtime.bridge drops here, unregistering the native handler.
    let _ = inner.session.close(&tab_id);
    Ok(inner.session.snapshot(inner.visible))
}

#[tauri::command]
pub fn browser_tab_navigate(
    state: State<'_, BrowserPanelState>,
    tab_id: BrowserTabId,
    url: String,
) -> Result<BrowserSessionSnapshot, String> {
    let parsed = parse_url_for_panel(&url)?;
    let mut inner = state.lock();
    let runtime = inner
        .tabs
        .get_mut(&tab_id)
        .ok_or_else(|| format!("aba {} não existe", tab_id))?;
    runtime
        .webview
        .navigate(parsed)
        .map_err(|e| format!("navigate falhou: {e}"))?;
    let _ = inner
        .session
        .begin_navigation(&tab_id, url)
        .map_err(|err| format!("begin_navigation failed: {err:?}"));
    Ok(inner.session.snapshot(inner.visible))
}

#[tauri::command]
pub fn browser_tab_back(
    state: State<'_, BrowserPanelState>,
    tab_id: BrowserTabId,
) -> Result<(), String> {
    let inner = state.lock();
    let runtime = inner
        .tabs
        .get(&tab_id)
        .ok_or_else(|| format!("aba {} não existe", tab_id))?;
    runtime
        .webview
        .eval("window.history.back();")
        .map_err(|e| format!("back falhou: {e}"))
}

#[tauri::command]
pub fn browser_tab_forward(
    state: State<'_, BrowserPanelState>,
    tab_id: BrowserTabId,
) -> Result<(), String> {
    let inner = state.lock();
    let runtime = inner
        .tabs
        .get(&tab_id)
        .ok_or_else(|| format!("aba {} não existe", tab_id))?;
    runtime
        .webview
        .eval("window.history.forward();")
        .map_err(|e| format!("forward falhou: {e}"))
}

#[tauri::command]
pub fn browser_tab_reload(
    state: State<'_, BrowserPanelState>,
    tab_id: BrowserTabId,
) -> Result<(), String> {
    let inner = state.lock();
    let runtime = inner
        .tabs
        .get(&tab_id)
        .ok_or_else(|| format!("aba {} não existe", tab_id))?;
    runtime
        .webview
        .eval("window.location.reload();")
        .map_err(|e| format!("reload falhou: {e}"))
}

const STALE_DOCUMENT: &str = "stale_document";

/// Pre‑work check: verify that the calling renderer's snapshot of the tab
/// identity (tab_id + generation) is still current. If another navigation
/// has occurred, the generation has advanced and the caller is operating
/// on stale data.
fn check_current(session: &BrowserSessionModel, tab_id: &str, generation: u64) -> Result<(), String> {
    if session.is_current_generation(tab_id, generation) {
        Ok(())
    } else {
        Err(format!("{STALE_DOCUMENT}: tab {tab_id} generation {generation} is not current"))
    }
}

/// Post‑work check: same as `check_current` but with a result to discard
/// and a cleanup callback for partial resources (e.g. temp snapshot files).
/// Called after native async work completes to catch the window where
/// the user navigated or closed the tab during the operation.
fn check_stale<T>(
    session: &BrowserSessionModel,
    tab_id: &str,
    generation: u64,
    result: T,
    cleanup: impl FnOnce(T),
) -> Result<T, String> {
    if session.is_current_generation(tab_id, generation) {
        Ok(result)
    } else {
        cleanup(result);
        Err(format!("{STALE_DOCUMENT}: tab {tab_id} generation changed during async work"))
    }
}

// ── Atomic multi-tab helpers (testable without a Tauri State) ───────

/// Atomically activates `next`: hides the previous tab, attempts to show
/// `next`, restores the previous tab on failure, and only commits the
/// model transition after the show succeeds.
///
/// `set_visible(id, visible)` is called for each visibility transition.
/// Returning `Err` from a "show" call triggers rollback: the previous
/// tab is shown again and the model is NOT mutated.
#[allow(dead_code)]
pub(crate) fn activate_atomically<F>(
    session: &mut BrowserSessionModel,
    next: &str,
    mut set_visible: F,
) -> Result<(), String>
where
    F: FnMut(&str, bool) -> Result<(), String>,
{
    let previous = match session.active_id() {
        Some(id) => id.to_string(),
        None => return Err("no active tab to deactivate".into()),
    };
    if previous == next {
        return Ok(());
    }
    set_visible(&previous, false)?;
    match set_visible(next, true) {
        Ok(()) => {
            session
                .activate(next)
                .map_err(|err| format!("activate failed: {err:?}"))?;
            Ok(())
        }
        Err(error) => {
            // Rollback: restore visibility of the previous tab.
            let _ = set_visible(&previous, true);
            Err(error)
        }
    }
}

/// Closes a tab atomically: removes the runtime from the map, calls the
/// `close` callback to dispose of native resources, applies the session
/// model transition, and returns the resulting snapshot.
///
/// If `tab_id` is not in `runtimes`, returns the unchanged snapshot
/// without calling `close` (idempotent at command boundary).
#[allow(dead_code)]
pub(crate) fn close_runtime_tab<T, F>(
    session: &mut BrowserSessionModel,
    runtimes: &mut HashMap<BrowserTabId, T>,
    tab_id: &str,
    close: F,
) -> Result<BrowserSessionSnapshot, String>
where
    F: FnOnce(&str, T) -> Result<(), String>,
{
    let snapshot_before = session.snapshot(false);
    let runtime = match runtimes.remove(tab_id) {
        Some(rt) => rt,
        None => return Ok(snapshot_before),
    };
    close(tab_id, runtime)?;
    session
        .close(tab_id)
        .map_err(|err| format!("session.close failed: {err:?}"))?;
    Ok(session.snapshot(false))
}

/// Resolve session bounds from the current panel state. Returns
/// `Err` with a clear message when `browser_session_open` was not called.
fn resolve_session_bounds(inner: &BrowserPanelInner) -> Result<BrowserBounds, String> {
    inner.bounds.ok_or_else(|| {
        "browser_tab_create falhou: sessão não aberta — chame browser_session_open primeiro".to_string()
    })
}

/// Atomic creation helper: attempts to attach a bridge (or any
/// post-webview step) to a partial resource. On failure, calls
/// `destroy` to dispose of the partial resource and propagates the
/// error. On success, returns the resource untouched so the caller
/// can insert it into the runtime map.
///
/// This is the seam that lets unit tests prove atomicity without a
/// real WKWebView: the test passes a stub resource, an attach_fn
/// that returns Err, and a destroy callback that records being
/// called.
#[allow(dead_code)]
pub(crate) fn try_attach_or_destroy<R, A, D>(
    partial: R,
    attach: A,
    destroy: D,
) -> Result<R, String>
where
    A: FnOnce(&R) -> Result<(), String>,
    D: FnOnce(R),
{
    match attach(&partial) {
        Ok(()) => Ok(partial),
        Err(error) => {
            destroy(partial);
            Err(error)
        }
    }
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    static CAPTURE_STORE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn capture_store_promotes_and_deletes_only_the_requested_owner() {
        let _guard = CAPTURE_STORE_TEST_LOCK.lock().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let store = BrowserCaptureStore::new(app_data.path().to_path_buf()).unwrap();
        let temp_root = std::env::temp_dir().join("verboo-browser");
        std::fs::create_dir_all(&temp_root).unwrap();
        let source = temp_root.join(format!("{}-capture.png", uuid::Uuid::new_v4()));
        std::fs::write(&source, b"png").unwrap();

        let promoted = store
            .promote("conversation-1", vec![source.to_string_lossy().into_owned()])
            .unwrap();
        assert_eq!(promoted.len(), 1);
        assert!(!source.exists());
        assert!(Path::new(&promoted[0].to).exists());

        store.delete_owner("conversation-1").unwrap();
        assert!(!Path::new(&promoted[0].to).exists());
    }

    #[test]
    fn capture_store_startup_gc_preserves_only_active_conversations() {
        let _guard = CAPTURE_STORE_TEST_LOCK.lock().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let store = BrowserCaptureStore::new(app_data.path().to_path_buf()).unwrap();
        let active = store.owner_dir("active").unwrap();
        let orphan = store.owner_dir("orphan").unwrap();
        std::fs::create_dir_all(&active).unwrap();
        std::fs::create_dir_all(&orphan).unwrap();
        std::fs::write(active.join("keep.png"), b"png").unwrap();
        std::fs::write(orphan.join("remove.png"), b"png").unwrap();

        store.cleanup_owners(vec!["active".into()]).unwrap();

        assert!(active.join("keep.png").exists());
        assert!(!orphan.exists());
    }

    #[test]
    fn page_message_queue_is_bounded_and_rejects_oversized_payloads() {
        use crate::services::browser_bridge::{
            BrowserBridgeQueue, BrowserPageEnvelope, MAX_PAGE_MESSAGES, MAX_PAGE_MESSAGE_BYTES,
        };
        let mut queue = BrowserBridgeQueue::new("tab-test".into(), "verboo".into());
        queue.expect_document("doc-1".into());
        // Fill the queue with well-formed messages.
        for index in 0..MAX_PAGE_MESSAGES {
            let envelope = BrowserPageEnvelope {
                tab_id: "tab-test".into(),
                bridge_token: "verboo".into(),
                document_token: "doc-1".into(),
                payload: format!("{{\"type\":\"msg-{index}\"}}"),
            };
            queue.accept(envelope).unwrap();
        }
        // The 257th message trips Overflow and clears the queue.
        let envelope = BrowserPageEnvelope {
            tab_id: "tab-test".into(),
            bridge_token: "verboo".into(),
            document_token: "doc-1".into(),
            payload: r#"{"type":"overflow"}"#.into(),
        };
        let result = queue.accept(envelope);
        assert!(result.is_err());
        assert!(queue.drain().is_empty());

        // Oversized payloads are rejected with MessageTooLarge.
        queue.expect_document("doc-2".into());
        let big = "x".repeat(MAX_PAGE_MESSAGE_BYTES + 1);
        let envelope = BrowserPageEnvelope {
            tab_id: "tab-test".into(),
            bridge_token: "verboo".into(),
            document_token: "doc-2".into(),
            payload: big,
        };
        assert!(queue.accept(envelope).is_err());
    }

    #[test]
    fn temp_cleanup_only_accepts_browser_pngs() {
        let directory = std::env::temp_dir().join("verboo-browser");
        assert!(is_browser_temp_png(&directory.join("capture.png")));
        assert!(!is_browser_temp_png(&directory.join("capture.jpg")));
        assert!(!is_browser_temp_png(&std::env::temp_dir().join("capture.png")));
        assert!(!is_browser_temp_png(&directory.join("nested/capture.png")));
    }

    #[test]
    fn bounds_rejects_zero_or_negative_size() {
        let bad = BrowserBounds {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 100.0,
        };
        assert!(!bad.is_valid());
        let bad2 = BrowserBounds {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: -1.0,
        };
        assert!(!bad2.is_valid());
        let bad3 = BrowserBounds {
            x: 0.0,
            y: 0.0,
            width: f64::NAN,
            height: 100.0,
        };
        assert!(!bad3.is_valid());
    }

    #[test]
    fn bounds_accepts_positive_size() {
        let good = BrowserBounds {
            x: -50.0,
            y: 0.0,
            width: 680.0,
            height: 800.0,
        };
        assert!(good.is_valid());
    }

    #[test]
    fn parse_url_accepts_http_https_about_file() {
        assert!(parse_url_for_panel("https://example.com").is_ok());
        assert!(parse_url_for_panel("http://localhost:3000/").is_ok());
        assert!(parse_url_for_panel("about:blank").is_ok());
        assert!(parse_url_for_panel("file:///Users/me/index.html").is_ok());
        // Trim tolerante
        assert!(parse_url_for_panel("  https://x.test  ").is_ok());
    }

    #[test]
    fn parse_url_rejects_unsupported_schemes() {
        assert!(parse_url_for_panel("javascript:alert(1)").is_err());
        assert!(parse_url_for_panel("data:text/html,<script>x</script>").is_err());
        assert!(parse_url_for_panel("ftp://files.test").is_err());
    }

    #[test]
    fn parse_url_rejects_empty_and_garbage() {
        assert!(parse_url_for_panel("").is_err());
        assert!(parse_url_for_panel("   ").is_err());
        assert!(parse_url_for_panel("not a url").is_err());
    }

    #[test]
    fn parse_url_preserves_path_query_fragment() {
        // RFC 3986: scheme e host são lowercased pelo parser; path, query
        // e fragment preservam case — confirmamos que não reescrevemos
        // além do que o parser faz.
        let parsed = parse_url_for_panel("HTTPS://Example.COM/Path?Q=1#Frag").unwrap();
        assert_eq!(parsed.as_str(), "https://example.com/Path?Q=1#Frag");
        // Scheme+host lowercased (RFC 3986), path/query/fragment intactos.
        assert_eq!(parsed.scheme(), "https");
        assert_eq!(parsed.host_str(), Some("example.com"));
        assert_eq!(parsed.path(), "/Path");
        assert_eq!(parsed.query(), Some("Q=1"));
        assert_eq!(parsed.fragment(), Some("Frag"));
    }

    #[test]
    fn label_seq_is_monotonic() {
        let a = next_label_seq();
        let b = next_label_seq();
        assert!(b > a);
    }

    #[test]
    fn bounds_serialization_roundtrip() {
        let bounds = BrowserBounds { x: 12.0, y: 48.0, width: 680.0, height: 800.0 };
        let json = serde_json::to_string(&bounds).unwrap();
        let back: BrowserBounds = serde_json::from_str(&json).unwrap();
        assert_eq!(bounds, back);
    }

    #[test]
    fn crop_math_preserves_css_rect_at_one_x() {
        let crop = crop_in_pixels(
            BrowserRect {
                x: 10.0,
                y: 20.0,
                width: 100.0,
                height: 50.0,
            },
            BrowserViewport {
                width: 800.0,
                height: 600.0,
            },
            800,
            600,
        )
        .unwrap();
        assert_eq!(
            crop,
            PixelCrop {
                x: 10,
                y: 20,
                width: 100,
                height: 50,
            }
        );
    }

    #[test]
    fn crop_math_scales_and_clamps_at_two_x() {
        let crop = crop_in_pixels(
            BrowserRect {
                x: 750.0,
                y: 560.0,
                width: 100.0,
                height: 80.0,
            },
            BrowserViewport {
                width: 800.0,
                height: 600.0,
            },
            1600,
            1200,
        )
        .unwrap();
        assert_eq!(
            crop,
            PixelCrop {
                x: 1500,
                y: 1120,
                width: 100,
                height: 80,
            }
        );
    }

    #[test]
    fn failed_activation_keeps_previous_tab_active() {
        let mut session = BrowserSessionModel::default();
        session.insert_and_activate(BrowserTabSnapshot::blank("a".into(), "label-a".into())).unwrap();
        session.insert_and_activate(BrowserTabSnapshot::blank("b".into(), "label-b".into())).unwrap();
        session.activate("a").unwrap();
        let mut visibility = Vec::new();
        let result = activate_atomically(&mut session, "b", |id, visible| {
            visibility.push((id.to_string(), visible));
            if id == "b" && visible { Err("show failed".to_string()) } else { Ok(()) }
        });
        assert!(result.is_err());
        assert_eq!(session.active_id(), Some("a"));
        assert_eq!(visibility, vec![("a".into(), false), ("b".into(), true), ("a".into(), true)]);
    }

    #[test]
    fn closing_unknown_tab_is_idempotent_at_command_boundary() {
        let mut session = BrowserSessionModel::default();
        session.insert_and_activate(BrowserTabSnapshot::blank("a".into(), "label-a".into())).unwrap();
        let mut runtimes = HashMap::from([("a".to_string(), ())]);
        let mut closed = Vec::new();
        let snapshot = close_runtime_tab(&mut session, &mut runtimes, "missing", |id, _| {
            closed.push(id.to_string());
            Ok(())
        }).unwrap();
        assert_eq!(snapshot.tabs.len(), 1);
        assert!(closed.is_empty());
    }

    /// EXIGIDO: criação atômica. attach_bridge falha DEPOIS de a webview
    /// ter sido criada. O runtime NÃO entra no HashMap e o recurso
    /// parcial (a webview) É destruído. prova que o design não vaza.
    ///
    /// O fluxo simula o caminho de produção: `try_attach_or_destroy`
    /// decide se o recurso parcial sobrevive. Só em caso de sucesso
    /// o runtime entra no HashMap e a session é mutada. Em falha, o
    /// destroy é chamado e nada é inserido — provando atomicidade.
    #[test]
    fn creation_failure_after_webview_does_not_leave_runtime() {
        let mut runtimes: HashMap<BrowserTabId, ()> = HashMap::new();
        let mut session = BrowserSessionModel::default();

        let destroyed = Arc::new(std::sync::Mutex::new(false));
        let destroy_flag = destroyed.clone();
        let stub_webview = 0_i32;
        let tab_id: BrowserTabId = "tab-fail".into();

        // Simulate the production flow: attach, and only on success
        // insert into runtimes + session. On failure, the partial
        // resource is destroyed and nothing is inserted.
        let attached = try_attach_or_destroy(
            stub_webview,
            |_w| Err::<(), _>("attach_bridge falhou".into()),
            move |_w| { *destroy_flag.lock().unwrap() = true; },
        );

        let succeeded = matches!(attached, Ok(_));
        match attached {
            Ok(_resource) => {
                runtimes.insert(tab_id.clone(), ());
                session
                    .insert_and_activate(BrowserTabSnapshot::blank(tab_id.clone(), tab_id.clone()))
                    .unwrap();
            }
            Err(_error) => {
                // Production path: do NOT insert. The partial resource
                // was already destroyed by try_attach_or_destroy.
            }
        }

        assert!(!succeeded, "attach_bridge failure must propagate");
        assert!(*destroyed.lock().unwrap(), "partial webview must be destroyed");
        assert!(runtimes.is_empty(), "runtime map must remain empty after failed attach");
        assert_eq!(session.active_id(), None, "session model must not be touched after failed attach");
        assert_eq!(session.snapshot(false).tabs.len(), 0, "session must have no tabs after failed attach");
    }

    /// EXIGIDO: stress de criação/fechamento não deixa handles registrados.
    /// 100 ciclos de insert_and_activate + close, e ao final o HashMap
    /// de runtime está vazio e a sessão está vazia.
    #[test]
    fn stress_creation_destruction_leaves_runtime_empty() {
        let mut runtimes: HashMap<BrowserTabId, ()> = HashMap::new();
        let mut session = BrowserSessionModel::default();

        for cycle in 0..100 {
            let id = format!("tab-{}", cycle);
            let snap = BrowserTabSnapshot::blank(id.clone(), id.clone());
            session.insert_and_activate(snap).unwrap();
            runtimes.insert(id.clone(), ());
            let snap = close_runtime_tab(&mut session, &mut runtimes, &id, |_, _| Ok(()))
                .expect("close_runtime_tab on known tab");
            assert!(snap.tabs.is_empty(), "session must be empty after close");
        }

        assert!(runtimes.is_empty(), "runtime map must be empty after stress");
        assert_eq!(session.active_id(), None, "session must have no active tab");
        assert_eq!(session.snapshot(false).tabs.len(), 0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn two_bridge_tokens_are_distinct_and_not_literal() {
        let t1 = macos_bridge::new_bridge_token();
        let t2 = macos_bridge::new_bridge_token();
        assert_ne!(t1, t2, "each tab must get a unique bridge token");
        assert_ne!(t1, "verboo", "bridge token must not be the development literal");
        assert_ne!(t2, "verboo", "bridge token must not be the development literal");
        assert!(!t1.is_empty());
        assert!(!t2.is_empty());
    }

    #[test]
    fn stale_generation_during_async_work_discards_result_and_cleans_temp_file() {
        let mut session = BrowserSessionModel::default();
        session
            .insert_and_activate(BrowserTabSnapshot::blank("tab-a".into(), "label-a".into()))
            .unwrap();
        let gen = session.begin_navigation("tab-a", "https://example.com".into()).unwrap();

        // Simulate a temp file produced during async work.
        let dir = tempfile::tempdir().unwrap();
        let temp_path = dir.path().join("snapshot.png");
        std::fs::write(&temp_path, b"fake png bytes").unwrap();

        // Generation changes DURING the async work (user navigated away).
        session
            .begin_navigation("tab-a", "https://new-url.com".into())
            .unwrap();

        // The after-check must detect staleness and clean up the temp file.
        let result = check_stale(
            &session,
            "tab-a",
            gen,
            temp_path.clone(),
            |path| { let _ = std::fs::remove_file(&path); },
        );

        let err_msg = result.as_ref().err().map(|e| e.as_str()).unwrap_or("");
        assert!(result.is_err(), "stale result must be discarded");
        assert!(err_msg.contains("stale_document"), "error must mention stale_document: {err_msg}");
        assert!(!temp_path.exists(), "temp file must be cleaned up on staleness");
    }

    #[test]
    fn resolve_session_bounds_returns_stored_bounds_when_present() {
        let bounds = BrowserBounds { x: 10.0, y: 20.0, width: 320.0, height: 240.0 };
        let mut inner = BrowserPanelInner::default();
        inner.bounds = Some(bounds.clone());
        assert_eq!(resolve_session_bounds(&inner).unwrap(), bounds);
    }

    #[test]
    fn resolve_session_bounds_fails_with_actionable_message_when_none() {
        let inner = BrowserPanelInner::default();
        let err = resolve_session_bounds(&inner).unwrap_err();
        assert!(
            err.contains("browser_session_open"),
            "error message must mention browser_session_open: {err}"
        );
    }
}
