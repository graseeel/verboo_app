(function() {
    globalThis.__VERBOO_NATIVE_TRANSPORT__ = {
        tabId: "%TAB_ID%",
        bridgeToken: "%BRIDGE_TOKEN%",
        get documentToken() {
            // The document token is injected by the native side per
            // navigation via ExecuteScript in the ContentLoading handler.
            // It is NEVER generated in JavaScript — the Rust side owns it.
            // If the global is missing (race between ContentLoading and
            // this script), the token is empty and the first page
            // message is rejected as StaleDocument by the Rust queue.
            var t = globalThis.__verboo_pending_doc_token__;
            if (t) {
                delete globalThis.__verboo_pending_doc_token__;
                return t;
            }
            return "";
        },
        post: function(text) {
            window.chrome.webview.postMessage(text);
        }
    };
})();
