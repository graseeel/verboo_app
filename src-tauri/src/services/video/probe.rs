use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::models::types::VideoStreamMetadata;

use super::{VideoHdrKind, VideoValidationError, MAX_VIDEO_BYTES, MAX_VIDEO_DURATION_MS};

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_FFPROBE_JSON_BYTES: usize = 1024 * 1024;
const MAX_FFPROBE_STDERR_BYTES: usize = 32 * 1024;
const SUPPORTED_CODECS: &[&str] = &["h264", "hevc", "vp8", "vp9", "av1", "prores"];

pub(crate) struct CappedDrain {
    pub(crate) bytes: Vec<u8>,
    pub(crate) truncated: bool,
}

#[derive(Deserialize)]
struct ProbeDocument {
    format: ProbeFormat,
    #[serde(default)]
    streams: Vec<ProbeStream>,
}

#[derive(Deserialize)]
struct ProbeFormat {
    format_name: Option<String>,
    duration: Option<String>,
    tags: Option<ProbeFormatTags>,
}

#[derive(Deserialize)]
struct ProbeFormatTags {
    major_brand: Option<String>,
}

#[derive(Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    avg_frame_rate: Option<String>,
    color_transfer: Option<String>,
    color_primaries: Option<String>,
    bits_per_raw_sample: Option<String>,
    bits_per_sample: Option<u8>,
    disposition: Option<ProbeDisposition>,
    #[serde(default)]
    side_data_list: Vec<ProbeSideData>,
}

#[derive(Deserialize)]
struct ProbeDisposition {
    attached_pic: Option<u8>,
}

#[derive(Deserialize)]
struct ProbeSideData {
    side_data_type: Option<String>,
}

/// Resolves the Tauri-packaged ffprobe sidecar without consulting PATH.
pub fn bundled_ffprobe_path() -> Result<PathBuf, VideoValidationError> {
    let executable =
        std::env::current_exe().map_err(|_| VideoValidationError::ProtectedOrUnreadable)?;
    #[cfg(debug_assertions)]
    let debug_binaries = Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries"));
    #[cfg(not(debug_assertions))]
    let debug_binaries: Option<PathBuf> = None;

    // A1c (2026-07-30): host_target moved to shared module to eliminate
    // triplication. See video/target.rs for the single source of truth.
    let Some(target) = super::target::host_target() else {
        return Err(VideoValidationError::UnsupportedPlatform {
            os: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
            tool: "verboo-ffprobe".into(),
        });
    };
    ffprobe_candidates(
        &executable,
        debug_binaries.as_deref(),
        target,
        super::target::executable_suffix(),
    )
    .into_iter()
    .find(|candidate| candidate.is_file())
    .ok_or(VideoValidationError::ProtectedOrUnreadable)
}

fn ffprobe_candidates(
    executable: &Path,
    debug_binaries: Option<&Path>,
    target: &str,
    suffix: &str,
) -> Vec<PathBuf> {
    let Some(directory) = executable.parent() else {
        return Vec::new();
    };
    let packaged = directory.join(format!("verboo-ffprobe{suffix}"));
    let target_qualified = format!("verboo-ffprobe-{target}{suffix}");
    let mut candidates = vec![packaged, directory.join(&target_qualified)];
    if let Some(debug_binaries) = debug_binaries {
        candidates.push(debug_binaries.join(target_qualified));
    }
    candidates
}

pub fn probe_and_validate(
    path: &Path,
    size: u64,
    ffprobe: &Path,
) -> Result<VideoStreamMetadata, VideoValidationError> {
    validate_size(size)?;

    let json = run_ffprobe(path, ffprobe)?;
    parse_probe_json(&json)
}

fn validate_size(size: u64) -> Result<(), VideoValidationError> {
    if size > MAX_VIDEO_BYTES {
        return Err(VideoValidationError::TooLarge {
            actual: size,
            maximum: MAX_VIDEO_BYTES,
        });
    }
    Ok(())
}

