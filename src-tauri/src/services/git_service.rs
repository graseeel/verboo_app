use std::path::{Path, PathBuf};
use std::process::Command;

use crate::models::types::{
    DiffLineKind, FileDiff, FileDiffHunk, FileDiffLine, FileDiffStatus, WorkspaceBranch,
    WorkspaceBranchInfo, WorkspaceBranchSwitchResult, WorkspaceChangeEntry, WorkspaceChangeSummary,
    WorkspaceCommitResult, WorkspacePullRequestResult, WorkspaceReviewCapabilities,
    WorkspaceReviewMetadata, WorkspaceReviewScope,
};

const MAX_UNTRACKED_FILE_BYTES: u64 = 1_000_000;
const MAX_DIFF_BYTES: usize = 1_500_000;
const MAX_DIFF_LINES: usize = 5_000;
const MAX_COMMIT_MESSAGE_BYTES: usize = 4_096;
const MAX_PR_TITLE_BYTES: usize = 4_096;
const MAX_PR_BODY_BYTES: usize = 64 * 1024;
const MAX_ERROR_BYTES: usize = 4_096;

/// Result of running a git command.
struct GitResult {
    ok: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Runs `git -C <cwd> <args>` and captures stdout/stderr.
fn run_git(cwd: &Path, args: &[&str]) -> GitResult {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output();
    match output {
        Ok(out) => GitResult {
            ok: out.status.success(),
            code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
        },
        Err(e) => GitResult {
            ok: false,
            code: None,
            stdout: String::new(),
            stderr: format!("git exec failed: {e}"),
        },
    }
}

/// Resolves the repository root for a working directory.
/// Returns None if the path is not inside a git repository.
fn resolve_repo_root(working_directory: &str) -> Option<PathBuf> {
    let path = PathBuf::from(working_directory);
    let result = run_git(&path, &["rev-parse", "--show-toplevel"]);
    if !result.ok {
        return None;
    }
    let trimmed = result.stdout.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

/// Resolves a path relative to the repo root, ensuring it stays inside the
/// repo (no `..` escapes). Mirrors Electron's `resolveSafePath`
/// (`fileReviewService.ts:17-22`) which uses Node's `resolve()` to normalize
/// `..` segments before checking the prefix.
///
/// `Path::join` + `strip_prefix` are purely lexical — they do NOT normalize
/// `..` — so `sub/../../escape` would pass a lexical check. We canonicalize
/// the joined target (following symlinks and resolving `..`) before the
/// prefix check. If the target does not yet exist (e.g., a new file in a
/// diff), we canonicalize the parent and re-append the file name.
fn resolve_safe_path(root: &Path, file_path: &str) -> Option<PathBuf> {
    // Reject absolute paths outright — they are never relative to the repo.
    if Path::new(file_path).is_absolute() {
        return None;
    }
    // Reject any `..` component verbatim, matching Electron's defensive check.
    for comp in Path::new(file_path).components() {
        if comp == std::path::Component::ParentDir {
            return None;
        }
    }
    let joined = root.join(file_path);
    // Canonicalize both sides so the prefix check is against normalized paths.
    // Symlinks and `..` segments are resolved by the OS.
    let root_canon = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let target_canon = match std::fs::canonicalize(&joined) {
        Ok(p) => p,
        // Target may not exist yet (new file in diff). Canonicalize the parent
        // and re-append the file name.
        Err(_) => {
            let parent = joined.parent()?;
            let fname = joined.file_name()?;
            let parent_canon = std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
            parent_canon.join(fname)
        }
    };
    if !target_canon.starts_with(&root_canon) {
        return None;
    }
    Some(target_canon)
}

/// Public wrapper around `resolve_safe_path` for use by `open_external_file`
/// in `lib.rs`. Validates that `file_path` (relative to `working_directory`)
/// stays inside the workspace before the caller opens it in the OS default
/// application.
pub fn resolve_safe_path_public(root: &Path, file_path: &str) -> Option<PathBuf> {
    resolve_safe_path(root, file_path)
}

// ════════════════════════════════════════════════════════════════════
// Workspace changes (numstat + untracked)
// ════════════════════════════════════════════════════════════════════

/// Reads the workspace change summary for a working directory.
/// Mirrors Electron's `readWorkspaceChangeSummary`.
pub fn read_workspace_change_summary(working_directory: &str) -> WorkspaceChangeSummary {
    let Some(root) = resolve_repo_root(working_directory) else {
        return empty_summary();
    };

    let mut entries: std::collections::HashMap<String, WorkspaceChangeEntry> =
        std::collections::HashMap::new();

    add_numstat_entries(&root, &["diff", "--numstat", "--"], &mut entries);
    add_numstat_entries(
        &root,
        &["diff", "--cached", "--numstat", "--"],
        &mut entries,
    );
    add_untracked_entries(&root, &mut entries);

    let mut files: Vec<WorkspaceChangeEntry> = entries.into_values().collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    summarize_entries(files)
}

fn add_numstat_entries(
    root: &Path,
    args: &[&str],
    entries: &mut std::collections::HashMap<String, WorkspaceChangeEntry>,
) {
    let result = run_git(root, args);
    if !result.ok {
        return;
    }
    for raw_line in result.stdout.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let raw_additions = parts.next().unwrap_or("");
        let raw_deletions = parts.next().unwrap_or("");
        let path = parts.next().unwrap_or("").trim();
        if path.is_empty() {
            continue;
        }
        let additions = parse_numstat_value(raw_additions);
        let deletions = parse_numstat_value(raw_deletions);
        let existing = entries.get(path).cloned();
        let status = if deletions > 0 && additions == 0 {
            Some("deleted".to_string())
        } else {
            existing.as_ref().and_then(|e| e.status.clone())
        };
        entries.insert(
            path.to_string(),
            WorkspaceChangeEntry {
                path: path.to_string(),
                additions: existing.as_ref().map(|e| e.additions).unwrap_or(0) + additions,
                deletions: existing.as_ref().map(|e| e.deletions).unwrap_or(0) + deletions,
                status,
            },
        );
    }
}

fn add_untracked_entries(
    root: &Path,
    entries: &mut std::collections::HashMap<String, WorkspaceChangeEntry>,
) {
    let result = run_git(
        root,
        &["status", "--porcelain=v1", "--untracked-files=normal"],
    );
    if !result.ok {
        return;
    }
    for raw_line in result.stdout.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        // Porcelain format: "XY path" where XY is 2 status chars
        if line.len() < 3 {
            continue;
        }
        let status_chars = &line[..2];
        let path = line[3..].trim();
        if path.is_empty() {
            continue;
        }
        // Only add untracked entries that aren't already in the map
        if status_chars.starts_with("??") && !entries.contains_key(path) {
            let line_count = count_untracked_lines(&root.join(path));
            entries.insert(
                path.to_string(),
                WorkspaceChangeEntry {
                    path: path.to_string(),
                    additions: line_count,
                    deletions: 0,
                    status: Some("untracked".to_string()),
                },
            );
        }
    }
}

