#[path = "generated/android_emulation_control.rs"]
pub(crate) mod generated;

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use tonic::metadata::{Ascii, MetadataValue};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostPlatform {
    MacOs,
    Windows,
    Linux,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DiscoveryEnvironment {
    pub(crate) home: Option<PathBuf>,
    pub(crate) local_app_data: Option<PathBuf>,
    pub(crate) xdg_runtime_dir: Option<PathBuf>,
    pub(crate) android_emulator_home: Option<PathBuf>,
    pub(crate) android_prefs_root: Option<PathBuf>,
    pub(crate) android_sdk_home: Option<PathBuf>,
    pub(crate) real_uid: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GrpcError {
    Unavailable,
    Unauthenticated,
    Unsupported,
}

#[derive(Clone)]
pub(crate) struct GrpcDiscovery {
    port: u16,
    authorization: MetadataValue<Ascii>,
}

impl GrpcDiscovery {
    pub(crate) fn port(&self) -> u16 {
        self.port
    }
}

pub(crate) fn discovery_roots(platform: HostPlatform, env: &DiscoveryEnvironment) -> Vec<PathBuf> {
    let mut bases = Vec::new();
    match platform {
        HostPlatform::MacOs => {
            if let Some(home) = &env.home {
                bases.push(home.join("Library/Caches/TemporaryItems"));
            }
        }
        HostPlatform::Windows => {
            if let Some(local) = &env.local_app_data {
                bases.push(local.join("Temp"));
            }
        }
        HostPlatform::Linux => {
            if let Some(path) = &env.xdg_runtime_dir {
                bases.push(path.clone());
            } else if let Some(uid) = env.real_uid {
                bases.push(PathBuf::from(format!("/run/user/{uid}")));
            }
            bases.extend(
                [
                    env.android_emulator_home.as_ref(),
                    env.android_prefs_root.as_ref(),
                    env.android_sdk_home.as_ref(),
                ]
                .into_iter()
                .flatten()
                .cloned(),
            );
            if let Some(home) = &env.home {
                bases.push(home.join(".android"));
            }
        }
    }
    let mut seen = BTreeSet::new();
    bases
        .into_iter()
        .map(|base| base.join("avd").join("running"))
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

fn parse_ini(bytes: &[u8]) -> Result<BTreeMap<String, String>, GrpcError> {
    let text = std::str::from_utf8(bytes).map_err(|_| GrpcError::Unsupported)?;
    let mut values = BTreeMap::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let (key, value) = line.split_once('=').ok_or(GrpcError::Unsupported)?;
        if key.is_empty() || values.insert(key.to_string(), value.to_string()).is_some() {
            return Err(GrpcError::Unsupported);
        }
    }
    Ok(values)
}

pub(crate) fn parse_discovery(
    bytes: &[u8],
    expected_avd: &str,
) -> Result<GrpcDiscovery, GrpcError> {
    let values = parse_ini(bytes)?;
    let identities: Vec<&str> = [values.get("avd.id"), values.get("avd.name")]
        .into_iter()
        .flatten()
        .map(String::as_str)
        .collect();
    if identities.is_empty() || identities.iter().any(|identity| *identity != expected_avd) {
        return Err(GrpcError::Unsupported);
    }
    let port = values
        .get("grpc.port")
        .ok_or(GrpcError::Unsupported)?
        .parse::<u16>()
        .map_err(|_| GrpcError::Unsupported)?;
    if port == 0 {
        return Err(GrpcError::Unsupported);
    }
    let token = values
        .get("grpc.token")
        .filter(|value| !value.is_empty())
        .ok_or(GrpcError::Unauthenticated)?;
    let mut authorization = format!("Bearer {token}")
        .parse::<MetadataValue<Ascii>>()
        .map_err(|_| GrpcError::Unauthenticated)?;
    authorization.set_sensitive(true);
    Ok(GrpcDiscovery {
        port,
        authorization,
    })
}

pub(crate) fn locate_discovery_in_roots(
    roots: &[PathBuf],
    pid: u32,
    expected_avd: &str,
) -> Result<GrpcDiscovery, GrpcError> {
    let names = [format!("pid_{pid}.ini"), format!("pid_{pid}_info.ini")];
    let matches: Vec<PathBuf> = roots
        .iter()
        .flat_map(|root| names.iter().map(move |name| root.join(name)))
        .filter(|path| path.is_file())
        .collect();
    if matches.is_empty() {
        return Err(GrpcError::Unavailable);
    }
    if matches.len() != 1 {
        return Err(GrpcError::Unsupported);
    }
    let bytes = std::fs::read(&matches[0]).map_err(|_| GrpcError::Unavailable)?;
    parse_discovery(&bytes, expected_avd)
}

fn endpoint_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

#[cfg(unix)]
fn real_uid() -> Option<u32> {
    Some(unsafe { libc::getuid() })
}

#[cfg(not(unix))]
fn real_uid() -> Option<u32> {
    None
}

#[cfg(target_os = "macos")]
const CURRENT_PLATFORM: HostPlatform = HostPlatform::MacOs;

#[cfg(target_os = "windows")]
const CURRENT_PLATFORM: HostPlatform = HostPlatform::Windows;

#[cfg(target_os = "linux")]
const CURRENT_PLATFORM: HostPlatform = HostPlatform::Linux;

fn path_from_env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub(crate) fn locate_owned_grpc(pid: u32, expected_avd: &str) -> Result<GrpcDiscovery, GrpcError> {
    let environment = DiscoveryEnvironment {
        home: path_from_env("HOME"),
        local_app_data: path_from_env("LOCALAPPDATA"),
        xdg_runtime_dir: path_from_env("XDG_RUNTIME_DIR"),
        android_emulator_home: path_from_env("ANDROID_EMULATOR_HOME"),
        android_prefs_root: path_from_env("ANDROID_PREFS_ROOT"),
        android_sdk_home: path_from_env("ANDROID_SDK_HOME"),
        real_uid: real_uid(),
    };
    let roots = discovery_roots(CURRENT_PLATFORM, &environment);
    locate_discovery_in_roots(&roots, pid, expected_avd)
}

const MAX_RGB_PAYLOAD: usize = 1600 * 720 * 3;
const MAX_GRPC_MESSAGE_BYTES: usize = MAX_RGB_PAYLOAD + 4096;

pub(crate) fn map_status(status: tonic::Status) -> GrpcError {
    match status.code() {
        tonic::Code::Unauthenticated | tonic::Code::PermissionDenied => GrpcError::Unauthenticated,
        tonic::Code::Unimplemented | tonic::Code::InvalidArgument => GrpcError::Unsupported,
        _ => GrpcError::Unavailable,
    }
}

pub(crate) async fn open_stream(
    discovery: &GrpcDiscovery,
    width: u32,
    height: u32,
) -> Result<tonic::Streaming<generated::Image>, GrpcError> {
    let endpoint = tonic::transport::Endpoint::from_shared(endpoint_uri(discovery.port))
        .map_err(|_| GrpcError::Unavailable)?;
    let channel = endpoint
        .connect()
        .await
        .map_err(|_| GrpcError::Unavailable)?;
    let authorization = discovery.authorization.clone();
    let interceptor = move |mut request: tonic::Request<()>| {
        request
            .metadata_mut()
            .insert("authorization", authorization.clone());
        Ok(request)
    };
    let mut client =
        generated::emulator_controller_client::EmulatorControllerClient::with_interceptor(
            channel,
            interceptor,
        )
        .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES);
    let request = generated::ImageFormat {
        format: generated::image_format::ImgFormat::Rgb888 as i32,
        width,
        height,
    };
    client
        .stream_screenshot(request)
        .await
        .map(tonic::Response::into_inner)
        .map_err(map_status)
}

pub(crate) struct TonicScreenshotStream(tonic::Streaming<generated::Image>);

impl super::preview::ScreenshotStream for TonicScreenshotStream {
    fn message(&mut self) -> super::preview::StreamMessageFuture<'_> {
        Box::pin(async move { self.0.message().await.map_err(map_status) })
    }
}

