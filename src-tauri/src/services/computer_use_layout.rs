use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager};

const COMPACT_MIN_WIDTH: f64 = 396.0;
const COMPACT_MIN_HEIGHT: f64 = 560.0;
const LAYOUT_STATE_EVENT: &str = "computer-use:layout-state";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ComputerUseLayoutMode {
    Idle,
    Entering,
    Compact,
    Fallback,
    Restoring,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseLayoutState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub mode: ComputerUseLayoutMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_bundle_id: Option<String>,
}

impl Default for ComputerUseLayoutState {
    fn default() -> Self {
        Self {
            session_id: None,
            mode: ComputerUseLayoutMode::Idle,
            target_bundle_id: None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct CompactWindowSnapshot {
    original_position: tauri::PhysicalPosition<i32>,
    original_size: tauri::PhysicalSize<u32>,
    original_min_size: Option<tauri::LogicalSize<f64>>,
}

#[derive(Debug, Clone)]
struct CompactLayoutLease {
    session_id: String,
    target_bundle_id: String,
    snapshot: CompactWindowSnapshot,
    state: ComputerUseLayoutMode,
}

#[derive(Default)]
struct ComputerUseLayoutMachine {
    active: Option<CompactLayoutLease>,
}

impl ComputerUseLayoutMachine {
    fn state(&self) -> ComputerUseLayoutState {
        self.active
            .as_ref()
            .map(|lease| ComputerUseLayoutState {
                session_id: Some(lease.session_id.clone()),
                mode: lease.state,
                target_bundle_id: Some(lease.target_bundle_id.clone()),
            })
            .unwrap_or_default()
    }

    fn begin(
        &mut self,
        session_id: &str,
        target_bundle_id: &str,
        snapshot: CompactWindowSnapshot,
    ) -> Result<bool, String> {
        if let Some(active) = self.active.as_ref() {
            if active.session_id == session_id {
                return Ok(false);
            }
            return Err("compact layout is owned by another Computer Use session".into());
        }
        self.active = Some(CompactLayoutLease {
            session_id: session_id.to_string(),
            target_bundle_id: target_bundle_id.to_string(),
            snapshot,
            state: ComputerUseLayoutMode::Entering,
        });
        Ok(true)
    }

    fn mark_focus_result(&mut self, session_id: &str, applied: bool) -> Result<(), String> {
        let active = self.active_for_mut(session_id)?;
        active.state = if applied {
            ComputerUseLayoutMode::Compact
        } else {
            ComputerUseLayoutMode::Fallback
        };
        Ok(())
    }

    fn begin_restore(&mut self, session_id: &str) -> Result<bool, String> {
        let active = self.active_for_mut(session_id)?;
        if active.state == ComputerUseLayoutMode::Restoring {
            return Ok(false);
        }
        active.state = ComputerUseLayoutMode::Restoring;
        Ok(true)
    }

    fn finish_restore(&mut self, session_id: &str) -> Result<(), String> {
        let active = self.active.as_ref().ok_or("compact layout is not active")?;
        if active.session_id != session_id {
            return Err("compact layout is owned by another Computer Use session".into());
        }
        self.active = None;
        Ok(())
    }

    fn active_for_mut(&mut self, session_id: &str) -> Result<&mut CompactLayoutLease, String> {
        let active = self.active.as_mut().ok_or("compact layout is not active")?;
        if active.session_id != session_id {
            return Err("compact layout is owned by another Computer Use session".into());
        }
        Ok(active)
    }

    fn snapshot(&self, session_id: &str) -> Result<CompactWindowSnapshot, String> {
        let active = self.active.as_ref().ok_or("compact layout is not active")?;
        if active.session_id != session_id {
            return Err("compact layout is owned by another Computer Use session".into());
        }
        Ok(active.snapshot)
    }
}

#[derive(Default)]
pub struct ComputerUseLayoutService {
    machine: Mutex<ComputerUseLayoutMachine>,
}

impl ComputerUseLayoutService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&self) -> Result<ComputerUseLayoutState, String> {
        self.machine
            .lock()
            .map(|machine| machine.state())
            .map_err(|_| "compact layout lock is poisoned".into())
    }

    pub fn enter(
        &self,
        app: &tauri::AppHandle,
        session_id: &str,
        target_bundle_id: &str,
    ) -> Result<ComputerUseLayoutState, String> {
        let window = app
            .get_webview_window("main")
            .ok_or("main window is unavailable")?;
        let snapshot = CompactWindowSnapshot {
            original_position: window.outer_position().map_err(|error| error.to_string())?,
            original_size: window.outer_size().map_err(|error| error.to_string())?,
            original_min_size: configured_main_min_size(app),
        };
        let began = self
            .machine
            .lock()
            .map_err(|_| "compact layout lock is poisoned".to_string())?
            .begin(session_id, target_bundle_id, snapshot)?;
        if began {
            if let Err(error) = window.set_min_size(Some(tauri::LogicalSize::new(
                COMPACT_MIN_WIDTH,
                COMPACT_MIN_HEIGHT,
            ))) {
                self.mark_focus_result(app, session_id, false)?;
                return Err(format!("lower main window minimum size: {error}"));
            }
            self.emit_state(app)?;
        }
        self.state()
    }

    pub fn mark_focus_result(
        &self,
        app: &tauri::AppHandle,
        session_id: &str,
        applied: bool,
    ) -> Result<ComputerUseLayoutState, String> {
        let snapshot = {
            let mut machine = self
                .machine
                .lock()
                .map_err(|_| "compact layout lock is poisoned".to_string())?;
            let snapshot = machine.snapshot(session_id)?;
            machine.mark_focus_result(session_id, applied)?;
            snapshot
        };
        if !applied {
            restore_main_window(app, snapshot)?;
        }
        self.emit_state(app)?;
        self.state()
    }

    pub fn restore(&self, app: &tauri::AppHandle, session_id: &str) -> Result<bool, String> {
        let snapshot = {
            let mut machine = self
                .machine
                .lock()
                .map_err(|_| "compact layout lock is poisoned".to_string())?;
            let snapshot = match machine.snapshot(session_id) {
                Ok(snapshot) => snapshot,
                Err(error) if error == "compact layout is not active" => return Ok(false),
                Err(error) => return Err(error),
            };
            if !machine.begin_restore(session_id)? {
                return Ok(false);
            }
            snapshot
        };
        self.emit_state(app)?;
        restore_main_window(app, snapshot)?;
        self.machine
            .lock()
            .map_err(|_| "compact layout lock is poisoned".to_string())?
            .finish_restore(session_id)?;
        self.emit_state(app)?;
        Ok(true)
    }

    fn emit_state(&self, app: &tauri::AppHandle) -> Result<(), String> {
        app.emit(LAYOUT_STATE_EVENT, self.state()?)
            .map_err(|error| error.to_string())
    }
}

fn configured_main_min_size(app: &tauri::AppHandle) -> Option<tauri::LogicalSize<f64>> {
    app.config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .and_then(|window| {
            Some(tauri::LogicalSize::new(
                window.min_width?,
                window.min_height?,
            ))
        })
}

fn restore_main_window(
    app: &tauri::AppHandle,
    snapshot: CompactWindowSnapshot,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window is unavailable")?;
    let mut errors = Vec::new();
    if let Err(error) = window.set_position(snapshot.original_position) {
        errors.push(format!("restore main window position: {error}"));
    }
    if let Err(error) = window.set_size(snapshot.original_size) {
        errors.push(format!("restore main window size: {error}"));
    }
    if let Err(error) = window.set_min_size(snapshot.original_min_size) {
        errors.push(format!("restore main window minimum size: {error}"));
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> CompactWindowSnapshot {
        CompactWindowSnapshot {
            original_position: tauri::PhysicalPosition::new(120, 80),
            original_size: tauri::PhysicalSize::new(1280, 840),
            original_min_size: Some(tauri::LogicalSize::new(960.0, 640.0)),
        }
    }

    #[test]
    fn computer_use_layout_follows_the_full_state_machine() {
        let mut machine = ComputerUseLayoutMachine::default();
        assert_eq!(machine.state().mode, ComputerUseLayoutMode::Idle);

        assert!(machine
            .begin("session-a", "com.apple.Calculator", snapshot())
            .unwrap());
        assert_eq!(machine.state().mode, ComputerUseLayoutMode::Entering);
        machine.mark_focus_result("session-a", true).unwrap();
        assert_eq!(machine.state().mode, ComputerUseLayoutMode::Compact);
        assert!(machine.begin_restore("session-a").unwrap());
        assert_eq!(machine.state().mode, ComputerUseLayoutMode::Restoring);
        machine.finish_restore("session-a").unwrap();
        assert_eq!(machine.state().mode, ComputerUseLayoutMode::Idle);
    }

    #[test]
    fn computer_use_layout_failure_is_fallback_and_calls_are_idempotent() {
        let mut machine = ComputerUseLayoutMachine::default();
        assert!(machine
            .begin("session-a", "com.apple.Calculator", snapshot())
            .unwrap());
        assert!(!machine
            .begin("session-a", "com.apple.Calculator", snapshot())
            .unwrap());
        machine.mark_focus_result("session-a", false).unwrap();
        assert_eq!(machine.state().mode, ComputerUseLayoutMode::Fallback);
        machine.mark_focus_result("session-a", false).unwrap();
        assert!(machine.begin_restore("session-a").unwrap());
        assert!(!machine.begin_restore("session-a").unwrap());
    }

    #[test]
    fn computer_use_layout_rejects_foreign_session_mutations() {
        let mut machine = ComputerUseLayoutMachine::default();
        machine
            .begin("session-a", "com.apple.Calculator", snapshot())
            .unwrap();
        assert!(machine
            .begin("session-b", "com.apple.Notes", snapshot())
            .is_err());
        assert!(machine.mark_focus_result("session-b", true).is_err());
        assert!(machine.begin_restore("session-b").is_err());
        assert!(machine.finish_restore("session-b").is_err());
        assert_eq!(machine.state().session_id.as_deref(), Some("session-a"));
    }
}