fn run_ffprobe(path: &Path, ffprobe: &Path) -> Result<String, VideoValidationError> {
    if !ffprobe.is_file() {
        return Err(VideoValidationError::ProtectedOrUnreadable);
    }

    let mut cmd = Command::new(ffprobe);
    cmd.arg("-v")
        .arg("error")
        .arg("-protocol_whitelist")
        .arg("file,pipe")
        .arg("-show_entries")
        .arg("format=format_name,duration:format_tags=major_brand:stream=codec_type,codec_name,width,height,avg_frame_rate,color_transfer,color_primaries,bits_per_raw_sample,bits_per_sample,side_data_list:stream_disposition=attached_pic")
        .arg("-of")
        .arg("json")
        .arg("--")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // A2: suppress console window on Windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::services::child_signal::process_creation_flags());
    }
    let mut child = cmd
        .spawn()
        .map_err(|_| VideoValidationError::ProtectedOrUnreadable)?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| VideoValidationError::ProbeFailed("missing ffprobe stdout".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| VideoValidationError::ProbeFailed("missing ffprobe stderr".to_string()))?;
    let stdout_reader = thread::spawn(move || drain_capped(stdout, MAX_FFPROBE_JSON_BYTES));
    let stderr_reader = thread::spawn(move || drain_capped(stderr, MAX_FFPROBE_STDERR_BYTES));
    let started = Instant::now();

    let process_result = loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                break child
                    .wait()
                    .map(|status| (status, false))
                    .map_err(|error| VideoValidationError::ProbeFailed(error.to_string()))
            }
            Ok(None) if started.elapsed() >= PROBE_TIMEOUT => {
                let _ = child.kill();
                break child
                    .wait()
                    .map(|status| (status, true))
                    .map_err(|error| VideoValidationError::ProbeFailed(error.to_string()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(VideoValidationError::ProbeFailed(error.to_string()));
            }
        }
    };
    let stdout = join_capped_drain(stdout_reader)?;
    let stderr = join_capped_drain(stderr_reader)?;
    let (status, timed_out) = process_result?;
    if timed_out {
        return Err(VideoValidationError::ProbeFailed("timeout".to_string()));
    }
    if stdout.truncated {
        return Err(VideoValidationError::ProbeFailed(
            "ffprobe JSON output exceeded limit".to_string(),
        ));
    }
    if !status.success() {
        return Err(VideoValidationError::ProbeFailed(stderr_message(&stderr)));
    }
    String::from_utf8(stdout.bytes)
        .map_err(|error| VideoValidationError::ProbeFailed(error.to_string()))
}

pub(crate) fn drain_capped<R: Read>(mut reader: R, limit: usize) -> io::Result<CappedDrain> {
    let mut bytes = Vec::with_capacity(limit);
    let mut buffer = [0u8; 8192];
    let mut truncated = false;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok(CappedDrain { bytes, truncated });
        }
        let remaining = limit.saturating_sub(bytes.len());
        let kept = read.min(remaining);
        bytes.extend_from_slice(&buffer[..kept]);
        truncated |= kept < read;
    }
}

fn join_capped_drain(
    reader: thread::JoinHandle<io::Result<CappedDrain>>,
) -> Result<CappedDrain, VideoValidationError> {
    reader
        .join()
        .map_err(|_| {
            VideoValidationError::ProbeFailed("ffprobe drain thread panicked".to_string())
        })?
        .map_err(|error| VideoValidationError::ProbeFailed(error.to_string()))
}

fn stderr_message(stderr: &CappedDrain) -> String {
    let message = String::from_utf8_lossy(&stderr.bytes).trim().to_string();
    let message = if message.is_empty() {
        "ffprobe exited unsuccessfully".to_string()
    } else {
        message
    };
    if stderr.truncated {
        format!("{message} [truncated]")
    } else {
        message
    }
}

