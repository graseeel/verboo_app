use serde::{Deserialize, Serialize};

use crate::models::computer_use::ComputerUseError;

const HISTORY_LIMIT: usize = 3;
const PRUNE_INTERVAL: usize = 25;
#[cfg(test)]
pub const DEFAULT_MAX_SCREENSHOT_DIMENSIONS: [u32; 2] = [1280, 720];

#[derive(Debug, Clone, PartialEq)]
pub struct ScreenshotFrame {
    pub screenshot_id: String,
    pub display_id: u32,
    pub png: Vec<u8>,
    pub api_width: u32,
    pub api_height: u32,
    pub screen_origin_x: f64,
    pub screen_origin_y: f64,
    pub screen_width: f64,
    pub screen_height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScreenshotTransform {
    pub screenshot_id: String,
    pub display_id: u32,
    pub api_width: u32,
    pub api_height: u32,
    pub screen_origin_x: f64,
    pub screen_origin_y: f64,
    pub screen_width: f64,
    pub screen_height: f64,
}

#[derive(Debug, Default)]
pub struct ScreenshotPipeline {
    history: Vec<ScreenshotFrame>,
    latest: Option<ScreenshotTransform>,
    registrations_since_prune: usize,
    evicted_since_prune: Vec<String>,
    // The engine drains this immediately after each accepted observation. Keep
    // only the newest batch so a missing consumer can never grow process memory
    // without bound.
    pending_prune_batch: Option<Vec<String>>,
}

impl ScreenshotPipeline {
    pub fn register(&mut self, frame: ScreenshotFrame) -> ScreenshotTransform {
        let transform = ScreenshotTransform {
            screenshot_id: frame.screenshot_id.clone(),
            display_id: frame.display_id,
            api_width: frame.api_width,
            api_height: frame.api_height,
            screen_origin_x: frame.screen_origin_x,
            screen_origin_y: frame.screen_origin_y,
            screen_width: frame.screen_width,
            screen_height: frame.screen_height,
        };
        self.history.push(frame);
        if self.history.len() > HISTORY_LIMIT {
            let evicted = self.history.remove(0);
            self.evicted_since_prune.push(evicted.screenshot_id);
        }
        self.registrations_since_prune += 1;
        if self.registrations_since_prune == PRUNE_INTERVAL {
            self.pending_prune_batch = Some(std::mem::take(&mut self.evicted_since_prune));
            self.registrations_since_prune = 0;
        }
        self.latest = Some(transform.clone());
        transform
    }

    pub fn map_latest(
        &self,
        screenshot_id: &str,
        api: [u32; 2],
    ) -> Result<[f64; 2], ComputerUseError> {
        let transform = self.latest.as_ref().ok_or_else(|| {
            ComputerUseError::new("stale_state", "No screenshot transform is available")
        })?;
        if transform.screenshot_id != screenshot_id {
            return Err(ComputerUseError::new(
                "stale_state",
                "Coordinates must reference the latest screenshot",
            ));
        }
        if api[0] >= transform.api_width || api[1] >= transform.api_height {
            return Err(ComputerUseError::new(
                "invalid_argument",
                "Coordinates must be inside the latest screenshot pixel grid",
            ));
        }
        Ok([
            transform.screen_origin_x
                + f64::from(api[0]) * transform.screen_width / f64::from(transform.api_width),
            transform.screen_origin_y
                + f64::from(api[1]) * transform.screen_height / f64::from(transform.api_height),
        ])
    }

    #[cfg(test)]
    pub fn dimensions_for(source: [u32; 2], max: [u32; 2]) -> [u32; 2] {
        let [source_width, source_height] = source;
        let [max_width, max_height] = max;
        if source_width == 0 || source_height == 0 || max_width == 0 || max_height == 0 {
            return [0, 0];
        }
        if source_width <= max_width && source_height <= max_height {
            return source;
        }

        let width_is_limiting = u64::from(max_width) * u64::from(source_height)
            <= u64::from(max_height) * u64::from(source_width);
        if width_is_limiting {
            let height = (u64::from(source_height) * u64::from(max_width) / u64::from(source_width))
                .max(1) as u32;
            [max_width, height]
        } else {
            let width = (u64::from(source_width) * u64::from(max_height) / u64::from(source_height))
                .max(1) as u32;
            [width, max_height]
        }
    }

    #[cfg(test)]
    pub fn history(&self) -> &[ScreenshotFrame] {
        &self.history
    }

    pub fn take_prune_batch(&mut self) -> Option<Vec<String>> {
        self.pending_prune_batch.take()
    }