pub(crate) struct TonicStreamFactory {
    discovery: GrpcDiscovery,
}

impl TonicStreamFactory {
    pub(crate) fn new(discovery: GrpcDiscovery) -> Self {
        Self { discovery }
    }
}

impl super::preview::ScreenshotStreamFactory for TonicStreamFactory {
    fn open(&self, width: u32, height: u32) -> super::preview::OpenStreamFuture<'_> {
        Box::pin(async move {
            open_stream(&self.discovery, width, height)
                .await
                .map(|stream| {
                    Box::new(TonicScreenshotStream(stream))
                        as Box<dyn super::preview::ScreenshotStream>
                })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn generated_rgb888_contract_matches_the_pinned_aosp_tags() {
        let request = generated::ImageFormat {
            format: generated::image_format::ImgFormat::Rgb888 as i32,
            width: 720,
            height: 1600,
        };
        assert_eq!(request.format, 2);
        assert_eq!((request.width, request.height), (720, 1600));
        let image = generated::Image {
            format: Some(request),
            image: vec![1, 2, 3],
            seq: 9,
            timestamp_us: 10,
        };
        assert_eq!(image.image, vec![1, 2, 3]);
        assert_eq!(image.seq, 9);
        assert_eq!(image.timestamp_us, 10);
    }

    fn environment() -> DiscoveryEnvironment {
        DiscoveryEnvironment {
            home: Some(PathBuf::from("/home/alice")),
            local_app_data: Some(PathBuf::from("C:/Users/alice/AppData/Local")),
            xdg_runtime_dir: Some(PathBuf::from("/run/user/1000")),
            android_emulator_home: Some(PathBuf::from("/opt/emulator-home")),
            android_prefs_root: Some(PathBuf::from("/opt/prefs-root")),
            android_sdk_home: Some(PathBuf::from("/opt/sdk-home")),
            real_uid: Some(1000),
        }
    }

    fn write_discovery(root: &Path, pid: u32, legacy_name: bool, bytes: &[u8]) -> PathBuf {
        let running = root.join("avd").join("running");
        std::fs::create_dir_all(&running).unwrap();
        let name = if legacy_name {
            format!("pid_{pid}_info.ini")
        } else {
            format!("pid_{pid}.ini")
        };
        let path = running.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn discovery_roots_are_platform_aware_and_ordered() {
        let env = environment();
        assert_eq!(
            discovery_roots(HostPlatform::MacOs, &env),
            vec![PathBuf::from(
                "/home/alice/Library/Caches/TemporaryItems/avd/running"
            )]
        );
        assert_eq!(
            discovery_roots(HostPlatform::Windows, &env),
            vec![PathBuf::from(
                "C:/Users/alice/AppData/Local/Temp/avd/running"
            )]
        );
        assert_eq!(
            discovery_roots(HostPlatform::Linux, &env),
            vec![
                PathBuf::from("/run/user/1000/avd/running"),
                PathBuf::from("/opt/emulator-home/avd/running"),
                PathBuf::from("/opt/prefs-root/avd/running"),
                PathBuf::from("/opt/sdk-home/avd/running"),
                PathBuf::from("/home/alice/.android/avd/running"),
            ]
        );
    }

    #[test]
    fn discovery_roots_deduplicate_identical_android_bases_preserving_order() {
        let shared = PathBuf::from("/opt/shared-android-base");
        let mut env = environment();
        env.android_emulator_home = Some(shared.clone());
        env.android_prefs_root = Some(shared.clone());
        env.android_sdk_home = Some(shared.clone());

        assert_eq!(
            discovery_roots(HostPlatform::Linux, &env),
            vec![
                PathBuf::from("/run/user/1000/avd/running"),
                shared.join("avd/running"),
                PathBuf::from("/home/alice/.android/avd/running"),
            ]
        );
    }

    #[test]
    fn exact_pid_current_and_legacy_files_parse_but_ambiguity_fails_closed() {
        let root = tempfile::tempdir().unwrap();
        let current = include_bytes!("../fixtures/discovery/pid_current.ini");
        let legacy = include_bytes!("../fixtures/discovery/pid_info.ini");
        write_discovery(root.path(), 4242, false, current);
        let roots = vec![root.path().join("avd/running")];
        let found = locate_discovery_in_roots(&roots, 4242, "Verboo_Device_API_36").unwrap();
        assert_eq!(found.port(), 8554);

        std::fs::remove_file(root.path().join("avd/running/pid_4242.ini")).unwrap();
        write_discovery(root.path(), 4242, true, legacy);
        assert!(locate_discovery_in_roots(&roots, 4242, "Verboo_Device_API_36").is_ok());

        write_discovery(root.path(), 4242, false, current);
        assert!(matches!(
            locate_discovery_in_roots(&roots, 4242, "Verboo_Device_API_36"),
            Err(GrpcError::Unsupported)
        ));
        assert!(matches!(
            locate_discovery_in_roots(&roots, 4243, "Verboo_Device_API_36"),
            Err(GrpcError::Unavailable)
        ));
    }

    #[test]
    fn locator_rejects_wrong_avd_duplicate_keys_bad_port_and_missing_token() {
        let good = include_str!("../fixtures/discovery/pid_current.ini");
        for bad in [
            good.replace("avd.id=Verboo_Device_API_36", "avd.id=Other_AVD"),
            format!("{good}grpc.port=8555\n"),
            good.replace("grpc.port=8554", "grpc.port=70000"),
            good.replace("grpc.token=fixture-token", "grpc.token="),
        ] {
            assert!(parse_discovery(bad.as_bytes(), "Verboo_Device_API_36").is_err());
        }
    }

    #[test]
    fn discovery_authorization_is_sensitive_and_request_debug_redacts_token() {
        let token = "task4-red-token-7x";
        let bytes = format!("avd.id=Verboo_Device_API_36\ngrpc.port=8554\ngrpc.token={token}\n");
        let discovery = parse_discovery(bytes.as_bytes(), "Verboo_Device_API_36").unwrap();
        assert!(discovery.authorization.is_sensitive());

        let authorization = discovery.authorization.clone();
        let mut request = tonic::Request::new(());
        request
            .metadata_mut()
            .insert("authorization", authorization);
        assert!(!format!("{request:?}").contains(token));
    }

    #[test]
    fn endpoint_is_always_ipv4_loopback_and_errors_never_contain_token() {
        assert_eq!(endpoint_uri(8554), "http://127.0.0.1:8554");
        let bytes = b"avd.id=Verboo_Device_API_36\ngrpc.port=bad\ngrpc.token=do-not-leak\n";
        let error = match parse_discovery(bytes, "Verboo_Device_API_36") {
            Err(error) => error,
            Ok(_) => panic!("bad port unexpectedly parsed"),
        };
        assert!(!format!("{error:?}").contains("do-not-leak"));
    }

    #[test]
    fn tonic_status_maps_only_to_the_frozen_failure_vocabulary() {
        assert_eq!(
            map_status(tonic::Status::unauthenticated("x")),
            GrpcError::Unauthenticated
        );
        assert_eq!(
            map_status(tonic::Status::permission_denied("x")),
            GrpcError::Unauthenticated
        );
        assert_eq!(
            map_status(tonic::Status::unimplemented("x")),
            GrpcError::Unsupported
        );
        assert_eq!(
            map_status(tonic::Status::invalid_argument("x")),
            GrpcError::Unsupported
        );
        assert_eq!(
            map_status(tonic::Status::unavailable("x")),
            GrpcError::Unavailable
        );
    }
}
