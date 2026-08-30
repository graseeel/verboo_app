use std::fmt;
use std::path::{Path, PathBuf};

use crate::models::types::{AttachmentKind, AttachmentMeta, ExtractionStatus};
use crate::services::video::{self, VideoValidationError};

/// Maximum file size for which we attempt PDF text extraction. Larger files
/// are skipped to avoid blocking the UI on huge PDFs (rare for chat
/// attachments; users with big PDFs can convert or use vision models).
const MAX_PDF_SIZE_FOR_EXTRACTION: u64 = 5 * 1024 * 1024;

/// Maximum file size for text file extraction. Same rationale as PDFs —
/// don't block the UI on huge text files (logs, generated code, etc.).
const MAX_TEXT_SIZE_FOR_EXTRACTION: u64 = 5 * 1024 * 1024;

/// Hard cap on extracted text length injected into the prompt. Keeps prompts
/// bounded so we don't blow context on textbook-sized PDFs. Truncation is
/// clearly marked so the model knows content was cut.
const MAX_EXTRACTED_TEXT_BYTES: usize = 50 * 1024;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "kind", content = "details", rename_all = "camelCase")]
pub enum FileInspectionError {
    NotAFile,
    Video(VideoValidationError),
}

impl fmt::Display for FileInspectionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAFile => write!(f, "attachment_not_a_file"),
            Self::Video(error) => error.fmt(f),
        }
    }
}

/// Returns true if the file extension is a well-known text format.
/// Covers: markdown, plain text, data formats (json/csv/yaml/toml/xml),
/// logs, config (ini/cfg/conf/env), and source code in common languages.
/// Detection by extension is fast and reliable for these formats.
fn is_text_file_by_ext(path: &Path) -> bool {
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    matches!(
        ext.as_str(),
        // Markdown / text
        ".md" | ".markdown" | ".mdx" | ".txt" | ".text" | ".rst" | ".asciidoc" | ".adoc"
        // Data formats
        | ".json" | ".json5" | ".jsonl" | ".ndjson" | ".csv" | ".tsv" | ".yaml" | ".yml"
        | ".toml" | ".xml" | ".plist" | ".ini" | ".cfg" | ".conf" | ".properties" | ".env"
        | ".editorconfig"
        // Logs
        | ".log" | ".out" | ".err"
        // Web
        | ".html" | ".htm" | ".css" | ".scss" | ".sass" | ".less" | ".vue" | ".svelte"
        | ".astro"
        // JS/TS
        | ".js" | ".jsx" | ".mjs" | ".cjs" | ".ts" | ".tsx" | ".mts" | ".cts" | ".d.ts"
        // Systems
        | ".rs" | ".go" | ".c" | ".h" | ".cpp" | ".cc" | ".cxx" | ".hpp" | ".hh" | ".hxx"
        | ".java" | ".kt" | ".kts" | ".sc" | ".swift" | ".dart" | ".zig"
        | ".nim" | ".v" | ".d" | ".pas"
        // Scripting
        | ".py" | ".pyi" | ".rb" | ".php" | ".pl" | ".lua" | ".tcl" | ".sh" | ".bash"
        | ".zsh" | ".fish" | ".ps1" | ".psm1" | ".bat" | ".cmd"
        // JVM
        | ".groovy" | ".gradle" | ".clj" | ".cljs" | ".cljc" | ".edn" | ".scala"
        // Functional
        | ".hs" | ".lhs" | ".ml" | ".mli" | ".fs" | ".fsi" | ".fsx" | ".elm" | ".purs" | ".erl"
        | ".ex" | ".exs"
        // SQL / DB
        | ".sql" | ".psql" | ".mysql" | ".sqlite" | ".db"
        // Other
        | ".graphql" | ".gql" | ".proto" | ".thrift" | ".dockerfile" | ".makefile"
        | ".cmake" | ".ninja" | ".gemspec" | ".rake" | ".rakefile" | ".gemfile"
    ) || {
        // Files with no extension but well-known text filenames.
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        matches!(
            name.as_str(),
            "dockerfile" | "makefile" | "rakefile" | "gemfile" | "brewfile"
            | "justfile" | ".gitignore" | ".gitattributes" | ".dockerignore"
            | ".npmignore" | ".env" | ".env.local" | ".env.production" | ".env.development"
        )
    }
}

/// Reads up to 8KB of the file for content heuristic checks.
/// Returns empty vec on read error.
fn read_content_sample(path: &Path) -> Vec<u8> {
    use std::io::Read;
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let mut buf = vec![0u8; 8192];
    let n = file.read(&mut buf).unwrap_or(0);
    buf.truncate(n);
    buf
}

/// Heuristic: returns true if the bytes look like text (valid UTF-8 and
/// low ratio of non-printable bytes). Catches files with unknown extensions
/// that are actually text (e.g. user renamed `.md` to `.xyz`).
///
/// Algorithm:
/// 1. Quick reject: NUL byte = almost certainly binary.
/// 2. Try to decode as UTF-8. If invalid, it's binary.
/// 3. Count "binary" bytes (control chars excluding \n, \r, \t).
/// 4. If binary ratio < 10%, it's text.
fn is_text_file_by_content(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return true; // Empty file = text.
    }
    // Quick reject: NUL byte = binary.
    if bytes.contains(&0u8) {
        return false;
    }
    // Must be valid UTF-8.
    let Ok(s) = std::str::from_utf8(bytes) else {
        return false;
    };
    // Count non-printable bytes (excluding common whitespace).
    let total = s.len();
    if total == 0 {
        return true;
    }
    let binary_count = s
        .chars()
        .filter(|c| {
            let u = *c as u32;
            // Control chars except \n (10), \r (13), \t (9).
            (u < 32 && u != 9 && u != 10 && u != 13) || u == 127
        })
        .count();
    let ratio = binary_count as f64 / total as f64;
    ratio < 0.10
}

