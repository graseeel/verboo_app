use std::fmt;

use serde::Serialize;

pub use crate::models::types::VideoHdrKind;

pub const MAX_VIDEO_BYTES: u64 = 500 * 1024 * 1024;
pub const MAX_VIDEO_DURATION_MS: u64 = 300_000;
pub const MAX_VISUAL_FRAMES: usize = 120;
pub const MAX_OCR_FRAMES: usize = 60;
pub const PASTE_CHUNK_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VideoValidationError {
    TooLarge { actual: u64, maximum: u64 },
    TooLong { actual_ms: u64, maximum_ms: u64 },
    MissingVideoStream,
    UnsupportedContainer(String),
    UnsupportedCodec(String),
    /// A1c (2026-07-30): explicit error for platforms without a
    /// published sidecar. Replaces the old `"unsupported"` string
    /// that produced an invalid filename (`verboo-ffprobe-unsupported`)
    /// and failed later with a confusing "file not found".
    ///
    /// Previous behavior was the cousin of the stub-Ok defect:
    /// silent fabrication of an invalid value that failed far from
    /// the root cause. Now the error surfaces immediately with the
    /// platform identity so the user (or CI log) sees which platform
    /// is unsupported.
    UnsupportedPlatform { os: String, arch: String, tool: String },
    ProtectedOrUnreadable,
    ProbeFailed(String),
}

impl fmt::Display for VideoValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge { actual, maximum } => write!(f, "video_too_large:{actual}:{maximum}"),
            Self::TooLong {
                actual_ms,
                maximum_ms,
            } => {
                write!(f, "video_too_long:{actual_ms}:{maximum_ms}")
            }
            Self::MissingVideoStream => write!(f, "video_missing_stream"),
            Self::UnsupportedContainer(container) => {
                write!(f, "video_unsupported_container:{container}")
            }
            Self::UnsupportedCodec(codec) => write!(f, "video_unsupported_codec:{codec}"),
            Self::UnsupportedPlatform { os, arch, tool } => {
                write!(
                    f,
                    "video_unsupported_platform: {tool} does not have a published \
                     binary for {os}/{arch}. Supported platforms: \
                     macOS x86_64/aarch64, Windows x86_64/aarch64, Linux x86_64/aarch64."
                )
            }
            Self::ProtectedOrUnreadable => write!(f, "video_protected_or_unreadable"),
            Self::ProbeFailed(message) => write!(f, "video_probe_failed:{message}"),
        }
    }
}

/// A user-safe, non-fatal degradation notice produced by the pipeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoWarning {
    pub code: String,
    pub message: String,
}

impl VideoWarning {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

pub mod analyze;
pub mod cache;
pub mod job;
pub mod prepare;
pub mod probe;
pub mod router;
pub mod target;
pub mod transcribe;

pub use probe::{bundled_ffprobe_path, probe_and_validate};
