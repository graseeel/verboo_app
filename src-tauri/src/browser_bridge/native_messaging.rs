//! Chrome Native Messaging wire framing.
//!
//! Chrome's Native Messaging protocol: each message is a UTF-8 JSON payload
//! prefixed with a 4-byte little-endian unsigned 32-bit length header.
//! Maximum message size: 1 MiB (Chrome enforces; we check too).
//!
//! Reference:
//! https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

use serde_json::Value;

/// Chrome's hard limit on a single Native Messaging message size.
pub const MAX_MESSAGE_SIZE: usize = 1024 * 1024; // 1 MiB

/// Errors from the framing layer.
#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("message too large: {size} bytes (max {MAX_MESSAGE_SIZE})")]
    TooLarge {
        size: usize,
        // const in error variant field is not allowed; use static via method
    },
    #[error("truncated length header: need 4 bytes, have {0}")]
    TruncatedHeader(usize),
    #[error("truncated payload: declared {declared} bytes, have {available}")]
    TruncatedPayload {
        declared: usize,
        available: usize,
    },
    #[error("invalid UTF-8 in payload: {0}")]
    InvalidUtf8(#[from] std::str::Utf8Error),
    #[error("invalid JSON in payload: {0}")]
    InvalidJson(#[from] serde_json::Error),
}

impl FrameError {
    /// Helper for the `TooLarge` variant (const not allowed in struct field).
    pub fn too_large(size: usize) -> Self {
        FrameError::TooLarge { size }
    }
}

/// Encode a JSON value into a Chrome Native Messaging frame.
///
/// Returns a `Vec<u8>` containing the 4-byte LE length header followed by
/// the UTF-8 JSON payload. The caller writes this to the NM pipe verbatim.
pub fn encode_message(json: &Value) -> Result<Vec<u8>, FrameError> {
    let payload = serde_json::to_vec(json)?;
    if payload.len() > MAX_MESSAGE_SIZE {
        return Err(FrameError::too_large(payload.len()));
    }
    let len = (payload.len() as u32).to_le_bytes();
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&len);
    out.extend_from_slice(&payload);
    Ok(out)
}

/// Decode a single Chrome Native Messaging frame from a byte buffer.
///
/// Returns the decoded JSON value and the number of bytes consumed (header +
/// payload). If the buffer does not contain a complete frame, returns
/// `Err(FrameError::TruncatedHeader)` or `Err(FrameError::TruncatedPayload)`.
/// The caller should retain unconsumed bytes for the next read.
pub fn decode_message(bytes: &[u8]) -> Result<(Value, usize), FrameError> {
    if bytes.len() < 4 {
        return Err(FrameError::TruncatedHeader(bytes.len()));
    }
    let len = u32::from_le_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3],
    ]) as usize;
    if len > MAX_MESSAGE_SIZE {
        return Err(FrameError::too_large(len));
    }
    let body_start = 4;
    let body_end = body_start + len;
    if bytes.len() < body_end {
        return Err(FrameError::TruncatedPayload {
            declared: len,
            available: bytes.len() - body_start,
        });
    }
    let slice = std::str::from_utf8(&bytes[body_start..body_end])?;
    let value: Value = serde_json::from_str(slice)?;
    Ok((value, body_end))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn encode_roundtrip_simple_object() {
        let msg = json!({ "type": "agent:turn_start", "turnId": "abc" });
        let frame = encode_message(&msg).unwrap();
        let payload_len = serde_json::to_vec(&msg).unwrap().len();
        assert_eq!(frame.len(), 4 + payload_len);
        let (decoded, consumed) = decode_message(&frame).unwrap();
        assert_eq!(consumed, frame.len());
        assert_eq!(decoded, msg);
    }

    #[test]
    fn encode_roundtrip_array() {
        let msg = json!([1, "two", { "three": 3 }]);
        let frame = encode_message(&msg).unwrap();
        let (decoded, _) = decode_message(&frame).unwrap();
        assert_eq!(decoded, msg);
    }

    #[test]
    fn decode_truncated_header() {
        let buf = [0u8, 1, 2]; // only 3 bytes
        let err = decode_message(&buf).unwrap_err();
        assert!(matches!(err, FrameError::TruncatedHeader(3)));
    }

    #[test]
    fn decode_truncated_payload() {
        let msg = json!({"x": "y"});
        let mut frame = encode_message(&msg).unwrap();
        // Drop the last 5 bytes of the payload.
        frame.truncate(frame.len() - 5);
        let err = decode_message(&frame).unwrap_err();
        assert!(matches!(
            err,
            FrameError::TruncatedPayload { declared: _, available: _ }
        ));
    }

    #[test]
    fn decode_extra_bytes_after_frame_are_ignored() {
        let msg = json!({"a": 1});
        let mut frame = encode_message(&msg).unwrap();
        frame.extend_from_slice(&[0xFF, 0xFF, 0xFF, 0xFF]);
        let (decoded, consumed) = decode_message(&frame).unwrap();
        assert_eq!(decoded, msg);
        assert_eq!(consumed, frame.len() - 4);
    }

    #[test]
    fn encode_rejects_oversized_payload() {
        // Build a >1MiB JSON string.
        let big = "x".repeat(MAX_MESSAGE_SIZE + 1);
        let msg = json!({ "data": big });
        let err = encode_message(&msg).unwrap_err();
        assert!(matches!(err, FrameError::TooLarge { size: _ }));
    }
}
