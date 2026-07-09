use std::path::{Path, PathBuf};

use crate::models::types::{AttachmentKind, AttachmentMeta};

/// Maps a file extension to its image media type, if known.
/// Matches Electron's `IMAGE_MEDIA_BY_EXT` (src/main/services/attachmentService.ts:15).
fn image_media_type_by_ext(ext: &str) -> Option<&'static str> {
    match ext.to_lowercase().as_str() {
        ".gif" => Some("image/gif"),
        ".heic" => Some("image/heic"),
        ".heif" => Some("image/heif"),
        ".jpeg" => Some("image/jpeg"),
        ".jpg" => Some("image/jpeg"),
        ".png" => Some("image/png"),
        ".webp" => Some("image/webp"),
        _ => None,
    }
}

/// Detects the image media type by reading the first 16 bytes of the file.
/// Falls back to extension-based detection for HEIC/HEIF (which have complex
/// headers) and for files where the header doesn't match a known signature.
/// Matches Electron's `detectImageMediaType`.
fn detect_image_media_type(path: &Path, header: &[u8]) -> Option<String> {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if header.len() >= 8
        && header[..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    {
        return Some("image/png".into());
    }
    // JPEG: FF D8 FF
    if header.len() >= 3 && header[0] == 0xff && header[1] == 0xd8 && header[2] == 0xff {
        return Some("image/jpeg".into());
    }
    // GIF: "GIF87a" or "GIF89a"
    if header.len() >= 6
        && (&header[..6] == b"GIF87a" || &header[..6] == b"GIF89a")
    {
        return Some("image/gif".into());
    }
    // WEBP: "RIFF" .... "WEBP"
    if header.len() >= 12
        && &header[..4] == b"RIFF"
        && &header[8..12] == b"WEBP"
    {
        return Some("image/webp".into());
    }
    // Fallback: extension
    path.extension()
        .and_then(|e| image_media_type_by_ext(&format!(".{}", e.to_string_lossy())))
        .map(|s| s.to_string())
}

/// Reads the first 16 bytes of a file for media type detection.
fn read_header(path: &Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut buffer = [0u8; 16];
    let n = file.read(&mut buffer)?;
    Ok(buffer[..n].to_vec())
}

/// Reads basic dimensions from an image using the `image` crate.
/// Returns (width, height) if decode succeeds.
fn read_image_dimensions(path: &Path) -> Option<(u32, u32)> {
    let reader = image::ImageReader::open(path).ok()?;
    let (w, h) = reader.into_dimensions().ok()?;
    Some((w, h))
}

/// Inspects a single file path and returns its AttachmentMeta.
/// Mirrors Electron's `inspectAttachment` (src/main/services/attachmentService.ts:60).
pub fn inspect_attachment(path: &str) -> Option<AttachmentMeta> {
    let p = PathBuf::from(path);
    let file_stat = std::fs::metadata(&p).ok()?;
    if !file_stat.is_file() {
        return None;
    }
    let size = file_stat.len() as u64;
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());

    let header = read_header(&p).unwrap_or_default();
    let media_type = detect_image_media_type(&p, &header);

    let (width, height, kind) = if media_type.is_some() {
        let dims = read_image_dimensions(&p);
        let kind = AttachmentKind::Image;
        match dims {
            Some((w, h)) => (Some(w), Some(h), kind),
            None => (None, None, kind),
        }
    } else {
        (None, None, AttachmentKind::File)
    };

    Some(AttachmentMeta {
        path: path.to_string(),
        name,
        size,
        kind,
        media_type,
        width,
        height,
    })
}

/// Inspects multiple file paths, dropping any that fail.
/// Mirrors Electron's `inspectAttachments`.
pub fn inspect_files(paths: &[String]) -> Vec<AttachmentMeta> {
    paths
        .iter()
        .filter_map(|p| inspect_attachment(p))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_png_signature() {
        let header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        let path = Path::new("file.png");
        assert_eq!(
            detect_image_media_type(path, &header),
            Some("image/png".into())
        );
    }

    #[test]
    fn detect_jpeg_signature() {
        let header = [0xff, 0xd8, 0xff, 0xe0];
        let path = Path::new("file.jpg");
        assert_eq!(
            detect_image_media_type(path, &header),
            Some("image/jpeg".into())
        );
    }

    #[test]
    fn detect_gif_signature() {
        let header = *b"GIF89a";
        let path = Path::new("file.gif");
        assert_eq!(
            detect_image_media_type(path, &header),
            Some("image/gif".into())
        );
    }

    #[test]
    fn detect_webp_signature() {
        let mut header = [0u8; 12];
        header[..4].copy_from_slice(b"RIFF");
        header[8..12].copy_from_slice(b"WEBP");
        let path = Path::new("file.webp");
        assert_eq!(
            detect_image_media_type(path, &header),
            Some("image/webp".into())
        );
    }

    #[test]
    fn detect_falls_back_to_extension() {
        let header = [];
        let path = Path::new("photo.heic");
        assert_eq!(
            detect_image_media_type(path, &header),
            Some("image/heic".into())
        );

        let path = Path::new("photo.HEIC");
        assert_eq!(
            detect_image_media_type(path, &header),
            Some("image/heic".into())
        );
    }

    #[test]
    fn detect_returns_none_for_unknown() {
        let header = [];
        let path = Path::new("document.txt");
        assert_eq!(detect_image_media_type(path, &header), None);

        let path = Path::new("file.bin");
        assert_eq!(detect_image_media_type(path, &header), None);
    }

    #[test]
    fn inspect_nonexistent_returns_none() {
        assert_eq!(inspect_attachment("/nonexistent/file.png"), None);
    }

    #[test]
    fn inspect_text_file_classified_as_file() {
        let temp = std::env::temp_dir().join(format!(
            "verboo-test-{}.txt",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&temp, "hello world").unwrap();
        let meta = inspect_attachment(temp.to_str().unwrap()).unwrap();
        assert_eq!(meta.kind, AttachmentKind::File);
        assert!(meta.media_type.is_none());
        assert!(meta.width.is_none());
        assert_eq!(meta.size, 11);
        let _ = std::fs::remove_file(&temp);
    }
}
