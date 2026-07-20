use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use image::imageops::FilterType;
use image::{GenericImage, Rgb, RgbImage};

use crate::models::types::{VideoHdrKind, VideoStreamMetadata};

use super::job::{ManagedVideoChild, VideoJob};
use super::probe::drain_capped;
use super::router::VideoRoute;
use super::{VideoWarning, MAX_OCR_FRAMES, MAX_VISUAL_FRAMES};

const SCENE_THRESHOLD: &str = "0.30";
const TARGET_SAMPLE_INTERVAL_MS: u64 = 2_500;
const MIN_UNIFORM_FRAMES: usize = 8;
const MAX_CANDIDATE_FRAMES: usize = 180;
const DUPLICATE_HAMMING_DISTANCE: u32 = 4;
/// Even near-identical content keeps one frame at least this often so a
/// mostly-static screen recording still gets temporal coverage.
const DEDUP_MAX_GAP_MS: u64 = 5_000;
const SHEET_COLUMNS: u32 = 4;
const SHEET_ROWS: u32 = 3;
const SHEET_CELL_WIDTH: u32 = 320;
const SHEET_CELL_HEIGHT: u32 = 180;
const FRAMES_PER_SHEET: usize = (SHEET_COLUMNS * SHEET_ROWS) as usize;
const MAX_CONTACT_SHEETS: usize = 10;
const MEDIA_TOOL_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_TOOL_STDERR_BYTES: usize = 512 * 1024;
const CANCEL_POLL: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimestampedFrame {
    pub timestamp_ms: u64,
    pub path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContactSheet {
    pub path: PathBuf,
    pub timestamps_ms: Vec<u64>,
}

#[derive(Debug, Default)]
pub struct PreparedVideo {
    pub visual_frames: Vec<TimestampedFrame>,
    pub ocr_frames: Vec<TimestampedFrame>,
    pub contact_sheets: Vec<ContactSheet>,
    pub audio_wav: Option<PathBuf>,
    pub native_path: Option<PathBuf>,
    pub warnings: Vec<VideoWarning>,
}

/// Resolves a Tauri-packaged media sidecar next to the app executable without
/// consulting PATH. Mirrors the ffprobe resolution used by the probe module.
pub fn bundled_media_tool(base: &str) -> Result<PathBuf, String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("resolve app executable: {error}"))?;
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let target = host_target();
    let mut candidates = Vec::new();
    if let Some(directory) = executable.parent() {
        candidates.push(directory.join(format!("{base}{suffix}")));
        candidates.push(directory.join(format!("{base}-{target}{suffix}")));
    }
    #[cfg(debug_assertions)]
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("{base}-{target}{suffix}")),
    );
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| format!("bundled media tool {base} is missing"))
}

pub fn bundled_ffmpeg_path() -> Result<PathBuf, String> {
    bundled_media_tool("verboo-ffmpeg")
}

fn host_target() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "aarch64-apple-darwin";
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return "x86_64-apple-darwin";
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "x86_64-pc-windows-msvc";
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "x86_64-unknown-linux-gnu";
    #[allow(unreachable_code)]
    "unsupported"
}

/// Runs one bundled media tool under the job's cancellation token. Arguments
/// are always a vector — never a shell string — and stderr is capped.
pub(crate) fn run_media_tool(
    job: &VideoJob,
    tool: &Path,
    args: &[OsString],
) -> Result<String, String> {
    if job.is_cancelled() {
        return Err("video job was cancelled".to_string());
    }
    let mut command = Command::new(tool);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("spawn media tool: {error}"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "missing media tool stderr".to_string())?;
    let stderr_reader = thread::spawn(move || drain_capped(stderr, MAX_TOOL_STDERR_BYTES));
    let managed = std::sync::Arc::new(ManagedVideoChild::new(child));
    let _registration = job.register_process(managed.clone())?;

    let started = Instant::now();
    let status = loop {
        if job.is_cancelled() {
            use super::job::VideoProcess;
            managed.interrupt();
            let _ = managed.with_child(|child| child.wait());
            drop(stderr_reader);
            return Err("video job was cancelled".to_string());
        }
        match managed.with_child(|child| child.try_wait()) {
            Some(Ok(Some(status))) => break status,
            Some(Ok(None)) => {
                if started.elapsed() >= MEDIA_TOOL_TIMEOUT {
                    use super::job::VideoProcess;
                    managed.interrupt();
                    let _ = managed.with_child(|child| child.wait());
                    drop(stderr_reader);
                    return Err("media tool timed out".to_string());
                }
                thread::sleep(CANCEL_POLL);
            }
            Some(Err(error)) => return Err(format!("await media tool: {error}")),
            None => return Err("media tool handle poisoned".to_string()),
        }
    };
    let drained = stderr_reader
        .join()
        .map_err(|_| "media tool stderr thread panicked".to_string())?
        .map_err(|error| format!("read media tool stderr: {error}"))?;
    let stderr_text = String::from_utf8_lossy(&drained.bytes).to_string();
    if !status.success() {
        let trimmed = stderr_text.trim();
        return Err(if trimmed.is_empty() {
            "media tool exited unsuccessfully".to_string()
        } else {
            format!("media tool failed: {trimmed}")
        });
    }
    Ok(stderr_text)
}

