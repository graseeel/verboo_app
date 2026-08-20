//! Android emulator input command builders (PA-26).

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::Emitter;

use super::session::{
    emit_error, AndroidEmulatorPoint, AndroidEmulatorPresenceEvent, AndroidSession, PRESENCE_EVENT,
};
use super::AndroidEmulatorService;

const INPUT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_adb_input_text_maps_spaces_and_shell_metacharacters() {
        assert_eq!(
            escape_adb_input_text("a b\"c'd;&é🦀").unwrap(),
            "a%sb\\\"c\\'d\\;\\&é🦀"
        );
    }

    #[test]
    fn escape_adb_input_text_rejects_control_injection() {
        let error = escape_adb_input_text("safe\nnext").unwrap_err();
        assert!(error.contains("control"), "unexpected error: {error}");
    }

    #[test]
    fn normalized_coordinates_and_swipe_args_are_pixel_safe() {
        assert_eq!(normalized_to_pixel(0.5, 1080).unwrap(), 540);
        assert_eq!(normalized_to_pixel(1.0, 1080).unwrap(), 1079);
        assert!(normalized_to_pixel(1.1, 1080).is_err());
        assert_eq!(
            build_swipe_args("emulator-5554", (10, 20), (300, 400), 180),
            vec![
                "-s",
                "emulator-5554",
                "shell",
                "input",
                "swipe",
                "10",
                "20",
                "300",
                "400",
                "180",
            ]
        );
    }

    #[test]
    fn adb_input_builders_keep_untrusted_text_as_one_argument() {
        assert_eq!(
            build_tap_args("emulator-5554", 540, 1199),
            vec![
                "-s",
                "emulator-5554",
                "shell",
                "input",
                "tap",
                "540",
                "1199"
            ]
        );
        assert_eq!(
            build_text_args("emulator-5554", "a b\"c").unwrap(),
            vec!["-s", "emulator-5554", "shell", "input", "text", "a%sb\\\"c",]
        );
        assert_eq!(
            build_keyevent_args("emulator-5554", 66),
            vec!["-s", "emulator-5554", "shell", "input", "keyevent", "66"]
        );
    }
}

pub(crate) fn escape_adb_input_text(text: &str) -> Result<String, String> {
    const SHELL_METACHARACTERS: &[char] = &[
        '\\', '"', '\'', ';', '&', '|', '<', '>', '(', ')', '$', '`', '*', '?', '#', '!', '~', '%',
        '[', ']', '{', '}', '^',
    ];

    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        if character.is_control() {
            return Err("input text cannot contain control characters".to_string());
        }
        if character == ' ' {
            escaped.push_str("%s");
        } else {
            if SHELL_METACHARACTERS.contains(&character) {
                escaped.push('\\');
            }
            escaped.push(character);
        }
    }
    Ok(escaped)
}

pub(crate) fn normalized_to_pixel(value: f64, extent: u32) -> Result<u32, String> {
    if !value.is_finite() || !(0.0..=1.0).contains(&value) || extent == 0 {
        return Err("simulator coordinates must be normalized between 0 and 1".to_string());
    }
    let last_pixel = extent.saturating_sub(1);
    Ok((value * f64::from(last_pixel)).round() as u32)
}

pub(crate) fn build_swipe_args(
    serial: &str,
    from: (u32, u32),
    to: (u32, u32),
    duration_ms: u64,
) -> Vec<String> {
    vec![
        "-s".to_string(),
        serial.to_string(),
        "shell".to_string(),
        "input".to_string(),
        "swipe".to_string(),
        from.0.to_string(),
        from.1.to_string(),
        to.0.to_string(),
        to.1.to_string(),
        duration_ms.to_string(),
    ]
}

pub(crate) fn build_tap_args(serial: &str, x: u32, y: u32) -> Vec<String> {
    vec![
        "-s".to_string(),
        serial.to_string(),
        "shell".to_string(),
        "input".to_string(),
        "tap".to_string(),
        x.to_string(),
        y.to_string(),
    ]
}

pub(crate) fn build_text_args(serial: &str, text: &str) -> Result<Vec<String>, String> {
    Ok(vec![
        "-s".to_string(),
        serial.to_string(),
        "shell".to_string(),
        "input".to_string(),
        "text".to_string(),
        escape_adb_input_text(text)?,
    ])
}

pub(crate) fn build_keyevent_args(serial: &str, keycode: u32) -> Vec<String> {
    vec![
        "-s".to_string(),
        serial.to_string(),
        "shell".to_string(),
        "input".to_string(),
        "keyevent".to_string(),
        keycode.to_string(),
    ]
}