/// Reads a text file and returns its content, truncated to
/// `MAX_EXTRACTED_TEXT_BYTES` with a marker if needed.
/// Returns `(Extracted, text)` on success, `(Warning, msg)` on read error.
fn extract_text_file_content(path: &Path, size: u64) -> (ExtractionStatus, String) {
    if size > MAX_TEXT_SIZE_FOR_EXTRACTION {
        let mb = size / (1024 * 1024);
        return (
            ExtractionStatus::Warning,
            format!(
                "[Document too large to read as text: {mb}MB. \
                 The model cannot read this file's content. \
                 Tell the user the file exceeds the 5MB text limit and \
                 they should paste the relevant portion.]"
            ),
        );
    }
    match std::fs::read_to_string(path) {
        Ok(content) => (ExtractionStatus::Extracted, truncate_extracted_text(content)),
        Err(e) => (
            ExtractionStatus::Warning,
            format!(
                "[Could not read this text file: {e}. \
                 Tell the user the file couldn't be read and suggest they \
                 verify the file or paste the content manually.]"
            ),
        ),
    }
}

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

fn video_media_type_by_ext(path: &Path) -> Option<&'static str> {
    match path
        .extension()?
        .to_string_lossy()
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "m4v" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "webm" => Some("video/webm"),
        "mkv" => Some("video/x-matroska"),
        "avi" => Some("video/x-msvideo"),
        _ => None,
    }
}

fn looks_like_video_container(header: &[u8]) -> bool {
    (header.len() >= 8 && &header[4..8] == b"ftyp")
        || (header.len() >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"AVI ")
        || header.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
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

/// Returns true if the file header starts with `%PDF-` (the PDF magic).
/// Per the PDF spec, all valid PDF files begin with `%PDF-1.x` (or `%PDF-2.x`).
/// We check the first 5 bytes only — enough to distinguish from images/text.
fn is_pdf_file(header: &[u8]) -> bool {
    header.len() >= 5 && &header[..5] == b"%PDF-"
}

/// Truncates extracted text to `MAX_EXTRACTED_TEXT_BYTES` with a clear marker
/// when truncation occurs. The marker tells the model (and the user) that
/// content was cut, so the model doesn't assume the truncated text is the
/// complete document.
fn truncate_extracted_text(text: String) -> String {
    if text.len() <= MAX_EXTRACTED_TEXT_BYTES {
        return text;
    }
    // Walk back to a UTF-8 char boundary to avoid splitting a multi-byte
    // sequence (would panic on String::from_utf8 later).
    let mut cut = MAX_EXTRACTED_TEXT_BYTES;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    let original_kb = text.len() / 1024;
    let shown_kb = cut / 1024;
    let mut truncated = String::with_capacity(cut + 128);
    truncated.push_str(&text[..cut]);
    truncated.push_str(&format!(
        "\n\n[truncated: showing first {shown_kb}KB of {original_kb}KB extracted text]"
    ));
    truncated
}

/// Extracts text from a PDF file using the pure-Rust `pdf-extract` crate.
///
/// Returns `(ExtractionStatus, String)`:
/// - `(Extracted, text)` — real text was extracted (possibly truncated).
/// - `(Warning, warning_string)` — extraction was attempted but produced no
///   usable text (scanned, corrupt, too large). The warning string is still
///   injected into the prompt so the model is told explicitly not to
///   hallucinate.
///
/// Callers should only invoke this when `is_pdf_file(header)` is true.
fn extract_pdf_text(path: &Path, size: u64) -> (ExtractionStatus, String) {
    if size > MAX_PDF_SIZE_FOR_EXTRACTION {
        let mb = size / (1024 * 1024);
        return (
            ExtractionStatus::Warning,
            format!(
                "[Document too large to extract text automatically: {mb}MB. \
                 The model cannot read this file's content. \
                 Tell the user the PDF exceeds the 5MB extraction limit and \
                 they should either split it, convert to text, or use a \
                 vision-capable model.]"
            ),
        );
    }
    // pdf-extract outputs a lot of debug logging on malformed PDFs; suppress
    // it so warnings don't pollute the app's stderr.
    let result = pdf_extract::extract_text(path);
    match result {
        Ok(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                // Scanned PDF (image-only, no text layer). Be explicit so the
                // model doesn't guess.
                (
                    ExtractionStatus::Warning,
                    "[No extractable text found in this PDF. It is likely a \
                     scanned document without an OCR text layer. \
                     The model cannot read its content. \
                     Tell the user the PDF appears to be scanned and needs \
                     OCR, or they should provide a text-based PDF or paste \
                     the content.]"
                        .to_string(),
                )
            } else {
                (ExtractionStatus::Extracted, truncate_extracted_text(text))
            }
        }
        Err(e) => {
            // Corrupt, encrypted, or malformed PDF. Surface the error so the
            // model tells the user instead of inventing content.
            (
                ExtractionStatus::Warning,
                format!(
                    "[Could not read this PDF: {e}. \
                     The file may be corrupted, encrypted, or use features the \
                     extractor doesn't support. \
                     Tell the user the PDF couldn't be read and suggest they \
                     verify the file or paste the content manually.]"
                ),
            )
        }
    }
}

