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
//! O navegador embutido é uma feature exclusiva do macOS nesta versão.
//! Windows e Linux compilam o módulo, mas `browser_create` recusa a criação
//! até que o port multiplataforma esteja pronto para lançamento.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use image::GenericImageView;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::webview::Webview;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, State, Wry};

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

#[derive(Default)]
struct BrowserPanelInner {
    webview: Option<Webview<Wry>>,
    label: Option<PanelLabel>,
    messages: Vec<String>,
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
    bounds_updated: bool,
    snapshot_ms: u128,
    snapshot_bytes: usize,
    destroyed: bool,
    error: Option<String>,
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

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationCaptureRequest {
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

/// Bootstrap isolado que vive dentro da página convidada. O arquivo separado
/// permite cobrir idempotência e contrato de mensagens em Vitest sem duplicar
/// a implementação que o WKWebView recebe em `document start`.
const BROWSER_INJECT_JS: &str = include_str!("browser_inject.js");
const MAX_PAGE_MESSAGES: usize = 128;
const MAX_PAGE_MESSAGE_BYTES: usize = 64 * 1024;

// ── Commands ─────────────────────────────────────────────────────────

const fn embedded_browser_supported() -> bool {
    cfg!(target_os = "macos")
}

#[tauri::command]
pub fn browser_create(
    app: AppHandle,
    state: State<'_, BrowserPanelState>,
    bounds: BrowserBounds,
    url: Option<String>,
) -> Result<BrowserCreateReport, String> {
    if !embedded_browser_supported() {
        return Err("navegador embutido disponível apenas no macOS nesta versão".into());
    }

    if !bounds.is_valid() {
        return Err(format!(
            "bounds inválidos: width={} height={}",
            bounds.width, bounds.height
        ));
    }

    // Idempotente: tear down antes de criar uma nova. v1 = aba única.
    close_current(&state);

    let window = app
        .get_window("main")
        .ok_or_else(|| "janela principal não encontrada".to_string())?;

    let label = format!("verboo-browser-{}", next_label_seq());
    let initial = url.as_deref().unwrap_or("about:blank");
    let parsed = parse_url_for_panel(initial)?;

    eprintln!(
        "[browser] browser_create: label={label} bounds=(x={:.1},y={:.1},w={:.1},h={:.1}) url={initial}",
        bounds.x, bounds.y, bounds.width, bounds.height
    );

    let blank = parse_url_for_panel("about:blank")?;
    let builder = tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(blank))
        // Perfil limpo (ADR-0001 critério 4): non-persistent, sem cookies
        // nem logins do usuário.
        .incognito(true);

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| {
            eprintln!(
                "[browser] add_child falhou: label={label} bounds=(x={:.1},y={:.1},w={:.1},h={:.1}) url={initial} err={e}",
                bounds.x, bounds.y, bounds.width, bounds.height
            );
            format!("add_child falhou: {e}")
        })?;

    eprintln!("[browser] add_child ok: label={label}");

    attach_message_handler(&webview, &state)?;

    {
        let mut inner = state.lock();
        inner.webview = Some(webview.clone());
        inner.label = Some(label.clone());
        inner.messages.clear();
    }

    // The trusted bridge is installed in an isolated WKContentWorld before
    // the requested page starts loading. Page scripts cannot call the native
    // message handler or replace `window.__verbooBrowser`.
    if initial != "about:blank" {
        if let Err(error) = webview.navigate(parsed) {
            close_current(&state);
            return Err(format!("navigate inicial falhou: {error}"));
        }
    }

    Ok(BrowserCreateReport { label })
}

#[tauri::command]
pub fn browser_navigate(
    state: State<'_, BrowserPanelState>,
    url: String,
) -> Result<(), String> {
    let parsed = parse_url_for_panel(&url)?;
    // Clone under the mutex, then release it before navigation. The injected
    // document may post `page-ready` synchronously and that callback needs the
    // same state lock to enqueue its message.
    let webview = current_webview(&state)?;
    webview
        .navigate(parsed)
        .map_err(|e| format!("navigate falhou: {e}"))
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
    let inner = state.lock();
    let webview = inner
        .webview
        .as_ref()
        .ok_or_else(|| "sem webview".to_string())?;
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| format!("set_position falhou: {e}"))?;
    webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|e| format!("set_size falhou: {e}"))
}

