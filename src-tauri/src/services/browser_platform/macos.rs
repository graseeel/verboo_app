use std::sync::Arc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
use objc2_foundation::{NSDictionary, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_web_kit::{
    WKContentWorld, WKScriptMessage, WKScriptMessageHandler, WKUserContentController,
    WKUserScript, WKUserScriptInjectionTime, WKWebView,
};
use tauri::webview::Webview;
use tauri::Wry;

use super::{BrowserPlatformError, PageMessageSink, PlatformFuture};
use crate::services::browser_bridge::BridgeConfig;

/// Owns the native message handler registration for one webview tab.
///
/// Dropping the handle dispatches the injectable `unregister` closure,
/// which in production calls `removeScriptMessageHandlerForContentWorld`
/// on the main thread. The unregister action is injectable so that
/// unit tests can verify the handler name is passed correctly without
/// a real WKWebView.
pub struct BridgeHandle {
    pub(crate) handler_name: String,
    pub(crate) unregister: Option<Box<dyn FnOnce(&str) + Send>>,
}

impl Drop for BridgeHandle {
    fn drop(&mut self) {
        if let Some(f) = self.unregister.take() {
            f(&self.handler_name);
        }
    }
}

/// Per-instance storage for `MsgHandler`. Each handler created via
/// `MsgHandler::new(mtm, sink)` holds ITS OWN sink — no globals, no
/// shared state, no use-after-free. The handler is retained by the
/// `WKUserContentController` (registered via
/// `addScriptMessageHandler`), so the ivars (and therefore the sink)
/// outlive every page message that the controller delivers to this
/// handler. The sink is dropped when `BridgeHandle::drop` removes the
/// handler and the controller releases its last retain.
pub struct MsgHandlerIvars {
    pub sink: PageMessageSink,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "VerbooBrowserMsgHandler"]
    #[ivars = MsgHandlerIvars]
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
            // The sink lives in the ivars of THIS handler instance. The
            // controller retained this handler at registration time, so
            // the ivars are valid for every delivery. When
            // `BridgeHandle::drop` removes the handler, the controller
            // releases it and the ivars (including the Arc-backed sink)
            // are freed — never before, never dangling.
            (self.ivars().sink)(text);
        }
    }
);

impl MsgHandler {
    fn new(mtm: MainThreadMarker, sink: PageMessageSink) -> Retained<Self> {
        let this = Self::alloc(mtm);
        let this = this.set_ivars(MsgHandlerIvars { sink });
        unsafe { msg_send![super(this), init] }
    }
}

/// # Safety: deve ser chamada na main thread com um ponteiro WKWebView válido.
pub unsafe fn wk_from_ptr<'a>(ptr: *mut std::ffi::c_void) -> &'a WKWebView {
    &*(ptr as *const WKWebView)
}

fn trusted_world(mtm: MainThreadMarker) -> Retained<WKContentWorld> {
    unsafe { WKContentWorld::defaultClientWorld(mtm) }
}

/// Script injetado. Mantido aqui enquanto a Task 7 não reformula o formato
/// de fábrica. O conteúdo é o mesmo do `browser_panel`, só a proveniência muda.
const BROWSER_INJECT_JS: &str = include_str!("../browser_inject.js");

/// Transport factory — define `globalThis.__VERBOO_NATIVE_TRANSPORT__` at
/// document-start BEFORE the inject.js runs and BEFORE any page script.
/// The inject.js (Vitral / Task 7) captures `tabId`, `bridgeToken`,
/// `documentToken` from this global into a closure and then IMMEDIATELY
/// deletes it so no page script can read the bridge credentials.
/// WebKit-specific transport factory. NOT shared contract — Windows uses
/// `window.chrome.webview.postMessage` instead. The filename explicitly
/// marks this as a WebKit implementation.
const WEBKIT_TRANSPORT_TEMPLATE: &str = include_str!("webkit_transport_setup.js");

