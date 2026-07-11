// Lists files in a workspace for `@`-mention autocomplete.
//
// Strategy:
//   1. If `working_directory` is inside a git repo, run
//      `git ls-files --cached --others --exclude-standard` (NUL-separated).
//      This respects `.gitignore` automatically and matches Electron's
//      behaviour.
//   2. Otherwise, fall back to a bounded directory walk (depth 6,
//      MAX_ENTRIES cap, skipping well-known noisy/build dirs).
//
// All returned paths are RELATIVE to `working_directory`, POSIX-style
// (forward slashes), sorted lexicographically, and capped at MAX_ENTRIES.
//
// Security:
//   - Output is always relative, so the renderer never sees absolute paths
//     outside the workspace.
//   - The walk does not follow symlinks (entry.file_type().is_symlink()
//     short-circuits), preventing escape via crafted symlinks.
//   - `resolve_safe_path`-style input validation is unnecessary here:
//     `working_directory` is the workspace itself, not a user-supplied path
//     inside it; we only check that it exists and is a directory.

use std::fs;
use std::path::{Component, Path};
use std::process::Command;

/// Maximum recursion depth for the non-git fallback walk.
/// Depth 0 = root, depth 6 = 6 levels of subdirectories below root.
pub const MAX_WALK_DEPTH: usize = 6;

/// Hard cap on the number of returned paths. Protects the renderer from
/// unbounded payloads on huge workspaces.
pub const MAX_ENTRIES: usize = 5000;

/// Directories always skipped during the fallback walk (matched by name,
/// at any depth). Mirrors the `.gitignore`-style exclusions that `git
/// ls-files` would have applied automatically in a git repo.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "dist-renderer",
    "release",
];

/// Arguments for the NUL-separated `git ls-files` invocation.
const GIT_LS_FILES_ARGS: &[&str] = &[
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
];

/// Lists files in `working_directory`.
///
/// Returns paths relative to `working_directory`, sorted lexicographically,
/// capped at `MAX_ENTRIES`. Returns `Err` only when `working_directory`
/// does not exist or is not a directory.
pub fn list_workspace_files(working_directory: &str) -> Result<Vec<String>, String> {
    let root = Path::new(working_directory);
    let meta = fs::metadata(root)
        .map_err(|e| format!("invalid working_directory '{working_directory}': {e}"))?;
    if !meta.is_dir() {
        return Err(format!(
            "working_directory '{working_directory}' is not a directory"
        ));
    }

    if let Some(paths) = try_git_ls_files(root) {
        return Ok(truncate_and_sort(paths));
    }

    Ok(fallback_walk(root))
}

/// Attempts to enumerate files via `git ls-files`. Returns `None` when
/// `working_directory` is not inside a git repo (or `git` is unavailable).
///
/// `git -C <working_directory> ls-files` returns paths relative to that
/// working directory, even when it is a subdirectory of the repo. Treat each
/// entry as already relative to `root` and defensively filter absolute paths
/// or parent-directory escapes before returning them to the renderer.
fn try_git_ls_files(root: &Path) -> Option<Vec<String>> {
    // Detect git repo membership first; the toplevel path is intentionally
    // not used for mapping because `git ls-files` below is cwd-relative.
    let inside_output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--is-inside-work-tree"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .ok()?;
    if !inside_output.status.success() {
        return None;
    }
    let inside_trimmed = String::from_utf8_lossy(&inside_output.stdout)
        .trim()
        .to_string();
    if inside_trimmed != "true" {
        return None;
    }

    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(GIT_LS_FILES_ARGS)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let paths: Vec<String> = stdout
        .split('\0')
        .filter(|p| !p.is_empty())
        .filter(|p| is_safe_relative_git_path(p))
        .map(|p| p.replace('\\', "/"))
        .collect();
    Some(paths)
}

fn is_safe_relative_git_path(path: &str) -> bool {
    let path = Path::new(path);
    !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

/// Bounded directory walk for non-git workspaces.
fn fallback_walk(root: &Path) -> Vec<String> {
    walk_with_cap(root, MAX_ENTRIES)
}

/// Internal walk helper. Exposed for tests so we can exercise the cap
/// behaviour with small fixtures.
fn walk_with_cap(root: &Path, max_entries: usize) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    walk_recursive(root, root, 0, max_entries, &mut paths);
    paths.sort();
    paths.truncate(max_entries);
    paths
}

