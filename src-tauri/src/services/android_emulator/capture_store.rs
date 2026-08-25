use std::collections::HashSet;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use image::{DynamicImage, GenericImageView, ImageFormat};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NormalizedCaptureRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CaptureWriteReport {
    pub crop_path: String,
    pub viewport_path: String,
    pub crop_width: u32,
    pub crop_height: u32,
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub crop_bytes: usize,
    pub viewport_bytes: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PromotedAndroidCaptureFile {
    pub from: String,
    pub to: String,
}

/// Temporary and conversation-durable files from Android emulator annotation
/// captures. Explicit screenshot/record buttons keep writing to the Desktop.
#[derive(Clone)]
pub struct AndroidEmulatorCaptureStore {
    temp_root: PathBuf,
    root: PathBuf,
}

impl AndroidEmulatorCaptureStore {
    #[cfg(test)]
    pub(crate) fn for_test(temp_root: PathBuf, root: PathBuf) -> Self {
        std::fs::create_dir_all(&temp_root).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        Self { temp_root, root }
    }

    pub fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        let store = Self {
            temp_root: std::env::temp_dir().join("verboo-android-emulator"),
            root: app_data_dir.join("android_captures"),
        };
        std::fs::create_dir_all(&store.temp_root)
            .map_err(|error| format!("create android emulator temp store falhou: {error}"))?;
        std::fs::create_dir_all(&store.root)
            .map_err(|error| format!("create android emulator capture store falhou: {error}"))?;
        store.cleanup_temp_root()?;
        Ok(store)
    }

    pub fn write_capture(
        &self,
        bytes: &[u8],
        rect: NormalizedCaptureRect,
    ) -> Result<CaptureWriteReport, String> {
        let image = image::load_from_memory(bytes)
            .map_err(|error| format!("captura do emulador Android inválida: {error}"))?;
        let (viewport_width, viewport_height) = image.dimensions();
        if viewport_width == 0 || viewport_height == 0 {
            return Err("A captura do emulador Android está vazia.".into());
        }
        let (left, top, crop_width, crop_height) =
            pixel_crop(rect, viewport_width, viewport_height)?;
        let crop = image.crop_imm(left, top, crop_width, crop_height);
        let viewport_png = encode_png(&image)?;
        let crop_png = encode_png(&crop)?;

        std::fs::create_dir_all(&self.temp_root)
            .map_err(|error| format!("create android emulator temp store falhou: {error}"))?;
        let stem = Uuid::new_v4().to_string();
        let crop_path = self.temp_root.join(format!("{stem}-crop.png"));
        let viewport_path = self.temp_root.join(format!("{stem}-viewport.png"));
        std::fs::write(&viewport_path, &viewport_png)
            .map_err(|error| format!("write android emulator viewport falhou: {error}"))?;
        if let Err(error) = std::fs::write(&crop_path, &crop_png) {
            let _ = std::fs::remove_file(&viewport_path);
            return Err(format!("write android emulator crop falhou: {error}"));
        }

        Ok(CaptureWriteReport {
            crop_path: crop_path.to_string_lossy().into_owned(),
            viewport_path: viewport_path.to_string_lossy().into_owned(),
            crop_width,
            crop_height,
            viewport_width,
            viewport_height,
            crop_bytes: crop_png.len(),
            viewport_bytes: viewport_png.len(),
        })
    }

    pub fn delete_temp_files(&self, paths: Vec<String>) -> Result<(), String> {
        let paths = paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
        if let Some(path) = paths.iter().find(|path| !self.is_temp_png(path)) {
            return Err(format!(
                "arquivo temporário fora do diretório do emulador Android: {}",
                path.display()
            ));
        }
        for path in paths {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "remove android emulator temp falhou para {}: {error}",
                        path.display()
                    ))
                }
            }
        }
        Ok(())
    }

    pub fn promote(
        &self,
        owner_id: &str,
        paths: Vec<String>,
    ) -> Result<Vec<PromotedAndroidCaptureFile>, String> {
        let owner_dir = self.owner_dir(owner_id)?;
        let sources = paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
        if let Some(path) = sources
            .iter()
            .find(|path| !self.is_temp_png(path) || !path.is_file())
        {
            return Err(format!("captura temporária inválida: {}", path.display()));
        }
        std::fs::create_dir_all(&owner_dir)
            .map_err(|error| format!("create android emulator capture owner falhou: {error}"))?;

        let mut promoted: Vec<PromotedAndroidCaptureFile> = Vec::with_capacity(sources.len());
        for source in &sources {
            let destination = owner_dir.join(format!("{}.png", Uuid::new_v4()));
            if let Err(error) = std::fs::copy(source, &destination) {
                for copied in &promoted {
                    let _ = std::fs::remove_file(&copied.to);
                }
                return Err(format!("promote android emulator capture falhou: {error}"));
            }
            promoted.push(PromotedAndroidCaptureFile {
                from: source.to_string_lossy().into_owned(),
                to: destination.to_string_lossy().into_owned(),
            });
        }
        for source in sources {
            let _ = std::fs::remove_file(source);
        }
        Ok(promoted)
    }

    pub fn delete_owner(&self, owner_id: &str) -> Result<(), String> {
        let owner_dir = self.owner_dir(owner_id)?;
        match std::fs::remove_dir_all(&owner_dir) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!(
                "delete android emulator capture owner falhou: {error}"
            )),
        }
    }

    pub fn cleanup_owners(&self, active_owner_ids: Vec<String>) -> Result<(), String> {
        let active = active_owner_ids
            .iter()
            .map(|owner| self.owner_dir(owner))
            .collect::<Result<HashSet<_>, _>>()?;
        for entry in std::fs::read_dir(&self.root)
            .map_err(|error| format!("read android emulator capture store falhou: {error}"))?
        {
            let entry = entry
                .map_err(|error| format!("read android emulator capture owner falhou: {error}"))?;
            let path = entry.path();
            if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
                && !active.contains(&path)
            {
                std::fs::remove_dir_all(&path).map_err(|error| {
                    format!("cleanup android emulator capture owner falhou: {error}")
                })?;
            }
        }
        Ok(())
    }

    pub(crate) fn owner_dir(&self, owner_id: &str) -> Result<PathBuf, String> {
        if owner_id.is_empty() || owner_id.len() > 512 {
            return Err("owner id inválido".into());
        }
        let digest = Sha256::digest(owner_id.as_bytes());
        Ok(self.root.join(format!("{digest:x}")))
    }

    pub(crate) fn temp_root(&self) -> &Path {
        &self.temp_root
    }

    #[cfg(test)]
    pub(crate) fn durable_root(&self) -> &Path {
        &self.root
    }

    fn is_temp_png(&self, path: &Path) -> bool {
        path.parent() == Some(self.temp_root.as_path())
            && path.extension().and_then(|extension| extension.to_str()) == Some("png")
    }

    fn cleanup_temp_root(&self) -> Result<(), String> {
        let entries = match std::fs::read_dir(&self.temp_root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("read android emulator temp store falhou: {error}")),
        };
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("read android emulator temp falhou: {error}"))?;
            let path = entry.path();
            if self.is_temp_png(&path)
                && entry
                    .file_type()
                    .map(|kind| kind.is_file())
                    .unwrap_or(false)
            {
                std::fs::remove_file(&path)
                    .map_err(|error| format!("cleanup android emulator temp falhou: {error}"))?;
            }
        }
        Ok(())
    }
}

