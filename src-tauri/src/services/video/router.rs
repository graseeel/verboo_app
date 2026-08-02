use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use crate::models::types::{
    CliMediaCapabilities, ModelMediaCapabilities, VideoHdrKind, VideoStreamMetadata,
};

const KNOWN_CONTAINERS: &[&str] = &["mp4", "mov", "webm", "matroska", "avi", "m4v"];
const KNOWN_VIDEO_CODECS: &[&str] = &["h264", "hevc", "vp8", "vp9", "av1", "prores"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoRoute {
    NativeOriginal,
    NativeSdrProxy { transcribe_audio_locally: bool },
    SampledFrames { transcribe_audio_locally: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MediaToolchainCapabilities {
    pub h264_sdr_proxy_encoder: bool,
}

pub fn choose_video_route(
    model: &ModelMediaCapabilities,
    cli: &CliMediaCapabilities,
    toolchain: &MediaToolchainCapabilities,
    video: &VideoStreamMetadata,
) -> VideoRoute {
    let transcribe_audio_locally = needs_local_audio_transcription(model, cli, video);
    let known_input = is_known(&video.container, KNOWN_CONTAINERS)
        && is_known(&video.video_codec, KNOWN_VIDEO_CODECS)
        && video.hdr != VideoHdrKind::Unknown;
    if !known_input {
        return VideoRoute::SampledFrames {
            transcribe_audio_locally,
        };
    }

    let native_transport = model.video && cli.video_blocks;
    let original_is_compatible = native_transport
        && declares(&model.video_containers, &video.container)
        && declares(&model.video_codecs, &video.video_codec)
        && (video.hdr == VideoHdrKind::Sdr || model.accepts_hdr_video);

    if original_is_compatible {
        // A compatible native video block carries its multiplexed audio. The
        // separate audio-block capability only governs fallback extraction.
        return VideoRoute::NativeOriginal;
    }

    let proxy_is_compatible = native_transport
        && toolchain.h264_sdr_proxy_encoder
        && declares(&model.video_containers, "mp4")
        && declares(&model.video_codecs, "h264");
    if proxy_is_compatible {
        return VideoRoute::NativeSdrProxy {
            transcribe_audio_locally,
        };
    }

    VideoRoute::SampledFrames {
        transcribe_audio_locally,
    }
}

fn needs_local_audio_transcription(
    model: &ModelMediaCapabilities,
    cli: &CliMediaCapabilities,
    video: &VideoStreamMetadata,
) -> bool {
    if !video.has_audio {
        return false;
    }
    let audio_metadata_is_known = video
        .audio_codec
        .as_deref()
        .is_some_and(|codec| !codec.trim().is_empty());
    !(audio_metadata_is_known && model.audio && cli.audio_blocks)
}

fn declares(values: &[String], required: &str) -> bool {
    let required = required.trim();
    !required.is_empty()
        && values
            .iter()
            .any(|value| value.trim().eq_ignore_ascii_case(required))
}

fn is_known(value: &str, known: &[&str]) -> bool {
    let value = value.trim();
    !value.is_empty()
        && known
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(value))
}

static DETECTED_TOOLCHAIN: OnceLock<MediaToolchainCapabilities> = OnceLock::new();

/// Detects the packaged proxy encoder once for the lifetime of the process.
/// The bundled sidecar is the only source; the user's PATH is never consulted.
pub fn detected_media_toolchain_capabilities() -> MediaToolchainCapabilities {
    *DETECTED_TOOLCHAIN.get_or_init(detect_bundled_toolchain)
}

fn detect_bundled_toolchain() -> MediaToolchainCapabilities {
    let h264_sdr_proxy_encoder = bundled_ffmpeg_path()
        .and_then(|ffmpeg| encoder_listing(&ffmpeg))
        .is_some_and(|listing| proxy_encoder_available_for(current_platform(), &listing));
    MediaToolchainCapabilities {
        h264_sdr_proxy_encoder,
    }
}

fn encoder_listing(ffmpeg: &Path) -> Option<String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-hide_banner")
        .arg("-encoders")
        .stdin(Stdio::null());
    crate::services::cli_spawn::apply_creation_flags(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let mut listing = String::from_utf8(output.stdout).ok()?;
    listing.push_str(&String::from_utf8_lossy(&output.stderr));
    Some(listing)
}

fn bundled_ffmpeg_path() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let executable_dir = executable.parent()?;
    // A1c (2026-07-30): host_target/executable_suffix moved to
    // shared module. See video/target.rs for the single source of truth.
    let Some(target) = super::target::host_target() else {
        return None;
    };
    let suffix = super::target::executable_suffix();
    let target_name = format!("verboo-ffmpeg-{target}{suffix}");
    let packaged_name = format!("verboo-ffmpeg{suffix}");
    let mut candidates = vec![
        executable_dir.join(&packaged_name),
        executable_dir.join(&target_name),
    ];

    #[cfg(target_os = "macos")]
    if let Some(contents) = executable_dir.parent() {
        candidates.insert(0, contents.join("Resources").join(&packaged_name));
        candidates.insert(1, contents.join("Resources").join(&target_name));
    }

    #[cfg(debug_assertions)]
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(target_name),
    );

    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn proxy_encoder_available_for(platform: &str, listing: &str) -> bool {
    let required = match platform {
        "macos" => "h264_videotoolbox",
        "windows" => "h264_mf",
        _ => return false,
    };
    listing
        .lines()
        .flat_map(str::split_whitespace)
        .any(|token| token == required)
}

fn current_platform() -> &'static str {
    #[cfg(target_os = "macos")]
    return "macos";
    #[cfg(target_os = "windows")]
    return "windows";
    #[cfg(target_os = "linux")]
    return "linux";
    #[allow(unreachable_code)]
    "unknown"
}

