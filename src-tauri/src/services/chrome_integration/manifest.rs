use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::paths::{windows_registry_key, edge_registry_key, IntegrationPlatform};

const HOST_NAME: &str = "com.verboo.code.browser_extension";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct NativeManifest {
    name: String,
    description: String,
    path: String,
    #[serde(rename = "type")]
    transport_type: String,
    allowed_origins: Vec<String>,
}

pub fn valid_extension_id(extension_id: &str) -> bool {
    extension_id.len() == 32
        && extension_id
            .bytes()
            .all(|byte| (b'a'..=b'p').contains(&byte))
}

pub fn write_native_manifest(
    manifest_path: &Path,
    helper_path: &Path,
    extension_id: &str,
) -> Result<(), String> {
    if !helper_path.is_absolute() {
        return Err("chrome_helper_path_not_absolute".into());
    }
    if !valid_extension_id(extension_id) {
        return Err("chrome_extension_id_invalid".into());
    }
    let manifest = NativeManifest {
        name: HOST_NAME.into(),
        description: "Verboo in Chrome MCP bridge".into(),
        path: helper_path.to_string_lossy().into_owned(),
        transport_type: "stdio".into(),
        allowed_origins: vec![format!("chrome-extension://{extension_id}/")],
    };
    atomic_write(
        manifest_path,
        &serde_json::to_vec_pretty(&manifest).map_err(to_string)?,
    )
}

pub fn manifest_is_managed(manifest_path: &Path, helper_path: &Path, extension_id: &str) -> bool {
    let Ok(bytes) = fs::read(manifest_path) else {
        return false;
    };
    let Ok(manifest) = serde_json::from_slice::<NativeManifest>(&bytes) else {
        return false;
    };
    manifest.name == HOST_NAME
        && manifest.transport_type == "stdio"
        && manifest.path == helper_path.to_string_lossy()
        && manifest.allowed_origins == [format!("chrome-extension://{extension_id}/")]
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("chrome_path_parent_missing")?;
    fs::create_dir_all(parent).map_err(to_string)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("verboo"),
        Uuid::new_v4().simple()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(to_string)?;
        file.write_all(bytes).map_err(to_string)?;
        file.sync_all().map_err(to_string)?;
        replace_file(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn register_manifest(
    platform: IntegrationPlatform,
    manifest_path: &Path,
) -> Result<(), String> {
    #[cfg(windows)]
    if platform == IntegrationPlatform::Windows {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let current_user = RegKey::predef(HKEY_CURRENT_USER);

        // Register for both Chrome and Edge
        for registry_key in [windows_registry_key(), edge_registry_key()] {
            if let Ok(existing) = current_user.open_subkey(registry_key) {
                let registered: String = existing.get_value("").map_err(to_string)?;
                if Path::new(&registered) != manifest_path {
                    return Err("chrome_registry_conflict".into());
                }
                continue;
            }
            let (key, _) = current_user
                .create_subkey(registry_key)
                .map_err(to_string)?;
            key.set_value("", &manifest_path.to_string_lossy().as_ref())
                .map_err(to_string)?;
        }
    }
    #[cfg(not(windows))]
    let _ = (platform, manifest_path, windows_registry_key());
    Ok(())
}

pub fn manifest_registration_is_managed(
    platform: IntegrationPlatform,
    manifest_path: &Path,
) -> Result<bool, String> {
    #[cfg(windows)]
    if platform == IntegrationPlatform::Windows {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let current_user = RegKey::predef(HKEY_CURRENT_USER);
        // Check both Chrome and Edge registries
        for registry_key in [windows_registry_key(), edge_registry_key()] {
            if let Ok(key) = current_user.open_subkey(registry_key) {
                let registered: String = key.get_value("").map_err(to_string)?;
                if Path::new(&registered) == manifest_path {
                    return Ok(true);
                }
            }
        }
        return Ok(false);
    }
    #[cfg(not(windows))]
    let _ = (platform, manifest_path, windows_registry_key());
    Ok(true)
}

pub fn unregister_manifest(
    platform: IntegrationPlatform,
    manifest_path: &Path,
) -> Result<(), String> {
    #[cfg(windows)]
    if platform == IntegrationPlatform::Windows {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let current_user = RegKey::predef(HKEY_CURRENT_USER);
        // Unregister from both Chrome and Edge
        for registry_key in [windows_registry_key(), edge_registry_key()] {
            let key = match current_user.open_subkey(registry_key) {
                Ok(key) => key,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.to_string()),
            };
            let registered: String = key.get_value("").map_err(to_string)?;
            if Path::new(&registered) != manifest_path {
                return Err("chrome_registry_conflict".into());
            }
            drop(key);
            match current_user.delete_subkey(registry_key) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
    }
    #[cfg(not(windows))]
    let _ = (platform, manifest_path, windows_registry_key());
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(to_string)
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}