    #[cfg(test)]
    pub fn pending_prune_batch_count(&self) -> usize {
        usize::from(self.pending_prune_batch.is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(
        screenshot_id: &str,
        api: [u32; 2],
        origin: [f64; 2],
        screen: [f64; 2],
    ) -> ScreenshotFrame {
        ScreenshotFrame {
            screenshot_id: screenshot_id.to_owned(),
            display_id: 42,
            png: vec![137, 80, 78, 71],
            api_width: api[0],
            api_height: api[1],
            screen_origin_x: origin[0],
            screen_origin_y: origin[1],
            screen_width: screen[0],
            screen_height: screen[1],
        }
    }

    #[test]
    fn computer_use_screenshot_maps_retina_coordinates_on_each_axis() {
        let mut pipeline = ScreenshotPipeline::default();
        pipeline.register(frame("retina", [1280, 720], [0.0, 0.0], [2560.0, 1440.0]));

        assert_eq!(
            pipeline.map_latest("retina", [640, 360]).unwrap(),
            [1280.0, 720.0]
        );
    }

    #[test]
    fn computer_use_screenshot_maps_negative_display_origins_and_asymmetric_axes() {
        let mut pipeline = ScreenshotPipeline::default();
        pipeline.register(frame(
            "left-display",
            [800, 700],
            [-1600.0, 150.0],
            [1600.0, 1050.0],
        ));

        assert_eq!(
            pipeline.map_latest("left-display", [200, 400]).unwrap(),
            [-1200.0, 750.0]
        );
    }

    #[test]
    fn computer_use_screenshot_rejects_a_stale_screenshot_id() {
        let mut pipeline = ScreenshotPipeline::default();
        pipeline.register(frame("old", [1280, 720], [0.0, 0.0], [1280.0, 720.0]));
        pipeline.register(frame("latest", [1280, 720], [0.0, 0.0], [1280.0, 720.0]));

        let error = pipeline
            .map_latest("old", [1, 1])
            .expect_err("an old frame cannot authorize coordinates");

        assert_eq!(error.code, "stale_state");
    }

    #[test]
    fn computer_use_screenshot_rejects_coordinates_on_the_outer_edges() {
        let mut pipeline = ScreenshotPipeline::default();
        pipeline.register(frame("latest", [1280, 720], [0.0, 0.0], [2560.0, 1440.0]));

        assert_eq!(
            pipeline.map_latest("latest", [1279, 719]).unwrap(),
            [2558.0, 1438.0]
        );

        for coordinate in [[1280, 0], [0, 720], [1280, 720]] {
            let error = pipeline
                .map_latest("latest", coordinate)
                .expect_err("the image bounds are exclusive");
            assert_eq!(error.code, "invalid_argument", "{coordinate:?}");
        }
    }

    #[test]
    fn computer_use_screenshot_resize_preserves_aspect_ratio() {
        assert_eq!(
            ScreenshotPipeline::dimensions_for([4000, 3000], DEFAULT_MAX_SCREENSHOT_DIMENSIONS,),
            [960, 720]
        );
        assert_eq!(
            ScreenshotPipeline::dimensions_for([3000, 1000], [1280, 720]),
            [1280, 426]
        );
    }

    #[test]
    fn computer_use_screenshot_resize_never_upscales() {
        assert_eq!(
            ScreenshotPipeline::dimensions_for([640, 360], [1280, 720]),
            [640, 360]
        );
    }

    #[test]
    fn computer_use_screenshot_history_keeps_only_the_latest_three_frames() {
        let mut pipeline = ScreenshotPipeline::default();
        for id in ["one", "two", "three", "four", "five"] {
            pipeline.register(frame(id, [1, 1], [0.0, 0.0], [1.0, 1.0]));
        }

        let ids = pipeline
            .history()
            .iter()
            .map(|frame| frame.screenshot_id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, ["three", "four", "five"]);
    }

    #[test]
    fn computer_use_screenshot_prunes_in_batches_after_twenty_five_registrations() {
        let mut pipeline = ScreenshotPipeline::default();
        for index in 0..24 {
            pipeline.register(frame(
                &format!("shot-{index}"),
                [1, 1],
                [0.0, 0.0],
                [1.0, 1.0],
            ));
        }
        assert_eq!(pipeline.take_prune_batch(), None);

        pipeline.register(frame("shot-24", [1, 1], [0.0, 0.0], [1.0, 1.0]));
        let first_batch = pipeline
            .take_prune_batch()
            .expect("the 25th registration should make a prune batch ready");

        assert_eq!(first_batch.len(), 22);
        assert_eq!(first_batch.first().map(String::as_str), Some("shot-0"));
        assert_eq!(first_batch.last().map(String::as_str), Some("shot-21"));
        assert!(!first_batch.iter().any(|id| id == "shot-24"));
        assert_eq!(
            pipeline
                .history()
                .iter()
                .map(|frame| frame.screenshot_id.as_str())
                .collect::<Vec<_>>(),
            ["shot-22", "shot-23", "shot-24"]
        );

        for index in 25..50 {
            pipeline.register(frame(
                &format!("shot-{index}"),
                [1, 1],
                [0.0, 0.0],
                [1.0, 1.0],
            ));
        }
        let second_batch = pipeline
            .take_prune_batch()
            .expect("another 25 registrations should produce another batch");
        assert_eq!(second_batch.len(), 25);
        assert_eq!(second_batch.first().map(String::as_str), Some("shot-22"));
        assert_eq!(second_batch.last().map(String::as_str), Some("shot-46"));
        assert!(!second_batch.iter().any(|id| id == "shot-49"));
        assert_eq!(
            pipeline
                .history()
                .iter()
                .map(|frame| frame.screenshot_id.as_str())
                .collect::<Vec<_>>(),
            ["shot-47", "shot-48", "shot-49"]
        );
    }

    #[test]
    fn computer_use_screenshot_retention_metadata_stays_bounded_without_a_consumer() {
        let mut pipeline = ScreenshotPipeline::default();
        for index in 0..274 {
            pipeline.register(frame(
                &format!("shot-{index}"),
                [1, 1],
                [0.0, 0.0],
                [1.0, 1.0],
            ));
        }

        assert_eq!(pipeline.pending_prune_batch_count(), 1);
        assert_eq!(pipeline.evicted_since_prune.len(), PRUNE_INTERVAL - 1);
        assert_eq!(pipeline.history.len(), HISTORY_LIMIT);
        let latest_batch = pipeline
            .take_prune_batch()
            .expect("the latest bounded prune batch remains available");
        assert_eq!(latest_batch.len(), PRUNE_INTERVAL);
        assert_eq!(latest_batch.first().map(String::as_str), Some("shot-222"));
        assert_eq!(latest_batch.last().map(String::as_str), Some("shot-246"));
        assert_eq!(pipeline.pending_prune_batch_count(), 0);
    }
}
