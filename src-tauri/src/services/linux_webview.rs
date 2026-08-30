//! Linux WebKitGTK black-screen mitigation (refs modrinth/code#3057, #3062).
//!
//! WebKitGTK's DMABUF renderer fails on some Linux setups — NVIDIA GPUs and/or
//! the libraries bundled inside the AppImage — producing a black window
//! (EGL_BAD_PARAMETER). The standard workaround is to set
//! `WEBKIT_DISABLE_DMABUF_RENDERER=1` BEFORE any webview is created.
//!
//! This module applies that workaround on Linux only, and only when the user
//! has not already set the variable themselves (their override always wins).
//! Nothing here is owner-hardcoded: AppImage detection reads the `APPIMAGE`
//! env var; NVIDIA detection reads `/proc/driver/nvidia` or the DRM vendor id
//! (`/sys/class/drm/*/device/vendor` == `0x10de`).

/// Pure: decides whether the DMABUF workaround should be applied.
///
/// - `user_override`: the current value of `WEBKIT_DISABLE_DMABUF_RENDERER`
///   (`None` = unset). If the user set it, we never touch it.
/// - `appimage`: running from an AppImage (`APPIMAGE` env var present).
/// - `nvidia`: an NVIDIA GPU was detected.
///
/// Kept free of `#[cfg]` so every combination is unit-testable on any host.
pub fn decide_disable_dmabuf(appimage: bool, nvidia: bool, user_override: Option<&str>) -> bool {
    if user_override.is_some() {
        return false;
    }
    appimage || nvidia
}

/// Linux-only: applies the workaround before any webview is created. Reads
/// the environment, detects the triggers, and — when the decision is to apply
/// — sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` and logs a clear English line
/// with the reason. No-op on other platforms (never compiled there).
#[cfg(target_os = "linux")]
pub fn apply_webkit_dmabuf_workaround() {
    let user_override = std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").ok();
    let appimage = std::env::var_os("APPIMAGE").is_some();
    let nvidia = nvidia_gpu_detected();
    if !decide_disable_dmabuf(appimage, nvidia, user_override.as_deref()) {
        return;
    }
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    let mut reasons = Vec::new();
    if appimage {
        reasons.push("appimage");
    }
    if nvidia {
        reasons.push("nvidia");
    }
    eprintln!(
        "[verboo] WEBKIT_DISABLE_DMABUF_RENDERER=1 (Linux black-screen workaround; reason: {})",
        reasons.join("+")
    );
}

/// Detects an NVIDIA GPU: `/proc/driver/nvidia` exists, or a DRM device
/// vendor id is `0x10de` (NVIDIA's PCI vendor id).
#[cfg(target_os = "linux")]
fn nvidia_gpu_detected() -> bool {
    if std::path::Path::new("/proc/driver/nvidia").exists() {
        return true;
    }
    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else {
        return false;
    };
    for entry in entries.flatten() {
        let vendor_path = entry.path().join("device").join("vendor");
        if let Ok(vendor) = std::fs::read_to_string(&vendor_path) {
            if vendor.trim().eq_ignore_ascii_case("0x10de") {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A user-set variable always wins: we never touch it, regardless of the
    /// AppImage/NVIDIA triggers.
    #[test]
    fn user_override_always_wins() {
        for appimage in [false, true] {
            for nvidia in [false, true] {
                assert!(
                    !decide_disable_dmabuf(appimage, nvidia, Some("0")),
                    "override Some must never be overridden (appimage={appimage}, nvidia={nvidia})"
                );
                assert!(
                    !decide_disable_dmabuf(appimage, nvidia, Some("1")),
                    "override Some must never be overridden (appimage={appimage}, nvidia={nvidia})"
                );
            }
        }
    }

    /// No override + no trigger: nothing to do.
    #[test]
    fn no_override_no_trigger_does_nothing() {
        assert!(!decide_disable_dmabuf(false, false, None));
    }

    /// No override + AppImage: apply.
    #[test]
    fn appimage_alone_triggers() {
        assert!(decide_disable_dmabuf(true, false, None));
    }

    /// No override + NVIDIA: apply.
    #[test]
    fn nvidia_alone_triggers() {
        assert!(decide_disable_dmabuf(false, true, None));
    }

    /// No override + both triggers: apply.
    #[test]
    fn both_triggers_apply() {
        assert!(decide_disable_dmabuf(true, true, None));
    }
}