fn walk_recursive(
    root: &Path,
    dir: &Path,
    depth: usize,
    max_entries: usize,
    out: &mut Vec<String>,
) {
    if depth > MAX_WALK_DEPTH {
        return;
    }
    if out.len() >= max_entries {
        return;
    }

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // permission denied, vanished, etc. — skip silently
    };

    for entry in entries.flatten() {
        if out.len() >= max_entries {
            return;
        }

        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };

        // Never follow symlinks — defends against escape via crafted links.
        if file_type.is_symlink() {
            continue;
        }

        let file_name = entry.file_name();
        let name_str = match file_name.to_str() {
            Some(s) => s,
            None => continue,
        };

        // Skip well-known noisy/build dirs at any depth.
        if file_type.is_dir() && SKIP_DIRS.contains(&name_str) {
            continue;
        }

        let entry_path = entry.path();
        let rel = match entry_path.strip_prefix(root) {
            Ok(p) => p,
            Err(_) => continue,
        };

        if file_type.is_dir() {
            walk_recursive(root, &entry_path, depth + 1, max_entries, out);
        } else if file_type.is_file() {
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            out.push(rel_str);
        }
        // Other file kinds (FIFOs, sockets, block devices): skipped.
    }
}

fn truncate_and_sort(mut paths: Vec<String>) -> Vec<String> {
    paths.sort();
    paths.truncate(MAX_ENTRIES);
    paths
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Helper: create an empty file at `<dir>/<rel>`, mkdir-p as needed.
    fn touch(dir: &Path, rel: &str) {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&p, b"").unwrap();
    }

    #[test]
    fn list_workspace_files_rejects_nonexistent_path() {
        let result = list_workspace_files("/this/path/should/never/exist/xyz_42");
        assert!(result.is_err(), "expected Err for nonexistent path");
    }

    #[test]
    fn list_workspace_files_rejects_file_not_dir() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("not_a_dir.txt");
        fs::write(&f, b"hello").unwrap();
        let result = list_workspace_files(f.to_str().unwrap());
        assert!(result.is_err(), "expected Err when input is a file");
    }

    #[test]
    fn list_workspace_files_empty_dir_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let result = list_workspace_files(tmp.path().to_str().unwrap()).unwrap();
        assert!(result.is_empty(), "empty dir must yield no paths");
    }

    #[test]
    fn walk_with_cap_returns_files_recursively_sorted() {
        let tmp = TempDir::new().unwrap();
        touch(tmp.path(), "a.txt");
        touch(tmp.path(), "src/main.rs");
        touch(tmp.path(), "src/lib/lib.rs");
        touch(tmp.path(), "docs/readme.md");

        let result = walk_with_cap(tmp.path(), MAX_ENTRIES);
        assert_eq!(
            result,
            vec![
                "a.txt".to_string(),
                "docs/readme.md".to_string(),
                "src/lib/lib.rs".to_string(),
                "src/main.rs".to_string(),
            ]
        );
    }

    #[test]
    fn walk_with_cap_skips_excluded_dirs() {
        let tmp = TempDir::new().unwrap();
        // Kept
        touch(tmp.path(), "src/main.rs");
        touch(tmp.path(), "kept.txt");
        // Skipped (under excluded dirs)
        touch(tmp.path(), ".git/HEAD");
        touch(tmp.path(), ".git/refs/heads/main");
        touch(tmp.path(), "node_modules/pkg/index.js");
        touch(tmp.path(), "node_modules/pkg/lib/util.js");
        touch(tmp.path(), "target/debug/app");
        touch(tmp.path(), "dist/bundle.js");
        touch(tmp.path(), "dist-renderer/index.html");
        touch(tmp.path(), "release/app.dmg");

        let result = walk_with_cap(tmp.path(), MAX_ENTRIES);
        assert_eq!(
            result,
            vec!["kept.txt".to_string(), "src/main.rs".to_string()],
            "excluded dirs and their contents must not appear: {result:?}"
        );
    }

    #[test]
    fn walk_with_cap_respects_depth_limit() {
        let tmp = TempDir::new().unwrap();
        // Depth 6 = 6 levels of subdirs below root, file at the 6th level.
        touch(tmp.path(), "a/b/c/d/e/f/depth_6.txt");
        // Depth 7 must NOT be reachable.
        touch(tmp.path(), "a/b/c/d/e/f/g/depth_7.txt");
        touch(tmp.path(), "a/b/c/d/e/f/g/h/depth_8.txt");

        let result = walk_with_cap(tmp.path(), MAX_ENTRIES);
        assert!(
            result.contains(&"a/b/c/d/e/f/depth_6.txt".to_string()),
            "depth 6 must be reachable: {result:?}"
        );
        assert!(
            !result.contains(&"a/b/c/d/e/f/g/depth_7.txt".to_string()),
            "depth 7 must NOT be reachable: {result:?}"
        );
        assert!(
            !result.contains(&"a/b/c/d/e/f/g/h/depth_8.txt".to_string()),
            "depth 8 must NOT be reachable: {result:?}"
        );
    }

    #[test]
    fn walk_with_cap_caps_at_max_entries() {
        let tmp = TempDir::new().unwrap();
        // Create 7 files; cap at 5.
        for i in 0..7 {
            touch(tmp.path(), &format!("file_{i:02}.txt"));
        }

        let result = walk_with_cap(tmp.path(), 5);
        assert_eq!(result.len(), 5, "cap must be respected");
        // Output must be sorted (contract) and free of duplicates.
        assert!(
            result.windows(2).all(|w| w[0] <= w[1]),
            "output must be sorted: {result:?}"
        );
        let unique: std::collections::HashSet<_> = result.iter().collect();
        assert_eq!(unique.len(), result.len(), "no duplicates allowed");
        // Every returned path must be one of the files we created.
        for p in &result {
            assert!(
                p.starts_with("file_") && p.ends_with(".txt"),
                "unexpected path: {p}"
            );
        }
    }

    #[test]
    fn walk_with_cap_handles_files_with_spaces_and_unicode() {
        let tmp = TempDir::new().unwrap();
        touch(tmp.path(), "normal.txt");
        touch(tmp.path(), "with space.txt");
        touch(tmp.path(), "café.txt");

        let result = walk_with_cap(tmp.path(), MAX_ENTRIES);
        assert!(result.contains(&"normal.txt".to_string()));
        assert!(result.contains(&"with space.txt".to_string()));
        assert!(
            result.iter().any(|p| p.contains("café")),
            "unicode filenames must round-trip: {result:?}"
        );
    }

    #[test]
    fn git_ls_files_from_subdir_returns_paths_relative_to_subdir() {
        let git_available = Command::new("git").arg("--version").output().is_ok();
        if !git_available {
            return;
        }

        let tmp = TempDir::new().unwrap();
        let init = Command::new("git")
            .arg("init")
            .arg(tmp.path())
            .output()
            .unwrap();
        if !init.status.success() {
            return;
        }

        fs::write(tmp.path().join(".gitignore"), "*.log\n").unwrap();
        touch(tmp.path(), "root.txt");
        touch(tmp.path(), "src-tauri/src/other.rs");
        touch(tmp.path(), "src-tauri/src/services/auth_token.rs");
        touch(
            tmp.path(),
            "src-tauri/src/services/workspace_files_service.rs",
        );
        touch(tmp.path(), "src-tauri/src/services/ignored.log");

        let subdir = tmp.path().join("src-tauri/src/services");
        let result = list_workspace_files(subdir.to_str().unwrap()).unwrap();

        assert!(
            result.contains(&"auth_token.rs".to_string()),
            "git paths must be relative to the requested subdir: {result:?}"
        );
        assert!(
            result.contains(&"workspace_files_service.rs".to_string()),
            "git paths must include files in the requested subdir: {result:?}"
        );
        assert!(
            !result.contains(&"src-tauri/src/services/auth_token.rs".to_string()),
            "subdir results must not be repo-root-relative: {result:?}"
        );
        assert!(
            !result.contains(&"root.txt".to_string())
                && !result.contains(&"../root.txt".to_string()),
            "subdir results must not include files outside the requested root: {result:?}"
        );
        assert!(
            !result.contains(&"ignored.log".to_string()),
            "git path must respect .gitignore: {result:?}"
        );
        assert!(
            result
                .iter()
                .all(|p| !Path::new(p).is_absolute() && !p.split('/').any(|part| part == "..")),
            "all returned paths must be safe relative paths: {result:?}"
        );
    }

    #[test]
    fn walk_with_cap_skips_symlinks_defensively() {
        // macOS / Linux only — symlinks aren't a concept on Windows.
        #[cfg(unix)]
        {
            let tmp = TempDir::new().unwrap();
            touch(tmp.path(), "real.txt");
            let link_path = tmp.path().join("link.txt");
            std::os::unix::fs::symlink(tmp.path().join("real.txt"), &link_path).unwrap();

            let result = walk_with_cap(tmp.path(), MAX_ENTRIES);
            assert_eq!(
                result,
                vec!["real.txt".to_string()],
                "symlinks must not appear (nor be followed): {result:?}"
            );
        }
    }
}
