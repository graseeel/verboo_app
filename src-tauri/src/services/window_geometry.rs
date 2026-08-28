//! Window size vs monitor work area (issue #100).
//!
//! Restoring from maximized reused `tauri.conf.json`'s default inner size
//! (1280×840). On an 800px-tall display that is taller than the work area,
//! so the sidebar footer falls off-screen and the bottom/right edges sit
//! on or past the screen boundary (not grabbable). Clamp to the monitor
//! *work area* (excludes taskbar/panel), not the full resolution.

const MIN_WIDTH_LOGICAL: u32 = 960;
const MIN_HEIGHT_LOGICAL: u32 = 640;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PxSize {
    pub width: u32,
    pub height: u32,
}

/// Inner size to apply so the *outer* frame fits `work_area`.
///
/// `decoration` is `outer - inner` (titlebar/borders). `min` is the
/// configured minimum inner size; when the work area is smaller than
/// `min`, the work area wins in the pure clamp; the OS min-size may
/// still impose the configured minimum.
///
/// A zero work-area axis means "unknown monitor" — that axis is left
/// unchanged rather than collapsing the window.
pub fn clamp_window_inner_size(
    desired: PxSize,
    work_area: PxSize,
    min: PxSize,
    decoration: PxSize,
) -> PxSize {
    PxSize {
        width: clamp_axis(desired.width, work_area.width, min.width, decoration.width),
        height: clamp_axis(
            desired.height,
            work_area.height,
            min.height,
            decoration.height,
        ),
    }
}

fn clamp_axis(desired: u32, work: u32, min: u32, deco: u32) -> u32 {
    if work == 0 {
        return desired;
    }
    let max = work.saturating_sub(deco).max(1).min(work);
    let floor = min.min(max);
    desired.clamp(floor, max)
}

/// Cap the current inner size to the monitor work area.
///
/// Call from setup (create-time `preventOverflow` is the other half).
/// Do not hook `WindowEvent::Resized`: maximize delivers a large size
/// before `is_maximized()` is true, and clamping would undo the zoom.
pub fn clamp_main_window_to_work_area(window: &tauri::WebviewWindow) {
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return;
    }
    let Ok(inner) = window.inner_size() else {
        return;
    };
    let Ok(outer) = window.outer_size() else {
        return;
    };
    let monitor = match window.current_monitor() {
        Ok(Some(monitor)) => monitor,
        _ => match window.primary_monitor() {
            Ok(Some(monitor)) => monitor,
            _ => return,
        },
    };
    let work = monitor.work_area().size;
    let scale = window.scale_factor().unwrap_or(1.0);
    let applied = clamp_window_inner_size(
        PxSize {
            width: inner.width,
            height: inner.height,
        },
        PxSize {
            width: work.width,
            height: work.height,
        },
        PxSize {
            width: (MIN_WIDTH_LOGICAL as f64 * scale).round() as u32,
            height: (MIN_HEIGHT_LOGICAL as f64 * scale).round() as u32,
        },
        PxSize {
            width: outer.width.saturating_sub(inner.width),
            height: outer.height.saturating_sub(inner.height),
        },
    );
    if applied.width == inner.width && applied.height == inner.height {
        return;
    }
    let _ = window.set_size(tauri::PhysicalSize::new(applied.width, applied.height));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn size(width: u32, height: u32) -> PxSize {
        PxSize { width, height }
    }

    #[test]
    fn issue100_default_overflows_800px_work_area() {
        let applied = clamp_window_inner_size(
            size(1280, 840),
            size(1280, 800),
            size(MIN_WIDTH_LOGICAL, MIN_HEIGHT_LOGICAL),
            size(0, 0),
        );
        assert_eq!(applied, size(1280, 800));
    }

    #[test]
    fn decoration_is_subtracted_so_outer_fits_work_area() {
        let applied = clamp_window_inner_size(
            size(1280, 840),
            size(1280, 800),
            size(MIN_WIDTH_LOGICAL, MIN_HEIGHT_LOGICAL),
            size(0, 40),
        );
        assert_eq!(applied, size(1280, 760));
    }

    #[test]
    fn size_that_already_fits_is_unchanged() {
        let applied = clamp_window_inner_size(
            size(1280, 840),
            size(1920, 1080),
            size(MIN_WIDTH_LOGICAL, MIN_HEIGHT_LOGICAL),
            size(0, 30),
        );
        assert_eq!(applied, size(1280, 840));
    }

    #[test]
    fn work_area_wins_when_smaller_than_min() {
        let applied = clamp_window_inner_size(
            size(1280, 840),
            size(800, 600),
            size(MIN_WIDTH_LOGICAL, MIN_HEIGHT_LOGICAL),
            size(0, 0),
        );
        assert_eq!(applied, size(800, 600));
    }

    #[test]
    fn below_min_on_a_large_work_area_is_raised_to_min() {
        let applied = clamp_window_inner_size(
            size(800, 500),
            size(1920, 1080),
            size(MIN_WIDTH_LOGICAL, MIN_HEIGHT_LOGICAL),
            size(0, 0),
        );
        assert_eq!(applied, size(960, 640));
    }

    #[test]
    fn unknown_work_area_leaves_desired_size() {
        let applied = clamp_window_inner_size(
            size(1280, 840),
            size(0, 0),
            size(MIN_WIDTH_LOGICAL, MIN_HEIGHT_LOGICAL),
            size(0, 40),
        );
        assert_eq!(applied, size(1280, 840));
    }

    #[test]
    fn min_constants_match_tauri_conf() {
        let conf = include_str!("../../tauri.conf.json");
        assert!(
            conf.contains("\"minWidth\": 960"),
            "MIN_WIDTH_LOGICAL must match tauri.conf.json"
        );
        assert!(
            conf.contains("\"minHeight\": 640"),
            "MIN_HEIGHT_LOGICAL must match tauri.conf.json"
        );
        assert!(
            conf.contains("\"preventOverflow\": true"),
            "create-time clamp must use the monitor work area, not full resolution"
        );
    }

    #[test]
    fn setup_clamps_main_window_to_work_area() {
        let source = include_str!("../lib.rs").replace("\r\n", "\n");
        let setup_start = source.find(".setup(|app|").expect("setup callback");
        let invoke_start = source
            .find(".invoke_handler(tauri::generate_handler!")
            .expect("invoke handler");
        let setup = &source[setup_start..invoke_start];
        assert!(
            setup.contains("clamp_main_window_to_work_area"),
            "setup must clamp the restored/default size to the monitor work area"
        );
    }
}
