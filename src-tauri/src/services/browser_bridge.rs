use std::collections::VecDeque;
use serde::Deserialize;
use super::browser_session::BrowserTabId;

pub const MAX_PAGE_MESSAGES: usize = 256;
pub const MAX_PAGE_MESSAGE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct BridgeConfig {
    pub tab_id: BrowserTabId,
    pub token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageEnvelope {
    pub tab_id: BrowserTabId,
    pub bridge_token: String,
    pub document_token: String,
    pub payload: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeAcceptError { WrongTab, WrongToken, StaleDocument, MessageTooLarge, InvalidPayload, Overflow }

#[derive(Deserialize)]
struct PageMessageKind {
    #[serde(rename = "type")]
    #[allow(dead_code)]
    kind: String,
}

pub struct BrowserBridgeQueue {
    config: BridgeConfig,
    document_token: Option<String>,
    messages: VecDeque<String>,
    recovery_required: bool,
}

impl BrowserBridgeQueue {
    pub fn new(tab_id: BrowserTabId, token: String) -> Self {
        Self { config: BridgeConfig { tab_id, token }, document_token: None, messages: VecDeque::new(), recovery_required: false }
    }

    /// Native-only knob: register the document token Rust expects from the page.
    /// Called by the platform adapter at document-start, one call per navigation.
    /// NEVER callable by the page itself — that is the entire point.
    pub fn expect_document(&mut self, token: String) {
        self.document_token = Some(token);
    }

    pub fn accept(&mut self, envelope: BrowserPageEnvelope) -> Result<(), BridgeAcceptError> {
        if envelope.tab_id != self.config.tab_id { return Err(BridgeAcceptError::WrongTab); }
        if envelope.bridge_token != self.config.token { return Err(BridgeAcceptError::WrongToken); }
        if envelope.payload.len() > MAX_PAGE_MESSAGE_BYTES { return Err(BridgeAcceptError::MessageTooLarge); }
        // Parse must succeed or we reject — even before the document_token check.
        serde_json::from_str::<PageMessageKind>(&envelope.payload)
            .map_err(|_| BridgeAcceptError::InvalidPayload)?;
        // document_token check is fail-closed: any mismatch, including expected==None,
        // is rejected. page-ready no longer rotates the token.
        if self.document_token.as_deref() != Some(envelope.document_token.as_str()) {
            return Err(BridgeAcceptError::StaleDocument);
        }
        if self.messages.len() >= MAX_PAGE_MESSAGES {
            self.messages.clear();
            self.recovery_required = true;
            return Err(BridgeAcceptError::Overflow);
        }
        self.messages.push_back(envelope.payload);
        Ok(())
    }

    pub fn drain(&mut self) -> Vec<String> { self.messages.drain(..).collect() }
    pub fn recovery_required(&self) -> bool { self.recovery_required }

    /// Returns the document token the queue currently expects from the
    /// page, or `None` if `expect_document` has not been called yet.
    /// Used by the page→native sink to build envelopes with the right
    /// `document_token` so `accept()` can validate staleness.
    pub fn current_document_token(&self) -> Option<&str> {
        self.document_token.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(token: &str, document: &str, payload: &str) -> BrowserPageEnvelope {
        BrowserPageEnvelope {
            tab_id: "tab-a".into(),
            bridge_token: token.into(),
            document_token: document.into(),
            payload: payload.into(),
        }
    }

    #[test]
    fn rejects_wrong_token_stale_document_and_oversized_payload() {
        let mut queue = BrowserBridgeQueue::new("tab-a".into(), "secret".into());
        queue.expect_document("doc-1".into());
        queue.accept(raw("secret", "doc-1", r#"{"type":"page-ready"}"#)).unwrap();
        assert_eq!(queue.accept(raw("wrong", "doc-1", r#"{"type":"x"}"#)), Err(BridgeAcceptError::WrongToken));
        assert_eq!(queue.accept(raw("secret", "doc-old", r#"{"type":"x"}"#)), Err(BridgeAcceptError::StaleDocument));
        assert_eq!(queue.accept(raw("secret", "doc-1", &"x".repeat(MAX_PAGE_MESSAGE_BYTES + 1))), Err(BridgeAcceptError::MessageTooLarge));
    }

    #[test]
    fn the_two_hundred_and_fifty_seventh_message_trips_recovery() {
        let mut queue = BrowserBridgeQueue::new("tab-a".into(), "secret".into());
        queue.expect_document("doc-1".into());
        queue.accept(raw("secret", "doc-1", r#"{"type":"page-ready"}"#)).unwrap();
        for _ in 1..MAX_PAGE_MESSAGES { queue.accept(raw("secret", "doc-1", r#"{"type":"x"}"#)).unwrap(); }
        assert_eq!(queue.accept(raw("secret", "doc-1", r#"{"type":"x"}"#)), Err(BridgeAcceptError::Overflow));
        assert!(queue.recovery_required());
        assert!(queue.drain().is_empty());
    }

    #[test]
    fn malformed_json_returns_invalid_payload_and_does_not_rotate_document_token() {
        let mut queue = BrowserBridgeQueue::new("tab-a".into(), "secret".into());
        queue.expect_document("doc-1".into());
        queue.accept(raw("secret", "doc-1", r#"{"type":"page-ready"}"#)).unwrap();
        // Malformed JSON with the OLD document token must NOT rotate the token
        // (rotation is impossible from the page; even if it were, this still fails to parse).
        assert_eq!(queue.accept(raw("secret", "doc-old", "{not json")), Err(BridgeAcceptError::InvalidPayload));
        // doc-1 is still the expected token: a well-formed message with doc-1 is accepted.
        assert!(queue.accept(raw("secret", "doc-1", r#"{"type":"x"}"#)).is_ok());
    }

    // REGRESSION TEST for the security failure Maestro found.
    // Before the fix, a page-ready envelope with a STALE document_token rotated the
    // expected token back to the stale value, re-enabling messages from the old document.
    // After the fix, page-ready has zero power over the token: a stale page-ready is
    // rejected with StaleDocument, and the expected token is unchanged.
    #[test]
    fn page_ready_with_stale_document_token_is_rejected_and_does_not_change_expected_token() {
        let mut queue = BrowserBridgeQueue::new("tab-a".into(), "secret".into());
        queue.expect_document("doc-1".into());
        queue.accept(raw("secret", "doc-1", r#"{"type":"page-ready"}"#)).unwrap();
        // Native rotates the expected token to doc-2 (a new navigation).
        queue.expect_document("doc-2".into());
        queue.accept(raw("secret", "doc-2", r#"{"type":"page-ready"}"#)).unwrap();
        // The old document's lingering script tries page-ready with doc-1 (stale):
        assert_eq!(
            queue.accept(raw("secret", "doc-1", r#"{"type":"page-ready"}"#)),
            Err(BridgeAcceptError::StaleDocument)
        );
        // And doc-2 is STILL the expected token — the failed attempt did not rotate it.
        assert!(queue.accept(raw("secret", "doc-2", r#"{"type":"x"}"#)).is_ok());
    }

    #[test]
    fn repeated_navigation_rotates_expected_token_and_invalidates_previous() {
        let mut queue = BrowserBridgeQueue::new("tab-a".into(), "secret".into());
        queue.expect_document("doc-1".into());
        assert!(queue.accept(raw("secret", "doc-1", r#"{"type":"x"}"#)).is_ok());
        // Native rotates the expected token to doc-2.
        queue.expect_document("doc-2".into());
        assert!(queue.accept(raw("secret", "doc-2", r#"{"type":"x"}"#)).is_ok());
        // doc-1 is now stale.
        assert_eq!(queue.accept(raw("secret", "doc-1", r#"{"type":"x"}"#)), Err(BridgeAcceptError::StaleDocument));
    }
}