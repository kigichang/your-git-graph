//! The diff windows (ui/diff.html, a Monaco editor) and the working-tree reads they need.
//! Revision contents come from the engine; only the working tree is read here.

use std::io::Read;
use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

/// Files above this size are not loaded into the editor.
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// Open a diff window. `spec` (JSON, built by ui/host/diffspec.js) tells the page what to show;
/// it is handed over as a global set before the page's scripts run.
#[tauri::command]
pub fn open_diff_window(app: tauri::AppHandle, spec: String, title: String) -> Result<(), String> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    // Re-serialised: only well-formed JSON reaches the initialisation script.
    let spec: serde_json::Value = serde_json::from_str(&spec).map_err(|e| e.to_string())?;
    let label = format!("diff-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App("diff.html".into()))
        .title(title)
        .inner_size(1100.0, 760.0)
        .min_inner_size(480.0, 320.0)
        .initialization_script(format!("window.__GG_DIFF_SPEC = {spec};"))
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
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

/// Read `path` (relative to the repository root) from the working tree. Paths leaving the
/// repository (`..`, absolute, or through a symlink pointing outside) are refused.
pub fn read_worktree_file(repo: &Path, path: &str) -> Result<WorktreeFile, String> {
    let relative = Path::new(path);
    if relative.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err(format!("{path} is not a path inside the repository."));
    }
    let full = repo.join(relative);
    let missing = WorktreeFile { exists: false, size: 0, binary: false, text: None, base64: None, skipped: None };
    let Ok(real) = full.canonicalize() else { return Ok(missing) };
    let root = repo.canonicalize().map_err(|e| e.to_string())?;
    if !real.starts_with(&root) {
        return Err(format!("{path} leads outside the repository."));
    }
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

#[tauri::command]
pub fn worktree_file(repo: String, path: String) -> Result<WorktreeFile, String> {
    read_worktree_file(Path::new(&repo), &path)
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
    }
}
