use chrono::Utc;
use reqwest::blocking::Client;
use serde_json::Value;

use crate::models::types::{
    ProfileActivityDay, ProfilePlan, ProfileResult, ProfileStatus, ProfileUsageSummary, ProfileUser,
};

const API_BASE: &str = "https://code.verboo.ai/api";

/// Mirrors Electron's `ProfileService` (src/main/services/profileService.ts).
/// Fetches `/me`, `/me/groups`, `/me/subscriptions`, and per-group usage
/// summaries using the user's API key as Bearer. Returns a normalized
/// `ProfileResult` for the renderer.
///
/// When `api_key` is None or empty, returns `Unauthenticated` so the renderer
/// can prompt for login. When all API calls fail, returns `Error`.
pub struct ProfileService;

impl ProfileService {
    pub fn new() -> Self {
        Self
    }

    pub fn get_profile(&self, api_key: Option<&str>) -> ProfileResult {
        let key = match api_key {
            Some(k) if !k.trim().is_empty() => k,
            _ => {
                return ProfileResult {
                    status: ProfileStatus::Unauthenticated,
                    fetched_at: None,
                    user: None,
                    plan: None,
                    summary: None,
                    activity: None,
                    active_days: None,
                    error: Some(
                        "Entre com Verboo pelo CLI/app ou configure uma chave de API para carregar dados reais de perfil."
                            .into(),
                    ),
                };
            }
        };

        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| Client::new());

        let now = Utc::now();
        let from = now - chrono::Duration::days(30);
        let usage_query = format!(
            "from={}&to={}&bucket=day",
            urlencode(&from.to_rfc3339()),
            urlencode(&now.to_rfc3339())
        );

        // Fire the three independent calls. We use blocking reqwest; the
        // command runs in a Tauri async context but `get_profile` itself is
        // a sync function — the caller wraps it in `tokio::task::spawn_blocking`
        // if needed.
        let me = fetch_json(&client, "/me", key).unwrap_or(Value::Null);
        let groups = fetch_json(&client, "/me/groups", key).unwrap_or(Value::Null);
        let subscriptions = fetch_json(&client, "/me/subscriptions", key).unwrap_or(Value::Null);

        let active_groups = array_from(&groups)
            .into_iter()
            .filter(|g| is_active_membership(g))
            .collect::<Vec<_>>();
        let group_ids = active_groups
            .iter()
            .filter_map(|g| {
                string_value(g.get("groupId")).or_else(|| string_value(g.get("id")))
            })
            .collect::<Vec<_>>();

        let mut summaries: Vec<Value> = Vec::new();
        for gid in &group_ids {
            let path = format!("/me/groups/{}/usage/summary?{}", gid, usage_query);
            if let Ok(v) = fetch_json(&client, &path, key) {
                summaries.push(v);
            }
        }

        let user = normalize_user(&me);
        let plan = normalize_plan(&subscriptions, &active_groups, &me);
        let normalized_summaries: Vec<ProfileUsageSummary> = summaries
            .iter()
            .filter_map(|s| normalize_summary(s))
            .collect();
        let summary = merge_summaries(&normalized_summaries);
        let activity = merge_activity(
            summaries
                .iter()
                .flat_map(|s| normalize_activity(s).into_iter())
                .collect::<Vec<_>>()
                .as_slice(),
        );
        let active_days = activity.iter().filter(|d| d.count > 0).count() as u32;

        let me_empty = !is_record(&me);
        let groups_empty = array_from(&groups).is_empty();
        let subs_empty = array_from(&subscriptions).is_empty();
        let sums_empty = summaries.is_empty();
        if me_empty && groups_empty && subs_empty && sums_empty {
            return ProfileResult {
                status: ProfileStatus::Error,
                fetched_at: None,
                user: None,
                plan: None,
                summary: None,
                activity: None,
                active_days: None,
                error: Some(
                    "Não foi possível carregar dados reais do Verboo com a credencial atual.".into(),
                ),
            };
        }