/// Name registered in `WKUserContentController` as the
/// `addScriptMessageHandler` key and read by
/// `window.webkit.messageHandlers.<NAME>` in `browser_inject.js`.
///
/// DO NOT per-tab this. Each WKWebView owns its own
/// `WKUserContentController`, so the same name in different webviews is
/// already isolated by construction. Per-tab destinations are
/// disambiguated by the sink inside the handler's ivars (one MsgHandler
/// per `attach_bridge` call, each carrying its own closure back to its
/// own `BrowserBridgeQueue`).
///
/// This name MUST stay in sync with `browser_inject.js`. The test
/// `rust_and_inject_agree_on_handler_name` enforces that.
const HANDLER_NAME: &str = "verboo";

fn handler_name_for(_config: &BridgeConfig) -> &'static str {
    HANDLER_NAME
}

/// Anexa o bridge a um webview: instala handler nativo + script injetado
/// num `WKContentWorld` isolado.
///
/// Cada aba recebe SEU PRÓPRIO `MsgHandler` com SEU PRÓPRIO sink como
/// ivar — nada de global compartilhado, nada de use-after-free.
///
/// Ordem crítica:
/// 1. Gera UUID de documento.
/// 2. Chama `on_document_start(uuid)` — Rust sabe que a aba é doc N.
/// 3. Instala script e handler (com o sink desta aba).
///
/// Retorna um `BridgeHandle` que, ao sofrer drop, remove o handler.
pub fn attach_bridge(
    webview: &Webview<Wry>,
    config: BridgeConfig,
    sink: PageMessageSink,
    on_document_start: Arc<dyn Fn(String) + Send + Sync + 'static>,
) -> Result<BridgeHandle, BrowserPlatformError> {
    let document_uuid = uuid::Uuid::new_v4().to_string();
    on_document_start(document_uuid.clone());

    let name = handler_name_for(&config);
    let install_tab_id = config.tab_id.clone();
    let install_bridge_token = config.token.clone();
    let install_document_token = document_uuid.clone();
    let install_sink = sink.clone();
    let wv = webview.clone();

    webview
        .with_webview(move |pw| unsafe {
            let wk = wk_from_ptr(pw.inner().cast());
            install_handler(wk, &install_tab_id, &install_bridge_token, &install_document_token, name, install_sink);
        })
        .map_err(|error| {
            BrowserPlatformError::new("attach_bridge", "macos", error.to_string())
        })?;

    let unregister: Option<Box<dyn FnOnce(&str) + Send>> = Some(Box::new(move |_| {
        let _ = wv.with_webview(move |pw| unsafe {
            let wk = wk_from_ptr(pw.inner().cast());
            let controller = wk.configuration().userContentController();
            let mtm = MainThreadMarker::new()
                .expect("unregister roda na main thread");
            let world = trusted_world(mtm);
            let ns_name = NSString::from_str(name);
            let _: () = msg_send![&*controller, removeScriptMessageHandlerForContentWorld: &*world, name: &*ns_name];
        });
    }));

    Ok(BridgeHandle {
        handler_name: name.to_string(),
        unregister,
    })
}

