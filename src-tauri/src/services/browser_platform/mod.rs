use std::{future::Future, pin::Pin, sync::Arc};
use tauri::{webview::Webview, Wry};

pub type PageMessageSink = Arc<dyn Fn(String) + Send + Sync + 'static>;
pub type PlatformFuture<T> = Pin<Box<dyn Future<Output = Result<T, BrowserPlatformError>> + Send + 'static>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserPlatformError {
    pub operation: String,
    pub platform: String,
    pub message: String,
}

impl BrowserPlatformError {
    pub fn new(
        operation: impl Into<String>,
        platform: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            operation: operation.into(),
            platform: platform.into(),
            message: message.into(),
        }
    }
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{attach_bridge, evaluate, set_media_suspended, snapshot_png, BridgeHandle};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{attach_bridge, evaluate, snapshot_png, BridgeHandle};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{attach_bridge, evaluate, snapshot_png, BridgeHandle};

// Helpers compartilhados entre os 3 adaptadores de plataforma.

/// Sanitiza tab_id para uso como identificador: não-alnum vira `_`.
pub fn sanitize_tab_id(tab_id: &str) -> String {
    tab_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// Nome do handler de mensagens, derivado do tab_id para isolamento.
/// Usado como chave em `window.webkit.messageHandlers["..."]` (macOS/Linux)
/// e como valor de consistência no BridgeHandle (Windows).
pub fn handler_name_for(tab_id: &str) -> String {
    format!("verboo_{}", sanitize_tab_id(tab_id))
}

/// Nome do content world privado do WebKit, derivado do tab_id.
/// Relevante no macOS (WKContentWorld) e Linux (UserScript::for_world).
/// WebView2 não usa content worlds — o nome fica como dívida de contrato.
pub fn world_name_for(tab_id: &str) -> String {
    format!("verboo-trusted-{}", sanitize_tab_id(tab_id))
}

/// Substitui os placeholders `%TAB_ID%`, `%BRIDGE_TOKEN%`,
/// `%HANDLER_NAME%`, `%DOCUMENT_TOKEN%` no template de transport.
///
/// Cada valor é serializado via `serde_json::to_string` (escapa aspas,
/// barras invertidas, etc.) — NUNCA concatene dados não-confiança
/// diretamente em fonte JavaScript.
pub fn render_transport(
    tpl: &str,
    tab_id: &str,
    token: &str,
    handler: &str,
    doc: &str,
) -> String {
    tpl.replace(r#""%TAB_ID%""#, &serde_json::to_string(tab_id).unwrap_or_default())
        .replace(r#""%BRIDGE_TOKEN%""#, &serde_json::to_string(token).unwrap_or_default())
        .replace(r#""%HANDLER_NAME%""#, &serde_json::to_string(handler).unwrap_or_default())
        .replace(r#""%DOCUMENT_TOKEN%""#, &serde_json::to_string(doc).unwrap_or_default())
}

pub fn close_webview(webview: &Webview<Wry>) -> Result<(), BrowserPlatformError> {
    webview
        .close()
        .map_err(|error| BrowserPlatformError::new("close", std::env::consts::OS, error.to_string()))
}

#[cfg(test)]
mod contract_tests {
    use super::*;

    fn assert_platform_error(error: BrowserPlatformError) {
        assert!(!error.operation.is_empty());
        assert!(!error.platform.is_empty());
        assert!(!error.message.is_empty());
    }

    #[test]
    fn platform_errors_preserve_operation_platform_and_message() {
        assert_platform_error(BrowserPlatformError::new("snapshot", "macos", "failed"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bridge_handle_drop_fires_unregister_with_correct_handler_name() {
        let recorded = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
        let inject = recorded.clone();
        let handle = BridgeHandle {
            handler_name: "verboo".into(),
            unregister: Some(Box::new(move |name| {
                *inject.lock().unwrap() = Some(name.to_string());
            })),
        };
        drop(handle);
        let result = recorded.lock().unwrap().take();
        assert_eq!(result.as_deref(), Some("verboo"));
    }

// Testes de contrato entre plataformas

    #[test]
    fn handler_name_provides_isolation() {
        assert_ne!(handler_name_for("tab-001"), handler_name_for("tab-002"));
    }

    #[test]
    fn handler_name_sanitizes_special_chars() {
        let name = handler_name_for("tab:123$abc");
        assert_eq!(name, "verboo_tab_123_abc",
            "non-alphanumeric chars must become underscores");
    }

    #[test]
    fn world_name_adds_trusted_prefix_and_sanitizes() {
        let w = world_name_for("tab:001");
        assert!(w.starts_with("verboo-trusted-"));
        assert_eq!(w, "verboo-trusted-tab_001",
            "world name must sanitize with underscores");
    }

    #[test]
    fn world_name_is_portable() {
        // world_name_for must sanitize spaces, colons, etc. — it's used
        // as a WKContentWorld name and UserScript injection world.
        let w = world_name_for("tab 001");
        assert!(!w.contains(' '), "world name must not contain spaces: {w}");
        assert_eq!(w, "verboo-trusted-tab_001");
    }

// Os templates CRUOS contêm os placeholders esperados
    // (Se um placeholder sumir do arquivo, ninguém substitui.)

    #[test]
    fn webkit_template_contains_all_four_placeholders() {
        let tpl = include_str!("webkit_transport_setup.js");
        assert!(tpl.contains("%TAB_ID%"));
        assert!(tpl.contains("%BRIDGE_TOKEN%"));
        assert!(tpl.contains("%HANDLER_NAME%"));
        assert!(tpl.contains("%DOCUMENT_TOKEN%"));
    }

    #[test]
    fn webview2_template_contains_its_three_placeholders() {
        let tpl = include_str!("webview2_transport_setup.js");
        assert!(tpl.contains("%TAB_ID%"));
        assert!(tpl.contains("%BRIDGE_TOKEN%"));
        assert!(tpl.contains("%DOCUMENT_TOKEN%"));
    }

// Depois de renderizar, NADA de % sobrevive

    #[test]
    fn render_transport_replaces_all_placeholders() {
        let rendered = render_transport(
            "{tabId: \"%TAB_ID%\", bridgeToken: \"%BRIDGE_TOKEN%\", handler: \"%HANDLER_NAME%\", doc: \"%DOCUMENT_TOKEN%\"}",
            "tab-id",
            "tok",
            "hdl",
            "doc123",
        );
        // None of the 4 placeholders survive.
        assert!(!rendered.contains('%'), "placeholder not substituted: {rendered}");
        // Escaped values appear.
        assert!(rendered.contains(r#""tab-id""#));
        assert!(rendered.contains(r#""tok""#));
        assert!(rendered.contains(r#""hdl""#));
        assert!(rendered.contains(r#""doc123""#));
    }

    #[test]
    fn render_transport_ignores_bare_unquoted_placeholders() {
        // Only the 4 quoted placeholders (e.g. "%TAB_ID%") are replaced.
        // A bare %FOO% (without surrounding quotes) must survive — the
        // test proves the replacement is not a blind "%VAR%"→value but
        // explicitly the quoted form.
        let tpl = r#""%TAB_ID%" %FOO% "#;
        let r = render_transport(tpl, "x", "x", "x", "x");
        assert!(r.contains(r#""x""#), "quoted placeholder must be replaced");
        assert!(r.contains("%FOO%"), "bare %FOO% must survive untouched");
    }

    #[test]
    fn render_transport_actual_webkit_template_no_leftovers() {
        let tpl = include_str!("webkit_transport_setup.js");
        let r = render_transport(tpl, "tab-id", "tok", "hdl", "doc123");
        assert!(!r.contains('%'), "surviving placeholder in webkit template: {r}");
    }

    #[test]
    fn render_transport_actual_webview2_template_no_leftovers() {
        let tpl = include_str!("webview2_transport_setup.js");
        let r = render_transport(tpl, "tab-id", "tok", "hdl", "doc123");
        assert!(!r.contains('%'), "surviving placeholder in webview2 template: {r}");
    }

    #[test]
    fn windows_document_script_registration_uses_webview2_completion_helper() {
        let source = include_str!("windows.rs");
        assert!(
            source.contains(
                "AddScriptToExecuteOnDocumentCreatedCompletedHandler::wait_for_async_operation"
            ),
            "WebView2 registration must pump its STA callback on Tauri's UI thread"
        );
        assert!(
            source.contains("recv_timeout")
                && !source.contains(
                    "AddScriptToExecuteOnDocumentCreatedCompletedHandler::create"
                ),
            "the worker must await the completed UI-thread registration before navigation"
        );
        assert!(
            !source.contains("let _ = cwv.AddScriptToExecuteOnDocumentCreated"),
            "WebView2 script registration errors must not be discarded"
        );
    }

    #[test]
    fn webview2_controller_wait_preserves_com_sta_reentrancy() {
        let source =
            include_str!("../../../vendor/wry/src/webview2/mod.rs").replace("\r\n", "\n");
        let manifest = include_str!("../../../Cargo.toml");
        let environment_helper = source
            .split_once("fn create_environment")
            .and_then(|(_, tail)| tail.split_once("\n  #[inline]\n  fn create_controller"))
            .map(|(helper, _)| helper)
            .expect("vendored Wry environment helper must remain inspectable");
        let controller_helper = source
            .split_once("fn create_controller")
            .and_then(|(_, tail)| tail.split_once("\n  #[allow(clippy::too_many_arguments)]"))
            .map(|(helper, _)| helper)
            .expect("vendored Wry controller helper must remain inspectable");
        assert!(
            environment_helper.contains("co_wait_for_handle(event)")
                && controller_helper.contains("co_wait_for_handle(event)")
                && source.contains("CoWaitForMultipleHandles")
                && source.contains("COWAIT_DISPATCH_CALLS")
                && source.contains("COWAIT_DISPATCH_WINDOW_MESSAGES"),
            "WebView2 controller creation must dispatch COM calls and window messages"
        );
        assert!(
            !environment_helper.contains("wait_with_pump")
                && !controller_helper.contains("wait_with_pump")
                && !environment_helper.contains("sync::mpsc")
                && !controller_helper.contains("sync::mpsc"),
            "environment/controller completion must signal a waitable event instead of polling a channel"
        );
        assert!(
            manifest.contains("wry = { path = \"vendor/wry\" }"),
            "Cargo must use the pinned Wry source containing the COM wait correction"
        );
    }

    #[test]
    fn webview2_browser_tabs_skip_the_tauri_initialization_runtime() {
        let source =
            include_str!("../../../vendor/wry/src/webview2/mod.rs").replace("\r\n", "\n");
        let helper = source
            .split_once("fn add_script_to_execute_on_document_created")
            .and_then(|(_, tail)| tail.split_once("\n  #[inline]\n  fn execute_script"))
            .map(|(helper, _)| helper)
            .expect("vendored Wry document-script helper must remain inspectable");
        assert!(
            helper.contains(
                "AddScriptToExecuteOnDocumentCreatedCompletedHandler::wait_for_async_operation"
            )
                && helper.contains(".AddScriptToExecuteOnDocumentCreated")
                && !helper.contains("co_wait_for_handle(event)"),
            "each required document script must use Wry's supported WebView2 completion helper"
        );
        assert!(
            !helper.contains("CreateEventW")
                && !helper.contains("SetEvent")
                && !helper.contains("Self::dispatch_handler")
                && !helper.contains("VecDeque"),
            "document-script registration must not duplicate controller wait plumbing"
        );
        assert!(
            source.contains(
                "let skip_tauri_initialization_scripts =\n      webview_id.starts_with(\"verboo-browser-\");"
            ) && source.contains("if !skip_tauri_initialization_scripts")
                && source.contains("initialization_scripts.push(String::from(IPC_INIT_SCRIPT))")
                && !source.contains("initialization_scripts.join(\"\\n;\\n\")"),
            "embedded browser tabs must keep the Wry IPC shim without exposing the Tauri runtime"
        );
        let bridge = include_str!("webview2_transport_setup.js");
        assert!(
            bridge.contains("window.chrome.webview.postMessage")
                && !bridge.contains("__TAURI_INTERNALS__")
                && !bridge.contains("window.ipc"),
            "the isolated browser bridge must remain independent of the skipped Tauri runtime"
        );
    }

    #[test]
    fn webview2_window_dispatcher_surfaces_install_and_post_failures() {
        let source =
            include_str!("../../../vendor/wry/src/webview2/mod.rs").replace("\r\n", "\n");
        assert!(
            !source.contains("fn defer_webview_completion"),
            "the failed CoWait completion barrier must stay removed"
        );
        let dispatcher = source
            .split_once("unsafe fn dispatch_handler")
            .and_then(|(_, tail)| {
                tail.split_once("\n  unsafe extern \"system\" fn main_thread_dispatcher_proc")
            })
            .map(|(helper, _)| helper)
            .expect("vendored Wry window dispatcher must remain inspectable");
        assert!(
            dispatcher.contains("windows::core::Result<()>")
                && dispatcher.contains("drop(Box::from_raw(raw))")
                && dispatcher.contains("return Err(err)"),
            "a failed PostMessage must free its closure and surface the error"
        );
        let dispatcher_install = source
            .split_once("unsafe fn attach_main_thread_dispatcher")
            .and_then(|(_, tail)| tail.split_once("\n\n  fn parent_bounds"))
            .map(|(helper, _)| helper)
            .expect("vendored Wry dispatcher installation must remain inspectable");
        assert!(
            dispatcher_install.contains("windows::core::Result<()>")
                && dispatcher_install.contains("SetWindowSubclass")
                && dispatcher_install.contains(".ok()")
                && source.matches("Self::attach_main_thread_dispatcher(hwnd)?;").count() == 2,
            "dispatcher installation must fail before any message can be posted without a consumer"
        );
    }
}
