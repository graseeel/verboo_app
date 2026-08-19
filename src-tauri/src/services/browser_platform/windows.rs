//! WebView2 (Windows) implementation of the browser platform bridge.
//!
//! Architecture mirrors macos.rs but uses WebView2-specific COM APIs.
//!
//! Per-navigation document-token order:
//!   1. NavigationStarting (synchronous, before HTTP request) →
//!      Rust generates UUID, calls on_document_start(uuid),
//!      stores UUID in handler state.
//!   2. ContentLoading (before any content/scripts) →
//!      Rust calls ExecuteScript to set the global
//!      `__verboo_pending_doc_token__` on the new document.
//!   3. The registered init script (transport + inject) runs,
//!      reads the global via a getter on the transport object,
//!      and immediately deletes it. No page script can read the
//!      bridge credentials after init.
//!
//! The UUID is NEVER generated in JavaScript — only Rust creates it.

use std::sync::{mpsc, Arc};
use std::time::Duration;

use serde_json;
use tokio::sync::oneshot;
use uuid::Uuid;

use tauri::webview::Webview;
use tauri::Wry;

use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
};
use webview2_com::{
    AddScriptToExecuteOnDocumentCreatedCompletedHandler,
    CapturePreviewCompletedHandler, ContentLoadingEventHandler,
    ExecuteScriptCompletedHandler, NavigationStartingEventHandler,
    WebMessageReceivedEventHandler,
};
use windows::Win32::System::Com::{
    STATSTG, STATFLAG_DEFAULT, STREAM_SEEK_SET,
};
use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
use image::ImageFormat;

use super::{BrowserPlatformError, PageMessageSink, PlatformFuture};
use crate::services::browser_bridge::BridgeConfig;

/// Script injetado (Vitral / Task 7). Idêntico ao do macOS.
const BROWSER_INJECT_JS: &str = include_str!("../browser_inject.js");

/// Transport factory — define `globalThis.__VERBOO_NATIVE_TRANSPORT__`
/// antes do inject.js rodar. Específico de WebView2: usa
/// `window.chrome.webview.postMessage` (em vez de
/// `window.webkit.messageHandlers`). O `documentToken` é resolvido por
/// getter que lê o global `__verboo_pending_doc_token__` definido pelo
/// lado nativo em `ContentLoading`. O UUID é SEMPRE gerado em Rust.
const WEBVIEW2_TRANSPORT_TEMPLATE: &str = include_str!("webview2_transport_setup.js");

const EVAL_TIMEOUT: Duration = Duration::from_secs(5);
const BRIDGE_ATTACH_TIMEOUT: Duration = Duration::from_secs(10);

/// Possui os três EventRegistrationToken (NavigationStarting,
/// ContentLoading, WebMessageReceived) e o Webview<Wry> clonado. Drop
/// chama `remove_NavigationStarting/ContentLoading/WebMessageReceived`
/// no CoreWebView2, espelhando o `removeScriptMessageHandlerForContentWorld`
/// do macOS. Se o controller já foi destruído junto com a janela, os
/// `remove_*` retornam erro silenciosamente — o que é seguro.
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

/// RAII pair: buffer + PCWSTR que aponta para dentro dele.
struct BufPcwstr {
    _buf: Vec<u16>,
    ptr: windows::core::PCWSTR,
}
impl BufPcwstr {
    fn new(s: &str) -> Self {
        let buf: Vec<u16> = s.encode_utf16().chain(std::iter::once(0)).collect();
        let ptr = windows::core::PCWSTR::from_raw(buf.as_ptr());
        Self { _buf: buf, ptr }
    }
}

