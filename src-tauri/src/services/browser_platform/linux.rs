use std::sync::Arc;
use std::time::Duration;

use tokio::sync::oneshot;
use uuid::Uuid;

use tauri::webview::Webview;
use tauri::Wry;

use gio::Cancellable;
use glib::signal::signal_handler_disconnect;
use webkit2gtk::{
    LoadEvent, SnapshotOptions, SnapshotRegion, UserContentInjectedFrames, UserScript,
    UserScriptInjectionTime, UserContentManagerExt, WebView, WebViewExt,
};

use super::{BrowserPlatformError, PageMessageSink, PlatformFuture};
use crate::services::browser_bridge::BridgeConfig;

const BROWSER_INJECT_JS: &str = include_str!("../browser_inject.js");
const WEBKIT_TRANSPORT_TEMPLATE: &str = include_str!("webkit_transport_setup.js");

const HANDLER_NAME: &str = "verboo";
const WORLD_NAME: &str = "verboo-trusted";
const EVAL_TIMEOUT: Duration = Duration::from_secs(5);

fn wk_from_ptr<'a>(ptr: *const std::ffi::c_void) -> &'a WebView {
    unsafe { &*(ptr as *const WebView) }
}

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
    let install_handler = HANDLER_NAME.to_string();
    let install_sink = sink.clone();
    let install_doc = doc_uuid0.clone();

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
        .with_webview(move |pw| unsafe {
            let wk = wk_from_ptr(pw.inner());
            let content_manager = wk
                .user_content_manager()
                .expect("webkit webview has no UserContentManager");
            let world = WORLD_NAME;

            // 1. UserScript (transport + inject) no mundo privado.
            let combined = format!(
                "{}\n{}",
                WEBKIT_TRANSPORT_TEMPLATE
                    .replace(
                        "\"%TAB_ID%\"",
                        &serde_json::to_string(&install_tab).unwrap_or_default(),
                    )
                    .replace(
                        "\"%BRIDGE_TOKEN%\"",
                        &serde_json::to_string(&install_token).unwrap_or_default(),
                    )
                    .replace(
                        "\"%HANDLER_NAME%\"",
                        &serde_json::to_string(&install_handler).unwrap_or_default(),
                    )
                    .replace(
                        "\"%DOCUMENT_TOKEN%\"",
                        &serde_json::to_string(&install_doc).unwrap_or_default(),
                    ),
                BROWSER_INJECT_JS,
            );
            let uscript = UserScript::for_world(
                &combined,
                UserContentInjectedFrames::TopFrame,
                UserScriptInjectionTime::Start,
                world,
                &[],
                &[],
            );
            content_manager.add_script(&uscript);

            // 2. Handler de mensagens.
            if !content_manager.register_script_message_handler_in_world(
                install_handler,
                world,
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
                Some(install_handler),
                move |_cm, js_result| {
                    if let Some(val) = js_result.js_value() {
                        let s = js_value_to_string(&val);
                        (ms_sink)(s);
                    }
                },
            );

            // 3. load-changed(Started) — UUID por navegacao.
            let ods = on_document_start.clone();
            let load_id = wk.connect_load_changed(move |webview, event| {
                if event == LoadEvent::Started {
                    let uuid = Uuid::new_v4().to_string();
                    ods(uuid.clone());
                    let js = format!(
                        "globalThis.__verboo_pending_doc_token__={};",
                        serde_json::to_string(&uuid)
                            .unwrap_or_else(|_| "null".into()),
                    );
                    webview.evaluate_javascript(
                        &js,
                        Some(world),
                        None::<&str>,
                        None::<&Cancellable>,
                        |_r| {},
                    );
                }
            });
            *load_sig_slot.lock().unwrap() = Some(load_id);
        })
        .map_err(|e| BrowserPlatformError::new("attach_bridge", "linux", e.to_string()))?;

    if let Some(e) = inner_err.lock().unwrap().take() {
        return Err(e);
    }

    let unreg: Box<dyn FnOnce(&str) + Send> = Box::new(move |name| {
        if let Some(sid) = load_sig_id.lock().unwrap().take() {
            let _ = wv_for_unreg.with_webview(move |pw| unsafe {
                let wk = wk_from_ptr(pw.inner());
                signal_handler_disconnect(wk, sid);
                if *msg_registered.lock().unwrap() {
                    if let Some(cm) = wk.user_content_manager() {
                        cm.unregister_script_message_handler_in_world(name, WORLD_NAME);
                    }
                }
            });
        }
    });

    Ok(BridgeHandle {
        handler_name: HANDLER_NAME.to_string(),
        unregister: Some(unreg),
    })
}

pub fn evaluate(webview: Webview<Wry>, script: String) -> PlatformFuture<String> {
    Box::pin(async move {
        let (tx, rx) = oneshot::channel();
        let tx = Arc::new(std::sync::Mutex::new(Some(tx)));

        webview
            .with_webview(move |pw| unsafe {
                let wk = wk_from_ptr(pw.inner());
                let tx_eval = tx.clone();
                wk.evaluate_javascript(
                    &script,
                    Some(WORLD_NAME),
                    None::<&str>,
                    None::<&Cancellable>,
                    move |result| {
                        let value = match result {
                            Ok(ref v) => js_value_to_string(v),
                            Err(e) => format!("eval erro: {e}"),
                        };
                        if let Some(s) = tx_eval.lock().unwrap().take() {
                            let _ = s.send(Ok(value));
                        }
                    },
                );
            })
            .map_err(|e| {
                BrowserPlatformError::new("evaluate", "linux", e.to_string())
            })?;

        tokio::time::timeout(EVAL_TIMEOUT, rx)
            .await
            .map_err(|_| {
                BrowserPlatformError::new("evaluate", "linux", "timed out")
            })?
            .map_err(|_| {
                BrowserPlatformError::new("evaluate", "linux", "channel dropped")
            })?
            .map_err(|e| BrowserPlatformError::new("evaluate", "linux", e))
    })
}

pub fn snapshot_png(webview: Webview<Wry>) -> PlatformFuture<Vec<u8>> {
    Box::pin(async move {
        let (tx, rx) = oneshot::channel();
        let tx = Arc::new(std::sync::Mutex::new(Some(tx)));

        webview
            .with_webview(move |pw| unsafe {
                let wk = wk_from_ptr(pw.inner());
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

        tokio::time::timeout(EVAL_TIMEOUT, rx)
            .await
            .map_err(|_| {
                BrowserPlatformError::new("snapshot", "linux", "timed out")
            })?
            .map_err(|_| {
                BrowserPlatformError::new("snapshot", "linux", "channel dropped")
            })?
            .map_err(|e| BrowserPlatformError::new("snapshot", "linux", e))
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

    #[test]
    fn transport_template_carries_placeholders() {
        let t = WEBKIT_TRANSPORT_TEMPLATE;
        assert!(t.contains("%TAB_ID%"));
        assert!(t.contains("%BRIDGE_TOKEN%"));
        assert!(t.contains("%HANDLER_NAME%"));
        assert!(t.contains("%DOCUMENT_TOKEN%"));
    }
}
