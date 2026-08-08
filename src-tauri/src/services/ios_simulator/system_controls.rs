use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{wda_client::WdaInterfaceOrientation, IosSimulatorDeviceFamily, NormalizedPoint};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IosSimulatorSystemAction {
    Home,
    AppSwitcher,
    Notifications,
    ControlCenter,
    RotateClockwise,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct SystemGesture {
    pub start: NormalizedPoint,
    pub end: NormalizedPoint,
    pub duration: Duration,
    pub hold: Duration,
}

pub(crate) fn system_gesture(
    action: IosSimulatorSystemAction,
    family: IosSimulatorDeviceFamily,
    orientation: WdaInterfaceOrientation,
) -> Option<SystemGesture> {
    let landscape = orientation.is_landscape();
    match action {
        IosSimulatorSystemAction::AppSwitcher => Some(SystemGesture {
            start: NormalizedPoint { x: 0.50, y: 0.98 },
            end: NormalizedPoint {
                x: 0.50,
                y: if landscape { 0.58 } else { 0.62 },
            },
            duration: Duration::from_millis(220),
            hold: Duration::from_millis(450),
        }),
        IosSimulatorSystemAction::Notifications => {
            let x = if family == IosSimulatorDeviceFamily::Ipad {
                0.25
            } else {
                0.20
            };
            Some(SystemGesture {
                start: NormalizedPoint { x, y: 0.01 },
                end: NormalizedPoint { x, y: 0.72 },
                duration: Duration::from_millis(350),
                hold: Duration::ZERO,
            })
        }
        IosSimulatorSystemAction::ControlCenter => Some(SystemGesture {
            start: NormalizedPoint { x: 0.92, y: 0.01 },
            end: NormalizedPoint {
                x: 0.92,
                y: if landscape { 0.64 } else { 0.60 },
            },
            duration: Duration::from_millis(350),
            hold: Duration::ZERO,
        }),
        IosSimulatorSystemAction::Home | IosSimulatorSystemAction::RotateClockwise => None,
    }
}

pub(crate) fn next_clockwise_orientation(
    current: WdaInterfaceOrientation,
    family: IosSimulatorDeviceFamily,
) -> WdaInterfaceOrientation {
    if family == IosSimulatorDeviceFamily::Iphone {
        return if current.is_landscape() {
            WdaInterfaceOrientation::Portrait
        } else {
            WdaInterfaceOrientation::LandscapeRight
        };
    }
    match current {
        WdaInterfaceOrientation::Portrait => WdaInterfaceOrientation::LandscapeRight,
        WdaInterfaceOrientation::LandscapeRight => WdaInterfaceOrientation::PortraitUpsideDown,
        WdaInterfaceOrientation::PortraitUpsideDown => WdaInterfaceOrientation::LandscapeLeft,
        WdaInterfaceOrientation::LandscapeLeft => WdaInterfaceOrientation::Portrait,
    }
}
