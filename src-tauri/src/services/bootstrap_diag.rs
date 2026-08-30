//! Last user-facing bootstrap failure, shared by the update snapshot and the
//! login path. Stores URL/status/relative-path details; never keys or tokens.

use std::sync::Mutex;
use std::time::{Duration, Instant};

struct LastDetail {
    detail: String,
    recorded_at: Instant,
}

static LAST_DETAIL: Mutex<Option<LastDetail>> = Mutex::new(None);

const OPAQUE_CODES: &[&str] = &["runtime_install_failed", "cli_initialization_failed"];
const DETAIL_TTL: Duration = Duration::from_secs(60);

pub fn record(detail: impl AsRef<str>) {
    let sanitized = sanitize(detail.as_ref());
    if sanitized.is_empty() || is_opaque_code(&sanitized) {
        return;
    }
    *LAST_DETAIL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(LastDetail {
        detail: sanitized,
        recorded_at: Instant::now(),
    });
}

pub fn last() -> Option<String> {
    let mut slot = LAST_DETAIL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match slot.as_ref() {
        Some(entry) if entry.recorded_at.elapsed() <= DETAIL_TTL => Some(entry.detail.clone()),
        Some(_) => {
            *slot = None;
            None
        }
        None => None,
    }
}

pub fn clear() {
    *LAST_DETAIL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

pub fn sanitize(detail: &str) -> String {
    let mut text = detail.trim().to_string();
    redact_span(&mut text, "Bearer ");
    redact_header_value(&mut text, "Authorization:");
    redact_after(&mut text, "token=");
    redact_after(&mut text, "secret=");
    redact_after(&mut text, "password=");
    redact_after(&mut text, "api_key=");
    redact_after(&mut text, "api-key=");
    text
}

fn is_opaque_code(detail: &str) -> bool {
    OPAQUE_CODES.contains(&strip_stage_prefixes(detail))
}

fn strip_stage_prefixes(detail: &str) -> &str {
    let mut cause = detail.trim();
    loop {
        let next = cause
            .strip_prefix("CLI: ")
            .or_else(|| cause.strip_prefix("App: "))
            .map(str::trim_start);
        match next {
            Some(stripped) if stripped != cause => cause = stripped,
            _ => break,
        }
    }
    cause
}

fn redact_header_value(text: &mut String, header: &str) {
    let Some(idx) = find_ignore_ascii_case(text, header) else {
        return;
    };
    let mut start = idx + header.len();
    while text
        .get(start..)
        .and_then(|rest| rest.chars().next())
        .is_some_and(|ch| ch.is_whitespace())
    {
        start += 1;
    }
    let end = text[start..]
        .find(char::is_whitespace)
        .map(|offset| start + offset)
        .unwrap_or(text.len());
    if start < end {
        text.replace_range(start..end, "[redacted]");
    }
}

fn redact_span(text: &mut String, marker: &str) {
    let Some(idx) = find_ignore_ascii_case(text, marker) else {
        return;
    };
    let after_marker = idx + marker.len();
    let end = text[after_marker..]
        .find(char::is_whitespace)
        .map(|offset| after_marker + offset)
        .unwrap_or(text.len());
    text.replace_range(idx..end, "[redacted]");
}

fn redact_after(text: &mut String, marker: &str) {
    let Some(idx) = find_ignore_ascii_case(text, marker) else {
        return;
    };
    let start = idx + marker.len();
    let end = text[start..]
        .find(|ch: char| ch.is_whitespace() || ch == '&' || ch == '"')
        .map(|offset| start + offset)
        .unwrap_or(text.len());
    text.replace_range(start..end, "[redacted]");
}

fn find_ignore_ascii_case(haystack: &str, needle: &str) -> Option<usize> {
    haystack
        .to_ascii_lowercase()
        .find(&needle.to_ascii_lowercase())
}

#[cfg(test)]
pub fn reset() {
    clear();
}

#[cfg(test)]
pub fn record_aged(detail: impl AsRef<str>, age: Duration) {
    let sanitized = sanitize(detail.as_ref());
    if sanitized.is_empty() || is_opaque_code(&sanitized) {
        return;
    }
    let recorded_at = Instant::now()
        .checked_sub(age)
        .expect("test host uptime must cover the bootstrap detail TTL");
    *LAST_DETAIL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(LastDetail {
        detail: sanitized,
        recorded_at,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_keeps_url_and_status_and_redacts_tokens() {
        let kept = sanitize(
            "managed Node download failed: HTTP 403 from https://nodejs.org/dist/v24.19.0/node.zip",
        );
        assert!(kept.contains("HTTP 403"));
        assert!(kept.contains("nodejs.org"));
        assert!(!kept.contains("token="));

        let redacted = sanitize("failed Authorization: Bearer super-secret-token");
        assert!(redacted.contains("[redacted]"));
        assert!(!redacted.contains("super-secret-token"));

        let query = sanitize("GET https://example.test/file?token=abc123&x=1");
        assert!(query.contains("[redacted]"));
        assert!(!query.contains("abc123"));
    }

    #[test]
    fn sanitize_redacts_password_query_values() {
        let redacted = sanitize("login failed password=hunter2 from upstream");
        assert!(redacted.contains("[redacted]"), "{redacted}");
        assert!(!redacted.contains("hunter2"), "{redacted}");
        assert!(redacted.contains("login failed"), "{redacted}");
    }

    #[test]
    fn sanitize_redacts_authorization_header_without_bearer() {
        let redacted = sanitize("proxy rejected Authorization: raw-header-token");
        assert!(redacted.contains("[redacted]"), "{redacted}");
        assert!(!redacted.contains("raw-header-token"), "{redacted}");
        assert!(redacted.contains("proxy rejected"), "{redacted}");
    }

    #[test]
    fn record_stores_sanitized_detail_and_skips_opaque_codes() {
        reset();
        record("runtime_install_failed");
        assert_eq!(last(), None);
        record("managed Node download failed: HTTP 403 from https://nodejs.org/dist/v24.19.0/node.zip");
        assert!(last().unwrap().contains("HTTP 403"));
        reset();
    }

    #[test]
    fn last_returns_none_when_detail_is_older_than_ttl() {
        reset();
        record_aged(
            "managed Node download failed: HTTP 403 from https://nodejs.org/dist/v24.19.0/node.zip",
            Duration::from_secs(61),
        );
        assert_eq!(last(), None);
        reset();
    }

    #[test]
    fn record_skips_double_prefixed_opaque_codes() {
        reset();
        record("CLI: CLI: runtime_install_failed");
        assert_eq!(last(), None);
        record("App: CLI: cli_initialization_failed");
        assert_eq!(last(), None);
        reset();
    }

    #[test]
    fn sanitize_keeps_minisign_public_key_prefix() {
        let kept = sanitize(
            "verified RWQjehzo2JD7vasdwqX2eXrGVlAucr62mJI2MqH50mKuE99cW9P8gvCw and also RWQaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        assert!(kept.contains("RWQjehzo"), "{kept}");
        assert!(kept.contains("RWQaaaa"), "{kept}");
        assert!(!kept.contains("[redacted]"), "{kept}");
    }
}