/// Uniform timestamps guaranteeing first/last coverage at an adaptive density.
pub(crate) fn plan_uniform_timestamps(duration_ms: u64, maximum: usize) -> Vec<u64> {
    if duration_ms == 0 || maximum == 0 {
        return vec![0];
    }
    let adaptive = (duration_ms / TARGET_SAMPLE_INTERVAL_MS) as usize + 1;
    let count = adaptive
        .clamp(MIN_UNIFORM_FRAMES.min(maximum), maximum)
        .max(2);
    let last = duration_ms.saturating_sub(1);
    let mut stamps: Vec<u64> = (0..count)
        .map(|index| (last as u128 * index as u128 / (count as u128 - 1)) as u64)
        .collect();
    stamps.dedup();
    stamps
}

/// Merges scene-change candidates with uniform coverage, sorted and capped.
pub(crate) fn merge_candidates(scene_ms: &[u64], uniform_ms: &[u64], maximum: usize) -> Vec<u64> {
    let mut merged: Vec<u64> = scene_ms.iter().chain(uniform_ms.iter()).copied().collect();
    merged.sort_unstable();
    merged.dedup();
    // Coalesce timestamps closer than a third of the target interval; scene
    // cuts win because uniform stamps can be regenerated anywhere.
    let mut coalesced: Vec<u64> = Vec::with_capacity(merged.len());
    for stamp in merged {
        match coalesced.last() {
            Some(&previous) if stamp - previous < TARGET_SAMPLE_INTERVAL_MS / 3 => {}
            _ => coalesced.push(stamp),
        }
    }
    if coalesced.len() > maximum {
        let length = coalesced.len();
        coalesced = (0..maximum)
            .map(|index| coalesced[index * (length - 1) / (maximum - 1)])
            .collect();
        coalesced.dedup();
    }
    coalesced
}

/// 64-bit average hash over an 8x8 grayscale reduction.
pub(crate) fn average_hash(gray64: &[u8; 64]) -> u64 {
    let sum: u32 = gray64.iter().map(|&value| value as u32).sum();
    let mean = sum / 64;
    gray64
        .iter()
        .enumerate()
        .fold(0u64, |hash, (index, &value)| {
            if value as u32 > mean {
                hash | (1 << index)
            } else {
                hash
            }
        })
}

pub(crate) fn is_perceptual_duplicate(first: u64, second: u64) -> bool {
    (first ^ second).count_ones() <= DUPLICATE_HAMMING_DISTANCE
}

/// Chunks visual frames into labeled 4x3 sheets, bounded at ten sheets.
pub(crate) fn plan_contact_sheets(timestamps_ms: &[u64]) -> Vec<Vec<u64>> {
    timestamps_ms
        .chunks(FRAMES_PER_SHEET)
        .take(MAX_CONTACT_SHEETS)
        .map(<[u64]>::to_vec)
        .collect()
}

/// Filter chain that normalizes any recognized input to SDR BT.709 frames.
pub(crate) fn frame_filter_chain(hdr: VideoHdrKind, select_expr: &str) -> String {
    let base = format!("select='{select_expr}',showinfo,scale=w='min(1280,iw)':h=-2");
    match hdr {
        VideoHdrKind::Sdr => format!("{base},format=rgb24"),
        _ => format!(
            "{base},zscale=t=linear:npl=100,tonemap=hable,\
             zscale=p=bt709:t=bt709:m=bt709:r=tv,format=rgb24"
        ),
    }
}

