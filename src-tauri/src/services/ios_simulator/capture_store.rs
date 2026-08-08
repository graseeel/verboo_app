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
pub struct PromotedSimulatorFile {
    pub from: String,
    pub to: String,
}

/// Owns the temporary and conversation-durable files produced from simulator
/// frames. The allowlist is deliberately independent from browser captures.
#[derive(Clone)]
pub struct IosSimulatorCaptureStore {
    temp_root: PathBuf,
    root: PathBuf,
}

impl IosSimulatorCaptureStore {
    #[cfg(test)]
    pub(crate) fn for_test(temp_root: PathBuf, root: PathBuf) -> Self {
        std::fs::create_dir_all(&temp_root).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        Self { temp_root, root }
    }

    pub fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        let store = Self {
            temp_root: std::env::temp_dir().join("verboo-ios-simulator"),
            root: app_data_dir.join("simulator_captures"),
        };
        std::fs::create_dir_all(&store.temp_root)
            .map_err(|error| format!("create simulator temp store falhou: {error}"))?;
        std::fs::create_dir_all(&store.root)
            .map_err(|error| format!("create simulator capture store falhou: {error}"))?;
        store.cleanup_temp_root()?;
        Ok(store)
    }

    pub fn write_capture(
        &self,
        bytes: &[u8],
        rect: NormalizedCaptureRect,
    ) -> Result<CaptureWriteReport, String> {
        let image = image::load_from_memory(bytes)
            .map_err(|error| format!("captura do simulador inválida: {error}"))?;
        let (viewport_width, viewport_height) = image.dimensions();
        if viewport_width == 0 || viewport_height == 0 {
            return Err("A captura do simulador está vazia.".into());
        }
        let (left, top, crop_width, crop_height) =
            pixel_crop(rect, viewport_width, viewport_height)?;
        let crop = image.crop_imm(left, top, crop_width, crop_height);
        let viewport_png = encode_png(&image)?;
        let crop_png = encode_png(&crop)?;

        std::fs::create_dir_all(&self.temp_root)
            .map_err(|error| format!("create simulator temp store falhou: {error}"))?;
        let stem = Uuid::new_v4().to_string();
        let crop_path = self.temp_root.join(format!("{stem}-crop.png"));
        let viewport_path = self.temp_root.join(format!("{stem}-viewport.png"));
        std::fs::write(&viewport_path, &viewport_png)
            .map_err(|error| format!("write simulator viewport falhou: {error}"))?;
        if let Err(error) = std::fs::write(&crop_path, &crop_png) {
            let _ = std::fs::remove_file(&viewport_path);
            return Err(format!("write simulator crop falhou: {error}"));
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
                "arquivo temporário fora do diretório do simulador: {}",
                path.display()
            ));
        }
        for path in paths {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "remove simulator temp falhou para {}: {error}",
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
    ) -> Result<Vec<PromotedSimulatorFile>, String> {
        let owner_dir = self.owner_dir(owner_id)?;
        let sources = paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
        if let Some(path) = sources
            .iter()
            .find(|path| !self.is_temp_png(path) || !path.is_file())
        {
            return Err(format!("captura temporária inválida: {}", path.display()));
        }
        std::fs::create_dir_all(&owner_dir)
            .map_err(|error| format!("create simulator capture owner falhou: {error}"))?;

        let mut promoted: Vec<PromotedSimulatorFile> = Vec::with_capacity(sources.len());
        for source in &sources {
            let destination = owner_dir.join(format!("{}.png", Uuid::new_v4()));
            if let Err(error) = std::fs::copy(source, &destination) {
                for copied in &promoted {
                    let _ = std::fs::remove_file(&copied.to);
                }
                return Err(format!("promote simulator capture falhou: {error}"));
            }
            promoted.push(PromotedSimulatorFile {
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
            Err(error) => Err(format!("delete simulator capture owner falhou: {error}")),
        }
    }

    pub fn cleanup_owners(&self, active_owner_ids: Vec<String>) -> Result<(), String> {
        let active = active_owner_ids
            .iter()
            .map(|owner| self.owner_dir(owner))
            .collect::<Result<HashSet<_>, _>>()?;
        for entry in std::fs::read_dir(&self.root)
            .map_err(|error| format!("read simulator capture store falhou: {error}"))?
        {
            let entry =
                entry.map_err(|error| format!("read simulator capture owner falhou: {error}"))?;
            let path = entry.path();
            if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
                && !active.contains(&path)
            {
                std::fs::remove_dir_all(&path)
                    .map_err(|error| format!("cleanup simulator capture owner falhou: {error}"))?;
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

    fn is_temp_png(&self, path: &Path) -> bool {
        path.parent() == Some(self.temp_root.as_path())
            && path.extension().and_then(|extension| extension.to_str()) == Some("png")
    }

    fn cleanup_temp_root(&self) -> Result<(), String> {
        let entries = match std::fs::read_dir(&self.temp_root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("read simulator temp store falhou: {error}")),
        };
        for entry in entries {
            let entry = entry.map_err(|error| format!("read simulator temp falhou: {error}"))?;
            let path = entry.path();
            if self.is_temp_png(&path)
                && entry
                    .file_type()
                    .map(|kind| kind.is_file())
                    .unwrap_or(false)
            {
                std::fs::remove_file(&path)
                    .map_err(|error| format!("cleanup simulator temp falhou: {error}"))?;
            }
        }
        Ok(())
    }
}

fn encode_png(image: &DynamicImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .map_err(|error| format!("encode simulator capture falhou: {error}"))?;
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
        return Err("A área selecionada está fora do simulador.".into());
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
    use image::{ImageBuffer, Rgba};

    fn png(width: u32, height: u32) -> Vec<u8> {
        let image = DynamicImage::ImageRgba8(ImageBuffer::from_pixel(
            width,
            height,
            Rgba([90, 40, 180, 255]),
        ));
        encode_png(&image).unwrap()
    }

    fn store() -> (tempfile::TempDir, IosSimulatorCaptureStore) {
        let directory = tempfile::tempdir().unwrap();
        let temp_root = directory.path().join("temp");
        let root = directory.path().join("durable");
        std::fs::create_dir_all(&temp_root).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        let store = IosSimulatorCaptureStore { temp_root, root };
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
        assert!(store
            .delete_temp_files(vec!["/tmp/not-verboo/file.png".into()])
            .is_err());
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
}
