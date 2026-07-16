use base64::Engine as _;
use image::GenericImageView as _;
use serde_json::{json, Value};

use crate::models::computer_use::{ComputerUseError, ComputerUseResult};
use crate::services::computer_use_screenshot::{ScreenshotFrame, ScreenshotPipeline};

const MAX_SCREENSHOT_PNG_BYTES: usize = 8 * 1024 * 1024;

/// Opaque proof minted only after the engine validates the filtered PNG,
/// dimensions, target identity, and coordinate transform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VerifiedScreenshot {
    screenshot_id: String,
    png: Vec<u8>,
    pruned_screenshot_ids: Vec<String>,
}

impl VerifiedScreenshot {
    pub fn screenshot_id(&self) -> &str {
        &self.screenshot_id
    }

    pub fn png(&self) -> &[u8] {
        &self.png
    }

    /// Local screenshots removed from the bounded full-resolution registry in
    /// this observation. The audit persistence layer can consume these ids to
    /// remove its corresponding evidence without keeping a process-wide queue.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn pruned_screenshot_ids(&self) -> &[String] {
        &self.pruned_screenshot_ids
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScreenshotTargetGuard {
    pub screenshot_id: String,
    pub app_pid: i32,
    /// Stable identity guard for the complete approved window.
    pub window_frame: [f64; 4],
    /// Screen-space rectangle represented by the latest screenshot. This can
    /// be a strict sub-rectangle of `window_frame` after zoom.
    pub capture_frame: [f64; 4],
    pub api_dimensions: [u32; 2],
}

/// Owns the trusted observation state for one visual Computer Use loop.
///
/// Every targeted action is derived from the latest accepted screenshot and
/// carries its PID/window guard to the native helper. A new observation
/// invalidates the previous coordinate transform; no screen-absolute bypass
/// is exposed to the model-facing tool.
#[derive(Debug, Default)]
pub struct ComputerUseEngine {
    screenshots: ScreenshotPipeline,
    latest_target: Option<ScreenshotTargetGuard>,
}

impl ComputerUseEngine {
    /// Begin a new visual observation attempt. The previous screenshot must
    /// stop authorizing coordinates before any new capture work can fail.
    pub fn begin_observation(&mut self) {
        self.latest_target = None;
    }

    pub fn accept_observation(
        &mut self,
        result: &ComputerUseResult,
    ) -> Result<VerifiedScreenshot, ComputerUseError> {
        self.begin_observation();
        let state = result.result.as_ref().ok_or_else(|| {
            ComputerUseError::new("stale_state", "Fresh screenshot metadata is missing")
        })?;
        let screenshot_id = state
            .get("screenshot_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| ComputerUseError::new("stale_state", "Screenshot id is missing"))?;
        let png = state
            .get("screenshot_base64")
            .and_then(Value::as_str)
            .ok_or_else(|| ComputerUseError::new("stale_state", "Screenshot pixels are missing"))
            .and_then(|encoded| {
                if encoded.len() > MAX_SCREENSHOT_PNG_BYTES.saturating_mul(4) / 3 + 16 {
                    return Err(ComputerUseError::new(
                        "stale_state",
                        "Screenshot PNG exceeds the trusted size limit",
                    ));
                }
                base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| {
                        ComputerUseError::new("stale_state", "Screenshot PNG is malformed")
                    })
            })?;
        if png.len() > MAX_SCREENSHOT_PNG_BYTES {
            return Err(ComputerUseError::new(
                "stale_state",
                "Screenshot PNG exceeds the trusted size limit",
            ));
        }
        if !png.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
            return Err(ComputerUseError::new(
                "stale_state",
                "Screenshot payload is not a PNG",
            ));
        }
        let api_width = required_dimension_u32(state, "display_width_px", "screenshot_width")?;
        let api_height = required_dimension_u32(state, "display_height_px", "screenshot_height")?;
        let display_id = required_u32(state, "display_id")?;
        let app_pid = state
            .get("app_pid")
            .and_then(Value::as_i64)
            .and_then(|pid| i32::try_from(pid).ok())
            .filter(|pid| *pid > 0)
            .ok_or_else(|| ComputerUseError::new("stale_state", "Captured app pid is missing"))?;
        let legacy_frame = state.get("window_frame").ok_or_else(|| {
            ComputerUseError::new("stale_state", "Captured window frame is missing")
        })?;
        let target_frame = state.get("target_window_frame").unwrap_or(legacy_frame);
        let capture_frame = state.get("capture_frame").unwrap_or(legacy_frame);
        let target = required_frame(target_frame)?;
        let capture = required_frame(capture_frame)?;
        if api_width == 0 || api_height == 0 {
            return Err(ComputerUseError::new(
                "stale_state",
                "Screenshot dimensions must be positive",
            ));
        }
        let decoded = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
            .map_err(|_| ComputerUseError::new("stale_state", "Screenshot PNG is malformed"))?;
        if decoded.dimensions() != (api_width, api_height) {
            return Err(ComputerUseError::new(
                "stale_state",
                "Screenshot PNG dimensions do not match its metadata",
            ));
        }
        self.screenshots.register(ScreenshotFrame {
            screenshot_id: screenshot_id.to_owned(),
            display_id,
            png: png.clone(),
            api_width,
            api_height,
            screen_origin_x: capture[0],
            screen_origin_y: capture[1],
            screen_width: capture[2],
            screen_height: capture[3],
        });
        let verified = VerifiedScreenshot {
            screenshot_id: screenshot_id.to_owned(),
            png,
            pruned_screenshot_ids: self.screenshots.take_prune_batch().unwrap_or_default(),
        };
        self.latest_target = Some(ScreenshotTargetGuard {
            screenshot_id: screenshot_id.to_owned(),
            app_pid,
            window_frame: target,
            capture_frame: capture,
            api_dimensions: [api_width, api_height],
        });
        Ok(verified)
    }

