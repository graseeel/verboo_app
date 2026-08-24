//! Test shim: shared support plus focused lifecycle and preview integration suites.

use super::super::grpc::generated;
use super::super::grpc::GrpcError;
use super::super::preview::{
    FirstPreviewError, FirstPreviewGate, FirstPreviewState, FrameReady, OpenStreamFuture,
    PreviewControl, PreviewEventSink, PreviewHealthState, PreviewMode, PreviewReadError,
    PreviewReason, PreviewSource, PreviewState, PreviewTransport, ScreenshotStream,
    ScreenshotStreamFactory, StreamMessageFuture, ValidatedRgbFrame, MAX_SAFE_GENERATION,
};
use super::*;
use std::collections::VecDeque;

include!("tests/support.rs");
include!("tests/lifecycle.rs");
include!("tests/preview_transport.rs");
include!("tests/preview_harden.rs");
include!("tests/read_frame.rs");