fn parse_numstat_value(raw: &str) -> u32 {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "-" {
        return 0;
    }
    trimmed.parse().unwrap_or(0)
}

fn count_untracked_lines(path: &Path) -> u32 {
    let Ok(meta) = std::fs::metadata(path) else {
        return 0;
    };
    if !meta.is_file() || meta.len() > MAX_UNTRACKED_FILE_BYTES {
        return 0;
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return 0;
    };
    if text.contains('\0') {
        return 0;
    }
    let normalized = if text.ends_with('\n') {
        &text[..text.len() - 1]
    } else {
        &text
    };
    if normalized.is_empty() {
        0
    } else {
        normalized.lines().count() as u32
    }
}

fn summarize_entries(files: Vec<WorkspaceChangeEntry>) -> WorkspaceChangeSummary {
    let total_files = files.len() as u32;
    let additions: u32 = files.iter().map(|e| e.additions).sum();
    let deletions: u32 = files.iter().map(|e| e.deletions).sum();
    WorkspaceChangeSummary {
        files,
        total_files,
        additions,
        deletions,
    }
}

fn empty_summary() -> WorkspaceChangeSummary {
    WorkspaceChangeSummary {
        files: Vec::new(),
        total_files: 0,
        additions: 0,
        deletions: 0,
    }
}

// ════════════════════════════════════════════════════════════════════
// Workspace review metadata
// ════════════════════════════════════════════════════════════════════

/// Reads metadata for the workspace review panel.
/// Mirrors Electron's `readWorkspaceReviewMetadata`.
pub fn read_workspace_review_metadata(working_directory: &str) -> WorkspaceReviewMetadata {
    let Some(root) = resolve_repo_root(working_directory) else {
        return WorkspaceReviewMetadata {
            scope: WorkspaceReviewScope::LocalFolder,
            title: "Arquivos com mudanças".into(),
            subtitle: "Sem repositório Git".into(),
            is_git_repository: false,
            is_github_repository: false,
            repository_root: None,
            current_branch: None,
            upstream_branch: None,
            capabilities: WorkspaceReviewCapabilities {
                can_diff: false,
                can_revert: false,
                can_open_external: true,
                can_commit: false,
                can_create_pr: false,
            },
        };
    };

    let repository_root = root.to_string_lossy().to_string();
    let remote_result = run_git(&root, &["remote", "-v"]);
    let is_github = remote_result.ok
        && regex_like_contains_github(&remote_result.stdout);
    let current_branch = read_current_branch(&root);
    let upstream_branch = read_upstream_branch(&root);

    if is_github {
        WorkspaceReviewMetadata {
            scope: WorkspaceReviewScope::GithubRepo,
            title: "Mudanças não commitadas".into(),
            subtitle: "Arquivos diferentes do último commit".into(),
            is_git_repository: true,
            is_github_repository: true,
            repository_root: Some(repository_root),
            current_branch,
            upstream_branch,
            capabilities: WorkspaceReviewCapabilities {
                can_diff: true,
                can_revert: true,
                can_open_external: true,
                can_commit: true,
                can_create_pr: is_gh_available(),
            },
        }
    } else {
        WorkspaceReviewMetadata {
            scope: WorkspaceReviewScope::GitRepo,
            title: "Mudanças no repositório".into(),
            subtitle: "Arquivos diferentes do último commit".into(),
            is_git_repository: true,
            is_github_repository: false,
            repository_root: Some(repository_root),
            current_branch,
            upstream_branch,
            capabilities: WorkspaceReviewCapabilities {
                can_diff: true,
                can_revert: true,
                can_open_external: true,
                can_commit: true,
                can_create_pr: false,
            },
        }
    }
}

