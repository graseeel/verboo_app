use std::time::Duration;

use crate::models::types::{
    FeedbackCategory, FeedbackChannel, FeedbackRequest, FeedbackResult,
};

const FEEDBACK_EMAIL: &str = "grasel.moura05@gmail.com";

/// Sends user feedback via Supabase (if configured) or falls back to mailto.
/// Mirrors Electron's `FeedbackService` (src/main/services/feedbackService.ts:6).
pub struct FeedbackService;

impl FeedbackService {
    /// Sends feedback. Reads Supabase config from env vars
    /// (`VERBOO_FEEDBACK_ENDPOINT`, `VERBOO_FEEDBACK_PUBLIC_KEY` or
    /// `VERBOO_FEEDBACK_ANON_KEY`), tries Supabase first, falls back to a
    /// pre-filled email on any failure.
    pub fn send_feedback(
        request: FeedbackRequest,
        app_version: &str,
        platform: &str,
        mut open_url: impl FnMut(&str) -> Result<(), String>,
    ) -> FeedbackResult {
        let endpoint = std::env::var("VERBOO_FEEDBACK_ENDPOINT")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let public_key = std::env::var("VERBOO_FEEDBACK_PUBLIC_KEY")
            .or_else(|_| std::env::var("VERBOO_FEEDBACK_ANON_KEY"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        Self::send_feedback_with_config(
            request,
            app_version,
            platform,
            endpoint.as_deref(),
            public_key.as_deref(),
            &mut open_url,
        )
    }

    /// Pure version of `send_feedback` that takes config explicitly. Easier to
    /// test without env var races. Public for the lib.rs wrapper and tests.
    pub fn send_feedback_with_config(
        request: FeedbackRequest,
        app_version: &str,
        platform: &str,
        endpoint: Option<&str>,
        public_key: Option<&str>,
        open_url: &mut dyn FnMut(&str) -> Result<(), String>,
    ) -> FeedbackResult {
        let normalized = normalize_request(request);

        if let Some(endpoint) = endpoint {
            match post_to_supabase(
                endpoint,
                public_key,
                &normalized,
                app_version,
                platform,
            ) {
                Ok(()) => return FeedbackResult {
                    ok: true,
                    channel: FeedbackChannel::Supabase,
                    message: "Feedback enviado.".into(),
                    error: None,
                },
                Err(message) => {
                    let mailto = build_mailto(&normalized, &message);
                    let _ = open_url(&mailto);
                    return FeedbackResult {
                        ok: true,
                        channel: FeedbackChannel::Mailto,
                        message:
                            "Não foi possível enviar pelo Supabase. Um e-mail preenchido foi aberto como fallback."
                                .into(),
                        error: Some(message),
                    };
                }
            }
        }

        let reason = "VERBOO_FEEDBACK_ENDPOINT não configurado.";
        let mailto = build_mailto(&normalized, reason);
        let _ = open_url(&mailto);
        FeedbackResult {
            ok: true,
            channel: FeedbackChannel::Mailto,
            message: "Supabase não está configurado neste build. Um e-mail preenchido foi aberto."
                .into(),
            error: None,
        }
    }
}

/// Posts the feedback payload to the Supabase endpoint. Mirrors Electron's
/// `postToSupabase` (feedbackService.ts:41).
fn post_to_supabase(
    endpoint: &str,
    public_key: Option<&str>,
    request: &FeedbackRequest,
    app_version: &str,
    platform: &str,
) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Falha ao criar cliente HTTP: {e}"))?;

    let mut payload = serde_json::to_value(request).map_err(|e| e.to_string())?;
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("appVersion".into(), serde_json::Value::String(app_version.into()));
        obj.insert("platform".into(), serde_json::Value::String(platform.into()));
    }

    let mut req = client
        .post(endpoint)
        .header("content-type", "application/json")
        .json(&payload);
    if let Some(key) = public_key {
        req = req
            .header("authorization", format!("Bearer {key}"))
            .header("apikey", key);
    }