        ProfileResult {
            status: ProfileStatus::Ready,
            fetched_at: Some(now.timestamp_millis()),
            user,
            plan,
            summary,
            activity: Some(activity),
            active_days: Some(active_days),
            error: None,
        }
    }
}

impl Default for ProfileService {
    fn default() -> Self {
        Self::new()
    }
}

fn fetch_json(client: &Client, path: &str, api_key: &str) -> Result<Value, String> {
    let url = format!("{API_BASE}{path}");
    let resp = client
        .get(&url)
        .bearer_auth(api_key)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json::<Value>().map_err(|e| e.to_string())
}

fn unwrap_data(value: &Value) -> Value {
    if let Some(obj) = value.as_object() {
        if let Some(d) = obj.get("data") {
            return d.clone();
        }
    }
    value.clone()
}

fn array_from(value: &Value) -> Vec<Value> {
    let unwrapped = unwrap_data(value);
    if let Some(arr) = unwrapped.as_array() {
        return arr
            .iter()
            .filter(|v| v.is_object())
            .cloned()
            .collect();
    }
    if let Some(obj) = unwrapped.as_object() {
        for key in ["items", "groups", "subscriptions", "memberships", "results"] {
            if let Some(nested) = obj.get(key) {
                if let Some(arr) = nested.as_array() {
                    return arr
                        .iter()
                        .filter(|v| v.is_object())
                        .cloned()
                        .collect();
                }
            }
        }
    }
    Vec::new()
}

fn first_record(value: &Value) -> Option<Value> {
    let unwrapped = unwrap_data(value);
    if unwrapped.is_object() {
        Some(unwrapped)
    } else {
        None
    }
}

fn normalize_user(value: &Value) -> Option<ProfileUser> {
    let record = first_record(value)?;
    let name = string_value(record.get("name"))
        .or_else(|| string_value(record.get("username")))
        .or_else(|| string_value(record.get("fullName")));
    Some(ProfileUser {
        id: string_value(record.get("id")),
        name,
        email: string_value(record.get("email")),
    })
}

fn normalize_plan(
    subscriptions: &Value,
    active_groups: &[Value],
    me: &Value,
) -> Option<ProfilePlan> {
    let subs_arr = array_from(subscriptions);
    let active_sub = subs_arr
        .iter()
        .find(|s| is_active_membership(s))
        .or_else(|| subs_arr.first());
    let group = active_groups.first();
    let user_record = first_record(me);
    let plan_record = active_sub
        .and_then(|s| first_record(&s.get("plan").cloned().unwrap_or(Value::Null)))
        .or_else(|| {
            active_sub.and_then(|s| first_record(&s.get("group").cloned().unwrap_or(Value::Null)))
        })
        .or_else(|| group.cloned())
        .or_else(|| user_record.clone());

    if plan_record.is_none() && active_sub.is_none() {
        return None;
    }

    let price_cents = active_sub
        .and_then(|s| number_value(s.get("priceCents")))
        .or_else(|| active_sub.and_then(|s| number_value(s.get("amountCents"))))
        .or_else(|| plan_record.as_ref().and_then(|p| number_value(p.get("priceCents"))))
        .or_else(|| plan_record.as_ref().and_then(|p| number_value(p.get("monthlyPriceCents"))));

    let models = normalize_model_names(vec![
        active_sub,
        plan_record.as_ref(),
        group,
    ]);

    Some(ProfilePlan {
        id: active_sub
            .and_then(|s| string_value(s.get("id")))
            .or_else(|| plan_record.as_ref().and_then(|p| string_value(p.get("id")))),
        name: active_sub
            .and_then(|s| string_value(s.get("planName")))
            .or_else(|| plan_record.as_ref().and_then(|p| string_value(p.get("name"))))
            .or_else(|| plan_record.as_ref().and_then(|p| string_value(p.get("title"))))
            .or_else(|| user_record.as_ref().and_then(|u| string_value(u.get("subscriptionType")))),
        status: active_sub
            .and_then(|s| string_value(s.get("status")))
            .or_else(|| group.and_then(|g| string_value(g.get("status")))),
        price_label: price_cents.map(format_brl_from_cents),
        models,
        concurrent_requests: active_sub
            .and_then(|s| s.get("group"))
            .and_then(|g| number_value(g.get("concurrentRequests")))
            .or_else(|| group.and_then(|g| number_value(g.get("concurrentRequests"))))
            .or_else(|| {
                plan_record
                    .as_ref()
                    .and_then(|p| number_value(p.get("concurrentRequests")))
            })
            .map(|n| n as u32),
    })
}