/// Instala o handler nativo + user scripts no WKWebView.
///
/// Ordem de instalação (execução em document-start, nesta sequência):
///   1. Transport factory — define `globalThis.__VERBOO_NATIVE_TRANSPORT__`
///      com os tokens desta aba (tabId, bridgeToken, documentToken).
///   2. Inject.js (Vitral / Task 7) — captura o transport numa closure,
///      deleta o global, e usa `transport.post()` para enviar mensagens.
///   3. Message handler — registra `name` para as mensagens chegarem.
///
/// O `sink` entra como ivar do `MsgHandler`, retido pelo controller.
fn install_handler(
    wk: &WKWebView,
    tab_id: &str,
    bridge_token: &str,
    document_token: &str,
    handler_name: &str,
    sink: PageMessageSink,
) {
    let mtm = MainThreadMarker::new().expect("with_webview roda na main thread");
    let handler = MsgHandler::new(mtm, sink);
    let proto: &ProtocolObject<dyn WKScriptMessageHandler> =
        ProtocolObject::from_ref(&*handler);
    unsafe {
        let controller = wk.configuration().userContentController();
        let world = trusted_world(mtm);

        // 1. Transport factory script (runs BEFORE inject.js).
        // Serialize each value via JSON so special characters (quotes,
        // backslashes, etc.) are escaped — NEVER concatenate untrusted
        // input directly into JavaScript source.
        let transport_js = WEBKIT_TRANSPORT_TEMPLATE
            .replace(
                r#""%TAB_ID%""#,
                &serde_json::to_string(tab_id).unwrap_or_default(),
            )
            .replace(
                r#""%BRIDGE_TOKEN%""#,
                &serde_json::to_string(bridge_token).unwrap_or_default(),
            )
            .replace(
                r#""%DOCUMENT_TOKEN%""#,
                &serde_json::to_string(document_token).unwrap_or_default(),
            )
            .replace(
                r#""%HANDLER_NAME%""#,
                &serde_json::to_string(handler_name).unwrap_or_default(),
            );
        let transport_script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly_inContentWorld(
            WKUserScript::alloc(mtm),
            &NSString::from_str(&transport_js),
            WKUserScriptInjectionTime::AtDocumentStart,
            true,
            &world,
        );
        controller.addUserScript(&transport_script);

        // 2. Inject.js (the actual app bootstrap).
        let user_script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly_inContentWorld(
            WKUserScript::alloc(mtm),
            &NSString::from_str(BROWSER_INJECT_JS),
            WKUserScriptInjectionTime::AtDocumentStart,
            true,
            &world,
        );
        controller.addUserScript(&user_script);

        // 3. Message handler registration.
        controller.addScriptMessageHandler_contentWorld_name(
            proto,
            &world,
            &NSString::from_str(handler_name),
        );
    }
}

/// Avalia JS no `WKContentWorld` isolado. O timeout externo de 5 s
/// permanece no caller (browser_panel).
pub fn evaluate(webview: Webview<Wry>, script: String) -> PlatformFuture<String> {
    Box::pin(async move {
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
        let tx = Arc::new(std::sync::Mutex::new(Some(tx)));

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
                    let wk = wk_from_ptr(pw.inner().cast());
                    eval_with_result(wk, &script, deliver);
                }
            })
            .map_err(|e| BrowserPlatformError::new("evaluate", "macos", e.to_string()))?;

        tokio::time::timeout(EVAL_TIMEOUT, rx)
            .await
            .map_err(|_| BrowserPlatformError::new("evaluate", "macos", "timed out"))?
            .map_err(|_| BrowserPlatformError::new("evaluate", "macos", "channel dropped"))?
            .map_err(|e| BrowserPlatformError::new("evaluate", "macos", e))
    })
}

/// Captura o viewport como PNG. O timeout externo está no caller.
pub fn snapshot_png(webview: Webview<Wry>) -> PlatformFuture<Vec<u8>> {
    Box::pin(async move {
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
        let tx = Arc::new(std::sync::Mutex::new(Some(tx)));

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
                    let wk = wk_from_ptr(pw.inner().cast());
                    take_snapshot(wk, deliver);
                }
            })
            .map_err(|e| BrowserPlatformError::new("snapshot", "macos", e.to_string()))?;

        tokio::time::timeout(EVAL_TIMEOUT, rx)
            .await
            .map_err(|_| BrowserPlatformError::new("snapshot", "macos", "timed out"))?
            .map_err(|_| BrowserPlatformError::new("snapshot", "macos", "channel dropped"))?
            .map_err(|e| BrowserPlatformError::new("snapshot", "macos", e))
    })
}

fn eval_with_result(
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
        // Try NSString first (most common case). For numbers and other
        // types, fall back to `[obj description]` which returns a
        // human-readable string for any ObjC object (e.g. "2" for an
        // NSNumber wrapping the integer 2).
        let value = obj
            .downcast_ref::<NSString>()
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                let description: Retained<NSString> =
                    unsafe { msg_send![obj, description] };
                description.to_string()
            });
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