fn parse_probe_json(json: &str) -> Result<VideoStreamMetadata, VideoValidationError> {
    let document: ProbeDocument = serde_json::from_str(json)
        .map_err(|error| VideoValidationError::ProbeFailed(error.to_string()))?;
    let duration_seconds = duration_seconds(document.format.duration.as_deref())?;
    if duration_seconds > MAX_VIDEO_DURATION_MS as f64 / 1_000.0 {
        return Err(VideoValidationError::TooLong {
            actual_ms: (duration_seconds * 1_000.0).ceil() as u64,
            maximum_ms: MAX_VIDEO_DURATION_MS,
        });
    }
    let duration_ms = (duration_seconds * 1_000.0).ceil() as u64;

    let container = canonical_container(
        document.format.format_name.as_deref(),
        document
            .format
            .tags
            .as_ref()
            .and_then(|tags| tags.major_brand.as_deref()),
    )?;
    let real_videos: Vec<&ProbeStream> = document
        .streams
        .iter()
        .filter(|stream| {
            stream.codec_type.as_deref() == Some("video") && !is_attached_picture(stream)
        })
        .collect();
    if real_videos.is_empty() {
        return Err(VideoValidationError::MissingVideoStream);
    }
    let video = real_videos
        .iter()
        .copied()
        .find(|stream| is_supported_video_codec(stream) && has_dimensions(stream));
    let Some(video) = video else {
        if real_videos
            .iter()
            .all(|stream| !is_supported_video_codec(stream))
        {
            return Err(unsupported_codec_error(real_videos[0]));
        }
        return Err(VideoValidationError::ProbeFailed(
            "missing usable video dimensions".to_string(),
        ));
    };
    let video_codec = video.codec_name.clone().expect("supported codec exists");
    let width = video.width.expect("usable video width exists");
    let height = video.height.expect("usable video height exists");

    let audio = document
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("audio"));
    Ok(VideoStreamMetadata {
        duration_ms,
        container,
        video_codec,
        audio_codec: audio.and_then(|stream| stream.codec_name.clone()),
        width,
        height,
        avg_fps: parse_fps(video.avg_frame_rate.as_deref()),
        has_audio: audio.is_some(),
        hdr: hdr_kind(video),
        color_primaries: video.color_primaries.clone(),
        color_transfer: video.color_transfer.clone(),
        bit_depth: video
            .bits_per_raw_sample
            .as_deref()
            .and_then(|value| value.parse().ok())
            .or(video.bits_per_sample),
    })
}

fn duration_seconds(value: Option<&str>) -> Result<f64, VideoValidationError> {
    let seconds: f64 = value
        .ok_or_else(|| VideoValidationError::ProbeFailed("missing duration".to_string()))?
        .parse()
        .map_err(|_| VideoValidationError::ProbeFailed("invalid duration".to_string()))?;
    if !seconds.is_finite() || seconds < 0.0 {
        return Err(VideoValidationError::ProbeFailed(
            "invalid duration".to_string(),
        ));
    }
    Ok(seconds)
}

fn canonical_container(
    format_name: Option<&str>,
    major_brand: Option<&str>,
) -> Result<String, VideoValidationError> {
    let raw = format_name.unwrap_or_default();
    let brand = major_brand.unwrap_or_default().trim();
    let container = if raw.contains("mov") {
        match brand {
            "qt" => "mov",
            "M4V" => "m4v",
            _ => "mp4",
        }
    } else if raw.contains("matroska") || raw.contains("webm") {
        "matroska"
    } else if raw.contains("avi") {
        "avi"
    } else {
        return Err(VideoValidationError::UnsupportedContainer(raw.to_string()));
    };
    Ok(container.to_string())
}

fn is_attached_picture(stream: &ProbeStream) -> bool {
    stream
        .disposition
        .as_ref()
        .and_then(|disposition| disposition.attached_pic)
        .unwrap_or_default()
        != 0
}

fn is_supported_video_codec(stream: &ProbeStream) -> bool {
    stream
        .codec_name
        .as_deref()
        .is_some_and(|codec| SUPPORTED_CODECS.contains(&codec))
}

fn has_dimensions(stream: &ProbeStream) -> bool {
    stream.width.is_some_and(|width| width > 0) && stream.height.is_some_and(|height| height > 0)
}

fn unsupported_codec_error(stream: &ProbeStream) -> VideoValidationError {
    VideoValidationError::UnsupportedCodec(
        stream
            .codec_name
            .clone()
            .unwrap_or_else(|| "unknown".to_string()),
    )
}