fn normalize_model_names(records: Vec<Option<&Value>>) -> Option<Vec<String>> {
    let mut names = std::collections::HashSet::new();
    for record in records.into_iter().flatten() {
        if !record.is_object() {
            continue;
        }
        for key in ["models", "modelIds", "modelNames", "allowedModels"] {
            if let Some(arr) = record.get(key).and_then(|v| v.as_array()) {
                for item in arr {
                    if let Some(s) = item.as_str() {
                        names.insert(s.to_string());
                    } else if item.is_object() {
                        let n = string_value(item.get("name"))
                            .or_else(|| string_value(item.get("id")))
                            .or_else(|| string_value(item.get("displayName")));
                        if let Some(n) = n {
                            names.insert(n);
                        }
                    }
                }
            }
        }
    }
    if names.is_empty() {
        None
    } else {
        Some(names.into_iter().collect())
    }
}

fn normalize_summary(value: &Value) -> Option<ProfileUsageSummary> {
    let record = first_record(value)?;
    let total = record
        .get("total")
        .and_then(|v| first_record(v))
        .unwrap_or_else(|| record.clone());
    let tokens_in_total = number_value(total.get("tokensInTotal"))
        .or_else(|| number_value(total.get("tokensIn")))
        .or_else(|| number_value(total.get("inputTokens")))
        .or_else(|| number_value(total.get("input_tokens")));
    let tokens_out_total = number_value(total.get("tokensOutTotal"))
        .or_else(|| number_value(total.get("tokensOut")))
        .or_else(|| number_value(total.get("outputTokens")))
        .or_else(|| number_value(total.get("output_tokens")));
    // Issue #93: o `totalTokens` cru da API pode replicar o input (Total =
    // Input, Output ignorado). Com input e output conhecidos, o total é a
    // soma das partes; o campo cru só vale quando falta o breakdown.
    let total_tokens = if tokens_in_total.is_some() && tokens_out_total.is_some() {
        Some(tokens_in_total.unwrap_or(0) + tokens_out_total.unwrap_or(0))
    } else {
        number_value(total.get("totalTokens"))
            .or_else(|| number_value(total.get("tokensTotal")))
            .or_else(|| number_value(total.get("tokens")))
            .or_else(|| {
                if tokens_in_total.is_some() || tokens_out_total.is_some() {
                    Some(tokens_in_total.unwrap_or(0) + tokens_out_total.unwrap_or(0))
                } else {
                    None
                }
            })
    };
    let req_total = number_value(total.get("reqTotal"))
        .or_else(|| number_value(total.get("requests")))
        .or_else(|| number_value(total.get("requestCount")))
        .or_else(|| number_value(total.get("totalRequests")));

    if tokens_in_total.is_none()
        && tokens_out_total.is_none()
        && total_tokens.is_none()
        && req_total.is_none()
    {
        return None;
    }

    Some(ProfileUsageSummary {
        tokens_in_total,
        tokens_out_total,
        total_tokens,
        req_total,
    })
}

fn merge_summaries(summaries: &[ProfileUsageSummary]) -> Option<ProfileUsageSummary> {
    if summaries.is_empty() {
        return None;
    }
    Some(ProfileUsageSummary {
        tokens_in_total: sum_defined(summaries.iter().map(|s| s.tokens_in_total)),
        tokens_out_total: sum_defined(summaries.iter().map(|s| s.tokens_out_total)),
        total_tokens: sum_defined(summaries.iter().map(|s| s.total_tokens)),
        req_total: sum_defined(summaries.iter().map(|s| s.req_total)),
    })
}