pub(crate) fn select_expression(timestamps_ms: &[u64], avg_fps: f64) -> String {
    let half_window = if avg_fps > 0.0 {
        (1.0 / (2.0 * avg_fps)).clamp(0.001, 0.5)
    } else {
        0.02
    };
    timestamps_ms
        .iter()
        .map(|&stamp| {
            let seconds = stamp as f64 / 1_000.0;
            format!(
                "between(t\\,{:.4}\\,{:.4})",
                (seconds - half_window).max(0.0),
                seconds + half_window
            )
        })
        .collect::<Vec<_>>()
        .join("+")
}

pub(crate) fn frame_extract_args(
    ffmpeg: &Path,
    original: &Path,
    filter_chain: &str,
    output_pattern: &Path,
) -> Vec<OsString> {
    let _ = ffmpeg;
    vec![
        OsString::from("-hide_banner"),
        OsString::from("-nostdin"),
        OsString::from("-v"),
        OsString::from("info"),
        OsString::from("-protocol_whitelist"),
        OsString::from("file,pipe"),
        OsString::from("-i"),
        original.into(),
        OsString::from("-vf"),
        OsString::from(filter_chain),
        OsString::from("-fps_mode"),
        OsString::from("vfr"),
        OsString::from("-f"),
        OsString::from("image2"),
        OsString::from("-y"),
        output_pattern.into(),
    ]
}

/// Scene-change probing writes tiny 8x8 PNGs into a scratch directory:
/// the bundled LGPL FFmpeg has no `null` muxer, so `image2` is the
/// cheapest sink that exists on every target. Timestamps come from the
/// showinfo lines on stderr; the probe frames themselves are discarded.
pub(crate) fn scene_detect_args(original: &Path, probe_pattern: &Path) -> Vec<OsString> {
    vec![
        OsString::from("-hide_banner"),
        OsString::from("-nostdin"),
        OsString::from("-v"),
        OsString::from("info"),
        OsString::from("-protocol_whitelist"),
        OsString::from("file,pipe"),
        OsString::from("-i"),
        original.into(),
        OsString::from("-vf"),
        OsString::from(format!(
            "select='gt(scene\\,{SCENE_THRESHOLD})',showinfo,scale=8:8"
        )),
        OsString::from("-fps_mode"),
        OsString::from("vfr"),
        OsString::from("-f"),
        OsString::from("image2"),
        OsString::from("-y"),
        probe_pattern.into(),
    ]
}

pub(crate) fn audio_extract_args(original: &Path, output: &Path) -> Vec<OsString> {
    vec![
        OsString::from("-hide_banner"),
        OsString::from("-nostdin"),
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-protocol_whitelist"),
        OsString::from("file,pipe"),
        OsString::from("-i"),
        original.into(),
        OsString::from("-vn"),
        OsString::from("-acodec"),
        OsString::from("pcm_s16le"),
        OsString::from("-ac"),
        OsString::from("1"),
        OsString::from("-ar"),
        OsString::from("16000"),
        OsString::from("-f"),
        OsString::from("wav"),
        OsString::from("-y"),
        output.into(),
    ]
}

/// H.264/AAC MP4 SDR BT.709 proxy using the platform's non-GPL encoder.
pub(crate) fn sdr_proxy_args(
    original: &Path,
    hdr: VideoHdrKind,
    has_audio: bool,
    encoder: &str,
    output: &Path,
) -> Vec<OsString> {
    let filter = match hdr {
        VideoHdrKind::Sdr => "scale=w='min(1920,iw)':h=-2,format=yuv420p".to_string(),
        _ => "scale=w='min(1920,iw)':h=-2,zscale=t=linear:npl=100,tonemap=hable,\
              zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p"
            .to_string(),
    };
    let mut args = vec![
        OsString::from("-hide_banner"),
        OsString::from("-nostdin"),
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-protocol_whitelist"),
        OsString::from("file,pipe"),
        OsString::from("-i"),
        original.into(),
        OsString::from("-vf"),
        OsString::from(filter),
        OsString::from("-c:v"),
        OsString::from(encoder),
    ];
    if has_audio {
        args.push(OsString::from("-c:a"));
        args.push(OsString::from("aac"));
    } else {
        args.push(OsString::from("-an"));
    }
    args.push(OsString::from("-f"));
    args.push(OsString::from("mp4"));
    args.push(OsString::from("-y"));
    args.push(output.into());
    args
}