fn parse_fps(value: Option<&str>) -> f64 {
    let Some(value) = value else { return 0.0 };
    let Some((numerator, denominator)) = value.split_once('/') else {
        return value.parse().unwrap_or(0.0);
    };
    let numerator: f64 = numerator.parse().unwrap_or(0.0);
    let denominator: f64 = denominator.parse().unwrap_or(0.0);
    if denominator == 0.0 {
        0.0
    } else {
        numerator / denominator
    }
}

fn hdr_kind(stream: &ProbeStream) -> VideoHdrKind {
    if stream.side_data_list.iter().any(|side_data| {
        side_data
            .side_data_type
            .as_deref()
            .is_some_and(|value| value.to_ascii_lowercase().contains("dovi"))
    }) {
        return VideoHdrKind::DolbyVision;
    }
    match stream
        .color_transfer
        .as_deref()
        .map(str::to_ascii_lowercase)
    {
        Some(value) if value == "smpte2084" || value == "pq" => VideoHdrKind::Pq,
        Some(value) if value == "arib-std-b67" || value == "hlg" => VideoHdrKind::Hlg,
        Some(value) if value == "bt709" || value == "iec61966-2-1" => VideoHdrKind::Sdr,
        Some(_) => VideoHdrKind::Unknown,
        None => VideoHdrKind::Sdr,
    }
}