/// Inspects a single file path and returns its AttachmentMeta.
/// Mirrors Electron's `inspectAttachment` (src/main/services/attachmentService.ts:60).
pub fn inspect_attachment_result(path: &str) -> Result<AttachmentMeta, FileInspectionError> {
    let p = PathBuf::from(path);
    let file_stat = std::fs::metadata(&p).map_err(|_| FileInspectionError::NotAFile)?;
    if !file_stat.is_file() {
        return Err(FileInspectionError::NotAFile);
    }
    let size = file_stat.len() as u64;
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());

    let header = read_header(&p).unwrap_or_default();
    let media_type = detect_image_media_type(&p, &header);

    if video_media_type_by_ext(&p).is_some() || looks_like_video_container(&header) {
        let ffprobe = video::bundled_ffprobe_path().map_err(FileInspectionError::Video)?;
        let video =
            video::probe_and_validate(&p, size, &ffprobe).map_err(FileInspectionError::Video)?;
        return Ok(AttachmentMeta {
            path: path.to_string(),
            name,
            size,
            kind: AttachmentKind::Video,
            media_type: video_media_type_by_ext(&p).map(str::to_string),
            width: Some(video.width),
            height: Some(video.height),
            extracted_text: None,
            extraction_status: None,
            video: Some(video),
        });
    }

    let (width, height, kind, extracted_text, extraction_status) = if media_type.is_some() {
        let dims = read_image_dimensions(&p);
        let kind = AttachmentKind::Image;
        match dims {
            Some((w, h)) => (Some(w), Some(h), kind, None, None),
            None => (None, None, kind, None, None),
        }
    } else if is_pdf_file(&header) {
        // PDF: extract text so any model (vision or not) can reason about it.
        // Extraction failures become explicit warnings — never an empty string.
        let (status, text) = extract_pdf_text(&p, size);
        (
            None,
            None,
            AttachmentKind::File,
            Some(text),
            Some(status),
        )
    } else if is_text_file_by_ext(&p) {
        // Known text extension: read content directly.
        let (status, text) = extract_text_file_content(&p, size);
        (
            None,
            None,
            AttachmentKind::File,
            Some(text),
            Some(status),
        )
    } else {
        // Unknown extension: use content heuristic (8KB sample).
        let sample = read_content_sample(&p);
        if is_text_file_by_content(&sample) {
            let (status, text) = extract_text_file_content(&p, size);
            (
                None,
                None,
                AttachmentKind::File,
                Some(text),
                Some(status),
            )
        } else {
            // Unknown binary format: honest warning, don't let the model guess.
            (
                None,
                None,
                AttachmentKind::File,
                Some(
                    "[This file's format is not recognized as text or PDF. \
                     The model cannot read its content. \
                     Tell the user the file format is not supported and suggest \
                     they paste the content or convert to a supported format.]"
                        .to_string(),
                ),
                Some(ExtractionStatus::Warning),
            )
        }
    };

    Ok(AttachmentMeta {
        path: path.to_string(),
        name,
        size,
        kind,
        media_type,
        width,
        height,
        extracted_text,
        extraction_status,
        video: None,
    })
}

/// Compatibility wrapper for callers that intentionally drop unsupported
/// attachments. New ingress paths should use [`inspect_attachment_result`] to
/// preserve typed video validation failures.
pub fn inspect_attachment(path: &str) -> Option<AttachmentMeta> {
    inspect_attachment_result(path).ok()
}

/// Maximum decoded size for a pasted image (15 MB). Screenshots are rarely
/// this large, but we cap to prevent abuse (e.g. a huge base64 blob that
/// would exhaust memory or fill the disk with temp files).
pub const MAX_PASTED_IMAGE_BYTES: usize = 15 * 1024 * 1024;

/// Maximum decoded size for an avatar image (10 MB). Avatars are small
/// profile pictures — 10MB is generous (a typical JPEG avatar is 50-500KB).
/// Larger uploads are rejected to prevent disk/memory abuse.
pub const MAX_AVATAR_BYTES: usize = 10 * 1024 * 1024;

/// MIME types accepted for avatar uploads. Maps MIME → file extension.
const AVATAR_MIME_EXTENSIONS: &[(&str, &str)] = &[
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/jpg", "jpg"),
    ("image/webp", "webp"),
];

/// Validates a MIME type and returns the corresponding file extension.
/// Returns `None` for unsupported MIME types.
fn avatar_extension_for_mime(mime: &str) -> Option<&'static str> {
    AVATAR_MIME_EXTENSIONS
        .iter()
        .find(|(m, _)| *m == mime.to_lowercase().as_str())
        .map(|(_, ext)| *ext)
}

/// Saves an avatar image (decoded base64 bytes) to the app data directory.
///
/// The avatar is saved as `avatar.<ext>` (e.g. `avatar.png`). If a previous
/// avatar exists with a different extension (e.g. switching from PNG to
/// JPEG), the old file is removed to avoid accumulating stale files.
///
/// Used by the `save_avatar_blob` Tauri command for profile picture uploads.
///
/// Returns the absolute path of the saved file, or an error string.
pub fn save_avatar_blob_core(
    bytes: &[u8],
    mime: &str,
    app_data_dir: &Path,
) -> Result<std::path::PathBuf, String> {
    if bytes.is_empty() {
        return Err("avatar image is empty".to_string());
    }
    if bytes.len() > MAX_AVATAR_BYTES {
        let mb = bytes.len() / (1024 * 1024);
        return Err(format!(
            "avatar too large: {mb}MB (max {}MB)",
            MAX_AVATAR_BYTES / (1024 * 1024)
        ));
    }

    let ext = avatar_extension_for_mime(mime).ok_or_else(|| {
        format!(
            "unsupported avatar MIME type: {mime} (accepted: image/png, image/jpeg, image/webp)"
        )
    })?;

    std::fs::create_dir_all(app_data_dir).map_err(|e| format!("create app_data_dir: {e}"))?;

    for (_, old_ext) in AVATAR_MIME_EXTENSIONS {
        if *old_ext == ext {
            continue;
        }
        let old_path = app_data_dir.join(format!("avatar.{old_ext}"));
        if old_path.exists() {
            let _ = std::fs::remove_file(&old_path);
        }
    }

    let target_path = app_data_dir.join(format!("avatar.{ext}"));
    std::fs::write(&target_path, bytes)
        .map_err(|e| format!("write avatar file: {e}"))?;

    Ok(target_path)
}