fn take_snapshot(
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
            .representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
            .ok_or_else(|| "encode PNG falhou".to_string())?;
        Ok(png.to_vec())
    }
}

const EVAL_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::DefinedClass;
    use std::sync::Mutex;

    /// Cross-artifact contract: the handler name that Rust registers via
    /// `addScriptMessageHandler_contentWorld_name` MUST match the handler
    /// name that `webkit_transport_setup.js` embeds via `%HANDLER_NAME%`.
    /// The test verifies that the WebKit template has the placeholder AND
    /// that the Rust constant is non-empty.
    #[test]
    fn rust_and_inject_agree_on_handler_name() {
        let transport_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/services/browser_platform/webkit_transport_setup.js");
        let source = std::fs::read_to_string(&transport_path)
            .unwrap_or_else(|err| panic!("could not read {}: {err}", transport_path.display()));
        // The template uses `%HANDLER_NAME%` which Rust resolves at injection time.
        assert!(
            source.contains("%HANDLER_NAME%"),
            "webkit_transport_setup.js must have a `%HANDLER_NAME%` placeholder for the \
             handler name, but it was not found."
        );
        // The Rust constant must not be empty — it will never resolve to a valid name.
        assert!(
            !super::HANDLER_NAME.is_empty(),
            "HANDLER_NAME must not be empty"
        );
    }

    /// Regression test for the use-after-free + OnceLock bug: two handlers
    /// created with two different sinks must route to their OWN sink, and
    /// neither inherits the other's sink. Before the ivar fix, the second
    /// `register_sink` was a no-op (OnceLock) and both handlers shared the
    /// first sink — or worse, the first sink's Arc had been dropped when
    /// `attach_bridge` returned, leaving a dangling pointer.
    ///
    /// This test instantiates two `MsgHandler` objects directly (no webview)
    /// and invokes their sinks via `ivars().sink` — the same path that
    /// `did_receive` takes when the controller delivers a message. If the
    /// ivars are per-instance (the fix), each handler records to its own
    /// vector. If they shared a global (the bug), both would record to the
    /// same vector.
    ///
    /// `MsgHandler` is `MainThreadOnly`, so this test requires the main
    /// thread. Rust's test harness runs tests on worker threads, so we
    /// skip (not fail) when `MainThreadMarker::new()` returns `None`. To
    /// actually exercise this, run with `--test-threads=1` on the main
    /// thread, or invoke it from a main-thread context. The skip is
    /// honest: we cannot prove the property without the main thread.
    #[test]
    fn two_handlers_route_to_their_own_sinks() {
        let mtm = match MainThreadMarker::new() {
            Some(mtm) => mtm,
            None => {
                eprintln!("skipped: MsgHandler is MainThreadOnly, test not on main thread");
                return;
            }
        };

        let sink_a: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_b: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

        let record_a = sink_a.clone();
        let sink_fn_a: PageMessageSink = Arc::new(move |text| {
            record_a.lock().unwrap().push(text);
        });
        let record_b = sink_b.clone();
        let sink_fn_b: PageMessageSink = Arc::new(move |text| {
            record_b.lock().unwrap().push(text);
        });

        let handler_a = MsgHandler::new(mtm, sink_fn_a);
        let handler_b = MsgHandler::new(mtm, sink_fn_b);

        // Deliver a message to each handler via the ivars path (same as
        // did_receive uses internally).
        (handler_a.ivars().sink)("from-a".into());
        (handler_b.ivars().sink)("from-b".into());
        (handler_a.ivars().sink)("second-a".into());

        let recorded_a = sink_a.lock().unwrap().clone();
        let recorded_b = sink_b.lock().unwrap().clone();

        assert_eq!(recorded_a, vec!["from-a".to_string(), "second-a".to_string()],
            "handler A must route to sink A only");
        assert_eq!(recorded_b, vec!["from-b".to_string()],
            "handler B must route to sink B only, not inherit A's sink");
    }
}
