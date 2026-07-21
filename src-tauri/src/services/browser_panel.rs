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

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluateReport {
    pub ms: u128,
    pub value: String,
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

/// Bootstrap injetado em `document start` em toda página carregada pelo
/// painel. Idempotente. Expõe `window.__verbooProbe.ping()` para smoke
/// tests e anuncia a página via `webkit.messageHandlers.verboo`
/// (ADR-0003 channel — Fase 3 lê isso).
const PROBE_JS: &str = r#"
(function () {
  if (window.__verbooProbeInstalled) return;
  window.__verbooProbeInstalled = true;
  window.__verbooProbe = {
    ping: function () { return 'pong:' + location.href; }
  };
  var tries = 0;
  var timer = setInterval(function () {
    tries += 1;
    try {
      window.webkit.messageHandlers.verboo.postMessage('hello:' + location.href);
      clearInterval(timer);
    } catch (e) {
      if (tries >= 10) clearInterval(timer);
    }
  }, 500);
})();
"#;

// ── Commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn browser_create(
    app: AppHandle,
    state: State<'_, BrowserPanelState>,
    bounds: BrowserBounds,
    url: Option<String>,
) -> Result<BrowserCreateReport, String> {
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

    let builder = tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed))
        // Perfil limpo (ADR-0001 critério 4): non-persistent, sem cookies
        // nem logins do usuário.
        .incognito(true)
        .initialization_script(PROBE_JS);

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| format!("add_child falhou: {e}"))?;

    attach_message_handler(&webview, &state);

    {
        let mut inner = state.lock();
        inner.webview = Some(webview);
        inner.label = Some(label.clone());
        inner.messages.clear();
    }

    Ok(BrowserCreateReport { label })
}

#[tauri::command]
pub fn browser_navigate(
    state: State<'_, BrowserPanelState>,
    url: String,
) -> Result<(), String> {
    let parsed = parse_url_for_panel(&url)?;
    let inner = state.lock();
    let webview = inner
        .webview
        .as_ref()
        .ok_or_else(|| "sem webview".to_string())?;
    let mut webview = webview.clone();
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
pub fn browser_back(state: State<'_, BrowserPanelState>) -> Result<(), String> {
    let inner = state.lock();
    let webview = inner
        .webview
        .as_ref()
        .ok_or_else(|| "sem webview".to_string())?;
    let mut webview = webview.clone();
    webview
        .eval("window.history.back();")
        .map_err(|e| format!("back falhou: {e}"))
}

#[tauri::command]
pub fn browser_forward(state: State<'_, BrowserPanelState>) -> Result<(), String> {
    let inner = state.lock();
    let webview = inner
        .webview
        .as_ref()
        .ok_or_else(|| "sem webview".to_string())?;
    let mut webview = webview.clone();
    webview
        .eval("window.history.forward();")
        .map_err(|e| format!("forward falhou: {e}"))
}

#[tauri::command]
pub fn browser_reload(state: State<'_, BrowserPanelState>) -> Result<(), String> {
    let inner = state.lock();
    let webview = inner
        .webview
        .as_ref()
        .ok_or_else(|| "sem webview".to_string())?;
    let mut webview = webview.clone();
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
        let webview = current_webview(&state)?;
        let started = Instant::now();
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
            .map_err(|e| format!("with_webview falhou: {e}"))?;

        let bytes = tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .map_err(|_| "snapshot timed out".to_string())?
            .map_err(|_| "snapshot channel dropped".to_string())??;

        let ms = started.elapsed().as_millis();
        let path = std::env::temp_dir().join("verboo-browser-snapshot.png");
        std::fs::write(&path, &bytes).map_err(|e| format!("write falhou: {e}"))?;
        Ok(SnapshotReport {
            ms,
            bytes: bytes.len(),
            path: path.to_string_lossy().into_owned(),
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        Err("snapshot: somente macOS no spike".into())
    }
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
        let webview = current_webview(&state)?;
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
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        let _ = script;
        Err("evaluate_script: somente macOS no spike".into())
    }
}

// ── Internals ────────────────────────────────────────────────────────

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
        inner.messages.push(msg);
    }
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
        WKScriptMessage, WKScriptMessageHandler, WKUserContentController, WKWebView,
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

    pub fn attach_handler(wk: &WKWebView) {
        // O `state` já deve estar registrado em `STATE_PTR` antes desta
        // chamada (feito em `attach_message_handler`). Aqui só
        // registramos o ObjC handler no webview.
        let mtm = MainThreadMarker::new().expect("with_webview corre na main thread");
        let handler = MsgHandler::new(mtm);
        let proto: &ProtocolObject<dyn WKScriptMessageHandler> =
            ProtocolObject::from_ref(&*handler);
        unsafe {
            let controller = wk.configuration().userContentController();
            // O controller retém o handler; o `Retained` pode dropar.
            controller.addScriptMessageHandler_name(proto, &NSString::from_str("verboo"));
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
            wk.evaluateJavaScript_completionHandler(&NSString::from_str(script), Some(&block))
        };
    }
}

#[cfg(target_os = "macos")]
fn attach_message_handler(webview: &Webview<Wry>, state: &BrowserPanelState) {
    // Registra o ponteiro de estado no singleton ANTES de with_webview,
    // para que o handler nativo (WKScriptMessageHandler) o encontre
    // via STATE_PTR.get() no callback. O closure de with_webview só
    // precisa capturar `pw` (Send) — não captura `state`.
    native::register_state(state);
    let _ = webview.with_webview(|pw| unsafe {
        let wk = native::wk_from_ptr(pw.inner().cast());
        native::attach_handler(wk);
    });
}

#[cfg(not(target_os = "macos"))]
fn attach_message_handler(_webview: &Webview<Wry>, _state: &BrowserPanelState) {}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

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
}