#[tauri::command]
pub fn browser_set_visible(
    state: State<'_, BrowserPanelState>,
    visible: bool,
) -> Result<(), String> {
    let webview = current_webview(&state)?;
    if visible {
        webview.show().map_err(|e| format!("show falhou: {e}"))
    } else {
        webview.hide().map_err(|e| format!("hide falhou: {e}"))
    }
}

#[tauri::command]
pub fn browser_back(state: State<'_, BrowserPanelState>) -> Result<(), String> {
    let webview = current_webview(&state)?;
    webview
        .eval("window.history.back();")
        .map_err(|e| format!("back falhou: {e}"))
}

#[tauri::command]
pub fn browser_forward(state: State<'_, BrowserPanelState>) -> Result<(), String> {
    let webview = current_webview(&state)?;
    webview
        .eval("window.history.forward();")
        .map_err(|e| format!("forward falhou: {e}"))
}

#[tauri::command]
pub fn browser_reload(state: State<'_, BrowserPanelState>) -> Result<(), String> {
    let webview = current_webview(&state)?;
    webview
        .eval("window.location.reload();")
        .map_err(|e| format!("reload falhou: {e}"))
}

#[tauri::command]
pub fn browser_destroy(state: State<'_, BrowserPanelState>) -> Result<(), String> {
    close_current(&state);
    Ok(())
}

/// Drena (zera) a fila de mensagens vindas da página. Retorna snapshot
/// atual e limpa o buffer — o renderer chama isso ao receber o evento
/// `browser-messages` para evitar duplicação.
#[tauri::command]
pub fn browser_drain_messages(state: State<'_, BrowserPanelState>) -> Vec<String> {
    let mut inner = state.lock();
    std::mem::take(&mut inner.messages)
}

