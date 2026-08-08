use std::thread;
use std::time::{Duration, Instant};

use reqwest::blocking::{Client, RequestBuilder};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::system_controls::SystemGesture;

const WDA_HTTP_TIMEOUT: Duration = Duration::from_secs(5);
const WDA_READY_RETRY: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u16", into = "u16")]
pub(crate) enum StreamProfile {
    Fps30,
    Fps60,
}

impl StreamProfile {
    pub(crate) const DEFAULT: Self = Self::Fps30;

    pub(crate) fn fps(self) -> u16 {
        match self {
            Self::Fps30 => 30,
            Self::Fps60 => 60,
        }
    }
}

impl TryFrom<u16> for StreamProfile {
    type Error = String;

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        match value {
            30 => Ok(Self::Fps30),
            60 => Ok(Self::Fps60),
            _ => Err("A fluidez deve ser 30 ou 60 fps.".to_string()),
        }
    }
}

impl From<StreamProfile> for u16 {
    fn from(value: StreamProfile) -> Self {
        value.fps()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WdaWindowSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WdaInterfaceOrientation {
    Portrait,
    PortraitUpsideDown,
    LandscapeLeft,
    LandscapeRight,
}

impl WdaInterfaceOrientation {
    fn wda_name(self) -> &'static str {
        match self {
            Self::Portrait => "portrait",
            Self::PortraitUpsideDown => "portraitUpsideDown",
            Self::LandscapeLeft => "landscapeLeft",
            Self::LandscapeRight => "landscapeRight",
        }
    }

    pub(crate) fn is_landscape(self) -> bool {
        matches!(self, Self::LandscapeLeft | Self::LandscapeRight)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WdaControlHandle {
    pub base_url: String,
    pub window_size: WdaWindowSize,
    pub orientation: WdaInterfaceOrientation,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WdaPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IosSimulatorKey {
    Enter,
    Backspace,
    Tab,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
}

impl IosSimulatorKey {
    fn hid_usage(self) -> u32 {
        match self {
            Self::Enter => 0x28,
            Self::Backspace => 0x2A,
            Self::Tab => 0x2B,
            Self::ArrowRight => 0x4F,
            Self::ArrowLeft => 0x50,
            Self::ArrowDown => 0x51,
            Self::ArrowUp => 0x52,
        }
    }
}

pub(crate) trait WdaClient: Send + Sync {
    fn wait_until_ready(&self, base_url: &str, deadline: Instant) -> Result<(), String>;
    fn apply_stream_settings(
        &self,
        control: &WdaControlHandle,
        profile: StreamProfile,
    ) -> Result<(), String>;
    fn tap(&self, control: &WdaControlHandle, point: WdaPoint) -> Result<(), String>;
    fn drag(
        &self,
        control: &WdaControlHandle,
        from: WdaPoint,
        to: WdaPoint,
        duration: Duration,
    ) -> Result<(), String>;
    fn type_text(&self, control: &WdaControlHandle, text: &str) -> Result<(), String>;
    fn press_key(&self, control: &WdaControlHandle, key: IosSimulatorKey) -> Result<(), String>;
    fn home(&self, control: &WdaControlHandle) -> Result<(), String>;
    fn system_gesture(
        &self,
        control: &WdaControlHandle,
        gesture: SystemGesture,
    ) -> Result<(), String>;
    fn rotate(
        &self,
        control: &WdaControlHandle,
        orientation: WdaInterfaceOrientation,
    ) -> Result<(), String>;
}

pub(crate) struct SystemWdaClient {
    client: Client,
}

impl Default for SystemWdaClient {
    fn default() -> Self {
        let client = Client::builder()
            .connect_timeout(WDA_HTTP_TIMEOUT)
            .timeout(WDA_HTTP_TIMEOUT)
            .build()
            .expect("WDA HTTP client configuration must be valid");
        Self { client }
    }
}

impl SystemWdaClient {
    fn endpoint(base_url: &str, path: &str) -> String {
        format!("{}{}", base_url.trim_end_matches('/'), path)
    }

    fn request_value(&self, request: RequestBuilder) -> Result<Value, String> {
        let response = request
            .send()
            .map_err(|error| format!("não foi possível falar com o WDA: {error}"))?;
        let status = response.status();
        let envelope: Value = response
            .json()
            .map_err(|error| format!("o WDA retornou JSON inválido: {error}"))?;
        if !status.is_success() {
            return Err(format!("o WDA retornou HTTP {status}: {envelope}"));
        }
        let value = envelope
            .get("value")
            .cloned()
            .ok_or_else(|| "a resposta do WDA não contém value".to_string())?;
        if let Some(error) = value.get("error").and_then(Value::as_str) {
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or(error);
            return Err(format!("o WDA recusou a operação ({error}): {message}"));
        }
        Ok(value)
    }
}

impl WdaClient for SystemWdaClient {
    fn wait_until_ready(&self, base_url: &str, deadline: Instant) -> Result<(), String> {
        let mut last_error = "o WDA ainda não respondeu".to_string();
        while Instant::now() < deadline {
            match self.request_value(self.client.get(Self::endpoint(base_url, "/status"))) {
                Ok(_) => return Ok(()),
                Err(error) => last_error = error,
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if !remaining.is_zero() {
                thread::sleep(WDA_READY_RETRY.min(remaining));
            }
        }
        Err(format!(
            "o WDA não ficou pronto dentro do prazo: {last_error}"
        ))
    }

    fn apply_stream_settings(
        &self,
        control: &WdaControlHandle,
        profile: StreamProfile,
    ) -> Result<(), String> {
        self.request_value(
            self.client
                .post(Self::endpoint(&control.base_url, "/wda/verboo/settings"))
                .json(&json!({
                    "mjpegServerFramerate": profile.fps(),
                    "mjpegScalingFactor": 100,
                })),
        )?;
        Ok(())
    }

    fn tap(&self, control: &WdaControlHandle, point: WdaPoint) -> Result<(), String> {
        self.request_value(
            self.client
                .post(Self::endpoint(&control.base_url, "/wda/verboo/tap"))
                .json(&json!({
                    "x": point.x,
                    "y": point.y,
                    "orientation": control.orientation.wda_name(),
                })),
        )?;
        Ok(())
    }

    fn drag(
        &self,
        control: &WdaControlHandle,
        from: WdaPoint,
        to: WdaPoint,
        duration: Duration,
    ) -> Result<(), String> {
        self.request_value(
            self.client
                .post(Self::endpoint(&control.base_url, "/wda/verboo/drag"))
                .json(&json!({
                    "fromX": from.x,
                    "fromY": from.y,
                    "toX": to.x,
                    "toY": to.y,
                    "duration": duration.as_secs_f64(),
                    "orientation": control.orientation.wda_name(),
                })),
        )?;
        Ok(())
    }

    fn type_text(&self, control: &WdaControlHandle, text: &str) -> Result<(), String> {
        self.request_value(
            self.client
                .post(Self::endpoint(&control.base_url, "/wda/verboo/type"))
                .json(&json!({ "text": text })),
        )?;
        Ok(())
    }

    fn press_key(&self, control: &WdaControlHandle, key: IosSimulatorKey) -> Result<(), String> {
        self.request_value(
            self.client
                .post(Self::endpoint(&control.base_url, "/wda/verboo/key"))
                .json(&json!({
                    "page": 0x07,
                    "usage": key.hid_usage(),
                    "duration": 0.005,
                })),
        )?;
        Ok(())
    }

    fn home(&self, control: &WdaControlHandle) -> Result<(), String> {
        // The WDA route rejects POSTs without a JSON body with an empty 400
        // (measured on iOS 26.5) — the other verboo routes all send one.
        self.request_value(
            self.client
                .post(Self::endpoint(&control.base_url, "/wda/verboo/home"))
                .json(&json!({})),
        )?;
        Ok(())
    }

    fn system_gesture(
        &self,
        control: &WdaControlHandle,
        gesture: SystemGesture,
    ) -> Result<(), String> {
        let from = super::normalized_to_wda_point(gesture.start, control.window_size)?;
        let to = super::normalized_to_wda_point(gesture.end, control.window_size)?;
        self.request_value(
            self.client
                .post(Self::endpoint(
                    &control.base_url,
                    "/wda/verboo/systemGesture",
                ))
                .json(&json!({
                    "fromX": from.x,
                    "fromY": from.y,
                    "toX": to.x,
                    "toY": to.y,
                    "duration": gesture.duration.as_secs_f64(),
                    "hold": gesture.hold.as_secs_f64(),
                    "orientation": control.orientation.wda_name(),
                })),
        )?;
        Ok(())
    }

    fn rotate(
        &self,
        control: &WdaControlHandle,
        orientation: WdaInterfaceOrientation,
    ) -> Result<(), String> {
        self.request_value(
            self.client
                .post(Self::endpoint(&control.base_url, "/wda/verboo/rotate"))
                .json(&json!({ "orientation": orientation.wda_name() })),
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        IosSimulatorKey, StreamProfile, SystemWdaClient, WdaClient, WdaControlHandle,
        WdaInterfaceOrientation, WdaPoint, WdaWindowSize,
    };
    use serde_json::Value;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    struct FakeWdaHttpServer {
        base_url: String,
        requests: Arc<Mutex<Vec<(String, String, Value)>>>,
        worker: Option<thread::JoinHandle<()>>,
    }

    impl FakeWdaHttpServer {
        fn start(expected_requests: usize) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let address = listener.local_addr().unwrap();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let worker_requests = requests.clone();
            let worker = thread::spawn(move || {
                for request_index in 0..expected_requests {
                    let (mut stream, _) = listener.accept().unwrap();
                    let mut buffer = Vec::new();
                    let mut chunk = [0_u8; 4096];
                    loop {
                        let read = stream.read(&mut chunk).unwrap();
                        buffer.extend_from_slice(&chunk[..read]);
                        let Some(header_end) =
                            buffer.windows(4).position(|part| part == b"\r\n\r\n")
                        else {
                            continue;
                        };
                        let header_end = header_end + 4;
                        let headers = String::from_utf8_lossy(&buffer[..header_end]);
                        let content_length = headers
                            .lines()
                            .find_map(|line| {
                                line.strip_prefix("content-length: ")
                                    .or_else(|| line.strip_prefix("Content-Length: "))
                            })
                            .and_then(|value| value.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        if buffer.len() >= header_end + content_length {
                            let request_line = headers.lines().next().unwrap();
                            let mut parts = request_line.split_whitespace();
                            let method = parts.next().unwrap().to_string();
                            let path = parts.next().unwrap().to_string();
                            let body = if content_length == 0 {
                                Value::Null
                            } else {
                                serde_json::from_slice(
                                    &buffer[header_end..header_end + content_length],
                                )
                                .unwrap()
                            };
                            worker_requests.lock().unwrap().push((method, path, body));
                            break;
                        }
                    }

                    let body = if request_index == 0 {
                        r#"{"value":{"sessionId":"session-1","capabilities":{}}}"#
                    } else {
                        r#"{"value":null}"#
                    };
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body,
                    )
                    .unwrap();
                }
            });
            Self {
                base_url: format!("http://{address}"),
                requests,
                worker: Some(worker),
            }
        }

        fn finish(mut self) -> Vec<(String, String, Value)> {
            self.worker.take().unwrap().join().unwrap();
            Arc::try_unwrap(self.requests)
                .unwrap()
                .into_inner()
                .unwrap()
        }
    }

    #[test]
    fn wda_stream_settings_are_sessionless() {
        let http = FakeWdaHttpServer::start(1);
        let client = SystemWdaClient::default();
        let session = WdaControlHandle {
            base_url: http.base_url.clone(),
            window_size: WdaWindowSize {
                width: 402.0,
                height: 874.0,
            },
            orientation: WdaInterfaceOrientation::Portrait,
        };
        client
            .apply_stream_settings(&session, StreamProfile::Fps30)
            .unwrap();

        assert_eq!(
            http.finish(),
            vec![(
                "POST".into(),
                "/wda/verboo/settings".into(),
                serde_json::json!({
                    "mjpegServerFramerate": 30,
                    "mjpegScalingFactor": 100,
                }),
            ),]
        );
    }

    #[test]
    fn stream_profile_rejects_every_value_except_30_and_60() {
        assert_eq!(StreamProfile::try_from(30).unwrap(), StreamProfile::Fps30);
        assert_eq!(StreamProfile::try_from(60).unwrap(), StreamProfile::Fps60);
        assert!(StreamProfile::try_from(10).is_err());
        assert!(StreamProfile::try_from(120).is_err());
    }

    #[test]
    fn wda_input_uses_only_sessionless_endpoints() {
        let http = FakeWdaHttpServer::start(4);
        let client = SystemWdaClient::default();
        let session = WdaControlHandle {
            base_url: http.base_url.clone(),
            window_size: WdaWindowSize {
                width: 393.0,
                height: 852.0,
            },
            orientation: WdaInterfaceOrientation::Portrait,
        };

        client
            .tap(&session, WdaPoint { x: 196.5, y: 213.0 })
            .unwrap();
        client
            .drag(
                &session,
                WdaPoint { x: 39.3, y: 681.6 },
                WdaPoint { x: 353.7, y: 170.4 },
                Duration::from_millis(180),
            )
            .unwrap();
        client.type_text(&session, "Verboo").unwrap();
        client
            .press_key(&session, IosSimulatorKey::Backspace)
            .unwrap();

        assert_eq!(
            http.finish(),
            vec![
                (
                    "POST".into(),
                    "/wda/verboo/tap".into(),
                    serde_json::json!({
                        "x": 196.5,
                        "y": 213.0,
                        "orientation": "portrait",
                    }),
                ),
                (
                    "POST".into(),
                    "/wda/verboo/drag".into(),
                    serde_json::json!({
                        "fromX": 39.3,
                        "fromY": 681.6,
                        "toX": 353.7,
                        "toY": 170.4,
                        "duration": 0.18,
                        "orientation": "portrait",
                    }),
                ),
                (
                    "POST".into(),
                    "/wda/verboo/type".into(),
                    serde_json::json!({ "text": "Verboo" }),
                ),
                (
                    "POST".into(),
                    "/wda/verboo/key".into(),
                    serde_json::json!({ "page": 7, "usage": 42, "duration": 0.005 }),
                ),
            ]
        );
    }

    #[test]
    fn wda_system_controls_use_only_verboo_sessionless_routes() {
        let http = FakeWdaHttpServer::start(3);
        let client = SystemWdaClient::default();
        let control = WdaControlHandle {
            base_url: http.base_url.clone(),
            window_size: WdaWindowSize {
                width: 402.0,
                height: 874.0,
            },
            orientation: WdaInterfaceOrientation::Portrait,
        };
        let gesture = super::super::system_controls::SystemGesture {
            start: super::super::NormalizedPoint { x: 0.5, y: 0.98 },
            end: super::super::NormalizedPoint { x: 0.5, y: 0.62 },
            duration: Duration::from_millis(220),
            hold: Duration::from_millis(450),
        };

        client.home(&control).unwrap();
        client.system_gesture(&control, gesture).unwrap();
        client
            .rotate(&control, WdaInterfaceOrientation::LandscapeRight)
            .unwrap();

        let paths = http
            .finish()
            .into_iter()
            .map(|(_, path, _)| path)
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            vec![
                "/wda/verboo/home",
                "/wda/verboo/systemGesture",
                "/wda/verboo/rotate",
            ]
        );
        assert!(paths.iter().all(|path| !path.contains("/session/")));
    }

    #[test]
    fn wda_home_sends_a_json_body() {
        let http = FakeWdaHttpServer::start(1);
        let client = SystemWdaClient::default();
        let control = WdaControlHandle {
            base_url: http.base_url.clone(),
            window_size: WdaWindowSize {
                width: 402.0,
                height: 874.0,
            },
            orientation: WdaInterfaceOrientation::Portrait,
        };
        client.home(&control).unwrap();
        let (_, path, body) = http.finish().into_iter().next().unwrap();
        assert_eq!(path, "/wda/verboo/home");
        assert_ne!(
            body,
            Value::Null,
            "o POST /wda/verboo/home precisa de corpo JSON — o WDA responde 400 vazio sem corpo (medido no iOS 26.5)"
        );
    }
}
