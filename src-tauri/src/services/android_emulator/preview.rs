use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::cell::Cell;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::grpc::generated;

pub(crate) const MAX_SAFE_GENERATION: u64 = 9_007_199_254_740_991;
pub(crate) const VAF1_HEADER_LEN: usize = 36;
pub(crate) const VAF1_RGB888: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GenerationError {
    Exhausted,
}

pub(crate) fn next_preview_generation(counter: &AtomicU64) -> Result<u64, GenerationError> {
    counter
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            (current < MAX_SAFE_GENERATION).then_some(current + 1)
        })
        .map(|previous| previous + 1)
        .map_err(|_| GenerationError::Exhausted)
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PreviewTransport {
    LegacyPng,
    Vaf1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PreviewMode {
    LegacyPrimary,
    Vaf1,
    LegacyFallback,
}

impl PreviewMode {
    pub(crate) fn from_wire(transport: Option<PreviewTransport>) -> Self {
        match transport {
            None => Self::LegacyPrimary,
            Some(PreviewTransport::Vaf1) => Self::Vaf1,
            Some(PreviewTransport::LegacyPng) => Self::LegacyFallback,
        }
    }

    pub(crate) fn capture_fps(self, stream_fps: u16, fallback_fps: f64) -> f64 {
        match self {
            Self::LegacyPrimary => f64::from(stream_fps),
            Self::Vaf1 | Self::LegacyFallback => fallback_fps,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrameReady {
    pub(crate) generation: u64,
    pub(crate) seq: u32,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PreviewSource {
    Grpc,
    AdbFallback,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PreviewReason {
    GpuSoftware,
    Unavailable,
    Unauthenticated,
    Unsupported,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewState {
    pub(crate) generation: u64,
    pub(crate) source: PreviewSource,
    pub(crate) requested_fps: u16,
    pub(crate) degraded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<PreviewReason>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum PreviewReadError {
    StaleGeneration {
        #[serde(rename = "currentGeneration")]
        current_generation: u64,
    },
    NoFrame,
    Unavailable,
    Unauthenticated,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SequenceError {
    Exhausted,
}

pub(crate) struct SessionSeq {
    last: u32,
}

#[cfg(test)]
thread_local! {
    static TEST_SESSION_SEQ_LAST: Cell<u32> = const { Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn seed_session_seq_last_for_test(last: u32) {
    TEST_SESSION_SEQ_LAST.with(|cell| cell.set(last));
}

impl SessionSeq {
    pub(crate) fn new() -> Self {
        Self {
            last: Self::initial_last(),
        }
    }

    #[cfg(not(test))]
    fn initial_last() -> u32 {
        0
    }

    #[cfg(test)]
    fn initial_last() -> u32 {
        TEST_SESSION_SEQ_LAST.with(|cell| cell.replace(0))
    }

    pub(crate) fn next(&mut self) -> Result<u32, SequenceError> {
        let next = self.last.checked_add(1).ok_or(SequenceError::Exhausted)?;
        self.last = next;
        Ok(next)
    }
}

pub(crate) trait Clock: Send + Sync {
    fn unix_micros(&self) -> u64;
    fn monotonic_micros(&self) -> u64;
    fn delay_micros(&self, _micros: u64) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async {})
    }
}

pub(crate) struct SystemClock {
    process_start: Instant,
    process_start_unix_us: u64,
}

impl SystemClock {
    pub(crate) fn new() -> Self {
        let process_start_unix_us = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros()
            .min(u128::from(u64::MAX)) as u64;
        Self {
            process_start: Instant::now(),
            process_start_unix_us,
        }
    }
}

impl Clock for SystemClock {
    fn unix_micros(&self) -> u64 {
        self.process_start_unix_us
            .saturating_add(self.monotonic_micros())
    }

    fn monotonic_micros(&self) -> u64 {
        self.process_start
            .elapsed()
            .as_micros()
            .min(u128::from(u64::MAX)) as u64
    }

    fn delay_micros(&self, micros: u64) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(tokio::time::sleep(Duration::from_micros(micros)))
    }
}

#[cfg(test)]
pub(crate) struct InstantRetryClock {
    monotonic_us: AtomicU64,
}

#[cfg(test)]
impl Default for InstantRetryClock {
    fn default() -> Self {
        Self {
            monotonic_us: AtomicU64::new(1),
        }
    }
}

#[cfg(test)]
impl Clock for InstantRetryClock {
    fn unix_micros(&self) -> u64 {
        1
    }

    fn monotonic_micros(&self) -> u64 {
        self.monotonic_us.load(Ordering::Acquire)
    }

    fn delay_micros(&self, micros: u64) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.monotonic_us.fetch_add(micros, Ordering::AcqRel);
        Box::pin(async {})
    }
}

pub(crate) fn coordinator_clock() -> Arc<dyn Clock> {
    #[cfg(test)]
    {
        Arc::new(InstantRetryClock::default())
    }
    #[cfg(not(test))]
    {
        Arc::new(SystemClock::new())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ValidatedRgbFrame<'a> {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) timestamp_us: u64,
    pub(crate) payload: &'a [u8],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FrameError {
    MissingFormat,
    WrongFormat,
    EmptyDimensions,
    OutsideBoundingBox,
    PayloadLength,
}

pub(crate) fn validate_image<'a>(
    image: &'a generated::Image,
    clock: &dyn Clock,
) -> Result<ValidatedRgbFrame<'a>, FrameError> {
    let format = image.format.as_ref().ok_or(FrameError::MissingFormat)?;
    if format.format != generated::image_format::ImgFormat::Rgb888 as i32 {
        return Err(FrameError::WrongFormat);
    }
    if format.width == 0 || format.height == 0 {
        return Err(FrameError::EmptyDimensions);
    }
    let portrait = format.width <= 720 && format.height <= 1600;
    let landscape = format.width <= 1600 && format.height <= 720;
    if !portrait && !landscape {
        return Err(FrameError::OutsideBoundingBox);
    }
    let expected = usize::try_from(format.width)
        .ok()
        .and_then(|width| {
            usize::try_from(format.height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .and_then(|pixels| pixels.checked_mul(3))
        .ok_or(FrameError::PayloadLength)?;
    if image.image.len() != expected {
        return Err(FrameError::PayloadLength);
    }
    let timestamp_us = if image.timestamp_us > 0 {
        image.timestamp_us
    } else {
        clock.unix_micros()
    };
    Ok(ValidatedRgbFrame {
        width: format.width,
        height: format.height,
        timestamp_us,
        payload: &image.image,
    })
}

#[derive(Debug)]
struct LatestSlotState {
    frame: Option<Vec<u8>>,
    dropped: u64,
}

#[derive(Debug)]
pub(crate) struct LatestSlot {
    generation: u64,
    state: Mutex<LatestSlotState>,
}

impl LatestSlot {
    pub(crate) fn new(current_generation: u64) -> Self {
        Self {
            generation: current_generation,
            state: Mutex::new(LatestSlotState {
                frame: None,
                dropped: 0,
            }),
        }
    }

    pub(crate) fn publish(&self, seq: u32, frame: ValidatedRgbFrame<'_>) {
        self.publish_with_materialization_probe(seq, frame, || {});
    }

    fn publish_with_materialization_probe(
        &self,
        seq: u32,
        frame: ValidatedRgbFrame<'_>,
        materialized: impl FnOnce(),
    ) {
        let mut bytes = Vec::with_capacity(VAF1_HEADER_LEN + frame.payload.len());
        bytes.extend_from_slice(b"VAF1");
        bytes.extend_from_slice(&self.generation.to_le_bytes());
        bytes.extend_from_slice(&seq.to_le_bytes());
        bytes.extend_from_slice(&frame.timestamp_us.to_le_bytes());
        bytes.extend_from_slice(&frame.width.to_le_bytes());
        bytes.extend_from_slice(&frame.height.to_le_bytes());
        bytes.push(VAF1_RGB888);
        bytes.extend_from_slice(&[0, 0, 0]);
        bytes.extend_from_slice(frame.payload);
        materialized();
        let mut state = self.state.lock().expect("Android latest slot poisoned");
        if state.frame.replace(bytes).is_some() {
            state.dropped = state.dropped.saturating_add(1);
        }
    }

    pub(crate) fn take(&self, requested_generation: u64) -> Result<Vec<u8>, PreviewReadError> {
        if requested_generation != self.generation {
            return Err(PreviewReadError::StaleGeneration {
                current_generation: self.generation,
            });
        }
        let mut state = self.state.lock().expect("Android latest slot poisoned");
        state.frame.take().ok_or(PreviewReadError::NoFrame)
    }

    pub(crate) fn ensure_generation(
        &self,
        requested_generation: u64,
    ) -> Result<(), PreviewReadError> {
        if requested_generation != self.generation {
            return Err(PreviewReadError::StaleGeneration {
                current_generation: self.generation,
            });
        }
        Ok(())
    }

    pub(crate) fn clear(&self) {
        self.state
            .lock()
            .expect("Android latest slot poisoned")
            .frame = None;
    }

    pub(crate) fn current_generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn dropped(&self) -> u64 {
        self.state
            .lock()
            .expect("Android latest slot poisoned")
            .dropped
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FirstPreviewError {
    Cancelled,
    Unavailable,
    Unauthenticated,
    Unsupported,
    SequenceExhausted,
    Event(String),
    LegacyPng(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FirstPreviewState {
    Pending,
    Ready,
    Failed(FirstPreviewError),
}

pub(crate) struct FirstPreviewGate {
    state: Mutex<FirstPreviewState>,
    changed: Condvar,
}

impl FirstPreviewGate {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(FirstPreviewState::Pending),
            changed: Condvar::new(),
        }
    }

    pub(crate) fn ready(&self) -> bool {
        self.finish(FirstPreviewState::Ready)
    }

    pub(crate) fn fail(&self, error: FirstPreviewError) -> bool {
        self.finish(FirstPreviewState::Failed(error))
    }

    fn finish(&self, next: FirstPreviewState) -> bool {
        let mut state = self
            .state
            .lock()
            .expect("Android first preview gate poisoned");
        if *state == FirstPreviewState::Pending {
            *state = next;
            self.changed.notify_all();
            true
        } else {
            false
        }
    }

    pub(crate) fn wait(&self) -> Result<(), FirstPreviewError> {
        let mut state = self
            .state
            .lock()
            .expect("Android first preview gate poisoned");
        while *state == FirstPreviewState::Pending {
            state = self
                .changed
                .wait(state)
                .expect("Android first preview gate poisoned");
        }
        match &*state {
            FirstPreviewState::Ready => Ok(()),
            FirstPreviewState::Failed(error) => Err(error.clone()),
            FirstPreviewState::Pending => unreachable!(),
        }
    }

    pub(crate) fn status(&self) -> FirstPreviewState {
        self.state
            .lock()
            .expect("Android first preview gate poisoned")
            .clone()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PreviewHealthState {
    Starting,
    Recovering,
    GrpcActive,
    AdbActive,
    Terminal(FirstPreviewError),
}

pub(crate) struct PreviewHealth {
    state: Mutex<PreviewHealthState>,
}

impl PreviewHealth {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(PreviewHealthState::Starting),
        }
    }

    pub(crate) fn status(&self) -> PreviewHealthState {
        self.state
            .lock()
            .expect("Android preview health poisoned")
            .clone()
    }

    pub(crate) fn is_operational(&self) -> bool {
        matches!(
            self.status(),
            PreviewHealthState::GrpcActive | PreviewHealthState::AdbActive
        )
    }

    fn transition(&self, next: PreviewHealthState) {
        let mut state = self.state.lock().expect("Android preview health poisoned");
        if !matches!(&*state, PreviewHealthState::Terminal(_)) {
            *state = next;
        }
    }

    pub(crate) fn recovering(&self) {
        self.transition(PreviewHealthState::Recovering);
    }

    pub(crate) fn grpc_active(&self) {
        self.transition(PreviewHealthState::GrpcActive);
    }

    pub(crate) fn adb_active(&self) {
        self.transition(PreviewHealthState::AdbActive);
    }

    pub(crate) fn terminal(&self, error: FirstPreviewError) {
        self.transition(PreviewHealthState::Terminal(error));
    }
}

pub(crate) type StreamMessageFuture<'a> = Pin<
    Box<dyn Future<Output = Result<Option<generated::Image>, super::grpc::GrpcError>> + Send + 'a>,
>;

pub(crate) type OpenStreamFuture<'a> = Pin<
    Box<dyn Future<Output = Result<Box<dyn ScreenshotStream>, super::grpc::GrpcError>> + Send + 'a>,
>;

pub(crate) trait ScreenshotStream: Send {
    fn message(&mut self) -> StreamMessageFuture<'_>;
}

pub(crate) trait ScreenshotStreamFactory: Send + Sync {
    fn open(&self, width: u32, height: u32) -> OpenStreamFuture<'_>;
}

pub(crate) trait PreviewEventSink: Send + Sync {
    fn frame_ready(&self, event: FrameReady) -> Result<(), String>;
    fn preview_state(&self, state: PreviewState) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PreviewControl {
    pub(crate) visible: bool,
    pub(crate) stop: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct OpenRetry {
    pub budget_us: u64,
    pub backoff_us: u64,
}

pub(crate) const OWNED_OPEN_RETRY: OpenRetry = OpenRetry {
    budget_us: 2_000_000,
    backoff_us: 100_000,
};

/// Caps retries when the clock does not advance (default `delay_micros` is a no-op).
const MAX_OWNED_OPEN_ATTEMPTS: u32 = 24;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WorkerOutcome {
    Stopped,
    Fallback(PreviewReason),
    Failed(FirstPreviewError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Orientation {
    Portrait,
    Landscape,
}

impl Orientation {
    fn dimensions(self) -> (u32, u32) {
        match self {
            Self::Portrait => (720, 1600),
            Self::Landscape => (1600, 720),
        }
    }

    fn from_frame(frame: ValidatedRgbFrame<'_>) -> Self {
        if frame.height >= frame.width {
            Self::Portrait
        } else {
            Self::Landscape
        }
    }
}

fn frame_interval_us(fps: u16) -> u64 {
    match u64::from(fps) {
        0 => u64::MAX,
        fps => 1_000_000 / fps,
    }
}

fn is_throttled(last_publish_us: Option<u64>, now_us: u64, fps: u16) -> bool {
    fps == 0
        || last_publish_us.is_some_and(|last| now_us.saturating_sub(last) < frame_interval_us(fps))
}

fn reason_for_grpc_error(error: super::grpc::GrpcError) -> PreviewReason {
    match error {
        super::grpc::GrpcError::Unavailable => PreviewReason::Unavailable,
        super::grpc::GrpcError::Unauthenticated => PreviewReason::Unauthenticated,
        super::grpc::GrpcError::Unsupported => PreviewReason::Unsupported,
    }
}

pub(crate) async fn run_vaf1_worker(
    generation: u64,
    requested_fps: Arc<Mutex<u16>>,
    slot: Arc<LatestSlot>,
    first_preview: Arc<FirstPreviewGate>,
    health: Arc<PreviewHealth>,
    control: tokio::sync::watch::Receiver<PreviewControl>,
    factory: Arc<dyn ScreenshotStreamFactory>,
    sink: Arc<dyn PreviewEventSink>,
    clock: Arc<dyn Clock>,
    gpu_software: bool,
) -> WorkerOutcome {
    run_vaf1_worker_with_open_retry(
        generation,
        requested_fps,
        slot,
        first_preview,
        health,
        control,
        factory,
        sink,
        clock,
        gpu_software,
        None,
    )
    .await
}

pub(crate) async fn run_vaf1_worker_with_open_retry(
    generation: u64,
    requested_fps: Arc<Mutex<u16>>,
    slot: Arc<LatestSlot>,
    first_preview: Arc<FirstPreviewGate>,
    health: Arc<PreviewHealth>,
    mut control: tokio::sync::watch::Receiver<PreviewControl>,
    factory: Arc<dyn ScreenshotStreamFactory>,
    sink: Arc<dyn PreviewEventSink>,
    clock: Arc<dyn Clock>,
    gpu_software: bool,
    open_retry: Option<OpenRetry>,
) -> WorkerOutcome {
    let mut seq = SessionSeq::new();
    let mut orientation = Orientation::Portrait;
    let mut last_publish_us = None;
    let mut state_emitted = false;
    let mut open_fail_started_us = None;
    let mut open_attempts = 0u32;

    loop {
        let initial_control = *control.borrow();
        if initial_control.stop {
            slot.clear();
            let error = FirstPreviewError::Cancelled;
            health.terminal(error.clone());
            first_preview.fail(error);
            return WorkerOutcome::Stopped;
        }
        if !initial_control.visible {
            slot.clear();
            if control.changed().await.is_err() {
                let error = FirstPreviewError::Cancelled;
                health.terminal(error.clone());
                first_preview.fail(error);
                return WorkerOutcome::Stopped;
            }
            continue;
        }

        let (width, height) = orientation.dimensions();
        let mut open_future = factory.open(width, height);
        let open_result = loop {
            tokio::select! {
                changed = control.changed() => {
                    if changed.is_err() {
                        slot.clear();
                        let error = FirstPreviewError::Cancelled;
                        health.terminal(error.clone());
                        first_preview.fail(error);
                        return WorkerOutcome::Stopped;
                    }
                    let next = *control.borrow_and_update();
                    if next.stop {
                        slot.clear();
                        let error = FirstPreviewError::Cancelled;
                        health.terminal(error.clone());
                        first_preview.fail(error);
                        return WorkerOutcome::Stopped;
                    }
                    if !next.visible {
                        slot.clear();
                        break None;
                    }
                }
                result = open_future.as_mut() => break Some(result),
            }
        };
        let Some(open_result) = open_result else {
            continue;
        };
        let mut stream = match open_result {
            Ok(stream) => {
                open_fail_started_us = None;
                open_attempts = 0;
                stream
            }
            Err(error) => {
                {
                    let final_control = control.borrow();
                    if final_control.stop {
                        slot.clear();
                        let error = FirstPreviewError::Cancelled;
                        health.terminal(error.clone());
                        first_preview.fail(error);
                        return WorkerOutcome::Stopped;
                    }
                    if !final_control.visible {
                        slot.clear();
                        continue;
                    }
                }
                let Some(retry) = open_retry else {
                    health.recovering();
                    return WorkerOutcome::Fallback(reason_for_grpc_error(error));
                };
                let now_us = clock.monotonic_micros();
                let started_us = *open_fail_started_us.get_or_insert(now_us);
                open_attempts = open_attempts.saturating_add(1);
                if now_us.saturating_sub(started_us) >= retry.budget_us
                    || open_attempts >= MAX_OWNED_OPEN_ATTEMPTS
                {
                    health.recovering();
                    return WorkerOutcome::Fallback(reason_for_grpc_error(error));
                }
                tokio::select! {
                    _ = clock.delay_micros(retry.backoff_us) => {}
                    changed = control.changed() => {
                        if changed.is_err() {
                            slot.clear();
                            let error = FirstPreviewError::Cancelled;
                            health.terminal(error.clone());
                            first_preview.fail(error);
                            return WorkerOutcome::Stopped;
                        }
                        let next = *control.borrow_and_update();
                        if next.stop {
                            slot.clear();
                            let error = FirstPreviewError::Cancelled;
                            health.terminal(error.clone());
                            first_preview.fail(error);
                            return WorkerOutcome::Stopped;
                        }
                        if !next.visible {
                            slot.clear();
                        }
                    }
                }
                continue;
            }
        };
        let open_visible = {
            let final_control = control.borrow();
            if final_control.stop {
                slot.clear();
                let error = FirstPreviewError::Cancelled;
                health.terminal(error.clone());
                first_preview.fail(error);
                return WorkerOutcome::Stopped;
            }
            if !final_control.visible {
                false
            } else {
                if !state_emitted {
                    let fps = *requested_fps.lock().expect("Android stream rate poisoned");
                    if let Err(error) = sink.preview_state(PreviewState {
                        generation,
                        source: PreviewSource::Grpc,
                        requested_fps: fps,
                        degraded: gpu_software,
                        reason: gpu_software.then_some(PreviewReason::GpuSoftware),
                    }) {
                        let error = FirstPreviewError::Event(error);
                        health.terminal(error.clone());
                        first_preview.fail(error.clone());
                        return WorkerOutcome::Failed(error);
                    }
                    state_emitted = true;
                }
                true
            }
        };
        if !open_visible {
            slot.clear();
            continue;
        }

        loop {
            tokio::select! {
                changed = control.changed() => {
                    if changed.is_err() {
                        slot.clear();
                        let error = FirstPreviewError::Cancelled;
                        health.terminal(error.clone());
                        first_preview.fail(error);
                        return WorkerOutcome::Stopped;
                    }
                    let next = *control.borrow_and_update();
                    if next.stop {
                        slot.clear();
                        let error = FirstPreviewError::Cancelled;
                        health.terminal(error.clone());
                        first_preview.fail(error);
                        return WorkerOutcome::Stopped;
                    }
                    if !next.visible {
                        slot.clear();
                        break;
                    }
                }
                message = stream.message() => {
                    let image = match message {
                        Ok(Some(image)) => image,
                        Ok(None) => {
                            let final_control = control.borrow();
                            if final_control.stop {
                                slot.clear();
                                let error = FirstPreviewError::Cancelled;
                                health.terminal(error.clone());
                                first_preview.fail(error);
                                return WorkerOutcome::Stopped;
                            }
                            if !final_control.visible {
                                drop(final_control);
                                slot.clear();
                                break;
                            }
                            health.recovering();
                            return WorkerOutcome::Fallback(PreviewReason::Unavailable);
                        }
                        Err(error) => {
                            let final_control = control.borrow();
                            if final_control.stop {
                                slot.clear();
                                let error = FirstPreviewError::Cancelled;
                                health.terminal(error.clone());
                                first_preview.fail(error);
                                return WorkerOutcome::Stopped;
                            }
                            if !final_control.visible {
                                drop(final_control);
                                slot.clear();
                                break;
                            }
                            health.recovering();
                            return WorkerOutcome::Fallback(reason_for_grpc_error(error));
                        }
                    };
                    let frame = match validate_image(&image, clock.as_ref()) {
                        Ok(frame) => frame,
                        Err(_) => {
                            let final_control = control.borrow();
                            if final_control.stop {
                                slot.clear();
                                let error = FirstPreviewError::Cancelled;
                                health.terminal(error.clone());
                                first_preview.fail(error);
                                return WorkerOutcome::Stopped;
                            }
                            if !final_control.visible {
                                drop(final_control);
                                slot.clear();
                                break;
                            }
                            health.recovering();
                            return WorkerOutcome::Fallback(PreviewReason::Unsupported);
                        }
                    };
                    let next_orientation = Orientation::from_frame(frame);
                    if next_orientation != orientation {
                        slot.clear();
                        orientation = next_orientation;
                        break;
                    }
                    let fps = *requested_fps
                        .lock()
                        .expect("Android stream rate poisoned");
                    let now_us = clock.monotonic_micros();
                    if is_throttled(last_publish_us, now_us, fps) {
                        continue;
                    }

                    let final_control = control.borrow();
                    if final_control.stop {
                        slot.clear();
                        let error = FirstPreviewError::Cancelled;
                        health.terminal(error.clone());
                        first_preview.fail(error);
                        return WorkerOutcome::Stopped;
                    }
                    if !final_control.visible {
                        drop(final_control);
                        slot.clear();
                        break;
                    }
                    let next_seq = match seq.next() {
                        Ok(next_seq) => next_seq,
                        Err(_) => {
                            let error = FirstPreviewError::SequenceExhausted;
                            health.terminal(error.clone());
                            first_preview.fail(error.clone());
                            return WorkerOutcome::Failed(error);
                        }
                    };
                    slot.publish(next_seq, frame);
                    if let Err(error) = sink.frame_ready(FrameReady {
                        generation,
                        seq: next_seq,
                    }) {
                        slot.clear();
                        let error = FirstPreviewError::Event(error);
                        health.terminal(error.clone());
                        first_preview.fail(error.clone());
                        return WorkerOutcome::Failed(error);
                    }
                    health.grpc_active();
                    first_preview.ready();
                    last_publish_us = Some(now_us);
                    drop(final_control);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::task::{Context, Poll};
    use tokio::sync::{mpsc, Notify};

    struct FakeClock {
        unix_us: AtomicU64,
        monotonic_us: AtomicU64,
        monotonic_reads: AtomicUsize,
        monotonic_changed: Notify,
    }

    impl FakeClock {
        fn new(unix_us: u64, monotonic_us: u64) -> Self {
            Self {
                unix_us: AtomicU64::new(unix_us),
                monotonic_us: AtomicU64::new(monotonic_us),
                monotonic_reads: AtomicUsize::new(0),
                monotonic_changed: Notify::new(),
            }
        }

        fn set_monotonic(&self, value: u64) {
            self.monotonic_us.store(value, Ordering::Release);
        }

        async fn wait_for_monotonic_reads(&self, expected: usize) {
            loop {
                let changed = self.monotonic_changed.notified();
                if self.monotonic_reads.load(Ordering::Acquire) >= expected {
                    return;
                }
                changed.await;
            }
        }
    }

    impl Clock for FakeClock {
        fn unix_micros(&self) -> u64 {
            self.unix_us.load(Ordering::Acquire)
        }

        fn monotonic_micros(&self) -> u64 {
            self.monotonic_reads.fetch_add(1, Ordering::AcqRel);
            self.monotonic_changed.notify_waiters();
            self.monotonic_us.load(Ordering::Acquire)
        }

        fn delay_micros(&self, micros: u64) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
            self.monotonic_us.fetch_add(micros, Ordering::AcqRel);
            Box::pin(async {})
        }
    }

    fn owned_frame(width: u32, height: u32, payload: Vec<u8>) -> generated::Image {
        generated::Image {
            format: Some(generated::ImageFormat {
                format: generated::image_format::ImgFormat::Rgb888 as i32,
                width,
                height,
            }),
            image: payload,
            seq: 4_000_000_000,
            timestamp_us: 0,
        }
    }

    struct HideOnMonotonicClock {
        unix_us: u64,
        monotonic_us: u64,
        control: tokio::sync::watch::Sender<PreviewControl>,
        fired: AtomicBool,
    }

    impl Clock for HideOnMonotonicClock {
        fn unix_micros(&self) -> u64 {
            self.unix_us
        }

        fn monotonic_micros(&self) -> u64 {
            if !self.fired.swap(true, Ordering::AcqRel) {
                self.control.send_replace(PreviewControl {
                    visible: false,
                    stop: false,
                });
            }
            self.monotonic_us
        }
    }

    type PushedMessage = Result<Option<generated::Image>, super::super::grpc::GrpcError>;

    struct PushStream {
        receiver: mpsc::UnboundedReceiver<PushedMessage>,
        message_count: Arc<AtomicUsize>,
        message_changed: Arc<Notify>,
        cancels: Arc<AtomicUsize>,
    }

    impl ScreenshotStream for PushStream {
        fn message(&mut self) -> StreamMessageFuture<'_> {
            Box::pin(async move {
                let result = self.receiver.recv().await.unwrap_or(Ok(None));
                self.message_count.fetch_add(1, Ordering::AcqRel);
                self.message_changed.notify_waiters();
                result
            })
        }
    }

    impl Drop for PushStream {
        fn drop(&mut self) {
            self.cancels.fetch_add(1, Ordering::AcqRel);
        }
    }

    struct PushStreamFactory {
        receivers: Mutex<VecDeque<mpsc::UnboundedReceiver<PushedMessage>>>,
        requested_sizes: Mutex<Vec<(u32, u32)>>,
        opens: AtomicUsize,
        open_changed: Notify,
        message_count: Arc<AtomicUsize>,
        message_changed: Arc<Notify>,
        cancels: Arc<AtomicUsize>,
    }

    impl PushStreamFactory {
        fn new(stream_count: usize) -> (Arc<Self>, Vec<mpsc::UnboundedSender<PushedMessage>>) {
            let mut senders = Vec::with_capacity(stream_count);
            let mut receivers = VecDeque::with_capacity(stream_count);
            for _ in 0..stream_count {
                let (sender, receiver) = mpsc::unbounded_channel();
                senders.push(sender);
                receivers.push_back(receiver);
            }
            (
                Arc::new(Self {
                    receivers: Mutex::new(receivers),
                    requested_sizes: Mutex::new(Vec::new()),
                    opens: AtomicUsize::new(0),
                    open_changed: Notify::new(),
                    message_count: Arc::new(AtomicUsize::new(0)),
                    message_changed: Arc::new(Notify::new()),
                    cancels: Arc::new(AtomicUsize::new(0)),
                }),
                senders,
            )
        }

        async fn wait_for_opens(&self, expected: usize) {
            loop {
                let changed = self.open_changed.notified();
                if self.opens.load(Ordering::Acquire) >= expected {
                    return;
                }
                changed.await;
            }
        }

        async fn wait_for_messages(&self, expected: usize) {
            loop {
                let changed = self.message_changed.notified();
                if self.message_count.load(Ordering::Acquire) >= expected {
                    return;
                }
                changed.await;
            }
        }

        fn requested_sizes(&self) -> Vec<(u32, u32)> {
            self.requested_sizes.lock().unwrap().clone()
        }
    }

    impl ScreenshotStreamFactory for PushStreamFactory {
        fn open(&self, width: u32, height: u32) -> OpenStreamFuture<'_> {
            self.requested_sizes.lock().unwrap().push((width, height));
            self.opens.fetch_add(1, Ordering::AcqRel);
            self.open_changed.notify_waiters();
            let stream = self
                .receivers
                .lock()
                .unwrap()
                .pop_front()
                .map(|receiver| {
                    Box::new(PushStream {
                        receiver,
                        message_count: self.message_count.clone(),
                        message_changed: self.message_changed.clone(),
                        cancels: self.cancels.clone(),
                    }) as Box<dyn ScreenshotStream>
                })
                .ok_or(super::super::grpc::GrpcError::Unavailable);
            Box::pin(async move { stream })
        }
    }

    struct FailingStreamFactory(super::super::grpc::GrpcError);

    impl ScreenshotStreamFactory for FailingStreamFactory {
        fn open(&self, _width: u32, _height: u32) -> OpenStreamFuture<'_> {
            let error = self.0;
            Box::pin(async move { Err(error) })
        }
    }

    struct RaceOpenFuture {
        control: tokio::sync::watch::Sender<PreviewControl>,
        next_control: PreviewControl,
        error: super::super::grpc::GrpcError,
        polled: Arc<Notify>,
        fired: bool,
    }

    impl Future for RaceOpenFuture {
        type Output = Result<Box<dyn ScreenshotStream>, super::super::grpc::GrpcError>;

        fn poll(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Self::Output> {
            if !self.fired {
                self.fired = true;
                self.control.send_replace(self.next_control);
                self.polled.notify_waiters();
            }
            Poll::Ready(Err(self.error))
        }
    }

    struct RaceOpenFactory {
        control: tokio::sync::watch::Sender<PreviewControl>,
        next_control: PreviewControl,
        error: super::super::grpc::GrpcError,
        polled: Arc<Notify>,
    }

    impl RaceOpenFactory {
        fn new(
            control: tokio::sync::watch::Sender<PreviewControl>,
            next_control: PreviewControl,
            error: super::super::grpc::GrpcError,
        ) -> Arc<Self> {
            Arc::new(Self {
                control,
                next_control,
                error,
                polled: Arc::new(Notify::new()),
            })
        }

        async fn wait_for_poll(&self) {
            let polled = self.polled.notified();
            polled.await;
        }
    }

    impl ScreenshotStreamFactory for RaceOpenFactory {
        fn open(&self, _width: u32, _height: u32) -> OpenStreamFuture<'_> {
            Box::pin(RaceOpenFuture {
                control: self.control.clone(),
                next_control: self.next_control,
                error: self.error,
                polled: self.polled.clone(),
                fired: false,
            })
        }
    }

    struct OpenSuccessStream;

    impl ScreenshotStream for OpenSuccessStream {
        fn message(&mut self) -> StreamMessageFuture<'_> {
            Box::pin(std::future::pending::<PushedMessage>())
        }
    }

    struct OpenSuccessFuture {
        control: tokio::sync::watch::Sender<PreviewControl>,
        next_control: Option<PreviewControl>,
        polled: Arc<AtomicUsize>,
        poll_changed: Arc<Notify>,
    }

    impl Future for OpenSuccessFuture {
        type Output = Result<Box<dyn ScreenshotStream>, super::super::grpc::GrpcError>;

        fn poll(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Self::Output> {
            if let Some(next_control) = self.next_control.take() {
                self.control.send_replace(next_control);
            }
            self.polled.fetch_add(1, Ordering::AcqRel);
            self.poll_changed.notify_waiters();
            Poll::Ready(Ok(Box::new(OpenSuccessStream) as Box<dyn ScreenshotStream>))
        }
    }

    struct RaceOpenSuccessFactory {
        control: tokio::sync::watch::Sender<PreviewControl>,
        first_control: PreviewControl,
        opens: AtomicUsize,
        open_changed: Notify,
        polled: Arc<AtomicUsize>,
        poll_changed: Arc<Notify>,
    }

    impl RaceOpenSuccessFactory {
        fn new(
            control: tokio::sync::watch::Sender<PreviewControl>,
            first_control: PreviewControl,
        ) -> Arc<Self> {
            Arc::new(Self {
                control,
                first_control,
                opens: AtomicUsize::new(0),
                open_changed: Notify::new(),
                polled: Arc::new(AtomicUsize::new(0)),
                poll_changed: Arc::new(Notify::new()),
            })
        }

        async fn wait_for_polls(&self, expected: usize) {
            loop {
                let changed = self.poll_changed.notified();
                if self.polled.load(Ordering::Acquire) >= expected {
                    return;
                }
                changed.await;
            }
        }

        fn opens(&self) -> usize {
            self.opens.load(Ordering::Acquire)
        }
    }

    impl ScreenshotStreamFactory for RaceOpenSuccessFactory {
        fn open(&self, _width: u32, _height: u32) -> OpenStreamFuture<'_> {
            let open_number = self.opens.fetch_add(1, Ordering::AcqRel) + 1;
            self.open_changed.notify_waiters();
            let next_control = (open_number == 1).then_some(self.first_control);
            Box::pin(OpenSuccessFuture {
                control: self.control.clone(),
                next_control,
                polled: self.polled.clone(),
                poll_changed: self.poll_changed.clone(),
            })
        }
    }

    struct RaceMessageFuture {
        control: tokio::sync::watch::Sender<PreviewControl>,
        next_control: PreviewControl,
        result: Option<PushedMessage>,
        polled: Arc<Notify>,
        fired: bool,
    }

    impl Future for RaceMessageFuture {
        type Output = PushedMessage;

        fn poll(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Self::Output> {
            if !self.fired {
                self.fired = true;
                self.control.send_replace(self.next_control);
                self.polled.notify_waiters();
            }
            Poll::Ready(self.result.take().expect("race message polled once"))
        }
    }

    struct RaceMessageStream {
        control: tokio::sync::watch::Sender<PreviewControl>,
        next_control: PreviewControl,
        result: Option<PushedMessage>,
        polled: Arc<Notify>,
        cancels: Arc<AtomicUsize>,
    }

    impl ScreenshotStream for RaceMessageStream {
        fn message(&mut self) -> StreamMessageFuture<'_> {
            Box::pin(RaceMessageFuture {
                control: self.control.clone(),
                next_control: self.next_control,
                result: self.result.take(),
                polled: self.polled.clone(),
                fired: false,
            })
        }
    }

    impl Drop for RaceMessageStream {
        fn drop(&mut self) {
            self.cancels.fetch_add(1, Ordering::AcqRel);
        }
    }

    struct RaceMessageFactory {
        control: tokio::sync::watch::Sender<PreviewControl>,
        next_control: PreviewControl,
        result: Mutex<Option<PushedMessage>>,
        polled: Arc<Notify>,
        cancels: Arc<AtomicUsize>,
    }

    impl RaceMessageFactory {
        fn new(
            control: tokio::sync::watch::Sender<PreviewControl>,
            next_control: PreviewControl,
            result: PushedMessage,
        ) -> Arc<Self> {
            Arc::new(Self {
                control,
                next_control,
                result: Mutex::new(Some(result)),
                polled: Arc::new(Notify::new()),
                cancels: Arc::new(AtomicUsize::new(0)),
            })
        }

        async fn wait_for_poll(&self) {
            let polled = self.polled.notified();
            polled.await;
        }
    }

    impl ScreenshotStreamFactory for RaceMessageFactory {
        fn open(&self, _width: u32, _height: u32) -> OpenStreamFuture<'_> {
            let result = self
                .result
                .lock()
                .unwrap()
                .take()
                .expect("race stream opened once");
            let stream = RaceMessageStream {
                control: self.control.clone(),
                next_control: self.next_control,
                result: Some(result),
                polled: self.polled.clone(),
                cancels: self.cancels.clone(),
            };
            Box::pin(async move { Ok(Box::new(stream) as Box<dyn ScreenshotStream>) })
        }
    }

    struct PendingMessageFuture {
        polls: Arc<AtomicUsize>,
        poll_changed: Arc<Notify>,
        drops: Arc<AtomicUsize>,
        observed_poll: bool,
    }

    impl Future for PendingMessageFuture {
        type Output = PushedMessage;

        fn poll(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Self::Output> {
            if !self.observed_poll {
                self.observed_poll = true;
                self.polls.fetch_add(1, Ordering::AcqRel);
                self.poll_changed.notify_waiters();
            }
            Poll::Pending
        }
    }

    impl Drop for PendingMessageFuture {
        fn drop(&mut self) {
            self.drops.fetch_add(1, Ordering::AcqRel);
        }
    }

    struct PendingMessageStream {
        polls: Arc<AtomicUsize>,
        poll_changed: Arc<Notify>,
        drops: Arc<AtomicUsize>,
    }

    impl ScreenshotStream for PendingMessageStream {
        fn message(&mut self) -> StreamMessageFuture<'_> {
            Box::pin(PendingMessageFuture {
                polls: self.polls.clone(),
                poll_changed: self.poll_changed.clone(),
                drops: self.drops.clone(),
                observed_poll: false,
            })
        }
    }

    #[derive(Default)]
    struct PendingMessageFactory {
        polls: Arc<AtomicUsize>,
        poll_changed: Arc<Notify>,
        drops: Arc<AtomicUsize>,
    }

    impl PendingMessageFactory {
        async fn wait_for_polls(&self, expected: usize) {
            loop {
                let changed = self.poll_changed.notified();
                if self.polls.load(Ordering::Acquire) >= expected {
                    return;
                }
                changed.await;
            }
        }
    }

    impl ScreenshotStreamFactory for PendingMessageFactory {
        fn open(&self, _width: u32, _height: u32) -> OpenStreamFuture<'_> {
            let stream = PendingMessageStream {
                polls: self.polls.clone(),
                poll_changed: self.poll_changed.clone(),
                drops: self.drops.clone(),
            };
            Box::pin(async move { Ok(Box::new(stream) as Box<dyn ScreenshotStream>) })
        }
    }

    struct FailingPreviewSink {
        state_error: Option<String>,
        frame_error: Option<String>,
        state_calls: AtomicUsize,
        states: Mutex<Vec<PreviewState>>,
        frames: Mutex<Vec<FrameReady>>,
    }

    impl FailingPreviewSink {
        fn new(state_error: Option<&str>, frame_error: Option<&str>) -> Arc<Self> {
            Arc::new(Self {
                state_error: state_error.map(str::to_owned),
                frame_error: frame_error.map(str::to_owned),
                state_calls: AtomicUsize::new(0),
                states: Mutex::new(Vec::new()),
                frames: Mutex::new(Vec::new()),
            })
        }

        fn state_calls(&self) -> usize {
            self.state_calls.load(Ordering::Acquire)
        }

        fn states(&self) -> Vec<PreviewState> {
            self.states.lock().unwrap().clone()
        }

        fn frames(&self) -> Vec<FrameReady> {
            self.frames.lock().unwrap().clone()
        }
    }

    impl PreviewEventSink for FailingPreviewSink {
        fn frame_ready(&self, event: FrameReady) -> Result<(), String> {
            if let Some(error) = &self.frame_error {
                return Err(error.clone());
            }
            self.frames.lock().unwrap().push(event);
            Ok(())
        }

        fn preview_state(&self, state: PreviewState) -> Result<(), String> {
            self.state_calls.fetch_add(1, Ordering::AcqRel);
            if let Some(error) = &self.state_error {
                return Err(error.clone());
            }
            self.states.lock().unwrap().push(state);
            Ok(())
        }
    }

    struct PendingOpenFuture {
        observed_poll: bool,
        polls: Arc<AtomicUsize>,
        poll_changed: Arc<Notify>,
        drops: Arc<AtomicUsize>,
    }

    impl Future for PendingOpenFuture {
        type Output = Result<Box<dyn ScreenshotStream>, super::super::grpc::GrpcError>;

        fn poll(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Self::Output> {
            if !self.observed_poll {
                self.observed_poll = true;
                self.polls.fetch_add(1, Ordering::AcqRel);
                self.poll_changed.notify_waiters();
            }
            Poll::Pending
        }
    }

    impl Drop for PendingOpenFuture {
        fn drop(&mut self) {
            self.drops.fetch_add(1, Ordering::AcqRel);
        }
    }

    #[derive(Default)]
    struct PendingOpenFactory {
        polls: Arc<AtomicUsize>,
        poll_changed: Arc<Notify>,
        drops: Arc<AtomicUsize>,
    }

    impl PendingOpenFactory {
        async fn wait_for_polls(&self, expected: usize) {
            loop {
                let changed = self.poll_changed.notified();
                if self.polls.load(Ordering::Acquire) >= expected {
                    return;
                }
                changed.await;
            }
        }
    }

    impl ScreenshotStreamFactory for PendingOpenFactory {
        fn open(&self, _width: u32, _height: u32) -> OpenStreamFuture<'_> {
            Box::pin(PendingOpenFuture {
                observed_poll: false,
                polls: self.polls.clone(),
                poll_changed: self.poll_changed.clone(),
                drops: self.drops.clone(),
            })
        }
    }

    #[derive(Default)]
    struct RecordingPreviewSink {
        states: Mutex<Vec<PreviewState>>,
        frames: Mutex<Vec<FrameReady>>,
        frame_changed: Notify,
    }

    impl RecordingPreviewSink {
        fn states(&self) -> Vec<PreviewState> {
            self.states.lock().unwrap().clone()
        }

        fn frames(&self) -> Vec<FrameReady> {
            self.frames.lock().unwrap().clone()
        }

        async fn wait_for_frames(&self, expected: usize) {
            loop {
                let changed = self.frame_changed.notified();
                if self.frames.lock().unwrap().len() >= expected {
                    return;
                }
                changed.await;
            }
        }
    }

    impl PreviewEventSink for RecordingPreviewSink {
        fn frame_ready(&self, event: FrameReady) -> Result<(), String> {
            self.frames.lock().unwrap().push(event);
            self.frame_changed.notify_waiters();
            Ok(())
        }

        fn preview_state(&self, state: PreviewState) -> Result<(), String> {
            self.states.lock().unwrap().push(state);
            Ok(())
        }
    }

    fn worker_image(width: u32, height: u32, emulator_seq: u32) -> generated::Image {
        generated::Image {
            format: Some(generated::ImageFormat {
                format: generated::image_format::ImgFormat::Rgb888 as i32,
                width,
                height,
            }),
            image: vec![0; width as usize * height as usize * 3],
            seq: emulator_seq,
            timestamp_us: 1,
        }
    }

    #[test]
    fn generation_starts_at_one_is_monotonic_and_saturates() {
        let counter = AtomicU64::new(0);
        assert_eq!(next_preview_generation(&counter), Ok(1));
        assert_eq!(next_preview_generation(&counter), Ok(2));
        counter.store(MAX_SAFE_GENERATION - 1, Ordering::Release);
        assert_eq!(next_preview_generation(&counter), Ok(MAX_SAFE_GENERATION));
        assert_eq!(
            next_preview_generation(&counter),
            Err(GenerationError::Exhausted)
        );
        assert_eq!(counter.load(Ordering::Acquire), MAX_SAFE_GENERATION);
    }

    #[test]
    fn optional_transport_keeps_three_effective_modes_and_rates() {
        assert_eq!(PreviewMode::from_wire(None), PreviewMode::LegacyPrimary);
        assert_eq!(
            PreviewMode::from_wire(Some(PreviewTransport::Vaf1)),
            PreviewMode::Vaf1
        );
        assert_eq!(
            PreviewMode::from_wire(Some(PreviewTransport::LegacyPng)),
            PreviewMode::LegacyFallback
        );
        assert_eq!(PreviewMode::LegacyPrimary.capture_fps(2, 1.0), 2.0);
        assert_eq!(PreviewMode::LegacyFallback.capture_fps(60, 1.0), 1.0);
        assert_eq!(PreviewMode::Vaf1.capture_fps(60, 1.0), 1.0);
    }

    #[test]
    fn wire_json_matches_renderer_golden_literals() {
        assert_eq!(
            serde_json::to_string(&PreviewReadError::StaleGeneration {
                current_generation: 7
            })
            .unwrap(),
            r#"{"code":"stale_generation","currentGeneration":7}"#
        );
        for (error, expected) in [
            (PreviewReadError::NoFrame, r#"{"code":"no_frame"}"#),
            (PreviewReadError::Unavailable, r#"{"code":"unavailable"}"#),
            (
                PreviewReadError::Unauthenticated,
                r#"{"code":"unauthenticated"}"#,
            ),
            (PreviewReadError::Unsupported, r#"{"code":"unsupported"}"#),
        ] {
            assert_eq!(serde_json::to_string(&error).unwrap(), expected);
        }
        assert_eq!(
            serde_json::to_string(&PreviewState {
                generation: 7,
                source: PreviewSource::AdbFallback,
                requested_fps: 60,
                degraded: true,
                reason: Some(PreviewReason::Unauthenticated),
            })
            .unwrap(),
            r#"{"generation":7,"source":"adbFallback","requestedFps":60,"degraded":true,"reason":"unauthenticated"}"#
        );
        assert_eq!(
            serde_json::to_string(&FrameReady {
                generation: 7,
                seq: 1
            })
            .unwrap(),
            r#"{"generation":7,"seq":1}"#
        );
    }

    #[test]
    fn validation_borrows_payload_and_rejects_before_slot() {
        let clock = FakeClock::new(55, 55);
        let portrait = owned_frame(720, 1600, vec![0; 720 * 1600 * 3]);
        let validated = validate_image(&portrait, &clock).unwrap();
        assert_eq!(validated.timestamp_us, 55);
        assert_eq!((validated.width, validated.height), (720, 1600));
        assert_eq!(validated.payload.as_ptr(), portrait.image.as_ptr());

        let outside = owned_frame(721, 1600, vec![0; 721 * 1600 * 3]);
        assert_eq!(
            validate_image(&outside, &clock),
            Err(FrameError::OutsideBoundingBox)
        );
        let empty = owned_frame(0, 1, Vec::new());
        assert_eq!(
            validate_image(&empty, &clock),
            Err(FrameError::EmptyDimensions)
        );
        let short = owned_frame(1, 1, vec![1, 2]);
        assert_eq!(
            validate_image(&short, &clock),
            Err(FrameError::PayloadLength)
        );
    }

    #[test]
    fn vaf1_and_slot_are_exact_latest_only_and_generation_strict() {
        let clock = FakeClock::new(99, 99);
        let image = owned_frame(2, 1, vec![1, 2, 3, 4, 5, 6]);
        let slot = LatestSlot::new(7);
        slot.publish(1, validate_image(&image, &clock).unwrap());
        assert_eq!(
            slot.take(8),
            Err(PreviewReadError::StaleGeneration {
                current_generation: 7
            })
        );
        let bytes = slot.take(7).unwrap();
        assert_eq!(&bytes[0..4], b"VAF1");
        assert_eq!(u64::from_le_bytes(bytes[4..12].try_into().unwrap()), 7);
        assert_eq!(u32::from_le_bytes(bytes[12..16].try_into().unwrap()), 1);
        assert_eq!(u64::from_le_bytes(bytes[16..24].try_into().unwrap()), 99);
        assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(bytes[28..32].try_into().unwrap()), 1);
        assert_eq!(bytes[32], 1);
        assert_eq!(&bytes[33..36], &[0, 0, 0]);
        assert_eq!(&bytes[36..], image.image.as_slice());
        assert_eq!(bytes.len(), 42);
        assert_eq!(slot.dropped(), 0);

        let one = owned_frame(1, 1, vec![7, 8, 9]);
        let two = owned_frame(1, 1, vec![10, 11, 12]);
        slot.publish(2, validate_image(&one, &clock).unwrap());
        slot.publish(3, validate_image(&two, &clock).unwrap());
        assert_eq!(slot.dropped(), 1);
        slot.clear();
        assert_eq!(slot.current_generation(), 7);
        assert_eq!(slot.dropped(), 1);
        assert_eq!(
            slot.take(8),
            Err(PreviewReadError::StaleGeneration {
                current_generation: 7
            })
        );
        assert_eq!(slot.take(7), Err(PreviewReadError::NoFrame));
    }

    #[test]
    fn slot_materializes_once_before_acquiring_the_replace_lock() {
        let clock = FakeClock::new(99, 99);
        let image = owned_frame(2, 1, vec![1, 2, 3, 4, 5, 6]);
        let slot = LatestSlot::new(7);
        slot.publish_with_materialization_probe(1, validate_image(&image, &clock).unwrap(), || {
            assert!(
                slot.state.try_lock().is_ok(),
                "slot mutex was held while VAF1 bytes were materialized"
            );
        });
        let bytes = slot.take(7).unwrap();
        assert_eq!(&bytes[36..], image.image.as_slice());
    }

    #[test]
    fn session_seq_starts_at_one_and_fails_closed() {
        let mut seq = SessionSeq::new();
        assert_eq!(seq.next(), Ok(1));
        assert_eq!(seq.next(), Ok(2));
        seq.last = u32::MAX;
        assert_eq!(seq.next(), Err(SequenceError::Exhausted));
        assert_eq!(seq.last, u32::MAX);
    }

    #[test]
    fn first_preview_and_runtime_health_are_consultable() {
        let gate = FirstPreviewGate::new();
        let health = PreviewHealth::new();
        assert_eq!(gate.status(), FirstPreviewState::Pending);
        assert_eq!(health.status(), PreviewHealthState::Starting);
        assert!(!health.is_operational());

        health.grpc_active();
        assert!(gate.ready());
        assert_eq!(gate.status(), FirstPreviewState::Ready);
        assert_eq!(health.status(), PreviewHealthState::GrpcActive);
        assert!(health.is_operational());

        health.recovering();
        assert!(!health.is_operational());
        health.adb_active();
        assert!(health.is_operational());
        health.terminal(FirstPreviewError::Unavailable);
        assert_eq!(
            health.status(),
            PreviewHealthState::Terminal(FirstPreviewError::Unavailable)
        );
        assert!(!health.is_operational());
    }

    #[test]
    fn terminal_health_is_absorbing_and_preserves_first_error() {
        let health = PreviewHealth::new();
        health.terminal(FirstPreviewError::Unavailable);

        health.recovering();
        health.grpc_active();
        health.adb_active();
        health.terminal(FirstPreviewError::Unsupported);

        assert_eq!(
            health.status(),
            PreviewHealthState::Terminal(FirstPreviewError::Unavailable)
        );
        assert!(!health.is_operational());
    }

    #[test]
    fn slot_dropped_count_saturates_when_replacing_at_maximum() {
        let clock = FakeClock::new(99, 99);
        let image = owned_frame(2, 1, vec![1, 2, 3, 4, 5, 6]);
        let slot = LatestSlot::new(7);
        slot.publish(1, validate_image(&image, &clock).unwrap());
        slot.state
            .lock()
            .expect("Android latest slot poisoned")
            .dropped = u64::MAX;

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            slot.publish(2, validate_image(&image, &clock).unwrap());
        }));

        assert!(result.is_ok(), "replacing a saturated slot must not panic");
        assert_eq!(slot.dropped(), u64::MAX);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn hidden_race_discards_before_slot_event_and_visible_reopens() {
        let (factory, mut senders) = PushStreamFactory::new(2);
        let first_sender = senders.remove(0);
        let second_sender = senders.remove(0);
        let sink = Arc::new(RecordingPreviewSink::default());
        let slot = Arc::new(LatestSlot::new(7));
        let first_preview = Arc::new(FirstPreviewGate::new());
        let rate = Arc::new(Mutex::new(60));
        let (control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
            visible: true,
            stop: false,
        });
        let clock = Arc::new(HideOnMonotonicClock {
            unix_us: 1,
            monotonic_us: 1_000_000,
            control: control_tx.clone(),
            fired: AtomicBool::new(false),
        });
        let task = tokio::spawn(run_vaf1_worker(
            7,
            rate,
            slot.clone(),
            first_preview,
            Arc::new(PreviewHealth::new()),
            control_rx,
            factory.clone(),
            sink.clone(),
            clock,
            false,
        ));
        factory.wait_for_opens(1).await;
        first_sender.send(Ok(Some(worker_image(2, 3, 99)))).unwrap();
        factory.wait_for_messages(1).await;
        tokio::task::yield_now().await;
        assert_eq!(slot.take(7), Err(PreviewReadError::NoFrame));
        assert!(sink.frames().is_empty());
        assert!(!control_tx.borrow().visible);

        control_tx.send_replace(PreviewControl {
            visible: true,
            stop: false,
        });
        factory.wait_for_opens(2).await;
        control_tx.send_replace(PreviewControl {
            visible: true,
            stop: true,
        });
        assert_eq!(task.await.unwrap(), WorkerOutcome::Stopped);
        drop(second_sender);
        assert!(factory.cancels.load(Ordering::Acquire) >= 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn rotation_reopens_and_preserves_local_sequence() {
        let (factory, mut senders) = PushStreamFactory::new(2);
        let portrait_sender = senders.remove(0);
        let landscape_sender = senders.remove(0);
        let sink = Arc::new(RecordingPreviewSink::default());
        let slot = Arc::new(LatestSlot::new(7));
        let first_preview = Arc::new(FirstPreviewGate::new());
        let clock = Arc::new(FakeClock::new(1, 1_000_000));
        let (control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
            visible: true,
            stop: false,
        });
        let task = tokio::spawn(run_vaf1_worker(
            7,
            Arc::new(Mutex::new(60)),
            slot,
            first_preview,
            Arc::new(PreviewHealth::new()),
            control_rx,
            factory.clone(),
            sink.clone(),
            clock.clone(),
            false,
        ));
        factory.wait_for_opens(1).await;
        portrait_sender
            .send(Ok(Some(worker_image(2, 3, 4_000_000_000))))
            .unwrap();
        sink.wait_for_frames(1).await;
        portrait_sender
            .send(Ok(Some(worker_image(3, 2, 1))))
            .unwrap();
        factory.wait_for_opens(2).await;
        clock.set_monotonic(1_020_000);
        landscape_sender
            .send(Ok(Some(worker_image(3, 2, 2))))
            .unwrap();
        sink.wait_for_frames(2).await;
        assert_eq!(factory.requested_sizes(), vec![(720, 1600), (1600, 720)]);
        assert_eq!(
            sink.frames(),
            vec![
                FrameReady {
                    generation: 7,
                    seq: 1,
                },
                FrameReady {
                    generation: 7,
                    seq: 2,
                },
            ]
        );
        control_tx.send_replace(PreviewControl {
            visible: true,
            stop: true,
        });
        assert_eq!(task.await.unwrap(), WorkerOutcome::Stopped);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn live_cap_discards_before_slot_materialization_and_ignores_emulator_seq() {
        let (factory, mut senders) = PushStreamFactory::new(1);
        let sender = senders.remove(0);
        let sink = Arc::new(RecordingPreviewSink::default());
        let slot = Arc::new(LatestSlot::new(7));
        let rate = Arc::new(Mutex::new(60));
        let clock = Arc::new(FakeClock::new(1, 1_000_000));
        let (control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
            visible: true,
            stop: false,
        });
        let task = tokio::spawn(run_vaf1_worker(
            7,
            rate.clone(),
            slot.clone(),
            Arc::new(FirstPreviewGate::new()),
            Arc::new(PreviewHealth::new()),
            control_rx,
            factory.clone(),
            sink.clone(),
            clock.clone(),
            false,
        ));
        factory.wait_for_opens(1).await;
        sender
            .send(Ok(Some(worker_image(2, 3, 4_000_000_000))))
            .unwrap();
        sink.wait_for_frames(1).await;
        clock.set_monotonic(1_010_000);
        sender.send(Ok(Some(worker_image(2, 3, 3)))).unwrap();
        clock.wait_for_monotonic_reads(2).await;
        assert_eq!(sink.frames().len(), 1);
        assert_eq!(slot.dropped(), 0);
        *rate.lock().unwrap() = 30;
        clock.set_monotonic(1_034_000);
        sender.send(Ok(Some(worker_image(2, 3, 2)))).unwrap();
        sink.wait_for_frames(2).await;
        assert_eq!(sink.frames().last().unwrap().seq, 2);
        assert_eq!(slot.dropped(), 1);
        control_tx.send_replace(PreviewControl {
            visible: true,
            stop: true,
        });
        assert_eq!(task.await.unwrap(), WorkerOutcome::Stopped);
    }

    #[test]
    fn zero_fps_is_fail_closed_without_division() {
        assert!(is_throttled(None, 0, 0));
        assert!(is_throttled(Some(1), 1, 0));
        assert!(is_throttled(Some(1), u64::MAX, 0));
        assert_eq!(frame_interval_us(0), u64::MAX);
        assert_eq!(frame_interval_us(60), 1_000_000 / 60);
        assert_eq!(frame_interval_us(30), 1_000_000 / 30);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn zero_fps_fail_closed_drops_every_frame_without_panic() {
        let (factory, mut senders) = PushStreamFactory::new(1);
        let sender = senders.remove(0);
        let sink = Arc::new(RecordingPreviewSink::default());
        let slot = Arc::new(LatestSlot::new(7));
        let rate = Arc::new(Mutex::new(0));
        let clock = Arc::new(FakeClock::new(1, 1_000_000));
        let (control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
            visible: true,
            stop: false,
        });
        let task = tokio::spawn(run_vaf1_worker(
            7,
            rate,
            slot.clone(),
            Arc::new(FirstPreviewGate::new()),
            Arc::new(PreviewHealth::new()),
            control_rx,
            factory.clone(),
            sink.clone(),
            clock.clone(),
            false,
        ));
        factory.wait_for_opens(1).await;
        sender
            .send(Ok(Some(worker_image(2, 3, 4_000_000_000))))
            .unwrap();
        clock.wait_for_monotonic_reads(1).await;
        assert_eq!(sink.frames().len(), 0);
        assert_eq!(slot.take(7), Err(PreviewReadError::NoFrame));
        control_tx.send_replace(PreviewControl {
            visible: true,
            stop: true,
        });
        assert_eq!(task.await.unwrap(), WorkerOutcome::Stopped);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn pending_open_is_dropped_by_hide_and_stop_without_slot_or_event() {
        let factory = Arc::new(PendingOpenFactory::default());
        let sink = Arc::new(RecordingPreviewSink::default());
        let slot = Arc::new(LatestSlot::new(7));
        let health = Arc::new(PreviewHealth::new());
        let (control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
            visible: true,
            stop: false,
        });
        let task = tokio::spawn(run_vaf1_worker(
            7,
            Arc::new(Mutex::new(60)),
            slot.clone(),
            Arc::new(FirstPreviewGate::new()),
            health.clone(),
            control_rx,
            factory.clone(),
            sink.clone(),
            Arc::new(FakeClock::new(1, 1)),
            false,
        ));

        factory.wait_for_polls(1).await;
        control_tx.send_replace(PreviewControl {
            visible: false,
            stop: false,
        });
        tokio::task::yield_now().await;
        assert_eq!(factory.drops.load(Ordering::Acquire), 1);
        assert!(!task.is_finished());
        assert_eq!(slot.take(7), Err(PreviewReadError::NoFrame));
        assert!(sink.states().is_empty());
        assert!(sink.frames().is_empty());

        control_tx.send_replace(PreviewControl {
            visible: true,
            stop: false,
        });
        factory.wait_for_polls(2).await;
        control_tx.send_replace(PreviewControl {
            visible: true,
            stop: true,
        });
        tokio::task::yield_now().await;
        assert_eq!(factory.drops.load(Ordering::Acquire), 2);
        assert_eq!(task.await.unwrap(), WorkerOutcome::Stopped);
        assert_eq!(
            health.status(),
            PreviewHealthState::Terminal(FirstPreviewError::Cancelled)
        );
        assert_eq!(slot.take(7), Err(PreviewReadError::NoFrame));
        assert!(sink.states().is_empty());
        assert!(sink.frames().is_empty());
    }

    struct FailThenSucceedFactory {
        remaining_failures: AtomicUsize,
        opens: AtomicUsize,
        frame: Mutex<Option<generated::Image>>,
    }

    impl ScreenshotStreamFactory for FailThenSucceedFactory {
        fn open(&self, _width: u32, _height: u32) -> OpenStreamFuture<'_> {
            self.opens.fetch_add(1, Ordering::AcqRel);
            if self.remaining_failures
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |left| {
                    left.checked_sub(1)
                })
                .is_ok()
            {
                return Box::pin(async { Err(super::super::grpc::GrpcError::Unavailable) });
            }
            let frame = self.frame.lock().unwrap().take();
            Box::pin(async move {
                Ok(Box::new(OneShotStream { first: frame }) as Box<dyn ScreenshotStream>)
            })
        }
    }

    struct OneShotStream {
        first: Option<generated::Image>,
    }

    impl ScreenshotStream for OneShotStream {
        fn message(&mut self) -> StreamMessageFuture<'_> {
            match self.first.take() {
                Some(frame) => Box::pin(async move { Ok(Some(frame)) }),
                None => Box::pin(std::future::pending()),
            }
        }
    }

    struct HoldDelayClock {
        monotonic_us: AtomicU64,
        delay_started: Notify,
        release: Notify,
    }

    impl Clock for HoldDelayClock {
        fn unix_micros(&self) -> u64 {
            1
        }

        fn monotonic_micros(&self) -> u64 {
            self.monotonic_us.load(Ordering::Acquire)
        }

        fn delay_micros(&self, micros: u64) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
            Box::pin(async move {
                self.delay_started.notify_waiters();
                self.release.notified().await;
                self.monotonic_us.fetch_add(micros, Ordering::AcqRel);
            })
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn owned_open_retries_until_success_within_fake_clock_budget() {
        let factory = Arc::new(FailThenSucceedFactory {
            remaining_failures: AtomicUsize::new(2),
            opens: AtomicUsize::new(0),
            frame: Mutex::new(Some(worker_image(2, 3, 4_000_000_000))),
        });
        let sink = Arc::new(RecordingPreviewSink::default());
        let first_preview = Arc::new(FirstPreviewGate::new());
        let (_control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
            visible: true,
            stop: false,
        });
        let task = tokio::spawn(run_vaf1_worker_with_open_retry(
            8,
            Arc::new(Mutex::new(60)),
            Arc::new(LatestSlot::new(8)),
            first_preview.clone(),
            Arc::new(PreviewHealth::new()),
            control_rx,
            factory.clone(),
            sink.clone(),
            Arc::new(FakeClock::new(1, 1)),
            false,
            Some(OpenRetry {
                budget_us: 1_000,
                backoff_us: 100,
            }),
        ));
        tokio::time::timeout(std::time::Duration::from_millis(400), sink.wait_for_frames(1))
            .await
            .expect("owned open retry must publish a grpc frame inside the fake-clock budget");
        assert_eq!(factory.opens.load(Ordering::Acquire), 3);
        assert_eq!(first_preview.status(), FirstPreviewState::Ready);
        assert_eq!(
            sink.states()[0].source,
            PreviewSource::Grpc,
            "retry success must stay on grpc, not PNG fallback"
        );
        drop(task);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn owned_open_retry_falls_back_when_fake_clock_budget_expires() {
        let (_control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
            visible: true,
            stop: false,
        });
        let factory = Arc::new(CountingFailFactory::default());
        let outcome = run_vaf1_worker_with_open_retry(
            8,
            Arc::new(Mutex::new(30)),
            Arc::new(LatestSlot::new(8)),
            Arc::new(FirstPreviewGate::new()),
            Arc::new(PreviewHealth::new()),
            control_rx,
            factory.clone(),
            Arc::new(RecordingPreviewSink::default()),
            Arc::new(FakeClock::new(1, 1)),
            false,
            Some(OpenRetry {
                budget_us: 250,
                backoff_us: 100,
            }),
        )
        .await;
        assert_eq!(outcome, WorkerOutcome::Fallback(PreviewReason::Unavailable));
        let opens = factory.opens.load(Ordering::Acquire);
        assert!(opens > 1, "budget retry must probe more than once, got {opens}");
        assert!(opens <= 5, "retry must stay bounded, got {opens}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn open_retry_stop_during_backoff_is_absorbing() {
        let (control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
            visible: true,
            stop: false,
        });
        let clock = Arc::new(HoldDelayClock {
            monotonic_us: AtomicU64::new(1),
            delay_started: Notify::new(),
            release: Notify::new(),
        });
        let first_preview = Arc::new(FirstPreviewGate::new());
        let health = Arc::new(PreviewHealth::new());
        let started = clock.delay_started.notified();
        let task = tokio::spawn(run_vaf1_worker_with_open_retry(
            9,
            Arc::new(Mutex::new(60)),
            Arc::new(LatestSlot::new(9)),
            first_preview.clone(),
            health.clone(),
            control_rx,
            Arc::new(FailingStreamFactory(super::super::grpc::GrpcError::Unavailable)),
            Arc::new(RecordingPreviewSink::default()),
            clock.clone(),
            false,
            Some(OpenRetry {
                budget_us: 2_000_000,
                backoff_us: 100_000,
            }),
        ));
        tokio::time::timeout(std::time::Duration::from_millis(400), started)
            .await
            .expect("owned open retry must enter backoff so cancel can interrupt it");
        control_tx.send_replace(PreviewControl {
            visible: true,
            stop: true,
        });
        clock.release.notify_waiters();
        assert_eq!(task.await.unwrap(), WorkerOutcome::Stopped);
        assert_eq!(
            first_preview.status(),
            FirstPreviewState::Failed(FirstPreviewError::Cancelled)
        );
        assert_eq!(
            health.status(),
            PreviewHealthState::Terminal(FirstPreviewError::Cancelled)
        );
    }

    struct LateReopenFactory {
        opens: AtomicUsize,
        frames: Mutex<Vec<generated::Image>>,
        dropped: Arc<Notify>,
    }

    struct DropOneShotStream {
        first: Option<generated::Image>,
        dropped: Arc<Notify>,
    }

    impl ScreenshotStream for DropOneShotStream {
        fn message(&mut self) -> StreamMessageFuture<'_> {
            match self.first.take() {
                Some(frame) => Box::pin(async move { Ok(Some(frame)) }),
                None => Box::pin(std::future::pending()),
            }
        }
    }

    impl Drop for DropOneShotStream {
        fn drop(&mut self) {
            self.dropped.notify_waiters();
        }
    }

    impl ScreenshotStreamFactory for LateReopenFactory {
        fn open(&self, _width: u32, _height: u32) -> OpenStreamFuture<'_> {
            let n = self.opens.fetch_add(1, Ordering::AcqRel) + 1;
            match n {
                1 | 3 => Box::pin(async { Err(super::super::grpc::GrpcError::Unavailable) }),
                2 | 4 => {
                    let frame = self.frames.lock().unwrap().remove(0);
                    let dropped = self.dropped.clone();
                    Box::pin(async move {
                        Ok(Box::new(DropOneShotStream {
                            first: Some(frame),
                            dropped,
                        }) as Box<dyn ScreenshotStream>)
                    })
                }
                _ => Box::pin(async { Err(super::super::grpc::GrpcError::Unavailable) }),
            }
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn successful_open_resets_retry_budget_so_late_reopen_can_retry() {
        let factory = Arc::new(LateReopenFactory {
            opens: AtomicUsize::new(0),
            frames: Mutex::new(vec![
                worker_image(2, 3, 4_000_000_000),
                worker_image(2, 3, 4_000_000_001),
            ]),
            dropped: Arc::new(Notify::new()),
        });
        let sink = Arc::new(RecordingPreviewSink::default());
        let clock = Arc::new(FakeClock::new(1, 1));
        let (control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
            visible: true,
            stop: false,
        });
        let task = tokio::spawn(run_vaf1_worker_with_open_retry(
            8,
            Arc::new(Mutex::new(60)),
            Arc::new(LatestSlot::new(8)),
            Arc::new(FirstPreviewGate::new()),
            Arc::new(PreviewHealth::new()),
            control_rx,
            factory.clone(),
            sink.clone(),
            clock.clone(),
            false,
            Some(OpenRetry {
                budget_us: 2_000_000,
                backoff_us: 100,
            }),
        ));
        tokio::time::timeout(std::time::Duration::from_millis(400), sink.wait_for_frames(1))
            .await
            .expect("boot race retry must publish the first grpc frame");
        clock.set_monotonic(30_000_000);
        let dropped = factory.dropped.notified();
        control_tx.send_replace(PreviewControl {
            visible: false,
            stop: false,
        });
        tokio::time::timeout(std::time::Duration::from_millis(400), dropped)
            .await
            .expect("hide after 30s must drop the healthy stream so the worker re-opens");
        control_tx.send_replace(PreviewControl {
            visible: true,
            stop: false,
        });
        tokio::time::timeout(std::time::Duration::from_millis(400), sink.wait_for_frames(2))
            .await
            .expect(
                "re-open 30s after a successful stream must get a fresh retry budget, not session-global expiry",
            );
        assert!(
            factory.opens.load(Ordering::Acquire) >= 4,
            "late re-open must fail then retry, got {} opens",
            factory.opens.load(Ordering::Acquire)
        );
        drop(task);
    }

    #[derive(Default)]
    struct CountingFailFactory {
        opens: AtomicUsize,
    }

    impl ScreenshotStreamFactory for CountingFailFactory {
        fn open(&self, _width: u32, _height: u32) -> OpenStreamFuture<'_> {
            self.opens.fetch_add(1, Ordering::AcqRel);
            Box::pin(async { Err(super::super::grpc::GrpcError::Unavailable) })
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn worker_returns_one_typed_outcome_for_each_transport_failure() {
        for (error, expected) in [
            (
                super::super::grpc::GrpcError::Unavailable,
                WorkerOutcome::Fallback(PreviewReason::Unavailable),
            ),
            (
                super::super::grpc::GrpcError::Unauthenticated,
                WorkerOutcome::Fallback(PreviewReason::Unauthenticated),
            ),
            (
                super::super::grpc::GrpcError::Unsupported,
                WorkerOutcome::Fallback(PreviewReason::Unsupported),
            ),
        ] {
            let (_control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
                visible: true,
                stop: false,
            });
            let outcome = run_vaf1_worker(
                8,
                Arc::new(Mutex::new(30)),
                Arc::new(LatestSlot::new(8)),
                Arc::new(FirstPreviewGate::new()),
                Arc::new(PreviewHealth::new()),
                control_rx,
                Arc::new(FailingStreamFactory(error)),
                Arc::new(RecordingPreviewSink::default()),
                Arc::new(FakeClock::new(1, 1)),
                false,
            )
            .await;
            assert_eq!(outcome, expected);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn open_error_rechecks_stop_and_hide_before_fallback() {
        for next_control in [
            PreviewControl {
                visible: true,
                stop: true,
            },
            PreviewControl {
                visible: false,
                stop: false,
            },
        ] {
            let (control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
                visible: true,
                stop: false,
            });
            let factory = RaceOpenFactory::new(
                control_tx.clone(),
                next_control,
                super::super::grpc::GrpcError::Unavailable,
            );
            let slot = Arc::new(LatestSlot::new(9));
            let first_preview = Arc::new(FirstPreviewGate::new());
            let health = Arc::new(PreviewHealth::new());
            let sink = Arc::new(RecordingPreviewSink::default());
            let task = tokio::spawn(run_vaf1_worker(
                9,
                Arc::new(Mutex::new(60)),
                slot.clone(),
                first_preview.clone(),
                health.clone(),
                control_rx,
                factory.clone(),
                sink.clone(),
                Arc::new(FakeClock::new(1, 1)),
                false,
            ));

            factory.wait_for_poll().await;
            tokio::task::yield_now().await;
            if !next_control.stop {
                control_tx.send_replace(PreviewControl {
                    visible: true,
                    stop: true,
                });
            }
            assert_eq!(task.await.unwrap(), WorkerOutcome::Stopped);
            assert_eq!(
                first_preview.status(),
                FirstPreviewState::Failed(FirstPreviewError::Cancelled)
            );
            assert_eq!(
                health.status(),
                PreviewHealthState::Terminal(FirstPreviewError::Cancelled)
            );
            assert_eq!(slot.take(9), Err(PreviewReadError::NoFrame));
            assert!(sink.states().is_empty());
            assert!(sink.frames().is_empty());
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn open_success_rechecks_stop_before_preview_state() {
        let (control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
            visible: true,
            stop: false,
        });
        let factory = RaceOpenSuccessFactory::new(
            control_tx,
            PreviewControl {
                visible: true,
                stop: true,
            },
        );
        let sink = Arc::new(RecordingPreviewSink::default());
        let slot = Arc::new(LatestSlot::new(14));
        let first_preview = Arc::new(FirstPreviewGate::new());
        let health = Arc::new(PreviewHealth::new());
        let task = tokio::spawn(run_vaf1_worker(
            14,
            Arc::new(Mutex::new(60)),
            slot.clone(),
            first_preview.clone(),
            health.clone(),
            control_rx,
            factory.clone(),
            sink.clone(),
            Arc::new(FakeClock::new(1, 1)),
            false,
        ));

        factory.wait_for_polls(1).await;
        assert_eq!(task.await.unwrap(), WorkerOutcome::Stopped);
        assert_eq!(
            first_preview.status(),
            FirstPreviewState::Failed(FirstPreviewError::Cancelled)
        );
        assert_eq!(
            health.status(),
            PreviewHealthState::Terminal(FirstPreviewError::Cancelled)
        );
        assert_eq!(slot.take(14), Err(PreviewReadError::NoFrame));
        assert!(sink.states().is_empty());
        assert!(sink.frames().is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn open_success_hide_waits_without_state_until_visible_reopen() {
        let (control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
            visible: true,
            stop: false,
        });
        let factory = RaceOpenSuccessFactory::new(
            control_tx.clone(),
            PreviewControl {
                visible: false,
                stop: false,
            },
        );
        let sink = Arc::new(RecordingPreviewSink::default());
        let slot = Arc::new(LatestSlot::new(15));
        let first_preview = Arc::new(FirstPreviewGate::new());
        let health = Arc::new(PreviewHealth::new());
        let task = tokio::spawn(run_vaf1_worker(
            15,
            Arc::new(Mutex::new(60)),
            slot.clone(),
            first_preview.clone(),
            health.clone(),
            control_rx,
            factory.clone(),
            sink.clone(),
            Arc::new(FakeClock::new(1, 1)),
            false,
        ));

        factory.wait_for_polls(1).await;
        tokio::task::yield_now().await;
        assert_eq!(factory.opens(), 1);
        assert!(!task.is_finished());
        assert_eq!(slot.take(15), Err(PreviewReadError::NoFrame));
        assert!(sink.states().is_empty());
        assert!(sink.frames().is_empty());

        control_tx.send_replace(PreviewControl {
            visible: true,
            stop: false,
        });
        factory.wait_for_polls(2).await;
        tokio::task::yield_now().await;
        assert_eq!(factory.opens(), 2);
        assert_eq!(sink.states().len(), 1);
        assert!(sink.frames().is_empty());

        control_tx.send_replace(PreviewControl {
            visible: true,
            stop: true,
        });
        assert_eq!(task.await.unwrap(), WorkerOutcome::Stopped);
        assert_eq!(
            first_preview.status(),
            FirstPreviewState::Failed(FirstPreviewError::Cancelled)
        );
        assert_eq!(
            health.status(),
            PreviewHealthState::Terminal(FirstPreviewError::Cancelled)
        );
        assert_eq!(slot.take(15), Err(PreviewReadError::NoFrame));
        assert_eq!(sink.states().len(), 1);
        assert!(sink.frames().is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn open_success_stop_never_calls_failing_preview_state_sink() {
        let (control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
            visible: true,
            stop: false,
        });
        let factory = RaceOpenSuccessFactory::new(
            control_tx,
            PreviewControl {
                visible: true,
                stop: true,
            },
        );
        let sink = FailingPreviewSink::new(Some("state sink"), None);
        let slot = Arc::new(LatestSlot::new(16));
        let first_preview = Arc::new(FirstPreviewGate::new());
        let health = Arc::new(PreviewHealth::new());
        let task = tokio::spawn(run_vaf1_worker(
            16,
            Arc::new(Mutex::new(60)),
            slot.clone(),
            first_preview.clone(),
            health.clone(),
            control_rx,
            factory.clone(),
            sink.clone(),
            Arc::new(FakeClock::new(1, 1)),
            false,
        ));

        factory.wait_for_polls(1).await;
        assert_eq!(task.await.unwrap(), WorkerOutcome::Stopped);
        assert_eq!(sink.state_calls(), 0);
        assert!(sink.states().is_empty());
        assert!(sink.frames().is_empty());
        assert_eq!(
            first_preview.status(),
            FirstPreviewState::Failed(FirstPreviewError::Cancelled)
        );
        assert_eq!(
            health.status(),
            PreviewHealthState::Terminal(FirstPreviewError::Cancelled)
        );
        assert_eq!(slot.take(16), Err(PreviewReadError::NoFrame));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn message_result_rechecks_stop_and_hide_before_fallback() {
        let cases = [
            (
                PreviewControl {
                    visible: true,
                    stop: true,
                },
                Err(super::super::grpc::GrpcError::Unauthenticated),
            ),
            (
                PreviewControl {
                    visible: false,
                    stop: false,
                },
                Ok(None),
            ),
            (
                PreviewControl {
                    visible: true,
                    stop: true,
                },
                Ok(Some(generated::Image {
                    format: None,
                    image: Vec::new(),
                    seq: 77,
                    timestamp_us: 1,
                })),
            ),
        ];

        for (next_control, result) in cases {
            let (control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
                visible: true,
                stop: false,
            });
            let factory = RaceMessageFactory::new(control_tx.clone(), next_control, result);
            let slot = Arc::new(LatestSlot::new(10));
            let first_preview = Arc::new(FirstPreviewGate::new());
            let health = Arc::new(PreviewHealth::new());
            let sink = Arc::new(RecordingPreviewSink::default());
            let task = tokio::spawn(run_vaf1_worker(
                10,
                Arc::new(Mutex::new(60)),
                slot.clone(),
                first_preview.clone(),
                health.clone(),
                control_rx,
                factory.clone(),
                sink.clone(),
                Arc::new(FakeClock::new(1, 1)),
                false,
            ));

            factory.wait_for_poll().await;
            tokio::task::yield_now().await;
            if !next_control.stop {
                control_tx.send_replace(PreviewControl {
                    visible: true,
                    stop: true,
                });
            }
            assert_eq!(task.await.unwrap(), WorkerOutcome::Stopped);
            assert_eq!(
                first_preview.status(),
                FirstPreviewState::Failed(FirstPreviewError::Cancelled)
            );
            assert_eq!(
                health.status(),
                PreviewHealthState::Terminal(FirstPreviewError::Cancelled)
            );
            assert_eq!(slot.take(10), Err(PreviewReadError::NoFrame));
            assert!(sink.frames().is_empty());
            assert_eq!(sink.states().len(), 1);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn pending_message_is_cancelled_by_hide_and_stop_without_extra_output() {
        let factory = Arc::new(PendingMessageFactory::default());
        let sink = Arc::new(RecordingPreviewSink::default());
        let slot = Arc::new(LatestSlot::new(11));
        let first_preview = Arc::new(FirstPreviewGate::new());
        let health = Arc::new(PreviewHealth::new());
        let (control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
            visible: true,
            stop: false,
        });
        let task = tokio::spawn(run_vaf1_worker(
            11,
            Arc::new(Mutex::new(60)),
            slot.clone(),
            first_preview.clone(),
            health.clone(),
            control_rx,
            factory.clone(),
            sink.clone(),
            Arc::new(FakeClock::new(1, 1)),
            false,
        ));

        factory.wait_for_polls(1).await;
        control_tx.send_replace(PreviewControl {
            visible: false,
            stop: false,
        });
        tokio::task::yield_now().await;
        assert_eq!(factory.drops.load(Ordering::Acquire), 1);
        assert!(!task.is_finished());
        assert_eq!(slot.take(11), Err(PreviewReadError::NoFrame));
        assert_eq!(sink.states().len(), 1);
        assert!(sink.frames().is_empty());
        assert_eq!(first_preview.status(), FirstPreviewState::Pending);

        control_tx.send_replace(PreviewControl {
            visible: true,
            stop: false,
        });
        factory.wait_for_polls(2).await;
        control_tx.send_replace(PreviewControl {
            visible: true,
            stop: true,
        });
        tokio::task::yield_now().await;
        assert_eq!(factory.drops.load(Ordering::Acquire), 2);
        assert_eq!(task.await.unwrap(), WorkerOutcome::Stopped);
        assert_eq!(
            first_preview.status(),
            FirstPreviewState::Failed(FirstPreviewError::Cancelled)
        );
        assert_eq!(
            health.status(),
            PreviewHealthState::Terminal(FirstPreviewError::Cancelled)
        );
        assert_eq!(slot.take(11), Err(PreviewReadError::NoFrame));
        assert_eq!(sink.states().len(), 1);
        assert!(sink.frames().is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn preview_state_and_frame_ready_sink_errors_fail_closed() {
        let (factory, _senders) = PushStreamFactory::new(1);
        let state_sink = FailingPreviewSink::new(Some("state sink"), None);
        let state_gate = Arc::new(FirstPreviewGate::new());
        let state_health = Arc::new(PreviewHealth::new());
        let state_outcome = run_vaf1_worker(
            12,
            Arc::new(Mutex::new(60)),
            Arc::new(LatestSlot::new(12)),
            state_gate.clone(),
            state_health.clone(),
            tokio::sync::watch::channel(PreviewControl {
                visible: true,
                stop: false,
            })
            .1,
            factory,
            state_sink.clone(),
            Arc::new(FakeClock::new(1, 1)),
            false,
        )
        .await;
        let state_error = FirstPreviewError::Event("state sink".to_owned());
        assert_eq!(state_outcome, WorkerOutcome::Failed(state_error.clone()));
        assert_eq!(
            state_gate.status(),
            FirstPreviewState::Failed(state_error.clone())
        );
        assert_eq!(
            state_health.status(),
            PreviewHealthState::Terminal(state_error)
        );
        assert!(state_sink.states().is_empty());
        assert!(state_sink.frames().is_empty());

        let (factory, mut senders) = PushStreamFactory::new(1);
        let sender = senders.remove(0);
        let frame_sink = FailingPreviewSink::new(None, Some("frame sink"));
        let frame_slot = Arc::new(LatestSlot::new(13));
        let frame_gate = Arc::new(FirstPreviewGate::new());
        let frame_health = Arc::new(PreviewHealth::new());
        let (_control_tx, control_rx) = tokio::sync::watch::channel(PreviewControl {
            visible: true,
            stop: false,
        });
        let task = tokio::spawn(run_vaf1_worker(
            13,
            Arc::new(Mutex::new(60)),
            frame_slot.clone(),
            frame_gate.clone(),
            frame_health.clone(),
            control_rx,
            factory.clone(),
            frame_sink.clone(),
            Arc::new(FakeClock::new(1, 1_000_000)),
            false,
        ));
        factory.wait_for_opens(1).await;
        sender.send(Ok(Some(worker_image(2, 3, 1)))).unwrap();
        let frame_error = FirstPreviewError::Event("frame sink".to_owned());
        assert_eq!(
            task.await.unwrap(),
            WorkerOutcome::Failed(frame_error.clone())
        );
        assert_eq!(
            frame_gate.status(),
            FirstPreviewState::Failed(frame_error.clone())
        );
        assert_eq!(
            frame_health.status(),
            PreviewHealthState::Terminal(frame_error)
        );
        assert_eq!(frame_slot.take(13), Err(PreviewReadError::NoFrame));
        assert_eq!(frame_sink.states().len(), 1);
        assert!(frame_sink.frames().is_empty());
    }
}