pub fn attach_bridge(
    webview: &Webview<Wry>,
    config: BridgeConfig,
    sink: PageMessageSink,
    on_document_start: Arc<dyn Fn(String) + Send + Sync + 'static>,
) -> Result<BridgeHandle, BrowserPlatformError> {
    let install_doc = Uuid::new_v4().to_string();
    on_document_start(install_doc.clone());

    let install_tab = config.tab_id.clone();
    let install_token = config.token.clone();
    let install_sink = sink.clone();
    let install_handler = super::handler_name_for(&install_tab);
    let install_handler_return = install_handler.clone();

    // `with_webview` dispatches onto Tauri's UI thread and returns before the
    // closure completes. WebView2 completion callbacks belong to that STA, so
    // the closure must pump the registration callback before notifying this
    // worker thread that the bridge is ready.
    let (registration_tx, registration_rx) = mpsc::channel::<Result<(), String>>();

    // Capturado fora da closure para o unregister; clonado para dentro.
    let wv_for_unregister = webview.clone();
    // Os três tokens são escritos pela closure e lidos pelo unregister.
    let tokens: Arc<std::sync::Mutex<(i64, i64, i64)>> =
        Arc::new(std::sync::Mutex::new((0, 0, 0)));
    let tokens_slot = tokens.clone();

    webview
        .with_webview(move |pw| unsafe {
            let cwv = match pw.controller().CoreWebView2() {
                Ok(c) => c,
                Err(e) => {
                    let _ = registration_tx.send(Err(e.to_string()));
                    return;
                }
            };

            let pending: Arc<std::sync::Mutex<Option<String>>> =
                Arc::new(std::sync::Mutex::new(None));
            let mut nav_tok: i64 = 0;
            let mut content_tok: i64 = 0;
            let mut msg_tok: i64 = 0;

            // 1. NavigationStarting (síncrono)
            let p1 = pending.clone();
            let ods = on_document_start.clone();
            let nh = NavigationStartingEventHandler::create(Box::new(move |_, _| {
                let u = Uuid::new_v4().to_string();
                ods(u.clone());
                *p1.lock().unwrap_or_else(|e| e.into_inner()) = Some(u);
                Ok(())
            }));
            if let Err(e) = cwv.add_NavigationStarting(&nh, &mut nav_tok as *mut i64) {
                let _ = registration_tx.send(Err(e.to_string()));
                return;
            }

            // 2. ContentLoading — injeta uuid no doc novo
            let p2 = pending.clone();
            let ch = ContentLoadingEventHandler::create(Box::new(move |sender, _| {
                if let (Some(u), Some(cwv2)) = (p2.lock().unwrap_or_else(|e| e.into_inner()).clone(), sender) {
                    let js = format!(
                        "globalThis.__verboo_pending_doc_token__={};",
                        serde_json::to_string(&u).unwrap_or_else(|_| "null".into()),
                    );
                    let buf = BufPcwstr::new(&js);
                    let noop = ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(())));
                    let _ = cwv2.ExecuteScript(buf.ptr, &noop);
                }
                Ok(())
            }));
            if let Err(e) = cwv.add_ContentLoading(&ch, &mut content_tok as *mut i64) {
                let _ = registration_tx.send(Err(e.to_string()));
                return;
            }

            // 3. WebMessageReceived
            let ms = install_sink.clone();
            let mh = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                if let Some(a) = args {
                    let mut out = windows::core::PWSTR::null();
                    if a.TryGetWebMessageAsString(&mut out as *mut windows::core::PWSTR).is_ok() {
                        let s = pwstr_to_string(out);
                        (ms)(s);
                    }
                }
                Ok(())
            }));
            if let Err(e) = cwv.add_WebMessageReceived(&mh, &mut msg_tok as *mut i64) {
                let _ = registration_tx.send(Err(e.to_string()));
                return;
            }

            // 4. Transport + inject
            let tpl = super::render_transport(
                WEBVIEW2_TRANSPORT_TEMPLATE,
                &install_tab,
                &install_token,
                &install_handler,
                &install_doc,
            );
            let full = format!("{tpl}\n{BROWSER_INJECT_JS}");

            // Persist before dispatch: WebView2 may invoke the completion
            // callback synchronously.
            *tokens_slot.lock().unwrap_or_else(|e| e.into_inner()) = (nav_tok, content_tok, msg_tok);
            let registration =
                AddScriptToExecuteOnDocumentCreatedCompletedHandler::wait_for_async_operation(
                    Box::new(move |handler| {
                        let script = windows::core::HSTRING::from(full);
                        cwv.AddScriptToExecuteOnDocumentCreated(&script, &handler)
                            .map_err(webview2_com::Error::WindowsError)
                    }),
                    Box::new(|error, _id| error),
                )
                .map_err(|error| error.to_string());
            let _ = registration_tx.send(registration);
        })
        .map_err(|e| BrowserPlatformError::new("attach_bridge", "windows", e.to_string()))?;

    registration_rx
        .recv_timeout(BRIDGE_ATTACH_TIMEOUT)
        .map_err(|error| {
            BrowserPlatformError::new(
                "attach_bridge",
                "windows",
                format!("document script registration did not complete: {error}"),
            )
        })?
        .map_err(|error| BrowserPlatformError::new("attach_bridge", "windows", error))?;

    // Unregister: chama remove_NavigationStarting/ContentLoading/WebMessageReceived
    // no CoreWebView2. Best-effort — se o controller já foi destruído
    // junto com a janela, os remove_* retornam erro silenciosamente.
    // O arg `&str` (handler_name) é parte do contrato BridgeHandle; não
    // usado aqui porque a remoção é por token, não por nome.
    let unregister: Box<dyn FnOnce(&str) + Send> = Box::new(move |_name| {
        let (nav, content, msg) = *tokens.lock().unwrap_or_else(|e| e.into_inner());
        let _ = wv_for_unregister.with_webview(move |pw| unsafe {
            if let Ok(cwv) = pw.controller().CoreWebView2() {
                let _ = cwv.remove_NavigationStarting(nav);
                let _ = cwv.remove_ContentLoading(content);
                let _ = cwv.remove_WebMessageReceived(msg);
            }
        });
    });

    Ok(BridgeHandle {
        handler_name: install_handler_return,
        unregister: Some(unregister),
    })
}

