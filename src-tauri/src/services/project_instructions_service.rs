use serde::{Deserialize, Serialize};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

pub const MAX_PROJECT_INSTRUCTION_BYTES: usize = 512 * 1024;
const ALLOWED_FILES: [&str; 2] = ["AGENTS.md", "CLAUDE.md"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInstructionFile {
    pub name: String,
    pub exists: bool,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInstructionReadResult {
    pub name: String,
    pub content: String,
    pub exists: bool,
}

pub fn list_project_instruction_files(
    working_directory: &str,
) -> Result<Vec<ProjectInstructionFile>, String> {
    let root = validate_working_directory(working_directory)?;

    ALLOWED_FILES
        .iter()
        .map(|name| {
            let path = root.join(name);
            let meta = instruction_file_metadata(&path)?;
            Ok(ProjectInstructionFile {
                name: (*name).to_string(),
                exists: meta.as_ref().is_some_and(|m| m.is_file()),
                size: meta.filter(|m| m.is_file()).map(|m| m.len()),
            })
        })
        .collect()
}

pub fn read_project_instruction_file(
    working_directory: &str,
    name: &str,
) -> Result<ProjectInstructionReadResult, String> {
    let (root, allowed_name) = validate_target(working_directory, name)?;
    let path = root.join(allowed_name);
    let Some(meta) = instruction_file_metadata(&path)? else {
        return Ok(ProjectInstructionReadResult {
            name: allowed_name.to_string(),
            content: String::new(),
            exists: false,
        });
    };

    if !meta.is_file() {
        return Err(format!(
            "project instruction '{allowed_name}' is not a file"
        ));
    }
    if meta.len() > MAX_PROJECT_INSTRUCTION_BYTES as u64 {
        return Err(format!(
            "project instruction '{allowed_name}' exceeds {} bytes",
            MAX_PROJECT_INSTRUCTION_BYTES
        ));
    }

    let bytes = fs::read(&path).map_err(|e| format!("read '{allowed_name}': {e}"))?;
    if bytes.len() > MAX_PROJECT_INSTRUCTION_BYTES {
        return Err(format!(
            "project instruction '{allowed_name}' exceeds {} bytes",
            MAX_PROJECT_INSTRUCTION_BYTES
        ));
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| format!("project instruction '{allowed_name}' must be valid UTF-8 text"))?;

    Ok(ProjectInstructionReadResult {
        name: allowed_name.to_string(),
        content,
        exists: true,
    })
}

pub fn write_project_instruction_file(
    working_directory: &str,
    name: &str,
    content: &str,
) -> Result<(), String> {
    let (root, allowed_name) = validate_target(working_directory, name)?;
    if content.len() > MAX_PROJECT_INSTRUCTION_BYTES {
        return Err(format!(
            "project instruction '{allowed_name}' exceeds {} bytes",
            MAX_PROJECT_INSTRUCTION_BYTES
        ));
    }

    let path = root.join(allowed_name);
    if let Some(meta) = instruction_file_metadata(&path)? {
        if !meta.is_file() {
            return Err(format!(
                "project instruction '{allowed_name}' is not a file"
            ));
        }
    }

    fs::write(&path, content).map_err(|e| format!("write '{allowed_name}': {e}"))
}

fn validate_target(working_directory: &str, name: &str) -> Result<(PathBuf, &'static str), String> {
    let root = validate_working_directory(working_directory)?;
    let allowed_name = validate_instruction_name(name)?;
    Ok((root, allowed_name))
}

fn validate_working_directory(working_directory: &str) -> Result<PathBuf, String> {
    let root = Path::new(working_directory);
    let meta = fs::metadata(root)
        .map_err(|e| format!("invalid working_directory '{working_directory}': {e}"))?;
    if !meta.is_dir() {
        return Err(format!(
            "working_directory '{working_directory}' is not a directory"
        ));
    }
    Ok(root.to_path_buf())
}

fn validate_instruction_name(name: &str) -> Result<&'static str, String> {
    let allowed_name = ALLOWED_FILES
        .iter()
        .copied()
        .find(|candidate| *candidate == name)
        .ok_or_else(|| format!("unsupported project instruction file '{name}'"))?;

    let path = Path::new(name);
    if path.is_absolute()
        || path.file_name().and_then(|file_name| file_name.to_str()) != Some(allowed_name)
        || path.components().count() != 1
    {
        return Err(format!("invalid project instruction file name '{name}'"));
    }

    Ok(allowed_name)
}

fn instruction_file_metadata(path: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "project instruction '{}' must not be a symlink",
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("<unknown>")
                ));
            }
            Ok(Some(meta))
        }
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("stat '{}': {e}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn rejects_names_outside_allowlist() {
        let tmp = TempDir::new().unwrap();

        for name in [
            "README.md",
            "agents.md",
            "AGENTS.md.bak",
            "nested/AGENTS.md",
            "nested\\AGENTS.md",
            "../AGENTS.md",
            "/AGENTS.md",
        ] {
            let result = read_project_instruction_file(tmp.path().to_str().unwrap(), name);
            assert!(result.is_err(), "{name} must be rejected");
        }
    }

    #[test]
    fn write_and_read_roundtrip_for_allowed_file() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_str().unwrap();

        write_project_instruction_file(root, "AGENTS.md", "# Agents\n\nUse Rust.").unwrap();
        let read = read_project_instruction_file(root, "AGENTS.md").unwrap();

        assert_eq!(read.name, "AGENTS.md");
        assert!(read.exists);
        assert_eq!(read.content, "# Agents\n\nUse Rust.");

        let files = list_project_instruction_files(root).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].name, "AGENTS.md");
        assert!(files[0].exists);
        assert_eq!(files[0].size, Some("# Agents\n\nUse Rust.".len() as u64));
        assert_eq!(files[1].name, "CLAUDE.md");
        assert!(!files[1].exists);
        assert_eq!(files[1].size, None);
    }

    #[test]
    fn missing_file_reads_as_empty_nonexistent() {
        let tmp = TempDir::new().unwrap();

        let read =
            read_project_instruction_file(tmp.path().to_str().unwrap(), "CLAUDE.md").unwrap();

        assert_eq!(read.name, "CLAUDE.md");
        assert!(!read.exists);
        assert_eq!(read.content, "");
    }

    #[test]
    fn traversal_attempt_does_not_write_outside_workspace() {
        let parent = TempDir::new().unwrap();
        let workspace = parent.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let outside = parent.path().join("AGENTS.md");

        let result =
            write_project_instruction_file(workspace.to_str().unwrap(), "../AGENTS.md", "escaped");

        assert!(result.is_err());
        assert!(!outside.exists());
    }

    #[test]
    fn rejects_oversized_content() {
        let tmp = TempDir::new().unwrap();
        let content = "x".repeat(MAX_PROJECT_INSTRUCTION_BYTES + 1);

        let result =
            write_project_instruction_file(tmp.path().to_str().unwrap(), "CLAUDE.md", &content);

        assert!(result.is_err());
    }
}