/// Extracts `pts_time:` stamps from ffmpeg showinfo stderr, in order.
pub(crate) fn parse_showinfo_timestamps(stderr: &str) -> Vec<u64> {
    stderr
        .lines()
        .filter(|line| line.contains("Parsed_showinfo"))
        .filter_map(|line| {
            let start = line.find("pts_time:")? + "pts_time:".len();
            let rest = &line[start..];
            let end = rest
                .find(|character: char| !(character.is_ascii_digit() || character == '.'))
                .unwrap_or(rest.len());
            rest[..end].parse::<f64>().ok()
        })
        .map(|seconds| (seconds * 1_000.0).round() as u64)
        .collect()
}

fn frame_hash(path: &Path) -> Result<u64, String> {
    let image = image::open(path).map_err(|error| format!("decode frame: {error}"))?;
    let reduced = image.resize_exact(8, 8, FilterType::Triangle).to_luma8();
    let mut gray = [0u8; 64];
    for (index, pixel) in reduced.pixels().enumerate().take(64) {
        gray[index] = pixel.0[0];
    }
    Ok(average_hash(&gray))
}

fn format_timestamp(timestamp_ms: u64) -> String {
    let total_seconds = timestamp_ms / 1_000;
    format!(
        "{:02}:{:02}.{:03}",
        total_seconds / 60,
        total_seconds % 60,
        timestamp_ms % 1_000
    )
}

// 5x7 bitmap glyphs for the timestamp label characters (digits, colon, dot).
fn glyph(character: char) -> [u8; 7] {
    match character {
        '0' => [
            0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
        ],
        '1' => [
            0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
        ],
        '2' => [
            0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111,
        ],
        '3' => [
            0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110,
        ],
        '4' => [
            0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
        ],
        '5' => [
            0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110,
        ],
        '6' => [
            0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
        ],
        '7' => [
            0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
        ],
        '8' => [
            0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
        ],
        '9' => [
            0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100,
        ],
        ':' => [
            0b00000, 0b00100, 0b00100, 0b00000, 0b00100, 0b00100, 0b00000,
        ],
        '.' => [
            0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00110, 0b00110,
        ],
        _ => [0; 7],
    }
}

fn draw_label(target: &mut RgbImage, text: &str, origin_x: u32, origin_y: u32) {
    const SCALE: u32 = 2;
    let label_width = (text.chars().count() as u32) * 6 * SCALE + 4;
    let label_height = 7 * SCALE + 4;
    for y in 0..label_height {
        for x in 0..label_width {
            let px = origin_x + x;
            let py = origin_y + y;
            if px < target.width() && py < target.height() {
                target.put_pixel(px, py, Rgb([0, 0, 0]));
            }
        }
    }
    let mut cursor = origin_x + 2;
    for character in text.chars() {
        let rows = glyph(character);
        for (row, bits) in rows.iter().enumerate() {
            for column in 0..5u32 {
                if bits & (1 << (4 - column)) != 0 {
                    for dy in 0..SCALE {
                        for dx in 0..SCALE {
                            let px = cursor + column * SCALE + dx;
                            let py = origin_y + 2 + row as u32 * SCALE + dy;
                            if px < target.width() && py < target.height() {
                                target.put_pixel(px, py, Rgb([255, 255, 255]));
                            }
                        }
                    }
                }
            }
        }
        cursor += 6 * SCALE;
    }
}

