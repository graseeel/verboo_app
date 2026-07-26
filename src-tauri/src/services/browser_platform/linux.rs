use std::sync::Arc;
use std::time::Duration;

use tokio::sync::oneshot;
use uuid::Uuid;

use tauri::webview::Webview;
use tauri::Wry;

use gio::Cancellable;
use glib::signal::signal_handler_disconnect;
use javascriptcore::ValueExt;
use webkit2gtk::{
    LoadEvent, SnapshotOptions, SnapshotRegion, UserContentInjectedFrames, UserScript,
    UserScriptInjectionTime, UserContentManagerExt, WebView, WebViewExt,
};

use super::{BrowserPlatformError, PageMessageSink, PlatformFuture};
use crate::services::browser_bridge::BridgeConfig;

const BROWSER_INJECT_JS: &str = include_str!("../browser_inject.js");
const WEBKIT_TRANSPORT_TEMPLATE: &str = include_str!("webkit_transport_setup.js");

const EVAL_TIMEOUT: Duration = Duration::from_secs(5);

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

pub fn attach_bridge(
    webview: &Webview<Wry>,
    config: BridgeConfig,
    sink: PageMessageSink,
    on_document_start: Arc<dyn Fn(String) + Send + Sync + 'static>,
) -> Result<BridgeHandle, BrowserPlatformError> {
    let doc_uuid0 = Uuid::new_v4().to_string();
    on_document_start(doc_uuid0.clone());

    let install_tab = config.tab_id.clone();
    let install_token = config.token.clone();
    let install_sink = sink.clone();
    let install_doc = doc_uuid0.clone();
    let install_handler = super::handler_name_for(&install_tab);
    let install_world = super::world_name_for(&install_tab);
    let install_handler_return = install_handler.clone();
    let unreg_world = install_world.clone();

    let inner_err: Arc<std::sync::Mutex<Option<BrowserPlatformError>>> =
        Arc::new(std::sync::Mutex::new(None));
    let err_slot = inner_err.clone();

    let wv_for_unreg = webview.clone();
    let load_sig_id: Arc<std::sync::Mutex<Option<glib::SignalHandlerId>>> =
        Arc::new(std::sync::Mutex::new(None));
    let load_sig_slot = load_sig_id.clone();

    // Flag de que o handler de mensagem foi registrado.
    let msg_registered: Arc<std::sync::Mutex<bool>> =
        Arc::new(std::sync::Mutex::new(false));
    let msg_flag = msg_registered.clone();

    webview
        .with_webview(move |pw| {
            let wk: &WebView = &pw.inner();
            let content_manager = wk
                .user_content_manager()
                .expect("webkit webview has no UserContentManager");

            // 1. UserScript (transport + inject) no mundo privado.
            let combined = format!(
                "{}\n{}",
                super::render_transport(
                    WEBKIT_TRANSPORT_TEMPLATE,
                    &install_tab,
                    &install_token,
                    &install_handler,
                    &install_doc,
                ),
                BROWSER_INJECT_JS,
            );
            let uscript = UserScript::for_world(
                &combined,
                UserContentInjectedFrames::TopFrame,
                UserScriptInjectionTime::Start,
                &install_world,
                &[],
                &[],
            );
            content_manager.add_script(&uscript);

            // 2. Handler de mensagens.
            if !content_manager.register_script_message_handler_in_world(
                &install_handler,
                &install_world,
            ) {
                *err_slot.lock().unwrap() = Some(BrowserPlatformError::new(
                    "attach_bridge",
                    "linux",
                    "register_script_message_handler falhou",
                ));
                return;
            }
            *msg_flag.lock().unwrap() = true;

            let ms_sink = install_sink;
            let _ = content_manager.connect_script_message_received(
                Some(&install_handler),
                move |_cm, js_result| {
                    if let Some(val) = js_result.js_value() {
                        let s = js_value_to_string(&val);
                        (ms_sink)(s);
                    }
                },
            );

            // 3. load-changed(Started) — antigamente tentava girar o
            //    document_token via evaluate_javascript, mas a execução
            //    JS precisa de IPC UI→Web→WebKit enquanto o UserScript
            //    é injetado localmente no web process — o UserScript
            //    sempre vence a corrida e recebe o token velho, fazendo
            //    accept() rejeitar StaleDocument. O document_token fica
            //    fixo no valor do attach (install_doc), como no Windows.
            let load_id = wk.connect_load_changed(move |_webview, _event| {
                // No-op: document_token rotation happens only on macOS
                // (synchronous WKUserScript injection) and on Windows
                // (synchronous NavigationStarting). On Linux, WebKitGTK's
                // IPC model makes rotation inherently racy, so we keep
                // the attach-time token for all navigations.
            });
            *load_sig_slot.lock().unwrap() = Some(load_id);
        })
        .map_err(|e| BrowserPlatformError::new("attach_bridge", "linux", e.to_string()))?;

    if let Some(e) = inner_err.lock().unwrap().take() {
        return Err(e);
    }

    let unreg: Box<dyn FnOnce(&str) + Send> = Box::new(move |name| {
        let uw = unreg_world.clone();
        if let Some(sid) = load_sig_id.lock().unwrap().take() {
            let name_owned = name.to_string();
            let _ = wv_for_unreg.with_webview(move |pw| {
                let wk: &WebView = &pw.inner();
                signal_handler_disconnect(wk, sid);
                if *msg_registered.lock().unwrap() {
                    if let Some(cm) = wk.user_content_manager() {
                        cm.unregister_script_message_handler_in_world(&name_owned, &uw);
                    }
                }
            });
        }
    });

    Ok(BridgeHandle {
        handler_name: install_handler_return,
        unregister: Some(unreg),
    })
}