#[cfg(test)]
mod tests {
    use crate::models::types::{
        CliMediaCapabilities, ModelMediaCapabilities, VideoHdrKind, VideoStreamMetadata,
    };
    use crate::services::turn_service::bundled_cli_0_13_0_media_capabilities;

    use super::{
        choose_video_route, proxy_encoder_available_for, MediaToolchainCapabilities, VideoRoute,
    };

    fn model() -> ModelMediaCapabilities {
        ModelMediaCapabilities {
            image: true,
            video: true,
            audio: true,
            video_containers: vec![
                "mp4".into(),
                "mov".into(),
                "webm".into(),
                "matroska".into(),
                "avi".into(),
                "m4v".into(),
            ],
            video_codecs: vec![
                "h264".into(),
                "hevc".into(),
                "vp8".into(),
                "vp9".into(),
                "av1".into(),
                "prores".into(),
            ],
            accepts_hdr_video: true,
        }
    }

    fn cli() -> CliMediaCapabilities {
        CliMediaCapabilities {
            image_blocks: true,
            video_blocks: true,
            audio_blocks: true,
        }
    }

    fn toolchain(proxy_encoder: bool) -> MediaToolchainCapabilities {
        MediaToolchainCapabilities {
            h264_sdr_proxy_encoder: proxy_encoder,
        }
    }

    fn video(container: &str, codec: &str, hdr: VideoHdrKind) -> VideoStreamMetadata {
        VideoStreamMetadata {
            duration_ms: 1_000,
            container: container.into(),
            video_codec: codec.into(),
            audio_codec: Some("aac".into()),
            width: 1_920,
            height: 1_080,
            avg_fps: 30.0,
            has_audio: true,
            hdr,
            color_primaries: Some("bt709".into()),
            color_transfer: Some("bt709".into()),
            bit_depth: Some(8),
        }
    }

    #[test]
    fn compatible_h264_sdr_uses_native_original() {
        assert_eq!(
            choose_video_route(
                &model(),
                &cli(),
                &toolchain(false),
                &video("mp4", "h264", VideoHdrKind::Sdr),
            ),
            VideoRoute::NativeOriginal,
        );
    }