fn compose_contact_sheet(
    frames: &[TimestampedFrame],
    output: &Path,
) -> Result<ContactSheet, String> {
    let mut sheet = RgbImage::from_pixel(
        SHEET_COLUMNS * SHEET_CELL_WIDTH,
        SHEET_ROWS * SHEET_CELL_HEIGHT,
        Rgb([16, 16, 16]),
    );
    let mut timestamps = Vec::with_capacity(frames.len());
    for (index, frame) in frames.iter().enumerate() {
        let cell_x = (index as u32 % SHEET_COLUMNS) * SHEET_CELL_WIDTH;
        let cell_y = (index as u32 / SHEET_COLUMNS) * SHEET_CELL_HEIGHT;
        let image = image::open(&frame.path)
            .map_err(|error| format!("open frame for contact sheet: {error}"))?
            .resize(SHEET_CELL_WIDTH, SHEET_CELL_HEIGHT, FilterType::Triangle)
            .to_rgb8();
        let offset_x = cell_x + (SHEET_CELL_WIDTH - image.width()) / 2;
        let offset_y = cell_y + (SHEET_CELL_HEIGHT - image.height()) / 2;
        sheet
            .copy_from(&image, offset_x, offset_y)
            .map_err(|error| format!("compose contact sheet: {error}"))?;
        draw_label(
            &mut sheet,
            &format_timestamp(frame.timestamp_ms),
            cell_x + 4,
            cell_y + 4,
        );
        timestamps.push(frame.timestamp_ms);
    }
    sheet
        .save(output)
        .map_err(|error| format!("save contact sheet: {error}"))?;
    Ok(ContactSheet {
        path: output.to_path_buf(),
        timestamps_ms: timestamps,
    })
}