pub fn evaluate(webview: Webview<Wry>, tab_id: String, script: String) -> PlatformFuture<String> {
    Box::pin(async move {
        let eval_world = super::world_name_for(&tab_id);
        let (tx, rx): (oneshot::Sender<String>, oneshot::Receiver<String>) = oneshot::channel();
        let tx = Arc::new(std::sync::Mutex::new(Some(tx)));

        webview
            .with_webview(move |pw| {
                let wk: &WebView = &pw.inner();
                let tx_eval = tx.clone();
                wk.evaluate_javascript(
                    &script,
                    Some(&eval_world),
                    None::<&str>,
                    None::<&Cancellable>,
                    move |result| {
                        let value = match result {
                            Ok(ref v) => js_value_to_string(v),
                            Err(e) => format!("eval erro: {e}"),
                        };
                        if let Some(s) = tx_eval.lock().unwrap().take() {
                            let _ = s.send(value);
                        }
                    },
                );
            })
            .map_err(|e| {
                BrowserPlatformError::new("evaluate", "linux", e.to_string())
            })?;

        let inner = tokio::time::timeout(EVAL_TIMEOUT, rx)
            .await
            .map_err(|_| {
                BrowserPlatformError::new("evaluate", "linux", "timed out")
            })?;
        let value = inner.map_err(|_| {
            BrowserPlatformError::new("evaluate", "linux", "channel dropped")
        })?;
        Ok(value)
    })
}

pub fn snapshot_png(webview: Webview<Wry>) -> PlatformFuture<Vec<u8>> {
    Box::pin(async move {
        let (tx, rx): (
            oneshot::Sender<Result<Vec<u8>, String>>,
            oneshot::Receiver<Result<Vec<u8>, String>>,
        ) = oneshot::channel();
        let tx = Arc::new(std::sync::Mutex::new(Some(tx)));

        webview
            .with_webview(move |pw| {
                let wk: &WebView = &pw.inner();
                let tx_snap = tx.clone();
                wk.snapshot(
                    SnapshotRegion::Visible,
                    SnapshotOptions::NONE,
                    None::<&Cancellable>,
                    move |result| {
                        let result = match result {
                            Ok(surface) => {
                                let mut png_bytes = Vec::new();
                                if let Err(e) =
                                    surface.write_to_png(&mut png_bytes)
                                {
                                    Err(format!("write_to_png: {e}"))
                                } else {
                                    match image::load_from_memory_with_format(
                                        &png_bytes,
                                        image::ImageFormat::Png,
                                    ) {
                                        Ok(_) => Ok(png_bytes),
                                        Err(e) => {
                                            Err(format!("PNG invalid: {e}"))
                                        }
                                    }
                                }
                            }
                            Err(e) => Err(format!("snapshot: {e}")),
                        };
                        if let Some(s) = tx_snap.lock().unwrap().take() {
                            let _ = s.send(result);
                        }
                    },
                );
            })
            .map_err(|e| {
                BrowserPlatformError::new("snapshot", "linux", e.to_string())
            })?;

        let inner = tokio::time::timeout(EVAL_TIMEOUT, rx)
            .await
            .map_err(|_| {
                BrowserPlatformError::new("snapshot", "linux", "timed out")
            })?;
        let result = inner.map_err(|_| {
            BrowserPlatformError::new("snapshot", "linux", "channel dropped")
        })?;
        result.map_err(|e| BrowserPlatformError::new("snapshot", "linux", e))
    })
}

/// Converte javascriptcore::Value para string.
fn js_value_to_string(val: &javascriptcore::Value) -> String {
    if val.is_string() {
        val.to_string_as_bytes()
            .and_then(|b| {
                std::str::from_utf8(b.as_ref())
                    .map(|s| s.to_string())
                    .ok()
            })
            .unwrap_or_default()
    } else if val.is_number() {
        val.to_double().to_string()
    } else if val.is_boolean() {
        val.to_boolean().to_string()
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_errors_carry_platform_tag() {
        let e = BrowserPlatformError::new("attach_bridge", "linux", "test");
        assert_eq!(e.platform, "linux");
        assert_eq!(e.operation, "attach_bridge");
    }

    #[test]
    fn transport_template_uses_webkit_messages() {
        let t = WEBKIT_TRANSPORT_TEMPLATE;
        assert!(t.contains("window.webkit.messageHandlers"));
        assert!(!t.contains("window.chrome.webview"));
    }

    #[test]
    fn transport_template_does_not_generate_uuid() {
        let t = WEBKIT_TRANSPORT_TEMPLATE;
        assert!(!t.contains("Uuid") && !t.contains("new_v4"));
        assert!(t.contains("__verboo_pending_doc_token__")
            || t.contains("%DOCUMENT_TOKEN%"));
    }
}