    let response = req.send().map_err(|e| format!("Falha ao enviar: {e}"))?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let details = response.text().unwrap_or_default();
    let truncated: String = details.chars().take(220).collect();
    Err(if truncated.is_empty() {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status}: {truncated}")
    })
}

/// Builds a `mailto:` URL with subject + body pre-filled. Mirrors Electron's
/// `openMailto` (feedbackService.ts:62).
fn build_mailto(request: &FeedbackRequest, fallback_reason: &str) -> String {
    let subject = format!(
        "[Verboo Code Desktop] {}: {}",
        label_for_category(&request.category),
        request.title
    );
    let diagnostics_line = if request.include_diagnostics {
        match &request.diagnostics {
            Some(d) => serde_json::to_string_pretty(d).unwrap_or_else(|_| "{}".into()),
            None => "não incluídos".into(),
        }
    } else {
        "não incluídos".into()
    };
    let contact = request
        .contact
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("não informado");
    let body = format!(
        "{description}\n\nContato: {contact}\nCanal principal: {reason}\n\nDiagnosticos:\n{diag}",
        description = request.description,
        contact = contact,
        reason = fallback_reason,
        diag = diagnostics_line,
    );
    format!(
        "mailto:{email}?subject={subject}&body={body}",
        email = FEEDBACK_EMAIL,
        subject = url_encode(&subject),
        body = url_encode(&body),
    )
}

/// URL-encodes a string for use in a `mailto:` query. Mirrors JavaScript's
/// `encodeURIComponent` for the subset of characters that need escaping.
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{:02X}", b));
            }
        }
    }
    out
}

/// Normalizes the request: trims, clamps lengths, defaults title from category.
/// Mirrors Electron's `normalizeRequest` (feedbackService.ts:80).
fn normalize_request(mut request: FeedbackRequest) -> FeedbackRequest {
    let title: String = request.title.trim().chars().take(160).collect();
    let description: String = request.description.trim().chars().take(8000).collect();
    let contact: Option<String> = request
        .contact
        .as_deref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(160).collect());

    request.title = if title.is_empty() {
        label_for_category(&request.category).to_string()
    } else {
        title
    };
    request.description = description;
    request.contact = contact;
    if !request.include_diagnostics {
        request.diagnostics = None;
    }
    request
}