    #[test]
    fn compatible_hdr_and_supported_codecs_use_native_original() {
        for (container, codec, hdr) in [
            ("mov", "hevc", VideoHdrKind::Pq),
            ("webm", "vp9", VideoHdrKind::Sdr),
            ("mp4", "av1", VideoHdrKind::Sdr),
            ("mov", "prores", VideoHdrKind::Hlg),
        ] {
            assert_eq!(
                choose_video_route(
                    &model(),
                    &cli(),
                    &toolchain(false),
                    &video(container, codec, hdr)
                ),
                VideoRoute::NativeOriginal,
                "expected {container}/{codec} to remain native",
            );
        }
    }

    #[test]
    fn native_original_keeps_multiplexed_audio_when_separate_audio_blocks_are_unavailable() {
        let mut cli = cli();
        cli.audio_blocks = false;

        assert_eq!(
            choose_video_route(
                &model(),
                &cli,
                &toolchain(false),
                &video("mp4", "h264", VideoHdrKind::Sdr),
            ),
            VideoRoute::NativeOriginal,
        );
    }

    #[test]
    fn incompatible_original_uses_verified_h264_sdr_proxy() {
        let mut model = model();
        model.video_containers = vec!["mp4".into()];
        model.video_codecs = vec!["h264".into()];
        model.accepts_hdr_video = false;

        assert_eq!(
            choose_video_route(
                &model,
                &cli(),
                &toolchain(true),
                &video("mov", "hevc", VideoHdrKind::Pq),
            ),
            VideoRoute::NativeSdrProxy {
                transcribe_audio_locally: false,
            },
        );
    }

    #[test]
    fn incompatible_original_without_proxy_encoder_uses_sampled_frames() {
        let mut model = model();
        model.video_containers = vec!["mp4".into()];
        model.video_codecs = vec!["h264".into()];
        model.accepts_hdr_video = false;

        assert_eq!(
            choose_video_route(
                &model,
                &cli(),
                &toolchain(false),
                &video("mov", "hevc", VideoHdrKind::Pq),
            ),
            VideoRoute::SampledFrames {
                transcribe_audio_locally: false,
            },
        );
    }

    #[test]
    fn proxy_requires_declared_h264_mp4_model_support() {
        let mut model = model();
        model.video_containers = vec!["mov".into()];
        model.video_codecs = vec!["hevc".into()];
        model.accepts_hdr_video = false;

        assert_eq!(
            choose_video_route(
                &model,
                &cli(),
                &toolchain(true),
                &video("mov", "hevc", VideoHdrKind::Pq),
            ),
            VideoRoute::SampledFrames {
                transcribe_audio_locally: false,
            },
        );
    }

    #[test]
    fn model_or_cli_without_video_uses_sampled_frames() {
        let mut no_model_video = model();
        no_model_video.video = false;
        let mut no_cli_video = cli();
        no_cli_video.video_blocks = false;
        let input = video("mp4", "h264", VideoHdrKind::Sdr);

        assert_eq!(
            choose_video_route(&no_model_video, &cli(), &toolchain(true), &input),
            VideoRoute::SampledFrames {
                transcribe_audio_locally: false,
            },
        );
        assert_eq!(
            choose_video_route(&model(), &no_cli_video, &toolchain(true), &input),
            VideoRoute::SampledFrames {
                transcribe_audio_locally: false,
            },
        );
    }

    #[test]
    fn empty_or_unknown_capabilities_fail_closed() {
        let mut missing_model_lists = model();
        missing_model_lists.video_containers.clear();
        missing_model_lists.video_codecs.clear();
        let input = video("mp4", "h264", VideoHdrKind::Sdr);

        assert_eq!(
            choose_video_route(&missing_model_lists, &cli(), &toolchain(true), &input),
            VideoRoute::SampledFrames {
                transcribe_audio_locally: false,
            },
        );

        for unknown in [
            video("", "h264", VideoHdrKind::Sdr),
            video("mp4", "", VideoHdrKind::Sdr),
            video("mp4", "h264", VideoHdrKind::Unknown),
        ] {
            assert_eq!(
                choose_video_route(&model(), &cli(), &toolchain(true), &unknown),
                VideoRoute::SampledFrames {
                    transcribe_audio_locally: false,
                },
            );
        }
    }