/// Snapshot do viewport → PNG escrito em `<temp_dir>/verboo-browser-snapshot.png`.
///
/// Meta: ≤ 100ms em página real (Fase 0 mediu 15–23ms em example.com).
/// Timeout de 5s evita hang se a webview travar ou morrer.
#[tauri::command]
pub async fn browser_snapshot(
    state: State<'_, BrowserPanelState>,
) -> Result<SnapshotReport, String> {
    #[cfg(target_os = "macos")]
    {
        let started = Instant::now();
        let bytes = capture_snapshot_bytes(&state).await?;

        let ms = started.elapsed().as_millis();
        let directory = std::env::temp_dir().join("verboo-browser");
        std::fs::create_dir_all(&directory)
            .map_err(|e| format!("create snapshot dir falhou: {e}"))?;
        let path = directory.join(format!("{}-snapshot.png", uuid::Uuid::new_v4()));
        std::fs::write(&path, &bytes).map_err(|e| format!("write falhou: {e}"))?;
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
        let bytes = capture_snapshot_bytes(&state).await?;
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
    script: String,
) -> Result<EvaluateReport, String> {
    #[cfg(target_os = "macos")]
    {
        evaluate_script(&state, script).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
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
        let report = evaluate_script(
            &state,
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
        current_webview(&state).map(|_| ())
    }
}

/// Runs the packaged-app multiwebview path for CI. This is intentionally
/// activated only by an explicit environment variable in `run()`.
pub fn start_runtime_smoke(app: AppHandle, report_path: PathBuf) {
    tauri::async_runtime::spawn(async move {
        let result = run_runtime_smoke(&app).await;
        let (report, exit_code) = match result {
            Ok(report) => (report, 0),
            Err(error) => {
                let _ = on_main_thread(&app, |handle| browser_destroy(handle.state())).await;
                (BrowserRuntimeSmokeReport {
                    success: false,
                    navigated: false,
                    bounds_updated: false,
                    snapshot_ms: 0,
                    snapshot_bytes: 0,
                    destroyed: false,
                    error: Some(error),
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

async fn run_runtime_smoke(app: &AppHandle) -> Result<BrowserRuntimeSmokeReport, String> {
    let page_path = std::env::temp_dir().join(format!(
        "verboo-browser-runtime-smoke-{}.html",
        uuid::Uuid::new_v4()
    ));
    std::fs::write(
        &page_path,
        "<!doctype html><html><body style='background:#12131c;color:white'><button data-component='SmokeButton'>Runtime smoke</button></body></html>",
    )
    .map_err(|error| format!("write smoke page falhou: {error}"))?;
    let page_url = tauri::Url::from_file_path(&page_path)
        .map_err(|_| "smoke page URL inválida".to_string())?
        .to_string();

    let initial_bounds = BrowserBounds { x: 40.0, y: 80.0, width: 480.0, height: 360.0 };
    let resized_bounds = BrowserBounds { x: 56.0, y: 92.0, width: 520.0, height: 390.0 };
    let url_for_create = page_url.clone();
    on_main_thread(app, move |handle| {
        browser_create(handle.clone(), handle.state(), initial_bounds, Some(url_for_create))?;
        browser_set_bounds(handle.state(), resized_bounds)
    }).await?;

    let mut navigated = false;
    for _ in 0..100 {
        let messages = browser_drain_messages(app.state());
        navigated = messages.iter().any(|message| {
            serde_json::from_str::<serde_json::Value>(message)
                .ok()
                .and_then(|value| value.get("type").and_then(|kind| kind.as_str()).map(|kind| kind == "page-loaded"))
                .unwrap_or(false)
        });
        if navigated { break; }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    if !navigated {
        return Err("runtime smoke did not observe page-loaded".into());
    }

    // Warm WebKit's first snapshot so the measured sample reflects the
    // interaction budget rather than one-time framework initialization.
    let warmup = browser_snapshot(app.state()).await?;
    browser_delete_temp_files(vec![warmup.path])?;
    let snapshot = browser_snapshot(app.state()).await?;
    browser_delete_temp_files(vec![snapshot.path.clone()])?;
    if snapshot.bytes == 0 {
        return Err("runtime smoke snapshot was empty".into());
    }

    on_main_thread(app, |handle| browser_destroy(handle.state())).await?;
    let destroyed = current_webview(&app.state()).is_err();
    let _ = std::fs::remove_file(page_path);
    Ok(BrowserRuntimeSmokeReport {
        success: true,
        navigated,
        bounds_updated: true,
        snapshot_ms: snapshot.ms,
        snapshot_bytes: snapshot.bytes,
        destroyed,
        error: None,
    })
}

async fn on_main_thread<T, F>(app: &AppHandle, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(AppHandle) -> Result<T, String> + Send + 'static,
{
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(operation(handle));
    }).map_err(|error| format!("schedule main-thread smoke falhou: {error}"))?;
    receiver.await.map_err(|_| "main-thread smoke channel dropped".to_string())?
}

#[cfg(target_os = "macos")]
async fn evaluate_script(
    state: &State<'_, BrowserPanelState>,
    script: String,
) -> Result<EvaluateReport, String> {
    let webview = current_webview(state)?;
    let started = Instant::now();
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let tx = std::sync::Arc::new(Mutex::new(Some(tx)));

    webview
        .with_webview(move |pw| {
            let deliver = {
                let tx = tx.clone();
                move |result: Result<String, String>| {
                    if let Some(sender) = tx.lock().unwrap().take() {
                        let _ = sender.send(result);
                    }
                }
            };
            unsafe {
                let wk = native::wk_from_ptr(pw.inner().cast());
                native::eval_with_result(wk, &script, deliver);
            }
        })
        .map_err(|e| format!("with_webview falhou: {e}"))?;

    let value = tokio::time::timeout(Duration::from_secs(5), rx)
        .await
        .map_err(|_| "eval timed out".to_string())?
        .map_err(|_| "eval channel dropped".to_string())??;

    Ok(EvaluateReport {
        ms: started.elapsed().as_millis(),
        value,
    })
}

#[cfg(target_os = "macos")]
async fn capture_snapshot_bytes(
    state: &State<'_, BrowserPanelState>,
) -> Result<Vec<u8>, String> {
    let webview = current_webview(state)?;
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    let tx = std::sync::Arc::new(Mutex::new(Some(tx)));

    webview
        .with_webview(move |pw| {
            let deliver = {
                let tx = tx.clone();
                move |result: Result<Vec<u8>, String>| {
                    if let Some(sender) = tx.lock().unwrap().take() {
                        let _ = sender.send(result);
                    }
                }
            };
            unsafe {
                let wk = native::wk_from_ptr(pw.inner().cast());
                native::take_snapshot(wk, deliver);
            }
        })
        .map_err(|error| format!("with_webview falhou: {error}"))?;

    tokio::time::timeout(Duration::from_secs(5), rx)
        .await
        .map_err(|_| "snapshot timed out".to_string())?
        .map_err(|_| "snapshot channel dropped".to_string())?
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

fn close_current(state: &State<'_, BrowserPanelState>) {
    let mut inner = state.lock();
    if let Some(webview) = inner.webview.take() {
        let _ = webview.close();
    }
    inner.label = None;
    inner.messages.clear();
}

fn current_webview(state: &State<'_, BrowserPanelState>) -> Result<Webview<Wry>, String> {
    state
        .lock()
        .webview
        .as_ref()
        .cloned()
        .ok_or_else(|| "sem webview".to_string())
}

/// Push usado pelo handler nativo (macOS) para enfileirar uma mensagem.
/// No-op se a webview já não está mais lá (destroy correu em paralelo).
fn push_message(state: &BrowserPanelState, msg: String) {
    let mut inner = state.lock();
    if inner.webview.is_some() {
        enqueue_page_message(&mut inner, msg);
    }
}

fn enqueue_page_message(inner: &mut BrowserPanelInner, msg: String) {
    if msg.len() > MAX_PAGE_MESSAGE_BYTES {
        return;
    }
    if inner.messages.len() == MAX_PAGE_MESSAGES {
        inner.messages.remove(0);
    }
    inner.messages.push(msg);
}

// ── macOS-native pieces ─────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod native {
    use std::sync::OnceLock;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_web_kit::{
        WKContentWorld, WKScriptMessage, WKScriptMessageHandler, WKUserContentController,
        WKUserScript, WKUserScriptInjectionTime, WKWebView,
    };

    use super::BrowserPanelState;

    /// Newtype sobre raw pointer que implementa `Send + Sync` (necessário
    /// para `OnceLock` em static). O `BrowserPanelState` é `.manage()` no
    /// `tauri::Builder` e vive até o fim do processo; o cast para
    /// `'static` é seguro. v1 = aba única.
    pub(crate) struct SendPtr(pub *const BrowserPanelState);
    // SAFETY: o ponteiro aponta para o BrowserPanelState singleton do
    // Tauri, vivo por toda a sessão. O acesso ao ponteiro em si é
    // feito apenas dentro de `define_class!` callback, que corre na
    // main thread — o lock em `push_message` serializa o acesso aos
    // dados internos.
    unsafe impl Send for SendPtr {}
    unsafe impl Sync for SendPtr {}

    static STATE_PTR: OnceLock<SendPtr> = OnceLock::new();

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "VerbooBrowserMsgHandler"]
        pub struct MsgHandler;

        unsafe impl NSObjectProtocol for MsgHandler {}

        unsafe impl WKScriptMessageHandler for MsgHandler {
            #[unsafe(method(userContentController:didReceiveScriptMessage:))]
            fn did_receive(
                &self,
                _controller: &WKUserContentController,
                message: &WKScriptMessage,
            ) {
                if !unsafe { message.frameInfo().isMainFrame() } {
                    return;
                }
                let body = unsafe { message.body() };
                let text = body
                    .downcast_ref::<NSString>()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "<non-string message>".to_string());
                if let Some(ptr) = STATE_PTR.get() {
                    // SAFETY: ponteiro registrado em `attach_handler`,
                    // `BrowserPanelState` viva por toda a sessão do app.
                    let state: &BrowserPanelState = unsafe { &*ptr.0 };
                    super::push_message(state, text);
                }
            }
        }
    );

    impl MsgHandler {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm);
            unsafe { msg_send![this, init] }
        }
    }

    /// Registra o `BrowserPanelState` no singleton `STATE_PTR`. Chamar
    /// antes de `with_webview` para que o handler nativo o encontre.
    pub fn register_state(state: &BrowserPanelState) {
        let _ = STATE_PTR.set(SendPtr(state as *const _));
    }

    /// # Safety: deve ser chamada na main thread com um ponteiro de WKWebView válido.
    pub unsafe fn wk_from_ptr<'a>(ptr: *mut std::ffi::c_void) -> &'a WKWebView {
        &*(ptr as *const WKWebView)
    }

    fn trusted_world(mtm: MainThreadMarker) -> Retained<WKContentWorld> {
        unsafe { WKContentWorld::defaultClientWorld(mtm) }
    }

    pub fn attach_handler(wk: &WKWebView, source: &str) {
        // O `state` já deve estar registrado em `STATE_PTR` antes desta
        // chamada (feito em `attach_message_handler`). Aqui só
        // registramos o ObjC handler no webview.
        let mtm = MainThreadMarker::new().expect("with_webview corre na main thread");
        let handler = MsgHandler::new(mtm);
        let proto: &ProtocolObject<dyn WKScriptMessageHandler> =
            ProtocolObject::from_ref(&*handler);
        unsafe {
            let controller = wk.configuration().userContentController();
            let world = trusted_world(mtm);
            let user_script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly_inContentWorld(
                WKUserScript::alloc(mtm),
                &NSString::from_str(source),
                WKUserScriptInjectionTime::AtDocumentStart,
                true,
                &world,
            );
            controller.addUserScript(&user_script);
            // O controller retém o handler; o `Retained` pode dropar.
            controller.addScriptMessageHandler_contentWorld_name(
                proto,
                &world,
                &NSString::from_str("verboo"),
            );
        }
    }

    pub fn take_snapshot(
        wk: &WKWebView,
        deliver: impl Fn(Result<Vec<u8>, String>) + Clone + 'static,
    ) {
        let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            if image.is_null() {
                let message = if error.is_null() {
                    "snapshot devolveu imagem nula".to_string()
                } else {
                    unsafe { (*error).localizedDescription().to_string() }
                };
                deliver(Err(message));
                return;
            }
            let image = unsafe { &*image };
            deliver(png_from_nsimage(image));
        });
        unsafe { wk.takeSnapshotWithConfiguration_completionHandler(None, &block) };
    }

    fn png_from_nsimage(image: &NSImage) -> Result<Vec<u8>, String> {
        unsafe {
            let tiff = image
                .TIFFRepresentation()
                .ok_or_else(|| "sem representação TIFF".to_string())?;
            let rep = NSBitmapImageRep::imageRepWithData(&tiff)
                .ok_or_else(|| "sem bitmap rep".to_string())?;
            let png = rep
                .representationUsingType_properties(
                    NSBitmapImageFileType::PNG,
                    &NSDictionary::new(),
                )
                .ok_or_else(|| "encode PNG falhou".to_string())?;
            Ok(png.to_vec())
        }
    }

    pub fn eval_with_result(
        wk: &WKWebView,
        script: &str,
        deliver: impl Fn(Result<String, String>) + Clone + 'static,
    ) {
        let block = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
            if !error.is_null() {
                let message = unsafe { (*error).localizedDescription().to_string() };
                deliver(Err(message));
                return;
            }
            if result.is_null() {
                deliver(Ok("<null>".to_string()));
                return;
            }
            let obj = unsafe { &*result };
            let value = obj
                .downcast_ref::<NSString>()
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("<non-string result: {obj:?}>"));
            deliver(Ok(value));
        });
        unsafe {
            let mtm = MainThreadMarker::new().expect("evaluate roda na main thread");
            let world = trusted_world(mtm);
            wk.evaluateJavaScript_inFrame_inContentWorld_completionHandler(
                &NSString::from_str(script),
                None,
                &world,
                Some(&block),
            )
        };
    }
}

