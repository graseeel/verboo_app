(function() {
    // NOTA: o placeholder HANDLER_NAME  (com percentuais, no WebKit)
    // NÃO está neste template. WebView2 não usa messageHandlers nomeados
    // como o WebKit; o método de postagem é fixo:
    //   window.chrome.webview.postMessage(text)
    // O handler_name derivado do tab_id ainda existe em Rust (BridgeHandle)
    // para consistência de contrato, mas não aparece no JS do Windows.
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
            return "%DOCUMENT_TOKEN%";
        },
        post: function(text) {
            window.chrome.webview.postMessage(text);
        }
    };
})();