fn label_for_category(category: &FeedbackCategory) -> &'static str {
    match category {
        FeedbackCategory::Bug => "Bug",
        FeedbackCategory::Question => "Dúvida",
        FeedbackCategory::Feedback => "Feedback",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::FeedbackDiagnostics;

    fn sample_request() -> FeedbackRequest {
        FeedbackRequest {
            category: FeedbackCategory::Bug,
            title: "App crashed".into(),
            description: "It crashed when I clicked X".into(),
            contact: Some("user@example.com".into()),
            include_diagnostics: false,
            diagnostics: None,
        }
    }

    #[test]
    fn normalize_trims_and_clamps() {
        let req = FeedbackRequest {
            category: FeedbackCategory::Feedback,
            title: "  hello  ".into(),
            description: "  world  ".into(),
            contact: Some("  x@y.z  ".into()),
            include_diagnostics: true,
            diagnostics: None,
        };
        let n = normalize_request(req);
        assert_eq!(n.title, "hello");
        assert_eq!(n.description, "world");
        assert_eq!(n.contact.as_deref(), Some("x@y.z"));
        // include_diagnostics=true but diagnostics=None → stays None
        assert!(n.diagnostics.is_none());
    }

    #[test]
    fn normalize_defaults_empty_title_from_category() {
        let req = FeedbackRequest {
            category: FeedbackCategory::Bug,
            title: "   ".into(),
            description: "desc".into(),
            contact: None,
            include_diagnostics: false,
            diagnostics: None,
        };
        let n = normalize_request(req);
        assert_eq!(n.title, "Bug");
    }

    #[test]
    fn normalize_drops_diagnostics_when_not_included() {
        let req = FeedbackRequest {
            category: FeedbackCategory::Feedback,
            title: "t".into(),
            description: "d".into(),
            contact: None,
            include_diagnostics: false,
            diagnostics: Some(FeedbackDiagnostics {
                app_version: "0.1".into(),
                platform: "darwin".into(),
                app_source: "test".into(),
                project_name: None,
                active_view: None,
                model_id: None,
                model_display_name: None,
                model_source: None,
                access_mode: None,
                context_window: None,
                context_usage: None,
                auth_method: None,
                cli_logged_in: None,
                has_api_key: None,
            }),
        };
        let n = normalize_request(req);
        assert!(n.diagnostics.is_none());
    }

    #[test]
    fn label_for_category_matches_electron() {
        assert_eq!(label_for_category(&FeedbackCategory::Bug), "Bug");
        assert_eq!(label_for_category(&FeedbackCategory::Question), "Dúvida");
        assert_eq!(label_for_category(&FeedbackCategory::Feedback), "Feedback");
    }

    #[test]
    fn url_encode_handles_special_chars() {
        assert_eq!(url_encode("hello world"), "hello%20world");
        assert_eq!(url_encode("a+b=c"), "a%2Bb%3Dc");
        assert_eq!(url_encode("café"), "caf%C3%A9");
        assert_eq!(url_encode("100%"), "100%25");
        // Unreserved chars stay literal
        assert_eq!(url_encode("A-Z_a.z.9"), "A-Z_a.z.9");
    }

    #[test]
    fn mailto_includes_subject_body_and_contact() {
        let req = sample_request();
        let url = build_mailto(&req, "test reason");
        assert!(url.starts_with("mailto:grasel.moura05@gmail.com?"));
        assert!(url.contains("subject="));
        assert!(url.contains("body="));
        assert!(url.contains("App%20crashed"));
        assert!(url.contains("user%40example.com"));
        assert!(url.contains("test%20reason"));
    }

    #[test]
    fn mailto_uses_default_contact_when_missing() {
        let mut req = sample_request();
        req.contact = None;
        let url = build_mailto(&req, "r");
        assert!(url.contains("n%C3%A3o%20informado"));
    }

    #[test]
    fn mailto_includes_diagnostics_when_requested() {
        let mut req = sample_request();
        req.include_diagnostics = true;
        req.diagnostics = Some(FeedbackDiagnostics {
            app_version: "0.3.0-beta.1".into(),
            platform: "darwin".into(),
            app_source: "test".into(),
            project_name: None,
            active_view: None,
            model_id: None,
            model_display_name: None,
            model_source: None,
            access_mode: None,
            context_window: None,
            context_usage: None,
            auth_method: None,
            cli_logged_in: None,
            has_api_key: None,
        });
        let url = build_mailto(&req, "r");
        assert!(url.contains("Diagnosticos"));
        assert!(url.contains("0.3.0-beta.1"));
    }

    #[test]
    fn send_feedback_falls_back_to_mailto_when_endpoint_unset() {
        let mut captured = String::new();
        let mut open = |url: &str| {
            captured = url.to_string();
            Ok(())
        };
        let result = FeedbackService::send_feedback_with_config(
            sample_request(),
            "0.3.0-beta.1",
            "darwin",
            None,
            None,
            &mut open,
        );
        assert!(result.ok);
        assert_eq!(result.channel, FeedbackChannel::Mailto);
        assert!(captured.starts_with("mailto:grasel.moura05@gmail.com"));
        assert!(result.message.contains("Supabase"));
        assert!(result.error.is_none());
    }

    #[test]
    fn send_feedback_falls_back_to_mailto_on_supabase_failure() {
        // Point to an unreachable endpoint to force the failure path → mailto fallback.
        let mut captured = String::new();
        let mut open = |url: &str| {
            captured = url.to_string();
            Ok(())
        };
        let result = FeedbackService::send_feedback_with_config(
            sample_request(),
            "0.3.0-beta.1",
            "darwin",
            Some("http://127.0.0.1:1/nonexistent-feedback-endpoint"),
            None,
            &mut open,
        );
        // Even on Supabase failure, ok=true because mailto fallback opened.
        assert!(result.ok);
        assert_eq!(result.channel, FeedbackChannel::Mailto);
        assert!(captured.starts_with("mailto:"));
        assert!(result.error.is_some());
    }
}