    pub fn map_latest_coordinate(
        &self,
        coordinate: [u32; 2],
    ) -> Result<(i32, i32), ComputerUseError> {
        let target = self.latest_target.as_ref().ok_or_else(|| {
            ComputerUseError::new(
                "stale_state",
                "Take a fresh screenshot before acting on screen coordinates",
            )
        })?;
        self.screenshots
            .map_latest(&target.screenshot_id, coordinate)
            .map(|[x, y]| (x.round() as i32, y.round() as i32))
    }

    pub fn target_guard(&self) -> Result<&ScreenshotTargetGuard, ComputerUseError> {
        self.latest_target.as_ref().ok_or_else(|| {
            ComputerUseError::new(
                "stale_state",
                "Take a fresh screenshot before controlling the app",
            )
        })
    }

    /// Convert a zoom rectangle from the latest screenshot pixel grid into
    /// the global screen rectangle that the native helper must recapture.
    /// Keeping this conversion in the trusted engine makes nested zooms
    /// relative to the image the model actually inspected.
    pub fn map_latest_region(&self, region: [u32; 4]) -> Result<[f64; 4], ComputerUseError> {
        let target = self.target_guard()?;
        let [x, y, width, height] = region;
        let [api_width, api_height] = target.api_dimensions;
        if width == 0
            || height == 0
            || x.checked_add(width).is_none_or(|right| right > api_width)
            || y.checked_add(height)
                .is_none_or(|bottom| bottom > api_height)
        {
            return Err(ComputerUseError::new(
                "invalid_argument",
                "Zoom region must be inside the latest screenshot pixel grid",
            ));
        }
        let [capture_x, capture_y, capture_width, capture_height] = target.capture_frame;
        Ok([
            capture_x + f64::from(x) * capture_width / f64::from(api_width),
            capture_y + f64::from(y) * capture_height / f64::from(api_height),
            f64::from(width) * capture_width / f64::from(api_width),
            f64::from(height) * capture_height / f64::from(api_height),
        ])
    }

    pub fn target_params(&self) -> Result<Value, ComputerUseError> {
        let target = self.target_guard()?;
        Ok(json!({
            "expected_screenshot_id": target.screenshot_id,
            "expected_pid": target.app_pid,
            "expected_window_frame": {
                "x": target.window_frame[0],
                "y": target.window_frame[1],
                "width": target.window_frame[2],
                "height": target.window_frame[3],
            }
        }))
    }
}

fn required_u32(value: &Value, key: &str) -> Result<u32, ComputerUseError> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|number| u32::try_from(number).ok())
        .ok_or_else(|| ComputerUseError::new("stale_state", format!("{key} is missing or invalid")))
}

fn required_dimension_u32(
    value: &Value,
    display_key: &str,
    legacy_key: &str,
) -> Result<u32, ComputerUseError> {
    let parse = |key: &str| -> Result<Option<u32>, ComputerUseError> {
        let Some(raw) = value.get(key) else {
            return Ok(None);
        };
        raw.as_u64()
            .and_then(|number| u32::try_from(number).ok())
            .map(Some)
            .ok_or_else(|| {
                ComputerUseError::new("stale_state", format!("{key} is missing or invalid"))
            })
    };
    match (parse(display_key)?, parse(legacy_key)?) {
        (Some(display), Some(legacy)) if display != legacy => Err(ComputerUseError::new(
            "stale_state",
            format!("{display_key} and {legacy_key} must match"),
        )),
        (Some(display), _) => Ok(display),
        (_, Some(legacy)) => Ok(legacy),
        (None, None) => Err(ComputerUseError::new(
            "stale_state",
            format!("{display_key} or {legacy_key} is missing"),
        )),
    }
}

