use std::io::{ErrorKind, Read, Write};

use serde::Serialize;
use serde_json::Value;

use crate::error::{BridgeError, Result};

pub const MAX_HOST_TO_CHROME_BYTES: usize = 1024 * 1024;
pub const MAX_CHROME_TO_HOST_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy)]
pub enum Direction {
    FromChrome,
    FromHost,
}

impl Direction {
    fn maximum(self) -> (usize, &'static str) {
        match self {
            Self::FromChrome => (MAX_CHROME_TO_HOST_BYTES, "64 MiB"),
            Self::FromHost => (MAX_HOST_TO_CHROME_BYTES, "1 MiB"),
        }
    }
}

pub struct FrameReader<R> {
    reader: R,
    direction: Direction,
}

impl<R: Read> FrameReader<R> {
    pub fn new(reader: R, direction: Direction) -> Self {
        Self { reader, direction }
    }

    pub fn read(&mut self) -> Result<Option<Value>> {
        let mut header = [0_u8; 4];
        match self.reader.read(&mut header[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::Interrupted => return self.read(),
            Err(error) => return Err(error.into()),
        }
        self.reader
            .read_exact(&mut header[1..])
            .map_err(incomplete_or_io)?;

        let length = u32::from_le_bytes(header) as usize;
        let (maximum, limit) = self.direction.maximum();
        if length > maximum {
            return Err(BridgeError::FrameTooLarge {
                limit,
                actual: length,
            });
        }

        let mut body = vec![0_u8; length];
        self.reader
            .read_exact(&mut body)
            .map_err(incomplete_or_io)?;
        Ok(Some(serde_json::from_slice(&body)?))
    }
}

fn incomplete_or_io(error: std::io::Error) -> BridgeError {
    if error.kind() == ErrorKind::UnexpectedEof {
        BridgeError::IncompleteFrame
    } else {
        BridgeError::Io(error)
    }
}

pub fn write_native_message<W: Write, T: Serialize>(mut writer: W, value: &T) -> Result<()> {
    let body = serde_json::to_vec(value)?;
    if body.len() > MAX_HOST_TO_CHROME_BYTES {
        return Err(BridgeError::FrameTooLarge {
            limit: "1 MiB",
            actual: body.len(),
        });
    }
    writer.write_all(&(body.len() as u32).to_le_bytes())?;
    writer.write_all(&body)?;
    writer.flush()?;
    Ok(())
}
