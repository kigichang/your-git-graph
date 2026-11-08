//! Files of a repository read and written outside git: the working-tree reads of the diff
//! windows, scanning a folder for repositories, and atomic writes.

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

/// Files above this size are not loaded into the editor.
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// How deep a folder that is not itself a repository is searched for repositories.
pub const SCAN_DEPTH: usize = 3;
/// Directories never searched: dependencies and build output hold no repositories worth listing.
const SKIP_DIRS: [&str; 4] = ["node_modules", "target", "build", "dist"];

/// Write `contents` to `file` atomically (a temporary file renamed over it), creating the
/// directory: a crash mid-write never leaves a truncated file behind.
pub fn write_atomic(file: &Path, contents: &[u8]) -> std::io::Result<()> {
    let dir = file.parent().ok_or_else(|| std::io::Error::other("no parent directory"))?;
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{}.{}.tmp", file.file_name().unwrap_or_default().to_string_lossy(), std::process::id()));
    let write = || {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(contents)?;
        // A network volume (smbfs) cannot be told to flush to disk: the rename still is atomic.
        match f.sync_all() {
            Err(e) if e.raw_os_error() != Some(libc::ENOTSUP) => return Err(e),
            _ => {}
        }
        std::fs::rename(&tmp, file)
    };
    write().inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeFile {
    pub exists: bool,
    pub size: u64,
    pub binary: bool,
    /// The text of a UTF-8 file.
    pub text: Option<String>,
    /// The bytes of a binary file, base64 (for image previews).
    pub base64: Option<String>,
    /// Set when the file is not loaded (too large).
    pub skipped: Option<String>,
}

/// Where `path` (relative to the repository root) really is, `None` when there is nothing
/// there. Paths leaving the repository (`..`, absolute, or through a symlink pointing outside)
/// are refused.
pub fn inside_repo(repo: &Path, path: &str) -> Result<Option<PathBuf>, String> {
    let relative = Path::new(path);
    if relative.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err(format!("{path} is not a path inside the repository."));
    }
    let Ok(real) = repo.join(relative).canonicalize() else { return Ok(None) };
    let root = repo.canonicalize().map_err(|e| e.to_string())?;
    if !real.starts_with(&root) {
        return Err(format!("{path} leads outside the repository."));
    }
    Ok(Some(real))
}

/// Read `path` (relative to the repository root) from the working tree; see [`inside_repo`].
pub fn read_worktree_file(repo: &Path, path: &str) -> Result<WorktreeFile, String> {
    let missing = WorktreeFile { exists: false, size: 0, binary: false, text: None, base64: None, skipped: None };
    let Some(real) = inside_repo(repo, path)? else { return Ok(missing) };
    let size = real.metadata().map_err(|e| e.to_string())?.len();
    if size > MAX_FILE_BYTES {
        return Ok(WorktreeFile { exists: true, size, binary: false, text: None, base64: None, skipped: Some(format!("The file is too large to show ({} MB).", size / (1024 * 1024))) });
    }
    let mut bytes = Vec::with_capacity(size as usize);
    std::fs::File::open(&real).and_then(|mut f| f.read_to_end(&mut bytes)).map_err(|e| e.to_string())?;
    // Binary like git decides it: a NUL in the first 8000 bytes (or not UTF-8 at all).
    let looks_binary = bytes.iter().take(8000).any(|&b| b == 0);
    match (looks_binary, String::from_utf8(bytes)) {
        (false, Ok(text)) => Ok(WorktreeFile { exists: true, size, binary: false, text: Some(text), base64: None, skipped: None }),
        (_, Ok(text)) => Ok(binary(size, text.into_bytes())),
        (_, Err(e)) => Ok(binary(size, e.into_bytes())),
    }
}

fn binary(size: u64, bytes: Vec<u8>) -> WorktreeFile {
    use base64::Engine;
    WorktreeFile { exists: true, size, binary: true, text: None, base64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)), skipped: None }
}

/// The repositories in `folder` (not itself a repository), at most `depth` levels down,
/// sorted. A repository found is not searched further (its submodules and vendored checkouts
/// belong to it); hidden directories and [`SKIP_DIRS`] are skipped.
pub fn scan(folder: &Path, depth: usize) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut level = vec![folder.to_path_buf()];
    for _ in 0..depth {
        let mut next = Vec::new();
        for dir in level {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !entry.file_type().is_ok_and(|t| t.is_dir()) || name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()) {
                    continue;
                }
                if path.join(".git").exists() {
                    found.push(path);
                } else {
                    next.push(path);
                }
            }
        }
        level = next;
    }
    found.sort();
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_text_binary_and_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("t.txt"), "héllo\n").unwrap();
        std::fs::write(dir.path().join("b.bin"), [0u8, 159, 146, 150]).unwrap();
        let text = read_worktree_file(dir.path(), "t.txt").unwrap();
        assert_eq!((text.exists, text.binary, text.text.as_deref()), (true, false, Some("héllo\n")));
        let bin = read_worktree_file(dir.path(), "b.bin").unwrap();
        assert_eq!((bin.binary, bin.base64.as_deref(), bin.size), (true, Some("AJ+Slg=="), 4));
        assert!(!read_worktree_file(dir.path(), "nope.txt").unwrap().exists);
    }

    #[test]
    fn refuses_paths_outside_the_repository() {
        let outer = tempfile::tempdir().unwrap();
        let repo = outer.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        std::fs::write(outer.path().join("secret"), "x").unwrap();
        std::os::unix::fs::symlink(outer.path().join("secret"), repo.join("link")).unwrap();
        assert!(read_worktree_file(&repo, "../secret").is_err());
        assert!(read_worktree_file(&repo, "/etc/passwd").is_err());
        assert!(read_worktree_file(&repo, "link").is_err());
        assert!(inside_repo(&repo, "link").is_err());
        assert!(inside_repo(&repo, "../secret").is_err());
        assert_eq!(inside_repo(&repo, "missing"), Ok(None));
        // A link staying inside is where it leads: that file is what gets judged and opened.
        std::fs::write(repo.join("run.command"), "x").unwrap();
        std::os::unix::fs::symlink("run.command", repo.join("README.md")).unwrap();
        assert_eq!(inside_repo(&repo, "README.md"), Ok(Some(repo.canonicalize().unwrap().join("run.command"))));
    }

    #[test]
    fn scanning_finds_repositories_without_descending_into_them() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        for repo in ["a", "group/b", "group/deep/c", "a/vendor/inner", "node_modules/pkg", ".hidden/x", "one/two/three/four"] {
            std::fs::create_dir_all(p.join(repo).join(".git")).unwrap();
        }
        std::fs::create_dir_all(p.join("worktree")).unwrap();
        std::fs::write(p.join("worktree/.git"), "gitdir: /somewhere\n").unwrap();
        let found: Vec<String> = scan(p, SCAN_DEPTH).iter().map(|f| f.strip_prefix(p).unwrap().display().to_string()).collect();
        assert_eq!(found, ["a", "group/b", "group/deep/c", "worktree"]);
    }
}