fn encode_png(image: &DynamicImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .map_err(|error| format!("encode android emulator capture falhou: {error}"))?;
    Ok(bytes)
}

fn pixel_crop(
    rect: NormalizedCaptureRect,
    viewport_width: u32,
    viewport_height: u32,
) -> Result<(u32, u32, u32, u32), String> {
    if ![rect.x, rect.y, rect.width, rect.height]
        .into_iter()
        .all(f64::is_finite)
        || rect.width <= 0.0
        || rect.height <= 0.0
    {
        return Err("Área de captura inválida.".into());
    }
    let left = rect.x.clamp(0.0, 1.0);
    let top = rect.y.clamp(0.0, 1.0);
    let right = (rect.x + rect.width).clamp(0.0, 1.0);
    let bottom = (rect.y + rect.height).clamp(0.0, 1.0);
    if right <= left || bottom <= top {
        return Err("A área selecionada está fora do emulador Android.".into());
    }
    let left_px = (left * f64::from(viewport_width)).floor() as u32;
    let top_px = (top * f64::from(viewport_height)).floor() as u32;
    let right_px =
        ((right * f64::from(viewport_width)).ceil() as u32).clamp(left_px + 1, viewport_width);
    let bottom_px =
        ((bottom * f64::from(viewport_height)).ceil() as u32).clamp(top_px + 1, viewport_height);
    Ok((left_px, top_px, right_px - left_px, bottom_px - top_px))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    use image::{DynamicImage, ImageBuffer, ImageFormat, Rgba};

    fn png(width: u32, height: u32) -> Vec<u8> {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(
            width,
            height,
            Rgba([90, 40, 180, 255]),
        ));
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .unwrap();
        bytes
    }

    fn store() -> (tempfile::TempDir, AndroidEmulatorCaptureStore) {
        let directory = tempfile::tempdir().unwrap();
        let temp_root = directory.path().join("temp");
        let root = directory.path().join("durable");
        let store = AndroidEmulatorCaptureStore::for_test(temp_root, root);
        (directory, store)
    }

    #[test]
    fn writes_same_snapshot_as_a_200_by_200_crop_and_400_by_800_viewport() {
        let (_directory, store) = store();
        let report = store
            .write_capture(
                &png(400, 800),
                NormalizedCaptureRect {
                    x: 0.25,
                    y: 0.25,
                    width: 0.5,
                    height: 0.25,
                },
            )
            .unwrap();

        assert_eq!((report.crop_width, report.crop_height), (200, 200));
        assert_eq!((report.viewport_width, report.viewport_height), (400, 800));
        assert!(PathBuf::from(&report.crop_path).is_file());
        assert!(PathBuf::from(&report.viewport_path).is_file());
        let crop_stem = PathBuf::from(&report.crop_path)
            .file_stem()
            .unwrap()
            .to_string_lossy()
            .trim_end_matches("-crop")
            .to_string();
        let viewport_stem = PathBuf::from(&report.viewport_path)
            .file_stem()
            .unwrap()
            .to_string_lossy()
            .trim_end_matches("-viewport")
            .to_string();
        assert_eq!(crop_stem, viewport_stem);
    }

    #[test]
    fn rejects_deletion_outside_the_simulator_temp_root() {
        let (_directory, store) = store();
        let error = store
            .delete_temp_files(vec!["/tmp/not-verboo/file.png".into()])
            .unwrap_err();
        assert!(
            error.contains("/tmp/not-verboo/file.png"),
            "outside-temp rejection must name the path, got {error}"
        );
        assert!(
            !error.contains("not implemented"),
            "stub error is not an allowlist rejection: {error}"
        );
    }

    #[test]
    fn hashes_each_capture_owner_into_a_distinct_directory() {
        let (_directory, store) = store();
        assert_ne!(
            store.owner_dir("conversation-a").unwrap(),
            store.owner_dir("conversation-b").unwrap(),
        );
        assert!(!store
            .owner_dir("conversation-a")
            .unwrap()
            .ends_with("conversation-a"));
    }

    #[test]
    fn write_capture_stays_under_temp_root_and_never_the_desktop() {
        let directory = tempfile::tempdir().unwrap();
        let desktop = directory.path().join("Desktop");
        let temp_root = directory.path().join("temp");
        let root = directory.path().join("android_captures");
        std::fs::create_dir_all(&desktop).unwrap();
        let store = AndroidEmulatorCaptureStore::for_test(temp_root.clone(), root);
        let report = store
            .write_capture(
                &png(400, 800),
                NormalizedCaptureRect {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
            )
            .unwrap();

        let crop = PathBuf::from(&report.crop_path);
        let viewport = PathBuf::from(&report.viewport_path);
        assert!(crop.starts_with(&temp_root));
        assert!(viewport.starts_with(&temp_root));
        assert!(!crop.starts_with(&desktop));
        assert!(!viewport.starts_with(&desktop));
        assert_eq!(desktop.read_dir().unwrap().count(), 0);
        assert!(crop
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with("-crop.png"));
        assert!(viewport
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with("-viewport.png"));
    }

    #[test]
    fn promote_moves_temp_pngs_into_the_hashed_owner_dir_not_the_desktop() {
        let directory = tempfile::tempdir().unwrap();
        let desktop = directory.path().join("Desktop");
        let temp_root = directory.path().join("temp");
        let root = directory.path().join("android_captures");
        std::fs::create_dir_all(&desktop).unwrap();
        let store = AndroidEmulatorCaptureStore::for_test(temp_root, root.clone());
        let report = store
            .write_capture(
                &png(20, 40),
                NormalizedCaptureRect {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
            )
            .unwrap();
        let crop = report.crop_path.clone();
        let viewport = report.viewport_path.clone();

        let promoted = store
            .promote("conversation-1", vec![crop.clone(), viewport.clone()])
            .unwrap();

        assert_eq!(promoted.len(), 2);
        assert!(!PathBuf::from(&crop).exists());
        assert!(!PathBuf::from(&viewport).exists());
        for file in &promoted {
            let dest = PathBuf::from(&file.to);
            assert!(dest.is_file());
            assert!(dest.starts_with(&root));
            assert!(!dest.starts_with(&desktop));
            assert_eq!(file.from.is_empty(), false);
        }
        assert_eq!(desktop.read_dir().unwrap().count(), 0);

        store.delete_owner("conversation-1").unwrap();
        assert!(!PathBuf::from(&promoted[0].to).exists());
    }

    #[test]
    fn cleanup_owners_keeps_active_conversations_and_drops_orphans() {
        let (_directory, store) = store();
        let active = store.owner_dir("active").unwrap();
        let orphan = store.owner_dir("orphan").unwrap();
        std::fs::create_dir_all(&active).unwrap();
        std::fs::create_dir_all(&orphan).unwrap();
        std::fs::write(active.join("keep.png"), b"png").unwrap();
        std::fs::write(orphan.join("remove.png"), b"png").unwrap();

        store.cleanup_owners(vec!["active".into()]).unwrap();

        assert!(active.join("keep.png").exists());
        assert!(!orphan.exists());
    }

    #[test]
    fn promoted_file_serializes_from_and_to_like_ios() {
        let json = serde_json::to_string(&PromotedAndroidCaptureFile {
            from: "/tmp/a.png".into(),
            to: "/data/b.png".into(),
        })
        .unwrap();
        assert_eq!(json, r#"{"from":"/tmp/a.png","to":"/data/b.png"}"#);
    }

    #[test]
    fn production_store_uses_system_temp_and_app_data_without_hardcoded_user_paths() {
        let source = include_str!("capture_store.rs");
        assert!(source.contains("std::env::temp_dir().join(\"verboo-android-emulator\")"));
        assert!(source.contains("app_data_dir.join(\"android_captures\")"));
        let producer_home = format!("{}{}", "/Users/", "grasel");
        let producer_mail = format!("{}{}", "grase", "eel");
        assert!(!source.contains(&producer_home));
        assert!(!source.contains(&producer_mail));
    }
}
