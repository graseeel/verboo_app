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
use std::io::{Read, Write};
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
    tab_creation: Mutex<()>,
}

struct BrowserTabRuntime {
    webview: Webview<Wry>,
    /// Held for its Drop side-effect: unregisters the native handler.
    #[allow(dead_code)]
    bridge: browser_platform::BridgeHandle,
    /// Arc<Mutex<>> because some platform adapters (Linux) retain the
    /// on_document_start callback across navigations, keeping a clone
    /// of the queue Arc. Stored shared so attach_message_handler never
    /// needs Arc::try_unwrap.
    ///
    /// Regression protection: changing this back to bare
    /// `BrowserBridgeQueue` breaks type-checking at the
    /// `inner.tabs.insert(..., messages: queue)` call site,
    /// since `queue` is `Arc<Mutex<BrowserBridgeQueue>>` and
    /// no `Arc::try_unwrap` remains. The compiler enforces this,
    /// not a test.
    messages: Arc<Mutex<BrowserBridgeQueue>>,
}

mod panel_visibility {
    #[derive(Default)]
    pub(crate) struct State {
        visible: bool,
    }

    impl State {
        pub(crate) fn is_visible(&self) -> bool {
            self.visible
        }

        /// The model flag is committed only after the native transition
        /// succeeds. Keeping the field private makes this the only route
        /// for changing the internal visibility state.
        pub(crate) fn set_after_native<F>(
            &mut self,
            visible: bool,
            native_transition: F,
        ) -> Result<(), String>
        where
            F: FnOnce() -> Result<(), String>,
        {
            native_transition()?;
            self.visible = visible;
            Ok(())
        }
    }
}

#[derive(Default)]
struct BrowserPanelInner {
    session: BrowserSessionModel,
    tabs: HashMap<BrowserTabId, BrowserTabRuntime>,
    bounds: Option<BrowserBounds>,
    visibility: panel_visibility::State,
}

impl BrowserPanelInner {
    fn snapshot(&self) -> BrowserSessionSnapshot {
        self.session.snapshot(self.visibility.is_visible())
    }
}

