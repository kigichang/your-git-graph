//! The diff windows (web/diff.html, a Monaco editor) and the working-tree reads they need.
//! Revision contents come from the engine; only the working tree is read here.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use gg_backend::files::read_worktree_file;
use serde_json::{json, Value};

use crate::remote::{self, Remotes};

/// Open a diff window. `spec` (JSON, built by web/src/lib/diffspec.ts) tells the page what to show;
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

#[tauri::command]
pub async fn worktree_file(remotes: tauri::State<'_, std::sync::Arc<Remotes>>, repo: String, path: String) -> Result<Value, String> {
    match remote::parse(&repo)? {
        Some(remote) => remote::ask(&remotes, &remote, json!({ "op": "worktreeFile", "path": path }), "repo").await,
        None => serde_json::to_value(read_worktree_file(Path::new(&repo), &path)?).map_err(|e| e.to_string()),
    }
}
