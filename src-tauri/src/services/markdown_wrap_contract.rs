//! Regression contract for the markdown wrap fix (2026-07-07).
//!
//! Symptom being prevented: long unbreakable tokens (URLs, inline `<code>`,
//! commit hashes, base64 blobs) inside assistant messages used to be silently
//! clipped at the right edge of `.message-row` because:
//!
//!   1. `.message-row` has `overflow: hidden` (required for `border-radius`
//!      and `content-visibility: auto`).
//!   2. `.message-row.assistant` used `display: grid` with the implicit
//!      default `min-width: auto` on its tracks — so a long child grew the
//!      track past the row's width and got clipped.
//!   3. `.step-text` (StepFlow intermediate text) had only
//!      `white-space: pre-wrap` and no `overflow-wrap`, so it had no way to
//!      break long tokens even if the track had been constrained.
//!   4. `.markdown-body` had `word-break: break-word` but not
//!      `overflow-wrap: anywhere` (the stronger, more reliable property)
//!      and no `min-width: 0`.
//!
//! These tests parse the renderer CSS files as strings and assert that the
//! three load-bearing rules are still present. They are NOT a substitute for
//! visual verification — they are a tripwire that fails the build if a
//! future refactor removes the wrap contract by accident.
//!
//! If a test fails: do NOT weaken the assertion. Re-add the missing CSS rule
//! or update the assertion to match the new (still-correct) rule, with a
//! comment explaining why the new form still prevents the silent-clip bug.

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    /// Returns the path to a renderer CSS file, walking up from
    /// `CARGO_MANIFEST_DIR` to find `src/renderer/styles/<name>`. Works in
    /// both `cargo test` (manifest dir is `src-tauri/`) and
    /// `cargo tauri build` (same).
    fn css_path(name: &str) -> PathBuf {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        // src-tauri/Cargo.toml → ../src/renderer/styles/<name>
        let path = manifest_dir
            .parent()
            .expect("src-tauri should have a parent dir")
            .join("src")
            .join("renderer")
            .join("styles")
            .join(name);
        assert!(
            path.exists(),
            "CSS file not found at {}. Run tests from the repo root.",
            path.display()
        );
        path
    }

    fn read_css(name: &str) -> String {
        let path = css_path(name);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()))
    }

    /// Returns the substring containing the first CSS rule whose selector
    /// contains `selector_fragment`. Selects the rule block from the start of
    /// the selector match to the first `}` that closes it (does not descend
    /// into nested rules — CSS doesn't have nested rules pre-native-nesting,
    /// so this is sufficient for our flat stylesheets).
    fn first_rule_block(css: &str, selector_fragment: &str) -> String {
        let start = css.find(selector_fragment).unwrap_or_else(|| {
            panic!("selector fragment {:?} not found in CSS", selector_fragment)
        });
        let close = css[start..].find('}').unwrap_or_else(|| {
            panic!(
                "rule starting with {:?} has no closing brace",
                selector_fragment
            )
        });
        css[start..start + close + 1].to_string()
    }

    /// `.step-text` must keep `overflow-wrap: anywhere` and `min-width: 0`
    /// so StepFlow intermediate text wraps instead of being clipped by the
    /// parent `.message-row { overflow: hidden }`.
    #[test]
    fn step_text_wraps_long_tokens() {
        let css = read_css("flow.css");
        let block = first_rule_block(&css, ".step-text");

        assert!(
            block.contains("overflow-wrap: anywhere"),
            "`.step-text` lost `overflow-wrap: anywhere` — long tokens will be clipped again. \
             See markdown_wrap_contract.rs for context."
        );
        assert!(
            block.contains("min-width: 0"),
            "`.step-text` lost `min-width: 0` — grid track will grow past the row and clip. \
             See markdown_wrap_contract.rs for context."
        );
        assert!(
            block.contains("white-space: pre-wrap"),
            "`.step-text` lost `white-space: pre-wrap` — model newlines/indentation will collapse."
        );
    }

    /// `.message-row.assistant` must constrain its grid track with
    /// `grid-template-columns: minmax(0, 1fr)` (or equivalent) so children
    /// can shrink below intrinsic content width. Without this, descendant
    /// `overflow-wrap` rules have no effect.
    #[test]
    fn assistant_row_constrains_grid_track() {
        let css = read_css("surfaces.css");
        let block = first_rule_block(&css, ".message-row.assistant");

        assert!(
            block.contains("minmax(0, 1fr)"),
            "`.message-row.assistant` lost `grid-template-columns: minmax(0, 1fr)` — \
             grid tracks default to `min-width: auto` and long tokens clip silently."
        );
    }

    /// `.markdown-body` must keep `overflow-wrap: anywhere` (stronger than
    /// `word-break: break-word` alone) and `min-width: 0` so react-markdown
    /// output wraps inside the grid track.
    #[test]
    fn markdown_body_wraps_long_tokens() {
        let css = read_css("markdown.css");
        let block = first_rule_block(&css, ".markdown-body");

        assert!(
            block.contains("overflow-wrap: anywhere"),
            "`.markdown-body` lost `overflow-wrap: anywhere` — long inline `<code>` and URLs \
             will be clipped by `.message-row` (which has `overflow: hidden`)."
        );
        assert!(
            block.contains("min-width: 0"),
            "`.markdown-body` lost `min-width: 0` — flex/grid item won't shrink below content width."
        );
        assert!(
            block.contains("word-break: break-word"),
            "`.markdown-body` lost `word-break: break-word` — keep as belt-and-braces with overflow-wrap."
        );
    }
}