#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::path::{Path, PathBuf};

    use super::super::{
        bundled_ffprobe_path, probe_and_validate, VideoHdrKind, VideoValidationError,
        MAX_VIDEO_BYTES, MAX_VIDEO_DURATION_MS,
    };
    use super::{drain_capped, ffprobe_candidates, parse_probe_json};

    const H264_SDR_WITH_AUDIO: &str = r#"{
      "format": { "format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "300.000", "tags": { "major_brand": "isom" } },
      "streams": [
        { "codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080, "avg_frame_rate": "30000/1001", "color_transfer": "bt709", "color_primaries": "bt709", "bits_per_raw_sample": "8" },
        { "codec_type": "audio", "codec_name": "aac" }
      ]
    }"#;

    const HEVC_PQ: &str = r#"{
      "format": { "format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "1.000", "tags": { "major_brand": "qt  " } },
      "streams": [
        { "codec_type": "video", "codec_name": "hevc", "width": 1280, "height": 720, "avg_frame_rate": "24/1", "color_transfer": "smpte2084", "color_primaries": "bt2020", "bits_per_raw_sample": "10" }
      ]
    }"#;

    const NO_VIDEO_STREAM: &str = r#"{
      "format": { "format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "1.000", "tags": { "major_brand": "isom" } },
      "streams": [{ "codec_type": "audio", "codec_name": "aac" }]
    }"#;

    const VP9_WEBM_NO_AUDIO: &str = r#"{
      "format": { "format_name": "matroska,webm", "duration": "1.000" },
      "streams": [
        { "codec_type": "video", "codec_name": "vp9", "width": 640, "height": 360, "avg_frame_rate": "30/1", "color_transfer": "bt709", "bits_per_raw_sample": "8" }
      ]
    }"#;

    const COVER_ART_THEN_H264: &str = r#"{
      "format": { "format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "1.000", "tags": { "major_brand": "isom" } },
      "streams": [
        { "codec_type": "video", "codec_name": "mjpeg", "width": 600, "height": 600, "disposition": { "attached_pic": 1 } },
        { "codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080, "avg_frame_rate": "24/1", "color_transfer": "bt709" }
      ]
    }"#;

    const ONLY_ATTACHED_PICTURE: &str = r#"{
      "format": { "format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "1.000", "tags": { "major_brand": "isom" } },
      "streams": [
        { "codec_type": "video", "codec_name": "mjpeg", "width": 600, "height": 600, "disposition": { "attached_pic": 1 } }
      ]
    }"#;

    const UNSUPPORTED_REAL_VIDEO: &str = r#"{
      "format": { "format_name": "avi", "duration": "1.000" },
      "streams": [
        { "codec_type": "video", "codec_name": "mjpeg", "width": 640, "height": 480 },
        { "codec_type": "video", "codec_name": "theora", "width": 640, "height": 480 }
      ]
    }"#;

    #[test]
    fn ffprobe_candidates_prioritize_the_packaged_unsuffixed_binary() {
        let executable = Path::new("/Applications/Verboo Code.app/Contents/MacOS/verboo-desktop");
        let candidates = ffprobe_candidates(executable, None, "aarch64-apple-darwin", "");

        assert_eq!(
            candidates,
            vec![
                PathBuf::from("/Applications/Verboo Code.app/Contents/MacOS/verboo-ffprobe"),
                PathBuf::from("/Applications/Verboo Code.app/Contents/MacOS/verboo-ffprobe-aarch64-apple-darwin"),
            ]
        );
    }

    #[test]
    fn ffprobe_candidates_keep_target_qualified_debug_binary_and_windows_suffix() {
        let debug_binaries = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let candidates = ffprobe_candidates(
            Path::new("/bundle/verboo-desktop.exe"),
            Some(&debug_binaries),
            "x86_64-pc-windows-msvc",
            ".exe",
        );

        assert_eq!(
            candidates,
            vec![
                PathBuf::from("/bundle/verboo-ffprobe.exe"),
                PathBuf::from("/bundle/verboo-ffprobe-x86_64-pc-windows-msvc.exe"),
                debug_binaries.join("verboo-ffprobe-x86_64-pc-windows-msvc.exe"),
            ]
        );
    }

    #[test]
    fn probe_accepts_valid_metadata_at_inclusive_limits() {
        assert!(super::validate_size(MAX_VIDEO_BYTES).is_ok());
        let metadata =
            parse_probe_json(H264_SDR_WITH_AUDIO).expect("exact duration limit must be accepted");

        assert_eq!(metadata.duration_ms, MAX_VIDEO_DURATION_MS);
        assert_eq!(metadata.container, "mp4");
        assert_eq!(metadata.video_codec, "h264");
        assert_eq!(metadata.audio_codec.as_deref(), Some("aac"));
        assert_eq!(metadata.width, 1920);
        assert_eq!(metadata.height, 1080);
        assert!(metadata.has_audio);
        assert_eq!(metadata.hdr, VideoHdrKind::Sdr);
        assert_eq!(metadata.bit_depth, Some(8));
    }

    #[test]
    fn probe_rejects_one_byte_over_before_spawning_ffprobe() {
        let err = probe_and_validate(
            Path::new("/fixture.mp4"),
            MAX_VIDEO_BYTES + 1,
            Path::new("/does-not-exist/verboo-ffprobe"),
        )
        .expect_err("size must be checked before invoking ffprobe");

        assert_eq!(
            err,
            VideoValidationError::TooLarge {
                actual: MAX_VIDEO_BYTES + 1,
                maximum: MAX_VIDEO_BYTES,
            }
        );
    }

    #[test]
    fn probe_rejects_one_millisecond_over_duration_limit() {
        let err = parse_probe_json(&H264_SDR_WITH_AUDIO.replace("300.000", "300.001"))
            .expect_err("300001ms must be rejected");

        assert_eq!(
            err,
            VideoValidationError::TooLong {
                actual_ms: MAX_VIDEO_DURATION_MS + 1,
                maximum_ms: MAX_VIDEO_DURATION_MS,
            }
        );
    }

    #[test]
    fn probe_rejects_any_duration_fraction_over_five_minutes() {
        let err = parse_probe_json(&H264_SDR_WITH_AUDIO.replace("300.000", "300.0004"))
            .expect_err("duration must be compared before millisecond conversion");

        assert_eq!(
            err,
            VideoValidationError::TooLong {
                actual_ms: MAX_VIDEO_DURATION_MS + 1,
                maximum_ms: MAX_VIDEO_DURATION_MS,
            }
        );
    }

    #[test]
    fn capped_drain_keeps_the_prefix_and_continues_consuming() {
        let drained = drain_capped(Cursor::new(b"abcdefgh".to_vec()), 3).unwrap();

        assert_eq!(drained.bytes, b"abc");
        assert!(drained.truncated);
    }

    #[test]
    fn bundled_ffprobe_accepts_the_h264_sdr_fixture() {
        let path = video_fixture("h264-sdr-aac.mp4");
        let metadata = probe_and_validate(
            &path,
            std::fs::metadata(&path).unwrap().len(),
            &bundled_ffprobe_path().unwrap(),
        )
        .unwrap();

        assert_eq!(metadata.container, "mp4");
        assert_eq!(metadata.video_codec, "h264");
        assert_eq!(metadata.audio_codec.as_deref(), Some("aac"));
        assert_eq!(metadata.hdr, VideoHdrKind::Sdr);
    }

    #[test]
    fn bundled_ffprobe_rejects_the_audio_only_fixture() {
        let path = video_fixture("audio-only-aac.mp4");
        let error = probe_and_validate(
            &path,
            std::fs::metadata(&path).unwrap().len(),
            &bundled_ffprobe_path().unwrap(),
        )
        .unwrap_err();

        assert_eq!(error, VideoValidationError::MissingVideoStream);
    }

    #[test]
    fn bundled_ffprobe_reads_the_hevc_pq_fixture() {
        let path = video_fixture("hevc-pq.mov");
        let metadata = probe_and_validate(
            &path,
            std::fs::metadata(&path).unwrap().len(),
            &bundled_ffprobe_path().unwrap(),
        )
        .unwrap();

        assert_eq!(metadata.video_codec, "hevc");
        assert_eq!(metadata.hdr, VideoHdrKind::Pq);
    }

    #[test]
    fn bundled_ffprobe_reads_the_vp9_no_audio_fixture() {
        let path = video_fixture("vp9-no-audio.webm");
        let metadata = probe_and_validate(
            &path,
            std::fs::metadata(&path).unwrap().len(),
            &bundled_ffprobe_path().unwrap(),
        )
        .unwrap();

        assert_eq!(metadata.container, "matroska");
        assert_eq!(metadata.video_codec, "vp9");
        assert!(!metadata.has_audio);
        assert_eq!(metadata.audio_codec, None);
    }

    fn video_fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/video")
            .join(name)
    }

    #[test]
    fn probe_maps_hdr_from_actual_stream_metadata() {
        let metadata = parse_probe_json(HEVC_PQ).unwrap();

        assert_eq!(metadata.container, "mov");
        assert_eq!(metadata.video_codec, "hevc");
        assert_eq!(metadata.hdr, VideoHdrKind::Pq);
        assert!(!metadata.has_audio);
    }

    #[test]
    fn probe_accepts_vp9_webm_without_audio() {
        let metadata = parse_probe_json(VP9_WEBM_NO_AUDIO).unwrap();

        assert_eq!(metadata.container, "matroska");
        assert_eq!(metadata.video_codec, "vp9");
        assert_eq!(metadata.audio_codec, None);
        assert!(!metadata.has_audio);
        assert_eq!(metadata.hdr, VideoHdrKind::Sdr);
    }

    #[test]
    fn probe_skips_attached_cover_art_for_the_first_usable_video_stream() {
        let metadata = parse_probe_json(COVER_ART_THEN_H264).unwrap();

        assert_eq!(metadata.video_codec, "h264");
        assert_eq!((metadata.width, metadata.height), (1920, 1080));
    }

    #[test]
    fn probe_rejects_a_container_with_only_attached_pictures() {
        let err = parse_probe_json(ONLY_ATTACHED_PICTURE).unwrap_err();

        assert_eq!(err, VideoValidationError::MissingVideoStream);
    }

    #[test]
    fn probe_reports_the_first_unsupported_real_video_codec() {
        let err = parse_probe_json(UNSUPPORTED_REAL_VIDEO).unwrap_err();

        assert_eq!(err, VideoValidationError::UnsupportedCodec("mjpeg".into()));
    }

    #[test]
    fn probe_rejects_a_container_without_a_video_stream() {
        let err = parse_probe_json(NO_VIDEO_STREAM)
            .expect_err("audio-only containers are not video attachments");

        assert_eq!(err, VideoValidationError::MissingVideoStream);
    }
}