fn regex_like_contains_github(remote_output: &str) -> bool {
    // Mirrors /\bgithub\.com[:/]/i — case-insensitive word-boundary match
    // for "github.com" followed by ':' or '/'.
    let lower = remote_output.to_lowercase();
    lower
        .split_whitespace()
        .any(|word| word.contains("github.com:") || word.contains("github.com/"))
}

fn read_current_branch(root: &Path) -> Option<String> {
    let result = run_git(root, &["branch", "--show-current"]);
    if result.ok {
        let trimmed = result.stdout.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let detached = run_git(root, &["rev-parse", "--short", "HEAD"]);
    if detached.ok {
        let trimmed = detached.stdout.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn read_upstream_branch(root: &Path) -> Option<String> {
    let result = run_git(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{u}",
        ],
    );
    if !result.ok {
        return None;
    }
    let trimmed = result.stdout.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn is_gh_available() -> bool {
    Command::new("gh")
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn command_error(stdout: &str, stderr: &str, fallback: &str) -> String {
    let combined = if !stderr.trim().is_empty() {
        stderr.trim()
    } else if !stdout.trim().is_empty() {
        stdout.trim()
    } else {
        fallback
    };
    sanitize_output(combined)
}

fn sanitize_output(value: &str) -> String {
    let without_nul = value.replace('\0', "");
    if without_nul.len() <= MAX_ERROR_BYTES {
        without_nul
    } else {
        let truncated: String = without_nul.chars().take(MAX_ERROR_BYTES).collect();
        format!("{truncated}…")
    }
}

fn validate_limited_text(value: &str, label: &str, max_bytes: usize) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} não pode ficar vazio."));
    }
    if trimmed.contains('\0') {
        return Err(format!("{label} contém caractere inválido."));
    }
    if trimmed.len() > max_bytes {
        return Err(format!("{label} excede {max_bytes} bytes."));
    }
    Ok(trimmed.to_string())
}

fn validate_optional_body(value: Option<&str>) -> Result<String, String> {
    let body = value.unwrap_or("").trim();
    if body.contains('\0') {
        return Err("Corpo do PR contém caractere inválido.".into());
    }
    if body.len() > MAX_PR_BODY_BYTES {
        return Err(format!("Corpo do PR excede {MAX_PR_BODY_BYTES} bytes."));
    }
    Ok(body.to_string())
}

fn clean_result(ok: bool, error: String) -> WorkspaceCommitResult {
    WorkspaceCommitResult {
        ok,
        commit_hash: None,
        error: Some(error),
    }
}

fn pr_result_error(error: String) -> WorkspacePullRequestResult {
    WorkspacePullRequestResult {
        ok: false,
        url: None,
        error: Some(error),
    }
}

// ════════════════════════════════════════════════════════════════════
// Review actions: commit + PR
// ════════════════════════════════════════════════════════════════════

pub fn commit_workspace_changes(working_directory: &str, message: &str) -> WorkspaceCommitResult {
    let Some(root) = resolve_repo_root(working_directory) else {
        return clean_result(false, "Commit exige um repositório Git.".into());
    };
    let message =
        match validate_limited_text(message, "Mensagem do commit", MAX_COMMIT_MESSAGE_BYTES) {
            Ok(message) => message,
            Err(error) => return clean_result(false, error),
        };

    let add = run_git(&root, &["add", "-A"]);
    if !add.ok {
        return clean_result(
            false,
            command_error(
                &add.stdout,
                &add.stderr,
                "Não foi possível preparar as mudanças.",
            ),
        );
    }

    let staged = run_git(&root, &["diff", "--cached", "--quiet", "--exit-code"]);
    if staged.ok {
        return clean_result(false, "Nenhuma mudança para commitar.".into());
    }
    if staged.code != Some(1) {
        return clean_result(
            false,
            command_error(
                &staged.stdout,
                &staged.stderr,
                "Não foi possível verificar mudanças staged.",
            ),
        );
    }

    let commit = run_git(&root, &["commit", "-m", message.as_str()]);
    if !commit.ok {
        return clean_result(
            false,
            command_error(
                &commit.stdout,
                &commit.stderr,
                "Não foi possível criar o commit.",
            ),
        );
    }

    let hash = run_git(&root, &["rev-parse", "--short", "HEAD"]);
    if !hash.ok {
        return clean_result(
            false,
            command_error(
                &hash.stdout,
                &hash.stderr,
                "Commit criado, mas não foi possível ler o hash.",
            ),
        );
    }

    WorkspaceCommitResult {
        ok: true,
        commit_hash: Some(hash.stdout.trim().to_string()),
        error: None,
    }
}

pub fn create_workspace_pull_request(
    working_directory: &str,
    title: &str,
    body: Option<&str>,
) -> WorkspacePullRequestResult {
    let Some(root) = resolve_repo_root(working_directory) else {
        return pr_result_error("PR exige um repositório Git.".into());
    };
    let title = match validate_limited_text(title, "Título do PR", MAX_PR_TITLE_BYTES) {
        Ok(title) => title,
        Err(error) => return pr_result_error(error),
    };
    let body = match validate_optional_body(body) {
        Ok(body) => body,
        Err(error) => return pr_result_error(error),
    };

    let dirty_files = read_dirty_files(&root);
    if !dirty_files.is_empty() {
        return pr_result_error(
            "Há mudanças não commitadas. Faça commit antes de abrir o PR.".into(),
        );
    }

    let gh_version = Command::new("gh")
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output();
    match gh_version {
        Ok(out) if out.status.success() => {}
        Ok(out) => {
            return pr_result_error(command_error(
                "",
                &String::from_utf8_lossy(&out.stderr),
                "GitHub CLI (gh) not found",
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return pr_result_error("GitHub CLI (gh) not found".into());
        }
        Err(e) => return pr_result_error(format!("Falha ao executar GitHub CLI (gh): {e}")),
    }

    let push = run_git(&root, &["push", "-u", "origin", "HEAD"]);
    if !push.ok {
        return pr_result_error(command_error(
            &push.stdout,
            &push.stderr,
            "Não foi possível fazer push do branch atual.",
        ));
    }

    let pr_output = Command::new("gh")
        .arg("pr")
        .arg("create")
        .arg("--title")
        .arg(&title)
        .arg("--body")
        .arg(&body)
        .current_dir(&root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output();

    let pr_output = match pr_output {
        Ok(out) => out,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return pr_result_error("GitHub CLI (gh) not found".into());
        }
        Err(e) => return pr_result_error(format!("Falha ao executar GitHub CLI (gh): {e}")),
    };

    let stdout = String::from_utf8_lossy(&pr_output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&pr_output.stderr).to_string();
    if !pr_output.status.success() {
        return pr_result_error(command_error(
            &stdout,
            &stderr,
            "Não foi possível criar o PR.",
        ));
    }

    let output = if stdout.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };
    let url = extract_first_url(output).unwrap_or_else(|| output.to_string());
    WorkspacePullRequestResult {
        ok: true,
        url: Some(url),
        error: None,
    }
}

fn extract_first_url(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .find(|part| part.starts_with("https://") || part.starts_with("http://"))
        .map(|url| {
            url.trim_matches(|c: char| c == ')' || c == ',' || c == '.')
                .to_string()
        })
}

// ════════════════════════════════════════════════════════════════════
// Branches
// ════════════════════════════════════════════════════════════════════

/// Reads branch info for a working directory.
/// Mirrors Electron's `readWorkspaceBranchInfo`.
pub fn read_workspace_branch_info(working_directory: &str) -> WorkspaceBranchInfo {
    let Some(root) = resolve_repo_root(working_directory) else {
        return WorkspaceBranchInfo {
            current_branch: None,
            upstream_branch: None,
            branches: Vec::new(),
            can_switch: false,
            dirty: false,
            dirty_files: Vec::new(),
            message: Some("Branches exigem um repositório Git.".into()),
        };
    };

    let current_branch = read_current_branch(&root);
    let upstream_branch = read_upstream_branch(&root);
    let branches = read_branches(&root, current_branch.as_deref());
    let dirty_files = read_dirty_files(&root);

    WorkspaceBranchInfo {
        current_branch,
        upstream_branch,
        can_switch: branches.len() > 1 && dirty_files.is_empty(),
        dirty: !dirty_files.is_empty(),
        dirty_files,
        branches,
        message: None,
    }
}

/// Switches to a branch. Mirrors Electron's `switchWorkspaceBranch`.
pub fn switch_workspace_branch(
    working_directory: &str,
    branch_name: &str,
) -> WorkspaceBranchSwitchResult {
    let Some(root) = resolve_repo_root(working_directory) else {
        return WorkspaceBranchSwitchResult {
            ok: false,
            message: Some("Trocar branch exige um repositório Git.".into()),
            branch_info: None,
        };
    };

    let requested = branch_name.trim();
    if requested.is_empty() || requested.contains('\0') {
        return WorkspaceBranchSwitchResult {
            ok: false,
            message: Some("Branch inválida.".into()),
            branch_info: None,
        };
    }

    let branch_info = read_workspace_branch_info(&root.to_string_lossy());
    let branch = branch_info.branches.iter().find(|b| b.name == requested);
    let Some(branch) = branch else {
        return WorkspaceBranchSwitchResult {
            ok: false,
            message: Some("Branch não encontrada neste repositório.".into()),
            branch_info: Some(branch_info),
        };
    };
    if branch.current {
        return WorkspaceBranchSwitchResult {
            ok: true,
            message: None,
            branch_info: Some(branch_info),
        };
    }
    if branch_info.dirty {
        return WorkspaceBranchSwitchResult {
            ok: false,
            message: Some(
                "Há mudanças não commitadas. Faça commit, stash ou descarte antes de trocar de branch.".into(),
            ),
            branch_info: Some(branch_info),
        };
    }

    let result = run_git(&root, &["switch", requested]);
    if !result.ok {
        let msg = if !result.stderr.trim().is_empty() {
            result.stderr.trim().to_string()
        } else {
            "Não foi possível trocar de branch.".to_string()
        };
        return WorkspaceBranchSwitchResult {
            ok: false,
            message: Some(msg),
            branch_info: Some(branch_info),
        };
    }

    WorkspaceBranchSwitchResult {
        ok: true,
        message: None,
        branch_info: Some(read_workspace_branch_info(&root.to_string_lossy())),
    }
}

fn read_branches(root: &Path, current_branch: Option<&str>) -> Vec<WorkspaceBranch> {
    let result = run_git(
        root,
        &[
            "for-each-ref",
            "--format=%(refname:short)|%(HEAD)|%(upstream:short)",
            "refs/heads",
        ],
    );
    if !result.ok {
        return Vec::new();
    }

    let mut seen = std::collections::HashSet::new();
    let mut branches: Vec<WorkspaceBranch> = Vec::new();

    for raw_line in result.stdout.lines() {
        let mut parts = raw_line.split('|');
        let raw_name = parts.next().unwrap_or("");
        let head = parts.next().unwrap_or("");
        let upstream = parts.next().unwrap_or("").trim();
        let name = normalize_branch_name(raw_name);
        if name.is_empty() || seen.contains(&name) {
            continue;
        }
        seen.insert(name.clone());
        branches.push(WorkspaceBranch {
            current: head.trim() == "*" || Some(name.as_str()) == current_branch,
            remote: false,
            upstream: if upstream.is_empty() {
                None
            } else {
                Some(upstream.to_string())
            },
            name,
        });
    }

    branches.sort_by(|a, b| {
        if a.current != b.current {
            return b.current.cmp(&a.current);
        }
        if a.remote != b.remote {
            return a.remote.cmp(&b.remote);
        }
        a.name.cmp(&b.name)
    });
    branches
}

fn normalize_branch_name(value: &str) -> String {
    let name = value.trim();
    if name.is_empty() || name == "HEAD" || name.ends_with("/HEAD") {
        return String::new();
    }
    name.strip_prefix("remotes/").unwrap_or(name).to_string()
}

fn read_dirty_files(root: &Path) -> Vec<String> {
    let result = run_git(
        root,
        &["status", "--porcelain=v1", "--untracked-files=normal"],
    );
    if !result.ok {
        return Vec::new();
    }
    result
        .stdout
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .filter_map(|l| {
            if l.len() < 3 {
                None
            } else {
                Some(l[3..].trim().to_string())
            }
        })
        .filter(|s| !s.is_empty())
        .collect()
}

// ════════════════════════════════════════════════════════════════════
// File diff + revert
// ════════════════════════════════════════════════════════════════════

/// Reads the diff for a file. Mirrors Electron's `readFileDiff`.
pub fn read_file_diff(
    working_directory: &str,
    file_path: &str,
    status: FileDiffStatus,
) -> FileDiff {
    let Some(root) = resolve_repo_root(working_directory) else {
        return empty_diff(
            file_path,
            status,
            Some("Diff indisponível fora de um repositório Git.".into()),
        );
    };

    let Some(_target) = resolve_safe_path(&root, file_path) else {
        return empty_diff(
            file_path,
            status,
            Some("Caminho fora do repositório.".into()),
        );
    };

    let args: Vec<&str> = match status {
        FileDiffStatus::Untracked | FileDiffStatus::Added => {
            // git diff --no-index -- /dev/null <path>
            // We pass the path as-is (relative to root).
            vec!["diff", "--no-index", "--", "/dev/null", file_path]
        }
        _ => vec!["diff", "HEAD", "--", file_path],
    };

    let result = run_git(&root, &args);
    let stdout = if result.ok || !result.stdout.is_empty() {
        result.stdout
    } else {
        return empty_diff(
            file_path,
            status,
            Some("Não foi possível ler o diff.".into()),
        );
    };

    if is_diff_too_large(&stdout) {
        let mut diff = empty_diff(file_path, status, None);
        diff.truncated = true;
        diff.message = Some("Diff muito grande para exibir.".into());
        return diff;
    }

    parse_unified_diff(file_path, status, &stdout)
}

/// Reverts a file to HEAD (tracked) or deletes it (untracked).
/// Mirrors Electron's `revertFile`.
pub fn revert_file(
    working_directory: &str,
    file_path: &str,
) -> Result<bool, String> {
    let Some(root) = resolve_repo_root(working_directory) else {
        return Err("Reverter exige um repositório Git.".into());
    };
    let Some(target) = resolve_safe_path(&root, file_path) else {
        return Err("Caminho fora do repositório.".into());
    };

    let tracked = run_git(&root, &["ls-files", "--error-unmatch", "--", file_path]);
    if tracked.ok {
        let checkout = run_git(&root, &["checkout", "HEAD", "--", file_path]);
        if checkout.ok {
            Ok(true)
        } else {
            Err("Não foi possível restaurar o arquivo.".into())
        }
    } else {
        // Untracked: delete the file
        match std::fs::remove_file(&target) {
            Ok(_) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
            Err(e) => Err(format!("Não foi possível remover o arquivo: {e}")),
        }
    }
}

fn is_diff_too_large(raw: &str) -> bool {
    raw.len() > MAX_DIFF_BYTES || raw.lines().count() > MAX_DIFF_LINES
}

fn parse_unified_diff(path: &str, status: FileDiffStatus, raw: &str) -> FileDiff {
    let mut hunks: Vec<FileDiffHunk> = Vec::new();
    let mut old_line: u32 = 0;
    let mut new_line: u32 = 0;
    let mut additions: u32 = 0;
    let mut deletions: u32 = 0;
    let mut binary = false;

    for line in raw.lines() {
        if line.starts_with("Binary files ") {
            binary = true;
            continue;
        }

        if line.starts_with("@@") {
            let (old_start, old_lines, new_start, new_lines) = parse_hunk_header(line);
            hunks.push(FileDiffHunk {
                header: line.to_string(),
                old_start,
                old_lines,
                new_start,
                new_lines,
                lines: Vec::new(),
            });
            old_line = old_start;
            new_line = new_start;
            continue;
        }

        if line.starts_with("diff --git")
            || line.starts_with("index ")
            || line.starts_with("--- ")
            || line.starts_with("+++ ")
        {
            continue;
        }

        if hunks.is_empty() {
            continue;
        }

        let (parsed, next_old, next_new) = parse_diff_line(line, old_line, new_line);
        let h = hunks.last_mut().expect("hunks non-empty checked above");
        h.lines.push(parsed);
        old_line = next_old;
        new_line = next_new;
        match line.chars().next() {
            Some('+') => additions += 1,
            Some('-') => deletions += 1,
            _ => {}
        }
    }

    FileDiff {
        path: path.to_string(),
        status,
        additions,
        deletions,
        binary,
        truncated: false,
        hunks,
        message: None,
    }
}

fn parse_hunk_header(line: &str) -> (u32, u32, u32, u32) {
    // Format: @@ -<start>,<count> +<start>,<count> @@
    // Counts are optional (default to 1).
    let bytes = line.as_bytes();
    let mut i = 0;
    // Skip "@@ -"
    while i < bytes.len() && bytes[i] == b'@' {
        i += 1;
    }
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'-') {
        i += 1;
    }
    let old_start = parse_u32_at(bytes, &mut i);
    let old_lines = parse_count_at(bytes, &mut i);
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'+') {
        i += 1;
    }
    let new_start = parse_u32_at(bytes, &mut i);
    let new_lines = parse_count_at(bytes, &mut i);
    (old_start, old_lines, new_start, new_lines)
}