impl AndroidEmulatorService {
    pub(crate) fn tap_sync(&self, x: f64, y: f64) -> Result<(), String> {
        let session = self.current_session()?;
        let (pixel_x, pixel_y) = normalized_pixels(&session, x, y)?;
        let args = build_tap_args(&session.serial, pixel_x, pixel_y);
        self.run_input(&session, "tap", args, PresenceTarget::Target { x, y })
    }

    pub(crate) fn drag_sync(
        &self,
        from_x: f64,
        from_y: f64,
        to_x: f64,
        to_y: f64,
        duration_ms: u64,
    ) -> Result<(), String> {
        let session = self.current_session()?;
        let from = normalized_pixels(&session, from_x, from_y)?;
        let to = normalized_pixels(&session, to_x, to_y)?;
        let args = build_swipe_args(&session.serial, from, to, duration_ms);
        self.run_input(
            &session,
            "drag",
            args,
            PresenceTarget::Drag {
                start: AndroidEmulatorPoint {
                    x: from_x,
                    y: from_y,
                },
                end: AndroidEmulatorPoint { x: to_x, y: to_y },
            },
        )
    }

    pub(crate) fn type_text_sync(&self, text: &str) -> Result<(), String> {
        let session = self.current_session()?;
        let args = build_text_args(&session.serial, text)?;
        self.run_input(&session, "typeText", args, PresenceTarget::None)
    }

    pub(crate) fn press_key_sync(&self, key: &str) -> Result<(), String> {
        let keycode = super::keycode_for_key(key)
            .ok_or_else(|| format!("unsupported Android emulator key: {key}"))?;
        let session = self.current_session()?;
        let args = build_keyevent_args(&session.serial, keycode);
        self.run_input(&session, "pressKey", args, PresenceTarget::None)
    }

    fn run_input(
        &self,
        session: &Arc<AndroidSession>,
        action: &str,
        args: Vec<String>,
        target: PresenceTarget,
    ) -> Result<(), String> {
        let _guard = session
            .input_lock
            .lock()
            .expect("Android emulator input queue poisoned");
        if session.stop.load(Ordering::Acquire) {
            return Err("Android emulator session has ended".to_string());
        }
        emit_presence(&self.app, session.generation, action, &target, "start");
        let result = self
            .runner
            .run_interruptible(
                session.adb_path.to_string_lossy().as_ref(),
                &args,
                &session.stop,
                Instant::now() + INPUT_COMMAND_TIMEOUT,
            )
            .and_then(|output| {
                if output.success {
                    Ok(())
                } else {
                    Err(format!(
                        "adb {action} failed: {}",
                        String::from_utf8_lossy(&output.stderr).trim()
                    ))
                }
            });
        if let Err(error) = &result {
            if let Some(app) = self
                .app
                .lock()
                .expect("Android emulator app handle poisoned")
                .clone()
            {
                emit_error(&app, error.clone());
            }
        }
        emit_presence(&self.app, session.generation, action, &target, "clear");
        result
    }
}

fn normalized_pixels(session: &AndroidSession, x: f64, y: f64) -> Result<(u32, u32), String> {
    let (width, height) = session
        .dimensions
        .lock()
        .expect("Android frame dimensions poisoned")
        .ok_or_else(|| "Android preview dimensions are not ready".to_string())?;
    Ok((
        normalized_to_pixel(x, width)?,
        normalized_to_pixel(y, height)?,
    ))
}

pub(crate) enum PresenceTarget {
    None,
    Target {
        x: f64,
        y: f64,
    },
    Drag {
        start: AndroidEmulatorPoint,
        end: AndroidEmulatorPoint,
    },
}

pub(crate) fn emit_presence(
    app: &std::sync::Mutex<Option<tauri::AppHandle>>,
    generation: u64,
    action: &str,
    target: &PresenceTarget,
    phase: &str,
) {
    let Some(app) = app
        .lock()
        .expect("Android emulator app handle poisoned")
        .clone()
    else {
        return;
    };
    let (target_point, start, end) = match target {
        PresenceTarget::None => (None, None, None),
        PresenceTarget::Target { x, y } => {
            (Some(AndroidEmulatorPoint { x: *x, y: *y }), None, None)
        }
        PresenceTarget::Drag { start, end } => (None, Some(start.clone()), Some(end.clone())),
    };
    let _ = app.emit(
        PRESENCE_EVENT,
        AndroidEmulatorPresenceEvent {
            generation,
            phase: phase.to_string(),
            action: Some(action.to_string()),
            target: target_point,
            start,
            end,
        },
    );
}