/// Writes a pasted image (decoded base64 bytes) to a temp file in the given
/// directory and inspects it via `inspect_attachment`. Used by the
/// `inspect_pasted_image` Tauri command for clipboard paste (screenshots).
///
/// The temp file gets a unique name: `<secs>_<nanos>_<sanitized_filename>`.
/// The extension is derived from the filename (default `.png` if none).
///
/// Returns the AttachmentMeta for the written file, or an error string
/// explaining what went wrong (invalid input, write failure, inspect failure).
pub fn write_pasted_image_and_inspect(
    bytes: &[u8],
    filename: &str,
    target_dir: &Path,
) -> Result<AttachmentMeta, String> {
    if bytes.is_empty() {
        return Err("pasted image is empty".to_string());
    }
    if bytes.len() > MAX_PASTED_IMAGE_BYTES {
        let mb = bytes.len() / (1024 * 1024);
        return Err(format!(
            "pasted image too large: {mb}MB (max {}MB)",
            MAX_PASTED_IMAGE_BYTES / (1024 * 1024)
        ));
    }

    let filename = filename.trim();
    if filename.is_empty() {
        return Err("filename is required".to_string());
    }
    if filename.len() > 255 {
        return Err("filename too long".to_string());
    }

    std::fs::create_dir_all(target_dir).map_err(|e| format!("create dir: {e}"))?;

    let ext = Path::new(filename)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_else(|| ".png".to_string());

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("system time: {e}"))?;
    let secs = now.as_secs();
    let nanos = now.subsec_nanos();
    let sanitized: String = filename
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let unique_name = format!("{secs}_{nanos}_{sanitized}");
    let temp_path = target_dir.join(format!("{unique_name}{ext}"));

    std::fs::write(&temp_path, bytes).map_err(|e| format!("write temp file: {e}"))?;

    let path_str = temp_path.to_string_lossy().to_string();
    match inspect_attachment(&path_str) {
        Some(meta) => Ok(meta),
        None => {
            let _ = std::fs::remove_file(&temp_path);
            Err("failed to inspect pasted image".to_string())
        }
    }
}

/// Inspects multiple file paths, dropping any that fail.
/// Mirrors Electron's `inspectAttachments`.
pub fn inspect_files(paths: &[String]) -> Vec<AttachmentMeta> {
    paths
        .iter()
        .filter_map(|p| inspect_attachment(p))
        .collect()
}

pub fn inspect_files_result(paths: &[String]) -> Result<Vec<AttachmentMeta>, FileInspectionError> {
    paths
        .iter()
        .map(|path| inspect_attachment_result(path))
        .collect()
}