impl BrowserPanelState {
    fn lock(&self) -> std::sync::MutexGuard<'_, BrowserPanelInner> {
        // Poisoning aqui indica um panic dentro de um comando anterior
        // mantendo o lock. Para o painel isso é recuperável (a webview
        // provavelmente já morreu junto com o thread); preferimos
        // retornar estado potencialmente inconsistente a abortar o app.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_tab_creation(&self) -> std::sync::MutexGuard<'_, ()> {
        self.tab_creation.lock().unwrap_or_else(|e| e.into_inner())
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
///
/// Lock order: panel mutex → queue mutex (NAV-20).
#[tauri::command]
pub fn browser_drain_messages(
    state: State<'_, BrowserPanelState>,
    tab_id: BrowserTabId,
) -> Result<Vec<String>, String> {
    let inner = state.lock();
    let runtime = inner
        .tabs
        .get(&tab_id)
        .ok_or_else(|| format!("{STALE_DOCUMENT}: tab {tab_id} not found"))?;
    let mut queue = runtime.messages.lock().unwrap_or_else(|e| e.into_inner());
    Ok(queue.drain())
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

/// Captura o viewport sem mini-modal e salva tanto o PNG completo quanto um
/// recorte escalado pela densidade real do snapshot (1x/2x/etc.).
#[tauri::command]
pub async fn browser_capture_annotation(
    state: State<'_, BrowserPanelState>,
    request: AnnotationCaptureRequest,
) -> Result<AnnotationCaptureReport, String> {
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

/// Confirma que o processo de conteúdo ainda responde e que o bridge
/// isolado continua instalado. Três falhas consecutivas no renderer
/// encerram a instância morta e expõem a ação explícita de recriação.
#[tauri::command]
pub async fn browser_healthcheck(state: State<'_, BrowserPanelState>) -> Result<(), String> {
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
const SMOKE_PAGE_READY_POLL: Duration = Duration::from_millis(50);
const SMOKE_PAGE_READY_ATTEMPTS: usize = 400;

/// F4-EVICT (2026-08-02) — TETO ANTI-CATASTROFE POR CONTAGEM.
///
/// MEDIDO (F4-MEASURE, 3 corridas, mediana; RSS incremental por PID):
///   página leve (example.com):     31.696 KB por aba
///   página pesada (youtube vídeo): 737.120 KB por aba
///   (leve: 31696/31568/31728 — pesada: 737120/714640/754576)
///
/// ISTO NÃO É UM TETO DE MEMÓRIA. A diferença de ~23x entre leve e
/// pesada torna impossível derivar um teto de memória por contagem: 8
/// abas LEVES dão ~250 MB (irrelevante), 8 abas PESADAS dariam ~5,8 GB
/// e o app morreria antes. Um teto derivado de orçamento sairia em 3 ou
/// 4; o 8 aqui NÃO protege memória — ele evita a catástrofe de vinte
/// abas e preserva o caso TÍPICO (usuário com algumas abas abertas,
/// despejo não-agressivo, e a promessa F2/F3: aba viva volta exatamente
/// de onde estava). O trade-off é deliberado: proteção de memória
/// real exige teto por PESO — RSS por PID em runtime, que a harness
/// da F1 (F4-MEASURE) já sabe ler — e fica como ITEM FUTURO.
///
/// 700MB POR ABA FECHADA NÃO É HIGIENE INVISÍVEL. Esta é a conclusão
/// mais importante: abrir e fechar quatro abas de vídeo numa sessão
/// normal queima ~2,8 GB que SÓ voltam reiniciando o app — o fork
/// RETÉM os webviews fechados (os dois retain no Drop do wkwebview;
/// medido: após fechar 2 abas, 3 processos WebContent continuam vivos,
/// 680-757 MB). Os dois retain do fork passam a ser o item de MAIOR
/// PRIORIDADE do navegador, acima de qualquer polimento. E a F4 NÃO os
/// cobre por construção: este teto conta abas VIVAS, e os órfãos vivem
/// FORA da contagem. A F4 não vende um limite que não limita — a lacuna
/// é declarada com todas as letras aqui, para que o leak do fork nunca
/// seja esquecido ou tratado como cosmético.
pub const MAX_LIVE_TABS: usize = 8;

/// Start a local HTTP server that serves the two smoke pages.
///
/// We do NOT use `file://` URLs because wry-0.55.1's webkitgtk IPC
/// handler does `http::Request::builder().uri(url)` on the URL from
/// `webview.uri()`, and `http::Uri` rejects `file:///` (empty authority).
/// The `file://localhost/` workaround was also insufficient: WebKitGTK
/// normalizes `file://localhost/` → `file:///` per WHATWG URL spec
/// (file host state), so the authority was lost before wry read it.
/// HTTP URLs have mandatory authority and avoid the issue entirely.
///
/// See NAV-23/NAV-26 — this chain consumed significant debugging time.
/// If someone attempts to "simplify" back to file://, the CI Linux
/// smoke will SIGABRT with "panic in a function that cannot unwind"
/// at wry-0.55.1/src/webkitgtk/mod.rs:648.
///
/// Port is dynamically assigned (127.0.0.1:0) to avoid flaky port
/// collisions when multiple CI jobs run on the same runner.
fn start_smoke_http_server() -> Result<(String, String), String> {
    let html1 = "<!doctype html><html><title>Tab-One</title><body style='background:#12131c;color:white'>First tab</body></html>";
    let html2 = "<!doctype html><html><title>Tab-Two</title><body style='background:#2a2a3c;color:white'>Second tab</body></html>";
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("bind smoke HTTP server falhou: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr falhou: {e}"))?
        .port();
    let page1_url = format!("http://127.0.0.1:{port}/page1.html");
    let page2_url = format!("http://127.0.0.1:{port}/page2.html");
    eprintln!("[smoke] http: listening on 127.0.0.1:{port}");
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = match stream {
                Ok(s) => s,
                Err(_) => return,
            };
            // Per-connection thread so a slow/corrupt connection from
            // one page (or a parallel request like favicon) does not
            // block the entire server.
            std::thread::spawn(move || {
                // 5s read timeout prevents a stalled connection from
                // hanging the thread.
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut buf = [0u8; 4096];
                let n = match stream.read(&mut buf) {
                    Ok(n) if n > 0 => n,
                    _ => return,
                };
                let request = String::from_utf8_lossy(&buf[..n]);
                let first_line = request.lines().next().unwrap_or("(empty)");
                let _ = first_line; // used in the log below
                eprintln!("[smoke] http: request {first_line}");
                let body = if request.contains("page1.html") {
                    html1
                } else if request.contains("page2.html") {
                    html2
                } else {
                    eprintln!("[smoke] http: 404 for {first_line}");
                    let not_found = "404 Not Found";
                    let response = format!(
                        "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{not_found}",
                        not_found.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                    eprintln!("[smoke] http: served 404 ({not_found} bytes)");
                    return;
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                eprintln!("[smoke] http: served page ({} bytes)", body.len());
                let _ = stream.write_all(response.as_bytes());
            });
        }
    });
    Ok((page1_url, page2_url))
}

async fn run_runtime_smoke(app: &AppHandle) -> Result<BrowserRuntimeSmokeReport, String> {
    eprintln!("[smoke] run_runtime_smoke starting");
    let (page1_url, page2_url) = start_smoke_http_server()?;

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

    // ── step: open session with bounds ────────────────────────
    eprintln!("[smoke] step: session_open starting");
    let session_bounds = BrowserBounds { x: 40.0, y: 80.0, width: 480.0, height: 360.0 };
    if let Err(e) = browser_session_open(app.state(), session_bounds) {
        eprintln!("[smoke] step: session_open failed: {e}");
        report.error = Some(format!("session open failed: {e}"));
        return Ok(report);
    }
    eprintln!("[smoke] step: session_open ok");
    report.bounds_updated = true;

    // ── step: create tab 1 ────────────────────────────────────
    eprintln!("[smoke] step: tab1 create starting");
    let tab1_id = match browser_tab_create(app.clone(), app.state(), Some(page1_url)) {
        Ok(snap) => {
            eprintln!("[smoke] step: tab1 create ok");
            report.created_tabs = 1;
            snap.active_tab_id.clone().unwrap_or_else(|| "missing-tab1".into())
        }
        Err(e) => { eprintln!("[smoke] step: tab1 create failed: {e}"); report.error = Some(format!("tab 1 create failed: {e}")); return Ok(report); }
    };

    // Wait for tab 1 to load.
    eprintln!("[smoke] step: wait_for_page_ready tab1 starting");
    if !wait_for_page_ready(app, &tab1_id).await {
        eprintln!("[smoke] step: wait_for_page_ready tab1 failed/timeout: page not ready");
        report.error = Some("tab 1 page-ready not observed".into());
        let _ = destroy_smoke_webview(app).await;
        return Ok(report);
    }
    eprintln!("[smoke] step: wait_for_page_ready tab1 ok");
    report.navigated = true;
    report.bridge_received = true;

    // ── step: create tab 2 ────────────────────────────────────
    eprintln!("[smoke] step: tab2 create starting");
    let tab2_id = match browser_tab_create(app.clone(), app.state(), Some(page2_url)) {
        Ok(snap) => {
            eprintln!("[smoke] step: tab2 create ok");
            report.created_tabs = 2;
            snap.active_tab_id.unwrap_or_else(|| "missing-tab2".into())
        }
        Err(e) => { eprintln!("[smoke] step: tab2 create failed: {e}"); report.error = Some(format!("tab 2 create failed: {e}")); return Ok(report); }
    };

    // Wait for tab 2 to load.
    eprintln!("[smoke] step: wait_for_page_ready tab2 starting");
    if !wait_for_page_ready(app, &tab2_id).await {
        eprintln!("[smoke] step: wait_for_page_ready tab2 failed/timeout: page not ready");
        report.error = Some("tab 2 page-ready not observed".into());
        let _ = destroy_smoke_webview(app).await;
        return Ok(report);
    }
    eprintln!("[smoke] step: wait_for_page_ready tab2 ok");

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

    // ── step: snapshot (skippable via env var) ────────────────
    // In headless CI runners, `takeSnapshot` may block indefinitely because
    // no frame is ever composited. Setting `VERBOO_SMOKE_SKIP_SNAPSHOT=1`
    // skips both warmup + measured steps and reports `snapshotBytes: 0`
    // with an error mentioning "snapshot" — the launcher's CI gate is
    // configured to treat this as non-fatal.
    let mut snapshot_bytes: usize = 0;
    let mut snapshot_ms: u128 = 0;
    let skip_snapshot = std::env::var("VERBOO_SMOKE_SKIP_SNAPSHOT").as_deref() == Ok("1");
    if skip_snapshot {
        eprintln!("[smoke] step: snapshot skipped (VERBOO_SMOKE_SKIP_SNAPSHOT=1)");
        report.error = Some("snapshot skipped (headless environment)".into());
    } else {
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
    }

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
    match browser_tab_close(app.state(), tab1_id).await {
        Ok(_) => { eprintln!("[smoke] step: close tab1 ok"); closed += 1; }
        Err(e) => { eprintln!("[smoke] step: close tab1 failed/timeout: {e}"); report.error = Some(format!("close tab 1 failed: {e}")); }
    }
    eprintln!("[smoke] step: close tab2 starting");
    match browser_tab_close(app.state(), tab2_id).await {
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

    // F2-PAUSE (2026-08-02) — PROVA PERSISTENTE com as DUAS metades
    // juntas, como exigido pelo QA: a mídia PAUSA (video.paused === true)
    // E o documento NÃO é descarregado (a URL continua a original, não
    // about:blank). Sem as duas asserções no MESMO teste, alguém poderia
    // "consertar" a pausa navegando para about:blank e a fase passaria
    // morta. PROXY DECLARADO: video.paused é a propriedade padrão de
    // mídia <video>/<audio> — Web Audio API e WebRTC NÃO passam por ela;
    // esse é o limite do proxy, aceito pelo QA. O teste roda no smoke
    // runtime (só funciona em release, nunca em debug — regra da base).
    //
    // Nota de validade: o youtube carrega pausado (autoplay com som é
    // bloqueado pela política). Por isso a prova DÁ PLAY (muted, que a
    // política permite) e confirma paused=false ANTES — senão "paused=true
    // depois" provaria que o comando pausou, e não que já estava pausado.
    eprintln!("[smoke] F2-PAUSE: provando que suspender pausa SEM descarregar");
    #[cfg(target_os = "macos")]
    {
        let bounds = BrowserBounds { x: 40.0, y: 80.0, width: 480.0, height: 360.0 };
        let _open = browser_session_open(app.state(), bounds);
        let create = browser_tab_create(app.clone(), app.state(), Some("https://www.youtube.com".into()));
        match create {
            Ok(snap) => {
                let tab = snap.active_tab_id.unwrap_or_default();
                if wait_for_page_ready(app, &tab).await {
                    eprintln!("[smoke] F2-PAUSE: youtube page-ready ok");
                }
                std::thread::sleep(std::time::Duration::from_millis(2000));
                let gen: u64 = { let s = app.state::<BrowserPanelState>(); let g = s.lock().session.current_generation(&tab).unwrap_or(0); g };
                let play_script = "(()=>{const v=document.querySelector('video'); if(v){v.muted=true; v.play();} return 'play-ok';})()";
                let probe_script = "JSON.stringify({paused: (()=>{const v=document.querySelector('video')||document.querySelector('audio'); return v? v.paused : null})(), url: location.href})";
                let _ = browser_evaluate_script(app.state(), tab.clone(), gen, play_script.into()).await;
                std::thread::sleep(std::time::Duration::from_millis(800));
                let playing = match browser_evaluate_script(app.state(), tab.clone(), gen, probe_script.into()).await {
                    Ok(r) => r.value, Err(e) => format!("eval-falhou: {e}"),
                };
                eprintln!("[smoke] F2-PAUSE: antes (deve estar paused=false): {playing}");

                let _ = browser_tab_set_media_suspended(app.state(), tab.clone(), true).await;
                std::thread::sleep(std::time::Duration::from_millis(500));
                let suspended = match browser_evaluate_script(app.state(), tab.clone(), gen, probe_script.into()).await {
                    Ok(r) => r.value, Err(e) => format!("eval-falhou: {e}"),
                };
                eprintln!("[smoke] F2-PAUSE: suspenso: {suspended}");

                // DUAS METADES JUNTAS:
                let was_playing = playing.contains("\"paused\":false");
                let paused = suspended.contains("\"paused\":true");
                let url_preserved = suspended.contains("youtube") && !suspended.contains("about:blank");
                if was_playing && paused && url_preserved {
                    eprintln!("[smoke] F2-PAUSE: >>> PROVA OK (mídia tocava → pausou; URL preservada, não about:blank)");
                } else {
                    eprintln!("[smoke] F2-PAUSE: >>> FALHOU — was_playing={was_playing} paused={paused} url_preserved={url_preserved}");
                    report.error = Some(format!(
                        "F2-PAUSE: was_playing={was_playing} paused={paused} url_preserved={url_preserved}"
                    ));
                }

                // ABERTO: devolve controle com pausa determinística — o
                // smoke mediu que o desbloqueio SOZINHO retoma autoplay;
                // o comando agora encadeia a pausa. Asserção: após o par,
                // nada tocando E URL preservada.
                let _ = browser_tab_set_media_suspended(app.state(), tab.clone(), false).await;
                std::thread::sleep(std::time::Duration::from_millis(800));
                let reopened = match browser_evaluate_script(app.state(), tab.clone(), gen, probe_script.into()).await {
                    Ok(r) => r.value, Err(e) => format!("eval-falhou: {e}"),
                };
                eprintln!("[smoke] F2-PAUSE: reaberto (deve estar paused=true, URL youtube): {reopened}");
                let reopened_paused = reopened.contains("\"paused\":true");
                let reopened_preserved = reopened.contains("youtube") && !reopened.contains("about:blank");
                if reopened_paused && reopened_preserved {
                    eprintln!("[smoke] F2-PAUSE: >>> ABERTO OK (controle devolvido, nada tocando, URL preservada)");
                } else {
                    eprintln!("[smoke] F2-PAUSE: >>> ABERTO FALHOU — paused={reopened_paused} preserved={reopened_preserved}");
                    if report.error.is_none() {
                        report.error = Some(format!(
                            "F2-PAUSE ABERTO: paused={reopened_paused} preserved={reopened_preserved}"
                        ));
                    }
                }
                let _ = browser_tab_close(app.state(), tab).await;
            }
            Err(e) => eprintln!("[smoke] F2-PAUSE: criação falhou: {e}"),
        }
    }

    // F3-SURVIVE (2026-08-02) — PROVA de que o webview SOBREVIVE ao
    // ciclo esconder-mostrar sem ser descartado. Este é o risco que o QA
    // marcou como o mais perigoso do projeto: o SO pode suspender ou
    // DESCARTAR uma view nativa oculta sem nos avisar. Se descartar, o
    // "volta exatamente de onde estava" quebra em silêncio.
    //
    // MEDIÇÃO: plantar uma variável de janela (`window.__f3_sentinel`)
    // com um valor único — ela SÓ sobrevive se o documento NÃO
    // recarregou. Esconder (set_visible false), ESPERAR, reabrir
    // (set_visible true), e verificar por evaluate: sentinel preservado
    // E URL preservada. O sentinel é mais forte que a URL sozinha: a URL
    // pode ser re-navegada e parecer igual, mas a variável plantada só
    // existe se o mesmo documento continuou vivo.
    //
    // A espera é variável: `F3_HOLD_MS` (default 2s para o smoke rápido;
    // o Maestro pediu 30s e 2min — rodados como execuções separadas com
    // env override). Se o SO descartar, o sentinel desaparece e a prova
    // FALHA — report.error setado, a fase não fecha com a prova vermelha.
    eprintln!("[smoke] F3-SURVIVE: provando que o webview sobrevive ao ciclo esconder-mostrar");
    #[cfg(target_os = "macos")]
    {
        let hold_ms: u64 = std::env::var("F3_HOLD_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(2000);
        let bounds = BrowserBounds { x: 40.0, y: 80.0, width: 480.0, height: 360.0 };
        let _open = browser_session_open(app.state(), bounds);
        let create = browser_tab_create(app.clone(), app.state(), Some("https://www.youtube.com".into()));
        match create {
            Ok(snap) => {
                let tab = snap.active_tab_id.unwrap_or_default();
                if wait_for_page_ready(app, &tab).await {
                    eprintln!("[smoke] F3-SURVIVE: youtube page-ready ok");
                }
                std::thread::sleep(std::time::Duration::from_millis(1500));
                let gen: u64 = { let s = app.state::<BrowserPanelState>(); let g = s.lock().session.current_generation(&tab).unwrap_or(0); g };
                // Planta o sentinel: valor único que só sobrevive se o
                // documento NÃO recarregou.
                let sentinel = format!("f3-{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
                let plant = format!("window.__f3_sentinel = {sentinel:?}; 'planted'");
                match browser_evaluate_script(app.state(), tab.clone(), gen, plant.into()).await {
                    Ok(r) => eprintln!("[smoke] F3-SURVIVE: sentinel plantado: {sentinel} ({})", r.value),
                    Err(e) => eprintln!("[smoke] F3-SURVIVE: plant falhou: {e}"),
                }

                // Esconde pelo MESMO comando usado pela produção. O smoke
                // também lê a view nativa: se set_visible voltar a ser só
                // uma mudança no modelo Rust, esta fase fica vermelha.
                let runtime_webview = {
                    let st = app.state::<BrowserPanelState>();
                    let inner = st.lock();
                    inner.tabs.get(&tab).map(|rt| rt.webview.clone())
                };
                let observe_native_hidden = || {
                    runtime_webview
                        .as_ref()
                        .ok_or_else(|| format!("F3-SURVIVE: runtime {tab} não encontrado"))
                        .and_then(native_webview_hidden)
                };
                let hidden_native = match browser_session_set_visible(app.state(), false) {
                    Ok(snapshot) => match observe_native_hidden() {
                        Ok(hidden) => {
                            eprintln!(
                                "[smoke] F3-SURVIVE: set_visible(false) → visible={} native_hidden={hidden}",
                                snapshot.visible
                            );
                            hidden
                        }
                        Err(error) => {
                            eprintln!("[smoke] F3-SURVIVE: probe hide falhou: {error}");
                            false
                        }
                    },
                    Err(error) => {
                        eprintln!("[smoke] F3-SURVIVE: set_visible(false) falhou: {error}");
                        false
                    }
                };
                if !hidden_native && report.error.is_none() {
                    report.error = Some("F3-SURVIVE: set_visible(false) não ocultou a view nativa".into());
                }
                eprintln!("[smoke] F3-SURVIVE: webview NATIVO escondido pelo comando, esperando {hold_ms}ms...");
                std::thread::sleep(std::time::Duration::from_millis(hold_ms));

                // REABRE pelo mesmo comando e verifica também que a view
                // nativa voltou a ficar visível antes do sentinel + URL.
                let shown_native = match browser_session_set_visible(app.state(), true) {
                    Ok(snapshot) => match observe_native_hidden() {
                        Ok(hidden) => {
                            eprintln!(
                                "[smoke] F3-SURVIVE: set_visible(true) → visible={} native_hidden={hidden}",
                                snapshot.visible
                            );
                            !hidden
                        }
                        Err(error) => {
                            eprintln!("[smoke] F3-SURVIVE: probe show falhou: {error}");
                            false
                        }
                    },
                    Err(error) => {
                        eprintln!("[smoke] F3-SURVIVE: set_visible(true) falhou: {error}");
                        false
                    }
                };
                if !shown_native && report.error.is_none() {
                    report.error = Some("F3-SURVIVE: set_visible(true) não mostrou a view nativa".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(300));
                let probe_script = format!(
                    "JSON.stringify({{sentinel: window.__f3_sentinel ?? null, url: location.href}})"
                );
                let after = match browser_evaluate_script(app.state(), tab.clone(), gen, probe_script.into()).await {
                    Ok(r) => r.value, Err(e) => format!("eval-falhou: {e}"),
                };
                eprintln!("[smoke] F3-SURVIVE: após reabrir ({hold_ms}ms escondido): {after}");

                let sentinel_alive = after.contains(&sentinel);
                let url_preserved = after.contains("youtube") && !after.contains("about:blank");
                if sentinel_alive && url_preserved {
                    eprintln!("[smoke] F3-SURVIVE: >>> PROVA OK ({hold_ms}ms: documento sobreviveu — sentinel e URL intactos)");
                } else {
                    eprintln!("[smoke] F3-SURVIVE: >>> FALHOU ({hold_ms}ms: documento foi DESCARTADO — sentinel={sentinel_alive} url={url_preserved})");
                    if report.error.is_none() {
                        report.error = Some(format!(
                            "F3-SURVIVE {hold_ms}ms: sentinel_alive={sentinel_alive} url_preserved={url_preserved} — SO pode ter descartado a view oculta"
                        ));
                    }
                }
                let _ = browser_tab_close(app.state(), tab).await;
            }
            Err(e) => eprintln!("[smoke] F3-SURVIVE: criação falhou: {e}"),
        }
    }

    // F4-EVICT (2026-08-02) — PROVA PERSISTENTE: despejar destrói o
    // webview mas MANTÉM a entrada da aba; reativar recria o webview e
    // navega para a URL guardada. O ciclo prova o contrato do teto: a
    // aba sobrevive ao despejo com identidade (id, url), e volta a ser
    // navegável sem recriar do zero.
    eprintln!("[smoke] F4-EVICT: provando despejo-preserva + reativação-navega");
    #[cfg(target_os = "macos")]
    {
        let bounds = BrowserBounds { x: 40.0, y: 80.0, width: 480.0, height: 360.0 };
        let _open = browser_session_open(app.state(), bounds);
        let create = browser_tab_create(app.clone(), app.state(), Some("https://www.youtube.com".into()));
        match create {
            Ok(snap) => {
                let tab = snap.active_tab_id.unwrap_or_default();
                if wait_for_page_ready(app, &tab).await {
                    eprintln!("[smoke] F4-EVICT: youtube page-ready ok");
                }
                std::thread::sleep(std::time::Duration::from_millis(1500));

                // 1. DESPEJA: entrada preservada, evicted=true, URL guardada.
                let evicted = match browser_tab_evict(app.state(), tab.clone()).await {
                    Ok(s) => s,
                    Err(e) => { eprintln!("[smoke] F4-EVICT: evict falhou: {e}"); return Ok(report); }
                };
                let evicted_tab = evicted.tabs.iter().find(|t| t.id == tab).cloned();
                match &evicted_tab {
                    Some(t) => eprintln!("[smoke] F4-EVICT: após evict — id={} evicted={} url={}",
                        t.id, t.evicted, t.url),
                    None => eprintln!("[smoke] F4-EVICT: >>> FALHOU — aba sumiu do session após evict"),
                }
                let entry_preserved = evicted_tab.as_ref().map(|t| t.evicted && t.url.contains("youtube")).unwrap_or(false);

                // 2. REATIVA: webview recriado, navega para a URL guardada.
                let reactivated = match browser_tab_reactivate(app.clone(), app.state(), tab.clone()) {
                    Ok(s) => s,
                    Err(e) => { eprintln!("[smoke] F4-EVICT: reactivate falhou: {e}"); return Ok(report); }
                };
                std::thread::sleep(std::time::Duration::from_millis(800));
                let react_tab = reactivated.tabs.iter().find(|t| t.id == tab).cloned();
                match &react_tab {
                    Some(t) => eprintln!("[smoke] F4-EVICT: após reactivate — evicted={} url(no snapshot)={}", t.evicted, t.url),
                    None => eprintln!("[smoke] F4-EVICT: >>> FALHOU — aba sumiu após reactivate"),
                }
                // A promessa da F4: a entrada saiu do estado evicted (o
                // webview foi recriado). A URL no SNAPSHOT pode estar
                // desatualizada — bug PRÉ-EXISTENTE: o caminho de criação
                // navega via webview.navigate sem begin_navigation, então o
                // session model não sincroniza a URL (também afeta o create
                // normal). A navegação REAL é provada pelo `alive` abaixo
                // (evaluate no documento recriado).
                let reactivated_ok = react_tab.as_ref().map(|t| !t.evicted).unwrap_or(false);

                // Confirma que o webview recriado responde (navegável) E
                // está na URL guardada — a prova real da reativação.
                let gen: u64 = { let s = app.state::<BrowserPanelState>(); let g = s.lock().session.current_generation(&tab).unwrap_or(0); g };
                let alive = match browser_evaluate_script(app.state(), tab.clone(), gen,
                    "JSON.stringify({url: location.href})".into()).await {
                    Ok(r) => r.value.contains("youtube"),
                    Err(_) => false,
                };
                eprintln!("[smoke] F4-EVICT: webview reativado responde a evaluate: {alive}");

                if entry_preserved && reactivated_ok && alive {
                    eprintln!("[smoke] F4-EVICT: >>> PROVA OK (despejo preserva entrada; reativação recria webview e navega)");
                } else {
                    eprintln!("[smoke] F4-EVICT: >>> FALHOU — entry_preserved={entry_preserved} reactivated_ok={reactivated_ok} alive={alive}");
                    if report.error.is_none() {
                        report.error = Some(format!(
                            "F4-EVICT: entry_preserved={entry_preserved} reactivated_ok={reactivated_ok} alive={alive}"
                        ));
                    }
                }
                let _ = browser_tab_close(app.state(), tab).await;
            }
            Err(e) => eprintln!("[smoke] F4-EVICT: criação falhou: {e}"),
        }
    }

    // ── step: destroy session ─────────────────────────────────
    eprintln!("[smoke] step: destroy starting");
    report.destroyed = destroy_smoke_webview(app).await;
    eprintln!("[smoke] step: destroy {}",
        if report.destroyed { "ok" } else { "failed" });

        report.success = report.error.is_none();
    Ok(report)
}

/// Drain messages for a specific tab until the page signals readiness.
/// Accepts either `page-ready` (posts on DOMContentLoaded, works in
/// headless CI) or `page-loaded` (posts after a double rAF — needs
/// frame composition, never fires in headless xvfb).
///
/// In headless CI the browser never composes a frame, so `page-loaded`
/// (wrapped in `requestAnimationFrame`) never fires. `page-ready` is
/// posted synchronously when the document is ready and carries url,
/// title and viewport — it is the authoritative signal.
///
/// Returns `true` if a ready/loaded message was found within the budget
/// (400 × 50 ms = 20 s).
async fn wait_for_page_ready(app: &AppHandle, tab_id: &str) -> bool {
    for _ in 0..SMOKE_PAGE_READY_ATTEMPTS {
        let Ok(messages) = browser_drain_messages(app.state(), tab_id.into()) else {
            eprintln!("[smoke] drain failed: tab_id={tab_id}");
            return false;
        };
        if !messages.is_empty() {
            eprintln!("[smoke] drain devolveu {} msg(s) para tab {tab_id}", messages.len());
            for m in &messages {
                let preview = &m[..m.len().min(200)];
                eprintln!("[smoke]   msg: {preview}");
            }
        }
        let ready = messages.iter().any(|m| {
            serde_json::from_str::<serde_json::Value>(m)
                .ok()
                .and_then(|v| {
                    let kind = v.get("type")?.as_str()?;
                    Some(kind == "page-ready" || kind == "page-loaded")
                })
                .unwrap_or(false)
        });
        if ready {
            // The bridge callback enqueues before it returns. Confirm a later
            // UI turn so creating the next child never races that callback.
            return wait_for_ui_turn(app).await;
        }
        // `navigate` is dispatched asynchronously. A confirmed UI turn keeps
        // headless Tao/Wry runners from sleeping with that message pending.
        if !wait_for_ui_turn(app).await {
            return false;
        }
        tokio::time::sleep(SMOKE_PAGE_READY_POLL).await;
    }
    false
}

async fn wait_for_ui_turn(app: &AppHandle) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    if let Err(error) = app.run_on_main_thread(move || {
        let _ = tx.send(());
    }) {
        eprintln!("[smoke] UI turn dispatch failed: {error}");
        return false;
    }

    match tokio::time::timeout(SMOKE_STEP_TIMEOUT, rx).await {
        Ok(Ok(())) => true,
        Ok(Err(_closed)) => {
            eprintln!("[smoke] UI turn channel closed");
            false
        }
        Err(_elapsed) => {
            eprintln!("[smoke] UI turn timed out");
            false
        }
    }
}

/// Destroy the smoke webviews after the lifecycle assertions finish.
async fn destroy_smoke_webview(app: &AppHandle) -> bool {
    match browser_session_destroy(app.state()).await {
        Ok(()) => true,
        Err(e) => { eprintln!("[smoke] destroy failed: {e}"); false }
    }
}

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

// F1-AUDIO (2026-08-02) — constantes da sondagem de descarregamento.
const UNLOAD_POLL_MS: u64 = 20;
const UNLOAD_BUDGET_MS: u64 = 500;

/// F1-AUDIO (2026-08-02) — fecha uma tab parando a mídia de verdade:
/// navega para about:blank e ESPERA a confirmação de que o documento
/// descarregou antes de fechar o webview. Usado por `browser_tab_close`
/// e `browser_session_destroy` — a garantia de áudio é compartilhada.
///
/// ORÇAMENTO TOTAL (correção QA 2026-08-02): o teto é de 500ms DE
/// ORÇAMENTO TOTAL, não 500ms por iteração. O `evaluate_script` interno
/// tem timeout próprio de 5s — se cada sondagem consumisse os 5s, dez
/// sondagens somariam 50s e o teto declarado não valeria nada. Por isso
/// cada chamada é envolta em `tokio::time::timeout(remaining, ...)` com
/// o TEMPO RESTANTE do orçamento: o pior caso real é 500ms, não
/// `n × 5s`. O timeout externo cai no mesmo ramo de erro da sondagem
/// (segue sondando ou sai pelo teto e loga) — comportamento declarado
/// não muda, só passa a ser verdadeiro.
///
/// O `bool` retornado é true quando o descarregamento foi confirmado
/// (documento virou about:blank) e false quando o teto foi atingido sem
/// confirmação — o caller loga e segue fechando mesmo assim (nunca
/// travamos a UI por causa de um webview que não confirma).
async fn unload_and_close_webview(
    state: &State<'_, BrowserPanelState>,
    tab_id: &BrowserTabId,
) -> bool {
    // Navegar para about:blank com o runtime ainda no map (a sondagem
    // endereça a tab por id). O MutexGuard não cruza o await abaixo.
    {
        let mut inner = state.lock();
        if let Some(runtime) = inner.tabs.get_mut(tab_id) {
            if let Ok(blank_url) = parse_url_for_panel("about:blank") {
                if let Err(e) = runtime.webview.navigate(blank_url) {
                    eprintln!(
                        "[browser_unload] navigate(about:blank) falhou para {tab_id}: {e}"
                    );
                }
            }
        }
    }

    let poll_started = std::time::Instant::now();
    let mut unloaded = false;
    while poll_started.elapsed().as_millis() < UNLOAD_BUDGET_MS as u128 {
        let remaining = UNLOAD_BUDGET_MS.saturating_sub(poll_started.elapsed().as_millis() as u64);
        if remaining == 0 {
            break;
        }
        // String() força NSString — boolean JS puro viraria NSNumber(1)
        // cujo description é "1" e nunca casaria com "true".
        let is_blank = tokio::time::timeout(
            std::time::Duration::from_millis(remaining),
            evaluate_script(
                state,
                (*tab_id).clone(),
                "String(document.location.href === 'about:blank')".into(),
            ),
        )
        .await;
        match is_blank {
            Ok(Ok(report)) if report.value.trim() == "true" => {
                unloaded = true;
                break;
            }
            _ => {
                // evaluate pode falhar (stale, timeout, webview morto) —
                // sinal ambíguo; continua sondando até o orçamento total.
                tokio::time::sleep(std::time::Duration::from_millis(UNLOAD_POLL_MS)).await;
            }
        }
    }
    if !unloaded {
        eprintln!(
            "[browser_unload] about:blank não confirmado em {UNLOAD_BUDGET_MS}ms para {tab_id} \
             (medição real: 14ms leve, 30ms youtube) — fechando sem confirmação"
        );
    }
    unloaded
}

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

/// Reads the native child-view visibility on the UI thread. This is smoke
/// instrumentation only: the production path uses Tauri's portable
/// `Webview::hide/show`, while the macOS smoke needs an observable native
/// effect so a model-only visibility update cannot pass.
#[cfg(target_os = "macos")]
fn native_webview_hidden(webview: &Webview<Wry>) -> Result<bool, String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |platform_webview| {
            // SAFETY: Tauri gives this closure the live WKWebView pointer on
            // the AppKit main thread. WKWebView is an NSView subclass, and
            // the pointer is used only for the duration of this callback.
            let view = unsafe {
                &*(platform_webview.inner() as *const objc2_app_kit::NSView)
            };
            let _ = sender.send(view.isHiddenOrHasHiddenAncestor());
        })
        .map_err(|error| format!("ler visibilidade nativa falhou: {error}"))?;
    receiver
        .recv_timeout(Duration::from_secs(1))
        .map_err(|error| format!("aguardar visibilidade nativa falhou: {error}"))
}

// ── bridge plumbing (ungated — 3 SOs) ────────────────────────────
//
// Each of these helpers was originally inside `#[cfg(target_os = "macos")]`
// `mod macos_bridge` because the platform adapter was macOS-only. Since the
// Meridiano cycle landed `browser_platform::attach_bridge` for Windows and
// Linux, nothing in this module is macOS-specific.
mod bridge_plumbing {
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
            eprintln!("[bridge] sink recebeu {} bytes para tab {sink_tab_id}", text.len());
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
            queue_for_doc.lock().unwrap_or_else(|e| e.into_inner()).expect_document(uuid);
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
            // NOTE (NAV-20): some platform adapters (Linux) retain the
            // on_document_start callback across navigations, keeping a
            // clone of the queue Arc. Storing the Arc directly avoids
            // Arc::try_unwrap which would fail in that case.
            // Canonical lock order: panel mutex → queue mutex.
            inner.tabs.insert(
                tab_id.to_string(),
                BrowserTabRuntime {
                    webview: webview.clone(),
                    bridge: handle,
                    messages: queue,
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
    /// Lock order: panel mutex → queue mutex (NAV-20).
    pub(crate) fn push_message_with_tab(state: &BrowserPanelState, tab_id: &str, msg: String) {
        let mut inner = state.lock();
        if let Some(runtime) = inner.tabs.get_mut(tab_id) {
            let envelope: BrowserPageEnvelope = match serde_json::from_str(&msg) {
                Ok(e) => e,
                Err(error) => {
                    eprintln!(
                        "[bridge] tab {tab_id}: envelope malformado ({error}); \
                         msg prefix: {}",
                        &msg[..msg.len().min(200)]
                    );
                    return;
                }
            };
            let mut queue = runtime.messages.lock().unwrap_or_else(|e| e.into_inner());
            if let Err(reason) = queue.accept(envelope) {
                eprintln!("[bridge] tab {tab_id}: envelope rejeitado: {reason:?}");
            }
        } else {
            let known: Vec<&str> = inner.tabs.keys().map(|k| k.as_str()).collect();
            eprintln!(
                "[bridge] tab {tab_id} não encontrada entre {} tab(s) conhecida(s): {known:?}",
                inner.tabs.len()
            );
        }
    }
}

// ── Multi-tab session commands (Task 4) ────────────────────────────

fn smoke_create_trace(message: &str) {
    if std::env::var_os("VERBOO_BROWSER_SMOKE_REPORT").is_some() {
        eprintln!("[smoke:create] {message}");
    }
}

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
    set_panel_visibility(&mut inner, true)?;
    Ok(inner.snapshot())
}

#[tauri::command]
pub fn browser_session_snapshot(
    state: State<'_, BrowserPanelState>,
) -> Result<BrowserSessionSnapshot, String> {
    let inner = state.lock();
    Ok(inner.snapshot())
}

#[tauri::command]
pub fn browser_session_set_visible(
    state: State<'_, BrowserPanelState>,
    visible: bool,
) -> Result<BrowserSessionSnapshot, String> {
    let mut inner = state.lock();
    set_panel_visibility(&mut inner, visible)?;
    Ok(inner.snapshot())
}

#[tauri::command]
pub async fn browser_session_destroy(
    state: State<'_, BrowserPanelState>,
) -> Result<(), String> {
    // F1-AUDIO (2026-08-02): o destroy do painel fecha TODAS as tabs com
    // a MESMA garantia do X da aba — `unload_and_close_webview` (navegar
    // about:blank + sondar com orçamento total). Antes, fechava bruto
    // (close direto) e o áudio continuava tocando exatamente como no
    // browser_tab_close original. O helper compartilhado garante que
    // nenhum caminho de fechamento deixe mídia órfã.
    let tab_ids: Vec<BrowserTabId> = {
        let inner = state.lock();
        inner.tabs.keys().cloned().collect()
    };
    for id in &tab_ids {
        let _ = unload_and_close_webview(&state, id).await;
        let mut inner = state.lock();
        if let Some(runtime) = inner.tabs.remove(id) {
            if let Err(e) = runtime.webview.close() {
                eprintln!("[browser_session_destroy] webview.close() falhou para {id}: {e}");
            }
            // runtime.bridge drops here, unregistering the native handler.
        }
        let _ = inner.session.close(id);
    }
    let mut inner = state.lock();
    inner.bounds = None;
    set_panel_visibility(&mut inner, false)?;
    Ok(())
}

#[tauri::command(async)]
pub fn browser_tab_create(
    app: AppHandle,
    state: State<'_, BrowserPanelState>,
    url: Option<String>,
) -> Result<BrowserSessionSnapshot, String> {
    // The async command wrapper leaves the WebView2 IPC callback, while this
    // gate preserves the single-file creation order when multiple create
    // requests arrive together.
    let _creation_guard = state.lock_tab_creation();
    let tab_id = format!("verboo-browser-{}", next_label_seq());
    create_webview_with_id(&app, &state, &tab_id, url.as_deref().unwrap_or("about:blank"))?;
    let inner = state.lock();
    smoke_create_trace("browser_tab_create returning");
    Ok(inner.snapshot())
}

/// FRENTE-GOOGLE (2026-08-02): User-Agent das ABAS do navegador embutido.
///
/// PROBLEMA MEDIDO (probe descartável em runtime, macOS 27.0): a WKWebView
/// sem UA customizado envia
///   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15
///    (KHTML, like Gecko)"
/// SEM o sufixo "Version/X.Y Safari/605.1.15" que o Safari real anexa.
///
/// O Google checa RECÊNCIA do token Version, não coerência. Medido em
/// 2026-08-02 (curl -A, mesmo base, só variando o token Version):
///   ausenta                         ->  84.446 bytes, name="f"       (ANTIGO)
///   Version/27.0 Safari/605.1.15    -> 217.923 bytes, role="search"  (MODERNO)
///   Version/15.0 Safari/605.1.15    ->  65.358 bytes, name="f"       (ANTIGO)
///   Version/9.0  Safari/605.1.15    ->  84.616 bytes, name="f"       (ANTIGO)
///   Linux X11, Version/8.0          ->  84.805 bytes, name="f"       (ANTIGO)
///   Linux X11, Version/17.0         -> 212.671 bytes, role="search"  (MODERNO)
///   Windows, Chrome/131 (Edge)      -> 224.051 bytes, role="search"  (MODERNO)
/// Version/15.0 é PERFEITAMENTE coerente com AppleWebKit/605.1.15 e mesmo
/// assim leva o layout velho. Consequência: chumbar a versão reintroduz o
/// defeito sozinho quando o Safari avançar. Por isso:
///   - macOS: a versão de marketing é LIDA EM RUNTIME do bundle do Safari
///     (app de sistema, sempre presente) via NSBundle — o parser do SISTEMA
///     trata plist XML E binário, sem parser nosso;
///   - Linux: não há Safari para ler — o valor vem do FALLBACK (declarado
///     na constante), SUBSTITUINDO o token Version/ que o WebKitGTK traz
///     (anexar não resolve: o default dele tem Version/ velho);
///   - Windows: WebView2 é motor Chromium — o UA default já é Chrome/Edge
///     moderno (medido acima); forçar um UA Safari no Windows seria pior
///     para os sites. Sem override.
#[cfg(target_os = "macos")]
const BROWSER_TAB_UA_BASE: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

/// Prefixo plausível do default do WebKitGTK (Linux), COM o token
/// Version/8.0 histórico que o Maestro mediu como ANTIGO (84.805 bytes,
/// name="f").
/// LIMITE DECLARADO: testamos um UA PLAUSÍVEL do WebKitGTK, não o que a
/// nossa build realmente manda, porque não temos máquina Linux. A correção
/// é DEFENSIVA: se o WebKitGTK moderno já mandar Version alto, ela não faz
/// mal; se mandar 8.0, ela salva. NÃO foi verificado no Linux.
#[cfg(target_os = "linux")]
const BROWSER_TAB_UA_BASE_LINUX: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/8.0 Safari/605.1.15";

/// Caminho do BUNDLE do Safari — app de sistema, sempre presente no macOS.
/// Lido em runtime via NSBundle (trata plist XML e binário); se a leitura
/// falhar, usamos o fallback declarado.
#[cfg(target_os = "macos")]
const SAFARI_BUNDLE_PATH: &str = "/Applications/Safari.app";

/// FALLBACK da versão de marketing. Quando usado — macOS: leitura do bundle
/// falhou (Safari removido, sandbox); Linux: não há Safari para ler — o
/// valor é este, 27.0, o Safari no momento do fix (medido). A VERDADE AQUI:
/// se cair neste caminho e o Safari do sistema avançar muito além de 27.0,
/// o Google volta a servir o layout antigo — a derivação em runtime é o
/// caminho principal; o fallback é a exceção com degradação conhecida, não
/// "nada quebra".
const BROWSER_TAB_SAFARI_MARKETING_VERSION_FALLBACK: &str = "27.0";

/// Monta o User-Agent das abas a partir do UA que o engine forneceria +
/// a versão de marketing resolvida. Três casos:
///  1. Já existe " Version/" (WebKitGTK no Linux): SUBSTITUI o token — o
///     WebKitGTK pode mandar um Version/ velho (medido: 8.0 -> ANTIGO),
///     então anexar não resolve.
///  2. Existe " Safari/" sem " Version/": insere o Version/ antes.
///  3. Nenhum dos dois (WKWebView no macOS): anexa o sufixo completo,
///     extraindo o build do token AppleWebKit do próprio input ("605.1.15",
///     congelado pela Apple desde 2017), para o par Version/Safari casar
///     com o engine.
fn assemble_browser_tab_user_agent(engine_ua: &str, safari_version: &str) -> String {
    if let Some(version_pos) = engine_ua.find(" Version/") {
        let value_start = version_pos + " Version/".len();
        let value_end = engine_ua[value_start..]
            .find(' ')
            .map(|offset| value_start + offset)
            .unwrap_or(engine_ua.len());
        return format!(
            "{} Version/{}{}",
            &engine_ua[..version_pos],
            safari_version,
            &engine_ua[value_end..]
        );
    }
    if let Some(safari_pos) = engine_ua.find(" Safari/") {
        return format!(
            "{} Version/{} {}",
            &engine_ua[..safari_pos],
            safari_version,
            &engine_ua[safari_pos + 1..]
        );
    }
    let webkit_build = engine_ua
        .split("AppleWebKit/")
        .nth(1)
        .and_then(|rest| rest.split([' ', '(', ';']).next())
        .filter(|t| !t.is_empty())
        .unwrap_or("605.1.15");
    format!("{engine_ua} Version/{safari_version} Safari/{webkit_build}")
}

/// Resolve a versão de marketing: runtime quando disponível, fallback senão.
/// Quando cai no fallback, registra UMA VEZ — a degradação não pode ser
/// invisível, senão o sintoma ("Google está feio") aparece anos depois sem
/// ligação com a causa.
fn resolve_safari_version(runtime: Option<String>) -> String {
    match runtime {
        Some(version) => version,
        None => {
            static LOGGED: std::sync::Once = std::sync::Once::new();
            LOGGED.call_once(|| {
                eprintln!(
                    "[browser-panel] User-Agent das abas: FALLBACK em uso ({fallback}). \
                     macOS: a leitura da versão do Safari falhou; Linux: não há Safari \
                     para ler. Quando o Safari do sistema avançar muito além de \
                     {fallback}, o Google volta a servir o layout antigo.",
                    fallback = BROWSER_TAB_SAFARI_MARKETING_VERSION_FALLBACK
                );
            });
            BROWSER_TAB_SAFARI_MARKETING_VERSION_FALLBACK.to_string()
        }
    }
}

/// Lê a versão de marketing do Safari via NSBundle — o parser do SISTEMA
/// decodifica o Info.plist em XML OU binário, sem parser nosso. None em
/// qualquer falha (bundle ausente, chave ausente) — o chamador decide o
/// fallback.
#[cfg(target_os = "macos")]
fn read_safari_marketing_version() -> Option<String> {
    read_short_version_from_bundle(std::path::Path::new(SAFARI_BUNDLE_PATH))
}

/// Lê e extrai CFBundleShortVersionString de um bundle em `path`.
/// Separada para o teste de fallback forçar o caminho de falha com um
/// caminho inexistente.
#[cfg(target_os = "macos")]
fn read_short_version_from_bundle(path: &std::path::Path) -> Option<String> {
    use objc2_foundation::{NSBundle, NSString};
    let bundle = NSBundle::bundleWithPath(&NSString::from_str(&path.to_string_lossy()))?;
    let value = bundle.objectForInfoDictionaryKey(&NSString::from_str("CFBundleShortVersionString"))?;
    value
        .downcast_ref::<NSString>()
        .map(|string| string.to_string())
        .filter(|version| !version.is_empty())
}

/// Versão de marketing resolvida (runtime ou fallback), cacheada — o bundle
/// é lido no máximo uma vez por processo.
#[cfg(target_os = "macos")]
fn resolved_tab_safari_version() -> &'static str {
    static CACHED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHED.get_or_init(|| resolve_safari_version(read_safari_marketing_version()))
}

/// F4-EVICT (2026-08-02): cria (ou RECRIA) o webview de uma aba com um
/// ID DADO. Compartilhado por `browser_tab_create` (id novo) e por
/// `browser_tab_reactivate` (id de uma aba despejada — o webview foi
/// destruído no despejo, esta função o traz de volta).
///
/// NOTA DE ROLLBACK: no caminho normal (`browser_tab_create`), o
/// session model ainda não tem a tab quando esta função roda — a
/// inserção no session acontece em outro lugar? NÃO: a inserção do
/// snapshot no session model acontece aqui, via `insert_and_activate`,
/// ANTES de navegar — para que a aba exista no modelo durante o
/// navigate e o rollback consiga desfazer. A reativação (evicted)
/// reutiliza a entrada que já existe no session (desmarca evicted).
fn create_webview_with_id(
    app: &AppHandle,
    state: &State<'_, BrowserPanelState>,
    tab_id: &BrowserTabId,
    initial: &str,
) -> Result<(), String> {
    let bounds = {
        let inner = state.lock();
        resolve_session_bounds(&inner)?
    };
    let window = app
        .get_window("main")
        .ok_or_else(|| "janela principal não encontrada".to_string())?;

    let parsed = parse_url_for_panel(initial)?;
    let blank = parse_url_for_panel("about:blank")?;
    let builder = tauri::webview::WebviewBuilder::new(tab_id, tauri::WebviewUrl::External(blank))
        .incognito(true);
    // FRENTE-GOOGLE (2026-08-02): o Google checa RECÊNCIA do token Version
    // — chumbar reintroduz o defeito quando o Safari avança. O teste
    // `tab_builder_sets_user_agent` fica VERMELHO se o `.user_agent` sumir
    // da cadeia de criação das abas.
    #[cfg(target_os = "macos")]
    let builder = builder.user_agent(&assemble_browser_tab_user_agent(
        BROWSER_TAB_UA_BASE,
        resolved_tab_safari_version(),
    ));
    // Linux: WebKitGTK pode mandar Version/ velho (medido plausível: 8.0 ->
    // ANTIGO). Sem Safari para ler, o valor vem do FALLBACK (declarado na
    // constante). Correção DEFENSIVA — ver o LIMITE na constante.
    #[cfg(target_os = "linux")]
    let builder = builder.user_agent(&assemble_browser_tab_user_agent(
        BROWSER_TAB_UA_BASE_LINUX,
        BROWSER_TAB_SAFARI_MARKETING_VERSION_FALLBACK,
    ));
    // Windows (WebView2): motor Chromium — o UA default já é Chrome/Edge
    // moderno (medido: Chrome/131 -> 224KB role="search" MODERNO). Forçar
    // um UA Safari no Windows seria pior para os sites. Sem override.

    smoke_create_trace("window.add_child starting");
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| format!("add_child falhou: {e}"))?;
    smoke_create_trace("window.add_child completed");

    // F4-EVICT: na REATIVAÇÃO, a entrada evicted já existe no session —
    // o attach_message_handler (logo abaixo) chama insert_and_activate
    // que falharia com DuplicateTab. Remove a entrada evicted ANTES do
    // attach; o attach re-insere fresh (evicted=false) e o navigate no
    // fim recarrega a URL guardada.
    {
        let mut inner = state.lock();
        if inner.session.tab_evicted(tab_id) {
            inner.session.remove_tab(tab_id);
        }
    }

    smoke_create_trace("bridge attach starting");
    let attach_result = bridge_plumbing::attach_message_handler(&webview, state, tab_id);
    if let Err(error) = attach_result {
        let _ = webview.close();
        return Err(error);
    }
    smoke_create_trace("bridge attach completed");

    smoke_create_trace("visibility update starting");
    {
        let mut inner = state.lock();
        set_panel_visibility(&mut inner, true)?;
    }
    smoke_create_trace("visibility update completed");

    if initial != "about:blank" {
        smoke_create_trace("initial navigation starting");
        if let Err(error) = webview.navigate(parsed) {
            // Rollback: close the tab we just created (only on the
            // fresh-create path — an evicted tab keeps its entry).
            let mut inner = state.lock();
            let runtime = inner.tabs.remove(tab_id);
            if let Some(rt) = runtime {
                let _ = rt.webview.close();
            }
            let _ = inner.session.close(tab_id);
            return Err(format!("navigate inicial falhou: {error}"));
        }
        smoke_create_trace("initial navigation completed");
    }
    Ok(())
}

/// F4-EVICT (2026-08-02) — DESPEJA uma aba: destrói o webview (e o
/// processo WebContent) mas MANTÉM a entrada da aba (id, título, URL,
/// favicon) no session model. O renderer continua mostrando a aba —
/// marcada como despejada — e o usuário pode reativá-la, que recria o
/// webview e navega para a URL guardada.
///
/// Usa o MESMO helper do fechamento (`unload_and_close_webview`): o
/// despejo e o close compartilham o mecanismo de parar mídia e destruir
/// o webview — um lugar só, como o Maestro exigiu. A diferença é que o
/// close remove a entrada do session; o evict NÃO.
///
/// O teto de abas vivas (F4) chama este comando nas abas em excesso:
/// o processo WebContent é liberado, a aba permanece visível.
#[tauri::command]
pub async fn browser_tab_evict(
    state: State<'_, BrowserPanelState>,
    tab_id: BrowserTabId,
) -> Result<BrowserSessionSnapshot, String> {
    // Só despeja se a aba existe no session (a entrada sobrevive).
    {
        let inner = state.lock();
        if inner.session.tab_snapshot(&tab_id).is_none() {
            return Ok(inner.snapshot());
        }
    }
    // A URL guardada vem do DOCUMENTO REAL (evaluate via o caminho do
    // renderer), não do session model — que é conhecido por desatualizar
    // (browser_tab_create usa webview.navigate direto, sem
    // begin_navigation, então o session pode ficar em about:blank mesmo
    // com a aba em youtube). A URL do documento é o estado que a
    // reativação deve navegar. Timeout curto (2s) — se o documento não
    // responder, cai para o session model.
    let saved_url: Option<String> = {
        match tokio::time::timeout(
            std::time::Duration::from_secs(2),
            evaluate_script(&state, tab_id.clone(), "String(location.href)".into()),
        )
        .await
        {
            Ok(Ok(report)) if !report.value.is_empty() && report.value != "about:blank" => {
                Some(report.value)
            }
            _ => {
                // Falhou, timeout ou about:blank — cai para o session model.
                let inner = state.lock();
                inner.session.tab_snapshot(&tab_id).map(|t| t.url.clone())
            }
        }
    };
    let _ = unload_and_close_webview(&state, &tab_id).await;
    let mut inner = state.lock();
    let runtime = inner.tabs.remove(&tab_id);
    if let Some(rt) = runtime {
        if let Err(e) = rt.webview.close() {
            eprintln!("[browser_tab_evict] webview.close() falhou para {tab_id}: {e}");
        }
        // runtime.bridge drops here.
    }
    let _ = inner.session.mark_evicted(&tab_id, true);
    if let Some(url) = saved_url {
        let _ = inner.session.set_tab_url(&tab_id, url);
    }
    Ok(inner.snapshot())
}

/// F4-EVICT (2026-08-02) — REATIVA uma aba despejada: recria o webview
/// e navega para a URL guardada na entrada. O documento recarrega (a
/// posição de rolagem etc. não é preservada) — a promessa é "a aba
/// volta na MESMA URL", não "volta no mesmo scroll" (restauração de
/// scroll só com declaração explícita da UI, opcional barato).
#[tauri::command(async)]
pub fn browser_tab_reactivate(
    app: AppHandle,
    state: State<'_, BrowserPanelState>,
    tab_id: BrowserTabId,
) -> Result<BrowserSessionSnapshot, String> {
    let _creation_guard = state.lock_tab_creation();
    let saved_url = {
        let inner = state.lock();
        match inner.session.tab_snapshot(&tab_id) {
            Some(tab) if tab.evicted => tab.url.clone(),
            _ => return Ok(inner.snapshot()),
        }
    };
    create_webview_with_id(&app, &state, &tab_id, &saved_url)?;
    let inner = state.lock();
    Ok(inner.snapshot())
}

#[tauri::command]
pub fn browser_tab_activate(
    state: State<'_, BrowserPanelState>,
    tab_id: BrowserTabId,
) -> Result<BrowserSessionSnapshot, String> {
    // Collect the visibility transitions we need to perform, then apply
    // them outside the session-model borrow. This avoids the double-mut
    // borrow that would happen if the closure captured `inner`.
    let (previous, snapshot_before, panel_visible) = {
        let inner = state.lock();
        let prev = inner.session.active_id().map(|id| id.to_string());
        (prev, inner.snapshot(), inner.visibility.is_visible())
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
    let native_result = activate_native_tab(
        &previous,
        &tab_id,
        panel_visible,
        |id, visible| {
            let webview = if id == previous.as_str() {
                &hide_prev
            } else {
                &show_next
            };
            if visible {
                webview.show().map_err(|error| error.to_string())
            } else {
                let _ = webview.hide();
                Ok(())
            }
        },
    );
    match native_result {
        Ok(()) => {
            let mut inner = state.lock();
            let _ = inner.session.activate(&tab_id);
            Ok(inner.snapshot())
        }
        Err(error) => {
            let _ = hide_prev.show();
            let _ = error;
            Ok(snapshot_before)
        }
    }
}

#[tauri::command]
pub async fn browser_tab_close(
    state: State<'_, BrowserPanelState>,
    tab_id: BrowserTabId,
) -> Result<BrowserSessionSnapshot, String> {
    // F1-AUDIO (2026-08-02) — DECISÃO: navegar para about:blank e
    // ESPERAR CONFIRMAÇÃO de que o documento descarregou antes de fechar.
    //
    // MEDIDO, não inferido: a medição (a) confirmou por evaluate que
    // navegar para about:blank muda o documento de
    // `{url: youtube, hasVideo: true}` para `{url: about:blank,
    // hasVideo: false}` — o player do youtube é destruído com o
    // documento. O áudio PARA no descarregamento. O processo WebContent
    // pode persistir depois (higiene invisível) — isso é LIMITE
    // DECLARADO: a promessa ao usuário é "áudio para e aba some", e a
    // medição prova que o áudio para; o processo vivo é aceito e
    // declarado.
    //
    // ESPERA POR EVENTO, NÃO POR RELÓGIO (correção do Maestro 2026-08-02):
    // a primeira versão dormia 600ms fixos — número sem referência que
    // volta a falhar intermitente em máquina lenta e bloqueia a UI. A
    // medição real (F1c) deu: página leve 17ms, youtube com vídeo 30ms
    // até virar about:blank. A espera agora SONDA o documento de 20 em
    // 20ms até 500ms — fecha no caso comum (~40ms com a granularidade da
    // sondagem) e tem teto no caso ruim. 500ms é 16x o pior caso medido,
    // cobrindo máquina lenta sem ser infinito.
    //
    // POR QUE SONDA EM VEZ DO EVENTO DE NAVEGAÇÃO (opção (a)): o
    // callback `did_finish_navigation` existe no wry mas não é exposto
    // pelo Webview do Tauri — expô-lo exigiria patch no fork, que está
    // PROIBIDO nesta fase. A sondagem usa o sinal observável que já
    // validamos por medida: o documento em si vira about:blank.
    //
    // A sondagem usa evaluate_script (o MESMO caminho do renderer, com
    // timeout de 5s) — não eval() do Tauri, que retorna Result<()> sem
    // valor. O runtime permanece no map durante a sondagem e só é
    // removido depois da confirmação.
    //
    // NOTA DE THREAD (Send): o MutexGuard do state NÃO pode cruzar o
    // `.await` da sondagem (futuro não-Send). Navegar e soltar o guard
    // ANTES de sondar; evaluate_script religa o lock internamente por
    // tab_id, então a tab continua endereçável mesmo com o guard solto.
    // Garantia de áudio compartilhada: navegar about:blank + sondar com
    // orçamento total (500ms) — ver `unload_and_close_webview`. O
    // runtime permanece no map durante a sondagem (endereçado por id) e
    // só é removido depois da confirmação. O MutexGuard não cruza o
    // await (futuro Send).
    {
        let inner = state.lock();
        if !inner.tabs.contains_key(&tab_id) {
            return Ok(inner.snapshot());
        }
    }
    let _unloaded = unload_and_close_webview(&state, &tab_id).await;

    // Runtime confirmado como descarregado (ou teto atingido). Agora sim
    // remove do map e fecha.
    let mut inner = state.lock();
    let runtime = match inner.tabs.remove(&tab_id) {
        Some(rt) => rt,
        None => return Ok(inner.snapshot()),
    };
    // O erro do close agora é registrado, não engolido. A medição por
    // PID provou que close() retorna Ok mas o processo WebContent pode
    // continuar vivo (WKWebView retido pelo WebKit) — o log é a única
    // pista quando isso acontecer. O Result do close é despachado no
    // run loop do Tauri; propagar Err aqui esconderia o que aconteceu,
    // então registramos e seguimos.
    if let Err(e) = runtime.webview.close() {
        eprintln!(
            "[browser_tab_close] webview.close() falhou para {tab_id}: {e}"
        );
    }
    // runtime.bridge drops here, unregistering the native handler.
    if let Err(e) = inner.session.close(&tab_id) {
        eprintln!("[browser_tab_close] session.close() falhou para {tab_id}: {e:?}");
    }
    Ok(inner.snapshot())
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
    // 2026-08-01 (QA): propagar, não engolir. A forma anterior
    // (`let _ = ...map_err(|err| ...)`) construía uma String de erro
    // e a jogava fora — parecia tratamento e não tratava nada.
    //
    // POR QUE PROPAGAR (e não apenas logar): begin_navigation avança o
    // generation da sessão — o mesmo generation que a captura de
    // anotação usa como identidade (tabId + generation). Se esta
    // chamada falhar (UnknownTab — session divergeu do runtime map) e
    // a navegação continuar com sucesso silencioso, o session fica com
    // o generation ANTIGO: uma captura de anotação pós-navegação seria
    // atribuída ao CARREGAMENTO ERRADO (o check de geração validaria a
    // geração antiga como "current" para uma página que já mudou).
    //
    // Nota de ordem: webview.navigate já foi chamado acima (efeito
    // físico irreversível). Se chegarmos aqui com erro, o webview está
    // a meio de uma navegação que a sessão não registrou — o retorno
    // Err faz o renderer tratar como falha e exibir o estado de erro,
    // em vez de avançar com identidade de geração divergente.
    inner
        .session
        .begin_navigation(&tab_id, url)
        .map_err(|err| format!("begin_navigation failed: {err:?}"))?;
    Ok(inner.snapshot())
}

// F2-PAUSE (2026-08-02) — pausa a mídia de uma aba SEM destruir nem
// descarregar o documento (minimizar preserva o estado).
//
// CONTRATO (revisado pelo QA 2026-08-02, medição real):
//   ESCONDIDO (suspended=true)  = silêncio GARANTIDO — a mídia para e
//       NÃO pode retomar (macOS bloqueia via suspended; script pausa nos
//       demais).
//   ABERTO (suspended=false)    = controle devolvido E NADA tocando.
//       ATENÇÃO: o desbloqueio SOZINHO NÃO garante isso — medido no
//       smoke (F2b): play → suspender(true) → unsuspend(false) deixou
//       `paused:false` após 1s — a página com autoplay RETOMOU sozinha
//       ao ser desbloqueada. Por isso o ABERTO encadeia uma PAUSA
//       DETERMINÍSTICA logo após o desbloqueio: `video.pause()` nos
//       elementos. A doc do setAllMediaPlaybackSuspended só garante o
//       DESBLOQUEIO ("resumed in pairs"), nunca que a página não tente
//       tocar — a pausa determinística é o segundo passo que fecha a
//       promessa "aberto = nada tocando".
//
// POR PLATAFORMA (cada uma com a doc citada no código da plataforma):
//   - macOS: `setAllMediaPlaybackSuspended(true/false)` — pausa e
//     BLOQUEIA toda tentativa de retomar (página ou usuário) até o par
//     `false`. É a API certa para o ESCONDIDO. Para o ABERTO: desbloqueia
//     E pausa determinística via script.
//   - Windows: `TrySuspend` (ICoreWebView2_5) e `IsMuted` (ICoreWebView2_13)
//     NÃO estão no binding webview2-com 0.38.2 (verificado por grep nas
//     interfaces — só o TrySuspendCompletedHandler de callback existe).
//     Fallback: script no documento (`video.pause()`), limite DECLARADO:
//     não pega mídia em iframe de outra origem.
//   - Linux: `webkit_web_view_set_is_muted` existe no binding (2.0.2),
//     mas a doc diz que MUTA o áudio — o vídeo continua AVANÇANDO calado,
//     o que viola a promessa "volta exatamente do ponto". Fallback:
//     script no documento, mesmo limite declarado.
//
// O caminho script é executado via evaluate_script (o MESMO do renderer),
// então o limite de iframe cross-origin é o custo de não termos a API
// nativa no binding.
#[tauri::command]
pub async fn browser_tab_set_media_suspended(
    state: State<'_, BrowserPanelState>,
    tab_id: BrowserTabId,
    suspended: bool,
) -> Result<(), String> {
    let webview = {
        let inner = state.lock();
        match inner.tabs.get(&tab_id) {
            Some(rt) => rt.webview.clone(),
            None => return Err(format!("aba {tab_id} não existe")),
        }
    };

    // PAUSA DETERMINÍSTICA (script nos elementos): pausa qualquer mídia
    // que o desbloqueio tenha deixado retomar. Sempre encadeada no ABERTO
    // (e redundante no ESCONDIDO para plataformas sem API nativa). O
    // script é o mesmo do fallback — em macOS é o segundo passo do par.
    let pause_script = "document.querySelectorAll('video,audio').forEach(e => e.pause())";

    #[cfg(target_os = "macos")]
    {
        // ESCONDIDO: suspender nativo (bloqueia retomada — silêncio
        // garantido inclusive contra autoplay da página).
        // ABERTO: desbloquear (devolve controle) E pausa determinística
        // encadeada — a medição F2b provou que o desbloqueio sozinho
        // retoma autoplay (paused:false após 1s).
        browser_platform::set_media_suspended(webview, suspended)
            .await
            .map_err(|e| format!("set_media_suspended falhou: {e:?}"))?;
        if !suspended {
            evaluate_script(&state, tab_id, pause_script.into()).await?;
        }
        Ok(())
    }

    #[cfg(any(windows, target_os = "linux"))]
    {
        // Fallback documentado (sem API nativa no binding): pausa via
        // script nos dois sentidos — ESCONDIDO pausa, ABERTO pausa de
        // novo (garante "nada tocando" ao reabrir, mesmo que a página
        // tenha tentado retomar). Como o script não bloqueia retomada,
        // o ABERTO refaz a pausa para fechar o contrato.
        evaluate_script(&state, tab_id, pause_script.into()).await?;
        Ok(())
    }
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

fn activate_native_tab<F>(
    previous: &str,
    next: &str,
    panel_visible: bool,
    mut set_visible: F,
) -> Result<(), String>
where
    F: FnMut(&str, bool) -> Result<(), String>,
{
    set_visible(previous, false)?;
    if !panel_visible {
        return Ok(());
    }

    match set_visible(next, true) {
        Ok(()) => Ok(()),
        Err(error) => {
            // Rollback: restore visibility of the previous tab.
            let _ = set_visible(previous, true);
            Err(error)
        }
    }
}

/// Atomically activates `next`: hides the previous tab, attempts to show
/// `next` when the panel is visible, restores the previous tab on failure,
/// and only commits the model transition after the native transition
/// succeeds. When the panel is hidden, it commits only the model change;
/// `set_panel_visibility(true)` will show the newly active tab later.
///
/// `set_visible(id, visible)` is called for each visibility transition.
/// Returning `Err` from a "show" call triggers rollback: the previous tab
/// is shown again and the model is NOT mutated.
#[allow(dead_code)]
pub(crate) fn activate_atomically<F>(
    session: &mut BrowserSessionModel,
    next: &str,
    panel_visible: bool,
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
    activate_native_tab(&previous, next, panel_visible, &mut set_visible)?;
    session
        .activate(next)
        .map_err(|err| format!("activate failed: {err:?}"))?;
    Ok(())
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

/// Applies the native visibility transition to every live webview while
/// preserving the multi-tab invariant: hidden sessions hide every runtime;
/// visible sessions position every runtime first, then show only the active
/// runtime. A tab switch owns which runtime is active, so showing all live
/// runtimes here would stack inactive pages over the active page.
fn apply_native_visibility<T, P, V>(
    runtimes: &HashMap<BrowserTabId, T>,
    active_id: Option<&str>,
    bounds: Option<BrowserBounds>,
    visible: bool,
    mut position: P,
    mut set_visible: V,
) -> Result<(), String>
where
    P: FnMut(&T, BrowserBounds) -> Result<(), String>,
    V: FnMut(&T, bool) -> Result<(), String>,
{
    let bounds = if visible {
        Some(bounds.ok_or_else(|| "sessão visível sem bounds".to_string())?)
    } else {
        None
    };

    for (tab_id, runtime) in runtimes {
        if let Some(bounds) = bounds {
            position(runtime, bounds)
                .map_err(|error| format!("posicionar webview {tab_id} falhou: {error}"))?;
        }
        let should_show = visible && active_id == Some(tab_id.as_str());
        set_visible(runtime, should_show)
            .map_err(|error| format!("alterar visibilidade de {tab_id} falhou: {error}"))?;
    }
    Ok(())
}

fn set_panel_visibility(
    inner: &mut BrowserPanelInner,
    visible: bool,
) -> Result<(), String> {
    let active_id = inner.session.active_id().map(ToOwned::to_owned);
    let bounds = inner.bounds;
    let (tabs, visibility) = (&inner.tabs, &mut inner.visibility);

    visibility.set_after_native(visible, || {
        apply_native_visibility(
            tabs,
            active_id.as_deref(),
            bounds,
            visible,
            |runtime, bounds| {
                runtime
                    .webview
                    .set_position(LogicalPosition::new(bounds.x, bounds.y))
                    .map_err(|error| error.to_string())?;
                runtime
                    .webview
                    .set_size(LogicalSize::new(bounds.width, bounds.height))
                    .map_err(|error| error.to_string())
            },
            |runtime, should_show| {
                let result = if should_show {
                    runtime.webview.show()
                } else {
                    runtime.webview.hide()
                };
                result.map_err(|error| error.to_string())
            },
        )
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
    fn native_visibility_hides_all_and_positions_before_showing_active() {
        #[derive(Default)]
        struct FakeNativeView {
            events: std::cell::RefCell<Vec<&'static str>>,
        }

        let mut runtimes = HashMap::new();
        runtimes.insert("tab-a".to_string(), FakeNativeView::default());
        runtimes.insert("tab-b".to_string(), FakeNativeView::default());
        let bounds = BrowserBounds { x: 12.0, y: 34.0, width: 560.0, height: 420.0 };

        apply_native_visibility(
            &runtimes,
            Some("tab-a"),
            Some(bounds),
            false,
            |_view, _bounds| panic!("hidden transition must not position"),
            |view, visible| {
                assert!(!visible);
                view.events.borrow_mut().push("hide");
                Ok(())
            },
        )
        .unwrap();

        apply_native_visibility(
            &runtimes,
            Some("tab-a"),
            Some(bounds),
            true,
            |view, actual| {
                assert_eq!(actual, bounds);
                view.events.borrow_mut().push("position");
                Ok(())
            },
            |view, visible| {
                view.events.borrow_mut().push(if visible { "show" } else { "hide" });
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(
            runtimes["tab-a"].events.borrow().as_slice(),
            &["hide", "position", "show"]
        );
        assert_eq!(
            runtimes["tab-b"].events.borrow().as_slice(),
            &["hide", "position", "hide"]
        );
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
        let result = activate_atomically(&mut session, "b", true, |id, visible| {
            visibility.push((id.to_string(), visible));
            if id == "b" && visible { Err("show failed".to_string()) } else { Ok(()) }
        });
        assert!(result.is_err());
        assert_eq!(session.active_id(), Some("a"));
        assert_eq!(visibility, vec![("a".into(), false), ("b".into(), true), ("a".into(), true)]);
    }

    #[test]
    fn hidden_activation_defers_show_until_panel_reopens() {
        #[derive(Default)]
        struct FakeNativeView {
            events: std::cell::RefCell<Vec<&'static str>>,
        }

        let mut session = BrowserSessionModel::default();
        session.insert_and_activate(BrowserTabSnapshot::blank("a".into(), "label-a".into())).unwrap();
        session.insert_and_activate(BrowserTabSnapshot::blank("b".into(), "label-b".into())).unwrap();
        session.activate("a").unwrap();

        let runtimes = HashMap::from([
            ("a".to_string(), FakeNativeView::default()),
            ("b".to_string(), FakeNativeView::default()),
        ]);
        activate_atomically(&mut session, "b", false, |id, visible| {
            runtimes[id]
                .events
                .borrow_mut()
                .push(if visible { "show" } else { "hide" });
            Ok(())
        })
        .unwrap();

        assert_eq!(session.active_id(), Some("b"));
        assert_eq!(runtimes["a"].events.borrow().as_slice(), &["hide"]);
        assert!(runtimes["b"].events.borrow().is_empty(), "hidden activation must not show the next tab");

        let bounds = BrowserBounds { x: 12.0, y: 34.0, width: 560.0, height: 420.0 };
        apply_native_visibility(
            &runtimes,
            session.active_id(),
            Some(bounds),
            true,
            |view, actual| {
                assert_eq!(actual, bounds);
                view.events.borrow_mut().push("position");
                Ok(())
            },
            |view, visible| {
                view.events.borrow_mut().push(if visible { "show" } else { "hide" });
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(
            runtimes["a"].events.borrow().as_slice(),
            &["hide", "position", "hide"]
        );
        assert_eq!(
            runtimes["b"].events.borrow().as_slice(),
            &["position", "show"]
        );
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

    // bridge_plumbing is ungated (3 SOs now have browser_platform::attach_bridge).
    // This test runs everywhere to prove the module compiled.
    #[test]
    fn two_bridge_tokens_are_distinct_and_not_literal() {
        let t1 = bridge_plumbing::new_bridge_token();
        let t2 = bridge_plumbing::new_bridge_token();
        assert_ne!(t1, t2, "each tab must get a unique bridge token");
        assert_ne!(t1, "verboo", "bridge token must not be the development literal");
        assert_ne!(t2, "verboo", "bridge token must not be the development literal");
        assert!(!t1.is_empty());
        assert!(!t2.is_empty());
    }

    /// Regression tripwire for the `#[cfg(not(target_os = "macos"))]`
    /// `attach_message_handler` stub that was deleted in NAV-13.
    ///
    /// The stub returned `Ok(())` without registering the tab in
    /// `inner.tabs` or `inner.session`. Outside macOS, `browser_drain_messages`
    /// returned `Err("stale document: tab X not found")` and `wait_for_page_ready`
    /// silently swallowed it — the Linux CI smoke "page-ready not observed"
    /// failure.
    ///
    /// We cannot instantiate `Webview<Wry>` in a unit test to run the real
    /// `attach_message_handler`, so we **pin the source contract**: exactly one
    /// definition of `fn attach_message_handler(` must exist — the ungated
    /// `bridge_plumbing::attach_message_handler`. A second definition (the stub,
    /// regardless of cfg gate spelling or formatting) will be caught.
    ///
    /// The real implementation lives in ungated `mod bridge_plumbing` and
    /// compiles on all 3 platforms (enforced by `cargo test` on each host).
    ///
    /// Format-proof: counts only non-comment lines that look like function
    /// definitions (start with `fn `, `pub `, `pub(crate) `, or similar).
    #[test]
    fn no_stub_attach_message_handler() {
        let source = include_str!("browser_panel.rs");
        let count = source
            .lines()
            .filter(|line| {
                let t = line.trim();
                // skip doc-comments and line comments
                if t.starts_with("//") {
                    return false;
                }
                // must contain the function name
                if !t.contains("fn attach_message_handler(") {
                    return false;
                }
                // must be an actual function definition, not a string reference
                t.starts_with("fn ") || t.starts_with("pub")
            })
            .count();
        assert_eq!(
            count, 1,
            "expected exactly 1 fn attach_message_handler definition (the ungated \
             bridge_plumbing impl), found {count}. If a second definition reappears, \
             delete the cfg-gated stub."
        );
    }

    /// Count how many times `fn_name` appears as a function definition
    /// (non-comment, starts with `fn ` or `pub`) in `browser_panel.rs`.
    /// Used by tripwire tests to detect reintroduced cfg-gated stubs.
    fn count_fn_defs_in_source(fn_name: &str) -> usize {
        let source = include_str!("browser_panel.rs");
        let pattern = format!("fn {fn_name}(");
        source
            .lines()
            .filter(|line| {
                let t = line.trim();
                if t.starts_with("//") {
                    return false; // skip comments and doc-comments
                }
                if !t.contains(&pattern) {
                    return false;
                }
                // Must be a real function definition, not a string literal.
                // Valid Rust forms: `fn `, `async fn `, `pub fn `, `pub(crate) fn `, etc.
                t.starts_with("fn ")
                    || t.starts_with("async ")
                    || t.starts_with("pub")
            })
            .count()
    }

    #[test]
    fn no_stub_evaluate_script() {
        let count = count_fn_defs_in_source("evaluate_script");
        assert_eq!(
            count, 1,
            "expected exactly 1 fn evaluate_script definition (ungated), found {count}"
        );
    }

    #[test]
    fn no_stub_capture_snapshot_bytes() {
        let count = count_fn_defs_in_source("capture_snapshot_bytes");
        assert_eq!(
            count, 1,
            "expected exactly 1 fn capture_snapshot_bytes definition (ungated), found {count}"
        );
    }

    /// FRENTE-GOOGLE: com a versão de marketing LIDA EM RUNTIME (27.0 nesta
    /// máquina), o montador produz exatamente a assinatura medida via curl
    /// (form role="search" = layout moderno).
    #[test]
    fn assembles_measured_signature_from_runtime_version() {
        let engine_ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
        let ua = assemble_browser_tab_user_agent(engine_ua, "27.0");
        assert_eq!(
            ua,
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15"
        );
        assert!(ua.contains(" Version/"), "suffix must include Version/");
        assert!(
            ua.contains(" Safari/605.1.15"),
            "suffix must include the engine's own AppleWebKit build"
        );
    }

    /// FRENTE-GOOGLE / ARMADILHA LINUX: o UA do WebKitGTK JÁ traz
    /// " Safari/" e um token Version/ possivelmente VELHO (medido: 8.0 ->
    /// ANTIGO). O montador tem que SUBSTITUIR o token — não anexar, e
    /// jamais devolver o input inalterado (o comportamento antigo fazia
    /// no-op exatamente neste caso e deixava o Linux com o defeito).
    #[test]
    fn replaces_old_version_token_on_webkitgtk_ua() {
        let gtk_old = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/8.0 Safari/605.1.15";
        let fixed = assemble_browser_tab_user_agent(gtk_old, "27.0");
        assert_ne!(
            fixed, gtk_old,
            "o token Version/ velho do WebKitGTK tem que ser SUBSTITUÍDO, não mantido"
        );
        assert_eq!(
            fixed,
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15"
        );
        // Um Version/ já moderno também é atualizado (defensivo, coerente).
        let gtk_17 = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
        assert_eq!(
            assemble_browser_tab_user_agent(gtk_17, "27.0"),
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15"
        );
    }

    /// Caso defensivo: " Safari/" sem " Version/" ganha o Version/ inserido
    /// antes do token Safari (não é anexado no fim, o que quebraria a
    /// ordem dos tokens).
    #[test]
    fn inserts_version_before_safari_when_missing() {
        let no_version = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Safari/605.1.15";
        assert_eq!(
            assemble_browser_tab_user_agent(no_version, "27.0"),
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15"
        );
    }

    /// O caminho de PRODUÇÃO do Linux (base plausível + fallback) produz o
    /// UA moderno exato — é o que o builder aplica nas abas do Linux.
    #[test]
    fn linux_production_path_replaces_old_token_with_fallback() {
        let base_linux = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/8.0 Safari/605.1.15";
        assert_eq!(
            assemble_browser_tab_user_agent(
                base_linux,
                BROWSER_TAB_SAFARI_MARKETING_VERSION_FALLBACK,
            ),
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15"
        );
    }

    /// Sem token AppleWebKit, o build de fallback mantém assinatura válida.
    #[test]
    fn uses_frozen_build_when_engine_token_missing() {
        assert_eq!(
            assemble_browser_tab_user_agent("Mozilla/5.0 (custom)", "27.0"),
            "Mozilla/5.0 (custom) Version/27.0 Safari/605.1.15"
        );
    }

    /// Resolve runtime quando disponível e cai no fallback quando não.
    ///
    /// O valor de runtime é "99.9" — que NUNCA pode coincidir com o fallback
    /// (27.0) — para que os dois caminhos produzam textos DISTINGUÍVEIS.
    /// Testar só com "27.0" é cego: nesta máquina o runtime vale o mesmo que
    /// o fallback, então uma mutação que descarta o valor de runtime passa
    /// em qualquer comparação de valor. (Ex.: `let runtime = None;` no início
    /// de `resolve_safari_version` passa no teste antigo e é pego por este.)
    #[test]
    fn resolves_runtime_or_fallback() {
        assert_eq!(resolve_safari_version(Some("99.9".to_string())), "99.9");
        assert_eq!(
            resolve_safari_version(None),
            BROWSER_TAB_SAFARI_MARKETING_VERSION_FALLBACK
        );
        assert_ne!(
            resolve_safari_version(Some("99.9".to_string())),
            resolve_safari_version(None),
            "os dois caminhos têm que ser distinguíveis"
        );
    }

    /// Pina que o valor de runtime atravessa ATÉ A STRING FINAL do UA, não
    /// só até a função `resolve`. Runtime (99.9) e fallback (27.0) têm que
    /// produzir UAs DIFERENTES — uma mutação que troque o valor no meio do
    /// caminho apaga essa diferença.
    #[test]
    fn runtime_value_flows_to_final_ua_string() {
        let engine_ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
        let runtime_ua = assemble_browser_tab_user_agent(
            engine_ua,
            &resolve_safari_version(Some("99.9".to_string())),
        );
        let fallback_ua = assemble_browser_tab_user_agent(
            engine_ua,
            &resolve_safari_version(None),
        );
        assert!(
            runtime_ua.contains("Version/99.9"),
            "o valor de runtime tem que aparecer na string final do UA"
        );
        assert_ne!(
            runtime_ua, fallback_ua,
            "caminho de runtime e caminho de fallback têm que divergir quando os valores divergem"
        );
        assert!(fallback_ua.contains(&format!(
            "Version/{}",
            BROWSER_TAB_SAFARI_MARKETING_VERSION_FALLBACK
        )));
    }

    /// Caminho de FALHA da leitura: caminho inexistente -> None -> fallback.
    /// O fallback mantém a assinatura funcional hoje, mas o comentário da
    /// constante declara a degradação: se o Safari avançar muito e cairmos
    /// aqui, o Google volta ao layout antigo.
    ///
    /// A falha é forçada com um caminho de bundle INEXISTENTE — o NSBundle
    /// devolve None (o parser do sistema não acha o bundle), o resolver cai
    /// no fallback e o UA montado mantém a assinatura funcional.
    #[cfg(target_os = "macos")]
    #[test]
    fn fallback_path_when_bundle_read_fails() {
        let missing = std::path::Path::new("/nonexistent/Safari.app");
        assert_eq!(read_short_version_from_bundle(missing), None);
        let resolved = resolve_safari_version(read_short_version_from_bundle(missing));
        assert_eq!(resolved, BROWSER_TAB_SAFARI_MARKETING_VERSION_FALLBACK);
        let engine_ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
        assert_eq!(
            assemble_browser_tab_user_agent(engine_ua, &resolved),
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15"
        );
    }

    /// Integração (só macOS): a LEITURA REAL do plist do Safari nesta
    /// máquina tem que devolver a versão medida (27.0) e o UA montado com
    /// ela tem que casar com a assinatura que o Google serve em modo
    /// moderno. Se o Safari da máquina avançar, este teste aponta a
    /// necessidade de re-medir a assinatura — é o tripwire da recência.
    #[cfg(target_os = "macos")]
    #[test]
    fn runtime_safari_read_matches_measured_signature() {
        let version = read_safari_marketing_version().expect("Safari plist deve ser legível no macOS");
        assert_eq!(version, "27.0", "versão do Safari desta máquina (medida)");
        let engine_ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
        let ua = assemble_browser_tab_user_agent(engine_ua, &version);
        assert!(ua.ends_with("Version/27.0 Safari/605.1.15"));
        assert_eq!(resolved_tab_safari_version(), "27.0");
    }

    /// REGRESSÃO FRENTE-GOOGLE: se alguém remover o `.user_agent(...)` da
    /// criação das abas, este teste fica VERMELHO — e o Google volta a
    /// servir o layout antigo silenciosamente.
    #[test]
    fn tab_builder_sets_user_agent() {
        let source = include_str!("browser_panel.rs").replace("\r\n", "\n");
        let create_start = source
            .find("fn create_webview_with_id")
            .expect("create_webview_with_id");
        let create_end = source[create_start..]
            .find("\npub fn ")
            .map(|offset| create_start + offset)
            .expect("create_webview_with_id end");
        let create = &source[create_start..create_end];
        // Comentários (//, ///) são descartados ANTES de buscar as strings —
        // senão o próprio comentário do fix satisfaria a asserção e a
        // remoção do código passaria despercebida (falso-verde).
        let create_code: String = create
            .lines()
            .filter(|line| !line.trim().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            create_code.contains(".user_agent("),
            "create_webview_with_id must set the tab user agent (Frente Google); removing it silently reverts google.com to the old layout"
        );
        assert!(
            create_code.contains("assemble_browser_tab_user_agent("),
            "the tab user agent must be assembled from the engine UA + the RUNTIME-read Safari version"
        );
        assert!(
            create_code.contains("resolved_tab_safari_version("),
            "the macOS Safari marketing version must come from runtime resolution (recency check), not a hardcoded value"
        );
        assert!(
            create_code.contains("BROWSER_TAB_UA_BASE_LINUX"),
            "Linux must also set the tab user agent (WebKitGTK can send a stale Version/ token); removing it leaves Linux with the old-google defect"
        );
        assert!(
            create_code.contains("BROWSER_TAB_SAFARI_MARKETING_VERSION_FALLBACK"),
            "Linux has no Safari to read, so its version must come from the declared fallback"
        );
    }

    /// Class-level assertion: no `#[cfg(not(target_os = "macos"))]` stub
    /// and no `"somente macOS"` error message may exist anywhere in
    /// non-comment code. Catches ANY reintroduction of the cfg-gated
    /// stub pattern, not just the specific functions already tripwired.
    ///
    /// Comment lines (///, //) are excluded so historical doc comments
    /// in the tripwire tests don't trigger false positives.
    #[test]
    fn no_cfg_gated_stubs_anywhere() {
        let source = include_str!("browser_panel.rs");
        // Search only in production code (before `mod tests {`), so the
        // test assertions and doc comments cannot self-reference.
        let prod_end = source.find("\nmod tests {").unwrap_or(source.len());
        let production = &source[..prod_end];
        let non_comment: String = production
            .lines()
            .filter(|line| !line.trim().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !non_comment.contains("cfg(not(target_os = \"macos\")"),
            "cfg(not(macos)) block found in production code. \
             All platform dispatch must go through ungated browser_platform::*.",
        );
        assert!(
            !non_comment.contains("somente macOS"),
            "\"somente macOS\" error message found in production code. \
             All stubs that announce being macOS-only must be deleted.",
        );
    }

    #[test]
    fn set_after_native_has_one_production_call_site() {
        let source = include_str!("browser_panel.rs");
        let prod_end = source.find("\nmod tests {").unwrap_or(source.len());
        let production = &source[..prod_end];
        let call_sites = production.matches("set_after_native(").count();

        assert_eq!(
            call_sites,
            1,
            concat!(
                "set_after_native must have exactly one production call site; a second call site ",
                "would create another path to mutate visibility and could pass an empty closure ",
                "(`|| Ok(())`) instead of performing the real native hide/show transition. ",
                "Found {} call sites."
            ),
            call_sites,
        );
    }

    /// Prove that an `Arc<Mutex<BrowserBridgeQueue>>` shared between the
    /// runtime and a retained callback (as Linux does with
    /// `on_document_start` in a `connect_load_changed` handler) can be
    /// used from both sides.
    ///
    /// This documents the QUEUE-SHARING contract, not the regression
    /// protection — the real anti-regression guard is the COMPILER:
    /// `messages` is `Arc<Mutex<BrowserBridgeQueue>>`, and reverting
    /// to bare `BrowserBridgeQueue` breaks the assign at the insert
    /// site since no `Arc::try_unwrap` remains.
    #[test]
    fn shared_queue_works_when_callback_retains_clone() {
        let queue = Arc::new(Mutex::new(BrowserBridgeQueue::new(
            "tab-test".into(),
            "secret".into(),
        )));

        // Simulate Linux: on_document_start callback retains a clone
        // (connect_load_changed keeps the Fn alive across navigations).
        let retained = queue.clone();
        let callback: Arc<dyn Fn(String) + Send + Sync> =
            Arc::new(move |uuid| {
                retained.lock().unwrap().expect_document(uuid);
            });

        // After "attach_bridge returns", the runtime stores queue.
        // With old Arc::try_unwrap this would fail (ref count: 2).
        let stored = queue; // moves the Arc (strong refs: runtime + callback)
        assert_eq!(
            Arc::strong_count(&stored),
            2,
            "runtime ref + retained callback ref = 2"
        );

        // Runtime accesses the queue via its Arc.
        stored
            .lock()
            .unwrap()
            .expect_document("doc-1".into());
        assert_eq!(
            stored.lock().unwrap().current_document_token(),
            Some("doc-1")
        );

        // The retained callback also accesses the same underlying queue.
        callback("doc-2".into());
        assert_eq!(
            stored.lock().unwrap().current_document_token(),
            Some("doc-2"),
            "observer mutation visible through shared Arc"
        );

        // Queue can also accept/process messages normally.
        let envelope = BrowserPageEnvelope {
            tab_id: "tab-test".into(),
            bridge_token: "secret".into(),
            document_token: "doc-2".into(),
            payload: r#"{"type":"test"}"#.into(),
        };
        stored.lock().unwrap().accept(envelope).unwrap();
        let drained = stored.lock().unwrap().drain();
        assert_eq!(drained.len(), 1, "message accepted and drainable");
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

    #[test]
    fn runtime_smoke_never_double_dispatches_child_webview_creation() {
        let source = include_str!("browser_panel.rs");
        let prod_end = source.find("\nmod tests {").unwrap_or(source.len());
        let production = &source[..prod_end];
        let smoke_start = production
            .find("async fn run_runtime_smoke")
            .expect("runtime smoke");
        let wait_start = production
            .find("async fn wait_for_page_ready")
            .expect("page-ready waiter");
        let smoke = &production[smoke_start..wait_start];

        assert!(
            !smoke.contains("on_main_thread("),
            "Window::add_child already dispatches and waits for the main thread"
        );
    }

    #[test]
    fn runtime_smoke_uses_page_ready_instead_of_an_arbitrary_tab_delay() {
        let source = include_str!("browser_panel.rs");
        let prod_end = source.find("\nmod tests {").unwrap_or(source.len());
        let production = &source[..prod_end];
        let first_ready = production
            .find("report.bridge_received = true")
            .expect("first tab page-ready checkpoint");
        let second_tab = production[first_ready..]
            .find("// ── step: create tab 2")
            .map(|offset| first_ready + offset)
            .expect("second tab creation");

        assert!(!production[first_ready..second_tab].contains("sleep("));
    }

    #[test]
    fn runtime_smoke_does_not_idle_before_creating_the_first_tab() {
        let source = include_str!("browser_panel.rs");
        let prod_end = source.find("\nmod tests {").unwrap_or(source.len());
        let production = &source[..prod_end];
        let smoke_start = production
            .find("async fn run_runtime_smoke")
            .expect("runtime smoke");
        let first_tab = production[smoke_start..]
            .find("// ── step: create tab 1")
            .map(|offset| smoke_start + offset)
            .expect("first tab creation");

        assert!(!production[smoke_start..first_tab].contains("sleep("));
    }

    #[test]
    fn page_ready_waiter_advances_only_after_a_confirmed_ui_turn() {
        let source = include_str!("browser_panel.rs");
        let prod_end = source.find("\nmod tests {").unwrap_or(source.len());
        let production = &source[..prod_end];
        let waiter_start = production
            .find("async fn wait_for_page_ready")
            .expect("page-ready waiter");
        let waiter_end = production[waiter_start..]
            .find("\n/// Destroy the smoke webviews")
            .map(|offset| waiter_start + offset)
            .expect("page-ready waiter end");
        let waiter = &production[waiter_start..waiter_end];

        assert!(production.contains("async fn wait_for_ui_turn"));
        assert!(
            waiter.matches("wait_for_ui_turn(app).await").count() >= 2,
            "the waiter must nudge idle navigation and flush the ready callback"
        );
    }

    #[test]
    fn windows_browser_tabs_keep_the_webview2_environment_on_the_ui_thread() {
        let source = include_str!("browser_panel.rs");
        let wry_source = include_str!("../../vendor/wry/src/webview2/mod.rs").replace("\r\n", "\n");
        let create_start = source
            .find("pub fn browser_tab_create")
            .expect("browser_tab_create");
        let create_end = source[create_start..]
            .find("pub fn browser_tab_activate")
            .map(|offset| create_start + offset)
            .expect("browser_tab_create end");
        let create = &source[create_start..create_end];

        assert!(
            !create.contains(".environment()") && !create.contains(".with_environment("),
            "CoreWebView2Environment must never round-trip through the async command thread"
        );
        assert!(
            wry_source.contains("EMBEDDED_BROWSER_ENVIRONMENT")
                && wry_source.contains("EmbeddedBrowserEnvironmentLease")
                && wry_source.contains("acquire_embedded_browser_environment"),
            "vendored Wry must share the embedded-browser environment entirely on its UI STA"
        );
        assert!(
            create
                .find("let _creation_guard = state.lock_tab_creation();")
                .is_some_and(|gate| gate < create.find("let bounds").unwrap()),
            "tab creation must be serialized before reading or mutating session state"
        );
    }

    #[test]
    fn windows_tab_creation_runs_outside_the_webview2_ipc_callback() {
        let source = include_str!("browser_panel.rs").replace("\r\n", "\n");
        assert!(
            source.contains("#[tauri::command(async)]\npub fn browser_tab_create"),
            "tab creation must leave the WebView2 IPC callback before waiting on main-thread work"
        );
    }

    #[test]
    fn tab_creation_gate_serializes_concurrent_requests() {
        let state = Arc::new(BrowserPanelState::default());
        let first_guard = state.lock_tab_creation();
        let second_state = Arc::clone(&state);
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);

        let second_request = std::thread::spawn(move || {
            let _guard = second_state.lock_tab_creation();
            entered_tx.send(()).unwrap();
        });

        assert!(
            matches!(
                entered_rx.recv_timeout(Duration::from_millis(50)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ),
            "a second creation request must wait for the first"
        );
        drop(first_guard);
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        second_request.join().unwrap();
    }

    #[test]
    fn page_ready_budget_covers_a_slow_headless_navigation() {
        let budget = SMOKE_PAGE_READY_POLL * SMOKE_PAGE_READY_ATTEMPTS as u32;
        assert!(budget >= Duration::from_secs(20));
    }

    #[test]
    fn runtime_smoke_starts_only_after_the_event_loop_is_pumping() {
        let source = include_str!("../lib.rs");
        let setup_start = source.find(".setup(|app|").expect("setup callback");
        let invoke_start = source
            .find(".invoke_handler(tauri::generate_handler!")
            .expect("invoke handler");
        let setup = &source[setup_start..invoke_start];

        assert!(!setup.contains("start_runtime_smoke"));
        assert!(source.contains("tauri::RunEvent::MainEventsCleared"));
    }
}
