(function() {
    globalThis.__VERBOO_NATIVE_TRANSPORT__ = {
        tabId: "%TAB_ID%",
        bridgeToken: "%BRIDGE_TOKEN%",
        get documentToken() {
            // macOS and Windows rotate the document token per navigation.
            // Linux cannot rotate (IPC races with UserScript injection in
            // WebKitGTK), so the token is fixed at attach time.
            return "%DOCUMENT_TOKEN%";
        },
        post: function(text) {
            window.webkit.messageHandlers["%HANDLER_NAME%"].postMessage(text);
        }
    };
})();