/// Avalia JS no documento via `ExecuteScript`.
/// `_tab_id` é ignorado — WebView2 não tem content worlds — mas faz
/// parte da assinatura compartilhada entre as 3 plataformas.
pub fn evaluate(webview: Webview<Wry>, _tab_id: String, script: String) -> PlatformFuture<String> {
    Box::pin(async move {
        let (tx, rx) = oneshot::channel();
        let tx = Arc::new(std::sync::Mutex::new(Some(tx)));

        webview
            .with_webview(move |pw| unsafe {
                if let Ok(cwv) = pw.controller().CoreWebView2() {
                    let tx_exec = tx.clone();
                    let js = BufPcwstr::new(&script);
                    let handler = ExecuteScriptCompletedHandler::create(Box::new(
                        move |ec, result: String| {
                            if ec.is_err() {
                                if let Some(s) = tx_exec.lock().unwrap_or_else(|e| e.into_inner()).take() {
                                    let _ = s.send(Err(format!("ExecuteScript: {:?}", ec)));
                                }
                            } else if let Some(s) = tx_exec.lock().unwrap_or_else(|e| e.into_inner()).take() {
                                let _ = s.send(Ok(result));
                            }
                            Ok(())
                        },
                    ));
                    if let Err(e) = cwv.ExecuteScript(js.ptr, &handler) {
                        if let Some(s) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
                            let _ = s.send(Err(format!("ExecuteScript dispatch: {e}")));
                        }
                    }
                } else if let Some(s) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    let _ = s.send(Err("CoreWebView2 indisponível".into()));
                }
            })
            .map_err(|e| BrowserPlatformError::new("evaluate", "windows", e.to_string()))?;

        tokio::time::timeout(EVAL_TIMEOUT, rx)
            .await
            .map_err(|_| BrowserPlatformError::new("evaluate", "windows", "timed out"))?
            .map_err(|_| BrowserPlatformError::new("evaluate", "windows", "channel dropped"))?
            .map_err(|e| BrowserPlatformError::new("evaluate", "windows", e))
    })
}

