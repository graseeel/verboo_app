(function() {
    globalThis.__VERBOO_NATIVE_TRANSPORT__ = {
        tabId: "%TAB_ID%",
        bridgeToken: "%BRIDGE_TOKEN%",
        get documentToken() {
            // The document token can be injected per navigation by the
            // native side via evaluate_javascript on load-changed.
            // If not set, falls back to the initial UUID (macOS setup)
            // or the NavigationStarting-generated token (Windows).
            var t = globalThis.__verboo_pending_doc_token__;
            if (t) {
                delete globalThis.__verboo_pending_doc_token__;
                return t;
            }
            return "%DOCUMENT_TOKEN%";
        },
        post: function(text) {
            window.webkit.messageHandlers["%HANDLER_NAME%"].postMessage(text);
        }
    };
})();
