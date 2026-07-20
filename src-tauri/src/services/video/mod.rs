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
            Self::ProtectedOrUnreadable => write!(f, "video_protected_or_unreadable"),
            Self::ProbeFailed(message) => write!(f, "video_probe_failed:{message}"),
        }
    }
}

pub mod probe;
pub mod transcribe;

pub use probe::{bundled_ffprobe_path, probe_and_validate};