/// Prepares every derived artifact the selected route needs inside the job
/// directory. The original file is never modified.
pub fn prepare_video(
    job: &VideoJob,
    ffmpeg: &Path,
    original: &Path,
    metadata: &VideoStreamMetadata,
    route: &VideoRoute,
    proxy_encoder: Option<&str>,
) -> Result<PreparedVideo, String> {
    let mut prepared = PreparedVideo::default();

    if let VideoRoute::NativeOriginal = route {
        prepared.native_path = Some(original.to_path_buf());
        return Ok(prepared);
    }

    if let VideoRoute::NativeSdrProxy {
        transcribe_audio_locally,
    } = route
    {
        let encoder =
            proxy_encoder.ok_or_else(|| "proxy route without a verified encoder".to_string())?;
        let proxy_path = job.directory().join("proxy.mp4");
        run_media_tool(
            job,
            ffmpeg,
            &sdr_proxy_args(
                original,
                metadata.hdr.clone(),
                metadata.has_audio,
                encoder,
                &proxy_path,
            ),
        )?;
        prepared.native_path = Some(proxy_path);
        if *transcribe_audio_locally && metadata.has_audio {
            prepared.audio_wav = extract_audio(job, ffmpeg, original, &mut prepared.warnings);
        }
        return Ok(prepared);
    }

    // SampledFrames: scene detection is best-effort; uniform coverage is not.
    if job.is_cancelled() {
        return Err("video job was cancelled".to_string());
    }
    let scene_probe_dir = job.directory().join("scene-probe");
    std::fs::create_dir_all(&scene_probe_dir)
        .map_err(|error| format!("create scene probe directory: {error}"))?;
    let scene_stamps = match run_media_tool(
        job,
        ffmpeg,
        &scene_detect_args(original, &scene_probe_dir.join("probe-%05d.png")),
    ) {
        Ok(stderr) => parse_showinfo_timestamps(&stderr),
        Err(error) if error.contains("cancelled") => return Err(error),
        Err(error) => {
            prepared.warnings.push(VideoWarning::new(
                "scene_detection_failed",
                format!("scene detection unavailable: {error}"),
            ));
            Vec::new()
        }
    };
    let _ = std::fs::remove_dir_all(&scene_probe_dir);
    let uniform = plan_uniform_timestamps(metadata.duration_ms, MAX_VISUAL_FRAMES);
    let candidates = merge_candidates(&scene_stamps, &uniform, MAX_CANDIDATE_FRAMES);

    let frames_dir = job.directory().join("frames");
    std::fs::create_dir_all(&frames_dir)
        .map_err(|error| format!("create frames directory: {error}"))?;
    let pattern = frames_dir.join("frame-%05d.png");
    let chain = frame_filter_chain(
        metadata.hdr.clone(),
        &select_expression(&candidates, metadata.avg_fps),
    );
    let stderr = run_media_tool(
        job,
        ffmpeg,
        &frame_extract_args(ffmpeg, original, &chain, &pattern),
    )?;
    let actual_stamps = parse_showinfo_timestamps(&stderr);

    let mut extracted: Vec<TimestampedFrame> = Vec::new();
    for (index, stamp) in actual_stamps.iter().enumerate() {
        let path = frames_dir.join(format!("frame-{:05}.png", index + 1));
        if path.is_file() {
            extracted.push(TimestampedFrame {
                timestamp_ms: *stamp,
                path,
            });
        }
    }
    if extracted.is_empty() {
        return Err("no frames could be extracted".to_string());
    }

    // Perceptual dedup keeps the earliest of each near-identical run.
    let mut kept: Vec<TimestampedFrame> = Vec::new();
    let mut last_hash: Option<u64> = None;
    let mut last_kept_ms: Option<u64> = None;
    for frame in extracted {
        if job.is_cancelled() {
            return Err("video job was cancelled".to_string());
        }
        let hash = match frame_hash(&frame.path) {
            Ok(hash) => hash,
            Err(error) => {
                prepared
                    .warnings
                    .push(VideoWarning::new("frame_hash_failed", error));
                continue;
            }
        };
        let duplicate = last_hash.is_some_and(|previous| is_perceptual_duplicate(previous, hash));
        // A long run of near-identical frames (static screen recordings)
        // must not collapse to a single frame: keep one per gap window so
        // the contact sheet retains temporal coverage.
        let gap_elapsed = last_kept_ms
            .is_none_or(|previous| frame.timestamp_ms.saturating_sub(previous) >= DEDUP_MAX_GAP_MS);
        if !duplicate || gap_elapsed {
            last_kept_ms = Some(frame.timestamp_ms);
            kept.push(frame.clone());
            last_hash = Some(hash);
        } else {
            let _ = std::fs::remove_file(&frame.path);
        }
        if kept.len() >= MAX_VISUAL_FRAMES {
            break;
        }
    }

    let scene_set: std::collections::HashSet<u64> = scene_stamps.iter().copied().collect();
    let mut ocr: Vec<TimestampedFrame> = kept
        .iter()
        .filter(|frame| scene_set.contains(&frame.timestamp_ms))
        .cloned()
        .collect();
    for frame in &kept {
        if ocr.len() >= MAX_OCR_FRAMES {
            break;
        }
        if !ocr.iter().any(|existing| existing.path == frame.path) {
            ocr.push(frame.clone());
        }
    }
    ocr.truncate(MAX_OCR_FRAMES);
    ocr.sort_by_key(|frame| frame.timestamp_ms);

    for (index, sheet_stamps) in plan_contact_sheets(
        &kept
            .iter()
            .map(|frame| frame.timestamp_ms)
            .collect::<Vec<_>>(),
    )
    .iter()
    .enumerate()
    {
        if job.is_cancelled() {
            return Err("video job was cancelled".to_string());
        }
        let members: Vec<TimestampedFrame> = kept
            .iter()
            .filter(|frame| sheet_stamps.contains(&frame.timestamp_ms))
            .cloned()
            .collect();
        let output = job.directory().join(format!("sheet-{index}.png"));
        match compose_contact_sheet(&members, &output) {
            Ok(sheet) => prepared.contact_sheets.push(sheet),
            Err(error) => prepared
                .warnings
                .push(VideoWarning::new("contact_sheet_failed", error)),
        }
    }

    let transcribe_audio_locally = matches!(
        route,
        VideoRoute::SampledFrames {
            transcribe_audio_locally: true
        }
    );
    if transcribe_audio_locally && metadata.has_audio {
        prepared.audio_wav = extract_audio(job, ffmpeg, original, &mut prepared.warnings);
    }

    prepared.visual_frames = kept;
    prepared.ocr_frames = ocr;
    Ok(prepared)
}

