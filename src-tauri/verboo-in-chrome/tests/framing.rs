use std::io::{Cursor, Read};

use serde_json::{json, Value};
use verboo_in_chrome::framing::{
    write_native_message, Direction, FrameReader, MAX_CHROME_TO_HOST_BYTES,
    MAX_HOST_TO_CHROME_BYTES,
};

fn frame(value: Value) -> Vec<u8> {
    let body = serde_json::to_vec(&value).unwrap();
    let mut bytes = (body.len() as u32).to_le_bytes().to_vec();
    bytes.extend(body);
    bytes
}

struct ChunkedReader {
    inner: Cursor<Vec<u8>>,
    chunk_size: usize,
}

impl Read for ChunkedReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let size = buffer.len().min(self.chunk_size);
        self.inner.read(&mut buffer[..size])
    }
}

#[test]
fn reads_partial_headers_and_bodies() {
    let source = ChunkedReader {
        inner: Cursor::new(frame(json!({"message": "olá"}))),
        chunk_size: 1,
    };
    let mut reader = FrameReader::new(source, Direction::FromChrome);

    assert_eq!(reader.read().unwrap(), Some(json!({"message": "olá"})));
    assert_eq!(reader.read().unwrap(), None);
}

#[test]
fn retains_second_frame_from_one_read() {
    let bytes = [frame(json!({"id": "one"})), frame(json!({"id": "two"}))].concat();
    let mut reader = FrameReader::new(Cursor::new(bytes), Direction::FromChrome);

    assert_eq!(reader.read().unwrap(), Some(json!({"id": "one"})));
    assert_eq!(reader.read().unwrap(), Some(json!({"id": "two"})));
}

#[test]
fn writes_utf8_length_in_bytes() {
    let mut output = Vec::new();
    write_native_message(&mut output, &json!({"text": "ação"})).unwrap();

    let length = u32::from_le_bytes(output[..4].try_into().unwrap()) as usize;
    assert_eq!(length, output[4..].len());
    assert_eq!(
        serde_json::from_slice::<Value>(&output[4..]).unwrap(),
        json!({"text": "ação"})
    );
}

#[test]
fn rejects_frames_over_the_chrome_to_host_limit_before_reading_body() {
    let length = (MAX_CHROME_TO_HOST_BYTES + 1) as u32;
    let mut reader = FrameReader::new(Cursor::new(length.to_le_bytes()), Direction::FromChrome);

    let error = reader.read().unwrap_err();
    assert!(error.to_string().contains("64 MiB"));
}

#[test]
fn rejects_host_output_over_one_mib() {
    let oversized = json!({"data": "x".repeat(MAX_HOST_TO_CHROME_BYTES)});
    let error = write_native_message(Vec::new(), &oversized).unwrap_err();

    assert!(error.to_string().contains("1 MiB"));
}

#[test]
fn rejects_malformed_json() {
    let body = b"{not json";
    let mut bytes = (body.len() as u32).to_le_bytes().to_vec();
    bytes.extend(body);
    let mut reader = FrameReader::new(Cursor::new(bytes), Direction::FromChrome);

    assert!(reader.read().is_err());
}

#[test]
fn rejects_partial_frame_header() {
    let mut reader = FrameReader::new(Cursor::new(vec![1, 2]), Direction::FromChrome);

    assert!(reader.read().is_err());
}