fn required_f64(value: &Value, key: &str) -> Result<f64, ComputerUseError> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .ok_or_else(|| ComputerUseError::new("stale_state", format!("{key} is missing or invalid")))
}

fn required_positive_f64(value: &Value, key: &str) -> Result<f64, ComputerUseError> {
    required_f64(value, key).and_then(|number| {
        if number > 0.0 {
            Ok(number)
        } else {
            Err(ComputerUseError::new(
                "stale_state",
                format!("{key} must be positive"),
            ))
        }
    })
}

fn required_frame(value: &Value) -> Result<[f64; 4], ComputerUseError> {
    Ok([
        required_f64(value, "x")?,
        required_f64(value, "y")?,
        required_positive_f64(value, "width")?,
        required_positive_f64(value, "height")?,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_base64(dimensions: [u32; 2]) -> String {
        let image = image::DynamicImage::new_rgba8(dimensions[0], dimensions[1]);
        let mut bytes = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut bytes, image::ImageFormat::Png)
            .expect("encode test PNG");
        base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
    }

    fn observation(id: &str, pid: i32, api: [u32; 2], frame: [f64; 4]) -> ComputerUseResult {
        ComputerUseResult {
            result: Some(json!({
                "screenshot_id":id,
                "screenshot_base64":png_base64(api),
                "screenshot_width":api[0],
                "screenshot_height":api[1],
                "display_id":42,
                "app_pid":pid,
                "window_frame":{"x":frame[0],"y":frame[1],"width":frame[2],"height":frame[3]},
            })),
            error: None,
        }
    }

    #[test]
    fn observation_drives_coordinates_and_target_guard() {
        let mut engine = ComputerUseEngine::default();
        engine
            .accept_observation(&observation(
                "latest",
                321,
                [100, 100],
                [-50.0, 10.0, 200.0, 300.0],
            ))
            .unwrap();

        assert_eq!(engine.map_latest_coordinate([25, 50]).unwrap(), (0, 160));
        assert_eq!(engine.target_guard().unwrap().app_pid, 321);
        assert_eq!(
            engine.target_params().unwrap()["expected_screenshot_id"],
            "latest"
        );
    }

    #[test]
    fn zoomed_observation_maps_pixels_through_capture_but_guards_full_window() {
        let mut engine = ComputerUseEngine::default();
        engine
            .accept_observation(&ComputerUseResult {
                result: Some(json!({
                    "screenshot_id":"zoomed",
                    "screenshot_base64":png_base64([400, 200]),
                    "screenshot_width":400,
                    "screenshot_height":200,
                    "display_id":42,
                    "app_pid":321,
                    "window_frame":{"x":100,"y":200,"width":800,"height":600},
                    "target_window_frame":{"x":100,"y":200,"width":800,"height":600},
                    "capture_frame":{"x":300,"y":350,"width":400,"height":200}
                })),
                error: None,
            })
            .unwrap();

        assert_eq!(
            engine.map_latest_coordinate([200, 100]).unwrap(),
            (500, 450)
        );
        assert_eq!(
            engine.target_params().unwrap()["expected_window_frame"],
            json!({"x":100.0,"y":200.0,"width":800.0,"height":600.0})
        );
    }

    #[test]
    fn nested_zoom_region_is_relative_to_the_latest_cropped_image() {
        let mut engine = ComputerUseEngine::default();
        engine
            .accept_observation(&ComputerUseResult {
                result: Some(json!({
                    "screenshot_id":"zoomed",
                    "screenshot_base64":png_base64([400, 200]),
                    "screenshot_width":400,
                    "screenshot_height":200,
                    "display_id":42,
                    "app_pid":321,
                    "window_frame":{"x":100,"y":200,"width":800,"height":600},
                    "target_window_frame":{"x":100,"y":200,"width":800,"height":600},
                    "capture_frame":{"x":300,"y":350,"width":400,"height":200}
                })),
                error: None,
            })
            .unwrap();

        assert_eq!(
            engine.map_latest_region([100, 50, 200, 100]).unwrap(),
            [400.0, 400.0, 200.0, 100.0]
        );
        assert_eq!(
            engine.map_latest_region([399, 199, 2, 1]).unwrap_err().code,
            "invalid_argument"
        );
    }

    #[test]
    fn malformed_or_missing_pixels_never_create_action_authority() {
        let mut engine = ComputerUseEngine::default();
        let mut malformed = observation("bad", 1, [10, 10], [0.0, 0.0, 10.0, 10.0]);
        malformed.result.as_mut().unwrap()["screenshot_base64"] = json!("not-base64");

        assert_eq!(
            engine.accept_observation(&malformed).unwrap_err().code,
            "stale_state"
        );
        assert_eq!(engine.target_guard().unwrap_err().code, "stale_state");
    }

    #[test]
    fn screenshot_pixel_dimensions_must_match_trusted_metadata() {
        let mut engine = ComputerUseEngine::default();
        let mismatch = ComputerUseResult {
            result: Some(json!({
                "screenshot_id":"mismatch",
                "screenshot_base64":png_base64([1, 1]),
                "screenshot_width":2,
                "screenshot_height":2,
                "display_id":42,
                "app_pid":7,
                "window_frame":{"x":0,"y":0,"width":2,"height":2}
            })),
            error: None,
        };

        assert_eq!(
            engine.accept_observation(&mismatch).unwrap_err().code,
            "stale_state"
        );
        assert!(engine.target_guard().is_err());
    }

    #[test]
    fn observation_accepts_display_dimension_fields_without_legacy_names() {
        let mut engine = ComputerUseEngine::default();
        let mut alias_only = observation("alias-only", 7, [10, 8], [0.0, 0.0, 20.0, 16.0]);
        let payload = alias_only
            .result
            .as_mut()
            .and_then(Value::as_object_mut)
            .expect("observation payload");
        let width = payload.remove("screenshot_width").expect("legacy width");
        let height = payload.remove("screenshot_height").expect("legacy height");
        payload.insert("display_width_px".into(), width);
        payload.insert("display_height_px".into(), height);

        engine
            .accept_observation(&alias_only)
            .expect("new dimension names remain valid wire input");
        assert_eq!(engine.map_latest_coordinate([5, 4]).unwrap(), (10, 8));
    }

    #[test]
    fn observation_rejects_conflicting_legacy_and_display_dimensions() {
        let mut engine = ComputerUseEngine::default();
        let mut conflicting = observation("conflict", 7, [10, 8], [0.0, 0.0, 20.0, 16.0]);
        let payload = conflicting
            .result
            .as_mut()
            .and_then(Value::as_object_mut)
            .expect("observation payload");
        payload.insert("display_width_px".into(), json!(11));
        payload.insert("display_height_px".into(), json!(8));

        assert_eq!(
            engine.accept_observation(&conflicting).unwrap_err().code,
            "stale_state"
        );
        assert!(engine.target_guard().is_err());
    }

    #[test]
    fn a_new_observation_replaces_the_previous_pid_and_transform() {
        let mut engine = ComputerUseEngine::default();
        engine
            .accept_observation(&observation(
                "old",
                10,
                [100, 100],
                [0.0, 0.0, 100.0, 100.0],
            ))
            .unwrap();
        engine
            .accept_observation(&observation(
                "new",
                20,
                [100, 100],
                [100.0, 100.0, 200.0, 200.0],
            ))
            .unwrap();

        assert_eq!(engine.target_guard().unwrap().screenshot_id, "new");
        assert_eq!(engine.target_guard().unwrap().app_pid, 20);
        assert_eq!(engine.map_latest_coordinate([50, 50]).unwrap(), (200, 200));
    }

    #[test]
    fn a_rejected_new_observation_invalidates_the_previous_spatial_authority() {
        let mut engine = ComputerUseEngine::default();
        engine
            .accept_observation(&observation(
                "old",
                10,
                [100, 100],
                [0.0, 0.0, 100.0, 100.0],
            ))
            .unwrap();
        assert_eq!(engine.map_latest_coordinate([50, 50]).unwrap(), (50, 50));

        let mut malformed = observation("new", 20, [100, 100], [100.0, 100.0, 100.0, 100.0]);
        malformed.result.as_mut().unwrap()["screenshot_base64"] = json!("not-base64");
        assert_eq!(
            engine.accept_observation(&malformed).unwrap_err().code,
            "stale_state"
        );

        assert_eq!(
            engine.map_latest_coordinate([50, 50]).unwrap_err().code,
            "stale_state"
        );
        assert_eq!(engine.target_guard().unwrap_err().code, "stale_state");
    }

    #[test]
    fn accepted_observation_surfaces_the_bounded_local_prune_batch() {
        let mut engine = ComputerUseEngine::default();
        for index in 0..24 {
            let verified = engine
                .accept_observation(&observation(
                    &format!("shot-{index}"),
                    7,
                    [1, 1],
                    [0.0, 0.0, 1.0, 1.0],
                ))
                .expect("accept observation");
            assert!(verified.pruned_screenshot_ids().is_empty());
        }

        let verified = engine
            .accept_observation(&observation("shot-24", 7, [1, 1], [0.0, 0.0, 1.0, 1.0]))
            .expect("accept 25th observation");
        assert_eq!(
            verified.pruned_screenshot_ids(),
            (0..22)
                .map(|index| format!("shot-{index}"))
                .collect::<Vec<_>>()
        );
    }
}