/// Captura o viewport como PNG via `CapturePreview`. Cria um IStream
/// via `CreateStreamOnHGlobal`, passa para o CapturePreview, e no
/// callback rebobina o stream (Seek(0, SET)), lê todo o conteúdo, e
/// valida com `image::load_from_memory_with_format(..., ImageFormat::Png)`
/// antes de devolver — conforme o plano exige.
pub fn snapshot_png(webview: Webview<Wry>) -> PlatformFuture<Vec<u8>> {
    Box::pin(async move {
        let (tx, rx) = oneshot::channel();
        let tx = Arc::new(std::sync::Mutex::new(Some(tx)));

        webview
            .with_webview(move |pw| unsafe {
                if let Ok(cwv) = pw.controller().CoreWebView2() {
                    // Cria IStream em HGLOBAL. deleteOnRelease=true
                    // libera o HGLOBAL quando o IStream é droppado.
                    let stream = match CreateStreamOnHGlobal(
                        windows::Win32::Foundation::HGLOBAL::default(),
                        true,
                    ) {
                        Ok(s) => s,
                        Err(e) => {
                            if let Some(s) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
                                let _ = s.send(Err(format!(
                                    "CreateStreamOnHGlobal: {e}"
                                )));
                            }
                            return;
                        }
                    };

                    let tx_snap = tx.clone();
                    // Clone para o closure: IStream é COM interface,
                    // clone() incrementa o refcount (AddRef) — ambos
                    // compartilham o mesmo HGLOBAL subjacente.
                    let stream_for_cb = stream.clone();
                    let handler = CapturePreviewCompletedHandler::create(
                        Box::new(move |ec| {
                            if ec.is_err() {
                                if let Some(s) =
                                    tx_snap.lock().unwrap_or_else(|e| e.into_inner()).take()
                                {
                                    let _ = s.send(Err(format!(
                                        "CapturePreview: {:?}",
                                        ec
                                    )));
                                }
                                return Ok(());
                            }
                            // Rebobina o stream para o início.
                            if let Err(e) = stream_for_cb.Seek(
                                0,
                                STREAM_SEEK_SET,
                                None,
                            ) {
                                if let Some(s) =
                                    tx_snap.lock().unwrap_or_else(|e| e.into_inner()).take()
                                {
                                    let _ = s.send(Err(format!(
                                        "Stream Seek: {e}"
                                    )));
                                }
                                return Ok(());
                            }
                            // Stat para pegar o tamanho total.
                            let mut stat = STATSTG::default();
                            if let Err(e) = stream_for_cb.Stat(
                                &mut stat as *mut STATSTG,
                                STATFLAG_DEFAULT,
                            ) {
                                if let Some(s) =
                                    tx_snap.lock().unwrap_or_else(|e| e.into_inner()).take()
                                {
                                    let _ = s.send(Err(format!(
                                        "Stream Stat: {e}"
                                    )));
                                }
                                return Ok(());
                            }
                            let total = stat.cbSize as usize;
                            let mut buf = vec![0u8; total];
                            let mut read = 0usize;
                            while read < total {
                                let mut got: u32 = 0;
                                let hr = stream_for_cb.Read(
                                    buf.as_mut_ptr().add(read) as *mut core::ffi::c_void,
                                    (total - read) as u32,
                                    Some(&mut got as *mut u32),
                                );
                                if hr.is_err() || got == 0 {
                                    break;
                                }
                                read += got as usize;
                            }
                            if read != total {
                                if let Some(s) =
                                    tx_snap.lock().unwrap_or_else(|e| e.into_inner()).take()
                                {
                                    let _ = s.send(Err(format!(
                                        "Stream Read incompleto: {read}/{total}"
                                    )));
                                }
                                return Ok(());
                            }
                            // Valida o PNG antes de devolver.
                            match image::load_from_memory_with_format(
                                &buf,
                                ImageFormat::Png,
                            ) {
                                Ok(_) => {
                                    if let Some(s) =
                                        tx_snap.lock().unwrap_or_else(|e| e.into_inner()).take()
                                    {
                                        let _ = s.send(Ok(buf));
                                    }
                                }
                                Err(e) => {
                                    if let Some(s) =
                                        tx_snap.lock().unwrap_or_else(|e| e.into_inner()).take()
                                    {
                                        let _ = s.send(Err(format!(
                                            "PNG inválido: {e}"
                                        )));
                                    }
                                }
                            }
                            Ok(())
                        }),
                    );
                    if let Err(e) = cwv.CapturePreview(
                        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                        &stream,
                        &handler,
                    ) {
                        if let Some(s) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
                            let _ = s.send(Err(format!(
                                "CapturePreview dispatch: {e}"
                            )));
                        }
                    }
                } else if let Some(s) = tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    let _ = s.send(Err("CoreWebView2 indisponível".into()));
                }
            })
            .map_err(|e| BrowserPlatformError::new("snapshot", "windows", e.to_string()))?;

        tokio::time::timeout(EVAL_TIMEOUT, rx)
            .await
            .map_err(|_| BrowserPlatformError::new("snapshot", "windows", "timed out"))?
            .map_err(|_| BrowserPlatformError::new("snapshot", "windows", "channel dropped"))?
            .map_err(|e| BrowserPlatformError::new("snapshot", "windows", e))
    })
}

unsafe fn pwstr_to_string(p: windows::core::PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    while *p.0.add(len) != 0 {
        len += 1;
    }
    if len == 0 {
        return String::new();
    }
    let slice = std::slice::from_raw_parts(p.0, len);
    String::from_utf16_lossy(slice)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_errors_carry_platform_tag() {
        let e = BrowserPlatformError::new("attach_bridge", "windows", "test");
        assert_eq!(e.platform, "windows");
        assert_eq!(e.operation, "attach_bridge");
    }

    #[test]
    fn transport_template_uses_chrome_webview() {
        let t = WEBVIEW2_TRANSPORT_TEMPLATE;
        assert!(t.contains("window.chrome.webview"));
        assert!(!t.contains("webkit.messageHandlers"));
    }

    #[test]
    fn transport_template_does_not_generate_uuid() {
        let t = WEBVIEW2_TRANSPORT_TEMPLATE;
        assert!(!t.contains("Uuid") && !t.contains("new_v4"));
        assert!(t.contains("__verboo_pending_doc_token__"));
    }

}