fn parse_u32_at(bytes: &[u8], i: &mut usize) -> u32 {
    let start = *i;
    while *i < bytes.len() && bytes[*i].is_ascii_digit() {
        *i += 1;
    }
    let s = std::str::from_utf8(&bytes[start..*i]).unwrap_or("0");
    s.parse().unwrap_or(0)
}

fn parse_count_at(bytes: &[u8], i: &mut usize) -> u32 {
    // Optional ",<count>" — if missing, default to 1.
    if *i < bytes.len() && bytes[*i] == b',' {
        *i += 1;
        let start = *i;
        while *i < bytes.len() && bytes[*i].is_ascii_digit() {
            *i += 1;
        }
        let s = std::str::from_utf8(&bytes[start..*i]).unwrap_or("1");
        s.parse().unwrap_or(1)
    } else {
        1
    }
}

fn parse_diff_line(raw: &str, old_line: u32, new_line: u32) -> (FileDiffLine, u32, u32) {
    if let Some(rest) = raw.strip_prefix('+') {
        (
            FileDiffLine {
                kind: DiffLineKind::Add,
                old_line: None,
                new_line: Some(new_line),
                text: rest.to_string(),
            },
            old_line,
            new_line + 1,
        )
    } else if let Some(rest) = raw.strip_prefix('-') {
        (
            FileDiffLine {
                kind: DiffLineKind::Del,
                old_line: Some(old_line),
                new_line: None,
                text: rest.to_string(),
            },
            old_line + 1,
            new_line,
        )
    } else {
        let rest = raw.strip_prefix(' ').unwrap_or(raw);
        (
            FileDiffLine {
                kind: DiffLineKind::Context,
                old_line: Some(old_line),
                new_line: Some(new_line),
                text: rest.to_string(),
            },
            old_line + 1,
            new_line + 1,
        )
    }
}

