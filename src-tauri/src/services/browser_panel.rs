//! Fase 0 spike for the embedded Browser panel (ADR-0001).
//!
//! Proves the load-bearing primitives on macOS before any real UI exists:
//!   - child webview docked inside the main window (tauri `unstable`)
//!   - bounds that follow the React-owned rectangle
//!   - native WKWebView snapshot → PNG (ADR-0002 shade + annotation crops)
//!   - evaluateJavaScript with a result (probe roundtrip)
//!   - page → app push via WKScriptMessageHandler (ADR-0003 channel)
//!
//! Everything here is spike-grade: gated behind VERBOO_BROWSER_SPIKE=1 and
//! expected to be reshaped in Fase 1. Non-macOS builds compile but return
//! errors from the native-dependent commands.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::webview::Webview;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, State, Wry};

/// Messages pushed from the page via `webkit.messageHandlers.verboo`.
/// Global because the WKScriptMessageHandler instance is owned by the
/// WKUserContentController, not by us.
static MESSAGES: Mutex<Vec<String>> = Mutex::new(Vec::new());

static LABEL_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
pub struct BrowserPanelState {
    webview: Mutex<Option<Webview<Wry>>>,
}

#[derive(Serialize)]
pub struct SnapshotReport {
    pub ms: u128,
    pub bytes: usize,
    pub path: String,
}

#[derive(Serialize)]
pub struct EvalReport {
    pub ms: u128,
    pub value: String,
}

/// Injected at document start into every page the spike webview loads.
/// Installs the probe (read back via evaluateJavaScript) and announces
/// itself via the native message handler, retrying because the handler may
/// be attached slightly after the first paint.
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

fn spike_env_enabled() -> bool {
    std::env::var("VERBOO_BROWSER_SPIKE").is_ok_and(|v| v == "1")
}

#[tauri::command]
pub fn browser_spike_enabled() -> bool {
    spike_env_enabled()
}

#[tauri::command]
pub fn browser_create(
    app: AppHandle,
    state: State<'_, BrowserPanelState>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    url: String,
) -> Result<String, String> {
    if !spike_env_enabled() {
        return Err("spike disabled".into());
    }
    // Idempotent: tear down any previous instance first.
    close_current(&state);

    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    let parsed = tauri::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    let label = format!("verboo-browser-{}", LABEL_SEQ.fetch_add(1, Ordering::Relaxed));

    let builder = tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed))
        // Clean profile (ADR-0001 criterion 4): non-persistent data store,
        // none of the user's cookies or logins.
        .incognito(true)
        .initialization_script(PROBE_JS);

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| format!("add_child failed: {e}"))?;

    attach_message_handler(&webview);

    *state.webview.lock().unwrap() = Some(webview);
    Ok(label)
}

#[tauri::command]
pub fn browser_navigate(state: State<'_, BrowserPanelState>, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    let guard = state.webview.lock().unwrap();
    let webview = guard.as_ref().ok_or_else(|| "no webview".to_string())?;
    let mut webview = webview.clone();
    webview.navigate(parsed).map_err(|e| format!("navigate failed: {e}"))
}

#[tauri::command]
pub fn browser_set_bounds(
    state: State<'_, BrowserPanelState>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let guard = state.webview.lock().unwrap();
    let webview = guard.as_ref().ok_or_else(|| "no webview".to_string())?;
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| format!("set_position failed: {e}"))?;
    webview
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| format!("set_size failed: {e}"))
}

#[tauri::command]
pub fn browser_destroy(state: State<'_, BrowserPanelState>) -> Result<(), String> {
    close_current(&state);
    Ok(())
}

#[tauri::command]
pub fn browser_poll_messages() -> Vec<String> {
    std::mem::take(&mut *MESSAGES.lock().unwrap())
}

fn close_current(state: &State<'_, BrowserPanelState>) {
    if let Some(webview) = state.webview.lock().unwrap().take() {
        let _ = webview.close();
    }
}

fn current_webview(state: &State<'_, BrowserPanelState>) -> Result<Webview<Wry>, String> {
    state
        .webview
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or_else(|| "no webview".to_string())
}

// ── macOS-native pieces ─────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod native {
    use super::MESSAGES;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_web_kit::{
        WKScriptMessage, WKScriptMessageHandler, WKUserContentController, WKWebView,
    };

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
                MESSAGES.lock().unwrap().push(text);
            }
        }
    );

    impl MsgHandler {
        pub fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm);
            unsafe { msg_send![this, init] }
        }
    }

    /// # Safety: must be called on the main thread with a valid WKWebView ptr.
    pub unsafe fn wk_from_ptr<'a>(ptr: *mut std::ffi::c_void) -> &'a WKWebView {
        &*(ptr as *const WKWebView)
    }

    pub fn attach_handler(wk: &WKWebView) {
        let mtm = MainThreadMarker::new().expect("with_webview runs on main thread");
        let handler = MsgHandler::new(mtm);
        let proto: &ProtocolObject<dyn WKScriptMessageHandler> =
            ProtocolObject::from_ref(&*handler);
        unsafe {
            let controller = wk.configuration().userContentController();
            // The controller retains the handler; our Retained can drop.
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
                    "snapshot returned no image".to_string()
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
                .ok_or_else(|| "no TIFF representation".to_string())?;
            let rep = NSBitmapImageRep::imageRepWithData(&tiff)
                .ok_or_else(|| "no bitmap rep".to_string())?;
            let png = rep
                .representationUsingType_properties(
                    NSBitmapImageFileType::PNG,
                    &NSDictionary::new(),
                )
                .ok_or_else(|| "png encode failed".to_string())?;
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
fn attach_message_handler(webview: &Webview<Wry>) {
    let _ = webview.with_webview(|pw| unsafe {
        let wk = native::wk_from_ptr(pw.inner().cast());
        native::attach_handler(wk);
    });
}

#[cfg(not(target_os = "macos"))]
fn attach_message_handler(_webview: &Webview<Wry>) {}

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
            .map_err(|e| format!("with_webview failed: {e}"))?;

        let bytes = tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .map_err(|_| "snapshot timed out".to_string())?
            .map_err(|_| "snapshot channel dropped".to_string())??;

        let ms = started.elapsed().as_millis();
        let path = std::env::temp_dir().join("verboo-browser-spike.png");
        std::fs::write(&path, &bytes).map_err(|e| format!("write failed: {e}"))?;
        Ok(SnapshotReport {
            ms,
            bytes: bytes.len(),
            path: path.to_string_lossy().into_owned(),
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        Err("snapshot: macOS only in the spike".into())
    }
}

#[tauri::command]
pub async fn browser_eval_roundtrip(
    state: State<'_, BrowserPanelState>,
) -> Result<EvalReport, String> {
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
                    native::eval_with_result(
                        wk,
                        "window.__verbooProbe ? window.__verbooProbe.ping() : 'no-probe'",
                        deliver,
                    );
                }
            })
            .map_err(|e| format!("with_webview failed: {e}"))?;

        let value = tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .map_err(|_| "eval timed out".to_string())?
            .map_err(|_| "eval channel dropped".to_string())??;

        Ok(EvalReport { ms: started.elapsed().as_millis(), value })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        Err("eval: macOS only in the spike".into())
    }
}