#[cfg(target_os = "macos")]
fn attach_message_handler(webview: &Webview<Wry>, state: &BrowserPanelState) -> Result<(), String> {
    // Registra o ponteiro de estado no singleton ANTES de with_webview,
    // para que o handler nativo (WKScriptMessageHandler) o encontre
    // via STATE_PTR.get() no callback. O closure de with_webview só
    // precisa capturar `pw` (Send) — não captura `state`.
    native::register_state(state);
    webview.with_webview(|pw| unsafe {
        let wk = native::wk_from_ptr(pw.inner().cast());
        native::attach_handler(wk, BROWSER_INJECT_JS);
    }).map_err(|error| format!("attach trusted browser bridge falhou: {error}"))
}

#[cfg(not(target_os = "macos"))]
fn attach_message_handler(_webview: &Webview<Wry>, _state: &BrowserPanelState) -> Result<(), String> {
    Ok(())
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
        let mut inner = BrowserPanelInner::default();
        for index in 0..(MAX_PAGE_MESSAGES + 5) {
            enqueue_page_message(&mut inner, format!("message-{index}"));
        }
        assert_eq!(inner.messages.len(), MAX_PAGE_MESSAGES);
        assert_eq!(inner.messages.first().map(String::as_str), Some("message-5"));

        enqueue_page_message(&mut inner, "x".repeat(MAX_PAGE_MESSAGE_BYTES + 1));
        assert_eq!(inner.messages.len(), MAX_PAGE_MESSAGES);
        assert_ne!(inner.messages.last().map(String::len), Some(MAX_PAGE_MESSAGE_BYTES + 1));
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
    fn embedded_browser_support_matches_the_macos_release_scope() {
        assert_eq!(embedded_browser_supported(), cfg!(target_os = "macos"));
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
}