    #[test]
    fn local_audio_transcription_requires_an_audio_track_and_effective_audio_blocks() {
        let input = video("avi", "vp9", VideoHdrKind::Sdr);
        let mut no_model_audio = model();
        no_model_audio.audio = false;
        no_model_audio.video = false;
        let mut no_cli_audio = cli();
        no_cli_audio.audio_blocks = false;
        no_cli_audio.video_blocks = false;

        assert_eq!(
            choose_video_route(&no_model_audio, &cli(), &toolchain(false), &input),
            VideoRoute::SampledFrames {
                transcribe_audio_locally: true,
            },
        );
        assert_eq!(
            choose_video_route(&model(), &no_cli_audio, &toolchain(false), &input),
            VideoRoute::SampledFrames {
                transcribe_audio_locally: true,
            },
        );

        let mut silent = input;
        silent.has_audio = false;
        silent.audio_codec = None;
        assert_eq!(
            choose_video_route(&no_model_audio, &no_cli_audio, &toolchain(false), &silent),
            VideoRoute::SampledFrames {
                transcribe_audio_locally: false,
            },
        );

        let mut unknown_audio = video("avi", "vp9", VideoHdrKind::Sdr);
        unknown_audio.audio_codec = None;
        assert_eq!(
            choose_video_route(&no_model_audio, &cli(), &toolchain(false), &unknown_audio),
            VideoRoute::SampledFrames {
                transcribe_audio_locally: true,
            },
        );
    }

    #[test]
    fn proxy_marks_audio_for_local_transcription_when_audio_blocks_are_incompatible() {
        let mut model = model();
        model.video_containers = vec!["mp4".into()];
        model.video_codecs = vec!["h264".into()];
        model.accepts_hdr_video = false;
        let mut cli = cli();
        cli.audio_blocks = false;

        assert_eq!(
            choose_video_route(
                &model,
                &cli,
                &toolchain(true),
                &video("mov", "hevc", VideoHdrKind::Pq),
            ),
            VideoRoute::NativeSdrProxy {
                transcribe_audio_locally: true,
            },
        );
    }

    #[test]
    fn current_bundled_cli_is_explicitly_image_only() {
        let capabilities = bundled_cli_0_13_0_media_capabilities();
        assert!(capabilities.image_blocks);
        assert!(!capabilities.video_blocks);
        assert!(!capabilities.audio_blocks);

        assert_eq!(
            choose_video_route(
                &model(),
                &capabilities,
                &toolchain(true),
                &video("mp4", "h264", VideoHdrKind::Sdr),
            ),
            VideoRoute::SampledFrames {
                transcribe_audio_locally: true,
            },
        );
    }

    #[test]
    fn encoder_listing_is_platform_specific_and_fail_closed() {
        let listing = " V..... h264_mf\n V..... h264_videotoolbox\n";
        assert!(proxy_encoder_available_for("macos", listing));
        assert!(proxy_encoder_available_for("windows", listing));
        assert!(!proxy_encoder_available_for("linux", listing));
        assert!(!proxy_encoder_available_for("unknown", listing));
        assert!(!proxy_encoder_available_for("macos", " V..... h264_mf\n"));
        assert!(!proxy_encoder_available_for(
            "windows",
            " V..... h264_videotoolbox\n",
        ));
    }

    #[test]
    fn provider_names_do_not_influence_routes() {
        let source = include_str!("router.rs");
        let production_source = source.split("#[cfg(test)]").next().unwrap_or(source);
        for provider in ["anthropic", "openai", "google", "claude", "gemini"] {
            assert!(
                !production_source.to_ascii_lowercase().contains(provider),
                "router must not contain provider-specific name {provider}",
            );
        }
    }
}