fn extract_audio(
    job: &VideoJob,
    ffmpeg: &Path,
    original: &Path,
    warnings: &mut Vec<VideoWarning>,
) -> Option<PathBuf> {
    let output = job.directory().join("audio.wav");
    match run_media_tool(job, ffmpeg, &audio_extract_args(original, &output)) {
        Ok(_) if output.is_file() => Some(output),
        Ok(_) => {
            warnings.push(VideoWarning::new(
                "audio_extraction_failed",
                "audio extraction produced no file",
            ));
            None
        }
        Err(error) if error.contains("cancelled") => None,
        Err(error) => {
            warnings.push(VideoWarning::new("audio_extraction_failed", error));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use tempfile::TempDir;

    use super::super::job::VideoJobRegistry;
    use super::super::probe::{bundled_ffprobe_path, probe_and_validate};
    use super::super::router::VideoRoute;
    use super::super::{MAX_OCR_FRAMES, MAX_VISUAL_FRAMES};
    use super::*;

    fn video_fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/video")
            .join(name)
    }

    #[test]
    fn uniform_plan_covers_first_and_last_and_respects_the_cap() {
        let stamps = plan_uniform_timestamps(300_000, MAX_VISUAL_FRAMES);

        assert_eq!(stamps.first(), Some(&0));
        assert_eq!(stamps.last(), Some(&299_999));
        assert!(stamps.len() <= MAX_VISUAL_FRAMES);
        assert!(stamps.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn uniform_plan_adapts_density_to_short_videos() {
        let stamps = plan_uniform_timestamps(4_000, MAX_VISUAL_FRAMES);

        assert!(stamps.len() >= 2);
        assert!(stamps.len() <= 8);
        assert_eq!(stamps.first(), Some(&0));
        assert_eq!(stamps.last(), Some(&3_999));
    }

    #[test]
    fn merge_prefers_scene_cuts_and_never_exceeds_the_candidate_cap() {
        let scenes: Vec<u64> = (0..300).map(|index| index * 1_000).collect();
        let uniform = plan_uniform_timestamps(300_000, MAX_VISUAL_FRAMES);

        let merged = merge_candidates(&scenes, &uniform, 180);

        assert!(merged.len() <= 180);
        assert!(merged.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(merged.contains(&0));
    }

    #[test]
    fn near_identical_hashes_are_duplicates_and_distinct_hashes_are_not() {
        let flat = [128u8; 64];
        let mut bright = [128u8; 64];
        bright[0] = 255;
        let mut checker = [0u8; 64];
        for (index, value) in checker.iter_mut().enumerate() {
            *value = if index % 2 == 0 { 255 } else { 0 };
        }

        let flat_hash = average_hash(&flat);
        let bright_hash = average_hash(&bright);
        let checker_hash = average_hash(&checker);

        assert!(is_perceptual_duplicate(flat_hash, bright_hash));
        assert!(!is_perceptual_duplicate(flat_hash, checker_hash));
    }

    #[test]
    fn contact_sheet_plan_is_bounded_to_ten_sheets_of_twelve() {
        let stamps: Vec<u64> = (0..150).map(|index| index * 2_000).collect();

        let sheets = plan_contact_sheets(&stamps);

        assert_eq!(sheets.len(), 10);
        assert!(sheets.iter().all(|sheet| sheet.len() <= 12));
    }

    #[test]
    fn hdr_frames_are_tonemapped_and_sdr_frames_pass_through() {
        let sdr = frame_filter_chain(VideoHdrKind::Sdr, "1");
        let pq = frame_filter_chain(VideoHdrKind::Pq, "1");

        assert!(!sdr.contains("tonemap"));
        assert!(pq.contains("zscale=t=linear"));
        assert!(pq.contains("tonemap=hable"));
        assert!(pq.contains("bt709"));
    }

    #[test]
    fn proxy_args_produce_h264_aac_sdr_mp4_and_respect_missing_audio() {
        let with_audio = sdr_proxy_args(
            Path::new("/tmp/in.mov"),
            VideoHdrKind::Pq,
            true,
            "h264_videotoolbox",
            Path::new("/tmp/out.mp4"),
        );
        let silent = sdr_proxy_args(
            Path::new("/tmp/in.mov"),
            VideoHdrKind::Sdr,
            false,
            "h264_videotoolbox",
            Path::new("/tmp/out.mp4"),
        );

        let with_audio: Vec<String> = with_audio
            .iter()
            .map(|value| value.to_string_lossy().to_string())
            .collect();
        let silent: Vec<String> = silent
            .iter()
            .map(|value| value.to_string_lossy().to_string())
            .collect();

        assert!(with_audio.contains(&"h264_videotoolbox".to_string()));
        assert!(with_audio.contains(&"aac".to_string()));
        assert!(with_audio.iter().any(|value| value.contains("tonemap")));
        assert!(silent.contains(&"-an".to_string()));
        assert!(!silent.iter().any(|value| value.contains("tonemap")));
    }

    #[test]
    fn showinfo_timestamps_parse_in_order_and_ignore_unrelated_lines() {
        let stderr = "\
[Parsed_showinfo_1 @ 0x1] n:   0 pts:    512 pts_time:0.5 duration:x\n\
frame=  1 fps=0.0\n\
[Parsed_showinfo_1 @ 0x1] n:   1 pts:   1024 pts_time:1.25 duration:x\n";

        assert_eq!(parse_showinfo_timestamps(stderr), vec![500, 1_250]);
    }

    #[test]
    fn preparing_the_sdr_fixture_yields_frames_sheets_and_audio() {
        let temp = TempDir::new().unwrap();
        let registry = VideoJobRegistry::new(temp.path()).unwrap();
        let job = registry.start("conversation-prepare-sdr").unwrap();
        let original = video_fixture("h264-sdr-aac.mp4");
        let ffmpeg = bundled_ffmpeg_path().unwrap();
        let metadata = probe_and_validate(
            &original,
            std::fs::metadata(&original).unwrap().len(),
            &bundled_ffprobe_path().unwrap(),
        )
        .unwrap();

        let prepared = prepare_video(
            &job,
            &ffmpeg,
            &original,
            &metadata,
            &VideoRoute::SampledFrames {
                transcribe_audio_locally: true,
            },
            None,
        )
        .unwrap();

        assert!(!prepared.visual_frames.is_empty());
        assert!(prepared.visual_frames.len() <= MAX_VISUAL_FRAMES);
        assert!(!prepared.ocr_frames.is_empty());
        assert!(prepared.ocr_frames.len() <= MAX_OCR_FRAMES);
        assert!(!prepared.contact_sheets.is_empty());
        assert!(prepared
            .visual_frames
            .iter()
            .all(|frame| frame.path.is_file()));
        let audio = prepared.audio_wav.as_ref().expect("fixture has audio");
        assert!(audio.is_file());
        assert!(prepared.native_path.is_none());
        job.finish().unwrap();
    }

    #[test]
    fn preparing_the_hdr_fixture_tonemaps_without_audio_artifacts() {
        let temp = TempDir::new().unwrap();
        let registry = VideoJobRegistry::new(temp.path()).unwrap();
        let job = registry.start("conversation-prepare-hdr").unwrap();
        let original = video_fixture("hevc-pq.mov");
        let ffmpeg = bundled_ffmpeg_path().unwrap();
        let metadata = probe_and_validate(
            &original,
            std::fs::metadata(&original).unwrap().len(),
            &bundled_ffprobe_path().unwrap(),
        )
        .unwrap();

        let prepared = prepare_video(
            &job,
            &ffmpeg,
            &original,
            &metadata,
            &VideoRoute::SampledFrames {
                transcribe_audio_locally: true,
            },
            None,
        )
        .unwrap();

        assert!(!prepared.visual_frames.is_empty());
        assert!(prepared.audio_wav.is_none());
        job.finish().unwrap();
    }

    #[test]
    fn a_cancelled_job_refuses_new_media_work() {
        let temp = TempDir::new().unwrap();
        let registry = VideoJobRegistry::new(temp.path()).unwrap();
        let job = registry.start("conversation-cancelled").unwrap();
        job.cancel().unwrap();

        let error = run_media_tool(
            &job,
            &bundled_ffmpeg_path().unwrap(),
            &[OsString::from("-version")],
        )
        .unwrap_err();

        assert!(error.contains("cancelled"));
    }

    #[test]
    fn native_original_route_keeps_the_immutable_source() {
        let temp = TempDir::new().unwrap();
        let registry = VideoJobRegistry::new(temp.path()).unwrap();
        let job = registry.start("conversation-native").unwrap();
        let original = video_fixture("h264-sdr-aac.mp4");
        let metadata = probe_and_validate(
            &original,
            std::fs::metadata(&original).unwrap().len(),
            &bundled_ffprobe_path().unwrap(),
        )
        .unwrap();

        let prepared = prepare_video(
            &job,
            &bundled_ffmpeg_path().unwrap(),
            &original,
            &metadata,
            &VideoRoute::NativeOriginal,
            None,
        )
        .unwrap();

        assert_eq!(prepared.native_path.as_deref(), Some(original.as_path()));
        assert!(prepared.visual_frames.is_empty());
        job.finish().unwrap();
    }
}
