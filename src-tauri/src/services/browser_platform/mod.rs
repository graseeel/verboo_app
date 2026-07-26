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
pub use macos::{attach_bridge, evaluate, snapshot_png, BridgeHandle};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{attach_bridge, evaluate, snapshot_png, BridgeHandle};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{attach_bridge, evaluate, snapshot_png, BridgeHandle};

// ---------------------------------------------------------------------------
// Helpers compartilhados entre os 3 adaptadores de plataforma.
// ---------------------------------------------------------------------------

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

    // ---- Testes de contrato entre plataformas ----

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

    // ---- Os templates CRUOS contêm os placeholders esperados ----
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

    // ---- Depois de renderizar, NADA de % sobrevive ----

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
    fn windows_document_script_registration_completes_without_a_nested_message_pump() {
        let source = include_str!("windows.rs");
        assert!(
            !source.contains("wait_for_async_operation"),
            "WebView2 registration must not nest a Win32 message pump inside Tauri's UI loop"
        );
        assert!(
            source.contains("AddScriptToExecuteOnDocumentCreatedCompletedHandler::create")
                && source.contains("recv_timeout"),
            "the worker must await WebView2 script registration before navigation"
        );
        assert!(
            !source.contains("let _ = cwv.AddScriptToExecuteOnDocumentCreated"),
            "WebView2 script registration errors must not be discarded"
        );
    }
}
