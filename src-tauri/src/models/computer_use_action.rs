use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerAction {
    Screenshot,
    LeftClick,
    RightClick,
    MiddleClick,
    DoubleClick,
    TripleClick,
    Type,
    Key,
    HoldKey,
    MouseMove,
    Scroll,
    LeftClickDrag,
    LeftMouseDown,
    LeftMouseUp,
    Wait,
    Zoom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyModifier {
    Cmd,
    Ctrl,
    Alt,
    Shift,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionRequest {
    pub action: ComputerAction,
    pub coordinate: Option<[u32; 2]>,
    pub start_coordinate: Option<[u32; 2]>,
    pub text: Option<String>,
    pub duration: Option<f64>,
    pub scroll_amount: Option<u32>,
    pub scroll_direction: Option<ScrollDirection>,
    pub region: Option<[u32; 4]>,
    #[serde(default)]
    pub modifiers: Vec<KeyModifier>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionValidationError(pub &'static str);

impl std::fmt::Display for ActionValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for ActionValidationError {}

impl ActionRequest {
    pub fn validate(&self) -> Result<(), ActionValidationError> {
        use ComputerAction::*;

        if self
            .modifiers
            .iter()
            .enumerate()
            .any(|(index, modifier)| self.modifiers[..index].contains(modifier))
        {
            return Err(ActionValidationError("modifiers must be unique"));
        }

        match self.action {
            LeftClick | RightClick | MiddleClick | DoubleClick | TripleClick | MouseMove
            | LeftMouseDown | LeftMouseUp => {
                self.coordinate
                    .ok_or(ActionValidationError("coordinate is required"))?;
                if self.start_coordinate.is_some()
                    || self.text.is_some()
                    || self.duration.is_some()
                    || self.scroll_amount.is_some()
                    || self.scroll_direction.is_some()
                    || self.region.is_some()
                    || !self.modifiers.is_empty()
                {
                    return Err(ActionValidationError("action contains unsupported fields"));
                }
            }
            LeftClickDrag => {
                self.start_coordinate
                    .ok_or(ActionValidationError("start_coordinate is required"))?;
                self.coordinate
                    .ok_or(ActionValidationError("coordinate is required"))?;
                if self.text.is_some()
                    || self.duration.is_some()
                    || self.scroll_amount.is_some()
                    || self.scroll_direction.is_some()
                    || self.region.is_some()
                    || !self.modifiers.is_empty()
                {
                    return Err(ActionValidationError("action contains unsupported fields"));
                }
            }
            Type => {
                if self.text.as_deref().is_none_or(str::is_empty) {
                    return Err(ActionValidationError("text is required"));
                }
                if self.coordinate.is_some()
                    || self.start_coordinate.is_some()
                    || self.duration.is_some()
                    || self.scroll_amount.is_some()
                    || self.scroll_direction.is_some()
                    || self.region.is_some()
                    || !self.modifiers.is_empty()
                {
                    return Err(ActionValidationError("action contains unsupported fields"));
                }
            }
            Key => {
                if self.text.as_deref().is_none_or(str::is_empty) {
                    return Err(ActionValidationError("key text is required"));
                }
                if self.coordinate.is_some()
                    || self.start_coordinate.is_some()
                    || self.duration.is_some()
                    || self.scroll_amount.is_some()
                    || self.scroll_direction.is_some()
                    || self.region.is_some()
                {
                    return Err(ActionValidationError("action contains unsupported fields"));
                }
            }
            HoldKey => {
                if self.text.as_deref().is_none_or(str::is_empty) {
                    return Err(ActionValidationError("key text is required"));
                }
                if self.coordinate.is_some()
                    || self.start_coordinate.is_some()
                    || self.scroll_amount.is_some()
                    || self.scroll_direction.is_some()
                    || self.region.is_some()
                    || !self.modifiers.is_empty()
                {
                    return Err(ActionValidationError("action contains unsupported fields"));
                }
            }
            Scroll => {
                self.coordinate
                    .ok_or(ActionValidationError("coordinate is required"))?;
                self.scroll_direction
                    .ok_or(ActionValidationError("scroll_direction is required"))?;
                match self.scroll_amount {
                    Some(1..=100) => {}
                    _ => {
                        return Err(ActionValidationError(
                            "scroll_amount must be between 1 and 100",
                        ))
                    }
                }
                if self.start_coordinate.is_some()
                    || self.text.is_some()
                    || self.duration.is_some()
                    || self.region.is_some()
                    || !self.modifiers.is_empty()
                {
                    return Err(ActionValidationError("action contains unsupported fields"));
                }
            }
            Zoom => {
                self.region
                    .ok_or(ActionValidationError("region is required"))?;
                if self.coordinate.is_some()
                    || self.start_coordinate.is_some()
                    || self.text.is_some()
                    || self.duration.is_some()
                    || self.scroll_amount.is_some()
                    || self.scroll_direction.is_some()
                    || !self.modifiers.is_empty()
                {
                    return Err(ActionValidationError("action contains unsupported fields"));
                }
            }
            Screenshot => {
                if self.coordinate.is_some()
                    || self.start_coordinate.is_some()
                    || self.text.is_some()
                    || self.duration.is_some()
                    || self.scroll_amount.is_some()
                    || self.scroll_direction.is_some()
                    || self.region.is_some()
                    || !self.modifiers.is_empty()
                {
                    return Err(ActionValidationError("action contains unsupported fields"));
                }
            }
            Wait => {
                if self.coordinate.is_some()
                    || self.start_coordinate.is_some()
                    || self.text.is_some()
                    || self.scroll_amount.is_some()
                    || self.scroll_direction.is_some()
                    || self.region.is_some()
                    || !self.modifiers.is_empty()
                {
                    return Err(ActionValidationError("action contains unsupported fields"));
                }
            }
        }

        if let Some(duration) = self.duration {
            if !(0.1..=60.0).contains(&duration) {
                return Err(ActionValidationError(
                    "duration must be between 0.1 and 60 seconds",
                ));
            }
        }
        if matches!(self.action, HoldKey | Wait) && self.duration.is_none() {
            return Err(ActionValidationError("duration is required"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(value: serde_json::Value) -> ActionRequest {
        serde_json::from_value(value).expect("valid action request")
    }

    #[test]
    fn every_documented_action_deserializes() {
        let cases = [
            json!({"action": "screenshot"}),
            json!({"action": "left_click", "coordinate": [1, 2]}),
            json!({"action": "right_click", "coordinate": [1, 2]}),
            json!({"action": "middle_click", "coordinate": [1, 2]}),
            json!({"action": "double_click", "coordinate": [1, 2]}),
            json!({"action": "triple_click", "coordinate": [1, 2]}),
            json!({"action": "type", "text": "hello"}),
            json!({"action": "key", "text": "ENTER", "modifiers": ["cmd"]}),
            json!({"action": "hold_key", "text": "shift", "duration": 0.5}),
            json!({"action": "mouse_move", "coordinate": [1, 2]}),
            json!({"action": "scroll", "coordinate": [1, 2], "scroll_amount": 4, "scroll_direction": "down"}),
            json!({"action": "left_click_drag", "start_coordinate": [1, 2], "coordinate": [3, 4]}),
            json!({"action": "left_mouse_down", "coordinate": [1, 2]}),
            json!({"action": "left_mouse_up", "coordinate": [1, 2]}),
            json!({"action": "wait", "duration": 0.5}),
            json!({"action": "zoom", "region": [1, 2, 30, 40]}),
        ];

        for case in cases {
            parse(case).validate().expect("documented action validates");
        }
    }

    #[test]
    fn coordinate_actions_require_a_coordinate() {
        for action in [
            "left_click",
            "right_click",
            "middle_click",
            "double_click",
            "triple_click",
            "mouse_move",
            "left_mouse_down",
            "left_mouse_up",
        ] {
            assert!(
                parse(json!({"action": action})).validate().is_err(),
                "{action}"
            );
        }
    }

    #[test]
    fn drag_requires_start_and_end_coordinates() {
        assert!(
            parse(json!({"action": "left_click_drag", "coordinate": [3, 4]}))
                .validate()
                .is_err()
        );
        assert!(
            parse(json!({"action": "left_click_drag", "start_coordinate": [1, 2]}))
                .validate()
                .is_err()
        );
    }

    #[test]
    fn type_requires_non_empty_text() {
        assert!(parse(json!({"action": "type"})).validate().is_err());
        assert!(parse(json!({"action": "type", "text": ""}))
            .validate()
            .is_err());
    }

    #[test]
    fn actions_reject_fields_that_do_not_belong_to_them() {
        let cases = [
            json!({"action":"screenshot","coordinate":[1,2]}),
            json!({"action":"left_click","coordinate":[1,2],"text":"extra"}),
            json!({"action":"left_click_drag","start_coordinate":[1,2],"coordinate":[3,4],"duration":1}),
            json!({"action":"type","text":"hello","coordinate":[1,2]}),
            json!({"action":"key","text":"enter","duration":1}),
            json!({"action":"hold_key","text":"shift","duration":1,"modifiers":["cmd"]}),
            json!({"action":"scroll","coordinate":[1,2],"scroll_amount":3,"scroll_direction":"down","text":"extra"}),
            json!({"action":"wait","duration":1,"region":[1,2,3,4]}),
            json!({"action":"zoom","region":[1,2,3,4],"coordinate":[1,2]}),
        ];

        for case in cases {
            assert!(parse(case.clone()).validate().is_err(), "accepted {case}");
        }
    }

    #[test]
    fn scroll_requires_bounded_amount_and_direction() {
        assert!(
            parse(json!({"action": "scroll", "coordinate": [1, 2], "scroll_amount": 1}))
                .validate()
                .is_err()
        );
        assert!(
            parse(json!({"action": "scroll", "coordinate": [1, 2], "scroll_direction": "up"}))
                .validate()
                .is_err()
        );
        assert!(parse(json!({"action": "scroll", "coordinate": [1, 2], "scroll_amount": 0, "scroll_direction": "up"})).validate().is_err());
        assert!(parse(json!({"action": "scroll", "coordinate": [1, 2], "scroll_amount": 101, "scroll_direction": "up"})).validate().is_err());
    }

    #[test]
    fn duration_is_rejected_outside_bounds() {
        assert!(parse(json!({"action": "wait", "duration": 0.09}))
            .validate()
            .is_err());
        assert!(parse(json!({"action": "wait", "duration": 60.01}))
            .validate()
            .is_err());
    }

    #[test]
    fn duplicate_key_modifiers_are_rejected() {
        let request = parse(json!({
            "action": "key",
            "text": "ENTER",
            "modifiers": ["cmd", "cmd"]
        }));

        assert_eq!(
            request.validate(),
            Err(ActionValidationError("modifiers must be unique"))
        );
    }

    #[test]
    fn unknown_fields_and_wrong_coordinate_lengths_fail_deserialization() {
        assert!(serde_json::from_value::<ActionRequest>(
            json!({"action": "screenshot", "surprise": true})
        )
        .is_err());
        assert!(serde_json::from_value::<ActionRequest>(
            json!({"action": "left_click", "coordinate": [1]})
        )
        .is_err());
        assert!(serde_json::from_value::<ActionRequest>(
            json!({"action": "left_click", "coordinate": [1, 2, 3]})
        )
        .is_err());
        assert!(serde_json::from_value::<ActionRequest>(
            json!({"action": "left_click", "coordinate": [-1, 2]})
        )
        .is_err());
    }
}