fn empty_diff(path: &str, status: FileDiffStatus, message: Option<String>) -> FileDiff {
    FileDiff {
        path: path.to_string(),
        status,
        additions: 0,
        deletions: 0,
        binary: false,
        truncated: false,
        hunks: Vec::new(),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_numstat_value_handles_binary_marker() {
        assert_eq!(parse_numstat_value("123"), 123);
        assert_eq!(parse_numstat_value("-"), 0);
        assert_eq!(parse_numstat_value(""), 0);
        assert_eq!(parse_numstat_value("not-a-number"), 0);
    }

    #[test]
    fn normalize_branch_name_strips_remotes_prefix() {
        assert_eq!(normalize_branch_name("remotes/origin/main"), "origin/main");
        assert_eq!(normalize_branch_name("main"), "main");
        assert_eq!(normalize_branch_name("HEAD"), "");
        assert_eq!(normalize_branch_name("origin/HEAD"), "");
        assert_eq!(normalize_branch_name("  "), "");
    }

    #[test]
    fn regex_like_detects_github_remote() {
        assert!(regex_like_contains_github("origin\tgit@github.com:foo/bar.git (fetch)"));
        assert!(regex_like_contains_github("origin\thttps://github.com/foo/bar.git (fetch)"));
        assert!(!regex_like_contains_github("origin\tgit@gitlab.com:foo/bar.git (fetch)"));
        assert!(!regex_like_contains_github(""));
    }

    #[test]
    fn validate_commit_message_rejects_empty_nul_and_too_large() {
        assert!(validate_limited_text("", "Mensagem do commit", MAX_COMMIT_MESSAGE_BYTES).is_err());
        assert!(
            validate_limited_text("   ", "Mensagem do commit", MAX_COMMIT_MESSAGE_BYTES).is_err()
        );
        assert!(validate_limited_text(
            "bad\0message",
            "Mensagem do commit",
            MAX_COMMIT_MESSAGE_BYTES
        )
        .is_err());
        assert!(validate_limited_text(
            &"x".repeat(MAX_COMMIT_MESSAGE_BYTES + 1),
            "Mensagem do commit",
            MAX_COMMIT_MESSAGE_BYTES,
        )
        .is_err());
        assert_eq!(
            validate_limited_text("  ok  ", "Mensagem do commit", MAX_COMMIT_MESSAGE_BYTES)
                .unwrap(),
            "ok"
        );
    }

    #[test]
    fn commit_workspace_changes_roundtrip_in_temp_repo() {
        let repo = init_test_repo();
        std::fs::write(repo.path().join("file.txt"), "hello\n").unwrap();

        let result = commit_workspace_changes(repo.path().to_str().unwrap(), "Initial commit");

        assert!(result.ok, "commit failed: {:?}", result.error);
        assert!(result.commit_hash.as_deref().unwrap_or("").len() >= 7);
        assert_eq!(result.error, None);

        let status = run_git(repo.path(), &["status", "--porcelain"]);
        assert!(status.ok);
        assert_eq!(status.stdout.trim(), "");

        let log = run_git(repo.path(), &["log", "-1", "--pretty=%B"]);
        assert!(log.ok);
        assert_eq!(log.stdout.trim(), "Initial commit");
    }

    #[test]
    fn commit_workspace_changes_reports_nothing_to_commit() {
        let repo = init_test_repo();
        std::fs::write(repo.path().join("file.txt"), "hello\n").unwrap();
        let first = commit_workspace_changes(repo.path().to_str().unwrap(), "Initial commit");
        assert!(first.ok, "initial commit failed: {:?}", first.error);

        let result = commit_workspace_changes(repo.path().to_str().unwrap(), "No-op");

        assert!(!result.ok);
        assert!(result.commit_hash.is_none());
        assert!(result.error.unwrap().contains("Nenhuma mudança"));
    }

    #[test]
    fn create_workspace_pull_request_rejects_dirty_repo_before_gh_or_push() {
        let repo = init_test_repo();
        std::fs::write(repo.path().join("file.txt"), "hello\n").unwrap();
        let first = commit_workspace_changes(repo.path().to_str().unwrap(), "Initial commit");
        assert!(first.ok, "initial commit failed: {:?}", first.error);
        std::fs::write(repo.path().join("file.txt"), "changed\n").unwrap();

        let result = create_workspace_pull_request(repo.path().to_str().unwrap(), "Test PR", None);

        assert!(!result.ok);
        assert!(result.url.is_none());
        assert!(result.error.unwrap().contains("Faça commit"));
    }

    fn init_test_repo() -> tempfile::TempDir {
        let repo = tempfile::TempDir::new().unwrap();
        let init = Command::new("git")
            .arg("init")
            .arg(repo.path())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .output()
            .unwrap();
        assert!(init.status.success(), "git init failed");
        assert!(run_git(repo.path(), &["config", "user.name", "Verboo Test"]).ok);
        assert!(
            run_git(
                repo.path(),
                &["config", "user.email", "test@example.invalid"]
            )
            .ok
        );
        repo
    }

    #[test]
    fn parse_hunk_header_with_counts() {
        let (os, ol, ns, nl) = parse_hunk_header("@@ -10,5 +12,7 @@ fn");
        assert_eq!((os, ol, ns, nl), (10, 5, 12, 7));
    }

    #[test]
    fn parse_hunk_header_without_counts() {
        let (os, ol, ns, nl) = parse_hunk_header("@@ -10 +12 @@ fn");
        assert_eq!((os, ol, ns, nl), (10, 1, 12, 1));
    }

    #[test]
    fn parse_diff_line_add() {
        let (line, next_old, next_new) = parse_diff_line("+added", 5, 10);
        assert_eq!(line.kind, DiffLineKind::Add);
        assert_eq!(line.new_line, Some(10));
        assert_eq!(line.old_line, None);
        assert_eq!(line.text, "added");
        assert_eq!((next_old, next_new), (5, 11));
    }

    #[test]
    fn parse_diff_line_del() {
        let (line, next_old, next_new) = parse_diff_line("-removed", 5, 10);
        assert_eq!(line.kind, DiffLineKind::Del);
        assert_eq!(line.old_line, Some(5));
        assert_eq!(line.new_line, None);
        assert_eq!(line.text, "removed");
        assert_eq!((next_old, next_new), (6, 10));
    }

    #[test]
    fn parse_diff_line_context() {
        let (line, next_old, next_new) = parse_diff_line(" context", 5, 10);
        assert_eq!(line.kind, DiffLineKind::Context);
        assert_eq!(line.old_line, Some(5));
        assert_eq!(line.new_line, Some(10));
        assert_eq!(line.text, "context");
        assert_eq!((next_old, next_new), (6, 11));
    }

    #[test]
    fn parse_unified_diff_basic() {
        let raw = "\
diff --git a/file.txt b/file.txt
index abc..def 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 line1
-old line
+new line
+added
 line3
";
        let diff = parse_unified_diff("file.txt", FileDiffStatus::Modified, raw);
        assert_eq!(diff.additions, 2);
        assert_eq!(diff.deletions, 1);
        assert_eq!(diff.hunks.len(), 1);
        assert_eq!(diff.hunks[0].lines.len(), 5);
        assert!(!diff.binary);
        assert!(!diff.truncated);
    }

    #[test]
    fn parse_unified_diff_binary() {
        let raw = "Binary files a/file.bin and b/file.bin differ\n";
        let diff = parse_unified_diff("file.bin", FileDiffStatus::Modified, raw);
        assert!(diff.binary);
        assert!(diff.hunks.is_empty());
    }

    #[test]
    fn is_diff_too_large_checks_bytes_and_lines() {
        let small = "a\nb\nc\n";
        assert!(!is_diff_too_large(small));

        let huge_bytes = "x".repeat(MAX_DIFF_BYTES + 1);
        assert!(is_diff_too_large(&huge_bytes));

        let huge_lines: String = (0..MAX_DIFF_LINES + 1).map(|i| format!("line{i}\n")).collect();
        assert!(is_diff_too_large(&huge_lines));
    }

    #[test]
    fn resolve_safe_path_rejects_dotdot() {
        // Non-existent root: canonicalize falls back to lexical, but the
        // explicit `..` component check still rejects escapes.
        let root = Path::new("/repo");
        assert!(resolve_safe_path(root, "file.txt").is_some());
        assert!(resolve_safe_path(root, "sub/file.txt").is_some());
        assert!(resolve_safe_path(root, "../escape").is_none());
        assert!(resolve_safe_path(root, "sub/../../escape").is_none());
        // Absolute paths are never relative to the repo.
        assert!(resolve_safe_path(root, "/etc/passwd").is_none());
    }

    #[test]
    fn resolve_safe_path_blocks_real_traversal() {
        // Reproduces the path-traversal exploit found by the verifier:
        // `sub/../../secret` where `sub/` exists inside the repo. Without
        // canonicalization, Path::join + strip_prefix treat this as a
        // valid in-repo path because the lexical prefix matches.
        let tmp = std::env::temp_dir().join(format!(
            "verboo-trav-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let repo = tmp.join("repo");
        let sub = repo.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let secret = tmp.join("secret.txt");
        std::fs::write(&secret, "victim").unwrap();

        // sub/../../secret.txt → must be rejected before reaching the file.
        let payload = "sub/../../secret.txt";
        let result = resolve_safe_path(&repo, payload);
        assert!(
            result.is_none(),
            "traversal must be blocked, got {:?}",
            result
        );
        // Victim file must still exist.
        assert!(secret.exists(), "victim file must not be deleted");

        let _ = std::fs::remove_file(&secret);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn resolve_safe_path_allows_valid_in_repo_subpath() {
        let tmp = std::env::temp_dir().join(format!(
            "verboo-safe-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("file.txt"), "x").unwrap();
        std::fs::create_dir_all(tmp.join("sub")).unwrap();

        assert!(resolve_safe_path(&tmp, "file.txt").is_some());
        assert!(resolve_safe_path(&tmp, "sub/").is_some());
        // Non-existent file inside repo is OK (e.g., new file in a diff).
        assert!(resolve_safe_path(&tmp, "newfile.txt").is_some());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn empty_summary_has_zero_counts() {
        let s = empty_summary();
        assert_eq!(s.total_files, 0);
        assert_eq!(s.additions, 0);
        assert_eq!(s.deletions, 0);
        assert!(s.files.is_empty());
    }
}
