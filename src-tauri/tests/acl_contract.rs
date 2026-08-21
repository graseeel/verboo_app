#[test]
fn generated_capability_allows_tauri_drag_double_click_maximize() {
    let mut context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let allowed = context.runtime_authority_mut().resolve_access(
        "plugin:window|internal_toggle_maximize",
        "main",
        "main",
        &tauri::ipc::Origin::Local,
    );
    assert!(
        allowed.is_some(),
        "the generated ACL must allow the Tauri drag-region double-click command"
    );
}
