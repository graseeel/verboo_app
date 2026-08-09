use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use super::store::{CliRuntimeLease, CliStore};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedCliRuntime {
    pub node_path: PathBuf,
    pub cli_mjs_path: PathBuf,
    pub version: String,
}

struct RuntimeAuthority {
    store: CliStore,
    node_path: PathBuf,
    // A process-wide lease is deliberately conservative. Every CLI version
    // used during this app session remains immutable until the app exits, so
    // detached auth/PTY children and active turns cannot outlive their bytes.
    leases: HashMap<(String, String), CliRuntimeLease>,
}

static AUTHORITY: OnceLock<Mutex<Option<RuntimeAuthority>>> = OnceLock::new();

fn authority() -> &'static Mutex<Option<RuntimeAuthority>> {
    AUTHORITY.get_or_init(|| Mutex::new(None))
}

pub fn configure(store: CliStore, node_path: PathBuf) -> Result<(), String> {
    if !crate::services::node_runtime::is_executable(&node_path) {
        return Err(format!(
            "embedded Node runtime is not executable at {}",
            node_path.display()
        ));
    }
    let mut authority = authority()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if authority.is_some() {
        return Err("CLI runtime authority is already configured".to_string());
    }
    *authority = Some(RuntimeAuthority {
        store,
        node_path,
        leases: HashMap::new(),
    });
    Ok(())
}

pub fn acquire() -> Result<ResolvedCliRuntime, String> {
    let mut authority = authority()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let authority = authority
        .as_mut()
        .ok_or_else(|| "CLI runtime authority is not configured".to_string())?;
    let pointer = authority
        .store
        .current()?
        .ok_or_else(|| "CLI bootstrap is required".to_string())?;
    let key = (pointer.version.clone(), pointer.manifest_digest.clone());
    if let Some(lease) = authority.leases.get(&key) {
        return Ok(ResolvedCliRuntime {
            node_path: lease.node_path.clone(),
            cli_mjs_path: lease.cli_mjs_path.clone(),
            version: lease.version.clone(),
        });
    }

    let lease = authority
        .store
        .acquire_runtime(authority.node_path.clone())?;
    let resolved = ResolvedCliRuntime {
        node_path: lease.node_path.clone(),
        cli_mjs_path: lease.cli_mjs_path.clone(),
        version: lease.version.clone(),
    };
    authority.leases.insert(key, lease);
    Ok(resolved)
}

pub fn current_version() -> Option<String> {
    authority()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .and_then(|authority| authority.store.current().ok().flatten())
        .map(|pointer| pointer.version)
}

#[cfg(test)]
pub(crate) fn reset() {
    *authority()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::services::cli_update::contract::DesktopTarget;
    use crate::services::cli_update::store::CliPointer;

    #[cfg(unix)]
    fn make_node(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        fs::write(path, b"#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(windows)]
    fn make_node(path: &std::path::Path) {
        fs::write(path, b"MZ").unwrap();
    }

    fn install(store: &CliStore, version: &str, digest: &str) {
        let root = store.version_dir(version).unwrap();
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(root.join("dist/cli.mjs"), b"entry").unwrap();
        store
            .activate(&CliPointer::new(version, DesktopTarget::host().unwrap(), digest).unwrap())
            .unwrap();
    }

    #[test]
    fn process_wide_lease_preserves_every_version_used_in_this_session() {
        let _guard = crate::services::cli_spawn::fake_cli_env::FAKE_CLI_ENV_GUARD
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset();
        let app_data = tempfile::tempdir().unwrap();
        let store = CliStore::open(app_data.path()).unwrap();
        let node = app_data
            .path()
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        make_node(&node);
        install(&store, "0.15.5", &"a".repeat(64));
        configure(store.clone(), node).unwrap();
        let first = acquire().unwrap();
        install(&store, "0.15.6", &"b".repeat(64));
        let second = acquire().unwrap();
        install(&store, "0.15.7", &"c".repeat(64));
        store.garbage_collect().unwrap();

        assert_eq!(first.version, "0.15.5");
        assert_eq!(second.version, "0.15.6");
        assert!(store.version_dir("0.15.5").unwrap().exists());
        assert!(store.version_dir("0.15.6").unwrap().exists());
        reset();
    }
}
