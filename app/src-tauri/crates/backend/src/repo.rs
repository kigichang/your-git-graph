//! Repository state the engine does not report: an in-progress merge / rebase / cherry-pick /
//! revert, read from the marker files git leaves in the git directory. The conflicted files are
//! listed by the frontend with `git diff --diff-filter=U` (they need the index's stages).
//! Also the one file the app writes into a work tree: the exported repository configuration.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationState {
    /// `merge` | `rebase` | `cherry-pick` | `revert`, or `None` when nothing is in progress.
    #[serde(rename = "type")]
    pub kind: Option<&'static str>,
    pub progress: Option<Progress>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Progress {
    pub step: u32,
    pub total: u32,
}

/// The git directory of the work tree at `root`: `.git` itself, or where a `.git` file
/// (linked worktree, submodule) points.
pub fn git_dir(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    let text = fs::read_to_string(&dot_git).ok()?;
    let target = text.trim().strip_prefix("gitdir:")?.trim();
    Some(root.join(target))
}

fn read_number(path: PathBuf) -> Option<u32> {
    fs::read_to_string(path).ok()?.trim().parse().ok()
}

fn progress(dir: &Path, step: &str, total: &str) -> Option<Progress> {
    Some(Progress { step: read_number(dir.join(step))?, total: read_number(dir.join(total))? })
}

pub fn operation_state(root: &Path) -> OperationState {
    let none = OperationState { kind: None, progress: None };
    let Some(dir) = git_dir(root) else { return none };
    // A rebase that stopped on a conflicting cherry-pick also leaves CHERRY_PICK_HEAD: check it first.
    if dir.join("rebase-merge").is_dir() {
        let d = dir.join("rebase-merge");
        return OperationState { kind: Some("rebase"), progress: progress(&d, "msgnum", "end") };
    }
    if dir.join("rebase-apply").is_dir() {
        let d = dir.join("rebase-apply");
        return OperationState { kind: Some("rebase"), progress: progress(&d, "next", "last") };
    }
    for (file, kind) in [("MERGE_HEAD", "merge"), ("CHERRY_PICK_HEAD", "cherry-pick"), ("REVERT_HEAD", "revert")] {
        if dir.join(file).is_file() {
            return OperationState { kind: Some(kind), progress: None };
        }
    }
    none
}

/// Where Export Repository Configuration writes, relative to the work tree (a file meant to be
/// committed, so everyone who clones the repository shares the settings in it).
pub const REPO_CONFIG_FILE: &str = ".your-git-graph.json";

/// Write the exported repository configuration of the work tree at `root`. Only that one path:
/// a symbolic link there (pointing out of the repository) is refused.
pub fn write_repo_config(root: &Path, contents: &str) -> Result<PathBuf, String> {
    if git_dir(root).is_none() {
        return Err(format!("{} is not a Git work tree.", root.display()));
    }
    let file = root.join(REPO_CONFIG_FILE);
    if fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(format!("{} is a symbolic link.", file.display()));
    }
    crate::files::write_atomic(&file, contents.as_bytes()).map_err(|e| format!("Cannot write {}: {e}", file.display()))?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn the_repo_config_goes_to_one_path_and_never_through_a_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        assert!(write_repo_config(p, "{}").is_err(), "not a work tree");
        fs::create_dir(p.join(".git")).unwrap();
        let file = write_repo_config(p, "{\"a\":1}").unwrap();
        assert_eq!(file, p.join(REPO_CONFIG_FILE));
        assert_eq!(fs::read_to_string(&file).unwrap(), "{\"a\":1}");
        write_repo_config(p, "{}").unwrap(); // overwritten
        assert_eq!(fs::read_to_string(&file).unwrap(), "{}");

        let outside = tempfile::tempdir().unwrap();
        fs::remove_file(&file).unwrap();
        std::os::unix::fs::symlink(outside.path().join("x.json"), &file).unwrap();
        assert!(write_repo_config(p, "{}").unwrap_err().contains("symbolic link"));
        assert!(!outside.path().join("x.json").exists());
    }

    fn git(dir: &Path, args: &[&str]) -> bool {
        Command::new("git").args(args).current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t")
            .env("GIT_EDITOR", "true")
            .output().unwrap().status.success()
    }

    /// main and side both change `f` → merging, rebasing or cherry-picking one onto the other conflicts.
    fn conflicting_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        assert!(git(p, &["init", "-q", "-b", "main"]));
        fs::write(p.join("f"), "base\n").unwrap();
        assert!(git(p, &["add", "f"]) && git(p, &["commit", "-qm", "base"]));
        assert!(git(p, &["checkout", "-qb", "side"]));
        fs::write(p.join("f"), "side\n").unwrap();
        assert!(git(p, &["commit", "-qam", "side"]));
        assert!(git(p, &["checkout", "-q", "main"]));
        fs::write(p.join("f"), "main\n").unwrap();
        assert!(git(p, &["commit", "-qam", "main"]));
        dir
    }

    #[test]
    fn clean_repository_has_no_operation() {
        let dir = conflicting_repo();
        assert_eq!(operation_state(dir.path()), OperationState { kind: None, progress: None });
        assert_eq!(operation_state(Path::new("/nonexistent")).kind, None);
    }

    #[test]
    fn detects_merge_cherry_pick_and_rebase() {
        let dir = conflicting_repo();
        let p = dir.path();
        assert!(!git(p, &["merge", "side"]));
        assert_eq!(operation_state(p).kind, Some("merge"));
        assert!(git(p, &["merge", "--abort"]));

        assert!(!git(p, &["cherry-pick", "side"]));
        assert_eq!(operation_state(p).kind, Some("cherry-pick"));
        assert!(git(p, &["cherry-pick", "--abort"]));

        assert!(!git(p, &["rebase", "side"]));
        let state = operation_state(p);
        assert_eq!(state.kind, Some("rebase"));
        assert_eq!(state.progress, Some(Progress { step: 1, total: 1 }));
        assert!(git(p, &["rebase", "--abort"]));
        assert_eq!(operation_state(p).kind, None);
    }
}