/// Resolves a user-selected image or video to the exact canonical file that
/// may be exposed through Tauri's asset protocol. Keeping this validation in
/// the backend lets the renderer authorize one visual file at a time instead
/// of widening the static asset scope to the user's whole home directory.
pub fn canonical_media_preview_path(path: &str) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| format!("media preview file unavailable: {error}"))?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| format!("media preview metadata unavailable: {error}"))?;
    if !metadata.is_file() {
        return Err("media preview path is not a file".to_string());
    }

    let header = read_header(&canonical)
        .map_err(|error| format!("media preview header unavailable: {error}"))?;
    let is_image = detect_image_media_type(&canonical, &header).is_some();
    let is_video = video_media_type_by_ext(&canonical).is_some()
        || looks_like_video_container(&header);
    if !is_image && !is_video {
        return Err("unsupported media preview format".to_string());
    }

    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static TEST_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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
    fn file_inspection_error_serializes_a_typed_nested_video_error() {
        let error = FileInspectionError::Video(VideoValidationError::TooLarge {
            actual: 501,
            maximum: 500,
        });

        assert_eq!(
            serde_json::to_value(error).unwrap(),
            serde_json::json!({
                "kind": "video",
                "details": {
                    "kind": "tooLarge",
                    "actual": 501,
                    "maximum": 500,
                }
            })
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
        let temp = temp_path("txt");
        std::fs::write(&temp, "hello world").unwrap();
        let meta = inspect_attachment(temp.to_str().unwrap()).unwrap();
        assert_eq!(meta.kind, AttachmentKind::File);
        assert!(meta.media_type.is_none());
        assert!(meta.width.is_none());
        assert_eq!(meta.size, 11);
        let _ = std::fs::remove_file(&temp);
    }

    #[test]
    fn inspect_rejects_a_renamed_text_file_with_a_video_extension() {
        let path = temp_path("mp4");
        std::fs::write(&path, "this is not a video").unwrap();

        let error = inspect_attachment_result(path.to_str().unwrap())
            .expect_err("a text file must never become a video attachment");
        assert!(matches!(error, FileInspectionError::Video(_)));

        let _ = std::fs::remove_file(&path);
    }

    // These tests verify the fix for the "PDF alucinado" bug: when a user
    // attaches a PDF, the model must receive real extracted text (or an
    // explicit warning), never an empty string that invites hallucination.

    /// Unique temp file path with the given suffix.
    fn temp_path(suffix: &str) -> PathBuf {
        let sequence = TEST_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "verboo-test-{}-{sequence}-{nanos}.{suffix}",
            std::process::id()
        ))
    }

    /// Builds a minimal valid PDF containing the given text on a single page.
    /// The PDF has a proper cross-reference table so `pdf-extract` can parse it.
    /// Uses a standard font (Helvetica) so no font embedding is needed.
    fn build_minimal_pdf_with_text(text: &str) -> Vec<u8> {
        // Escape parentheses and backslashes per PDF string rules.
        let escaped = text
            .replace('\\', "\\\\")
            .replace('(', "\\(")
            .replace(')', "\\)");
        let content = format!("BT /F1 24 Tf 100 700 Td ({escaped}) Tj ET");

        // Build objects, tracking byte offsets for the xref table.
        let mut pdf = String::from("%PDF-1.1\n");
        let mut offsets: Vec<usize> = Vec::new();

        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        ];

        for (i, obj) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.push_str(&format!("{} 0 obj\n{}\nendobj\n", i + 1, obj));
        }

        // Object 5: content stream with /Length.
        offsets.push(pdf.len());
        pdf.push_str(&format!(
            "5 0 obj\n<< /Length {} >>\nstream\n{}\nendstream\nendobj\n",
            content.len(),
            content
        ));

        // xref table.
        let xref_offset = pdf.len();
        pdf.push_str(&format!(
            "xref\n0 6\n0000000000 65535 f \n"
        ));
        for off in &offsets {
            pdf.push_str(&format!("{:010} 00000 n \n", off));
        }

        // trailer.
        pdf.push_str(&format!(
            "trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n{}\n%%EOF\n",
            xref_offset
        ));

        pdf.into_bytes()
    }

    /// Builds a minimal valid PDF with NO text layer (simulates a scanned PDF).
    /// The page has an empty content stream, so pdf-extract returns empty.
    fn build_minimal_pdf_no_text() -> Vec<u8> {
        let mut pdf = String::from("%PDF-1.1\n");
        let mut offsets: Vec<usize> = Vec::new();

        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /Resources << >> /MediaBox [0 0 612 792] /Contents 4 0 R >>",
        ];

        for (i, obj) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.push_str(&format!("{} 0 obj\n{}\nendobj\n", i + 1, obj));
        }

        // Object 4: empty content stream.
        offsets.push(pdf.len());
        pdf.push_str("4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n");

        let xref_offset = pdf.len();
        pdf.push_str("xref\n0 5\n0000000000 65535 f \n");
        for off in &offsets {
            pdf.push_str(&format!("{:010} 00000 n \n", off));
        }
        pdf.push_str(&format!(
            "trailer\n<< /Root 1 0 R /Size 5 >>\nstartxref\n{}\n%%EOF\n",
            xref_offset
        ));

        pdf.into_bytes()
    }

    #[test]
    fn is_pdf_file_detects_magic() {
        assert!(is_pdf_file(b"%PDF-1.1\nrest"));
        assert!(is_pdf_file(b"%PDF-2.0"));
        assert!(!is_pdf_file(b"not a pdf"));
        assert!(!is_pdf_file(b""));
        assert!(!is_pdf_file(b"%PDF")); // missing dash
    }

    #[test]
    fn extract_pdf_text_from_real_pdf() {
        let path = temp_path("pdf");
        let pdf = build_minimal_pdf_with_text("Joao da Silva Resume");
        std::fs::write(&path, &pdf).unwrap();
        let (status, text) = extract_pdf_text(&path, pdf.len() as u64);
        assert_eq!(
            status,
            ExtractionStatus::Extracted,
            "real text should be Extracted"
        );
        assert!(
            text.contains("Joao da Silva Resume") || text.contains("Joao"),
            "extracted text should contain the PDF content, got: {text}"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn extract_pdf_text_from_scanned_pdf_returns_warning() {
        // PDF with no text layer — simulates a scanned document.
        // The model must be told explicitly, not given an empty string.
        let path = temp_path("pdf");
        let pdf = build_minimal_pdf_no_text();
        std::fs::write(&path, &pdf).unwrap();
        let (status, text) = extract_pdf_text(&path, pdf.len() as u64);
        assert_eq!(
            status,
            ExtractionStatus::Warning,
            "scanned PDF should be Warning"
        );
        assert!(
            text.contains("No extractable text") || text.contains("scanned"),
            "scanned PDF should produce a warning, got: {text}"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn extract_pdf_text_from_corrupt_pdf_returns_warning() {
        // Bytes that start with %PDF- but are garbage after — simulates a
        // truncated/corrupted download. pdf-extract is lenient and may parse
        // this as an empty PDF (→ "scanned" warning) or fail (→ "corrupt"
        // warning). Both are acceptable — the key assertion is that we get
        // a Warning status, never an empty string.
        let path = temp_path("pdf");
        let corrupt = b"%PDF-1.1\nthis is not a real pdf body at all !!!\n%%EOF\n";
        std::fs::write(&path, corrupt).unwrap();
        let (status, text) = extract_pdf_text(&path, corrupt.len() as u64);
        assert_eq!(
            status,
            ExtractionStatus::Warning,
            "corrupt PDF should be Warning"
        );
        assert!(
            !text.trim().is_empty(),
            "corrupt PDF should produce a non-empty warning"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn extract_pdf_text_too_large_returns_warning() {
        // Don't actually write a 5MB file — just test the size guard directly.
        let path = temp_path("pdf");
        let pdf = build_minimal_pdf_with_text("small");
        std::fs::write(&path, &pdf).unwrap();
        let oversized = MAX_PDF_SIZE_FOR_EXTRACTION + 1;
        let (status, text) = extract_pdf_text(&path, oversized);
        assert_eq!(
            status,
            ExtractionStatus::Warning,
            "oversized PDF should be Warning"
        );
        assert!(
            text.contains("too large"),
            "oversized PDF should produce a too-large warning, got: {text}"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn truncate_extracted_text_short_text_unchanged() {
        let input = "Hello, world!".to_string();
        let output = truncate_extracted_text(input.clone());
        assert_eq!(output, input);
    }

    #[test]
    fn truncate_extracted_text_long_text_gets_marker() {
        let input = "A".repeat(MAX_EXTRACTED_TEXT_BYTES * 2);
        let input_len = input.len();
        let output = truncate_extracted_text(input);
        assert!(output.len() < input_len, "should be truncated");
        assert!(
            output.contains("[truncated:"),
            "should have truncation marker, got tail: {}",
            &output[output.len().saturating_sub(200)..]
        );
    }

    #[test]
    fn truncate_extracted_text_respects_utf8_boundary() {
        // Multi-byte UTF-8 right at the cut point must not panic.
        // 'é' is 2 bytes in UTF-8; fill so the cut lands mid-char.
        let input = "é".repeat(MAX_EXTRACTED_TEXT_BYTES);
        let output = truncate_extracted_text(input);
        // Should not panic and should be valid UTF-8 (String guarantees this).
        assert!(output.contains("[truncated:") || output.len() <= MAX_EXTRACTED_TEXT_BYTES);
    }

    #[test]
    fn inspect_pdf_attachment_includes_extracted_text() {
        let path = temp_path("pdf");
        let pdf = build_minimal_pdf_with_text("UniqueMarkerContent123");
        std::fs::write(&path, &pdf).unwrap();
        let meta = inspect_attachment(path.to_str().unwrap()).unwrap();
        assert_eq!(meta.kind, AttachmentKind::File);
        assert!(meta.extracted_text.is_some(), "PDF should have extracted text");
        let text = meta.extracted_text.unwrap();
        assert!(
            text.contains("UniqueMarkerContent123"),
            "extracted text should contain the marker, got: {text}"
        );
        assert_eq!(
            meta.extraction_status,
            Some(ExtractionStatus::Extracted),
            "real text should be marked Extracted"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn inspect_scanned_pdf_marks_status_as_warning() {
        // Scanned PDF (no text layer) — extracted_text holds a warning string,
        // and extraction_status is Warning so the frontend can distinguish.
        let path = temp_path("pdf");
        let pdf = build_minimal_pdf_no_text();
        std::fs::write(&path, &pdf).unwrap();
        let meta = inspect_attachment(path.to_str().unwrap()).unwrap();
        assert!(meta.extracted_text.is_some(), "should have warning string");
        assert_eq!(
            meta.extraction_status,
            Some(ExtractionStatus::Warning),
            "scanned PDF should be marked Warning"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn inspect_non_pdf_file_has_no_extracted_text() {
        // Binary file with unknown extension — should get warning, not extraction.
        let path = temp_path("bin");
        std::fs::write(&path, [0u8, 1, 2, 3, 0, 255, 254, 0]).unwrap();
        let meta = inspect_attachment(path.to_str().unwrap()).unwrap();
        assert!(meta.extracted_text.is_some(), "binary should have warning");
        assert_eq!(
            meta.extraction_status,
            Some(ExtractionStatus::Warning),
            "binary unknown should be Warning"
        );
        let _ = std::fs::remove_file(&path);
    }

    // Text file extraction tests (FRENTE B)

    #[test]
    fn is_text_file_by_ext_recognizes_common_formats() {
        assert!(is_text_file_by_ext(Path::new("readme.md")));
        assert!(is_text_file_by_ext(Path::new("notes.txt")));
        assert!(is_text_file_by_ext(Path::new("data.json")));
        assert!(is_text_file_by_ext(Path::new("config.yaml")));
        assert!(is_text_file_by_ext(Path::new("config.yml")));
        assert!(is_text_file_by_ext(Path::new("Cargo.toml")));
        assert!(is_text_file_by_ext(Path::new("app.tsx")));
        assert!(is_text_file_by_ext(Path::new("main.rs")));
        assert!(is_text_file_by_ext(Path::new("script.sh")));
        assert!(is_text_file_by_ext(Path::new("Dockerfile"))); // no ext — matches by filename
        assert!(!is_text_file_by_ext(Path::new("image.png")));
        assert!(!is_text_file_by_ext(Path::new("archive.zip")));
        assert!(!is_text_file_by_ext(Path::new("unknown.xyz")));
    }

    #[test]
    fn is_text_file_by_ext_no_extension_filenames() {
        assert!(is_text_file_by_ext(Path::new("Dockerfile")));
        assert!(is_text_file_by_ext(Path::new("Makefile")));
        assert!(is_text_file_by_ext(Path::new(".gitignore")));
        assert!(is_text_file_by_ext(Path::new(".env")));
    }

    #[test]
    fn is_text_file_by_content_pure_text() {
        let bytes = b"Hello, world!\nThis is a text file.\nLine 3.\n";
        assert!(is_text_file_by_content(bytes));
    }

    #[test]
    fn is_text_file_by_content_with_unicode() {
        let bytes = "Olá, mundo! João da Silva — café\n".as_bytes();
        assert!(is_text_file_by_content(bytes));
    }

    #[test]
    fn is_text_file_by_content_rejects_binary() {
        // NUL byte = binary.
        let bytes = [0u8, 1, 2, 3, 0, 255, 254, 0];
        assert!(!is_text_file_by_content(&bytes));
    }

    #[test]
    fn is_text_file_by_content_rejects_invalid_utf8() {
        // Invalid UTF-8 sequence.
        let bytes = [0xFF, 0xFE, 0xFD, 0xFC];
        assert!(!is_text_file_by_content(&bytes));
    }

    #[test]
    fn is_text_file_by_content_empty_file_is_text() {
        assert!(is_text_file_by_content(&[]));
    }

    #[test]
    fn extract_text_file_content_reads_markdown() {
        let path = temp_path("md");
        std::fs::write(&path, "# Title\n\nSome **markdown** content.\n").unwrap();
        let (status, text) = extract_text_file_content(&path, 50);
        assert_eq!(status, ExtractionStatus::Extracted);
        assert!(text.contains("# Title"));
        assert!(text.contains("markdown"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn extract_text_file_content_reads_json() {
        let path = temp_path("json");
        std::fs::write(&path, r#"{"name": "João", "age": 30}"#).unwrap();
        let (status, text) = extract_text_file_content(&path, 40);
        assert_eq!(status, ExtractionStatus::Extracted);
        assert!(text.contains("João"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn extract_text_file_content_too_large_returns_warning() {
        let path = temp_path("txt");
        std::fs::write(&path, "small").unwrap();
        let oversized = MAX_TEXT_SIZE_FOR_EXTRACTION + 1;
        let (status, text) = extract_text_file_content(&path, oversized);
        assert_eq!(status, ExtractionStatus::Warning);
        assert!(text.contains("too large"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn inspect_markdown_attachment_extracts_content() {
        let path = temp_path("md");
        std::fs::write(&path, "# UniqueMdMarker123\n\nContent here.").unwrap();
        let meta = inspect_attachment(path.to_str().unwrap()).unwrap();
        assert_eq!(meta.kind, AttachmentKind::File);
        assert!(meta.extracted_text.is_some());
        assert_eq!(
            meta.extraction_status,
            Some(ExtractionStatus::Extracted),
            "markdown should be Extracted"
        );
        let text = meta.extracted_text.unwrap();
        assert!(text.contains("UniqueMdMarker123"), "got: {text}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn inspect_txt_attachment_extracts_content() {
        let path = temp_path("txt");
        std::fs::write(&path, "plain text content with marker").unwrap();
        let meta = inspect_attachment(path.to_str().unwrap()).unwrap();
        assert_eq!(meta.extraction_status, Some(ExtractionStatus::Extracted));
        assert!(meta.extracted_text.unwrap().contains("marker"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn inspect_json_attachment_extracts_content() {
        let path = temp_path("json");
        std::fs::write(&path, r#"{"key": "JsonValueMarker456"}"#).unwrap();
        let meta = inspect_attachment(path.to_str().unwrap()).unwrap();
        assert_eq!(meta.extraction_status, Some(ExtractionStatus::Extracted));
        assert!(meta.extracted_text.unwrap().contains("JsonValueMarker456"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn inspect_unknown_ext_text_by_content_extracts() {
        // File with unknown extension but text content — heuristic should catch it.
        let path = temp_path("xyz");
        std::fs::write(&path, "This is text content with a marker token.").unwrap();
        let meta = inspect_attachment(path.to_str().unwrap()).unwrap();
        assert_eq!(
            meta.extraction_status,
            Some(ExtractionStatus::Extracted),
            "text by content should be Extracted"
        );
        assert!(meta.extracted_text.unwrap().contains("marker token"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn inspect_binary_unknown_ext_returns_warning() {
        // Binary file with unknown extension — honest warning.
        let path = temp_path("dat");
        std::fs::write(&path, [0u8, 1, 2, 3, 0, 255, 254, 0, 1, 2]).unwrap();
        let meta = inspect_attachment(path.to_str().unwrap()).unwrap();
        assert_eq!(
            meta.extraction_status,
            Some(ExtractionStatus::Warning),
            "binary unknown should be Warning"
        );
        let text = meta.extracted_text.unwrap();
        assert!(
            text.contains("not recognized") || text.contains("not supported"),
            "binary should have format warning, got: {text}"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn inspect_code_file_extracts_content() {
        let path = temp_path("rs");
        std::fs::write(&path, "fn main() { println!(\"RustCodeMarker789\"); }").unwrap();
        let meta = inspect_attachment(path.to_str().unwrap()).unwrap();
        assert_eq!(meta.extraction_status, Some(ExtractionStatus::Extracted));
        assert!(meta.extracted_text.unwrap().contains("RustCodeMarker789"));
        let _ = std::fs::remove_file(&path);
    }

    // Pasted image tests (inspect_pasted_image command)

    /// Minimal valid PNG (1x1 red pixel) for testing image inspection.
    fn minimal_png_bytes() -> Vec<u8> {
        vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
            0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, // 8bit RGB
            0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, // IDAT chunk
            0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, // data
            0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC, 0x33, // crc
            0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, // IEND
            0xAE, 0x42, 0x60, 0x82,
        ]
    }

    #[test]
    fn canonical_media_preview_path_accepts_real_images() {
        let path = temp_path("png");
        std::fs::write(&path, minimal_png_bytes()).unwrap();

        let resolved = canonical_media_preview_path(path.to_str().unwrap()).unwrap();

        assert_eq!(resolved, std::fs::canonicalize(&path).unwrap());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn canonical_media_preview_path_rejects_non_media_files() {
        let path = temp_path("txt");
        std::fs::write(&path, b"not visual media").unwrap();

        let error = canonical_media_preview_path(path.to_str().unwrap()).unwrap_err();

        assert!(error.contains("unsupported media"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn write_pasted_image_png_writes_and_inspects() {
        let dir = std::env::temp_dir().join(format!(
            "verboo-test-paste-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let png = minimal_png_bytes();
        let meta = write_pasted_image_and_inspect(&png, "screenshot.png", &dir).unwrap();
        assert_eq!(meta.kind, AttachmentKind::Image);
        assert_eq!(meta.media_type.as_deref(), Some("image/png"));
        assert_eq!(meta.size, png.len() as u64);
        assert!(std::path::Path::new(&meta.path).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_pasted_image_rejects_empty_bytes() {
        let dir = std::env::temp_dir().join("verboo-test-paste-empty");
        let result = write_pasted_image_and_inspect(&[], "img.png", &dir);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_pasted_image_rejects_oversized() {
        let dir = std::env::temp_dir().join("verboo-test-paste-big");
        let oversized = vec![0u8; MAX_PASTED_IMAGE_BYTES + 1];
        let result = write_pasted_image_and_inspect(&oversized, "big.png", &dir);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("too large"), "got: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_pasted_image_rejects_empty_filename() {
        let dir = std::env::temp_dir().join("verboo-test-paste-noname");
        let png = minimal_png_bytes();
        let result = write_pasted_image_and_inspect(&png, "", &dir);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("filename is required"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_pasted_image_sanitizes_filename() {
        let dir = std::env::temp_dir().join(format!(
            "verboo-test-paste-sanitize-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let png = minimal_png_bytes();
        // Filename with path separators and spaces — should be sanitized.
        let meta = write_pasted_image_and_inspect(&png, "../../etc/passwd screenshot.png", &dir)
            .unwrap();
        // The written file must be INSIDE the target dir (no path traversal).
        let written_parent = std::path::Path::new(&meta.path).parent().unwrap();
        assert!(
            written_parent == dir,
            "file should be written inside target dir, got parent: {:?}, expected: {:?}",
            written_parent,
            dir
        );
        // No path separators in the filename portion (all sanitized to _).
        let filename = std::path::Path::new(&meta.path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(
            !filename.contains('/'),
            "filename should have no path separators, got: {}",
            filename
        );
        assert!(std::path::Path::new(&meta.path).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_pasted_image_default_extension_png() {
        let dir = std::env::temp_dir().join(format!(
            "verboo-test-paste-ext-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let png = minimal_png_bytes();
        let meta = write_pasted_image_and_inspect(&png, "screenshot", &dir).unwrap();
        assert!(
            meta.path.ends_with(".png"),
            "should default to .png extension, got: {}",
            meta.path
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_pasted_image_jpeg_extension_preserved() {
        let dir = std::env::temp_dir().join(format!(
            "verboo-test-paste-jpg-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // Use PNG bytes but with .jpg filename — extension should be preserved
        // from the filename (the inspect will still detect PNG by magic bytes).
        let png = minimal_png_bytes();
        let meta = write_pasted_image_and_inspect(&png, "photo.jpg", &dir).unwrap();
        assert!(
            meta.path.ends_with(".jpg"),
            "should preserve .jpg extension, got: {}",
            meta.path
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_pasted_image_unique_filenames() {
        let dir = std::env::temp_dir().join(format!(
            "verboo-test-paste-unique-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let png = minimal_png_bytes();
        let meta1 = write_pasted_image_and_inspect(&png, "shot.png", &dir).unwrap();
        // Small delay to ensure different nanos.
        std::thread::sleep(std::time::Duration::from_millis(1));
        let meta2 = write_pasted_image_and_inspect(&png, "shot.png", &dir).unwrap();
        assert_ne!(
            meta1.path, meta2.path,
            "unique names should prevent collisions"
        );
        // Both files should exist.
        assert!(std::path::Path::new(&meta1.path).exists());
        assert!(std::path::Path::new(&meta2.path).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Avatar blob tests (save_avatar_blob command)

    #[test]
    fn save_avatar_blob_png_saves_and_returns_path() {
        let dir = std::env::temp_dir().join(format!(
            "verboo-test-avatar-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let png = minimal_png_bytes();
        let path = save_avatar_blob_core(&png, "image/png", &dir).unwrap();
        assert!(path.ends_with("avatar.png"), "got: {}", path.display());
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_avatar_blob_jpeg_saves_with_jpg_extension() {
        let dir = std::env::temp_dir().join(format!(
            "verboo-test-avatar-jpg-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // Use PNG bytes but with JPEG MIME — extension comes from MIME.
        let png = minimal_png_bytes();
        let path = save_avatar_blob_core(&png, "image/jpeg", &dir).unwrap();
        assert!(path.ends_with("avatar.jpg"), "got: {}", path.display());
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_avatar_blob_webp_saves_with_webp_extension() {
        let dir = std::env::temp_dir().join(format!(
            "verboo-test-avatar-webp-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let bytes = vec![0u8; 100]; // fake webp bytes
        let path = save_avatar_blob_core(&bytes, "image/webp", &dir).unwrap();
        assert!(path.ends_with("avatar.webp"), "got: {}", path.display());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_avatar_blob_rejects_empty_bytes() {
        let dir = std::env::temp_dir().join("verboo-test-avatar-empty");
        let result = save_avatar_blob_core(&[], "image/png", &dir);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_avatar_blob_rejects_invalid_mime() {
        let dir = std::env::temp_dir().join("verboo-test-avatar-mime");
        let bytes = vec![0u8; 100];
        let result = save_avatar_blob_core(&bytes, "image/gif", &dir);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("unsupported"), "got: {err}");
        assert!(err.contains("image/gif"), "should mention the rejected MIME");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_avatar_blob_rejects_oversized() {
        let dir = std::env::temp_dir().join("verboo-test-avatar-big");
        let oversized = vec![0u8; MAX_AVATAR_BYTES + 1];
        let result = save_avatar_blob_core(&oversized, "image/png", &dir);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("too large"), "got: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_avatar_blob_removes_old_extension() {
        // Save PNG, then save JPEG — the old avatar.png should be removed.
        let dir = std::env::temp_dir().join(format!(
            "verboo-test-avatar-cleanup-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let png = minimal_png_bytes();

        let png_path = save_avatar_blob_core(&png, "image/png", &dir).unwrap();
        assert!(png_path.ends_with("avatar.png"));
        assert!(png_path.exists());

        // Save JPEG — should remove avatar.png.
        let jpg_path = save_avatar_blob_core(&png, "image/jpeg", &dir).unwrap();
        assert!(jpg_path.ends_with("avatar.jpg"));
        assert!(jpg_path.exists());
        assert!(
            !png_path.exists(),
            "old avatar.png should be removed after switching to JPEG"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_avatar_blob_overwrites_same_extension() {
        // Saving a new avatar with the same MIME should overwrite, not error.
        let dir = std::env::temp_dir().join(format!(
            "verboo-test-avatar-overwrite-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let png1 = minimal_png_bytes();
        let path1 = save_avatar_blob_core(&png1, "image/png", &dir).unwrap();

        let png2 = vec![0xFF; 200]; // different content
        let path2 = save_avatar_blob_core(&png2, "image/png", &dir).unwrap();

        assert_eq!(path1, path2, "same extension should overwrite same path");
        assert!(path2.exists());
        let saved = std::fs::read(&path2).unwrap();
        assert_eq!(saved, png2, "content should be overwritten");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_avatar_blob_mime_case_insensitive() {
        // MIME types should be matched case-insensitively.
        let dir = std::env::temp_dir().join("verboo-test-avatar-case");
        let bytes = vec![0u8; 100];
        let path = save_avatar_blob_core(&bytes, "IMAGE/PNG", &dir).unwrap();
        assert!(path.ends_with("avatar.png"), "got: {}", path.display());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
