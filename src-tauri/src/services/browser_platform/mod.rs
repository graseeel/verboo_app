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
}
