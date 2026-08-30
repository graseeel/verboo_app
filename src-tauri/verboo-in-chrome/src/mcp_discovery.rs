//! Shared discovery-root hardening for the iOS and Android MCP sidecars.
//!
//! Both helpers must behave identically: a relative or `..` override is
//! rejected, and any directory the client touches is forced to `0o700` on
//! Unix (same contract as the desktop bridges' `secure_directory`).
//!
//! `VERBOO_ANDROID_EMULATOR_DISCOVERY_DIR` / `VERBOO_IOS_SIMULATOR_DISCOVERY_DIR`
//! are trusted-process overrides (tests/dev). A process that can inject those
//! env vars can still point the helper at another absolute directory; this
//! module only rejects empty, relative, and `..` values, then tightens perms
//! on the directory if it already exists. It does not create the override path.

use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

pub fn parse_override_root(raw: OsString) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err("discovery dir override must be a non-empty absolute path".into());
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("discovery dir override must be an absolute path".into());
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("discovery dir override must not contain '..'".into());
    }
    Ok(path)
}

pub fn ensure_private_root(root: &Path) -> std::io::Result<()> {
    if !root.exists() {
        return Ok(());
    }
    if !root.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "discovery root exists and is not a directory",
        ));
    }
    #[cfg(unix)]
    fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

pub fn create_private_root(root: &Path) -> std::io::Result<()> {
    fs::create_dir_all(root)?;
    #[cfg(unix)]
    fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_must_be_a_non_empty_absolute_path_without_parent_dir() {
        assert!(parse_override_root(OsString::from("")).is_err());
        assert!(parse_override_root(OsString::from("relative/cache")).is_err());
        assert!(parse_override_root(OsString::from("/tmp/../evil")).is_err());
        let parsed = parse_override_root(OsString::from("/tmp/verboo-mcp-discovery")).unwrap();
        assert_eq!(parsed, PathBuf::from("/tmp/verboo-mcp-discovery"));
        assert!(
            !parse_override_root(OsString::from("/tmp/../evil"))
                .unwrap_err()
                .contains("not implemented"),
            "rejection must name the validation rule, not the stub"
        );
    }

    #[cfg(unix)]
    #[test]
    fn create_private_root_forces_owner_only_permissions() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path().join("discovery");
        create_private_root(&root).unwrap();
        assert_eq!(root.metadata().unwrap().permissions().mode() & 0o777, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn ensure_private_root_tightens_an_existing_world_readable_directory() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path().join("discovery");
        fs::create_dir_all(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        ensure_private_root(&root).unwrap();
        assert_eq!(root.metadata().unwrap().permissions().mode() & 0o777, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn ensure_private_root_does_not_create_a_missing_directory() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path().join("missing");
        ensure_private_root(&root).unwrap();
        assert!(!root.exists());
    }

    #[test]
    fn ensure_private_root_rejects_a_file() {
        let temp = tempfile::TempDir::new().unwrap();
        let file = temp.path().join("not-a-dir");
        fs::write(&file, b"x").unwrap();
        let error = ensure_private_root(&file).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    }
}
