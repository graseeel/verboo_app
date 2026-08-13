//! FRENTE-A (2026-08-02) — CANARY against a specific silent failure mode:
//! the bundled Chrome extension renames or removes one of its browser
//! tools, and `activity_for_tool`'s chrome arm silently stops matching, so
//! the transcript step degrades to the generic "Usou o Chrome" fallback
//! (or worse, the generic "Usou ferramenta" tool arm) with no error and a
//! still-GREEN suite — our fixtures test OUR copy of the truth, not the
//! extension's reality. Discovery only happens when the user notices the
//! step lost its name. Falha silenciosa é o pior tipo.
//!
//! A producer-side rename can silently degrade the consumer. The golden-anchor
//! discipline ("test EXISTENCE vs test HOLDING", 2026-07-31) applies: the
//! contrafactual mutations are documented in the FRENTE-A order.
//!
//! ──────────────────────────────────────────────────────────────────────
//! METHOD (read the artifact, not our copy of the truth)
//! ──────────────────────────────────────────────────────────────────────
//! This canary reads the REAL extension manifest at
//! `extensions/verboo-chrome/src/controller/browserTools.json` and asserts
//! in BOTH directions:
//!   1. every tool declared in the manifest has a SPECIFIC activity arm
//!      (its label must differ from the generic fallback — kind "browser"
//!      alone is not enough, because the fallback also returns it);
//!   2. every specific chrome arm in `CHROME_BROWSER_TOOLS` matches a tool
//!      that exists in the manifest.
//!
//! browserTools.json is CHECKED IN — a missing manifest here IS the defect,
//! so we fail loudly.
//! See .gitignore: only `extensions/verboo-chrome/dist/` and
//! `store-assets/*.zip` are ignored; `src/` is tracked.

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use serde_json::Value;

    use crate::services::turn_service::{
        activity_for_tool, CHROME_BROWSER_TOOLS, CHROME_FALLBACK_LABEL, CHROME_MCP_PREFIX,
    };

    /// The extension manifest lives one level above the crate root
    /// (`src-tauri/` is CARGO_MANIFEST_DIR).
    fn manifest_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../extensions/verboo-chrome/src/controller/browserTools.json")
    }

    fn manifest_tool_names() -> Vec<String> {
        let raw = fs::read_to_string(manifest_path())
            .unwrap_or_else(|e| panic!("browserTools.json missing: {e}"));
        let json: Value = serde_json::from_str(&raw).expect("browserTools.json must be valid JSON");
        json["tools"]
            .as_array()
            .expect("browserTools.json must have a `tools` array")
            .iter()
            .filter_map(|t| t["name"].as_str().map(String::from))
            .collect()
    }

    #[test]
    fn every_manifest_tool_has_a_specific_activity_arm() {
        let names = manifest_tool_names();
        for name in &names {
            let full = format!("{CHROME_MCP_PREFIX}{name}");
            let (label, kind) = activity_for_tool(&full);
            assert_eq!(
                kind, "browser",
                "manifest tool `{name}` must map to kind browser"
            );
            assert_ne!(
                label,
                CHROME_FALLBACK_LABEL,
                "manifest tool `{name}` hit the GENERIC fallback — its specific arm \
                 was renamed or removed on the Rust side, and the transcript step \
                 would silently degrade to \"{label}\""
            );
        }
    }

    #[test]
    fn every_chrome_activity_arm_matches_a_manifest_tool() {
        let names = manifest_tool_names();
        for (name, label) in CHROME_BROWSER_TOOLS {
            assert!(
                names.iter().any(|n| n == name),
                "activity arm `{name}` ({label}) has no matching tool in browserTools.json — \
                 the extension renamed or removed it and the arm is dead code"
            );
        }
    }
}