fn normalize_activity(value: &Value) -> Vec<ProfileActivityDay> {
    let record = first_record(value);
    let buckets: Vec<Value> = if let Some(arr) = value.as_array() {
        arr.clone()
    } else if let Some(rec) = record.as_ref() {
        if let Some(arr) = rec.get("buckets").and_then(|v| v.as_array()) {
            arr.clone()
        } else if let Some(arr) = rec.get("days").and_then(|v| v.as_array()) {
            arr.clone()
        } else if let Some(arr) = rec.get("series").and_then(|v| v.as_array()) {
            arr.clone()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    buckets
        .iter()
        .filter_map(|bucket| {
            if !bucket.is_object() {
                return None;
            }
            let date = string_value(bucket.get("date"))
                .or_else(|| string_value(bucket.get("day")))
                .or_else(|| string_value(bucket.get("bucket")))?;
            let count = number_value(bucket.get("count"))
                .or_else(|| number_value(bucket.get("reqTotal")))
                .or_else(|| number_value(bucket.get("requests")))
                .or_else(|| number_value(bucket.get("requestCount")))?;
            let date = if date.len() >= 10 { date[..10].to_string() } else { date };
            Some(ProfileActivityDay { date, count: count as u32 })
        })
        .collect()
}

fn merge_activity(days: &[ProfileActivityDay]) -> Vec<ProfileActivityDay> {
    let mut merged: std::collections::BTreeMap<String, u32> = std::collections::BTreeMap::new();
    for day in days {
        *merged.entry(day.date.clone()).or_insert(0) += day.count;
    }
    merged
        .into_iter()
        .map(|(date, count)| ProfileActivityDay { date, count })
        .collect()
}

fn is_active_membership(record: &Value) -> bool {
    let Some(status) = string_value(record.get("status")) else {
        return true;
    };
    matches!(
        status.as_str(),
        "active" | "trialing" | "past_due" | "unpaid" | "incomplete"
    )
}

fn sum_defined<'a, I: Iterator<Item = Option<u64>>>(iter: I) -> Option<u64> {
    let mut total: u64 = 0;
    let mut any = false;
    for v in iter {
        if let Some(n) = v {
            total += n;
            any = true;
        }
    }
    if any {
        Some(total)
    } else {
        None
    }
}

fn number_value(value: Option<&Value>) -> Option<u64> {
    let v = value?;
    if let Some(n) = v.as_u64() {
        return Some(n);
    }
    if let Some(n) = v.as_i64() {
        if n >= 0 {
            return Some(n as u64);
        }
    }
    if let Some(f) = v.as_f64() {
        if f.is_finite() && f >= 0.0 {
            return Some(f as u64);
        }
    }
    if let Some(s) = v.as_str() {
        if let Ok(n) = s.parse::<u64>() {
            return Some(n);
        }
    }
    None
}

fn string_value(value: Option<&Value>) -> Option<String> {
    let v = value?;
    let s = v.as_str()?;
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn is_record(value: &Value) -> bool {
    value.is_object()
}

fn format_brl_from_cents(cents: u64) -> String {
    // pt-BR currency format: R$ X.XXX,XX
    let reais = cents / 100;
    let centavos = cents % 100;
    let reais_str = reais
        .to_string()
        .as_bytes()
        .rchunks(3)
        .rev()
        .map(std::str::from_utf8)
        .collect::<Result<Vec<&str>, _>>()
        .unwrap_or_default()
        .join(".");
    format!("R$ {reais_str},{centavos:02}")
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.as_bytes() {
        let c = *byte as char;
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '~' {
            out.push(c);
        } else if c == ' ' {
            out.push_str("%20");
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn no_api_key_returns_unauthenticated() {
        let svc = ProfileService::new();
        let result = svc.get_profile(None);
        assert_eq!(result.status, ProfileStatus::Unauthenticated);
        assert!(result.error.is_some());
    }

    #[test]
    fn empty_api_key_returns_unauthenticated() {
        let svc = ProfileService::new();
        let result = svc.get_profile(Some("   "));
        assert_eq!(result.status, ProfileStatus::Unauthenticated);
    }

    #[test]
    fn normalize_user_extracts_fields() {
        let me = json!({
            "id": "u_123",
            "name": "Gabriel",
            "email": "gabriel@example.com"
        });
        let user = normalize_user(&me).unwrap();
        assert_eq!(user.id.as_deref(), Some("u_123"));
        assert_eq!(user.name.as_deref(), Some("Gabriel"));
        assert_eq!(user.email.as_deref(), Some("gabriel@example.com"));
    }

    #[test]
    fn normalize_user_falls_back_to_username() {
        let me = json!({"username": "graseeel"});
        let user = normalize_user(&me).unwrap();
        assert_eq!(user.name.as_deref(), Some("graseeel"));
    }

    #[test]
    fn normalize_user_returns_none_for_non_object() {
        let me = json!("string");
        assert!(normalize_user(&me).is_none());
    }

    #[test]
    fn array_from_extracts_items_key() {
        let v = json!({"items": [{"id": 1}, {"id": 2}]});
        let arr = array_from(&v);
        assert_eq!(arr.len(), 2);
    }

    #[test]
    fn array_from_extracts_data_array() {
        let v = json!({"data": [{"id": 1}]});
        let arr = array_from(&v);
        assert_eq!(arr.len(), 1);
    }

    #[test]
    fn array_from_returns_empty_for_non_array() {
        let v = json!({"foo": "bar"});
        assert!(array_from(&v).is_empty());
    }

    #[test]
    fn is_active_membership_recognizes_active_states() {
        for s in ["active", "trialing", "past_due", "unpaid", "incomplete"] {
            let v = json!({"status": s});
            assert!(is_active_membership(&v));
        }
    }

    #[test]
    fn is_active_membership_returns_true_when_no_status() {
        let v = json!({"id": "g_1"});
        assert!(is_active_membership(&v));
    }

    #[test]
    fn is_active_membership_returns_false_for_canceled() {
        let v = json!({"status": "canceled"});
        assert!(!is_active_membership(&v));
    }

    #[test]
    fn number_value_handles_u64_i64_f64_string() {
        assert_eq!(number_value(Some(&json!(42))), Some(42));
        assert_eq!(number_value(Some(&json!(-1))), None);
        assert_eq!(number_value(Some(&json!(3.14))), Some(3));
        assert_eq!(number_value(Some(&json!("100"))), Some(100));
        assert_eq!(number_value(Some(&json!("not a number"))), None);
        assert_eq!(number_value(None), None);
    }

    #[test]
    fn string_value_trims_and_rejects_empty() {
        assert_eq!(string_value(Some(&json!("  hello  "))), Some("hello".into()));
        assert_eq!(string_value(Some(&json!("   "))), None);
        assert_eq!(string_value(Some(&json!(42))), None);
        assert_eq!(string_value(None), None);
    }

    #[test]
    fn merge_activity_sums_same_date() {
        let days = vec![
            ProfileActivityDay { date: "2026-07-01".into(), count: 5 },
            ProfileActivityDay { date: "2026-07-01".into(), count: 3 },
            ProfileActivityDay { date: "2026-07-02".into(), count: 2 },
        ];
        let merged = merge_activity(&days);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].date, "2026-07-01");
        assert_eq!(merged[0].count, 8);
        assert_eq!(merged[1].date, "2026-07-02");
        assert_eq!(merged[1].count, 2);
    }

    #[test]
    fn normalize_summary_extracts_fields() {
        let v = json!({
            "total": {
                "tokensInTotal": 1000,
                "tokensOutTotal": 2000,
                "totalTokens": 3000,
                "reqTotal": 50
            }
        });
        let s = normalize_summary(&v).unwrap();
        assert_eq!(s.tokens_in_total, Some(1000));
        assert_eq!(s.tokens_out_total, Some(2000));
        assert_eq!(s.total_tokens, Some(3000));
        assert_eq!(s.req_total, Some(50));
    }

    #[test]
    fn normalize_summary_total_is_in_plus_out_when_both_present() {
        // Issue #93: a API da conta pode devolver `totalTokens` replicando o
        // input (Total 4.9B = Input 4.9B, Output 26.4M ignorado). Quando
        // input e output são conhecidos, o total exibido deve ser a soma.
        let v = json!({
            "total": {
                "tokensInTotal": 100,
                "tokensOutTotal": 7,
                "totalTokens": 100,
                "reqTotal": 3
            }
        });
        let s = normalize_summary(&v).unwrap();
        assert_eq!(s.tokens_in_total, Some(100));
        assert_eq!(s.tokens_out_total, Some(7));
        assert_eq!(s.total_tokens, Some(107));
    }

    #[test]
    fn normalize_summary_falls_back_to_raw_total_without_breakdown() {
        // Payload sem breakdown: o campo cru continua sendo a fonte do total.
        let v = json!({"total": {"totalTokens": 3000, "reqTotal": 9}});
        let s = normalize_summary(&v).unwrap();
        assert_eq!(s.tokens_in_total, None);
        assert_eq!(s.tokens_out_total, None);
        assert_eq!(s.total_tokens, Some(3000));
        assert_eq!(s.req_total, Some(9));
    }

    #[test]
    fn normalize_summary_unilateral_input_sums_with_missing_output() {
        // Só input conhecido, sem totalTokens cru: total = input + 0.
        let v = json!({"total": {"tokensInTotal": 100}});
        let s = normalize_summary(&v).unwrap();
        assert_eq!(s.tokens_in_total, Some(100));
        assert_eq!(s.tokens_out_total, None);
        assert_eq!(s.total_tokens, Some(100));
    }

    #[test]
    fn normalize_summary_returns_none_when_all_missing() {
        let v = json!({"total": {}});
        assert!(normalize_summary(&v).is_none());
    }

    #[test]
    fn merge_summaries_sums_defined_only() {
        let summaries = vec![
            ProfileUsageSummary {
                tokens_in_total: Some(100),
                tokens_out_total: None,
                total_tokens: Some(100),
                req_total: Some(5),
            },
            ProfileUsageSummary {
                tokens_in_total: Some(200),
                tokens_out_total: Some(50),
                total_tokens: Some(250),
                req_total: None,
            },
        ];
        let merged = merge_summaries(&summaries).unwrap();
        assert_eq!(merged.tokens_in_total, Some(300));
        assert_eq!(merged.tokens_out_total, Some(50));
        assert_eq!(merged.total_tokens, Some(350));
        assert_eq!(merged.req_total, Some(5));
    }

    #[test]
    fn merge_summaries_returns_none_for_empty() {
        assert!(merge_summaries(&[]).is_none());
    }

    #[test]
    fn format_brl_from_cents_formats_correctly() {
        assert_eq!(format_brl_from_cents(0), "R$ 0,00");
        assert_eq!(format_brl_from_cents(99), "R$ 0,99");
        assert_eq!(format_brl_from_cents(100), "R$ 1,00");
        assert_eq!(format_brl_from_cents(123456), "R$ 1.234,56");
    }

    #[test]
    fn urlencode_encodes_special_chars() {
        assert_eq!(urlencode("hello world"), "hello%20world");
        assert_eq!(urlencode("a+b=c"), "a%2Bb%3Dc");
        assert_eq!(urlencode("2026-07-01T00:00:00Z"), "2026-07-01T00%3A00%3A00Z");
    }

    #[test]
    fn normalize_activity_extracts_buckets() {
        let v = json!({
            "buckets": [
                {"date": "2026-07-01", "count": 5},
                {"date": "2026-07-02", "count": 3}
            ]
        });
        let days = normalize_activity(&v);
        assert_eq!(days.len(), 2);
        assert_eq!(days[0].date, "2026-07-01");
        assert_eq!(days[0].count, 5);
    }

    #[test]
    fn normalize_activity_truncates_date_to_10_chars() {
        let v = json!({
            "buckets": [{"date": "2026-07-01T12:00:00Z", "count": 1}]
        });
        let days = normalize_activity(&v);
        assert_eq!(days[0].date, "2026-07-01");
    }
}
