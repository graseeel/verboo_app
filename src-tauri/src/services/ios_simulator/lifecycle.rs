use std::sync::{atomic::AtomicBool, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::ownership::IosSimulatorOwnership;
use super::{
    simulator_display_metrics, CommandRunner, IosSimulatorDevice, SimctlDisplayMetrics,
    SimulatorDisplayErrorKind,
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IosSimulatorStartupStage {
    Idle,
    Booting,
    WaitingForDisplay,
    GeneratingFirstPreview,
    PreparingInteraction,
    Ready,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum IosSimulatorRecordingState {
    Idle,
    Starting,
    Recording { started_at_ms: u64 },
    Finalizing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IosSimulatorLifecycleSnapshot {
    pub udid: Option<String>,
    pub device_generation: Option<u64>,
    pub stage: IosSimulatorStartupStage,
    pub ownership: Option<IosSimulatorOwnership>,
    pub preview_suspended: bool,
    pub interaction_ready: bool,
    pub recording: IosSimulatorRecordingState,
    pub recoverable_error: Option<String>,
}

impl Default for IosSimulatorLifecycleSnapshot {
    fn default() -> Self {
        Self {
            udid: None,
            device_generation: None,
            stage: IosSimulatorStartupStage::Idle,
            ownership: None,
            preview_suspended: false,
            interaction_ready: false,
            recording: IosSimulatorRecordingState::Idle,
            recoverable_error: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SimulatorReadinessError {
    pub(crate) kind: SimulatorDisplayErrorKind,
    pub(crate) message: String,
    pub(crate) recoverable: bool,
}

#[derive(Debug, Clone)]
pub(crate) enum LifecycleSignal {
    BootComplete,
    DisplayReady,
    FirstFrameReady,
    InteractionReady,
    InteractionFailed(String),
    PreviewSuspended(bool),
    RecordingChanged(IosSimulatorRecordingState),
    RecoverableError(String),
    ClearRecoverableError,
}

#[derive(Debug, Clone)]
struct LifecycleState {
    snapshot: IosSimulatorLifecycleSnapshot,
    boot_complete: bool,
    display_ready: bool,
    first_frame_ready: bool,
    interaction_ready: bool,
}

pub(crate) struct LifecycleAuthority {
    state: Mutex<LifecycleState>,
    changed: Condvar,
}

pub(crate) struct PreviewGate {
    visible: Mutex<bool>,
    changed: Condvar,
    #[cfg(test)]
    parked_workers: std::sync::atomic::AtomicUsize,
}

impl PreviewGate {
    pub(crate) fn new(visible: bool) -> Self {
        Self {
            visible: Mutex::new(visible),
            changed: Condvar::new(),
            #[cfg(test)]
            parked_workers: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    pub(crate) fn set_visible(&self, visible: bool) {
        *self.visible.lock().expect("preview gate poisoned") = visible;
        self.changed.notify_all();
    }

    pub(crate) fn stop_and_wake(&self, stop: &AtomicBool) {
        stop.store(true, std::sync::atomic::Ordering::Release);
        self.changed.notify_all();
    }

    pub(crate) fn wait_until_visible(&self, stop: &AtomicBool) -> bool {
        let mut visible = self.visible.lock().expect("preview gate poisoned");
        while !*visible && !stop.load(std::sync::atomic::Ordering::Acquire) {
            #[cfg(test)]
            self.parked_workers
                .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            visible = self.changed.wait(visible).expect("preview gate poisoned");
            #[cfg(test)]
            self.parked_workers
                .fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
        }
        !stop.load(std::sync::atomic::Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn parked_workers(&self) -> usize {
        self.parked_workers
            .load(std::sync::atomic::Ordering::Acquire)
    }

    pub(crate) fn is_visible(&self) -> bool {
        *self.visible.lock().expect("preview gate poisoned")
    }
}

impl Default for LifecycleAuthority {
    fn default() -> Self {
        Self {
            state: Mutex::new(LifecycleState {
                snapshot: IosSimulatorLifecycleSnapshot::default(),
                boot_complete: false,
                display_ready: false,
                first_frame_ready: false,
                interaction_ready: false,
            }),
            changed: Condvar::new(),
        }
    }
}

impl LifecycleAuthority {
    pub(crate) fn begin(
        &self,
        generation: u64,
        device: IosSimulatorDevice,
        ownership: IosSimulatorOwnership,
        visible: bool,
    ) -> IosSimulatorLifecycleSnapshot {
        let mut state = self.state.lock().expect("iOS simulator lifecycle poisoned");
        state.boot_complete = false;
        state.display_ready = false;
        state.first_frame_ready = false;
        state.interaction_ready = false;
        state.snapshot = IosSimulatorLifecycleSnapshot {
            udid: Some(device.udid),
            device_generation: Some(generation),
            stage: IosSimulatorStartupStage::Booting,
            ownership: Some(ownership),
            preview_suspended: !visible,
            interaction_ready: false,
            recording: IosSimulatorRecordingState::Idle,
            recoverable_error: None,
        };
        let snapshot = state.snapshot.clone();
        self.changed.notify_all();
        snapshot
    }

    pub(crate) fn transition(&self, generation: u64, signal: LifecycleSignal) -> bool {
        let mut state = self.state.lock().expect("iOS simulator lifecycle poisoned");
        if state.snapshot.device_generation != Some(generation) {
            return false;
        }
        match signal {
            LifecycleSignal::BootComplete => state.boot_complete = true,
            LifecycleSignal::DisplayReady => state.display_ready = true,
            LifecycleSignal::FirstFrameReady => state.first_frame_ready = true,
            LifecycleSignal::InteractionReady => {
                state.interaction_ready = true;
                state.snapshot.interaction_ready = true;
            }
            LifecycleSignal::InteractionFailed(message) => {
                state.interaction_ready = false;
                state.snapshot.interaction_ready = false;
                state.snapshot.recoverable_error = Some(message);
            }
            LifecycleSignal::PreviewSuspended(suspended) => {
                state.snapshot.preview_suspended = suspended;
            }
            LifecycleSignal::RecordingChanged(recording) => {
                state.snapshot.recording = recording;
            }
            LifecycleSignal::RecoverableError(message) => {
                state.snapshot.recoverable_error = Some(message);
            }
            LifecycleSignal::ClearRecoverableError => {
                state.snapshot.recoverable_error = None;
            }
        }
        state.snapshot.stage = derive_stage(&state);
        self.changed.notify_all();
        true
    }

    pub(crate) fn snapshot(&self) -> IosSimulatorLifecycleSnapshot {
        self.state
            .lock()
            .expect("iOS simulator lifecycle poisoned")
            .snapshot
            .clone()
    }

    pub(crate) fn clear(&self, generation: u64) -> bool {
        let mut state = self.state.lock().expect("iOS simulator lifecycle poisoned");
        if state.snapshot.device_generation != Some(generation) {
            return false;
        }
        state.boot_complete = false;
        state.display_ready = false;
        state.first_frame_ready = false;
        state.interaction_ready = false;
        state.snapshot = IosSimulatorLifecycleSnapshot::default();
        self.changed.notify_all();
        true
    }

    pub(crate) fn wait_until_ready(
        &self,
        generation: u64,
        timeout: Duration,
    ) -> Result<IosSimulatorLifecycleSnapshot, String> {
        let deadline = Instant::now() + timeout;
        let mut state = self.state.lock().expect("iOS simulator lifecycle poisoned");
        loop {
            match state.snapshot.device_generation {
                Some(current) if current != generation => {
                    return Err("A prontidão pertence a outra sessão do simulador.".into());
                }
                None => return Err("A sessão do simulador foi encerrada.".into()),
                Some(_) => {}
            }
            if state.snapshot.stage == IosSimulatorStartupStage::Ready
                && state.snapshot.interaction_ready
            {
                return Ok(state.snapshot.clone());
            }
            if let Some(message) = state.snapshot.recoverable_error.as_ref() {
                return Err(message.clone());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("O simulador não ficou pronto dentro do prazo.".into());
            }
            let (next, result) = self
                .changed
                .wait_timeout(state, remaining)
                .expect("iOS simulator lifecycle poisoned");
            state = next;
            if result.timed_out() {
                return Err("O simulador não ficou pronto dentro do prazo.".into());
            }
        }
    }
}

fn derive_stage(state: &LifecycleState) -> IosSimulatorStartupStage {
    if !state.boot_complete {
        return IosSimulatorStartupStage::Booting;
    }
    if !state.display_ready {
        return IosSimulatorStartupStage::WaitingForDisplay;
    }
    if !state.first_frame_ready {
        return IosSimulatorStartupStage::GeneratingFirstPreview;
    }
    if !state.interaction_ready {
        return IosSimulatorStartupStage::PreparingInteraction;
    }
    IosSimulatorStartupStage::Ready
}

pub(crate) fn wait_for_display_metrics(
    runner: &dyn CommandRunner,
    udid: &str,
    timeout: Duration,
    retry_interval: Duration,
) -> Result<SimctlDisplayMetrics, SimulatorReadinessError> {
    let deadline = Instant::now() + timeout;
    loop {
        match simulator_display_metrics(runner, udid) {
            Ok(metrics) => return Ok(metrics),
            Err(error) if error.kind.is_retryable() => {
                if Instant::now() >= deadline {
                    return Err(SimulatorReadinessError {
                        kind: error.kind,
                        message: error.message,
                        recoverable: true,
                    });
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if !retry_interval.is_zero() {
                    thread::sleep(retry_interval.min(remaining));
                } else {
                    thread::yield_now();
                }
            }
            Err(error) => {
                return Err(SimulatorReadinessError {
                    kind: error.kind,
                    message: error.message,
                    recoverable: false,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::sync::Arc;

    fn test_device() -> IosSimulatorDevice {
        IosSimulatorDevice {
            name: "iPhone 17 Pro".into(),
            udid: "phone-17-pro".into(),
            state: "Booted".into(),
            ios_version: "27.0".into(),
            family: super::super::IosSimulatorDeviceFamily::Iphone,
            ownership: Some(IosSimulatorOwnership::External),
        }
    }

    #[test]
    fn readiness_wait_parks_until_the_same_generation_is_fully_ready() {
        let authority = Arc::new(LifecycleAuthority::default());
        authority.begin(7, test_device(), IosSimulatorOwnership::External, true);
        let waiting = authority.clone();
        let (started_tx, started_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let waiter = thread::spawn(move || {
            started_tx.send(()).unwrap();
            result_tx
                .send(waiting.wait_until_ready(7, Duration::from_secs(1)))
                .unwrap();
        });

        started_rx.recv_timeout(Duration::from_millis(100)).unwrap();
        assert!(authority.transition(7, LifecycleSignal::BootComplete));
        assert!(authority.transition(7, LifecycleSignal::DisplayReady));
        assert!(authority.transition(7, LifecycleSignal::FirstFrameReady));
        assert!(authority.transition(7, LifecycleSignal::InteractionReady));

        let snapshot = result_rx
            .recv_timeout(Duration::from_millis(250))
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.stage, IosSimulatorStartupStage::Ready);
        assert!(snapshot.interaction_ready);
        waiter.join().unwrap();
    }

    #[test]
    fn readiness_wait_wakes_when_the_requested_session_is_cleared() {
        let authority = Arc::new(LifecycleAuthority::default());
        authority.begin(8, test_device(), IosSimulatorOwnership::External, true);
        let waiting = authority.clone();
        let (started_tx, started_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let waiter = thread::spawn(move || {
            started_tx.send(()).unwrap();
            result_tx
                .send(waiting.wait_until_ready(8, Duration::from_secs(1)))
                .unwrap();
        });

        started_rx.recv_timeout(Duration::from_millis(100)).unwrap();
        assert!(authority.clear(8));

        let error = result_rx
            .recv_timeout(Duration::from_millis(250))
            .unwrap()
            .unwrap_err();
        assert!(error.contains("encerrada"), "unexpected error: {error}");
        waiter.join().unwrap();
    }

    #[test]
    fn readiness_wait_rejects_a_stale_generation_without_waiting() {
        let authority = LifecycleAuthority::default();
        authority.begin(9, test_device(), IosSimulatorOwnership::External, true);

        let error = authority
            .wait_until_ready(8, Duration::from_secs(1))
            .unwrap_err();

        assert!(error.contains("outra sessão"), "unexpected error: {error}");
    }

    #[test]
    fn stopping_hidden_preview_wakes_waiter_after_stop_is_set() {
        let gate = Arc::new(PreviewGate::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let (started_sender, started_receiver) = mpsc::channel();
        let (finished_sender, finished_receiver) = mpsc::channel();
        let waiting_gate = gate.clone();
        let waiting_stop = stop.clone();
        let waiter = std::thread::spawn(move || {
            started_sender.send(()).unwrap();
            finished_sender
                .send(waiting_gate.wait_until_visible(&waiting_stop))
                .unwrap();
        });

        started_receiver
            .recv_timeout(Duration::from_millis(100))
            .unwrap();
        thread::sleep(Duration::from_millis(20));
        gate.stop_and_wake(&stop);
        assert_eq!(
            finished_receiver
                .recv_timeout(Duration::from_millis(250))
                .unwrap(),
            false
        );
        waiter.join().unwrap();
    }
}
